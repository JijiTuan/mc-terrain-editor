// 模型连接面板「保存」按钮固定在底部 — 实测探针
//
// 背景：.modal 以前是单一 overflow:auto 容器，模型连接面板内容很长，
// 小窗口下 .modal-foot（含保存按钮）被推到滚动区底部之外，
// 用户看到的现象是「没有确定按钮」。
//
// 修法：.modal 改 flex column，.modal-body 唯一滚动，.modal-foot flex:none 固定。
// 这个探针在小视口下打开面板，量按钮的几何位置是否始终在可视区内。
//
// 反向对照：注入旧样式（单容器滚动）后同一断言必须失败 —— 否则探针是假绿。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const k of ['NO_PROXY', 'no_proxy']) process.env[k] = '127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

const URL = process.argv[2] || 'http://localhost:5199/'
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const b = await puppeteer.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const p = await b.newPage()

// 关键：小视口。修的问题就是「小窗口下按钮出视口」，用大窗口测是假绿。
await p.setViewport({ width: 900, height: 560 })

// networkidle2 等不到：vite 的 HMR websocket 让网络永远不空闲。
// 用 domcontentloaded，就绪与否交给下面的 waitForFunction 判断。
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
await new Promise((r) => setTimeout(r, 2000))

/**
 * 打开模型连接面板并量几何。
 * 返回：按钮矩形、面板滚动几何、按钮是否在面板可视区内（不需滚动就能看到）。
 */
async function measure() {
  return p.evaluate(() => {
    const g = [...document.querySelectorAll('.ai-head button')].find((x) => x.textContent.trim() === '⚙')
    if (!g) return { error: '找不到齿轮按钮' }
    g.click()
    return new Promise((res) => setTimeout(() => {
      const foot = document.querySelector('.modal-foot')
      const save = foot?.querySelector('[data-save]')
      const body = document.querySelector('.modal-body')
      const modal = document.querySelector('.modal')
      if (!foot || !save || !modal) { res({ error: '面板结构不全' }); return }
      const fr = foot.getBoundingClientRect()
      const sr = save.getBoundingClientRect()
      const mr = modal.getBoundingClientRect()
      // 「在可视区内」= 按钮完整落在面板矩形内（面板自身不再整体滚动，
      // foot 永远钉在面板底部，因此只要面板在窗口里，按钮就在窗口里）
      const fullyVisibleInModal = sr.top >= mr.top && sr.bottom <= mr.bottom && sr.height > 0
      res({
        modalRect: { top: Math.round(mr.top), bottom: Math.round(mr.bottom), h: Math.round(mr.height) },
        footRect: { top: Math.round(fr.top), bottom: Math.round(fr.bottom), h: Math.round(fr.height) },
        saveRect: { top: Math.round(sr.top), bottom: Math.round(sr.bottom), h: Math.round(sr.height) },
        viewportH: window.innerHeight,
        bodyScrollable: body ? body.scrollHeight > body.clientHeight : null,
        bodyScrollH: body?.scrollHeight ?? null,
        bodyClientH: body?.clientHeight ?? null,
        fullyVisibleInModal,
        alsoInViewport: sr.top >= 0 && sr.bottom <= window.innerHeight,
      })
    }, 600))
  })
}

console.log(`\n[小视口 900x560] ${URL}\n`)

// ── 新布局实测 ──
const m = await measure()
if (m.error) { check('打开面板', false, m.error); await b.close(); process.exit(1) }

check('面板结构完整（foot + data-save）', true)
check('modal 高度不超视口', m.modalRect.h <= m.viewportH, `${m.modalRect.h} vs ${m.viewportH}`)
check('modal-foot 固定在 modal 底部', Math.abs(m.footRect.bottom - m.modalRect.bottom) <= 2,
  `foot.bottom=${m.footRect.bottom} modal.bottom=${m.modalRect.bottom}`)
check('保存按钮在面板可视区内（无需滚动）', m.fullyVisibleInModal,
  `save.top=${m.saveRect.top} bottom=${m.saveRect.bottom}`)
check('保存按钮同时也在窗口可视区内', m.alsoInViewport,
  `窗口高 ${m.viewportH}，按钮 ${m.saveRect.top}~${m.saveRect.bottom}`)
check('面板内容确实超长（触发过滚动的场景）', m.bodyScrollable === true,
  `body scrollH=${m.bodyScrollH} clientH=${m.bodyClientH}`)

// ── 反向对照：注入旧样式（整个 modal 单一滚动），同一断言必须失败 ──
await p.evaluate(() => {
  const st = document.createElement('style')
  st.id = '__legacy_modal_css__'
  st.textContent = `
    .modal { display: block !important; overflow: auto !important; }
    .modal-body { overflow: visible !important; flex: none !important; min-height: 0 !important; }
    .modal-foot { flex: none !important; background: transparent !important; }
  `
  document.head.appendChild(st)
})
const legacy = await p.evaluate(() => {
  const foot = document.querySelector('.modal-foot')
  const save = foot?.querySelector('[data-save]')
  const modal = document.querySelector('.modal')
  const sr = save?.getBoundingClientRect()
  const mr = modal?.getBoundingClientRect()
  if (!sr || !mr) return { error: '结构丢失' }
  return { fullyVisible: sr.top >= mr.top && sr.bottom <= mr.bottom && sr.height > 0 }
})
if (legacy.error) {
  check('反向对照可执行', false, legacy.error)
} else {
  check('反向对照：旧布局下按钮会滚出面板（断言必须翻红）', legacy.fullyVisible === false,
    legacy.fullyVisible ? '旧布局也通过 → 探针是假绿，断言无效' : '旧布局下按钮确实滚出去了，断言有效')
}

await b.close()
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
