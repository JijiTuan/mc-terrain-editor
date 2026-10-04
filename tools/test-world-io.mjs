// 存档窗口 导入/导出 往返测试
//
// 核心断言：**逐格完全一致**。不比对「大概对」，不比对「方块数接近」。
// 存档改写是最不能出错的一类操作 —— 用户的建筑一旦被写坏就没有回头路。
//
// 反向对照：故意把位宽算错（用 4 位装 17 项调色板），必须能测出来。
import { VoxelWorld } from '../src/core/voxel-world.js'
import { parseNbt } from '../src/io/nbt.js'
import {
  parseRegion, readChunkNbt, writeRegion, serializeChunkNbt,
  readSectionIndices, sectionIndex, bitsForPalette,
  packBlockStates, unpackBlockStates as m_unpack,
} from '../src/io/anvil.js'
import { importWorldWindow, buildChunkReplacements, serializeNbtRoot, CHUNK } from '../src/io/world-io.js'

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

/** 造一个可控的假存档：给定 chunk → section 数据 */
function makeFakeChunk({ cx, cz, sections }) {
  const root = {
    DataVersion: 3465,
    xPos: cx, zPos: cz,
    Status: 'minecraft:full',
    sections,
    // 塞一些「我们不该懂但必须保留」的字段
    block_entities: [{ id: 'minecraft:chest', x: 3, y: 70, z: 5, KeepPacked: 0 }],
    Heightmaps: { MOTION_BLOCKING: new BigInt64Array([1n, 2n, 3n]) },
    InhabitedTime: 12345n,
  }
  return { root, rootName: '' }
}

/** 造一个 section：用调色板铺满 4096 格 */
function makeSection(absY, paletteNames, fill) {
  const palette = paletteNames.map((n) => ({ Name: `minecraft:${n}` }))
  const indices = new Uint16Array(4096)
  for (let i = 0; i < 4096; i++) indices[i] = fill ? fill(i) : 0
  const bits = bitsForPalette(palette.length)
  return {
    Y: absY,
    block_states: { palette, data: packBlockStates(indices, bits) },
    biomes: { palette: ['minecraft:plains'] },
  }
}

console.log('\n[1] 单 chunk 单 section 往返')
{
  // 造一个 chunk：y=4（绝对 Y=64）那一 section，ly=1 石头 / 2 泥土 / 3 草，ly=0 与 4+ 空气
  const names = ['air', 'stone', 'dirt', 'grass_block']
  const sec = makeSection(4, names, (i) => {
    const ly = i >> 8
    if (ly > 3) return 0
    if (ly === 3) return 3   // 草方块
    if (ly === 2) return 2   // 泥土
    if (ly === 1) return 1   // 石头
    return 0                 // ly=0 是空气，不能落进上面任何一支
  })

  const chunkBlob = serializeNbtRoot(makeFakeChunk({ cx: 0, cz: 0, sections: [sec] }).root, '')
  const packed = await serializeChunkNbt(chunkBlob)
  const mca = writeRegion(null, new Map([['0,0', packed]]))

  // 用 importWorldWindow 读回来：窗口取 1 个 chunk、Y 从 64 起 16 格
  const { world, report } = await importWorldWindow({
    readRegion: async (rx, rz) => (rx === 0 && rz === 0 ? mca : null),
    minChunkX: 0, minChunkZ: 0, chunksX: 1, chunksZ: 1,
    minY: 64, height: 16,
  })

  check('世界尺寸 = 1 chunk', world.width === 16 && world.depth === 16, `${world.width}×${world.height}×${world.depth}`)

  // 手工核对：section 的 ly=0..3 对应世界 y=0..3
  // 原数据 ly=3 → 草方块(3)，ly=2 → 泥土(2)，ly=1 → 石头(1)，ly=0 → 空气
  const { BLOCK_BY_NAME } = await import('../src/data/blocks.js')
  const grass = BLOCK_BY_NAME.get('grass_block').id
  const dirt = BLOCK_BY_NAME.get('dirt').id
  const stone = BLOCK_BY_NAME.get('stone').id

  let bad = []
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const expect = [[0, 0], [1, stone], [2, dirt], [3, grass]]
      for (const [y, want] of expect) {
        const got = world.get(lx, y, lz)
        if (got !== want) bad.push(`(${lx},${y},${lz}) 期望 ${want} 实得 ${got}`)
      }
    }
  }
  check('逐格与原 NBT 一致（256×4 格）', bad.length === 0, bad.length ? bad.slice(0, 3).join(' | ') : '0 差异')
  check('报告里的方块总数合理', report.totalBlocks === 16 * 16 * 3, String(report.totalBlocks))
}

