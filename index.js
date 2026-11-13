'use strict';

/**
 * index.js - entry point.
 *
 * Loads config.json (merged over built-in defaults), keeps the process alive
 * through stray errors, and reconnects the bot with exponential backoff
 * whenever the connection drops, is refused, or the bot is kicked.
 */

const { createBot, log } = require('./bot');

const DEFAULTS = {
  minecraft: { host: 'localhost', port: 25565, username: 'OllamaBot', auth: 'offline', version: '1.20.1' },
  ollama: {
    host: 'http://127.0.0.1:11434',
    model: 'llama3.1',
    temperature: 0.5,
    numCtx: 8192,
    maxToolRounds: 4,
    requestTimeoutMs: 90000,
    keepAlive: '30m'
  },
  chat: {
    maxLength: 256,
    maxChunks: 3,
    historySize: 10,
    sendDelayMs: 1200,
    requireMention: false,
    allowedPlayers: [],
    greeting: ''
  },
  bot: {
    autoEatBelow: 15,
    canDig: true,
    allowAttackPlayers: false,
    mineSearchRadius: 48,
    attackSearchRadius: 32,
    equipIntervalMs: 60000
  },
  reconnect: { baseDelayMs: 5000, maxDelayMs: 60000 }
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function loadConfig() {
  let userConfig = {};
  try {
    userConfig = require('./config.json');
  } catch (err) {
    log.error(`Could not read config.json: ${err.message}`);
    process.exit(1);
  }

  const cfg = deepMerge(DEFAULTS, userConfig);

  // Optional environment overrides (handy for quick tests from the Terminal).
  if (process.env.MC_HOST) cfg.minecraft.host = process.env.MC_HOST;
  if (process.env.MC_PORT) cfg.minecraft.port = Number(process.env.MC_PORT);
  if (process.env.MC_USERNAME) cfg.minecraft.username = process.env.MC_USERNAME;
  if (process.env.OLLAMA_HOST) cfg.ollama.host = process.env.OLLAMA_HOST;
  if (process.env.OLLAMA_MODEL) cfg.ollama.model = process.env.OLLAMA_MODEL;

  cfg.minecraft.port = Number(cfg.minecraft.port);
  if (!Number.isInteger(cfg.minecraft.port) || cfg.minecraft.port < 1 || cfg.minecraft.port > 65535) {
    log.error(`Invalid Minecraft port in config.json: ${cfg.minecraft.port}`);
    process.exit(1);
  }
  if (!cfg.minecraft.username || String(cfg.minecraft.username).length > 16) {
    log.error('minecraft.username must be 1-16 characters.');
    process.exit(1);
  }
  cfg.chat.maxLength = Math.max(20, Math.min(256, Number(cfg.chat.maxLength) || 256));
  cfg.chat.maxChunks = Math.max(1, Number(cfg.chat.maxChunks) || 3);
  cfg.chat.historySize = Math.max(1, Number(cfg.chat.historySize) || 10);
  return cfg;
}

const config = loadConfig();

// Pathfinder / network hiccups must never take the whole process down.
process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception (bot kept alive): ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  log.error(`Unhandled promise rejection (bot kept alive): ${reason && reason.stack ? reason.stack : reason}`);
});

let activeBot = null;
let reconnectTimer = null;
let reconnectDelay = config.reconnect.baseDelayMs;
let attempt = 0;
let shuttingDown = false;

function scheduleReconnect(reason) {
  if (shuttingDown || reconnectTimer) return;
  log.warn(`Disconnected (${reason}). Reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, config.reconnect.maxDelayMs);
}

function connect() {
  if (shuttingDown) return;
  attempt += 1;
  const mc = config.minecraft;
  log.info(`Connecting to ${mc.host}:${mc.port} as ${mc.username} (attempt ${attempt})...`);

  let bot;
  try {
    bot = createBot(config);
  } catch (err) {
    log.error(`Failed to create bot: ${err && err.message ? err.message : err}`);
    scheduleReconnect('startup error');
    return;
  }

  activeBot = bot;
  let spawned = false;
  let handled = false;
  let watchdog = null;

  const onGone = (reason) => {
    if (handled) return;
    handled = true;
    clearTimeout(watchdog);
    if (activeBot === bot) activeBot = null;
    scheduleReconnect(reason || 'connection closed');
  };

  bot.once('spawn', () => {
    spawned = true;
    clearTimeout(watchdog);
    reconnectDelay = config.reconnect.baseDelayMs; // healthy connection: reset backoff
    log.info('Bot spawned in the world.');
  });
  bot.once('end', (reason) => onGone(reason));

  // If we never manage to log in (hung connection), give up and retry.
  watchdog = setTimeout(() => {
    if (spawned || handled) return;
    log.warn('Login timed out.');
    try {
      bot.end('login timeout');
    } catch (_) {
      /* ignore */
    }
    onGone('login timeout');
  }, 60000);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down...');
  clearTimeout(reconnectTimer);
  try {
    if (activeBot) activeBot.quit('Shutting down');
  } catch (_) {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 600);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log.info(`Ollama brain: model "${config.ollama.model}" at ${config.ollama.host}`);
connect();
