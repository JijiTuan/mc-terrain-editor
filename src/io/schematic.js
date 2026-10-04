/**
 * schematic.js — Minecraft schematic 导入 / 导出
 *
 * 覆盖三种格式：
 *   1. Sponge Schematic v2/v3（.schem，现代 WorldEdit / Litematica 使用，方块用 palette 索引）
 *   2. WorldEdit Classic（.schematic，老版本，方块用数字 id + data）
 *   3. Litematica（.litematic，分区域 + 位数组打包）
 *
 * 内部统一转成编辑器的 VoxelWorld。方块名映射走名表：
 * 能对上的直接映射，对不上的按「最接近的近似方块」降级，并在导入报告里列出。
 */

import { VoxelWorld } from '../core/voxel-world.js'
import { BLOCK_BY_NAME, BLOCK_BY_ID } from '../data/blocks.js'
import { parseCompressedNbt, NbtWriter, gzipBytes } from './nbt.js'

/**
 * Minecraft 方块名 → 编辑器方块名 的近似映射。
 * 只写「语义不同但外观可替代」的；同名的不需要列。
 */
const APPROX = {
  grass: 'grass_block', grass_path: 'dirt', dirt_path: 'dirt', farmland: 'dirt',
  podzol: 'dirt', coarse_dirt: 'dirt', rooted_dirt: 'dirt', mycelium: 'dirt',
  mud: 'dirt', mud_bricks: 'bricks', packed_mud: 'dirt',
  stone_slab: 'stone', smooth_stone: 'stone', stone_stairs: 'stone',
  cobblestone_wall: 'cobblestone', mossy_stone_bricks: 'mossy_cobblestone',
  deepslate_bricks: 'deepslate', cobbled_deepslate: 'deepslate',
  polished_deepslate: 'deepslate', deepslate_tiles: 'deepslate',
  sand_variants: 'sand', smooth_sandstone: 'sandstone', cut_sandstone: 'sandstone',
  red_sandstone: 'sandstone', chiseled_sandstone: 'sandstone',
  oak_wood: 'oak_log', oak_planks_variant: 'oak_planks',
  stripped_oak_log: 'oak_log', stripped_spruce_log: 'spruce_log',
  stripped_birch_log: 'birch_log',
  wood_planks: 'oak_planks', planks: 'oak_planks',
  leaves: 'oak_leaves', jungle_leaves: 'oak_leaves', acacia_leaves: 'oak_leaves',
  dark_oak_leaves: 'oak_leaves', mangrove_leaves: 'oak_leaves',
  snow: 'snow_block', snow_layer: 'snow_block', powder_snow: 'snow_block',
  water_flowing: 'water', lava_flowing: 'lava',
  flowing_water: 'water', flowing_lava: 'lava',
  brick_block: 'bricks', brick: 'bricks',
  glass_pane: 'glass', tinted_glass: 'black_concrete',
  white_wool: 'white_concrete', light_gray_wool: 'gray_concrete',
  gray_wool: 'gray_concrete', black_wool: 'black_concrete',
  red_wool: 'red_concrete', blue_wool: 'blue_concrete',
  yellow_wool: 'yellow_concrete', lime_wool: 'green_concrete',
  green_wool: 'green_concrete',
  white_terracotta: 'white_concrete', orange_terracotta: 'terracotta',
  iron_block: 'iron_ore', gold_block: 'gold_ore',
  diamond_block: 'diamond_ore', coal_block: 'coal_ore',
  redstone_block: 'redstone_ore', lapis_block: 'blue_concrete',
  cobblestone_stairs: 'cobblestone', gravel_variant: 'gravel',
  clay_ball: 'clay', bricks_variant: 'bricks',
  cave_air: 'air', void_air: 'air', structure_void: 'air',
  moving_piston: 'stone', piston: 'stone', piston_head: 'stone',
  crafting_table: 'oak_planks', chest: 'oak_planks', barrel: 'oak_planks',
  bookshelf: 'oak_planks', jukebox: 'oak_planks', note_block: 'oak_planks',
  ladder: 'oak_planks', torch: 'glowstone', wall_torch: 'glowstone',
  lantern: 'sea_lantern', soul_lantern: 'glowstone',
  sea_lantern_variant: 'sea_lantern', shroomlight: 'glowstone',
  grass_block_snow: 'grass_block',
}

