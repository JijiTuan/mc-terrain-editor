/**
 * ai-panel.js — 右侧 AI 对话面板
 *
 * 三个区域：通道状态栏 / 消息流（含操作确认卡）/ 输入区。
 * 消息流是整体重建的 —— 消息数量有限，重建比维护增量 DOM 更不容易出状态不一致的 bug。
 * （例外：流式输出期间直接改那一个气泡的 textContent，避免每个 token 都重建整棵树。）
 */

import { BLOCK_BY_ID } from '../data/blocks.js'
import { readDirectConfig } from '../ai/ai-client.js'
import { EXAMPLE_PROMPTS } from '../ai/prompt.js'
import { opFootprint } from '../core/op-schema.js'
import { cssColor } from './toolbar.js'
import { openModal } from './modal.js'

export function buildAiPanel(app) {
  const host = app.el.aiPanel
  // 重建前先记下「用户当时是不是贴着底部」。
  // 不能直接记 scrollTop 数值：面板整体重建后内容高度会变，
  // 旧数值对应的位置已经没有意义了，恢复回去会把视线拉到一个随机的地方。
  const prev = host.querySelector('.ai-messages')
  const wasAtBottom = prev ? prev.scrollHeight - prev.scrollTop - prev.clientHeight < 24 : true

  // 出现新的待确认操作卡时，无论用户之前滚到哪里，都要把视线拉到底部 ——
  // 「等你确认」的东西如果藏在视野外，用户会以为程序没反应。
  // 这是有意打断用户的阅读位置：待确认操作是需要即时处理的动作，
  // 优先级高于「保持刚才的滚动位置」。
  const pendingKey = app.pendingPreview
    ? `${app.pendingPreview.createdAt ?? 0}:${app.pendingPreview.ops?.length ?? 0}`
    : null
  const hasNewPending = pendingKey !== null && pendingKey !== app._shownPendingKey

  host.innerHTML = ''

  host.appendChild(buildHead(app))

  const msgs = document.createElement('div')
  msgs.className = 'ai-messages'
  renderMessages(app, msgs)
  host.appendChild(msgs)

  // 滚动必须在 appendChild 之后做：游离节点没有布局，
  // 此时 scrollHeight 恒为 0，在那之前设置的 scrollTop 会被丢掉。
  // 原来这里恢复的是「重建前的 scrollTop 数值」，配合 renderMessages 里
  // 那句对游离节点的无效赋值，结果就是新出现的操作卡永远停在视野外 ——
  // 用户看到顶部提示「等待确认」，却找不到确认按钮。
  if (hasNewPending || wasAtBottom) {
    scrollToBottom(msgs)
  }
  // 记下这次展示过的卡片标识，避免每次重建都强制滚到底（那会让人没法往上翻）
  if (pendingKey && hasNewPending) app._shownPendingKey = pendingKey

  host.appendChild(buildInput(app))
  // 输入框保持焦点，方便连续输入
  if (app.aiFocusWanted) {
    const ta = host.querySelector('textarea')
    ta?.focus()
    app.aiFocusWanted = false
  }
}

/**
 * 把消息区滚到底部。
 *
 * 为什么要分两帧滚：
 *   刚 appendChild 完就设 scrollTop = scrollHeight 时，浏览器还没完成这一次
 *   布局，scrollHeight 读到的是偏小的旧值（实测少 125px）—— 于是「滚到底」
 *   其实没到底，新卡片的下半截和确认按钮仍然在视野外。
 *   等一帧后在布局稳定时再钉一次，才能保证真的贴底。
 *   额外再补一帧是防御性的：卡片里的换行、等宽字体度量偶发会再触发一次回流。
 */
function scrollToBottom(el) {
  const pin = () => { el.scrollTop = el.scrollHeight }
  pin()
  requestAnimationFrame(() => {
    pin()
    requestAnimationFrame(pin)
  })
}

