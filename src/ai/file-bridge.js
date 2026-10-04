/**
 * file-bridge.js — 外部对话驱动桥（WorkBuddy / DSH）
 *
 * ── 要解决的问题 ──
 * 用户在 WorkBuddy / DSH 里和我（或其他助手）对话时，希望我能直接操作这个编辑器。
 * 但助手运行在对话环境里，看不到编辑器的内存状态，也没有网络回调能力。
 * 双方唯一的共同介质是「文件系统」（assistant 有 Read/Write 工具，编辑器能读写本地目录）。
 *
 * ── 协议 ──
 * 项目根目录下的 .mc-editor/ 目录充当双向信箱：
 *
 *   .mc-editor/
 *     protocol.md        编辑器写：给外部对话的能力说明（供助手 Read 后照着写指令）
 *     state.json         编辑器写：当前世界状态摘要（尺寸/选区/选中方块/统计）
 *     requests/          外部对话写：每条指令一个 .json 文件
 *       <任意名>.json    { "instruction": "生成一片山地并在山谷挖条河", "session": "可选" }
 *     responses/         编辑器写：处理结果（处理完后把 request 文件挪到 processed/）
 *     processed/         request 处理完归档
 *
 * ── 为什么要这样设计 ──
 * 用「文件出现即触发」而不是网络接口，是因为编辑器无法开端口让助手回调，
 * 助手也无法主动 push。轮询 + 原子重命名可以保证：指令不会被执行两次，
 * 也不会因为写入到一半被读到而解析失败。
 * 写入方要求先写 .tmp 再 rename —— 这点写在 protocol.md 里，助手照做即可。
 *
 * ── 两种后端 ──
 * 同一套轮询/归档逻辑，底下换两种文件系统实现：
 *
 *   桌面版：Electron 主进程 fs（通过 preload 暴露的 window.desktop.bridge）
 *           —— 用原生文件夹对话框选目录，路径落盘，下次启动自动重连。
 *   网页版：File System Access API 的目录句柄
 *           —— 受浏览器安全模型限制，每次启动都要用户重新授权。
 *
 * 这层抽象是必要的：如果只留网页后端，桌面版每次启动都要重选目录，
 * 那就不叫桌面软件了；如果只留桌面后端，网页版直接整个功能消失。
 */

export const BRIDGE_DIR = '.mc-editor'

import blocks, { AIR } from '../data/blocks.js'

/** 轮询间隔：太频繁会拖慢文件操作，太慢用户感觉不到响应 */
const POLL_INTERVAL_MS = 1200

/**
 * 桌面后端：把操作转发到 Electron 主进程。
 * 参数里的 dir 是绝对路径，由主进程负责越界校验。
 */
class DesktopFsBackend {
  constructor(dir) {
    this.api = window.desktop.bridge
    this.dir = dir
  }

  get label() { return this.dir }

  async ensureLayout() {
    for (const sub of ['requests', 'responses', 'processed']) {
      await this.api.mkdir(this.dir, sub)
    }
  }

  async listFiles(sub) {
    const res = await this.api.listDir(this.dir, sub)
    if (!res.ok) throw new Error('读取目录失败')
    return res.files
  }

  async read(sub, name) {
    const res = await this.api.readFile(this.dir, `${sub}/${name}`)
    if (!res.ok) return null // 文件已被移走，视为不存在
    return res.text
  }

  async write(sub, name, text) {
    await this.api.writeFile(this.dir, `${sub}/${name}`, text)
  }

  async writeRoot(name, text) {
    await this.api.writeFile(this.dir, name, text)
  }

  /** 写入目标 + 删除源，一步完成，避免中间态被下一次轮询读到 */
  async archive(fromSub, fromName, toSub, toName, text) {
    await this.api.archive(this.dir, `${fromSub}/${fromName}`, `${toSub}/${toName}`, text)
  }
}

/** 网页后端：File System Access API 的目录句柄 */
class BrowserFsBackend {
  constructor(handle) {
    this.handle = handle
  }

  get label() { return this.handle.name }

  async ensureLayout() {
    for (const sub of ['requests', 'responses', 'processed']) {
      await this.handle.getDirectoryHandle(sub, { create: true })
    }
  }

  async dirHandle(sub) {
    return this.handle.getDirectoryHandle(sub, { create: true })
  }

  async listFiles(sub) {
    const d = await this.dirHandle(sub)
    const names = []
    for await (const [name, entry] of d.entries()) {
      if (entry.kind === 'file') names.push(name)
    }
    return names
  }

