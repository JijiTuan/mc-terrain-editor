/**
 * 启动崩溃定位：在浏览器里逐步调用 boot() 的每个子步骤，
 * 谁先抛就把谁抓出来。比读代码猜快得多。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '..', '.smoke')
mkdirSync(OUT, { recursive: true })

const WORKSPACE_MODULES =
  process.env.WB_WORKSPACE_MODULES ||
  'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (
  await import(
    pathToFileURL(resolve(WORKSPACE_MODULES, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href
  )
).default

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()) })

await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))

const trace = await page.evaluate(async () => {
  const app = window.__MC_EDITOR__
  if (!app) return { fatal: 'window.__MC_EDITOR__ 不存在，说明模块顶层就炸了' }

  const results = []
  const steps = [
    ['buildShell 已有 el', () => { if (!app.el?.toolbar) throw new Error('el 未填充'); return Object.keys(app.el).length }],
    ['world 存在', () => { if (!app.world) throw new Error('world 为空'); return `${app.world.width}x${app.world.height}x${app.world.depth}` }],
    ['bus 存在', () => { if (!app.bus) throw new Error('bus 为空'); return 'ok' }],
    ['renderer 存在', () => { if (!app.renderer) throw new Error('renderer 为空'); return 'ok' }],
    ['controls 存在', () => { if (!app.controls) throw new Error('controls 为空'); return 'ok' }],
    ['interaction 存在', () => { if (!app.interaction) throw new Error('interaction 为空'); return 'ok' }],
    ['store 存在', () => { if (!app.store) throw new Error('store 为空'); return app.store.channel }],
    ['ai 存在', () => { if (!app.ai) throw new Error('ai 为空'); return `channel=${app.ai.channel}` }],
    ['bridge 存在', () => { if (!app.bridge) throw new Error('bridge 为空'); return 'ok' }],
    ['chatHistory', () => (Array.isArray(app.chatHistory) ? `len=${app.chatHistory.length}` : '不是数组')],
    ['canvas 已在 DOM', () => { const c = document.querySelector('canvas'); if (!c) throw new Error('没有 canvas'); return `${c.width}x${c.height}` }],
  ]

  for (const [name, fn] of steps) {
    try {
      results.push({ name, ok: true, value: String(fn()) })
    } catch (e) {
      results.push({ name, ok: false, error: e.message })
    }
  }
  return { results }
})

console.log(JSON.stringify(trace, null, 2))

// 再逐步跑一遍 boot 的每个子步骤，定位抛错点
const stepTrace = await page.evaluate(async () => {
  const app = window.__MC_EDITOR__
  if (!app) return { fatal: 'no app' }
  const out = []
  const calls = [
    'setupWorld', 'setupStore', 'setupAi', 'setupBridge', 'bindKeys', 'refreshAll',
    'refreshHistoryButtons', 'refreshAiPanel', 'refreshModeBadge', 'setStatus', 'stateSnapshot',
  ]
  for (const m of calls) {
    if (typeof app[m] !== 'function') { out.push({ m, skip: '方法不存在' }); continue }
    try {
      const r = app[m].call(app)
      out.push({ m, ok: true, ret: String(r).slice(0, 80) })
    } catch (e) {
      out.push({ m, ok: false, error: e.message, stack: (e.stack || '').split('\n').slice(0, 6).join(' | ') })
    }
  }
  return { out }
})
console.log('\n=== 子步骤 ===')
console.log(JSON.stringify(stepTrace, null, 2))

await browser.close()
