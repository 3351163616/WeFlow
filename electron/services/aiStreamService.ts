/**
 * 共享 AI 流式调用服务
 * 供"角色提示词""年度报告叙事""聊天分析风格对比"等 AI 能力复用
 *
 * 设计原则：
 * - 同时兼容 OpenAI (/v1/chat/completions) 与 Anthropic (/v1/messages) 两种协议
 * - SSE 流式 + 非流式 JSON 自动回退
 * - 失败时返回清晰错误信息，不吞异常
 */

import * as https from 'https'
import * as http from 'http'

export type AiProvider = 'openai' | 'anthropic'

export interface AiConfig {
  provider: AiProvider
  apiBaseUrl: string
  apiKey: string
  model: string
}

export interface BuiltinAiConfig extends AiConfig {
  configured: boolean
}

/**
 * 从 env 读取内置 API 配置（兑换码路径使用）
 * 未配置时 configured=false，调用方应回退到用户自备 API 或报错
 */
export function getBuiltinAiConfig(): BuiltinAiConfig {
  const apiBaseUrl = process.env.WEFLOW_BUILTIN_API_URL || ''
  const apiKey = process.env.WEFLOW_BUILTIN_API_KEY || ''
  const model = process.env.WEFLOW_BUILTIN_API_MODEL || 'claude-opus-4-6'
  const provider = (process.env.WEFLOW_BUILTIN_API_PROVIDER as AiProvider) || 'openai'
  return {
    provider,
    apiBaseUrl,
    apiKey,
    model,
    configured: !!(apiBaseUrl && apiKey)
  }
}

/**
 * 拼接 API URL，智能补 /v1 版本段
 *
 * 规则：仅当 base 已经以 /v\d+ 结尾（如 `.../v1`）时跳过补版本；
 * 其余情况（包括 `.../api`、`.../api/anthropic` 这类供应商代理前缀）一律补 `/v1`。
 * 例：
 *   https://api.anthropic.com              → https://api.anthropic.com/v1/messages
 *   https://api.openai.com/v1              → https://api.openai.com/v1/chat/completions
 *   https://open.bigmodel.cn/api/anthropic → https://open.bigmodel.cn/api/anthropic/v1/messages
 */
export function buildAiApiUrl(baseUrl: string, path: string): string {
  let base = baseUrl.replace(/\/+$/, '')
  if (!/\/v\d+$/.test(base)) {
    base = `${base}/v1`
  }
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * 识别供应商代理在 HTTP 200 外壳里塞的业务错误包。
 * 典型形如 `{code:500, success:false, msg:"404 NOT_FOUND"}`（智谱网关）、
 * `{error:{message:"..."}}`（OpenAI）、`{error:"..."}`（通用）。
 * 命中时返回错误文案，否则返回空串。
 */
function extractBizError(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const p = parsed as Record<string, unknown>
  const codeIsError = typeof p.code === 'number' && (p.code as number) >= 400
  const successFalse = p.success === false || p.ok === false
  const hasErrorField = typeof p.error !== 'undefined' && p.error !== null

  if (!codeIsError && !successFalse && !hasErrorField) return ''

  const pickString = (v: unknown): string => (typeof v === 'string' ? v : '')
  const errObj = p.error as Record<string, unknown> | string | undefined
  const candidates: string[] = [
    pickString(p.msg),
    pickString(p.message),
    typeof errObj === 'string' ? errObj : pickString(errObj?.message as unknown)
  ].filter(Boolean)

  if (candidates.length > 0) return candidates[0]
  try {
    return JSON.stringify(parsed).slice(0, 300)
  } catch {
    return ''
  }
}

class SSEParser {
  private buffer = ''
  private onEvent: (event: string, data: string) => void

  constructor(onEvent: (event: string, data: string) => void) {
    this.onEvent = onEvent
  }

  feed(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    let currentEvent = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const currentData = line.slice(6)
        this.onEvent(currentEvent || 'data', currentData)
        currentEvent = ''
      }
    }
  }
}

