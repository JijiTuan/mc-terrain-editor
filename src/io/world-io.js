/**
 * world-io.js — 把 Minecraft 存档 ↔ 编辑器世界互转
 *
 * anvil.js 负责「文件格式」层面（扇区、位打包、zlib），这里负责「语义」层面：
 * 哪些 chunk 要读、怎么拼成一块连续地形、改完怎么写回去。
 *
 * ── 编辑器世界 vs 存档，两个结构性差异 ──
 *
 * 1. **坐标系不同**
 *    编辑器世界原点在 (0,0,0)，尺寸 64×48×64 之类，是「一块地形」。
 *    存档是无限世界，chunk 坐标可以是负数，Y 从 -64 到 320。
 *    所以导入必须选一个「窗口」：挑一片区域、挑一段高度范围，映射成编辑器世界。
 *
 * 2. **存储顺序不同**
 *    编辑器：一维数组，index = (y * depth + z) * width + x
 *    存档 section：4096 数组，index = y*256 + z*16 + x
 *    两者都是 YZX，但步长不同，转换时不能想当然。
 *
 * ── 写回的安全策略 ──
 * 只替换「方块数据」这一个字段，chunk 里其余内容（实体、光照、高度图、
 * 生物群系、结构引用）全部原样保留。这是刻意的：我们只懂方块，
 * 重造整个 chunk 会把不懂的东西丢掉，用户的箱子、刷怪笼、光照就没了。
 */

import { VoxelWorld } from '../core/voxel-world.js'
import { BLOCK_BY_ID } from '../data/blocks.js'
import { parseNbt, TagType, NbtWriter } from './nbt.js'
import {
  parseRegion, readChunkNbt, writeRegion, serializeChunkNbt,
  readSectionIndices, sectionIndex, bitsForPalette, packBlockStates,
} from './anvil.js'
import { mapBlockName, makeReport } from './schematic.js'

export const CHUNK = 16
const SECTIONS_PER_CHUNK = 24   // 1.18+ 主世界 Y 范围 -64..320

/**
 * 把区块坐标 + section Y 索引换算成 section 的绝对 Y。
 * 1.18+ 起 section 的 Y 字段可能是负数（-4 对应 y=-64），
 * 更老的版本从 0 开始。这个函数把两种都归一到绝对 Y。
 */
function sectionAbsoluteY(section, fallbackIndex) {
  const y = section?.Y
  if (typeof y === 'number') return y
  return fallbackIndex
}

/**
 * 读取存档里的一个「窗口」，合成编辑器世界。
 *
 * @param {object} opts
 * @param {(rx:number, rz:number) => Promise<Uint8Array|null>} opts.readRegion  读 region 文件
 * @param {number} opts.minChunkX  窗口左边界（chunk 坐标，含）
 * @param {number} opts.minChunkZ
 * @param {number} opts.chunksX    横向多少 chunk
 * @param {number} opts.chunksZ
 * @param {number} opts.minY       底部绝对 Y（含）
 * @param {number} opts.height     高度（格）
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<{world:VoxelWorld, report:object}>}
 */
