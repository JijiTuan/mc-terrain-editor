/**
 * toolbar.js — 左侧工具面板
 *
 * 面板的分区顺序是按「用到的先后」排的，不是按功能重要性：
 *
 *   1. 操作模式   ← 进编辑器第一个要决定的事
 *   2. 工具       ← 决定这一笔是放、删、还是框选
 *   3. 方块       ← 放什么（方块模式的全部参数就这一个）
 *   4. 笔刷参数   ← 只在笔刷模式下出现，否则整块隐藏
 *   5. 区域操作 / 地形生成 / 视图
 *
 * 关键取舍：笔刷参数整块跟着模式隐藏，而不是「灰掉但仍占位置」。
 * 方块模式下用户根本碰不到形状和半径，让它们占着屏幕只是在制造噪音 ——
 * Blockbench 的工具面板之所以清爽，就是因为它只显示当前上下文需要的东西。
 *
 * 全部用原生 DOM 构建，不引入框架：
 * 面板的更新是"整体重建"，因为控件数量只有几十个，
 * 重建成本远低于维护一套细粒度 diff 逻辑的复杂度。
 */

import { BLOCK_BY_ID, DEFAULT_PALETTE, CATEGORY_LABELS, AIR } from '../data/blocks.js'
import { BrushMode, BrushShape, SHAPE_LABELS, MODE_LABELS } from '../core/brushes.js'
import { regionVolume, normalizeRegion } from '../core/regions.js'
import { InputMode, Tool } from './interaction.js'
import { openModal, closeModal } from './modal.js'

/** 方块模式的工具档位 */
const BLOCK_TOOLS = [
  { id: Tool.PLACE, label: '放置', key: '左键', icon: '▣' },
  { id: Tool.ERASE, label: '删除', key: 'Alt+左键', icon: '⌫' },
]

/** 两种模式共有的工具档位 */
const SHARED_TOOLS = [
  { id: Tool.SELECT, label: '框选', key: 'R', icon: '⬚' },
  { id: Tool.EYEDROPPER, label: '吸管', key: 'Q', icon: '⊙' },
]

export function buildToolbar(app) {
  const s = app.state
  const el = app.el.toolbar
  el.innerHTML = ''

  el.appendChild(sectionMode(app))
  el.appendChild(sectionTool(app))
  el.appendChild(sectionBlock(app))
  if (s.inputMode === InputMode.BRUSH) el.appendChild(sectionBrush(app))
  el.appendChild(sectionRegion(app))
  el.appendChild(sectionTerrain(app))
  el.appendChild(sectionView(app))
}

/** 1. 操作模式：整个面板的开关，放最上面 */
function sectionMode(app) {
  const s = app.state
  const box = panel('操作模式', '<span class="hint">V / B 切换</span>', 'mode')
  const seg = div('seg mode-seg')

  const block = button('▣ 方块模式', s.inputMode === InputMode.BLOCK)
  block.title = '左键放一格 · Alt+左键删一格（Blockbench 手感）'
  block.onclick = () => app.setInputMode(InputMode.BLOCK)
  seg.appendChild(block)

  const brush = button('✎ 笔刷模式', s.inputMode === InputMode.BRUSH)
  brush.title = '左键拖拽涂抹一片（球形/立方体等）'
  brush.onclick = () => app.setInputMode(InputMode.BRUSH)
  seg.appendChild(brush)

  box.appendChild(seg)
  box.appendChild(note(s.inputMode === InputMode.BLOCK
    ? '左键点一下放一块，<b>Alt+左键</b>删一块。按住左键拖动可以连续铺。<br>右键拖拽转视角，中键平移，滚轮缩放。'
    : '左键拖拽涂抹。<b>Alt+左键</b>临时转视角，右键拖拽转视角。'))
  return box
}

