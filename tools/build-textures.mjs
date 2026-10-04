/**
 * tools/build-textures.mjs — 从 Minecraft 官方 jar 生成方块贴图图集
 *
 * ── 它做什么 ──
 * 从官方客户端 jar 里读出每个方块真正的贴图，拼成一张图集（atlas）PNG，
 * 同时输出 UV 映射表（JSON），供运行时按方块名 + 面朝向查 UV。
 *
 * ── 为什么不再用「材质包 + 手写映射表」 ──
 * 上一版的做法是：读一个第三方材质包目录，按手写的 BLOCK_TEXTURES 表
 * 去 textures/block/ 里按文件名捞图。有两个真问题：
 *
 *   1. 手写的表会跟游戏实际不符。原版草方块的侧面其实是
 *      `grass_block_side` + `grass_block_side_overlay` 两层叠出来的，
 *      砂岩的底面和顶面是两张不同的图 —— 这些都在模型 JSON 里，
 *      靠人肉记和抄，迟早抄错，而且抄错了没有任何东西会报错。
 *   2. 材质包版本不匹配就直接缺图。之前用的 1.16 材质包里没有
 *      deepslate / tuff / calcite（1.17 才加入），脚本只能报「缺失 3 张」然后退出。
 *
 * 现在改成从 jar 里读三方数据自动推导：
 *
 *   blockstates/<方块>.json   →  取一个 variant 的 model 名
 *   models/block/<模型>.json  →  顺着 parent 链继承，拿到 textures 表
 *   按面取 #top / #bottom / #side / #all / #end / #north…  →  收敛到 top/side/bottom 三面
 *   textures/block/<贴图>.png →  解码
 *
 * 好处：映射是「从游戏数据推出来的」，不是「我以为的游戏数据」。
 * 换版本只要把 jar 路径指过去，不用改代码。
 *
 * ── 为什么默认写死一个 jar 路径 ──
 * 这台机器上就有完整的 1.21.1 官方资源，构建时不该再依赖网络。
 * 但仍然允许用参数覆盖，且覆盖方式有优先级，见 resolveSources()。
 *
 * 用法：
 *   node tools/build-textures.mjs                          # 自动找本机 1.21.1 jar
 *   node tools/build-textures.mjs --jar <客户端.jar>
 *   node tools/build-textures.mjs --pack <材质包目录|zip>   # 覆盖贴图（可选的换肤）
 *   node tools/build-textures.mjs --pack <材质包> --jar <jar>  # 贴图取自材质包，模型/染色取自 jar
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'src', 'assets')
const OUT_ATLAS = path.join(OUT_DIR, 'blocks-atlas.png')
const OUT_MAP = path.join(OUT_DIR, 'blocks-atlas.json')

/** 图集单张贴图的边长（像素）。原版是 16×16 */
const TILE = 16
/** 图集里每行放几张 */
const COLS = 16

/**
 * 本机已知的官方 jar 候选路径（按优先级）。
 *
 * 直接读 `.minecraft/versions/<版本>/<版本>.jar`：这是官方启动器/PCL 下载的
 * 客户端 jar，里面就带着 assets/minecraft/{blockstates,models,textures}。
 * 用户机器上不一定在这个路径，所以找不到时会给出明确指引。
 */
const JAR_CANDIDATES = [
  'C:/Users/passk/Desktop/.minecraft/versions/1.21.1-NeoForge_21.1.235/1.21.1-NeoForge_21.1.235.jar',
  'C:/Users/passk/AppData/Roaming/.minecraft/versions/1.21.1/1.21.1.jar',
]

/**
 * 要烘进图集的方块。键是本项目 data/blocks.js 里的方块名，
 * 值是对应到官方数据里的方块 id（绝大多数同名，个别需要改写）。
 *
 * 之所以还要列一份「要哪些方块」的清单：jar 里有 1060 个方块，
 * 全烘进去图集会有 1MB 且 99% 用不上。这份清单决定图集内容，
 * 但每张图「具体是哪张」是自动解析出来的。
 */
const BLOCKS = [
  // 自然方块
  'stone', 'cobblestone', 'dirt', 'grass_block', 'sand', 'red_sand', 'gravel', 'clay',
  'snow_block', 'ice', 'packed_ice', 'sandstone', 'terracotta', 'obsidian', 'bedrock',
  'mossy_cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff', 'calcite',
  'netherrack', 'soul_sand', 'magma_block',

  // 液体（动画贴图，只取第一帧）
  'water', 'lava',

  // 木材
  'oak_log', 'oak_planks', 'spruce_log', 'spruce_planks', 'birch_log', 'birch_planks',
  'oak_leaves', 'spruce_leaves', 'birch_leaves',

  // 建材
  'bricks', 'stone_bricks', 'glass',
  'white_concrete', 'gray_concrete', 'black_concrete', 'red_concrete',
  'blue_concrete', 'yellow_concrete', 'green_concrete', 'quartz_block',

  // 矿物
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'redstone_ore',

  // 发光方块
  'glowstone', 'sea_lantern',
]

