// 桌面版导出端到端：真实打包 Electron 里走导出对话框，验证文件真的写到磁盘。
// 之前只验证「toast 说成功」是不够的 —— Electron 里 blob 下载走的是
// Chromium 默认行为（无 will-download 处理器时静默存到系统「下载」目录），
// 要证明文件真的出现才算闭环。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'

for (const k of ['NO_PROXY', 'no_proxy']) process.env[k] = '127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

const ROOT = resolve('.')
const dirs = fs.readdirSync(ROOT)
  .filter((f) => /^release\d*$/.test(f) && fs.existsSync(resolve(ROOT, f, 'win-unpacked')))
  .sort((a, b) => fs.statSync(resolve(ROOT, b, 'win-unpacked')).mtimeMs - fs.statSync(resolve(ROOT, a, 'win-unpacked')).mtimeMs)
const unpacked = resolve(ROOT, dirs[0], 'win-unpacked')
const exe = resolve(unpacked, fs.readdirSync(unpacked).find((f) => f.endsWith('.exe')))
console.log(`产物：${unpacked}`)

let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const exeName = exe.split('\\').pop()
spawn('taskkill', ['/F', '/IM', exeName, '/T'], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const PORT = 9338
// 探针用测试目录：MC_EXPORT_TEST_DIR 让主进程跳过原生保存对话框直接落盘
const DL = 'C:/Users/passk/AppData/Local/Temp/mc-export-test'
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.WORKBUDDY_NODE_ENV
env.MC_EXPORT_TEST_DIR = DL
const child = spawn(exe, [`--remote-debugging-port=${PORT}`, '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  { cwd: unpacked, stdio: ['ignore', 'pipe', 'pipe'], env })
let errOut = ''
child.stderr.on('data', (d) => { errOut += d.toString() })

async function waitPort() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 600))
  }
  return false
}
if (!await waitPort()) { console.log('调试端口没起来\n' + errOut.slice(0, 600)); process.exit(1) }
await new Promise((r) => setTimeout(r, 3000))

const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
const pages = await b.pages()
const p = pages.find((x) => !x.url().startsWith('devtools://')) || pages[0]
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
await new Promise((r) => setTimeout(r, 2000))

// 记录测试目录导出前的状态，之后对比新增文件
const before = new Map(fs.existsSync(DL) ? fs.readdirSync(DL).map((f) => [f, fs.statSync(resolve(DL, f)).mtimeMs]) : [])

const result = await p.evaluate(async () => {
  const app = window.__MC_EDITOR__
  const toasts = []
  const origToast = app.toast.bind(app)
  app.toast = (msg, kind) => { toasts.push({ msg: String(msg), kind }); return origToast(msg, kind) }
  const objCalls = []
  const origCOU = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (arg) => { objCalls.push(arg?.constructor?.name); return origCOU(arg) }

  document.querySelector('#btn-export')?.click()
  await new Promise((r) => setTimeout(r, 400))
  const exportBtn = [...document.querySelectorAll('.modal-foot button')].find((x) => x.textContent.trim() === '导出')
  if (!exportBtn) return { error: '找不到导出按钮' }
  exportBtn.click()
  await new Promise((r) => setTimeout(r, 1000))
  return { objCalls, toasts }
})

check('createObjectURL 收到 Blob', result.objCalls?.length >= 1 && result.objCalls.every((t) => t === 'Blob'),
  JSON.stringify(result.objCalls))
check('无导出失败报错', !result.toasts?.some((t) => t.kind === 'error'), result.toasts?.map((t) => `${t.kind}:${t.msg}`).join(' | '))

// 等 Electron 的下载落盘（默认无提示，存到系统下载目录）。
// 上一轮等 3 秒只看到 .tmp —— 拉长到 15 秒并分两次查，区分「慢」和「被丢弃」。
let schem = null
let lastFresh = []
for (let i = 0; i < 15 && !schem; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const after = fs.existsSync(DL) ? fs.readdirSync(DL).map((f) => ({ f, m: fs.statSync(resolve(DL, f)).mtimeMs })) : []
  lastFresh = after.filter((x) => !before.has(x.f) || x.m > (before.get(x.f) ?? 0))
  schem = lastFresh.find((x) => x.f.endsWith('.schem'))
}
check('导出文件真的写到磁盘（下载目录出现新 .schem）', !!schem,
  schem ? `${schem.f}（${(fs.statSync(resolve(DL, schem.f)).size / 1024).toFixed(1)} KB）` : `下载目录新文件：${lastFresh.map((x) => x.f).join(', ') || '无'}`)

// 导出的文件头应为 gzip 魔数（Sponge Schem 是 gzip NBT）——顺手验内容形态
if (schem) {
  const head = fs.readFileSync(resolve(DL, schem.f)).subarray(0, 2)
  check('文件头是 gzip 魔数 1f 8b', head[0] === 0x1f && head[1] === 0x8b,
    `${head[0]?.toString(16)} ${head[1]?.toString(16)}`)
}

await b.close().catch(() => {})
spawn('taskkill', ['/F', '/IM', exeName, '/T'], { stdio: 'ignore' })
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
