import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { callAiStream, callAiOnce, getBuiltinAiConfig, type AiConfig, type AiProvider } from './aiStreamService'
import { characterPromptRedeemService } from './characterPromptRedeemService'
import type { AnnualReportData } from './annualReportService'
import { buildNarrationPrompt, buildTitlePrompt, parseTitleJson } from './annualReportAiTemplate'

export interface AnnualReportAiParams {
  reportData: AnnualReportData
  useBuiltinApi?: boolean
  apiBaseUrl?: string
  apiKey?: string
  apiModel?: string
  apiProvider?: AiProvider
}

class AnnualReportAiService {
  private config: ConfigService | null = null
  private abortControllers: Map<string, AbortController> = new Map()
  private taskIdCounter = 0

  setConfig(config: ConfigService) {
    this.config = config
  }

  private resolveAiConfig(params: AnnualReportAiParams): { config: AiConfig; useBuiltin: boolean; error?: string } {
    if (params.useBuiltinApi) {
      const builtin = getBuiltinAiConfig()
      if (!characterPromptRedeemService.hasRemainingUses()) {
        return { config: null as unknown as AiConfig, useBuiltin: true, error: '可用次数已耗尽，请兑换新的使用码' }
      }
      if (builtin.configured) {
        return { config: builtin, useBuiltin: true }
      }
      // 内置未配置，回退用户共享 AI 配置
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

  /**
   * 启动叙事生成（流式）
   */
  async generateNarration(params: AnnualReportAiParams): Promise<{ success: boolean; taskId?: string; error?: string }> {
    const taskId = `arai_narr_${++this.taskIdCounter}_${Date.now()}`
    const { config, useBuiltin, error } = this.resolveAiConfig(params)
    if (error) return { success: false, error }

    const abort = new AbortController()
    this.abortControllers.set(taskId, abort)

    // 异步执行
    this.executeNarration(taskId, config, params, useBuiltin, abort.signal)
    return { success: true, taskId }
  }

  private async executeNarration(
    taskId: string,
    config: AiConfig,
    params: AnnualReportAiParams,
    useBuiltin: boolean,
    signal: AbortSignal
  ) {
    try {
      this.broadcast('annualReportAi:progress', { taskId, message: '正在构建叙事模板...' })
      const prompt = buildNarrationPrompt(params.reportData)

      this.broadcast('annualReportAi:progress', { taskId, message: 'AI 正在撰写叙事...' })
      let fullText = ''
      await callAiStream({
        config,
        prompt,
        maxTokens: 8000,
        onChunk: (chunk) => {
          fullText += chunk
          this.broadcast('annualReportAi:chunk', { taskId, chunk })
        },
        signal
      })

      if (useBuiltin) {
        const r = characterPromptRedeemService.consumeOneUse()
        this.broadcast('annualReportAi:usesUpdated', { taskId, remaining: r.remaining })
      }

      this.broadcast('annualReportAi:complete', { taskId, fullText })
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== '已取消') {
        this.broadcast('annualReportAi:error', { taskId, error: msg })
      }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  /**
   * 生成个性化标题（非流式，单次返回 JSON）
   */
  async generateTitle(params: AnnualReportAiParams): Promise<{
    success: boolean
    title?: string
    subtitle?: string
    error?: string
  }> {
    const { config, useBuiltin, error } = this.resolveAiConfig(params)
    if (error) return { success: false, error }

    const abort = new AbortController()
    const taskId = `arai_title_${++this.taskIdCounter}_${Date.now()}`
    this.abortControllers.set(taskId, abort)

    try {
      const prompt = buildTitlePrompt(params.reportData)
      const raw = await callAiOnce({
        config,
        prompt,
        maxTokens: 500,
        signal: abort.signal
      })
      const { title, subtitle } = parseTitleJson(raw)

      if (useBuiltin) {
        const r = characterPromptRedeemService.consumeOneUse()
        this.broadcast('annualReportAi:usesUpdated', { taskId, remaining: r.remaining })
      }

      if (!title) {
        return { success: false, error: `AI 返回的标题无法解析：${raw.slice(0, 200)}` }
      }
      return { success: true, title, subtitle }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    } finally {
      this.abortControllers.delete(taskId)
    }
  }

  stop(taskId: string): { success: boolean } {
    const ctrl = this.abortControllers.get(taskId)
    if (ctrl) {
      ctrl.abort()
      this.abortControllers.delete(taskId)
    }
    return { success: true }
  }

  getRemainingUses(): { remaining: number } {
    return { remaining: characterPromptRedeemService.getRemainingUses() }
  }
}

export const annualReportAiService = new AnnualReportAiService()
