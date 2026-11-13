'use strict';

/**
 * tools.js - everything the Ollama brain can DO in the world.
 *
 * createTools(bot, config, state) returns:
 *   definitions - tool schemas in Ollama's function-calling format
 *   execute     - run a tool by name; always resolves to a short text result
 *   actions     - helpers used directly by bot.js (auto-eat, auto-armor, stop)
 *
 * Long-running actions (walking, mining, fighting, delivering items) run in
 * the background: the tool returns immediately and the bot announces the
 * outcome in chat when it finishes. Starting a new task cancels the old one.
 */

const { goals } = require('mineflayer-pathfinder');

const LIVING_TYPES = new Set(['player', 'mob', 'hostile', 'animal', 'passive', 'water_creature', 'ambient', 'living']);

const BAD_FOODS = new Set([
  'pufferfish',
  'spider_eye',
  'poisonous_potato',
  'rotten_flesh',
  'chorus_fruit',
  'suspicious_stew',
  'enchanted_golden_apple',
  'golden_apple',
  'chicken'
]);

const TIERS = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };
const ORE_ALIASES = ['coal', 'iron', 'gold', 'copper', 'diamond', 'emerald', 'lapis', 'redstone'];
const LOG_ALIASES = ['log', 'logs', 'wood', 'tree', 'trees'];