function buildHead(app) {
  const head = document.createElement('div')
  head.className = 'ai-head'

  const avail = app.ai.availability()
  const dotClass = avail.ok ? '' : 'bad'

  head.innerHTML = `
    <span class="dot ${dotClass}"></span>
    <span class="t">AI 辅助编辑</span>
    <div class="spacer"></div>
  `

  // 通道已被收敛为单一「自备 Key」通道（云服务通道已移除），
  // 因此这里不再放下拉框 —— 一个只有唯一选项的下拉框只会让人以为还有别的选。
  // 但「怎么配 Key」这件事必须一眼能找到，所以保留这个齿轮按钮。
  const mode = app.bridge?.connected ? '接入会话' : '自备 Key'
  const tag = document.createElement('span')
  tag.className = 't'
  tag.style.cssText = 'font-size:10.5px;color:#6b7c96'
  tag.textContent = mode
  head.appendChild(tag)

  const cfgBtn = document.createElement('button')
  cfgBtn.className = 'ghost icon'
  cfgBtn.textContent = '⚙'
  cfgBtn.title = '模型配置与状态'
  cfgBtn.onclick = () => showChannelInfo(app)
  head.appendChild(cfgBtn)

  return head
}

function showChannelInfo(app) {
  const cfg = readDirectConfig()
  const avail = app.ai.availability()

  let body = `<div class="form-row"><label>当前通道</label>
    <div class="desc" style="font-size:12px;color:#e6ecf5">环境变量直连 · 自备 Key</div></div>
    <div class="form-row"><label>配置来源</label>
      <div class="desc">项目根目录的 <code>.env.local</code>（构建时注入，参考 <code>.env.example</code>）</div></div>
    <div class="form-row"><label>接口地址</label>
      <div class="desc" style="font-family:monospace">${escapeHtml(cfg.baseUrl)}</div></div>
    <div class="form-row"><label>模型</label>
      <div class="desc" style="font-family:monospace">${escapeHtml(cfg.model || '（未设置 VITE_AI_MODEL）')}</div></div>
    <div class="form-row"><label>API Key</label>
      <div class="desc" style="font-family:monospace">${cfg.apiKey ? `已设置（${escapeHtml(cfg.apiKey.slice(0, 6))}…${escapeHtml(cfg.apiKey.slice(-4))}）` : '未设置'}</div></div>
    <div class="form-row"><label style="color:#ffd166">安全提示</label>
      <div class="desc">这是纯前端应用，Key 会随代码打包进产物。自用没问题，
      但不要把这套部署成给别人用的公共服务 —— 那样 Key 等于公开。</div></div>
    <div class="form-row"><label>不想配 Key？</label>
      <div class="desc">用右下角的「<b>接入会话</b>」，让 WorkBuddy / DSH 里的对话直接驱动编辑器，
      Key 留在对话环境那一侧，本程序完全不需要。</div></div>`

  if (!avail.ok) {
    body += `<div class="form-row"><label style="color:#ff6b6b">当前不可用</label>
      <div class="desc" style="color:#ffb4b4">${escapeHtml(avail.reason)}</div></div>`
  }

  openModal(app, {
    title: 'AI 通道',
    body,
    actions: [{ label: '关闭', primary: true, close: true }],
  })
}

function renderMessages(app, host) {
  const history = app.chatHistory ?? (app.chatHistory = [])
  const meta = app.lastAiMeta

  if (!history.length && !app.pendingPreview) {
    const hasKey = app.ai.availability().ok
    // 空状态是有且只有一次的教学位。没配 Key 的人在这里直接告诉他还有另一条路，
    // 而不是让他对着一个「发送」点了报错才发现要配 .env.local。
    host.innerHTML = `
      <div class="empty-hint">
        用自然语言描述你想要的地形，<br>我来转换成编辑操作。<br><br>
        <span style="color:#6b7c96">操作会先预览影响范围，<br>你确认后才会真正改动世界。</span>
        <br><br>
        ${hasKey
          ? `<span style="color:#6b7c96">也可以在对话环境里用「接入会话」，<br>
             由外部助手直接写指令过来。</span>`
          : `<span style="color:#ffd166">还没配置模型 Key，直接发送会失败。</span><br>
             <span style="color:#6b7c96">点右下角 <b>接入会话</b>，<br>
             让 WorkBuddy / DSH 里的对话来驱动编辑器，<br>就不用在这里填 Key。</span>`}
      </div>`
    return
  }

  for (const m of history) {
    const el = document.createElement('div')
    el.className = `msg ${m.role}`
    const who = { user: '你', assistant: 'AI', error: '错误', system: '系统' }[m.role] ?? m.role
    el.innerHTML = `<div class="who">${who}</div><div class="bubble">${escapeHtml(m.content)}</div>`
    host.appendChild(el)
  }

  // 流式输出中的临时气泡
  if (meta && !meta.done && !meta.error) {
    const el = document.createElement('div')
    el.className = 'msg assistant'
    const text = meta.streaming || ''
    el.innerHTML = `<div class="who">AI</div><div class="bubble">${escapeHtml(text)}<span class="typing"></span></div>`
    host.appendChild(el)
    if (meta.reasoning) {
      const r = document.createElement('details')
      r.className = 'reasoning'
      r.innerHTML = `<summary>模型思考过程（${meta.reasoning.length} 字）</summary><div class="body">${escapeHtml(meta.reasoning)}</div>`
      el.appendChild(r)
    }
  }

  // 待确认的操作卡
  if (app.pendingPreview) {
    host.appendChild(buildOpCard(app, app.pendingPreview))
  }

  // 注意：这里不能设 host.scrollTop。
  // 本函数执行时 host 往往还是个游离节点（buildAiPanel 在 renderMessages 之后
  // 才把它 appendChild 进 DOM），游离节点没有布局，scrollHeight 恒为 0，
  // 赋值等于把 scrollTop 归零、什么也没滚到。
  // 真正的「滚到底」交给 buildAiPanel 在挂载完成后处理。
}

