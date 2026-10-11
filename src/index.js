const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalBlock, GoalFollow, GoalNear } = goals;
const Vec3 = require('vec3');
const fs = require('node:fs');
const path = require('node:path');
const { loadLitematic } = require('./litematic');

const required = ['MC_HOST', 'MC_USERNAME', 'COMMANDER_USERNAME'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const port = Number(process.env.MC_PORT || 25565);
const version = process.env.MC_VERSION || false;
const runnerMode = String(process.env.RUNNER_MODE || 'smp').trim().toLowerCase();
if (!['smp', 'anarchy'].includes(runnerMode)) {
  console.error('Invalid RUNNER_MODE. Choose smp or anarchy.');
  process.exit(1);
}
const targetServer = runnerMode === 'anarchy' ? 'anarchy' : 'wanderwood';
const inputDir = path.resolve(process.env.SCHEMATIC_DIR || 'Input');
let coordinatorUsername;

// BOT_CREDENTIALS is a repository Actions secret with one "username/password"
// pair per line. Passwords are never printed to logs.
function loadBotCredentials(raw) {
  const credentials = new Map();
  const lines = (raw || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 5) {
    console.error('BOT_CREDENTIALS supports at most 5 botname/botpassword lines.');
    process.exit(1);
  }
  for (const line of lines) {
    const slash = line.indexOf('/');
    if (slash <= 0 || slash === line.length - 1) {
      console.error('Invalid BOT_CREDENTIALS entry. Use one botname/botpassword pair per line.');
      process.exit(1);
    }
    const username = line.slice(0, slash).trim();
    const password = line.slice(slash + 1).trim();
    if (!/^[a-z0-9_]{1,16}$/i.test(username) || !password) {
      console.error('Invalid BOT_CREDENTIALS username or empty password.');
      process.exit(1);
    }
    const key = username.toLowerCase();
    if (credentials.has(key)) {
      console.error('Duplicate username in BOT_CREDENTIALS.');
      process.exit(1);
    }
    credentials.set(key, password);
  }
  return credentials;
}

const botCredentials = loadBotCredentials(process.env.BOT_CREDENTIALS);
coordinatorUsername = process.env.BOT_COORDINATOR_USERNAME || [...botCredentials.keys()][0] || process.env.MC_USERNAME;
const configuredBots = (process.env.BOT_GROUP || [...botCredentials.keys()].join(',') || process.env.MC_USERNAME)
  .split(',').map((name) => name.trim()).filter(Boolean);
const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port,
  username: process.env.MC_USERNAME,
  version,
  auth: process.env.MC_AUTH || 'offline',
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  console.log(`[${bot.username}] Connected. Coordinator: ${coordinatorUsername}. Waiting for commander chat commands.`);
});

// Log incoming server messages so authentication prompts and chat can be diagnosed
// from the Actions log. Never log the configured passwords or outgoing auth commands.
const handledAuthPrompts = new Set();
const handledLoginConfirmations = new Set();
const recentCommandMessages = new Map();

function dispatchChatCommand(username, message, source) {
  const sender = String(username || '').trim();
  const text = String(message || '').trim();
  if (!sender || !text || sender.toLowerCase() === String(bot.username).toLowerCase()) return;
  const key = sender.toLowerCase() + '|' + text.toLowerCase();
  const now = Date.now();
  const previous = recentCommandMessages.get(key);
  if (previous && now - previous < 1500) return;
  recentCommandMessages.set(key, now);
  console.log('[' + bot.username + '] [CHAT COMMAND INPUT via ' + source + '] sender=' + sender + ' message=' + text);
  void handleCommand(text, sender).catch((error) => {
    console.error('[' + bot.username + '] Command handler error:', error);
    reply('Command failed; check the bot log for details.');
  });
}

