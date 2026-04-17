import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'
import { callAiStream, getBuiltinAiConfig, type AiConfig, type AiProvider } from './aiStreamService'
import { characterPromptRedeemService } from './characterPromptRedeemService'
import { buildStyleContrastPrompt } from './analyticsAiTemplate'
import type { Message } from './chatService'

const SKIP_LOCAL_TYPES = new Set([10000, 42, 48])
const STYLE_CONTRAST_TEMPERATURE = 0.6
/** 分层采样：目标总条数与时间段数 */
const TARGET_SAMPLE_SIZE = 600
const SAMPLE_SEGMENTS = 4
/** 1 次会话的间隔阈值（秒）：> 该值视为"对话重启"，下条消息的发送者视为本轮发起者 */
const SESSION_GAP_SECONDS = 2 * 3600

export interface AnalyticsAiParams {
  sessionId: string
  useBuiltinApi?: boolean
  apiBaseUrl?: string
  apiKey?: string
  apiModel?: string
  apiProvider?: AiProvider
}

class AnalyticsAiService {
  private config: ConfigService | null = null
  private abortControllers: Map<string, AbortController> = new Map()
  private taskIdCounter = 0

  setConfig(config: ConfigService) {
    this.config = config
  }

  private resolveAiConfig(params: AnalyticsAiParams): { config: AiConfig; useBuiltin: boolean; error?: string } {
    if (params.useBuiltinApi) {
      const builtin = getBuiltinAiConfig()
      if (!characterPromptRedeemService.hasRemainingUses()) {
        return { config: null as unknown as AiConfig, useBuiltin: true, error: '可用次数已耗尽，请兑换新的使用码' }
      }
      if (builtin.configured) return { config: builtin, useBuiltin: true }
      const apiBaseUrl = String(this.config?.get('aiModelApiBaseUrl') || '').trim()
      const apiKey = String(this.config?.get('aiModelApiKey') || '').trim()
      const apiModel = String(this.config?.get('aiModelApiModel') || '').trim()
      if (!apiBaseUrl || !apiKey) {
        return { config: null as unknown as AiConfig, useBuiltin: true, error: '内置 API 未配置且用户共享 AI 配置为空' }
      }
      return {
        config: { provider: params.apiProvider || 'openai', apiBaseUrl, apiKey, model: apiModel || 'gpt-4o' },
        useBuiltin: true
      }
    }
    const apiBaseUrl = params.apiBaseUrl || String(this.config?.get('aiModelApiBaseUrl') || '').trim()
    const apiKey = params.apiKey || String(this.config?.get('aiModelApiKey') || '').trim()
    const apiModel = params.apiModel || String(this.config?.get('aiModelApiModel') || '').trim()
    if (!apiBaseUrl || !apiKey) {
      return { config: null as unknown as AiConfig, useBuiltin: false, error: '请先配置 API 地址和 Key' }
    }
    return {
      config: { provider: params.apiProvider || 'openai', apiBaseUrl, apiKey, model: apiModel || 'gpt-4o' },
      useBuiltin: false
    }
  }

