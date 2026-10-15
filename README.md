# Telegram Bot for Render

This is a small Telegram webhook bot designed to run on Render's free web service. It includes:

- `/health` for Render health checks
- automatic Telegram webhook registration on startup
- `/start`, `/help`, and `/ping` commands
- a simple text echo handler you can replace with your bot's real behavior
- no secrets committed to the repository

## 1. Create the Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`, choose a name, and choose a username ending in `bot`.
3. Copy the token. Treat it like a password; never commit it to Git.

## 2. Run locally

Install Node.js 20 or newer, then run:

```powershell
Copy-Item .env.example .env
# Edit .env and set TELEGRAM_BOT_TOKEN
npm install
npm start
```

For Telegram to reach your local computer, set `PUBLIC_URL` to an HTTPS tunnel URL (for example, an ngrok or Cloudflare Tunnel URL). Without a public URL, the server and health endpoint still run, but Telegram webhook registration is skipped.

## 3. Deploy to Render

1. Create a new GitHub repository.
2. From this folder, run the Git commands shown below and push the repository.
3. In Render, choose **New + → Blueprint** and select the repository. Render will read `render.yaml`.
4. When prompted, enter `TELEGRAM_BOT_TOKEN` as a secret environment variable.
5. Deploy. Render supplies `RENDER_EXTERNAL_URL`; the app uses it to register the webhook automatically.
6. Open the bot in Telegram and send `/start`.

The service must be a **Web Service**, not a static site or background worker. Free Render services can sleep after inactivity; Telegram will wake the service when a webhook request arrives, though the first response may take longer.

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

## Customize the bot

Edit `handleUpdate` in `src/server.js`. Keep financial, user, or third-party API credentials in Render environment variables, not in source code. If you add a database or external API, handle timeouts and failures explicitly so Telegram requests do not crash the process.

## Useful checks

After deployment, open:

```text
https://YOUR-SERVICE.onrender.com/health
```

It should return JSON with `"status":"ok"`. Render logs should contain `Telegram webhook configured` after a successful startup.

