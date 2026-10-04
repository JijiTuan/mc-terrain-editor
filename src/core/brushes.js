/**
 * brushes.js — 笔刷形状与笔刷操作
 *
 * 全部笔刷都是「纯函数式」的：给定世界 + 参数，遍历出受影响坐标集合。
 * 拆成两步（先收集受影响坐标 → 再统一写入）的原因：
 *   1. AI 操作预览需要「只算不写」的高亮范围；
 *   2. 3D 视口要在悬停时实时显示笔刷轮廓，同样只算不写。
 */

export const BrushShape = {
  SPHERE: 'sphere',
  CUBE: 'cube',
  CYLINDER: 'cylinder',
  CONE: 'cone',
  DIAMOND: 'diamond',
}

export const BrushMode = {
  PLACE: 'place',     // 放置
  REPLACE: 'replace', // 替换（只替换指定的目标方块）
  ERASE: 'erase',     // 删除
  RAISE: 'raise',     // 抬升
  LOWER: 'lower',     // 下沉
  SMOOTH: 'smooth',   // 平滑
}

export const SHAPE_LABELS = {
  [BrushShape.SPHERE]: '球体',
  [BrushShape.CUBE]: '立方体',
  [BrushShape.CYLINDER]: '圆柱',
  [BrushShape.CONE]: '圆锥',
  [BrushShape.DIAMOND]: '菱形',
}

export const MODE_LABELS = {
  [BrushMode.PLACE]: '放置',
  [BrushMode.REPLACE]: '替换',
  [BrushMode.ERASE]: '删除',
  [BrushMode.RAISE]: '抬升',
  [BrushMode.LOWER]: '下沉',
  [BrushMode.SMOOTH]: '平滑',
}

/**
 * 判断相对坐标 (dx, dy, dz) 是否落在形状内。
 * r 为半径（格），单位为方块数；形状以原点为中心。
 */
export function inShape(shape, dx, dy, dz, r) {
  switch (shape) {
    case BrushShape.SPHERE:
      return dx * dx + dy * dy + dz * dz <= r * r
    case BrushShape.CUBE:
      return Math.abs(dx) <= r && Math.abs(dy) <= r && Math.abs(dz) <= r
    case BrushShape.CYLINDER:
      return dx * dx + dz * dz <= r * r && Math.abs(dy) <= r
    case BrushShape.CONE: {
      // 顶点朝上：半径随 y 从 0 线性增长到 r
      const t = (dy + r) / (2 * r) // 0 底部 → 1 顶部
      const maxR = r * (1 - t)
      return dx * dx + dz * dz <= maxR * maxR && Math.abs(dy) <= r
    }
    case BrushShape.DIAMOND:
      return Math.abs(dx) + Math.abs(dy) + Math.abs(dz) <= r
    default:
      return false
  }
}

/**
 * 收集笔刷影响范围内的坐标。
 * @param {import('./voxel-world.js').VoxelWorld} world
 * @param {{x:number,y:number,z:number}} center
 * @param {{size:number, shape:string}} opts
 * @returns {Array<{x:number,y:number,z:number,id:number}>}
 */
export function collectBrushCells(world, center, { size, shape }) {
  const r = Math.max(0, (size - 1) / 2)
  const ri = Math.ceil(r)
  const cells = []
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dz = -ri; dz <= ri; dz++) {
      for (let dx = -ri; dx <= ri; dx++) {
        if (!inShape(shape, dx, dy, dz, r)) continue
        const x = center.x + dx, y = center.y + dy, z = center.z + dz
        if (!world.inBounds(x, y, z)) continue
        cells.push({ x, y, z, id: world.get(x, y, z) })
      }
    }
  }
  return cells
}

/**
 * 依据 mode 计算某个坐标应当被写成什么值。
 * 返回 null 表示该格不变。
 *
 * @param {import('./voxel-world.js').VoxelWorld} world
 * @param {{x,y,z,id}} cell
 * @param {object} p 笔刷参数
 * @param {number} p.mode
 * @param {number} p.blockId    主方块（放置 / 替换目标 / 抬升的填充材料）
 * @param {number} [p.targetId] 替换模式下的目标方块
 * @param {number} [p.surfaceBlockId]
 */
export function resolveBrushValue(world, cell, p) {
  const { x, y, z, id } = cell
  switch (p.mode) {
    case BrushMode.PLACE:
      return id === p.blockId ? null : p.blockId
    case BrushMode.REPLACE:
      if (p.targetId != null && id !== p.targetId) return null
      return id === p.blockId ? null : p.blockId
    case BrushMode.ERASE:
      return id === 0 ? null : 0
    case BrushMode.RAISE:
    case BrushMode.LOWER: {
      // 只作用于地表那一格，模拟推土机效果
      const dir = p.mode === BrushMode.RAISE ? 1 : -1
      const above = world.get(x, y + 1, z)
      const below = world.get(x, y - 1, z)
      // 只在「暴露在空气下的表面方块」上操作
      if (id === 0 || above !== 0) return null
      if (dir === 1) return p.blockId != null ? p.blockId : null
      // 下沉：把当前方块删掉，让上面的落下来（简化为直接删除）
      return below === 0 && y === 0 ? null : 0
    }
    case BrushMode.SMOOTH: {
      // 3x3 邻域高度平均，把尖角削平
      if (id === 0) return null
      const h = world.surfaceHeight(x, z)
      if (h < 0) return null
      let sum = 0, n = 0
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          const sh = world.surfaceHeight(x + ox, z + oz)
          if (sh >= 0) { sum += sh; n++ }
        }
      }
      if (n === 0) return null
      const target = Math.round(sum / n)
      if (y > target) return 0
      if (y === target) return p.surfaceBlockId ?? p.blockId
      return null
    }
    default:
      return null
  }
}

/**
 * 应用一次笔刷（写入世界）。返回改动方块数。
 * @returns {number}
 */
export function applyBrush(world, center, params) {
  const cells = collectBrushCells(world, center, params)
  let changed = 0
  const writes = []
  for (const cell of cells) {
    const v = resolveBrushValue(world, cell, params)
    if (v !== null) writes.push([cell, v])
  }
  for (const [cell, v] of writes) {
    if (world.set(cell.x, cell.y, cell.z, v)) changed++
  }
  return changed
}

/** 只计算笔刷会影响的坐标（供悬停高亮与 AI 预览用，不写世界） */
export function previewBrush(world, center, params) {
  const cells = collectBrushCells(world, center, params)
  const affected = []
  for (const cell of cells) {
    const v = resolveBrushValue(world, cell, params)
    if (v !== null) affected.push(cell.x, cell.y, cell.z)
  }
  return affected
}

/**
 * 沿一条线插值应用笔刷，避免鼠标快速拖动时出现断点。
 * @param {{x,y,z}} from
 * @param {{x,y,z}} to
 */
export function applyBrushStroke(world, from, to, params) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  const steps = Math.max(1, Math.ceil(dist / Math.max(1, params.spacing ?? 1)))
  let changed = 0
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const c = {
      x: Math.round(from.x + (to.x - from.x) * t),
      y: Math.round(from.y + (to.y - from.y) * t),
      z: Math.round(from.z + (to.z - from.z) * t),
    }
    changed += applyBrush(world, c, params)
  }
  return changed
}
