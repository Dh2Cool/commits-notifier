# Commits Notifier

Every time a commit is pushed to this repository, a GitHub Actions workflow fires and sends a notification to:

- **WhatsApp** (yourself) — via Meta / WhatsApp Cloud API
- **Discord** (a channel of your choice) — via an incoming webhook

No server to host or maintain. GitHub runs the job for free on every push.

---

## How it works

```
git push
  └─▶ GitHub Actions (notify.yml)
        └─▶ scripts/notify.mjs
              ├─▶ Meta Cloud API  → WhatsApp message to your number
              └─▶ Discord webhook → embed in your channel
```

Each destination is **independently optional** — if its secrets are missing the step is skipped without failing the workflow. You can enable one at a time.

---

## Setup

### 1. Add this repo to GitHub

Push the project to a GitHub repository (or add these files to an existing one).

---

### 2. WhatsApp — Meta Cloud API

You need a **Meta Developer account** and a **WhatsApp Business** phone number.

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App** → choose **Business**.
2. Add the **WhatsApp** product to the app.
3. In **WhatsApp → API Setup** you will find:
   - **Phone Number ID** → copy this, it goes into `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** (valid 24 h for testing) — or generate a **permanent System User token** for production → goes into `WHATSAPP_TOKEN`
4. Your own WhatsApp number (international digits only, e.g. `919876543210`) goes into `WHATSAPP_TO_NUMBER`.
5. **Important:** the first time you message a number, Meta requires an **opt-in**. For personal use during development, send any message from the test number to your number first using the "Send test message" button in the dashboard — this registers the opt-in.

---

### 3. Discord — Incoming Webhook

1. Open Discord → right-click the channel you want → **Edit Channel**.
2. Go to **Integrations** → **Webhooks** → **New Webhook**.
3. Give it a name (e.g. `GitHub Commits`), click **Copy Webhook URL**.
4. That URL is your `DISCORD_WEBHOOK_URL`.

---

### 4. Add GitHub Actions Secrets

In your GitHub repo go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Where to find it |
|---|---|
| `WHATSAPP_TOKEN` | Meta Developer dashboard — access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta Developer dashboard — Phone Number ID |
| `WHATSAPP_TO_NUMBER` | Your personal WhatsApp number (digits only, e.g. `919876543210`) |
| `DISCORD_WEBHOOK_URL` | Copied from Discord channel integrations |

You only need to add the secrets for the destinations you want. Missing secrets = that destination is skipped.

---

### 5. Push a commit

That's it. The workflow at `.github/workflows/notify.yml` triggers on every push to any branch. Check the **Actions** tab in GitHub to see the run logs.

---

## Message format

**WhatsApp**
```
New push to owner/repo
Branch: `main`
Pusher: dhruv
Commits: 2

• a1b2c3d — fix login bug
  ~ src/auth.js, src/session.js
• d4e5f6a — add user profile page
  + src/profile.js, src/profile.css
```

**Discord** — a rich embed with per-commit fields showing a `diff`-style file list, a link to the compare view on GitHub, timestamp, and pusher name in the footer.

---

## Local testing

You can run the script locally against a fake event:

```powershell
$env:GITHUB_EVENT_JSON = Get-Content test-event.json -Raw
$env:DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/..."
node scripts/notify.mjs
```

A minimal `test-event.json`:

```json
{
  "ref": "refs/heads/main",
  "repository": { "full_name": "you/your-repo" },
  "pusher": { "name": "dhruv" },
  "compare": "https://github.com/you/your-repo/compare/abc...def",
  "commits": [
    {
      "id": "abc1234",
      "message": "fix: correct null check",
      "added": [],
      "modified": ["src/index.js"],
      "removed": []
    }
  ]
}
```

---

## Files

```
.github/
  workflows/
    notify.yml        ← Actions workflow (triggers on push)
scripts/
  notify.mjs          ← notification logic (WhatsApp + Discord)
.env.example          ← copy to .env for local testing
package.json
README.md
```
