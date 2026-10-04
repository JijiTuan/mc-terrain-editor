/**
 * scatter 反向对照：确认「0 改动」不是因为 scatter 坏了，而是因为上层被 layer 换成了沙子。
 * 做法：同一区域、同一 seed，跑两次 —— 一次前面加 layer（换成沙），一次不加。
 * 如果前者 0、后者非 0，就证明 onTop 过滤是生效的，而不是功能失效。
 */
import { createDefaultWorld } from '../src/data/default-world.js'
import { validateProgram } from '../src/core/op-schema.js'
import { previewProgram, applyProgram } from '../src/core/op-executor.js'
import { VoxelWorld } from '../src/core/voxel-world.js'
import { BLOCK_BY_ID } from '../src/data/blocks.js'

function run(ops, label) {
  const world = createDefaultWorld()
  const v = validateProgram(ops, world)
  if (!v.ok) {
    console.log(`${label}: 校验失败 -> ${v.error}`)
    return
  }
  const preview = previewProgram(world, v.ops)
  const copy = new VoxelWorld(world.width, world.height, world.depth, world.snapshot())
  const applied = applyProgram(copy, v.ops)
  console.log(`${label}:`)
  console.log(`   perOp  =`, JSON.stringify(v.ops.map((o, i) => ({ [o.type]: preview.perOp[i].changes }))))
  console.log(`   preview=${preview.totalChanges}  apply=${applied}  一致=${preview.totalChanges === applied}`)
}

const scatterOnly = [
  { type: 'scatter', x1: 2, z1: 2, x2: 24, z2: 24, block: 'oak_log', density: 0.06, onTop: 'grass_block', seed: 555 },
]

const layerThenScatter = [
  { type: 'layer', x1: 2, z1: 2, x2: 24, z2: 24, height: 3, top: 'sand', middle: 'sandstone', bottom: 'stone' },
  { type: 'scatter', x1: 2, z1: 2, x2: 24, z2: 24, block: 'oak_log', density: 0.06, onTop: 'grass_block', seed: 555 },
]

// 第三种：layer 换成沙，scatter 也把 onTop 换成沙 —— 应该又能种上
const layerThenScatterOnSand = [
  { type: 'layer', x1: 2, z1: 2, x2: 24, z2: 24, height: 3, top: 'sand', middle: 'sandstone', bottom: 'stone' },
  { type: 'scatter', x1: 2, z1: 2, x2: 24, z2: 24, block: 'oak_log', density: 0.06, onTop: 'sand', seed: 555 },
]

console.log('grass_block id =', Object.entries(BLOCK_BY_ID).find(([, b]) => b.name === 'grass_block')?.[0])
console.log('sand id        =', Object.entries(BLOCK_BY_ID).find(([, b]) => b.name === 'sand')?.[0])
console.log('water id       =', Object.entries(BLOCK_BY_ID).find(([, b]) => b.name === 'water')?.[0])
console.log('magma_block id =', Object.entries(BLOCK_BY_ID).find(([, b]) => b.name === 'magma_block')?.[0])
console.log('')

run(scatterOnly, '[A] 只 scatter（地表是草）')
run(layerThenScatter, '[B] layer 换沙 后再 scatter(onTop=grass)')
run(layerThenScatterOnSand, '[C] layer 换沙 后再 scatter(onTop=sand)')

// 兜底方块是否指对了
console.log('\n=== river 兜底液体检查 ===')
const riverNoWater = [{ type: 'river', x1: 2, z1: 2, x2: 30, z2: 30, width: 4, depth: 3 }]
const w2 = createDefaultWorld()
const v2 = validateProgram(riverNoWater, w2)
console.log('校验:', v2.ok, v2.ok ? '' : v2.error)
if (v2.ok) {
  console.log('归一化后的 water id =', v2.ops[0].water, '(', BLOCK_BY_ID[v2.ops[0].water]?.name, ')')
}
