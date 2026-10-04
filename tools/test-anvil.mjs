// Anvil 存档读写测试
//
// 重点测「位打包」—— 这是整个 Anvil 格式里最容易出静默错误的地方：
// 天真的 `bitIndex = i * bits` 在 bits 不是 64 约数时前半段还是对的，
// 越往后越乱，肉眼审查很难发现。所以这里做**逐格往返比对**，
// 并且特意构造「索引值超出单个 long 容量」的用例来逼出越界 bug。
import {
  bitsForPalette, unpackBlockStates, packBlockStates,
  readSectionIndices, sectionIndex, parseRegion, writeRegion,
  serializeChunkNbt, zlibInflate, zlibDeflate,
} from '../src/io/anvil.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

console.log('\n[1] 位数计算')
check('调色板 1 项 → 4 位（原版下限）', bitsForPalette(1) === 4, String(bitsForPalette(1)))
check('调色板 2 项 → 4 位', bitsForPalette(2) === 4, String(bitsForPalette(2)))
check('调色板 16 项 → 4 位', bitsForPalette(16) === 4, String(bitsForPalette(16)))
check('调色板 17 项 → 5 位', bitsForPalette(17) === 5, String(bitsForPalette(17)))
check('调色板 33 项 → 6 位', bitsForPalette(33) === 6, String(bitsForPalette(33)))

console.log('\n[2] 位打包往返（逐格比对）')
for (const bits of [4, 5, 6, 7, 8, 9, 11, 13]) {
  const n = 4096
  const maxV = (1 << bits) - 1
  // 构造边界值：0、最大值、以及跨 long 边界的下标位置放一个「哨兵」值
  const src = new Uint16Array(n)
  for (let i = 0; i < n; i++) src[i] = i % (maxV + 1)
  src[0] = maxV
  src[11] = maxV          // bits=5 时每个 long 装 12 个，11 是第 12 个
  src[12] = 1             // 12 是新 long 的第 1 个 —— 跨边界处
  src[n - 1] = maxV

  const packed = packBlockStates(src, bits)
  const back = unpackBlockStates(packed, n, bits)
  check(`bits=${bits} 往返逐格一致`, eq(src, back),
    eq(src, back) ? `${packed.length} 个 long` : `首个差异 index=${src.findIndex((v, i) => v !== back[i])}`)
}

console.log('\n[3] 反向对照：故意用错误的「i*bits」算法必须失败')
{
  // 朴素实现：把整个数组当成一个连续位流（错误做法）
  const bits = 5, n = 4096
  const src = new Uint16Array(n)
  for (let i = 0; i < n; i++) src[i] = i % 32
  const packed = packBlockStates(src, bits)
  const naive = new Uint16Array(n)
  const mask = (1n << BigInt(bits)) - 1n
  for (let i = 0; i < n; i++) {
    const bitPos = i * bits
    const longIdx = Math.floor(bitPos / 64)
    const shift = BigInt(bitPos % 64)
    naive[i] = Number((packed[longIdx] >> shift) & mask)
  }
  const mismatchAt = src.findIndex((v, i) => v !== naive[i])
  check('朴素算法确实会读错（证明这个测试有区分力）', mismatchAt > 0,
    mismatchAt > 0 ? `第 ${mismatchAt} 格起开始错` : '朴素算法竟然也对 —— 用例不够狠')
}

console.log('\n[4] section 索引顺序（原版是 y*256+z*16+x）')
check('(0,0,0) → 0', sectionIndex(0, 0, 0) === 0)
check('(1,0,0) → 1', sectionIndex(1, 0, 0) === 1)
check('(0,0,1) → 16', sectionIndex(0, 0, 1) === 16, String(sectionIndex(0, 0, 1)))
check('(0,1,0) → 256', sectionIndex(0, 1, 0) === 256, String(sectionIndex(0, 1, 0)))
check('(15,15,15) → 4095', sectionIndex(15, 15, 15) === 4095, String(sectionIndex(15, 15, 15)))

console.log('\n[5] 单一方块 section（原版省略 data）')
{
  const r = readSectionIndices({ palette: [{ Name: 'minecraft:stone' }] })
  check('无 data 时全填索引 0', r.indices.every((v) => v === 0))
  check('无 data 时 bits 记为 0', r.bits === 0, String(r.bits))
}

console.log('\n[6] zlib 往返（现代 MC chunk 用的是 zlib 不是 gzip）')
{
  const src = new TextEncoder().encode('Hello Anvil '.repeat(200))
  const def = await zlibDeflate(src)
  check('压缩产生的是 zlib 流（magic 78 xx）', def[0] === 0x78, `magic=${def[0].toString(16)}`)
  check('不是 gzip 流（magic 不是 1f8b）', !(def[0] === 0x1f && def[1] === 0x8b))
  const back = await zlibInflate(def)
  check('解压往返一致', eq(src, back), `${src.length} → ${def.length} → ${back.length}`)
}

console.log('\n[7] region 文件切分与重写')
{
  // 手工造一个最小 region：2 个 chunk
  const chunkA = await serializeChunkNbt(new Uint8Array([1, 2, 3, 4, 5]))
  const chunkB = await serializeChunkNbt(new Uint8Array([9, 9, 9]))
  const repl = new Map([
    ['0,0', chunkA],
    ['3,2', chunkB],
  ])
  const mca = writeRegion(null, repl)
  check('产出的 region 是 4096 的整数倍', mca.length % 4096 === 0, `${mca.length} bytes`)

  const parsed = parseRegion(mca)
  check('解析回 2 个 chunk', parsed.length === 2, `${parsed.length} 个`)
  const a = parsed.find((e) => e.cx === 0 && e.cz === 0)
  const b = parsed.find((e) => e.cx === 3 && e.cz === 2)
  check('chunk (0,0) 定位正确', !!a)
  check('chunk (3,2) 定位正确', !!b)
  check('压缩类型记为 zlib(2)', a?.compression === 2, String(a?.compression))

  // 再写一次：只替换 A，B 必须原样保留
  const repl2 = new Map([['0,0', await serializeChunkNbt(new Uint8Array([7, 7]))]])
  const mca2 = writeRegion(mca, repl2)
  const parsed2 = parseRegion(mca2)
  check('重写后仍是 2 个 chunk（未改的没丢）', parsed2.length === 2, `${parsed2.length} 个`)
  const b2 = parsed2.find((e) => e.cx === 3 && e.cz === 2)
  const bOrig = parsed.find((e) => e.cx === 3 && e.cz === 2)
  check('未改动的 chunk 字节完全一致（原样搬运）',
    b2 && bOrig && eq(b2.raw, bOrig.raw),
    b2 && bOrig ? `${b2.raw.length} vs ${bOrig.raw.length}` : '找不到')
}

console.log('\n[8] region 边界与损坏容忍')
{
  check('太小的文件明确抛错', (() => {
    try { parseRegion(new Uint8Array(100)); return false } catch { return true }
  })())

  const mca = writeRegion(null, new Map([['5,7', await serializeChunkNbt(new Uint8Array([1]))]]))
  const parsed = parseRegion(mca)
  const e = parsed[0]
  check('cx/cz 从位置表索引正确还原', e.cx === 5 && e.cz === 7, `(${e.cx},${e.cz})`)

  // 极端坐标：31,31 是 region 内最大
  const mca2 = writeRegion(null, new Map([['31,31', await serializeChunkNbt(new Uint8Array([1]))]]))
  const e2 = parseRegion(mca2)[0]
  check('边界坐标 (31,31) 可往返', e2.cx === 31 && e2.cz === 31, `(${e2.cx},${e2.cz})`)
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
