/**
 * 探针：Blockbench 式方块模式的交互是否真的生效。
 *
 * ============ 为什么必须用真实鼠标事件 ============
 *
 * 这次改动的核心是「点击语义」，而点击语义全是事件驱动的：
 * 按下 / 移动 / 松开 的先后顺序、位移是否超过阈值、修饰键按没按。
 * 如果只调用 app.onCellEdit(...) 去验证，证明的只是「方法能跑」，
 * 完全证明不了「鼠标点下去会调到这个方法」—— 而这恰恰是本次唯一要验的事。
 *
 * 所以这里全部走 CDP 的 Input.dispatchMouseEvent，让事件真的从
 * 浏览器的输入管线流过：命中 canvas → InteractionController 收下 →
 * 状态机分发 → onCellEdit → commit → 世界数据变化。
 * 最后断言的是世界数组里那一格的值，而不是任何中间变量。
 *
 * ============ 反向后向对照 ============
 *
 * 光看到「测试通过」不能说明探针是有效的 —— 一个永远返回 true 的探针
 * 也「通过」。所以测试最后会做一次反向对照：人为把放置逻辑短路
 * （monkey-patch 成空操作），再跑同一套点击，断言这次必须失败。
 * 只有「正常时通过 + 短路时失败」两条同时成立，才算探针有效。
 *
 * 用法：
 *   node tools/diag-blockbench.mjs                  # 默认 http://127.0.0.1:5199
 *   node tools/diag-blockbench.mjs http://host:port
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE_MODULES =
  process.env.WB_WORKSPACE_MODULES ||
  'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'

const puppeteer = (
  await import(
    pathToFileURL(resolve(WORKSPACE_MODULES, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href
  )
).default

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', '.diag-blockbench')
mkdirSync(OUT_DIR, { recursive: true })

const URL_TARGET = process.argv[2] || 'http://localhost:5199/'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--window-size=1600,950',
  ],
})

const page = await browser.newPage()
await page.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 })

// 探针的短路钩子必须在页面脚本之前注入 —— App 只在构造交互控制器时读一次
// window.__MC_PROBE_HOOKS__，晚于那一刻注入就再也接不上了。
// 默认是 null（不使用钩子），只有反向对照那一段会临时把 cellEdit 装上。
//
// 注意方法名：这个 puppeteer-core 版本（25.x）暴露的是 evaluateOnNewDocument，
// 不是上游文档里常见的 addInitScript。用错名字不会报「参数错」，
// 而是直接 TypeError: page.addInitScript is not a function。
await page.evaluateOnNewDocument(() => {
  window.__MC_PROBE_HOOKS__ = { cellEdit: null }
})

await page.goto(URL_TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 })

await page.waitForFunction(
  () => {
    const a = window.__MC_EDITOR__
    return !!(a && a.world && a.renderer && a.controls && a.interaction)
  },
  { timeout: 25000, polling: 200 }
)

// 首帧渲染落定，并让相机插值到稳定位置 —— 相机还在飞的时候做拾取，
// 命中的格子会随帧变化，量出来的结果不可复现
await new Promise((r) => setTimeout(r, 2200))

// ---------- 工具函数（注入到页面里） ----------
await page.evaluate(() => {
  const app = window.__MC_EDITOR__

  // 视口 canvas 的中心点：所有鼠标事件都打这里，保证射线落在世界内部。
  //
  // 注意：页面上有两个 canvas —— 俯视小地图和 WebGL 主视口，
  // 且小地图的 DOM 顺序更靠前（minimap-wrap 在 viewport-overlay 里）。
  // 用 '.viewport canvas' 会选中小地图，于是所有鼠标事件都打在一个
  // 176×176 的 2D 画布上，WebGL 视口一个事件都收不到（探针第一版就是这么挂的）。
  // 判据是「能拿到 webgl 上下文」，因为小地图用的是 2d 上下文。
  window.__bb = {
    center() {
      const canvases = [...document.querySelectorAll('canvas')]
      const c = canvases.find((el) => el.getContext('webgl2') || el.getContext('webgl'))
      if (!c) throw new Error('找不到 WebGL 视口 canvas')
      const r = c.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rect: r }
    },

    /** 把相机拉到一个正对世界的角度并等它停稳 */
    async settleCamera() {
      app.controls.frameWorld(app.world)
      // 相机是阻尼插值的，等它真的收敛（距离变化 < 0.01）。
      // 但「收敛」不只是 position —— azimuth/polar/distance 三个目标值
      // 都要对上。这里额外要求连续 3 帧稳定，否则会出现「刚好路过」的假收敛：
      // 上一段测试把相机转到了另一个方位，插值回程中每一帧都在变，
      // 单看一次差值可能恰好很小，于是误判为停稳 —— 后面所有 pick
      // 都会落在一个还在飞的相机上，量出来的格子毫无意义。
      let stable = 0
      for (let i = 0; i < 240; i++) {
        await new Promise((r) => requestAnimationFrame(r))
        const d = Math.abs(app.controls.distance - app.controls._targetDistance)
        const a = Math.abs(app.controls.azimuth - app.controls._targetAz)
        const p = Math.abs(app.controls.polar - app.controls._targetPolar)
        if (d < 0.01 && a < 0.0005 && p < 0.0005) { if (++stable >= 3) break } else stable = 0
      }
      await new Promise((r) => setTimeout(r, 260))
    },
  }
})