function buildOpCard(app, pending) {
  const card = document.createElement('div')
  const applied = Boolean(pending.applied)
  const rejected = Boolean(pending.rejected)
  const failed = Boolean(pending.error)
  card.className = 'op-card ' + (failed ? 'failed' : rejected ? 'rejected' : applied ? 'applied' : 'pending')

  const preview = pending.preview
  const ops = pending.ops

  // 卡片头
  const head = document.createElement('div')
  head.className = 'op-card-head'
  const statusText = failed ? '执行失败' : rejected ? '已放弃' : applied ? '已执行' : '等待确认'
  head.innerHTML = `<span>▤ 编辑方案</span>
    <span class="badge">${ops.length} 条操作</span>
    <div class="spacer"></div>
    <span class="badge">${statusText}</span>`
  card.appendChild(head)

  // 操作明细
  const list = document.createElement('div')
  list.className = 'op-list'
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    const item = document.createElement('div')
    item.className = 'op-item'
    const perOp = preview?.perOp?.[i]
    const n = perOp?.changes ?? perOp?.error ?? ''
    item.innerHTML = `<div class="idx">${i + 1}</div>
      <div class="desc">${describeOp(op)}</div>
      ${n !== '' ? `<div style="color:#6b7c96;font-family:monospace;font-size:10.5px">${typeof n === 'number' ? n.toLocaleString() + ' 格' : '失败'}</div>` : ''}`
    list.appendChild(item)
  }
  card.appendChild(list)

  // 统计条
  const stats = document.createElement('div')
  stats.className = 'op-stats'
  stats.innerHTML = `
    <span class="stat">影响 <b>${(preview?.totalChanges ?? 0).toLocaleString()}</b> 格</span>
    ${preview?.bounds ? `<span class="stat">范围 <b>${preview.bounds.x1},${preview.bounds.y1},${preview.bounds.z1}</b> → <b>${preview.bounds.x2},${preview.bounds.y2},${preview.bounds.z2}</b></span>` : ''}
    ${applied ? `<span class="stat">已改动 <b>${(pending.appliedChanges ?? 0).toLocaleString()}</b> 格</span>` : ''}
  `
  card.appendChild(stats)

  // 警告
  if (pending.warnings?.length) {
    const w = document.createElement('div')
    w.className = 'op-warnings'
    w.innerHTML = pending.warnings.slice(0, 6).map((t) => `<div>· ${escapeHtml(t)}</div>`).join('')
    card.appendChild(w)
  }

  // 操作按钮
  const actions = document.createElement('div')
  actions.className = 'op-actions'
  if (!applied && !rejected && !failed) {
    const ok = document.createElement('button')
    ok.className = 'primary'
    ok.textContent = '✓ 确认执行'
    ok.onclick = () => { app.applyPendingPreview(); app.aiFocusWanted = true }
    actions.appendChild(ok)

    const no = document.createElement('button')
    no.textContent = '✕ 放弃'
    no.onclick = () => { app.rejectPendingPreview() }
    actions.appendChild(no)
  } else {
    const done = document.createElement('button')
    done.textContent = applied ? '收起' : '知道了'
    done.className = applied ? 'primary' : ''
    done.onclick = () => { app.dismissPendingPreview() }
    actions.appendChild(done)
  }
  card.appendChild(actions)

  return card
}

