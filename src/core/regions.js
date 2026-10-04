/**
 * regions.js — 区域框选操作：填充、清空、地形生成、复制粘贴
 */

import { AIR } from '../data/blocks.js'

export function normalizeRegion(a, b) {
  return {
    x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x),
    y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y),
    z1: Math.min(a.z, b.z), z2: Math.max(a.z, b.z),
  }
}

export function regionVolume(r) {
  return (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1) * (r.z2 - r.z1 + 1)
}

/** 用单个方块填满区域 */
export function fillRegion(world, region, blockId) {
  let changed = 0
  for (let y = region.y1; y <= region.y2; y++) {
    for (let z = region.z1; z <= region.z2; z++) {
      for (let x = region.x1; x <= region.x2; x++) {
        if (world.set(x, y, z, blockId)) changed++
      }
    }
  }
  return changed
}

/** 清空区域（写入空气） */
export function clearRegion(world, region) {
  return fillRegion(world, region, AIR)
}

/** 把区域内的所有方块替换为另一种方块 */
export function replaceInRegion(world, region, fromId, toId) {
  let changed = 0
  for (let y = region.y1; y <= region.y2; y++) {
    for (let z = region.z1; z <= region.z2; z++) {
      for (let x = region.x1; x <= region.x2; x++) {
        if (world.get(x, y, z) === fromId && world.set(x, y, z, toId)) changed++
      }
    }
  }
  return changed
}

/** 空心化：只保留外壳 */
export function hollowRegion(world, region, blockId, thickness = 1) {
  let changed = 0
  for (let y = region.y1; y <= region.y2; y++) {
    for (let z = region.z1; z <= region.z2; z++) {
      for (let x = region.x1; x <= region.x2; x++) {
        const onShell =
          x < region.x1 + thickness || x > region.x2 - thickness ||
          y < region.y1 + thickness || y > region.y2 - thickness ||
          z < region.z1 + thickness || z > region.z2 - thickness
        if (onShell) {
          if (world.set(x, y, z, blockId)) changed++
        } else if (world.get(x, y, z) !== AIR) {
          if (world.set(x, y, z, AIR)) changed++
        }
      }
    }
  }
  return changed
}

/** 对区域应用一个 (x,y,z) → 新值的映射函数；返回 null 表示不变 */
export function mapRegion(world, region, fn) {
  let changed = 0
  for (let y = region.y1; y <= region.y2; y++) {
    for (let z = region.z1; z <= region.z2; z++) {
      for (let x = region.x1; x <= region.x2; x++) {
        const cur = world.get(x, y, z)
        const next = fn(x, y, z, cur)
        if (next !== null && next !== undefined && world.set(x, y, z, next)) changed++
      }
    }
  }
  return changed
}
