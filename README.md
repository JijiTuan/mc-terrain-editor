# Minecraft 地形编辑器（桌面版）

Windows 桌面应用：**左侧工具面板 + 右侧实时 3D 预览 + 内置 AI 对话**。
用自然语言描述需求（「生成一片山地，并在山谷中挖出一条河」），模型返回结构化编辑操作，
在视口里高亮出影响范围，确认后一次性执行，全程可撤销。

打包形态是 **Electron 桌面应用**（NSIS 安装包 + 免安装便携版），不需要浏览器、不需要起服务、
双击即用。编辑器内核（`src/`）是纯 Web 技术，由 Electron 的渲染进程通过 `file://` 加载；
主进程只负责窗口、原生文件夹对话框和文件系统 IPC。

技术栈：Electron 33 + Vite 5 + 原生 ES 模块 + Three.js 0.169 + WorkBuddy 云服务。
无前端框架 —— 状态集中在 `App` 一个中枢，数据流单向，好排查。

---

## 快速开始

```bash
npm install
npm run electron        # 构建 + 直接启动桌面版
```

日常开发（改代码即时生效）：

```bash
npm run dev             # 终端 1：Vite dev server
npm run electron:dev    # 终端 2：Electron 连上 dev server，自动开 DevTools
```

打安装包：

```bash
npm run dist            # NSIS 安装包 + portable 便携版 → release/
npm run pack            # 只出解包目录，用于快速验证打包配置
```

> **首次 `npm install` 会下载 Electron 的二进制（100MB+）**，它不在 npm registry 上，
> 而是走 GitHub Releases，国内直连会被 TLS 掐断。仓库里的 `.npmrc` 已配好 npmmirror 镜像，
> 正常情况无需手动干预。
>
> 若 `npm install` 报 `Cannot find module @rollup/rollup-win32-x64-msvc` 或
> `@esbuild/win32-x64 could not be found`，是 npm 可选依赖的已知问题，补装即可：
> ```bash
> npm install @rollup/rollup-win32-x64-msvc --save-optional
> npm install @esbuild/win32-x64 --save-optional
> ```

### 如果 Electron 一启动就崩在 `ipcMain.handle`

报错长这样：

```
TypeError: Cannot read properties of undefined (reading 'handle')
    at Object.<anonymous> (electron/main.cjs:...)
```

这**不是代码问题**，是环境里存在 `ELECTRON_RUN_AS_NODE=1`，它会让 `electron.exe`
退化成普通 Node 进程：`process.type` 变成 `undefined`，`require('electron').app` / `ipcMain`
全是 `undefined`。这个变量常见于「拿 Electron 当 Node 脚本运行器」的工具链（CI、IDE 集成）。

`npm run electron` 走的 `tools/electron-run.mjs` 已经会主动清掉它，所以正常路径不会踩到；
只有在你自己直接敲 `electron .` 时才需要手动 `unset ELECTRON_RUN_AS_NODE`。

---

## 界面与操作

```
┌──────────── 顶栏：撤销/重做 · 导入/导出 · 新建/工程/保存 · 帮助 ────────────┐
├──────────────┬──────────────────────────────────┬──────────────────────┤
│  工具面板     │        3D 预览视口                │    AI 对话面板        │
│  ① 操作模式   │  左上：当前模式 · 当前工具         │   通道状态            │
│  ② 工具       │  右上：视角预设 透视/俯视/正视/侧视 │   消息流 + 操作确认卡  │
│  ③ 放置的方块 │  HUD：世界尺寸/实体方块/撤销栈/通道 │   输入框 + 发送        │
│  ④ 笔刷参数*  │  俯视图小地图（选区/AI范围/相机）    │                      │
│  ⑤ 区域操作   │                                  │                      │
│  ⑥ 地形生成   │                                  │                      │
│  ⑦ 视图与数据 │                                  │                      │
└──────────────┴──────────────────────────────────┴──────────────────────┘
  * 第 ④ 块只在「笔刷模式」下出现
```

### 两种操作模式

默认是 **方块模式**，手感照搬 Blockbench：一个方块光标跟着鼠标走，
左键点一下就放一块，不需要拖拽，也不用先在工具栏里选「画笔」。

