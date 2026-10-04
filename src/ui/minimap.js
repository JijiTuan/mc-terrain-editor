/**
 * minimap.js — 俯视图小地图
 *
 * 把世界沿 Y 轴投影：每一列取最高的非空方块，用它的颜色上色。
 * 这是 Minecraft 地图的常规做法 —— 好处是"一眼看出地形轮廓"，
 * 而且渲染成本只有 X*Z 而不是 X*Y*Z。
 *
 * 只在世界变更后重绘一次（dirty 标记），不参与每帧循环，
 * 因此对帧率影响可以忽略。
 */

import { BLOCK_BY_ID, AIR } from '../data/blocks.js'

let canvas = null
let ctx = null
let dirty = true
let cachedImage = null
let cachedSize = ''

export function markDirty() {
  dirty = true
}

/** 在帧循环里调用；只有 dirty 时才真正重绘 */
export function render(app) {
  if (!app || !app.world) return
  const el = app.el.minimap
  if (!el) return
  if (el !== canvas) {
    canvas = el
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    dirty = true
  }

  const { width: W, depth: D, height: H } = app.world
  const key = `${W}x${D}x${H}@${app.world.revision}`
  if (!dirty && cachedSize === key) return

  // 保持宽高比：把世界压进方形画布
  const size = canvas.width
  const scale = Math.min(size / W, size / D)
  const w = Math.max(1, Math.floor(W * scale))
  const h = Math.max(1, Math.floor(D * scale))
  const offX = Math.floor((size - w) / 2)
  const offY = Math.floor((size - h) / 2)

  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = '#0b0f16'
  ctx.fillRect(0, 0, size, size)

  // 逐列取地表方块上色
  const img = ctx.createImageData(w, h)
  for (let z = 0; z < D; z++) {
    const py = Math.min(h - 1, Math.floor(z * scale))
    for (let x = 0; x < W; x++) {
      const px = Math.min(w - 1, Math.floor(x * scale))
      let color = null
      for (let y = H - 1; y >= 0; y--) {
        const id = app.world.get(x, y, z)
        if (id !== AIR) {
          const def = BLOCK_BY_ID[id]
          // 高度做明暗调制：越高越亮，形成立体感
          const t = 0.55 + 0.45 * (y / Math.max(1, H - 1))
          const c = def.color
          color = [
            Math.round(((c >> 16) & 0xff) * t),
            Math.round(((c >> 8) & 0xff) * t),
            Math.round((c & 0xff) * t),
          ]
          break
        }
      }
      const o = (py * w + px) * 4
      if (color) {
        img.data[o] = color[0]
        img.data[o + 1] = color[1]
        img.data[o + 2] = color[2]
        img.data[o + 3] = 255
      } else {
        img.data[o + 3] = 0
      }
    }
  }

  const tmp = document.createElement('canvas')
  tmp.width = w
  tmp.height = h
  tmp.getContext('2d').putImageData(img, 0, 0)

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tmp, offX, offY, w, h)

  // 选区叠加
  if (app.selection) {
    const s = app.selection
    const x1 = offX + Math.min(s.x1, s.x2) * scale
    const z1 = offY + Math.min(s.z1, s.z2) * scale
    const x2 = offX + (Math.max(s.x1, s.x2) + 1) * scale
    const z2 = offY + (Math.max(s.z1, s.z2) + 1) * scale
    ctx.strokeStyle = '#ffd166'
    ctx.lineWidth = 1.5
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x1, z1, Math.max(2, x2 - x1), Math.max(2, z2 - z1))
    ctx.setLineDash([])
  }

  // AI 预览范围叠加
  if (app.pendingPreview?.preview?.bounds) {
    const b = app.pendingPreview.preview.bounds
    const x1 = offX + b.x1 * scale
    const z1 = offY + b.z1 * scale
    const x2 = offX + (b.x2 + 1) * scale
    const z2 = offY + (b.z2 + 1) * scale
    ctx.strokeStyle = '#a78bfa'
    ctx.lineWidth = 2
    ctx.strokeRect(x1, z1, Math.max(2, x2 - x1), Math.max(2, z2 - z1))
  }

  // 相机注视点标记
  if (app.controls?.target) {
    const cx = offX + app.controls.target.x * scale
    const cz = offY + app.controls.target.z * scale
    ctx.strokeStyle = '#4fd1c5'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cz, 4, 0, Math.PI * 2)
    ctx.stroke()
  }

  cachedSize = key
  dirty = false
}

/** 导出缩略图（工程列表里显示用） */
export function snapshotDataUrl(app, size = 96) {
  if (!app?.world) return null
  try {
    const W = app.world.width, D = app.world.depth, H = app.world.height
    const c = document.createElement('canvas')
    c.width = size; c.height = size
    const g = c.getContext('2d')
    g.fillStyle = '#0b0f16'
    g.fillRect(0, 0, size, size)

    const scale = Math.min(size / W, size / D)
    const w = Math.max(1, Math.floor(W * scale))
    const h = Math.max(1, Math.floor(D * scale))
    const ox = Math.floor((size - w) / 2)
    const oy = Math.floor((size - h) / 2)

    const img = g.createImageData(w, h)
    for (let z = 0; z < D; z++) {
      const py = Math.min(h - 1, Math.floor(z * scale))
      for (let x = 0; x < W; x++) {
        const px = Math.min(w - 1, Math.floor(x * scale))
        let color = null
        for (let y = H - 1; y >= 0; y--) {
          const id = app.world.get(x, y, z)
          if (id !== AIR) {
            const def = BLOCK_BY_ID[id]
            const t = 0.55 + 0.45 * (y / Math.max(1, H - 1))
            color = [Math.round(((def.color >> 16) & 0xff) * t), Math.round(((def.color >> 8) & 0xff) * t), Math.round((def.color & 0xff) * t)]
            break
          }
        }
        const o = (py * w + px) * 4
        if (color) { img.data[o] = color[0]; img.data[o + 1] = color[1]; img.data[o + 2] = color[2]; img.data[o + 3] = 255 }
      }
    }
    const tmp = document.createElement('canvas')
    tmp.width = w; tmp.height = h
    tmp.getContext('2d').putImageData(img, 0, 0)
    g.imageSmoothingEnabled = false
    g.drawImage(tmp, ox, oy, w, h)

    // 压缩成 JPEG 以减少存储体积（缩略图不需要无损）
    return c.toDataURL('image/jpeg', 0.72)
  } catch {
    return null
  }
}
