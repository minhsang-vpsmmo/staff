'use strict';

const logger = require('./logger');
const log = logger.child({ module: 'telegram' });

const TELEGRAM_API = 'https://api.telegram.org/bot';

let _botToken = null;
let _adminChatId = null;

function init(config) {
  _botToken = config.TELEGRAM_BOT_TOKEN;
  _adminChatId = config.TELEGRAM_ADMIN_CHAT_ID;
}

async function sendMessage(chatId, text, opts = {}) {
  if (!chatId || !_botToken) return;
  try {
    const res = await fetch(`${TELEGRAM_API}${_botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...opts,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      log.error({ event: 'telegram.send_failed', chatId, status: res.status, body });
    }
  } catch (err) {
    log.error({ event: 'telegram.send_error', chatId, err: err.message });
  }
}

async function sendToAdmin(text) {
  if (_adminChatId) {
    await sendMessage(_adminChatId, text);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { init, sendMessage, sendToAdmin, escapeHtml };
