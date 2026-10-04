/**
 * 存档往返测试：导出 → 导入 → 逐格比对。
 *
 * 为什么要专门测这个：schematic 导出写错一个字节，用户在 Minecraft 里加载时
 * 只会看到「存档损坏」或「方块错位」，根本不知道是编辑器的问题。
 * 所以必须做严格的双向往返，而不是「能导出不报错就算过」。
 *
 * 覆盖：Sponge v3(默认导出) / 原生 JSON / RLE 序列化 / 分块-合并
 */
import { createDefaultWorld } from '../src/data/default-world.js'
import {
  exportSchematic, importSchematic, exportNative, importNative,
  sliceIntoChunks, mergeChunks, detectFormat,
} from '../src/io/schematic.js'
import { VoxelWorld } from '../src/core/voxel-world.js'
import { parseCompressedNbt, NbtReader } from '../src/io/nbt.js'
import { BLOCK_BY_ID } from '../src/data/blocks.js'

let pass = 0
let fail = 0

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 逐格比对两个世界，返回差异数与首个差异坐标 */
function diffWorlds(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.depth !== b.depth) {
    return { dimsMismatch: true, a: [a.width, a.height, a.depth], b: [b.width, b.height, b.depth] }
  }
  let n = 0
  let first = null
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) {
      n++
      if (!first) {
        const y = Math.floor(i / (a.depth * a.width))
        const rem = i - y * a.depth * a.width
        const z = Math.floor(rem / a.width)
        const x = rem - z * a.width
        first = { x, y, z, a: a.data[i], b: b.data[i] }
      }
    }
  }
  return { diff: n, first }
}

// ============================================================
console.log('\n[1] VoxelWorld JSON / RLE 往返')
{
  const w = createDefaultWorld()
  const json = w.toJSON()
  const back = VoxelWorld.fromJSON(json)
  const d = diffWorlds(w, back)
  check('尺寸一致', !d.dimsMismatch, d.dimsMismatch ? `${d.a} vs ${d.b}` : `${w.width}x${w.height}x${w.depth}`)
  check('逐格完全一致', d.diff === 0, d.diff ? `差异 ${d.diff} 格，首处 ${JSON.stringify(d.first)}` : '0 差异')
  check('编码标记为 rle', json.encoding === 'rle', `encoding=${json.encoding}`)
  check('runs 是偶数长度的成对数组', Array.isArray(json.runs) && json.runs.length % 2 === 0,
    `runs.length=${json.runs.length}`)
  // runs 是 [值,连续个数, 值,连续个数, ...]，展开后的总量必须等于世界体积
  let expanded = 0
  for (let i = 1; i < json.runs.length; i += 2) expanded += json.runs[i]
  check('runs 展开后覆盖全部体素', expanded === w.size, `展开 ${expanded} / 体积 ${w.size}`)
  check('RLE 确实压缩了', json.runs.length < w.data.length,
    `体素 ${w.data.length} 个 → runs ${json.runs.length} 个数字（压缩比 ${(w.data.length / json.runs.length).toFixed(1)}x）`)
}

// ============================================================
console.log('\n[2] 原生工程格式往返')
{
  const w = createDefaultWorld()
  const obj = exportNative(w, { name: '测试工程', note: 'roundtrip' })
  const back = importNative(obj)
  const d = diffWorlds(w, back)
  check('逐格完全一致', d.diff === 0, d.diff ? `差异 ${d.diff}` : '0 差异')
  check('meta.name 保留', obj.meta?.name === '测试工程', `meta.name=${obj.meta?.name}`)
  check('自定义字段保留', obj.meta?.note === 'roundtrip', `meta.note=${obj.meta?.note}`)
  check('format 标记正确', obj.format === 'mc-terrain-editor', `format=${obj.format}`)
}