/**
 * 把贴图名归一化成短名（不含命名空间与目录前缀）。
 *
 * 为什么必须归一化：模型 JSON 里的贴图名写法不统一 ——
 * 有的是 `minecraft:block/oak_leaves`，有的是 `block/dirt`，
 * 还有的是 `dirt`。如果直接拿原始写法当图集的键，就会出现
 * 「同一张贴图被当成三个不同的贴图烘三遍」，而且 TINT / COMPOSITE
 * 这些用短名写的表永远匹配不上 —— 表现为「染色静默失效」，
 * 没有任何报错，只是草和树叶颜色不对。
 *
 * 所以：所有进入集合、映射表、图集键的贴图名，一律先过这里。
 */
function shortTexName(t) {
  if (!t) return t
  return t
    .replace(/^minecraft:/, '')
    .replace(/^(block|textures\/block)\//, '')
}

/**
 * 与 data/blocks.js 的命名差异。
 * 本项目里叫 snow_block（避免和「雪层」混淆），官方叫 snow。
 */
const BLOCK_ID_OVERRIDE = {
  snow_block: 'snow',
}

/**
 * 直接写死三面贴图的方块 —— 那些「模型里查不到」的。
 *
 * 液体是特例：水/岩浆的渲染完全由引擎负责，它们的模型 JSON 里只有一个
 * `particle` 贴图（用于破坏粒子），根本没有六个面的定义。所以
 * 「从模型推贴图」这条路对它们走不通，只能显式指定。
 * 用的是 still（静止）版本而不是 flow（流动）版本 —— 编辑器里是静态预览。
 */
const FACE_OVERRIDE = {
  water: { top: 'water_still', side: 'water_still', bottom: 'water_still' },
  lava: { top: 'lava_still', side: 'lava_still', bottom: 'lava_still' },
}

/**
 * 需要按生物群系染色的贴图（原版给的是灰度图，运行时上色）。
 *
 * 颜色不是猜的 —— 取自官方 tints 常量（minecraft-data 里 1.21.1 的 tints.json）：
 *   grass（草方块系，平原生物群系）  = 0x79c05a
 *   foliage（橡树叶，平原，受群系影响）= 0x79c05a 的 foliage 变体
 *   birch_leaves（常量，不受群系影响）= 0x80a755
 *   spruce_leaves（常量，不受群系影响）= 0x619961
 *
 * 注意水不是染出来的：原版水的颜色由 `water` tint 决定（平原约 0x3f76e4），
 * 但 water_still.png 本身就是灰度的，不染会显示成灰色水。这里一并染上。
 */
const TINT = {
  grass_block_top: 0x79c05a,
  grass_block_side_overlay: 0x79c05a, // 草方块侧面那层草边
  oak_leaves: 0x48b518,
  spruce_leaves: 0x619961,
  birch_leaves: 0x80a755,
  water_still: 0x3f76e4,
}

/**
 * 三张特殊贴图的合成规则。
 *
 * 草方块的侧面在原版里是「两层」：底层是泥土加一圈暗边（grass_block_side），
 * 上面叠一层半透明的草色（grass_block_side_overlay）。我们只有一个面、
 * 一张图，所以要把这两层合成成一张 —— 直接只取 grass_block_side 会得到
 * 一圈枯黄的边，看起来像过期资源包。
 *
 * 合成方式 alpha-over 标准混合。只在 overlay 有效时用它。
 */
const COMPOSITE = {
  grass_block_side: ['grass_block_side', 'grass_block_side_overlay'],
}

/* ============================================================
 * jar / 材质包读取
 * ============================================================ */

/**
 * 统一的「只读资源容器」。jar 和材质包 zip 都走这里，
 * 上层解析逻辑就不需要关心数据是从哪来的。
 *
 * 实现说明：自己解析 zip 中央目录，不调 unzip 命令。
 * 原因很实际 —— 调 `unzip` 依赖 PATH 里有它，而 Node 的 spawnSync
 * 在 Git Bash 环境下不一定继承到 /usr/bin，会出现「终端里明明能跑、
 * 脚本里报找不到命令」这种让人摸不着头脑的失败。
 * zip 格式的读取只用到中央目录 + stored/deflate 两种压缩，代码量可控，
 * 而且能精确控制「哪个条目读、哪个不读」，对 300MB 的客户端 jar 反而更快。
 */
class ZipReader {
  constructor(zipPath) {
    this.path = zipPath
    this._entries = null // Map<name, {method, compSize, localOffset, uncompSize}>
  }

  /** 解析中央目录（末尾 EOCD → CD 表）。惰性执行一次。 */
  _load() {
    if (this._entries) return this._entries
    const fd = fs.openSync(this.path, 'r')
    try {
      const size = fs.fstatSync(fd).size

      // EOCD 在文件末尾，最长为 22 + 65535 字节的注释
      const tailLen = Math.min(size, 22 + 65535)
      const tail = Buffer.alloc(tailLen)
      fs.readSync(fd, tail, 0, tailLen, size - tailLen)

      // 从后往前找 EOCD 签名 0x06054b50
      let eocd = -1
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
      }
      if (eocd < 0) throw new Error(`不是有效的 zip/jar：${this.path}`)

      const cdCount = tail.readUInt16LE(eocd + 10)
      const cdSize = tail.readUInt32LE(eocd + 12)
      const cdOffset = tail.readUInt32LE(eocd + 16)

      const cd = Buffer.alloc(cdSize)
      fs.readSync(fd, cd, 0, cdSize, cdOffset)

      const entries = new Map()
      let p = 0
      for (let i = 0; i < cdCount; i++) {
        if (cd.readUInt32LE(p) !== 0x02014b50) break
        const method = cd.readUInt16LE(p + 10)
        const compSize = cd.readUInt32LE(p + 20)
        const uncompSize = cd.readUInt32LE(p + 24)
        const nameLen = cd.readUInt16LE(p + 28)
        const extraLen = cd.readUInt16LE(p + 30)
        const commentLen = cd.readUInt16LE(p + 32)
        const localOffset = cd.readUInt32LE(p + 42)
        const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
        entries.set(name, { method, compSize, uncompSize, localOffset })
        p += 46 + nameLen + extraLen + commentLen
      }
      this._entries = entries
      return entries
    } finally {
      fs.closeSync(fd)
    }
  }

  list() {
    return [...this._load().keys()]
  }

  has(name) {
    return this._load().has(name)
  }

  /** 读出某个条目的内容；不存在返回 null（而不是抛错，调用方要能优雅处理缺失） */
  read(name) {
    const e = this._load().get(name)
    if (!e) return null
    const fd = fs.openSync(this.path, 'r')
    try {
      // 本地头长度不固定（文件名/扩展字段长度可变），要先读它才知道数据从哪开始
      const lh = Buffer.alloc(30)
      fs.readSync(fd, lh, 0, 30, e.localOffset)
      if (lh.readUInt32LE(0) !== 0x04034b50) return null
      const nameLen = lh.readUInt16LE(26)
      const extraLen = lh.readUInt16LE(28)
      const dataStart = e.localOffset + 30 + nameLen + extraLen

      const comp = Buffer.alloc(e.compSize)
      fs.readSync(fd, comp, 0, e.compSize, dataStart)

      if (e.method === 0) return comp                       // stored
      if (e.method === 8) return zlib.inflateRawSync(comp)  // deflate
      throw new Error(`不支持的压缩方式 ${e.method}：${name}`)
    } finally {
      fs.closeSync(fd)
    }
  }

  readJSON(name) {
    const b = this.read(name)
    if (!b) return null
    try {
      return JSON.parse(b.toString('utf8'))
    } catch (err) {
      throw new Error(`解析 ${name} 失败：${err.message}`)
    }
  }
}

