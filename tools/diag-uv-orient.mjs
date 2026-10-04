// 贴图朝向实测探针 — 直接量 mesher 几何里的 UV 映射
//
// 为什么不靠眼睛/推理：贴图朝向涉及 image flipY、顶点环绕方向、相机朝向
// 三层约定，心算极容易错（这次就是 —— 推理说是转 90°，实测可能是别的）。
// 所以直接构建 1×1×1 草方块世界，跑 buildChunkGeometry，量「世界坐标 ↔ UV」
// 的数值对应关系，对照 Minecraft 原版的贴图朝向约定：
//
//   侧面（±X/±Z）：贴图正立 —— 图片上沿（v 大）朝 +Y。
//     （草方块侧面的绿条必须在方块上沿，用户报的「躺倒」就是这条不对）
//   顶面（+Y）  ：图片上沿朝北（−Z），u 沿 +X（东）。
//   底面（−Y）  ：只检查不越界，方向从宽（原版底面几乎全是均匀贴图）。
//
// 每个面 4 个顶点，positions/uvs 按同序排列，直接配对比较即可。
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

for (const k of ['NO_PROXY', 'no_proxy']) process.env[k] = '127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

const URL = process.argv[2] || 'http://localhost:5199/'
let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const b = await puppeteerLaunch()
const p = await b.newPage()
await p.setViewport({ width: 1200, height: 800 })
await p.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
await new Promise((r) => setTimeout(r, 1500))

// 在页面里跑 mesher：1×1×1 世界放一个草方块，量六个面的 UV
const faces = await p.evaluate(async () => {
  const mesher = await import('/src/render/mesher.js')
  const { VoxelWorld } = await import('/src/core/voxel-world.js')
  const { BLOCK_BY_NAME } = await import('/src/data/blocks.js')
  const w = new VoxelWorld(1, 1, 1)
  w.set(0, 0, 0, BLOCK_BY_NAME.get('grass_block').id)
  const geo = mesher.buildChunkGeometry(w, { x: 0, y: 0, z: 0, sizeX: 1, sizeY: 1, sizeZ: 1 })

  // 每 4 个顶点是一个面；positions 是 (x,y,z) 三元组
  const out = []
  for (let f = 0; f < geo.faceCount; f++) {
    const verts = []
    for (let ci = 0; ci < 4; ci++) {
      const vi = (f * 4 + ci) * 3
      verts.push({
        x: geo.positions[vi], y: geo.positions[vi + 1], z: geo.positions[vi + 2],
        u: geo.uvs[(f * 4 + ci) * 2], v: geo.uvs[(f * 4 + ci) * 2 + 1],
      })
    }
    out.push({ normal: null, verts })
  }
  // 识别每个面的法线：四个顶点共享的固定轴
  for (const face of out) {
    const [a, b2, c, d] = face.verts
    if (a.x === b2.x && a.x === c.x && a.x === d.x) face.normal = a.x === 0 ? '-X' : '+X'
    else if (a.y === b2.y && a.y === c.y && a.y === d.y) face.normal = a.y === 0 ? '-Y' : '+Y'
    else if (a.z === b2.z && a.z === c.z && a.z === d.z) face.normal = a.z === 0 ? '-Z' : '+Z'
  }
  return out
})

const byNormal = Object.fromEntries(faces.map((f) => [f.normal, f]))
console.log(`\n[mesher UV 朝向实测] ${URL}\n`)
check('六个面全部生成', faces.length === 6, `实得 ${faces.length} 个面`)

// ── 侧面：贴图正立，图片上沿（v 大）必须在 y=1 ──
for (const n of ['+X', '-X', '+Z', '-Z']) {
  const f = byNormal[n]
  if (!f) { check(`侧面 ${n} 存在`, false); continue }
  const vAtTop = f.verts.filter((v) => v.y === 1).map((v) => v.v)
  const vAtBot = f.verts.filter((v) => v.y === 0).map((v) => v.v)
  const topMax = Math.max(...vAtTop), botMax = Math.max(...vAtBot)
  check(`侧面 ${n} 正立（上沿 v > 下沿 v）`, topMax > botMax,
    `y=1 处 v=${vAtTop.map((x) => x.toFixed(4)).join('/')}，y=0 处 v=${vAtBot.map((x) => x.toFixed(4)).join('/')}`)
}

// ── 顶面：图片上沿朝北（−Z），u 沿 +X ──
{
  const f = byNormal['+Y']
  if (!f) check('顶面存在', false)
  else {
    const vAtNorth = f.verts.filter((v) => v.z === 0).map((v) => v.v)
    const vAtSouth = f.verts.filter((v) => v.z === 1).map((v) => v.v)
    check('顶面：贴图上沿朝北（z=0 处 v > z=1 处 v）', Math.max(...vAtNorth) > Math.max(...vAtSouth),
      `z=0 v=${vAtNorth.map((x) => x.toFixed(4)).join('/')}，z=1 v=${vAtSouth.map((x) => x.toFixed(4)).join('/')}`)
    const uAtEast = f.verts.filter((v) => v.x === 1).map((v) => v.u)
    const uAtWest = f.verts.filter((v) => v.x === 0).map((v) => v.u)
    check('顶面：u 沿 +X（东）', Math.min(...uAtEast) > Math.min(...uAtWest),
      `x=1 u=${uAtEast.map((x) => x.toFixed(4)).join('/')}，x=0 u=${uAtWest.map((x) => x.toFixed(4)).join('/')}`)
  }
}

