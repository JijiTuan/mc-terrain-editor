/**
 * op-schema.js — AI 结构化编辑操作协议
 *
 * 这是模型输出与编辑器之间的唯一契约。三种角色共用同一份定义：
 *   1. 提示词生成（ai/prompt.js）—— 把 schema 渲染进 system prompt；
 *   2. 输出校验（ai/parser.js）—— 逐条校验模型返回的 op；
 *   3. 执行（ai/op-executor.js）—— 把 op 翻译成对 VoxelWorld 的写入。
 *
 * 新增一种能力 = 在 OPS 里加一条 + 在 executor 里加一个分支，提示词自动同步。
 */

import { resolveBlockId } from '../data/blocks.js'

/** 每个 op 的参数规格：name → { type, required, min, max, default, desc } */
const NUM = (desc, extra = {}) => ({ type: 'number', desc, ...extra })
// 注意：ID 也必须接收 extra。之前只收 desc，导致 ID('x', { default: 'dirt' }) 里的
// default 被静默丢掉 —— 调用方以为给了默认值，实际校验时仍然报「缺少参数」，非常难查。
const ID = (desc, extra = {}) => ({ type: 'block', desc, ...extra })

export const OPS = {
  fill: {
    desc: '把整个区域填满同一种方块',
    params: {
      x1: NUM('区域起点 X'), y1: NUM('区域起点 Y'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), y2: NUM('区域终点 Y'), z2: NUM('区域终点 Z'),
      block: ID('要填充的方块'),
    },
  },

  replace: {
    desc: '把区域内的方块 A 替换成方块 B',
    params: {
      x1: NUM('区域起点 X'), y1: NUM('区域起点 Y'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), y2: NUM('区域终点 Y'), z2: NUM('区域终点 Z'),
      from: ID('被替换的方块'), to: ID('替换成的方块'),
    },
  },

  clear: {
    desc: '清空区域（挖空）',
    params: {
      x1: NUM('区域起点 X'), y1: NUM('区域起点 Y'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), y2: NUM('区域终点 Y'), z2: NUM('区域终点 Z'),
    },
  },

  sphere: {
    desc: '在中心点放置一个球体',
    params: {
      cx: NUM('中心 X'), cy: NUM('中心 Y'), cz: NUM('中心 Z'),
      radius: NUM('半径（格）', { min: 1, max: 128 }),
      block: ID('球体方块'),
    },
  },

  cylinder: {
    desc: '放置圆柱体',
    params: {
      cx: NUM('中心 X'), cy: NUM('圆柱底面中心 Y'), cz: NUM('中心 Z'),
      radius: NUM('半径（格）', { min: 1, max: 128 }),
      height: NUM('高度（格）', { min: 1, max: 256 }),
      block: ID('方块'),
    },
  },

  terrain: {
    desc: '在区域内用噪声生成地形。山地示例：type=terrain, terrainType=mountain, amplitude=24。',
    params: {
      x1: NUM('区域起点 X'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), z2: NUM('区域终点 Z'),
      terrainType: { type: 'enum', values: ['mountain', 'hills', 'plateau', 'valley'], desc: '地形类型', default: 'hills' },
      baseY: NUM('地面基准高度', { default: 8 }),
      amplitude: NUM('起伏幅度（格）', { default: 12 }),
      scale: NUM('噪声缩放，越大越平缓', { default: 0.05 }),
      // 三类方块都给了 default：executor（generateTerrain）本来就有兜底值，
      // 这里必须与之一致 —— 否则模型说「生成一片山地」却不写 sub，校验会直接拒绝，
      // 而实际上执行器完全能处理。schema 与执行器的默认值漂移是最容易漏的一类 bug。
      surface: ID('表层方块', { default: 'grass_block' }),
      sub: ID('次表层方块', { default: 'dirt' }),
      base: ID('底层方块', { default: 'stone' }),
      seed: NUM('随机种子', { default: 0 }),
    },
  },

  river: {
    desc: '在区域中挖出一条河。direction 为走向；地形高度由编辑器自动采样。',
    params: {
      x1: NUM('区域起点 X'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), z2: NUM('区域终点 Z'),
      direction: { type: 'enum', values: ['x', 'z', 'auto'], desc: '河流走向', default: 'auto' },
      width: NUM('河宽（格）', { min: 1, max: 64, default: 6 }),
      depth: NUM('河深（格）', { min: 1, max: 32, default: 4 }),
      water: ID('河流填充液体', { default: 'water' }),
    },
  },

  layer: {
    desc: '按相对高度分层填充（如地表草皮、次层泥土、底层石头）',
    params: {
      x1: NUM('区域起点 X'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), z2: NUM('区域终点 Z'),
      height: NUM('从地表向下覆盖的高度', { default: 4 }),
      top: ID('最表层方块', { default: 'grass_block' }),
      middle: ID('中间层方块', { default: 'dirt' }),
      bottom: ID('底层方块', { default: 'stone' }),
    },
  },

  scatter: {
    desc: '在区域地表随机散布方块（如树木、岩石、花丛）',
    params: {
      x1: NUM('区域起点 X'), z1: NUM('区域起点 Z'),
      x2: NUM('区域终点 X'), z2: NUM('区域终点 Z'),
      block: ID('散布什么方块，建成 3-6 格高的柱体'),
      density: NUM('密度 0~1', { min: 0, max: 1, default: 0.05 }),
      onTop: ID('只长在这种方块上', { default: 'grass_block' }),
      seed: NUM('随机种子', { default: 0 }),
    },
  },

  // ---- 对外对话（WorkBuddy / DSH）驱动的指令用 op ----
  sphere_at_surface: {
    desc: '在世界坐标系原地生成一个贴合地表的球体（无需预先知道地表高度）',
    params: {
      cx: NUM('中心 X'), cz: NUM('中心 Z'),
      radius: NUM('半径（格）', { min: 1, max: 128 }),
      block: ID('方块'),
    },
  },
}

