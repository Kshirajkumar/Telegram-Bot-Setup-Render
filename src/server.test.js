import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTelegramBot, loadConfig } from './server.js';

const config = {
  token: 'test-token',
  webhookSecret: 'a-test-secret-with-more-than-16-characters',
  taxflowWebhookUrl: 'https://taxflow.example.com/api/v1/telegram/webhook',
  webhookUrl: 'https://telegram.example.com/telegram/webhook',
};
const serverErrors = [];
const calls = [];
let server;
let baseUrl;
let relayStatus = 200;
let relayPayload = { ok: true };
let telegramStatus = 200;

const bot = createTelegramBot({
  config,
  logger: { info() {}, error(message) { serverErrors.push(message); } },
  fetchImpl: async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const isTelegram = String(url).startsWith('https://api.telegram.org/');
    const status = isTelegram ? telegramStatus : relayStatus;
    const payload = isTelegram ? { ok: status < 400 } : relayPayload;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  },
});

before(async () => {
  await new Promise((resolve) => {
    server = bot.app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function sendWebhook(update, secret = config.webhookSecret) {
  return fetch(`${baseUrl}/telegram/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(update),
  });
}

test('configuration requires a destination, HTTPS, and webhook secret', () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN is required/);
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: config.webhookSecret,
    RENDER_EXTERNAL_URL: 'https://telegram.example.com',
  }), /TAXFLOW_TELEGRAM_WEBHOOK_URL is missing.*Render service environment.*api\/v1\/telegram\/webhook/);
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: config.webhookSecret,
    TAXFLOW_TELEGRAM_WEBHOOK_URL: 'taxflow.example.com/api/v1/telegram/webhook',
    RENDER_EXTERNAL_URL: 'https://telegram.example.com',
  }), /TAXFLOW_TELEGRAM_WEBHOOK_URL is invalid.*complete HTTPS URL/);
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: 'short',
    TAXFLOW_TELEGRAM_WEBHOOK_URL: 'http://taxflow.example.com/api/v1/telegram/webhook',
    RENDER_EXTERNAL_URL: 'https://telegram.example.com',
  }), /16-256 characters/);
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_WEBHOOK_SECRET: config.webhookSecret,
    TAXFLOW_TELEGRAM_WEBHOOK_URL: 'http://taxflow.example.com/api/v1/telegram/webhook',
    RENDER_EXTERNAL_URL: 'https://telegram.example.com',
  }), /HTTPS URL/);
});

test('text messages are relayed with the shared webhook secret', async () => {
  calls.length = 0;
  relayStatus = 200;
  relayPayload = { ok: true };
  const update = { update_id: 71, message: { message_id: 5, chat: { id: 9 }, text: 'Hello' } };
  const response = await sendWebhook(update);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.taxflowWebhookUrl);
  assert.equal(calls[0].options.headers['x-telegram-bot-api-secret-token'], config.webhookSecret);
  assert.deepEqual(JSON.parse(calls[0].options.body), update);
});

test('media messages are acknowledged without forwarding file metadata or captions', async () => {
  const media = [
    { photo: [{ file_id: 'photo-1' }] },
    { document: { file_id: 'document-1', file_name: 'private.pdf' } },
    { video: { file_id: 'video-1' } },
    { animation: { file_id: 'animation-1' } },
    { video_note: { file_id: 'video-note-1' } },
    { audio: { file_id: 'audio-1' } },
    { voice: { file_id: 'voice-1' } },
    { sticker: { file_id: 'sticker-1' } },
    { paid_media: [{ type: 'photo', media: { file_id: 'paid-photo-1' } }] },
    { document: { file_id: 'caption-command' }, caption: '/start private-link-code' },
  ];

  for (const [index, payload] of media.entries()) {
    calls.length = 0;
    const response = await sendWebhook({
      update_id: 78 + index,
      message: { message_id: index + 1, chat: { id: 9 }, ...payload },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, ignored: true });
    assert.equal(calls.length, 0, 'media updates must not be forwarded or trigger bot replies');
  }

  calls.length = 0;
  const editedResponse = await sendWebhook({
    update_id: 90,
    edited_message: { chat: { id: 9 }, photo: [{ file_id: 'edited-photo' }], caption: 'edited caption' },
  });
  assert.equal(editedResponse.status, 200);
  assert.deepEqual(await editedResponse.json(), { success: true, ignored: true });
  assert.equal(calls.length, 0);
});

test('webhook registration keeps the relay as the sole Telegram ingress', async () => {
  calls.length = 0;
  await bot.configureWebhook();
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/setWebhook$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    url: config.webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ['message', 'edited_message'],
  });
});

test('TaxFlow client-link commands are forwarded instead of consumed by local bot commands', async () => {
  calls.length = 0;
  const update = {
    update_id: 76,
    message: { chat: { id: 9 }, text: '/start one-time-link-code' },
  };
  const response = await sendWebhook(update);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.taxflowWebhookUrl);
  assert.deepEqual(JSON.parse(calls[0].options.body), update);
});

test('invalid secrets are rejected without forwarding', async () => {
  calls.length = 0;
  const response = await sendWebhook({ update_id: 72 }, 'wrong-secret');
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('TaxFlow failures return a retryable response to Telegram', async () => {
  relayStatus = 503;
  const response = await sendWebhook({ update_id: 73, message: { chat: { id: 9 }, text: 'hello' } });
  assert.equal(response.status, 503);
  relayStatus = 200;
});

test('TaxFlow must confirm acceptance before the relay acknowledges Telegram', async () => {
  relayPayload = { success: true };
  const response = await sendWebhook({ update_id: 77, message: { chat: { id: 9 }, text: 'hello' } });
  assert.equal(response.status, 503);
  relayPayload = { ok: true };
});

test('invalid updates are rejected and bot health stays available', async () => {
  assert.equal((await sendWebhook({ message: {} })).status, 400);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');
  assert.equal((await fetch(`${baseUrl}/`)).status, 200);
});

test('local ping command is answered without being relayed', async () => {
  calls.length = 0;
  const response = await sendWebhook({ update_id: 74, message: { chat: { id: 9 }, text: '/ping' } });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /api\.telegram\.org\/bottest-token\/sendMessage$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { chat_id: 9, text: 'pong' });
});

test('Telegram send failures are surfaced as retryable', async () => {
  telegramStatus = 502;
  const response = await sendWebhook({ update_id: 75, message: { chat: { id: 9 }, text: '/ping' } });
  assert.equal(response.status, 503);
  telegramStatus = 200;
});
