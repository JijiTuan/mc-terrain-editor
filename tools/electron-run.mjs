/**
 * tools/electron-run.mjs — 启动 Electron，并清掉会把它降级成纯 Node 的环境变量
 *
 * ── 为什么需要这个文件 ──
 * 如果环境里存在 ELECTRON_RUN_AS_NODE=1，electron.exe 会退化成普通 Node 进程：
 *   - process.type 变成 undefined（正常应为 'browser'）
 *   - require('electron').app / ipcMain 全是 undefined
 *   - 主进程第一个 ipcMain.handle(...) 就抛 TypeError
 * 这个变量常见于「用 Electron 当 Node 脚本运行器」的场景（CI、IDE 集成、CLI 工具内部），
 * 一旦被带到当前 shell，开发者看到的是「Electron 装坏了」的假象，实际代码没有任何问题。
 *
 * 所以启动前显式删掉它，而不是让每个使用者自己记得 unset。
 * 同时删掉 NODE_OPTIONS —— 有些环境的 NODE_OPTIONS 会注入了额外的 --require 脚本
 * （比如打包工具的 shim），注入到 Electron 主进程里会引发难以定位的副作用。
 *
 * 用法：
 *   node tools/electron-run.mjs             → 加载当前目录（dist 产物）
 *   node tools/electron-run.mjs --dev       → 连本地 Vite dev server
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import net from 'node:net'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.MC_EDITOR_PORT || 5173)
const DEV = process.argv.includes('--dev')

const electronBin = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)

if (!existsSync(electronBin)) {
  console.error(`[electron] 找不到可执行文件：${electronBin}`)
  console.error('[electron] 请先运行 npm install（Electron 的二进制走 .npmrc 里的镜像下载）')
  process.exit(1)
}

/** 复制一份环境变量，逐一剔除会让 Electron 行为跑偏的项 */
function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  delete env.WORKBUDDY_NODE_ENV
  if (DEV) {
    env.MC_EDITOR_DEV_SERVER = `http://127.0.0.1:${PORT}`
  } else {
    delete env.MC_EDITOR_DEV_SERVER
  }
  return env
}

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => { sock.destroy(); resolve(false) })
    setTimeout(() => { sock.destroy(); resolve(false) }, 1500)
  })
}

if (DEV) {
  if (!(await portInUse(PORT))) {
    console.error(`[electron] --dev 需要先起好 Vite：npm run dev（期望端口 ${PORT}）`)
    process.exit(1)
  }
  console.log(`[electron] dev 模式，devServer = http://127.0.0.1:${PORT}`)
} else {
  const indexPath = path.join(ROOT, 'dist', 'index.html')
  if (!existsSync(indexPath)) {
    console.error('[electron] 未找到 dist/index.html，请先运行 npm run build')
    process.exit(1)
  }
}

/**
 * GPU 相关开关。
 *
 * 为什么默认带 SwiftShader 兜底：
 * 某些机器/沙箱里 Electron 的 GPU 进程会直接崩，日志长这样 ——
 *   ERROR:gpu_process_host.cc  GPU process exited unexpectedly: exit_code=-1073741819
 *   FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
 * -1073741819 是 0xC0000005（访问违例），通常是驱动或显卡被虚拟化环境挡住了。
 * 不给兜底的话现象是「窗口一闪就没」，看起来像程序本身坏了，其实是环境问题。
 *
 * --enable-unsafe-swiftshader 让 WebGL 走 CPU 软件光栅化 —— 帧率低，
 * 但至少能出画面，能验证功能。想要真 GPU 加速时用 --gpu 关掉这些开关。
 */
const GPU_FALLBACK_ARGS = process.argv.includes('--gpu')
  ? []
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']

const child = spawn(electronBin, ['.', ...GPU_FALLBACK_ARGS], {
  cwd: ROOT,
  stdio: 'inherit',
  env: cleanEnv(),
})

child.on('close', (code) => process.exit(code ?? 0))
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { child.kill(); process.exit(0) })
}