/** 把 block 参数解析成 id 并记录无法识别的名字 */
export function resolveBlockParam(value, fallbackName) {
  const name = value ?? fallbackName
  const fallbackId = resolveBlockId(fallbackName, 1)
  const id = resolveBlockId(name, fallbackId)
  const known = typeof name !== 'string' || resolveBlockId(name, -1) >= 0
  return { id, name: typeof name === 'string' ? name : fallbackName, unknown: !known }
}

/**
 * 校验并归一化单条 op。
 * @returns {{ok:true, op:object, warnings:string[]} | {ok:false, error:string}}
 */
export function validateOp(raw, world) {
  const warnings = []
  if (!raw || typeof raw !== 'object') return { ok: false, error: '操作不是对象' }
  const type = String(raw.type ?? '').trim()
  const spec = OPS[type]
  if (!spec) return { ok: false, error: `不支持的操作类型 "${type}"` }

  const out = { type }

  for (const [key, rule] of Object.entries(spec.params)) {
    // 防御：任何参数名都不得叫 "type"，否则会覆盖操作类型判别字段
    if (key === 'type') throw new Error(`op "${type}" 的参数名不能是 "type"（与操作类型字段冲突）`)
    let v = raw[key]
    if (v === undefined || v === null || v === '') {
      if (rule.default !== undefined) {
        v = rule.default
      } else {
        return { ok: false, error: `操作 "${type}" 缺少参数 ${key}（${rule.desc}）` }
      }
    }

    if (rule.type === 'number' || rule.type === 'enum') {
      if (rule.type === 'enum') {
        const s = String(v)
        if (!rule.values.includes(s)) {
          warnings.push(`"${type}.${key}" 的值 "${s}" 不在 ${rule.values.join('/')} 中，已回退为 ${rule.default ?? rule.values[0]}`)
          v = rule.default ?? rule.values[0]
        }
        out[key] = v
        continue
      }
      const n = Number(v)
      if (!Number.isFinite(n)) return { ok: false, error: `操作 "${type}" 的参数 ${key} 不是有效数字：${v}` }
      let clamped = Math.round(n)
      if (rule.min !== undefined && clamped < rule.min) { warnings.push(`"${type}.${key}"=${clamped} 小于下限 ${rule.min}，已钳制`); clamped = rule.min }
      if (rule.max !== undefined && clamped > rule.max) { warnings.push(`"${type}.${key}"=${clamped} 超过上限 ${rule.max}，已钳制`); clamped = rule.max }
      out[key] = clamped
    } else if (rule.type === 'block') {
      const { id, name, unknown } = resolveBlockParam(v, rule.default ?? 'stone')
      if (unknown) warnings.push(`无法识别方块 "${name}"，已使用默认方块 "${rule.default ?? 'stone'}"`)
      out[key] = id
      out[`${key}Name`] = name
    } else {
      out[key] = v
    }
  }

  // 坐标越界检查与裁剪
  const coordKeys = Object.keys(spec.params).filter((k) => spec.params[k].type === 'number' && /^[xyzc][0-9]?$|^cx$|^cy$|^cz$/.test(k))
  if (world && coordKeys.length) {
    for (const k of coordKeys) {
      const v = out[k]
      if (typeof v !== 'number') continue
      const limit = k.startsWith('y') ? world.height : (k.startsWith('x') || k === 'cx') ? world.width : world.depth
      if (v < 0 || v >= limit) {
        warnings.push(`"${type}.${k}"=${v} 超出世界范围 0~${limit - 1}，已钳制`)
        out[k] = Math.min(Math.max(0, v), limit - 1)
      }
    }
    if (out.x1 !== undefined && out.x2 !== undefined && out.x1 > out.x2) {
      ;[out.x1, out.x2] = [out.x2, out.x1]
      warnings.push(`"${type}" 的 x1 > x2，已自动交换`)
    }
    if (out.y1 !== undefined && out.y2 !== undefined && out.y1 > out.y2) {
      ;[out.y1, out.y2] = [out.y2, out.y1]
      warnings.push(`"${type}" 的 y1 > y2，已自动交换`)
    }
    if (out.z1 !== undefined && out.z2 !== undefined && out.z1 > out.z2) {
      ;[out.z1, out.z2] = [out.z2, out.z1]
      warnings.push(`"${type}" 的 z1 > z2，已自动交换`)
    }
  }

  return { ok: true, op: out, warnings }
}