/** 一次导入的结果报告 */
export function makeReport() {
  return {
    format: null,
    size: { w: 0, h: 0, d: 0 },
    totalBlocks: 0,
    skippedAir: 0,
    palette: [],
    approxBlocks: [],   // 被近似替代的方块名
    unknownBlocks: [],  // 完全无法识别、已丢弃或降级为石头的方块
    unsupported: [],    // 该格式中编辑器暂不支持的结构（如实体、方块实体）
  }
}

/** 去掉命名空间与 blockstate 属性： "minecraft:oak_stairs[facing=east]" → "oak_stairs" */
function normalizeBlockName(raw) {
  if (raw == null) return 'air'
  let s = String(raw).trim()
  const bracket = s.indexOf('[')
  if (bracket >= 0) s = s.slice(0, bracket)
  s = s.replace(/^minecraft:/i, '').replace(/^[a-z_]+:/i, '')
  return s.toLowerCase()
}

/**
 * 把 Minecraft 方块名映射到编辑器方块，并记录近似情况。
 *
 * 导出是为了让 anvil.js（存档读写）复用同一套映射 —— 两边各写一份的话，
 * 同一块「oak_stairs」在导入 .schem 和导入存档时会得到不同结果，
 * 用户完全无从判断哪个才对。
 *
 * @returns {number} 方块 id（0 = 空气）
 */
export function mapBlockName(mcName, report) {
  const name = normalizeBlockName(mcName)
  if (!name || name === 'air') return 0

  if (BLOCK_BY_NAME.has(name)) return BLOCK_BY_NAME.get(name).id

  const approx = APPROX[name]
  if (approx && BLOCK_BY_NAME.has(approx)) {
    if (!report.approxBlocks.includes(name)) report.approxBlocks.push(name)
    return BLOCK_BY_NAME.get(approx).id
  }

  // 后缀启发式：矿物、混凝土、木板的变体大多能靠关键词归类
  const guess = guessByKeyword(name)
  if (guess && BLOCK_BY_NAME.has(guess)) {
    if (!report.approxBlocks.includes(name)) report.approxBlocks.push(name)
    return BLOCK_BY_NAME.get(guess).id
  }

  if (!report.unknownBlocks.includes(name)) report.unknownBlocks.push(name)
  return 0
}

const KEYWORD_RULES = [
  [/leaves|sapling|vine|moss/i, 'oak_leaves'],
  [/log|wood|stem/i, 'oak_log'],
  [/plank/i, 'oak_planks'],
  [/glass/i, 'glass'],
  [/wool|carpet/i, 'white_concrete'],
  [/concrete/i, 'white_concrete'],
  [/terracotta/i, 'terracotta'],
  [/sandstone/i, 'sandstone'],
  [/sand/i, 'sand'],
  [/brick/i, 'bricks'],
  [/deepslate|blackstone|basalt/i, 'deepslate'],
  [/netherrack|crimson|warped/i, 'netherrack'],
  [/ore/i, 'stone'],
  [/water/i, 'water'],
  [/lava|magma|fire/i, 'lava'],
  [/snow|powder/i, 'snow_block'],
  [/ice/i, 'ice'],
  [/obsidian/i, 'obsidian'],
  [/bedrock/i, 'bedrock'],
  [/dirt|soil|mud|farmland|path/i, 'dirt'],
  [/grass|fern|flower|petal/i, 'grass_block'],
  [/stone|rock|cobble|andesite|diorite|granite|tuff|calcite/i, 'stone'],
  [/coral|prismarine|kelp|seagrass/i, 'stone'],
  [/rail|iron|copper/i, 'stone'],
  [/glow|lantern|torch|lamp|light/i, 'glowstone'],
]

function guessByKeyword(name) {
  for (const [re, target] of KEYWORD_RULES) {
    if (re.test(name)) return target
  }
  return null
}

// ---------------- 格式识别 ----------------

