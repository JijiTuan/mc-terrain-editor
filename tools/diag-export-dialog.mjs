// 导出对话框端到端探针：走真实 UI（顶栏「导出」→ 对话框「导出」按钮），
// 钩住 URL.createObjectURL 验证收到的是 Blob，toast 无「导出失败」。
// 背景：doExport 曾把 exportSchematic 返回的裸 Uint8Array 直接传给
// downloadBlob，createObjectURL 报 Overload resolution failed（用户截图实锤）。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const k of ['NO_PROXY', 'no_proxy']) process.env[k] = '127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

const URL_TARGET = process.argv[2] || 'http://localhost:5199/'
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const b = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const p = await b.newPage()
await p.setViewport({ width: 1400, height: 900 })
await p.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
await new Promise((r) => setTimeout(r, 1500))

// 在页面里钩住 createObjectURL 和 toast，然后走真实 UI 流程
const result = await p.evaluate(async () => {
  const app = window.__MC_EDITOR__
  const toasts = []
  const origToast = app.toast.bind(app)
  app.toast = (msg, kind) => { toasts.push({ msg: String(msg), kind }); return origToast(msg, kind) }

  const objCalls = []
  const origCOU = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (arg) => {
    objCalls.push({ type: arg?.constructor?.name, isBlob: arg instanceof Blob })
    return origCOU(arg)
  }

  // 1. 打开导出对话框（真实按钮）
  document.querySelector('#btn-export')?.click()
  await new Promise((r) => setTimeout(r, 400))

  const dlgOpen = !!document.querySelector('.modal')
  const fmt = document.getElementById('ex-format')?.value

  // 2. 点对话框里的「导出」确认按钮（foot 里的 primary）
  const footBtns = [...document.querySelectorAll('.modal-foot button')]
  const exportBtn = footBtns.find((x) => x.textContent.trim() === '导出')
  if (!exportBtn) return { dlgOpen, fmt, error: 'foot 里找不到「导出」按钮', footBtns: footBtns.map((x) => x.textContent.trim()) }
  exportBtn.click()
  await new Promise((r) => setTimeout(r, 800))

  return {
    dlgOpen, fmt,
    objCalls,
    toasts,
    filenameTried: null,
  }
})

console.log(`\n[导出对话框端到端] ${URL_TARGET}\n`)
check('导出对话框能打开', result.dlgOpen === true)
check('默认格式是 schem', result.fmt === 'schem', `实得 ${result.fmt}`)
if (result.error) {
  check('能点到导出按钮', false, result.error)
} else {
  check('createObjectURL 收到的是 Blob', result.objCalls.length >= 1 && result.objCalls.every((c) => c.isBlob),
    JSON.stringify(result.objCalls))
  const failed = result.toasts.find((t) => t.kind === 'error' || t.msg.includes('导出失败'))
  const ok = result.toasts.find((t) => t.kind === 'ok')
  check('没有「导出失败」报错', !failed, failed?.msg ?? '')
  check('有成功提示', !!ok, ok?.msg ?? '')
}

await b.close()
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