/** 校验整个操作列表 */
export function validateProgram(rawOps, world) {
  if (!Array.isArray(rawOps)) return { ok: false, error: '返回的 ops 不是数组' }
  if (rawOps.length === 0) return { ok: false, error: '返回的 ops 为空，没有可执行的操作' }
  if (rawOps.length > 64) return { ok: false, error: `一次最多执行 64 条操作，收到 ${rawOps.length} 条` }
  const ops = []
  const warnings = []
  for (let i = 0; i < rawOps.length; i++) {
    const r = validateOp(rawOps[i], world)
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 条操作无效：${r.error}` }
    ops.push(r.op)
    warnings.push(...r.warnings)
  }
  return { ok: true, ops, warnings }
}

/** 生成给模型的 schema 文本（提示词用，与上面定义同源） */
export function describeSchema() {
  const lines = []
  for (const [type, spec] of Object.entries(OPS)) {
    const params = Object.entries(spec.params)
      .map(([k, r]) => {
        if (r.type === 'enum') return `${k}:"${r.values.join('"|"')}"`
        if (r.type === 'block') return `${k}:"方块名"`
        return `${k}:数字`
      })
      .join(', ')
    lines.push(`- ${type}: ${spec.desc}\n  参数: { "type":"${type}", ${params} }`)
  }
  return lines.join('\n')
}

/** 统计一条 op 大致影响的方块体积，用于预览提示 */
export function opFootprint(op) {
  switch (op.type) {
    case 'fill': case 'clear': case 'replace': case 'layer':
      return (op.x2 - op.x1 + 1) * (op.y2 - op.y1 + 1) * (op.z2 - op.z1 + 1)
    case 'terrain': case 'river': case 'scatter':
      return (op.x2 - op.x1 + 1) * (op.z2 - op.z1 + 1)
    case 'sphere': case 'sphere_at_surface':
      return Math.ceil((4 / 3) * Math.PI * op.radius ** 3)
    case 'cylinder':
      return Math.ceil(Math.PI * op.radius ** 2 * op.height)
    default:
      return 0
  }
}
