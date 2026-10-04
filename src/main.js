/**
 * main.js — 应用装配与主循环
 *
 * 这里把所有模块接起来：世界 → 渲染器 → 交互 → UI → AI。
 * 各模块之间不直接互相引用，全部通过 App 这个中枢通信，
 * 好处是「谁改了世界」这件事只有一个入口（commit 系列方法），便于维护撤销、脏区块与自动保存。
 */

import './ui/styles.css'
import * as THREE from 'three'

import { VoxelWorld } from './core/voxel-world.js'
import { CommandBus, CommandType } from './core/commands.js'
import { BrushMode, BrushShape, applyBrush, applyBrushStroke, previewBrush } from './core/brushes.js'
import { fillRegion, clearRegion, replaceInRegion, normalizeRegion, regionVolume, hollowRegion } from './core/regions.js'
import { placeBlock, eraseBlock } from './core/edit-ops.js'
import { previewProgram, applyProgram } from './core/op-executor.js'
import { validateProgram, opFootprint } from './core/op-schema.js'
import { generateTerrain } from './core/terrain.js'
import { BLOCK_BY_ID, resolveBlockId, DEFAULT_PALETTE } from './data/blocks.js'

import { VoxelRenderer } from './render/voxel-renderer.js'
import { OrbitControls } from './render/orbit-controls.js'
import { InteractionController, InputMode, Tool } from './ui/interaction.js'
import { buildToolbar } from './ui/toolbar.js'
import { buildAiPanel, showBridgeGuide } from './ui/ai-panel.js'
import { showToast } from './ui/toast.js'
import { openModal, closeModal } from './ui/modal.js'
import * as Minimap from './ui/minimap.js'

import { AiClient, Channel, readDirectConfig } from './ai/ai-client.js'
import { buildMessages } from './ai/prompt.js'
import { parseModelOutput } from './ai/parser.js'
import { FileBridge } from './ai/file-bridge.js'

import { ProjectStore, describeError } from './persist/storage.js'
import { importSchematic, exportSchematic, exportNative, importNative, sliceIntoChunks, mergeChunks } from './io/schematic.js'
import { createDefaultWorld } from './data/default-world.js'

class App {
  constructor() {
    this.container = document.getElementById('app')
    this.world = null
    this.bus = null
    this.selection = null
    this.pendingPreview = null
    this.strokeFrom = null
    this.strokeChanged = 0
    this.mouseDown = false
    this.autoSaveTimer = null
    this.dirtySinceSave = false

    this.state = {
      // 默认进方块模式（Blockbench 手感：一格一格放）。笔刷收进可选档位。
      inputMode: InputMode.BLOCK,
      tool: Tool.PLACE,
      mode: BrushMode.PLACE,
      shape: BrushShape.SPHERE,
      size: 5,
      strength: 0.5,
      spacing: 0.6,
      blockId: resolveBlockId('stone'),
      targetId: resolveBlockId('stone'),
      showGrid: true,
      autoRotate: false,
      aiChannel: Channel.DIRECT,
      aiModel: '',
      lastError: null,
    }

    this.history = []
    this.activeProjectId = null
    /** 自动化探针的短路钩子；生产环境恒为空对象 */
    this.probeHooks = null
  }

  // ============ 启动 ============

  async boot() {
    // 顺序有讲究：buildShell 建 DOM → setupWorld 建世界/渲染器/交互。
    // 但 setupWorld 内部会 refreshAll() 触发整块 UI 重建，而 UI 会去读 app.ai / app.store / app.bridge，
    // 所以这三者必须在 setupWorld 之前就位，否则首帧刷新必然踩到 undefined。
    this.buildShell()
    this.setupAi()
    this.setupStore()
    this.setupBridge()
    this.setupWorld(createDefaultWorld(), {
      // 自动化探针在这一层注入短路钩子（见 setupInteraction 的注释）。
      // 生产运行时这个对象是空的。
      probeHooks: window.__MC_PROBE_HOOKS__ || null,
    })
    this.bindTopbar()
    this.bindKeys()
    this.loop()

    await this.restoreSession()
    // 桥接的自动重连放在最后：它只涉及文件系统，不该拖慢编辑器出画面。
    // 不 await —— 目录在慢速外置盘上时，等它会让「已就绪」提示慢半拍。
    this.autoConnectBridge()
    // 存档提示延后一点：它会弹窗，刚启动就抢焦点会挡住「已就绪」的提示
    setTimeout(() => this.offerLastSave(), 1200)
    this.toast('地形编辑器已就绪', 'ok')
    this.setStatus()
  }

  buildShell() {
    this.container.innerHTML = `
      <div class="topbar">
        <div class="brand">
          <svg class="logo" viewBox="0 0 16 16" fill="none">
            <path d="M8 1 15 4.5v7L8 15 1 11.5v-7L8 1Z" fill="#4fd1c5" opacity=".9"/>
            <path d="M8 1v7m0 0 7-3.5M8 8l-7-3.5M8 8v7" stroke="#0b0f16" stroke-width=".7"/>
          </svg>
          地形编辑器
          <small>Minecraft Voxel Editor</small>
        </div>
        <div class="spacer"></div>
        <div class="topbar-group">
          <button id="btn-undo" class="icon" title="撤销 (Ctrl+Z)">↶ 撤销</button>
          <button id="btn-redo" class="icon" title="重做 (Ctrl+Shift+Z)">↷ 重做</button>
        </div>
        <div class="topbar-group">
          <button id="btn-import" title="导入 schematic / 工程文件">导入</button>
          <button id="btn-export" title="导出 schematic / 工程文件">导出</button>
        </div>
        <div class="topbar-group">
          <button id="btn-new" title="新建世界">新建</button>
          <button id="btn-projects" title="打开工程列表">工程 <span id="proj-count"></span></button>
          <button id="btn-save" class="primary" title="保存到本机 (Ctrl+S)">保存</button>
        </div>
        <div class="topbar-group">
          <button id="btn-help" title="使用说明">?</button>
        </div>
      </div>
      <aside class="toolbar" id="toolbar"></aside>
      <main class="viewport" id="viewport">
        <div class="viewport-overlay">
          <div class="mode-badge" id="mode-badge"></div>
          <div class="view-buttons">
            <button data-view="perspective" title="透视视角">透视</button>
            <button data-view="top" title="俯视">俯视</button>
            <button data-view="front" title="正视">正视</button>
            <button data-view="side" title="侧视">侧视</button>
            <button id="btn-autorotate" title="自动旋转">自转</button>
          </div>
          <div class="hud" id="hud"></div>
          <div class="minimap-wrap">
            <div class="mm-title"><span>俯视图</span><span id="mm-coord">—</span></div>
            <canvas id="minimap" width="176" height="176"></canvas>
          </div>
        </div>
      </main>
      <aside class="ai-panel" id="ai-panel"></aside>
      <div class="toast-host" id="toast-host"></div>
      <div class="modal-backdrop hidden" id="modal-host"></div>
      <input type="file" id="file-input" style="display:none">
    `
    this.el = {
      toolbar: document.getElementById('toolbar'),
      viewport: document.getElementById('viewport'),
      aiPanel: document.getElementById('ai-panel'),
      hud: document.getElementById('hud'),
      modeBadge: document.getElementById('mode-badge'),
      minimap: document.getElementById('minimap'),
      mmCoord: document.getElementById('mm-coord'),
      toastHost: document.getElementById('toast-host'),
      modalHost: document.getElementById('modal-host'),
      fileInput: document.getElementById('file-input'),
    }
  }

  setupWorld(world, extraCallbacks = {}) {
    const isFirst = !this.world
    this.world = world
    this.bus = new CommandBus(world, { limit: 100 })
    this.bus.onChange(() => this.refreshHistoryButtons())

    if (isFirst) {
      this.renderer = new VoxelRenderer(this.el.viewport)
      this.controls = new OrbitControls(this.renderer.camera, this.renderer.renderer.domElement)
      this.renderer.setWorld(world)
      this.controls.frameWorld(world)
      this.setupInteraction(extraCallbacks)
    } else {
      this.renderer.setWorld(world)
      this.controls.frameWorld(world)
    }

    this.selection = null
    this.renderer.setSelectionBox(null)
    this.renderer.setPreview(null)
    this.pendingPreview = null
    this.history = []
    if (!isFirst) Minimap.markDirty()
    this.refreshAll()
  }

