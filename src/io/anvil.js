/**
 * anvil.js — Minecraft Java 版存档（Anvil 格式）读写
 *
 * ── 这个文件解决的问题 ──
 * 之前只能通过 .schem 结构文件跟游戏交换地形，用户得自己在游戏里用 WorldEdit
 * 粘贴。现在可以直接打开 .minecraft/saves/<世界名>/ 读写真实存档。
 *
 * ── Anvil 格式速览 ──
 *
 *   <世界名>/
 *     level.dat                       gzip 压缩的 NBT：世界种子、版本、游戏规则等
 *     region/
 *       r.<rx>.<rz>.mca               区域文件，每个覆盖 32×32 个 chunk
 *     entities/  poi/  DIM-1/  DIM1/   其他维度
 *
 * 一个 region 文件（.mca）的结构：
 *
 *   [0x0000, 4096)   位置表：每 chunk 4 字节，3 字节大端偏移（单位 4096 字节）+ 1 字节扇区数
 *   [0x1000, 8192)   时间戳表：每 chunk 4 字节，chunk 最后修改时间（秒）
 *   [0x2000, ...)    数据扇区，每个 chunk 一份
 *
 * 每个 chunk 数据 = 4 字节大端长度 + 1 字节压缩类型 + 压缩后的 NBT
 *   压缩类型：1 = gzip，2 = zlib(deflate)，3 = 无压缩（1.20.2+ 少见）
 *   ⚠️ 现代版本**几乎全是 zlib(2)**，不是 gzip —— 这是最容易踩的坑，
 *      按 gzip 去解会得到「invalid header」。
 *
 * ── chunk NBT 里的方块数据（1.18+ 才是这样）──
 *
 *   sections: [ { Y: byte, block_states: { palette: [ {Name:"minecraft:stone"} ... ],
 *                                          data: [LongArray]  ← 可选，全单一方块时省略
 *                }, biomes: {...} } ... ]
 *
 *   `data` 是**打包过的位数组**：每个方块索引占 `ceil(log2(palette.length))` 位
 *   （最少 4 位），跨 long 边界**不拆分**（每个 long 从低位往高位填，
 *   装不下就换下一个 long）。所以第 i 个方块的位偏移不是简单的 i*bits。
 *
 * ── 为什么先只做「读取 + 写回」而不重造整个存档 ──
 * 写回时只替换我们要改的那些 chunk 的方块数据，其余 chunk 原样拷贝。
 * 这样最大程度保留存档的其余内容（实体、光照、生物群系、结构引用）。
 */

import { parseNbt, TagType, NbtWriter, gzipBytes } from './nbt.js'