| | 方块模式（默认） | 笔刷模式 |
|---|---|---|
| 左键单击 | 在光标格放置一个方块 | — |
| 左键拖拽 | 沿路径连续放置（逐格铺路） | 按当前形状/半径涂抹一片 |
| `Alt` + 左键 | 删除光标格的方块 | 临时旋转视角 |
| 右键拖拽 | 旋转视角 | 旋转视角 |
| 中键拖拽 | 平移视角 | 平移视角 |
| 滚轮 | 缩放 | 缩放 |

顶部 `V` / `B` 切换模式，或用工具面板最上面的「操作模式」档位。

**为什么右键留给转视角，而不是像 Blockbench 那样用来删除。**
Blockbench 是「左键放、右键删」，但本编辑器的右键早就被视角旋转占了 ——
3D 编辑里没有旋转视角就没法干活。把右键拿去做删除，就得给旋转再找一个键
（中键已经被平移占了），徒增学习成本。所以删除挪到 `Alt+左键`：
左手按一下，右手点一下，不用切换任何工具档位，`左键=加 / Alt+左键=减`
这组对立关系比原版更省事。另外「删除」也是工具面板里的一个正式档位，
`R`/`Q` 之外的键盘用户可以直接切过去。

**为什么方块模式下「单击」的判定放在松手时。**
按下时立刻放方块的话，用户想转视角结果手抖点了一下，就会多出一个方块 ——
这是这类编辑器最常见的误操作。所以位移超过 4px 才算拖拽，没超过就在
`pointerup` 里补一次放置。拖拽期间按格去重，不会因为鼠标在原地抖动
就往撤销栈里塞几十条命令。

**笔刷模式为什么没被砍掉。** 刷大面积地形时球形/立方体笔刷是真省事，
改手感不该把它牺牲掉，所以收进一个可选档位。切到笔刷模式时工具面板会
多出「笔刷参数」一整块（半径 / 强度 / 形状 / 方式），切回方块模式就整块
隐藏 —— 方块模式下根本碰不到这些参数，让它们占着屏幕只是在制造噪音。

**快捷键**：`Ctrl+Z` 撤销 · `Ctrl+Shift+Z` / `Ctrl+Y` 重做 · `Ctrl+S` 保存 ·
`Ctrl+C/V` 复制粘贴选区 · `V` 方块模式 · `B` 笔刷模式 · `E` 放置 ·
`R` 删除/框选 · `Q` 吸管 · `Esc` 取消选区/预览 · `G` 网格 · `F` 适应视图 ·
`[` `]` 笔刷大小

---

## 方块贴图

方块表面用的是 **Minecraft 原版材质**，打包时烘成一张图集，开箱即用。

```
src/assets/blocks-atlas.png    62 张 16×16 贴图拼成的 256×64 图集（~14 KB）
src/assets/blocks-atlas.json   方块名 → 贴图名 → 图集位置
```

渲染上做了两件关键的事：

- **`NearestFilter`（不做插值）**。这是"像素感"的开关：默认的线性过滤会把 16×16
  贴图放大成一片渐变糊，像素风格就没了。同时关掉 mipmap，否则远处方块也会糊。
- **几乎不施加光照**。顶点色不再表示方块本色，只表示面朝向的极轻微差异
  —— 顶面 `1.00`、南北 `0.97`、东西 `0.94`、底面 `0.88`。
  六面同亮会让立方体看起来是平的，留这一点差异是为了能分清结构，
  但整体观感接近无光照。

草方块顶面、橡木顶面这类**多面贴图**已按原版规则分开映射
（草方块 = 顶面草 + 侧面过渡 + 底面泥土；原木 = 顶面年轮 + 侧面树皮）。
树叶、草顶这类原版给的是**灰度图**、运行时才按生物群系染色，
这里离线烘图时统一按平原群系色染好。

### 重新生成图集

图集是从游戏客户端或材质包里提取的，源素材不在仓库里（那是 Mojang 的版权内容）。
需要重建时：

```bash
# 从材质包 zip
npm run textures -- --zip "C:/path/to/材质包.zip"

# 或从已解压的目录（会自动找 assets/minecraft/textures/block）
npm run textures -- "C:/path/to/.minecraft/versions/1.21.11-Fabric 0.19.3"
```

脚本会按 `tools/build-textures.mjs` 里的 `BLOCK_TEXTURES` 映射表抽取所需贴图，
缺任何一张都会明确报错并列出缺哪些，不会静默生成一张有空洞的图集。