// ============================================================
console.log('\n[3] Sponge schematic v3 导出 → 导入往返')
{
  const w = createDefaultWorld()
  const buf = await exportSchematic(w, 'roundtrip')
  check('产出的是字节流', buf instanceof Uint8Array || buf instanceof ArrayBuffer, `${buf.byteLength ?? buf.length} bytes`)

  // 先确认是合法 gzip + NBT（能解析出来）
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  // gzip magic 0x1f 0x8b
  check('是 gzip 流', bytes[0] === 0x1f && bytes[1] === 0x8b, `magic=${bytes[0].toString(16)} ${bytes[1].toString(16)}`)

  // parseCompressedNbt 返回 { rootName, root }。
  // 注意 parseNbt 已经把所有标签「解包」了：数字就是 number，Compound 就是普通对象，
  // ByteArray 就是 Uint8Array —— 不要再套一层 .value。
  const parsed = await parseCompressedNbt(bytes)
  const root = parsed.root
  check('NBT 可解析', !!root, `rootName="${parsed.rootName}" 字段数=${Object.keys(root || {}).length}`)
  check('根标签名为 Schematic', parsed.rootName === 'Schematic', `rootName=${parsed.rootName}`)
  check('含 Version 版本信息', root?.Version === 3, `Version=${root?.Version}`)
  check('含尺寸 Width/Height/Length',
    root?.Width != null && root?.Height != null && root?.Length != null,
    `${root?.Width}x${root?.Height}x${root?.Length}`)
  check('NBT 尺寸与源世界一致',
    root?.Width === w.width && root?.Height === w.height && root?.Length === w.depth,
    `${root?.Width}x${root?.Height}x${root?.Length} vs ${w.width}x${w.height}x${w.depth}`)
  check('含 Blocks.Data 字节数组', root?.Blocks?.Data instanceof Uint8Array,
    `ctor=${root?.Blocks?.Data?.constructor?.name} len=${root?.Blocks?.Data?.length}`)
  check('Blocks.Data 长度 = 世界体积', root?.Blocks?.Data?.length === w.size,
    `${root?.Blocks?.Data?.length} vs ${w.size}`)
  check('含 Palette 方块调色板', root?.Palette && typeof root.Palette === 'object',
    `调色板条目=${Object.keys(root?.Palette || {}).length}`)
  check('Palette[0] 是空气', Object.keys(root?.Palette || {})[0] === 'minecraft:air',
    `首项=${Object.keys(root?.Palette || {})[0]}`)

  const { world: back, report } = await importSchematic(bytes, 'roundtrip.schem')
  const d = diffWorlds(w, back)
  check('导入尺寸一致', !d.dimsMismatch, d.dimsMismatch ? `${d.a} vs ${d.b}` : `${back.width}x${back.height}x${back.depth}`)
  check('逐格完全一致', d.diff === 0, d.diff ? `差异 ${d.diff}，首处 ${JSON.stringify(d.first)}` : '0 差异')
  console.log(`     报告: 总方块=${report?.totalBlocks} 近似=${report?.approxBlocks} 未知=${report?.unknownBlocks}`)
}

// ============================================================
console.log('\n[4] 格式探测')
{
  // detectFormat 收的是「已解析的 NBT 根对象」，不是字节流。
  // 传字节流会掉进末尾的文件名兜底分支，把 .schem 一律判成 sponge-v2。
  const w = createDefaultWorld()
  const buf = await exportSchematic(w, 'detect')
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const { root } = await parseCompressedNbt(bytes)

  check('自己导出的 v3 被识别为 sponge-v3', detectFormat(root, 'detect.schem') === 'sponge-v3',
    `detectFormat -> ${detectFormat(root, 'detect.schem')}`)

  // litematic 特征
  check('带 Regions+Metadata 判为 litematic',
    detectFormat({ Regions: {}, Metadata: {} }, 'x.litematic') === 'litematic',
    `-> ${detectFormat({ Regions: {}, Metadata: {} }, 'x.litematic')}`)

  // v2：Version=2，根级 Palette + Blocks.Data —— 必须判成 v2 而不是 v3
  check('Version=2 判为 sponge-v2',
    detectFormat({ Version: 2, Palette: { 'minecraft:air': 0 }, Width: 2, Height: 2, Length: 2, Blocks: { Data: new Uint8Array(8) } }, 'x.schem') === 'sponge-v2',
    `-> ${detectFormat({ Version: 2, Palette: { 'minecraft:air': 0 }, Width: 2, Height: 2, Length: 2, Blocks: { Data: new Uint8Array(8) } }, 'x.schem')}`)

  // v2 且无 Data：以前会掉进 we-classic 分支，把调色板索引当旧版数字 id 解析
  check('v2 无 Blocks.Data 仍判为 sponge-v2（不回落到 we-classic）',
    detectFormat({ Version: 2, Palette: { 'minecraft:air': 0 }, Width: 2, Height: 2, Length: 2, BlockData: new Uint8Array(8) }, 'x.schem') === 'sponge-v2',
    `-> ${detectFormat({ Version: 2, Palette: { 'minecraft:air': 0 }, Width: 2, Height: 2, Length: 2, BlockData: new Uint8Array(8) }, 'x.schem')}`)

  // 真正的 we-classic：有 Blocks 但没有 Palette
  check('无 Palette 的 Blocks+Width 判为 we-classic',
    detectFormat({ Width: 2, Height: 2, Length: 2, Blocks: new Uint8Array(8) }, 'x.schem') === 'we-classic',
    `-> ${detectFormat({ Width: 2, Height: 2, Length: 2, Blocks: new Uint8Array(8) }, 'x.schem')}`)

  // 无特征字段应抛错，而不是瞎猜
  let threw = false
  try { detectFormat({ Foo: 1 }, 'x.bin') } catch { threw = true }
  check('无特征字段时明确抛错', threw, threw ? '已抛出' : '未抛错（会静默误判）')
}