  async read(sub, name) {
    const d = await this.dirHandle(sub)
    try {
      const fh = await d.getFileHandle(name)
      return await (await fh.getFile()).text()
    } catch (err) {
      if (err?.name === 'NotFoundError') return null
      throw err
    }
  }

  async write(sub, name, text) {
    const d = await this.dirHandle(sub)
    const fh = await d.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
  }

  async writeRoot(name, text) {
    const fh = await this.handle.getFileHandle(name, { create: true })
    const w = await fh.createWritable()
    await w.write(text)
    await w.close()
  }

  async archive(fromSub, fromName, toSub, toName, text) {
    await this.write(toSub, toName, text)
    const d = await this.dirHandle(fromSub)
    await d.removeEntry(fromName).catch(() => {})
  }
}

export class FileBridge {
  /**
   * @param {object} opts
   * @param {() => object} opts.getStateSnapshot 返回当前世界状态摘要的函数
   * @param {(instruction:string, meta:object) => Promise<object>} opts.onInstruction
   * @param {(msg:string, level:string)=>void} opts.notify
   */
  constructor({ getStateSnapshot, onInstruction, notify }) {
    this.getStateSnapshot = getStateSnapshot
    this.onInstruction = onInstruction
    this.notify = notify || (() => {})
    this.fs = null
    this.timer = null
    this.connected = false
    this.processedCount = 0
    this.lastError = null

    // 桌面版走主进程 fs；网页版要求浏览器支持目录句柄
    this.isDesktop = typeof window !== 'undefined' && Boolean(window.desktop?.isElectron)
    this.supported = this.isDesktop ||
      (typeof window !== 'undefined' && 'showDirectoryPicker' in window)
  }

  get dirLabel() {
    return this.fs?.label ?? null
  }

  /** 桌面版的目录是不是「记住后自动接上」的，界面据此显示不同措辞 */
  get isAutoConnected() {
    return Boolean(this._autoConnected)
  }