export async function importWorldWindow({
  readRegion, minChunkX, minChunkZ, chunksX, chunksZ, minY, height, onProgress,
}) {
  const width = chunksX * CHUNK
  const depth = chunksZ * CHUNK
  const world = new VoxelWorld(width, height, depth)
  const report = makeReport()
  report.format = 'minecraft-world'
  report.size = { w: width, h: height, d: depth }

  // 按 region 归组，避免同一个 region 文件被读多次 ——
  // 一个 region 有 1024 个 chunk，反复读盘会慢到不可接受。
  const regionCache = new Map()
  const regionKey = (rx, rz) => `${rx},${rz}`

  const maxChunkX = minChunkX + chunksX - 1
  const maxChunkZ = minChunkZ + chunksZ - 1
  const maxY = minY + height - 1

  let done = 0
  const total = chunksX * chunksZ

  for (let cz = minChunkZ; cz <= maxChunkZ; cz++) {
    for (let cx = minChunkX; cx <= maxChunkX; cx++) {
      // 负数坐标的 region 索引要用 floor 除法：chunk -1 属于 region -1，不是 0
      const rx = Math.floor(cx / 32)
      const rz = Math.floor(cz / 32)
      let entries = regionCache.get(regionKey(rx, rz))
      if (!entries) {
        const buf = await readRegion(rx, rz)
        entries = buf ? parseRegion(buf) : []
        regionCache.set(regionKey(rx, rz), entries)
      }

      // region 内的局部 chunk 坐标要用「取模」而不是「按位与」——
      // 负数的 & 31 在 JS 里对 -1 会得到 31（因为补码），
      // 恰好和 -1 & 31 = 31 一致，但语义容易让人误解，显式取模更清楚。
      const localCx = ((cx % 32) + 32) % 32
      const localCz = ((cz % 32) + 32) % 32
      const entry = entries.find((e) => e.cx === localCx && e.cz === localCz)

      if (entry?.raw) {
        try {
          const { root } = await readChunkNbt(entry)
          const sections = root?.sections ?? root?.Level?.Sections ?? []
          applySections({
            world, sections, report,
            originX: (cx - minChunkX) * CHUNK,
            originZ: (cz - minChunkZ) * CHUNK,
            minY, maxY,
          })
        } catch (err) {
          report.unsupported.push(`chunk (${cx},${cz}) 解析失败：${err.message}`)
        }
      }

      done++
      onProgress?.(done, total)
    }
  }

  report.totalBlocks = world.stats().solid
  return { world, report }
}

/**
 * 把一个 chunk 的所有 section 写进编辑器世界。
 *
 * 注意这里的 section 是「一整个 16×16×16」的立方体，而编辑器世界的高度
 * 可能不是 16 的倍数，所以在上下边界要裁掉超出的部分 ——
 * 不裁的话会越界写到别的行上去，是最难查的那类脏数据。
 */
function applySections({ world, sections, report, originX, originZ, minY, maxY }) {
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si]
    if (!section) continue
    const absY = sectionAbsoluteY(section, si)
    const baseY = absY * 16

    // 这个 section 完全在窗口之外就跳过（Y 方向）
    if (baseY + 15 < minY || baseY > maxY) continue

    const bs = section.block_states
    if (!bs) continue
    const { indices, palette } = readSectionIndices(bs)

    // 调色板名字先翻译成编辑器 id，避免在 4096 次循环里反复做字符串处理
    const idMap = new Int32Array(palette.length)
    for (let p = 0; p < palette.length; p++) {
      const raw = palette[p]?.Name ?? palette[p]?.name ?? 'minecraft:air'
      idMap[p] = mapBlockName(raw, report)
      if (!report.palette.includes(raw)) report.palette.push(raw)
    }

    for (let ly = 0; ly < 16; ly++) {
      const wy = baseY + ly
      if (wy < minY || wy > maxY) continue   // 超出窗口高度，裁掉
      const wyLocal = wy - minY

      for (let lz = 0; lz < 16; lz++) {
        for (let lx = 0; lx < 16; lx++) {
          const pi = indices[sectionIndex(lx, ly, lz)]
          const id = idMap[pi] ?? 0
          if (id === 0) continue   // 空气不写，省时间也省内存
          world.set(originX + lx, wyLocal, originZ + lz, id)
        }
      }
    }
  }
}

/**
 * 把编辑器世界的一个区域写回存档的 chunk 数据。
 *
 * 只改方块，其它字段照抄原 chunk。返回 { [chunkKey]: {chunkData, sectors} }。
 *
 * @param {object} opts
 * @param {VoxelWorld} opts.world       编辑器世界
 * @param {object} opts.region          区域：{x1,y1,z1,x2,y2,z2}（编辑器坐标）
 * @param {number} opts.minChunkX       世界窗口对应的最小 chunk 坐标
 * @param {number} opts.minY            世界窗口对应的最小绝对 Y（编辑器 y=0 对应的世界 y）
 * @param {(chunkX:number, chunkZ:number) => Promise<object|null>} opts.readChunk
 *        读取原始 chunk NBT（用于保留非方块字段）
 * @returns {Promise<Map<string,{chunkData:Uint8Array,sectors:number}>>}
 */