export function detectFormat(root, fileName = '') {
  const name = fileName.toLowerCase()

  // Litematica
  if (root.Regions && root.Metadata) return 'litematic'

  // ---- Sponge ----
  // v2 与 v3 都可能是「根级 Palette + Blocks.Data」，光看有没有 Blocks.Data 区分不开。
  // 真正的判别依据是 Version 字段：
  //   v3 → Version >= 3，方块数据走 varint 编码，Palette 在根级
  //   v2 → Version <= 2，方块数据是定长字节，Palette 在 Blocks.Palette
  // 优先信 Version，缺失时才退回结构猜测。
  const hasPalette = Boolean(root.Palette || root.Blocks?.Palette)
  if (hasPalette) {
    const ver = Number(root.Version ?? root.SchematicVersion ?? 0)
    if (Number.isFinite(ver) && ver >= 3) return 'sponge-v3'
    if (Number.isFinite(ver) && ver > 0 && ver < 3) return 'sponge-v2'
    // 没有 Version：v3 的 Blocks 是 Compound 且带 Container/Data，v2 是根级 Palette
    if (root.Blocks?.Container !== undefined) return 'sponge-v3'
    return 'sponge-v2'
  }

  // 包了一层 Schematic 的（v2 也有这种写法）
  if (root.Schematic) {
    const ver = Number(root.Schematic.Version ?? 0)
    return ver >= 3 ? 'sponge-v3' : 'sponge-v2'
  }

  // ---- WorldEdit Classic ----
  // 特征：Blocks 是变长编码字节数组（这里是 Uint8Array 或 base64 字符串），且没有 Palette。
  // 必须放在 Sponge 判定之后 —— v2 同样有 Width/Height/Length，
  // 先判 we-classic 会把 v2 误吞掉，导致 Palette 索引被当成旧版数字 id 解析。
  if (root.Blocks !== undefined && root.Width !== undefined) {
    if (typeof root.Blocks === 'string') return 'we-classic'
    if (root.Blocks instanceof Uint8Array) return 'we-classic'
  }
  if (root.Width !== undefined && root.Height !== undefined && root.Length !== undefined) {
    return 'we-classic'
  }

  if (name.endsWith('.litematic')) return 'litematic'
  if (name.endsWith('.schem')) return 'sponge-v2'
  throw new Error('无法识别的 schematic 格式：缺少 Palette/Blocks/Width 等特征字段')
}

// ---------------- 导入 ----------------

/**
 * 解析 schematic 文件为 VoxelWorld。
 * @param {ArrayBuffer} buffer
 * @param {string} fileName 用于格式识别的兜底
 * @param {{maxSize?:number}} opts
 * @returns {{world: VoxelWorld, report: object}}
 */
export async function importSchematic(buffer, fileName = '', opts = {}) {
  const maxSize = opts.maxSize ?? 256
  const { rootName, root } = await parseCompressedNbt(buffer)

  // Sponge v3 把内容包在根节点里
  const effective = root.Schematic ?? root
  const format = detectFormat(effective, fileName)

  const report = makeReport()
  report.format = format

  let world
  switch (format) {
    case 'sponge-v2':
    case 'sponge-v3':
      world = importSponge(effective, format, report, maxSize)
      break
    case 'we-classic':
      world = importWorldEditClassic(effective, report, maxSize)
      break
    case 'litematic':
      world = importLitematic(effective, report, maxSize)
      break
    default:
      throw new Error(`暂不支持的格式：${format}`)
  }

  report.size = { w: world.width, h: world.height, d: world.depth }
  let solid = 0
  for (let i = 0; i < world.size; i++) if (world.data[i] !== 0) solid++
  report.totalBlocks = solid
  return { world, report, rootName }
}

/** Sponge Schematic v2 / v3 */
function importSponge(root, format, report, maxSize) {
  const w = Number(root.Width ?? root.Size?.[0] ?? 0)
  const h = Number(root.Height ?? root.Size?.[1] ?? 0)
  const d = Number(root.Length ?? root.Size?.[2] ?? 0)
  if (!w || !h || !d) throw new Error('schematic 缺少尺寸信息（Width/Height/Length）')
  if (w > maxSize || h > maxSize || d > maxSize) {
    throw new Error(`schematic 尺寸 ${w}×${h}×${d} 超过编辑器上限 ${maxSize}，请先裁剪`)
  }

  // v3: 根级 Palette；v2: Blocks.Palette
  const paletteMap = root.Palette ?? root.Blocks?.Palette ?? {}
  const blockDataRaw =
    format === 'sponge-v3'
      ? (root.Blocks?.Data ?? root.Blocks?.Container ?? root.Blocks)
      : (root.Blocks?.Data ?? root.BlockData)

  if (!blockDataRaw) throw new Error('schematic 缺少方块数据（Blocks.Data）')

  // Palette: {"minecraft:stone": 0, ...} → id 数组
  const palette = []
  for (const [name, idx] of Object.entries(paletteMap)) {
    palette[Number(idx)] = name
  }
  report.palette = palette.filter(Boolean)

  const data = toByteArray(blockDataRaw)
  const total = w * h * d
  if (data.length < total) {
    throw new Error(`方块数据长度 ${data.length} 小于预期 ${total}，文件可能损坏`)
  }

  const world = new VoxelWorld(w, h, d)
  // Sponge 的 Y Z X 顺序：index = (y * length + z) * width + x
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const p = (y * d + z) * w + x
        const nameIdx = data[p]
        const name = palette[nameIdx]
        world.data[(y * d + z) * w + x] = mapBlockName(name, report)
      }
    }
  }
  world.revision++
  collectExtras(root, report)
  return world
}

