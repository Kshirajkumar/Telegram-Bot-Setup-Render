import 'dotenv/config';
import express from 'express';

const app = express();
const port = Number(process.env.PORT || 10000);
const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const publicUrl = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const webhookPath = '/telegram/webhook';

if (!botToken) {
  console.error('Missing TELEGRAM_BOT_TOKEN. Add it to .env locally or Render environment variables.');
  process.exit(1);
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

app.get('/', (_request, response) => {
  response.json({ service: 'telegram-bot', status: 'ok' });
});

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.post(webhookPath, async (request, response) => {
  if (webhookSecret && request.get('x-telegram-bot-api-secret-token') !== webhookSecret) {
    return response.sendStatus(401);
  }

  // Acknowledge Telegram quickly; processing can happen after the response.
  response.sendStatus(200);
  try {
    await handleUpdate(request.body);
  } catch (error) {
    console.error('Update handling failed:', error);
  }
});

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(result)}`);
  }
  return result.result;
}

async function handleUpdate(update) {
  const message = update?.message;
  if (!message?.chat?.id) return;

  const chatId = message.chat.id;
  const text = message.text?.trim() || '';

  if (text === '/start') {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Welcome! Your Telegram bot is online. Send me a message and I will echo it.'
    });
    return;
  }

  if (text === '/help') {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Commands:\n/start - check that the bot is online\n/help - show this help\n/ping - test the connection'
    });
    return;
  }

  if (text === '/ping') {
    await telegram('sendMessage', { chat_id: chatId, text: 'pong' });
    return;
  }

  if (text) {
    await telegram('sendMessage', { chat_id: chatId, text: `You said: ${text}` });
  }
}

async function configureWebhook() {
  if (!publicUrl) {
    console.warn('PUBLIC_URL/RENDER_EXTERNAL_URL is not set; webhook registration was skipped.');
    return;
  }

  const webhookUrl = `${publicUrl}${webhookPath}`;
  await telegram('setWebhook', {
    url: webhookUrl,
    ...(webhookSecret ? { secret_token: webhookSecret } : {})
  });
  console.log(`Telegram webhook configured: ${webhookUrl}`);
}

const server = app.listen(port, () => {
  console.log(`Telegram bot listening on port ${port}`);
  configureWebhook().catch((error) => console.error('Webhook setup failed:', error.message));
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

