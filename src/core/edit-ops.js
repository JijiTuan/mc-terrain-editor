/**
 * edit-ops.js — 最小编辑单位（单格放置 / 单格删除）
 *
 * 为什么单独成一个模块，而不是让 interaction.js 直接写世界：
 *
 *   1. 撤销栈只有一个入口（App.commit），交互层不该知道 CommandBus 的存在。
 *      交互层算出「要动哪一格」，App 负责「怎么提交」，职责边界清晰。
 *   2. 单格编辑是 Blockbench 模式的最小单位，也是将来「按住左键连续放置」
 *      （Blockbench 的拖拽刷格）唯一需要复用的地方 —— 放这里改一次就够。
 *   3. 返回值统一是「实际改动格数」，这样 App.commit 能正确判断 skipped。
 *
 * 注意：这里的函数会直接改世界，必须由 App.commit 包在命令里执行，
 * 否则改动不会进撤销栈，用户会觉得「撤销撤不掉刚才点的那个方块」。
 */

import { AIR } from '../data/blocks.js'

/**
 * 在 (x,y,z) 放置一个方块。
 * @returns {number} 实际改动格数（0 表示该格本来就是目标方块，或坐标越界）
 */
export function placeBlock(world, x, y, z, blockId) {
  if (blockId === AIR) return 0
  if (!world.inBounds(x, y, z)) return 0
  return world.set(x, y, z, blockId) ? 1 : 0
}

/**
 * 删除 (x,y,z) 的方块。
 * @returns {number} 实际改动格数（0 表示该格本来就是空气，或坐标越界）
 */
export function eraseBlock(world, x, y, z) {
  if (!world.inBounds(x, y, z)) return 0
  return world.set(x, y, z, AIR) ? 1 : 0
}
