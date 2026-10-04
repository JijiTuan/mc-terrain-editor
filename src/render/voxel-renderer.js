/**
 * voxel-renderer.js — Three.js 渲染器
 *
 * 职责：
 *   1. 分区块维护 Mesh，只重建「脏」区块（增量刷新，即时渲染无需手动刷新）
 *   2. 提供射线拾取（屏幕坐标 → 体素坐标 + 命中面法线）
 *   3. 维护笔刷轮廓 / 选区框 / AI 预览高亮三套辅助线框
 *
 * 脏区块机制：写入方块时把对应区块（以及跨界时相邻区块）标脏，
 * 每帧开头统一重建，避免一次地形生成触发几千次重复构建。
 */

import * as THREE from 'three'
import { buildChunkGeometry, createChunkMesh, disposeChunkMesh } from './mesher.js'
import { AIR, BLOCK_BY_ID } from '../data/blocks.js'
import { ATLAS_URL } from './textures.js'

const CHUNK = 16
const FOG_COLOR = 0x0f1420

export class VoxelRenderer {
  constructor(container) {
    this.container = container
    this.world = null
    this.chunkSize = CHUNK

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(FOG_COLOR)
    this.scene.fog = new THREE.Fog(FOG_COLOR, 60, 260)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000)
    this.camera.position.set(38, 34, 52)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(FOG_COLOR, 1)
    container.appendChild(this.renderer.domElement)

    // 贴图 + 顶点色：贴图来自原版材质图集（tools/build-textures.mjs 生成），
    // 顶点色只用来做极轻微的面朝向明暗差异，不再表示方块本色。
    //
    // NearestFilter 必须设：默认的 LinearFilter 会对 16×16 的小贴图做双线性插值，
    // 放大后每个像素糊成渐变，像素风就没了。这是「像素感」的关键开关。
    const atlas = new THREE.TextureLoader().load(ATLAS_URL)
    atlas.magFilter = THREE.NearestFilter
    atlas.minFilter = THREE.NearestFilter
    atlas.generateMipmaps = false
    atlas.wrapS = THREE.ClampToEdgeWrapping
    atlas.wrapT = THREE.ClampToEdgeWrapping
    atlas.colorSpace = THREE.SRGBColorSpace
    this.atlasTexture = atlas

    this.material = new THREE.MeshBasicMaterial({
      map: atlas,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      alphaTest: 0.02,
      side: THREE.FrontSide,
    })

    // 世界轴向网格（地面参考）
    this.grid = new THREE.GridHelper(64, 64, 0x2a3a52, 0x1d2838)
    this.grid.position.y = 0.001
    this.grid.visible = false
    this.scene.add(this.grid)

    this.root = new THREE.Group()
    this.scene.add(this.root)

    // 方块光标当前是否处于「删除」语义（Alt 按下）。只影响描边颜色，
    // 不影响几何 —— 画得太花反而看不清目标格。
    this._cursorErase = false

    /** @type {Map<string, THREE.Mesh>} key = "cx,cy,cz" */
    this.chunks = new Map()
    this.dirty = new Set()
    this.lastRevision = -1
    this.forceRebuildAll = false

