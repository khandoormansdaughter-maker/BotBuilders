const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');
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
const inputDir = path.resolve(process.env.SCHEMATIC_DIR || 'Input');
const coordinatorUsername = process.env.BOT_COORDINATOR_USERNAME || process.env.MC_USERNAME;
const configuredBots = (process.env.BOT_GROUP || process.env.MC_USERNAME)
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
  console.log(`Connected as ${bot.username}. Coordinator: ${coordinatorUsername}. Waiting for commander chat commands.`);
});

bot.on('kicked', (reason) => console.error('Kicked from server:', reason));
bot.on('error', (error) => console.error('Minecraft bot error:', error));
bot.on('end', () => console.log('Minecraft connection ended.'));

function reply(message) {
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

const state = { schematic: null, pos1: null, pos2: null };
const pendingInventory = new Map();
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
  if (username !== process.env.COMMANDER_USERNAME) return;
  if (!message.toLowerCase().startsWith('Builders ')) return;

  const command = message.slice('Builders '.length).trim();
  const lower = command.toLowerCase();
  const isInventoryCommand = lower === 'material list' || lower.startsWith('holder ');
  if (isInventoryCommand && bot.username.toLowerCase() !== coordinatorUsername.toLowerCase()) return;

  if (lower === 'help') {
    reply('Commands: schem list | schem set <name> | coords set1/set2 <x y z> | material list | holder <bot...> | build schem | say <message>');
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
    if (text) reply(text);
    return;
  }
  reply('Unknown command. Use Builders help.');
}

bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  void handleCommand(message, username).catch((error) => {
    console.error('Command handler error:', error);
    reply('Command failed; check the bot log for details.');
  });
});

// Disguised/system messages need a tested parser before they can be trusted.
