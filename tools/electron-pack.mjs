/**
 * tools/electron-pack.mjs — 打包 Windows 桌面版
 *
 * ── 为什么不能直接用 electron-builder 的默认流程 ──
 * 默认流程是：
 *   1. 从缓存取出 electron-v{ver}-win32-x64.zip
 *   2. 解压到 <out>/win-unpacked.tmp
 *   3. fs.rename('.tmp' → 'win-unpacked')
 *
 * 第 3 步在本机稳定报 EPERM。已实测复现并定位到触发条件：
 *   - 纯文件目录（哪怕 400 个文件）rename → 成功
 *   - 含子目录的目录（哪怕只有 10 个子目录）rename → EPERM
 *   - 关掉沙箱、清空 NODE_OPTIONS 后依旧 EPERM
 * 所以是本机文件系统对「非空且有子目录的目录 rename」的拦截，与打包配置无关。
 *
 * ── 绕法 ──
 * 自己把 zip 解压成一个 **Electron 运行时目录**，然后通过 `electronDist` 把它交给
 * electron-builder。builder 拿到 electronDist 就不会再去解压缓存 zip，
 * 也就不会走那个会 EPERM 的 rename，其余流程（写 app.asar、NSIS、portable）完全正常。
 *
 * 注意不能用 `--prepackaged`：那个选项的语义是「整个 app 目录都已封装完毕」，
 * builder 会重建 resources/ 并按 projectDir 的 files 规则重新收集文件，
 * 结果是我们塞进去的 resources/app 被清空、default_app.asar 又被恢复 —— 实测如此。
 * `electronDist` 才是「只替换运行时而保留正常打包流程」的正确开关。
 *
 * 用法：
 *   node tools/electron-pack.mjs          → 打 NSIS 安装包 + 便携版
 *   node tools/electron-pack.mjs --dir    → 只出解包目录（快速验证）
 */

import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR_ONLY = process.argv.includes('--dir')

const isWin = process.platform === 'win32'
const exe = (n) => (isWin ? `${n}.cmd` : n)

/** 干净环境：见 tools/electron-run.mjs 里的说明 */
function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.WORKBUDDY_NODE_ENV
  env.ELECTRON_MIRROR = env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/'
  env.ELECTRON_BUILDER_BINARIES_MIRROR =
    env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'
  return env
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, env: baseEnv(), ...opts })
  if (r.status !== 0) {
    console.error(`[pack] 命令失败：${cmd} ${args.join(' ')}（exit ${r.status}）`)
    process.exit(r.status ?? 1)
  }
}

function electronVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version
}

/** Electron 的 zip 缓存：@electron/get 用下载 url 的 sha256 做目录名，所以要遍历找 */
function findElectronZip(version) {
  const plat = isWin ? 'win32' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const name = `electron-v${version}-${plat}-${arch}.zip`
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'electron', 'Cache'
  )
  if (!fs.existsSync(cacheRoot)) return null
  for (const sub of fs.readdirSync(cacheRoot)) {
    const candidate = path.join(cacheRoot, sub, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 找一个能解 zip 的工具（Windows 10+ 自带 bsdtar，多数环境 unzip 也有） */
function pickUnzip() {
  const candidates = [
    { cmd: 'unzip', args: ['-q', '-o'] },
    { cmd: 'tar', args: ['-xf'] },
    { cmd: path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe'), args: ['x', '-y'] },
  ]
  for (const c of candidates) {
    const probe = spawnSync(c.cmd, c.args.includes('-xf') ? ['--version'] : ['--help'], { stdio: 'ignore' })
    if (!probe.error) return c
  }
  return null
}

/**
 * 挑一个可用的输出目录。
 *
 * 某些环境会拦截含子目录的递归删除（本机 safe-delete 即如此），上一次打包留下的
 * release/ 就删不掉了。硬碰硬没意义 —— 换一个带序号的目录继续，最后把实际用的
 * 目录名打印出来。比要求用户先手动清理要好用，也不会被一个删不掉的旧目录卡住。
 */
function pickOutDir() {
  const base = process.env.MC_PACK_OUT || 'release'
  // 候选范围给宽一点：自动化环境里旧产物可能因为文件锁 / 删除拦截而清不掉，
  // 每打一次就占掉一个序号，范围太窄会很快用尽。
  const candidates = [base, ...Array.from({ length: 20 }, (_, i) => `${base}${i + 2}`)]
  for (const c of candidates) {
    const full = path.join(ROOT, c)
    if (!fs.existsSync(full)) return c
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 2 })
      return c
    } catch {
      console.warn(`[pack] ${c}/ 已存在且无法清除，换下一个候选目录`)
    }
  }
  console.error(`[pack] ${base} 及其序号变体都无法使用，请手动清理后再打包`)
  process.exit(1)
}

