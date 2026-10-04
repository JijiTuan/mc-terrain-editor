// 存档功能端到端探针（真实 Electron + 真实磁盘上的假存档）
//
// 为什么不能只靠单元测试：单元测试直接调 importWorldWindow，
// 绕过了 IPC、对话框、备份逻辑、写盘路径。而这些恰恰是最容易出错的地方 ——
// 二进制过一遍 UTF-8 就会被静默破坏，单元测试根本碰不到这一层。
//
// 所以这个探针会：
//   1. 在磁盘上造一个**结构完整**的假存档（level.dat + region/*.mca）
//   2. 启动真实 Electron，调主进程 IPC 读写它
//   3. 断言写回后：原文件被备份、方块真的变了、其它字段没丢
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── 先给本机回环开个免代理白名单 ──
// 这台机器（WorkBuddy 沙箱）shell 里设了 http_proxy/https_proxy=http://127.0.0.1:51397，
// Node 的 fetch 会**老老实实把 127.0.0.1 的请求也塞进代理**，代理不转发回环 → UND_ERR_SOCKET。
// 症状特别有误导性：子进程明明打印了 "DevTools listening on ws://127.0.0.1:9335"，
// 探针却一直报「端口没起来」，看起来像打包产物坏了，其实是探针自己连不上。
// 必须在**本进程**和**子进程**两头都设，缺一头都不行。
for (const k of ['NO_PROXY', 'no_proxy']) process.env[k] = '127.0.0.1,localhost,::1'
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[k]