console.log('\n[2] 多调色板 / 高位宽（逼出位打包 bug 的用例）')
{
  // 用 20 种方块 → bits=5，会触发「不跨 long 边界」的逻辑
  const names = ['air', ...Array.from({ length: 19 }, (_, i) => `block_${i}`)]
  // 这些名字编辑器不认识，会被映射成空气 —— 改用真实方块的组合
  const { BLOCK_BY_ID } = await import('../src/data/blocks.js')
  const realNames = BLOCK_BY_ID.slice(0, 20).map((b) => b.name)
  const sec = makeSection(0, realNames, (i) => i % 20)

  const blob = serializeNbtRoot(makeFakeChunk({ cx: 0, cz: 0, sections: [sec] }).root, '')
  const mca = writeRegion(null, new Map([['0,0', await serializeChunkNbt(blob)]]))

  const { world } = await importWorldWindow({
    readRegion: async () => mca,
    minChunkX: 0, minChunkZ: 0, chunksX: 1, chunksZ: 1,
    minY: 0, height: 16,
  })

  // 逐格核对：section 内 index i 对应 lx=i&15, ly=(i>>8)&15, lz=(i>>4)&15
  let bad = 0, firstBad = null
  for (let i = 0; i < 4096; i++) {
    const lx = i & 15, lz = (i >> 4) & 15, ly = (i >> 8) & 15
    const wantId = BLOCK_BY_ID[i % 20].id
    const got = world.get(lx, ly, lz)
    if (got !== wantId) { bad++; if (!firstBad) firstBad = `i=${i} (${lx},${ly},${lz}) 期望 ${wantId} 实得 ${got}` }
  }
  check('位宽 5 的 4096 格全部正确', bad === 0, bad ? `${bad} 格错，首个：${firstBad}` : '0 差异')
}

console.log('\n[3] 写回：只改方块，其它字段必须原样保留')
{
  const names = ['air', 'stone']
  const sec = makeSection(4, names, () => 0)  // 全空气
  const fake = makeFakeChunk({ cx: 0, cz: 0, sections: [sec] })
  const blob = serializeNbtRoot(fake.root, '')
  const mca = writeRegion(null, new Map([['0,0', await serializeChunkNbt(blob)]]))

  // 先导入
  const { world } = await importWorldWindow({
    readRegion: async () => mca,
    minChunkX: 0, minChunkZ: 0, chunksX: 1, chunksZ: 1,
    minY: 64, height: 16,
  })

  // 在世界里铺一层石头
  const { BLOCK_BY_NAME } = await import('../src/data/blocks.js')
  const stone = BLOCK_BY_NAME.get('stone').id
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) world.set(x, 0, z, stone)

  // 写回
  const replacements = await buildChunkReplacements({
    world,
    region: { x1: 0, y1: 0, z1: 0, x2: 15, y2: 15, z2: 15 },
    minChunkX: 0, minChunkZ: 0, minY: 64,
    readChunk: async () => ({ root: fake.root, rootName: '' }),
  })

  check('产出 1 个 chunk 替换', replacements.size === 1, `${replacements.size} 个`)

  // 解回来看字段有没有丢
  const outMca = writeRegion(mca, replacements)
  const entries = parseRegion(outMca)
  const { root } = await readChunkNbt(entries[0])

  check('block_entities 保留', Array.isArray(root.block_entities) && root.block_entities.length === 1,
    JSON.stringify(root.block_entities?.[0]?.id))
  check('Heightmaps 保留', !!root.Heightmaps && root.Heightmaps.MOTION_BLOCKING?.length === 3,
    `len=${root.Heightmaps?.MOTION_BLOCKING?.length}`)
  check('InhabitedTime 保留（bigint）', root.InhabitedTime === 12345n, String(root.InhabitedTime))
  check('DataVersion 保留', root.DataVersion === 3465, String(root.DataVersion))
  check('Status 保留', root.Status === 'minecraft:full', String(root.Status))

  // 方块真的改了吗
  const outEntries = parseRegion(outMca)
  const chunk = await readChunkNbt(outEntries[0])
  const outSec = chunk.root.sections.find((s) => s.Y === 4)
  const { indices, palette } = readSectionIndices(outSec.block_states)
  const stoneIdx = palette.findIndex((p) => (p?.Name ?? '').includes('stone'))
  const y0All = Array.from({ length: 256 }, (_, i) => indices[sectionIndex(i & 15, 0, i >> 4)])
  check('写回的 y=0 层全是石头', y0All.every((v) => v === stoneIdx), `stoneIdx=${stoneIdx}`)

  const y5 = Array.from({ length: 256 }, (_, i) => indices[sectionIndex(i & 15, 5, i >> 4)])
  check('没碰的 y=5 层仍是空气', y5.every((v) => palette[v]?.Name === 'minecraft:air'), palette[y5[0]]?.Name)
}