const NOTABLE_BLOCKS = new Set([
  'crafting_table',
  'furnace',
  'blast_furnace',
  'smoker',
  'chest',
  'trapped_chest',
  'barrel',
  'ender_chest',
  'enchanting_table',
  'anvil',
  'obsidian',
  'spawner',
  'nether_portal',
  'sugar_cane',
  'pumpkin',
  'melon',
  'wheat',
  'carrots',
  'potatoes'
]);

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeName(name) {
  return String(name === undefined || name === null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/[\s-]+/g, '_');
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function shortError(err) {
  const msg = err && err.message ? err.message : String(err);
  return msg.replace(/\s+/g, ' ').slice(0, 140);
}

function withTimeout(promise, ms, label) {
  let timer;
  promise.catch(() => {}); // avoid unhandled rejection if the timeout wins
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Returns the first defined, non-empty value among obj[keys...]. */
function pick(obj, keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return undefined;
}

/** Runs fn, swallowing sync throws and async rejections. */
function quiet(fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {
    /* ignore */
  }
}

function describePos(v) {
  return `${Math.round(v.x)}, ${Math.round(v.y)}, ${Math.round(v.z)}`;
}

function isHostile(entity) {
  return entity.type === 'hostile' || String(entity.kind || '').toLowerCase().includes('hostile');
}

/* ------------------------------------------------------------------ */
/* Tool factory                                                        */
/* ------------------------------------------------------------------ */

function createTools(bot, config, state) {
  const log = state.log;
  const cfg = config.bot || {};
  const say = (text) => {
    try {
      state.say(text);
    } catch (err) {
      log.warn(`say failed: ${shortError(err)}`);
    }
  };

  /* ---------------- task bookkeeping ---------------- */

  function haltMovement() {
    quiet(() => bot.pathfinder.setGoal(null));
    quiet(() => bot.pvp && bot.pvp.stop());
    quiet(() => bot.collectBlock && bot.collectBlock.cancelTask && bot.collectBlock.cancelTask());
    quiet(() => bot.clearControlStates());
  }

  function beginTask(label) {
    state.taskId += 1;
    state.currentTask = label;
    haltMovement();
    return state.taskId;
  }

  const isCurrent = (id) => state.taskId === id;

  function endTask(id) {
    if (isCurrent(id)) state.currentTask = 'idle';
  }

  function stopAll() {
    state.taskId += 1;
    state.currentTask = 'idle';
    haltMovement();
  }

  /** Runs fn() in the background; announces its returned text (if any) in chat. */
  function runBackground(id, label, fn) {
    Promise.resolve()
      .then(fn)
      .then((message) => {
        if (!isCurrent(id)) return; // cancelled or replaced: stay quiet
        endTask(id);
        if (message) say(message);
      })
      .catch((err) => {
        if (!isCurrent(id)) return;
        endTask(id);
        haltMovement();
        log.warn(`Task "${label}" failed: ${shortError(err)}`);
        say(`I couldn't finish ${label}: ${shortError(err)}`);
      });
  }

  /* ---------------- lookup helpers ---------------- */

  function findPlayer(name) {
    const wanted = String(name === undefined || name === null ? '' : name)
      .trim()
      .toLowerCase();
    if (!wanted) return null;
    const players = Object.values(bot.players).filter((p) => p && p.username && p.username !== bot.username);
    const exact = players.find((p) => p.username.toLowerCase() === wanted);
    if (exact) return exact;
    const partial = players.filter((p) => p.username.toLowerCase().startsWith(wanted));
    return partial.length === 1 ? partial[0] : null;
  }

  function countItem(itemName) {
    return bot.inventory
      .items()
      .filter((i) => i.name === itemName)
      .reduce((sum, i) => sum + i.count, 0);
  }

  /* ---------------- follow_player ---------------- */

  async function followPlayer(username) {
    const player = findPlayer(username);
    if (!player) return `Error: no player named "${username}" is online.`;
    if (!player.entity) return `Error: I can't see ${player.username} right now (too far away).`;
    beginTask(`following ${player.username}`);
    bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true);
    return `OK: now following ${player.username}.`;
  }

  /* ---------------- go_to_coordinates ---------------- */

  async function goToCoordinates(args) {
    const x = toNumber(pick(args, ['x']));
    const y = toNumber(pick(args, ['y']));
    const z = toNumber(pick(args, ['z']));
    if (![x, y, z].every(Number.isFinite)) return 'Error: x, y and z must all be numbers.';

    const minY = bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64;
    const height = bot.game && Number.isFinite(bot.game.height) ? bot.game.height : 384;
    if (y < minY || y > minY + height) return `Error: y must be between ${minY} and ${minY + height}.`;

    const label = `heading to ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`;
    const id = beginTask(label);
    const goal = new goals.GoalNear(x, y, z, 1);
    runBackground(id, label, async () => {
      await bot.pathfinder.goto(goal);
      return `I arrived at ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}.`;
    });
    return `OK: ${label} now. I'll say when I get there.`;
  }

  /* ---------------- mine_block ---------------- */

  function resolveBlocks(rawName) {
    const byName = bot.registry.blocksByName;
    let name = normalizeName(rawName);
    if (LOG_ALIASES.includes(name)) {
      const logs = Object.keys(byName).filter((k) => k.endsWith('_log') && !k.startsWith('stripped_'));
      return { label: 'logs', names: logs };
    }
    if (ORE_ALIASES.includes(name)) name = `${name}_ore`;
    if (!byName[name]) {
      const suggestions = Object.keys(byName)
        .filter((k) => name && k.includes(name))
        .slice(0, 8);
      return { label: name, names: [], suggestions };
    }
    const names = [name];
    if (name.endsWith('_ore') && !name.startsWith('deepslate_') && byName[`deepslate_${name}`]) {
      names.push(`deepslate_${name}`);
    }
    return { label: name, names };
  }

  function lacksHarvestTool(block) {
    const harvest = block.harvestTools;
    if (!harvest || Object.keys(harvest).length === 0) return false;
    const have = new Set(bot.inventory.items().map((i) => i.type));
    return !Object.keys(harvest).some((k) => have.has(Number(k)));
  }

  async function mineBlock(args) {
    const rawName = pick(args, ['block_name', 'block', 'name']);
    if (!rawName) return 'Error: block_name is required.';
    let count = Math.floor(toNumber(pick(args, ['count', 'amount', 'quantity'])));
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 64);

    const resolved = resolveBlocks(rawName);
    if (resolved.names.length === 0) {
      const hint = resolved.suggestions && resolved.suggestions.length ? ` Did you mean: ${resolved.suggestions.join(', ')}?` : '';
      return `Error: "${rawName}" is not a known block name.${hint}`;
    }
    const ids = resolved.names.map((n) => bot.registry.blocksByName[n].id);
    const radius = Number(cfg.mineSearchRadius) || 48;

    const first = bot.findBlocks({ matching: ids, maxDistance: radius, count: 1 });
    if (first.length === 0) return `Error: I can't find any ${resolved.label} within ${radius} blocks.`;
    const firstBlock = bot.blockAt(first[0]);
    if (firstBlock && lacksHarvestTool(firstBlock)) {
      return `Error: I don't have a tool that can harvest ${firstBlock.name}. I need a better pickaxe first.`;
    }

    const label = `mining ${count} ${resolved.label}`;
    const id = beginTask(label);
    runBackground(id, label, async () => {
      let mined = 0;
      let failures = 0;
      const failed = new Set();

      while (mined < count && isCurrent(id)) {
        const positions = bot.findBlocks({ matching: ids, maxDistance: radius, count: 32 });
        const pos = positions.find((p) => !failed.has(p.toString()));
        if (!pos) break;

        const block = bot.blockAt(pos);
        if (!block || !ids.includes(block.type)) {
          failed.add(pos.toString());
          continue;
        }
        if (lacksHarvestTool(block)) {
          if (mined === 0) throw new Error(`I need a better tool to mine ${block.name}`);
          break;
        }

        try {
          await bot.collectBlock.collect(block);
          mined += 1;
        } catch (err) {
          if (!isCurrent(id)) return null;
          failed.add(pos.toString());
          failures += 1;
          log.warn(`Could not collect ${block.name} at ${pos}: ${shortError(err)}`);
          if (failures >= 5) break;
        }
      }

      if (!isCurrent(id)) return null;
      if (mined >= count) return `Done! I mined ${mined} ${resolved.label}.`;
      if (mined > 0) return `I only managed to mine ${mined} of ${count} ${resolved.label}.`;
      return `I couldn't mine any ${resolved.label} (none were reachable).`;
    });
    return `OK: started ${label}. I'll say when I'm done.`;
  }

  /* ---------------- equip_best_gear ---------------- */

  function weaponScore(item) {
    const match = /^(wooden|golden|stone|iron|diamond|netherite)_(sword|axe)$/.exec(item.name);
    if (!match) return -1;
    return TIERS[match[1]] * 2 + (match[2] === 'sword' ? 1 : 0);
  }

  async function equipBestWeapon() {
    let best = null;
    let bestScore = -1;
    for (const item of bot.inventory.items()) {
      const score = weaponScore(item);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    if (!best) return null;
    if (!bot.heldItem || bot.heldItem.type !== best.type) await bot.equip(best, 'hand');
    return best.name;
  }

  async function equipArmor() {
    try {
      if (bot.armorManager && typeof bot.armorManager.equipAll === 'function') {
        await bot.armorManager.equipAll();
      }
    } catch (err) {
      log.warn(`Armor equip failed: ${shortError(err)}`);
    }
  }

  async function equipBestGear() {
    await equipArmor();

    let weapon = null;
    try {
      weapon = await equipBestWeapon();
    } catch (err) {
      log.warn(`Weapon equip failed: ${shortError(err)}`);
    }

    try {
      const shield = bot.inventory.items().find((i) => i.name === 'shield');
      const offhand = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')];
      if (shield && !offhand) await bot.equip(shield, 'off-hand');
    } catch (err) {
      log.warn(`Shield equip failed: ${shortError(err)}`);
    }

    const armor = ['head', 'torso', 'legs', 'feet']
      .map((slot) => bot.inventory.slots[bot.getEquipmentDestSlot(slot)])
      .filter(Boolean)
      .map((item) => item.name);
    const parts = [];
    parts.push(armor.length ? `armor: ${armor.join(', ')}` : 'no armor');
    parts.push(weapon ? `weapon: ${weapon}` : 'no sword or axe');
    return `OK: equipped my best gear (${parts.join('; ')}).`;
  }

  /* ---------------- eat_food ---------------- */

  async function eatFood() {
    if (state.eating) return { ok: false, reason: 'busy', message: 'I am already eating.' };
    if (bot.food >= 20) return { ok: false, reason: 'not_hungry', message: 'I am not hungry (food bar is full).' };

    const foods = bot.registry.foodsByName || {};
    const candidates = bot.inventory.items().filter((i) => foods[i.name] && !BAD_FOODS.has(i.name));
    if (candidates.length === 0) {
      return { ok: false, reason: 'no_food', message: 'I have no safe food in my inventory.' };
    }
    candidates.sort(
      (a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints || foods[b.name].saturation - foods[a.name].saturation
    );
    const food = candidates[0];
    const previous = bot.heldItem;

    state.eating = true;
    try {
      await bot.equip(food, 'hand');
      await withTimeout(bot.consume(), 10000, 'eating');
      await sleep(250);
      if (previous && previous.type !== food.type) {
        const again = bot.inventory.items().find((i) => i.type === previous.type);
        if (again) await bot.equip(again, 'hand').catch(() => {});
      }
      return { ok: true, reason: 'ate', message: `I ate ${food.name}. Hunger is now ${bot.food}/20.` };
    } catch (err) {
      quiet(() => bot.deactivateItem());
      return { ok: false, reason: 'error', message: `I couldn't eat: ${shortError(err)}` };
    } finally {
      state.eating = false;
    }
  }

  /* ---------------- attack_entity ---------------- */

  async function attackEntity(args) {
    const raw = pick(args, ['target_name', 'target', 'name', 'entity', 'mob']);
    const target = normalizeName(raw);
    if (!target) return 'Error: target_name is required.';
    if (!bot.pvp) return 'Error: the combat plugin is not loaded.';

    const me = bot.entity.position;
    const radius = Number(cfg.attackSearchRadius) || 32;
    const generic = ['hostile', 'hostile_mob', 'monster', 'mob', 'nearest_hostile', 'enemy'].includes(target);

    const matches = Object.values(bot.entities)
      .filter((e) => {
        if (!e || e === bot.entity || !e.position || !LIVING_TYPES.has(e.type)) return false;
        if (e.position.distanceTo(me) > radius) return false;
        if (generic) return isHostile(e);
        return (
          normalizeName(e.username) === target ||
          normalizeName(e.name) === target ||
          normalizeName(e.displayName) === target
        );
      })
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));

    if (matches.length === 0) return `Error: I can't find "${raw}" within ${radius} blocks.`;

    const victim = matches[0];
    const isPlayer = victim.type === 'player';
    if (isPlayer && !cfg.allowAttackPlayers) return 'Error: I am not allowed to attack players.';

    const label = isPlayer ? victim.username : victim.name || String(raw);
    const distance = Math.round(victim.position.distanceTo(me));
    const taskLabel = `fighting ${label}`;
    const id = beginTask(taskLabel);

    try {
      await equipBestWeapon();
    } catch (err) {
      log.warn(`Weapon equip failed: ${shortError(err)}`);
    }
    quiet(() => bot.pvp.attack(victim));

    runBackground(id, taskLabel, async () => {
      await sleep(700); // give the pvp plugin time to register its target
      const started = Date.now();
      while (isCurrent(id) && bot.pvp.target) {
        if (Date.now() - started > 120000) {
          quiet(() => bot.pvp.stop());
          return `I gave up fighting ${label}.`;
        }
        await sleep(500);
      }
      return isCurrent(id) ? `Finished fighting ${label}.` : null;
    });
    return `OK: attacking ${label} (${distance} blocks away).`;
  }

  /* ---------------- give_item ---------------- */

  async function giveItem(args) {
    const username = pick(args, ['username', 'player', 'target', 'to']);
    const rawItem = pick(args, ['item_name', 'item']);
    let count = Math.floor(toNumber(pick(args, ['count', 'amount', 'quantity'])));
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, 2304);

    const player = findPlayer(username);
    if (!player) return `Error: no player named "${username}" is online.`;
    if (!player.entity) return `Error: ${player.username} is too far away for me to see.`;

    const wanted = normalizeName(rawItem);
    if (!wanted) return 'Error: item_name is required.';

    const names = [...new Set(bot.inventory.items().map((i) => i.name))];
    let itemName = names.find((n) => n === wanted);
    if (!itemName) {
      const partial = names.filter((n) => n.includes(wanted));
      if (partial.length === 1) itemName = partial[0];
      else if (partial.length > 1) return `Error: "${rawItem}" is ambiguous. I have: ${partial.join(', ')}.`;
    }
    if (!itemName) return `Error: I don't have any ${rawItem}.`;

    const have = countItem(itemName);
    const amount = Math.min(count, have);
    const itemType = bot.registry.itemsByName[itemName].id;
    const playerName = player.username;
    const label = `giving ${amount} ${itemName} to ${playerName}`;
    const id = beginTask(label);

    runBackground(id, label, async () => {
      const record = bot.players[playerName];
      const entity = record && record.entity;
      if (!entity) throw new Error(`${playerName} went out of sight`);

      try {
        await withTimeout(
          bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)),
          25000,
          'walking to the player'
        );
      } catch (err) {
        quiet(() => bot.pathfinder.setGoal(null));
        throw err;
      }

      const latest = (bot.players[playerName] && bot.players[playerName].entity) || entity;
      await bot.lookAt(latest.position.offset(0, latest.height || 1.6, 0), true);
      await bot.toss(itemType, null, amount);
      return `I gave ${amount} ${itemName} to ${playerName}.`;
    });

    const note = amount < count ? ` (I only have ${have})` : '';
    return `OK: bringing ${amount} ${itemName} to ${playerName}${note}. I'll say when I've handed it over.`;
  }

  /* ---------------- check_surroundings ---------------- */

  let notableIds = null;
  let liquidIds = null;

  function loadBlockIdSets() {
    if (notableIds) return;
    const all = bot.registry.blocksArray;
    notableIds = all
      .filter((b) => /_(ore|log)$/.test(b.name) || b.name.endsWith('_bed') || NOTABLE_BLOCKS.has(b.name))
      .map((b) => b.id);
    liquidIds = all.filter((b) => b.name === 'water' || b.name === 'lava').map((b) => b.id);
  }

  function tallyBlocks(positions, me) {
    const tally = new Map();
    for (const pos of positions) {
      const block = bot.blockAt(pos);
      if (!block) continue;
      const dist = pos.distanceTo(me);
      const entry = tally.get(block.name);
      if (!entry) tally.set(block.name, { count: 1, nearest: dist });
      else {
        entry.count += 1;
        entry.nearest = Math.min(entry.nearest, dist);
      }
    }
    return [...tally.entries()].sort((a, b) => a[1].nearest - b[1].nearest);
  }

  async function checkSurroundings() {
    loadBlockIdSets();
    const me = bot.entity.position;
    const lines = [];

    lines.push(`Position: ${describePos(me)}`);
    const below = bot.blockAt(me.offset(0, -1, 0));
    lines.push(`Standing on: ${below ? below.name : 'unknown'}`);
    const here = bot.blockAt(me);
    if (here && here.biome && here.biome.name) lines.push(`Biome: ${here.biome.name}`);
    if (bot.time && typeof bot.time.timeOfDay === 'number') {
      lines.push(`Time: ${bot.time.timeOfDay < 12500 ? 'daytime' : 'night'}${bot.isRaining ? ', raining' : ''}`);
    }

    const players = Object.values(bot.players)
      .filter((p) => p && p.entity && p.username !== bot.username)
      .map((p) => `${p.username} (${Math.round(p.entity.position.distanceTo(me))}m)`);
    lines.push(`Players nearby: ${players.length ? players.join(', ') : 'none'}`);

    const mobs = new Map();
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position || e.type === 'player' || !LIVING_TYPES.has(e.type)) continue;
      const dist = e.position.distanceTo(me);
      if (dist > 24) continue;
      const key = `${e.name || 'unknown'}${isHostile(e) ? ' [hostile]' : ''}`;
      const entry = mobs.get(key);
      if (!entry) mobs.set(key, { count: 1, nearest: dist });
      else {
        entry.count += 1;
        entry.nearest = Math.min(entry.nearest, dist);
      }
    }
    const mobText = [...mobs.entries()]
      .sort((a, b) => a[1].nearest - b[1].nearest)
      .slice(0, 10)
      .map(([name, info]) => `${name} x${info.count} (nearest ${Math.round(info.nearest)}m)`);
    lines.push(`Mobs within 24 blocks: ${mobText.length ? mobText.join(', ') : 'none'}`);

    const liquids = tallyBlocks(bot.findBlocks({ matching: liquidIds, maxDistance: 12, count: 60 }), me);
    const lava = liquids.find(([name]) => name === 'lava');
    const water = liquids.find(([name]) => name === 'water');
    if (lava) lines.push(`WARNING: lava within ${Math.round(lava[1].nearest)} blocks.`);
    if (water) lines.push(`Water within ${Math.round(water[1].nearest)} blocks.`);

    const resources = tallyBlocks(bot.findBlocks({ matching: notableIds, maxDistance: 20, count: 300 }), me)
      .slice(0, 15)
      .map(([name, info]) => `${name} x${info.count} (nearest ${Math.round(info.nearest)}m)`);
    lines.push(`Notable blocks within 20 blocks: ${resources.length ? resources.join(', ') : 'none'}`);

    return lines.join('\n');
  }

  /* ---------------- tool registry ---------------- */

  const handlers = {
    follow_player: (a) => followPlayer(pick(a, ['username', 'player', 'name', 'target'])),
    stop_moving: async () => {
      stopAll();
      return 'OK: I stopped what I was doing and I am standing still.';
    },
    go_to_coordinates: (a) => goToCoordinates(a),
    mine_block: (a) => mineBlock(a),
    attack_entity: (a) => attackEntity(a),
    equip_best_gear: () => equipBestGear(),
    eat_food: async () => {
      const result = await eatFood();
      return `${result.ok ? 'OK' : 'Error'}: ${result.message}`;
    },
    give_item: (a) => giveItem(a),
    check_surroundings: () => checkSurroundings()
  };

  const definitions = [
    {
      type: 'function',
      function: {
        name: 'follow_player',
        description: 'Continuously follow a player around until told to stop.',
        parameters: {
          type: 'object',
          properties: { username: { type: 'string', description: 'Exact in-game name of the player to follow.' } },
          required: ['username']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'stop_moving',
        description: 'Stop walking, following, mining and fighting, and stand still.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'go_to_coordinates',
        description: 'Walk to the given world coordinates. Only use coordinates the player gave or that appear in your status.',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate.' },
            y: { type: 'number', description: 'Y coordinate (height).' },
            z: { type: 'number', description: 'Z coordinate.' }
          },
          required: ['x', 'y', 'z']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'mine_block',
        description:
          'Find and mine a number of blocks of one type nearby and collect the drops, e.g. oak_log, stone, coal_ore, iron_ore, dirt. "log" mines any tree logs.',
        parameters: {
          type: 'object',
          properties: {
            block_name: { type: 'string', description: 'Minecraft block name such as oak_log, cobblestone, iron_ore.' },
            count: { type: 'integer', description: 'How many blocks to mine (1-64). Defaults to 1.' }
          },
          required: ['block_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'attack_entity',
        description:
          'Attack the nearest mob with the given name (e.g. zombie, skeleton, cow). Use "hostile" to attack the nearest hostile mob.',
        parameters: {
          type: 'object',
          properties: { target_name: { type: 'string', description: 'Mob type name such as zombie, or "hostile".' } },
          required: ['target_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'equip_best_gear',
        description: 'Equip the best armor, the best sword or axe, and a shield from the inventory.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'eat_food',
        description: 'Eat the best safe food in the inventory to restore hunger.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'give_item',
        description: 'Walk to a player and drop items from the inventory for them.',
        parameters: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'Exact in-game name of the player to give items to.' },
            item_name: { type: 'string', description: 'Minecraft item name such as oak_log or bread.' },
            count: { type: 'integer', description: 'How many to give. Defaults to 1.' }
          },
          required: ['username', 'item_name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'check_surroundings',
        description: 'Look around: nearby players, mobs, water/lava, ores, trees and other notable blocks, biome and time.',
        parameters: { type: 'object', properties: {} }
      }
    }
  ];

  async function execute(name, rawArgs) {
    const key = String(name || '').trim();
    const handler = handlers[key];
    if (!handler) return `Error: unknown tool "${name}". Available tools: ${Object.keys(handlers).join(', ')}.`;

    let args = rawArgs;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch (_) {
        args = {};
      }
    }
    if (!args || typeof args !== 'object') args = {};

    let result;
    try {
      result = String(await handler(args));
    } catch (err) {
      result = `Error: ${shortError(err)}`;
    }
    let argText = '';
    try {
      argText = JSON.stringify(args);
    } catch (_) {
      argText = '{}';
    }
    log.info(`[tool] ${key}(${argText}) -> ${result.split('\n')[0].slice(0, 160)}`);
    return result;
  }

  return {
    definitions,
    execute,
    actions: { eatFood, equipArmor, stopAll }
  };
}

module.exports = { createTools, normalizeName };