const OUT_DIR = pickOutDir()
const version = electronVersion()
console.log(`[pack] electron ${version} → 输出目录 ${OUT_DIR}/`)

// ============ 1. 准备 Electron 运行时目录（供 electronDist 使用）============
// 解压到打包产物之外的一个独立目录，避免被当成打包输出而遭清理。
// 放在 node_modules/.cache 下，不进 git，也和源码隔离。

const runtimeDir = path.join(ROOT, 'node_modules', '.cache', 'mc-electron-dist', `${version}-${process.arch}`)
if (fs.existsSync(runtimeDir) && fs.existsSync(path.join(runtimeDir, isWin ? 'electron.exe' : 'electron'))) {
  console.log('[pack] 复用已解压的 Electron 运行时')
} else {
  const zip = findElectronZip(version)
  if (!zip) {
    console.error(`[pack] 找不到缓存的 ${version} zip。请先运行一次 npm install，让 Electron 下载二进制。`)
    process.exit(1)
  }
  console.log(`[pack] 解压 ${path.basename(zip)}（${(fs.statSync(zip).size / 1048576).toFixed(1)} MB）`)
  fs.mkdirSync(runtimeDir, { recursive: true })

  const uz = pickUnzip()
  if (!uz) {
    console.error('[pack] 找不到可用的解压工具（unzip / tar / 7z 都没有）')
    process.exit(1)
  }
  run(uz.cmd, [...uz.args, zip], { cwd: runtimeDir })

  // zip 若带顶层目录则上提一层，保证 electron.exe 直接在根上
  const entries = fs.readdirSync(runtimeDir)
  if (entries.length === 1 && fs.statSync(path.join(runtimeDir, entries[0])).isDirectory()) {
    const inner = path.join(runtimeDir, entries[0])
    console.log(`[pack] zip 内含顶层目录 ${entries[0]}，内容上提一层`)
    for (const f of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, f), path.join(runtimeDir, f))
    }
    fs.rmdirSync(inner)
  }
}

const exePath = path.join(runtimeDir, isWin ? 'electron.exe' : 'electron')
if (!fs.existsSync(exePath)) {
  console.error(`[pack] Electron 运行时目录不完整，找不到 ${exePath}`)
  console.error('[pack] 实际内容：', fs.readdirSync(runtimeDir).slice(0, 20).join(', '))
  process.exit(1)
}
console.log('[pack] Electron 运行时已就绪')

// ============ 2. 交给 electron-builder ============
// electronDist 指向已解压运行时 → builder 跳过「解压缓存 zip + rename」那一步。
// 其余流程照旧：按 package.json 的 build.files 收集源码、打 app.asar、出 NSIS / portable。

const builderBin = path.join(ROOT, 'node_modules', '.bin', exe('electron-builder'))
const args = ['--win']
if (DIR_ONLY) args.push('--dir')
args.push(`--config.directories.output=${OUT_DIR}`)
args.push(`--config.electronDist=${runtimeDir}`)

console.log(`[pack] electron-builder ${args.join(' ')}`)
const child = spawn(builderBin, args, { cwd: ROOT, stdio: 'inherit', shell: isWin, env: baseEnv() })
child.on('close', (code) => {
  const outFull = path.join(ROOT, OUT_DIR)
  if (code === 0) {
    console.log(`\n[pack] 完成。产物在 ${OUT_DIR}/`)
    const artifacts = fs.existsSync(outFull)
      ? fs.readdirSync(outFull).filter((f) => !f.startsWith('win-'))
      : []
    for (const a of artifacts) {
      const st = fs.statSync(path.join(outFull, a))
      console.log(`  ${a}  (${(st.size / 1048576).toFixed(1)} MB)`)
    }
    console.log(`  解包目录：${OUT_DIR}/win-unpacked/`)
  }
  process.exit(code ?? 0)
})