bot.on('messagestr', (message, position, jsonMsg, senderUuid) => {
  const text = String(message).replace(/§[0-9a-fk-or]/gi, '').trim();
  console.log(`[${bot.username}] [INCOMING ${position || 'unknown'}] ${text}`);

  // Ignore ordinary player chat so a player cannot trigger a password command
  // by typing a fake prompt. Auth plugins may use system or game-info messages.
  if (position === 'chat') {
    // Some server chat formats appear in messagestr but do not trigger Mineflayer's
    // parsed 'chat' event. Resolve the sender UUID through the player list as a fallback.
    const normalizedSenderUuid = String(senderUuid || '').replace(/-/g, '').toLowerCase();
    const senderEntry = normalizedSenderUuid
      ? Object.entries(bot.players).find(([, player]) =>
          player.uuid && String(player.uuid).replace(/-/g, '').toLowerCase() === normalizedSenderUuid)
      : null;
    if (senderEntry) {
      dispatchChatCommand(senderEntry[0], text, 'messagestr');
    } else {
      console.log('[' + bot.username + '] [CHAT COMMAND INPUT] Could not resolve chat sender UUID; parsed chat event will be used if available.');
    }
    return;
  }
  if (/successful login/i.test(text) && !handledLoginConfirmations.has(String(bot.username).toLowerCase())) {
    handledLoginConfirmations.add(String(bot.username).toLowerCase());
    console.log(`[${bot.username}] LOGIN CONFIRMED by server. Sending /server ${targetServer}.`);
    bot.chat(`/server ${targetServer}`);

    const statusDir = process.env.LOGIN_STATUS_DIR;
    if (statusDir) {
      try {
        fs.mkdirSync(statusDir, { recursive: true });
        const markerName = String(bot.username).replace(/[^a-z0-9_-]/gi, '_') + '.logged-in';
        fs.writeFileSync(path.join(statusDir, markerName), new Date().toISOString(), 'utf8');
      } catch (error) {
        console.error(`[${bot.username}] Could not write login status marker:`, error.message);
      }
    }
  }

  let action = null;
  if (/\bregister\b/i.test(text) && /\/register\b/i.test(text)) {
    action = 'register';
  } else if (/\blog\s*in\b|\blogin\b/i.test(text) && /\/login\b/i.test(text)) {
    action = 'login';
  }
  if (!action || handledAuthPrompts.has(action)) return;

  const password = botCredentials.get(String(bot.username).toLowerCase());
  if (!password) {
    console.error(`[${bot.username}] Server requested ${action}, but BOT_CREDENTIALS has no entry for this bot username.`);
    return;
  }
  handledAuthPrompts.add(action);
  if (action === 'register') bot.chat(`/register ${password} ${password}`);
  else bot.chat(`/login ${password}`);
  console.log(`[${bot.username}] Sent the / ${action} command in response to a system prompt (password hidden).`);
});

bot.on('kicked', (reason) => console.error(`[${bot.username}] Kicked from server:`, reason));
bot.on('error', (error) => console.error(`[${bot.username}] Minecraft bot error:`, error));
bot.on('end', () => console.log(`[${bot.username}] Minecraft connection ended.`));

// Automatically request respawn after death so a bot can resume working.
bot.on('death', () => {
  console.warn(`[${bot.username}] Died; requesting respawn in 1 second.`);
  setTimeout(() => {
    try {
      bot.respawn();
    } catch (error) {
      console.error(`[${bot.username}] Respawn request failed:`, error.message);
    }
  }, 1000);
});

function reply(message) {
  // Only the coordinator bot may send command replies to public chat.
  // Every bot can still process commands locally, but non-coordinators stay silent.
  if (String(bot.username).toLowerCase() !== String(coordinatorUsername).toLowerCase()) {
    return;
  }
  bot.chat(String(message).slice(0, 240));
}

