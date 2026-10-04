/**
 * electron/preload.cjs — 上下文隔离下的能力桥
 *
 * 渲染进程拿不到 node，只能通过这里暴露的 window.desktop 调主进程。
 * 暴露面刻意收窄成「外部对话桥」需要的那几个操作 ——
 * 不是把 ipcRenderer 整个丢出去，那样等于把主进程的 IPC 面全开给页面。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  isElectron: true,

  /** 应用与运行环境信息 */
  info: () => ipcRenderer.invoke('app:info'),

  /** 外部对话桥 —— 目录选择与持久化 */
  bridge: {
    /** 弹原生文件夹对话框。返回 { canceled } 或 { canceled:false, dir } */
    pickDir: () => ipcRenderer.invoke('bridge:pickDir'),
    /** 读上次记住的目录，valid 表示它现在还存不存在 */
    savedDir: () => ipcRenderer.invoke('bridge:savedDir'),
    /** 清除记住的目录 */
    forgetDir: () => ipcRenderer.invoke('bridge:forgetDir'),
    /** 在系统文件管理器里打开这个目录 */
    reveal: (dir) => ipcRenderer.invoke('bridge:reveal', { dir }),

    /** 文件读写。name 是相对 dir 的路径，主进程侧会做越界校验 */
    writeFile: (dir, name, text) => ipcRenderer.invoke('bridge:writeFile', { dir, name, text }),
    readFile: (dir, name) => ipcRenderer.invoke('bridge:readFile', { dir, name }),
    listDir: (dir, name) => ipcRenderer.invoke('bridge:listDir', { dir, name }),
    mkdir: (dir, name) => ipcRenderer.invoke('bridge:mkdir', { dir, name }),
    archive: (dir, fromName, toName, text) =>
      ipcRenderer.invoke('bridge:archive', { dir, fromName, toName, text }),
    remove: (dir, name) => ipcRenderer.invoke('bridge:remove', { dir, name }),
  },

  /**
   * Minecraft 存档读写。
   *
   * 与上面那套 bridge 分开，是因为这里传的是**二进制**（Uint8Array），
   * 不能走按 UTF-8 编码的 writeFile —— 二进制过一遍字符串会被静默破坏。
   * 所有方法都返回 { ok, ... } 而不是抛异常，避免一个读失败打断整条流程。
   */
  world: {
    /** 弹对话框选存档目录 */
    pickSave: () => ipcRenderer.invoke('world:pickSave'),
    /** 上次打开的存档（启动时提示「继续编辑」用） */
    savedSave: () => ipcRenderer.invoke('world:savedSave'),
    forgetSave: () => ipcRenderer.invoke('world:forgetSave'),
    /** 列出存档里的可用维度 */
    listDimensions: (dir) => ipcRenderer.invoke('world:listDimensions', { dir }),
    /** 读 level.dat 原始字节 */
    readLevelDat: (dir) => ipcRenderer.invoke('world:readLevelDat', { dir }),
    /** 列出某个维度里所有 region 坐标 */
    listRegions: (dir, sub) => ipcRenderer.invoke('world:listRegions', { dir, sub }),
    /** 读一个 region 文件的原始字节（不存在时 data 为 null） */
    readRegion: (dir, sub, rx, rz) => ipcRenderer.invoke('world:readRegion', { dir, sub, rx, rz }),
    /** 写回 region 文件（自动先备份原文件） */
    writeRegion: (dir, sub, rx, rz, data) =>
      ipcRenderer.invoke('world:writeRegion', { dir, sub, rx, rz, data }),
  },
})
