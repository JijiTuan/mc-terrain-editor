// WASD 飞行平移探针
// 要验证的不是「函数被调用了」，而是「注视点确实按视角朝向移动了」。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default
const b = await puppeteer.launch({
  executablePath: 'C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1600,950'],
})
const p = await b.newPage()
await p.setViewport({ width: 1600, height: 950, deviceScaleFactor: 1 })
await p.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__MC_EDITOR__?.interaction, { timeout: 25000, polling: 200 })
await new Promise((r) => setTimeout(r, 3000))

const center = () => p.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].find((el) => el.getContext('webgl2') || el.getContext('webgl'))
  const r = cv.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})
const snap = () => p.evaluate(() => {
  const c = window.__MC_EDITOR__.controls
  const t = c._targetTarget
  const d = new (window.__MC_EDITOR__.controls.camera.position.constructor)()
  c.camera.getWorldDirection(d)
  return {
    target: [+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3)],
    camDir: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)],
    distance: +c.distance.toFixed(2),
    flySpeed: c.flySpeed,
  }
})

let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  — ' + detail : ''}`)
  ok ? pass++ : fail++
}

const C = await center()
await p.mouse.move(C.x, C.y)   // 让视口获得「聚焦」
await new Promise((r) => setTimeout(r, 200))

// ---- 1. W 前进：target 应沿相机水平朝向前移 ----
let a = await snap()
await p.keyboard.down('w')
await new Promise((r) => setTimeout(r, 600))
await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 200))
let bb = await snap()
const dx = bb.target[0] - a.target[0]
const dz = bb.target[2] - a.target[2]
const moved = Math.hypot(dx, dz)
// 相机水平朝向（压平后归一）
const hd = Math.hypot(a.camDir[0], a.camDir[2])
const hDir = [a.camDir[0] / hd, a.camDir[2] / hd]
// 位移方向与相机水平朝向的余弦相似度
const cos = moved > 0 ? (dx / moved) * hDir[0] + (dz / moved) * hDir[1] : 0
check('W 让注视点水平移动', moved > 2, `移动 ${moved.toFixed(2)} 格`)
check('W 的移动方向 = 相机水平朝向', cos > 0.98, `cos=${cos.toFixed(4)}（1.0 表示完全一致）`)
check('W 不改变高度', Math.abs(bb.target[1] - a.target[1]) < 0.01, `Δy=${(bb.target[1] - a.target[1]).toFixed(4)}`)

// ---- 2. S 后退：方向应与 W 相反 ----
a = await snap()
await p.keyboard.down('s')
await new Promise((r) => setTimeout(r, 400))
await p.keyboard.up('s')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const sdx = bb.target[0] - a.target[0], sdz = bb.target[2] - a.target[2]
const sDot = hDir[0] * sdx + hDir[1] * sdz
check('S 沿相机朝向的反方向移动', sDot < -1, `点积=${sDot.toFixed(2)}（负值=后退）`)

// ---- 3. D 横移：方向应垂直于相机朝向 ----
a = await snap()
await p.keyboard.down('d')
await new Promise((r) => setTimeout(r, 400))
await p.keyboard.up('d')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const ddx = bb.target[0] - a.target[0], ddz = bb.target[2] - a.target[2]
const dLen = Math.hypot(ddx, ddz)
const dDot = dLen > 0 ? (ddx / dLen) * hDir[0] + (ddz / dLen) * hDir[1] : 0
check('D 横向移动且垂直朝向', dLen > 1 && Math.abs(dDot) < 0.02, `长度=${dLen.toFixed(2)} 垂直度=${dDot.toFixed(4)}`)

// ---- 4. 固定步长：不同距离下同样时长的位移量应一致 ----
a = await snap()
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 500)); await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const nearMove = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])

// 把镜头拉远很多，再测同样时长
await p.evaluate(() => { window.__MC_EDITOR__.controls.jumpTo({ distance: 400 }); window.__MC_EDITOR__.controls._targetDistance = 400 })
await new Promise((r) => setTimeout(r, 300))
a = await snap()
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 500)); await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const farMove = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])
check('固定步长：远近位移一致', Math.abs(nearMove - farMove) < nearMove * 0.25,
  `distance≈70 走 ${nearMove.toFixed(2)} / distance≈400 走 ${farMove.toFixed(2)}`)

// ---- 5. Ctrl 加速 ----
await p.evaluate(() => { window.__MC_EDITOR__.controls.jumpTo({ distance: 70 }) })
await new Promise((r) => setTimeout(r, 200))
a = await snap()
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 500)); await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const normal = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])

a = await snap()
await p.keyboard.down('Control')
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 500))
await p.keyboard.up('w'); await p.keyboard.up('Control')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const fast = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])
check('Ctrl 加速生效', fast > normal * 2.5, `常速 ${normal.toFixed(2)} → 加速 ${fast.toFixed(2)}（约 ${(fast / normal).toFixed(1)}×）`)

// ---- 6. 反向对照：鼠标不在视口里时 WASD 应无效 ----
await p.mouse.move(1500, 200)  // 移到右侧 AI 面板
await new Promise((r) => setTimeout(r, 250))
const focused = await p.evaluate(() => window.__MC_EDITOR__.interaction.viewportFocused)
a = await snap()
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 500)); await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const ctrlMove = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])
check('反向对照·视口外按下时不该移动', focused === false && ctrlMove < 0.01,
  `viewportFocused=${focused} 位移=${ctrlMove.toFixed(4)}`)

// ---- 7. 反向对照的活性证明：同一位置把鼠标放回视口，W 应恢复生效 ----
await p.mouse.move(C.x, C.y)
await new Promise((r) => setTimeout(r, 250))
a = await snap()
await p.keyboard.down('w'); await new Promise((r) => setTimeout(r, 400)); await p.keyboard.up('w')
await new Promise((r) => setTimeout(r, 150))
bb = await snap()
const backMove = Math.hypot(bb.target[0] - a.target[0], bb.target[2] - a.target[2])
check('反向对照·放回视口后恢复生效', backMove > 2, `位移 ${backMove.toFixed(2)} 格`)

console.log(`\n结果：${fail === 0 ? '全部通过' : fail + ' 项失败'}（${pass} 通过 / ${fail} 失败）`)
await b.close()
process.exit(fail === 0 ? 0 : 1)
