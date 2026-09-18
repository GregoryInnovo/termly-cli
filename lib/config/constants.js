/**
 * Application constants
 *
 * All magic numbers and configuration values should be defined here.
 */

module.exports = {
  // Network & WebSocket
  HEARTBEAT_TIMEOUT: 13000,        // 13s - detect network loss (server pings every ~5s)
  CLI_IDLE_THRESHOLD: 15000,       // 15s - no PTY output = CLI is idle

  // PTY & Terminal
  RESTORE_RESIZE_DELAY: 2000,      // 2s - delay before restoring terminal size after mobile disconnect

  // Buffer
  DEFAULT_BUFFER_SIZE: 100000,     // 100KB - circular buffer max size

  // Reconnection
  MAX_RECONNECT_ATTEMPTS: 10,      // Max WebSocket reconnection attempts

  // Telegram client (OpenCode)
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  TELEGRAM_POLL_TIMEOUT: 30,             // seconds - long poll getUpdates
  TELEGRAM_MAX_MESSAGE_LENGTH: 4096,     // Telegram hard limit per message
  TELEGRAM_OPENCODE_HOST: '127.0.0.1',
  TELEGRAM_OPENCODE_PORT: 0,             // 0 = let OpenCode pick a free port
  TELEGRAM_OPENCODE_HEALTH_TIMEOUT: 20000,
  TELEGRAM_OPENCODE_PROMPT_TIMEOUT: 600000, // 10 min - agent loops can be long
  TELEGRAM_DEFAULT_AGENT: 'build',
  TELEGRAM_MAX_MODEL_BUTTONS: 20,
  TELEGRAM_MAX_SESSION_BUTTONS: 20,
  TELEGRAM_INBOX_FOLDER: '.termly-inbox',
  TELEGRAM_MAX_UPLOAD_BYTES: 20 * 1024 * 1024,
  TELEGRAM_BOT_COMMANDS: [
    { command: 'plan', description: 'Modo plan (analiza, no edita código)' },
    { command: 'build', description: 'Modo build (implementa cambios)' },
    { command: 'model', description: 'Ver o cambiar el modelo' },
    { command: 'sessions', description: 'Ver y continuar conversaciones' },
    { command: 'new', description: 'Nueva sesión de OpenCode' },
    { command: 'abort', description: 'Cancelar la tarea actual' },
    { command: 'status', description: 'Proyecto, modo, modelo y estado' },
    { command: 'agents', description: 'Listar agentes disponibles' },
    { command: 'help', description: 'Ver todos los comandos' }
  ],
};
