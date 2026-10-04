/**
 * mesher.js — 把体素数据转成 Three.js 可用几何体
 *
 * 核心优化：面剔除（face culling）
 * 只为一个方块的「暴露面」生成四边形 —— 即邻居是空气/透明方块时才生成。
 * 一个实心 48³ 地形如果逐块生成 6 个面要 83 万面，剔除后通常只剩 2 万面左右。
 *
 * 贴图：每个面从方块贴图图集里取 UV（见 textures.js）。
 * 顶点色不再表示「方块本色」，而是表示「面朝向的极轻微明暗差异」——
 * 六面同亮会让立方体看起来是平的，留一点点差异才分得清结构，
 * 但差异要小到接近无光照的观感（顶 1.00 / 侧 0.94 / 底 0.88）。
 */

import * as THREE from 'three'
import { AIR, BLOCK_BY_ID } from '../data/blocks.js'
import { faceUV } from './textures.js'

/** 六个面：法线方向、四个顶点偏移（逆时针，保证正面朝外）、面类型、明暗系数 */
const FACES = [
  { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.94, face: 'side' },  // +X 东
  { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.94, face: 'side' }, // -X 西
  { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.00, face: 'top' },   // +Y 顶
  { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.88, face: 'bottom' }, // -Y 底
  { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.97, face: 'side' },  // +Z 南
  { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.97, face: 'side' }, // -Z 北
]

/** 液体面稍微内缩，避免与相邻液体面重叠闪烁 */
const LIQUID_SHRINK = 0.12

function isTransparent(id) {
  if (id === AIR) return true
  return BLOCK_BY_ID[id]?.transparent === true
}

/** 判断某个面的邻居是否遮挡本面 */
function isFaceVisible(world, x, y, z, dx, dy, dz, selfId) {
  const nx = x + dx, ny = y + dy, nz = z + dz
  // 世界外部边界视为空气，露出外壁
  if (!world.inBounds(nx, ny, nz)) return true
  const neighbor = world.get(nx, ny, nz)
  if (neighbor === AIR) return true
  // 自身是透明方块时，相邻同为同种透明方块则隐藏（例如水连成一片）
  if (isTransparent(selfId)) return neighbor !== selfId
  return isTransparent(neighbor)
}

/** 面明暗系数 → 顶点色（灰度，乘到贴图上） */
function faceTint(shade) {
  return [shade, shade, shade]
}

/**
 * 每个面的四个顶点对应的 UV 顺序。
 *
 * FACES 里 corners 的顺序是按「从外侧看逆时针」排的，不同面的起始角不同，
 * 所以不能共用一套 UV。
 *
 * 这里按 Minecraft 的贴图朝向约定给出每个角的 (cu,cv)：
 *   - 侧面：贴图正立 —— 图片上沿（cv=0 → v1）朝 +Y；
 *     水平不镜像 —— 从外侧看，图片左→右（u0→u1）与屏幕左→右一致
 *     （+X 面 u1 在 z=0，-X 面 u1 在 z=1，+Z 面 u1 在 x=1，-Z 面 u1 在 x=0）
 *   - 顶面：图片上沿朝北（−Z），u 沿 +X（东）
 *   - 底面：从下往上看，图片上沿朝北（−Z），u 沿 −X（从下看东西是反的）
 *
 * 注意 [cu,cv] 的语义（见 atlasUV）：cu 0→u0 / 1→u1；cv 0→v1(图片上沿) / 1→v0。
 * 即 [0,0]=左上、[1,0]=右上、[1,1]=右下、[0,1]=左下。
 *
 * 朝向曾实测出过大 bug（tools/diag-uv-orient.mjs 量出来的）：旧版把侧面
 * 的 u 沿 y、v 沿 z 装配 —— 所有侧向贴图整体转了 90°，草方块侧面的
 * 绿条竖着贴在边上，用户看到的是「草方块躺倒了」。
 */
