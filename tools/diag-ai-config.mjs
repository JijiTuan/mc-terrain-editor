// AI 直连配置可编辑探针
//
// 要验证的不是「弹窗里出现了输入框」，而是：
//   1. 界面上真的能改地址/Key/模型，且改完真的作用到请求上
//   2. 三层来源优先级正确（运行时 > 构建时 > 默认）
//   3. 地址归一化真的把用户多贴的 /chat/completions 削回去了
//      —— 这条不做反向对照，就等于在测一个「永远返回 true」的常量
//   4. 「测试连接」失败时给的是能定位问题的错误，而不是笼统的「失败」
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

// ── 起一个假的 OpenAI 兼容服务，用来断言「请求真的打到了我填的地址」 ──
// 必须自己起一个可控的服务：如果只断言「界面上显示了地址」，那 UI 改对了、
// 但请求还发去旧地址这种 bug 是测不出来的。
let lastReq = null
let failMode = null // null | 401 | 404
const server = http.createServer((req, res) => {
  // 跨源必须带 CORS 头：页面在 127.0.0.1:5199，假服务在另一个端口。
  // 不带的话浏览器直接拦成 "Failed to fetch"，测出来的是 CORS 而不是被测逻辑。
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    lastReq = { url: req.url, auth: req.headers.authorization || '', body: (() => { try { return JSON.parse(body) } catch { return null } })() }
    if (failMode === 401) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }))
      return
    }
    if (failMode === 404) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Not Found' } }))
      return
    }
    // 流式端点
    if (lastReq.body?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"的"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: {} }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const FAKE_BASE = `http://127.0.0.1:${PORT}/v1`

const b = await puppeteer.launch({
  executablePath: 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1600,950'],
})
const p = await b.newPage()
await p.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 })
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 200 })
await new Promise((r) => setTimeout(r, 2500))

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// ── 读取当前生效配置（走 app 里的真实对象，不自己重新 import 一份） ──
const cfgNow = () => p.evaluate(async () => {
  const m = await import('/src/ai/config-store.js')
  const r = m.resolveAiConfig()
  return { baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, source: r.source }
})

// ── 直接操作界面：点 ⚙ → 填三个框 → 保存 ──
// 不用 p.evaluate 直接往 localStorage 写：那样绕过的是被验证的对象本身。
const openSettings = async () => {
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('.ai-head button')]
    const g = btns.find((x) => x.textContent.trim() === '⚙')
    if (!g) throw new Error('找不到齿轮按钮')
    g.click()
  })
  await new Promise((r) => setTimeout(r, 350))
  const open = await p.evaluate(() => !!document.querySelector('#ai-baseUrl'))
  if (!open) throw new Error('设置弹窗没有打开 / 没有出现输入框')
}