/** WorldEdit Classic：数字 id + data，Blocks 是变长编码的字节数组 */
function importWorldEditClassic(root, report, maxSize) {
  const w = Number(root.Width)
  const h = Number(root.Height)
  const d = Number(root.Length)
  if (!w || !h || !d) throw new Error('经典 schematic 缺少尺寸信息')
  if (w > maxSize || h > maxSize || d > maxSize) {
    throw new Error(`schematic 尺寸 ${w}×${h}×${d} 超过编辑器上限 ${maxSize}，请先裁剪`)
  }

  const addBlocks = root.AddBlocks ? toByteArray(root.AddBlocks) : null
  let indices = null

  if (typeof root.Blocks === 'string') {
    // 部分工具把 Blocks 存成 latin1 字符串
    const bytes = new Uint8Array(root.Blocks.length)
    for (let i = 0; i < root.Blocks.length; i++) bytes[i] = root.Blocks.charCodeAt(i) & 0xff
    indices = decodeVarIntArray(bytes, w * h * d)
  } else {
    indices = decodeVarIntArray(toByteArray(root.Blocks), w * h * d)
  }

  const world = new VoxelWorld(w, h, d)
  const topIds = new Uint8Array(w * h * d)
  for (let i = 0; i < topIds.length && i < indices.length; i++) {
    topIds[i] = indices[i] & 0xff
    if (addBlocks && i < addBlocks.length) {
      topIds[i] |= (i % 2 === 0 ? addBlocks[i >> 1] & 0x0f : (addBlocks[i >> 1] >> 4) & 0x0f) << 8
    }
  }

  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const p = (y * d + z) * w + x
        const legacyId = topIds[p]
        world.data[p] = legacyIdToEditor(legacyId, report)
      }
    }
  }
  world.revision++
  return world
}

/** 经典数字 id → 编辑器方块。只覆盖最常见的，其余归为石头。 */
const LEGACY_ID_MAP = {
  0: 0, 1: 1, 2: 4, 3: 3, 4: 2, 5: 29, 7: 16, 8: 25, 9: 25, 10: 26, 11: 26,
  12: 5, 13: 8, 14: 8, 15: 51, 16: 46, 17: 28, 18: 34, 20: 38, 21: 48, 22: 47,
  24: 12, 35: 40, 41: 49, 42: 39, 43: 1, 44: 1, 45: 35, 48: 1, 49: 15,
  54: 29, 56: 49, 57: 52, 73: 51, 79: 9, 80: 9, 82: 8, 87: 23, 89: 53,
  98: 38, 121: 19, 129: 54, 133: 54, 152: 43, 155: 51, 159: 13, 160: 43,
  162: 27, 168: 55, 172: 13, 179: 5, 251: 41, 252: 42,
}

function legacyIdToEditor(id, report) {
  if (id === 0) return 0
  const mapped = LEGACY_ID_MAP[id]
  if (mapped !== undefined) return mapped
  if (!report.unknownBlocks.includes(`legacy:${id}`)) report.unknownBlocks.push(`legacy:${id}`)
  return 1
}

