/**
 * interaction.js — 视口交互调度
 *
 * ============ 两套操作模式 ============
 *
 * Blockbench 习惯的核心是「一个方块光标 + 左右键分工明确」，所以默认就是方块模式；
 * 但球形/立方体笔刷在刷大面积地形时是真好用，不能因为改手感就把它砍掉，
 * 于是把它收进一个可选档位（笔刷模式），需要时切过去。
 *
 *   ── 方块模式（mode='block'，默认）──
 *     左键单击    → 在光标格放置一个方块（Blockbench 手感）
 *     左键拖拽    → 沿路径连续放置（快速铺路，不经过的格子不会被误刷）
 *     Alt+左键    → 删除光标格的一个方块
 *     右键拖拽    → 旋转视角
 *     中键拖拽    → 平移视角
 *     滚轮        → 缩放
 *
 *   ── 笔刷模式（mode='brush'）──
 *     左键拖拽    → 按当前笔刷形状/半径涂抹
 *     Alt+左键    → 临时旋转视角（沿用改版前的习惯）
 *     右键/中键/滚轮 → 同上
 *
 *   两种模式共有的：区域框选（select）、吸管（eyedropper）。
 *
 * ============ 为什么右键留给转视角 ============
 *
 * Blockbench 原版是「左键放、右键删」，但本编辑器右键早就被视角旋转占了，
 * 且 3D 编辑里没有旋转视角就没法干活 —— 把右键拿去做删除，就得给旋转再找
 * 一个键（中键被平移占了），徒增学习成本。
 * 所以删除挪到 Alt+左键：左手按一下，右手点一下，不需要切换任何工具档位，
 * 「左键=加、Alt+左键=减」这组对立关系比原版更省事。
 *
 * ============ 安全边界 ============
 *
 * 指针捕获：按下时 setPointerCapture，这样拖到画布外面松手也能收到 pointerup。
 * 但 pointerdown 只在 canvas 上监听（e.target 判断），避免点到 UI 面板上被当成绘制。
 *
 * 拖拽阈值：位移超过 4px 才认为「在拖拽」。不设阈值的话，手抖一下就会
 * 在建了上一个方块之后又插一个 —— 这是这类编辑器最常见的误操作。
 * 所以方块模式下的「单击」判定放在 pointerup，而不是 pointerdown：
 * 只有没拖过才当作单击放置，拖过就交给拖拽路径处理。
 */

import * as THREE from 'three'

export const InputMode = {
  BLOCK: 'block',
  BRUSH: 'brush',
}

export const Tool = {
  PLACE: 'place',
  ERASE: 'erase',
  SELECT: 'select',
  EYEDROPPER: 'eyedropper',
}

/** 判定为拖拽的最小位移（px） */
const DRAG_THRESHOLD = 4

export class InteractionController {
  constructor({ canvas, renderer, controls, getState, callbacks }) {
    this.canvas = canvas
    this.renderer = renderer
    this.controls = controls
    this.getState = getState
    this.cb = callbacks

    /**
     * 空闲状态机。
     * idle | orbit | pan | select | brush | blockdrag（方块模式下的连续放置）
     */
    this.mode = 'idle'
    this.button = -1
    /** 当前被捕获的指针 id，onUp 里用它释放捕获 */
    this.pointerId = null
    this.lastX = 0
    this.lastY = 0
    this.downX = 0
    this.downY = 0
    this.dragged = false
    this.hover = null
    this.selectStart = null
    this.spaceDown = false
    this.altDown = false

    /** 方块模式拖拽时上一个落点，用于「不重复写同一格」 */
    this.lastCellKey = null
    /** 一次拖拽期间的总改动数，松手时用来决定要不要提示 */
    this.strokeChanged = 0

    this.bind()
  }