/** 材质包目录（已解压）也要能像 zip 一样读，好让 --pack <dir> 也能用 */
class DirReader {
  constructor(dir) {
    this.dir = dir
  }
  list() {
    const out = []
    const walk = (d, prefix) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(d, e.name), rel)
        else out.push(rel)
      }
    }
    walk(this.dir, '')
    return out
  }
  has(name) { return fs.existsSync(path.join(this.dir, name)) }
  read(name) {
    const p = path.join(this.dir, name)
    return fs.existsSync(p) ? fs.readFileSync(p) : null
  }
  readJSON(name) {
    const b = this.read(name)
    if (!b) return null
    try { return JSON.parse(b.toString('utf8')) } catch (err) {
      throw new Error(`解析 ${name} 失败：${err.message}`)
    }
  }
}

/**
 * 建一个 reader，自动判断资源根前缀。
 *
 * 官方客户端 jar 里资源在 `assets/minecraft/`。
 * 材质包目录结构五花八门（有的直接给 textures/block，有的套 assets/minecraft/…，
 * 有的还是 BE 的 textures/blocks），所以按「哪一层能找到 textures/block/stone.png」逐个试。
 */
function openReader(p) {
  if (!fs.existsSync(p)) throw new Error(`路径不存在：${p}`)

  if (fs.statSync(p).isFile()) {
    const reader = new ZipReader(p)
    // jar 和标准材质包 zip 都是 assets/minecraft/ 结构
    if (reader.has('assets/minecraft/textures/block/stone.png')) {
      return { reader, prefix: 'assets/minecraft/' }
    }
    // 少数材质包会把 assets 放在别的层级，这里只认标准结构
    if (reader.has('textures/block/stone.png')) return { reader, prefix: '' }
    throw new Error(`压缩包 ${p} 里找不到 textures/block/stone.png（不是标准的 Java 版资源包/jar）`)
  }

  // 目录：判断它本身是不是已经是 assets/minecraft（或更深的 textures/block）
  const direct = new DirReader(p)
  if (direct.has('textures/block/stone.png')) return { reader: direct, prefix: '' }
  if (direct.has('assets/minecraft/textures/block/stone.png')) {
    return { reader: direct, prefix: 'assets/minecraft/' }
  }
  // 传进来的可能已经是 textures/block 目录本身：把父级当作根
  for (const updir of ['..', '../..', '../../..']) {
    const parent = path.resolve(p, updir)
    if (!fs.existsSync(parent)) continue
    const r = new DirReader(parent)
    if (r.has('textures/block/stone.png')) return { reader: r, prefix: '' }
    if (r.has('assets/minecraft/textures/block/stone.png')) {
      return { reader: r, prefix: 'assets/minecraft/' }
    }
  }
  throw new Error(`在 ${p} 里找不到 textures/block/stone.png，无法识别为资源包`)
}

