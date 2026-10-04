/**
 * electron/main.js — 桌面版主进程
 *
 * ── 职责边界 ──
 * 主进程只做「浏览器做不到的事」：
 *   1. 开窗口、管生命周期
 *   2. 原生文件夹对话框（外部对话桥用）—— 网页版的 showDirectoryPicker
 *      在 Electron 里虽然也能用，但拿不到持久化权限，每次启动都要重选，
 *      而且用户根本分不清它选的是哪个目录。换成原生对话框 + 记住路径才是桌面版该有的样子。
 *   3. 把渲染进程的文件请求转发成主进程 fs 操作（唯一通道是 IPC）
 *
 * 编辑逻辑一行都不在这里 —— 全部在 src/ 里，由渲染进程加载。
 * 这样网页版和桌面版共用同一套编辑器内核，只是外壳不同。
 *
 * 用 CommonJS 写（package.json 是 "type": "module"，所以扩展名用 .cjs）：
 * Electron 主进程对 ESM 的支持要配合 `"main"` 里显式 .mjs 走 `--experimental`，
 * 在打包场景下容易出岔子，CJS 是稳的选择。
 */

const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const ROOT = path.resolve(__dirname, '..')

/**
 * 必须在任何 app.getPath('userData') 之前定死应用名。
 *
 * 未打包直接跑时，Electron 默认拿 package.json 的 name（或直接叫 "Electron"），
 * 于是用户设置会落到 AppData\Roaming\Electron\settings.json；
 * 打包后产品名变成「Minecraft 地形编辑器」，userData 又换到另一个目录 ——
 * 结果是「开发时记住的桥接目录，装成正式版后就丢了」。
 * 显式设一个跟打包配置对齐的名字，两个环境下路径一致。
 */
app.setName('mc-terrain-editor')

/** Vite 构建产物目录。桌面版以它为「站点根」，用 file:// 直接加载，不需要起 HTTP 服务 */
const DIST_DIR = path.join(ROOT, 'dist')

/**
 * 开发模式下加载 devServer，否则加载 dist。
 * 用环境变量而不是命令行参数，是为了让 `npm run dev` / `npm run electron:dev` 分开控制：
 * 改代码时两个终端各跑一个，谁都不需要为了另一个改参数。
 */
const DEV_SERVER = process.env.MC_EDITOR_DEV_SERVER || ''
const IS_DEV = Boolean(DEV_SERVER)

/** 外部对话桥的目录（用户选了「记住并自动重连」，所以要落盘） */
let settingsPath = ''
let settings = { bridgeDir: null }
let settingsLoaded = false

/**
 * 读设置。
 * 用 settingsLoaded 做幂等：这个方法既可能在 app ready 时调，也可能被某个 IPC
 * 在更早的时机间接触发，重复读一次的成本很低，但「读到一半」的状态会导致
 * 用户设置忽有忽无。loadSettings 内部并发调用也只会真的读一次。
 */
let settingsLoading = null
async function loadSettings() {
  if (settingsLoaded) return
  if (settingsLoading) return settingsLoading
  settingsLoading = (async () => {
    // userData 目录在 ready 前不一定存在，先确保路径可用
    settingsPath = path.join(app.getPath('userData'), 'settings.json')
    try {
      settings = JSON.parse(await fsp.readFile(settingsPath, 'utf8'))
    } catch {
      // 首次启动没有这个文件，属于正常情况，不是错误
      settings = { bridgeDir: null }
    }
    settingsLoaded = true
  })()
  return settingsLoading
}

