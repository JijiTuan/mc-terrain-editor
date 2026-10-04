/**
 * ai-client.js — 大模型调用
 *
 * 单通道：环境变量直连（自备 Key）。
 * 走标准 OpenAI 兼容的 /chat/completions SSE，endpoint / key / model 由构建时注入的
 * VITE_AI_* 变量提供，适合有自己模型配额、或离线部署到内网的场景。
 *
 * 这里原先还有一条「云服务（免密钥）」通道，现已移除 —— 那条通道依赖一个已经下线的
 * 网页部署，桌面版里连不上。详见 README「为什么去掉了云服务通道」。
 *
 * 关于 Key 的安全边界（界面上也会明说）：
 * 这是纯前端应用，没有服务端可以藏东西，Key 必然会随代码打包进产物。
 * 自用没问题，但不要把这套部署成给别人用的公共服务 —— 那样等于把 Key 公开。
 *
 * 另一种不需要 Key 的用法是「接入会话」（见 file-bridge.js）：
 * 由外部对话把指令写成文件，编辑器读文件执行，Key 始终留在对话环境那一侧。
 */

export const Channel = {
  DIRECT: 'direct',
}

/** 从构建环境变量读取直连配置 */
export function readDirectConfig() {
  const env = import.meta.env ?? {}
  const baseUrl = String(env.VITE_AI_BASE_URL ?? '').trim()
  const apiKey = String(env.VITE_AI_API_KEY ?? '').trim()
  const model = String(env.VITE_AI_MODEL ?? '').trim()
  return {
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    apiKey,
    model,
    configured: Boolean(apiKey) || (Boolean(baseUrl) && Boolean(env.VITE_AI_TRUST_PROXY)),
  }
}

export class AiClient {
  /**
   * @param {object} opts
   * @param {string} opts.channel     目前只有 Channel.DIRECT
   * @param {string} opts.directModel 直连通道使用的模型名
   * @param {(msg:string, level:string)=>void} opts.notify
   */
  constructor({ channel = Channel.DIRECT, directModel = '', notify }) {
    this.channel = channel
    this.directModel = directModel
    this.notify = notify || (() => {})
  }

  /** 当前通道是否可用 */
  availability() {
    const cfg = readDirectConfig()
    if (!cfg.apiKey) {
      return {
        ok: false,
        reason: '未检测到 API Key。请用「接入会话」由外部对话驱动，或在项目根目录创建 .env.local 填写 VITE_AI_API_KEY（参考 .env.example）后重新构建。',
      }
    }
    return { ok: true }
  }

  /**
   * 流式生成。
   * @param {Array<{role:string, content:string}>} messages
   * @param {{signal?:AbortSignal, onDelta?:(s:string)=>void, onReasoning?:(s:string)=>void, stream?:boolean}} opts
   * @returns {Promise<{content:string, reasoning:string, usage:object|null}>}
   */
  async generate(messages, opts = {}) {
    const avail = this.availability()
    if (!avail.ok) {
      const err = new Error(avail.reason)
      err.kind = 'not_configured'
      throw err
    }
    return this.generateDirect(messages, opts)
  }

  /** 标准 OpenAI 兼容的 /chat/completions SSE */
  async generateDirect(messages, { signal, onDelta, onReasoning }) {
    const cfg = readDirectConfig()
    const model = this.directModel || cfg.model
    if (!model) {
      const err = new Error('未指定模型名。请设置 VITE_AI_MODEL（或在 .env.local 里配置）。')
      err.kind = 'not_configured'
      throw err
    }

    const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.6,
        }),
        signal,
      })
    } catch (err) {
      const e = new Error(`无法连接模型服务（${url}）：${err.message}。请检查网络、VITE_AI_BASE_URL 是否正确，以及是否需要代理。`)
      e.kind = 'network'
      throw e
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      let detail = body.slice(0, 300)
      try {
        const j = JSON.parse(body)
        detail = j.error?.message || j.message || detail
      } catch { /* 非 JSON 错误体，保留原文 */ }
      const e = new Error(`模型服务返回 ${res.status}：${detail || res.statusText}`)
      e.kind = res.status === 401 || res.status === 403 ? 'auth'
        : res.status === 429 ? 'quota'
        : res.status >= 500 ? 'server'
        : 'request'
      e.status = res.status
      throw e
    }

    return this.consumeSse(res, { onDelta, onReasoning })
  }

  /** 解析 SSE 流；OpenAI / 各兼容服务都适用 */
  async consumeSse(res, { onDelta, onReasoning }) {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let usage = null
    let sawDone = false

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 以空行分隔事件
      let sep
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of block.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue
          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') { sawDone = true; continue }
          let json
          try { json = JSON.parse(data) } catch { continue }
          if (json.error) {
            const e = new Error(`模型返回错误：${json.error.message || JSON.stringify(json.error)}`)
            e.kind = 'server'
            throw e
          }
          const delta = json.choices?.[0]?.delta
          if (delta?.content) { content += delta.content; onDelta?.(delta.content) }
          if (delta?.reasoning_content) { reasoning += delta.reasoning_content; onReasoning?.(delta.reasoning_content) }
          if (delta?.reasoning) { reasoning += delta.reasoning; onReasoning?.(delta.reasoning) }
          if (json.usage) usage = json.usage
        }
      }
    }

    if (!sawDone && !content) {
      const e = new Error('流式响应意外中断且没有返回内容。请重试，或检查模型服务是否支持 SSE。')
      e.kind = 'network'
      throw e
    }
    return { content, reasoning, usage }
  }
}

export function describeAiError(err) {
  if (!err) return '未知错误'
  return err.message || String(err)
}