> **版权提示**：`src/assets/blocks-atlas.png` 内含 Mojang 的原版材质。
> 自行构建的产物**仅供个人使用，请勿公开发布或再分发**。
> 若要去掉这部分内容，把 `build-textures.mjs` 的 `BLOCK_TEXTURES` 指向自己的贴图，
> 或改用程序化生成的纯色图集。

---

## AI 接入的两条通道

右侧面板顶部的 `⚙` 里可以切换 / 配置：

1. **自备 Key** —— 在 `⚙` →「模型连接」里直接填**接口地址 / API Key / 模型名**，
   存本机，保存即生效。任何 OpenAI 兼容接口都行（DeepSeek / OpenAI / 通义 / 月之暗面 /
   智谱 / 本地 Ollama 都有一键填充）。
   也支持走构建时环境变量（`.env.local`，见 `.env.example`），
   但**界面里填的优先级更高** —— 装好的安装包里改配置不需要重新构建。
2. **接入会话** —— 不需要任何 Key。让 WorkBuddy / DSH 里的对话通过共享文件夹
   直接把指令写进来，编辑器读到就弹操作卡片。适合「已经开着对话在写东西」的场景。

> **只支持 OpenAI 兼容格式**（`/chat/completions`）。
> DeepSeek 的 Anthropic 格式端点（`https://api.deepseek.com/anthropic`）是另一套协议
> （`/v1/messages` + `x-api-key` + `content_block_delta`），本程序尚未实现，填了会 404。
> DeepSeek 请填 `https://api.deepseek.com/v1`。

`⚙` 里的「测试连接」会先发一个最小请求，把三类失败分开报——
**Key 不对（401）** / **地址不对（404，并提示多半是漏了 `/v1`）** / **网络不通**，
而不是笼统地甩一句「失败」。地址栏允许直接粘完整端点（`.../v1/chat/completions`），
程序会自动削回 base，不会拼成双份。

**纯前端应用无法隐藏 Key**：Key 存在浏览器 localStorage 里，
和打包进产物对「本机其他人」来说一样挡不住。只适合自己用，不要部署成对外服务。

### 操作确认卡

模型返回的不是文本而是结构化操作。执行前编辑器会：

1. 校验每条操作（类型、参数、方块名、坐标边界），不合规的直接退回并说明原因；
2. 在「世界副本」上 dry-run，算出**精确**的受影响方块数与包围盒；
3. 视口里用紫色包围盒 + 点云高亮影响范围，卡片上列出每条操作的中文描述；
4. 等你点「确认执行」才真正写入 —— 可撤销。

> 关键不变量：**预览说的改动数必须等于执行的改动数**。
> `tools/smoke.mjs` 每次都断言这一条，不成立就直接失败。
> 否则卡片上那句「影响约 N 格」就是在骗用户，而用户正是靠这个数字决定要不要执行。

---

## 外部对话直连（WorkBuddy / DSH 文件桥）

在 AI 面板点「连外部对话」，弹出**原生文件夹对话框**，选一个目录
（编辑器会在里面自动建 `.mc-editor/`）。之后**任何能读写本地文件的助手**都可以驱动这个编辑器
—— 包括本对话窗口。

```
.mc-editor/
├── protocol.md      ← 协议说明，写给"外部助手"看的
├── state.json       ← 编辑器当前状态快照（世界尺寸/选区/通道…）
├── requests/        ← 外部助手把指令写成这里的 .json
├── responses/       ← 编辑器执行后的回执
└── processed/       ← 处理过的指令归档（带时间戳前缀，同一文件不会执行两次）
```

**桌面版会把选定的目录记住，下次启动自动接上**，不用每次重选。
设置存在 `%APPDATA%\mc-terrain-editor\settings.json`；想换目录或彻底断开，
在桥接信息面板里点「断开连接」即可。面板上还有「打开目录」，直接在资源管理器里定位过去。

**为什么是文件桥而不是网络 API**：外部助手跑在对话环境里，看不到编辑器的内存，
也没有推送通道 —— 文件系统是双方唯一共享的媒介。所以用轮询 + 原子重命名。

外部助手写指令时要遵守两条硬规则（`protocol.md` 里有完整说明）：

- **先读 `state.json`**，按当前世界尺寸和选区生成坐标，别凭想象写。
- **原子写入**：先写 `.json.tmp` 再 rename 成 `.json`。直接写目标文件的话，
  编辑器可能读到写了一半的内容。

