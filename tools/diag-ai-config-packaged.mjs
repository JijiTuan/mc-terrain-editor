// 在「打包好的桌面版」里验证模型连接面板可用
// dev server 里能用 ≠ 打包后能用：asar 打包、file:// 协议、localStorage 来源
// 都可能让 localStorage 写入失败或模块路径解析出错。
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

const EXE = resolve('release7/win-unpacked/Minecraft 地形编辑器.exe')
const PORT = 9334

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV

// 必须带 swiftshader 软渲染：无头环境下走真 GPU 会让渲染线程挂住，
// 页面骨架能起来但主循环不跑，后续的 UI 断言就会随机失败。
const child = spawn(EXE, [
  `--remote-debugging-port=${PORT}`,
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
], { cwd: resolve('release7/win-unpacked'), stdio: 'ignore', env })
await new Promise((r) => setTimeout(r, 7000))

let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

try {
  const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const pages = await b.pages()
  const p = pages.find((x) => !x.url().startsWith('devtools://')) || pages[0]
  await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
  await new Promise((r) => setTimeout(r, 2000))

  console.log(`\n[打包版] 页面 URL: ${p.url()}\n`)

  // 1. 齿轮按钮存在且可点
  await p.evaluate(() => {
    const g = [...document.querySelectorAll('.ai-head button')].find((x) => x.textContent.trim() === '⚙')
    if (!g) throw new Error('找不到齿轮')
    g.click()
  })
  await new Promise((r) => setTimeout(r, 500))

  const ui = await p.evaluate(() => ({
    baseUrl: !!document.querySelector('#ai-baseUrl'),
    apiKey: !!document.querySelector('#ai-apiKey'),
    model: !!document.querySelector('#ai-model'),
    save: !!document.querySelector('[data-save]'),
    clear: !!document.querySelector('[data-clear]'),
    test: !!document.querySelector('[data-test]'),
    presets: document.querySelectorAll('[data-preset]').length,
  }))
  check('打包版里能打开「模型连接」', ui.baseUrl && ui.apiKey && ui.model)
  check('三个按钮都在', ui.save && ui.clear && ui.test)
  check('预置服务商按钮已渲染', ui.presets === 6, `${ui.presets} 个`)

  // 2. 预置按钮真的会填地址
  await p.evaluate(() => document.querySelector('[data-preset="deepseek"]').click())
  await new Promise((r) => setTimeout(r, 300))
  const afterPreset = await p.evaluate(() => ({
    base: document.querySelector('#ai-baseUrl').value,
    model: document.querySelector('#ai-model').value,
  }))
  check('点 DeepSeek 预置填好了地址', /api\.deepseek\.com/.test(afterPreset.base), afterPreset.base)
  check('点 DeepSeek 预置填好了模型', afterPreset.model === 'deepseek-chat', afterPreset.model)

  // 3. 保存到 localStorage —— 打包版 file:// 下 localStorage 是否可写
  await p.evaluate(() => {
    document.querySelector('#ai-apiKey').value = 'sk-pack-test-1234'
    document.querySelector('[data-save]').click()
  })
  await new Promise((r) => setTimeout(r, 800))

  const persisted = await p.evaluate(() => {
    const raw = localStorage.getItem('mc-terrain-editor:ai-config')
    return raw ? JSON.parse(raw) : null
  })
  check('保存真的写进了 localStorage（file:// 下可写）', persisted?.apiKey === 'sk-pack-test-1234', JSON.stringify(persisted))
  check('地址一并落盘', /api\.deepseek\.com/.test(persisted?.baseUrl || ''), persisted?.baseUrl)

  // 4. 生效判定
  const ok = await p.evaluate(() => window.__MC_EDITOR__.ai.availability().ok)
  check('填齐后 availability 判定为可用', ok === true)

  // 5. 清空能回到未配置
  await p.evaluate(() => document.querySelector('[data-clear]').click())
  await new Promise((r) => setTimeout(r, 700))
  const cleared = await p.evaluate(() => ({
    raw: localStorage.getItem('mc-terrain-editor:ai-config'),
    ok: window.__MC_EDITOR__.ai.availability().ok,
  }))
  check('清空后 localStorage 条目被移除', cleared.raw === null, String(cleared.raw))
  check('清空后回到未配置', cleared.ok === false)

  await b.disconnect()
} catch (err) {
  check(`打包版验证过程未抛异常`, false, err.message)
} finally {
  child.kill()
}

console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