/** Litematica：多区域 + 位数组打包 */
function importLitematic(root, report, maxSize) {
  const regions = root.Regions
  const names = Object.keys(regions || {})
  if (!names.length) throw new Error('litematic 不含任何区域')

  let totalW = 0, totalH = 0, totalD = 0
  const parsed = []

  for (const name of names) {
    const r = regions[name]
    const size = r.Size
    const w = Math.abs(Number(size?.x ?? 0))
    const h = Math.abs(Number(size?.y ?? 0))
    const d = Math.abs(Number(size?.z ?? 0))
    if (!w || !h || !d) continue
    const paletteNames = Array.isArray(r.BlockStatePalette) ? r.BlockStatePalette : []
    const packed = r.BlockStates
    parsed.push({ name, w, h, d, paletteNames, packed, pos: r.Position })
    totalW = Math.max(totalW, w)
    totalH = Math.max(totalH, h)
    totalD = Math.max(totalD, d)
  }

  if (!parsed.length) throw new Error('litematic 区域尺寸非法')
  if (totalW > maxSize || totalH > maxSize || totalD > maxSize) {
    throw new Error(`litematic 尺寸 ${totalW}×${totalH}×${totalD} 超过编辑器上限 ${maxSize}`)
  }

  const world = new VoxelWorld(totalW, totalH, totalD)
  report.unsupported.push('litematic 的多区域偏移已忽略，仅按各自局部坐标叠加')

  for (const reg of parsed) {
    const bits = Math.max(2, bitsNeeded(reg.paletteNames.length))
    const perLong = Math.floor(64 / bits)
    const totalCells = reg.w * reg.h * reg.d
    const longs = reg.packed
    if (!longs || longs.length * perLong < totalCells) {
      report.unsupported.push(`区域 ${reg.name} 的 BlockStates 数据不完整，已跳过`)
      continue
    }
    for (let y = 0; y < reg.h; y++) {
      for (let z = 0; z < reg.d; z++) {
        for (let x = 0; x < reg.w; x++) {
          // litematic 顺序：index = (y * d + z) * w + x
          const idx = (y * reg.d + z) * reg.w + x
          const longIdx = Math.floor(idx / perLong)
          const offset = BigInt((idx % perLong) * bits)
          const mask = (1n << BigInt(bits)) - 1n
          const value = Number((BigInt.asUintN(64, BigInt(longs[longIdx] ?? 0n)) >> offset) & mask)
          const nameRef = reg.paletteNames[value]
          const blockName = typeof nameRef === 'string' ? nameRef : nameRef?.Name
          const id = mapBlockName(blockName, report)
          if (id !== 0) world.set(x, y, z, id)
        }
      }
    }
  }
  world.revision++
  return world
}

function bitsNeeded(n) {
  let b = 1
  while ((1 << b) < n) b++
  return b
}

function toByteArray(v) {
  if (v instanceof Uint8Array) return v
  if (v instanceof Int8Array) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  if (Array.isArray(v)) return new Uint8Array(v)
  if (v && typeof v === 'object' && v.length !== undefined) return new Uint8Array(v)
  throw new Error('无法转换的方块数据格式')
}

/** WorldEdit 的 Blocks 使用 VarInt 变长编码 */
function decodeVarIntArray(bytes, expected) {
  const out = new Int32Array(expected)
  let p = 0, i = 0
  while (p < bytes.length && i < expected) {
    let value = 0, shift = 0, byte
    do {
      byte = bytes[p++]
      value |= (byte & 0x7f) << shift
      shift += 7
    } while (byte & 0x80 && p < bytes.length && shift < 35)
    out[i++] = value
  }
  return out
}

/** 收集该 schematic 中编辑器不支持、需要提示用户的内容 */
function collectExtras(root, report) {
  const has = (k) => {
    const v = root[k]
    return v && (Array.isArray(v) ? v.length > 0 : true)
  }
  if (has('Entities') || has('EntitiesData')) report.unsupported.push('实体数据（Entities）')
  if (has('BlockEntities') || has('BlockEntitiesData')) report.unsupported.push('方块实体数据（箱子内容物等）')
  if (root.Biomes) report.unsupported.push('生物群系数据（Biomes）')
}

// ---------------- 导出 ----------------

/**
 * 导出为 Sponge Schematic v3（.schem，gzip 压缩）。
 * 使用编辑器的方块名作为 palette key，加 minecraft: 前缀以便 WorldEdit 识别。
 */