编辑器每 1.2 秒扫一次 `requests/`，执行后把文件挪到 `processed/`，
所以**同一个指令文件不会被执行两次**。执行仍然走「操作确认卡」流程 ——
外部指令也不能绕过用户确认。

> **两种外壳，同一套协议**。桌面版走 Electron 主进程的 `fs`（原生对话框 + 路径落盘）；
> 若把 `src/` 单独跑在浏览器里，则自动降级为 File System Access API 的目录句柄
> —— 那一路受浏览器安全模型限制，每次刷新都要重新授权目录。
> 桥接层（`src/ai/file-bridge.js`）把这两种后端藏在同一组接口后面，上层轮询逻辑共用一套。

---

## 项目结构

```
electron/                  桌面版外壳（不含任何编辑逻辑）
├── main.cjs               主进程：窗口、生命周期、原生对话框、文件系统 IPC
└── preload.cjs            上下文隔离下的能力桥（只暴露桥接需要的操作）

src/
├── core/                  纯逻辑，无 DOM/Three 依赖，可单独跑测试
│   ├── voxel-world.js     稠密体素存储：Uint8Array，索引 (y*depth+z)*width+x
│   ├── commands.js        撤销/重做：快照式 CommandBus
│   ├── brushes.js         笔刷形状/模式 + 描边插值
│   ├── regions.js         区域填充/清空/替换/镂空
│   ├── terrain.js         噪声地形、河流、分层、散布
│   ├── op-schema.js       ★ AI 操作协议唯一真源（提示词/校验/执行共用）
│   └── op-executor.js     操作 → 世界写入；dry-run 预览
├── render/
│   ├── mesher.js          面剔除网格化 + 每面 UV（顶点色只留极轻微面差异）
│   ├── textures.js        贴图图集加载与 UV 查表（方块名 + 面 → 图集 UV）
│   ├── voxel-renderer.js  分区块 Mesh、脏区块增量重建、DDA 拾取
│   └── orbit-controls.js  球坐标相机 + 阻尼
├── ui/
│   ├── interaction.js     鼠标语义 → 画笔/视角/框选
│   ├── toolbar.js         左侧面板
│   ├── ai-panel.js        右侧对话 + 操作确认卡
│   ├── minimap.js         俯视投影小地图
│   ├── modal.js           通用弹窗
│   └── toast.js           轻提示
├── ai/
│   ├── prompt.js          system prompt 组装
│   ├── parser.js          模型输出 → 结构化操作（多层容错提取）
│   ├── ai-client.js       云服务 / 直连双通道
│   └── file-bridge.js     外部对话文件桥（桌面 fs / 浏览器句柄双后端）
├── persist/storage.js     云优先、本地兜底的工程存储
├── io/
│   ├── nbt.js             NBT 二进制读写（含 gzip，零第三方依赖）
│   └── schematic.js       Sponge v2/v3 · WorldEdit Classic · Litematica
├── data/
│   ├── blocks.js          55 种方块定义（color 供 UI 色块/小地图用）
│   └── default-world.js   开场世界（固定种子，每次一样）
├── assets/
│   ├── blocks-atlas.png   方块贴图图集（由 tools/build-textures.mjs 生成）
│   └── blocks-atlas.json  方块 → 贴图 → 图集位置
└── main.js                App：把所有模块接起来 + 主循环

tools/                     启动与验证脚本
├── build-textures.mjs     从材质包/游戏 jar 提取贴图并生成图集
├── electron-run.mjs       启动桌面版（顺带清掉会破坏 Electron 的环境变量）
├── electron-dev.mjs       同时起 Vite + Electron
├── electron-pack.mjs      调 electron-builder 打包（注入镜像配置）
├── electron-verify.mjs    桌面版启动自检（13 项断言）
├── smoke.mjs              浏览器端实机冒烟（真实 Chromium）
└── test-io.mjs            存档往返（纯 Node）
```

### 几个值得说明的设计取舍

**为什么打包成 Electron 而不是 Tauri**：编辑器自带 Three.js + WebGL 实时渲染，
需要一个功能完整的 Chromium 与 GPU 通路。Electron 直接给到和浏览器完全一致的运行环境，
不用为 WebView2 的版本差异另开分支 —— 代价是安装包体积（约 100 MB），对一个本地工具可以接受。

