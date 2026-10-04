/**
 * terrain.js — 地形生成算法
 *
 * 值噪声实现（不依赖外部库，可复现：同 seed 必得同结果）。
 * 用双线性插值 + 多次倍频叠加得到分形噪声，足以表现山地、丘陵、河谷。
 */

/** 确定性伪随机：给定整数坐标 + seed 得到 [0,1) */
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function smoothstep(t) {
  return t * t * (3 - 2 * t)
}

/** 值噪声采样 */
export function valueNoise(x, y, seed = 0) {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = smoothstep(x - x0)
  const fy = smoothstep(y - y0)

  const v00 = hash2(x0, y0, seed)
  const v10 = hash2(x0 + 1, y0, seed)
  const v01 = hash2(x0, y0 + 1, seed)
  const v11 = hash2(x0 + 1, y0 + 1, seed)

  const a = v00 + (v10 - v00) * fx
  const b = v01 + (v11 - v01) * fx
  return a + (b - a) * fy
}

/** 分形噪声：多倍频叠加，返回 [0,1] */
export function fbm(x, y, { scale = 0.05, octaves = 4, persistence = 0.5, seed = 0 } = {}) {
  let amp = 1, freq = 1, sum = 0, norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * scale * freq, y * scale * freq, seed + i * 101) * amp
    norm += amp
    amp *= persistence
    freq *= 2
  }
  return sum / norm
}

/**
 * 计算某点相对地形高度偏移，返回 [0, 1] 的归一化高度。
 * type 决定噪声的形状变换。
 */
export function terrainHeightOffset(type, nx, nz, opts) {
  const n = fbm(nx, nz, opts) // 0..1
  switch (type) {
    case 'mountain':
      // 用幂次拉开高低差，造出尖峰与山脊
      return Math.pow(n, 1.8)
    case 'hills':
      return Math.pow(n, 1.1)
    case 'plateau': {
      // 阶梯化：把连续高度量化成台地
      const steps = 4
      return Math.floor(n * steps) / steps
    }
    case 'valley': {
      // 谷地：中间低两边高
      const cx = 0.5, cz = 0.5
      const d = Math.min(1, Math.hypot(nx / (opts.areaW || 1) - cx, nz / (opts.areaD || 1) - cz) * 2)
      return n * 0.3 + (1 - d) * 0.2
    }
    default:
      return n
  }
}

/**
 * 区域地形生成。
 * @returns {number} 改动方块数
 */
export function generateTerrain(world, {
  x1, z1, x2, z2, type = 'hills', baseY = 8, amplitude = 12,
  scale = 0.05, surface = 4, sub = 3, base = 1, seed = 0,
}) {
  const areaW = x2 - x1 + 1
  const areaD = z2 - z1 + 1
  let changed = 0

  for (let z = z1; z <= z2; z++) {
    for (let x = x1; x <= x2; x++) {
      const off = terrainHeightOffset(type, x, z, {
        scale, octaves: 4, persistence: 0.5, seed, areaW, areaD,
      })
      const top = Math.max(1, Math.min(world.height - 1, Math.round(baseY + off * amplitude)))

      for (let y = 0; y <= top; y++) {
        let id
        if (y === top) id = surface
        else if (y >= top - 2) id = sub
        else id = base
        if (world.set(x, y, z, id)) changed++
      }
      // 把被地形顶上去之后残留的悬空方块清掉
      for (let y = top + 1; y < world.height; y++) {
        if (world.get(x, y, z) !== 0 && world.set(x, y, z, 0)) changed++
      }
    }
  }
  return changed
}

/**
 * 在区域中挖河。地形高度由编辑器实时采样（而不是让模型猜），
 * 这是「AI 说需求、编辑器算几何」的一个典型分工。
 */
export function carveRiver(world, {
  x1, z1, x2, z2, direction = 'auto', width = 6, depth = 4, water = 1,
}) {
  const r = Math.max(1, Math.floor(width / 2))
  let changed = 0

  // 自动判定走向：区域较长的轴作为河流方向
  let dir = direction
  if (dir === 'auto') {
    dir = (x2 - x1) >= (z2 - z1) ? 'x' : 'z'
  }

  const a1 = dir === 'x' ? z1 : x1
  const a2 = dir === 'x' ? z2 : x2

  // 先算一遍河道中线（带轻微摆动，避免笔直）
  const centerAt = (t) => {
    const wobble = (fbm(t * 0.3, dir === 'x' ? 7 : 13, { scale: 0.15, octaves: 2, seed: 42 }) - 0.5) * r * 1.6
    return Math.round((a1 + a2) / 2 + wobble)
  }

  for (let t = Math.min(a1, a2); t <= Math.max(a1, a2); t++) {
    const c = centerAt(t)
    for (let o = -r; o <= r; o++) {
      const lateral = c + o
      const dist = Math.abs(o) / (r + 0.0001)
      // 河床越靠中间越深
      const localDepth = Math.max(1, Math.round(depth * (1 - dist * dist)))
      const x = dir === 'x' ? t : lateral
      const z = dir === 'x' ? lateral : t
      if (x < Math.min(x1, x2) || x > Math.max(x1, x2)) continue
      if (z < Math.min(z1, z2) || z > Math.max(z1, z2)) continue

      const h = world.surfaceHeight(x, z)
      if (h < 0) continue
      const bed = Math.max(0, h - localDepth)

      // 一次遍历完成「挖空 + 注水」，避免先写空气再写水导致同一格被计数两次
      for (let y = bed; y <= h; y++) {
        const next = y < h ? water : 0 // 河床顶面留空，其余灌水
        if (world.set(x, y, z, next)) changed++
      }
    }
  }
  return changed
}

/**
 * 按相对地表分层覆盖。
 */
export function applyLayer(world, { x1, z1, x2, z2, height = 4, top = 4, middle = 3, bottom = 1 }) {
  let changed = 0
  for (let z = z1; z <= z2; z++) {
    for (let x = x1; x <= x2; x++) {
      const h = world.surfaceHeight(x, z)
      if (h < 0) continue
      for (let d = 0; d < height; d++) {
        const y = h - d
        if (y < 0) break
        const id = d === 0 ? top : d < height - 1 ? middle : bottom
        if (world.set(x, y, z, id)) changed++
      }
    }
  }
  return changed
}

/**
 * 在地表随机散布柱状物（树、岩石）。
 */
export function scatterOnSurface(world, {
  x1, z1, x2, z2, block = 28, density = 0.05, onTop = 4, seed = 0,
}) {
  let changed = 0
  const area = (x2 - x1 + 1) * (z2 - z1 + 1)
  const target = Math.max(1, Math.round(area * density))
  for (let i = 0; i < target; i++) {
    const x = x1 + Math.floor(hash2(i, 1, seed) * (x2 - x1 + 1))
    const z = z1 + Math.floor(hash2(i, 2, seed) * (z2 - z1 + 1))
    const h = world.surfaceHeight(x, z)
    if (h < 0) continue
    if (onTop != null && world.get(x, h, z) !== onTop) continue
    const tall = 3 + Math.floor(hash2(i, 3, seed) * 4)
    for (let k = 1; k <= tall; k++) {
      if (world.set(x, h + k, z, block)) changed++
    }
  }
  return changed
}
