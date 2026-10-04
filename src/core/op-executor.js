/**
 * op-executor.js — 把 AI 返回的结构化 op 翻译成世界写入
 *
 * 关键点：预览与执行走同一条代码路径。
 * previewProgram() 用 dry-run 模式（写到一个世界副本上）得出精确的影响范围，
 * applyProgram() 直接写真实世界。二者几何一致，不会出现「预览说改100格、执行改了500格」。
 */

import { AIR, BLOCK_BY_ID, resolveBlockId } from '../data/blocks.js'
import { fillRegion, clearRegion, replaceInRegion } from './regions.js'
import { generateTerrain, carveRiver, applyLayer, scatterOnSurface } from './terrain.js'
import { VoxelWorld } from './voxel-world.js'

const OPS_WITH_REGION = new Set(['fill', 'clear', 'replace', 'terrain', 'river', 'layer', 'scatter'])

/**
 * 兜底方块 id。
 * 一律用名字去查表，不写裸数字 —— 裸数字和 blocks.js 的行序强耦合，
 * 一旦那里插入/调序就静默指向别的方块（历史上 river 的兜底就误指到了岩浆块）。
 */
const FALLBACK = {
  surface: resolveBlockId('grass_block', 4),
  sub: resolveBlockId('dirt', 3),
  base: resolveBlockId('stone', 1),
  water: resolveBlockId('water', 26),
  onTop: resolveBlockId('grass_block', 4),
}

/** 从 op 中提取区域，用于计算包围盒 */
export function opRegion(op) {
  if (!OPS_WITH_REGION.has(op.type)) return null
  return { x1: op.x1, y1: op.y1 ?? 0, z1: op.z1, x2: op.x2, y2: op.y2 ?? 255, z2: op.z2 }
}

/**
 * 执行单条 op，写入目标世界。
 * @returns {number} 改动方块数
 */
export function applyOp(world, op) {
  switch (op.type) {
    case 'fill':
      return fillRegion(world, { x1: op.x1, y1: op.y1, z1: op.z1, x2: op.x2, y2: op.y2, z2: op.z2 }, op.block)

    case 'clear':
      return clearRegion(world, { x1: op.x1, y1: op.y1, z1: op.z1, x2: op.x2, y2: op.y2, z2: op.z2 })

    case 'replace':
      return replaceInRegion(world, { x1: op.x1, y1: op.y1, z1: op.z1, x2: op.x2, y2: op.y2, z2: op.z2 }, op.from, op.to)

    case 'sphere':
      return fillSphere(world, op.cx, op.cy, op.cz, op.radius, op.block)

    case 'sphere_at_surface': {
      const h = world.surfaceHeight(op.cx, op.cz)
      const cy = h < 0 ? Math.floor(world.height / 2) : h + Math.round(op.radius * 0.3)
      return fillSphere(world, op.cx, cy, op.cz, op.radius, op.block)
    }

    case 'cylinder':
      return fillCylinder(world, op.cx, op.cy, op.cz, op.radius, op.height, op.block)

    case 'terrain':
      return generateTerrain(world, {
        x1: op.x1, z1: op.z1, x2: op.x2, z2: op.z2,
        type: op.terrainType,
        baseY: op.baseY, amplitude: op.amplitude, scale: op.scale,
        surface: op.surface ?? FALLBACK.surface, sub: op.sub ?? FALLBACK.sub, base: op.base ?? FALLBACK.base, seed: op.seed ?? 0,
      })

    case 'river':
      return carveRiver(world, {
        x1: op.x1, z1: op.z1, x2: op.x2, z2: op.z2,
        direction: op.direction, width: op.width, depth: op.depth, water: op.water ?? FALLBACK.water,
      })

    case 'layer':
      return applyLayer(world, {
        x1: op.x1, z1: op.z1, x2: op.x2, z2: op.z2,
        height: op.height, top: op.top ?? FALLBACK.surface, middle: op.middle ?? FALLBACK.sub, bottom: op.bottom ?? FALLBACK.base,
      })

    case 'scatter':
      return scatterOnSurface(world, {
        x1: op.x1, z1: op.z1, x2: op.x2, z2: op.z2,
        block: op.block, density: op.density, onTop: op.onTop ?? FALLBACK.onTop, seed: op.seed ?? 0,
      })

    default:
      throw new Error(`执行器不支持的操作：${op.type}`)
  }
}