    this.setupHelpers()

    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()
  }

  /** 三套辅助显示对象 */
  setupHelpers() {
    // 笔刷轮廓
    const brushGeo = new THREE.BoxGeometry(1, 1, 1)
    const brushEdges = new THREE.EdgesGeometry(brushGeo)
    this.brushOutline = new THREE.LineSegments(
      brushEdges,
      new THREE.LineBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.9, depthTest: false })
    )
    this.brushOutline.renderOrder = 999
    this.brushOutline.visible = false
    this.scene.add(this.brushOutline)

    // 单个方块高亮（Blockbench 风格的「方块光标」：鼠标指到哪，哪一格就描边）
    this.cursorBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.01, 1.01, 1.01)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false })
    )
    this.cursorBox.renderOrder = 1000
    this.cursorBox.visible = false
    this.scene.add(this.cursorBox)

    // 待放置方块的半透明预览体：光有描边看不出「会变成什么方块」，
    // 有了这个色块，按下左键之前就能预判结果。
    this.ghostBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x4fd1c5,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    )
    this.ghostBox.renderOrder = 995
    this.ghostBox.visible = false
    this.scene.add(this.ghostBox)

    // 待删除方块上蒙一层红：删除是破坏性操作，视觉上要和放置明确区分开
    this.eraseBox = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xff6b6b,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    )
    this.eraseBox.renderOrder = 995
    this.eraseBox.visible = false
    this.scene.add(this.eraseBox)

    // 选区框
    this.selectionBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.95, depthTest: false })
    )
    this.selectionBox.renderOrder = 998
    this.selectionBox.visible = false
    this.scene.add(this.selectionBox)

    // AI 操作预览：用淡色半透明体块显示影响范围，比线框更直观
    this.previewBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 1, depthTest: false })
    )
    this.previewBox.renderOrder = 997
    this.previewBox.visible = false
    this.scene.add(this.previewBox)

    // AI 影响的体素点云（只显示变化过的格子，避免淹没视线）
    this.previewPoints = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({ color: 0xc4b5fd, size: 1.4, sizeAttenuation: true, transparent: true, opacity: 0.85, depthTest: false })
    )
    this.previewPoints.renderOrder = 996
    this.previewPoints.visible = false
    this.scene.add(this.previewPoints)
  }

  setWorld(world) {
    this.world = world
    this.rebuildAll()
  }

  /** 视图尺寸变化 */
  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  chunkKey(cx, cy, cz) {
    return `${cx},${cy},${cz}`
  }

  chunkRange() {
    return {
      nx: Math.ceil(this.world.width / CHUNK),
      ny: Math.ceil(this.world.height / CHUNK),
      nz: Math.ceil(this.world.depth / CHUNK),
    }
  }

  rebuildAll() {
    for (const mesh of this.chunks.values()) {
      this.root.remove(mesh)
      disposeChunkMesh(mesh)
    }
    this.chunks.clear()
    this.dirty.clear()
    if (!this.world) return

    const { nx, ny, nz } = this.chunkRange()
    for (let cy = 0; cy < ny; cy++) {
      for (let cz = 0; cz < nz; cz++) {
        for (let cx = 0; cx < nx; cx++) {
          this.dirty.add(this.chunkKey(cx, cy, cz))
        }
      }
    }
    this.grid.visible = true
    this.updateCameraLimits()
    this.flushDirty()
    this.lastRevision = this.world.revision
  }

  updateCameraLimits() {
    const maxDim = Math.max(this.world.width, this.world.height, this.world.depth)
    this.camera.far = Math.max(1000, maxDim * 6)
    this.camera.updateProjectionMatrix()
    this.scene.fog.near = maxDim * 1.2
    this.scene.fog.far = maxDim * 3.2
    this.grid.geometry.dispose()
    const gridSize = Math.ceil(maxDim / 2) * 2
    this.grid.geometry = new THREE.BufferGeometry().fromGeometry
      ? new THREE.BufferGeometry()
      : new THREE.BufferGeometry()
    const gh = new THREE.GridHelper(gridSize, gridSize, 0x2a3a52, 0x1d2838)
    this.grid.geometry.dispose()
    this.grid.geometry = gh.geometry
    gh.material.dispose()
  }

  /** 标记某个体素所在区块为脏（含跨界邻接区块） */
  markDirtyAt(x, y, z) {
    const cx = Math.floor(x / CHUNK), cy = Math.floor(y / CHUNK), cz = Math.floor(z / CHUNK)
    this.dirty.add(this.chunkKey(cx, cy, cz))
    // 位于区块边界时，邻居区块的面剔除结果也会变化
    const lx = x % CHUNK, ly = y % CHUNK, lz = z % CHUNK
    if (lx === 0) this.dirty.add(this.chunkKey(cx - 1, cy, cz))
    if (lx === CHUNK - 1) this.dirty.add(this.chunkKey(cx + 1, cy, cz))
    if (ly === 0) this.dirty.add(this.chunkKey(cx, cy - 1, cz))
    if (ly === CHUNK - 1) this.dirty.add(this.chunkKey(cx, cy + 1, cz))
    if (lz === 0) this.dirty.add(this.chunkKey(cx, cy, cz - 1))
    if (lz === CHUNK - 1) this.dirty.add(this.chunkKey(cx, cy, cz + 1))
  }

  /** 整片区域标脏（区域填充 / 地形生成用，比逐格快得多） */
  markDirtyBox(x1, y1, z1, x2, y2, z2) {
    const c1 = [Math.floor(Math.min(x1, x2) / CHUNK), Math.floor(Math.min(y1, y2) / CHUNK), Math.floor(Math.min(z1, z2) / CHUNK)]
    const c2 = [Math.floor(Math.max(x1, x2) / CHUNK), Math.floor(Math.max(y1, y2) / CHUNK), Math.floor(Math.max(z1, z2) / CHUNK)]
    for (let cy = c1[1] - 1; cy <= c2[1] + 1; cy++) {
      for (let cz = c1[2] - 1; cz <= c2[2] + 1; cz++) {
        for (let cx = c1[0] - 1; cx <= c2[0] + 1; cx++) {
          if (cx < 0 || cy < 0 || cz < 0) continue
          this.dirty.add(this.chunkKey(cx, cy, cz))
        }
      }
    }
  }

  markAllDirty() {
    if (!this.world) return
    const { nx, ny, nz } = this.chunkRange()
    for (let cy = 0; cy < ny; cy++) {
      for (let cz = 0; cz < nz; cz++) {
        for (let cx = 0; cx < nx; cx++) this.dirty.add(this.chunkKey(cx, cy, cz))
      }
    }
  }

  /** 重建所有脏区块。每帧调用一次。 */
  flushDirty() {
    if (!this.world || this.dirty.size === 0) return 0
    let rebuilt = 0
    const { nx, ny, nz } = this.chunkRange()

    for (const key of this.dirty) {
      const [cx, cy, cz] = key.split(',').map(Number)
      const existing = this.chunks.get(key)

      if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) {
        if (existing) {
          this.root.remove(existing)
          disposeChunkMesh(existing)
          this.chunks.delete(key)
        }
        continue
      }

      const chunk = { x: cx * CHUNK, y: cy * CHUNK, z: cz * CHUNK, sizeX: CHUNK, sizeY: CHUNK, sizeZ: CHUNK }
      const data = buildChunkGeometry(this.world, chunk)

      if (existing) {
        this.root.remove(existing)
        disposeChunkMesh(existing)
        this.chunks.delete(key)
      }

      if (data.faceCount > 0) {
        const mesh = createChunkMesh(data, this.material)
        this.chunks.set(key, mesh)
        this.root.add(mesh)
      }
      rebuilt++
    }
    this.dirty.clear()
    this.lastRevision = this.world.revision
    return rebuilt
  }

  /** 外部世界被整体替换（撤销 / 重做 / 加载）时调用 */
  handleRevisionChange() {
    if (!this.world) return
    if (this.world.revision !== this.lastRevision) {
      this.markAllDirty()
      this.flushDirty()
    }
  }

  /**
   * 屏幕坐标 → 体素命中。
   * 采用「射线步进」而不是 THREE.Raycaster：体素世界面数多，
   * Raycaster 要对每个三角形求交；DDA 步进只需沿射线走格子，通常几十步就命中。
   *
   * @returns {{x,y,z, nx,ny,nz, distance, placeX,placeY,placeZ} | null}
   *   x/y/z 为命中方块坐标；place* 为放置目标（命中面外侧一格）
   */
  pick(clientX, clientY) {
    if (!this.world) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )
    const origin = new THREE.Vector3().setFromMatrixPosition(this.camera.matrixWorld)
    const dir = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(origin).normalize()

    return this.raycastVoxel(origin, dir)
  }

  raycastVoxel(origin, dir, maxDist = 400) {
    const world = this.world
    // 起点在界外时，先把射线推进到 AABB 上
    let t = 0

    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z)
    if (!world.inBounds(x, y, z)) {
      const tHit = rayAABB(origin, dir, world)
      if (tHit === null) return null
      t = tHit
      x = Math.floor(origin.x + dir.x * t)
      y = Math.floor(origin.y + dir.y * t)
      z = Math.floor(origin.z + dir.z * t)
    }

    const stepX = dir.x > 0 ? 1 : -1
    const stepY = dir.y > 0 ? 1 : -1
    const stepZ = dir.z > 0 ? 1 : -1

    const tDeltaX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity
    const tDeltaY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity
    const tDeltaZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity

    let tMaxX = dir.x !== 0 ? ((dir.x > 0 ? x + 1 - origin.x : origin.x - x) / Math.abs(dir.x)) : Infinity
    let tMaxY = dir.y !== 0 ? ((dir.y > 0 ? y + 1 - origin.y : origin.y - y) / Math.abs(dir.y)) : Infinity
    let tMaxZ = dir.z !== 0 ? ((dir.z > 0 ? z + 1 - origin.z : origin.z - z) / Math.abs(dir.z)) : Infinity

    let nx = 0, ny = 0, nz = 0
    let guard = 0
    const MAX_STEPS = (world.width + world.height + world.depth) * 3

    while (t <= maxDist && guard++ < MAX_STEPS) {
      if (world.inBounds(x, y, z)) {
        const id = world.get(x, y, z)
        if (id !== AIR) {
          return {
            x, y, z, nx, ny, nz, distance: t,
            id,
            placeX: x + nx, placeY: y + ny, placeZ: z + nz,
            normal: new THREE.Vector3(nx, ny, nz),
          }
        }
      } else if (t > 0 && !insideAABB(x, y, z, world)) {
        // 已彻底离开包围盒
        const beyond =
          (stepX > 0 ? x >= world.width : x < 0) ||
          (stepY > 0 ? y >= world.height : y < 0) ||
          (stepZ > 0 ? z >= world.depth : z < 0)
        if (beyond) return null
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ
      }
    }
    return null
  }

  /** 更新笔刷轮廓位置 */
  setBrushOutline(center, size, shape) {
    if (!center) {
      this.brushOutline.visible = false
      return
    }
    this.brushOutline.visible = true
    const s = Math.max(1, size)
    this.brushOutline.position.set(center.x + 0.5, center.y + 0.5, center.z + 0.5)
    this.brushOutline.scale.set(s, s, s)
    this.brushOutline.rotation.y = shape === 'cylinder' || shape === 'cube' ? 0 : 0
  }

  /**
   * 更新方块光标的位置与语义。
   *
   * @param {{x:number,y:number,z:number}} pos 目标格（放置=命中面外侧一格；删除=命中格本身）
   * @param {'place'|'erase'} kind 语义，只影响描边颜色
   */
  setCursorBox(pos, kind = 'place') {
    if (!pos) {
      this.cursorBox.visible = false
      return
    }
    this.cursorBox.visible = true
    this.cursorBox.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    if (kind !== this._cursorErase) {
      this._cursorErase = kind
      this.cursorBox.material.color.setHex(kind === 'erase' ? 0xff8f8f : 0xffffff)
    }
  }

  /**
   * 更新「即将发生什么」的色块预览。
   *
   * 放置 → 青色半透明体；删除 → 红色半透明体。两者互斥，同时只显示一个。
   * 传 color 是为了让预览体的颜色贴近即将放下的方块本色 ——
   * 全用同一个青色的话，堆雪块和堆地狱岩在按下前长得一样。
   *
   * @param {{x:number,y:number,z:number}|null} pos
   * @param {'place'|'erase'|null} kind
   * @param {number} [color] 0xRRGGBB
   */
  setGhost(pos, kind, color) {
    const place = pos && kind === 'place'
    const erase = pos && kind === 'erase'

    this.ghostBox.visible = place
    this.eraseBox.visible = erase

    if (place) {
      this.ghostBox.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
      if (typeof color === 'number') this.ghostBox.material.color.setHex(color)
      // 玻璃、树叶这类方块本色很浅，纯色块压上去会遮住底下的地形，
      // 所以按亮度微调不透明度：越亮的方块越透明，保证能看穿。
      const lum = (((color >> 16) & 255) * 0.299 + ((color >> 8) & 255) * 0.587 + (color & 255) * 0.114) / 255
      this.ghostBox.material.opacity = 0.18 + 0.16 * (1 - lum)
    } else if (erase) {
      this.eraseBox.position.set(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5)
    }
  }

  /** 隐藏全部光标类辅助对象（放置预览 / 删除预览 / 方块光标 / 笔刷轮廓） */
  hideCursor() {
    this.cursorBox.visible = false
    this.ghostBox.visible = false
    this.eraseBox.visible = false
    this.brushOutline.visible = false
  }

  setSelectionBox(region) {
    if (!region) {
      this.selectionBox.visible = false
      return
    }
    const w = region.x2 - region.x1 + 1
    const h = region.y2 - region.y1 + 1
    const d = region.z2 - region.z1 + 1
    this.selectionBox.visible = true
    this.selectionBox.position.set(region.x1 + w / 2, region.y1 + h / 2, region.z1 + d / 2)
    this.selectionBox.scale.set(w, h, d)
  }

  /**
   * AI 预览：包围盒线框 + 受影响体素点云
   *
   * 注意参数默认值写法：`= {}` 只能兜住 undefined，传 null 会照样进解构并抛 TypeError。
   * 调用方存在 `setPreview(null)` 这种「清空预览」的用法，所以这里显式再兜一层 null。
   */
  setPreview(options) {
    const { bounds, affected } = options || {}
    if (!bounds) {
      this.previewBox.visible = false
      this.previewPoints.visible = false
      return
    }
    const w = bounds.x2 - bounds.x1 + 1
    const h = bounds.y2 - bounds.y1 + 1
    const d = bounds.z2 - bounds.z1 + 1
    this.previewBox.visible = true
    this.previewBox.position.set(bounds.x1 + w / 2, bounds.y1 + h / 2, bounds.z1 + d / 2)
    this.previewBox.scale.set(w, h, d)

    if (affected && affected.length) {
      // 点太多就稀释，保证帧率
      const stride = affected.length > 30000 ? 2 : 1
      const pts = []
      for (let i = 0; i < affected.length; i += 3 * stride) {
        pts.push(affected[i] + 0.5, affected[i + 1] + 0.5, affected[i + 2] + 0.5)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      this.previewPoints.geometry.dispose()
      this.previewPoints.geometry = geo
      this.previewPoints.visible = true
    } else {
      this.previewPoints.visible = false
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    window.removeEventListener('resize', this._onResize)
    for (const mesh of this.chunks.values()) disposeChunkMesh(mesh)
    this.chunks.clear()
    this.material.dispose()
    this.atlasTexture?.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}

function insideAABB(x, y, z, world) {
  return x >= 0 && y >= 0 && z >= 0 && x < world.width && y < world.height && z < world.depth
}

/** 射线与世界包围盒求交，返回进入参数 t */
function rayAABB(origin, dir, world) {
  const min = [0, 0, 0]
  const max = [world.width, world.height, world.depth]
  const o = [origin.x, origin.y, origin.z]
  const d = [dir.x, dir.y, dir.z]
  let tmin = 0, tmax = Infinity
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null
    } else {
      let t1 = (min[i] - o[i]) / d[i]
      let t2 = (max[i] - o[i]) / d[i]
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) return null
    }
  }
  return tmin
}
