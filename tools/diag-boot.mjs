/**
 * 定位启动崩溃：把 boot() 里每一步单独跑一遍，看哪一步、哪个表达式抛错。
 * 这是「不猜、直接量」的做法 —— 报错信息只说了 destructure，没说在哪一行。
 */
import { createDefaultWorld } from '../src/data/default-world.js'
import { previewProgram, applyProgram } from '../src/core/op-executor.js'
import { validateProgram } from '../src/core/op-schema.js'
import { VoxelWorld } from '../src/core/voxel-world.js'

const world = createDefaultWorld()
console.log('世界:', world.width, world.height, world.depth, 'revision=', world.revision)

// --- 1. previewProgram 空 ops ---
try {
  const p = previewProgram(world, [])
  console.log('[1] 空 ops preview ->', JSON.stringify({ totalChanges: p.totalChanges, bounds: p.bounds, affectedLen: p.affected.length }))
} catch (e) {
  console.log('[1] 空 ops preview 抛错:', e.message)
}

// --- 2. shadow 构造会不会改到原世界 ---
const revBefore = world.revision
try {
  const shadow = new VoxelWorld(world.width, world.height, world.depth, world.snapshot())
  console.log('[2] shadow 构造 OK, shadow.revision =', shadow.revision, ' / 原世界 revision 变化 =', world.revision - revBefore)
} catch (e) {
  console.log('[2] shadow 构造抛错:', e.message)
}

// --- 3. 正式 program ---
const program = [
  { type: 'terrain', terrainType: 'hills', from: [2, 0, 2], to: [24, 30, 24], block: 'grass_block', seed: 12345, amplitude: 5 },
  { type: 'river', from: [2, 0, 2], to: [24, 4, 24], block: 'water', width: 3, depth: 2, seed: 999 },
  { type: 'sphere', center: [10, 12, 10], radius: 3, block: 'oak_log' },
  { type: 'layer', from: [2, 0, 2], to: [24, 3, 24], block: 'sand', thickness: 1 },
]

let v
try {
  v = validateProgram(program, world)
  console.log('[3] validate ->', JSON.stringify({ ok: v.ok, error: v.error, warnings: v.warnings, opsLen: v.ops?.length }))
} catch (e) {
  console.log('[3] validate 抛错:', e.message)
}

if (v && v.ok) {
  try {
    const p = previewProgram(world, v.ops)
    console.log('[4] preview -> totalChanges =', p.totalChanges, ' bounds =', JSON.stringify(p.bounds), ' affectedLen =', p.affected.length)
  } catch (e) {
    console.log('[4] preview 抛错:', e.message, '\n', e.stack)
  }

  const w2 = createDefaultWorld()
  try {
    const applied = applyProgram(w2, v.ops)
    console.log('[5] apply ->', applied)
  } catch (e) {
    console.log('[5] apply 抛错:', e.message)
  }
} else if (v) {
  console.log('[3b] 校验未通过，逐条看:')
  for (const op of program) {
    const one = validateProgram([op], world)
    console.log('   ', op.type, '->', one.ok ? 'OK' : 'FAIL: ' + one.error)
  }
}
