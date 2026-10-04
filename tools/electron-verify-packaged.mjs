/**
 * tools/electron-verify-packaged.mjs — 验证【打包产物】能真正启动
 *
 * 与 electron-verify.mjs 的区别：
 *   那个测的是「源码 + 未打包 Electron」，能过不代表打得出的安装包能跑 ——
 *   常见坑有 asar 里路径写错、files 规则漏文件、main 入口在包内解析不到。
 *   这个脚本直接启动 win-unpacked 里那个已改名的 exe，
 *   连上它的调试端口用 CDP 探 DOM。
 *
 * 为什么要连调试端口而不是像源码版那样 require 主进程：
 *   打包后的主进程在 asar 里，外部脚本没法 require 它。
 *   所以让 exe 自己带 --remote-debugging-port 起，再走 CDP。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9333

// 找最新的 release 目录
const dirs = fs.readdirSync(ROOT)
  .filter((f) => /^release\d*$/.test(f) && fs.existsSync(path.join(ROOT, f, 'win-unpacked')))
  .sort((a, b) => fs.statSync(path.join(ROOT, b)).mtimeMs - fs.statSync(path.join(ROOT, a)).mtimeMs)
if (!dirs.length) { console.error('找不到任何 release*/win-unpacked，请先运行 npm run pack'); process.exit(1) }
const rel = dirs[0]
const unpacked = path.join(ROOT, rel, 'win-unpacked')
const exeFile = fs.readdirSync(unpacked).find((f) => f.endsWith('.exe'))
const exePath = path.join(unpacked, exeFile)
console.log(`验证 ${rel}/win-unpacked/${exeFile}`)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV

const child = spawn(exePath, [
  `--remote-debugging-port=${PORT}`,
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
], { cwd: unpacked, stdio: ['ignore', 'pipe', 'pipe'], env })

let stderr = ''
child.stderr.on('data', (d) => { stderr += d.toString() })
child.stdout.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  return null
}

/** 极简 CDP 客户端：够用就行，不引第三方依赖 */
async function cdpEval(wsUrl, expression) {
  const { WebSocket } = await import('node:worker_threads').then(() => ({ WebSocket: globalThis.WebSocket }))
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')) }, 20000)
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id === 1) {
        clearTimeout(timer); ws.close()
        if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text))
        else resolve(msg.result?.result?.value)
      }
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) }
  })
}

const target = await findTarget()
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok  ${name}${extra ? ' — ' + extra : ''}`)
  else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`) }
}

console.log('\n=== 打包产物启动自检 ===\n')
check('进程保持运行', !child.exitCode)
check('调试端口可连', Boolean(target))

if (target) {
  // 等编辑器内核就绪
  let ready = false
  for (let i = 0; i < 40; i++) {
    try {
      ready = await cdpEval(target.webSocketDebuggerUrl,
        'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.world && window.__MC_EDITOR__.renderer)')
      if (ready) break
    } catch { /* 页面还在加载 */ }
    await sleep(500)
  }
  check('编辑器内核就绪', ready)

  try {
    const probe = await cdpEval(target.webSocketDebuggerUrl, `(() => {
      const a = window.__MC_EDITOR__
      const canvases = [...document.querySelectorAll('canvas')]
      const vp = canvases.find(c => c.parentElement && c.parentElement.classList.contains('viewport'))
      const gl = vp && (vp.getContext('webgl2') || vp.getContext('webgl'))
      let pv = null
      try {
        const r = a.__test__.validatePreviewExecute([
          { type: 'terrain', terrainType: 'hills', x1: 2, y1: 0, z1: 2, x2: 30, y2: 40, z2: 30, amplitude: 6 },
        ])
        pv = { match: r.pipeline.previewMatchesApply, preview: r.pipeline.previewTotalChanges, apply: r.pipeline.appliedChanged }
      } catch (e) { pv = { error: e.message } }
      return {
        title: document.title,
        url: location.protocol,
        hasWorld: !!a.world,
        dims: [a.world.width, a.world.height, a.world.depth],
        isDesktop: a.bridge.isDesktop,
        desktopGlobal: !!window.desktop,
        canvasCount: canvases.length,
        glVersion: gl ? gl.getParameter(gl.VERSION) : null,
        buttons: document.querySelectorAll('button').length,
        skeleton: !!(document.querySelector('.topbar') && document.querySelector('.toolbar')
          && document.querySelector('.viewport') && document.querySelector('.ai-panel')),
        // Blockbench 改版的落地标记：只在方块模式渲染的「操作模式」档位，
        // 以及默认模式下不该出现的「笔刷参数」面板。
        // 不查这两个，上面那些断言在旧版界面上同样会全绿 —— 打包漏了 dist
        // 也能过，属于典型的假绿灯。
        modeSegs: document.querySelectorAll('.toolbar .seg.mode-seg button').length,
        brushPanelHidden: !document.body.textContent.includes('笔刷参数'),
        hotkeyBadges: document.querySelectorAll('.toolbar .seg.tool-seg .hotkey').length,
        badgeText: document.getElementById('mode-badge')?.textContent.trim() ?? '',
        pv,
      }
    })()`)
    check('界面骨架完整', probe.skeleton)
    check('世界已建立', probe.hasWorld, JSON.stringify(probe.dims))
    check('preload 桥挂载', probe.desktopGlobal === true)
    check('识别为桌面版', probe.isDesktop === true)
    check('file:// 协议加载', probe.url === 'file:', probe.url)
    check('WebGL 可用', typeof probe.glVersion === 'string', probe.glVersion ?? '')
    check('canvas = 2', probe.canvasCount === 2, String(probe.canvasCount))
    check('预览数 === 执行数', probe.pv && probe.pv.match === true,
      probe.pv ? `preview=${probe.pv.preview} apply=${probe.pv.apply}` : JSON.stringify(probe.pv))
    // Blockbench 改版的落地标记
    check('操作模式档位存在', probe.modeSegs === 2, `${probe.modeSegs} 个档位`)
    check('方块模式隐藏笔刷参数', probe.brushPanelHidden === true)
    check('工具带快捷键角标', probe.hotkeyBadges >= 4, `${probe.hotkeyBadges} 个角标`)
    check('视口状态条显示模式', /方块模式/.test(probe.badgeText), probe.badgeText)
    console.log(`     标题「${probe.title}」/ 按钮 ${probe.buttons} 个`)
  } catch (err) {
    failed++
    console.error(`FAIL  渲染进程探测：${err.message}`)
  }
}

child.kill()
await sleep(800)
try { child.kill('SIGKILL') } catch {}

if (stderr.trim()) {
  const noisy = stderr.split('\n').filter((l) => l.trim() && !/crashpad|GPU|DevTools|Fontconfig/i.test(l))
  if (noisy.length) console.log('\n--- stderr（已滤噪）---\n' + noisy.slice(0, 8).join('\n'))
}

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}\n`)
process.exit(failed === 0 ? 0 : 1)
