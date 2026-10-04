/**
 * commands.js — 命令总线与撤销/重做
 *
 * 设计要点：
 * 所有对世界的修改（鼠标笔刷、区域操作、AI 生成、文件导入）都必须经过 CommandBus。
 * 这样撤销/重做栈天然覆盖全部编辑来源，不需要为每种工具单独实现回滚逻辑。
 *
 * 命令只记录「意图」，由 CommandBus 在 apply 前拍快照。
 * 快照采用整块 data.slice()：50^3 世界只有 125KB，100 步撤销约 12MB，完全可接受；
 * 换来的是绝对不会出现「部分回滚」的复杂 bug。
 */

export const CommandType = {
  BRUSH: 'brush',
  REGION_FILL: 'region_fill',
  TERRAIN: 'terrain',
  PASTE: 'paste',
  CLEAR: 'clear',
  AI_BATCH: 'ai_batch',
}

/**
 * @typedef {object} Command
 * @property {string} type       CommandType
 * @property {string} label      展示给用户的说明（中文）
 * @property {() => number} apply   执行，返回改动方块数
 * @property {number} [revision] 执行后的世界 revision（用于校验）
 */

export class CommandBus {
  constructor(world, { limit = 100 } = {}) {
    this.world = world
    this.limit = limit
    /** @type {Array<{label:string, type:string, before:Uint8Array, after:Uint8Array}>} */
    this.undoStack = []
    this.redoStack = []
    this.isRestoring = false
    this.listeners = new Set()
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit() {
    const state = this.stackState()
    for (const fn of this.listeners) {
      try { fn(state) } catch (e) { console.error('[CommandBus] listener error', e) }
    }
  }

  stackState() {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoCount: this.undoStack.length,
      redoCount: this.redoStack.length,
      lastLabel: this.undoStack.at(-1)?.label ?? null,
      nextLabel: this.redoStack.at(-1)?.label ?? null,
    }
  }

  /**
   * 执行命令。
   * @param {Command} cmd
   * @returns {{changes:number, skipped:boolean}}
   */
  execute(cmd) {
    if (this.isRestoring) return { changes: 0, skipped: true }

    const before = this.world.snapshot()
    let changes = 0
    try {
      changes = cmd.apply() ?? 0
    } catch (err) {
      // 命令失败：世界可能已被部分修改，回滚到执行前状态
      this.world.replaceAll(before)
      throw err
    }

    if (changes === 0) return { changes: 0, skipped: true }

    const after = this.world.snapshot()
    this.undoStack.push({ label: cmd.label, type: cmd.type, before, after })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack.length = 0
    this.emit()
    return { changes, skipped: false }
  }

  undo() {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.isRestoring = true
    try {
      this.world.replaceAll(entry.before)
    } finally {
      this.isRestoring = false
    }
    this.redoStack.push(entry)
    if (this.redoStack.length > this.limit) this.redoStack.shift()
    this.emit()
    return { label: entry.label }
  }

  redo() {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.isRestoring = true
    try {
      this.world.replaceAll(entry.after)
    } finally {
      this.isRestoring = false
    }
    this.undoStack.push(entry)
    this.emit()
    return { label: entry.label }
  }

  clearHistory() {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.emit()
  }

  /** 撤销栈序列化（不持久化快照本身，只记录数量用于诊断） */
  describe() {
    return {
      depth: this.undoStack.length,
      labels: this.undoStack.slice(-10).map((e) => e.label),
    }
  }
}
