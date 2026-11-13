'use strict';

/**
 * brain.js - the Ollama "brain".
 *
 * Keeps a rolling chat history (last N messages), builds a system prompt with
 * the bot's live status before every reply, lets the model call tools in a
 * short loop, and returns the final chat reply.
 */

const ollamaPkg = require('ollama');

const OllamaClass = ollamaPkg.Ollama || (ollamaPkg.default && ollamaPkg.default.Ollama);
if (typeof OllamaClass !== 'function') {
  throw new Error('Could not load the Ollama class from the "ollama" package. Run: npm install');
}

function withTimeout(promise, ms, label) {
  let timer;
  promise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

/**
 * Some models (llama3.1 especially) occasionally print a tool call as JSON
 * text instead of using the structured tool_calls field. This recovers those.
 * Returns calls in Ollama's { function: { name, arguments } } shape.
 */
function extractTextToolCalls(content, validNames) {
  if (!content) return [];
  const text = String(content)
    .replace(/<\/?tool_call>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return [];

  let parsed = tryParse(text);
  if (parsed === undefined) {
    const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (last <= 0) return [];
    parsed = tryParse(text.slice(0, last + 1));
    if (parsed === undefined) return [];
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const fn = item.function && typeof item.function === 'object' ? item.function : item;
    const name = fn.name;
    if (typeof name !== 'string' || !validNames.includes(name)) continue;
    let args = fn.parameters !== undefined ? fn.parameters : fn.arguments !== undefined ? fn.arguments : {};
    if (typeof args === 'string') args = tryParse(args) || {};
    calls.push({ function: { name, arguments: args && typeof args === 'object' ? args : {} } });
  }
  return calls;
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

class Brain {
  constructor(bot, config, tools, state) {
    this.bot = bot;
    this.config = config;
    this.tools = tools;
    this.state = state;
    this.log = state.log;

    const o = config.ollama || {};
    this.model = o.model || 'llama3.1';
    this.temperature = typeof o.temperature === 'number' ? o.temperature : 0.5;
    this.numCtx = Number(o.numCtx) || 8192;
    this.maxRounds = Math.max(1, Number(o.maxToolRounds) || 4);
    this.timeoutMs = Number(o.requestTimeoutMs) || 90000;
    this.keepAlive = o.keepAlive || '30m';
    this.client = new OllamaClass({ host: o.host || 'http://127.0.0.1:11434' });

    this.historySize = Math.max(1, Number(config.chat.historySize) || 10);
    this.history = []; // { username, message, isBot }
    this.busy = false;
    this.seq = 0; // number of chat messages that want an answer
    this.answeredSeq = 0;
    this.lastErrorSpoken = 0;
  }

  /* ---------------- startup check ---------------- */

  async init() {
    try {
      const list = await this.client.list();
      const names = (list.models || []).map((m) => m.name || m.model).filter(Boolean);
      const wanted = this.model;
      const found = names.some((n) => n === wanted || (!wanted.includes(':') && n === `${wanted}:latest`));
      if (found) {
        this.log.info(`Ollama is reachable and model "${wanted}" is installed.`);
      } else {
        this.log.warn(
          `Model "${wanted}" is not installed in Ollama (installed: ${names.join(', ') || 'none'}). Run: ollama pull ${wanted}`
        );
      }
    } catch (err) {
      this.log.warn(
        `Could not reach Ollama at ${this.config.ollama.host}. Is it running? (${err && err.message ? err.message : err})`
      );
    }
  }

  /* ---------------- memory ---------------- */

  addHistory(username, message, isBot = false) {
    const text = String(message === undefined || message === null ? '' : message).trim();
    if (!text) return;
    this.history.push({ username, message: text, isBot });
    while (this.history.length > this.historySize) this.history.shift();
  }

  historyMessages() {
    return this.history.map((entry) =>
      entry.isBot
        ? { role: 'assistant', content: entry.message }
        : { role: 'user', content: `${entry.username}: ${entry.message}` }
    );
  }

  lastSpeaker() {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (!this.history[i].isBot) return this.history[i].username;
    }
    return 'the player';
  }

  /* ---------------- chat intake ---------------- */

  shouldRespond(username, text) {
    const allowed = (this.config.chat.allowedPlayers || []).map((n) => String(n).toLowerCase());
    if (allowed.length > 0 && !allowed.includes(String(username).toLowerCase())) return false;
    if (this.config.chat.requireMention) {
      return text.toLowerCase().includes(String(this.bot.username).toLowerCase());
    }
    return true;
  }

  handleChat(username, message) {
    const text = String(message === undefined || message === null ? '' : message).trim();
    if (!text) return;
    this.addHistory(username, text, false);
    if (!this.shouldRespond(username, text)) return;
    this.seq += 1;
    this.pump();
  }

  /** Processes one request at a time; messages arriving meanwhile are answered next. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.answeredSeq < this.seq) {
        const target = this.seq;
        try {
          const reply = await this.think();
          if (reply) this.state.say(reply);
        } catch (err) {
          this.reportError(err);
        }
        this.answeredSeq = target;
      }
    } finally {
      this.busy = false;
    }
  }

  /* ---------------- prompt building ---------------- */

  buildStatus() {
    const bot = this.bot;
    const lines = [];
    const pos = bot.entity && bot.entity.position;

    lines.push(`Health: ${round1(bot.health === undefined ? 20 : bot.health)}/20`);
    lines.push(`Hunger: ${bot.food === undefined ? 20 : bot.food}/20`);
    if (pos) lines.push(`Position: x=${Math.floor(pos.x)} y=${Math.floor(pos.y)} z=${Math.floor(pos.z)}`);
    if (bot.game && bot.game.dimension) lines.push(`Dimension: ${bot.game.dimension}`);
    if (bot.time && typeof bot.time.timeOfDay === 'number') {
      lines.push(`Time: ${bot.time.timeOfDay < 12500 ? 'day' : 'night'}${bot.isRaining ? ', raining' : ''}`);
    }
    lines.push(`Current task: ${this.state.currentTask}`);
    lines.push(`Holding: ${bot.heldItem ? `${bot.heldItem.name} x${bot.heldItem.count}` : 'nothing'}`);

    try {
      const armor = ['head', 'torso', 'legs', 'feet']
        .map((slot) => bot.inventory.slots[bot.getEquipmentDestSlot(slot)])
        .filter(Boolean)
        .map((item) => item.name);
      lines.push(`Armor worn: ${armor.length ? armor.join(', ') : 'none'}`);
    } catch (_) {
      /* ignore */
    }

    const totals = new Map();
    for (const item of bot.inventory.items()) totals.set(item.name, (totals.get(item.name) || 0) + item.count);
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, 30).map(([name, count]) => `${name} x${count}`);
    const extra = sorted.length > 30 ? `, +${sorted.length - 30} more kinds` : '';
    lines.push(`Inventory: ${shown.length ? shown.join(', ') : 'empty'}${extra}`);

    if (pos) {
      const players = Object.values(bot.players)
        .filter((p) => p && p.entity && p.username !== bot.username)
        .map((p) => `${p.username} (${Math.round(p.entity.position.distanceTo(pos))}m)`);
      lines.push(`Nearby players: ${players.length ? players.join(', ') : 'none'}`);

      const hostiles = Object.values(bot.entities)
        .filter((e) => e && e !== bot.entity && e.position && e.type === 'hostile' && e.position.distanceTo(pos) <= 16)
        .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
        .slice(0, 6)
        .map((e) => `${e.name || 'mob'} (${Math.round(e.position.distanceTo(pos))}m)`);
      lines.push(`Nearby hostile mobs: ${hostiles.length ? hostiles.join(', ') : 'none'}`);
    }
    return lines.join('\n');
  }

  buildSystemPrompt() {
    const speaker = this.lastSpeaker();
    return [
      `You are ${this.bot.username}, a friendly AI-controlled player in a Minecraft 1.20.1 survival world. You talk with players in the in-game chat and you act in the world by calling tools.`,
      '',
      'HOW TO BEHAVE:',
      '- Reply like a Minecraft player: casual, one or two short sentences, under 200 characters. Plain text only: no markdown, no emojis, no line breaks, never start a message with "/".',
      '- When a player asks you to DO something in the game, call the matching tool instead of just saying you will.',
      `- "me" or "I" in a request means the player who sent the latest message. Right now that is ${speaker}.`,
      '- Never invent coordinates, inventory contents or results. Only use the live status below and tool outputs.',
      '- Walking, mining, fighting and handing over items continue in the background and you announce the result later. Say you have started, not that it is finished.',
      '- If a tool returns an error, tell the player briefly and honestly what went wrong and what would help.',
      '- For small talk and questions, just answer without calling tools.',
      '- You may eat or equip gear when it clearly helps, but never attack a player.',
      '',
      'YOUR LIVE STATUS RIGHT NOW:',
      this.buildStatus()
    ].join('\n');
  }

  /* ---------------- Ollama calls ---------------- */

  async callOllama(messages, withTools) {
    const request = {
      model: this.model,
      messages,
      stream: false,
      keep_alive: this.keepAlive,
      options: { temperature: this.temperature, num_ctx: this.numCtx }
    };
    if (withTools) request.tools = this.tools.definitions;
    return withTimeout(this.client.chat(request), this.timeoutMs, 'Ollama request');
  }

  /** Runs the model (with tool calling) and returns the text to say in chat. */
  async think() {
    const messages = [{ role: 'system', content: this.buildSystemPrompt() }, ...this.historyMessages()];
    const toolNames = this.tools.definitions.map((d) => d.function.name);
    const results = [];

    for (let round = 0; round < this.maxRounds; round++) {
      const response = await this.callOllama(messages, true);
      const msg = (response && response.message) || {};
      let content = typeof msg.content === 'string' ? msg.content.trim() : '';
      let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((c) => c && c.function && c.function.name) : [];

      if (calls.length === 0 && content) {
        const recovered = extractTextToolCalls(content, toolNames);
        if (recovered.length > 0) {
          calls = recovered;
          content = '';
        }
      }

      if (calls.length === 0) return content || this.fallbackReply(results);

      calls = calls.slice(0, 4);
      messages.push({ role: 'assistant', content, tool_calls: calls });
      if (content) this.state.say(content);

      for (const call of calls) {
        const name = call.function.name;
        const result = await this.tools.execute(name, call.function.arguments);
        results.push(result);
        messages.push({ role: 'tool', content: result, tool_name: name });
      }
    }

    // Tool-call budget used up: ask for a final plain-text answer.
    const final = await this.callOllama(messages, false);
    const text = final && final.message && typeof final.message.content === 'string' ? final.message.content.trim() : '';
    return text || this.fallbackReply(results);
  }

  fallbackReply(results) {
    if (results.length === 0) return "Sorry, I didn't catch that. Could you say it another way?";
    return String(results[results.length - 1])
      .split('\n')[0]
      .replace(/^(OK|Error):\s*/i, '');
  }

  /* ---------------- error reporting ---------------- */

  reportError(err) {
    const message = err && err.message ? err.message : String(err);
    const code = String((err && ((err.cause && err.cause.code) || err.code)) || '');
    this.log.error(`Brain error: ${message}`);

    let spoken = 'Sorry, my brain glitched. Try again in a moment.';
    if (code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED/i.test(message)) {
      spoken = "My brain (Ollama) isn't reachable right now. Is it running?";
    } else if (/not found/i.test(message) && /model/i.test(message)) {
      spoken = `The model "${this.model}" isn't installed in Ollama yet.`;
    } else if (/does not support tools/i.test(message)) {
      spoken = `The model "${this.model}" can't use tools. Try llama3.1 or qwen2.5.`;
    } else if (/timed out/i.test(message)) {
      spoken = 'My brain is taking too long to answer. Try again in a moment.';
    }

    if (Date.now() - this.lastErrorSpoken > 60000) {
      this.lastErrorSpoken = Date.now();
      this.state.say(spoken);
    }
  }
}

module.exports = { Brain, extractTextToolCalls };