export interface AiTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface CallAiOptions {
  config: AiConfig
  /** 单轮提示词；与 messages 二选一（messages 优先） */
  prompt?: string
  /** 多轮对话数组（不含 system 角色；system 走 systemPrompt）。传入后覆盖 prompt */
  messages?: AiTurn[]
  systemPrompt?: string
  maxTokens?: number
  /** 采样温度，默认由 provider 决定（OpenAI 默认 1.0）；观察型/对比型任务建议 0.4–0.7 */
  temperature?: number
  onChunk: (text: string) => void
  signal?: AbortSignal
}

/**
 * 统一的 AI 流式调用入口
 * 同时兼容 OpenAI/Anthropic 两种协议，SSE + 非流式 JSON 自动回退
 */
export function callAiStream(opts: CallAiOptions): Promise<void> {
  const { config, prompt, messages, systemPrompt, maxTokens = 16384, temperature, onChunk, signal } = opts
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }

    // 归一化多轮消息：messages 优先，否则 fallback 到单条 user prompt
    const turns: AiTurn[] = (messages && messages.length > 0)
      ? messages
      : [{ role: 'user', content: String(prompt || '') }]

    if (!turns.some(t => t.content)) {
      reject(new Error('callAiStream：prompt 与 messages 均为空'))
      return
    }

    let endpoint: string
    let body: string
    let headers: Record<string, string>

    if (config.provider === 'anthropic') {
      endpoint = buildAiApiUrl(config.apiBaseUrl, '/messages')
      const anthropicBody: Record<string, unknown> = {
        model: config.model,
        max_tokens: maxTokens,
        stream: true,
        messages: turns.map(t => ({ role: t.role, content: t.content }))
      }
      if (systemPrompt) anthropicBody.system = systemPrompt
      if (typeof temperature === 'number') anthropicBody.temperature = temperature
      body = JSON.stringify(anthropicBody)
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      }
    } else {
      endpoint = buildAiApiUrl(config.apiBaseUrl, '/chat/completions')
      const openaiMessages: Array<{ role: string; content: string }> = []
      if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt })
      for (const t of turns) openaiMessages.push({ role: t.role, content: t.content })
      const openaiBody: Record<string, unknown> = {
        model: config.model,
        stream: true,
        messages: openaiMessages
      }
      if (typeof temperature === 'number') openaiBody.temperature = temperature
      body = JSON.stringify(openaiBody)
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      }
    }

    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch {
      reject(new Error(`无效的 API URL: ${endpoint}`))
      return
    }

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body).toString()
      }
    }

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request

    const req = requestFn(options, (res) => {
      if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
        let errData = ''
        res.on('data', (chunk) => { errData += chunk })
        res.on('end', () => {
          reject(new Error(`API 请求失败 (${res.statusCode}): ${errData.slice(0, 500)}`))
        })
        return
      }

      let receivedAnyChunk = false
      let rawBuffer = ''

      const parser = new SSEParser((event, data) => {
        if (config.provider === 'anthropic') {
          if (event === 'content_block_delta') {
            try {
              const parsed = JSON.parse(data)
              const text = parsed?.delta?.text
              if (typeof text === 'string') {
                receivedAnyChunk = true
                onChunk(text)
              }
            } catch { /* 忽略 */ }
          }
          if (event === 'error') {
            try {
              const parsed = JSON.parse(data)
              reject(new Error(`Anthropic 流错误: ${parsed?.error?.message || data}`))
            } catch {
              reject(new Error(`Anthropic 流错误: ${data}`))
            }
          }
        } else {
          if (data.trim() === '[DONE]') return
          try {
            const parsed = JSON.parse(data)
            const text = parsed?.choices?.[0]?.delta?.content
            if (typeof text === 'string') {
              receivedAnyChunk = true
              onChunk(text)
            }
          } catch { /* 忽略 */ }
        }
      })

      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        rawBuffer += chunk
        parser.feed(chunk)
      })
      res.on('end', () => {
        if (!receivedAnyChunk && rawBuffer) {
          try {
            const parsed = JSON.parse(rawBuffer)

            // 业务错误识别：部分供应商代理在上游失败时会返回 HTTP 200 +
            // {success:false, code, msg} 之类的业务错误包（如智谱 Anthropic 网关）。
            // 需要在此优先识别，把真实错误信息透传给用户。
            const bizErrorMsg = extractBizError(parsed)
            if (bizErrorMsg) {
              reject(new Error(`上游返回错误：${bizErrorMsg}`))
              return
            }

            let content = ''
            if (config.provider === 'anthropic') {
              if (Array.isArray(parsed?.content)) {
                content = parsed.content
                  .filter((b: { type: string }) => b?.type === 'text')
                  .map((b: { text: string }) => b?.text || '')
                  .join('')
              }
            } else {
              content = parsed?.choices?.[0]?.message?.content
                || parsed?.choices?.[0]?.text
                || parsed?.choices?.[0]?.delta?.content
                || ''
            }
            if (content) {
              onChunk(content)
              receivedAnyChunk = true
            }
          } catch {
            if (rawBuffer.trim()) {
              onChunk(rawBuffer)
              receivedAnyChunk = true
            }
          }
        }

        if (!receivedAnyChunk) {
          reject(new Error(`API 返回空响应：${rawBuffer.slice(0, 300)}`))
        } else {
          resolve()
        }
      })
      res.on('error', (e) => reject(e))
    })

    req.setTimeout(600_000, () => {
      req.destroy()
      reject(new Error('API 请求超时（10分钟）'))
    })

    req.on('error', (e) => reject(e))

    if (signal) {
      const onAbort = () => {
        req.destroy()
        reject(new Error('已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }

    req.write(body)
    req.end()
  })
}

/**
 * 非流式调用：聚合完整响应后返回
 */
export async function callAiOnce(opts: Omit<CallAiOptions, 'onChunk'>): Promise<string> {
  let full = ''
  await callAiStream({
    ...opts,
    onChunk: (t) => { full += t }
  })
  return full
}

// ─── 连接性测试 ────────────────────────────────────────────────────────────

export type TestErrorKind =
  | 'unreachable'      // 网络不通 / 超时
  | 'auth'             // 401/403
  | 'model_not_found'  // 404 或模型不存在
  | 'bad_response'     // 非预期格式
  | 'rate_limit'       // 429
  | 'http'             // 其他 HTTP 错误
  | 'unknown'

export interface AiTestResult {
  success: boolean
  latencyMs?: number
  returnedModel?: string       // 服务端实际返回的 model 字段
  replyPreview?: string        // 响应的前 200 字符预览
  errorKind?: TestErrorKind
  errorMessage?: string
  rawSnippet?: string          // 原始响应片段（最多 500 字符）
  statusCode?: number
}

/**
 * 发送一次最小成本请求，验证配置可用性
 * - OpenAI: max_tokens=5, 非流式
 * - Anthropic: max_tokens=5, 非流式
 */
export function testAiConnection(config: AiConfig): Promise<AiTestResult> {
  return new Promise((resolve) => {
    const startTs = Date.now()

    if (!config.apiBaseUrl || !config.apiKey || !config.model) {
      resolve({
        success: false,
        errorKind: 'unknown',
        errorMessage: '配置不完整：API 地址、Key、模型名称均不能为空'
      })
      return
    }

    let endpoint: string
    let body: string
    let headers: Record<string, string>

    if (config.provider === 'anthropic') {
      endpoint = buildAiApiUrl(config.apiBaseUrl, '/messages')
      body = JSON.stringify({
        model: config.model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }]
      })
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      }
    } else {
      endpoint = buildAiApiUrl(config.apiBaseUrl, '/chat/completions')
      body = JSON.stringify({
        model: config.model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }]
      })
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      }
    }

    let urlObj: URL
    try {
      urlObj = new URL(endpoint)
    } catch {
      resolve({
        success: false,
        errorKind: 'unknown',
        errorMessage: `无效的 API URL：${endpoint}`
      })
      return
    }

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST' as const,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body).toString()
      }
    }

    const isHttps = urlObj.protocol === 'https:'
    const requestFn = isHttps ? https.request : http.request

    const req = requestFn(reqOptions, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        const latencyMs = Date.now() - startTs
        const statusCode = res.statusCode || 0
        const rawSnippet = raw.slice(0, 500)

        if (statusCode < 200 || statusCode >= 300) {
          let kind: TestErrorKind = 'http'
          if (statusCode === 401 || statusCode === 403) kind = 'auth'
          else if (statusCode === 404) kind = 'model_not_found'
          else if (statusCode === 429) kind = 'rate_limit'

          // 尝试提取响应里的 "model not found" 之类关键词
          if (/model.*(not.*found|does.*not.*exist|invalid.*model|unknown.*model)/i.test(raw)) {
            kind = 'model_not_found'
          }

          let msg = `HTTP ${statusCode}`
          try {
            const parsed = JSON.parse(raw)
            const m = parsed?.error?.message
              || parsed?.error
              || parsed?.message
            if (typeof m === 'string') msg += `：${m.slice(0, 200)}`
          } catch {
            if (rawSnippet.trim()) msg += `：${rawSnippet.slice(0, 200)}`
          }

          resolve({
            success: false,
            latencyMs,
            statusCode,
            errorKind: kind,
            errorMessage: msg,
            rawSnippet
          })
          return
        }

        // 2xx 响应：先识别"HTTP 200 外壳 + 业务错误体"的代理包
        try {
          const parsed = JSON.parse(raw)

          const bizErrorMsg = extractBizError(parsed)
          if (bizErrorMsg) {
            // 根据错误文本智能分类
            let kind: TestErrorKind = 'http'
            if (/404|not.*found|model.*(not.*exist|invalid|unknown)/i.test(bizErrorMsg)) {
              kind = 'model_not_found'
            } else if (/401|403|auth|unauthoriz|forbidden/i.test(bizErrorMsg)) {
              kind = 'auth'
            } else if (/429|rate.*limit|too.*many/i.test(bizErrorMsg)) {
              kind = 'rate_limit'
            }
            resolve({
              success: false,
              latencyMs,
              statusCode,
              errorKind: kind,
              errorMessage: `上游返回错误：${bizErrorMsg.slice(0, 200)}`,
              rawSnippet
            })
            return
          }

          let reply = ''
          let returnedModel: string | undefined

          if (config.provider === 'anthropic') {
            if (Array.isArray(parsed?.content)) {
              reply = parsed.content
                .filter((b: { type: string }) => b?.type === 'text')
                .map((b: { text: string }) => b?.text || '')
                .join('')
            }
            returnedModel = typeof parsed?.model === 'string' ? parsed.model : undefined
          } else {
            reply = parsed?.choices?.[0]?.message?.content
              || parsed?.choices?.[0]?.text
              || parsed?.choices?.[0]?.delta?.content
              || ''
            returnedModel = typeof parsed?.model === 'string' ? parsed.model : undefined
          }

          if (!reply && !returnedModel) {
            resolve({
              success: false,
              latencyMs,
              statusCode,
              errorKind: 'bad_response',
              errorMessage: '返回格式异常：未找到 content 字段',
              rawSnippet
            })
            return
          }

          resolve({
            success: true,
            latencyMs,
            statusCode,
            returnedModel,
            replyPreview: reply ? reply.slice(0, 200) : undefined
          })
        } catch {
          resolve({
            success: false,
            latencyMs,
            statusCode,
            errorKind: 'bad_response',
            errorMessage: '返回内容不是合法 JSON',
            rawSnippet
          })
        }
      })
      res.on('error', (e) => {
        resolve({
          success: false,
          latencyMs: Date.now() - startTs,
          errorKind: 'unknown',
          errorMessage: e.message
        })
      })
    })

    req.setTimeout(15_000, () => {
      req.destroy()
      resolve({
        success: false,
        latencyMs: Date.now() - startTs,
        errorKind: 'unreachable',
        errorMessage: '连接超时（15 秒）'
      })
    })

    req.on('error', (e) => {
      const msg = (e as NodeJS.ErrnoException).message || String(e)
      const code = (e as NodeJS.ErrnoException).code
      let kind: TestErrorKind = 'unreachable'
      if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
        kind = 'unreachable'
      }
      resolve({
        success: false,
        latencyMs: Date.now() - startTs,
        errorKind: kind,
        errorMessage: `${code ? `[${code}] ` : ''}${msg}`
      })
    })

    req.write(body)
    req.end()
  })
}
