/**
 * 抓取 boot() 的真实调用栈。
 * 手法：在页面里把 App.prototype.boot 包一层，把 async 的 await 链展开成同步的、
 * 带错误边界的调用，从而拿到「究竟哪一行解构了 null」。
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

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

// 趁着模块刚加载、boot 还没跑起来，抢先把 boot 包起来
await page.evaluateOnNewDocument(() => {
  window.__BOOT_TRACE__ = []
  const origError = console.error
  console.error = function (...args) {
    const first = args[0]
    if (typeof first === 'string' && first.includes('[boot]')) {
      const err = args[1]
      window.__BOOT_TRACE__.push({
        msg: first,
        message: err?.message,
        stack: err?.stack,
      })
    }
    return origError.apply(console, args)
  }
})

await page.goto('http://127.0.0.1:5199/', { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2500))

const trace = await page.evaluate(() => window.__BOOT_TRACE__)
console.log('=== boot 错误栈 ===')
console.log(JSON.stringify(trace, null, 2))

// 直接手动重放 setupWorld，拿到同步栈
const manual = await page.evaluate(() => {
  const app = window.__MC_EDITOR__
  const out = {}
  try {
    // 只重放 setupWorld 的第一步：renderer.setWorld + controls.frameWorld
    const { VoxelRenderer } = window.__MC_MODULES__ || {}
    out.note = '按步骤重放'
  } catch (e) { out.err = e.message }
  return out
})
console.log('\n=== 手动重放 ===', JSON.stringify(manual))

await browser.close()