  private broadcast(channel: string, data: unknown) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
  }

  async generateStyleContrast(params: AnalyticsAiParams): Promise<{ success: boolean; taskId?: string; error?: string }> {
    const taskId = `anlai_${++this.taskIdCounter}_${Date.now()}`
    const resolved = this.resolveAiConfig(params)
    if (resolved.error) return { success: false, error: resolved.error }
    if (params.sessionId.includes('@chatroom')) {
      return { success: false, error: '当前仅支持双人会话的风格对比' }
    }
    const abort = new AbortController()
    this.abortControllers.set(taskId, abort)
    this.execute(taskId, resolved.config, params, resolved.useBuiltin, abort.signal)
    return { success: true, taskId }
  }

  private async execute(
    taskId: string,
    config: AiConfig,
    params: AnalyticsAiParams,
    useBuiltin: boolean,
    signal: AbortSignal
  ) {
    try {
      this.broadcast('analyticsAi:progress', { taskId, message: '正在加载会话数据...' })
      const myWxid = String(this.config?.get('myWxid') || '')

      // 1) 分层采样：按时间四等分，每段等量抽取，既保留早期也保留近期
      const messages = await this.stratifiedSample(params.sessionId, TARGET_SAMPLE_SIZE, SAMPLE_SEGMENTS, signal)
      if (!messages.length) {
        this.broadcast('analyticsAi:error', { taskId, error: '该会话没有消息记录' })
        return
      }

      // 2) 解析名字
      let selfName = ''
      let otherName = ''
      for (const m of messages) {
        const msg = m as Message & { isSend?: number; senderDisplayName?: string }
        if (msg.isSend === 1) {
          if (msg.senderDisplayName && !selfName) selfName = msg.senderDisplayName
        } else {
          if (msg.senderDisplayName && !otherName) otherName = msg.senderDisplayName
        }
      }
      if (!otherName) {
        try {
          const c = await chatService.getContact(params.sessionId)
          if (c) otherName = c.remark || c.nickName || c.alias || ''
        } catch { /* ignore */ }
      }
      if (!otherName) otherName = params.sessionId
      if (selfName === myWxid || !selfName) selfName = '我'
      else selfName = `我（${selfName}）`

      // 3) 简单统计 + 3 个新量化指标（回复延迟中位数 / 夜聊占比 / 发起者占比）
      let selfCount = 0
      let otherCount = 0
      let textMessages = 0, imageMessages = 0, voiceMessages = 0, emojiMessages = 0
      let nightCount = 0       // 23-6 点发送数
      let selfInitiated = 0
      let otherInitiated = 0
      const replyDelaysSelf: number[] = []   // B→A 的延迟
      const replyDelaysOther: number[] = []  // A→B 的延迟
      const dateSet = new Set<string>()
      let firstTs: number | null = null, lastTs: number | null = null

      // 确保按时间升序（stratifiedSample 内已排序，这里只是防御）
      const asc = [...messages].sort((a, b) => (a.createTime || 0) - (b.createTime || 0))

      let prevTsSec = 0
      let prevIsSend: number | null = null
      for (const m of asc) {
        const msg = m as Message & { isSend?: number; localType?: number; createTime?: number }
        const lt = msg.localType
        const isSend = msg.isSend ?? 0
        if (isSend === 1) selfCount++; else otherCount++
        if (lt === 1) textMessages++
        else if (lt === 3) imageMessages++
        else if (lt === 34) voiceMessages++
        else if (lt === 47) emojiMessages++

        const tsSec = Number(msg.createTime || 0)
        if (tsSec > 0) {
          const tsMs = tsSec < 1e12 ? tsSec * 1000 : tsSec
          if (!firstTs || tsMs < firstTs) firstTs = tsMs
          if (!lastTs || tsMs > lastTs) lastTs = tsMs
          const d = new Date(tsMs)
          dateSet.add(d.toISOString().slice(0, 10))
          const h = d.getHours()
          if (h >= 23 || h < 6) nightCount++

          // 发起者：距上一条消息间隔 > 阈值（或首条）算新会话
          if (prevTsSec === 0 || tsSec - prevTsSec > SESSION_GAP_SECONDS) {
            if (isSend === 1) selfInitiated++; else otherInitiated++
          } else if (prevIsSend !== null && prevIsSend !== isSend) {
            // 回复延迟：发送方切换时的间隔
            const delta = tsSec - prevTsSec
            if (delta >= 0 && delta <= 24 * 3600) {
              if (isSend === 1) replyDelaysSelf.push(delta)
              else replyDelaysOther.push(delta)
            }
          }
          prevTsSec = tsSec
          prevIsSend = isSend
        }
      }

      const median = (arr: number[]): number | null => {
        if (!arr.length) return null
        const s = [...arr].sort((a, b) => a - b)
        const mid = Math.floor(s.length / 2)
        return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
      }
      const medianReplyDelaySelf = median(replyDelaysSelf)
      const medianReplyDelayOther = median(replyDelaysOther)
      const nightRatio = messages.length > 0 ? nightCount / messages.length : 0
      const initiatorTotal = selfInitiated + otherInitiated
      const selfInitiatorRatio = initiatorTotal > 0 ? selfInitiated / initiatorTotal : 0

      // 4) 构建样本（A/B 标签化）
      const lines: string[] = []
      let lastTag = ''
      for (const m of messages) {
        const msg = m as Message & { isSend?: number; localType?: number; parsedContent?: string; quotedContent?: string }
        if (SKIP_LOCAL_TYPES.has(msg.localType || 0)) continue
        let content = ''
        const lt = msg.localType
        if (lt === 1) content = (msg.parsedContent || '').replace(/^\n+/, '')
        else if (lt === 34) content = msg.parsedContent || '[语音]'
        else if (lt === 3) content = '[图]'
        else if (lt === 43) content = '[视频]'
        else if (lt === 47) continue
        else if (lt === 49 && msg.quotedContent) {
          const reply = (msg.parsedContent || '').replace(/\[引用\s+.*?[：:].*?\]/g, '').trim()
          content = `>${msg.quotedContent}|${reply}`
        } else if (lt === 49 && msg.parsedContent) content = msg.parsedContent.replace(/^\n+/, '')
        if (!content) continue
        const tag = msg.isSend === 1 ? 'A' : 'B'
        if (tag === lastTag) {
          lines.push(content)
        } else {
          lines.push(`${tag}: ${content}`)
          lastTag = tag
        }
      }
      const sampleText = lines.slice(-400).join('\n')  // 取最后 400 条压缩

      this.broadcast('analyticsAi:progress', { taskId, message: 'AI 正在分析双人风格...' })

      const prompt = buildStyleContrastPrompt({
        sessionDisplayName: otherName,
        selfName,
        otherName,
        stats: {
          totalMessages: messages.length,
          selfCount,
          otherCount,
          textMessages,
          imageMessages,
          voiceMessages,
          emojiMessages,
          firstMessageTime: firstTs,
          lastMessageTime: lastTs,
          activeDays: dateSet.size,
          medianReplyDelaySelf,
          medianReplyDelayOther,
          nightRatio,
          selfInitiatorRatio,
          initiatorSampleSize: initiatorTotal
        },
        sampleMessages: sampleText
      })

      let fullText = ''
      await callAiStream({
        config,
        prompt,
        maxTokens: 6000,
        temperature: STYLE_CONTRAST_TEMPERATURE,
        onChunk: (chunk) => {
          fullText += chunk
          this.broadcast('analyticsAi:chunk', { taskId, chunk })
        },
        signal
      })

      if (useBuiltin) {
        const r = characterPromptRedeemService.consumeOneUse()
        this.broadcast('analyticsAi:usesUpdated', { taskId, remaining: r.remaining })
      }

      this.broadcast('analyticsAi:complete', { taskId, fullText, meta: { selfName, otherName } })
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== '已取消') {
        this.broadcast('analyticsAi:error', { taskId, error: msg })
      }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  /**
   * 按时间分层采样：若总条数 ≤ target 直接全取；否则把消息流按等份时间段切 N 段，
   * 每段内部均匀抽取 target/N 条，并保证最新一段命中尾部（即"最新"消息必在采样内）。
   * 实现层面为了避免把全部消息拉到内存，改为按偏移量抽：
   *   1) getMessageCount 拿总数 count
   *   2) 每段 segmentSize = count / N，段内步长 step = segmentSize / perSeg
   *   3) 在每段内按 step 逐个取 offset 的单条消息（一次取一个 batch=1 的窗口）
   */
  private async stratifiedSample(
    sessionId: string,
    target: number,
    segments: number,
    signal: AbortSignal
  ): Promise<Message[]> {
    const countRes = await wcdbService.getMessageCount(sessionId)
    const total = Number(countRes?.count || 0)
    if (total === 0) return []

    if (total <= target) {
      // 全量加载（按消息时间升序返回）
      const all: Message[] = []
      const BATCH = 500
      let offset = 0
      while (true) {
        if (signal.aborted) throw new Error('已取消')
        const r = await chatService.getMessages(sessionId, offset, BATCH, undefined, undefined, true)
        const batch: Message[] = r?.messages || []
        if (!batch.length) break
        all.push(...batch)
        if (batch.length < BATCH) break
        offset += BATCH
      }
      return all.sort((a, b) => (a.createTime || 0) - (b.createTime || 0))
    }

    // 分层抽取：每段取一块连续窗口（而非单条采样，便于 AI 看到真实对话节奏）
    // 每段窗口长度 perSeg，从段起点读取；最后一段对齐到 total - 1 以保证命中最新消息
    const perSeg = Math.floor(target / segments)
    const segmentSize = total / segments

    const picked = new Map<number, Message>() // key = sortable timestamp
    for (let s = 0; s < segments; s++) {
      if (signal.aborted) throw new Error('已取消')
      const segStart = Math.floor(s * segmentSize)
      const segEndInclusive = Math.min(total - 1, Math.floor((s + 1) * segmentSize) - 1)
      const windowLen = Math.min(perSeg, segEndInclusive - segStart + 1)
      let offset = segStart
      // 最后一段：把窗口向末尾对齐，保证采到最新消息
      if (s === segments - 1) offset = Math.max(segStart, total - windowLen)
      const r = await chatService.getMessages(sessionId, offset, windowLen, undefined, undefined, true)
      const batch: Message[] = r?.messages || []
      for (const msg of batch) {
        const ts = (msg.createTime || 0) * 1_000_000 + (msg.localId || 0)
        if (!picked.has(ts)) picked.set(ts, msg)
      }
    }

    return Array.from(picked.values()).sort((a, b) => (a.createTime || 0) - (b.createTime || 0))
  }

  stop(taskId: string): { success: boolean } {
    const ctrl = this.abortControllers.get(taskId)
    if (ctrl) { ctrl.abort(); this.abortControllers.delete(taskId) }
    return { success: true }
  }

  getRemainingUses(): { remaining: number } {
    return { remaining: characterPromptRedeemService.getRemainingUses() }
  }
}

export const analyticsAiService = new AnalyticsAiService()
