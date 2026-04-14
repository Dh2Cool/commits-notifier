/**
 * Reads the GitHub push event from the GITHUB_EVENT_JSON env var (injected
 * by the Actions workflow), formats commit + file-change info, then sends
 * notifications to WhatsApp (Meta Cloud API) and/or Discord (incoming webhook).
 *
 * Any destination whose secrets are missing is silently skipped so you can
 * enable them one at a time.
 *
 * File-change data comes from the push event payload. If a commit's arrays are
 * empty (common for certain commit types), we fall back to the GitHub Commits
 * API using the auto-provided GH_TOKEN.
 */

const event = JSON.parse(process.env.GITHUB_EVENT_JSON || "{}");

const repo = event.repository?.full_name ?? "unknown/repo";
const ref = event.ref ?? "";
const branch = ref.replace("refs/heads/", "");
const pusher = event.pusher?.name ?? event.sender?.login ?? "unknown";
const commits = Array.isArray(event.commits) ? event.commits : [];
const compareUrl = event.compare ?? "";
const [repoOwner, repoName] = repo.split("/");

// ─── helpers ────────────────────────────────────────────────────────────────

function cap(arr, max) {
  if (!arr?.length) return { items: [], overflow: 0 };
  return { items: arr.slice(0, max), overflow: Math.max(0, arr.length - max) };
}

function shortSha(c) {
  return (c.id || c.sha || "").slice(0, 7);
}

function firstLine(msg) {
  return (msg || "").split("\n")[0];
}

function hasFileData(c) {
  return (c.added?.length || c.modified?.length || c.removed?.length) > 0;
}

// ─── GitHub API fallback for file changes ────────────────────────────────────
// GH_TOKEN is the auto-provided GITHUB_TOKEN passed under a non-reserved name.

async function fetchCommitFiles(sha) {
  const token = process.env.GH_TOKEN;
  if (!token || !sha) return null;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/commits/${sha}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) {
      console.warn(`[GitHub API] Could not fetch files for ${sha}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const files = data.files || [];
    return {
      added:    files.filter((f) => f.status === "added").map((f) => f.filename),
      modified: files.filter((f) => ["modified", "changed", "renamed", "copied"].includes(f.status)).map((f) => f.filename),
      removed:  files.filter((f) => f.status === "removed").map((f) => f.filename),
    };
  } catch (err) {
    console.warn(`[GitHub API] Error fetching files for ${sha}:`, err.message);
    return null;
  }
}

async function enrichCommits(rawCommits) {
  return Promise.all(
    rawCommits.map(async (c) => {
      if (hasFileData(c)) return c;
      console.log(`[GitHub API] Fetching file list for ${shortSha(c)} via API…`);
      const files = await fetchCommitFiles(c.id || c.sha);
      return files ? { ...c, ...files } : c;
    })
  );
}

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

async function sendWhatsApp(enrichedCommits) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const to = process.env.WHATSAPP_TO_NUMBER;

  if (!token || !phoneNumberId || !to) {
    console.log("[WhatsApp] Skipped — WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_TO_NUMBER not set");
    return;
  }

  const lines = [
    `*New push to ${repo}*`,
    `Branch: \`${branch}\``,
    `Pusher: ${pusher}`,
    `Commits: ${enrichedCommits.length}`,
    "",
  ];

  for (const c of enrichedCommits.slice(0, 10)) {
    const sha = shortSha(c);
    const msg = firstLine(c.message);
    lines.push(`• ${sha} — ${msg}`);

    const added    = cap(c.added, 10);
    const modified = cap(c.modified, 10);
    const removed  = cap(c.removed, 10);

    if (added.items.length)
      lines.push(`  + ${added.items.join(", ")}${added.overflow ? ` … +${added.overflow}` : ""}`);
    if (modified.items.length)
      lines.push(`  ~ ${modified.items.join(", ")}${modified.overflow ? ` … +${modified.overflow}` : ""}`);
    if (removed.items.length)
      lines.push(`  - ${removed.items.join(", ")}${removed.overflow ? ` … +${removed.overflow}` : ""}`);
  }

  if (enrichedCommits.length > 10) lines.push(`… and ${enrichedCommits.length - 10} more commits`);
  if (compareUrl) lines.push(`\n${compareUrl}`);

  const body = lines.join("\n");

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[WhatsApp] API error:", JSON.stringify(data, null, 2));
    } else {
      console.log("[WhatsApp] Sent — message id:", data?.messages?.[0]?.id ?? "?");
    }
  } catch (err) {
    console.error("[WhatsApp] Unexpected error:", err.message);
  }
}

// ─── Discord (incoming webhook) ──────────────────────────────────────────────

async function sendDiscord(enrichedCommits) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[Discord] Skipped — DISCORD_WEBHOOK_URL not set");
    return;
  }

  function buildFieldValue(c) {
    const lines = [];
    for (const f of (c.added    || [])) lines.push(`+ ${f}`);
    for (const f of (c.modified || [])) lines.push(`~ ${f}`);
    for (const f of (c.removed  || [])) lines.push(`- ${f}`);
    if (!lines.length) return "*(no file changes listed)*";
    const block    = lines.slice(0, 20).join("\n");
    const overflow = lines.length > 20 ? `\n… +${lines.length - 20} more` : "";
    const raw      = `\`\`\`diff\n${block}${overflow}\n\`\`\``;
    return raw.length <= 1024 ? raw : raw.slice(0, 1021) + "…";
  }

  const fields = enrichedCommits.slice(0, 10).map((c) => ({
    name:   `\`${shortSha(c)}\` ${firstLine(c.message)}`.slice(0, 256),
    value:  buildFieldValue(c),
    inline: false,
  }));

  if (enrichedCommits.length > 10) {
    fields.push({ name: "More commits", value: `… and ${enrichedCommits.length - 10} more`, inline: false });
  }

  const embed = {
    title:  `Push to \`${repo}\` · \`${branch}\``.slice(0, 256),
    url:    compareUrl || undefined,
    color:  0x5865f2,
    fields,
    footer: { text: `Pushed by ${pusher} · ${enrichedCommits.length} commit${enrichedCommits.length !== 1 ? "s" : ""}` },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[Discord] Error:", res.status, text);
    } else {
      console.log("[Discord] Sent OK");
    }
  } catch (err) {
    console.error("[Discord] Unexpected error:", err.message);
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const enrichedCommits = await enrichCommits(commits);
await Promise.all([sendWhatsApp(enrichedCommits), sendDiscord(enrichedCommits)]);
