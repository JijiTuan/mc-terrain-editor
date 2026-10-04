# 项目长期笔记 · Minecraft 地形编辑器

## 仓库与身份

- GitHub：**https://github.com/JijiTuan/mc-terrain-editor**（public，默认分支 `main`）
- 署名：`JijiTuan <wxz080925080925@163.com>`（仓库级 git config，勿改）
- git 提交信息一律中文：标题单行概括 + 要点列表

## 版本号规则

- 全项目仅 `package.json` 一处版本号，改动必须同步（历史上有过漂移）
- 加功能 → minor；修 bug → patch；不兼容 → major
- 当前 **1.7.0**

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

## MC 世界存档读写（1.7.0 加）

- 三层：`io/anvil.js`（二进制格式）→ `io/world-io.js`（语义/窗口）→
  `ui/world-save.js`（界面流程）。主进程 `world:*` IPC 七个处理器
- **只支持现代调色板（paletted container）区块格式**（1.13+）。
  **未覆盖**光照、后处理、biome 全量改写
- **写回只动方块数据**：`block_entities`/`Heightmaps`/`InhabitedTime`/
  `DataVersion`/`Status` 必须原样保留；未触碰区块**逐字节复制**不重压
- **写盘必须「先备份 + tmp/rename」**：`.mca.bak-<时间戳>` 再写 `.tmp-<pid>` 后 rename。
  简化这一步 = 用户存档损坏风险
- 坐标：编辑器原点世界 vs 存档无限世界用「窗口」（维度/每边区块 2–8/最小 Y/
  高度/起始区块）调和；负区块用 `((c%32)+32)%32`
- 方块名映射**必须复用** `schematic.js` 的 `mapBlockName`（已改导出），
  否则同一方块在 .schem 与存档两处导入结果不一致

## Anvil 格式三个必须记住的点

1. **现代 MC 用 zlib(2)，不是 gzip(1)** —— 按 gzip 解会报 "invalid header"。
   `DecompressionStream('deflate')` = zlib 包裹
2. **位打包索引不能跨 long 边界**：`perLong = floor(64/bits)`，
   `longIdx = floor(i/perLong)`；写成 `i*bits` 在第一个边界后全错
   （section 内索引序 `y*256 + z*16 + x`）
3. 一区块 = 4 字节大端长度 + 1 字节压缩类型 + 压缩 NBT；
   region 头 = 4096 字节偏移表（3 字节扇区偏移 + 1 字节扇区数）+ 4096 字节时间戳表

## 构建与验证

```bash
npm run dev           # 开发服务器
npm run build         # 生产构建（39 模块）
npm test              # test:io + test:anvil + test:world + test:smoke
npm run dist          # Electron 打包
npm run textures      # 重建方块图集（需材质包 zip）
```

探针脚本在 `tools/`：`diag-blockbench.mjs`（交互 22 项）、`diag-fly.mjs`（WASD 9 项）、
`diag-ai-config.mjs`（AI 配置 24 项）、`test-anvil.mjs`（Anvil 格式 34 项）、
`test-world-io.mjs`（世界读写 20 项）、`diag-world-save.mjs`（存档端到端 16 项）、
`smoke.mjs`（冒烟）、`electron-verify-packaged.mjs`（打包产物实机启动 15 项）。

**生产构建下探针不能 `import('/src/...')`**（会解析成 `file:///D:/src/...` 404）——
必须走 `app.__test__` 暴露的入口。已在 `__test__` 里放了：
`validatePreviewExecute` / `worldDigest` / `worldFromJSON` / `loadWorldSaveModules`。
**新写探针前先翻这一节，这个坑已经踩过两次。**

**探针必须带反向对照 + 活性断言**，否则链路全死时对照也会假绿。
**测「配置是否真的生效」要起本地假服务断言发出去的请求内容**——
只断言界面显示了什么，测不出「UI 改对了但请求还发去旧地址」。假服务记得加
CORS 头，否则测出来的是跨源拦截而不是被测逻辑。

## 环境坑（这台机器特有）

