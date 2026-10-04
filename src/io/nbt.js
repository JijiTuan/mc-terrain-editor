/**
 * nbt.js — Minecraft NBT 格式解析器（含 gzip 解压）
 *
 * schematic 文件本质是一个 gzip 压缩的 NBT 树。浏览器有 DecompressionStream('gzip')，
 * 无需第三方库即可解压。NBT 是自描述的标签树，按 tagType 递归读取即可。
 *
 * 支持的 tag 类型：End/Byte/Short/Int/Long/Float/Double/ByteArray/String/List/Compound/IntArray/LongArray
 */

export const TagType = {
  End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6,
  ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12,
}

/** 解压 gzip；若数据不是 gzip 则原样返回 */
export async function maybeGunzip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 解压（需要 DecompressionStream）')
  }
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([bytes]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export function gunzipSync(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes
  throw new Error('同步解压不可用，请使用 maybeGunzip')
}

/** NBT 读取器 */
export class NbtReader {
  constructor(bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = 0
    this.textDecoder = new TextDecoder('utf-8')
  }

  need(n) {
    if (this.pos + n > this.view.byteLength) throw new Error('NBT 数据意外结束（文件可能已损坏）')
  }

  u8() { this.need(1); return this.view.getUint8(this.pos++) }
  i8() { this.need(1); return this.view.getInt8(this.pos++) }
  i16() { this.need(2); const v = this.view.getInt16(this.pos, false); this.pos += 2; return v }
  u16() { this.need(2); const v = this.view.getUint16(this.pos, false); this.pos += 2; return v }
  i32() { this.need(4); const v = this.view.getInt32(this.pos, false); this.pos += 4; return v }
  i64() { this.need(8); const v = this.view.getBigInt64(this.pos, false); this.pos += 8; return v }
  f32() { this.need(4); const v = this.view.getFloat32(this.pos, false); this.pos += 4; return v }
  f64() { this.need(8); const v = this.view.getFloat64(this.pos, false); this.pos += 8; return v }

  /** Java 修改版 UTF-8：长度用 u16，必要时以 CESU-8 编码 */
  string() {
    const len = this.u16()
    this.need(len)
    const slice = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len)
    this.pos += len
    return this.textDecoder.decode(slice)
  }

  /** 读取一个具名标签，返回 { name, value } */
  namedTag() {
    const type = this.u8()
    if (type === TagType.End) return { name: '', value: null, type }
    const name = this.string()
    return { name, value: this.payload(type), type }
  }

  payload(type) {
    switch (type) {
      case TagType.End: return null
      case TagType.Byte: return this.i8()
      case TagType.Short: return this.i16()
      case TagType.Int: return this.i32()
      case TagType.Long: return this.i64()
      case TagType.Float: return this.f32()
      case TagType.Double: return this.f64()
      case TagType.ByteArray: {
        const n = this.i32()
        this.need(n)
        const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n)
        this.pos += n
        return new Uint8Array(out)
      }
      case TagType.String: return this.string()
      case TagType.List: {
        const itemType = this.u8()
        const n = this.i32()
        if (n < 0) throw new Error('NBT 列表长度非法')
        const out = new Array(n)
        for (let i = 0; i < n; i++) out[i] = this.payload(itemType)
        return out
      }
      case TagType.Compound: {
        const out = {}
        for (;;) {
          const tag = this.namedTag()
          if (tag.type === TagType.End) break
          out[tag.name] = tag.value
        }
        return out
      }
      case TagType.IntArray: {
        const n = this.i32()
        const out = new Int32Array(n)
        for (let i = 0; i < n; i++) out[i] = this.i32()
        return out
      }
      case TagType.LongArray: {
        const n = this.i32()
        const out = new BigInt64Array(n)
        for (let i = 0; i < n; i++) out[i] = this.i64()
        return out
      }
      default:
        throw new Error(`未知的 NBT 标签类型：${type}`)
    }
  }
}

/** 解析完整 NBT 文档，返回根复合标签 */
export function parseNbt(bytes) {
  const reader = new NbtReader(bytes)
  const root = reader.namedTag()
  if (root.type !== TagType.Compound) throw new Error('NBT 根标签不是 Compound')
  return { rootName: root.name, root: root.value }
}

/** 解析 gzip 压缩的 NBT */
export async function parseCompressedNbt(buffer) {
  const raw = await maybeGunzip(buffer)
  return parseNbt(raw)
}

// ---------------- NBT 写入（导出 schematic 用） ----------------

export class NbtWriter {
  constructor() {
    this.chunks = []
    this.length = 0
  }

  push(bytes) {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  u8(v) { this.push(new Uint8Array([v & 0xff])) }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, false); this.push(b) }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); this.push(b) }
  string(s) {
    const bytes = new TextEncoder().encode(s)
    this.i16(bytes.length)
    this.push(bytes)
  }
  byteArray(arr) {
    this.i32(arr.length)
    this.push(arr instanceof Uint8Array ? arr : new Uint8Array(arr))
  }
  intArray(arr) {
    this.i32(arr.length)
    for (const v of arr) this.i32(v)
  }

  compound(name, fields) {
    this.u8(TagType.Compound)
    this.string(name)
    for (const [k, v] of fields) {
      this.tag(k, v)
    }
    this.u8(TagType.End)
  }

  tag(name, v) {
    if (typeof v === 'number') {
      if (Number.isInteger(v)) { this.u8(TagType.Int); this.string(name); this.i32(v) }
      else { this.u8(TagType.Double); this.string(name); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, false); this.push(b) }
    } else if (typeof v === 'string') {
      this.u8(TagType.String); this.string(name); this.string(v)
    } else if (v instanceof Uint8Array) {
      this.u8(TagType.ByteArray); this.string(name); this.byteArray(v)
    } else if (v instanceof Int32Array || Array.isArray(v)) {
      this.u8(TagType.IntArray); this.string(name); this.intArray(v)
    } else if (v && typeof v === 'object' && v.__nested) {
      this.compound(name, v.fields)
    } else {
      throw new Error(`无法序列化的 NBT 值：${name}`)
    }
  }

  toBytes() {
    const out = new Uint8Array(this.length)
    let p = 0
    for (const c of this.chunks) { out.set(c, p); p += c.length }
    return out
  }
}

/** 用 gzip 压缩（浏览器 CompressionStream） */
export async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 压缩（需要 CompressionStream）')
  }
  const cs = new CompressionStream('gzip')
  const stream = new Blob([bytes]).stream().pipeThrough(cs)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