const fillAndSave = async ({ baseUrl, apiKey, model }) => {
  await p.evaluate((v) => {
    const set = (id, val) => {
      const el = document.querySelector('#ai-' + id)
      el.value = val
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('baseUrl', v.baseUrl)
    set('apiKey', v.apiKey)
    set('model', v.model)
    document.querySelector('[data-save]').click()
  }, { baseUrl, apiKey, model })
  await new Promise((r) => setTimeout(r, 500))
}

// ══════════════════════════════════════════════════════
console.log('\n[1] 界面上存在可编辑入口')
await openSettings()
const inputs = await p.evaluate(() => ['baseUrl', 'apiKey', 'model'].map((id) => {
  const el = document.querySelector('#ai-' + id)
  return { id, exists: !!el, tag: el?.tagName, type: el?.type, editable: el ? !el.readOnly && !el.disabled : false }
}))
for (const it of inputs) check(`「${it.id}」是可编辑输入框`, it.exists && it.editable, `<${it.tag} type=${it.type}>`)

// ══════════════════════════════════════════════════════
console.log('\n[2] 保存后真的作用到「发出去的请求」上')
await fillAndSave({ baseUrl: FAKE_BASE, apiKey: 'sk-test-probe-key', model: 'probe-model-x' })
const saved = await cfgNow()
check('地址已按填入值生效', saved.baseUrl === FAKE_BASE, saved.baseUrl)
check('来源标记为「运行时」', saved.source.baseUrl === '运行时', saved.source.baseUrl)

// 真发一次对话，看请求落在哪
lastReq = null
const sendRes = await p.evaluate(async () => {
  const A = window.__MC_EDITOR__
  try {
    const r = await A.ai.generate([{ role: 'user', content: 'hi' }])
    return { ok: true, content: r.content }
  } catch (e) { return { ok: false, msg: e.message } }
})
check('对话请求成功（打到假服务）', sendRes.ok, sendRes.ok ? `回复「${sendRes.content}」` : sendRes.msg)
check('请求落在填入的地址上', lastReq?.url === '/v1/chat/completions', `实际 path = ${lastReq?.url}`)
check('请求带的是填入的 Key', lastReq?.auth === 'Bearer sk-test-probe-key', `实际 = ${lastReq?.auth}`)
check('请求带的是填入的模型名', lastReq?.body?.model === 'probe-model-x', `实际 = ${lastReq?.body?.model}`)

// ══════════════════════════════════════════════════════
console.log('\n[3] 地址归一化：用户把完整端点贴进来也不该拼出双份')
// 反向对照 —— 归一化函数如果是个恒等函数，这里就必须失败
const norm = await p.evaluate(async () => {
  const m = await import('/src/ai/config-store.js')
  return {
    plain: m.normalizeBaseUrl('https://api.deepseek.com/v1'),
    trailing: m.normalizeBaseUrl('https://api.deepseek.com/v1/'),
    full: m.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'),
    query: m.normalizeBaseUrl('https://api.deepseek.com/v1/?x=1'),
    spaced: m.normalizeBaseUrl('  https://api.deepseek.com/v1  '),
  }
})
check('带结尾斜杠 → 削掉', norm.trailing === 'https://api.deepseek.com/v1', norm.trailing)
check('贴了完整端点 → 削回 base', norm.full === 'https://api.deepseek.com/v1', norm.full)
check('带 query → 去掉 query', norm.query === 'https://api.deepseek.com/v1', norm.query)
check('带首尾空格 → 去空格', norm.spaced === 'https://api.deepseek.com/v1', JSON.stringify(norm.spaced))
check('反向对照：正常地址不该被改动', norm.plain === 'https://api.deepseek.com/v1', norm.plain)

// ══════════════════════════════════════════════════════
console.log('\n[4] 测试连接：能区分「通了」和「Key 错」「地址错」')
const testConn = async (cfg) => p.evaluate(async (c) => {
  const m = await import('/src/ai/config-store.js')
  try {
    const r = await m.testAiConnection(c)
    return { ok: true, ms: r.ms }
  } catch (e) { return { ok: false, kind: e.kind, msg: e.message } }
}, cfg)

const t1 = await testConn({ baseUrl: FAKE_BASE, apiKey: 'sk-test-probe-key', model: 'probe-model-x' })
check('连通时返回 ok', t1.ok === true, t1.ok ? `${t1.ms} ms` : t1.msg)

failMode = 401
const t2 = await testConn({ baseUrl: FAKE_BASE, apiKey: 'sk-wrong', model: 'probe-model-x' })
check('Key 错 → 判为 auth 且提示 Key', t2.ok === false && t2.kind === 'auth' && /Key|key/.test(t2.msg), `kind=${t2.kind} msg=${(t2.msg || '').slice(0, 60)}`)

failMode = 404
const t3 = await testConn({ baseUrl: FAKE_BASE, apiKey: 'sk-test-probe-key', model: 'probe-model-x' })
check('404 → 提示地址可能不对', t3.ok === false && t3.kind === 'notfound' && /地址/.test(t3.msg), `kind=${t3.kind}`)
failMode = null

const t4 = await testConn({ baseUrl: '', apiKey: 'k', model: 'm' })
check('地址为空 → 本地就拦下，不发请求', t4.ok === false && t4.kind === 'config', `kind=${t4.kind}`)

// 真·连不上的地址（端口没人监听）
const t5 = await testConn({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm' })
check('地址不通 → 判为 network 并带上地址', t5.ok === false && t5.kind === 'network' && /127\.0\.0\.1:9/.test(t5.msg), `kind=${t5.kind}`)

// ══════════════════════════════════════════════════════
console.log('\n[5] 清空界面配置 → 回到构建时 / 默认值')
await openSettings()
await p.evaluate(() => document.querySelector('[data-clear]').click())
await new Promise((r) => setTimeout(r, 500))
const afterClear = await cfgNow()
check('清空后地址回到默认值', afterClear.baseUrl === 'https://api.deepseek.com/v1', afterClear.baseUrl)
check('清空后来源标为「默认」（环境变量没设时）', afterClear.source.baseUrl === '默认', afterClear.source.baseUrl)
check('清空后 Key 为空 → availability 报不可用',
  (await p.evaluate(() => window.__MC_EDITOR__.ai.availability().ok)) === false)

// ══════════════════════════════════════════════════════
console.log('\n[6] 空状态提示指向了正确的入口')
const hint = await p.evaluate(() => document.querySelector('.ai-messages')?.textContent || '')
check('空状态提到「模型连接」', /模型连接/.test(hint), hint.replace(/\s+/g, ' ').slice(0, 90))
check('空状态不再让人去找 .env.local', !/\.env\.local/.test(hint))

// ══════════════════════════════════════════════════════
await b.close()
server.close()
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
