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
/** 默认采样条数（当前端未传 sampleSize 时使用） */
const TARGET_SAMPLE_SIZE = 600
/** 1 次会话的间隔阈值（秒）：> 该值视为"对话重启"，下条消息的发送者视为本轮发起者 */
const SESSION_GAP_SECONDS = 2 * 3600

export interface AnalyticsAiParams {
  sessionId: string
  /** 用于 AI 分析的采样条数；不传时使用默认 TARGET_SAMPLE_SIZE */
  sampleSize?: number
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

      // 1) 纯倒序采样：从最新一条向前倒推 target 条连续消息，与"角色提示词"保持一致
      const targetSize = Math.max(10, Math.floor(params.sampleSize ?? TARGET_SAMPLE_SIZE))
      const messages = await this.loadLatestMessages(params.sessionId, targetSize, signal)
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

      // 确保按时间升序（loadLatestMessages 内已排序，这里只是防御）
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
   * 倒序截取最新 N 条消息。
   * 与"角色提示词"保持一致：按时间从新到旧选取 target 条连续消息，
   * 再按时间升序返回（方便后续统计与 prompt 构建）。
   * total ≤ target 时退化为全量加载。
   */
  private async loadLatestMessages(
    sessionId: string,
    target: number,
    signal: AbortSignal
  ): Promise<Message[]> {
    const countRes = await wcdbService.getMessageCount(sessionId)
    const total = Number(countRes?.count || 0)
    if (total === 0) return []

    const effectiveTarget = Math.min(Math.max(1, target), total)
    const startOffset = total - effectiveTarget
    const BATCH = 500
    const all: Message[] = []
    let offset = startOffset
    while (offset < total) {
      if (signal.aborted) throw new Error('已取消')
      const remaining = total - offset
      const take = Math.min(BATCH, remaining)
      const r = await chatService.getMessages(sessionId, offset, take, undefined, undefined, true)
      const batch: Message[] = r?.messages || []
      if (!batch.length) break
      all.push(...batch)
      offset += batch.length
      if (batch.length < take) break
    }
    return all.sort((a, b) => (a.createTime || 0) - (b.createTime || 0))
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