/** 2. 工具档位：随模式变化 */
function sectionTool(app) {
  const s = app.state
  const isBlock = s.inputMode === InputMode.BLOCK
  const box = panel('工具', `<span class="hint">${isBlock ? '左键点击视口' : '左键拖拽视口'}</span>`)
  const seg = div('seg tool-seg')

  // 笔刷模式下没有「放置/删除」档位：放什么由笔刷模式（放置/替换/删除/抬升…）决定
  const tools = isBlock ? [...BLOCK_TOOLS, ...SHARED_TOOLS] : SHARED_TOOLS
  const visible = isBlock || s.tool === Tool.SELECT || s.tool === Tool.EYEDROPPER
  const current = visible ? s.tool : null

  for (const t of tools) {
    const b = button(`${t.icon} ${t.label}`, current === t.id)
    b.title = `${t.label}（${t.key}）`
    // 快捷键角标：Blockbench 风格里键位提示直接长在按钮上，
    // 用户不用悬停就能学会键盘操作。
    const k = document.createElement('span')
    k.className = 'hotkey'
    k.textContent = t.key
    b.appendChild(k)
    b.onclick = () => app.setTool(t.id)
    seg.appendChild(b)
  }
  box.appendChild(seg)

  if (s.tool === Tool.SELECT) {
    box.appendChild(note('在视口中按住左键拖出一个立方体区域，松手完成。拖拽期间不要松开左键。'))
  } else if (s.tool === Tool.EYEDROPPER) {
    box.appendChild(note('左键点击任意方块，把它设为当前要放置的方块。'))
  } else if (isBlock && s.tool === Tool.ERASE) {
    box.appendChild(note('当前是删除档：左键点哪删哪。想快速删一下也可以直接按 <b>Alt+左键</b>，不必切到这个档位。'))
  }
  return box
}

/** 3. 方块选择器 */
function sectionBlock(app) {
  const s = app.state
  const box = panel('放置的方块', '<span class="hint">点击选择</span>')

  const cur = BLOCK_BY_ID[s.blockId]
  const sel = div('selected-block')
  sel.innerHTML = `
    <div class="chip" style="background:${cssColor(cur.color)}"></div>
    <div>
      <div class="nm">${cur.label}</div>
      <div class="en">${cur.name}</div>
    </div>
  `
  box.appendChild(sel)

  // 分类筛选
  if (s.paletteCat === undefined) s.paletteCat = 'all'
  const cats = div('palette-cats')
  const catList = [['all', '全部'], ...Object.entries(CATEGORY_LABELS)]
  for (const [id, name] of catList) {
    const b = button(name, s.paletteCat === id)
    b.onclick = () => { s.paletteCat = id; buildToolbar(app) }
    cats.appendChild(b)
  }
  box.appendChild(cats)

  const grid = div('palette')
  const list = s.paletteCat === 'all'
    ? DEFAULT_PALETTE.map((n) => BLOCK_BY_ID.find((b) => b.name === n)).filter(Boolean)
    : BLOCK_BY_ID.filter((b) => b.id !== AIR && b.category === s.paletteCat)

  for (const b of list) {
    const sw = document.createElement('div')
    sw.className = 'swatch' + (b.id === s.blockId ? ' selected' : '')
    sw.style.background = cssColor(b.color)
    sw.dataset.label = b.label
    sw.title = `${b.label}（${b.name}）`
    sw.onclick = () => { s.blockId = b.id; buildToolbar(app) }
    grid.appendChild(sw)
  }
  box.appendChild(grid)

  const more = button(`浏览全部方块（共 ${BLOCK_BY_ID.length - 1} 种）`)
  more.style.width = '100%'
  more.style.marginTop = '7px'
  more.onclick = () => openBlockPicker(app)
  box.appendChild(more)
  return box
}

function openBlockPicker(app) {
  openModal(app, {
    title: '选择方块',
    body: buildPickerBody(app),
    actions: [{ label: '关闭', primary: true, close: true }],
    onOpen: (host) => {
      host.querySelectorAll('[data-block]').forEach((sw) => {
        sw.addEventListener('click', () => {
          app.state.blockId = Number(sw.dataset.block)
          closeModal(app)
          buildToolbar(app)
        })
      })
    },
  })
}

