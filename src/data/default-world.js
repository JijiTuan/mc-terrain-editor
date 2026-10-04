/**
 * default-world.js — 程序化生成的默认世界
 *
 * 打开编辑器就有东西可看、可编辑，比空白世界友好得多。
 * 用一个固定的种子生成，保证每次打开看到的是同一片地形（可预期）。
 */

import { VoxelWorld } from '../core/voxel-world.js'
import { generateTerrain, carveRiver, scatterOnSurface } from '../core/terrain.js'
import { resolveBlockId } from './blocks.js'

export function createDefaultWorld() {
  const W = 64, H = 48, D = 64
  const world = new VoxelWorld(W, H, D)

  const grass = resolveBlockId('grass_block')
  const dirt = resolveBlockId('dirt')
  const stone = resolveBlockId('stone')
  const water = resolveBlockId('water')
  const sand = resolveBlockId('sand')
  const log = resolveBlockId('oak_log')
  const leaves = resolveBlockId('oak_leaves')

  // 主体丘陵地形
  generateTerrain(world, {
    x1: 0, z1: 0, x2: W - 1, z2: D - 1,
    type: 'hills', baseY: 12, amplitude: 9, scale: 0.075,
    surface: grass, sub: dirt, base: stone, seed: 20261004,
  })

  // 一条贯穿的河，给场景一个视觉焦点
  carveRiver(world, {
    x1: 0, z1: 0, x2: W - 1, z2: D - 1,
    direction: 'x', width: 9, depth: 4, water,
  })

  // 河岸铺沙，避免水面直接切在草皮上显得生硬
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) {
      const h = world.surfaceHeight(x, z)
      if (h < 0) continue
      const nearWater = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
      ].some(([dx, dz]) => world.get(x + dx, h, z + dz) === water)
      if (nearWater && world.get(x, h, z) === grass) world.set(x, h, z, sand)
    }
  }

  // 树：只长在草地上，且避开刚铺过沙的河岸
  scatterOnSurface(world, {
    x1: 0, z1: 0, x2: W - 1, z2: D - 1,
    block: log, density: 0.012, onTop: grass, seed: 777,
  })

  // 给树加个简单的树冠
  for (let z = 1; z < D - 1; z++) {
    for (let x = 1; x < W - 1; x++) {
      for (let y = 1; y < H - 1; y++) {
        if (world.get(x, y, z) !== log) continue
        if (world.get(x, y + 1, z) !== 0) continue
        // 只有柱子顶端才长树冠
        for (let dy = 0; dy <= 2; dy++) {
          const r = dy === 2 ? 1 : 2
          for (let ox = -r; ox <= r; ox++) {
            for (let oz = -r; oz <= r; oz++) {
              if (Math.abs(ox) === r && Math.abs(oz) === r && dy === 2) continue
              const px = x + ox, py = y + dy, pz = z + oz
              if (world.get(px, py, pz) === 0) world.set(px, py, pz, leaves)
            }
          }
        }
      }
    }
  }

  world.revision++
  return world
}