export async function exportSchematic(world, name = 'terrain') {
  const bytes = world.data
  const paletteIndex = new Map()
  const paletteEntries = []
  const indices = new Uint8Array(bytes.length)

  // palette[0] 固定为空气，符合惯例
  paletteIndex.set('minecraft:air', 0)
  paletteEntries.push('minecraft:air')

  for (let i = 0; i < bytes.length; i++) {
    const id = bytes[i]
    const key = id === 0 ? 'minecraft:air' : toMinecraftName(id)
    if (!paletteIndex.has(key)) {
      paletteIndex.set(key, paletteEntries.length)
      paletteEntries.push(key)
    }
    indices[i] = paletteIndex.get(key)
  }

  if (paletteEntries.length > 256) {
    throw new Error(`调色板数量 ${paletteEntries.length} 超过导出上限 256`)
  }

  const writer = new NbtWriter()
  // 根节点
  writer.u8(10) // Compound
  writer.string('Schematic')
  // ---- 子字段 ----
  writeInt(writer, 'Version', 3)
  writeInt(writer, 'DataVersion', 3700)
  writeShort(writer, 'Width', world.width)
  writeShort(writer, 'Height', world.height)
  writeShort(writer, 'Length', world.depth)
  writeIntArray(writer, 'Offset', [0, 0, 0])

  // Metadata
  writer.u8(10); writer.string('Metadata')
  writer.u8(8); writer.string('Name'); writer.string(name)
  writer.u8(8); writer.string('Author'); writer.string('MC Terrain Editor')
  writeLong(writer, 'CreatedAt', BigInt(Date.now()))
  writer.u8(0)

  // Palette（v3 在根级）
  writer.u8(10); writer.string('Palette')
  for (let i = 0; i < paletteEntries.length; i++) {
    writer.u8(3); writer.string(paletteEntries[i]); writer.i32(i)
  }
  writer.u8(0)

  // Blocks: { Data, Palette }
  writer.u8(10); writer.string('Blocks')
  writer.u8(7); writer.string('Data'); writer.byteArray(indices)
  writer.u8(10); writer.string('Palette')
  for (let i = 0; i < paletteEntries.length; i++) {
    writer.u8(3); writer.string(paletteEntries[i]); writer.i32(i)
  }
  writer.u8(0)
  writer.u8(0) // Blocks End

  writer.u8(0) // root End

  const raw = writer.toBytes()
  return gzipBytes(raw)
}

function writeInt(w, name, v) { w.u8(3); w.string(name); w.i32(v) }
function writeShort(w, name, v) { w.u8(2); w.string(name); w.i16(v) }
function writeLong(w, name, v) { w.u8(4); w.string(name); const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), false); w.push(b) }
function writeIntArray(w, name, arr) { w.u8(11); w.string(name); w.intArray(arr) }

/** 编辑器方块 id → minecraft 方块名（导出用） */
function toMinecraftName(id) {
  const def = BLOCK_BY_ID[id]
  return `minecraft:${def?.name ?? 'stone'}`
}

/** 导出为编辑器原生格式（JSON，含 RLE，体积小、无损、可再导入） */
export function exportNative(world, meta = {}) {
  return {
    format: 'mc-terrain-editor',
    version: 1,
    meta: { name: meta.name ?? '未命名工程', exportedAt: new Date().toISOString(), ...meta },
    world: world.toJSON(),
  }
}

export function importNative(obj) {
  if (!obj || obj.format !== 'mc-terrain-editor') throw new Error('不是本编辑器导出的工程文件')
  return VoxelWorld.fromJSON(obj.world)
}

// ---------------- 区块导入导出 ----------------

/**
 * 把一个编辑器的 X/Z 区块切成可独立保存的「区块工程」。
 * 之所以只切 X/Z：Minecraft 的区块概念就是 16×世界高×16 的竖直柱，
 * 保持这个语义，导出的区块才能直接对应到游戏里的一个 chunk。
 */
export function sliceIntoChunks(world, chunkSize = 16) {
  const chunks = []
  for (let cz = 0; cz < world.depth; cz += chunkSize) {
    for (let cx = 0; cx < world.width; cx += chunkSize) {
      const w = Math.min(chunkSize, world.width - cx)
      const d = Math.min(chunkSize, world.depth - cz)
      const buf = new Uint8Array(w * world.height * d)
      let p = 0
      for (let y = 0; y < world.height; y++) {
        for (let z = 0; z < d; z++) {
          for (let x = 0; x < w; x++) {
            buf[p++] = world.get(cx + x, y, cz + z)
          }
        }
      }
      chunks.push({
        chunkX: cx / chunkSize,
        chunkZ: cz / chunkSize,
        originX: cx,
        originZ: cz,
        width: w,
        height: world.height,
        depth: d,
        // 只保留有内容的区块，空区块不占空间
        empty: buf.every((v) => v === 0),
        world: new VoxelWorld(w, world.height, d, buf),
      })
    }
  }
  return chunks
}

/** 把一批区块粘合成一个世界 */
export function mergeChunks(chunks, { width, height, depth }) {
  const world = new VoxelWorld(width, height, depth)
  for (const c of chunks) {
    const src = c.world ?? VoxelWorld.fromJSON(c.worldData)
    for (let y = 0; y < src.height; y++) {
      for (let z = 0; z < src.depth; z++) {
        for (let x = 0; x < src.width; x++) {
          const v = src.get(x, y, z)
          if (v !== 0) world.set(c.originX + x, y, c.originZ + z, v)
        }
      }
    }
  }
  return world
}
