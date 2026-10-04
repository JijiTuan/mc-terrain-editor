# 项目长期笔记 · Minecraft 地形编辑器

## 仓库与身份

- GitHub：**https://github.com/JijiTuan/mc-terrain-editor**（public，默认分支 `main`）
- 署名：`JijiTuan <wxz080925080925@163.com>`（仓库级 git config，勿改）
- git 提交信息一律中文：标题单行概括 + 要点列表

## 版本号规则

- 全项目仅 `package.json` 一处版本号，改动必须同步（历史上有过漂移）
- 加功能 → minor；修 bug → patch；不兼容 → major
- 当前 **1.5.0**

## 技术栈

Vite 5 + 原生 ESM（无框架）+ Three.js 0.169 + Electron 33。
`base: './'` 必须保留（`file://` 协议加载）。

## 操作方式（1.5.0 起，照 Blockbench）

- 默认 **方块模式**：左键单击放一格、左键拖拽逐格连铺、`Alt+左键` 删一格
- 可选 **笔刷模式**：左键拖拽涂抹，工具面板随之显隐「笔刷参数」整块
- 右键转视角（**刻意保留**，不改成删除）、中键平移、滚轮缩放
- 单击判定放在 `pointerup` 而非 `pointerdown`，位移 > 4px 才算拖拽
- 拖拽按格去重（`lastCellKey`）；方块模式**按格提交**命令，不是整条拖拽一条

## 关键设计约定

- `src/core/edit-ops.js` 是最小编辑单元，**交互层不得直接触 CommandBus**
- `orbit-controls.js`：`snap()` 拿 current 回填 target，**改目标值要用 `jumpTo()`**，
  写成「先改 `_targetXxx` 再 `snap()`」会被反向覆盖（frameWorld 踩过这个坑）
- 渲染：面剔除 + 16³ 分块增量重建；无光照，仅保留极轻微面向差异
- 贴图：从官方 jar 推导 `blockstates → models(顺 parent 链) → textures`，
  不手写映射表

## 构建与验证

```bash
npm run dev           # 开发服务器
npm run build         # 生产构建（34 模块）
npm test              # test:io + test:smoke
npm run dist          # Electron 打包
npm run textures      # 重建方块图集（需材质包 zip）
```

探针脚本在 `tools/`：`diag-blockbench.mjs`（交互 22 项）、`smoke.mjs`（冒烟）、
`electron-verify-packaged.mjs`（打包产物实机启动 15 项）。

**探针必须带反向对照 + 活性断言**，否则链路全死时对照也会假绿。

## 环境坑（这台机器特有）

- 工作区路径含中文 → Gradle 类工具需 `subst` 映射盘符（本项目管理不涉及）
- **网络代理 `127.0.0.1:57709` 会在「TLS 中间人」与「直通」间切换**，
  git 配置要跟着切：拦了就用 `sslBackend=openssl` + SteamTools 自签 CA，
  直通就用 `sslBackend=schannel` 并删掉 `sslCAInfo`。代理还会间歇返 502，重试即可。
- `ELECTRON_RUN_AS_NODE=1` 是毒变量，会把 electron.exe 降级成普通 Node
- `release/`~`release5/` 各卡着删不掉的 `default_app.asar`，打包目录会自动顺延
- puppeteer-core 25.12.0 的方法叫 `evaluateOnNewDocument`（不是 `addInitScript`）
- 启动 vite 用 Bash 后台会被沙箱连带杀掉，要用 PowerShell 的 `run_in_background`

## 版权

图集 `src/assets/blocks-atlas.png` 是原版贴图烘成的，**按用户决定保留在公开仓库**。
中间素材 `.mc-jar-textures/`、`.mc-textures-tmp/` 已 ignore。