async function saveSettings() {
  try {
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true })
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8')
  } catch (err) {
    console.warn('[settings] 写入失败', err)
  }
}

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#0b0f16',
    // 首帧渲染完再显示，避免白屏闪一下
    show: false,
    autoHideMenuBar: true,
    title: 'Minecraft 地形编辑器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 体素编辑是纯 CPU 重活，后台节流会让切回来时卡一下
      backgroundThrottling: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (IS_DEV) {
    mainWindow.loadURL(DEV_SERVER)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    const indexPath = path.join(DIST_DIR, 'index.html')
    if (!fs.existsSync(indexPath)) {
      dialog.showErrorBox(
        '找不到构建产物',
        `未找到 ${indexPath}\n\n请先运行 npm run build 生成 dist/，再启动桌面版。`
      )
      app.quit()
      return
    }
    mainWindow.loadFile(indexPath)
  }

  // 别让页面里的链接把整个应用窗口导航走 —— 外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const isDevUrl = IS_DEV && url.startsWith(DEV_SERVER)
    const isFileUrl = url.startsWith('file://')
    if (!isDevUrl && !isFileUrl) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ============ IPC：Minecraft 存档读写 ============
//
// 存档是**二进制**（.mca / level.dat），不能复用上面那套 writeFile(text) —— 
// 那套按 UTF-8 转字符串，二进制会在这一步被破坏，而且是静默破坏：
// 写出来的文件看起来正常，游戏一读就崩。
// 所以下面这几个 handler 全程走 Buffer / Uint8Array，不经过任何编码转换。

/** 猜 .minecraft 目录的默认位置，作为对话框的起始路径 */
function guessMinecraftDir() {
  const os = require('os')
  const home = os.homedir()
  const candidates = [
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft', 'saves'),
    path.join(home, 'AppData', 'Roaming', '.minecraft', 'saves'),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ }
  }
  return home
}

/**
 * 让用户挑一个存档目录。
 * 返回存档信息（名字、版本、可用维度），并记住路径供下次直接打开。
 */
ipcMain.handle('world:pickSave', async () => {
  await loadSettings()
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    title: '选择 Minecraft 存档',
    message: '选择 saves 目录下的某个世界文件夹（里面有 level.dat 的那个）',
    defaultPath: settings.mcSavesDir || guessMinecraftDir(),
    properties: ['openDirectory'],
    buttonLabel: '打开存档',
  })
  if (result.canceled || !result.filePaths?.length) return { canceled: true }

  const dir = result.filePaths[0]
  if (!fs.existsSync(path.join(dir, 'level.dat'))) {
    return {
      canceled: false,
      error: `这个文件夹里没有 level.dat，看起来不是 Minecraft 存档。\n\n选中的是：${dir}\n\n应该选 saves 里面那个世界文件夹本身。`,
    }
  }

  settings.mcSavesDir = dir
  await saveSettings()
  return { canceled: false, dir }
})

/** 上次打开的存档，用于启动时提示「继续编辑」 */
ipcMain.handle('world:savedSave', async () => {
  await loadSettings()
  const dir = settings.mcSavesDir
  if (!dir) return { dir: null, valid: false }
  try {
    const st = await fsp.stat(dir)
    return { dir, valid: st.isDirectory() && fs.existsSync(path.join(dir, 'level.dat')) }
  } catch {
    return { dir, valid: false }
  }
})

ipcMain.handle('world:forgetSave', async () => {
  await loadSettings()
  settings.mcSavesDir = null
  await saveSettings()
  return { ok: true }
})

/**
 * 列出存档里的可用维度。
 * 主世界在 region/，下界在 DIM-1/region/，末地在 DIM1/region/。
 */
ipcMain.handle('world:listDimensions', async (_e, { dir }) => {
  const dims = []
  const specs = [
    { id: 'overworld', label: '主世界', sub: '' },
    { id: 'nether', label: '下界', sub: 'DIM-1' },
    { id: 'end', label: '末地', sub: 'DIM1' },
  ]
  for (const s of specs) {
    const regionDir = path.join(dir, s.sub, 'region')
    try {
      const files = await fsp.readdir(regionDir)
      const mca = files.filter((f) => f.endsWith('.mca'))
      if (mca.length) dims.push({ id: s.id, label: s.label, sub: s.sub, regionCount: mca.length })
    } catch { /* 该维度不存在 */ }
  }
  return { dims }
})

