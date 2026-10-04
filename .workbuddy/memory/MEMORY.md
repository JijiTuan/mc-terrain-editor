# 项目长期笔记 · Minecraft 地形编辑器

## 仓库与身份

- GitHub：**https://github.com/JijiTuan/mc-terrain-editor**（public，默认分支 `main`）
- 署名：`JijiTuan <wxz080925080925@163.com>`（仓库级 git config，勿改）
- git 提交信息一律中文：标题单行概括 + 要点列表

## 版本号规则

- 全项目仅 `package.json` 一处版本号，改动必须同步（历史上有过漂移）
- 加功能 → minor；修 bug → patch；不兼容 → major
- 当前 **1.6.0**

## 技术栈

Vite 5 + 原生 ESM（无框架）+ Three.js 0.169 + Electron 33。
`base: './'` 必须保留（`file://` 协议加载）。

## 操作方式（1.5.0 起，照 Blockbench）

- 默认 **方块模式**：左键单击放一格、左键拖拽逐格连铺、`Alt+左键` 删一格
- 可选 **笔刷模式**：左键拖拽涂抹，工具面板随之显隐「笔刷参数」整块
- 右键拖拽转视角（**刻意保留**，不改成删除）、中键拖拽平移、滚轮缩放
- **WASD 按视角方向飞行**（1.6.0 加），`Ctrl` 加速 4 倍，固定步长不按距离缩放。
  **只在鼠标位于视口内时生效**（`pointerenter/leave` 跟踪，不用 tabindex+focus）。
  上下移动故意不做 —— 用户明确说「还是中键吧」（指保留下方方案，不加升降键）。
- 单击判定放在 `pointerup` 而非 `pointerdown`，位移 > 4px 才算拖拽
- 拖拽按格去重（`lastCellKey`）；方块模式**按格提交**命令，不是整条拖拽一条

## AI 配置（1.6.0 加）

- 三层来源，**优先级：界面(localStorage) > 构建时 `VITE_AI_*` > 内置默认**。
  刻意让界面优先——环境变量是给打包者的，界面是给使用者的。
  实现在 `src/ai/config-store.js`，`ai-client.js` 的 `readDirectConfig()` 已改为走它。
- **只支持 OpenAI 兼容协议**（`/chat/completions`）。Anthropic 的 `/v1/messages`
  格式（`x-api-key` + `content_block_delta`）**未实现**，DeepSeek 的
  `.../anthropic` 端点填了会 404，应填 `https://api.deepseek.com/v1`。
- `normalizeBaseUrl()` 必须保留：用户会把整条 `.../v1/chat/completions` 贴进来，
  不削掉就拼成双份 → 404，而 404 报错看不出是地址写多了。
- 界面入口：右侧 AI 面板右上角 **⚙ →「模型连接」**。未配置时按钮点亮成警示色。
- Key 存 localStorage，**和打包进产物一样挡不住**，界面上如实写明，不许美化。

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
npm run build         # 生产构建（35 模块）
npm test              # test:io + test:smoke
npm run dist          # Electron 打包
npm run textures      # 重建方块图集（需材质包 zip）
```

探针脚本在 `tools/`：`diag-blockbench.mjs`（交互 22 项）、`diag-fly.mjs`（WASD 9 项）、
`diag-ai-config.mjs`（AI 配置 24 项）、`smoke.mjs`（冒烟）、
`electron-verify-packaged.mjs`（打包产物实机启动 15 项）。

**探针必须带反向对照 + 活性断言**，否则链路全死时对照也会假绿。
**测「配置是否真的生效」要起本地假服务断言发出去的请求内容**——
只断言界面显示了什么，测不出「UI 改对了但请求还发去旧地址」。假服务记得加
CORS 头，否则测出来的是跨源拦截而不是被测逻辑。

## 环境坑（这台机器特有）

- 工作区路径含中文 → Gradle 类工具需 `subst` 映射盘符（本项目管理不涉及）
- **这台机器同时开着两个代理**：Steam++ 占 `57709`，clash-verge 占 `7897`。
  哪个能用**不一定**（2026-10-04 时 57709 返回 502/000，7897 正常）。
  用之前先逐个探测：`curl -x http://127.0.0.1:<port> -o /dev/null -w '%{http_code}' https://github.com`，
  取能出 200 的那个。再用 `openssl s_client -proxy 127.0.0.1:<port> -connect github.com:443 -showcerts`
  看 issuer：是 `SteamTools Certificate` 就用 `sslBackend=openssl` + 自签 CA；
  是真 `Sectigo` 链就是直通，用 `sslBackend=schannel` 并且**不要** `sslCAInfo`。
- 即便代理通畅，`git push` 也可能被 SIGTERM 掐掉（超时，不是报错）。
  代码已提交在本地就没事，网络好了补推即可。
- `ELECTRON_RUN_AS_NODE=1` 是毒变量，会把 electron.exe 降级成普通 Node
- `release/`~`release5/` 各卡着删不掉的 `default_app.asar`，打包目录会自动顺延
- puppeteer-core 25.12.0 的方法叫 `evaluateOnNewDocument`（不是 `addInitScript`）
- 启动 vite 用 Bash 后台会被沙箱连带杀掉，要用 PowerShell 的 `run_in_background`

## 版权

图集 `src/assets/blocks-atlas.png` 是原版贴图烘成的，**按用户决定保留在公开仓库**。
中间素材 `.mc-jar-textures/`、`.mc-textures-tmp/` 已 ignore。
