/**
 * textures.js — 方块贴图图集
 *
 * 图集本身由 tools/build-textures.mjs 从 Minecraft 原版材质生成，
 * 产物是两张文件：
 *   assets/blocks-atlas.png   所有方块贴图拼成的一张图
 *   assets/blocks-atlas.json  方块 → 贴图名 → 图集像素位置
 *
 * ── 为什么用 Vite 的 URL 导入而不是硬编码路径 ──
 * Vite 会处理 ?url 导入：构建时把资源复制到 dist/assets 并按内容哈希重命名，
 * 返回正确的最终 URL。手写 './assets/blocks-atlas.png' 在打包后一定 404，
 * 因为文件名被改成带哈希的了。
 *
 * ── 坐标系约定 ──
 * JSON 里的位置是「图集内的像素坐标」，这里换算成 0..1 的 UV。
 * 换算只做一次并缓存，避免每个顶点都算。
 */

import atlasUrl from '../assets/blocks-atlas.png?url'
import meta from '../assets/blocks-atlas.json'

export const ATLAS_URL = atlasUrl
export const ATLAS_META = meta

/** 贴图名 → { u0, v0, u1, v1 }（已归一化到 0..1） */
const uvCache = new Map()

function uvFor(texName) {
  let uv = uvCache.get(texName)
  if (uv) return uv
  const loc = meta.textures[texName]
  if (!loc) return null
  // 注意 V 轴：图片坐标 y 向下，WebGL UV 的 v 向上，所以要翻转
  const W = meta.atlasWidth
  const H = meta.atlasHeight
  // 内缩半个像素：当图集用 NearestFilter 时其实不需要，
  // 但一旦有人把过滤改成 Linear，不内缩就会在格子边缘采到邻格颜色。
  const eps = 0
  uv = {
    u0: (loc.x + eps) / W,
    v0: 1 - (loc.y + loc.h - eps) / H,
    u1: (loc.x + loc.w - eps) / W,
    v1: 1 - (loc.y + eps) / H,
  }
  uvCache.set(texName, uv)
  return uv
}

/**
 * 取某个方块某个面的 UV。
 *
 * @param {string} blockName 方块名（如 'grass_block'）
 * @param {'top'|'bottom'|'side'} face 面朝向
 * @returns {{u0:number,v0:number,u1:number,v1:number}|null}
 */
export function faceUV(blockName, face) {
  const def = meta.blocks[blockName]
  if (!def) return null
  const tex = def[face] ?? def.all
  if (!tex) return null
  return uvFor(tex)
}

/** 图集里某张贴图的代表色，供 UI 色块 / 小地图使用（懒计算） */
const avgCache = new Map()
export function textureAvgColor(texName) {
  return avgCache.get(texName) ?? null
}
export function _setTextureAvgColor(texName, rgb) {
  avgCache.set(texName, rgb)
}

export const TILE_SIZE = meta.tile
export const ATLAS_COLS = meta.cols
export const TEXTURE_COUNT = meta.tileCount