export async function buildChunkReplacements({ world, region, minChunkX, minChunkZ, minY, readChunk }) {
  const out = new Map()

  // 区域覆盖到哪些 chunk
  const c0x = Math.floor(region.x1 / CHUNK) + minChunkX
  const c1x = Math.floor(region.x2 / CHUNK) + minChunkX
  const c0z = Math.floor(region.z1 / CHUNK) + minChunkZ
  const c1z = Math.floor(region.z2 / CHUNK) + minChunkZ

  for (let cz = c0z; cz <= c1z; cz++) {
    for (let cx = c0x; cx <= c1x; cx++) {
      const original = await readChunk(cx, cz)

      // 局部 chunk 坐标 → 编辑器世界坐标（chunk 的 (0,0) 落在哪个世界格）
      const worldX0 = (cx - minChunkX) * CHUNK
      const worldZ0 = (cz - minChunkZ) * CHUNK

      const root = original?.root ?? null
      const sections = root?.sections ?? root?.Level?.Sections ?? []

      // 收集这个 chunk 涉及的所有 section Y
      const sectionYs = new Set()
      for (let wy = region.y1; wy <= region.y2; wy++) {
        sectionYs.add(Math.floor((minY + wy) / 16))
      }

      for (const absY of sectionYs) {
        let section = sections.find((s, i) => sectionAbsoluteY(s, i) === absY)
        if (!section) {
          // 原 chunk 里没有这个 section（可能是一整片空气）——
          // 只有当我们确实要在这里放方块时才需要新建
          section = { Y: absY, block_states: { palette: [{ Name: 'minecraft:air' }] } }
          sections.push(section)
        }
        paintSection({ section, world, region, worldX0, worldZ0, minY, absY })
      }

      // 重新序列化
      const bytes = serializeNbtRoot(root, original?.rootName ?? '')
      out.set(`${cx},${cz}`, await serializeChunkNbt(bytes))
    }
  }
  return out
}

/** 把编辑器世界里落在某个 section 范围内的方块涂进这个 section */
function paintSection({ section, world, region, worldX0, worldZ0, minY, absY }) {
  const bs = section.block_states ?? (section.block_states = { palette: [{ Name: 'minecraft:air' }] })
  const palette = bs.palette ?? (bs.palette = [{ Name: 'minecraft:air' }])

  const { indices } = readSectionIndices(bs)
  const baseY = absY * 16

  // 建立「方块 id → 调色板下标」的反查表，边用边扩
  const idToPal = new Map()
  const rebuildReverse = () => {
    idToPal.clear()
    for (let p = 0; p < palette.length; p++) {
      const name = palette[p]?.Name ?? palette[p]?.name ?? 'minecraft:air'
      const id = name === 'minecraft:air' ? 0 : mapBlockName(name, { approxBlocks: [], unknownBlocks: [] })
      if (!idToPal.has(id)) idToPal.set(id, p)
    }
  }
  rebuildReverse()

  // 只遍历这个 chunk 落在区域的交叠部分
  const lx0 = Math.max(0, region.x1 - worldX0)
  const lx1 = Math.min(15, region.x2 - worldX0)
  const lz0 = Math.max(0, region.z1 - worldZ0)
  const lz1 = Math.min(15, region.z2 - worldZ0)

  for (let wy = Math.max(region.y1, baseY - minY); wy <= Math.min(region.y2, baseY + 15 - minY); wy++) {
    const ly = (minY + wy) - baseY
    if (ly < 0 || ly > 15) continue

    for (let wz = lz0; wz <= lz1; wz++) {
      for (let wx = lx0; wx <= lx1; wx++) {
        const id = world.get(wx, wy, wz)
        let pal = idToPal.get(id)
        if (pal === undefined) {
          // 调色板里没有这个方块，加进去（Minecraft 调色板上限 4096，够用）
          const def = blockIdToMcName(id)
          palette.push({ Name: def })
          pal = palette.length - 1
          idToPal.set(id, pal)
        }
        indices[sectionIndex(wx - worldX0, ly, wz - worldZ0)] = pal
      }
    }
  }

  // 位宽可能因为调色板变大而变粗，必须重新打包
  const bits = bitsForPalette(palette.length)
  bs.data = packBlockStates(indices, bits)
  bs.palette = palette
}

/** 编辑器方块 id → Minecraft 方块名 */
function blockIdToMcName(id) {
  const def = BLOCK_BY_ID[id]
  if (!def) return 'minecraft:air'
  return `minecraft:${def.name}`
}

