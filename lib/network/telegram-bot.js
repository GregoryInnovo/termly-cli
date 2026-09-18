const fs = require('fs');
const path = require('path');
const axios = require('axios').default || require('axios');
const logger = require('../utils/logger');
const {
  TELEGRAM_API_BASE,
  TELEGRAM_POLL_TIMEOUT,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_BOT_COMMANDS,
  TELEGRAM_MAX_UPLOAD_BYTES
} = require('../config/constants');

class TelegramBot {
  constructor(options) {
    this.token = options.token;
    this.pairingCode = options.pairingCode || null;
    this.allowedChatId = options.allowedChatId ? String(options.allowedChatId) : null;
    this.inboxDir = options.inboxDir || null;
    this.onMessage = options.onMessage || null;
    this.onCommand = options.onCommand || null;
    this.onPaired = options.onPaired || null;
    this.onCallback = options.onCallback || null;

    this.http = axios.create({
      baseURL: `${TELEGRAM_API_BASE}/bot${this.token}`,
      timeout: (TELEGRAM_POLL_TIMEOUT + 10) * 1000
    });

    this.offset = 0;
    this.running = false;
    this.botInfo = null;
  }

  async start() {
    const me = await this.http.get('/getMe');
    if (!me.data || !me.data.ok) {
      throw new Error('Telegram getMe failed — check the bot token');
    }

    this.botInfo = me.data.result;
    await this.setCommands(TELEGRAM_BOT_COMMANDS);
    this.running = true;
    logger.success(`Telegram bot @${this.botInfo.username} connected`);
    this.poll();
    return this.botInfo;
  }

  async setCommands(commands) {
    try {
      await this.http.post('/setMyCommands', { commands });
      logger.debug(`Registered ${commands.length} Telegram bot commands`);
    } catch (err) {
      logger.debug(`Failed to set Telegram commands: ${err.message}`);
    }
  }

  stop() {
    this.running = false;
  }