function fillSphere(world, cx, cy, cz, radius, block) {
  const r2 = radius * radius
  let changed = 0
  const ri = Math.ceil(radius)
  for (let y = cy - ri; y <= cy + ri; y++) {
    for (let z = cz - ri; z <= cz + ri; z++) {
      for (let x = cx - ri; x <= cx + ri; x++) {
        const dx = x - cx, dy = y - cy, dz = z - cz
        if (dx * dx + dy * dy + dz * dz <= r2) {
          if (world.set(x, y, z, block)) changed++
        }
      }
    }
  }
  return changed
}

function fillCylinder(world, cx, cy, cz, radius, height, block) {
  const r2 = radius * radius
  let changed = 0
  const ri = Math.ceil(radius)
  for (let y = cy; y < cy + height; y++) {
    for (let z = cz - ri; z <= cz + ri; z++) {
      for (let x = cx - ri; x <= cx + ri; x++) {
        const dx = x - cx, dz = z - cz
        if (dx * dx + dz * dz <= r2) {
          if (world.set(x, y, z, block)) changed++
        }
      }
    }
  }
  return changed
}

/**
 * 在真实世界副本上 dry-run，得到精确的预览信息。
 * 返回被影响坐标的扁平数组 [x,y,z, x,y,z, ...]（可用于高亮）与统计。
 */
export function previewProgram(world, ops) {
  const shadow = new VoxelWorld(world.width, world.height, world.depth, world.snapshot())
  const affected = []
  let totalChanges = 0
  const perOp = []

  for (const op of ops) {
    const before = shadow.snapshot()
    let changes = 0
    try {
      changes = applyOp(shadow, op)
    } catch (err) {
      perOp.push({ op, changes: 0, error: err.message })
      continue
    }
    // 逐格比较找出真正变化的坐标
    let diff = 0
    for (let i = 0; i < shadow.data.length; i++) {
      if (shadow.data[i] !== before[i]) {
        diff++
        if (affected.length < 60000) {
          const y = Math.floor(i / (world.depth * world.width))
          const rem = i - y * world.depth * world.width
          const z = Math.floor(rem / world.width)
          const x = rem - z * world.width
          affected.push(x, y, z)
        }
      }
    }
    perOp.push({ op, changes: diff })
    totalChanges += diff
  }

  const bounds = computeBounds(affected)
  const blocks = summarizeBlocks(shadow, world)
  return { affected, totalChanges, perOp, bounds, blocks, shadow }
}

function computeBounds(flat) {
  if (!flat.length) return null
  let x1 = Infinity, y1 = Infinity, z1 = Infinity, x2 = -Infinity, y2 = -Infinity, z2 = -Infinity
  for (let i = 0; i < flat.length; i += 3) {
    const x = flat[i], y = flat[i + 1], z = flat[i + 2]
    if (x < x1) x1 = x
    if (y < y1) y1 = y
    if (z < z1) z1 = z
    if (x > x2) x2 = x
    if (y > y2) y2 = y
    if (z > z2) z2 = z
  }
  return { x1, y1, z1, x2, y2, z2 }
}

/** 预览中涉及到的方块种类统计，用于操作卡片展示 */
function summarizeBlocks(shadow, world) {
  const counts = new Map()
  for (let i = 0; i < shadow.data.length; i++) {
    const id = shadow.data[i]
    if (id === AIR) continue
    if (id === world.data[i]) continue
    counts.set(id, (counts.get(id) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, n]) => ({ id, name: BLOCK_BY_ID[id]?.name ?? `#${id}`, label: BLOCK_BY_ID[id]?.label ?? `#${id}`, count: n }))
}

/** 直接作用于真实世界（调用方负责先拍快照交给撤销栈） */
export function applyProgram(world, ops) {
  let total = 0
  for (const op of ops) total += applyOp(world, op)
  return total
}
