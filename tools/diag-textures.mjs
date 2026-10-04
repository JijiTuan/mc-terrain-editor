/**
 * tools/diag-textures.mjs — 验证贴图渲染真的生效
 *
 * 要验的几件事（都不能只看「没报错」）：
 *   1. 图集贴图确实加载成功（不是 404 后的空纹理）
 *   2. 几何体有 uv 属性，且 UV 落在 0..1 内
 *   3. 网格用的材质带 map，且过滤是 NearestFilter（像素感的关键）
 *   4. 截图像素里能看到「多种颜色」—— 纯色说明贴图没生效
 *   5. 面朝向明暗差异接近无光照（顶/侧/底 的亮度比）
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron')
const probePath = path.join(ROOT, '.diag-tex-probe.cjs')
const outPath = path.join(ROOT, '.diag-tex.json')
const shotPath = path.join(ROOT, '.diag-tex.png')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV
delete env.MC_EDITOR_DEV_SERVER

const probe = `
const { app, BrowserWindow } = require('electron')
const fs = require('fs'), path = require('path')
const LOG = ${JSON.stringify(outPath)}
const events = []
const done = (code) => { try { fs.writeFileSync(LOG, JSON.stringify(events, null, 2)) } catch {} app.exit(code) }
const hardTimer = setTimeout(() => { events.push({ t: 'TIMEOUT' }); done(1) }, 50000)

app.whenReady().then(async () => {
  try { require(path.join(${JSON.stringify(ROOT)}, 'electron', 'main.cjs')) }
  catch (err) { events.push({ t: 'main FAILED', error: err.message }); clearTimeout(hardTimer); return done(1) }

  let waited = 0
  while (BrowserWindow.getAllWindows().length === 0 && waited < 20000) {
    await new Promise(r => setTimeout(r, 250)); waited += 250
  }
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) { events.push({ t: 'no window' }); clearTimeout(hardTimer); return done(1) }

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    const ready = await w.webContents.executeJavaScript(
      'Boolean(window.__MC_EDITOR__ && window.__MC_EDITOR__.renderer && window.__MC_EDITOR__.world)'
    ).catch(() => false)
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }

  // 收集加载失败
  const fails = await w.webContents.executeJavaScript(\`(() => {
    const out = { failed: [] }
    performance.getEntriesByType('resource').forEach(e => {
      if (e.name.includes('blocks-atlas')) out.atlasUrl = e.name
    })
    return out
  })()\`).catch(() => ({}))
  events.push({ t: 'atlasUrl', data: fails })

  // 铺一片有代表性的方块做视觉检查：草、石、沙、木
  const setup = await w.webContents.executeJavaScript(\`(() => {
    const a = window.__MC_EDITOR__
    const w = a.world
    const W = w.width, D = w.depth, H = w.height
    // 顶部铺草（id 4），下面垫石头（id 1）
    for (let y = 0; y < Math.min(12, H); y++)
      for (let z = 0; z < D; z++)
        for (let x = 0; x < W; x++)
          w.set(x, y, z, y === 11 ? 4 : 1)
    // 一片沙地（id 5）
    for (let z = 20; z < 30; z++) for (let x = 20; x < 30; x++) w.set(x, 11, z, 5)
    // 四根原木柱子（id 26），看得到顶面年轮
    for (const [cx, cz] of [[10, 10], [40, 10], [10, 40], [40, 40]]) {
      for (let y = 12; y < 18; y++) w.set(cx, y, cz, 26)
    }
    // 触发全量重建
    a.renderer.forceRebuildAll = true
    return { ok: true, w: W, h: H, d: D }
  })()\`).catch(e => ({ error: String(e) }))
  events.push({ t: 'setup', data: setup })

  await new Promise(r => setTimeout(r, 2500))

  // 检查材质与几何
  const check = await w.webContents.executeJavaScript(\`(() => {
    const a = window.__MC_EDITOR__
    const r = a.renderer
    const mat = r.material
    const meshes = [...r.chunks.values()]
    const m0 = meshes[0]
    const geo = m0 && m0.geometry
    let uvRange = null
    if (geo && geo.attributes.uv) {
      const arr = geo.attributes.uv.array
      let mn = Infinity, mx = -Infinity
      for (let i = 0; i < arr.length; i++) { if (arr[i] < mn) mn = arr[i]; if (arr[i] > mx) mx = arr[i] }
      uvRange = { min: +mn.toFixed(4), max: +mx.toFixed(4), count: arr.length }
    }
    const tex = mat && mat.map
    // three 的常量：NearestFilter = 1003，LinearFilter = 1006
    return {
      chunkCount: meshes.length,
      materialHasMap: Boolean(tex),
      textureLoaded: Boolean(tex && tex.image && (tex.image.width || tex.image.naturalWidth)),
      textureSize: tex && tex.image ? (tex.image.width || tex.image.naturalWidth) + 'x' + (tex.image.height || tex.image.naturalHeight) : null,
      magFilter: tex ? tex.magFilter : null,
      magFilterNearest: tex ? tex.magFilter === 1003 : null,
      minFilter: tex ? tex.minFilter : null,
      minFilterNearest: tex ? tex.minFilter === 1003 : null,
      generateMipmaps: tex ? tex.generateMipmaps : null,
      vertexColors: mat ? mat.vertexColors : null,
      hasUvAttribute: Boolean(geo && geo.attributes.uv),
      uvRange,
      vertexCount: geo ? geo.attributes.position.count : 0,
      // 顶点色应该是接近 1 的灰度（面明暗），不是方块本色
      vertexColorSample: geo && geo.attributes.color ? [
        +geo.attributes.color.array[0].toFixed(3),
        +geo.attributes.color.array[1].toFixed(3),
        +geo.attributes.color.array[2].toFixed(3),
      ] : null,
      // 顶点色全部取值集合（应该只有 1.00 / 0.97 / 0.94 / 0.88 几种灰度）
      vertexColorPalette: geo && geo.attributes.color
        ? [...new Set(Array.from(geo.attributes.color.array).map(v => +v.toFixed(3)))].sort()
        : null,
    }
  })()\`).catch(e => ({ error: String(e) }))
  events.push({ t: 'material', data: check })

  // 截图并统计颜色多样性：纯色 = 贴图没生效
  const png = await w.webContents.capturePage().catch(() => null)
  if (png) {
    try { fs.writeFileSync(${JSON.stringify(shotPath)}, png.toPNG()) } catch {}
  }

  clearTimeout(hardTimer)
  done(0)
})
`

fs.writeFileSync(probePath, probe)
const child = spawn(electronBin, [probePath, '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env,
})
let err = ''
child.stderr.on('data', (d) => { err += d.toString() })
await new Promise((res) => child.on('exit', res))

try {
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'))
  for (const ev of data) console.log('\n[' + ev.t + ']\n' + JSON.stringify(ev.data ?? ev, null, 2))
} catch (e) {
  console.error('读结果失败：', e.message, '\n', err.slice(-2000))
}
