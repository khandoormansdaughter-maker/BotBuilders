const fs = require('node:fs/promises');
const nbt = require('prismarine-nbt');

function valueOf(tag) {
  return tag && typeof tag === 'object' && Object.hasOwn(tag, 'value')
    ? tag.value
    : tag;
}

function child(compound, key) {
  return valueOf(compound?.[key]);
}

function numberValue(tag) {
  const value = valueOf(tag);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid or unsafe integer in schematic.');
  return number;
}

function asUnsignedBigInt(value) {
  if (typeof value === 'bigint') return BigInt.asUintN(64, value);
  if (typeof value === 'number') return BigInt.asUintN(64, BigInt(value));
  if (value && typeof value.toString === 'function') {
    return BigInt.asUintN(64, BigInt(value.toString()));
  }
  throw new Error('Unsupported BlockStates long-array value.');
}

function readPaletteEntry(entry) {
  const name = child(entry, 'Name');
  if (typeof name !== 'string' || !name.includes(':')) {
    throw new Error('Schematic contains an invalid block palette entry.');
  }
  return name;
}

function countRegion(region) {
  const size = child(region, 'Size');
  const x = Math.abs(numberValue(size?.x));
  const y = Math.abs(numberValue(size?.y));
  const z = Math.abs(numberValue(size?.z));
  const total = x * y * z;
  if (![x, y, z].every(Number.isSafeInteger) || !Number.isSafeInteger(total) || total < 1) {
    throw new Error('Schematic region has invalid dimensions.');
  }

  const paletteTag = region?.BlockStatePalette;
  const palette = valueOf(paletteTag);
  const packedTag = region?.BlockStates;
  const packed = valueOf(packedTag);
  if (!Array.isArray(palette) || palette.length === 0 || !Array.isArray(packed)) {
    throw new Error('Schematic region is missing its block palette or BlockStates data.');
  }

  const names = palette.map(readPaletteEntry);
  const bits = Math.max(2, Math.ceil(Math.log2(names.length)));
  const valuesPerLong = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  const expectedLongs = Math.ceil(total / valuesPerLong);
  if (packed.length < expectedLongs) {
    throw new Error('Schematic BlockStates data is truncated.');
  }

  const counts = new Map();
  for (let index = 0; index < total; index += 1) {
    const word = asUnsignedBigInt(packed[Math.floor(index / valuesPerLong)]);
    const shift = BigInt((index % valuesPerLong) * bits);
    const paletteIndex = Number((word >> shift) & mask);
    const block = names[paletteIndex];
    if (!block) throw new Error('Schematic references a missing palette entry.');
    if (block !== 'minecraft:air' && block !== 'minecraft:cave_air' && block !== 'minecraft:void_air') {
      counts.set(block, (counts.get(block) || 0) + 1);
    }
  }
  return { total, counts };
}

async function loadLitematic(filePath) {
  const buffer = await fs.readFile(filePath);
  const result = await nbt.parse(buffer);
  const root = valueOf(result.parsed ?? result);
  const metadata = child(root, 'Metadata') || {};
  const name = child(metadata, 'Name') || filePath.split(/[\\/]/).pop();
  const regions = child(root, 'Regions');
  if (!regions || typeof regions !== 'object' || Array.isArray(regions)) {
    throw new Error('This file does not contain a valid Litematica Regions compound.');
  }

  const combined = new Map();
  const regionSummaries = [];
  for (const [regionName, region] of Object.entries(regions)) {
    if (!region || typeof region !== 'object') continue;
    const { total, counts } = countRegion(region);
    regionSummaries.push({ name: regionName, blocks: total });
    for (const [block, count] of counts) combined.set(block, (combined.get(block) || 0) + count);
  }

  if (regionSummaries.length === 0) throw new Error('No valid regions were found in the Litematica file.');
  return {
    name,
    regions: regionSummaries,
    blockCount: [...combined.values()].reduce((sum, count) => sum + count, 0),
    materials: [...combined.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([block, count]) => ({ block, count })),
  };
}

module.exports = { loadLitematic };
