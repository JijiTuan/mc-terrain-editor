/**
 * storage.js — 编辑进度持久化
 *
 * 单通道：localStorage。
 *
 * 这里原先有「云服务 + 本地」双通道，现已移除云服务部分 —— 原因见 README「为什么去掉了云服务通道」：
 * 桌面版里那个云端点属于一个已经下线的网页部署，连不上；而一个写死在代码里的失效域名
 * 还有被他人抢注的风险。既然它在桌面形态下毫无用处、还带风险，就不该留着当装饰。
 *
 * localStorage 的限制要如实告知用户（界面「数据通道」一栏会写明）：
 *   - 容量约 5MB，因此只保留最近 12 份工程；大世界要长期保存请用「导出」落成文件。
 *   - 清空浏览器数据会一起清掉，重要成果请导出备份。
 */

const LOCAL_KEY = 'mc-terrain-editor:projects:v1'
const LOCAL_ACTIVE_KEY = 'mc-terrain-editor:active:v1'
const LOCAL_SCRATCH_KEY = 'mc-terrain-editor:scratch'

export class ProjectStore {
  /**
   * @param {object} opts
   * @param {(msg:string, level:string)=>void} opts.notify
   */
  constructor({ notify } = {}) {
    this.notify = notify || (() => {})
    /** 始终是 'local'。保留这个字段是因为 UI（状态栏、HUD、工程列表）都读它， */
    /// 且能让「数据到底存在哪」这件事在代码里只有一个来源。
    this.channel = 'local'
    this.lastError = null
  }

  channelLabel() {
    return '本地浏览器'
  }

  // ---------- 读写 ----------

  localList() {
    try {
      const raw = localStorage.getItem(LOCAL_KEY)
      const parsed = raw ? JSON.parse(raw) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // 记录损坏时返回空表，而不是让整个「工程列表」弹窗炸掉
      return []
    }
  }

  localWrite(records) {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(records))
  }

  localSave({ id, name, world, thumbnail }) {
    const records = this.localList()
    const entry = {
      id: id || `local_${Date.now()}`,
      name,
      width: world.width,
      height: world.height,
      depth: world.depth,
      data: world.toJSON(),
      thumbnail: thumbnail || null,
      updated_at: new Date().toISOString(),
    }
    const idx = records.findIndex((r) => r.id === entry.id)
    if (idx >= 0) records[idx] = entry
    else records.unshift(entry)
    // 本地容量有限（约 5MB），只保留最近的 12 份
    this.localWrite(records.slice(0, 12))
    return entry.id
  }

  localLoad(id) {
    return this.localList().find((r) => r.id === id) || null
  }

  localDelete(id) {
    const records = this.localList().filter((r) => r.id !== id)
    this.localWrite(records)
    return true
  }

  // ---------- 统一入口 ----------
  // 保持 async：调用方（工程列表、自动保存、恢复会话）都按异步写的，
  // 将来若要换回远端存储，只改这里、不动任何调用点。

  async list() {
    return this.localList()
  }

  async load(id) {
    return this.localLoad(id)
  }

  /**
   * 保存工程。
   * 容量超限（QuotaExceededError）是最可能真实发生的失败 —— 世界数据是 RLE 后的 JSON，
   * 大世界很容易顶到 5MB。必须明确报错并给出可操作的建议，不能静默吞掉。
   */
  async save({ id, name, world, thumbnail }) {
    try {
      return { id: this.localSave({ id, name, world, thumbnail }), channel: 'local' }
    } catch (err) {
      const quota = err?.name === 'QuotaExceededError' || err?.code === 22
      const msg = quota
        ? `本地存储已满，无法保存。请先删除「工程」里的旧工程，或用顶栏「导出」保存成文件。`
        : `保存失败：${describeError(err)}`
      this.lastError = err
      this.notify(msg, 'error')
      throw new Error(msg)
    }
  }

  async remove(id) {
    return this.localDelete(id)
  }

  /** 记住当前正在编辑的工程 id，刷新后自动续上 */
  setActiveId(id) {
    try {
      if (id) localStorage.setItem(LOCAL_ACTIVE_KEY, String(id))
      else localStorage.removeItem(LOCAL_ACTIVE_KEY)
    } catch { /* 忽略隐私模式下的异常 */ }
  }

  getActiveId() {
    try {
      return localStorage.getItem(LOCAL_ACTIVE_KEY)
    } catch {
      return null
    }
  }

  /** 自动保存用的轻量插槽：只留最近一次编辑快照 */
  saveScratch(world) {
    try {
      localStorage.setItem(LOCAL_SCRATCH_KEY, JSON.stringify(world.toJSON()))
    } catch { /* 容量超限时静默失败，用户已有常规保存路径 */ }
  }

  loadScratch() {
    try {
      const raw = localStorage.getItem(LOCAL_SCRATCH_KEY)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
}

export function describeError(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  if (err.name === 'QuotaExceededError') return '本地存储已满'
  return err.message || String(err)
}