/** 把 op 翻译成一行中文描述（用户看的是这个，不是 JSON） */
function describeOp(op) {
  const b = (id) => {
    const def = BLOCK_BY_ID[id]
    return def
      ? `<span class="sw" style="background:${cssColor(def.color)}"></span><b>${def.label}</b>`
      : '<b>?</b>'
  }
  const box = `(${op.x1}, ${op.y1 ?? 0}, ${op.z1}) → (${op.x2}, ${op.y2 ?? 0}, ${op.z2})`
  const xz = `(${op.x1}, ${op.z1}) → (${op.x2}, ${op.z2})`

  switch (op.type) {
    case 'fill': return `填充区域 ${box} 为 ${b(op.block)}`
    case 'clear': return `挖空区域 ${box}`
    case 'replace': return `区域 ${box} 内把 ${b(op.from)} 替换为 ${b(op.to)}`
    case 'sphere': return `在 (${op.cx}, ${op.cy}, ${op.cz}) 放置半径 ${op.radius} 的 ${b(op.block)}球体`
    case 'sphere_at_surface': return `在 (${op.cx}, ${op.cz}) 地表放置半径 ${op.radius} 的 ${b(op.block)}球体`
    case 'cylinder': return `在 (${op.cx}, ${op.cy}, ${op.cz}) 放置半径 ${op.radius}、高 ${op.height} 的 ${b(op.block)}圆柱`
    case 'terrain': return `生成${terrainName(op.terrainType)}地形 ${xz}，基准高度 ${op.baseY}、起伏 ${op.amplitude}，表层 ${b(op.surface)}`
    case 'river': return `在 ${xz} 挖一条河：宽 ${op.width}、深 ${op.depth}、走向 ${dirName(op.direction)}，灌满 ${b(op.water)}`
    case 'layer': return `区域 ${xz} 地表向下 ${op.height} 格分层：表层 ${b(op.top)}、中层 ${b(op.middle)}、底层 ${b(op.bottom)}`
    case 'scatter': return `区域 ${xz} 地表按 ${(op.density * 100).toFixed(1)}% 密度散布 ${b(op.block)}`
    default: return `<b>${op.type}</b> ${JSON.stringify(op).slice(0, 90)}`
  }
}

function terrainName(t) {
  return { mountain: '山地', hills: '丘陵', plateau: '台地', valley: '谷地' }[t] ?? t
}
function dirName(d) {
  return { x: '东西向', z: '南北向', auto: '自动判定' }[d] ?? d
}

function buildInput(app) {
  const wrap = document.createElement('div')
  wrap.className = 'ai-input'

  // 快捷示例（只在没有对话历史时显示，避免长期占位）
  if (!app.chatHistory?.length) {
    const chips = document.createElement('div')
    chips.className = 'quick-chips'
    for (const t of EXAMPLE_PROMPTS.slice(0, 3)) {
      const c = document.createElement('button')
      c.textContent = t.length > 18 ? t.slice(0, 18) + '…' : t
      c.title = t
      c.onclick = () => {
        const ta = wrap.querySelector('textarea')
        ta.value = t
        ta.focus()
      }
      chips.appendChild(c)
    }
    wrap.appendChild(chips)
  }

  const ta = document.createElement('textarea')
  ta.placeholder = '描述你想要的编辑效果，例如：生成一片山地，并在山谷中挖出一条河\n（Enter 发送，Shift+Enter 换行）'
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }
  wrap.appendChild(ta)

  const row = document.createElement('div')
  row.className = 'row'

  if (app.aiBusy) {
    const stop = document.createElement('button')
    stop.className = 'danger'
    stop.textContent = '■ 停止'
    stop.onclick = () => app.cancelAi()
    row.appendChild(stop)
    const tip = document.createElement('span')
    tip.className = 'tip'
    tip.textContent = '正在生成…'
    row.appendChild(tip)
  } else {
    const send = document.createElement('button')
    send.className = 'primary'
    send.textContent = ' ↑ 发送'
    send.onclick = submit
    row.appendChild(send)
  }

  row.appendChild(Object.assign(document.createElement('div'), { className: 'spacer' }))

  // 「接入会话」入口。
  // 未连接时点它先弹说明（而不是直接弹文件夹对话框）——
  // 直接弹框的话，用户会先看到「选择文件夹」而完全不知道这是在干什么，
  // 大概率随手取消掉，这个功能就永远用不起来了。
  const extBtn = document.createElement('button')
  extBtn.className = app.bridge?.connected ? 'ghost' : 'ghost'
  extBtn.textContent = app.bridge?.connected ? '● 会话已接入' : '接入会话'
  extBtn.title = '让 WorkBuddy / DSH 里的对话直接驱动编辑器（不需要在这里填 Key）'
  if (app.bridge?.connected) extBtn.style.color = '#5ee38a'
  extBtn.onclick = () => {
    if (app.bridge?.connected) showBridgeInfo(app)
    else showBridgeGuide(app)
  }
  row.appendChild(extBtn)

  wrap.appendChild(row)

  function submit() {
    const text = ta.value.trim()
    if (!text) return
    ta.value = ''
    app.aiFocusWanted = true
    app.sendAiMessage(text)
  }

  // 让外部能触发 submit（示例 chips 用）
  wrap.__submit = submit
  return wrap
}

