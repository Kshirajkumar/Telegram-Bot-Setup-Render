import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RELAY_TIMEOUT_MS = 25_000;

function requireHttpsUrl(value, label, expectedPath) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }

  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials, query parameters, or fragments.`);
  }
  if (expectedPath && url.pathname !== expectedPath) {
    throw new Error(`${label} must use the path ${expectedPath}.`);
  }
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!webhookSecret || webhookSecret.length < 16 || webhookSecret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must be 16-256 characters and use only letters, numbers, underscores, or hyphens.');
  }

  const taxflowWebhookUrl = requireHttpsUrl(
    env.TAXFLOW_TELEGRAM_WEBHOOK_URL?.trim(),
    'TAXFLOW_TELEGRAM_WEBHOOK_URL',
    '/api/v1/telegram/webhook'
  );
  const publicUrl = requireHttpsUrl(env.RENDER_EXTERNAL_URL?.trim() || env.PUBLIC_URL?.trim(), 'RENDER_EXTERNAL_URL');

  return {
    token,
    webhookSecret,
    taxflowWebhookUrl,
    webhookUrl: `${publicUrl}/telegram/webhook`,
  };
}

function secretsMatch(expected, provided) {
  if (typeof provided !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function createTelegramBot({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch API implementation is required.');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb', type: 'application/json' }));

  async function callTelegram(method, payload) {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${config.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch {
      throw new Error('Telegram API request failed.');
    }

    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('Telegram API returned an invalid response.');
    }
    if (!response.ok || result?.ok !== true) {
      throw new Error(`Telegram API rejected the request with HTTP ${response.status}.`);
    }
  }

  async function forwardUpdate(update) {
    let response;
    try {
      response = await fetchImpl(config.taxflowWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': config.webhookSecret,
        },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
    } catch {
      throw new Error('TaxFlow webhook relay request failed.');
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`TaxFlow webhook rejected the update with HTTP ${response.status}.`);
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('TaxFlow webhook returned an invalid response.');
    }
    if (result?.ok !== true) throw new Error('TaxFlow webhook did not confirm that the update was accepted.');
  }

  app.get('/', (_req, res) => {
    res.json({ service: 'telegram-bot', status: 'ok' });
  });

  app.get('/health', (_req, res) => {
    res.json({ success: true, status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.post('/telegram/webhook', async (req, res) => {
    const providedSecret = req.get('x-telegram-bot-api-secret-token');
    if (!secretsMatch(config.webhookSecret, providedSecret)) {
      return res.status(401).json({ success: false, error: 'Invalid webhook secret.' });
    }

    const update = req.body;
    if (!update || typeof update !== 'object' || Array.isArray(update) || !Number.isInteger(update.update_id)) {
      return res.status(400).json({ success: false, error: 'Invalid Telegram update.' });
    }

    const message = update.message;
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    const command = text.match(/^\/(start|help|ping)(?:@\w+)?(?:\s+(.*))?$/i);

    try {
      if (command && command[1].toLowerCase() !== 'start') {
        const reply = command[1].toLowerCase() === 'ping'
          ? 'pong'
          : 'Commands:\n/start <link code> - connect this chat to your TaxFlow client\n/help - show this help\n/ping - test the connection';
        await callTelegram('sendMessage', { chat_id: message.chat.id, text: reply });
      } else if (command && command[1].toLowerCase() === 'start' && !command[2]?.trim()) {
        await callTelegram('sendMessage', {
          chat_id: message.chat.id,
          text: 'Welcome to TaxFlow. Use the Telegram link code provided by your CA with /start to connect this chat.',
        });
      } else {
        await forwardUpdate(update);
      }
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error(`[Telegram] update ${update.update_id} processing failed: ${error.message}`);
      return res.status(503).json({ success: false, error: 'Update processing failed; Telegram may retry.' });
    }
  });

  async function configureWebhook() {
    await callTelegram('setWebhook', {
      url: config.webhookUrl,
      secret_token: config.webhookSecret,
      allowed_updates: ['message', 'edited_message'],
    });
    logger.info(`Telegram webhook configured: ${new URL(config.webhookUrl).origin}/telegram/webhook`);
  }

  return { app, configureWebhook };
}

const isDirectExecution = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectExecution) {
  try {
    const bot = createTelegramBot();
    await bot.configureWebhook();
    const port = Number.parseInt(process.env.PORT || '10000', 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
    const server = await new Promise((resolveServer, reject) => {
      const listeningServer = bot.app.listen(port, '0.0.0.0', () => resolveServer(listeningServer));
      listeningServer.once('error', reject);
    });
    console.log(`Telegram relay listening on port ${port}`);

    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[Telegram] ${signal} received; shutting down.`);
      server.close((error) => {
        if (error) {
          console.error(`[Telegram] graceful shutdown failed: ${error.message}`);
          process.exitCode = 1;
        }
      });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    console.error(`[Telegram] startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
