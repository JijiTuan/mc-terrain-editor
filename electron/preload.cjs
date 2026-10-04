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
})
