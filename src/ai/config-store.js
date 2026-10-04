/**
 * config-store.js — AI 直连配置的运行时存储
 *
 * 背景（为什么要有这个文件）：
 *   1.5.0 之前，接口地址 / Key / 模型名只有一条来源 —— 构建时注入的
 *   `import.meta.env.VITE_AI_*`。也就是说，用户装完安装包之后，
 *   软件里**没有任何地方**能改这三个值，想换 Key 只能重新构建一次。
 *   实际反馈就是「我找不到在软件内输入 Key 的地方」—— 不是找不到，是真的没有。
 *
 * 所以这里加一条运行时优先级更高的来源，三层从高到低：
 *
 *   1. 运行时配置（本文件，localStorage）  ← 界面上填的，最高优先级
 *   2. 构建时环境变量（VITE_AI_*）          ← 开发/自部署时写死在产物里的
 *   3. 内置默认值（baseUrl 兜底）
 *
 * 「运行时优先于构建时」是刻意的：环境变量是给打包者用的，界面是给使用者用的，
 * 使用者明确填了东西就应该盖过打包者的默认值，否则界面上改完没反应，
 * 比没有这个界面更让人困惑。
 *
 * 关于 Key 存在 localStorage 里这件事，必须说清楚：
 *   这是纯前端应用，没有服务端能藏东西。存在 localStorage 和打包进产物，
 *   对「本机上的其他人/其他程序」来说安全级别是一样的 —— 都挡不住。
 *   界面上的安全提示不能省，不能让用户以为填进界面就比写进 .env 更安全。
 */

const KEY = 'mc-terrain-editor:ai-config'

/**
 * 预置服务商。用户点一下就把地址填好，不用去翻文档 ——
 * 「baseUrl 该填到 /v1 还是不带 /v1」正是最容易填错的一处，
 * 每个服务商还不一样（DeepSeek 要 /v1，Anthropic 不要，Ollama 要 /v1）。
 */
export const AI_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'dashscope',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
  },
  {
    id: 'moonshot',
    label: '月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
  },
]

/** 内置兜底地址（与环境变量都没填时用） */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/**
 * 读运行时配置。任何一步出错都返回全空 ——
 * 配置读不出来时应该退化成「没配」，而不是让整个面板崩掉。
 */
export function readRuntimeConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { baseUrl: '', apiKey: '', model: '' }
    const o = JSON.parse(raw)
    return {
      baseUrl: String(o?.baseUrl ?? '').trim(),
      apiKey: String(o?.apiKey ?? '').trim(),
      model: String(o?.model ?? '').trim(),
    }
  } catch {
    return { baseUrl: '', apiKey: '', model: '' }
  }
}

/** 写运行时配置。传空字符串等于清掉这一项。 */
export function writeRuntimeConfig({ baseUrl, apiKey, model }) {
  const payload = {
    baseUrl: String(baseUrl ?? '').trim(),
    apiKey: String(apiKey ?? '').trim(),
    model: String(model ?? '').trim(),
  }
  try {
    // 三项都空就把条目删掉，别在 localStorage 里留一个空壳
    if (!payload.baseUrl && !payload.apiKey && !payload.model) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* 隐私模式/配额满：静默失败，界面下次打开会显示成没配 */
  }
  return payload
}

/** 清空运行时配置（回到环境变量 / 默认值） */
export function clearRuntimeConfig() {
  try { localStorage.removeItem(KEY) } catch { /* 同上 */ }
}

/**
 * 合并三层来源，给出最终生效的配置。
 * @returns {{baseUrl:string, apiKey:string, model:string,
 *            source:{baseUrl:string, apiKey:string, model:string}}}
 *          source 标记每一项分别来自哪一层，界面上要如实显示 ——
 *          「我明明填了怎么没生效」绝大多数时候是环境变量在盖着。
 */
