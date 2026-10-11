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
const bot = mineflayer.createBot({
  host: process.env.MC_HOST,
  port,
  username: process.env.MC_USERNAME,
  version,
  // Offline-mode servers generally use username-only login. Do not assume
  // that a Minecraft account password is needed or send one in chat.
  auth: process.env.MC_AUTH || 'offline',
});

bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
  bot.pathfinder.setMovements(new Movements(bot));
  console.log(`Connected as ${bot.username}. Waiting for commander chat commands.`);
});

bot.on('kicked', (reason) => console.error('Kicked from server:', reason));
bot.on('error', (error) => console.error('Minecraft bot error:', error));
bot.on('end', () => console.log('Minecraft connection ended.'));

function reply(message) {
  // Keep responses short enough for ordinary Minecraft chat.
  bot.chat(String(message).slice(0, 240));
}

function replyLines(lines) {
  for (const line of lines) reply(line);
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

const state = {
  schematic: null,
  pos1: null,
  pos2: null,
  spareBlock: null,
};

async function reportMaterials() {
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
    const stackSlots = data.materials.reduce((sum, item) => sum + Math.ceil(item.count / 64), 0);
    const shulkers = Math.ceil(stackSlots / 27);
    const lines = [
      `Materials for ${state.schematic}: ${data.blockCount} non-air blocks.`,
      `Regions: ${data.regions.length}; rough estimate: ${stackSlots} stacks / ${shulkers} shulker boxes (64-item stacks).`,
    ];
    const entries = data.materials.map((item) => `${item.block.replace(/^minecraft:/, '')} x${item.count}`);
    for (let i = 0; i < entries.length; i += 4) {
      lines.push(entries.slice(i, i + 4).join(', '));
    }
    replyLines(lines);
  } catch (error) {
    console.error('Could not read selected Litematica file:', error);
    reply('Could not read that .litematic file. Check the file format; details are in the bot log.');
  }
}

async function handleCommand(rawMessage, username) {
  // Only the configured commander can issue actions. Match the sender field,
  // not text inside a message, to avoid impersonation via message contents.
  if (username !== process.env.COMMANDER_USERNAME) return;

  const prefix = 'Builders ';
  const message = rawMessage.trim();
  if (!message.toLowerCase().startsWith(prefix.toLowerCase())) return;

  const command = message.slice(prefix.length).trim();
  const lower = command.toLowerCase();

  if (lower === 'help') {
    reply('Commands: schem list | schem set <name> | coords set1 <x y z> | coords set2 <x y z> | material list | build schem | say <message>');
    return;
  }

  if (lower === 'schem list') {
    const names = getSchematics();
    reply(names.length ? `Schematics: ${names.join(', ')}` : 'No schematics found in Input/. Add a .litematic, .schem, or .schematic file.');
    return;
  }

  const setMatch = command.match(/^schem\s+set\s+(.+)$/i);
  if (setMatch) {
    const requested = setMatch[1].trim();
    const found = getSchematics().find((name) => name.toLowerCase() === requested.toLowerCase());
    if (!found) {
      reply(`Schematic not found: ${requested}. Use Builders schem list.`);
      return;
    }
    state.schematic = found;
    reply(`Selected schematic: ${found}`);
    return;
  }

  const coordMatch = command.match(/^coords\s+(set1|set2)\s+(.+)$/i);
  if (coordMatch) {
    const coords = parseCoordinates(coordMatch[2]);
    if (!coords) {
      reply('Use coordinates as: Builders coords set1 <x y z>');
      return;
    }
    state[coordMatch[1].toLowerCase() === 'set1' ? 'pos1' : 'pos2'] = coords;
    reply(`${coordMatch[1]} set to ${coords.x} ${coords.y} ${coords.z}`);
    return;
  }

  if (lower === 'material list') {
    await reportMaterials();
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

// Some servers expose disguised/system messages as chat events rather than
// the normal chat event. Do not parse arbitrary raw packets as commands yet:
// implement this only after validating the server's message format.