/**
 * 「接入会话」的使用说明。
 *
 * 这个功能是全项目最需要解释的一处 —— 它的工作方式不是「点一下就能用」，
 * 而是要用户在另一个对话窗口里让助手去读写一个目录。不说清楚，用户只会看到
 * 一个「连外部对话」的按钮，点完选了目录，然后……不知道下一步干什么。
 *
 * 所以这里把说明拆成两部分：
 *   showBridgeGuide()  —— 连接前的「这是什么、怎么用」，带分步引导
 *   showBridgeInfo()   —— 连接后的「现在是什么状态」，带操作按钮
 */
export function showBridgeGuide(app) {
  const isDesktop = app.bridge?.isDesktop

  openModal(app, {
    title: '接入会话 · 让对话直接改地形',
    body: `
      <div class="form-row"><label>它是做什么的</label>
        <div class="desc">
          让你在 WorkBuddy / DSH 的对话框里说「生成一片山地」，
          编辑器就真的把地形改了 —— <b>不需要在本程序里填任何 API Key</b>。
        </div></div>

      <div class="form-row"><label>怎么做到的</label>
        <div class="desc">
          两边通过一个共享文件夹通信，编辑器盯着它，助手往里写文件：<br><br>
          <code style="display:block;line-height:1.7;background:#0b0f16;padding:8px 10px;border-radius:6px">
            你在对话里说需求<br>
            &nbsp;&nbsp;↓ 助手把需求写成 requests/xxx.json<br>
            &nbsp;&nbsp;↓ 编辑器读到（约 1.2 秒一次）<br>
            &nbsp;&nbsp;↓ 生成操作卡片，<b>等你点「确认执行」</b><br>
            &nbsp;&nbsp;↓ 结果写进 responses/，需求归档到 processed/
          </code>
          <br>
          目录里还会自动放一份 <code>protocol.md</code>，
          助手读它就知道该怎么写指令、能表达哪些操作。
        </div></div>

      <div class="form-row"><label>三步用起来</label>
        <div class="desc">
          <b>1.</b> 点下面的「选择目录并连接」，挑一个空文件夹
          （编辑器会在里面自动建 <code>.mc-editor/</code>，不会动其他文件）。<br>
          <b>2.</b> 把下面这段提示词贴给对话里的助手：

          <div style="margin:8px 0;background:#0b0f16;border:1px solid #232d42;border-radius:6px;padding:9px 11px;font-family:monospace;font-size:11px;line-height:1.6;user-select:all">
            读一下 <b>【你的目录】/.mc-editor/protocol.md</b>，
            然后帮我在里面写一条指令：生成一片山地，并在山谷中挖出一条河。
          </div>

          <b>3.</b> 回到这个窗口，操作卡片会自己冒出来，点「确认执行」。
        </div></div>

      <div class="form-row"><label style="color:#ffd166">它和「自备 Key」的区别</label>
        <div class="desc">
          两条路只能二选一，但可以并存配置：<br>
          · <b>自备 Key</b> —— 在编辑器里直接跟模型对话，需要 <code>.env.local</code> 配 Key。<br>
          · <b>接入会话</b>（本功能）—— 编辑器自己不算模型，只执行指令，Key 留在对话环境里。
          适合「已经开着 WorkBuddy / DSH 在写东西，顺手让它改地形」的场景。<br><br>
          无论走哪条路，<b>改动前都会弹出操作卡片等你确认</b>，不会直接动世界。
        </div></div>

      <div class="form-row desc">${isDesktop
        ? '桌面版会记住你选的目录，下次启动自动接上，不用重选。'
        : '网页版需要保持这个页面打开，轮询才会进行；且每次刷新都要重新授权目录。'}</div>
    `,
    actions: [
      { label: '选择目录并连接', primary: true, close: true, onClick: () => app.connectBridge() },
      { label: '稍后再说', close: true },
    ],
  })
}

