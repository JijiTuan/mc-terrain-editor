/**
 * world-save.js — 「打开存档 / 保存到存档」的界面流程
 *
 * 与 io/ 那层的关系：io/ 只管格式，这里管「跟用户来回对话」——
 * 选哪个存档、编辑哪一片区域、多高、写到哪个维度、写之前确认什么。
 *
 * ── 一个必须讲清楚的限制 ──
 * 编辑器世界有固定尺寸（比如 64×48×64），而存档是无限的。
 * 所以「打开存档」本质是**截取一个窗口**：横向 N×N 个区块、纵向一段高度。
 * 这件事必须让用户显式参与，不能悄悄替他决定 ——
 * 否则他打开存档看到一片空地，会以为存档读坏了。
 *
 * ── 写回为什么危险，界面要怎么处理 ──
 * 写回会**真实修改游戏存档**。用户可能开着游戏、可能没备份。
 * 所以这里做三件事：
 *   1. 写回前弹确认，明确列出「哪些区块会被改」
 *   2. 提示先关掉游戏（游戏运行时会把内存里的区块刷回去，覆盖我们的修改）
 *   3. 主进程侧自动备份原 .mca（.bak-时间戳）
 */

import { openModal, closeModal } from './modal.js'
import { importWorldWindow, buildChunkReplacements, CHUNK } from '../io/world-io.js'
// anvil 静态引入一次即可 —— 之前写回时又动态 import 了一遍，
// Vite 会警告「同一模块既静态又动态引入」，chunk 拆分也变得不可预测。
import { readLevelDat, parseRegion, readChunkNbt, writeRegion } from '../io/anvil.js'

/** 桌面版才有存档读写能力（网页版拿不到任意路径） */
export function worldSaveSupported() {
  return Boolean(window.desktop?.world)
}

/**
 * 「打开存档」主流程。
 * @param {object} app
 */
export async function openWorldSave(app) {
  if (!worldSaveSupported()) {
    app.toast('网页版无法直接读写游戏存档，请用桌面版', 'warn')
    return
  }

  const picked = await window.desktop.world.pickSave()
  if (picked.canceled) return
  if (picked.error) {
    openModal(app, {
      title: '这个文件夹不是存档',
      body: `<div class="form-row desc" style="white-space:pre-wrap">${escapeHtml(picked.error)}</div>`,
      actions: [{ label: '知道了', primary: true, close: true }],
    })
    return
  }

  app.mcSave = { dir: picked.dir }

  // 读 level.dat 拿世界信息，同时验证它真的能解析
  let info = null
  const ld = await window.desktop.world.readLevelDat(picked.dir)
  if (ld.ok) {
    try {
      info = await readLevelDat(ld.data)
    } catch (err) {
      app.toast(`level.dat 解析失败：${err.message}`, 'warn')
    }
  } else {
    app.toast(`读不到 level.dat：${ld.error}`, 'error')
    return
  }

  const dimsRes = await window.desktop.world.listDimensions(picked.dir)
  const dims = dimsRes.dims ?? []
  if (!dims.length) {
    app.toast('这个存档里没有任何 region 文件，没有可编辑的地形', 'warn')
    return
  }

  showWindowDialog(app, info, dims)
}

