'use strict';

/**
 * bot.js - creates the mineflayer bot, loads plugins, wires up events,
 * chat sending (splitting/trimming to Minecraft's 256-char limit),
 * auto-eat and auto-armor, and connects the Ollama brain to in-game chat.
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
const pvpPkg = require('mineflayer-pvp');
const collectPkg = require('mineflayer-collectblock');
const armorPkg = require('mineflayer-armor-manager');

const { createTools } = require('./tools');
const { Brain } = require('./brain');

const pvpPlugin = pvpPkg.plugin || pvpPkg.default || pvpPkg;
const collectPlugin = collectPkg.plugin || collectPkg.default || collectPkg;
const armorPlugin = typeof armorPkg === 'function' ? armorPkg : armorPkg.plugin || armorPkg.default;

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function stamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

const log = {
  info: (msg) => console.log(`[${stamp()}] [INFO]  ${msg}`),
  warn: (msg) => console.warn(`[${stamp()}] [WARN]  ${msg}`),
  error: (msg) => console.error(`[${stamp()}] [ERROR] ${msg}`),
  debug: () => {}
};

function safe(label, fn) {
  try {
    return fn();
  } catch (err) {
    log.error(`${label} handler error: ${err && err.stack ? err.stack : err}`);
    return undefined;
  }
}

function stringifyReason(reason) {
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch (_) {
    return String(reason);
  }
}

/* ------------------------------------------------------------------ */
/* Chat helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Makes text safe to send as Minecraft chat:
 *  - removes the section sign and control characters (the server kicks for them)
 *  - flattens newlines and markdown noise
 *  - removes leading slashes so the model can never run a command
 */
function sanitizeChat(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/[\u0000-\u001f\u007f\u00a7]/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s/]+/, '')
    .trim();
}

/**
 * Splits text into chunks of at most maxLength characters, preferring to
 * break on spaces. At most maxChunks chunks are returned; anything beyond
 * that is trimmed and the last chunk ends with "...".
 */
function splitMessage(text, maxLength = 256, maxChunks = 3) {
  const clean = sanitizeChat(text);
  if (!clean) return [];

  const chunks = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= maxLength) {
      chunks.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf(' ', maxLength);
    if (cut < Math.floor(maxLength * 0.5)) cut = maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0 && chunks.length > 0) {
    const ellipsis = '...';
    const last = chunks.length - 1;
    let line = chunks[last];
    if (line.length + ellipsis.length > maxLength) {
      line = line.slice(0, maxLength - ellipsis.length).trimEnd();
    }
    chunks[last] = line + ellipsis;
  }
  return chunks.filter(Boolean);
}