// ============================================================
console.log('\n[5] 分块 → 合并往返')
{
  const w = createDefaultWorld()
  const chunks = sliceIntoChunks(w, 16)
  // 只按 X/Z 切分：这是刻意对齐 Minecraft 的 chunk 语义（16×世界高×16 的竖直柱），
  // 所以 64×48×64 的世界得到 (64/16)×(64/16) = 16 块，而不是三维的 64 块。
  const expectXZ = Math.ceil(w.width / 16) * Math.ceil(w.depth / 16)
  check('块数 = X/Z 平面切分（对齐 MC chunk 语义）', chunks.length === expectXZ,
    `期望 ${expectXZ} 实得 ${chunks.length}`)
  check('每块高度等于世界高度', chunks.every((c) => c.height === w.height), `height=${chunks[0]?.height}`)
  check('块尺寸均为 16×16', chunks.every((c) => c.width === 16 && c.depth === 16),
    `${chunks[0]?.width}x${chunks[0]?.depth}`)
  const nonEmpty = chunks.filter((c) => !c.empty).length
  console.log(`     其中非空块 ${nonEmpty} / ${chunks.length}`)
  const merged = mergeChunks(chunks, { width: w.width, height: w.height, depth: w.depth })
  const d = diffWorlds(w, merged)
  check('合并后逐格一致', d.diff === 0, d.diff ? `差异 ${d.diff}` : '0 差异')
}

// ============================================================
console.log('\n[6] 空世界与边界尺寸')
{
  const empty = new VoxelWorld(8, 8, 8)
  const obj = exportNative(empty, { name: '空' })
  const back = importNative(obj)
  const d = diffWorlds(empty, back)
  check('空世界往返一致', d.diff === 0, d.diff ? `差异 ${d.diff}` : '0 差异')

  // 1×1×1
  const tiny = new VoxelWorld(1, 1, 1)
  tiny.set(0, 0, 0, 1)
  const buf = await exportSchematic(tiny, 'tiny')
  const { world: tb } = await importSchematic(buf instanceof Uint8Array ? buf : new Uint8Array(buf), 'tiny.schem')
  const td = diffWorlds(tiny, tb)
  check('1×1×1 往返一致', td.diff === 0, td.diff ? `差异 ${td.diff}` : '0 差异')
}

// ============================================================
console.log('\n[7] 方块名称映射完整性（导出用的名字能被导入认回）')
{
  // 取所有非空气方块各造一个世界，确认导出再导入不丢方块种类
  const names = Object.values(BLOCK_BY_ID).filter((b) => b && b.name && b.id !== 0)
  const w = new VoxelWorld(16, 4, 16)
  const placed = []
  let i = 0
  for (const b of names) {
    const x = i % 16
    const z = Math.floor(i / 16) % 16
    if (w.set(x, 0, z, b.id)) placed.push({ id: b.id, name: b.name, x, y: 0, z })
    i++
  }
  console.log(`     放置了 ${placed.length} 种方块（共 ${names.length} 种）`)

  const obj = exportNative(w, { name: '全方块' })
  const back = importNative(obj)
  let lost = 0
  const lostList = []
  for (const p of placed) {
    const got = back.get(p.x, p.y, p.z)
    if (got !== p.id) { lost++; if (lostList.length < 8) lostList.push(`${p.name}(${p.id}) -> ${got}`) }
  }
  check('原生格式无方块丢失', lost === 0, lost ? `${lost} 个丢失: ${lostList.join(', ')}` : `${placed.length} 种全部保留`)

  const buf = await exportSchematic(w, 'allblocks')
  const { world: sb } = await importSchematic(buf instanceof Uint8Array ? buf : new Uint8Array(buf), 'all.schem')
  let slost = 0
  const slostList = []
  for (const p of placed) {
    const got = sb.get(p.x, p.y, p.z)
    if (got !== p.id) { slost++; if (slostList.length < 12) slostList.push(`${p.name}(${p.id})→${got}${got ? '(' + (BLOCK_BY_ID[got]?.name ?? '?') + ')' : ''}`) }
  }
  check('Sponge 格式无方块丢失', slost === 0,
    slost ? `${slost}/${placed.length} 丢失/改变: ${slostList.join(', ')}` : `${placed.length} 种全部保留`)
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail ? 1 : 0)
