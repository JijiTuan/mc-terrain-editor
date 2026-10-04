/**
 * tools/diag-panel-layout.mjs — 量 AI 面板的真实布局尺寸与滚动能力
 *
 * 为什么要实测而不是读 CSS：
 *   `.ai-messages{flex:1;overflow-y:auto;min-height:0}` 这套写法看起来是对的，
 *   但「看起来对」不代表浏览器算出来的盒子对。要拿到 offsetHeight / scrollHeight /
 *   clientHeight 的实际数字，才能判定是谁把高度吃掉了。
 *
 * 做法沿用 electron-verify.mjs：临时探针 require 真实 main.cjs → 等窗口就绪
 * → webContents.executeJavaScript 注入测量脚本 → 写结果文件。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')

const probePath = path.join(ROOT, '.diag-layout-probe.cjs')
const outPath = path.join(ROOT, '.diag-layout.json')

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
const hardTimer = setTimeout(() => { events.push({ t: 'TIMEOUT' }); done(1) }, 40000)

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

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }

  const MEASURE = \`(() => {
    const q = (s) => document.querySelector(s)
    const box = (el) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      return {
        h: Math.round(r.height), w: Math.round(r.width),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        offsetH: el.offsetHeight,
        canScroll: el.scrollHeight > el.clientHeight + 1,
        overflowY: cs.overflowY, flex: cs.flex, minHeight: cs.minHeight,
        display: cs.display, position: cs.position,
      }
    }
    const panel = q('.ai-panel')
    const msgs = q('.ai-messages')
    const input = q('.ai-input')
    const head = q('.ai-head')
    return {
      win: { h: window.innerHeight, w: window.innerWidth },
      found: { panel: !!panel, messages: !!msgs, input: !!input, head: !!head },
      panel: box(panel),
      head: box(head),
      messages: box(msgs),
      input: box(input),
      sumChildren: [head, msgs, input].filter(Boolean).reduce((a,el)=>a+Math.round(el.getBoundingClientRect().height),0),
      msgsChildren: msgs ? msgs.children.length : 0,
      opCard: box(q('.op-card')),
      panelParents: (() => {
        const out = []
        let el = panel
        for (let i = 0; i < 4 && el; i++) {
          const cs = getComputedStyle(el)
          out.push({ cls: el.className || el.id, h: Math.round(el.getBoundingClientRect().height),
                     overflow: cs.overflow, minH: cs.minHeight, display: cs.display })
          el = el.parentElement
        }
        return out
      })(),
    }
  })()\`

  const m = await w.webContents.executeJavaScript(MEASURE).catch(e => ({ error: String(e) }))
  events.push({ t: 'measure', data: m })

  // 注入 20 条消息撑高，再测能不能滚
  const FORCE = \`(() => {
    const msgs = document.querySelector('.ai-messages')
    if (!msgs) return { err: 'no .ai-messages' }
    const before = { scrollH: msgs.scrollHeight, clientH: msgs.clientHeight, canScroll: msgs.scrollHeight > msgs.clientHeight + 1 }
    for (let i = 0; i < 20; i++) {
      const d = document.createElement('div')
      d.className = 'msg user'
      d.innerHTML = '<div class="who">你</div><div class="bubble">撑高内容区测试 ' + i + '</div>'
      msgs.appendChild(d)
    }
    const after = { scrollH: msgs.scrollHeight, clientH: msgs.clientHeight }
    msgs.scrollTop = msgs.scrollHeight
    return { before, after, afterScrollTop: msgs.scrollTop, scrollWorked: msgs.scrollTop > 0 }
  })()\`
  const f = await w.webContents.executeJavaScript(FORCE).catch(e => ({ error: String(e) }))
  events.push({ t: 'forceScroll', data: f })

  // 截图存证
  const img = await w.webContents.capturePage().catch(() => null)
  if (img) { try { fs.writeFileSync(path.join(${JSON.stringify(ROOT)}, '.diag-layout.png'), img.toPNG()) } catch {} }

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
  for (const ev of data) {
    if (ev.t === 'measure') console.log('\n=== 面板布局实测 ===\n' + JSON.stringify(ev.data, null, 2))
    else if (ev.t === 'forceScroll') console.log('\n=== 撑高后滚动实测 ===\n' + JSON.stringify(ev.data, null, 2))
    else console.log('[probe]', JSON.stringify(ev))
  }
} catch (e) {
  console.error('读结果失败：', e.message)
  console.error(err.slice(-1500))
}
try { fs.unlinkSync(probePath) } catch {}