function buildPickerBody(app) {
  const groups = new Map()
  for (const b of BLOCK_BY_ID) {
    if (b.id === AIR) continue
    if (!groups.has(b.category)) groups.set(b.category, [])
    groups.get(b.category).push(b)
  }
  let html = ''
  for (const [cat, list] of groups) {
    html += `<div class="panel-title" style="margin-top:10px">${CATEGORY_LABELS[cat] ?? cat}</div><div class="palette">`
    for (const b of list) {
      html += `<div class="swatch" data-block="${b.id}" data-label="${b.label}" title="${b.label}（${b.name}）"
        style="background:${cssColor(b.color)};cursor:pointer"></div>`
    }
    html += '</div>'
  }
  return html
}

/** 4. 笔刷参数：只在笔刷模式下渲染 */
function sectionBrush(app) {
  const s = app.state
  const box = panel('笔刷参数', '')

  box.appendChild(slider('半径', s.size, 1, 31, 1, (v) => { s.size = v; buildToolbar(app) }, ' 格'))
  box.appendChild(slider('强度', s.strength, 0.1, 1, 0.05, (v) => { s.strength = v; buildToolbar(app) }, '', (v) => `${Math.round(v * 100)}%`))

  // 形状
  const shapeField = div('field')
  shapeField.appendChild(label('形状'))
  const shapes = div('seg')
  for (const sh of Object.values(BrushShape)) {
    const b = button(SHAPE_LABELS[sh], s.shape === sh)
    b.onclick = () => { s.shape = sh; buildToolbar(app) }
    shapes.appendChild(b)
  }
  shapeField.appendChild(shapes)
  box.appendChild(shapeField)

  // 笔刷行为
  const modeField = div('field')
  modeField.appendChild(label('方式'))
  const modes = div('seg')
  for (const m of Object.values(BrushMode)) {
    const b = button(MODE_LABELS[m], s.mode === m)
    b.onclick = () => { s.mode = m; buildToolbar(app) }
    modes.appendChild(b)
  }
  modeField.appendChild(modes)
  box.appendChild(modeField)

  if (s.mode === BrushMode.REPLACE) {
    box.appendChild(note(`替换模式：只把「${BLOCK_BY_ID[s.targetId]?.label ?? '?'}」换成当前方块。`))
    const b = button(`设目标方块为当前方块（${BLOCK_BY_ID[s.blockId]?.label}）`)
    b.style.width = '100%'
    b.onclick = () => { s.targetId = s.blockId; buildToolbar(app) }
    box.appendChild(b)
  } else if (s.mode === BrushMode.RAISE || s.mode === BrushMode.LOWER) {
    box.appendChild(note('抬升 / 下沉只作用于暴露在空气中的地表方块，模拟推土效果。'))
  } else if (s.mode === BrushMode.SMOOTH) {
    box.appendChild(note('平滑会把地表高度向 3×3 邻域的平均值靠拢，削掉尖角。'))
  } else if (s.mode === BrushMode.ERASE) {
    box.appendChild(note('删除模式：把作用范围内的方块清成空气。大范围挖空用这个，比 Alt+左键一格一格点快得多。'))
  }
  return box
}

/** 5. 区域操作 */
function sectionRegion(app) {
  const box = panel('区域操作', '<span class="hint">需先框选</span>')
  const sel = app.selection

  if (!sel) {
    box.appendChild(note('用「框选」工具在视口里拖出一个区域，这里就会出现填充、复制等操作。'))
  } else {
    const r = normalizeRegion({ x: sel.x1, y: sel.y1, z: sel.z1 }, { x: sel.x2, y: sel.y2, z: sel.z2 })
    const info = div('selected-block')
    info.innerHTML = `<div style="flex:1">
      <div class="nm">${r.x2 - r.x1 + 1} × ${r.y2 - r.y1 + 1} × ${r.z2 - r.z1 + 1}</div>
      <div class="en">${regionVolume(r).toLocaleString()} 格 · (${r.x1},${r.y1},${r.z1}) → (${r.x2},${r.y2},${r.z2})</div>
    </div>`
    box.appendChild(info)
  }

  const g = div('grid-2')
  const ops = [
    ['填充', 'fill'],
    ['替换', 'replace'],
    ['挖空', 'clear'],
    ['空心壳', 'hollow'],
    ['复制', 'copy'],
    ['剪切', 'cut'],
  ]
  for (const [label, kind] of ops) {
    const b = button(label)
    b.disabled = !sel
    b.onclick = () => app.regionOp(kind)
    g.appendChild(b)
  }
  box.appendChild(g)

  const paste = button(`粘贴${app.clipboard ? `（剪贴板 ${app.clipboard.w}×${app.clipboard.h}×${app.clipboard.d}）` : ''}`)
  paste.style.width = '100%'
  paste.style.marginTop = '6px'
  paste.disabled = !app.clipboard
  paste.onclick = () => app.pasteClipboard()
  box.appendChild(paste)

  if (sel) {
    const clr = button('清除选区', false, 'ghost')
    clr.style.width = '100%'
    clr.style.marginTop = '6px'
    clr.onclick = () => app.clearSelection()
    box.appendChild(clr)
  }
  return box
}