**为什么排版 `vite.config.js` 里 `base` 要用 `'./'`**：桌面版用 `file://` 加载 `dist/index.html`，
绝对路径 `/assets/xxx` 在 `file://` 协议下会被解析成**磁盘根目录**而 404。
改成相对路径后，`file://` 与 `http://` 两种加载方式都正常。

**为什么撤销用「快照」而不是「逆操作」**：逆操作要为每种编辑各写一份反向逻辑，
很容易出现「撤销到一半状态不一致」。快照只需 `data.slice()`，50³ = 125 KB，
100 步约 12 MB —— 完全可接受，换来的是撤销永不跑偏。

**为什么不用 `THREE.Raycaster` 拾取**：面剔除后仍有很多三角形，
而体素世界可以做 DDA 步进，几十个格子就能精确命中，还顺带拿到命中面的法线
（放置方块时需要）。

**为什么 AI 操作用 schema 驱动**：`OPS` 一份定义同时生成提示词、校验规则和执行分支。
新增能力的正确做法是加一条 `OPS` + 加一个 executor 分支，提示词自动同步 ——
不会出现「提示词说支持、代码没实现」的漂移。

**为什么河流只让 AI 说「在哪挖多宽」**：河道曲线由编辑器采样 `surfaceHeight` 自己算。
模型不该、也做不好「逐格算地形高度」这件事。分工是：AI 决定*做什么*，编辑器决定*怎么算*。

**为什么主进程 IPC 要做路径越界校验**：渲染进程理论上不会构造恶意路径，
但把边界收在主进程是这类 IPC 的基本纪律 —— 一旦哪天渲染进程被执行了不可信内容
（比如 AI 回复里的东西被当代码跑），越界也到不了任意路径。

**为什么贴图要烘成图集而不是一张张加载**：原版 `textures/block/` 有 735 张图，
全量加载要几百次请求和几百个纹理对象。烘成一张 256×64 的图集后：
一次加载、一个纹理、UV 查表是 O(1)，还能让所有方块共享同一个材质
（否则每换一种方块就得换材质，批次调用会炸）。

**为什么顶点色还要留着**：贴图已经提供了方块本色，但六面同亮会让立方体看起来是
一张平面 —— 尤其在纯色区域（整片石墙）几乎看不出结构。留 0.88~1.00 的微弱差异
既保住结构辨识度，又接近"无光照"的观感。

**为什么 `renderMessages` 里不能设 `scrollTop`**：那个函数执行时，它操作的 DOM 往往
还没被插进文档（`buildAiPanel` 是"先建好子树、再整体挂载"）。游离节点没有布局，
`scrollHeight` 恒为 0，此时设 `scrollTop` 等于什么都没做。滚动必须等挂载完成后、
在下一帧布局稳定时再做 —— 这个坑让"新出现的操作卡停在视野外、用户找不到确认按钮"
成了一个很难从代码上看出来的 bug。

---

## 存档格式

| 格式 | 导入 | 导出 | 说明 |
|---|---|---|---|
| `.schem`（Sponge v3） | ✅ | ✅ | 默认导出格式，gzip + NBT，PC 版主流 |
| `.schem`（Sponge v2） | ✅ | — | 旧版，按 `Version` 字段自动识别 |
| `.schem`（WorldEdit Classic） | ✅ | — | 旧版数字 id + VarInt 变长编码 |
| `.litematic` | ✅ | — | Litematica 蓝图，Bit 打包 BlockStates |
| `.json`（原生工程） | ✅ | ✅ | RLE 压缩、无损、体积最小，往返首选 |

导入时会弹出报告：识别了多少方块、哪些是近似映射、哪些不认识。
不认识的方块不会被静默丢弃。

**编辑进度持久化**：编辑过程中自动往「草稿」写快照，刷新页面自动恢复；
`Ctrl+S` 保存成命名工程。存储是**本地 localStorage**（云通道已移除）。

---

## 接入 Minecraft 世界存档（桌面版）

工具栏「7. 游戏存档」可以**直接打开真实的 `.minecraft/saves` 存档**，
把地形读进编辑器改完，再**写回存档本身**。这是编辑器和游戏之间的双向通道，
和上面的 `.schem` 导入导出是两回事（那个是「结构文件」，这个是「整个世界存档」）。

### 怎么用

