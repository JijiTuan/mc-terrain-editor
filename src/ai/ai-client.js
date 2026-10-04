/**
 * ai-client.js — 大模型调用
 *
 * 单通道：直连（自备 Key）。
 * 走标准 OpenAI 兼容的 /chat/completions SSE。
 *
 * 配置来源有两层，运行时优先（见 config-store.js）：
 *   1. 软件里「齿轮 → 模型连接」填的（localStorage）  ← 使用者改的，优先
 *   2. 构建时注入的 VITE_AI_*                          ← 打包者/开发者写死的
 * 1.5.0 之前只有第 2 层，结果就是装完安装包之后软件里无处可改，只能重新构建。
 *
 * 关于协议：只实现了 OpenAI 兼容格式。
 * `https://api.deepseek.com/anthropic` 那种 Anthropic Messages 格式
 * （`/v1/messages` + `x-api-key` + content_block_delta 事件）是另一套协议，
 * 本客户端不支持 —— 填进界面会得到 404。界面上的说明里写明了这一点。
 *
 * 关于 Key 的安全边界（界面上也会明说）：
 * 这是纯前端应用，没有服务端可以藏东西。填进界面存在 localStorage 里，
 * 和打包进产物对「本机其他人」来说一样挡不住。自用没问题，
 * 但不要把这套部署成给别人用的公共服务 —— 那样等于把 Key 公开。
 *
 * 另一种不需要 Key 的用法是「接入会话」（见 file-bridge.js）：
 * 由外部对话把指令写成文件，编辑器读文件执行，Key 始终留在对话环境那一侧。
 */

import { resolveAiConfig, normalizeBaseUrl } from './config-store.js'

export const Channel = {
  DIRECT: 'direct',
}

/**
 * 读取直连配置（已合并运行时与环境变量两层）。
 * 保留原函数名，调用方不用改。
 */
export function readDirectConfig() {
  const r = resolveAiConfig()
  return {
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    model: r.model,
    source: r.source,
    configured: Boolean(r.apiKey),
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
        reason: '还没填 API Key。点这个窗口右上角的 ⚙ →「模型连接」填地址和 Key；或者用右下角「接入会话」让外部对话来驱动，那样不需要 Key。',
      }
    }
    if (!cfg.model) {
      return { ok: false, reason: '填了 API Key 但没填模型名（例如 deepseek-chat）。点右上角 ⚙ →「模型连接」补上。' }
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
      const err = new Error('未指定模型名。请在 ⚙ →「模型连接」里填写（例如 deepseek-chat）。')
      err.kind = 'not_configured'
      throw err
    }

    const base = normalizeBaseUrl(cfg.baseUrl)
    const url = `${base}/chat/completions`
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
      const e = new Error(`连不上模型服务（${url}）：${err.message}。检查这个地址是否写错、网络是否需要代理。`)
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
      // 404 最常见的原因不是「服务不存在」，而是地址多写或漏写了 /v1。
      // 不点出来的话，用户只会看到一个 404 完全不知道从哪查。
      const hint = res.status === 404
        ? `（地址可能不对：实际请求的是 ${url}。多数服务要带 /v1，DeepSeek 是 https://api.deepseek.com/v1）`
        : ''
      const e = new Error(`模型服务返回 ${res.status}${hint}：${detail || res.statusText}`)
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