/** 6. 地形生成 */
function sectionTerrain(app) {
  const box = panel('地形生成', '<span class="hint">作用于选区或全图</span>')
  const g = div('grid-2')
  for (const [type, label] of [['mountain', '山地'], ['hills', '丘陵'], ['plateau', '台地'], ['valley', '谷地']]) {
    const b = button(label)
    b.onclick = () => app.quickTerrain(type)
    g.appendChild(b)
  }
  box.appendChild(g)
  box.appendChild(note(`当前表层方块：${BLOCK_BY_ID[app.state.blockId]?.label}，下方两层为泥土，再往下是石头。`))
  return box
}

/** 7. 视图与数据 */
function sectionView(app) {
  const s = app.state
  const box = panel('视图与数据', '')

  const g = div('grid-2')
  const gridBtn = button(s.showGrid ? '隐藏网格' : '显示网格')
  gridBtn.onclick = () => app.toggleGrid()
  g.appendChild(gridBtn)

  const frameBtn = button('适应视图')
  frameBtn.onclick = () => app.controls.frameWorld(app.world)
  g.appendChild(frameBtn)
  box.appendChild(g)

  box.appendChild(note(
    `世界 ${app.world.width}×${app.world.height}×${app.world.depth} · 已用 ${(app.world.fillRatio() * 100).toFixed(1)}%`
  ))
  return box
}

// ---------- DOM 小工具 ----------

function panel(titleText, hint = '', extra = '') {
  const p = div(['panel', extra].filter(Boolean).join(' '))
  const t = div('panel-title')
  t.innerHTML = `<span>${titleText}</span>${hint}`
  p.appendChild(t)
  return p
}

function div(cls) {
  const d = document.createElement('div')
  if (cls) d.className = cls
  return d
}

function span(cls, text) {
  const s = document.createElement('span')
  if (cls) s.className = cls
  if (text !== undefined) s.textContent = text
  return s
}

function label(text, valueEl) {
  const l = document.createElement('label')
  l.innerHTML = `<span>${text}</span>`
  if (valueEl) l.appendChild(valueEl)
  return l
}

function button(text, active = false, extra = '') {
  const b = document.createElement('button')
  b.className = [active ? 'active' : '', extra].filter(Boolean).join(' ')
  b.textContent = text
  return b
}

function note(text) {
  const d = div('section-note')
  d.innerHTML = text
  return d
}

function slider(name, value, min, max, step, onChange, suffix = '', fmt) {
  const f = div('field')
  const val = document.createElement('span')
  val.className = 'val'
  val.textContent = fmt ? fmt(value) : `${value}${suffix}`
  const l = label(name, val)
  f.appendChild(l)

  const input = document.createElement('input')
  input.type = 'range'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  let raf = null
  input.oninput = () => {
    const v = Number(input.value)
    val.textContent = fmt ? fmt(v) : `${v}${suffix}`
    // 拖动中重建整个面板会掉帧，用 rAF 节流
    if (raf) cancelAnimationFrame(raf)
    raf = requestAnimationFrame(() => onChange(v))
  }
  f.appendChild(input)
  return f
}

export function cssColor(hex) {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`
}