  /**
   * 连接桥接目录。
   * 桌面版：弹原生文件夹对话框（路径会落盘，下次启动自动重连）。
   * 网页版：弹 showDirectoryPicker，必须由用户手势触发 —— 这是浏览器安全模型的硬限制。
   */
  async connect() {
    if (!this.supported) {
      throw new Error('当前环境不支持文件系统访问。请改用内置「AI 对话」面板。')
    }

    if (this.isDesktop) {
      const res = await window.desktop.bridge.pickDir()
      if (res.canceled) {
        const e = new Error('已取消目录选择')
        e.kind = 'aborted'
        throw e
      }
      if (res.error) throw new Error(res.error)
      this.fs = new DesktopFsBackend(res.dir)
      this._autoConnected = false
    } else {
      let handle
      try {
        handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'mc-editor-bridge' })
      } catch (err) {
        if (err?.name === 'AbortError') {
          const e = new Error('已取消目录选择')
          e.kind = 'aborted'
          throw e
        }
        throw err
      }
      // 用户可能选的是项目根目录，也可能直接选了 .mc-editor，两种都支持
      if (handle.name !== BRIDGE_DIR) {
        handle = await handle.getDirectoryHandle(BRIDGE_DIR, { create: true })
      }
      this.fs = new BrowserFsBackend(handle)
    }

    await this.activate()
    return this.dirLabel
  }

  /**
   * 桌面版专用：启动时尝试用上次记住的目录自动接上。
   * 不弹任何对话框，所以可以在 boot 阶段静默调用。
   * 目录已不存在（被删/外置盘没插）时返回 false，界面会退回「未连接」。
   */
  async autoConnect() {
    if (!this.isDesktop || this.connected) return false
    let saved
    try {
      saved = await window.desktop.bridge.savedDir()
    } catch {
      return false
    }
    if (!saved?.dir || !saved.valid) return false

    this.fs = new DesktopFsBackend(saved.dir)
    await this.activate()
    this._autoConnected = true
    return true
  }

  /** 后端就绪后的公共初始化：建目录结构、发布协议与状态、开始轮询 */
  async activate() {
    await this.fs.ensureLayout()
    await this.publishProtocol()
    await this.publishState()
    this.connected = true
    this.startPolling()
  }

  disconnect() {
    this.stopPolling()
    this.connected = false
    this.fs = null
    this._autoConnected = false
  }

  /** 断开并抹掉记住的路径，下次启动不再自动连 */
  async forget() {
    this.disconnect()
    if (this.isDesktop) {
      await window.desktop.bridge.forgetDir().catch(() => {})
    }
  }

  startPolling() {
    this.stopPolling()
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => {
        this.lastError = err
        // 目录被移走/权限被回收时不要刷屏
        if (this.processedCount === 0) this.notify(`读取外部指令失败：${err.message}`, 'warn')
      })
    }, POLL_INTERVAL_MS)
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 扫描 requests/，逐个处理 */
  async pollOnce() {
    if (!this.fs) return
    const names = (await this.fs.listFiles('requests'))
      .filter((n) => n.endsWith('.json'))
      .sort()

    for (const name of names) {
      try {
        const text = await this.fs.read('requests', name)
        if (text === null) continue // 轮询间隙被别的进程移走了，跳过即可

        const payload = JSON.parse(text)
        const instruction = String(payload.instruction ?? payload.prompt ?? payload.text ?? '').trim()
        if (!instruction) {
          await this.archiveRequest(name, { ok: false, error: '指令文件缺少 instruction 字段' })
          continue
        }

        const result = await this.onInstruction(instruction, {
          source: 'external',
          session: payload.session ?? null,
          autoApply: payload.autoApply === true,
        })

        await this.writeResponse(name, { ok: true, ...result })
        await this.archiveRequest(name, { ok: true })
        this.processedCount++
        this.notify(`已接收外部指令：${instruction.slice(0, 32)}${instruction.length > 32 ? '…' : ''}`, 'ok')
      } catch (err) {
        this.notify(`处理外部指令 ${name} 失败：${err.message}`, 'error')
        await this.writeResponse(name, { ok: false, error: err.message }).catch(() => {})
        await this.archiveRequest(name, { ok: false, error: err.message }).catch(() => {})
      }
    }
  }

  /** 处理完的请求挪进 processed/，保证同一个文件不会被执行两次 */
  async archiveRequest(name, result) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const payload = JSON.stringify(
      { originalName: name, processedAt: new Date().toISOString(), ...result },
      null,
      2
    )
    await this.fs.archive('requests', name, 'processed', `${stamp}__${name}`, payload)
  }

  async writeResponse(requestName, payload) {
    const outName = requestName.replace(/\.json$/, '.response.json')
    await this.fs.write('responses', outName, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2))
  }

  /** 写 state.json：外部对话据此了解编辑器当前状态 */
  async publishState() {
    if (!this.fs) return
    const snap = this.getStateSnapshot()
    await this.fs.writeRoot('state.json', JSON.stringify({
      updatedAt: new Date().toISOString(),
      ...snap,
    }, null, 2))
  }

  /** 写 protocol.md：外部对话读它就知道该怎么写指令 */
  async publishProtocol() {
    if (!this.fs) return
    const text = PROTOCOL_TEXT.replace('{{BLOCK_LIST}}', buildBlockListSection())
    await this.fs.writeRoot('protocol.md', text)
  }

  /** 手动触发一次（界面上「立即检查」按钮用） */
  async checkNow() {
    await this.pollOnce()
    await this.publishState()
    return this.processedCount
  }
}

/**
 * protocol.md 的正文。
 * 这份文档是写给「外部对话里的助手」看的 —— 它 Read 这个文件后就能照着写指令。
 * 因此措辞要面向助手，把协议讲清楚，包括原子写入的要求。
 */
