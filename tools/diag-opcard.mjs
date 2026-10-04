/**
 * tools/diag-opcard.mjs — 实测操作卡片的渲染
 *
 * 目的：确认「pendingPreview 有值」时，.op-card 到底有没有出现在 DOM 里。
 * 前一次实测拿到 opCard: null —— 但那次是空世界的初始状态，没有待确认操作，
 * 所以 null 是正常的。这次要主动造一个待确认状态，再看卡片。
 *
 * 做法：注入脚本 → 直接调 app.applyAiOps / runAiInstruction 的产物 → 检查 DOM。
 * 为避免依赖大模型（不可控、要网络），直接构造 pendingPreview 走 UI 渲染路径。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const probePath = path.join(ROOT, '.diag-opcard-probe.cjs')
const outPath = path.join(ROOT, '.diag-opcard.json')
const shotPath = path.join(ROOT, '.diag-opcard.png')

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
  const wins = BrowserWindow.getAllWindows()
  if (!wins.length) { events.push({ t: 'no window' }); clearTimeout(hardTimer); return done(1) }
  const w = wins[0]

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }
  events.push({ t: 'editor ready' })

  // 收集渲染期错误 —— 如果 buildOpCard 抛异常，这里能抓到
  await w.webContents.executeJavaScript(\`(() => {
    window.__diagErrors = []
    window.addEventListener('error', (e) => window.__diagErrors.push(String(e.message)))
    const origError = console.error
    console.error = function(...a) { window.__diagErrors.push('console.error: ' + a.map(String).join(' ')); return origError.apply(console, a) }
    return true
  })()\`).catch(() => {})

  // ── 造一个待确认操作 ──
  // 走 app 的真实路径：先构造 ops，再赋 pendingPreview，再 refresh。
  const SETUP = \`(() => {
    const a = window.__MC_EDITOR__
    const out = { steps: [] }
    try {
      out.hasApp = Boolean(a)
      out.hasRefresh = typeof a.refreshAiPanel === 'function'
      out.hasApply = typeof a.applyPendingPreview === 'function'
      // 造一个 fill 操作，覆盖一小块区域，避免影响太大
      a.pendingPreview = {
        ops: [{ type: 'fill', x1: 2, y1: 1, z1: 2, x2: 8, y2: 3, z2: 8, block: 'stone' }],
        preview: { totalChanges: 147, bounds: { x1: 2, y1: 1, z1: 2, x2: 8, y2: 3, z2: 8 }, perOp: [{ changes: 147 }], affected: [] },
        warnings: [],
        instruction: '诊断用：铺一块石头',
        createdAt: Date.now(),
      }
      out.pendingPreviewSet = Boolean(a.pendingPreview)
      a.refreshAiPanel()
      out.refreshed = true
    } catch (err) { out.error = String(err && err.stack || err) }
    return out
  })()\`
  const setup = await w.webContents.executeJavaScript(SETUP).catch(e => ({ error: String(e) }))
  events.push({ t: 'setup', data: setup })

  await new Promise(r => setTimeout(r, 800))

  const CHECK = \`(() => {
    const msgs = document.querySelector('.ai-messages')
    const card = document.querySelector('.op-card')
    const actions = document.querySelector('.op-actions')
    const btns = actions ? [...actions.querySelectorAll('button')].map(b => b.textContent) : []
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width), top: Math.round(b.top), bottom: Math.round(b.bottom) } }
    return {
      msgsChildCount: msgs ? msgs.children.length : -1,
      msgsRect: r(msgs),
      msgsScroll: msgs ? { scrollH: msgs.scrollHeight, clientH: msgs.clientHeight, canScroll: msgs.scrollHeight > msgs.clientHeight + 1, scrollTop: msgs.scrollTop } : null,
      cardFound: Boolean(card),
      cardRect: r(card),
      cardClass: card ? card.className : null,
      cardVisibleInMsgs: (() => {
        if (!card || !msgs) return null
        const cb = card.getBoundingClientRect(), mb = msgs.getBoundingClientRect()
        return { cardBottom: Math.round(cb.bottom), msgsBottom: Math.round(mb.bottom), fullyVisible: cb.bottom <= mb.bottom + 1 }
      })(),
      actionsFound: Boolean(actions),
      actionButtons: btns,
      errors: window.__diagErrors || [],
    }
  })()\`
  const check = await w.webContents.executeJavaScript(CHECK).catch(e => ({ error: String(e) }))
  events.push({ t: 'check', data: check })

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