/** 第二屏：选维度 + 选区窗口尺寸 */
function showWindowDialog(app, info, dims) {
  const versionText = info.versionName
    ? `${info.versionName}（数据版本 ${info.dataVersion ?? '?'}）`
    : `数据版本 ${info.dataVersion ?? '未知'}`
  const saved = app.lastWindow ?? { chunks: 4, y: 64, height: 48 }

  openModal(app, {
    title: '打开存档 · 选择编辑范围',
    body: `
      <div class="form-row"><label>存档</label>
        <div class="desc" style="font-size:12px;color:#e6ecf5">${escapeHtml(info.levelName)}</div>
        <div class="desc" style="font-family:monospace;font-size:10.5px;word-break:break-all">${escapeHtml(app.mcSave.dir)}</div>
        <div class="desc">版本：${escapeHtml(versionText)}${info.spawn ? `　出生点 (${info.spawn.x}, ${info.spawn.z})` : ''}</div>
      </div>

      <div class="form-row"><label>维度</label>
        <select id="ws-dim">
          ${dims.map((d) => `<option value="${d.sub}">${escapeHtml(d.label)}（${d.regionCount} 个区域文件）</option>`).join('')}
        </select>
        <div class="desc">下界和末地的坐标是独立的，跟主世界对不上。</div>
      </div>

      <div class="form-row"><label>横向范围</label>
        <select id="ws-chunks">
          <option value="2">2×2 区块（32×32 格）</option>
          <option value="4" selected>4×4 区块（64×64 格）</option>
          <option value="6">6×6 区块（96×96 格）</option>
          <option value="8">8×8 区块（128×128 格）</option>
        </select>
        <div class="desc">编辑器世界是固定尺寸的，所以只能一次截取一块。
        想改别处，改完这次再打开另一个窗口。</div>
      </div>

      <div class="form-row"><label>高度范围</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ws-y" type="number" value="${saved.y}" style="width:100px" title="底部 Y 坐标">
          <span class="desc" style="margin:0">起，向上</span>
          <input id="ws-height" type="number" value="${saved.height}" style="width:100px" title="高度">
          <span class="desc" style="margin:0">格</span>
        </div>
        <div class="desc">1.18+ 主世界 Y 范围 -64 ~ 320。地表一般在 60~80 之间；
        改成 -64 起 384 格能拿到完整高度，但很吃内存。</div>
      </div>

      <div class="form-row"><label>起始位置</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="ws-cx" type="number" value="${saved.cx ?? 0}" style="width:100px" title="起始区块 X">
          <input id="ws-cz" type="number" value="${saved.cz ?? 0}" style="width:100px" title="起始区块 Z">
        </div>
        <div class="desc">区块坐标。出生点大约在区块 (${Math.floor((info.spawn?.x ?? 0) / 16)}, ${Math.floor((info.spawn?.z ?? 0) / 16)})。</div>
      </div>

      <div class="form-row"><label style="color:#ffd166">只读打开是安全的</label>
        <div class="desc">这一步只是把地形读进编辑器，<b>不会改动存档</b>。
        要写回你得另外点「保存到存档」，那时才会弹确认。</div>
      </div>
    `,
    actions: [
      { label: '取消', close: true },
      { label: '读取', primary: true, close: true, onClick: () => doImportWindow(app) },
    ],
  })
}

async function doImportWindow(app) {
  const g = (id) => document.getElementById(id)
  const sub = g('ws-dim')?.value ?? ''
  const chunks = Number(g('ws-chunks')?.value ?? 4)
  const minY = Number(g('ws-y')?.value ?? 64)
  const height = Number(g('ws-height')?.value ?? 48)
  const cx = Number(g('ws-cx')?.value ?? 0)
  const cz = Number(g('ws-cz')?.value ?? 0)

  if (!(height >= 1 && height <= 512)) {
    app.toast('高度要在 1 ~ 512 之间', 'warn')
    return
  }

  app.lastWindow = { chunks, y: minY, height, cx, cz }

  // 进度提示：读一个 8×8 的窗口要解 64 个 chunk，不提示会以为卡死。
  // 注意 app.toast 没有返回句柄，所以只能分阶段提示，不能逐块更新百分比。
  app.toast('正在读取存档…', 'ok')

  try {
    const dir = app.mcSave.dir
    const { world, report } = await importWorldWindow({
      readRegion: async (rx, rz) => {
        const r = await window.desktop.world.readRegion(dir, sub, rx, rz)
        return r.ok ? r.data : null
      },
      minChunkX: cx, minChunkZ: cz, chunksX: chunks, chunksZ: chunks,
      minY, height,
    })

    if (world.stats().solid === 0) {
      app.toast('这个范围里全是空气 —— 检查一下起始区块和高度范围对不对', 'warn')
    }

    // 记下来源，供写回时用
    app.mcSave.dim = sub
    app.mcSave.minChunkX = cx
    app.mcSave.minChunkZ = cz
    app.mcSave.minY = minY

    app.replaceWorld(world, `存档 ${report.size.w}×${report.size.h}×${report.size.d}`)
    showImportReport(app, report, `${app.mcSave.dir} · ${chunks}×${chunks} 区块 · Y ${minY}~${minY + height - 1}`)
  } catch (err) {
    app.toast(`读取存档失败：${err.message}`, 'error')
  }
}