  async poll() {
    while (this.running) {
      try {
        const response = await this.http.get('/getUpdates', {
          params: {
            timeout: TELEGRAM_POLL_TIMEOUT,
            offset: this.offset,
            allowed_updates: JSON.stringify(['message', 'callback_query'])
          }
        });

        const updates = (response.data && response.data.result) || [];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) {
          return;
        }

        logger.debug(`Telegram poll error: ${err.message}`);
        await delay(2000);
      }
    }
  }

  async handleUpdate(update) {
    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
      return;
    }

    const message = update.message;
    if (!message || !message.chat) {
      return;
    }

    const chatId = String(message.chat.id);
    const text = (message.text || message.caption || '').trim();
    const media = collectMedia(message);

    if (!this.allowedChatId) {
      if (this.isPairingMessage(text)) {
        this.allowedChatId = chatId;
        logger.success(`Telegram chat paired: ${chatId}`);
        if (this.onPaired) {
          this.onPaired(chatId);
        }
        await this.send(chatId, [
          '<b>Paired.</b> Toca / para ver los comandos.',
          '',
          '/plan — analizar sin editar',
          '/build — implementar cambios',
          '/model — cambiar modelo',
          '/sessions — continuar un chat',
          '',
          'Puedes mandar texto, fotos o documentos.'
        ].join('\n'), { html: true });
        return;
      }

      await this.send(chatId, 'This bot is waiting for a pairing code from the Termly CLI.');
      return;
    }

    if (chatId !== this.allowedChatId) {
      logger.debug(`Ignoring Telegram chat ${chatId}`);
      return;
    }

    if (!text && media.length === 0) {
      await this.send(chatId, 'Manda un texto, una foto o un documento para OpenCode.');
      return;
    }

    if (text.startsWith('/') && media.length === 0) {
      const [command, ...rest] = text.slice(1).split(/\s+/);
      const name = command.split('@')[0].toLowerCase();

      if (this.onCommand) {
        Promise.resolve(this.onCommand(name, rest.join(' '), chatId)).catch(async (err) => {
          await this.send(chatId, err.message);
        });
      }
      return;
    }

    if (this.onMessage) {
      Promise.resolve((async () => {
        const files = await this.saveMedia(media);
        const prompt = text || (files.length ? 'Revisa este archivo adjunto.' : '');
        await this.onMessage(prompt, chatId, files);
      })()).catch(async (err) => {
        await this.send(chatId, err.message);
      });
    }
  }

  async saveMedia(media) {
    if (!media.length) {
      return [];
    }

    if (!this.inboxDir) {
      throw new Error('No hay carpeta de adjuntos configurada');
    }

    fs.mkdirSync(this.inboxDir, { recursive: true });
    const saved = [];

    for (const item of media) {
      const file = await this.downloadTelegramFile(item);
      saved.push(file);
    }

    return saved;
  }

  async downloadTelegramFile(item) {
    const info = await this.http.get('/getFile', {
      params: { file_id: item.fileId }
    });

    const filePath = info.data && info.data.result && info.data.result.file_path;
    const fileSize = info.data && info.data.result && info.data.result.file_size;

    if (!filePath) {
      throw new Error('Telegram no devolvió el archivo');
    }

    if (fileSize && fileSize > TELEGRAM_MAX_UPLOAD_BYTES) {
      throw new Error('El archivo supera 20 MB');
    }

    const url = `${TELEGRAM_API_BASE}/file/bot${this.token}/${filePath}`;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      maxContentLength: TELEGRAM_MAX_UPLOAD_BYTES
    });

    const ext = path.extname(item.fileName || filePath) || guessExtension(item.mime);
    const safeName = sanitizeFileName(item.fileName || `telegram-${item.fileId}${ext}`);
    const dest = uniquePath(this.inboxDir, safeName);
    fs.writeFileSync(dest, Buffer.from(response.data));

    logger.info(`Saved Telegram file: ${dest}`);
    return {
      path: dest,
      filename: path.basename(dest),
      mime: item.mime || guessMime(dest)
    };
  }

  async handleCallback(query) {
    const chatId = query.message && query.message.chat
      ? String(query.message.chat.id)
      : null;

    if (!this.allowedChatId || chatId !== this.allowedChatId) {
      await this.answerCallback(query.id, 'Chat no autorizado');
      return;
    }

    if (!this.onCallback) {
      await this.answerCallback(query.id);
      return;
    }

    try {
      await this.onCallback(query);
    } catch (err) {
      await this.answerCallback(query.id, err.message);
    }
  }

  isPairingMessage(text) {
    if (!this.pairingCode || !text) {
      return false;
    }

    const compact = text.replace(/[\s-/]/g, '').toUpperCase();
    const expected = this.pairingCode.toUpperCase();
    return compact === expected || compact === `/START${expected}`;
  }

  async send(chatId, text, extra) {
    const options = extra || {};
    const html = options.html;
    const rest = { ...options };
    delete rest.html;

    const chunks = splitTelegramText(text || '');

    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        chat_id: chatId,
        text: chunks[i]
      };

      if (html) {
        payload.parse_mode = 'HTML';
      }

      if (i === chunks.length - 1) {
        Object.assign(payload, rest);
      }

      try {
        await this.http.post('/sendMessage', payload);
      } catch (err) {
        if (payload.parse_mode) {
          delete payload.parse_mode;
          await this.http.post('/sendMessage', payload);
        } else {
          throw err;
        }
      }
    }
  }

  async answerCallback(callbackQueryId, text) {
    const payload = { callback_query_id: callbackQueryId };
    if (text) {
      payload.text = text.slice(0, 200);
    }

    await this.http.post('/answerCallbackQuery', payload);
  }

  async editMessage(chatId, messageId, text, extra) {
    const options = extra || {};
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text
    };

    if (options.html) {
      payload.parse_mode = 'HTML';
    }

    Object.keys(options).forEach((key) => {
      if (key !== 'html') {
        payload[key] = options[key];
      }
    });

    try {
      await this.http.post('/editMessageText', payload);
    } catch (err) {
      logger.debug(`editMessage failed: ${err.message}`);
    }
  }
}

function collectMedia(message) {
  const media = [];

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1];
    media.push({
      fileId: photo.file_id,
      fileName: `photo-${photo.file_unique_id}.jpg`,
      mime: 'image/jpeg'
    });
  }

  if (message.document) {
    media.push({
      fileId: message.document.file_id,
      fileName: message.document.file_name || `document-${message.document.file_unique_id}`,
      mime: message.document.mime_type || 'application/octet-stream'
    });
  }

  return media;
}

function sanitizeFileName(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let dest = path.join(dir, fileName);
  let n = 2;

  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${base}-${n}${ext}`);
    n += 1;
  }

  return dest;
}

function guessExtension(mime) {
  if (mime === 'image/jpeg') {
    return '.jpg';
  }
  if (mime === 'image/png') {
    return '.png';
  }
  if (mime === 'image/webp') {
    return '.webp';
  }
  if (mime === 'application/pdf') {
    return '.pdf';
  }
  return '';
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return 'image/jpeg';
  }
  if (ext === '.png') {
    return 'image/png';
  }
  if (ext === '.webp') {
    return 'image/webp';
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  if (ext === '.md') {
    return 'text/markdown';
  }
  if (ext === '.txt') {
    return 'text/plain';
  }
  return 'application/octet-stream';
}

function splitTelegramText(text) {
  const limit = TELEGRAM_MAX_MESSAGE_LENGTH;
  if (text.length <= limit) {
    return [text];
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut < limit / 2) {
      cut = limit;
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = TelegramBot;