const WS = 'C:/Users/passk/.workbuddy/binaries/node/workspace/node_modules'
const puppeteer = (await import(pathToFileURL(resolve(WS, 'puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default

let pass = 0, fail = 0
const check = (n, ok, d = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${n}${d ? '  — ' + d : ''}`); ok ? pass++ : fail++ }

const ROOT = resolve('.')
const SAVE_DIR = path.join(os.tmpdir(), `mc-probe-save-${Date.now()}`)
const REGION_DIR = path.join(SAVE_DIR, 'region')
fs.mkdirSync(REGION_DIR, { recursive: true })

// ── 用项目自己的模块造一个合法存档 ──
const anvil = await import(pathToFileURL(path.join(ROOT, 'src/io/anvil.js')).href)
const nbt = await import(pathToFileURL(path.join(ROOT, 'src/io/nbt.js')).href)
const wio = await import(pathToFileURL(path.join(ROOT, 'src/io/world-io.js')).href)

const secIdx = (x, y, z) => (y << 8) | (z << 4) | x

// chunk (0,0)：y=64 以下填石头，y=64 草，y=65 空气
const palette = [{ Name: 'minecraft:air' }, { Name: 'minecraft:stone' }, { Name: 'minecraft:dirt' }, { Name: 'minecraft:grass_block' }]
const indices = new Uint16Array(4096)
for (let i = 0; i < 4096; i++) {
  const ly = i >> 8
  indices[i] = ly === 0 ? 3 : ly <= 2 ? 2 : ly <= 5 ? 1 : 0
}
const section = {
  Y: 4,   // 绝对 Y = 64
  block_states: { palette, data: anvil.packBlockStates(indices, anvil.bitsForPalette(palette.length)) },
  biomes: { palette: ['minecraft:plains'] },
}
const chunkRoot = {
  DataVersion: 3465, xPos: 0, zPos: 0, Status: 'minecraft:full',
  sections: [section],
  block_entities: [{ id: 'minecraft:chest', x: 2, y: 65, z: 2 }],
  InhabitedTime: 999n,
  Heightmaps: { MOTION_BLOCKING: new BigInt64Array([7n, 8n]) },
}
const chunkBytes = await anvil.serializeChunkNbt(wio.serializeNbtRoot(chunkRoot, ''))
const mcaOriginal = anvil.writeRegion(null, new Map([['0,0', chunkBytes]]))
fs.writeFileSync(path.join(REGION_DIR, 'r.0.0.mca'), mcaOriginal)

// level.dat：一个 gzip NBT，含 Data.LevelName
const levelNbt = wio.serializeNbtRoot({
  Data: {
    LevelName: '探针测试世界',
    DataVersion: 3465,
    Version: { Name: '1.20.1', Id: 3465 },
    SpawnX: 8, SpawnY: 70, SpawnZ: 8,
    LastPlayed: 1700000000000,
  },
}, '')
fs.writeFileSync(path.join(SAVE_DIR, 'level.dat'), await nbt.gzipBytes(levelNbt))

console.log(`\n假存档：${SAVE_DIR}`)
console.log(`  level.dat  ${fs.statSync(path.join(SAVE_DIR, 'level.dat')).size} bytes`)
console.log(`  r.0.0.mca  ${mcaOriginal.length} bytes\n`)

// ── 启动真实 Electron ──
// 自动挑最新的 releaseN 目录（release/ 本身被一个删不掉的 default_app.asar 占着，
// 硬写死目录名会在下次重新打包时失效）。
const RELEASE_DIRS = fs.readdirSync(ROOT)
  .filter((f) => /^release\d*$/.test(f) && fs.existsSync(path.join(ROOT, f, 'win-unpacked')))
  .sort((a, b) => fs.statSync(path.join(ROOT, b)).mtimeMs - fs.statSync(path.join(ROOT, a)).mtimeMs)
if (!RELEASE_DIRS.length) {
  console.log('找不到任何 release*/win-unpacked，跳过端到端（先跑 npm run dist）')
  process.exit(0)
}
const REL = RELEASE_DIRS[0]
const UNPACKED = path.join(ROOT, REL, 'win-unpacked')
const EXE = path.join(UNPACKED, fs.readdirSync(UNPACKED).find((f) => f.endsWith('.exe')))
console.log(`使用打包产物：${REL}/win-unpacked`)

const PORT = 9335
// 这三个变量必须清掉，尤其是 ELECTRON_RUN_AS_NODE：
// 当前 shell 里它就是 1（WorkBuddy 环境注入的），会让 electron.exe 退化成普通 Node，
// 于是 Chromium 的命令行开关全被当成「bad option」拒掉，调试端口根本不会开。
// 症状是「连不上 127.0.0.1:PORT」，很容易误判成打包产物坏了。
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
delete env.WORKBUDDY_NODE_ENV
// Chromium 也会读代理环境变量；让它走代理去连自己的调试端口没道理，一并清掉。
delete env.HTTP_PROXY
delete env.HTTPS_PROXY
delete env.http_proxy
delete env.https_proxy
env.NO_PROXY = '127.0.0.1,localhost,::1'
env.no_proxy = env.NO_PROXY

// ── 先清掉上一轮残留的实例 ──
// 这个应用有 requestSingleInstanceLock：只要还有一个实例活着，
// 新起的那个会直接 app.quit() 并以 code 0 退出 —— 而 Chromium 在退出前
// 已经打印过 "DevTools listening on ws://127.0.0.1:9335"。
// 于是现象是「stderr 说在监听，探针却永远连不上（ECONNREFUSED）」，
// 极容易误判成打包产物坏了或代理问题。
// 每次跑之前主动清场，并等端口真正空出来。
async function killStaleInstances() {
  const exeName = path.basename(EXE)
  if (process.platform === 'win32') {
    await new Promise((r) => {
      spawn('taskkill', ['/F', '/IM', exeName, '/T'], { stdio: 'ignore' }).on('exit', r).on('error', r)
    })
  } else {
    await new Promise((r) => {
      spawn('pkill', ['-f', exeName], { stdio: 'ignore' }).on('exit', r).on('error', r)
    })
  }
}

async function waitPortFree(port, timeoutMs = 10000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
      await new Promise((r) => setTimeout(r, 400))   // 还活着，继续等
    } catch { return true }                          // 连不上 = 端口空了
  }
  return false
}

console.log('清理残留实例…')
await killStaleInstances()
await new Promise((r) => setTimeout(r, 1200))   // 给系统回收锁文件和端口的时间
const freed = await waitPortFree(PORT)
console.log(freed ? `端口 ${PORT} 已空出\n` : `警告：端口 ${PORT} 仍被占用，可能会失败\n`)

const child = spawn(EXE, [
  `--remote-debugging-port=${PORT}`,
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
], { cwd: path.dirname(EXE), stdio: ['ignore', 'pipe', 'pipe'], env })

// 留着 stderr —— 启动失败时它会直接说出原因（比如 bad option），
// 用 stdio:'ignore' 就只剩一句没头没脑的「fetch failed」，白白多花一轮排查。
let childErr = ''
child.stderr.on('data', (d) => { childErr += d.toString() })

/**
 * 等调试端点真的起来，而不是盲睡固定秒数。
 * 固定 sleep 有两个坑：睡短了偶发失败（表现为 fetch failed，看起来像产物坏了），
 * 睡长了每次跑都白等。这里轮询到端口可连为止，最多 30 秒。
 */
async function waitForDevtools(port, timeoutMs = 30000) {
  const t0 = Date.now()
  let lastErr = null
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return true
      lastErr = `HTTP ${r.status}`
    } catch (e) { lastErr = `${e.message}${e.cause?.code ? ' / ' + e.cause.code : ''}` }
    await new Promise((r) => setTimeout(r, 600))
  }
  // 把真正的失败原因带出来 —— 上一轮的「fetch failed」什么都没说明，白烧一小时。
  console.log(`  最后错误：${lastErr}`)
  return false
}

const devtoolsUp = await waitForDevtools(PORT)
if (!devtoolsUp) {
  console.log('调试端口 30 秒内没起来，跳过端到端')
  if (childErr.trim()) console.log(`\n-- 子进程 stderr --\n${childErr.trim().slice(0, 1200)}\n`)
  await killStaleInstances()
  process.exit(1)
}
await new Promise((r) => setTimeout(r, 3000))   // 再给页面一点时间完成首屏

try {
  const b = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
  const pages = await b.pages()
  const p = pages.find((x) => !x.url().startsWith('devtools://')) || pages[0]
  await p.waitForFunction(() => window.__MC_EDITOR__, { timeout: 25000, polling: 300 })
  await new Promise((r) => setTimeout(r, 2500))

  // 1. preload 暴露了 world API
  const api = await p.evaluate(() => {
    const w = window.desktop?.world
    return w ? Object.keys(w) : null
  })
  check('preload 暴露了 world API', Array.isArray(api) && api.length >= 8, api ? api.join(',') : 'null')

  // 2. 列维度
  const dims = await p.evaluate((d) => window.desktop.world.listDimensions(d), SAVE_DIR)
  check('能列出存档维度', dims.dims?.some((x) => x.id === 'overworld'), JSON.stringify(dims.dims))

  // 3. 读 level.dat（二进制过 IPC）
  //    长度必须在页面内取：返回值跨 evaluate 会被 JSON 序列化，
  //    Uint8Array 到这边变成 {0:..,1:..}，.length 是 undefined。
  const ld = await p.evaluate(async (d) => {
    const r = await window.desktop.world.readLevelDat(d)
    return {
      ok: r.ok,
      error: r.error || null,
      // 二进制是否原样到达：只看是不是「可按字节索引的对象」，不看长度
      byteLength: r.ok ? r.data.length ?? Object.keys(r.data).length : 0,
      isBinary: typeof r.data === 'object' && r.data !== null && !(typeof r.data === 'string'),
      // 反向对照：如果 IPC 把它当 UTF-8 字符串处理过，前两位不会是 gzip 魔数 1f 8b
      magic: r.ok ? `${r.data[0]?.toString(16)} ${r.data[1]?.toString(16)}` : '',
    }
  }, SAVE_DIR)
  check('level.dat 读回成功', ld.ok === true, ld.ok ? `${ld.byteLength} bytes` : ld.error)
  check('读回的是二进制不是字符串', ld.isBinary === true, `typeof=${typeof ld}`)
  check('二进制未被 UTF-8 破坏（gzip 魔数 1f 8b）', ld.magic === '1f 8b', `魔数=${ld.magic || '无'}`)

  // 4. 读 region 原始字节
  const rr = await p.evaluate(async (d) => {
    const r = await window.desktop.world.readRegion(d, '', 0, 0)
    return {
      ok: r.ok, error: r.error || null,
      byteLength: r.ok ? (r.data.length ?? Object.keys(r.data).length) : 0,
    }
  }, SAVE_DIR)
  check('region 读回成功', rr.ok && rr.byteLength > 0, rr.ok ? `${rr.byteLength} bytes` : rr.error)
  check('region 长度与原文件一致', rr.byteLength === mcaOriginal.length,
    `${rr.byteLength} vs ${mcaOriginal.length}`)

  // 5. 走完整的「读进编辑器」路径
  //    注意这里**不能** import('/src/io/world-io.js')：那是开发服务器的路径，
  //    打包产物走 file:// 时会解析成 file:///D:/src/io/world-io.js 直接 404。
  //    改用 app.__test__.loadWorldSaveModules() 这个生产构建下也存在的入口。
  const imported = await p.evaluate(async ({ dir }) => {
    const { worldIo } = await window.__MC_EDITOR__.__test__.loadWorldSaveModules()
    const { world, report } = await worldIo.importWorldWindow({
      readRegion: async (rx, rz) => {
        const r = await window.desktop.world.readRegion(dir, '', rx, rz)
        return r.ok ? r.data : null
      },
      minChunkX: 0, minChunkZ: 0, chunksX: 1, chunksZ: 1, minY: 64, height: 16,
    })
    return { solid: world.stats().solid, size: [world.width, world.height, world.depth], report: report.format }
  }, { dir: SAVE_DIR })
  check('能从存档读出地形', imported.solid > 0, `${imported.solid} 格，格式=${imported.report}`)

  // 6. 写回：把整个 chunk 铺成石头，然后验证磁盘上的文件真的变了
  const before = fs.readFileSync(path.join(REGION_DIR, 'r.0.0.mca'))

  const writeResult = await p.evaluate(async ({ dir, beforeArr }) => {
    const before = new Uint8Array(beforeArr)
    const { anvil, worldIo: wio, voxelWorld, blocks } = await window.__MC_EDITOR__.__test__.loadWorldSaveModules()
    const { VoxelWorld } = voxelWorld
    const { BLOCK_BY_NAME } = blocks

    // 造一个全石头的世界
    const w = new VoxelWorld(16, 16, 16)
    const stone = BLOCK_BY_NAME.get('stone').id
    for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) w.set(x, y, z, stone)

    const regionCache = new Map()
    const readChunk = async (cx, cz) => {
      const rx = Math.floor(cx / 32), rz = Math.floor(cz / 32)
      const lcx = ((cx % 32) + 32) % 32, lcz = ((cz % 32) + 32) % 32
      const r = await window.desktop.world.readRegion(dir, '', rx, rz)
      if (!r.ok || !r.data) return null
      const e = anvil.parseRegion(r.data).find((x) => x.cx === lcx && x.cz === lcz)
      if (!e?.raw) return null
      const n = await anvil.readChunkNbt(e)
      return { root: n.root, rootName: n.rootName }
    }

    const repl = await wio.buildChunkReplacements({
      world: w, region: { x1: 0, y1: 0, z1: 0, x2: 15, y2: 15, z2: 15 },
      minChunkX: 0, minChunkZ: 0, minY: 64, readChunk,
    })
    const out = anvil.writeRegion(before, repl)
    const res = await window.desktop.world.writeRegion(dir, '', 0, 0, out)
    return { ok: res.ok, backupPath: res.backupPath, chunks: repl.size, error: res.error }
  }, { dir: SAVE_DIR, beforeArr: Array.from(before) })

  check('写回 IPC 成功', writeResult.ok === true, writeResult.ok ? `${writeResult.chunks} 个区块` : writeResult.error)
  check('自动创建了备份', Boolean(writeResult.backupPath), writeResult.backupPath || '（无）')

  // 7. 磁盘上的文件真的变了
  const after = fs.readFileSync(path.join(REGION_DIR, 'r.0.0.mca'))
  check('磁盘文件内容已改变', !before.equals(after), `${before.length} → ${after.length} bytes`)

  // 8. 备份内容 === 原始内容（这是「能回退」的唯一凭据）
  if (writeResult.backupPath) {
    const backup = fs.readFileSync(writeResult.backupPath)
    check('备份内容与写前完全一致', before.equals(backup), `${backup.length} bytes`)
  } else {
    check('备份内容与写前完全一致', false, '没有备份文件')
  }

  // 9. 写回的 chunk 能重新解析，且方块变成石头
  const reparsed = await p.evaluate(async ({ dir }) => {
    const { anvil } = await window.__MC_EDITOR__.__test__.loadWorldSaveModules()
    const r = await window.desktop.world.readRegion(dir, '', 0, 0)
    const e = anvil.parseRegion(r.data)[0]
    const n = await anvil.readChunkNbt(e)
    const bs = n.root.sections.find((s) => s.Y === 4).block_states
    const { indices, palette } = anvil.readSectionIndices(bs)
    // 采样几个点
    const samples = [0, 1, 255, 256, 4095].map((i) => palette[indices[i]]?.Name)
    return {
      samples,
      palette: bs.palette.map((x) => x.Name),
      keptEntities: n.root.block_entities?.length ?? -1,
      keptTime: String(n.root.InhabitedTime),
      keptStatus: n.root.Status,
    }
  }, { dir: SAVE_DIR })

  check('写回后 y=4 section 全是石头', reparsed.samples.every((s) => s === 'minecraft:stone'), reparsed.samples.join(','))
  check('箱子等方块实体没丢', reparsed.keptEntities === 1, `block_entities=${reparsed.keptEntities}`)
  check('InhabitedTime（bigint）没丢', reparsed.keptTime === '999', reparsed.keptTime)
  check('Status 没丢', reparsed.keptStatus === 'minecraft:full', reparsed.keptStatus)

  await b.disconnect()
} catch (err) {
  check('端到端流程未抛异常', false, err.message)
  // 启动失败时把子进程的 stderr 打出来 —— 否则只有一句 fetch failed，无法定位
  if (childErr.trim()) console.log(`\n-- 子进程 stderr --\n${childErr.trim().slice(0, 1200)}\n`)
} finally {
  // 这里必须用 taskkill 而不是 child.kill()：Electron 是「主进程 + 若干子进程」，
  // kill() 只杀最外层，剩下的渲染进程会带着 single-instance 锁继续活着，
  // 下一次再跑探针就会被锁挡掉（表现为秒退 code 0）。/T 连子孙一起收。
  await killStaleInstances()
  try { fs.rmSync(SAVE_DIR, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
}

console.log(`\n结果：${fail === 0 ? '全部通过' : '有失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)
