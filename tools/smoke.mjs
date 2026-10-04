/**
 * 实机冒烟测试：用真实 Chromium 加载编辑器，捕获运行时报错与页面状态。
 *
 * 为什么需要它：`npm run build` 只证明「能打包」，不证明「能跑」。
 * 模块循环依赖、Three.js API 误用、DOM 选择器写错，这些只有真跑一次才暴露。
 *
 * 用法：
 *   node tools/smoke.mjs                    # 默认 http://127.0.0.1:5199
 *   node tools/smoke.mjs http://host:port
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ESM 的解析器不认 NODE_PATH，所以这里显式按绝对路径加载托管 workspace 里的
// puppeteer-core —— 这样既能用现成依赖，又不会把浏览器驱动写进项目 package.json。
const WORKSPACE_MODULES =
  process.env.WB_WORKSPACE_MODULES ||
  'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'

const puppeteer = (
  await import(
    pathToFileURL(resolve(WORKSPACE_MODULES, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href
  )
).default

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', '.smoke')

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:5199/'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

// 只有 dev server 会按源码路径（/src/*.js）提供模块；生产构建是打包产物。
// 探针里凡是要 import('/src/...') 的地方都得先看这个开关。
const IS_DEV_SERVER = process.env.SMOKE_MODE === 'dev' || process.argv.includes('--dev')

mkdirSync(OUT_DIR, { recursive: true })

const errors = []
const warnings = []
const consoleLines = []
const failedRequests = []

function stamp() {
  return new Date().toISOString().slice(11, 23)
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    // 强制走 SwiftShader 软件光栅化：headless 下没有真 GPU，
    // 不给这个开关 WebGL 上下文会直接创建失败
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,950'
  ]
})

const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 })

page.on('console', (msg) => {
  const type = msg.type()
  const text = msg.text()
  consoleLines.push(`[${stamp()}][${type}] ${text}`)
  if (type === 'error') errors.push(`console.error: ${text}`)
  if (type === 'warning') warnings.push(`console.warn: ${text}`)
})

page.on('pageerror', (err) => {
  errors.push(`pageerror: ${err.message}\n${err.stack || ''}`)
})

page.on('requestfailed', (req) => {
  failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`)
})

let navError = null
try {
  // 不能用 networkidle2：编辑器的 requestAnimationFrame 主循环一直在跑，
  // 网络空闲这个条件永远不会达成，会白等到超时。用 domcontentloaded + 显式等待世界就绪。
  await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 })
} catch (e) {
  navError = e.message
}

// 等到 App 真正启动完成（world 和 renderer 都就位），而不是盲等固定秒数
try {
  await page.waitForFunction(
    () => {
      const a = window.__MC_EDITOR__
      return !!(a && a.world && a.renderer && a.ai && a.store)
    },
    { timeout: 25000, polling: 200 }
  )
} catch (e) {
  errors.push(`等待应用就绪超时：${e.message}`)
}

// 给 Three.js 首帧渲染与像素采样留一点时间
await new Promise((r) => setTimeout(r, 2500))

// ---------- 采集运行时探针 ----------
const probe = await page.evaluate(() => {
  const app = window.__MC_EDITOR__

  // 注意：页面上有两个 canvas —— 俯视图小地图和 WebGL 主视口。
  // 必须挑 WebGL 那个（能拿到 webgl/webgl2 上下文），否则量的是小地图。
  const allCanvas = [...document.querySelectorAll('canvas')]
  const canvas = allCanvas.find((c) => c.getContext('webgl2') || c.getContext('webgl')) || null
  let glInfo = null
  if (canvas) {
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info')
      glInfo = {
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight]
      }
    }
  }

  const count = (sel) => document.querySelectorAll(sel).length

  // 把 canvas 画素抽样一遍，判断「到底画没画出东西」
  // 纯色（全黑/全透明）说明渲染管线没真正跑起来
  let pixelStats = null
  if (canvas) {
    try {
      const off = document.createElement('canvas')
      off.width = 320
      off.height = 200
      const ctx = off.getContext('2d')
      ctx.drawImage(canvas, 0, 0, 320, 200)
      const d = ctx.getImageData(0, 0, 320, 200).data
      let nonBlank = 0
      let sumLum = 0
      const buckets = new Set()
      for (let i = 0; i < d.length; i += 4) {
        const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0
        sumLum += lum
        if (d[i + 3] > 8 && lum > 6) nonBlank++
        buckets.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`)
      }
      const total = d.length / 4
      pixelStats = {
        nonBlankRatio: +(nonBlank / total).toFixed(4),
        meanLuminance: +(sumLum / total).toFixed(2),
        distinctColorBuckets: buckets.size
      }
    } catch (e) {
      pixelStats = { error: String(e) }
    }
  }

  let worldInfo = null
  if (app && app.world) {
    const s = app.world.stats?.() || {}
    worldInfo = {
      width: app.world.width,
      height: app.world.height,
      depth: app.world.depth,
      revision: app.world.revision,
      solid: s.solid ?? s.nonAir ?? null,
      stats: s
    }
  }

  let historyInfo = null
  if (app && app.bus) {
    try {
      historyInfo = app.bus.stackState?.() || null
    } catch (e) {
      historyInfo = { error: String(e) }
    }
  }

  return {
    hasApp: !!app,
    appKeys: app ? Object.keys(app).slice(0, 60) : [],
    canvas: canvas
      ? {
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
          widthAttr: canvas.width,
          heightAttr: canvas.height
        }
      : null,
    glInfo,
    pixelStats,
    worldInfo,
    historyInfo,
    dom: {
      topbar: count('.topbar'),
      toolbar: count('.toolbar'),
      viewport: count('.viewport'),
      aiPanel: count('.ai-panel'),
      panels: count('.panel'),
      swatches: count('.swatch'),
      buttons: count('button'),
      inputs: count('input'),
      selects: count('select'),
      canvas: count('canvas'),
      modes: count('.mode-badge, .badge'),
      toast: count('.toast')
    },
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 3000)
  }
})

await page.screenshot({ path: resolve(OUT_DIR, 'shot-01-boot.png') })

// ---------- 交互探测 1：往视口中间模拟一次涂抹 ----------
const cx = 800
const cy = 500
await page.mouse.move(cx, cy)
await new Promise((r) => setTimeout(r, 300))

const before = await page.evaluate(() => ({
  revision: window.__MC_EDITOR__?.world?.revision ?? null,
  undo: window.__MC_EDITOR__?.bus?.stackState?.()?.undoCount ?? null
}))

await page.mouse.down({ button: 'left' })
for (let i = 0; i < 8; i++) {
  await page.mouse.move(cx + i * 6, cy + i * 4)
  await new Promise((r) => setTimeout(r, 45))
}
await page.mouse.up({ button: 'left' })
await new Promise((r) => setTimeout(r, 900))

const after = await page.evaluate(() => ({
  revision: window.__MC_EDITOR__?.world?.revision ?? null,
  undo: window.__MC_EDITOR__?.bus?.stackState?.()?.undoCount ?? null
}))

await page.screenshot({ path: resolve(OUT_DIR, 'shot-02-after-paint.png') })

// ---------- 交互探测 2：撤销 ----------
await page.keyboard.down('Control')
await page.keyboard.press('KeyZ')
await page.keyboard.up('Control')
await new Promise((r) => setTimeout(r, 700))

const afterUndo = await page.evaluate(() => ({
  revision: window.__MC_EDITOR__?.world?.revision ?? null,
  undo: window.__MC_EDITOR__?.bus?.stackState?.()?.undoCount ?? null,
  redo: window.__MC_EDITOR__?.bus?.stackState?.()?.redoCount ?? null
}))

await page.screenshot({ path: resolve(OUT_DIR, 'shot-03-after-undo.png') })

// ---------- 交互探测 3：右键拖拽转视角 ----------
await page.mouse.move(cx, cy)
await page.mouse.down({ button: 'right' })
for (let i = 0; i < 10; i++) {
  await page.mouse.move(cx + i * 12, cy - i * 3)
  await new Promise((r) => setTimeout(r, 40))
}
await page.mouse.up({ button: 'right' })
await new Promise((r) => setTimeout(r, 600))

const afterOrbit = await page.evaluate(() => {
  const app = window.__MC_EDITOR__
  const c = app?.controls
  return {
    azimuth: c ? +c.azimuth?.toFixed?.(4) : null,
    polar: c ? +c.polar?.toFixed?.(4) : null,
    distance: c ? +c.distance?.toFixed?.(3) : null
  }
})

await page.screenshot({ path: resolve(OUT_DIR, 'shot-04-after-orbit.png') })

// ---------- 顺手摸一下 AI 解析链路（纯本地，不联网） ----------
//
// 这里必须「总是」执行 page.evaluate，分支放在浏览器内部：
// 之前把三元表达式放在外面，导致生产模式下整段探针都没跑，
// 输出一个 skipped 看着像「主动跳过」，实际是「漏测」，很容易自欺。
const aiProbe = await page.evaluate(async (isDev) => {
  const out = { mode: isDev ? 'dev' : 'prod', steps: [] }

  // 解析器只存在于源码里，生产构建无法按 URL import
  if (isDev) {
    try {
      const parser = await import('/src/ai/parser.js')
      const cases = [
        ['fenced', '```json\n{"reply":"done","ops":[{"type":"fill","x1":0,"y1":0,"z1":0,"x2":2,"y2":2,"z2":2,"block":"stone"}]}\n```'],
        ['bare', '{"reply":"ok","ops":[{"type":"clear","x1":0,"y1":0,"z1":0,"x2":1,"y2":1,"z2":1}]}'],
        ['aliased', '{"reply":"ok","operations":[{"type":"clear","x1":0,"y1":0,"z1":0,"x2":1,"y2":1,"z2":1}]}'],
        ['chatty', '好的，我帮你把这片山挖平。'],
        ['trailing', '{"reply":"ok","ops":[{"type":"clear","x1":0,"y1":0,"z1":0,"x2":1,"y2":1,"z2":1,},],}']
      ]
      for (const [name, input] of cases) {
        try {
          const r = parser.parseModelOutput(input)
          out.steps.push({
            name,
            ok: true,
            opCount: r.ops?.length ?? 0,
            reply: (r.reply || '').slice(0, 60),
            degraded: !!r.degraded
          })
        } catch (e) {
          out.steps.push({ name, ok: false, error: String(e) })
        }
      }
    } catch (e) {
      out.importError = String(e)
    }
  } else {
    out.parserNote = '生产构建下解析器已打包，无法按 URL 单独 import；改由下面的 app 入口间接覆盖'
  }

  // 操作校验 + 预览/执行一致性（这是全项目最硬的一条正确性断言）
  //
  // 这段用 /src/... 直接 import 源码模块，只有 dev server 提供这些 URL；
  // 生产构建把模块打进了 assets/*.js，没有这些路径。所以按环境分流：
  // dev 走源码 import，生产走 app 暴露出来的内部入口，两者断言同一件事。
  // 不分流的话，探针本身会 404 并回退到 index.html，报出一堆与代码无关的 MIME 错。
  const program = [
    { type: 'terrain', terrainType: 'hills', x1: 2, z1: 2, x2: 24, z2: 24, surface: 'grass_block', amplitude: 5, seed: 12345 },
    { type: 'river', x1: 2, z1: 2, x2: 24, z2: 24, width: 3, depth: 2, water: 'water' },
    { type: 'sphere', cx: 10, cy: 12, cz: 10, radius: 3, block: 'oak_log' },
    { type: 'layer', x1: 2, z1: 2, x2: 24, z2: 24, height: 3, top: 'sand', middle: 'sandstone', bottom: 'stone' },
  ]

  try {
    const app = window.__MC_EDITOR__
    const w = app.world

    if (isDev) {
      const schema = await import('/src/core/op-schema.js')
      const executor = await import('/src/core/op-executor.js')
      const { VoxelWorld } = await import('/src/core/voxel-world.js')

      const v = schema.validateProgram(program, w)
      out.validation = { ok: v.ok, error: v.error || null, warnings: v.warnings?.length ?? 0, opCount: v.ops?.length ?? 0 }

      if (v.ok) {
        const preview = executor.previewProgram(w, v.ops)
        // 另建同源副本再执行，避免污染编辑器正在用的世界
        const copy = new VoxelWorld(w.width, w.height, w.depth, w.snapshot())
        const appliedChanged = executor.applyProgram(copy, v.ops)
        out.pipeline = {
          previewAffected: preview.affected.length / 3,
          previewTotalChanges: preview.totalChanges,
          appliedChanged,
          previewMatchesApply: preview.totalChanges === appliedChanged,
          bounds: preview.bounds,
          perOp: preview.perOp.map((p) => ({ type: p.op.type, changes: p.changes, error: p.error || null }))
        }
      }
    } else {
      // 生产环境：用 app 自己暴露的入口跑同一条断言
      const api = app.__test__ || app.testApi
      if (!api || typeof api.validatePreviewExecute !== 'function') {
        out.pipelineSkipped = '生产构建未暴露 __test__.validatePreviewExecute，跳过一致性断言（dev 下已覆盖）'
      } else {
        out.pipeline = api.validatePreviewExecute(program)
      }
    }
  } catch (e) {
    out.pipelineError = String(e) + '\n' + (e.stack || '')
  }

  return out
}, IS_DEV_SERVER)

// ---------- 交互探测 4：本地存储往返（保存 → 列列表 → 读回 → 逐格比对 → 删除） ----------
//
// 这是「刷新不丢进度」这条承诺的唯一硬证据。它必须走真实的 localStorage 与
// 真实的 RLE 序列化/反序列化：只断言「save 返回了 id」是在自欺 ——
// 记录写进去了但 RLE 编解码丢了精度，用户下次打开就是一片损坏的地形。
//
// 之前这段测的是云服务（tools/test-cloud.mjs，已随云通道移除）。换成本地后
// 断言反而更硬：本地是我们唯一剩下的通道，它坏了没有任何兜底。
const storageProbe = await page.evaluate(async () => {
  const app = window.__MC_EDITOR__
  const out = { steps: [] }
  const log = (name, ok, detail) => out.steps.push({ name, ok, detail: String(detail ?? '') })

  if (!app?.store) {
    log('store 就位', false, 'app.store 不存在')
    return out
  }
  log('store 就位', true, 'channel=' + app.store.channel)
  out.channel = app.store.channel
  out.channelLabel = app.store.channelLabel()

  // 先清掉上次自检可能残留的记录，避免列表越堆越长
  const NAME = '[自检] 本地存储往返'
  try {
    for (const p of await app.store.list()) {
      if (String(p.name).startsWith('[自检]')) await app.store.remove(p.id)
    }
    log('清理历史自检数据', true, 'ok')
  } catch (e) {
    log('清理历史自检数据', false, e.message)
  }

  let savedId = null
  try {
    const saved = await app.store.save({ name: NAME, world: app.world, thumbnail: null })
    savedId = saved?.id ?? null
    log('保存工程', !!savedId, 'id=' + savedId + ' channel=' + saved?.channel)
  } catch (e) {
    log('保存工程', false, e.message)
    return out
  }

  try {
    const list = await app.store.list()
    const found = list.find((p) => p.id === savedId)
    log('列表可查到', !!found, found ? `name=${found.name}` : `列表 ${list.length} 条未命中`)
    out.listCount = list.length
  } catch (e) {
    log('列表可查到', false, e.message)
  }

  // 关键断言：逐格比对。RLE 编码/解码丢一格都会被这里抓住。
  try {
    const rec = await app.store.load(savedId)
    if (!rec) throw new Error('load 返回 null')
    if (!rec.data) throw new Error('记录缺 data 字段')
    const fromJSON = app.__test__?.worldFromJSON
    if (typeof fromJSON !== 'function') throw new Error('app.__test__.worldFromJSON 未暴露')
    const b = fromJSON(rec.data)

    const a = app.world
    const sizeOk = a.width === b.width && a.height === b.height && a.depth === b.depth
    let diff = 0
    if (sizeOk) {
      for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) diff++
    }
    log('读回尺寸一致', sizeOk, `${b.width}x${b.height}x${b.depth} vs ${a.width}x${a.height}x${a.depth}`)
    log('读回逐格一致', sizeOk && diff === 0, sizeOk ? `差异 ${diff} 格` : '尺寸不符')
    out.roundtripDiff = diff
  } catch (e) {
    log('读回逐格一致', false, e.message)
  }

  try {
    await app.store.remove(savedId)
    const after = await app.store.list()
    const still = after.some((p) => p.id === savedId)
    log('删除工程', !still, still ? '删除后仍能查到' : '已从列表消失')
  } catch (e) {
    log('删除工程', false, e.message)
  }

  // 顺带确认 AI 通道已收敛为单通道（只剩自备 Key）
  log('AI 通道为直连', app.ai?.channel === 'direct', 'channel=' + app.ai?.channel)

  out.failed = out.steps.filter((s) => !s.ok).length
  return out
})

// ---------- 汇总 ----------
const summary = {
  target: URL_TARGET,
  navError,
  errorCount: errors.length,
  warningCount: warnings.length,
  failedRequestCount: failedRequests.length
}

writeFileSync(resolve(OUT_DIR, 'errors.txt'), errors.join('\n\n---\n\n') || '(none)', 'utf8')
writeFileSync(resolve(OUT_DIR, 'warnings.txt'), warnings.join('\n') || '(none)', 'utf8')
writeFileSync(
  resolve(OUT_DIR, 'failed-requests.txt'),
  failedRequests.join('\n') || '(none)',
  'utf8'
)
writeFileSync(resolve(OUT_DIR, 'console.txt'), consoleLines.join('\n'), 'utf8')
writeFileSync(resolve(OUT_DIR, 'probe.json'), JSON.stringify(probe, null, 2), 'utf8')
writeFileSync(
  resolve(OUT_DIR, 'interaction.json'),
  JSON.stringify({ before, after, afterUndo, afterOrbit, aiProbe, storageProbe }, null, 2),
  'utf8'
)
writeFileSync(resolve(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

// 直接打到 stdout，方便工具链直接看到结论
console.log('=== 冒烟测试汇总 ===')
console.log(JSON.stringify(summary, null, 2))
console.log('\n=== 渲染探针 ===')
console.log(JSON.stringify({ glInfo: probe.glInfo, pixelStats: probe.pixelStats, canvas: probe.canvas }, null, 2))
console.log('\n=== DOM 探针 ===')
console.log(JSON.stringify(probe.dom, null, 2))
console.log('\n=== 世界探针 ===')
console.log(JSON.stringify(probe.worldInfo, null, 2))
console.log('\n=== 交互探针 ===')
console.log(JSON.stringify({ before, after, afterUndo, afterOrbit }, null, 2))
console.log('\n=== AI 探针 ===')
console.log(JSON.stringify(aiProbe, null, 2))
console.log('\n=== 本地存储往返探针 ===')
console.log(JSON.stringify(storageProbe, null, 2))
console.log('\n=== 报错 (前 40 行) ===')
console.log(errors.slice(0, 40).join('\n') || '(none)')

// 存储往返是「刷新不丢进度」的硬证据，失败必须让整个测试退出码非零，
// 否则 CI 只看退出码时会把它当通过。
if (storageProbe?.failed) {
  process.exitCode = 1
}

await browser.close()