/** Rate-limited chat queue so long replies don't trigger server spam kicks. */
function createChatSender(bot, config) {
  const maxLength = config.chat.maxLength;
  const maxChunks = config.chat.maxChunks;
  const delay = Math.max(0, Number(config.chat.sendDelayMs) || 0);
  const queue = [];
  let timer = null;
  let lastSent = 0;

  function pump() {
    if (timer || queue.length === 0) return;
    const wait = Math.max(0, lastSent + delay - Date.now());
    timer = setTimeout(() => {
      timer = null;
      const line = queue.shift();
      if (line) {
        try {
          bot.chat(line);
        } catch (err) {
          log.warn(`Could not send chat: ${err && err.message ? err.message : err}`);
        }
        lastSent = Date.now();
      }
      pump();
    }, wait);
  }

  return {
    send(text) {
      const chunks = splitMessage(text, maxLength, maxChunks);
      for (const chunk of chunks) queue.push(chunk);
      if (queue.length > 12) queue.splice(0, queue.length - 12);
      pump();
      return chunks;
    },
    clear() {
      queue.length = 0;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Bot creation                                                        */
/* ------------------------------------------------------------------ */

function createBot(config) {
  const mc = config.minecraft;
  const options = {
    host: mc.host,
    port: mc.port,
    username: mc.username,
    auth: mc.auth || 'offline',
    version: mc.version || '1.20.1',
    hideErrors: true,
    checkTimeoutInterval: 60 * 1000
  };
  if (mc.password) options.password = mc.password;

  const bot = mineflayer.createBot(options);

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvpPlugin);
  bot.loadPlugin(collectPlugin);
  if (armorPlugin) bot.loadPlugin(armorPlugin);

  const state = {
    currentTask: 'idle',
    taskId: 0,
    eating: false,
    log,
    say: () => {}
  };
  const timers = [];
  let initialized = false;
  let tools = null;
  let brain = null;
  let sender = null;

  /* ---------------- lifecycle events (registered immediately) -------- */

  bot.on('error', (err) => {
    log.error(`Bot error: ${err && err.message ? err.message : err}`);
  });

  bot.on('kicked', (reason) => {
    log.warn(`Kicked from server: ${stringifyReason(reason)}`);
  });

  bot.on('end', (reason) => {
    for (const t of timers) clearInterval(t);
    timers.length = 0;
    if (sender) sender.clear();
    if (tools) safe('cleanup', () => tools.actions.stopAll());
    log.warn(`Connection ended: ${reason}`);
  });

  bot.on('spawn', () =>
    safe('spawn', () => {
      const movements = new Movements(bot);
      movements.canDig = config.bot.canDig !== false;
      movements.allowSprinting = true;
      bot.pathfinder.setMovements(movements);

      if (initialized) {
        // Respawned after dying: drop any stale goals.
        tools.actions.stopAll();
        return;
      }
      initialized = true;
      initialize();
    })
  );

  /* ---------------- one-time setup after the first spawn ------------- */

  function initialize() {
    sender = createChatSender(bot, config);
    tools = createTools(bot, config, state);
    brain = new Brain(bot, config, tools, state);
    const duel = require('./duel')(bot, config, state, tools); // "pvp" duel mode

    // Everything the bot says (replies, task notifications) goes through here
    // so it is rate-limited, split to fit the chat limit, and remembered.
    state.say = (text) => {
      const sent = sender.send(text);
      if (sent.length > 0) brain.addHistory(bot.username, sent.join(' '), true);
    };

    brain.init().catch((err) => log.warn(`Brain init problem: ${err && err.message ? err.message : err}`));

    bot.on('chat', (username, message) =>
      safe('chat', () => {
        if (username === bot.username) return; // ignore our own messages
        if (duel.handleChat(username, message)) return; // "pvp" / "stop" duel commands
        brain.handleChat(username, message);
      })
    );

    bot.on('death', () =>
      safe('death', () => {
        tools.actions.stopAll();
        state.say('Ouch, I died. Respawning now.');
      })
    );

    // ---- Auto-eat: eat whenever hunger drops below the configured level ----
    let eatBusy = false;
    let lastAttempt = 0;
    let lastNoFoodWarning = 0;
    const autoEat = async () => {
      if (eatBusy || state.eating || !bot.entity) return;
      const threshold = Number(config.bot.autoEatBelow);
      if (!(bot.food < threshold)) return;
      if (bot.pvp && bot.pvp.target && bot.food > 6) return; // don't eat mid-fight unless starving
      if (Date.now() - lastAttempt < 2000) return;
      lastAttempt = Date.now();
      eatBusy = true;
      try {
        const result = await tools.actions.eatFood();
        if (result.ok) {
          log.info(`Auto-eat: ${result.message}`);
        } else if (result.reason === 'no_food' && Date.now() - lastNoFoodWarning > 5 * 60 * 1000) {
          lastNoFoodWarning = Date.now();
          state.say("I'm getting hungry but I don't have any food on me.");
        }
      } catch (err) {
        log.warn(`Auto-eat failed: ${err && err.message ? err.message : err}`);
      } finally {
        eatBusy = false;
      }
    };
    bot.on('health', () => {
      autoEat();
    });
    timers.push(setInterval(() => autoEat(), 5000));

    // ---- Auto-armor: mineflayer-armor-manager equips on pickup; we also
    //      sweep on spawn and periodically as a safety net ----
    timers.push(setTimeout(() => tools.actions.equipArmor(), 3000));
    timers.push(
      setInterval(() => {
        if (!bot.entity || state.eating) return;
        tools.actions.equipArmor();
      }, Math.max(10000, Number(config.bot.equipIntervalMs) || 60000))
    );

    const greeting = String(config.chat.greeting || '').trim();
    if (greeting) timers.push(setTimeout(() => state.say(greeting), 1500));

    log.info(`Ready. Talk to ${bot.username} in Minecraft chat.`);
  }

  return bot;
}

module.exports = { createBot, log, splitMessage, sanitizeChat };