  bind() {
    const c = this.canvas
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    c.addEventListener('pointerdown', this.onDown, { passive: false })
    window.addEventListener('pointermove', this.onMove, { passive: false })
    window.addEventListener('pointerup', this.onUp)
    c.addEventListener('wheel', this.onWheel, { passive: false })

    c.addEventListener('pointerleave', () => {
      if (this.mode === 'idle') {
        this.hover = null
        this.cb.onHover?.(null)
      }
    })

    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKeyUp)
    // 切到别的窗口再回来时，Alt 的 keyup 常常收不到，
    // 状态会一直卡在「Alt 仍按下」，导致左键变成删除。
    window.addEventListener('blur', () => { this.altDown = false })
  }

  // ---------- 键盘 ----------

  onKey = (e) => {
    if (e.code === 'Space') this.spaceDown = true
    if (e.altKey) this.altDown = true
  }

  onKeyUp = (e) => {
    if (e.code === 'Space') this.spaceDown = false
    if (e.code === 'Alt' || !e.altKey) this.altDown = false
  }

  // ---------- 按下 ----------

  onDown = (e) => {
    if (e.target !== this.canvas) return
    // 捕获指针：拖到画布外面松手也能收到 pointerup。
    // 必须在 onUp 里放掉，否则捕获会一直挂在 canvas 上，
    // 后续不经过按下的事件也会被改派到 canvas，坐标判断全部错位。
    this.canvas.setPointerCapture?.(e.pointerId)
    this.pointerId = e.pointerId
    this.button = e.button
    this.downX = e.clientX
    this.downY = e.clientY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.dragged = false
    this.lastCellKey = null
    this.strokeChanged = 0
    this.altDown = e.altKey

    const state = this.getState()
    const inBlockMode = this.isBlockMode(state)

    // 中键 → 平移（两种模式都一样）
    if (e.button === 1) {
      this.mode = 'pan'
      e.preventDefault()
      return
    }

    // 右键 → 旋转（两种模式都一样，用户明确要求保留）
    if (e.button === 2) {
      this.mode = 'orbit'
      e.preventDefault()
      return
    }

    // 空格 → 临时旋转（任何模式都让路给视角）
    if (this.spaceDown) {
      this.mode = 'orbit'
      e.preventDefault()
      return
    }

    if (e.button !== 0) return

    // ---- 左键 ----

    // Alt+左键：方块模式=删除；笔刷模式=临时旋转（沿用旧手感）
    if (e.altKey) {
      if (inBlockMode) {
        this.mode = 'blockdrag'
        e.preventDefault()
        this.blockEditAt(e.clientX, e.clientY, 'erase')
        return
      }
      this.mode = 'orbit'
      e.preventDefault()
      return
    }

    // 框选：与模式无关
    if (state.tool === Tool.SELECT) {
      const hit = this.renderer.pick(e.clientX, e.clientY)
      if (hit) {
        this.mode = 'select'
        this.selectStart = { x: hit.x, y: hit.y, z: hit.z }
        this.cb.onSelectStart?.(this.selectStart)
      } else {
        this.mode = 'orbit'
      }
      return
    }

    // 吸管：与模式无关
    if (state.tool === Tool.EYEDROPPER) {
      const hit = this.renderer.pick(e.clientX, e.clientY)
      if (hit) this.cb.onPickBlock?.(hit.id)
      this.mode = 'idle'
      return
    }

    // 方块模式：按下先不动世界，等 pointerup 判定是单击还是拖拽。
    // 直接在 down 里放方块的话，用户想转视角却点了一下就会多出一个方块。
    if (inBlockMode) {
      this.mode = 'blockdrag'
      e.preventDefault()
      return
    }

    // 笔刷模式
    this.mode = 'brush'
    e.preventDefault()
    this.paintAt(e.clientX, e.clientY, true)
  }

  isBlockMode(state) {
    const m = state?.inputMode
    // 状态缺省时按方块模式走 —— 默认手感应是 Blockbench 那套
    return m === undefined || m === null ? true : m === InputMode.BLOCK
  }

  // ---------- 移动 ----------

  onMove = (e) => {
    const state = this.getState()
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    if (Math.abs(e.clientX - this.downX) + Math.abs(e.clientY - this.downY) > DRAG_THRESHOLD) {
      this.dragged = true
    }

    if (this.mode === 'orbit') {
      this.controls.rotate(dx, dy)
      this.lastX = e.clientX; this.lastY = e.clientY
      return
    }
    if (this.mode === 'pan') {
      this.controls.pan(dx, dy)
      this.lastX = e.clientX; this.lastY = e.clientY
      return
    }
    if (this.mode === 'brush') {
      this.lastX = e.clientX; this.lastY = e.clientY
      this.paintAt(e.clientX, e.clientY, false)
      return
    }
    if (this.mode === 'blockdrag') {
      this.lastX = e.clientX; this.lastY = e.clientY
      // 拖过阈值之前不写世界，避免「手一抖多一个方块」
      if (this.dragged) {
        const kind = this.altDown ? 'erase' : 'place'
        this.blockEditAt(e.clientX, e.clientY, kind)
      }
      return
    }
    if (this.mode === 'select' && this.selectStart) {
      const hit = this.renderer.pick(e.clientX, e.clientY)
      if (hit) this.cb.onSelectDrag?.({ end: { x: hit.x, y: hit.y, z: hit.z } })
      return
    }

    // 空闲态：更新悬停高亮 + 方块光标
    if (e.target === this.canvas) {
      const hit = this.renderer.pick(e.clientX, e.clientY)
      const prev = this.hover
      this.hover = hit
      if (hit?.x !== prev?.x || hit?.y !== prev?.y || hit?.z !== prev?.z ||
          hit?.placeX !== prev?.placeX || hit?.placeY !== prev?.placeY || hit?.placeZ !== prev?.placeZ) {
        this.cb.onHover?.(hit)
      }
    }
  }

  // ---------- 松开 ----------

  onUp = () => {
    if (this.mode === 'brush') this.cb.onStrokeEnd?.()

    if (this.mode === 'blockdrag') {
      // 全程没拖过 = 单击。单击的语义在 up 里补上（down 里刻意什么都没做）
      if (!this.dragged) {
        const kind = this.altDown ? 'erase' : 'place'
        this.blockEditAt(this.lastX, this.lastY, kind)
      }
      this.cb.onStrokeEnd?.()
    }

    if (this.mode === 'select' && this.selectStart) {
      this.cb.onSelectEnd?.(this.selectStart)
      this.selectStart = null
    }

    // 与 onDown 的 setPointerCapture 配对。失败时静默忽略：
    // 指针可能已经被浏览器隐式释放（例如触摸抬起），再放一次会抛 NotFoundError。
    if (this.pointerId !== null && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(this.pointerId) } catch { /* 已被隐式释放 */ }
    }
    this.pointerId = null

    this.mode = 'idle'
    this.button = -1
    this.lastCellKey = null
  }

  onWheel = (e) => {
    e.preventDefault()
    this.controls.zoom(e.deltaY)
  }

  // ---------- 两种编辑路径 ----------

  /**
   * 方块模式：算出目标格，交给 App 执行。
   * 同一格在一次拖拽里只写一次（lastCellKey），否则拖过一个方块会触发几十条命令，
   * 撤销栈被瞬间塞满，用户得连按几十次 Ctrl+Z 才能退回一步。
   */
  blockEditAt(clientX, clientY, kind) {
    const hit = this.renderer.pick(clientX, clientY)
    if (!hit) return
    const target = kind === 'erase'
      ? { x: hit.x, y: hit.y, z: hit.z, hitId: hit.id }
      : { x: hit.placeX, y: hit.placeY, z: hit.placeZ }
    const key = `${target.x},${target.y},${target.z}`
    if (key === this.lastCellKey) return
    this.lastCellKey = key
    this.cb.onCellEdit?.(target, { kind, hit })
  }

  /** 笔刷模式：整体涂抹（沿用原逻辑） */
  paintAt(clientX, clientY, isStart) {
    const state = this.getState()
    const hit = this.renderer.pick(clientX, clientY)
    if (!hit) return
    // 笔刷模式下「橡皮」工具走删除语义，其余按当前笔刷模式（放置/替换/抬升…）
    const isErase = state.tool === Tool.ERASE || state.mode === 'erase'
    const target = isErase
      ? { x: hit.x, y: hit.y, z: hit.z }
      : { x: hit.placeX, y: hit.placeY, z: hit.placeZ }
    this.cb.onPaint?.(target, { isStart, hit })
  }

  dispose() {
    if (this.pointerId !== null && this.canvas.releasePointerCapture) {
      try { this.canvas.releasePointerCapture(this.pointerId) } catch { /* 已被隐式释放 */ }
      this.pointerId = null
    }
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}
