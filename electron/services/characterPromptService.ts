/**
 * 角色提示词核心服务
 *
 * 负责：
 * 1. 消息格式化（Message[] → token 紧凑纯文本）
 * 2. 双协议流式 LLM 调用（OpenAI 兼容 / Anthropic 原生）
 * 3. 生成流程编排（获取消息 → 格式化 → 组装 prompt → 流式调用 → IPC 推送 chunk）
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { CHARACTER_PROMPT_TEMPLATE } from './characterPromptTemplate'
import { characterPromptRedeemService } from './characterPromptRedeemService'
import { characterPromptExportStore } from './characterPromptExportStore'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface MemberInfo {
  wxid: string
  displayName: string
  messageCount: number
}

export interface GenerateParams {
  sessionId: string
  targetWxids: string[]
  sessionGap?: number
  apiProvider: 'openai' | 'anthropic'
  apiBaseUrl?: string
  apiKey?: string
  apiModel?: string
  useBuiltinApi?: boolean // true = 兑换码路径，使用内置 API
}

interface FormattedResult {
  text: string
  tagToName: Record<string, string>
  nameToTag: Record<string, string>
}

// ─── 内置 API 配置（兑换码路径使用） ────────────────────────────────────────
// 从环境变量读取，避免硬编码泄露。打包发布时通过启动环境注入；
// 开发期可在项目根目录的 .env.local（已加入 .gitignore）中设置。
// 亦可通过 ConfigService（用户设置）覆盖，便于内部测试。

const BUILTIN_API_URL = process.env.WEFLOW_BUILTIN_API_URL || ''
const BUILTIN_API_KEY = process.env.WEFLOW_BUILTIN_API_KEY || ''
const BUILTIN_API_MODEL = process.env.WEFLOW_BUILTIN_API_MODEL || 'claude-opus-4-6'
const BUILTIN_API_PROVIDER: 'openai' | 'anthropic' =
  (process.env.WEFLOW_BUILTIN_API_PROVIDER as 'openai' | 'anthropic') || 'openai'

// ─── 消息格式化 ────────────────────────────────────────────────────────────

const SKIP_LOCAL_TYPES = new Set([
  10000, // 系统消息
  42,    // 名片消息
  48,    // 位置消息
])

function formatMessageContent(msg: Message): string | null {
  const lt = msg.localType

  if (lt === 1) {
    return (msg.parsedContent || '').replace(/^\n+/, '')
  }
  if (lt === 34) {
    return msg.parsedContent || '[语音]'
  }
  if (lt === 3) {
    return '[图]'
  }
  if (lt === 43) {
    return '[视频]'
  }
  if (lt === 49 && msg.quotedContent) {
    const reply = (msg.parsedContent || '').replace(/\[引用\s+.*?[：:].*?\]/g, '').trim()
    return `>${msg.quotedContent}|${reply}`
  }
  if (lt === 50) {
    return '[通话]'
  }
  if (lt === 47) {
    return null
  }
  if (lt === 49 && msg.parsedContent) {
    return msg.parsedContent.replace(/^\n+/, '')
  }

  return null
}

function buildMemberMap(
  messages: Message[],
  sessionType: 'private' | 'group',
  sessionDisplayName: string,
  myWxid: string,
  selfDisplayName?: string, // 由调用方传入，与 getSessionMembers 保持一致（如 "我" / "我（昵称）"）
): { nameToTag: Record<string, string>; tagToName: Record<string, string> } {
  // 自己的显示名：优先使用调用方传入的值（与前端一致），否则从消息采样提取
  let selfName = selfDisplayName || ''
  if (!selfName) {
    for (const msg of messages) {
      if (msg.isSend === 1 && msg.senderDisplayName) {
        selfName = msg.senderDisplayName
        break
      }
    }
  }
  selfName = selfName || myWxid || '我'

  if (sessionType === 'private') {
    const otherName = sessionDisplayName || 'B'
    return {
      nameToTag: { [selfName]: 'A', [otherName]: 'B' },
      tagToName: { 'A': selfName, 'B': otherName }
    }
  }

  const counter: Record<string, number> = {}
  for (const msg of messages) {
    const name = msg.senderDisplayName || ''
    if (!name || name === sessionDisplayName) continue
    if (SKIP_LOCAL_TYPES.has(msg.localType)) continue
    counter[name] = (counter[name] || 0) + 1
  }

  const othersSorted = Object.entries(counter)
    .filter(([name]) => name !== selfName)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)

  const nameToTag: Record<string, string> = { [selfName]: 'A' }
  const tagToName: Record<string, string> = { 'A': selfName }

  for (let i = 0; i < othersSorted.length && i < 25; i++) {
    const tag = String.fromCharCode(66 + i)
    nameToTag[othersSorted[i]] = tag
    tagToName[tag] = othersSorted[i]
  }

  return { nameToTag, tagToName }
}

function formatMessages(
  messages: Message[],
  sessionType: 'private' | 'group',
  sessionDisplayName: string,
  myWxid: string,
  sessionGap: number = 7200,
  selfDisplayName?: string,
): FormattedResult {
  const { nameToTag, tagToName } = buildMemberMap(messages, sessionType, sessionDisplayName, myWxid, selfDisplayName)

  const sessions: Message[][] = []
  let current: Message[] = []

  for (const msg of messages) {
    if (SKIP_LOCAL_TYPES.has(msg.localType)) continue
    if (sessionType === 'group' && msg.senderDisplayName === sessionDisplayName) continue

    if (current.length > 0 && msg.createTime - current[current.length - 1].createTime > sessionGap) {
      sessions.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) sessions.push(current)

  sessions.reverse()

  const lines: string[] = []

  const mappingParts = Object.entries(tagToName)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, name]) => `${tag}=${name}`)
  lines.push(mappingParts.join(','))

  for (const session of sessions) {
    const dt = new Date(session[0].createTime * 1000)
    const yy = String(dt.getFullYear()).slice(2)
    const MM = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    const hh = String(dt.getHours()).padStart(2, '0')
    const mm = String(dt.getMinutes()).padStart(2, '0')
    lines.push(`@${yy}-${MM}-${dd}/${hh}:${mm}`)

    let lastTag = ''
    for (const msg of session) {
      const content = formatMessageContent(msg)
      if (content === null) continue

      let tag: string | undefined
      if (sessionType === 'private') {
        // 私聊：直接按 isSend 映射，避免 senderDisplayName 为空导致丢消息
        tag = msg.isSend === 1 ? 'A' : 'B'
      } else {
        // 群聊：按名字查表
        const senderName = msg.senderDisplayName || ''
        tag = nameToTag[senderName]
      }
      if (!tag) continue

      if (tag !== lastTag) {
        lines.push(`${tag} ${content}`)
        lastTag = tag
      } else {
        lines.push(content)
      }
    }
  }

  return { text: lines.join('\n'), tagToName, nameToTag }
}

// ─── Prompt 组装 ───────────────────────────────────────────────────────────

function buildPrompt(
  formattedText: string,
  targetTag: string,
  targetName: string,
  tagToName: Record<string, string>
): string {
  const otherParts: string[] = []
  for (const [tag, name] of Object.entries(tagToName).sort(([a], [b]) => a.localeCompare(b))) {
    if (tag === targetTag) continue
    otherParts.push(`${tag}（${name}）`)
  }
  const otherName = otherParts.join('、')

  const metaPrompt = CHARACTER_PROMPT_TEMPLATE
    .replace(/\{TARGET_ROLE\}/g, targetTag)
    .replace(/\{TARGET_NAME\}/g, targetName)
    .replace(/\{OTHER_NAME\}/g, otherName)

  return `${metaPrompt}\n\n--- 聊天记录开始 ---\n\n${formattedText}\n\n--- 聊天记录结束 ---`
}

// ─── 流式 LLM 调用 ─────────────────────────────────────────────────────────

function buildApiUrl(baseUrl: string, path: string): string {
  let base = baseUrl.replace(/\/+$/, '')
  // 若用户填的是裸根（如 http://host:3000），自动补 /v1（OpenAI/Anthropic 兼容网关常见约定）
  if (!/\/v\d+$/.test(base) && !/\/(openai|anthropic|api)/i.test(base)) {
    base = `${base}/v1`
  }
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
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

function callApiStream(
  provider: 'openai' | 'anthropic',
  apiBaseUrl: string,
  apiKey: string,
  model: string,
  promptContent: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }

    let endpoint: string
    let body: string
    let headers: Record<string, string>

    if (provider === 'anthropic') {
      endpoint = buildApiUrl(apiBaseUrl, '/messages')
      body = JSON.stringify({
        model,
        max_tokens: 16384,
        stream: true,
        messages: [{ role: 'user', content: promptContent }]
      })
      headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    } else {
      endpoint = buildApiUrl(apiBaseUrl, '/chat/completions')
      body = JSON.stringify({
        model,
        stream: true,
        messages: [{ role: 'user', content: promptContent }]
      })
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
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

      // 检测响应类型：SSE 流式 vs 非流式 JSON
      const contentType = String(res.headers['content-type'] || '').toLowerCase()
      const isStreaming = contentType.includes('event-stream') || contentType.includes('stream')

      let receivedAnyChunk = false

      // 累积所有原始响应，用于非流式兜底
      let rawBuffer = ''

      const parser = new SSEParser((event, data) => {
        if (provider === 'anthropic') {
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
        // 若 SSE 流式解析一个 chunk 都没产出，尝试按非流式 JSON 解析整段响应
        if (!receivedAnyChunk && rawBuffer) {
          try {
            // 可能是标准 JSON 响应
            const parsed = JSON.parse(rawBuffer)
            let content = ''
            if (provider === 'anthropic') {
              // Anthropic: { content: [{ type: 'text', text: '...' }] }
              if (Array.isArray(parsed?.content)) {
                content = parsed.content
                  .filter((b: { type: string }) => b?.type === 'text')
                  .map((b: { text: string }) => b?.text || '')
                  .join('')
              }
            } else {
              // OpenAI: { choices: [{ message: { content: '...' } }] } 或 delta 格式
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
            // 非 JSON，尝试纯文本
            if (rawBuffer.trim()) {
              onChunk(rawBuffer)
              receivedAnyChunk = true
            }
          }
        }

        if (!receivedAnyChunk) {
          reject(new Error(`API 返回空响应（Content-Type: ${contentType || '未知'}）：${rawBuffer.slice(0, 300)}`))
        } else {
          resolve()
        }
      })
      res.on('error', (e) => reject(e))

      // isStreaming 变量保留用于未来调试，目前两种情况统一处理
      void isStreaming
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

// ─── 生成编排 ──────────────────────────────────────────────────────────────

interface SessionCacheEntry {
  count: number           // 已缓存的消息条数（= 下一批起始 offset）
  messages: Message[]     // 正序消息
  lastUsedAt: number
  formatKey?: string      // 对应 formatted 的参数指纹
  formatted?: FormattedResult
  selfDisplayName?: string
  sessionDisplayName?: string
}

const SESSION_CACHE_LIMIT = 5

class CharacterPromptService {
  private config: ConfigService | null = null
  private abortControllers: Map<string, AbortController> = new Map()
  private taskIdCounter = 0
  private sessionCache: Map<string, SessionCacheEntry> = new Map()

  setConfig(config: ConfigService) {
    this.config = config
  }

  private touchCache(sessionId: string, entry: SessionCacheEntry) {
    entry.lastUsedAt = Date.now()
    this.sessionCache.set(sessionId, entry)
    if (this.sessionCache.size > SESSION_CACHE_LIMIT) {
      // LRU 淘汰：删除最久未用的
      let oldestKey = ''
      let oldestTs = Infinity
      for (const [k, v] of this.sessionCache.entries()) {
        if (v.lastUsedAt < oldestTs) {
          oldestTs = v.lastUsedAt
          oldestKey = k
        }
      }
      if (oldestKey && oldestKey !== sessionId) this.sessionCache.delete(oldestKey)
    }
  }

  /** 清除指定会话或全部缓存 */
  invalidateCache(sessionId?: string) {
    if (sessionId) this.sessionCache.delete(sessionId)
    else this.sessionCache.clear()
  }

  /** 获取会话成员列表（含发言量统计） */
  async getSessionMembers(sessionId: string): Promise<{
    success: boolean
    members?: MemberInfo[]
    sessionType?: 'private' | 'group'
    sessionDisplayName?: string
    error?: string
  }> {
    try {
      const sessionsResult = await wcdbService.getSessions()
      if (!sessionsResult.success || !sessionsResult.sessions) {
        return { success: false, error: '无法获取会话列表' }
      }

      const session = sessionsResult.sessions.find(
        (s: { username: string }) => s.username === sessionId
      )
      if (!session) {
        return { success: false, error: '未找到该会话' }
      }

      const isGroup = sessionId.includes('@chatroom')
      const sessionType = isGroup ? 'group' as const : 'private' as const
      const sessionDisplayName = session.displayName || session.username
      const myWxid = String(this.config?.get('myWxid') || '')

      // 私聊：直接返回两个成员，采样最近 50 条消息统计各自发言量
      if (!isGroup) {
        const sampleResult = await chatService.getLatestMessages(sessionId, 50)
        const sampleMessages: Message[] = sampleResult?.messages || sampleResult || []

        let selfName = ''
        let otherName = ''
        let selfCount = 0
        let otherCount = 0
        for (const msg of sampleMessages) {
          if (msg.isSend === 1) {
            selfCount++
            if (msg.senderDisplayName && !selfName) selfName = msg.senderDisplayName
          } else {
            otherCount++
            if (msg.senderDisplayName && !otherName) otherName = msg.senderDisplayName
          }
        }

        // 通过 contact 接口获取对方备注/昵称作为主来源
        if (!otherName) {
          try {
            const contact = await chatService.getContact(sessionId)
            if (contact) {
              otherName = contact.remark || contact.nickName || contact.alias || ''
            }
          } catch { /* 忽略 */ }
        }
        // 会话 displayName 兜底（可能已经是备注）
        if (!otherName) {
          otherName = sessionDisplayName && sessionDisplayName !== sessionId
            ? sessionDisplayName
            : sessionId
        }

        // 自己的显示名：优先用消息采样中的 senderDisplayName，其次从 contact 取，最后统一回退到"我"
        if (!selfName && myWxid) {
          try {
            const selfContact = await chatService.getContact(myWxid)
            if (selfContact) {
              selfName = selfContact.nickName || selfContact.remark || selfContact.alias || ''
            }
          } catch { /* 忽略 */ }
        }
        // 最终回退：避免显示冗长的 wxid，直接用"我"
        if (!selfName) selfName = '我'
        else if (selfName === myWxid) selfName = '我' // 如果名字还是 wxid，也替换为"我"
        else selfName = `我（${selfName}）` // 有昵称时附加显示

        const countResult = await wcdbService.getMessageCount(sessionId)
        const totalCount = Number(countResult?.count || 0)
        const sampleTotal = selfCount + otherCount || 1
        const estSelf = Math.round(totalCount * selfCount / sampleTotal)
        const estOther = totalCount - estSelf

        return {
          success: true,
          sessionType,
          sessionDisplayName: otherName,
          members: [
            { wxid: myWxid, displayName: selfName, messageCount: estSelf },
            { wxid: sessionId, displayName: otherName, messageCount: estOther }
          ]
        }
      }

      // 群聊：采样最近 1000 条消息快速统计
      const sampleResult = await chatService.getLatestMessages(sessionId, 1000)
      const messages: Message[] = sampleResult?.messages || sampleResult || []

      const counterMap: Record<string, { wxid: string; displayName: string; count: number }> = {}
      for (const msg of messages) {
        if (SKIP_LOCAL_TYPES.has(msg.localType)) continue
        const wxid = msg.senderUsername || (msg.isSend === 1 ? myWxid : '')
        if (!wxid) continue
        const name = msg.senderDisplayName || wxid
        if (!counterMap[wxid]) {
          counterMap[wxid] = { wxid, displayName: name, count: 0 }
        }
        counterMap[wxid].count++
        if (msg.senderDisplayName) {
          counterMap[wxid].displayName = msg.senderDisplayName
        }
      }

      const members: MemberInfo[] = Object.values(counterMap)
        .sort((a, b) => b.count - a.count)

      return { success: true, members, sessionType, sessionDisplayName }
    } catch (e) {
      return { success: false, error: `获取成员失败: ${(e as Error).message}` }
    }
  }

  /** 启动生成任务 */
  async generate(params: GenerateParams): Promise<{ success: boolean; taskId?: string; error?: string }> {
    const taskId = `cp_${++this.taskIdCounter}_${Date.now()}`

    let apiBaseUrl: string
    let apiKey: string
    let apiModel: string
    let apiProvider: 'openai' | 'anthropic'

    if (params.useBuiltinApi) {
      // 兑换码路径：使用内置 API，先检查次数
      if (!characterPromptRedeemService.hasRemainingUses()) {
        return { success: false, error: '可用次数已耗尽，请兑换新的使用码' }
      }
      if (!BUILTIN_API_URL || !BUILTIN_API_KEY) {
        // 内置 API 未配置时，回退到用户的共享 AI 配置
        apiBaseUrl = String(this.config?.get('aiModelApiBaseUrl') || '').trim()
        apiKey = String(this.config?.get('aiModelApiKey') || '').trim()
        apiModel = String(this.config?.get('aiModelApiModel') || '').trim()
        apiProvider = params.apiProvider || 'openai'
      } else {
        apiBaseUrl = BUILTIN_API_URL
        apiKey = BUILTIN_API_KEY
        apiModel = BUILTIN_API_MODEL
        apiProvider = BUILTIN_API_PROVIDER
      }
    } else {
      // 自备 API 路径
      apiBaseUrl = params.apiBaseUrl || String(this.config?.get('aiModelApiBaseUrl') || '').trim()
      apiKey = params.apiKey || String(this.config?.get('aiModelApiKey') || '').trim()
      apiModel = params.apiModel || String(this.config?.get('aiModelApiModel') || '').trim()
      apiProvider = params.apiProvider
    }

    if (!apiBaseUrl || !apiKey) {
      return { success: false, error: '请先配置 API 地址和 Key' }
    }

    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    // 异步执行
    this.executeGeneration(taskId, params, apiBaseUrl, apiKey, apiModel, apiProvider, abortController.signal)

    return { success: true, taskId }
  }

  stop(taskId: string): { success: boolean } {
    const controller = this.abortControllers.get(taskId)
    if (controller) {
      controller.abort()
      this.abortControllers.delete(taskId)
    }
    return { success: true }
  }

  private async executeGeneration(
    taskId: string,
    params: GenerateParams,
    apiBaseUrl: string,
    apiKey: string,
    apiModel: string,
    apiProvider: 'openai' | 'anthropic',
    signal: AbortSignal
  ) {
    const broadcast = (channel: string, data: unknown) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, data)
        }
      }
    }

    try {
      broadcast('characterPrompt:progress', {
        taskId, phase: 'loading', message: '正在加载聊天记录...'
      })

      const myWxid = String(this.config?.get('myWxid') || '')
      const isGroup = params.sessionId.includes('@chatroom')
      const sessionType = isGroup ? 'group' as const : 'private' as const

      const sessionsResult = await wcdbService.getSessions()
      const session = sessionsResult.sessions?.find(
        (s: { username: string }) => s.username === params.sessionId
      )
      let sessionDisplayName = session?.displayName || params.sessionId

      // 与 getSessionMembers 保持一致的名称解析
      let selfDisplayName = ''
      if (!isGroup) {
        const sampleResult = await chatService.getLatestMessages(params.sessionId, 50)
        const sampleMessages: Message[] = sampleResult?.messages || sampleResult || []
        let selfName = ''
        let otherName = ''
        for (const msg of sampleMessages) {
          if (msg.isSend === 1) {
            if (msg.senderDisplayName && !selfName) selfName = msg.senderDisplayName
          } else {
            if (msg.senderDisplayName && !otherName) otherName = msg.senderDisplayName
          }
        }
        if (!otherName) {
          try {
            const contact = await chatService.getContact(params.sessionId)
            if (contact) otherName = contact.remark || contact.nickName || contact.alias || ''
          } catch { /* 忽略 */ }
        }
        if (!otherName) {
          otherName = sessionDisplayName && sessionDisplayName !== params.sessionId
            ? sessionDisplayName
            : params.sessionId
        }
        if (!selfName && myWxid) {
          try {
            const selfContact = await chatService.getContact(myWxid)
            if (selfContact) selfName = selfContact.nickName || selfContact.remark || selfContact.alias || ''
          } catch { /* 忽略 */ }
        }
        if (!selfName) selfDisplayName = '我'
        else if (selfName === myWxid) selfDisplayName = '我'
        else selfDisplayName = `我（${selfName}）`
        sessionDisplayName = otherName
      }

      // 消息加载：优先走磁盘导出存储（若已配置目录）；未配置则走内存 LRU
      const exportDir = String(this.config?.get('characterPromptExportDir' as 'aiModelApiBaseUrl') || '').trim()
      let allMessages: Message[] = []

      if (exportDir) {
        // 磁盘路径：首次落盘 or 增量追加 or 全量命中
        const exportResult = await characterPromptExportStore.ensureExport({
          dir: exportDir,
          sessionId: params.sessionId,
          myWxid,
          sessionDisplayName,
          selfDisplayName,
          onProgress: (payload) => {
            broadcast('characterPrompt:progress', {
              taskId,
              phase: payload.stage,
              stage: payload.stage,
              message: payload.message,
              current: payload.current,
              total: payload.total,
              indeterminate: payload.indeterminate
            })
          },
          signal
        })
        allMessages = exportResult.messages
        broadcast('characterPrompt:progress', {
          taskId,
          phase: 'loaded',
          stage: 'loaded',
          message: `已${exportResult.hitKind === 'full' ? '命中' : exportResult.hitKind === 'incremental' ? '增量更新' : '导出'}聊天记录 ${allMessages.length} 条`,
          current: allMessages.length,
          total: allMessages.length
        })
      } else {
        // 内存 LRU 路径（兼容未配置导出目录的场景）
        const cached = this.sessionCache.get(params.sessionId)
        allMessages = cached ? cached.messages : []
        const BATCH_SIZE = 500
        let offset = cached ? cached.count : 0
        const startOffset = offset
        const countResult = await wcdbService.getMessageCount(params.sessionId)
        const dbTotal = Number(countResult?.count || 0)
        while (true) {
          if (signal.aborted) throw new Error('已取消')
          const result = await chatService.getMessages(
            params.sessionId, offset, BATCH_SIZE, undefined, undefined, true
          )
          const batchMessages: Message[] = result?.messages || []
          if (batchMessages.length === 0) break
          allMessages.push(...batchMessages)
          broadcast('characterPrompt:progress', {
            taskId,
            phase: 'exporting',
            stage: 'exporting',
            message: cached
              ? `正在增量加载新消息...`
              : `正在从数据库加载聊天记录...`,
            current: allMessages.length,
            total: dbTotal || undefined
          })
          if (batchMessages.length < BATCH_SIZE) break
          offset += BATCH_SIZE
        }
      }

      if (allMessages.length === 0) {
        broadcast('characterPrompt:error', { taskId, error: '该会话没有消息记录' })
        return
      }

      // 写回内存缓存（两条路径都复用，用于同进程后续重试/换目标）
      const existingCache = this.sessionCache.get(params.sessionId)
      const cacheEntry: SessionCacheEntry = existingCache || {
        count: 0, messages: allMessages, lastUsedAt: Date.now()
      }
      cacheEntry.messages = allMessages
      cacheEntry.count = allMessages.length
      cacheEntry.selfDisplayName = selfDisplayName
      cacheEntry.sessionDisplayName = sessionDisplayName

      broadcast('characterPrompt:progress', {
        taskId,
        phase: 'formatting',
        stage: 'formatting',
        message: `正在格式化 ${allMessages.length} 条消息...`,
        indeterminate: true
      })

      const formatKey = `${sessionType}|${params.sessionGap || 7200}|${selfDisplayName}|${sessionDisplayName}|${allMessages.length}`
      let formatted: FormattedResult
      if (cacheEntry.formatKey === formatKey && cacheEntry.formatted) {
        formatted = cacheEntry.formatted
      } else {
        formatted = formatMessages(
          allMessages, sessionType, sessionDisplayName, myWxid, params.sessionGap || 7200, selfDisplayName
        )
        cacheEntry.formatKey = formatKey
        cacheEntry.formatted = formatted
      }
      this.touchCache(params.sessionId, cacheEntry)

      // 为每个目标生成
      for (const targetWxid of params.targetWxids) {
        if (signal.aborted) throw new Error('已取消')

        let targetTag = ''
        let targetName = ''

        // 1) 自己：targetWxid === myWxid → 'A'
        if (myWxid && targetWxid === myWxid) {
          targetTag = 'A'
          targetName = formatted.tagToName['A'] || selfDisplayName || '我'
        }
        // 2) 私聊对方：targetWxid === sessionId → 'B'
        else if (!isGroup && targetWxid === params.sessionId) {
          targetTag = 'B'
          targetName = formatted.tagToName['B'] || sessionDisplayName
        }
        // 3) 群聊：通过 senderUsername 找到对应的 senderDisplayName，再定位 tag
        else {
          let resolvedName = ''
          for (const msg of allMessages) {
            if (msg.senderUsername === targetWxid && msg.senderDisplayName) {
              resolvedName = msg.senderDisplayName
              break
            }
          }
          if (resolvedName && formatted.nameToTag[resolvedName]) {
            targetTag = formatted.nameToTag[resolvedName]
            targetName = resolvedName
          } else {
            // 兜底：直接用 targetWxid 作为 name 查表
            for (const [name, tag] of Object.entries(formatted.nameToTag)) {
              if (name === targetWxid || tag === targetWxid) {
                targetTag = tag
                targetName = name
                break
              }
            }
          }
        }

        if (!targetTag) {
          broadcast('characterPrompt:error', {
            taskId, targetName: targetWxid,
            error: `未找到成员 "${targetWxid}" 的消息记录`
          })
          continue
        }

        broadcast('characterPrompt:progress', {
          taskId,
          phase: 'prompting',
          stage: 'prompting',
          targetName,
          message: `正在请求 AI 为 ${targetName} 生成角色提示词...`,
          indeterminate: true
        })

        const fullPrompt = buildPrompt(formatted.text, targetTag, targetName, formatted.tagToName)

        let fullText = ''
        let streamStarted = false
        await callApiStream(
          apiProvider, apiBaseUrl, apiKey, apiModel, fullPrompt,
          (chunk) => {
            fullText += chunk
            broadcast('characterPrompt:chunk', { taskId, targetName, chunk })
            if (!streamStarted) {
              streamStarted = true
              broadcast('characterPrompt:progress', {
                taskId,
                phase: 'streaming',
                stage: 'streaming',
                targetName,
                message: `AI 正在为 ${targetName} 输出...`,
                indeterminate: true
              })
            }
          },
          signal
        )

        // 兑换码路径：生成成功后扣减次数
        if (params.useBuiltinApi) {
          const consumeResult = characterPromptRedeemService.consumeOneUse()
          broadcast('characterPrompt:usesUpdated', {
            taskId, remaining: consumeResult.remaining
          })
        }

        broadcast('characterPrompt:complete', { taskId, targetName, fullText })
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== '已取消') {
        broadcast('characterPrompt:error', { taskId, error: msg })
      }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }
}

export const characterPromptService = new CharacterPromptService()