/* ============================================================
 * 方块数据解析：blockstate → model → texture
 * ============================================================ */

/**
 * 顺着模型的 parent 链把 textures 表继承下来。
 *
 * 原版模型继承很常见：oak_log 的模型只有一行 parent=cube_column + 两个贴图名，
 * 真正「哪个面用哪个贴图」的定义在 cube_column 里。不追 parent 就只能拿到
 * 半张表，然后按面查时全落空。
 *
 * 子模型的 textures 优先于父模型（同名键覆盖），这与游戏行为一致。
 */
function resolveModelTextures(modelName, prefix, reader, seen = new Set()) {
  if (seen.has(modelName)) return {} // 防环：正常数据不会有，但不能因此死循环
  seen.add(modelName)

  const short = modelName.replace(/^minecraft:/, '').replace(/^block\//, '')
  const file = `${prefix}models/block/${short}.json`
  const model = reader.readJSON(file)
  if (!model) return {}

  let textures = {}
  if (model.parent) {
    const parentTextures = resolveModelTextures(model.parent, prefix, reader, seen)
    textures = { ...parentTextures }
  }
  if (model.textures) {
    // 值可能是 '#side' 这种间接引用，稍后统一解引用
    textures = { ...textures, ...model.textures }
  }
  return textures
}

/**
 * 把 '#side' 这类引用解成真正的贴图名。
 * '#all' → 'block/stone'；本身就是 'block/stone' 的直接返回。
 */
function deref(value, textures, depth = 0) {
  if (typeof value !== 'string') return null
  if (!value.startsWith('#')) return value
  if (depth > 8) return null
  const next = textures[value.slice(1)]
  return next ? deref(next, textures, depth + 1) : null
}

/**
 * 从一个方块的 blockstate 里挑一个 variant，解析出六面贴图。
 *
 * 为什么要「挑一个 variant」：草方块按 snowy 分两个 variant，
 * 原木按 axis=x/y/z 分三个。我们要的是最普通的那个 ——
 * 草方块的 snowy=false、原木的 axis=y（竖着长的原木）。
 *
 * 选择策略：优先取不含状态键的 variant（""），
 * 否则取第一个，并对原木这类优先 axis=y。
 */
function pickVariant(blockstate) {
  const variants = blockstate.variants
  if (!variants) {
    // multipart 方块（栅栏、红石线等）。我们清单里不含这类，但留个明确报错。
    if (blockstate.multipart) return null
    return null
  }
  const keys = Object.keys(variants)
  if (keys.length === 1) {
    const v = variants[keys[0]]
    return Array.isArray(v) ? v[0] : v
  }
  // 优先「无状态」的变体
  const plain = keys.find((k) => k === '')
  if (plain) {
    const v = variants[plain]
    return Array.isArray(v) ? v[0] : v
  }
  // 原木：取 axis=y（竖直），这是编辑器里放置的默认朝向
  const yAxis = keys.find((k) => k.split(',').every((p) => p === 'axis=y'))
  if (yAxis) {
    const v = variants[yAxis]
    return Array.isArray(v) ? v[0] : v
  }
  // 草方块：排除 snowy=true
  const notSnowy = keys.find((k) => !k.includes('snowy=true'))
  const pick = notSnowy ?? keys[0]
  const v = variants[pick]
  return Array.isArray(v) ? v[0] : v
}

/**
 * 方块模型里的面名 → 我们的三面语义。
 *
 * 原版用 up/down/north/south/east/west，且 cube 系列父模型把
 * down 绑到 #bottom、up 绑到 #top、四侧绑到 #side。
 * 我们只要 top/side/bottom 三面（mesher 就是这么用的），
 * 所以四个侧面收敛成一个。
 */
const FACE_KEYS = {
  top: ['up', 'top'],
  bottom: ['down', 'bottom'],
  side: ['north', 'side', 'east', 'south', 'west'],
}

/**
 * 解析一个方块 → { top, side, bottom } 三张贴图名。
 *
 * 两条路：
 *   A. 模型有 elements（草方块就是这种）：直接读 elements[].faces[].texture
 *   B. 模型只有 textures 表（绝大多数 cube 系列）：按 cube 系列的约定取名
 * 两条都走一遍，优先用 elements 的结果（它是显式的，不会猜错）。
 */
function resolveBlockFaces(blockId, prefix, reader) {
  const bs = reader.readJSON(`${prefix}blockstates/${blockId}.json`)
  if (!bs) return { error: `没有 blockstates/${blockId}.json` }

  const variant = pickVariant(bs)
  if (!variant?.model) return { error: `blockstates/${blockId}.json 里没有可用的 model` }

  const modelName = variant.model.replace(/^minecraft:/, '').replace(/^block\//, '')
  const model = reader.readJSON(`${prefix}models/block/${modelName}.json`)
  if (!model) return { error: `没有 models/block/${modelName}.json` }

  const textures = resolveModelTextures(modelName, prefix, reader)

  const faces = {}
  // --- 路线 A：显式 elements ---
  if (Array.isArray(model.elements)) {
    // 草方块这种「全覆盖 + overlay」的模型：同一个面可能出现两次，
    // 第二次是叠加层。这里记录所有出现过的贴图，交给 COMPOSITE 处理。
    const collected = { up: [], down: [], north: [], south: [], east: [], west: [] }
    for (const el of model.elements) {
      for (const [dir, face] of Object.entries(el.faces ?? {})) {
        const tex = deref(face.texture, textures)
        if (tex && collected[dir] && !collected[dir].includes(tex)) collected[dir].push(tex)
      }
    }
    faces.top = collected.up
    faces.bottom = collected.down
    // 四个侧面取出现次数最多的那个作为「主侧面」
    const sideCount = new Map()
    for (const d of ['north', 'south', 'east', 'west']) {
      for (const t of collected[d]) sideCount.set(t, (sideCount.get(t) ?? 0) + 1)
    }
    if (sideCount.size) {
      const main = [...sideCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
      faces.side = [main, ...[...sideCount.keys()].filter((t) => t !== main)]
    }
  }

  // --- 路线 B：textures 表约定（补 A 没拿到的面） ---
  if (!faces.top?.length || !faces.side?.length || !faces.bottom?.length) {
    const byKey = (keys) => {
      for (const k of keys) {
        const t = deref(textures[k], textures)
        if (t) return t
      }
      return null
    }
    const all = byKey(['all', 'side', 'texture'])
    faces.top = faces.top?.length ? faces.top : [byKey(['up', 'top', 'end']) ?? all].filter(Boolean)
    faces.bottom = faces.bottom?.length ? faces.bottom : [byKey(['down', 'bottom', 'end']) ?? all].filter(Boolean)
    faces.side = faces.side?.length ? faces.side : [byKey(['side', 'all', 'north']) ?? all].filter(Boolean)
  }

  const pick1 = (arr) => (arr?.length ? shortTexName(arr[0]) : null)
  return {
    top: pick1(faces.top),
    bottom: pick1(faces.bottom),
    side: pick1(faces.side),
    // 记录侧面的叠加层（草方块需要），供 COMPOSITE 使用
    sideOverlay: faces.side?.[1] ? shortTexName(faces.side[1]) : null,
  }
}

/* ============================================================
 * PNG 编解码（零依赖）
 * ============================================================ */

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  c = -1
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'latin1')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * 解码 PNG → { width, height, data: Buffer(RGBA) }
 *
 * 必须支持调色板 + 低位深：原版贴图大量使用 colorType=3、bitDepth=4
 * （每字节塞两个索引）来省体积，只处理 8 位/RGBA 的解码器会在第一步就崩。
 * 这也是为什么这个文件里没有用任何图片库 —— 需求太窄，自己写更可控。
 */
function decodePngBuffer(buf, label) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG：${label}`)

  let pos = 8
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  let palette = null, trns = null
  const idat = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') {
      palette = Buffer.from(data)
    } else if (type === 'tRNS') {
      trns = Buffer.from(data)
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') break
    pos += 12 + len
  }

  if (interlace !== 0) throw new Error(`不支持隔行扫描：${label}`)

  const channelsFor = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channelsFor) throw new Error(`不支持的颜色类型 ${colorType}：${label}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))

  // 每行的字节数：位深 < 8 时多个像素共享一个字节，必须按位算
  const bitsPerPixel = channelsFor * bitDepth
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8)) // 过滤用的偏移单位

  // 反过滤
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      switch (filter) {
        case 0: break
        case 1: cur[x] = (cur[x] + a) & 0xff; break
        case 2: cur[x] = (cur[x] + b) & 0xff; break
        case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          cur[x] = (cur[x] + pred) & 0xff
          break
        }
        default: throw new Error(`未知过滤器 ${filter}：${label}`)
      }
    }
    cur.copy(out, y * stride)
    prev = cur
  }

  // 按位深读取第 i 个样本（原样值，尚未归一化到 0..255）
  const readSample = (row, index) => {
    if (bitDepth === 8) return out[row * stride + index]
    if (bitDepth === 16) return (out[row * stride + index * 2] << 8) | out[row * stride + index * 2 + 1]
    const perByte = 8 / bitDepth
    const bytePos = Math.floor(index / perByte)
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (out[row * stride + bytePos] >> shift) & ((1 << bitDepth) - 1)
  }
  // 把样本值缩放到 0..255：8 位本来就对，16 位右移 8，低位深按位深比例放大
  const toByte = bitDepth === 8
    ? (v) => v
    : bitDepth === 16
      ? (v) => v >> 8
      : (v) => Math.round(v * (255 / ((1 << bitDepth) - 1)))

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4
      if (colorType === 3) {
        // 调色板：样本值是 PLTE 的下标，不是颜色
        const pi = readSample(y, x)
        const pa = trns && pi < trns.length ? trns[pi] : 255
        rgba[d] = palette[pi * 3]
        rgba[d + 1] = palette[pi * 3 + 1]
        rgba[d + 2] = palette[pi * 3 + 2]
        rgba[d + 3] = pa
      } else if (colorType === 0) {
        const v = toByte(readSample(y, x))
        rgba[d] = rgba[d + 1] = rgba[d + 2] = v; rgba[d + 3] = 255
      } else if (colorType === 4) {
        const v = toByte(readSample(y, x * 2))
        const al = toByte(readSample(y, x * 2 + 1))
        rgba[d] = rgba[d + 1] = rgba[d + 2] = v; rgba[d + 3] = al
      } else if (colorType === 2) {
        rgba[d] = toByte(readSample(y, x * 3))
        rgba[d + 1] = toByte(readSample(y, x * 3 + 1))
        rgba[d + 2] = toByte(readSample(y, x * 3 + 2))
        rgba[d + 3] = 255
      } else {
        rgba[d] = toByte(readSample(y, x * 4))
        rgba[d + 1] = toByte(readSample(y, x * 4 + 1))
        rgba[d + 2] = toByte(readSample(y, x * 4 + 2))
        rgba[d + 3] = toByte(readSample(y, x * 4 + 3))
      }
    }
  }
  return { width, height, data: rgba }
}