// ── 底面：从宽，只要四个点的 UV 都落在贴图格内（0..1 之间即可，勿崩） ──
{
  const f = byNormal['-Y']
  if (!f) check('底面存在', false)
  else check('底面 UV 有效', f.verts.every((v) => v.u >= 0 && v.u <= 1 && v.v >= 0 && v.v <= 1),
    f.verts.map((v) => `(${v.u.toFixed(3)},${v.v.toFixed(3)})`).join(' '))
}

// ── 侧面 u 方向：不镜像。南面（+Z）从外看屏幕右 = +X，u1 应在 x=1 ──
// （相机 forward=(0,0,-1)，right = forward × up = +X）
{
  const f = byNormal['+Z']
  const uAtX1 = f.verts.filter((v) => v.x === 1).map((v) => v.u)
  const uAtX0 = f.verts.filter((v) => v.x === 0).map((v) => v.u)
  check('南面不镜像（u 沿 +X，u1 在 x=1）', Math.min(...uAtX1) > Math.min(...uAtX0),
    `x=1 u=${uAtX1.map((x) => x.toFixed(4)).join('/')}，x=0 u=${uAtX0.map((x) => x.toFixed(4)).join('/')}`)
}

// ── 像素级验证：真实渲染一个草方块正面，绿条必须在方块上半部 ──
// 数值断言证明的是 UV 数学正确；这一步证明「图集 + flipY + 渲染」整条链
// 合起来用户看到的就是正的。草方块侧面：上=绿(草皮) 下=棕(泥土)。
const pixel = await p.evaluate(async () => {
  const app = window.__MC_EDITOR__
  const THREE = app.__test__.three   // 静态引用，不是 Promise
  const mesher = await import('/src/render/mesher.js')
  const { ATLAS_URL } = await import('/src/render/textures.js')
  const { VoxelWorld } = await import('/src/core/voxel-world.js')
  const { BLOCK_BY_NAME } = await import('/src/data/blocks.js')

  // 与 voxel-renderer.js 同样的加载方式（TextureLoader → flipY=true），
  // 保证测的就是生产链路的行为
  const map = await new THREE.TextureLoader().loadAsync(ATLAS_URL)
  map.magFilter = THREE.NearestFilter
  map.minFilter = THREE.NearestFilter
  map.generateMipmaps = false

  const w = new VoxelWorld(1, 1, 1)
  w.set(0, 0, 0, BLOCK_BY_NAME.get('grass_block').id)
  const geo = mesher.buildChunkGeometry(w, { x: 0, y: 0, z: 0, sizeX: 1, sizeY: 1, sizeZ: 1 })

  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(geo instanceof THREE.BufferGeometry ? geo : buildGeo(geo), new THREE.MeshBasicMaterial({ map })))
  function buildGeo(g) {
    const bg = new THREE.BufferGeometry()
    bg.setAttribute('position', new THREE.BufferAttribute(g.positions, 3))
    bg.setAttribute('color', new THREE.BufferAttribute(g.colors, 3))
    bg.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2))
    bg.setIndex(new THREE.BufferAttribute(g.indices, 1))
    return bg
  }

  // 相机：从 +Z 看向南面，正交投影
  const cam = new THREE.OrthographicCamera(-0.75, 0.75, 0.75, -0.75, 0.01, 10)
  cam.position.set(0.5, 0.5, 3)
  cam.lookAt(0.5, 0.5, 0)

  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: false })
  renderer.setSize(96, 96)
  renderer.render(scene, cam)

  const gl = renderer.getContext()
  const buf = new Uint8Array(96 * 96 * 4)
  gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, buf)

  // readPixels 原点在左下角。取中间一列，比较上 1/4 与下 1/4 的平均色
  const avg = (y0, y1) => {
    let r = 0, g = 0, b = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = 40; x < 56; x++) {
      const i = (y * 96 + x) * 4
      r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  }
  const top = avg(64, 92)    // 画面上部（= 方块面上部）
  const bottom = avg(4, 32)  // 画面下部
  return { top, bottom }
})

if (pixel.error) {
  check('像素级验证可执行', false, pixel.error)
} else {
  const [tr, tg] = pixel.top, [br, bg] = pixel.bottom
  const isGreen = (r, g) => g > r + 8 && g > 60   // 草皮绿：绿显著高于红
  const isBrown = (r, g) => r > g                  // 泥土棕：红高于绿
  check('像素验证：方块面上部是草皮绿', isGreen(tr, tg), `上部平均色 rgb(${pixel.top.join(',')})`)
  check('像素验证：方块面下部是泥土棕', isBrown(br, bg), `下部平均色 rgb(${pixel.bottom.join(',')})`)
}

await b.close()
console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)

async function puppeteerLaunch() {
  const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
  const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default
  return puppeteer.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
  })
}
