/**
 * tools/electron-dev.mjs — 开发模式下同时起 Vite 和 Electron
 *
 * 为什么不用 cross-env + shell 变量：Windows 上给子进程设环境变量在各 shell 里写法不同，
 * 多装一个依赖只为了传一个变量不划算。这里用 Node 直接 spawn，环境变量显式传，
 * 两个平台都是同一份代码，也顺便能等到 Vite 真正监听起来再拉起 Electron ——
 * 否则 Electron 会先加载到一个空白的 localhost 页面。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.MC_EDITOR_PORT || 5173)
const DEV_SERVER = `http://127.0.0.1:${PORT}`

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const electronBin = path.join(
  ROOT,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)

/**
 * 环境变量要洗干净再传下去。
 * ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node，主进程直接崩在第一个 ipcMain.handle；
 * NODE_OPTIONS 里若有额外 --require 也会被注入到 Electron 主进程。这两项都不是应用该管的事，
 * 但对 Electron 是致命的，所以显式删掉。
 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.WORKBUDDY_NODE_ENV
  return env
}

/** 探测端口是否已被占用 —— 已经有 dev server 在跑时就不重复起一个 */
function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    // 有些环境连接会悬着，给个上限避免卡死启动流程
    setTimeout(() => { sock.destroy(); resolve(false) }, 1500)
  })
}

/** 轮询等 dev server 就绪，最多等 30 秒 */
async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portInUse(port)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

let vite = null

if (await portInUse(PORT)) {
  console.log(`[dev] 检测到 ${DEV_SERVER} 已在运行，直接复用它`)
} else {
  console.log(`[dev] 启动 Vite …`)
  vite = spawn(npx, ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: cleanEnv(),
  })
  const ready = await waitForServer(PORT)
  if (!ready) {
    console.error(`[dev] Vite 在 30 秒内没有监听到 ${PORT}，放弃启动 Electron`)
    vite?.kill()
    process.exit(1)
  }
}

console.log(`[dev] 启动 Electron，devServer = ${DEV_SERVER}`)
const electron = spawn(electronBin, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: cleanEnv({ MC_EDITOR_DEV_SERVER: DEV_SERVER }),
})

electron.on('close', (code) => {
  // Electron 关掉就意味着开发者结束调试了，顺带把 Vite 也收掉，不留孤儿进程
  vite?.kill()
  process.exit(code ?? 0)
})

// Ctrl+C 时两边都要停，否则 Vite 会一直占着端口
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    electron.kill()
    vite?.kill()
    process.exit(0)
  })
}