  setupInteraction(extraCallbacks = {}) {
    const canvas = this.renderer.renderer.domElement
    this.interaction = new InteractionController({
      canvas,
      renderer: this.renderer,
      controls: this.controls,
      getState: () => this.state,
      callbacks: {
        onHover: (hit) => this.onHover(hit),
        onCellEdit: (target, info) => {
          // 探针短路钩子：自动化测试要把「放置」这条链路整段掐掉，
          // 用它做反向对照，证明探针量的是真结果而不是永远为真。
          // 钩子挂在「交互回调」这一层而不是 App 方法上，是因为
          // 交互控制器在构造时就把回调捕获进了闭包 —— 事后再替换
          // app.onCellEdit 根本不会被调用到（探针第一版就踩了这个坑）。
          if (this.probeHooks?.cellEdit) {
            const r = this.probeHooks.cellEdit(target, info)
            if (r !== undefined) return r
          }
          return this.onCellEdit(target, info)
        },
        onPaint: (target, info) => this.onPaint(target, info),
        onStrokeEnd: () => this.onStrokeEnd(),
        onPickBlock: (id) => this.pickBlock(id),
        onSelectStart: (p) => this.onSelectStart(p),
        onSelectDrag: ({ end }) => this.onSelectDrag(end),
        onSelectEnd: (start) => this.onSelectEnd(start),
      },
    })
    // 生产运行时 extraCallbacks 为空，钩子表也保持为空 —— 行为与没有它时完全一致
    this.probeHooks = extraCallbacks.probeHooks || null

    canvas.addEventListener('pointerdown', () => { this.mouseDown = true })
    window.addEventListener('pointerup', () => { this.mouseDown = false })

    // 追踪 Alt / Shift 的按下状态，让方块光标的颜色和预览色块
    // 在「按下修饰键的那一刻」就切换成删除语义 —— 而不是等点下去才知道。
    // 用捕获阶段是因为有些子元素会 stopPropagation 掉 keydown。
    window.addEventListener('keydown', (e) => {
      const wasAlt = this.altHeld
      const wasShift = this.shiftHeld
      this.altHeld = e.altKey
      this.shiftHeld = e.shiftKey
      if (wasAlt !== this.altHeld || wasShift !== this.shiftHeld) this.refreshHoverPreview()
    }, true)
    window.addEventListener('keyup', (e) => {
      const wasAlt = this.altHeld
      const wasShift = this.shiftHeld
      this.altHeld = e.altKey
      this.shiftHeld = e.shiftKey
      if (wasAlt !== this.altHeld || wasShift !== this.shiftHeld) this.refreshHoverPreview()
    }, true)
    // 焦点切走时修饰键状态会失真（Alt 的 keyup 常常收不到），强制归零
    window.addEventListener('blur', () => {
      if (this.altHeld || this.shiftHeld) {
        this.altHeld = false
        this.shiftHeld = false
        this.refreshHoverPreview()
      }
    })
  }

  /** 修饰键变化后重绘一次悬停预览（鼠标没动，但语义变了） */
  refreshHoverPreview() {
    if (this.hoverVoxel) this.onHover(this.hoverVoxel)
  }

  // ============ 存储与 AI ============

  setupStore() {
    this.store = new ProjectStore({
      notify: (msg, level) => this.toast(msg, level || 'warn'),
    })
  }

  setupAi() {
    const cfg = readDirectConfig()
    this.ai = new AiClient({
      channel: Channel.DIRECT,
      directModel: cfg.model,
      notify: (m, l) => this.toast(m, l),
    })
  }