1. `打开存档` → 选择存档文件夹（会自动记住，下次直接进）
2. 选**维度**（主世界 / 下界 / 末地）和**读取窗口**：每边区块数（2–8）、最小 Y、高度、起始区块
3. 编辑器里改，改完 `保存到存档`
4. 保存前会弹确认框，**列出将要改写的精确区块范围**，并提醒**先关掉 Minecraft**

### 关键安全设计

- **写前自动备份**：原文件先复制成 `<region>.mca.bak-<时间戳>`，再写新内容
- **原子替换**：先写 `.tmp-<pid>`，成功后 `rename` 覆盖，写一半断电不会留下半截文件
- **只动方块数据**：`block_entities`（箱子内容）、`Heightmaps`、`InhabitedTime`、
  `DataVersion`、`Status` 等字段原样保留；没碰到的区块**逐字节复制**，不重新压缩

### Anvil 格式支持范围

支持现代版本（1.13+）的调色板（paletted container）区块格式，
读 `region/*.mca`，zlib 压缩。**未覆盖**：区块内的光照数据、后处理、
`biomes` 的全量调色板改写（读取时保留，写入时不改）。

> ⚠️ 写回功能**只在合成的测试存档上验证过**，没有在真实玩家存档上实测。
> 代码有自动备份兜底，但请**先自行备份存档**再试。

---

## 自动化验证

```bash
npm run test:io                  # 存档往返（纯 Node，无需浏览器）
npm run test:anvil               # Anvil 格式：位打包 / region / zlib
npm run test:world               # MC 世界读写：窗口选择、写回字段保留
npm run test:smoke               # 浏览器端实机冒烟（需要先起服务）
node tools/diag-world-save.mjs   # 存档端到端（真打包 Electron + 真磁盘假存档）
node tools/electron-verify.mjs   # 桌面版启动自检
```

`test:io` 覆盖：RLE 往返、原生工程往返、Sponge v3 导出→导入**逐格比对**、
格式识别（v2/v3/we-classic/litematic 不混淆）、分块合并、空世界与 1×1×1 边界、
以及**全部 54 种方块**导出再导入不丢失。

`test:smoke` 用真实 Chromium 加载页面，断言：

- 零运行时报错、零请求失败
- WebGL 上下文可用、UI 结构完整
- **涂抹改变世界且进撤销栈** → **`Ctrl+Z` 撤销生效且进重做栈** → **右键拖拽旋转视角**
- 模型输出解析的 5 类容错（markdown 包裹 / 裸 JSON / 别名字段 / 纯闲聊 / 尾逗号）
- **预览改动数 === 执行改动数**（全项目最硬的一条正确性断言）

截图落在 `.smoke/`，可直接肉眼复核。

`electron-verify.mjs` 用真实的 Electron 起窗口，断言主进程没崩、`process.type === 'browser'`、
preload 能力桥挂载、编辑器内核与各子系统就位、WebGL 可用、UI 骨架完整、
以及桌面版里**预览改动数依旧 === 执行改动数**。

> 写这类探针时注意：断言必须落在**真实的字段层级**上。这个脚本第一版把
> `validatePreviewExecute()` 的返回值当成了 `{ ok, previewCount, applyCount }`，
> 实际结构是 `{ validation, pipeline: { previewMatchesApply, ... } }` —— 于是断言
> 永远取不到值，被当成「跳过」放过去，看起来是绿的。这就是典型的假绿：
> **取不到值必须算失败，不能算跳过**。

---

## 已知限制

- 世界尺寸上限 512³，超过会在构造时直接抛错（避免内存爆掉）。
- Litematica 只做导入，不做导出。
- **AI 只支持 OpenAI 兼容协议**。Anthropic 的 Messages 格式（`/v1/messages`）
  尚未实现，DeepSeek 的 `.../anthropic` 端点填进去会 404。
- 自备 Key 存在本机 localStorage（或构建时被打进产物），只适合自己用，
  不要分发这个构建、也不要部署成对外服务。
- **打包需要能正常 rename 非空目录**。本机实测在含子目录的目录上 `rename` 会稳定
  `EPERM`（纯文件目录则正常），而 electron-builder 默认流程恰好要「解压到 .tmp 再改名」，
  因此必然失败。`tools/electron-pack.mjs` 已绕开这一步：自己把 zip 解压到最终位置，
  再用 `--prepackaged` 让 electron-builder 跳过解压改名。若在别的机器上打包遇到同样的
  `EPERM`，这个绕法同样适用；若你那边 `rename` 正常，也可以直接把那段换成标准流程。