/** 读 level.dat（二进制） */
ipcMain.handle('world:readLevelDat', async (_e, { dir }) => {
  try {
    const buf = await fsp.readFile(path.join(dir, 'level.dat'))
    return { ok: true, data: new Uint8Array(buf) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

/**
 * 列出某个维度里所有 region 文件的坐标。
 * 返回 [rx, rz] 列表，渲染进程据此算「存档有多大、能编辑哪些块」。
 */
ipcMain.handle('world:listRegions', async (_e, { dir, sub = '' }) => {
  const regionDir = path.join(dir, sub, 'region')
  try {
    const files = await fsp.readdir(regionDir)
    const out = []
    for (const f of files) {
      const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(f)
      if (m) out.push([Number(m[1]), Number(m[2])])
    }
    return { ok: true, regions: out }
  } catch (err) {
    return { ok: false, error: err.message, regions: [] }
  }
})

/** 读一个 region 文件的原始字节 */
ipcMain.handle('world:readRegion', async (_e, { dir, sub = '', rx, rz }) => {
  const p = path.join(dir, sub, 'region', `r.${rx}.${rz}.mca`)
  try {
    const buf = await fsp.readFile(p)
    return { ok: true, data: new Uint8Array(buf) }
  } catch (err) {
    // 文件不存在是正常情况（那片区域还没生成过），不当错误
    if (err.code === 'ENOENT') return { ok: true, data: null }
    return { ok: false, error: err.message, data: null }
  }
})

/**
 * 写回 region 文件。
 *
 * **关键安全措施：写之前先把原文件备份成 .mca.bak-<时间戳>。**
 * 存档改写是少数几个「一旦写坏就没救」的操作，而用户不可能每次都记得
 * 自己先复制一份。备份放在同一个目录，用户想回退随时能拿回来。
 * 已有同名备份时不覆盖（保留最早的原始版本）。
 */
ipcMain.handle('world:writeRegion', async (_e, { dir, sub = '', rx, rz, data, backup = true }) => {
  const regionDir = path.join(dir, sub, 'region')
  const target = path.join(regionDir, `r.${rx}.${rz}.mca`)
  try {
    await fsp.mkdir(regionDir, { recursive: true })

    let backupPath = null
    if (backup && fs.existsSync(target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = `${target}.bak-${stamp}`
      await fsp.copyFile(target, backupPath)
    }

    // 先写临时文件再 rename：中途断电/崩溃也不会留下半个文件把存档毁掉
    const tmp = `${target}.tmp-${process.pid}`
    await fsp.writeFile(tmp, Buffer.from(data))
    await fsp.rename(tmp, target)

    return { ok: true, backupPath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ============ IPC：外部对话桥 ============

/**
 * 让用户选外部对话桥的目录。
 * 返回**真实路径字符串**，渲染进程侧把它当作「已连接的目录」，所有读写都走下面的 IPC。
 * 不返回句柄，是因为主进程侧本来就是按路径操作，多一层句柄抽象没有收益。
 */
ipcMain.handle('bridge:pickDir', async () => {
  await loadSettings()
  const parent = mainWindow ?? undefined
  const result = await dialog.showOpenDialog(parent, {
    title: '选择外部对话桥目录',
    message: '选择项目根目录或 .mc-editor 目录，编辑器会在其中建立 requests/ 与 responses/',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '连接',
  })
  if (result.canceled || !result.filePaths?.length) return { canceled: true }

  let dir = result.filePaths[0]
  // 用户可能选项目根目录，也可能直接选了 .mc-editor，两种都支持
  if (path.basename(dir) !== '.mc-editor') dir = path.join(dir, '.mc-editor')

  try {
    await fsp.mkdir(dir, { recursive: true })
    for (const sub of ['requests', 'responses', 'processed']) {
      await fsp.mkdir(path.join(dir, sub), { recursive: true })
    }
  } catch (err) {
    return { canceled: false, error: `无法创建目录结构：${err.message}` }
  }

  settings.bridgeDir = dir
  await saveSettings()
  return { canceled: false, dir }
})

/** 上次记住的桥接目录，用于启动时自动重连 */
ipcMain.handle('bridge:savedDir', async () => {
  await loadSettings()
  const dir = settings.bridgeDir
  if (!dir) return { dir: null, valid: false }
  try {
    const st = await fsp.stat(dir)
    return { dir, valid: st.isDirectory() }
  } catch {
    // 目录被删了或外置盘没插，如实告诉渲染进程，让它退回「请手动选择」
    return { dir, valid: false }
  }
})

ipcMain.handle('bridge:forgetDir', async () => {
  await loadSettings()
  settings.bridgeDir = null
  await saveSettings()
  return { ok: true }
})

/**
 * 读写桥接目录里的文件。
 *
 * 安全约束：只允许在已授权的 bridgeDir 内部操作，且路径不允许穿越。
 * 渲染进程理论上不会构造恶意路径，但把边界收在主进程里是这类 IPC 的基本纪律 ——
 * 一旦哪天渲染进程被执行了不可信内容（比如 AI 回复里的东西被当代码跑），越界也到不了任意路径。
 */
function resolveInside(dir, ...parts) {
  const base = path.resolve(dir)
  const target = path.resolve(base, ...parts)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`路径越界：${target}`)
  }
  return target
}

function assertBridgeDir(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('桥接目录未连接')
  return dir
}

ipcMain.handle('bridge:writeFile', async (_e, { dir, name, text }) => {
  const base = assertBridgeDir(dir)
  const file = resolveInside(base, name)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, 'utf8')
  return { ok: true }
})

ipcMain.handle('bridge:readFile', async (_e, { dir, name }) => {
  const base = assertBridgeDir(dir)
  const file = resolveInside(base, name)
  try {
    return { ok: true, text: await fsp.readFile(file, 'utf8') }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, missing: true }
    throw err
  }
})

/**
 * 列出目录里的文件（不递归）。
 * 只返回名字不返回内容 —— 内容由渲染进程按需逐个读，避免把大目录一次灌进内存。
 */
ipcMain.handle('bridge:listDir', async (_e, { dir, name }) => {
  const base = assertBridgeDir(dir)
  const target = resolveInside(base, name)
  try {
    const entries = await fsp.readdir(target, { withFileTypes: true })
    return { ok: true, files: entries.filter((e) => e.isFile()).map((e) => e.name) }
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, files: [] }
    throw err
  }
})

ipcMain.handle('bridge:mkdir', async (_e, { dir, name }) => {
  const base = assertBridgeDir(dir)
  await fsp.mkdir(resolveInside(base, name), { recursive: true })
  return { ok: true }
})

/**
 * 「归档」= 内容写到目标名 + 删掉源文件。
 * 不用 fsp.rename 是因为源和目标可能跨目录，rename 跨设备会 EXDEV 失败；
 * 这里语义上也确实是「复制后删除」。
 */
ipcMain.handle('bridge:archive', async (_e, { dir, fromName, toName, text }) => {
  const base = assertBridgeDir(dir)
  const target = resolveInside(base, toName)
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.writeFile(target, text, 'utf8')
  await fsp.rm(resolveInside(base, fromName), { force: true })
  return { ok: true }
})

ipcMain.handle('bridge:remove', async (_e, { dir, name }) => {
  const base = assertBridgeDir(dir)
  await fsp.rm(resolveInside(base, name), { force: true })
  return { ok: true }
})

/** 在系统文件管理器里打开桥接目录，方便用户手动往里丢指令文件 */
ipcMain.handle('bridge:reveal', async (_e, { dir }) => {
  const base = assertBridgeDir(dir)
  await shell.openPath(base)
  return { ok: true }
})

/** 当前是不是桌面版 —— 渲染进程据此决定用原生对话框还是浏览器 API */
ipcMain.handle('app:info', async () => ({
  isElectron: true,
  version: app.getVersion(),
  platform: process.platform,
  isDev: IS_DEV,
}))

// ============ 生命周期 ============

// 单实例：第二次启动时把已有窗口拿到前台，而不是再开一个编辑器抢同一份 settings.json
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    await loadSettings()
    // 桌面版没有「多标签页」概念，默认菜单栏纯属噪音
    Menu.setApplicationMenu(null)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // Windows/Linux 上关窗即退出，符合桌面软件的直觉
  if (process.platform !== 'darwin') app.quit()
})