- 工作区路径含中文 → Gradle 类工具需 `subst` 映射盘符（本项目管理不涉及）
- **本机 shell 有 `http_proxy/https_proxy=http://127.0.0.1:51397`（WorkBuddy 沙箱代理）**。
  Node 的 `fetch` 会**把 127.0.0.1 的回环请求也塞进代理** → `UND_ERR_SOCKET`。
  任何探针/脚本要连本机端口，必须**在本进程内**（运行期改 `process.env` 是有效的，
  undici 惰性读）设 `NO_PROXY=127.0.0.1,localhost,::1` 并删掉四个 proxy 变量，
  子进程 env 也要一起清。
- **这台机器同时开着两个代理**：Steam++ 占 `57709`，clash-verge 占 `7897`。
  哪个能用**不一定**（2026-10-04 时 57709 返回 502/000，7897 正常）。
  用之前先逐个探测：`curl -x http://127.0.0.1:<port> -o /dev/null -w '%{http_code}' https://github.com`，
  取能出 200 的那个。再用 `openssl s_client -proxy 127.0.0.1:<port> -connect github.com:443 -showcerts`
  看 issuer：是 `SteamTools Certificate` 就用 `sslBackend=openssl` + 自签 CA；
  是真 `Sectigo` 链就是直通，用 `sslBackend=schannel` 并且**不要** `sslCAInfo`。
- 即便代理通畅，`git push` 也可能被 SIGTERM 掐掉（超时，不是报错）。
  代码已提交在本地就没事，网络好了补推即可。
- `ELECTRON_RUN_AS_NODE=1` 是毒变量，会把 electron.exe 降级成普通 Node
  （报 `bad option: --remote-debugging-port=...`）
- **打包应用有 `requestSingleInstanceLock()`**：残留实例会让新实例**秒退 code 0**，
  而 Chromium 退出前已打印 `DevTools listening on ws://...`。
  症状是「stderr 说在监听，探针永远 ECONNREFUSED」，极易误判成产物坏了。
  探针**启动前必须 `taskkill /F /IM <exe> /T` 清场**并等端口空出；
  `child.kill()` 不够（Electron 有子进程，残留者仍持锁）。
- **vite 默认只绑 IPv6 `[::1]:<port>`**。`curl 127.0.0.1:<port>` → 000，
  `curl localhost:<port>` → 200。判据：先 `netstat -ano | grep <port>` 看有没有
  `[::1]:<port> LISTENING`，再挑 `localhost`。
- `release/`~`release11/` 各卡着删不掉的 `default_app.asar`，打包目录会自动顺延；
  探针要**自动挑最新 releaseN**，别硬写目录名。`.gitignore` 已用模式 `release[0-9]*/` 覆盖
- **打包后要 `git status` 看一眼**。曾发生过一次工作区 `package.json` 被清空
  （`scripts`/`devDependencies`/`build` 全没）的事件 —— 已查明不是
  `electron-builder` 也不是 `npm run dist` 的常态行为（守护复跑 sha1 不变），
  且没进任何提交，但**留下习惯：打包前后 `sha1sum package.json` 对一下**
- puppeteer-core 25.12.0 的方法叫 `evaluateOnNewDocument`（不是 `addInitScript`）
- 启动 vite 用 Bash 后台会被沙箱连带杀掉。PowerShell 侧 `npx.ps1` 被执行策略挡
  （`UnauthorizedAccess`），`Start-Process cmd.exe` 被安全策略拒。
  **可行解：`& "<node.exe 绝对路径>" ".\node_modules\vite\bin\vite.js" --port <p> --strictPort`**
- **跨 `evaluate` 的 `Uint8Array` 会变成 `{0:..,1:..}`**，`.length` 是 `undefined`。
  长度/判定要在页面内算成纯数字再返回

## 版权

图集 `src/assets/blocks-atlas.png` 是原版贴图烘成的，**按用户决定保留在公开仓库**。
中间素材 `.mc-jar-textures/`、`.mc-textures-tmp/` 已 ignore。
