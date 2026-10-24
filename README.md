# Telegram Bot for Render

This service is the Telegram webhook ingress for a TaxFlow.AI deployment. Telegram delivers each update here; the service authenticates it and forwards it to the TaxFlow backend before acknowledging Telegram. A failed relay returns a retryable response rather than dropping the update.

It includes:

- `/health` for Render health checks
- automatic webhook registration to this service on startup
- `/start`, `/help`, and `/ping` commands
- authenticated, synchronous forwarding of text messages to TaxFlow
- local acknowledgement and discard of Telegram media updates without forwarding their metadata
- no file download or client data storage in this relay service
- no secrets committed to the repository

## 1. Create the Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name, and choose a username ending in `bot`.
3. Copy the token. Treat it like a password; never commit it to Git.

## 2. Run locally

Install Node.js 20 or newer, then run:

```powershell
Copy-Item .env.example .env
# Set the required values described below in .env
npm install
npm start
```

The relay requires `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TAXFLOW_TELEGRAM_WEBHOOK_URL`, and a public HTTPS URL (`PUBLIC_URL` locally or Render's `RENDER_EXTERNAL_URL`). In the Telegram bot Render service's **Environment** settings, set `TAXFLOW_TELEGRAM_WEBHOOK_URL` to the full URL `https://<your-taxflow-backend-host>/api/v1/telegram/webhook`; do not enter only the backend's hostname or dashboard URL. Startup fails with a specific setup error if this value is missing or malformed.

## 3. Deploy to Render

1. Create a new GitHub repository.
2. From this folder, run the Git commands shown below and push the repository.
3. In Render, choose **New + → Blueprint** and select the repository. Render will read `render.yaml`.
4. Set `TELEGRAM_BOT_TOKEN` and `TAXFLOW_TELEGRAM_WEBHOOK_URL` (`https://<your-taxflow-backend-host>/api/v1/telegram/webhook`) in the Telegram bot service's **Environment** page. The TaxFlow host must be the public URL of the deployed TaxFlow backend, not this Telegram bot service's URL.
5. Render generates `TELEGRAM_WEBHOOK_SECRET`. Copy that exact value to the TaxFlow backend's `TELEGRAM_WEBHOOK_SECRET` environment variable. This shared secret authenticates the relay request; do not put it in a URL or logs.
6. Deploy. Render supplies `RENDER_EXTERNAL_URL`; this service registers itself as the Telegram webhook owner.
7. On the TaxFlow backend, set `TELEGRAM_WEBHOOK_AUTO_CONFIGURE=false` and `TELEGRAM_WEBHOOK_RELAY_URL` to this service's `/telegram/webhook` URL. Do not let the TaxFlow backend overwrite the Telegram webhook.
8. Deploy both services and confirm this service's `/health` is healthy, TaxFlow's Telegram diagnostics show the relay URL, and Telegram has no recent webhook error.
9. Link a private Telegram chat to a TaxFlow client and send a text message. Upload documents only through the secure client portal. Telegram photos, documents, audio, video, stickers, and other supported media updates are acknowledged and discarded by this relay; they are not forwarded, downloaded, or stored.

The service must be a **Web Service**, not a static site or background worker. Free Render services can sleep after inactivity; a delayed request may exceed the relay timeout and be retried by Telegram. In production, use a plan that meets your latency and availability needs. Telegram is a text and client-connection channel only. Client documents must be uploaded through the secure portal and stored using the portal's private Supabase Storage flow.

## Push commands

Run these one at a time from this folder:

```powershell
git init
git add .
git commit -m "chore: add Render Telegram bot starter"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Replace the remote URL before running the last command. If Git says a remote already exists, use `git remote set-url origin YOUR_URL`.

## Operations and troubleshooting

- Do not configure a second webhook owner for this bot. Only this service should call `setWebhook`.
- If TaxFlow is unavailable or returns a non-2xx response, this service returns HTTP 503 to Telegram. Check both Render services' logs and Telegram webhook diagnostics; do not treat a webhook receipt as successful until TaxFlow acknowledges it.
- Media updates are deliberately acknowledged with HTTP 200 and discarded so Telegram does not retry them. Clients should upload documents through their secure portal instead.
- If startup reports `TAXFLOW_TELEGRAM_WEBHOOK_URL is missing`, add that variable to the Telegram bot service's Render **Environment** settings, save it, and redeploy. Confirm the value ends with `/api/v1/telegram/webhook`.
- Webhook requests require Telegram's secret-token header. Relay requests use the same secret over HTTPS.
- Keep financial, user, and third-party API credentials in Render environment variables, never in source code.

## Useful checks

After deployment, open:

```text
https://YOUR-SERVICE.onrender.com/health
```

It should return JSON with `"success":true`. Render logs should contain `Telegram webhook configured` after a successful startup. Logs include update IDs and failure status only; never add bot tokens, relay secrets, or message contents to logs.

## Local tests

Run the relay's isolated HTTP tests with:

```powershell
node --test src/server.test.js
```
