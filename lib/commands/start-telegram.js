const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { validateDirectory } = require('../utils/validation');
const logger = require('../utils/logger');
const { selectManualTool } = require('../ai-tools/selector');
const { getConfig, setConfig } = require('../config/manager');
const { getSessionByDirectory, addSession, updateSession } = require('../session/registry');
const { createSession } = require('../session/state');
const OpenCodeClient = require('../ai-tools/opencode-client');
const TelegramBot = require('../network/telegram-bot');
const { formatPermissionHtml, markdownToTelegramHtml, escapeHtml } = require('../utils/telegram-format');
const { TELEGRAM_MAX_MODEL_BUTTONS, TELEGRAM_MAX_SESSION_BUTTONS, TELEGRAM_INBOX_FOLDER } = require('../config/constants');

function generatePairingCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';

  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

function resolveBotToken(options) {
  return options.telegramToken
    || process.env.TERMLY_TELEGRAM_BOT_TOKEN
    || getConfig('telegramBotToken')
    || '';
}

function displayTelegramUI(botUsername, pairingCode, projectName, workingDir) {
  const formattedCode = `${pairingCode.substring(0, 3).split('').join(' ')} - ${pairingCode.substring(3).split('').join(' ')}`;

  console.log('');
  console.log(chalk.bold.cyan('┌──────────────────────────────────────────────────┐'));
  console.log(chalk.bold.cyan('│ Termly × Telegram (OpenCode)                     │'));
  console.log(chalk.bold.cyan('│                                                  │'));
  console.log(chalk.cyan(`│ Project: ${projectName.padEnd(37)}  │`));
  console.log(chalk.cyan(`│ Bot:     @${String(botUsername).padEnd(36)}  │`));
  console.log(chalk.bold.cyan('│                                                  │'));
  console.log(chalk.bold.cyan('│ Open the bot and send this code:                 │'));
  console.log(chalk.bold.cyan('│                                                  │'));
  console.log(chalk.bold.cyan(`│      ${chalk.bold.yellow(formattedCode)}                              │`));
  console.log(chalk.bold.cyan('│                                                  │'));
  console.log(chalk.yellow('│ Waiting for Telegram pairing...                  │'));
  console.log(chalk.gray(`│ ${workingDir.substring(0, 46).padEnd(46)} │`));
  console.log(chalk.bold.cyan('└──────────────────────────────────────────────────┘'));
  console.log('');
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return '';
  }

  const then = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const delta = Date.now() - then;
  const minutes = Math.max(0, Math.floor(delta / 60000));

  if (minutes < 1) {
    return 'ahora';
  }
  if (minutes < 60) {
    return `hace ${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `hace ${hours}h`;
  }

  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

function sessionLabel(session, currentId) {
  const title = (session.title || session.slug || session.id).slice(0, 40);
  const when = formatRelativeTime(session.time && session.time.updated);
  const current = session.id === currentId ? ' ●' : '';
  return `${title}${when ? ` · ${when}` : ''}${current}`.slice(0, 64);
}

async function startTelegramCommand(directory, options) {
  if (options.ai && options.ai !== 'opencode') {
    logger.error('Telegram mode currently supports OpenCode only');
    console.error('');
    console.error(chalk.cyan('  termly start --telegram'));
    process.exit(1);
  }

  const workingDir = path.resolve(directory || process.cwd());
  const validation = validateDirectory(workingDir);

  if (!validation.valid) {
    logger.error(validation.error);
    process.exit(1);
  }

  const existingSession = getSessionByDirectory(workingDir);
  if (existingSession) {
    console.error(chalk.red('❌ Session already running in this directory!'));
    console.error(chalk.cyan(`  termly stop ${existingSession.sessionId}`));
    process.exit(1);
  }

  const token = resolveBotToken(options);
  if (!token) {
    logger.error('Telegram bot token is required');
    console.error('');
    console.error('1. Create a bot with @BotFather and copy the token');
    console.error('2. Save it:');
    console.error(chalk.cyan('   termly config set telegramBotToken <token>'));
    console.error('   or: export TERMLY_TELEGRAM_BOT_TOKEN=<token>');
    console.error('3. Start:');
    console.error(chalk.cyan('   termly start --telegram'));
    process.exit(1);
  }

  const selectedTool = await selectManualTool('opencode');
  const projectName = path.basename(workingDir);
  const savedChatId = getConfig('telegramChatId') || '';
  const pairingCode = savedChatId ? null : generatePairingCode();

  const inboxDir = path.join(workingDir, TELEGRAM_INBOX_FOLDER);
  fs.mkdirSync(inboxDir, { recursive: true });
  const session = createSession(
    projectName,
    workingDir,
    selectedTool.key,
    selectedTool.displayName,
    selectedTool.version,
    'telegram'
  );

  addSession(session);

  const opencode = new OpenCodeClient(selectedTool.command, workingDir);
  let bot = null;
  let busy = false;
  const queue = [];
  const pendingPermissions = new Map();
  const pendingModels = new Map();
  const pendingSessions = new Map();
  let permissionSeq = 0;

  const cleanup = async () => {
    logger.info('Shutting down...');
    if (bot) {
      bot.stop();
    }
    opencode.close();
    updateSession(session.sessionId, { status: 'stopped' });
    logger.success('Telegram session ended');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    await opencode.start();
    const resumed = await opencode.resumeOrCreate(getConfig('telegramOpenCodeSessionId'));
    setConfig('telegramOpenCodeSessionId', opencode.sessionId);
    await opencode.resolveCurrentModel();
    logger.info(`Using OpenCode chat: ${opencode.sessionTitle(resumed)}`);
    updateSession(session.sessionId, { pid: opencode.getStatus().pid || process.pid });
  } catch (err) {
    logger.error(`Failed to start OpenCode: ${err.message}`);
    updateSession(session.sessionId, { status: 'failed' });
    process.exit(1);
  }

  const sendPrompt = async (text, chatId, files) => {
    const attachments = files || [];
    if (busy) {
      queue.push({ text, chatId, files: attachments });
      await bot.send(chatId, `En cola (${queue.length}). OpenCode sigue trabajando.`);
      return;
    }

    busy = true;
    try {
      const images = attachments.filter((file) => (file.mime || '').startsWith('image/'));
      if (images.length > 0) {
        const canSee = await opencode.modelSupportsVision();
        if (!canSee) {
          const { models } = await opencode.listModels();
          const visionModels = models.filter((model) => model.vision).slice(0, 6);
          const visionLines = visionModels.length
            ? visionModels.map((model) => `<code>/model ${escapeHtml(`${model.providerID}/${model.id}`)}</code>`)
            : ['Conecta Claude, GPT-4o o Gemini con visión.'];
          await bot.send(chatId, [
            '<b>Este modelo no ve imágenes</b>',
            `<code>${escapeHtml(opencode.formatModel())}</code>`,
            '',
            'Es un modelo de texto. No puede analizar fotos.',
            'Cambia a uno con visión y vuelve a mandar la imagen:',
            '',
            ...visionLines
          ].join('\n'), { html: true });
          return;
        }
      }
      const fileNote = attachments.length
        ? `\nAdjuntos: ${attachments.map((file) => file.filename).join(', ')}`
        : '';
      await bot.send(
        chatId,
        `<b>OpenCode</b> (${escapeHtml(opencode.agent)} · ${escapeHtml(opencode.formatModel())}) está trabajando…${fileNote ? `\n<code>${escapeHtml(fileNote.trim())}</code>` : ''}`,
        { html: true }
      );
      console.log('');
      console.log(chalk.cyan(`Telegram → OpenCode [${opencode.agent}]: ${text}`));
      const reply = await opencode.sendPrompt(text, attachments);
      console.log(chalk.green('OpenCode → Telegram'));
      await bot.send(chatId, markdownToTelegramHtml(reply), { html: true });
    } catch (err) {
      logger.error(`OpenCode prompt failed: ${err.message}`);
      await bot.send(chatId, `OpenCode error: ${err.message}`);
    } finally {
      busy = false;
      if (queue.length > 0) {
        const next = queue.shift();
        await sendPrompt(next.text, next.chatId, next.files);
      }
    }
  };

  const permissionText = (permission) => formatPermissionHtml(permission);

  const notifyPermission = async (permission) => {
    const chatId = bot && bot.allowedChatId;
    if (!chatId) {
      logger.warn('Permission requested but no Telegram chat is paired');
      return;
    }

    permissionSeq += 1;
    const seq = String(permissionSeq);
    pendingPermissions.set(seq, permission);

    await bot.send(chatId, permissionText(permission), {
      html: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Aceptar', callback_data: `p:${seq}:once` },
            { text: 'Siempre', callback_data: `p:${seq}:always` }
          ],
          [
            { text: 'Rechazar', callback_data: `p:${seq}:reject` }
          ]
        ]
      }
    });
  };

  const showModels = async (chatId, visionOnly) => {
    const { models } = await opencode.listModels();
    const current = opencode.formatModel();
    const pageSize = TELEGRAM_MAX_MODEL_BUTTONS;
    const list = visionOnly ? models.filter((model) => model.vision) : models;

    pendingModels.clear();
    list.forEach((model, index) => {
      pendingModels.set(String(index), model);
    });

    if (list.length === 0) {
      await bot.send(chatId, visionOnly
        ? `Modelo actual: ${current}\n\nNo hay modelos con visión conectados.`
        : `Modelo actual: ${current}\n\nNo hay modelos conectados.`);
      return;
    }

    const totalPages = Math.ceil(list.length / pageSize);

    for (let page = 0; page < totalPages; page++) {
      const start = page * pageSize;
      const slice = list.slice(start, start + pageSize);
      const header = [
        page === 0 ? `Modelo actual: ${current}${opencode.modelVision ? ' (visión)' : ''}` : null,
        visionOnly ? 'Solo modelos que ven imágenes' : null,
        `Modelos ${start + 1}–${start + slice.length} de ${list.length}`
      ].filter(Boolean).join('\n');

      const buttons = slice.map((model, offset) => {
        const index = start + offset;
        const prefix = model.vision ? '👁 ' : '';
        const label = `${prefix}${model.providerID}/${model.id}`.slice(0, 64);
        return [{ text: label, callback_data: `m:${index}` }];
      });

      await bot.send(chatId, header, {
        reply_markup: { inline_keyboard: buttons }
      });
    }
  };

  const rememberSession = () => {
    setConfig('telegramOpenCodeSessionId', opencode.sessionId);
  };

  const showSessions = async (chatId) => {
    const sessions = await opencode.listProjectSessions();
    const currentId = opencode.sessionId;
    const pageSize = TELEGRAM_MAX_SESSION_BUTTONS;

    pendingSessions.clear();
    sessions.forEach((item, index) => {
      pendingSessions.set(String(index), item);
    });

    if (sessions.length === 0) {
      await bot.send(chatId, 'No hay conversaciones todavía. Escribe un prompt o usa /new.');
      return;
    }

    const totalPages = Math.ceil(sessions.length / pageSize);

    for (let page = 0; page < totalPages; page++) {
      const start = page * pageSize;
      const slice = sessions.slice(start, start + pageSize);
      const header = [
        `Chat actual: ${opencode.sessionTitle()}`,
        `Conversaciones ${start + 1}–${start + slice.length} de ${sessions.length}`,
        'Toca una para continuar.'
      ].join('\n');

      const buttons = slice.map((item, offset) => {
        const index = start + offset;
        return [{ text: sessionLabel(item, currentId), callback_data: `c:${index}` }];
      });

      await bot.send(chatId, header, {
        reply_markup: { inline_keyboard: buttons }
      });
    }
  };

  opencode.onPermission(notifyPermission);

  bot = new TelegramBot({
    token,
    pairingCode,
    allowedChatId: savedChatId || null,
    inboxDir,
    onPaired: (chatId) => {
      setConfig('telegramChatId', chatId);
      updateSession(session.sessionId, { mobileConnected: true });
      console.log(chalk.green(`📱 Telegram paired (chat ${chatId})`));
    },
    onMessage: sendPrompt,
    onCallback: async (query) => {
      const data = query.data || '';
      const chatId = String(query.message.chat.id);
      const messageId = query.message.message_id;

      if (data.startsWith('p:')) {
        const parts = data.split(':');
        const seq = parts[1];
        const reply = parts[2];
        const permission = pendingPermissions.get(seq);

        if (!permission) {
          await bot.answerCallback(query.id, 'Este permiso ya no está pendiente');
          return;
        }

        await opencode.replyPermission(permission, reply);
        pendingPermissions.delete(seq);

        const labels = {
          once: 'Aceptado una vez',
          always: 'Aceptado siempre',
          reject: 'Rechazado'
        };

        await bot.answerCallback(query.id, labels[reply] || reply);
        await bot.editMessage(
          chatId,
          messageId,
          `${permissionText(permission)}\n\n<b>${labels[reply] || reply}</b>`,
          { html: true, reply_markup: { inline_keyboard: [] } }
        );
        return;
      }

      if (data.startsWith('m:')) {
        const key = data.slice(2);
        const model = pendingModels.get(key);
        if (!model) {
          await bot.answerCallback(query.id, 'Ese modelo ya no está en la lista');
          return;
        }

        await opencode.setModel(`${model.providerID}/${model.id}`);
        await bot.answerCallback(query.id, `Modelo: ${opencode.formatModel()}`);
        await bot.editMessage(
          chatId,
          messageId,
          `Modelo actual: ${opencode.formatModel()}`,
          { reply_markup: { inline_keyboard: [] } }
        );
        return;
      }

      if (data.startsWith('c:')) {
        const key = data.slice(2);
        const selected = pendingSessions.get(key);
        if (!selected) {
          await bot.answerCallback(query.id, 'Esa conversación ya no está en la lista');
          return;
        }

        const attached = await opencode.useSession(selected.id);
        rememberSession();
        await bot.answerCallback(query.id, 'Conversación reanudada');
        await bot.editMessage(
          chatId,
          messageId,
          `Continuando: ${opencode.sessionTitle(attached)}`,
          { reply_markup: { inline_keyboard: [] } }
        );
      }
    },
    onCommand: async (command, arg, chatId) => {
      const switchAgent = async (name) => {
        const agent = await opencode.setAgent(name);
        const description = opencode.describeAgent(agent.name);
        await bot.send(chatId, `Modo ${agent.name}: ${description}.`);

        if (arg) {
          await sendPrompt(arg, chatId);
        }
      };

      switch (command) {
        case 'start':
        case 'help':
          await bot.send(chatId, [
            '<b>Termly × OpenCode</b>',
            '',
            `Modo: <b>${escapeHtml(opencode.agent)}</b> — ${escapeHtml(opencode.describeAgent(opencode.agent))}`,
            `Modelo: <code>${escapeHtml(opencode.formatModel())}</code>`,
            `Chat: ${escapeHtml(opencode.sessionTitle())}`,
            '',
            '<b>Comandos</b>',
            '/plan — analiza, no edita código',
            '/build — implementa cambios',
            '/model — ver modelos  ·  /model vision — solo los que ven fotos',
            '/sessions — ver y continuar conversaciones',
            '/new — nueva sesión',
            '/abort — cancelar la tarea actual',
            '/status — proyecto, modo, modelo y estado',
            '',
            '<b>Archivos</b>',
            'Manda una foto o un documento. Las fotos requieren un modelo con visión (👁).',
            `Se guardan en <code>${escapeHtml(TELEGRAM_INBOX_FOLDER)}</code> del proyecto.`,
            '',
            'Si OpenCode quiere correr un comando o tocar archivos, te llega Aceptar / Rechazar.'
          ].join('\n'), { html: true });
          break;

        case 'plan':
          await switchAgent('plan');
          break;

        case 'build':
          await switchAgent('build');
          break;

        case 'agent':
          if (!arg) {
            await bot.send(chatId, `Modo actual: ${opencode.agent}. Usa /plan, /build o /agents.`);
            break;
          }
          await switchAgent(arg);
          break;

        case 'model':
        case 'modelo':
          if (!arg || arg === 'vision') {
            await showModels(chatId, arg === 'vision');
            break;
          }
          await opencode.setModel(arg);
          await bot.send(
            chatId,
            `Modelo actual: ${opencode.formatModel()}${opencode.modelVision ? ' (ve imágenes)' : ' (solo texto)'}`
          );
          break;

        case 'sessions':
        case 'chats':
        case 'continue':
          await showSessions(chatId);
          break;

        case 'agents': {
          const agents = await opencode.listAgents();
          const lines = agents.map((agent) => {
            const current = agent.name === opencode.agent ? ' (actual)' : '';
            const summary = agent.description ? ` — ${agent.description}` : '';
            return `/${agent.name}${current}${summary}`;
          });
          await bot.send(chatId, ['Agentes:', '', ...(lines.length ? lines : ['plan', 'build'])].join('\n'));
          break;
        }

        case 'new': {
          const created = await opencode.newSession();
          rememberSession();
          await bot.send(chatId, `Nueva sesión: ${opencode.sessionTitle(created)}`);
          break;
        }

        case 'abort':
        case 'stop':
          await opencode.abort();
          busy = false;
          await bot.send(chatId, 'Tarea de OpenCode cancelada.');
          break;

        case 'status': {
          const status = opencode.getStatus();
          await bot.send(chatId, [
            `Proyecto: ${projectName}`,
            `Directorio: ${workingDir}`,
            `Modo: ${status.agent} (${opencode.describeAgent(status.agent)})`,
            `Modelo: ${status.model}${status.vision ? ' (ve imágenes)' : ' (solo texto)'}`,
            `Conversación: ${opencode.sessionTitle()}`,
            `ID: ${status.sessionId}`,
            `Servidor: ${status.baseUrl}`,
            busy ? 'Estado: trabajando' : 'Estado: idle'
          ].join('\n'));
          break;
        }

        default:
          await bot.send(chatId, `Comando /${command} desconocido. Toca / o usa /help`);
      }
    }
  });

  let botInfo;
  try {
    botInfo = await bot.start();
  } catch (err) {
    opencode.close();
    logger.error(`Failed to connect to Telegram: ${err.message}`);
    updateSession(session.sessionId, { status: 'failed' });
    process.exit(1);
  }

  if (savedChatId) {
    updateSession(session.sessionId, { mobileConnected: true });
    console.log('');
    logger.success(`Telegram client ready (@${botInfo.username})`);
    console.log(chalk.gray(`Chat ID: ${savedChatId}`));
    console.log(chalk.gray(`Project: ${projectName}`));
    console.log(chalk.gray('Toca / en Telegram para ver plan, build y el resto de comandos.'));
    console.log('');
    await bot.send(savedChatId, [
      `<b>OpenCode listo</b> en ${escapeHtml(projectName)}.`,
      `Conversación: ${escapeHtml(opencode.sessionTitle())}`,
      `Modo: <b>${escapeHtml(opencode.agent)}</b> · modelo <code>${escapeHtml(opencode.formatModel())}</code>`,
      '',
      `Fotos y documentos se guardan en <code>${escapeHtml(TELEGRAM_INBOX_FOLDER)}</code>.`,
      'Toca /sessions para continuar otro chat.'
    ].join('\n'), { html: true });
  } else {
    displayTelegramUI(botInfo.username, pairingCode, projectName, workingDir);
  }
}

module.exports = startTelegramCommand;
