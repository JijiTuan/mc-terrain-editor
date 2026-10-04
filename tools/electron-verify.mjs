/**
 * tools/electron-verify.mjs — 桌面版启动自检
 *
 * 用一个临时探针脚本启动 Electron，断言「窗口建出来了、渲染进程真的跑起来了、
 * preload 的能力桥挂上了、编辑器内核初始化完成」。跑完自动退出，适合放进 CI。
 *
 * 为什么不能用普通 Node 脚本测：编辑器的渲染、WebGL、preload 桥都只在
 * Electron 的真实浏览器进程里存在，Node 里 import 这些模块根本跑不到那些分支。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import net from 'node:net'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEV = process.argv.includes('--dev')
const PORT = Number(process.env.MC_EDITOR_PORT || 5173)

const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')

const probePath = path.join(ROOT, '.electron-verify-probe.cjs')
const outPath = path.join(ROOT, '.electron-verify.json')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV
if (DEV) env.MC_EDITOR_DEV_SERVER = `http://127.0.0.1:${PORT}`
else delete env.MC_EDITOR_DEV_SERVER

// 探针：加载真实主进程，等它建窗口，然后探 DOM
const probe = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), path = require('path')
const LOG = ${JSON.stringify(outPath)}
const events = []
const done = (code) => { try { fs.writeFileSync(LOG, JSON.stringify(events, null, 2)) } catch {} app.exit(code) }

const hardTimer = setTimeout(() => { events.push({ t: 'TIMEOUT' }); done(1) }, 30000)

app.whenReady().then(async () => {
  events.push({ t: 'ready', processType: process.type })
  try { require(path.join(${JSON.stringify(ROOT)}, 'electron', 'main.cjs')) }
  catch (err) { events.push({ t: 'main.cjs FAILED', error: err.message, stack: String(err.stack).slice(0,900) }); clearTimeout(hardTimer); return done(1) }
  events.push({ t: 'main.cjs loaded' })

  // 等窗口出现且加载完成
  let waited = 0
  while (BrowserWindow.getAllWindows().length === 0 && waited < 20000) {
    await new Promise(r => setTimeout(r, 250)); waited += 250
  }
  const wins = BrowserWindow.getAllWindows()
  events.push({ t: 'windows', count: wins.length })
  if (!wins.length) { clearTimeout(hardTimer); return done(1) }
  const w = wins[0]

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world && window.__MC_EDITOR__.renderer)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }

  try {
    const r = await w.webContents.executeJavaScript(\`(() => {
      const a = window.__MC_EDITOR__
      // 视口 canvas 必须从「不在 minimap 里」的那些里挑：小地图也是一个 canvas，
      // 而它的 2D context 一旦建立，再调 getContext('webgl2') 会返回 null，
      // 于是「WebGL 不可用」的假失败就出现了。按父容器排除掉它。
      const canvases = [...document.querySelectorAll('canvas')]
      const canvas = canvases.find(c => c.parentElement && c.parentElement.classList.contains('viewport'))
        || (a && a.renderer && a.renderer.renderer ? a.renderer.renderer.domElement : null)
      const gl = canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))
      return {
        title: document.title,
        hasWorld: !!(a && a.world),
        dims: a && a.world ? [a.world.width, a.world.height, a.world.depth] : null,
        hasRenderer: !!(a && a.renderer),
        hasAi: !!(a && a.ai),
        hasStore: !!(a && a.store),
        hasBridge: !!(a && a.bridge),
        isDesktop: !!(a && a.bridge && a.bridge.isDesktop),
        bridgeSupported: !!(a && a.bridge && a.bridge.supported),
        bridgeConnected: !!(a && a.bridge && a.bridge.connected),
        hasDesktopGlobal: !!window.desktop,
        desktopIsElectron: !!(window.desktop && window.desktop.isElectron),
        canvasCount: document.querySelectorAll('canvas').length,
        glVersion: gl ? gl.getParameter(gl.VERSION) : null,
        buttons: document.querySelectorAll('button').length,
        topbar: !!document.querySelector('.topbar'),
        toolbar: !!document.querySelector('.toolbar'),
        viewport: !!document.querySelector('.viewport'),
        aiPanel: !!document.querySelector('.ai-panel'),
        swatches: document.querySelectorAll('.swatch').length,
      }
    })()\`)
    events.push({ t: 'probe', ...r })
  } catch (err) {
    events.push({ t: 'probe FAILED', error: err.message })
    clearTimeout(hardTimer); return done(1)
  }

  // 顺带验证预览数 == 执行数（桌面版里同样必须成立）。
  // 注意返回结构是 { validation, pipeline: { previewMatchesApply, ... } } —— 断言必须往下钻一层，
  // 读错层级会让断言永远取不到值、然后被当「跳过」放过去，那就是假绿。
  try {
    const pv = await w.webContents.executeJavaScript(\`(() => {
      const a = window.__MC_EDITOR__
      if (!a || !a.__test__) return { error: '__test__ 入口不存在' }
      const r = a.__test__.validatePreviewExecute([
        { type: 'terrain', terrainType: 'hills', x1: 2, y1: 0, z1: 2, x2: 30, y2: 40, z2: 30, amplitude: 6 },
      ])
      const p = r && r.pipeline
      return {
        validationOk: !!(r && r.validation && r.validation.ok),
        validationError: (r && r.validation && r.validation.error) || null,
        previewMatchesApply: p ? p.previewMatchesApply === true : null,
        previewTotalChanges: p ? p.previewTotalChanges : null,
        appliedChanged: p ? p.appliedChanged : null,
        perOp: p ? p.perOp : null,
      }
    })()\`)
    events.push({ t: 'previewExecute', ...pv })
  } catch (err) {
    events.push({ t: 'previewExecute FAILED', error: err.message })
  }

  clearTimeout(hardTimer)
  done(0)
})
`

fs.writeFileSync(probePath, probe)

if (DEV) {
  const ok = await new Promise((resolve) => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => { s.destroy(); resolve(false) })
    setTimeout(() => { s.destroy(); resolve(false) }, 1500)
  })
  if (!ok) { console.error(`[verify] --dev 需要 Vite 已在 ${PORT} 运行`); process.exit(1) }
}

const args = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', probePath]
const child = spawn(electronBin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env })

let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
child.stdout.on('data', () => {})

child.on('close', () => {
  fs.rmSync(probePath, { force: true })
  let events = []
  try { events = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch {}
  fs.rmSync(outPath, { force: true })

  const fail = (msg) => { console.error(`FAIL  ${msg}`); return 1 }
  let failed = 0
  const check = (name, cond, extra = '') => {
    if (cond) console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`)
    else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
  }

  console.log('\n=== Electron 桌面版启动自检 ===\n')
  const probeEv = events.find((e) => e.t === 'probe')
  const mainFail = events.find((e) => e.t === 'main.cjs FAILED')

  check('主进程模块加载', !mainFail, mainFail?.error ?? '')
  check('process.type = browser', events.find((e) => e.t === 'ready')?.processType === 'browser')
  check('窗口已创建', (events.find((e) => e.t === 'windows')?.count ?? 0) === 1)

  if (probeEv) {
    check('preload 能力桥挂载', probeEv.desktopIsElectron === true)
    check('桥接识别为桌面版', probeEv.isDesktop === true)
    check('编辑器内核就绪', probeEv.hasWorld && probeEv.hasRenderer)
    check('AI / 存储 / 桥接子系统就位', probeEv.hasAi && probeEv.hasStore && probeEv.hasBridge)
    check('世界尺寸', Array.isArray(probeEv.dims), JSON.stringify(probeEv.dims))
    check('WebGL 可用', typeof probeEv.glVersion === 'string', probeEv.glVersion ?? '')
    check('主界面骨架', probeEv.topbar && probeEv.toolbar && probeEv.viewport && probeEv.aiPanel)
    check('canvas 数量 = 2（视口 + 小地图）', probeEv.canvasCount === 2, String(probeEv.canvasCount))
    console.log(`     按钮 ${probeEv.buttons} 个 / 色板 ${probeEv.swatches} 个`)
  } else {
    failed++
    console.error('FAIL  渲染进程探针无结果')
    console.error(events.map((e) => JSON.stringify(e)).join('\n'))
  }

  const pv = events.find((e) => e.t === 'previewExecute')
  if (!pv) {
    failed++
    console.error('FAIL  预览/执行一致性：探针未返回结果（不是「跳过」，是没测到）')
  } else if (pv.error) {
    failed++
    console.error(`FAIL  预览/执行一致性：${pv.error}`)
  } else {
    check('操作通过校验', pv.validationOk === true, pv.validationError ?? '')
    check('预览数 === 执行数', pv.previewMatchesApply === true,
      `preview=${pv.previewTotalChanges} apply=${pv.appliedChanged}`)
    if (Array.isArray(pv.perOp)) console.log(`     分项：${pv.perOp.map((o) => o.type + ':' + o.changes).join(' / ')}`)
  }

  if (stderr.trim()) {
    const noisy = stderr.split('\n').filter((l) => l.trim() && !/crashpad|GPU|Fontconfig|DevTools/i.test(l))
    if (noisy.length) console.log('\n--- stderr（已滤噪）---\n' + noisy.slice(0, 10).join('\n'))
  }

  console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}\n`)
  process.exit(failed === 0 ? 0 : 1)
})