/** 编码 RGBA Buffer → PNG */
function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0  // compression
  ihdr[11] = 0  // filter
  ihdr[12] = 0  // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从 16×N 的动画贴图里取第一帧（顶部 16×16） */
function firstFrame(img, tile = TILE) {
  if (img.height <= tile && img.width === tile) return img
  const out = Buffer.alloc(tile * tile * 4)
  const rows = Math.min(tile, img.height)
  for (let y = 0; y < rows; y++) {
    img.data.copy(out, y * tile * 4, y * img.width * 4, y * img.width * 4 + tile * 4)
  }
  return { width: tile, height: tile, data: out }
}

/** 给灰度贴图上色：逐像素乘目标色（保持原有明暗层次） */
function applyTint(img, color) {
  const tr = (color >> 16) & 0xff
  const tg = (color >> 8) & 0xff
  const tb = color & 0xff
  const out = Buffer.from(img.data)
  for (let i = 0; i < img.width * img.height; i++) {
    const d = i * 4
    // 原版染色是「贴图灰度(0..1) × 群系色」，这里等价于按 255 归一后相乘
    out[d] = Math.min(255, Math.round((out[d] / 255) * tr))
    out[d + 1] = Math.min(255, Math.round((out[d + 1] / 255) * tg))
    out[d + 2] = Math.min(255, Math.round((out[d + 2] / 255) * tb))
  }
  return { width: img.width, height: img.height, data: out }
}