export const PROTOCOL_TEXT = `# MC 地形编辑器 · 外部对话接口

你正在通过文件系统控制一个运行中的 Minecraft 地形编辑器。
编辑器会以约 1.2 秒的间隔轮询 \`requests/\` 目录，发现新的 \`.json\` 文件就解析并生成操作卡片。

## 目录结构

\`\`\`
.mc-editor/
  protocol.md     ← 本文件，说明协议
  state.json      ← 编辑器当前状态（只读，供你参考）
  requests/       ← 你写指令到这里
  responses/      ← 编辑器写处理结果
  processed/      ← 已处理的指令归档
\`\`\`

## 第一步：先读 state.json

写指令前务必先读 \`state.json\`，里面有世界尺寸、当前选区、选中方块、已用体积等信息。
坐标必须落在世界范围内，否则会被钳制或拒绝。

## 第二步：写指令

在 \`requests/\` 下创建任意名字的 \`.json\` 文件，内容：

\`\`\`json
{
  "instruction": "生成一片山地，并在山谷中挖出一条河"
}
\`\`\`

要点：

- \`instruction\` 是自然语言，用中文描述你想要的编辑效果即可，编辑器内部会调用大模型把它翻译成结构化操作。
- **必须原子写入**：先写成 \`xxx.json.tmp\`，确认写完整后再重命名为 \`xxx.json\`。
  直接写 \`xxx.json\` 有可能在写入过程中被编辑器读到，导致 JSON 解析失败。
- 一次只写一个文件。上一个指令被移入 \`processed/\` 之后，再写下一条。
- 可选字段 \`session\`：同一批相关指令填同一个字符串，便于在界面上归组。

## 第三步：读结果

处理完成后：

- \`responses/<你的文件名>.response.json\` 里是结果摘要（生成了几条操作、影响多少方块、是否报错）。
- 原请求文件会被移入 \`processed/\`。

## 重要：执行需要用户确认

编辑器遵循「先预览、后执行」的原则。你的指令会被转换成操作卡片，
**高亮显示出受影响的范围，等用户在界面上点「确认执行」才会真正改动世界。**

所以：

- 你写完指令后，请告诉用户「已在编辑器中生成操作卡片，请到界面上确认」。
- 用户可能修改或拒绝。不要假设一定执行成功，以 \`responses/\` 里的结果为准。
- 状态变更后 \`state.json\` 会更新，可以再次读取确认最终效果。

## 能表达什么样的需求

指令会被解析成这些操作（编辑器侧的限制）：

- \`fill\` / \`clear\` / \`replace\` —— 区域填充、挖空、替换方块
- \`terrain\` —— 噪声地形，类型有 mountain / hills / plateau / valley
- \`river\` —— 挖河，高度由编辑器自动采样地形，不需要你算
- \`layer\` —— 按相对地表分层铺（草皮 / 泥土 / 石头）
- \`scatter\` —— 地表随机散布（树、岩石）
- \`sphere\` / \`cylinder\` —— 球体、圆柱

所以「生成山地并在山谷挖河」「把地表铺成草原」「在中心建座圆形石塔」
这类描述都没有问题。纯美术细节（自定义贴图、模型、实体）不在支持范围内。

## 坐标系与边界

- 原点 (0,0,0) 在世界的西北下角；**x 向东、y 向上、z 向南**，全部从 0 起。
- 当前世界尺寸在 \`state.json\` 的 \`world\` 字段里，坐标必须落在
  \`0 ≤ x < width\`、\`0 ≤ y < height\`、\`0 ≤ z < depth\`。
  超范围的坐标会被**钳制到边界内**，不会报错 —— 所以范围写错了不会崩，但也可能不是你想要的效果。
- 世界尺寸上限是 512×512×512，新建工程时可以自定（state.json 里看到的就是当前实际值）。
- \`state.json\` 的 \`selection\`（若非 null）是用户在界面上框选的区域，
  格式 \`{x1,y1,z1,x2,y2,z2}\`。用户框选了范围时，优先把操作限制在这个范围内。

## 可以用的方块

指令里的方块名写下面的英文name（大小写随意，也可带 \`minecraft:\` 前缀）或中文 label：

{{BLOCK_LIST}}

**不认识的方块名不会报错，而是回退成石头**，并在 response 的对应字段里标记
\`unknown\`。所以写完指令后读一下 response，确认没有意外回退。
如果 state.json 的 \`selectedBlock\` 里有现成的选中方块，直接沿用最稳。

## 写指令的措辞建议

- 明确范围：说「X 从 2 到 45、Z 从 2 到 45」比说「中间那片」更可靠。
- 一次一个主题：把「生成地形」和「种树」分成两条指令，比塞进一句更可控。
- 需要精确数字时直接给：密度、半径、高度都写清楚。

## 排查

- response 里 \`ok: false\` / \`error\`：指令没被接受，error 字段会说原因（最常见是缺参数）。
- response 里操作数为 0：范围可能落在空气区或被 onTop 条件过滤了，换个范围再试。
- 改了但界面没动静：确认 response 存在且操作数非 0，然后让用户点「确认执行」。
`

/**
 * 方块清单段：从 blocks.js 动态生成，避免和方块表漂移
 * （手工维护一份清单，加方块时必然忘了同步 protocol.md）。
 */
function buildBlockListSection() {
  const lines = []
  for (const b of blocks) {
    if (b.id === AIR) continue // 空气不是「可用方块」，写它等于删除
    lines.push(`- \`${b.name}\`（${b.label}）`)
  }
  return lines.join('\n')
}

export { POLL_INTERVAL_MS }
