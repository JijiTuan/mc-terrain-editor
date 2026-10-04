/**
 * parser.js — 从模型的自由文本里抠出结构化操作
 *
 * 模型即使被要求"只输出 JSON"，实际仍可能包 markdown 代码块、加前后缀说明、
 * 或把 JSON 写成带注释的形式。这里做多层容错提取，尽量不让一次有效回复因格式问题作废。
 */

/**
 * @param {string} text 模型的原始输出
 * @returns {{ok:true, reply:string, ops:any[]} | {ok:false, error:string, raw:string}}
 */
export function parseModelOutput(text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, error: '模型返回了空内容', raw }

  const candidates = extractJsonCandidates(raw)

  for (const cand of candidates) {
    const parsed = tryParse(cand)
    if (!parsed) continue
    const normalized = normalizePayload(parsed)
    if (normalized) return { ok: true, ...normalized, raw }
  }

  // 兜底：模型只回了纯文本，没有 JSON —— 当成对话回复，ops 为空
  return {
    ok: true,
    reply: raw.replace(/```[\s\S]*?```/g, '').trim() || raw,
    ops: [],
    degraded: true,
    raw,
  }
}

/** 依次尝试：整体解析 → 代码块 → 最外层大括号 → 括号配平扫描 */
function extractJsonCandidates(text) {
  const out = []

  // 1) 去掉 markdown 代码块围栏
  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g
  let m
  while ((m = fenceRe.exec(text)) !== null) {
    out.push(m[1].trim())
  }

  // 2) 整体
  out.push(text)

  // 3) 最外层大括号
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first >= 0 && last > first) out.push(text.slice(first, last + 1))

  // 4) 括号配平扫描，抓出第一个完整对象（能处理前后有解释文字的情况）
  const balanced = scanBalanced(text)
  if (balanced) out.push(balanced)

  return [...new Set(out.filter(Boolean))]
}

/** 从文本中扫描出第一个括号完全配平的 JSON 对象（跳过字符串内的括号） */
function scanBalanced(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (escape) escape = false
      else if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function tryParse(s) {
  try {
    return JSON.parse(s)
  } catch { /* 尝试修复常见问题 */ }

  // 修复：尾随逗号
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'))
  } catch { /* 继续 */ }

  // 修复：单引号字符串
  try {
    const fixed = s
      .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3')
      .replace(/:\s*'([^']*)'/g, ': "$1"')
    return JSON.parse(fixed)
  } catch { /* 放弃 */ }

  return null
}

/** 把不同形态的返回统一成 { reply, ops } */
function normalizePayload(obj) {
  if (!obj || typeof obj !== 'object') return null

  // 标准形态
  if (Array.isArray(obj.ops)) {
    return { reply: String(obj.reply ?? obj.message ?? obj.explanation ?? '').trim(), ops: obj.ops }
  }

  // 模型直接返回了单个 op
  if (typeof obj.type === 'string' && !obj.ops) {
    return { reply: String(obj.reply ?? '').trim(), ops: [obj] }
  }

  // 模型返回 { operations: [...] } 之类的变体
  for (const key of ['operations', 'commands', 'edits', 'actions']) {
    if (Array.isArray(obj[key])) {
      return { reply: String(obj.reply ?? obj.message ?? '').trim(), ops: obj[key] }
    }
  }

  // 只有 reply，没有操作 —— 合法（闲聊或说明限制）
  if (typeof obj.reply === 'string' || typeof obj.message === 'string') {
    return { reply: String(obj.reply ?? obj.message).trim(), ops: [] }
  }

  return null
}