console.log('\n[4] 反向对照：位宽算错必须被检出')
{
  // 真实的损坏场景：写的时候位宽算错，读的时候位宽也对不上，
  // 于是数据被「静默截断」—— 索引值被掩码吃掉高位，读出来是另一个方块，不报错。
  // 这个对照要证明：我们的往返测试确实能捕捉到这类静默错误。
  const indices = new Uint16Array(4096)
  for (let i = 0; i < 4096; i++) indices[i] = i % 17   // 需要 5 位（0..16）
  indices[0] = 16
  indices[1] = 15

  const wrong = packBlockStates(indices, 4)     // 故意用 4 位
  const readWrong = m_unpack(wrong, 4096, 4)
  const bad = []
  for (let i = 0; i < 4096; i++) if (readWrong[i] !== indices[i]) bad.push(i)
  check('用 4 位装 0..16 会静默截断（证明测试有区分力）', bad.length > 0,
    bad.length ? `${bad.length} 格被截断，首个 i=${bad[0]}（${indices[bad[0]]} → ${readWrong[bad[0]]}）` : '竟然没截断，用例无效')

  const right = m_unpack(packBlockStates(indices, 5), 4096, 5)
  check('正确位宽 5 往返无误', right.every((v, i) => v === indices[i]))
}

console.log('\n[5] 负坐标 chunk（-1 属于 region -1）')
{
  const sec = makeSection(0, ['air', 'stone'], (i) => (((i >> 8) & 15) < 4 ? 1 : 0))
  const blob = serializeNbtRoot(makeFakeChunk({ cx: -1, cz: 0, sections: [sec] }).root, '')
  // 关键：chunk -1 落在 region (-1,0) 里，且在该 region 内的**局部索引是 31**（不是 0）。
  // 这里必须按局部索引 31 放，否则测的是错误的文件布局。
  const mca = writeRegion(null, new Map([['31,0', await serializeChunkNbt(blob)]]))

  const calls = []
  const { world } = await importWorldWindow({
    readRegion: async (rx, rz) => { calls.push(`${rx},${rz}`); return (rx === -1 && rz === 0) ? mca : null },
    minChunkX: -1, minChunkZ: 0, chunksX: 1, chunksZ: 1,
    minY: 0, height: 16,
  })
  check('chunk -1 请求的是 region (-1,0)', calls[0] === '-1,0', calls.join(' | '))
  check('负数 region 里的 chunk 也能读出来', world.stats().solid > 0, `${world.stats().solid} 格`)
}

console.log('\n[6] 空 chunk / 缺 region 不炸')
{
  const { world, report } = await importWorldWindow({
    readRegion: async () => null,   // 一个 region 文件都没有
    minChunkX: 0, minChunkZ: 0, chunksX: 2, chunksZ: 2,
    minY: 0, height: 16,
  })
  check('region 全缺失时返回空世界而非崩溃', world.stats().solid === 0, `${world.width}×${world.height}×${world.depth}`)
  check('也不该报 unsupported', report.unsupported.length === 0, report.unsupported.join('; ').slice(0, 80))
}

console.log('\n[7] 窗口高度裁剪（section 跨界不能越界写）')
{
  // section Y=4 → 绝对 64..79。窗口只要 70..75，上下都要裁
  const sec = makeSection(4, ['air', 'stone'], (i) => (((i >> 8) & 15) === 0 ? 1 : 0))
  const blob = serializeNbtRoot(makeFakeChunk({ cx: 0, cz: 0, sections: [sec] }).root, '')
  const mca = writeRegion(null, new Map([['0,0', await serializeChunkNbt(blob)]]))

  const { world } = await importWorldWindow({
    readRegion: async () => mca,
    minChunkX: 0, minChunkZ: 0, chunksX: 1, chunksZ: 1,
    minY: 70, height: 6,
  })
  check('窗口高度正确', world.height === 6, String(world.height))
  // 石头在 section 的 ly=0 → 绝对 Y=64，落在窗口下方，应被裁掉
  check('窗口外的方块被裁掉（没越界写进来）', world.stats().solid === 0, `${world.stats().solid} 格`)
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