/**
 * 把 section 列表序列化回 chunk NBT 字节。
 *
 * 这里刻意不重新构造整棵树 —— 我们改的是 root.sections 里的对象，
 * 直接把它写回去即可。新增的 tag 类型（LongArray）Writer 原本不支持，
 * 所以下面这段是手写的序列化。
 */
export function serializeNbtRoot(root, rootName) {
  const w = new NbtWriter()
  // 根是具名 Compound：类型字节 + 名字 + 内容 + End
  w.u8(TagType.Compound)
  w.string(rootName || '')
  writeCompoundBody(w, root)
  w.u8(TagType.End)
  return w.toBytes()
}

function writeCompoundBody(w, obj) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    writeTag(w, k, v)
  }
  w.u8(TagType.End)
}

function writeTag(w, name, v) {
  if (v === null || v === undefined) return

  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
      w.u8(TagType.Int); w.string(name); w.i32(v)
    } else {
      w.u8(TagType.Double); w.string(name)
      const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); w.push(b)
    }
    return
  }
  if (typeof v === 'string') { w.u8(TagType.String); w.string(name); w.string(v); return }
  if (typeof v === 'bigint') {
    w.u8(TagType.Long); w.string(name)
    const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, false); w.push(b)
    return
  }
  if (typeof v === 'boolean') { w.u8(TagType.Byte); w.string(name); w.u8(v ? 1 : 0); return }

  if (v instanceof Uint8Array) {
    w.u8(TagType.ByteArray); w.string(name); w.byteArray(v); return
  }
  if (v instanceof Int32Array) {
    w.u8(TagType.IntArray); w.string(name); w.intArray(v); return
  }
  if (v instanceof BigInt64Array || v instanceof BigUint64Array) {
    w.u8(TagType.LongArray); w.string(name); w.i32(v.length)
    const b = new Uint8Array(8 * v.length)
    const dv = new DataView(b.buffer)
    for (let i = 0; i < v.length; i++) dv.setBigInt64(i * 8, BigInt.asIntN(64, v[i]), false)
    w.push(b)
    return
  }
  if (Array.isArray(v)) {
    // List：元素类型取第一个元素的类型；空列表用 End(0)
    w.u8(TagType.List); w.string(name)
    const t = v.length ? listElementType(v[0]) : TagType.End
    w.u8(t); w.i32(v.length)
    for (const item of v) writePayload(w, t, item)
    return
  }
  if (typeof v === 'object') {
    w.u8(TagType.Compound); w.string(name)
    writeCompoundBody(w, v)
    return
  }
}

function listElementType(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? TagType.Int : TagType.Double
  if (typeof v === 'string') return TagType.String
  if (typeof v === 'bigint') return TagType.Long
  if (v instanceof Uint8Array) return TagType.ByteArray
  if (v instanceof Int32Array) return TagType.IntArray
  if (v instanceof BigInt64Array) return TagType.LongArray
  if (Array.isArray(v)) return TagType.List
  return TagType.Compound
}

function writePayload(w, type, v) {
  switch (type) {
    case TagType.Byte: w.u8(v ? 1 : 0); break
    case TagType.Int: w.i32(v); break
    case TagType.Double: { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); w.push(b); break }
    case TagType.String: w.string(String(v)); break
    case TagType.Long: { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(v), false); w.push(b); break }
    case TagType.ByteArray: w.byteArray(v); break
    case TagType.IntArray: w.intArray(v); break
    case TagType.LongArray: {
      w.i32(v.length)
      const b = new Uint8Array(8 * v.length); const dv = new DataView(b.buffer)
      for (let i = 0; i < v.length; i++) dv.setBigInt64(i * 8, BigInt.asIntN(64, v[i]), false)
      w.push(b); break
    }
    case TagType.Compound: writeCompoundBody(w, v); break
    case TagType.List: {
      const t = v.length ? listElementType(v[0]) : TagType.End
      w.u8(t); w.i32(v.length)
      for (const item of v) writePayload(w, t, item)
      break
    }
    default: throw new Error(`无法序列化的 List 元素类型：${type}`)
  }
}

export { writeRegion, serializeChunkNbt }