function showBridgeInfo(app) {
  const snap = app.stateSnapshot()
  const bridge = app.bridge
  const isDesktop = bridge.isDesktop
  const auto = bridge.isAutoConnected

  // 目录名要用后端自己的 label：桌面版是绝对路径，网页版是句柄名。
  // 之前写死读 `dirHandle.name`，桌面版没有 dirHandle，会永远显示不带路径的 '.mc-editor'。
  const dirLabel = bridge.dirLabel || '.mc-editor'

  const statusLine = auto
    ? `已自动连接（上次记住的目录）<br><span style="font-family:monospace;font-size:11px;word-break:break-all">${escapeHtml(dirLabel)}</span>`
    : `已连接<br><span style="font-family:monospace;font-size:11px;word-break:break-all">${escapeHtml(dirLabel)}</span>`

  openModal(app, {
    title: '接入会话 · 已连接',
    body: `
      <div class="form-row"><label>状态</label>
        <div class="desc" style="color:#5ee38a">${statusLine}</div></div>
      <div class="form-row"><label>已处理指令</label>
        <div class="desc">${bridge.processedCount} 条</div></div>

      <div class="form-row"><label>接下来做什么</label>
        <div class="desc">
          把这句话贴给对话里的助手（把路径换成上面那个）：
          <div style="margin:8px 0;background:#0b0f16;border:1px solid #232d42;border-radius:6px;padding:9px 11px;font-family:monospace;font-size:11px;line-height:1.6;user-select:all">
            读一下 <b>${escapeHtml(dirLabel)}/protocol.md</b>，
            然后往 requests/ 里写一条指令：生成一片山地，并在山谷中挖出一条河。
          </div>
          编辑器约 1.2 秒轮询一次，发现新指令就会弹出操作卡片等你确认。
        </div></div>

      <div class="form-row"><label>工作方式</label>
        <div class="desc">
          编辑器在选定的目录下维护 <code>.mc-editor/</code>：<br>
          · <code>protocol.md</code> —— 写给助手看的协议说明（编辑器自动生成）<br>
          · <code>state.json</code> —— 当前世界尺寸／选区／方块统计（只读，助手据此算坐标）<br>
          · <code>requests/</code> —— 助手写指令的地方<br>
          · <code>responses/</code> —— 处理结果<br>
          · <code>processed/</code> —— 处理过的指令归档（保证不会重复执行）
        </div></div>

      <div class="form-row"><label>当前世界快照</label>
        <div class="desc" style="font-family:monospace;font-size:11px;max-height:160px;overflow:auto;white-space:pre-wrap">${escapeHtml(JSON.stringify(snap, null, 1))}</div></div>

      <div class="form-row desc">提示：${isDesktop
        ? '桌面版会记住这个目录，下次启动自动接上。'
        : '浏览器需要保持这个页面打开，轮询才会进行；且每次刷新都要重新授权目录。'}</div>
    `,
    actions: [
      { label: '查看用法说明', close: false, onClick: () => showBridgeGuide(app) },
      { label: '立即检查一次', close: false, onClick: async () => {
        try {
          await app.bridge.checkNow()
          app.toast('已检查并同步状态', 'ok')
        } catch (err) { app.toast(`检查失败：${err.message}`, 'error') }
      } },
      ...(isDesktop ? [{ label: '打开目录', close: false, onClick: async () => {
        try { await window.desktop.bridge.reveal(bridge.fs.dir) }
        catch (err) { app.toast(`打开目录失败：${err.message}`, 'error') }
      } }] : []),
      { label: '断开连接', danger: true, onClick: () => app.disconnectBridge() },
      { label: '关闭', primary: true, close: true },
    ],
  })
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
