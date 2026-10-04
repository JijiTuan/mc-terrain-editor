/**
 * voxel-world.js — 稠密体素世界
 *
 * 存储模型：一维 Uint8Array，索引公式 (y * depth + z) * width + x
 * 之所以用稠密数组而不是 Map/稀疏结构，是因为：
 *   1. 渲染器要按区块遍历，稠密数组的连续性对缓存友好；
 *   2. 区域填充 / 复制粘贴 / AI 生成的批量操作可以用 Uint8Array.set 一次性写入；
 *   3. 快照只需要 slice()，撤销栈实现简单且内存可控。
 * 55 种方块 < 255，Uint8 足够。
 *
 * 坐标系与 Minecraft 一致：X 东，Y 上，Z 南。y=0 是最底层。
 */

import { AIR } from '../data/blocks.js'

export const MAX_REASONABLE_SIZE = 512

export class VoxelWorld {
  /**
   * @param {number} width  X 尺寸
   * @param {number} height Y 尺寸
   * @param {number} depth  Z 尺寸
   * @param {Uint8Array} [data] 已有数据（尺寸必须匹配）
   */
  constructor(width, height, depth, data) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isInteger(depth)) {
      throw new Error('世界尺寸必须是整数')
    }
    if (width <= 0 || height <= 0 || depth <= 0) throw new Error('世界尺寸必须为正数')
    if (width > MAX_REASONABLE_SIZE || depth > MAX_REASONABLE_SIZE || height > MAX_REASONABLE_SIZE) {
      throw new Error(`世界尺寸上限为 ${MAX_REASONABLE_SIZE}`)
    }

    this.width = width
    this.height = height
    this.depth = depth
    this.size = width * height * depth

    if (data) {
      if (data.length !== this.size) {
        throw new Error(`数据长度 ${data.length} 与世界尺寸 ${this.size} 不匹配`)
      }
      this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
    } else {
      this.data = new Uint8Array(this.size)
    }

    /** 单调递增的修改计数，渲染器据此判断是否需要重建脏区块 */
    this.revision = 0
  }

  /** 世界是否包含某个整数坐标 */
  inBounds(x, y, z) {
    return x >= 0 && y >= 0 && z >= 0 && x < this.width && y < this.height && z < this.depth
  }

  /** 坐标 → 一维下标；越界返回 -1 */
  index(x, y, z) {
    return this.inBounds(x, y, z) ? (y * this.depth + z) * this.width + x : -1
  }

  /** 读取方块；越界返回 0（空气），便于邻接查询 */
  get(x, y, z) {
    const i = this.index(x, y, z)
    return i < 0 ? AIR : this.data[i]
  }

  /**
   * 写入方块。
   * @returns {boolean} 是否真的发生了改变（越界或值未变返回 false）
   */
  set(x, y, z, id) {
    const i = this.index(x, y, z)
    if (i < 0) return false
    if (this.data[i] === id) return false
    this.data[i] = id
    this.revision++
    return true
  }

  /** 不做边界检查的快速写入，仅限内部已知坐标合法的场景 */
  setUnsafe(i, id) {
    if (this.data[i] === id) return false
    this.data[i] = id
    this.revision++
    return true
  }

  /** 整块内存替换（撤销 / 重做 / 加载时用），不逐格比较 */
  replaceAll(data) {
    if (data.length !== this.size) throw new Error('替换数据长度不匹配')
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.revision++
  }

  /** 复制一份完整快照 */
  snapshot() {
    return this.data.slice()
  }

  fill(id) {
    this.data.fill(id)
    this.revision++
  }

  isEmpty() {
    for (let i = 0; i < this.size; i++) if (this.data[i] !== AIR) return false
    return true
  }

  /** 已使用体积占比，用于 HUD 显示 */
  fillRatio() {
    let n = 0
    for (let i = 0; i < this.size; i++) if (this.data[i] !== AIR) n++
    return n / this.size
  }

  /** 从最高非空方块往下找地表高度（用于笔刷工具的地形贴合） */
  surfaceHeight(x, z) {
    for (let y = this.height - 1; y >= 0; y--) {
      if (this.get(x, y, z) !== AIR) return y
    }
    return -1
  }

  /**
   * 复制一个长方体区域到独立缓冲区。
   * @returns {{x:number,y:number,z:number,w:number,h:number,d:number,data:Uint8Array}}
   */
  copyRegion(x1, y1, z1, x2, y2, z2) {
    const x0 = Math.min(x1, x2), xE = Math.max(x1, x2)
    const y0 = Math.min(y1, y2), yE = Math.max(y1, y2)
    const z0 = Math.min(z1, z2), zE = Math.max(z1, z2)
    const w = xE - x0 + 1, h = yE - y0 + 1, d = zE - z0 + 1
    const buf = new Uint8Array(w * h * d)
    let p = 0
    for (let y = y0; y <= yE; y++) {
      for (let z = z0; z <= zE; z++) {
        for (let x = x0; x <= xE; x++) {
          buf[p++] = this.get(x, y, z)
        }
      }
    }
    return { x: x0, y: y0, z: z0, w, h, d, data: buf }
  }

  /**
   * 把缓冲区贴回世界。越界部分自动裁剪，不报错。
   * @param {{x:number,y:number,z:number,w:number,h:number,d:number,data:Uint8Array}} region
   * @param {number} ox 目标原点
   * @param {number} oy
   * @param {number} oz
   * @param {boolean} [skipAir=false] 为 true 时空气不覆盖已有方块（实现"只贴实体"的粘贴）
   * @returns {number} 实际写入的方块数
   */
  pasteRegion(region, ox, oy, oz, skipAir = false) {
    let written = 0
    let p = 0
    for (let dy = 0; dy < region.h; dy++) {
      for (let dz = 0; dz < region.d; dz++) {
        for (let dx = 0; dx < region.w; dx++) {
          const id = region.data[p++]
          if (skipAir && id === AIR) continue
          if (this.set(ox + dx, oy + dy, oz + dz, id)) written++
        }
      }
    }
    return written
  }

  /** 遍历所有方块，返回统计信息（HUD 用） */
  stats() {
    const counts = new Map()
    let solid = 0
    for (let i = 0; i < this.size; i++) {
      const id = this.data[i]
      if (id === AIR) continue
      solid++
      counts.set(id, (counts.get(id) || 0) + 1)
    }
    return { solid, counts }
  }

  /** 序列化为可 JSON 的紧凑结构：RLE 游程编码，空白世界几乎不占空间 */
  toJSON() {
    return {
      width: this.width,
      height: this.height,
      depth: this.depth,
      encoding: 'rle',
      runs: rleEncode(this.data),
    }
  }

  /** 从 toJSON 结果还原 */
  static fromJSON(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('无效的世界数据')
    const { width, height, depth, encoding, runs, data } = obj
    if (encoding === 'rle') {
      const buf = rleDecode(runs, width * height * depth)
      return new VoxelWorld(width, height, depth, buf)
    }
    // 兼容 base64 原始字节（schematic / 旧版本存档）
    if (typeof data === 'string') {
      return new VoxelWorld(width, height, depth, base64ToBytes(data))
    }
    throw new Error('未知的世界数据编码方式')
  }
}

/** 游程编码：输出扁平数组 [值, 次数, 值, 次数, ...] */
export function rleEncode(bytes) {
  const runs = []
  let prev = bytes[0]
  let n = 1
  for (let i = 1; i < bytes.length; i++) {
    const v = bytes[i]
    if (v === prev && n < 0xffffffff) {
      n++
    } else {
      runs.push(prev, n)
      prev = v
      n = 1
    }
  }
  runs.push(prev, n)
  return runs
}

export function rleDecode(runs, expectedLength) {
  if (!Array.isArray(runs)) throw new Error('无效的游程数据')
  const out = new Uint8Array(expectedLength)
  let p = 0
  for (let i = 0; i < runs.length; i += 2) {
    const v = runs[i]
    const n = runs[i + 1]
    if (typeof v !== 'number' || typeof n !== 'number') throw new Error('游程数据格式错误')
    const end = Math.min(p + n, expectedLength)
    out.fill(v, p, end)
    p = end
    if (p >= expectedLength) break
  }
  return out
}

export function bytesToBase64(bytes) {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

export function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