  setupBridge() {
    this.bridge = new FileBridge({
      getStateSnapshot: () => this.stateSnapshot(),
      onInstruction: async (instruction, meta) => {
        const result = await this.runAiInstruction(instruction, { autoApply: meta.autoApply })
        return result
      },
      notify: (m, l) => this.toast(m, l),
    })

    // 支持拖拽 .schem / .json 到视口导入
    const vp = this.el.viewport
    vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.style.outline = '2px dashed #4fd1c5'; vp.style.outlineOffset = '-8px' })
    vp.addEventListener('dragleave', () => { vp.style.outline = '' })
    vp.addEventListener('drop', async (e) => {
      e.preventDefault()
      vp.style.outline = ''
      const file = e.dataTransfer?.files?.[0]
      if (file) await this.importFile(file)
    })
  }

  // ============ 主循环 ============

  loop() {
    const tick = () => {
      // WASD 飞行会一路把注视点推出去，每帧夹一次边界 ——
      // 不夹的话很容易「飞丢了，视野里全是空气，找不到地形」。
      this.controls.clampTargetToWorld?.(this.world)
      this.controls.update(1)
      this.renderer.flushDirty()
      this.renderer.render()
      this.updateHud()
      Minimap.render(this)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  // ============ 刷新 ============

  refreshAll() {
    // 每个子系统都做「就位判断」：即使将来有人调整 boot 顺序、或在世界还没建好时
    // 就调用 refreshAll，也只是少刷新一块 UI，而不是整个应用启动失败。
    if (this.world && this.renderer) this.refreshToolbar()
    if (this.ai) this.refreshAiPanel()
    if (this.bus) this.refreshHistoryButtons()
    if (this.renderer) this.renderer.grid.visible = this.state.showGrid
    this.refreshModeBadge()
    Minimap.markDirty()
    this.updateHud()
  }

  refreshToolbar() {
    buildToolbar(this)
  }

  refreshAiPanel() {
    buildAiPanel(this)
  }

  refreshHistoryButtons() {
    const s = this.bus.stackState()
    const u = document.getElementById('btn-undo')
    const r = document.getElementById('btn-redo')
    if (u) {
      u.disabled = !s.canUndo
      u.title = s.canUndo ? `撤销：${s.lastLabel} (Ctrl+Z)` : '没有可撤销的操作'
    }
    if (r) {
      r.disabled = !s.canRedo
      r.title = s.canRedo ? `重做：${s.nextLabel} (Ctrl+Shift+Z)` : '没有可重做的操作'
    }
  }

  refreshModeBadge() {
    const parts = []
    // 模式 pill 常驻：用户随时要能确认「我现在左键是放一格还是刷一片」。
    // 工具 pill 分开渲染，CSS 上用 · 前缀挂在一起 —— 一级信息（模式）
    // 和二级信息（具体档位）在视觉上要能一眼分开。
    const isBrush = this.state.inputMode === InputMode.BRUSH
    parts.push(`<span class="pill mode ${isBrush ? 'ai' : 'accent'}">${isBrush ? '✎ 笔刷模式' : '▣ 方块模式'}</span>`)
    parts.push(`<span class="pill tool">${toolLabel(this.state)}</span>`)
    if (this.selection) parts.push('<span class="pill warn">已框选区域</span>')
    if (this.pendingPreview) parts.push('<span class="pill ai">AI 预览待确认</span>')
    this.el.modeBadge.innerHTML = parts.join('')
  }

  setStatus() {
    const label = this.store.channelLabel()
    const dot = document.querySelector('.ai-head .dot')
    if (dot) {
      // 圆点反映的是「自备 Key 是否可用」：可用为常色，未配置为警告色。
      // 以前这里读的是云服务连通性；云通道移除后，唯一还会让 AI 不可用的
      // 原因就只剩「没填 Key」了。
      dot.className = 'dot'
      if (!this.ai?.availability().ok) dot.classList.add('warn')
    }
    this.storeChannelEl && (this.storeChannelEl.textContent = label)
  }

  updateHud() {
    if (!this.world) return
    const s = this.bus ? this.bus.stackState() : { undoCount: 0 }
    const sel = this.selection
    this.el.hud.innerHTML = `
      <div class="row"><span class="k">世界尺寸</span><span class="v">${this.world.width}×${this.world.height}×${this.world.depth}</span></div>
      <div class="row"><span class="k">实体方块</span><span class="v">${this.solidCount ?? '—'}</span></div>
      <div class="row"><span class="k">撤销栈</span><span class="v">${s.undoCount} / 100</span></div>
      <div class="row"><span class="k">数据通道</span><span class="v">${this.store ? this.store.channelLabel() : '—'}</span></div>
      ${sel ? `<div class="row"><span class="k">选区</span><span class="v">${sel.x2 - sel.x1 + 1}×${sel.y2 - sel.y1 + 1}×${sel.z2 - sel.z1 + 1}</span></div>` : ''}
    `
    // 实体方块数变化较慢，降低统计频率
    this._hudTick = (this._hudTick ?? 0) + 1
    if (this._hudTick % 30 === 1) {
      this.solidCount = this.world.stats().solid.toLocaleString()
    }
  }

  // ============ 编辑入口（全部经此，保证撤销/脏区块/自动保存一致） ============

  /**
   * 提交一次编辑。
   * @param {{type:string, label:string, apply:()=>number, dirtyBox?:[number,number,number,number,number,number]}} spec
   */
  commit(spec) {
    let result
    try {
      result = this.bus.execute({ type: spec.type, label: spec.label, apply: spec.apply })
    } catch (err) {
      this.toast(`操作失败：${err.message}`, 'error')
      return 0
    }
    if (result.skipped) return 0

    if (spec.dirtyBox) {
      this.renderer.markDirtyBox(...spec.dirtyBox)
    } else {
      this.renderer.markAllDirty()
    }
    Minimap.markDirty()
    this.markDirtySinceSave()
    this.solidCount = null
    return result.changes
  }

  markDirtySinceSave() {
    this.dirtySinceSave = true
    clearTimeout(this.autoSaveTimer)
    this.autoSaveTimer = setTimeout(() => this.autoSaveScratch(), 2500)
  }

  autoSaveScratch() {
    if (!this.store || !this.dirtySinceSave) return
    this.store.saveScratch(this.world)
    this.dirtySinceSave = false
  }

  // ============ 视口交互：方块模式 / 笔刷模式 ============

  /** 当前是否处于 Blockbench 式方块模式 */
  isBlockMode() {
    return this.state.inputMode !== InputMode.BRUSH
  }

  /**
   * 悬停：决定「操作哪一格」以及「会变成什么」。
   *
   * 方块模式  → 方块光标 + 色块预览（放置=青、删除=红）
   * 笔刷模式  → 笔刷体积轮廓（沿用改版前）
   *
   * 这里和 onCellEdit 必须用同一套「空格 / Shift 走删除语义」的判断，
   * 否则会出现「预览是青的、按下去却删了」这种欺骗性反馈。
   */
  onHover(hit) {
    this.hoverVoxel = hit

    if (!hit) {
      this.renderer.hideCursor()
      if (this.el.mmCoord) this.el.mmCoord.textContent = '—'
      return
    }

    if (!this.isBlockMode()) {
      const center = this.hoverTarget(hit)
      this.renderer.setCursorBox(center, 'place')
      this.renderer.setGhost(null)
      this.renderer.setBrushOutline(center, this.state.size, this.state.shape)
      if (this.el.mmCoord) this.el.mmCoord.textContent = `${hit.x}, ${hit.y}, ${hit.z}`
      return
    }

    const kind = this.hoverEditKind()
    const target = kind === 'erase'
      ? { x: hit.x, y: hit.y, z: hit.z }
      : { x: hit.placeX, y: hit.placeY, z: hit.placeZ }

    this.renderer.setBrushOutline(null)
    this.renderer.setCursorBox(target, kind)
    this.renderer.setGhost(
      target,
      kind,
      BLOCK_BY_ID[this.state.blockId]?.color ?? 0x4fd1c5
    )
    if (this.el.mmCoord) this.el.mmCoord.textContent = `${hit.x}, ${hit.y}, ${hit.z}`
  }

  /**
   * 这次左键点击是「放」还是「删」。
   * 三个入口都能触发删除：Alt 按住、工具选了「删除」、按着 Shift。
   * 提供多个入口是因为 Alt 在某些键盘布局/输入法下会被吃掉。
   */
  hoverEditKind() {
    if (this.altHeld || this.state.tool === Tool.ERASE || this.shiftHeld) return 'erase'
    return 'place'
  }

  /** 悬停/涂抹时的目标格：删除取命中格本身，其余取命中面外侧一格 */
  hoverTarget(hit) {
    const erase = this.state.tool === Tool.ERASE || this.state.mode === BrushMode.ERASE
    return erase
      ? { x: hit.x, y: hit.y, z: hit.z }
      : { x: hit.placeX, y: hit.placeY, z: hit.placeZ }
  }

  /**
   * 方块模式的编辑：一次点击 = 一个方块进撤销栈。
   *
   * 逐格提交（而不是把整条拖拽合成一条命令）是有意的：
   * 用户按住左键铺一条路，中途发现方向错了，希望 Ctrl+Z 能一格一格退。
   * 若合成一条，撤销就变成「整条路一起没了」，反而更难用。
   */
  onCellEdit(target, { kind }) {
    const blockId = this.state.blockId
    const label = kind === 'erase'
      ? `删除方块 @ ${target.x},${target.y},${target.z}`
      : `放置 ${BLOCK_BY_ID[blockId]?.label ?? '方块'} @ ${target.x},${target.y},${target.z}`

    const changes = this.commit({
      type: CommandType.BRUSH,
      label,
      // 单格改动顺手把邻接区块也标脏（编辑放在区块边界时，邻块的面剔除会变）
      dirtyBox: [target.x - 1, target.y - 1, target.z - 1, target.x + 1, target.y + 1, target.z + 1],
      apply: () => (kind === 'erase'
        ? eraseBlock(this.world, target.x, target.y, target.z)
        : placeBlock(this.world, target.x, target.y, target.z, blockId)),
    })
    return changes
  }

  /** 笔刷模式：沿用改版前的涂抹逻辑 */
  onPaint(target, { isStart }) {
    const s = this.state
    if (s.tool === Tool.ERASE) {
      this.paintBrush({ ...target }, { mode: BrushMode.ERASE })
      return
    }
    const params = this.brushParams()
    // 只在拖动开始时记录起点，用于插值补点
    if (isStart) {
      this.strokeFrom = { ...target }
      this.strokeChanged = 0
    }
    if (this.strokeFrom && !isStart) {
      this.strokeChanged += this.commitBrushStroke(this.strokeFrom, target, params)
      this.strokeFrom = { ...target }
    } else {
      this.strokeChanged += this.paintBrush(target, params)
      this.strokeFrom = { ...target }
    }
  }

  brushParams(overrides = {}) {
    const s = this.state
    return {
      mode: s.mode,
      shape: s.shape,
      size: s.size,
      blockId: s.blockId,
      targetId: s.targetId,
      surfaceBlockId: s.blockId,
      spacing: Math.max(1, Math.round((s.size / 4) * (1.6 - s.strength))),
      ...overrides,
    }
  }

  paintBrush(center, params) {
    const snapshot = this.world.snapshot()
    return this.bus.execute({
      type: CommandType.BRUSH,
      label: `笔刷 ${BLOCK_BY_ID[params.blockId]?.label ?? ''} @ ${center.x},${center.y},${center.z}`,
      apply: () => applyBrush(this.world, center, params),
    }).changes ?? 0
  }

  commitBrushStroke(from, to, params) {
    const snapshot = this.world.snapshot()
    const r = this.bus.execute({
      type: CommandType.BRUSH,
      label: `笔刷描线 ${BLOCK_BY_ID[params.blockId]?.label ?? ''}`,
      apply: () => applyBrushStroke(this.world, from, to, params),
    })
    if (!r.skipped) {
      const pad = Math.ceil(params.size / 2) + 2
      this.renderer.markDirtyBox(
        Math.min(from.x, to.x) - pad, Math.min(from.y, to.y) - pad, Math.min(from.z, to.z) - pad,
        Math.max(from.x, to.x) + pad, Math.max(from.y, to.y) + pad, Math.max(from.z, to.z) + pad
      )
      Minimap.markDirty()
      this.markDirtySinceSave()
      this.solidCount = null
    }
    return r.changes ?? 0
  }

  onStrokeEnd() {
    this.strokeFrom = null
    if (this.strokeChanged > 0) {
      this.strokeChanged = 0
      // 一次描线产生的多条命令保持可撤销；这里只做提示
    }
  }

  pickBlock(id) {
    if (id === 0) return
    this.state.blockId = id
    this.refreshToolbar()
    this.toast(`吸取方块：${BLOCK_BY_ID[id]?.label}`, 'ok')
  }

  // ============ 区域框选 ============

  onSelectStart(p) {
    this.selection = { x1: p.x, y1: p.y, z1: p.z, x2: p.x, y2: p.y, z2: p.z }
    this.controls._frozen = true
    this.syncSelection()
  }

  onSelectDrag(end) {
    if (!this.selection) return
    this.selection.x2 = end.x
    this.selection.y2 = end.y
    this.selection.z2 = end.z
    this.syncSelection()
  }

  onSelectEnd() {
    this.controls._frozen = false
    if (!this.selection) return
    const r = normalizeRegion(
      { x: this.selection.x1, y: this.selection.y1, z: this.selection.z1 },
      { x: this.selection.x2, y: this.selection.y2, z: this.selection.z2 }
    )
    this.selection = r
    this.syncSelection()
    const vol = regionVolume(r)
    this.toast(`选区 ${r.x2 - r.x1 + 1}×${r.y2 - r.y1 + 1}×${r.z2 - r.z1 + 1}（${vol.toLocaleString()} 格）`, 'ok')
  }

  syncSelection() {
    if (!this.selection) {
      this.renderer.setSelectionBox(null)
    } else {
      const r = normalizeRegion(
        { x: this.selection.x1, y: this.selection.y1, z: this.selection.z1 },
        { x: this.selection.x2, y: this.selection.y2, z: this.selection.z2 }
      )
      this.renderer.setSelectionBox(r)
    }
    this.refreshModeBadge()
    this.refreshToolbar()
    this.bridge?.publishState?.().catch(() => {})
  }

  clearSelection() {
    this.selection = null
    this.renderer.setSelectionBox(null)
    this.refreshModeBadge()
    this.refreshToolbar()
  }

  /** 用当前选区作参数执行区域操作 */
  regionOp(kind) {
    const sel = this.selection
    if (!sel) {
      this.toast('请先用「框选」工具在视口里拖出一个区域', 'warn')
      return
    }
    const r = normalizeRegion(
      { x: sel.x1, y: sel.y1, z: sel.z1 },
      { x: sel.x2, y: sel.y2, z: sel.z2 }
    )
    const box = [r.x1, r.y1, r.z1, r.x2, r.y2, r.z2]
    const label = BLOCK_BY_ID[this.state.blockId]?.label ?? ''

    switch (kind) {
      case 'fill':
        this.commit({
          type: CommandType.REGION_FILL, label: `填充区域（${label}）`, dirtyBox: box,
          apply: () => fillRegion(this.world, r, this.state.blockId),
        })
        break
      case 'clear':
        this.commit({
          type: CommandType.REGION_FILL, label: '清空区域', dirtyBox: box,
          apply: () => clearRegion(this.world, r),
        })
        break
      case 'replace':
        this.commit({
          type: CommandType.REGION_FILL, label: `区域内替换 ${BLOCK_BY_ID[this.state.targetId]?.label}→${label}`, dirtyBox: box,
          apply: () => replaceInRegion(this.world, r, this.state.targetId, this.state.blockId),
        })
        break
      case 'hollow':
        this.commit({
          type: CommandType.REGION_FILL, label: `区域空心化（${label}）`, dirtyBox: box,
          apply: () => hollowRegion(this.world, r, this.state.blockId, 1),
        })
        break
      case 'copy':
        this.clipboard = this.world.copyRegion(r.x1, r.y1, r.z1, r.x2, r.y2, r.z2)
        this.toast(`已复制 ${this.clipboard.w}×${this.clipboard.h}×${this.clipboard.d} 区域`, 'ok')
        break
      case 'cut':
        this.clipboard = this.world.copyRegion(r.x1, r.y1, r.z1, r.x2, r.y2, r.z2)
        this.commit({
          type: CommandType.REGION_FILL, label: '剪切区域', dirtyBox: box,
          apply: () => clearRegion(this.world, r),
        })
        this.toast('已剪切到剪贴板', 'ok')
        break
      default:
        break
    }
    this.refreshToolbar()
  }

  /** 把剪贴板贴到当前选区起点 */
  pasteClipboard() {
    if (!this.clipboard) {
      this.toast('剪贴板为空，请先复制一个区域', 'warn')
      return
    }
    const to = this.selection || { x1: this.hoverVoxel?.x ?? 0, y1: this.hoverVoxel?.y ?? 0, z1: this.hoverVoxel?.z ?? 0 }
    const ox = to.x1 ?? 0, oy = to.y1 ?? 0, oz = to.z1 ?? 0
    const c = this.clipboard
    this.commit({
      type: CommandType.PASTE,
      label: `粘贴区域（${c.w}×${c.h}×${c.d}）`,
      dirtyBox: [ox, oy, oz, ox + c.w - 1, oy + c.h - 1, oz + c.d - 1],
      apply: () => this.world.pasteRegion(c, ox, oy, oz, false),
    })
    this.toast(`已粘贴到 (${ox}, ${oy}, ${oz})`, 'ok')
  }

  // ============ 地形快捷生成 ============

  quickTerrain(type) {
    const w = this.world
    const region = this.selection
      ? { x1: this.selection.x1, z1: this.selection.z1, x2: this.selection.x2, z2: this.selection.z2 }
      : { x1: 0, z1: 0, x2: w.width - 1, z2: w.depth - 1 }
    const presets = {
      mountain: { baseY: Math.floor(w.height * 0.25), amplitude: Math.floor(w.height * 0.42), scale: 0.05 },
      hills: { baseY: Math.floor(w.height * 0.28), amplitude: Math.floor(w.height * 0.16), scale: 0.09 },
      plateau: { baseY: Math.floor(w.height * 0.34), amplitude: Math.floor(w.height * 0.22), scale: 0.07 },
      valley: { baseY: Math.floor(w.height * 0.3), amplitude: Math.floor(w.height * 0.2), scale: 0.08 },
    }
    const p = presets[type] ?? presets.hills
    this.commit({
      type: CommandType.TERRAIN,
      label: `生成${terrainLabel(type)}`,
      dirtyBox: [region.x1, 0, region.z1, region.x2, w.height - 1, region.z2],
      apply: () => generateTerrain(w, {
        ...region, type: type === 'plateau' ? 'plateau' : type === 'valley' ? 'valley' : type,
        ...p, surface: this.state.blockId, sub: resolveBlockId('dirt'), base: resolveBlockId('stone'),
        seed: Math.floor(Math.random() * 100000),
      }),
    })
  }

  // ============ AI ============

  /** 供 UI 调用：发一条用户消息 */
  async sendAiMessage(text) {
    const input = String(text ?? '').trim()
    if (!input) return
    if (this.aiBusy) {
      this.toast('上一条指令还在处理中', 'warn')
      return
    }
    this.aiBusy = true
    this.currentInstruction = input

    this.chatHistory.push({ role: 'user', content: input })
    this.lastAiMeta = { streaming: '', reasoning: '', done: false, error: null }
    this.refreshAiPanel()

    const controller = new AbortController()
    this.aiAbort = controller

    try {
      const messages = buildMessages(this.world, this.chatHistory.slice(0, -1), input, {
        selectedBlock: BLOCK_BY_ID[this.state.blockId]?.name,
        selection: this.selection,
        lastError: this.state.lastError,
      })

      const res = await this.ai.generate(messages, {
        signal: controller.signal,
        onDelta: (s) => {
          this.lastAiMeta.streaming += s
          this.updateStreamingBubble()
        },
        onReasoning: (s) => {
          this.lastAiMeta.reasoning += s
        },
      })

      this.lastAiMeta.done = true
      this.handleAiResult(res.content)
    } catch (err) {
      if (err.kind === 'aborted') {
        this.chatHistory.push({ role: 'system', content: '已取消本次生成' })
      } else {
        this.state.lastError = err.message
        this.chatHistory.push({ role: 'error', content: err.message })
      }
      this.lastAiMeta.error = err.message
    } finally {
      this.aiBusy = false
      this.aiAbort = null
      this.refreshAiPanel()
    }
  }

  /** 把模型输出解析成操作卡 */
  handleAiResult(rawText) {
    const parsed = parseModelOutput(rawText)

    if (!parsed.ok) {
      this.chatHistory.push({ role: 'error', content: `无法解析模型输出：${parsed.error}` })
      return { ok: false, error: parsed.error }
    }

    const reply = parsed.reply || '（模型没有给出说明）'
    this.chatHistory.push({ role: 'assistant', content: reply })

    if (!parsed.ops.length) {
      this.state.lastError = null
      return { ok: true, ops: 0, reply }
    }

    const validation = validateProgram(parsed.ops, this.world)
    if (!validation.ok) {
      this.state.lastError = validation.error
      this.chatHistory.push({ role: 'error', content: `操作校验失败：${validation.error}` })
      this.refreshAiPanel()
      return { ok: false, error: validation.error }
    }

    this.state.lastError = null
    const preview = previewProgram(this.world, validation.ops)
    this.pendingPreview = {
      ops: validation.ops,
      preview,
      warnings: validation.warnings,
      instruction: this.currentInstruction,
      createdAt: Date.now(),
    }

    // 高亮显示影响范围
    this.renderer.setPreview({ bounds: preview.bounds, affected: preview.affected })
    this.refreshModeBadge()
    this.refreshAiPanel()
    this.toast(`已生成 ${validation.ops.length} 条操作，影响约 ${preview.totalChanges.toLocaleString()} 格，请确认`, 'ok')

    return { ok: true, ops: validation.ops.length, changes: preview.totalChanges, reply }
  }

  /** 供外部对话桥调用：一条指令走完整流程（但不自动执行） */
  async runAiInstruction(instruction, { autoApply = false } = {}) {
    this.currentInstruction = instruction
    this.chatHistory.push({ role: 'user', content: `[外部对话] ${instruction}` })

    const messages = buildMessages(this.world, this.chatHistory.slice(0, -1), instruction, {
      selectedBlock: BLOCK_BY_ID[this.state.blockId]?.name,
      selection: this.selection,
      lastError: this.state.lastError,
    })

    const res = await this.ai.generate(messages, {})
    const parsed = parseModelOutput(res.content)
    if (!parsed.ok) {
      this.chatHistory.push({ role: 'error', content: parsed.error })
      this.refreshAiPanel()
      return { ok: false, error: parsed.error }
    }

    this.chatHistory.push({ role: 'assistant', content: parsed.reply || '(无说明)' })
    if (!parsed.ops.length) {
      this.refreshAiPanel()
      return { ok: true, ops: 0, reply: parsed.reply }
    }

    const validation = validateProgram(parsed.ops, this.world)
    if (!validation.ok) {
      this.chatHistory.push({ role: 'error', content: validation.error })
      this.refreshAiPanel()
      return { ok: false, error: validation.error }
    }

    const preview = previewProgram(this.world, validation.ops)
    this.pendingPreview = {
      ops: validation.ops, preview, warnings: validation.warnings,
      instruction, external: true, createdAt: Date.now(),
    }
    this.renderer.setPreview({ bounds: preview.bounds, affected: preview.affected })
    this.refreshModeBadge()
    this.refreshAiPanel()

    let applied = false
    if (autoApply) {
      applied = this.applyPendingPreview() > 0
    } else {
      this.toast('外部对话已生成操作卡片，请在 AI 面板确认后执行', 'warn')
    }

    return {
      ok: true,
      ops: validation.ops.length,
      changes: preview.totalChanges,
      bounds: preview.bounds,
      applied,
      reply: parsed.reply,
      note: applied ? '已自动执行' : '等待用户在编辑器界面确认',
    }
  }

  /** 确认执行待预览的操作 */
  applyPendingPreview() {
    const pending = this.pendingPreview
    if (!pending) return 0
    const ops = pending.ops

    const changes = this.commit({
      type: CommandType.AI_BATCH,
      label: `AI：${(pending.instruction || '').slice(0, 24)}`,
      apply: () => applyProgram(this.world, ops),
      dirtyBox: pending.preview.bounds
        ? [pending.preview.bounds.x1, pending.preview.bounds.y1, pending.preview.bounds.z1,
           pending.preview.bounds.x2, pending.preview.bounds.y2, pending.preview.bounds.z2]
        : null,
    })

    this.pendingPreview = { ...pending, applied: true, appliedChanges: changes }
    this.renderer.setPreview(null)
    this.chatHistory.push({ role: 'system', content: `已执行：改动 ${changes.toLocaleString()} 个方块` })
    this.refreshModeBadge()
    this.refreshAiPanel()
    this.toast(`执行完成，改动 ${changes.toLocaleString()} 个方块`, 'ok')
    this.bridge?.publishState?.().catch(() => {})
    return changes
  }

  rejectPendingPreview() {
    if (!this.pendingPreview) return
    this.pendingPreview = { ...this.pendingPreview, rejected: true }
    this.renderer.setPreview(null)
    this.chatHistory.push({ role: 'system', content: '已放弃本次操作' })
    this.refreshModeBadge()
    this.refreshAiPanel()
  }

  dismissPendingPreview() {
    this.pendingPreview = null
    this.renderer.setPreview(null)
    this.refreshModeBadge()
    this.refreshAiPanel()
  }

  updateStreamingBubble() {
    const el = document.querySelector('.ai-messages .msg.assistant:last-child .bubble')
    if (el) el.textContent = this.lastAiMeta.streaming
  }

  cancelAi() {
    this.aiAbort?.abort()
  }

  // ============ 存档 ============

  async importFile(file) {
    const name = file.name.toLowerCase()
    try {
      if (name.endsWith('.json')) {
        const text = await file.text()
        const obj = JSON.parse(text)
        // 可能是本编辑器导出的工程，也可能是外部对话写的指令
        if (obj.format === 'mc-terrain-editor') {
          const world = importNative(obj)
          this.commit({
            type: CommandType.CLEAR, label: `导入工程 ${obj.meta?.name ?? file.name}`,
            apply: () => { this.world.replaceAll(world.data); return 1 },
          })
          this.renderer.setWorld(this.world)
          this.controls.frameWorld(this.world)
          this.toast(`已导入工程：${obj.meta?.name ?? file.name}`, 'ok')
        } else if (obj.chunks) {
          const world = mergeChunks(obj.chunks, obj)
          this.replaceWorld(world, `导入区块集（${obj.chunks.length} 块）`)
        } else {
          this.toast('无法识别的 JSON 文件（既不是工程文件也不是区块集）', 'error')
        }
        return
      }

      if (name.endsWith('.schem') || name.endsWith('.schematic') || name.endsWith('.litematic') || name.endsWith('.nbt')) {
        const buf = await file.arrayBuffer()
        const { world, report } = await importSchematic(buf, file.name)
        this.replaceWorld(world, `导入 ${file.name}`)
        this.showImportReport(report, file.name)
        return
      }

      this.toast(`不支持的文件类型：${file.name}`, 'error')
    } catch (err) {
      this.toast(`导入失败：${err.message}`, 'error')
    }
  }

  /**
   * 换掉当前世界（导入 / 打开工程 / 新建）。
   * 渲染器与交互控制器复用不重建 —— 它们只持有 canvas 引用，
   * 世界是 setWorld 喂进去的，重建反而会把相机和事件监听一起丢掉。
   */
  replaceWorld(world, label) {
    this.world = world
    // 撤销栈与旧世界强绑定（存的是旧世界的字节快照），必须整体换新而不是清空
    this.bus = new CommandBus(world, { limit: 100 })
    this.bus.onChange(() => this.refreshHistoryButtons())
    this.renderer.setWorld(world)
    this.controls.frameWorld(world)
    this.selection = null
    this.pendingPreview = null
    this.renderer.setSelectionBox(null)
    this.renderer.setPreview(null)
    this.solidCount = null
    this.history = []
    Minimap.markDirty()
    this.refreshAll()
    this.toast(`${label}：${world.width}×${world.height}×${world.depth}`, 'ok')
    this.markDirtySinceSave()
  }

  showImportReport(report, fileName) {
    const rows = []
    rows.push(['格式', report.format])
    rows.push(['尺寸', `${report.size.w}×${report.size.h}×${report.size.d}`])
    rows.push(['实体方块', report.totalBlocks.toLocaleString()])
    let html = `<div class="form-row"><table style="width:100%;font-size:12px;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="color:#a8b6cc;padding:3px 0">${k}</td><td style="text-align:right;font-family:monospace">${v}</td></tr>`).join('')}
    </table></div>`

    if (report.approxBlocks.length) {
      html += `<div class="form-row"><label>已近似替代的方块（${report.approxBlocks.length} 种）</label>
        <div class="desc" style="font-family:monospace;max-height:120px;overflow:auto">${report.approxBlocks.slice(0, 60).map(escapeHtml).join('、')}${report.approxBlocks.length > 60 ? ' …' : ''}</div></div>`
    }
    if (report.unknownBlocks.length) {
      html += `<div class="form-row"><label style="color:#ffd166">未识别而丢弃的方块（${report.unknownBlocks.length} 种）</label>
        <div class="desc" style="font-family:monospace;max-height:120px;overflow:auto">${report.unknownBlocks.slice(0, 60).map(escapeHtml).join('、')}${report.unknownBlocks.length > 60 ? ' …' : ''}</div></div>`
    }
    if (report.unsupported.length) {
      html += `<div class="form-row"><label style="color:#ffd166">本编辑器暂不支持、已忽略的数据</label>
        <div class="desc">${report.unsupported.map(escapeHtml).join('<br>')}</div></div>`
    }

    openModal(this, {
      title: `导入报告 · ${fileName}`,
      body: html,
      actions: [{ label: '知道了', primary: true, close: true }],
    })
  }

  async exportWorld(kind) {
    try {
      if (kind === 'schem') {
        const bytes = await exportSchematic(this.world, this.projectName || 'terrain')
        downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `${this.projectName || 'terrain'}.schem`)
        this.toast('已导出 Sponge Schematic v3（.schem）', 'ok')
      } else if (kind === 'native') {
        const obj = exportNative(this.world, { name: this.projectName || '未命名工程' })
        downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), `${this.projectName || 'terrain'}.mcterrain.json`)
        this.toast('已导出工程文件（.mcterrain.json）', 'ok')
      } else if (kind === 'chunks') {
        const chunks = sliceIntoChunks(this.world).filter((c) => !c.empty)
        const obj = {
          format: 'mc-terrain-editor-chunks',
          width: this.world.width, height: this.world.height, depth: this.world.depth,
          chunkSize: 16,
          chunks: chunks.map((c) => ({
            chunkX: c.chunkX, chunkZ: c.chunkZ, originX: c.originX, originZ: c.originZ,
            width: c.width, height: c.height, depth: c.depth,
            worldData: c.world.toJSON(),
          })),
        }
        downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), `${this.projectName || 'terrain'}.chunks.json`)
        this.toast(`已导出 ${chunks.length} 个非空区块（空区块已省略）`, 'ok')
      }
    } catch (err) {
      this.toast(`导出失败：${err.message}`, 'error')
    }
  }

  async saveProject() {
    const name = this.projectName || await this.promptName()
    if (!name) return
    this.projectName = name
    const thumb = Minimap.snapshotDataUrl(this)
    try {
      const { id } = await this.store.save({
        id: this.activeProjectId,
        name,
        world: this.world,
        thumbnail: thumb,
      })
      // 首次保存后才有 id，之后每次保存都续到同一条记录上（而不是新建一份）
      this.activeProjectId = id
      this.store.setActiveId(this.activeProjectId)
      this.dirtySinceSave = false
      this.toast(`已保存到本地：${name}`, 'ok')
      this.bridge?.publishState?.().catch(() => {})
      this.refreshAiPanel()
    } catch (err) {
      // store.save 已经把可读的原因 toast 过了，这里不重复刷屏；
      // 但仍要 refreshAiPanel，让面板上的状态跟上。
      this.refreshAiPanel()
    }
  }

  promptName() {
    return new Promise((resolve) => {
      openModal(this, {
        title: '工程命名',
        body: `<div class="form-row"><label>工程名称</label>
          <input type="text" id="proj-name-input" value="${escapeHtml(this.projectName || `地形工程 ${new Date().toLocaleString('zh-CN')}`)}">
          <div class="desc">保存到${this.store.channelLabel()}，之后可在「工程」里打开</div></div>`,
        actions: [
          { label: '取消', close: true, onClick: () => resolve(null) },
          { label: '保存', primary: true, close: true, onClick: () => {
            resolve(document.getElementById('proj-name-input')?.value?.trim() || null)
          } },
        ],
        onOpen: () => {
          const el = document.getElementById('proj-name-input')
          el?.focus(); el?.select()
          el?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              resolve(el.value.trim() || null)
              closeModal(this)
            }
          })
        },
      })
    })
  }

  async openProjects() {
    let list = []
    try {
      list = await this.store.list()
    } catch (err) {
      this.toast(`无法读取工程列表：${describeError(err)}`, 'error')
      return
    }
    const channel = this.store.channelLabel()

    let body = `<div class="form-row desc">当前数据通道：<b style="color:#4fd1c5">${channel}</b>
      （保存在本机浏览器里，约 5MB，最多留 12 份。要长期保存请用顶栏「导出」存成文件）</div>`

    if (!list.length) {
      body += `<div class="empty-hint">还没有保存过工程。<br>编辑后点顶栏「保存」即可。</div>`
    } else {
      body += `<div style="display:flex;flex-direction:column;gap:6px;max-height:44vh;overflow:auto">`
      for (const p of list) {
        const updated = p.updated_at ? new Date(p.updated_at).toLocaleString('zh-CN') : ''
        body += `<div style="display:flex;align-items:center;gap:10px;padding:7px 9px;background:#1a2233;border:1px solid #232d42;border-radius:7px">
          ${p.thumbnail ? `<img src="${p.thumbnail}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;flex:none">` : '<div style="width:40px;height:40px;background:#0b0f16;border-radius:4px;flex:none"></div>'}
          <div style="flex:1;min-width:0">
            <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name || '未命名')}</div>
            <div style="font-size:10.5px;color:#6b7c96">${p.width}×${p.height}×${p.depth} · ${updated}</div>
          </div>
          <button data-load="${escapeHtml(String(p.id))}" style="font-size:11px">打开</button>
          <button data-del="${escapeHtml(String(p.id))}" class="danger" style="font-size:11px">删除</button>
        </div>`
      }
      body += `</div>`
    }

    openModal(this, {
      title: '工程列表',
      body,
      actions: [
        { label: '新建世界', close: true, onClick: () => this.newWorldDialog() },
        { label: '关闭', close: true, primary: true },
      ],
      onOpen: (host) => {
        host.querySelectorAll('[data-load]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.load
            try {
              const rec = await this.store.load(id)
              if (!rec) { this.toast('工程不存在', 'error'); return }
              const world = VoxelWorld.fromJSON(rec.data)
              this.replaceWorld(world, `打开工程 ${rec.name}`)
              this.activeProjectId = id
              this.projectName = rec.name
              this.store.setActiveId(this.activeProjectId)
              closeModal(this)
            } catch (err) {
              this.toast(`打开失败：${describeError(err)}`, 'error')
            }
          })
        })
        host.querySelectorAll('[data-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.dataset.del
            if (!confirm('删除这个工程？此操作不可恢复。')) return
            const ok = await this.store.remove(id)
            this.toast(ok ? '已删除' : '删除失败', ok ? 'ok' : 'error')
            closeModal(this)
            this.openProjects()
          })
        })
      },
    })
  }

  newWorldDialog() {
    openModal(this, {
      title: '新建世界',
      body: `
        <div class="form-row"><label>世界尺寸（X 宽 / Y 高 / Z 深）</label>
          <div class="grid-3">
            <input type="number" id="nw-w" value="64" min="8" max="256">
            <input type="number" id="nw-h" value="64" min="8" max="256">
            <input type="number" id="nw-d" value="64" min="8" max="256">
          </div>
          <div class="desc">上限 256。体积 = 宽×高×深，例如 64³ ≈ 26 万格。</div>
        </div>
        <div class="form-row"><label>初始内容</label>
          <select id="nw-fill">
            <option value="empty">完全空白</option>
            <option value="flat" selected>平坦地面（草地 + 泥土 + 石头）</option>
            <option value="noise">随机丘陵</option>
          </select>
        </div>
        <div class="form-row"><label>初始地面高度（平坦 / 丘陵时生效）</label>
          <input type="number" id="nw-base" value="12" min="1" max="200">
        </div>`,
      actions: [
        { label: '取消', close: true },
        { label: '创建', primary: true, close: true, onClick: () => {
          const w = clampInt(document.getElementById('nw-w').value, 8, 256, 64)
          const h = clampInt(document.getElementById('nw-h').value, 8, 256, 64)
          const d = clampInt(document.getElementById('nw-d').value, 8, 256, 64)
          const fill = document.getElementById('nw-fill').value
          const base = clampInt(document.getElementById('nw-base').value, 1, h - 1, 12)
          const world = buildNewWorld(w, h, d, fill, base)
          this.replaceWorld(world, '新建世界')
          this.activeProjectId = null
          this.projectName = ''
          this.store.setActiveId(null)
        } },
      ],
    })
  }

  async restoreSession() {
    // 优先级：上次打开的工程 > 自动保存的临时快照
    const activeId = this.store.getActiveId()
    if (activeId) {
      try {
        const rec = await this.store.load(activeId)
        if (rec) {
          const world = VoxelWorld.fromJSON(rec.data)
          this.replaceWorld(world, `恢复工程 ${rec.name}`)
          this.projectName = rec.name
          this.activeProjectId = activeId
          return
        }
      } catch (err) {
        console.warn('[restore] 恢复工程失败', err)
      }
    }
    const scratch = this.store.loadScratch()
    if (scratch) {
      try {
        const world = VoxelWorld.fromJSON(scratch)
        this.replaceWorld(world, '恢复上次编辑')
      } catch { /* 快照损坏则保留默认世界 */ }
    }
  }

  stateSnapshot() {
    const stats = this.world.stats()
    const top = [...stats.counts.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ block: BLOCK_BY_ID[id]?.name, count: n }))
    return {
      world: { width: this.world.width, height: this.world.height, depth: this.world.depth },
      solidBlocks: stats.solid,
      fillRatio: Number(this.world.fillRatio().toFixed(4)),
      selection: this.selection,
      selectedBlock: BLOCK_BY_ID[this.state.blockId]?.name,
      topBlocks: top,
      historyDepth: this.bus.undoStack.length,
      ai: {
        channel: this.ai.channel,
        hasPendingPreview: Boolean(this.pendingPreview && !this.pendingPreview.applied),
      },
      storageChannel: this.store?.channel ?? 'local',
      storageLabel: this.store?.channelLabel() ?? '本地浏览器',
      bridge: {
        connected: this.bridge?.connected ?? false,
        processedInstructions: this.bridge?.processedCount ?? 0,
      },
    }
  }

  /**
   * 自检入口，供自动化探针调用（生产构建下源码路径不可 import，只能走这里）。
   *
   * 核心断言：预览说改多少格，执行就真的改多少格。
   * 这条不成立的话，操作卡片上那句「影响约 N 格」就是在骗用户，
   * 而用户是基于这个数字决定要不要点「确认执行」的。
   */
  get __test__() {
    return {
      validatePreviewExecute: (program) => {
        const w = this.world
        const v = validateProgram(program, w)
        const validation = {
          ok: v.ok,
          error: v.error || null,
          warnings: v.warnings?.length ?? 0,
          opCount: v.ops?.length ?? 0,
        }
        if (!v.ok) return { validation, pipeline: null }

        const preview = previewProgram(w, v.ops)
        // 同源副本再跑一遍，既能比较改动数，又不会动用户正在编辑的世界
        const copy = new VoxelWorld(w.width, w.height, w.depth, w.snapshot())
        const appliedChanged = applyProgram(copy, v.ops)

        return {
          validation,
          pipeline: {
            previewAffected: preview.affected.length / 3,
            previewTotalChanges: preview.totalChanges,
            appliedChanged,
            previewMatchesApply: preview.totalChanges === appliedChanged,
            bounds: preview.bounds,
            perOp: preview.perOp.map((p) => ({
              type: p.op.type,
              changes: p.changes,
              error: p.error || null,
            })),
          },
        }
      },

      // 给探针用的世界快照，避免它为了量体积去遍历整个数组
      worldDigest: () => ({
        dims: [this.world.width, this.world.height, this.world.depth],
        revision: this.world.revision,
        solid: this.world.stats().solid,
      }),

      // 还原 RLE 记录 → 世界。探针在生产构建下无法 import('/src/...')，
      // 所以把这一步也放在这里暴露出去，云存储往返断言才能在生产下跑。
      worldFromJSON: (json) => VoxelWorld.fromJSON(json),

      // ---- 存档读写（同样是为了生产构建下可测）----
      // 探针不能用 import('/src/io/anvil.js')：打包后那个路径变成
      // file:///D:/src/io/anvil.js，必然 404。函数没法跨 evaluate 传，
      // 所以这里交出「拿到模块的入口」，让探针在页面里自己组合调用。
      loadWorldSaveModules: async () => {
        const [anvil, worldIo, voxelWorld, blocks] = await Promise.all([
          import('./io/anvil.js'),
          import('./io/world-io.js'),
          import('./core/voxel-world.js'),
          import('./data/blocks.js'),
        ])
        return { anvil, worldIo, voxelWorld, blocks }
      },
    }
  }

  // ============ 快捷键 ============

  bindKeys() {
    window.addEventListener('keydown', async (e) => {
      const tag = document.activeElement?.tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable

      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
          e.preventDefault()
          this.doUndo()
        } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
          e.preventDefault()
          this.doRedo()
        } else if (e.key.toLowerCase() === 's') {
          e.preventDefault()
          this.saveProject()
        } else if (e.key.toLowerCase() === 'c' && !typing) {
          e.preventDefault()
          if (this.selection) this.regionOp('copy')
        } else if (e.key.toLowerCase() === 'v' && !typing) {
          e.preventDefault()
          this.pasteClipboard()
        }
        return
      }

      if (typing) {
        if (e.key === 'Escape') document.activeElement?.blur()
        return
      }

      switch (e.key.toLowerCase()) {
        case 'b': this.setInputMode(InputMode.BRUSH); break
        case 'v': this.setInputMode(InputMode.BLOCK); break
        case 'e': this.setTool(Tool.ERASE); break
        case 'r': this.setTool(Tool.SELECT); break
        case 'q': this.setTool(Tool.EYEDROPPER); break
        case 'escape':
          if (this.pendingPreview) this.rejectPendingPreview()
          else this.clearSelection()
          break
        case 'g': this.toggleGrid(); break
        case 'f': this.controls.frameWorld(this.world); break
        case '[': this.state.size = Math.max(1, this.state.size - 2); this.refreshToolbar(); break
        case ']': this.state.size = Math.min(31, this.state.size + 2); this.refreshToolbar(); break
        default: break
      }
    })
  }

  /**
   * 切换操作模式。
   *
   * 切到笔刷模式时把工具强制归位到「涂抹」：如果从方块模式的「删除」档切过来，
   * 笔刷会沿用一个不属于它的工具状态，手感会很怪（笔刷半径拖过去却在单格删除）。
   */
  setInputMode(mode) {
    if (this.state.inputMode === mode) return
    this.state.inputMode = mode
    if (mode === InputMode.BRUSH) {
      if (this.state.tool === Tool.ERASE || this.state.tool === Tool.PLACE) this.state.tool = Tool.PLACE
    } else if (this.state.tool === Tool.PLACE) {
      this.state.tool = Tool.PLACE
    }
    this.renderer.hideCursor()
    this.refreshToolbar()
    this.refreshModeBadge()
    this.toast(mode === InputMode.BRUSH
      ? '已切到笔刷模式：左键拖拽涂抹，工具面板里调形状与半径'
      : '已切到方块模式：左键放置一格，Alt+左键删除一格', 'info')
  }

  /**
   * 切换工具。
   *
   * 「删除」只在方块模式下有意义（一笔一格）；笔刷模式下删一片是用
   * 笔刷的「删除」模式（BrushMode.ERASE）完成的，已经在工具面板里可选。
   */
  setTool(tool) {
    this.state.tool = tool
    this.renderer.hideCursor()
    this.refreshToolbar()
    this.refreshModeBadge()
  }

  // ============ 顶栏按钮 ============
  //
  // 顶栏的按钮以前是「有 id、没处理器」——DOM 建出来了，但没有任何代码绑事件，
  // 点了毫无反应。功能其实都在（文件选择、导入导出、保存、工程列表、新建），
  // 只是只有快捷键能找到它们（Ctrl+S 之类），不知道快捷键的用户就以为坏了。
  // 这里统一绑上。
  bindTopbar() {
    const on = (id, fn) => {
      const el = document.getElementById(id)
      if (el) el.addEventListener('click', fn)
    }

    on('btn-undo', () => this.doUndo())
    on('btn-redo', () => this.doRedo())

    on('btn-import', () => this.el.fileInput.click())

    on('btn-export', () => this.openExportDialog())
    on('btn-new', () => this.newWorldDialog())
    on('btn-projects', () => this.openProjects())
    on('btn-save', () => this.saveProject())
    on('btn-help', () => this.showHelp())

    on('btn-autorotate', () => {
      this.state.autoRotate = !this.state.autoRotate
      const b = document.getElementById('btn-autorotate')
      if (b) b.classList.toggle('active', this.state.autoRotate)
    })

    // 文件选择的回调（以前只绑在拖拽路径上）
    const fi = this.el.fileInput
    if (fi) {
      fi.addEventListener('change', async () => {
        const file = fi.files?.[0]
        fi.value = '' // 允许连续选同一个文件
        if (file) await this.importFile(file)
      })
    }

    // 视角预设按钮
    document.querySelectorAll('.view-buttons [data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.view
        if (v === 'perspective') { this.controls.frameWorld(this.world); return }
        this.controls.setView?.(v, this.world)
      })
    })
  }

  // ============ 存档（Minecraft 世界读写）============

  /** 打开游戏存档（桌面版；网页版会提示不可用） */
  async openWorldSave() {
    const { openWorldSave } = await import('./ui/world-save.js')
    return openWorldSave(this)
  }

  /** 把当前改动写回存档 */
  async saveToWorldSave() {
    const { saveToWorldSave } = await import('./ui/world-save.js')
    return saveToWorldSave(this)
  }

  /** 弹文件选择器导入结构文件（工具栏按钮用，等价于拖拽） */
  pickImportFile() {
    this.el.fileInput?.click()
  }

  /**
   * 导出对话框。
   *
   * 三种格式的取舍要在界面上讲清楚，否则用户只会随手点第一个：
   *   .schem  —— 给 WorldEdit 等模组用，最通用的交换格式
   *   .json   —— 本编辑器的原生格式，保留全部精度，但别的软件读不了
   *   .mcstructure —— 基岩版结构方块格式
   */
  openExportDialog() {
    const w = this.world
    openModal(this, {
      title: '导出',
      body: `
        <div class="form-row"><label>格式</label>
          <select id="ex-format">
            <option value="schem" selected>Sponge Schematic（.schem）— WorldEdit 等模组通用</option>
            <option value="native">编辑器工程（.json）— 保留全部精度，可再次导入</option>
          </select></div>
        <div class="form-row"><label>内容</label>
          <select id="ex-scope">
            <option value="all" selected>整个世界（${w.width}×${w.height}×${w.depth}）</option>
            ${this.selection ? '<option value="selection">仅当前选区</option>' : ''}
          </select>
          ${this.selection ? '' : '<div class="desc">想只导一块，先用「框选」工具拉一个区域。</div>'}</div>
        <div class="form-row"><label>文件名</label>
          <input id="ex-name" value="${escapeHtml(this.projectName || 'terrain')}"></div>
        <div class="form-row desc">导出的是当前内存里的世界，未保存的改动也会一并导出。</div>
      `,
      actions: [
        { label: '取消', close: true },
        { label: '导出', primary: true, close: true, onClick: () => this.doExport() },
      ],
      onOpen: () => {
        const el = document.getElementById('ex-name')
        el?.focus(); el?.select()
      },
    })
  }

  /**
   * 执行导出。
   *
   * 注意导出器的真实签名 —— 这版 `exportSchematic(world, name)` 导出的是整个世界，
   * 没有「只导选区」的参数（选区导出走另一条切片路径）。所以这里如实告知：
   * 选了「仅当前选区」但导出器不支持时，明确提示而不是默默导整个世界 ——
   * 用户拿到一个比预期大得多的文件却不知道哪里出了错，是最糟的结果。
   */
  async doExport() {
    const fmt = document.getElementById('ex-format')?.value || 'schem'
    const scope = document.getElementById('ex-scope')?.value || 'all'
    const name = (document.getElementById('ex-name')?.value || 'terrain').trim() || 'terrain'

    if (scope === 'selection' && this.selection) {
      const r = this.exportSelection(name, fmt)
      if (r === false) {
        this.toast('当前导出格式不支持只导选区，已改为导出整个世界', 'warn')
      } else {
        return
      }
    }

    try {
      if (fmt === 'native') {
        const obj = exportNative(this.world, { name })
        const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' })
        downloadBlob(blob, `${name}.json`)
      } else {
        const blob = await exportSchematic(this.world, name)
        downloadBlob(blob, `${name}.schem`)
      }
      this.toast(`已导出 ${name}`, 'ok')
    } catch (err) {
      this.toast(`导出失败：${describeError(err)}`, 'error')
    }
  }

  /** 仅导出选区。返回 false 表示该格式不支持，调用方退回整世界导出。 */
  exportSelection(name, fmt) {
    if (fmt === 'native') {
      // 原生格式可以先把选区抠成一个临时世界再序列化
      const sel = this.selection
      const sub = new VoxelWorld(sel.x2 - sel.x1 + 1, sel.y2 - sel.y1 + 1, sel.z2 - sel.z1 + 1)
      for (let y = sel.y1; y <= sel.y2; y++) {
        for (let z = sel.z1; z <= sel.z2; z++) {
          for (let x = sel.x1; x <= sel.x2; x++) {
            sub.set(x - sel.x1, y - sel.y1, z - sel.z1, this.world.get(x, y, z))
          }
        }
      }
      const obj = exportNative(sub, { name: `${name}（选区）`, source: 'selection' })
      downloadBlob(new Blob([JSON.stringify(obj)], { type: 'application/json' }), `${name}-选区.json`)
      this.toast(`已导出选区 ${sub.width}×${sub.height}×${sub.depth}`, 'ok')
      return true
    }
    return false
  }

  /** 使用说明。顶栏那个「?」以前没绑事件，点了没反应，现在指向这里。 */
  showHelp() {
    openModal(this, {
      title: '使用说明',
      body: `
        <div class="form-row"><label>画地形</label>
          <div class="desc">左侧选工具和方块，在右侧视口里按住左键涂抹。
          右键拖拽转视角，滚轮缩放，中键平移。</div></div>
        <div class="form-row"><label>快捷键</label>
          <div class="desc" style="font-family:monospace;line-height:1.8">
            B 笔刷 · E 橡皮 · R 框选 · Q 吸管 · G 网格 · F 聚焦世界<br>
            [ / ] 调笔刷大小 · Ctrl+Z 撤销 · Ctrl+Shift+Z 重做<br>
            Ctrl+S 保存 · Ctrl+C / Ctrl+V 复制粘贴选区 · Esc 取消
          </div></div>
        <div class="form-row"><label>让 AI 改地形</label>
          <div class="desc">
            右侧面板有两种用法，二选一即可：<br>
            · <b>自备 Key</b> —— 在编辑器里直接对话。需要项目根目录的
              <code>.env.local</code> 配置 API Key 后重新构建。<br>
            · <b>接入会话</b> —— 让 WorkBuddy / DSH 里的对话直接驱动编辑器。
              点右下角「接入会话」看详细步骤，不需要在这里配 Key。
          </div></div>
        <div class="form-row"><label>保存</label>
          <div class="desc">编辑进度自动存在本机浏览器（约 5MB，留最近 12 份），刷新不丢。
          要长期保存或分享，用顶栏「导出」存成文件。</div></div>
      `,
      actions: [
        { label: '接入会话怎么用', close: true, onClick: () => this.showBridgeGuide() },
        { label: '知道了', primary: true, close: true },
      ],
    })
  }

  /** 转出桥接用法说明（实现在 ui/ai-panel.js，那里才有渲染弹窗的上下文） */
  showBridgeGuide() {
    if (this.bridge?.connected) this.refreshAiPanel()
    else showBridgeGuide(this)
  }

  toggleGrid() {
    this.state.showGrid = !this.state.showGrid
    this.renderer.grid.visible = this.state.showGrid
    this.refreshToolbar()
  }

  doUndo() {
    const r = this.bus.undo()
    if (!r) { this.toast('没有可撤销的操作', 'warn'); return }
    this.renderer.markAllDirty()
    Minimap.markDirty()
    this.solidCount = null
    this.markDirtySinceSave()
    this.toast(`已撤销：${r.label}`, 'ok')
  }

  doRedo() {
    const r = this.bus.redo()
    if (!r) { this.toast('没有可重做的操作', 'warn'); return }
    this.renderer.markAllDirty()
    Minimap.markDirty()
    this.solidCount = null
    this.markDirtySinceSave()
    this.toast(`已重做：${r.label}`, 'ok')
  }

  toast(msg, level = 'info') {
    showToast(this.el.toastHost, msg, level)
  }

  // ============ 外部对话桥 ============

  async connectBridge() {
    try {
      await this.bridge.connect()
      this.toast(`已连接外部对话桥：${this.bridge.dirLabel || BRIDGE_DIR_PATH}`, 'ok')
      this.refreshAiPanel()
    } catch (err) {
      if (err.kind !== 'aborted') this.toast(`连接失败：${err.message}`, 'error')
      this.refreshAiPanel()
    }
  }

  disconnectBridge() {
    this.bridge.disconnect()
    this.toast('已断开外部对话桥', 'warn')
    this.refreshAiPanel()
  }

  /**
   * 桌面版启动时的静默重连。
   * 失败不弹错误 —— 用户没主动要求连接，目录被删也属正常，
   * 界面保持在「连外部对话」按钮上即可，等他需要时自己点。
   */
  async autoConnectBridge() {
    try {
      const ok = await this.bridge.autoConnect()
      if (ok) {
        this.toast(`外部对话桥已自动连接：${this.bridge.dirLabel}`, 'ok')
        this.refreshAiPanel()
      }
    } catch (err) {
      console.warn('[bridge] 自动重连失败', err)
    }
  }

  /**
   * 启动时提示「上次编辑的存档」。
   *
   * 单独做成一次询问而不是自动打开：读一个存档要解几十个 chunk，
   * 用户可能只是想新建一块地形试试，不希望每次开机都被迫等一次读盘。
   */
  async offerLastSave() {
    if (!window.desktop?.world) return
    try {
      const { offerReopenSave } = await import('./ui/world-save.js')
      await offerReopenSave(this)
    } catch (err) {
      console.warn('[world] 上次存档提示失败', err)
    }
  }
}

// ============ 辅助函数 ============

const BRIDGE_DIR_PATH = '.mc-editor/'

function toolLabel(state) {
  if (state.tool === Tool.SELECT) return '区域框选'
  if (state.tool === Tool.EYEDROPPER) return '吸取方块'

  // 方块模式：「放置 / 删除」——这是用户真正关心的信息，
  // 不用「笔刷」这种实现细节去描述它。
  if (state.inputMode !== InputMode.BRUSH) {
    return state.tool === Tool.ERASE ? '删除方块' : '放置方块'
  }
  return `${MODE_LABEL(state.mode)}笔刷`
}

function MODE_LABEL(mode) {
  return { place: '放置', replace: '替换', erase: '删除', raise: '抬升', lower: '下沉', smooth: '平滑' }[mode] ?? ''
}

function terrainLabel(type) {
  return { mountain: '山地', hills: '丘陵', plateau: '台地', valley: '谷地' }[type] ?? '地形'
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function buildNewWorld(w, h, d, fill, base) {
  const world = new VoxelWorld(w, h, d)
  if (fill === 'empty') return world
  const grass = resolveBlockId('grass_block')
  const dirt = resolveBlockId('dirt')
  const stone = resolveBlockId('stone')
  for (let z = 0; z < d; z++) {
    for (let x = 0; x < w; x++) {
      const top = fill === 'noise'
        ? Math.max(1, Math.min(h - 2, base + Math.round(Math.sin(x * 0.3) * Math.cos(z * 0.3) * 3)))
        : base
      for (let y = 0; y <= top; y++) {
        world.set(x, y, z, y === top ? grass : y >= top - 2 ? dirt : stone)
      }
    }
  }
  return world
}

// openModal / closeModal 统一由 ui/modal.js 提供（这里只做转出，
// 不再本地另写一份 —— 否则两个同名实现并存，改一个漏一个）。
export { App, openModal, closeModal }

// ---- 启动 ----
const app = new App()
window.__MC_EDITOR__ = app
app.boot().catch((err) => {
  console.error('[boot] 启动失败', err)
  document.body.innerHTML = `<div style="padding:40px;font-family:system-ui;color:#ffb4b4;background:#0b0f16;height:100vh">
    <h2>编辑器启动失败</h2><pre style="white-space:pre-wrap">${escapeHtml(err?.stack || err?.message || String(err))}</pre>
  </div>`
})