function showImportReport(app, report, label) {
  let html = `<div class="form-row"><label>来源</label>
    <div class="desc" style="font-family:monospace;font-size:10.5px;word-break:break-all">${escapeHtml(label)}</div></div>
    <div class="form-row"><table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr><td style="color:#a8b6cc;padding:3px 0">尺寸</td>
          <td style="text-align:right;font-family:monospace">${report.size.w}×${report.size.h}×${report.size.d}</td></tr>
      <tr><td style="color:#a8b6cc;padding:3px 0">实体方块</td>
          <td style="text-align:right;font-family:monospace">${report.totalBlocks.toLocaleString()}</td></tr>
      <tr><td style="color:#a8b6cc;padding:3px 0">用到的方块种类</td>
          <td style="text-align:right;font-family:monospace">${report.palette.length}</td></tr>
    </table></div>`

  if (report.approxBlocks.length) {
    html += `<div class="form-row"><label>已近似替代（${report.approxBlocks.length} 种）</label>
      <div class="desc" style="font-family:monospace;max-height:110px;overflow:auto">${report.approxBlocks.slice(0, 60).map(escapeHtml).join('、')}${report.approxBlocks.length > 60 ? ' …' : ''}</div>
      <div class="desc">这些方块编辑器没有对应的贴图，用最接近的一种代替了。写回存档时也会写成替代后的方块。</div></div>`
  }
  if (report.unknownBlocks.length) {
    html += `<div class="form-row"><label style="color:#ffd166">未识别、已丢弃（${report.unknownBlocks.length} 种）</label>
      <div class="desc" style="font-family:monospace;max-height:110px;overflow:auto">${report.unknownBlocks.slice(0, 60).map(escapeHtml).join('、')}${report.unknownBlocks.length > 60 ? ' …' : ''}</div>
      <div class="desc">这些方块的位置在编辑器里会变成空气。<b>如果接着写回存档，它们会被真的抹掉</b> —— 编辑器不知道它们原本是什么。</div></div>`
  }
  if (report.unsupported.length) {
    html += `<div class="form-row"><label style="color:#ffd166">解析时的提醒</label>
      <div class="desc">${report.unsupported.slice(0, 8).map(escapeHtml).join('<br>')}</div></div>`
  }

  html += `<div class="form-row"><label>接下来</label>
    <div class="desc">直接编辑就行。改完点顶栏「<b>保存到存档</b>」写回游戏。
    写回前会自动备份原 region 文件。</div></div>`

  openModal(app, {
    title: '已读入存档',
    body: html,
    actions: [{ label: '开始编辑', primary: true, close: true }],
  })
}

/**
 * 「保存到存档」流程。
 * 这里是最需要谨慎的地方：会真实改动玩家的存档。
 */