export function resolveAiConfig() {
  const env = import.meta.env ?? {}
  const envBase = String(env.VITE_AI_BASE_URL ?? '').trim()
  const envKey = String(env.VITE_AI_API_KEY ?? '').trim()
  const envModel = String(env.VITE_AI_MODEL ?? '').trim()
  const rt = readRuntimeConfig()

  const pick = (rtv, envv, def) => {
    if (rtv) return { value: rtv, from: '运行时' }
    if (envv) return { value: envv, from: '构建时' }
    return { value: def, from: def === envv ? '构建时' : '默认' }
  }

  const b = pick(rt.baseUrl, envBase, DEFAULT_BASE_URL)
  const k = pick(rt.apiKey, envKey, '')
  const m = pick(rt.model, envModel, '')

  return {
    baseUrl: b.value,
    apiKey: k.value,
    model: m.value,
    source: { baseUrl: b.from, apiKey: k.from, model: m.from },
  }
}

/**
 * 归一化用户填的接口地址。
 *
 * 用户很可能把完整端点直接贴进来（`https://api.deepseek.com/v1/chat/completions`，
 * 甚至带 ?query），而调用侧只会在后面拼 `/chat/completions`。
 * 不归一化就会拼成 `.../chat/completions/chat/completions` → 404，
 * 而 404 的报错信息完全看不出是地址填多了。
 *
 * 所以这里把「已经带了端点后缀」的地址削回去，并去掉结尾多余的斜杠。
 */
export function normalizeBaseUrl(input) {
  let s = String(input ?? '').trim()
  if (!s) return ''
  s = s.replace(/[?#].*$/, '')       // 去掉 query / hash
  s = s.replace(/\/+$/, '')          // 去掉结尾斜杠
  s = s.replace(/\/chat\/completions$/i, '')
  s = s.replace(/\/+$/, '')
  return s
}

/**
 * 快速体检：在真正发对话之前，用一个最小请求确认地址+Key+模型能通。
 *
 * 存在的意义：直接发对话失败时，用户看到的是「生成失败」，
 * 根本分不清是 Key 错了、地址错了、还是模型名写错了。
 * 这里把三类错误分开报，并带上状态码。
 *
 * @param {{baseUrl:string, apiKey:string, model:string}} cfg
 * @param {{timeoutMs?:number}} opts
 * @returns {Promise<{ok:true, ms:number, reply:string}>}
 */
export async function testAiConnection(cfg, { timeoutMs = 20000 } = {}) {
  const base = normalizeBaseUrl(cfg.baseUrl)
  if (!base) {
    const e = new Error('接口地址是空的。至少填到服务商的域名，例如 https://api.deepseek.com/v1')
    e.kind = 'config'
    throw e
  }
  if (!cfg.apiKey) {
    const e = new Error('API Key 是空的。')
    e.kind = 'config'
    throw e
  }
  if (!cfg.model) {
    const e = new Error('模型名是空的。例如 deepseek-chat / gpt-4o-mini。')
    e.kind = 'config'
    throw e
  }

  const url = `${base}/chat/completions`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0 = Date.now()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
        stream: false,
      }),
      signal: ctrl.signal,
    })
  } catch (err) {
    const e = new Error(
      err.name === 'AbortError'
        ? `请求超时（${timeoutMs / 1000} 秒没有响应）。地址 ${url} —— 检查网络，或该服务是否需要代理。`
        : `连不上 ${url} —— ${err.message}。检查地址是否写错、服务是否在运行。`
    )
    e.kind = 'network'
    throw e
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    let detail = text.slice(0, 300)
    try {
      const j = JSON.parse(text)
      detail = j.error?.message || j.message || detail
    } catch { /* 非 JSON 错误体，保留原文 */ }
    const hint = res.status === 401 || res.status === 403
      ? '（Key 不对或没有该模型的权限）'
      : res.status === 404
        ? `（地址或模型名不对。当前请求的是 ${url}；DeepSeek 这类服务地址要带 /v1）`
        : res.status === 429
          ? '（限流或余额不足）'
          : res.status >= 500
            ? '（服务端故障，稍后重试）'
            : ''
    const e = new Error(`HTTP ${res.status} ${hint} ${detail || res.statusText}`)
    e.kind = res.status === 401 || res.status === 403 ? 'auth'
      : res.status === 404 ? 'notfound'
      : res.status === 429 ? 'quota'
      : res.status >= 500 ? 'server'
      : 'request'
    e.status = res.status
    throw e
  }

  let reply = ''
  try {
    const j = JSON.parse(text)
    reply = j.choices?.[0]?.message?.content ?? ''
  } catch { /* 不是 JSON，能 200 就算通了 */ }

  return { ok: true, ms: Date.now() - t0, reply, url, model: cfg.model }
}