// ---------- 鼠标动作封装（走真实 CDP 输入管线） ----------
//
// 注意 CENTER 不能只算一次就到处用。
// 面板内容会随模式变化（笔刷模式多一整块「笔刷参数」），布局一变
// 视口的 rect 就变了；更关键的是相机被拖动过之后，同样的屏幕点
// 可能射到世界的边缘墙（x=0 那一列）上，于是「放置」全落在越界格。
// 所以每段测试开跑前都重新取一次中心点。
let CENTER = await page.evaluate(() => window.__bb.center())
const recenter = async () => { CENTER = await page.evaluate(() => window.__bb.center()); return CENTER }

/** 让中心点命中一个「周围有实体方块、且目标格是空气」的位置，避免落在边缘墙上 */
async function aimAtEditableSpot() {
  const c = await page.evaluate(() => {
    const app = window.__MC_EDITOR__
    const cv = [...document.querySelectorAll('canvas')].find((el) => el.getContext('webgl2') || el.getContext('webgl'))
    const r = cv.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    // 在中心附近螺旋找一点，要求：命中实体方块，且放置目标是世界内的空格
    for (let ring = 0; ring <= 6; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const x = Math.round(cx + dx * 26)
          const y = Math.round(cy + dy * 26)
          const h = app.renderer.pick(x, y)
          if (!h || h.id === 0) continue
          if (!app.world.inBounds(h.placeX, h.placeY, h.placeZ)) continue
          // 放置目标最好还是空气，这样点一下必有效果
          if (app.world.get(h.placeX, h.placeY, h.placeZ) !== 0) continue
          return { x, y, hit: `${h.x},${h.y},${h.z}`, target: `${h.placeX},${h.placeY},${h.placeZ}` }
        }
      }
    }
    return { x: Math.round(cx), y: Math.round(cy), hit: null, target: null }
  })
  return c
}

async function click({ button = 'left', at = null, delay = 40 } = {}) {
  const p = at || CENTER
  await page.mouse.move(p.x, p.y)
  await page.mouse.down({ button })
  await new Promise((r) => setTimeout(r, delay))
  await page.mouse.up({ button })
  await new Promise((r) => setTimeout(r, 260))
}

async function drag({ from, to, button = 'left', modifiers = [], steps = 10 } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down({ button })
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      Math.round(from.x + ((to.x - from.x) * i) / steps),
      Math.round(from.y + ((to.y - from.y) * i) / steps)
    )
    await new Promise((r) => setTimeout(r, 24))
  }
  await page.mouse.up({ button })
  await new Promise((r) => setTimeout(r, 280))
}