export async function saveToWorldSave(app) {
  if (!worldSaveSupported()) {
    app.toast('网页版无法写回存档，请用桌面版', 'warn')
    return
  }
  if (!app.mcSave?.dir) {
    app.toast('当前世界不是从存档打开的，没有可写回的目标', 'warn')
    return
  }

  const sel = app.selection
  const region = sel
    ? { x1: Math.min(sel.x1, sel.x2), y1: Math.min(sel.y1, sel.y2), z1: Math.min(sel.z1, sel.z2),
        x2: Math.max(sel.x1, sel.x2), y2: Math.max(sel.y1, sel.y2), z2: Math.max(sel.z1, sel.z2) }
    : { x1: 0, y1: 0, z1: 0, x2: app.world.width - 1, y2: app.world.height - 1, z2: app.world.depth - 1 }

  // 算出会被触碰的区块列表，让用户看到确切范围
  const c0x = Math.floor(region.x1 / CHUNK) + app.mcSave.minChunkX
  const c1x = Math.floor(region.x2 / CHUNK) + app.mcSave.minChunkX
  const c0z = Math.floor(region.z1 / CHUNK) + app.mcSave.minChunkZ
  const c1z = Math.floor(region.z2 / CHUNK) + app.mcSave.minChunkZ
  const chunkCount = (c1x - c0x + 1) * (c1z - c0z + 1)

  const absYMin = app.mcSave.minY + region.y1
  const absYMax = app.mcSave.minY + region.y2

  openModal(app, {
    title: '保存到存档',
    body: `
      <div class="form-row"><label style="color:#ff6b6b">这会真的改动游戏存档</label>
        <div class="desc" style="color:#ffb4b4">
          下面列出的区块会被重写。原文件会自动备份成
          <code>.mca.bak-时间戳</code>，但请你理解这一步是真的在动存档。
        </div></div>

      <div class="form-row"><label>写入范围</label>
        <div class="desc">${sel ? '仅当前选区' : '整个世界（没有选区）'}</div>
        <div class="desc" style="font-family:monospace;font-size:11px">
          世界坐标 X ${region.x1}~${region.x2}　Y ${absYMin}~${absYMax}　Z ${region.z1}~${region.z2}
        </div></div>

      <div class="form-row"><label>将重写 ${chunkCount} 个区块</label>
        <div class="desc" style="font-family:monospace;font-size:11px">
          区块 X ${c0x}~${c1x}　Z ${c0z}~${c1z}
        </div>
        <div class="desc">每个区块只重写方块数据，箱子里装的东西、实体、光照都保留不动。</div></div>

      <div class="form-row"><label style="color:#ffd166">先做这件事</label>
        <div class="desc">
          <b>把 Minecraft 关掉。</b>游戏运行时会把内存里的区块写回磁盘，
          我们写进去的改动会被它覆盖掉（或者更糟，两边互相覆盖）。
        </div></div>
    `,
    actions: [
      { label: '取消', close: true },
      { label: '确认写入', primary: true, close: true, onClick: () => doSave(app, region, { c0x, c1x, c0z, c1z }) },
    ],
  })
}