function getSchematics() {
  if (!fs.existsSync(inputDir)) return [];
  return fs.readdirSync(inputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(schem|schematic|litematic)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function parseCoordinates(value) {
  const parts = value.trim().split(/[ ,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: Math.floor(parts[0]), y: Math.floor(parts[1]), z: Math.floor(parts[2]) };
}

const state = { schematic: null, pos1: null, pos2: null, following: null };
const pendingInventory = new Map();
const digoutCompletions = new Map();
let requestCounter = 0;

function ownInventory() {
  const counts = new Map();
  for (const item of bot.inventory.items()) {
    counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  }
  return counts;
}

function requestInventory(botNames, timeoutMs = 6000) {
  const uniqueNames = [...new Set(botNames)];
  const requestId = `${Date.now().toString(36)}${(++requestCounter).toString(36)}`;
  const request = { expected: new Set(uniqueNames), reports: new Map(), resolve: null };
  const result = new Promise((resolve) => { request.resolve = resolve; });
  pendingInventory.set(requestId, request);

  for (const name of uniqueNames) {
    if (name.toLowerCase() === bot.username.toLowerCase()) {
      request.reports.set(bot.username, ownInventory());
      request.expected.delete(name);
    }
  }

  if (request.expected.size === 0) {
    pendingInventory.delete(requestId);
    request.resolve({ reports: request.reports, missing: [] });
    return result;
  }

  for (const name of request.expected) {
    bot.chat(`BuildersInternal inventory-request ${requestId} ${name}`);
  }

  setTimeout(() => {
    if (!pendingInventory.has(requestId)) return;
    pendingInventory.delete(requestId);
    request.resolve({
      reports: request.reports,
      missing: [...request.expected].filter((name) =>
        ![...request.reports.keys()].some((reported) => reported.toLowerCase() === name.toLowerCase())),
    });
  }, timeoutMs);
  return result;
}

function sendInventoryReport(requestId) {
  const counts = ownInventory();
  for (const [name, count] of counts) {
    bot.chat(`BuildersInternal inventory-item ${requestId} ${bot.username} ${name} ${count}`);
  }
  bot.chat(`BuildersInternal inventory-done ${requestId} ${bot.username}`);
}

function handleInternalMessage(username, message) {
  const parts = message.trim().split(/\s+/);
  if (parts[0] !== 'BuildersInternal') return false;

  if (parts[1] === 'digout-warning' && parts.length === 8) {
    const diggerName = parts[2];
    const reporter = parts[3];
    const x = Number(parts[4]);
    const y = Number(parts[5]);
    const z = Number(parts[6]);
    const kind = parts[7];
    if (reporter.toLowerCase() === username.toLowerCase() &&
        configuredBots.some((name) => name.toLowerCase() === username.toLowerCase()) &&
        Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
        (kind === 'water' || kind === 'lava') &&
        bot.username.toLowerCase() === diggerName.toLowerCase()) {
      reply(`Digout warning: ${kind} detected near ${x} ${y} ${z}; nearby blocks are being left intact.`);
    }
    return true;
  }

  if (parts[1] === 'digout-worker-done' && parts.length === 4) {
    const diggerName = parts[2];
    const reportedWorker = parts[3];
    if (reportedWorker.toLowerCase() === username.toLowerCase()) {
      const key = diggerName.toLowerCase();
      if (!digoutCompletions.has(key)) digoutCompletions.set(key, new Set());
      digoutCompletions.get(key).add(reportedWorker.toLowerCase());
    }
    return true;
  }

  if (username.toLowerCase() === coordinatorUsername.toLowerCase() &&
      parts[1] === 'digout-start' && parts.length === 5) {
    const diggerName = parts[2];
    const targetY = Number(parts[3]);
    const dimensions = parts[4].split('x').map(Number);
    if (bot.username.toLowerCase() !== diggerName.toLowerCase() &&
        Number.isInteger(targetY) && dimensions.length === 3 &&
        dimensions.every((n) => Number.isInteger(n) && n >= 1 && n <= 15)) {
      void runDigoutWorker(diggerName, targetY, dimensions);
    }
    return true;
  }

  if (username.toLowerCase() === coordinatorUsername.toLowerCase() &&
      parts[1] === 'inventory-request' && parts.length === 4) {
    const [, , requestId, target] = parts;
    if (target.toLowerCase() === bot.username.toLowerCase()) sendInventoryReport(requestId);
    return true;
  }

  const requestId = parts[2];
  const request = pendingInventory.get(requestId);
  if (!request || ![...request.expected].some((name) => name.toLowerCase() === username.toLowerCase())) return true;

  if (parts[1] === 'inventory-item' && parts.length === 6) {
    const [, , , reportedBot, itemName, rawCount] = parts;
    const count = Number(rawCount);
    if (reportedBot.toLowerCase() !== username.toLowerCase() || !Number.isSafeInteger(count) || count < 0) return true;
    if (!request.reports.has(username)) request.reports.set(username, new Map());
    const inventory = request.reports.get(username);
    inventory.set(itemName, (inventory.get(itemName) || 0) + count);
    return true;
  }

  if (parts[1] === 'inventory-done' && parts.length === 4) {
    const reportedBot = parts[3];
    if (reportedBot.toLowerCase() !== username.toLowerCase()) return true;
    if (!request.reports.has(username)) request.reports.set(username, new Map());
    for (const expectedName of request.expected) {
      if (expectedName.toLowerCase() === username.toLowerCase()) request.expected.delete(expectedName);
    }
    if (request.expected.size === 0) {
      pendingInventory.delete(requestId);
      request.resolve({ reports: request.reports, missing: [] });
    }
    return true;
  }
  return true;
}

function bestPickaxe() {
  const rank = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
  const pickaxes = bot.inventory.items().filter((item) => rank.includes(item.name));
  pickaxes.sort((a, b) => rank.indexOf(a.name) - rank.indexOf(b.name));
  return pickaxes[0] || null;
}

async function equipBestPickaxe() {
  const pickaxe = bestPickaxe();
  if (!pickaxe) throw new Error('No pickaxe found in inventory.');
  await bot.equip(pickaxe, 'hand');
  console.log(`[${bot.username}] Equipped best available pickaxe: ${pickaxe.name}.`);
  return pickaxe;
}

const gearMaterialRank = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather', 'turtle'];
function gearItemPriority(item) {
  const name = item.name;
  const materialIndex = gearMaterialRank.findIndex((material) => name.startsWith(material + '_'));
  return materialIndex < 0 ? 999 : materialIndex;
}
function isWantedGearItem(item) {
  const name = item.name;
  return /_(helmet|chestplate|leggings|boots)$/.test(name) ||
    /_(pickaxe|axe)$/.test(name) ||
    name === 'totem_of_undying' ||
    name === 'golden_apple' ||
    name === 'enchanted_golden_apple';
}
function findBestTool(toolType) {
  const rank = toolType === 'pickaxe'
    ? ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe']
    : ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
  return bot.inventory.items()
    .filter((item) => rank.includes(item.name))
    .sort((a, b) => rank.indexOf(a.name) - rank.indexOf(b.name))[0] || null;
}
function nearbyShulkerPlacement() {
  if (!bot.entity || !bot.entity.position) return null;
  const floorY = Math.floor(bot.entity.position.y) - 1;
  const baseX = Math.floor(bot.entity.position.x);
  const baseZ = Math.floor(bot.entity.position.z);
  const offsets = [
    [2, 0], [-2, 0], [0, 2], [0, -2],
    [2, 2], [-2, 2], [2, -2], [-2, -2],
    [3, 0], [-3, 0], [0, 3], [0, -3],
    [1, 2], [-1, 2], [1, -2], [-1, -2]
  ];
  const botIndex = Math.max(0, configuredBots.findIndex((name) => name.toLowerCase() === bot.username.toLowerCase()));
  const ordered = offsets.slice(botIndex % offsets.length).concat(offsets.slice(0, botIndex % offsets.length));
  for (const [dx, dz] of ordered) {
    const support = bot.blockAt(new Vec3(baseX + dx, floorY, baseZ + dz));
    const targetPos = new Vec3(baseX + dx, floorY + 1, baseZ + dz);
    const target = bot.blockAt(targetPos);
    if (support && support.boundingBox === 'block' && target && target.name === 'air') {
      return { support, targetPos };
    }
  }
  return null;
}

async function lootNearbyShulker() {
  const shulker = bot.inventory.items().find((item) => /^(?:[a-z]+_)?shulker_box$/.test(item.name));
  if (!shulker) return false;
  const placement = nearbyShulkerPlacement();
  if (!placement) {
    console.warn(`[${bot.username}] Has a shulker box but no safe nearby floor spot to place it.`);
    return false;
  }

  await bot.equip(shulker, 'hand');
  await bot.placeBlock(placement.support, new Vec3(0, 1, 0));
  await waitMs(350);
  const placed = bot.blockAt(placement.targetPos);
  if (!placed || !placed.name.endsWith('shulker_box')) {
    throw new Error('Could not confirm the placed shulker box.');
  }

  let container;
  try {
    container = await bot.openContainer(placed);
    const contents = container.containerItems().filter(isWantedGearItem);
    let withdrawn = 0;
    for (const item of contents) {
      try {
        await container.withdraw(item.type, item.metadata, item.count);
        withdrawn += item.count;
      } catch (error) {
        console.warn(`[${bot.username}] Could not take all ${item.name} from shulker: ${error.message}`);
      }
    }
    const remaining = container.containerItems();
    container.close();
    await waitMs(250);
    if (remaining.length === 0) {
      const currentBlock = bot.blockAt(placement.targetPos);
      if (currentBlock && currentBlock.name.endsWith('shulker_box') && bot.canDigBlock(currentBlock)) {
        await bot.dig(currentBlock);
      }
      console.log(`[${bot.username}] Looted ${withdrawn} item(s) from shulker and reclaimed the empty box if possible.`);
    } else {
      console.log(`[${bot.username}] Looted ${withdrawn} item(s); left the shulker placed because it still contains other items.`);
    }
    return true;
  } catch (error) {
    if (container) {
      try { container.close(); } catch {}
    }
    throw error;
  }
}

async function gearUp() {
  state.following = null;
  bot.pathfinder.setGoal(null);
  let shulkerChecked = false;
  if (bot.inventory.items().some((item) => /^(?:[a-z]+_)?shulker_box$/.test(item.name))) {
    shulkerChecked = true;
    try {
      await lootNearbyShulker();
    } catch (error) {
      console.error(`[${bot.username}] Shulker looting failed:`, error.message);
    }
  }

  const armorSlots = [
    ['helmet', 'head'],
    ['chestplate', 'torso'],
    ['leggings', 'legs'],
    ['boots', 'feet']
  ];
  for (const [suffix, destination] of armorSlots) {
    const candidates = bot.inventory.items()
      .filter((item) => item.name.endsWith('_' + suffix))
      .sort((a, b) => gearItemPriority(a) - gearItemPriority(b));
    if (candidates.length) {
      try {
        await bot.equip(candidates[0], destination);
        console.log(`[${bot.username}] Equipped ${candidates[0].name} in ${destination}.`);
      } catch (error) {
        console.warn(`[${bot.username}] Could not equip ${candidates[0].name}: ${error.message}`);
      }
    }
  }

  const totem = bot.inventory.items().find((item) => item.name === 'totem_of_undying');
  if (totem) {
    try {
      await bot.equip(totem, 'off-hand');
      console.log(`[${bot.username}] Equipped totem of undying in off-hand.`);
    } catch (error) {
      console.warn(`[${bot.username}] Could not equip off-hand totem: ${error.message}`);
    }
  } else {
    console.warn(`[${bot.username}] No totem of undying found in inventory or looted shulker.`);
  }

  const pickaxe = findBestTool('pickaxe');
  if (pickaxe) {
    await bot.equip(pickaxe, 'hand');
    console.log(`[${bot.username}] Main hand set to ${pickaxe.name}.`);
  } else {
    console.warn(`[${bot.username}] No pickaxe found in inventory or looted shulker.`);
  }
  const axe = findBestTool('axe');
  if (axe) console.log(`[${bot.username}] Has axe available: ${axe.name}.`);
  const apples = bot.inventory.items().filter((item) => item.name === 'golden_apple' || item.name === 'enchanted_golden_apple')
    .reduce((sum, item) => sum + item.count, 0);
  console.log(`[${bot.username}] Gear check complete: ${apples} golden apple(s) carried; shulker checked: ${shulkerChecked}.`);
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fluidKind(block) {
  if (!block) return null;
  if (block.name === 'water' || block.name.includes('water')) return 'water';
  if (block.name === 'lava' || block.name.includes('lava')) return 'lava';
  return null;
}

function fluidHazardAt(position) {
  const directions = [
    [0, 0, 0], [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
  ];
  for (const [dx, dy, dz] of directions) {
    const block = bot.blockAt(position.offset(dx, dy, dz));
    const kind = fluidKind(block);
    if (kind) return { kind, position: position.offset(dx, dy, dz) };
  }
  return null;
}

function warnDigoutHazard(diggerName, hazardPosition, kind) {
  const x = Math.floor(hazardPosition.x);
  const y = Math.floor(hazardPosition.y);
  const z = Math.floor(hazardPosition.z);
  console.warn(`[${bot.username}] Digout avoiding ${kind} near ${x} ${y} ${z}.`);
  bot.chat(`BuildersInternal digout-warning ${diggerName} ${bot.username} ${x} ${y} ${z} ${kind}`);
}

async function runDigoutDigger(targetY, dimensions) {
  state.following = null;
  bot.pathfinder.setGoal(null);
  try {
    await equipBestPickaxe();
    let steps = 0;
    while (Math.floor(bot.entity.position.y) > targetY && steps < 256) {
      const feet = bot.entity.position;
      const below = bot.blockAt(new Vec3(Math.floor(feet.x), Math.floor(feet.y) - 1, Math.floor(feet.z)));
      if (!below || below.name === 'air') {
        await waitMs(350);
        steps++;
        continue;
      }
      const descentHazard = fluidHazardAt(below.position);
      if (descentHazard) {
        warnDigoutHazard(bot.username, descentHazard.position, descentHazard.kind);
        throw new Error(`${descentHazard.kind} detected near the descent shaft; stopping rather than opening it.`);
      }
      if (!bot.canDigBlock(below)) throw new Error(`Cannot dig block below bot: ${below.name}`);
      await bot.dig(below);
      await waitMs(250);
      steps++;
    }
    if (Math.floor(bot.entity.position.y) > targetY) {
      throw new Error('Could not reach target Y within the dig limit.');
    }

    const others = configuredBots.filter((name) => name.toLowerCase() !== bot.username.toLowerCase());
    for (const name of others) {
      bot.chat(`/tpahere ${name}`);
      await waitMs(800);
    }
    bot.chat(`BuildersInternal digout-start ${bot.username} ${targetY} ${dimensions.join('x')}`);
    reply(`Digout at Y=${targetY}: sent TPA requests to ${others.length} bot(s); mining area ${dimensions.join('x')}.`);
  } catch (error) {
    console.error(`[${bot.username}] Digout descent failed:`, error.message);
    reply(`Digout stopped: ${error.message}`);
  }
}

async function runDigoutWorker(diggerName, targetY, dimensions) {
  const workers = configuredBots.filter((name) => name.toLowerCase() !== diggerName.toLowerCase());
  const workerIndex = workers.findIndex((name) => name.toLowerCase() === bot.username.toLowerCase());
  if (workerIndex < 0 || workers.length === 0) return;

  try {
    await equipBestPickaxe();
    bot.pathfinder.setGoal(null);
    bot.chat(`/tpaccept ${diggerName}`);
    console.log(`[${bot.username}] Accepted teleport request from ${diggerName}; waiting for teleport.`);
    await waitMs(3500);

    const centerX = Math.floor(bot.entity.position.x);
    const centerZ = Math.floor(bot.entity.position.z);
    const [width, height, depth] = dimensions;
    const startX = centerX - Math.floor(width / 2);
    const startZ = centerZ - Math.floor(depth / 2);
    let mined = 0;
    const warnedFluidKinds = new Set();

    // Split whole X-columns between workers to reduce duplicate digging.
    for (let y = targetY + height - 1; y >= targetY; y--) {
      for (let xOffset = 0; xOffset < width; xOffset++) {
        if (xOffset % workers.length !== workerIndex) continue;
        for (let zOffset = 0; zOffset < depth; zOffset++) {
          const x = startX + xOffset;
          const z = startZ + zOffset;
          let block = bot.blockAt(new Vec3(x, y, z));
          if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
          try {
            await bot.pathfinder.goto(new GoalNear(x, y, z, 3));
            block = bot.blockAt(new Vec3(x, y, z));
            if (!block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') continue;
            const hazard = fluidHazardAt(block.position);
            if (hazard) {
              if (!warnedFluidKinds.has(hazard.kind)) {
                warnedFluidKinds.add(hazard.kind);
                warnDigoutHazard(diggerName, hazard.position, hazard.kind);
              }
              continue;
            }
            if (!bot.canDigBlock(block)) continue;
            await bot.equip(bestPickaxe(), 'hand');
            await bot.dig(block);
            mined++;
          } catch (error) {
            console.warn(`[${bot.username}] Could not mine ${x} ${y} ${z}: ${error.message}`);
          }
        }
      }
    }
    // Re-scan the intended excavation volume twice to clear blocks that fell or
    // appeared after their column was first mined. Fluids and their immediate neighbors
    // are protected; those blocks are reported and left alone.
    let cleanupMined = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = targetY + height - 1; y >= targetY; y--) {
        for (let xOffset = 0; xOffset < width; xOffset++) {
          if (xOffset % workers.length !== workerIndex) continue;
          for (let zOffset = 0; zOffset < depth; zOffset++) {
            const x = startX + xOffset;
            const z = startZ + zOffset;
            let block = bot.blockAt(new Vec3(x, y, z));
            if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) continue;
            const hazard = fluidHazardAt(block.position);
            if (hazard) {
              if (!warnedFluidKinds.has(hazard.kind)) {
                warnedFluidKinds.add(hazard.kind);
                warnDigoutHazard(diggerName, hazard.position, hazard.kind);
              }
              continue;
            }
            try {
              await bot.pathfinder.goto(new GoalNear(x, y, z, 3));
              block = bot.blockAt(new Vec3(x, y, z));
              if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) continue;
              const recheckHazard = fluidHazardAt(block.position);
              if (recheckHazard) {
                if (!warnedFluidKinds.has(recheckHazard.kind)) {
                  warnedFluidKinds.add(recheckHazard.kind);
                  warnDigoutHazard(diggerName, recheckHazard.position, recheckHazard.kind);
                }
                continue;
              }
              if (!bot.canDigBlock(block)) continue;
              await bot.equip(bestPickaxe(), 'hand');
              await bot.dig(block);
              cleanupMined++;
            } catch (error) {
              console.warn(`[${bot.username}] Cleanup pass could not clear ${x} ${y} ${z}: ${error.message}`);
            }
          }
        }
      }
    }
    if (cleanupMined) console.log(`[${bot.username}] Cleanup pass removed ${cleanupMined} late/fallen block(s).`);

    // Tell the other workers this bot has finished mining, then wait for every
    // assigned worker before lighting the floor so torches are not skipped on blocks
    // that another bot has not cleared yet.
    const digoutKey = diggerName.toLowerCase();
    if (!digoutCompletions.has(digoutKey)) digoutCompletions.set(digoutKey, new Set());
    digoutCompletions.get(digoutKey).add(bot.username.toLowerCase());
    bot.chat(`BuildersInternal digout-worker-done ${diggerName} ${bot.username}`);
    const expectedWorkers = workers.map((name) => name.toLowerCase());
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 600000) {
      const done = digoutCompletions.get(digoutKey) || new Set();
      if (expectedWorkers.every((name) => done.has(name))) break;
      await waitMs(500);
    }
    const completedWorkers = digoutCompletions.get(digoutKey) || new Set();
    if (!expectedWorkers.every((name) => completedWorkers.has(name))) {
      console.warn(`[${bot.username}] Timed out waiting for all digout workers; placing torches only where floor is clear.`);
    }

    // Place torches on the exposed floor in a grid after mining. Eight-block spacing
    // gives overlapping light coverage in ordinary open tunnels, but cannot guarantee
    // spawn-proofing in every version or on irregular terrain.
    const torchStacks = bot.inventory.items().filter((item) => item.name === 'torch');
    if (torchStacks.length) {
      const [widthForTorches, , depthForTorches] = dimensions;
      const xOffsets = [...new Set([Math.min(1, widthForTorches - 1), Math.min(9, widthForTorches - 1)])];
      const zOffsets = [...new Set([Math.min(1, depthForTorches - 1), Math.min(9, depthForTorches - 1)])];
      let placedTorches = 0;
      for (const xOffset of xOffsets) {
        for (const zOffset of zOffsets) {
          const torchSlot = xOffsets.indexOf(xOffset) * zOffsets.length + zOffsets.indexOf(zOffset);
          if (torchSlot % workers.length !== workerIndex) continue;
          const x = startX + xOffset;
          const z = startZ + zOffset;
          let floor = bot.blockAt(new Vec3(x, targetY - 1, z));
          let target = bot.blockAt(new Vec3(x, targetY, z));
          if (!floor || floor.boundingBox !== 'block' || !target || target.name !== 'air') continue;
          try {
            await bot.pathfinder.goto(new GoalNear(x, targetY, z, 3));
            floor = bot.blockAt(new Vec3(x, targetY - 1, z));
            target = bot.blockAt(new Vec3(x, targetY, z));
            if (!floor || floor.boundingBox !== 'block' || !target || target.name !== 'air') continue;
            const torch = bot.inventory.items().find((item) => item.name === 'torch');
            if (!torch) break;
            await bot.equip(torch, 'hand');
            await bot.placeBlock(floor, new Vec3(0, 1, 0));
            placedTorches++;
          } catch (error) {
            console.warn(`[${bot.username}] Could not place torch at ${x} ${targetY} ${z}: ${error.message}`);
          }
        }
      }
      console.log(`[${bot.username}] Placed ${placedTorches} torch(es) in the digout floor grid.`);
      const pickaxeAfterLighting = findBestTool('pickaxe');
      if (pickaxeAfterLighting) await bot.equip(pickaxeAfterLighting, 'hand');
    }
    console.log(`[${bot.username}] Digout finished; mined ${mined} block(s) in assigned columns.`);
  } catch (error) {
    console.error(`[${bot.username}] Digout worker failed:`, error.message);
  }
}

function combineInventories(reports) {
  const combined = new Map();
  for (const inventory of reports.values()) {
    for (const [item, count] of inventory) combined.set(item, (combined.get(item) || 0) + count);
  }
  return combined;
}

async function showInventory(botNames) {
  const { reports, missing } = await requestInventory(botNames);
  const combined = combineInventories(reports);
  if (reports.size === 0) {
    reply('No inventory reports received. Check that the named bots are online and use the same coordinator username.');
    return;
  }
  reply(`Inventory reports received from: ${[...reports.keys()].join(', ')}.`);
  for (const [name, inventory] of reports) {
    const entries = [...inventory.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([item, count]) => `${item} x${count}`);
    reply(`${name}: ${entries.length ? entries.join(', ') : 'inventory empty'}`);
  }
  const totals = [...combined.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([item, count]) => `${item} x${count}`);
  reply(`Combined total: ${totals.length ? totals.join(', ') : 'empty'}`);
  if (missing.length) reply(`No response from: ${missing.join(', ')}`);
}

async function reportMaterials(botNames = configuredBots) {
  if (!state.schematic) {
    reply('Choose a schematic first: Builders schem set <name>.');
    return;
  }
  if (!state.schematic.toLowerCase().endsWith('.litematic')) {
    reply('Material counting currently supports .litematic files only.');
    return;
  }
  try {
    const data = await loadLitematic(path.join(inputDir, state.schematic));
    reply(`Materials for ${state.schematic}: ${data.blockCount} non-air blocks.`);
    const { reports, missing } = await requestInventory(botNames);
    const combined = combineInventories(reports);
    const entries = data.materials.map((item) => {
      const name = item.block.replace(/^minecraft:/, '');
      const available = combined.get(name) || combined.get(item.block) || 0;
      return { name, needed: item.count, available, deficit: Math.max(0, item.count - available) };
    });
    const shortTypes = entries.filter((item) => item.deficit > 0).length;
    reply(`Inventories checked: ${[...reports.keys()].join(', ') || 'none'}; ${shortTypes} material types short.`);
    for (let i = 0; i < entries.length; i += 3) {
      reply(entries.slice(i, i + 3).map((item) =>
        `${item.name} need ${item.needed}, have ${item.available}, short ${item.deficit}`).join(' | '));
    }
    if (missing.length) reply(`No report from: ${missing.join(', ')}`);
    reply('Counts include player inventory only, not shulkers/chests; item variants and stack limits need further handling.');
  } catch (error) {
    console.error('Could not read selected Litematica file:', error);
    reply('Could not read that .litematic file. Check the file format; details are in the bot log.');
  }
}

async function handleCommand(rawMessage, username) {
  const message = rawMessage.trim();
  if (message.startsWith('BuildersInternal ')) {
    handleInternalMessage(username, message);
    return;
  }
  const configuredCommander = String(process.env.COMMANDER_USERNAME || '').trim();
  if (username.toLowerCase() !== configuredCommander.toLowerCase()) {
    if (message.toLowerCase().startsWith('builders ')) {
      console.log('[' + bot.username + '] Ignoring Builders command from "' + username + '"; COMMANDER_USERNAME is configured as "' + configuredCommander + '".');
    }
    return;
  }
  if (!message.toLowerCase().startsWith('builders ')) return;

  const command = message.slice('Builders '.length).trim();
  const lower = command.toLowerCase();
  const isInventoryCommand = lower === 'material list' || lower.startsWith('holder ');
  if (isInventoryCommand && bot.username.toLowerCase() !== coordinatorUsername.toLowerCase()) return;

  if (lower === 'help') {
    reply('Commands: follow <playername> | tpa <playername> | rtp | gear | digout <y> <width>x<height>x<depth> | schem list | schem set <name> | coords set1/set2 <x y z> | material list | holder <bot...> | build schem | say <message>');
    return;
  }
  const tpaMatch = command.match(/^tpa\s+([a-z0-9_]{1,16})$/i);
  if (tpaMatch) {
    const targetName = tpaMatch[1];
    bot.chat('/tpa ' + targetName);
    console.log('[' + bot.username + '] Sent /tpa request to ' + targetName + '.');
    return;
  }
  const followMatch = command.match(/^follow\s+([a-z0-9_]{1,16})$/i);
  if (followMatch) {
    const targetName = followMatch[1];
    const player = bot.players[targetName] ||
      Object.entries(bot.players).find(([name]) => name.toLowerCase() === targetName.toLowerCase())?.[1];
    if (!player || !player.entity) {
      reply(`Can't see player ${targetName}. Make sure they're online and nearby, then try again.`);
      return;
    }
    state.following = targetName;
    bot.pathfinder.setGoal(new GoalFollow(player.entity, 2), true);
    console.log(`[${bot.username}] Following player ${targetName}.`);
    reply(`Following ${targetName}.`);
    return;
  }
  if (lower === 'gear') {
    try {
      await gearUp();
      reply('Gear check finished for ' + bot.username + '.');
    } catch (error) {
      console.error('[' + bot.username + '] Gear command failed:', error);
      reply('Gear command failed for ' + bot.username + '; check the bot log.');
    }
    return;
  }
  if (lower === 'rtp') {
    state.following = null;
    try {
      bot.pathfinder.setGoal(null);
      // Spread bots along the X axis so they do not stack inside one another.
      const botIndex = configuredBots.findIndex((name) => name.toLowerCase() === bot.username.toLowerCase());
      const slotOffset = botIndex < 0 ? 0 : Math.round((botIndex - (configuredBots.length - 1) / 2) * 2);
      const standX = 2 + slotOffset;
      const standZ = -8;
      await bot.pathfinder.goto(new GoalBlock(standX, 116, standZ));

      // Yaw 0 faces south (+Z). Aim at the NPC itself from each bot's separate slot.
      await bot.look(0, 0, true);
      let npc = bot.entityAtCursor(5);
      if (!npc) {
        const botNames = new Set(configuredBots.map((name) => name.toLowerCase()));
        const standPosition = new Vec3(2, 116, -8);
        const candidates = Object.values(bot.entities)
          .filter((entity) => entity && entity !== bot.entity && entity.position &&
            entity.position.z > standZ &&
            entity.position.distanceTo(standPosition) <= 7 &&
            !(entity.username && botNames.has(entity.username.toLowerCase())))
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
        if (candidates.length) {
          const target = candidates[0];
          await bot.lookAt(target.position.offset(0, Math.max(0.5, (target.height || 1.8) * 0.8), 0), true);
          npc = bot.entityAtCursor(5);
        }
      }

      if (npc) {
        await bot.activateEntity(npc);
        console.log('[' + bot.username + '] Right-clicked the entity from slot X=' + standX + '.');
        // Give the server-side NPC/plugin interaction time to run, then restore level south-facing view.
        await waitMs(1200);
        await bot.look(0, 0, true);
        console.log('[' + bot.username + '] Reapplied south-facing yaw and level pitch after NPC interaction.');
      } else {
        console.warn('[' + bot.username + '] No entity was targeted from slot X=' + standX + '; skipped NPC click.');
      }
      reply('Reached RTP click position X=' + standX + ', Y=116, Z=' + standZ + '.');
    } catch (error) {
      console.error('[' + bot.username + '] RTP movement failed:', error.message);
      reply('RTP movement failed for ' + bot.username + '; check the bot log.');
    }
    return;
  }
  const digoutMatch = command.match(/^digout\s+(-?\d+)\s+(\d+)x(\d+)x(\d+)$/i);
  if (digoutMatch) {
    if (bot.username.toLowerCase() !== coordinatorUsername.toLowerCase()) return;
    const targetY = Number(digoutMatch[1]);
    const dimensions = digoutMatch.slice(2).map(Number);
    if (targetY < -64 || targetY > 320 ||
        dimensions.some((n) => !Number.isInteger(n) || n < 1 || n > 15) ||
        dimensions.some((n) => n % 2 === 0)) {
      reply('Use Builders digout <Y> <odd-width>x<odd-height>x<odd-depth> (each dimension 1–15).');
      return;
    }
    if (configuredBots.every((name) => name.toLowerCase() === bot.username.toLowerCase())) {
      reply('Digout needs at least one other configured bot to accept the teleport and mine.');
      return;
    }
    void runDigoutDigger(targetY, dimensions);
    return;
  }
  if (lower === 'schem list') {
    const names = getSchematics();
    reply(names.length ? `Schematics: ${names.join(', ')}` : 'No schematics found in Input/. Add a .litematic, .schem, or .schematic file.');
    return;
  }
  const setMatch = command.match(/^schem\s+set\s+(.+)$/i);
  if (setMatch) {
    const found = getSchematics().find((name) => name.toLowerCase() === setMatch[1].trim().toLowerCase());
    if (!found) { reply(`Schematic not found: ${setMatch[1].trim()}. Use Builders schem list.`); return; }
    state.schematic = found;
    reply(`Selected schematic: ${found}`);
    return;
  }
  const coordMatch = command.match(/^coords\s+(set1|set2)\s+(.+)$/i);
  if (coordMatch) {
    const coords = parseCoordinates(coordMatch[2]);
    if (!coords) { reply('Use coordinates as: Builders coords set1 <x y z>'); return; }
    state[coordMatch[1].toLowerCase() === 'set1' ? 'pos1' : 'pos2'] = coords;
    reply(`${coordMatch[1]} set to ${coords.x} ${coords.y} ${coords.z}`);
    return;
  }
  if (lower === 'material list') { await reportMaterials(); return; }
  const holderMatch = command.match(/^holder\s+(.+)$/i);
  if (holderMatch) {
    const names = holderMatch[1].split(/[ ,]+/).filter(Boolean);
    if (names.some((name) => !/^[a-z0-9_]{1,16}$/i.test(name))) {
      reply('Use bot usernames only: Builders holder BotOne BotTwo');
      return;
    }
    await showInventory(names);
    return;
  }
  if (lower === 'build schem') {
    reply('Build execution is not enabled yet. Material checks and safe placement must be implemented first.');
    return;
  }
  if (lower.startsWith('say ')) {
    const text = command.slice(4).trim();
    if (text) bot.chat(text.slice(0, 240));
    return;
  }
  reply('Unknown command. Use Builders help.');
}

bot.on('chat', (username, message) => {
  dispatchChatCommand(username, message, 'chat');
});

// Disguised/system messages need a tested parser before they can be trusted.