/** zlib 解压（deflate 带 zlib 头）。浏览器 DecompressionStream 支持 'deflate'。 */
export async function zlibInflate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 zlib 解压（需要 DecompressionStream）')
  }
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([b]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** zlib 压缩（带 zlib 头的 deflate） */
export async function zlibDeflate(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 zlib 压缩（需要 CompressionStream）')
  }
  const cs = new CompressionStream('deflate')
  const stream = new Blob([b]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** gzip 解压，用于 level.dat */
async function gunzip(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (b[0] !== 0x1f || b[1] !== 0x8b) return b
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([b]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// ────────────────────────── region 文件解析 ──────────────────────────

const SECTOR = 4096

/**
 * 解析一个 .mca 文件，返回该 region 里所有 chunk 的原始条目。
 *
 * 只做「切分」，不解压 —— 解压很贵，调用方通常只想读其中几个 chunk，
 * 全解一遍会白烧几十毫秒 × 1024 个 chunk。
 *
 * @returns {Array<{cx:number, cz:number, offset:number, sectors:number, timestamp:number,
 *                  raw: Uint8Array|null, compression:number}>}
 */
export function parseRegion(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < SECTOR * 2) throw new Error('region 文件太小，不是合法的 .mca')

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = []

  for (let i = 0; i < 1024; i++) {
    const p = i * 4
    // 3 字节大端偏移 + 1 字节扇区数
    const off = (view.getUint8(p) << 16) | (view.getUint8(p + 1) << 8) | view.getUint8(p + 2)
    const sectors = view.getUint8(p + 3)
    if (off === 0 || sectors === 0) continue // 该 chunk 不存在

    const cx = i & 31
    const cz = i >> 5
    const start = off * SECTOR

    if (start + 5 > bytes.length) continue // 越界，损坏条目，跳过而不是炸掉

    const length = view.getInt32(start, false)
    const compression = view.getUint8(start + 4)
    if (length <= 1 || start + 4 + length > bytes.length) continue

    out.push({
      cx, cz,
      offset: off,
      sectors,
      timestamp: view.getInt32(SECTOR + i * 4, false),
      compression,
      // 只切出压缩后的载荷，不含那 5 字节头长度前缀
      raw: bytes.subarray(start + 5, start + 4 + length),
    })
  }
  return out
}

/** 按压缩类型解出 chunk 的 NBT */
export async function readChunkNbt(entry) {
  if (!entry.raw) throw new Error(`chunk (${entry.cx},${entry.cz}) 没有数据`)
  let plain
  if (entry.compression === 1) plain = await gunzip(entry.raw)
  else if (entry.compression === 2) plain = await zlibInflate(entry.raw)
  else if (entry.compression === 3) plain = entry.raw
  else throw new Error(`未知的 chunk 压缩类型：${entry.compression}`)
  return parseNbt(plain)
}

// ────────────────────────── 打包位数组（Paletted Container）──────────────────────────

/** 每个索引占多少位：至少 4 位，其余按调色板大小取对数上取整 */
export function bitsForPalette(size) {
  return Math.max(4, Math.ceil(Math.log2(Math.max(2, size))))
}

/**
 * 解包方块位数组。
 *
 * 关键细节：**一个方块索引不能跨 long 边界**。
 * 4096 个方块、bits=5 时，每个 long(64 位) 只装得下 12 个（60 位），
 * 剩下 4 位浪费掉。所以位置要按「每 long 装多少个」来算，不是简单 i*bits。
 *
 * 天真的实现 `bitIndex = i * bits` 在 bits 不是 64 的约数时是**错的**，
 * 而且错得很隐蔽 —— 前半段能读出正确数据，越往后越乱。
 */
export function unpackBlockStates(dataLongs, count, bits) {
  const out = new Uint16Array(count)
  if (!dataLongs || dataLongs.length === 0) {
    out.fill(0)
    return out
  }
  const perLong = Math.floor(64 / bits)
  const mask = (1n << BigInt(bits)) - 1n
  for (let i = 0; i < count; i++) {
    const longIdx = Math.floor(i / perLong)
    if (longIdx >= dataLongs.length) break
    const withinLong = i % perLong
    const shift = BigInt(withinLong * bits)
    const v = (dataLongs[longIdx] >> shift) & mask
    out[i] = Number(v)
  }
  return out
}

/**
 * 打包方块索引成位数组（unpack 的逆运算）。
 * 同样遵守「不跨 long 边界」的规则，否则游戏读出来会是乱码。
 */
export function packBlockStates(indices, bits) {
  const perLong = Math.floor(64 / bits)
  const longCount = Math.ceil(indices.length / perLong)
  const out = new BigInt64Array(longCount)
  const mask = (1n << BigInt(bits)) - 1n
  for (let i = 0; i < indices.length; i++) {
    const longIdx = Math.floor(i / perLong)
    const withinLong = i % perLong
    const shift = BigInt(withinLong * bits)
    out[longIdx] |= (BigInt(indices[i]) & mask) << shift
  }
  return out
}

/**
 * 从 section 的 block_states 解出 4096 个调色板索引（YZX 顺序，与原版一致）。
 * 世界里的存储是 XZY，转换在调用方做。
 */
export function readSectionIndices(blockStates) {
  const palette = blockStates?.palette ?? []
  const dataLongs = blockStates?.data
  // 调色板只有 1 项时原版会省略 data —— 整段都是那一个方块
  if (!dataLongs || dataLongs.length === 0) {
    const out = new Uint16Array(4096)
    out.fill(0)
    return { indices: out, palette, bits: 0 }
  }
  const bits = bitsForPalette(palette.length)
  return { indices: unpackBlockStates(dataLongs, 4096, bits), palette, bits }
}

/** section 内局部坐标 → 4096 数组下标。原版顺序是 y*256 + z*16 + x */
export function sectionIndex(x, y, z) {
  return (y << 8) | (z << 4) | x
}

// ────────────────────────── 存档目录级别 ──────────────────────────

/** 判断一个目录看起来是不是 MC 存档（有 level.dat 就是） */
export function looksLikeWorld(dirEntries) {
  return dirEntries.includes('level.dat')
}

/**
 * 解析 level.dat，拿出世界基本信息。
 * 1.18 之后 LevelName 在 Data 里，更老的版本在 Data.LevelName 也一样，
 * 但 1.16- 是 Data.LevelName —— 这里两种都试。
 */
export async function readLevelDat(buffer) {
  const plain = await gunzip(buffer)
  const { root } = parseNbt(plain)
  const d = root?.Data ?? root ?? {}
  return {
    levelName: d.LevelName ?? '未命名世界',
    version: d.Version ?? null,
    versionName: d.Version?.Name ?? null,
    dataVersion: d.DataVersion ?? null,
    spawn: d.SpawnX != null ? { x: d.SpawnX, y: d.SpawnY, z: d.SpawnZ } : null,
    lastPlayed: d.LastPlayed != null ? Number(d.LastPlayed) : null,
    gameType: d.GameType ?? null,
    hardcore: d.hardcore === 1 || d.Hardcore === 1,
    seed: d.WorldGenSettings?.seed ?? d.RandomSeed ?? null,
  }
}

/**
 * 把 chunk NBT 重新序列化成 region 扇区条目。
 *
 * 返回 { chunkData, sectors }：chunkData 已包含 4 字节长度 + 1 字节压缩类型，
 * 且已补齐到 4096 的整数倍，可以直接摆进 region 文件的扇区位置。
 */
export async function serializeChunkNbt(nbtBytes) {
  const deflated = await zlibDeflate(nbtBytes)
  const total = 5 + deflated.length
  const sectors = Math.ceil(total / SECTOR)
  const out = new Uint8Array(sectors * SECTOR)
  new DataView(out.buffer).setInt32(0, deflated.length + 1, false)
  out[4] = 2 // zlib
  out.set(deflated, 5)
  return { chunkData: out, sectors }
}

/**
 * 在已有的 region 文件上，替换掉若干 chunk 的数据，其余原样保留。
 *
 * 为什么要这么麻烦而不是从头写一个 region：一个 region 有 1024 个 chunk，
 * 我们只改了其中几个。从头写意味着要把没改的 1000 多个全部重新序列化，
 * 既慢又会丢掉我们没解析的字段（实体、光照、高度图…）。
 *
 * @param {Uint8Array} original      原始 .mca 内容（null 表示新建空 region）
 * @param {Map<string,{chunkData:Uint8Array,sectors:number}>} replacements  key = "cx,cz"
 * @returns {Uint8Array} 新的 .mca 内容
 */
export function writeRegion(original, replacements) {
  const entries = original ? parseRegion(original) : []
  const timestamps = new Int32Array(1024)
  if (original) {
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength)
    for (let i = 0; i < 1024; i++) timestamps[i] = view.getInt32(SECTOR + i * 4, false)
  }

  // 保留未改动的 chunk：连原始扇区字节一起搬过去（不重新压缩，省时且无损）
  const kept = []
  for (const e of entries) {
    const key = `${e.cx},${e.cz}`
    if (replacements.has(key)) continue
    const start = e.offset * SECTOR
    kept.push({
      cx: e.cx, cz: e.cz,
      bytes: original.subarray(start, start + e.sectors * SECTOR),
      sectors: e.sectors,
      timestamp: e.timestamp,
    })
  }

  const now = Math.floor(Date.now() / 1000)
  const puts = []
  for (const [key, val] of replacements) {
    const [cx, cz] = key.split(',').map(Number)
    puts.push({ cx, cz, bytes: val.chunkData, sectors: val.sectors, timestamp: now })
  }

  // 扇区分配：从第 2 扇区（0x2000）开始，按 order 顺序摆
  const all = [...kept, ...puts]
  let cursor = 2
  const header = new Uint8Array(SECTOR * 2)
  const hv = new DataView(header.buffer)

  for (const it of all) {
    const idx = ((it.cz & 31) << 5) | (it.cx & 31)
    // 偏移是 3 字节大端；最大 0xFFFFFF 扇区 = 64 GB，够用
    hv.setUint8(idx * 4, (cursor >> 16) & 0xff)
    hv.setUint8(idx * 4 + 1, (cursor >> 8) & 0xff)
    hv.setUint8(idx * 4 + 2, cursor & 0xff)
    hv.setUint8(idx * 4 + 3, it.sectors)
    hv.setInt32(SECTOR + idx * 4, it.timestamp, false)
    cursor += it.sectors
  }

  const totalSectors = Math.max(cursor, 2)
  const out = new Uint8Array(totalSectors * SECTOR)
  out.set(header, 0)
  let p = SECTOR * 2
  for (const it of all) {
    out.set(it.bytes, p)
    p += it.sectors * SECTOR
  }
  return out
}

export { SECTOR }