/**
 * 把 overlay 用 alpha-over 叠到 base 上。
 * 草方块侧面的草边层是半透明的，直接覆盖会丢底下的泥土纹理。
 */
function alphaOver(base, overlay) {
  const out = Buffer.from(base.data)
  for (let i = 0; i < base.width * base.height; i++) {
    const d = i * 4
    const sa = overlay.data[d + 3] / 255
    if (sa === 0) continue
    out[d] = Math.round(overlay.data[d] * sa + out[d] * (1 - sa))
    out[d + 1] = Math.round(overlay.data[d + 1] * sa + out[d + 1] * (1 - sa))
    out[d + 2] = Math.round(overlay.data[d + 2] * sa + out[d + 2] * (1 - sa))
    out[d + 3] = Math.max(out[d + 3], overlay.data[d + 3])
  }
  return { width: base.width, height: base.height, data: out }
}

/* ============================================================
 * 主流程
 * ============================================================ */

function parseArgs(argv) {
  const out = { jar: null, pack: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--jar') out.jar = argv[++i]
    else if (argv[i] === '--pack' || argv[i] === '--zip') out.pack = argv[++i]
    else if (!out.pack && !out.jar) out.pack = argv[i]
  }
  return out
}

/** 找可用的官方 jar。显式指定的优先，否则按候选表逐个试。 */
function resolveJar(explicit) {
  const candidates = explicit ? [explicit, ...JAR_CANDIDATES] : JAR_CANDIDATES
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  if (explicit) throw new Error(`指定的 jar 不存在：${explicit}`)
  throw new Error(
    `找不到本机 Minecraft 客户端 jar。请在命令行显式指定：\n` +
    `  node tools/build-textures.mjs --jar "<路径>/1.21.1.jar"\n` +
    `已尝试过：\n${JAR_CANDIDATES.map((c) => '  ' + c).join('\n')}`
  )
}