// ---------- 开始逐项验证 ----------
const steps = []
const log = (name, ok, detail) => {
  steps.push({ name, ok, detail: String(detail ?? '') })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(30)} ${detail ?? ''}`)
}

await page.evaluate(() => window.__bb.settleCamera())

// ===== 1. 方块模式下的单击放置 =====
{
  const spot = await aimAtEditableSpot()
  if (!spot.target) {
    log('单击放置一格', false, '中心附近找不到「可放置」的位置（相机没对着世界？）')
  } else {
    const before = await page.evaluate((sp) => {
      const app = window.__MC_EDITOR__
      const [x, y, z] = sp.target.split(',').map(Number)
      return {
        target: { x, y, z, id: app.state.blockId },
        cell: app.world.get(x, y, z),
        undoCount: app.bus.undoStack.length,
      }
    }, spot)

    await click({ at: spot })
    // 世界数据在 commit 里当场就改了，但「可见的变化」要等主循环 flushDirty
    // 和一次额外的整块重建。这里显式等一批帧，而不是赌固定毫秒。
    await page.evaluate(() => new Promise((r) => {
      const app = window.__MC_EDITOR__
      let n = 0
      const step = () => {
        app.renderer.flushDirty()
        if (++n >= 8) return r()
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    }))
    const after = await page.evaluate((t) => {
      const app = window.__MC_EDITOR__
      return {
        cell: app.world.get(t.x, t.y, t.z),
        undoCount: app.bus.undoStack.length,
        lastLabel: app.bus.stackState().lastLabel,
      }
    }, before.target)

    const placed = after.cell === before.target.id && after.cell !== before.cell
    log('单击放置一格', placed,
      `(${before.target.x},${before.target.y},${before.target.z}) ${before.cell} → ${after.cell}（期望 ${before.target.id}）`)
    log('放置进了撤销栈', after.undoCount === before.undoCount + 1,
      `${before.undoCount} → ${after.undoCount} · ${after.lastLabel}`)
  }
}

// 撤销掉刚才那一格，回到干净状态
await page.evaluate(() => window.__MC_EDITOR__.doUndo())
await page.evaluate(() => window.__bb.settleCamera())

// ===== 2. 反向后向对照：把放置逻辑短路，同一套点击必须失败 =====
//
// 这一段曾经假绿过一次：探针的鼠标打在错误 canvas 上，整条链路根本没跑，
// 于是「短路后世界未变」当然成立 —— 但那是「什么都没发生」的未变，
// 不是「短路起了作用」的未变。
// 所以这里加一条活性断言：钩子必须真的被调到过。没调到 = 整段对照无意义。
{
  const spot = await aimAtEditableSpot()
  if (!spot.target) {
    log('反向对照（应失败）', false, '中心附近找不到可编辑位置')
  } else {
    const before = await page.evaluate((sp) => {
      const app = window.__MC_EDITOR__
      // 短路：让钩子直接返回 0，onCellEdit 根本不会被走到，世界不变。
      // 这是通过 App 在构造时预留的钩子表实现的（见 public/probe-hooks.js）——
      // 不能事后替换 app.onCellEdit，因为交互控制器构造时已经把回调捕获进闭包了。
      window.__hookCalls = 0
      window.__MC_PROBE_HOOKS__.cellEdit = () => { window.__hookCalls++; return 0 }
      const [x, y, z] = sp.target.split(',').map(Number)
      return { target: { x, y, z }, cell: app.world.get(x, y, z) }
    }, spot)

    await click({ at: spot })
    await page.evaluate(() => new Promise((r) => {
      const app = window.__MC_EDITOR__
      let n = 0
      const step = () => { app.renderer.flushDirty(); if (++n >= 6) return r(); requestAnimationFrame(step) }
      requestAnimationFrame(step)
    }))
    const after = await page.evaluate((t) => {
      const app = window.__MC_EDITOR__
      return { cell: app.world.get(t.x, t.y, t.z), hookCalls: window.__hookCalls }
    }, before.target)

    // 活性断言：钩子被调到，说明点击确实走到了编辑入口。
    // 这一条不成立的话，下面那条「世界没变」是在为一条死链路背书。
    log('反向对照·钩子被触发', after.hookCalls > 0,
      `hookCalls=${after.hookCalls}（0 表示点击没走到编辑链路，对照无效）`)

    // 这里期望「没变」——也就是对照确实把功能打掉了。
    const unchanged = after.cell === before.cell
    log('反向对照（应失败）', unchanged && after.hookCalls > 0,
      unchanged ? `短路后世界未变（钩子拦截 ${after.hookCalls} 次），探针确有效力`
                : `短路后仍变成 ${after.cell}，探针无效`)

    await page.evaluate(() => { window.__MC_PROBE_HOOKS__.cellEdit = null })
  }
}

// ===== 2b. 摘掉钩子后，同一套点击必须重新生效 =====
// 这是对照的另一半：如果拿掉钩子世界还是不变，说明「不变」与钩子无关。
{
  const spot = await aimAtEditableSpot()
  if (spot.target) {
    const before = await page.evaluate((sp) => {
      const app = window.__MC_EDITOR__
      const [x, y, z] = sp.target.split(',').map(Number)
      return { target: { x, y, z }, cell: app.world.get(x, y, z) }
    }, spot)
    await click({ at: spot })
    const after = await page.evaluate((t) => {
      const app = window.__MC_EDITOR__
      return { cell: app.world.get(t.x, t.y, t.z), id: app.state.blockId }
    }, before.target)
    log('摘钩后点击恢复生效', after.cell !== before.cell,
      `(${before.target.x},${before.target.y},${before.target.z}) ${before.cell} → ${after.cell}（目标 ${after.id}）`)
    await page.evaluate(() => window.__MC_EDITOR__.doUndo())
    await page.evaluate(() => window.__bb.settleCamera())
  } else {
    log('摘钩后点击恢复生效', false, '中心附近找不到可编辑位置')
  }
}

// ===== 3. Alt+左键删除一格 =====
await page.evaluate(() => window.__bb.settleCamera())
{
  // 删除要命中的是「实体方块」本身，所以要找一个中心附近有实体的点，
  // 而不是 aimAtEditableSpot 那种「旁边是空气」的位置
  const spot = await page.evaluate(() => {
    const app = window.__MC_EDITOR__
    const cv = [...document.querySelectorAll('canvas')].find((el) => el.getContext('webgl2') || el.getContext('webgl'))
    const r = cv.getBoundingClientRect()
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2
    for (let ring = 0; ring <= 6; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const x = Math.round(cx + dx * 26), y = Math.round(cy + dy * 26)
          const h = app.renderer.pick(x, y)
          if (h && h.id !== 0) return { x, y, hit: `${h.x},${h.y},${h.z}`, id: h.id }
        }
      }
    }
    return null
  })

  if (!spot) {
    log('Alt+左键删除一格', false, '中心附近找不到实体方块')
  } else {
    const before = await page.evaluate((sp) => {
      const app = window.__MC_EDITOR__
      const [x, y, z] = sp.hit.split(',').map(Number)
      return { target: { x, y, z }, cell: app.world.get(x, y, z) }
    }, spot)

    // 用键盘真的按住 Alt，而不是给事件加 modifier 标记 ——
    // 因为交互层读的是 keydown 维护的 altHeld 状态
    await page.keyboard.down('Alt')
    await new Promise((r) => setTimeout(r, 140))
    const armed = await page.evaluate(() => window.__MC_EDITOR__.altHeld)
    await click({ at: spot })
    await page.keyboard.up('Alt')
    await new Promise((r) => setTimeout(r, 180))

    const after = await page.evaluate((t) => {
      const app = window.__MC_EDITOR__
      return { cell: app.world.get(t.x, t.y, t.z), undoLabel: app.bus.stackState().lastLabel }
    }, before.target)

    log('Alt 状态已同步到 App', armed === true, `app.altHeld=${armed}`)
    log('Alt+左键删除一格', after.cell === 0 && before.cell !== 0,
      `(${before.target.x},${before.target.y},${before.target.z}) ${before.cell} → ${after.cell}`)
    log('删除标签正确', /删除/.test(after.undoLabel || ''), after.undoLabel || '(无)')
  }
}

// ===== 4. 右键拖拽转视角（用户明确要求保留） =====
await page.evaluate(() => window.__bb.settleCamera())
await recenter()
{
  const before = await page.evaluate(() => ({
    azimuth: window.__MC_EDITOR__.controls.azimuth,
    revision: window.__MC_EDITOR__.world.revision,
    undoCount: window.__MC_EDITOR__.bus.undoStack.length,
  }))

  await drag({
    from: { x: CENTER.x - 160, y: CENTER.y },
    to: { x: CENTER.x + 160, y: CENTER.y - 70 },
    button: 'right',
  })

  const after = await page.evaluate(() => ({
    azimuth: window.__MC_EDITOR__.controls.azimuth,
    revision: window.__MC_EDITOR__.world.revision,
    undoCount: window.__MC_EDITOR__.bus.undoStack.length,
  }))

  const rotated = Math.abs(after.azimuth - before.azimuth) > 0.08
  log('右键拖拽转视角', rotated, `azimuth ${before.azimuth.toFixed(4)} → ${after.azimuth.toFixed(4)}`)
  // 关键反向断言：转视角绝不能顺手改了世界。
  // 这里同时看 revision 和撤销栈 —— 只看其中一个的话，
  // 万一改动走的是不产生 revision 的路径就漏掉了。
  log('转视角未误写世界',
    after.revision === before.revision && after.undoCount === before.undoCount,
    `revision ${before.revision} → ${after.revision} · 撤销栈 ${before.undoCount} → ${after.undoCount}`)
}

// ===== 5. 左键拖拽连续放置，且不重复写同一格 =====
//
// 断言方式经过两次修正，值得记下来：
//
// 1) 一开始比的是「世界实体方块总数变化」。但沿地形表面横拖时落点常常
//    是已存在的石头，set() 返回 false，总数不变 —— 一个完全正常的拖拽被判失败。
//    改成通过钩子记录「每次编辑请求的目标格」，断言「连续请求了多个不同格子」。
//
// 2) 改完仍不对：落点是清一色的 x=0（世界侧壁那一列）。原因是上一段
//    右键转视角把相机转到了 azimuth≈-1.6，此时「屏幕水平」在世界里是斜的，
//    而且正对着侧壁，放置目标大量越界 —— 测试走了一条退化路径。
//    所以这里先把相机复位到开机时的取景（frameWorld），
//    在那个位姿下整个视口都落在世界内部（已实测确认）。
await page.evaluate(() => {
  // 用 frameWorld + snap 一次性复位，而不是靠阻尼插值等它自己回来
  window.__MC_EDITOR__.controls.frameWorld(window.__MC_EDITOR__.world)
  window.__MC_EDITOR__.controls.snap()
})
await page.evaluate(() => window.__bb.settleCamera())
await recenter()
{
  await page.evaluate(() => {
    // 用钩子记录目标格，但返回 undefined 放行给真实逻辑 —— 只观察不干预
    window.__editLog = []
    window.__MC_PROBE_HOOKS__.cellEdit = (target, info) => {
      window.__editLog.push(`${target.x},${target.y},${target.z}`)
      return undefined
    }
  })

  // 横拖一条线。相机复位后视口中心整片都在世界内部，
  // 所以直接用中心 ± 偏移即可，不需要再搜索。
  await drag({
    from: { x: CENTER.x - 110, y: CENTER.y },
    to: { x: CENTER.x + 110, y: CENTER.y },
    button: 'left',
    steps: 14,
  })

  const after = await page.evaluate(() => ({
    undoCount: window.__MC_EDITOR__.bus.undoStack.length,
    log: window.__editLog,
  }))
  await page.evaluate(() => { window.__MC_PROBE_HOOKS__.cellEdit = null })

  const distinct = new Set(after.log).size
  log('左键拖拽连续编辑', after.log.length > 1, `触发 ${after.log.length} 次编辑请求`)
  log('拖拽跨过多个格子', distinct > 2,
    `命中 ${distinct} 个不同格子：${[...new Set(after.log)].slice(0, 6).join(' → ')}`)
  // 去重的意义：14 次鼠标采样里，落在同一格的那些被折叠掉
  log('同格去重生效', after.log.length <= distinct + 1,
    `触发 ${after.log.length} 次 ≤ 不同格子 ${distinct} + 1`)

  // 路径有效性：命中点不能全贴在世界边界（x/y/z 出现 0 或 max-1）。
  // 贴边说明相机正对着世界的侧壁，放置目标大量越界，
  // 测试其实是在走一条退化的路径，不能代表正常编辑。
  // 这条断言是上一轮「假通过」逼出来的 —— 没有它，贴边路径会一直绿下去。
  const dims = await page.evaluate(() => ({
    w: window.__MC_EDITOR__.world.width,
    h: window.__MC_EDITOR__.world.height,
    d: window.__MC_EDITOR__.world.depth,
  }))
  const cells = [...new Set(after.log)].map((s) => s.split(',').map(Number))
  const onEdge = cells.filter(([x, y, z]) =>
    x === 0 || y === 0 || z === 0 || x === dims.w - 1 || y === dims.h - 1 || z === dims.d - 1).length
  log('拖拽路径不在世界边界上', onEdge < cells.length,
    `${onEdge}/${cells.length} 个落点贴边（全贴边说明相机对着侧壁，路径退化）`)
}

// ===== 6. 切到笔刷模式：整段涂抹 + 参数面板挂载 =====
//
// 这里刻意不去断言「笔刷拖一次只有一条命令」—— 那是错的。
// 两个模式的提交粒度确实不同，但不在「条数」上：
//   · 方块模式：每个跨过的格子各一条（够撤销到具体的某一格）
//   · 笔刷模式：每个 pointermove 段一条，段内做插值补点
//     （applyBrushStroke 会把 from→to 之间按 spacing 插出一串落点，
//      所以快速拖动不会留下断点）
// 把「条数少」当成笔刷的卖点是误读实现。这一段真正要验的是：
// 切换模式后参数面板正确挂载/卸载，且涂抹确实改了世界。
{
  await page.evaluate(() => {
    window.__MC_EDITOR__.setInputMode('brush')
  })
  await page.evaluate(() => window.__bb.settleCamera())
  await new Promise((r) => setTimeout(r, 300))

  const modeOk = await page.evaluate(() => window.__MC_EDITOR__.state.inputMode)
  log('可切到笔刷模式', modeOk === 'brush', `inputMode=${modeOk}`)

  const panel = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('#toolbar .panel-title')].map((t) => t.textContent.trim())
    return {
      titles,
      hasBrushParams: titles.some((t) => t.includes('笔刷参数')),
      hasMode: titles.some((t) => t.includes('操作模式')),
    }
  })
  log('笔刷参数面板已出现', panel.hasBrushParams, panel.titles.join(' | '))

  // 切到笔刷模式后重新取中心点：面板里多了「笔刷参数」整块，
  // 布局一变视口 rect 就变了
  const brushCenter = await page.evaluate(() => window.__bb.center())

  const before = await page.evaluate((c) => {
    const app = window.__MC_EDITOR__
    const h = app.renderer.pick(c.x, c.y)
    return {
      undoCount: app.bus.undoStack.length,
      revision: app.world.revision,
      aim: h ? `${h.x},${h.y},${h.z}` : null,
    }
  }, brushCenter)

  await drag({
    from: { x: brushCenter.x - 60, y: brushCenter.y },
    to: { x: brushCenter.x + 60, y: brushCenter.y },
    button: 'left',
    steps: 8,
  })

  const after = await page.evaluate(() => {
    const app = window.__MC_EDITOR__
    return { undoCount: app.bus.undoStack.length, revision: app.world.revision }
  })

  // 真正确认「涂抹生效」：revision 必须动过。
  // revision 是世界的单调修改计数，只要有一个方块真的被写进去就会加，
  // 比「撤销栈条数」更直接地证明这次拖拽有实效。
  log('笔刷涂抹改动了世界', after.revision !== before.revision,
    `revision ${before.revision} → ${after.revision}，落笔处 ${before.aim ?? '未命中'}`)
  log('笔刷拖拽可撤销', after.undoCount > before.undoCount,
    `撤销栈 ${before.undoCount} → ${after.undoCount}`)

  // 切回方块模式，确认笔刷参数面板收起
  await page.evaluate(() => window.__MC_EDITOR__.setInputMode('block'))
  await new Promise((r) => setTimeout(r, 300))
  const back = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('#toolbar .panel-title')].map((t) => t.textContent.trim())
    return { mode: window.__MC_EDITOR__.state.inputMode, hasBrushParams: titles.some((t) => t.includes('笔刷参数')) }
  })
  log('切回方块模式隐藏笔刷参数', back.mode === 'block' && !back.hasBrushParams,
    `mode=${back.mode} 笔刷参数=${back.hasBrushParams ? '仍在' : '已隐藏'}`)
}

// ===== 7. 方块光标与放置预览 =====
await page.evaluate(() => window.__bb.settleCamera())
{
  // 前面切过模式、拖动过多次，重新取一次视口中心，确保鼠标落在世界上
  const c = await page.evaluate(() => window.__bb.center())
  await page.mouse.move(c.x, c.y)
  await new Promise((r) => setTimeout(r, 340))

  const cur = await page.evaluate(() => {
    const r = window.__MC_EDITOR__.renderer
    return {
      cursorVisible: r.cursorBox.visible,
      ghostVisible: r.ghostBox.visible,
      eraseVisible: r.eraseBox.visible,
      ghostColor: '#' + r.ghostBox.material.color.getHexString(),
    }
  })
  log('方块光标已显示', cur.cursorVisible, `cursorBox.visible=${cur.cursorVisible}`)
  log('放置预览色块显示', cur.ghostVisible && !cur.eraseVisible,
    `ghost=${cur.ghostVisible} erase=${cur.eraseVisible} 色=${cur.ghostColor}`)

  // 按住 Alt，预览应切成红色删除块
  await page.keyboard.down('Alt')
  await new Promise((r) => setTimeout(r, 200))
  // 修饰键变化会触发 refreshHoverPreview，但鼠标没动，需要保持 hover 有值
  await page.mouse.move(c.x, c.y + 1)
  await new Promise((r) => setTimeout(r, 280))
  const altCur = await page.evaluate(() => {
    const r = window.__MC_EDITOR__.renderer
    return {
      ghostVisible: r.ghostBox.visible,
      eraseVisible: r.eraseBox.visible,
      cursorColor: '#' + r.cursorBox.material.color.getHexString(),
    }
  })
  await page.keyboard.up('Alt')

  log('Alt 时预览切换为删除', altCur.eraseVisible && !altCur.ghostVisible,
    `erase=${altCur.eraseVisible} ghost=${altCur.ghostVisible} 描边=${altCur.cursorColor}`)
}

// ---------- 汇总 ----------
const failed = steps.filter((s) => !s.ok)
writeFileSync(resolve(OUT_DIR, 'result.json'), JSON.stringify({ url: URL_TARGET, steps }, null, 2), 'utf8')

console.log(`\n结果：${failed.length === 0 ? '全部通过（' + steps.length + ' 项）' : failed.length + ' / ' + steps.length + ' 项失败'}`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  - ${f.name}：${f.detail}`)
}
console.log(`明细已写入 ${resolve(OUT_DIR, 'result.json')}\n`)

await browser.close()
process.exit(failed.length === 0 ? 0 : 1)