const FACE_UV_CORNERS = {
  0: [[0, 1], [1, 1], [1, 0], [0, 0]], // +X 东：corners (z,y) = (1,0)(0,0)(0,1)(1,1)
  1: [[0, 1], [1, 1], [1, 0], [0, 0]], // -X 西：corners (z,y) = (0,0)(1,0)(1,1)(0,1)
  2: [[0, 1], [1, 1], [1, 0], [0, 0]], // +Y 顶：corners (x,z) = (0,1)(1,1)(1,0)(0,0)
  3: [[1, 0], [0, 0], [0, 1], [1, 1]], // -Y 底：corners (x,z) = (0,0)(1,0)(1,1)(0,1)
  4: [[0, 1], [1, 1], [1, 0], [0, 0]], // +Z 南：corners (x,y) = (0,0)(1,0)(1,1)(0,1)
  5: [[0, 1], [1, 1], [1, 0], [0, 0]], // -Z 北：corners (x,y) = (1,0)(0,0)(0,1)(1,1)
}

/** UV 在贴图内的象限 → 图集 UV。cornerUV = [cx, cy]，取值 0 或 1 */
function atlasUV(uv, cx, cy) {
  return [
    cx === 0 ? uv.u0 : uv.u1,
    cy === 0 ? uv.v1 : uv.v0, // 图片 y 向下，UV v 向上，所以 cy=0 对应 v1
  ]
}

/**
 * 构建一个区块的几何数据。
 * @param {import('../core/voxel-world.js').VoxelWorld} world
 * @param {{x,y,z,sizeX,sizeY,sizeZ}} chunk
 * @returns {{positions:Float32Array, colors:Float32Array, uvs:Float32Array, indices:Uint32Array, faceCount:number}}
 */
export function buildChunkGeometry(world, chunk) {
  const positions = []
  const colors = []
  const uvs = []
  const indices = []

  const xEnd = Math.min(chunk.x + chunk.sizeX, world.width)
  const yEnd = Math.min(chunk.y + chunk.sizeY, world.height)
  const zEnd = Math.min(chunk.z + chunk.sizeZ, world.depth)

  let vertexCount = 0

  for (let y = chunk.y; y < yEnd; y++) {
    for (let z = chunk.z; z < zEnd; z++) {
      for (let x = chunk.x; x < xEnd; x++) {
        const id = world.get(x, y, z)
        if (id === AIR) continue
        const def = BLOCK_BY_ID[id]
        if (!def) continue
        const shrink = def.transparent ? LIQUID_SHRINK : 0

        for (let f = 0; f < 6; f++) {
          const face = FACES[f]
          const [dx, dy, dz] = face.dir
          if (!isFaceVisible(world, x, y, z, dx, dy, dz, id)) continue

          // 取这个面该用的贴图 UV。查不到就退回「整张图集左上角一格」，
          // 至少不会整个面变黑或崩掉。
          const uv = faceUV(def.name, face.face)
          const tint = faceTint(face.shade)
          const base = vertexCount
          const uvCorners = FACE_UV_CORNERS[f]

          for (let ci = 0; ci < 4; ci++) {
            const [ox, oy, oz] = face.corners[ci]
            // 内缩：把顶点朝方块中心拉一点
            const px = x + (shrink ? ox * (1 - shrink) + shrink / 2 : ox)
            const py = y + (shrink && dy === 0 ? oy * (1 - shrink) + shrink / 2 : oy)
            const pz = z + (shrink && dz === 0 ? oz * (1 - shrink) + shrink / 2 : oz)
            positions.push(px, py, pz)
            colors.push(tint[0], tint[1], tint[2])
            if (uv) {
              const [cu, cv] = atlasUV(uv, uvCorners[ci][0], uvCorners[ci][1])
              uvs.push(cu, cv)
            } else {
              uvs.push(0, 0)
            }
            vertexCount++
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
        }
      }
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    faceCount: indices.length / 6,
  }
}

/** 把一个区块的几何数据包装成 THREE.Mesh */
export function createChunkMesh(geometryData, material) {
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(geometryData.positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(geometryData.colors, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(geometryData.uvs, 2))
  geo.setIndex(new THREE.BufferAttribute(geometryData.indices, 1))
  geo.computeBoundingSphere()
  const mesh = new THREE.Mesh(geo, material)
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  return mesh
}

export function disposeChunkMesh(mesh) {
  if (!mesh) return
  mesh.geometry?.dispose()
}