const main = () => {
  const args = parseArgs(process.argv.slice(2))

  const jarPath = resolveJar(args.jar)
  const { reader: jarReader, prefix: jarPrefix } = openReader(jarPath)
  console.log(`[tex] 官方 jar： ${jarPath}`)

  // 可选：材质包覆盖贴图。模型/方框数据永远来自 jar
  // （材质包不该改变「哪个面用哪张图」这件事，只该改变图长什么样）。
  let packReader = null
  let packPrefix = ''
  if (args.pack) {
    const opened = openReader(args.pack)
    packReader = opened.reader
    packPrefix = opened.prefix
    console.log(`[tex] 材质包覆盖：${args.pack}`)
  }

  /** 读一张贴图：材质包优先，jar 兜底。入参一律是短名。 */
  const readTexture = (texName) => {
    const short = shortTexName(texName)
    const rel = `textures/block/${short}.png`
    if (packReader?.has(`${packPrefix}${rel}`)) {
      const b = packReader.read(`${packPrefix}${rel}`)
      if (b) return { buf: b, from: 'pack' }
    }
    if (jarReader.has(`${jarPrefix}${rel}`)) {
      const b = jarReader.read(`${jarPrefix}${rel}`)
      if (b) return { buf: b, from: 'jar' }
    }
    return null
  }

  // ---- 逐个方块解析出三面贴图 ----
  const blockFaceMap = {}
  const resolveErrors = []
  const allTextures = new Set()

  for (const block of BLOCKS) {
    // 液体这类「引擎渲染、模型里没有面定义」的，直接用覆盖表
    if (FACE_OVERRIDE[block]) {
      blockFaceMap[block] = { ...FACE_OVERRIDE[block] }
      for (const v of Object.values(FACE_OVERRIDE[block])) allTextures.add(v)
      continue
    }

    const blockId = BLOCK_ID_OVERRIDE[block] ?? block
    const r = resolveBlockFaces(blockId, jarPrefix, jarReader)
    if (r.error) {
      resolveErrors.push(`${block}（${blockId}）：${r.error}`)
      continue
    }
    const entry = {
      top: r.top,
      side: r.side,
      bottom: r.bottom,
    }
    if (!entry.top || !entry.side || !entry.bottom) {
      resolveErrors.push(`${block}（${blockId}）：模型里解析不出完整的 top/side/bottom（得到 ${JSON.stringify(entry)}）`)
      continue
    }
    blockFaceMap[block] = entry
    // 侧面若有叠加层（草方块），一并记下来，等下一并读图
    for (const k of ['top', 'side', 'bottom']) allTextures.add(entry[k])
    if (r.sideOverlay) allTextures.add(r.sideOverlay)
  }

  if (resolveErrors.length) {
    console.error(`\n[tex] ${resolveErrors.length} 个方块解析失败：`)
    for (const e of resolveErrors) console.error(`  - ${e}`)
    console.error('\n这通常意味着清单里的方块名与 jar 版本不符（例如 1.17 之前没有 deepslate）。')
    process.exit(1)
  }
  console.log(`[tex] 解析出 ${Object.keys(blockFaceMap).length} 个方块的贴图映射`)

  // ---- 合成：草方块侧面 = base + overlay ----
  const compositeTargets = new Map() // 合成图名 → [base, overlay]
  for (const [name, parts] of Object.entries(COMPOSITE)) {
    const [base, overlay] = parts
    // 只在两个素材都存在时才合成
    if (allTextures.has(base) && allTextures.has(overlay)) {
      compositeTargets.set(name, parts)
    }
  }

  // ---- 逐张读图、染色、合成 ----
  const images = new Map()
  const missing = []
  const tinted = []
  const composed = []
  const sourceStats = { jar: 0, pack: 0 }

  for (const tex of allTextures) {
    if (compositeTargets.has(tex)) continue // 由下面统一合成，不单独读
    const got = readTexture(tex)
    if (!got) { missing.push(tex); continue }
    sourceStats[got.from]++
    let img = firstFrame(decodePngBuffer(got.buf, tex))
    if (TINT[tex] !== undefined) {
      img = applyTint(img, TINT[tex])
      tinted.push(tex)
    }
    images.set(tex, img)
  }

  // 合成：把 overlay 叠到 base 上，结果存成 base 的名字（映射表里引用的就是 base）
  for (const [name, [base, overlay]] of compositeTargets) {
    let baseImg = images.get(base)
    if (!baseImg) {
      // base 还没读过（它在 allTextures 里，理论上已经读了；防御性补读一次）
      const got = readTexture(base)
      if (!got) { missing.push(base); continue }
      baseImg = firstFrame(decodePngBuffer(got.buf, base))
      images.set(base, baseImg)
    }
    const gotOverlay = readTexture(overlay)
    if (!gotOverlay) { missing.push(overlay); continue }
    sourceStats[gotOverlay.from]++
    let overImg = firstFrame(decodePngBuffer(gotOverlay.buf, overlay))
    if (TINT[overlay] !== undefined) {
      overImg = applyTint(overImg, TINT[overlay])
      if (!tinted.includes(overlay)) tinted.push(overlay)
    }
    images.set(name, alphaOver(baseImg, overImg))
    composed.push(`${name} = ${base} + ${overlay}`)
    // 不再需要的 overlay 贴图从图集里去掉，省一格
    images.delete(overlay)
  }

  if (composed.length) console.log(`[tex] 合成 ${composed.length} 张：${composed.join('；')}`)
  if (tinted.length) console.log(`[tex] 已染色 ${tinted.length} 张：${tinted.join(', ')}`)

  if (missing.length) {
    const uniq = [...new Set(missing)]
    console.error(`\n[tex] 缺失 ${uniq.length} 张贴图：`)
    for (const m of uniq) console.error(`  - ${m}`)
    console.error('\n请检查 jar / 材质包是否完整，或核对 BLOCKS 清单。')
    process.exit(1)
  }

  // ---- 拼图集 ----
  const tileCount = images.size
  const rows = Math.ceil(tileCount / COLS)
  const atlasW = COLS * TILE
  const atlasH = rows * TILE
  const atlas = Buffer.alloc(atlasW * atlasH * 4) // 全透明打底

  const uvMap = {}
  let idx = 0
  for (const [name, img] of images) {
    const cx = (idx % COLS) * TILE
    const cy = Math.floor(idx / COLS) * TILE
    for (let y = 0; y < TILE; y++) {
      img.data.copy(
        atlas,
        ((cy + y) * atlasW + cx) * 4,
        y * img.width * 4,
        y * img.width * 4 + TILE * 4
      )
    }
    // UV 用像素坐标记录，运行时换算成 0..1，避免浮点误差累积
    uvMap[name] = { x: cx, y: cy, w: TILE, h: TILE }
    idx++
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(OUT_ATLAS, encodePng(atlasW, atlasH, atlas))

  // 映射表里的贴图名已经是短名（resolveBlockFaces 里归一化过），直接输出
  const blocksOut = {}
  for (const [block, v] of Object.entries(blockFaceMap)) {
    const top = shortTexName(v.top)
    const side = shortTexName(v.side)
    const bottom = shortTexName(v.bottom)
    blocksOut[block] = { top, side, bottom, all: side }
  }

  const out = {
    tile: TILE,
    cols: COLS,
    atlasWidth: atlasW,
    atlasHeight: atlasH,
    tileCount,
    /** 数据来源，便于事后核对该换没换 jar */
    source: {
      jar: path.basename(jarPath),
      pack: args.pack ? path.basename(args.pack) : null,
      tilesFromJar: sourceStats.jar,
      tilesFromPack: sourceStats.pack,
    },
    textures: uvMap,
    blocks: blocksOut,
  }
  fs.writeFileSync(OUT_MAP, JSON.stringify(out, null, 2))

  const kb = (fs.statSync(OUT_ATLAS).size / 1024).toFixed(1)
  console.log(`[tex] 图集：${atlasW}×${atlasH}，${tileCount} 格，${kb} KB`)
  console.log(`[tex] 贴图来源：jar ${sourceStats.jar} 张${sourceStats.pack ? `，材质包 ${sourceStats.pack} 张` : ''}`)
  console.log(`[tex] 输出：${path.relative(ROOT, OUT_ATLAS)}`)
  console.log(`[tex] 映射：${path.relative(ROOT, OUT_MAP)}`)
}

main()