async function doSave(app, region, bounds) {
  app.toast('正在写入存档…', 'ok')
  const { dir, dim, minChunkX, minChunkZ, minY } = app.mcSave

  try {
    // 缓存读过的 region，避免同一个文件被反复读
    const regionCache = new Map()
    const loadRegion = async (rx, rz) => {
      const k = `${rx},${rz}`
      if (regionCache.has(k)) return regionCache.get(k)
      const r = await window.desktop.world.readRegion(dir, dim, rx, rz)
      const val = { bytes: r.ok ? r.data : null, dirty: false }
      regionCache.set(k, val)
      return val
    }

    // 找一个 chunk 的原始 NBT（用来保留方块以外的字段）
    const readChunk = async (cx, cz) => {
      const rx = Math.floor(cx / 32)
      const rz = Math.floor(cz / 32)
      const lcx = ((cx % 32) + 32) % 32
      const lcz = ((cz % 32) + 32) % 32
      const reg = await loadRegion(rx, rz)
      if (!reg.bytes) return null
      const entries = parseRegion(reg.bytes)
      const e = entries.find((x) => x.cx === lcx && x.cz === lcz)
      if (!e?.raw) return null
      const nbt = await readChunkNbt(e)
      return { root: nbt.root, rootName: nbt.rootName }
    }

    const replacements = await buildChunkReplacements({
      world: app.world, region, minChunkX, minChunkZ, minY, readChunk,
    })

    // 按 region 归组，一个 region 只写一次盘
    const byRegion = new Map()
    for (const [key, val] of replacements) {
      const [cx, cz] = key.split(',').map(Number)
      const rx = Math.floor(cx / 32)
      const rz = Math.floor(cz / 32)
      const rk = `${rx},${rz}`
      if (!byRegion.has(rk)) byRegion.set(rk, { rx, rz, items: [] })
      byRegion.get(rk).items.push({ cx, cz, val })
    }

    let written = 0
    const backups = []
    for (const [rk, grp] of byRegion) {
      const reg = await loadRegion(grp.rx, grp.rz)
      const repl = new Map(grp.items.map((it) => [`${localChunkCoord(it.cx)},${localChunkCoord(it.cz)}`, it.val]))
      const out = writeRegion(reg.bytes, repl)

      const res = await window.desktop.world.writeRegion(dir, dim, grp.rx, grp.rz, out)
      if (!res.ok) throw new Error(`写 ${rk} 失败：${res.error}`)
      if (res.backupPath) backups.push(res.backupPath)
      written++
    }

    app.mcSave.dirty = false
    app.toast(`已写入 ${replacements.size} 个区块、${byRegion.size} 个区域文件`, 'ok')

    if (backups.length) {
      openModal(app, {
        title: '已写入存档',
        body: `
          <div class="form-row"><label>结果</label>
            <div class="desc">重写了 <b>${replacements.size}</b> 个区块，涉及 <b>${byRegion.size}</b> 个区域文件。</div></div>
          <div class="form-row"><label>备份</label>
            <div class="desc">原文件已备份，想回退就把备份改名回原来的名字：</div>
            <div class="desc" style="font-family:monospace;font-size:10.5px;max-height:140px;overflow:auto;white-space:pre-wrap">${backups.map(escapeHtml).join('\n')}</div></div>
          <div class="form-row"><label>下一步</label>
            <div class="desc">启动游戏进存档看看。如果地形没变，多半是写入时游戏还开着 ——
            关掉游戏再写一次。</div></div>
        `,
        actions: [{ label: '知道了', primary: true, close: true }],
      })
    }
  } catch (err) {
    app.toast(`写入存档失败：${err.message}`, 'error')
  }
}

/**
 * 启动时提示「上次编辑的存档」。
 * 只在真的存在且还是有效存档时提示，避免用户删了存档后每次启动都弹。
 */
export async function offerReopenSave(app) {
  if (!worldSaveSupported()) return
  try {
    const saved = await window.desktop.world.savedSave()
    if (!saved?.valid) return
    const ld = await window.desktop.world.readLevelDat(saved.dir)
    let name = saved.dir
    if (ld.ok) {
      try { name = (await readLevelDat(ld.data)).levelName } catch { /* 用路径兜底 */ }
    }
    openModal(app, {
      title: '上次编辑的存档',
      body: `<div class="form-row desc">检测到上次打开的存档：<br>
        <b>${escapeHtml(name)}</b><br>
        <span style="font-family:monospace;font-size:10.5px;word-break:break-all">${escapeHtml(saved.dir)}</span></div>`,
      actions: [
        { label: '不用了', close: true, onClick: () => window.desktop.world.forgetSave() },
        { label: '打开', primary: true, close: true, onClick: () => openWorldSave(app) },
      ],
    })
  } catch { /* 提示失败不影响使用 */ }
}

/**
 * 绝对 chunk 坐标 → region 内的局部坐标（0~31）。
 * 必须用「先取模再补正」而不是 `& 31` —— 后者对负数虽然结果恰好也对
 * （补码特性），但语义晦涩，读到的人会怀疑它错了。
 */
function localChunkCoord(c) {
  return ((c % 32) + 32) % 32
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
