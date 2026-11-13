'use strict';

/**
 * duel.js - type "pvp" in Minecraft chat and the bot duels you.
 *
 * Skills it uses:
 *  - equips its best armor, sword/axe and shield before the fight
 *  - chases you with pathfinding, then switches to manual combat up close
 *  - faces you, strafes left/right at random intervals, keeps spacing
 *  - critical hits: jumps and swings while falling
 *  - respects weapon cooldowns (sword vs axe) instead of spam-clicking
 *  - w-tap: briefly releases sprint after each hit for extra knockback
 *  - raises its shield between swings
 *  - backs off and eats a golden apple (or food) when its health gets low
 *
 * Chat commands: "pvp" starts. "stop", "pvp stop", "peace", "yield" or "gg" ends it.
 */

const { goals } = require('mineflayer-pathfinder');

const START_WORDS = new Set(['pvp', '!pvp', 'pvp me']);
const STOP_WORDS = new Set(['pvp stop', 'stop pvp', 'pvp off', 'peace', 'stop', 'yield', 'gg']);
const OPENERS = ["Alright, let's duel!", 'Fight me! No hacks, just skill.', "You asked for it. Let's go!"];

function quiet(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function withTimeout(promise, ms) {
  let timer;
  promise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createDuel(bot, config, state, tools) {
  const say = (text) => {
    try {
      state.say(text);
    } catch (_) {
      /* ignore */
    }
  };

  let active = false;
  let targetName = null;
  let myTask = 0;
  let pathing = false;
  let followed = null;
  let lastAttack = 0;
  let readySince = 0; // when we first had a ready swing while in reach
  let lastJump = 0;
  let lastHeal = 0;
  let lastSeen = 0;
  let wtapUntil = 0;
  let nextStrafeSwitch = 0;
  let strafeDir = 1;
  let healing = false;
  let shieldUp = false;

  /* ---------------- helpers ---------------- */

  function releaseControls() {
    quiet(() => bot.clearControlStates());
  }

  function hasShieldOffhand() {
    try {
      const item = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
      return Boolean(item && item.name === 'shield');
    } catch (_) {
      return false;
    }
  }

  function raiseShield() {
    if (shieldUp || !hasShieldOffhand()) return;
    shieldUp = true;
    quiet(() => bot.activateItem(true));
  }

  function lowerShield() {
    if (!shieldUp) return;
    shieldUp = false;
    quiet(() => bot.deactivateItem());
  }

  /** How long to wait between swings, based on the weapon in hand. */
  function cooldownMs() {
    const name = bot.heldItem ? bot.heldItem.name : '';
    if (/_sword$/.test(name)) return 640;
    if (/_axe$/.test(name)) {
      if (/^(wooden|stone)/.test(name)) return 1260;
      if (name.startsWith('iron')) return 1110;
      return 1010;
    }
    if (/_pickaxe$/.test(name)) return 850;
    if (/_shovel$/.test(name)) return 1010;
    return 420;
  }

  function jump() {
    const now = Date.now();
    if (now - lastJump < 350) return;
    lastJump = now;
    bot.setControlState('jump', true);
    setTimeout(() => {
      if (active) bot.setControlState('jump', false);
    }, 120);
  }

  async function heal() {
    if (healing) return;
    const now = Date.now();
    if (now - lastHeal < 15000) return;

    const apple = bot.inventory.items().find((i) => i.name === 'enchanted_golden_apple' || i.name === 'golden_apple');
    const starving = bot.food <= 6;
    if (!apple && !starving) return;

    healing = true;
    lastHeal = now;
    lowerShield();
    try {
      if (apple) {
        await bot.equip(apple, 'hand');
        await withTimeout(bot.consume(), 4000);
      } else {
        await tools.actions.eatFood();
      }
    } catch (_) {
      quiet(() => bot.deactivateItem());
    } finally {
      healing = false;
      quiet(() => tools.execute('equip_best_gear')); // put the sword back in hand
    }
  }

  /* ---------------- the fight loop (runs every game tick) ---------------- */

  function onTick() {
    if (!active) return;
    if (state.taskId !== myTask) {
      // Something else (stop command, another task, death) took over.
      finish(null);
      return;
    }
    if (!bot.entity) return;

    const now = Date.now();
    const record = bot.players[targetName];
    const target = record && record.entity;

    if (!target) {
      releaseControls();
      if (now - lastSeen > 8000) finish('I lost you. Duel over.');
      return;
    }
    lastSeen = now;

    const eye = bot.entity.position.offset(0, 1.62, 0);
    const aim = target.position.offset(0, (target.height || 1.8) * 0.5, 0);
    const dist = eye.distanceTo(aim);
    const flat = bot.entity.position.distanceTo(target.position);

    if (flat > 40) {
      finish('You ran too far away. Duel over.');
      return;
    }

    // Low health: fall back and heal.
    if (healing) {
      bot.setControlState('forward', false);
      bot.setControlState('back', true);
      return;
    }
    if (bot.health <= 9) quiet(() => heal());

    // Far away: let the pathfinder run us down. Switch to manual combat when close.
    if (flat > 5.5 || (pathing && flat > 4.2)) {
      if (!pathing || followed !== target) {
        releaseControls();
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
        pathing = true;
        followed = target;
      }
      lowerShield();
      return;
    }
    if (pathing) {
      bot.pathfinder.setGoal(null);
      releaseControls();
      pathing = false;
      followed = null;
    }

    // Face the target and move: hold spacing and strafe.
    quiet(() => bot.lookAt(aim, true));
    if (now >= nextStrafeSwitch) {
      strafeDir *= -1;
      nextStrafeSwitch = now + 450 + Math.random() * 650;
    }
    const tapping = now < wtapUntil;
    const forward = dist > 2.7 && !tapping;
    bot.setControlState('forward', forward);
    bot.setControlState('back', dist < 1.7);
    bot.setControlState('left', strafeDir < 0);
    bot.setControlState('right', strafeDir > 0);
    bot.setControlState('sprint', forward);

    // Attack logic: wait for the cooldown, then land a critical (hit while falling).
    if (dist <= 3.0) {
      const cd = cooldownMs();
      const ready = now - lastAttack >= cd;
      if (ready) {
        if (!readySince) readySince = now;
        const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.08;
        // Prefer a critical (falling) hit; swing anyway if we've waited too long.
        if (falling || now - readySince > 500) {
          lowerShield();
          bot.attack(target);
          lastAttack = now;
          readySince = 0;
          wtapUntil = now + 110; // w-tap for knockback
        } else if (bot.entity.onGround) {
          jump();
        }
      } else {
        readySince = 0;
        raiseShield();
      }
    } else {
      readySince = 0;
      lowerShield();
    }
  }

  /* ---------------- start / stop ---------------- */

  function finish(message) {
    if (!active) return;
    active = false;
    bot.removeListener('physicsTick', onTick);
    lowerShield();
    quiet(() => bot.pathfinder.setGoal(null));
    releaseControls();
    if (state.taskId === myTask) state.currentTask = 'idle';
    if (message) say(message);
  }

  function start(username) {
    const allowed = ((config.chat && config.chat.allowedPlayers) || []).map((n) => String(n).toLowerCase());
    if (allowed.length > 0 && !allowed.includes(String(username).toLowerCase())) return;

    const record = bot.players[username];
    if (!record || !record.entity) {
      say(`I can't see you, ${username}. Come closer and say pvp again.`);
      return;
    }

    if (active) finish(null);
    tools.actions.stopAll();
    active = true;
    targetName = username;
    myTask = state.taskId;
    state.currentTask = `dueling ${username}`;
    pathing = false;
    followed = null;
    lastAttack = 0;
    readySince = 0;
    lastHeal = 0;
    lastSeen = Date.now();
    wtapUntil = 0;
    healing = false;
    shieldUp = false;
    nextStrafeSwitch = 0;

    quiet(() => tools.execute('equip_best_gear'));
    say(OPENERS[Math.floor(Math.random() * OPENERS.length)]);
    bot.on('physicsTick', onTick);
  }

  bot.on('entityDead', (entity) => {
    if (active && entity && entity.username === targetName) finish('gg! Good fight.');
  });
  bot.on('death', () => {
    if (active) finish('gg, you got me!');
  });

  /** Returns true if the chat message was a duel command (so the brain skips it). */
  function handleChat(username, message) {
    if (username === bot.username) return false;
    const text = String(message === undefined || message === null ? '' : message)
      .trim()
      .toLowerCase()
      .replace(/[!.?]+$/, '');
    if (START_WORDS.has(text)) {
      start(username);
      return true;
    }
    if (active && STOP_WORDS.has(text)) {
      finish('Okay, duel over.');
      return true;
    }
    return false;
  }

  return { handleChat, isActive: () => active, stop: () => finish('Okay, duel over.') };
}

module.exports = createDuel;
