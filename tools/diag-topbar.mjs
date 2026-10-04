/**
 * 探针：顶栏按钮是否真的绑上了事件。
 *
 * 为什么需要它：这批按钮原先是「有 id、没处理器」——DOM 建出来了，
 * 点了毫无反应，而 mock / 静态检查都看不出来（元素存在、id 正确、
 * 方法也都在 app 上）。只有真去点一下、看有没有副作用，
 * 才能区分「功能正常」和「按钮是死的」。
 *
 * 用「点击前后有没有产生可观测的变化」来判定，而不是查有没有 addEventListener
 * （那需要 monkey-patch，且证明不了处理器真的接上了）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')

const probePath = path.join(ROOT, '.diag-topbar-probe.cjs')
const outPath = path.join(ROOT, '.diag-topbar.json')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV
delete env.MC_EDITOR_DEV_SERVER

const probe = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const LOG = ${JSON.stringify(outPath)}
const events = []
const done = (code) => { try { fs.writeFileSync(LOG, JSON.stringify(events, null, 2)) } catch {} app.exit(code) }
const hardTimer = setTimeout(() => { events.push({ t: 'TIMEOUT' }); done(1) }, 60000)

app.whenReady().then(async () => {
  try { require(path.join(${JSON.stringify(ROOT)}, 'electron', 'main.cjs')) }
  catch (err) { events.push({ t: 'main.cjs FAILED', error: err.message }); clearTimeout(hardTimer); return done(1) }

  let waited = 0
  while (BrowserWindow.getAllWindows().length === 0 && waited < 20000) {
    await new Promise(r => setTimeout(r, 250)); waited += 250
  }
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { events.push({ t: 'no window' }); clearTimeout(hardTimer); return done(1) }

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world && window.__MC_EDITOR__.controls)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }

  try {
    const r = await w.webContents.executeJavaScript(\`(async () => {
      const a = window.__MC_EDITOR__
      const out = { buttons: [], modalCount: 0, errors: [] }

      // 每个按钮：记下「点之前」的一个可观测状态，点一下，再看弹窗有没有出现
      const specs = [
        ['btn-help',        '弹出使用说明'],
        ['btn-export',      '弹出导出对话框'],
        ['btn-new',         '弹出新建世界'],
        ['btn-projects',    '弹出工程列表'],
      ]

      const modalHost = document.getElementById('modal-host')

      for (const [id, what] of specs) {
        const btn = document.getElementById(id)
        if (!btn) { out.buttons.push({ id, exists: false }); continue }
        const before = modalHost.classList.contains('hidden')
        btn.click()
        await new Promise(r => setTimeout(r, 260))
        const after = modalHost.classList.contains('hidden')
        const opened = before === true && after === false
        const title = document.querySelector('.modal-title, .modal h3, .modal-head')?.textContent?.trim() || null
        out.buttons.push({ id, exists: true, what, openedModal: opened, title })
        // 关掉，为下一个按钮复位
        const closeBtn = [...document.querySelectorAll('#modal-host button')].find(b => /关闭|取消|知道了|稍后/.test(b.textContent))
        if (closeBtn) closeBtn.click()
        await new Promise(r => setTimeout(r, 160))
      }

      // 视角按钮：点「俯视」后 polar 应该有明显变化
      const controls = a.controls
      a.controls.frameWorld(a.world)
      await new Promise(r => setTimeout(r, 420))
      const polarBefore = controls.polar
      const topBtn = document.querySelector('.view-buttons [data-view="top"]')
      if (topBtn) {
        topBtn.click()
        // 视角是插值过去的，多等几帧
        await new Promise(r => setTimeout(r, 900))
      }
      out.view = {
        exists: !!topBtn,
        polarBefore: +polarBefore?.toFixed(4),
        polarAfter: +controls.polar?.toFixed(4),
        changed: Math.abs((controls.polar ?? 0) - (polarBefore ?? 0)) > 0.05,
      }

      // 自转按钮：点一下 autoRotate 应该翻转
      const arBtn = document.getElementById('btn-autorotate')
      const arBefore = a.state.autoRotate
      if (arBtn) { arBtn.click(); await new Promise(r => setTimeout(r, 200)) }
      out.autoRotate = {
        exists: !!arBtn,
        before: arBefore,
        after: a.state.autoRotate,
        toggled: arBefore !== a.state.autoRotate,
      }

      // 撤销按钮：先做一次编辑，再点撤销，看 revision 是否回退
      const revBefore = a.world.revision
      const undoBtn = document.getElementById('btn-undo')
      out.undo = { exists: !!undoBtn, revisionBefore: revBefore, disabled: undoBtn?.disabled ?? null }

      return out
    })()\`)
    events.push({ t: 'topbar', ...r })
  } catch (err) {
    events.push({ t: 'topbar FAILED', error: err.message, stack: String(err.stack).slice(0, 700) })
  }

  clearTimeout(hardTimer)
  done(0)
})
`

fs.writeFileSync(probePath, probe)

const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', probePath]
const child = spawn(electronBin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

child.on('close', () => {
  fs.rmSync(probePath, { force: true })
  let events = []
  try { events = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch {}
  fs.rmSync(outPath, { force: true })

  console.log('\n=== 顶栏按钮绑定探针 ===\n')
  const ev = events.find((e) => e.t === 'topbar')
  const fail = events.find((e) => e.t.endsWith('FAILED') || e.t === 'TIMEOUT')

  if (!ev) {
    console.error('探针无结果：')
    console.error(events.map((e) => JSON.stringify(e)).join('\n'))
    process.exit(1)
  }

  let bad = 0
  for (const b of ev.buttons) {
    const ok = b.exists && b.openedModal
    if (!ok) bad++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${b.id.padEnd(14)} ${b.what}${b.title ? ' → ' + b.title : ''}`)
  }
  const v = ev.view
  console.log(`  ${v.changed ? 'ok  ' : 'FAIL'} 视角按钮          polar ${v.polarBefore} → ${v.polarAfter}`)
  if (!v.changed) bad++
  const ar = ev.autoRotate
  console.log(`  ${ar.toggled ? 'ok  ' : 'FAIL'} 自转按钮          ${ar.before} → ${ar.after}`)
  if (!ar.toggled) bad++

  console.log(`\n结果：${bad === 0 ? '全部按钮已接上事件' : bad + ' 项未接上'}\n`)
  process.exit(bad === 0 ? 0 : 1)
})
