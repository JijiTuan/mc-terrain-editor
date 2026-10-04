/**
 * tools/diag-opcard-scroll.mjs — 验证「新操作卡出现时能不能被看到」
 *
 * 复现用户的真实场景：先聊过几轮（消息流已经很高），
 * 然后新的待确认操作卡出现，检查它是否落在可视区内。
 *
 * 修复前预期：卡片在可视区外，且 scrollTop 被恢复到旧值。
 * 修复后预期：卡片底部落在消息区可视范围内。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const probePath = path.join(ROOT, '.diag-scroll-probe.cjs')
const outPath = path.join(ROOT, '.diag-scroll.json')
const shotPath = path.join(ROOT, '.diag-scroll.png')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV
delete env.MC_EDITOR_DEV_SERVER

const probe = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), path = require('path')
const LOG = ${JSON.stringify(outPath)}
const events = []
const done = (code) => { try { fs.writeFileSync(LOG, JSON.stringify(events, null, 2)) } catch {} app.exit(code) }
const hardTimer = setTimeout(() => { events.push({ t: 'TIMEOUT' }); done(1) }, 45000)

app.whenReady().then(async () => {
  try { require(path.join(${JSON.stringify(ROOT)}, 'electron', 'main.cjs')) }
  catch (err) { events.push({ t: 'main FAILED', error: err.message }); clearTimeout(hardTimer); return done(1) }

  let waited = 0
  while (BrowserWindow.getAllWindows().length === 0 && waited < 20000) {
    await new Promise(r => setTimeout(r, 250)); waited += 250
  }
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { events.push({ t: 'no window' }); clearTimeout(hardTimer); return done(1) }

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }

  // 步骤 1：灌入 8 轮对话，构造「已经聊过一阵」的状态
  const step1 = await w.webContents.executeJavaScript(\`(() => {
    const a = window.__MC_EDITOR__
    a.chatHistory = []
    for (let i = 0; i < 8; i++) {
      a.chatHistory.push({ role: 'user', content: '第 ' + (i+1) + ' 条：把这一带改成丘陵地形' })
      a.chatHistory.push({ role: 'assistant', content: '好的，已规划 ' + (i+1) + ' 号方案，共 3 条操作。' })
    }
    a.pendingPreview = null
    a.refreshAiPanel()
    const m = document.querySelector('.ai-messages')
    // 把用户滚到中间偏上的位置，模拟「正在翻看历史」
    m.scrollTop = Math.floor(m.scrollHeight * 0.4)
    return { scrollTop: m.scrollTop, scrollH: m.scrollHeight, clientH: m.clientHeight, canScroll: m.scrollHeight > m.clientHeight + 1 }
  })()\`).catch(e => ({ error: String(e) }))
  events.push({ t: 'step1_灌入历史并滚到中间', data: step1 })

  await new Promise(r => setTimeout(r, 400))

  // 步骤 2：新操作卡到来（走真实路径：赋 pendingPreview + refreshAiPanel）
  const step2 = await w.webContents.executeJavaScript(\`(() => {
    const a = window.__MC_EDITOR__
    a.pendingPreview = {
      ops: [{ type: 'terrain', terrainType: 'hills', x1: 4, y1: 0, z1: 4, x2: 40, y2: 20, z2: 40, amplitude: 6 }],
      preview: { totalChanges: 5184, bounds: { x1: 4, y1: 1, z1: 4, x2: 40, y2: 20, z2: 40 }, perOp: [{ changes: 5184 }], affected: [] },
      warnings: [],
      instruction: '生成一片丘陵',
      createdAt: Date.now(),
    }
    a.refreshAiPanel()
    return true
  })()\`).catch(e => ({ error: String(e) }))
  events.push({ t: 'step2_注入新卡', data: step2 })

  await new Promise(r => setTimeout(r, 900))

  // 步骤 3：量卡片是否可见（等动画帧滚动完成）
  const step3 = await w.webContents.executeJavaScript(\`(async () => {
    // 等两帧，让 scrollToBottom 里的 rAF 链跑完
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const msgs = document.querySelector('.ai-messages')
    const card = document.querySelector('.op-card')
    const actions = document.querySelector('.op-actions')
    const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) } }
    if (!msgs) return { err: 'no msgs' }
    const mb = msgs.getBoundingClientRect()
    const cb = card ? card.getBoundingClientRect() : null
    const ab = actions ? actions.getBoundingClientRect() : null
    return {
      msgs: { ...R(msgs), scrollTop: Math.round(msgs.scrollTop), scrollH: msgs.scrollHeight, clientH: msgs.clientHeight, maxScroll: msgs.scrollHeight - msgs.clientHeight },
      card: R(card),
      actions: R(actions),
      cardFound: Boolean(card),
      buttons: actions ? [...actions.querySelectorAll('button')].map(b => b.textContent) : [],
      // 关键断言：确认按钮是否落在消息区可视范围内
      actionsVisible: ab ? (ab.top >= mb.top - 1 && ab.bottom <= mb.bottom + 1) : null,
      cardVisible: cb ? (cb.bottom <= mb.bottom + 1 && cb.top >= mb.top - 1) : null,
      distanceBelowViewport: cb ? Math.round(cb.bottom - mb.bottom) : null,
      pinnedToBottom: Math.abs(msgs.scrollHeight - msgs.clientHeight - msgs.scrollTop) <= 2,
    }
  })()\`).catch(e => ({ error: String(e) }))
  events.push({ t: 'step3_可见性判定', data: step3 })

  const img = await w.webContents.capturePage().catch(() => null)
  if (img) { try { fs.writeFileSync(${JSON.stringify(shotPath)}, img.toPNG()) } catch {} }

  clearTimeout(hardTimer)
  done(0)
})
`

fs.writeFileSync(probePath, probe)
const child = spawn(electronBin, [probePath, '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env,
})
let err = ''
child.stderr.on('data', (d) => { err += d.toString() })
await new Promise((res) => child.on('exit', res))

try {
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  for (const ev of data) console.log('\n[' + ev.t + ']\n' + JSON.stringify(ev.data ?? ev, null, 2))
} catch (e) {
  console.error('读结果失败：', e.message, '\n', err.slice(-1500))
}
try { fs.unlinkSync(probePath) } catch {}
