import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService } from './chatService'
import { callAiStream, getBuiltinAiConfig, type AiConfig, type AiProvider } from './aiStreamService'
import { characterPromptRedeemService } from './characterPromptRedeemService'
import { buildStyleContrastPrompt } from './analyticsAiTemplate'
import type { Message } from './chatService'

const SKIP_LOCAL_TYPES = new Set([10000, 42, 48])

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

      // 1) 获取最近 500 条消息样本
      const sampleResult = await chatService.getLatestMessages(params.sessionId, 500)
      const messages: Message[] = sampleResult?.messages || []
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

      // 3) 简单统计
      let selfCount = 0
      let otherCount = 0
      let textMessages = 0, imageMessages = 0, voiceMessages = 0, emojiMessages = 0
      const dateSet = new Set<string>()
      let firstTs: number | null = null, lastTs: number | null = null
      for (const m of messages) {
        const msg = m as Message & { isSend?: number; localType?: number; createTime?: number }
        if (msg.isSend === 1) selfCount++; else otherCount++
        const lt = msg.localType
        if (lt === 1) textMessages++
        else if (lt === 3) imageMessages++
        else if (lt === 34) voiceMessages++
        else if (lt === 47) emojiMessages++
        if (msg.createTime) {
          const ts = msg.createTime < 1e12 ? msg.createTime * 1000 : msg.createTime
          if (!firstTs || ts < firstTs) firstTs = ts
          if (!lastTs || ts > lastTs) lastTs = ts
          dateSet.add(new Date(ts).toISOString().slice(0, 10))
        }
      }

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
          activeDays: dateSet.size
        },
        sampleMessages: sampleText
      })

      let fullText = ''
      await callAiStream({
        config,
        prompt,
        maxTokens: 6000,
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
