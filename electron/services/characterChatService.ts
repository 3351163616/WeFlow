/**
 * 模拟微信角色聊天 · 主服务（里程碑 1：画像生成 + 查询）
 *
 * 复用能力：
 *  - chatService.getMessages：拉取消息
 *  - wcdbService.getSessions / getMessageCount：会话元数据与计数
 *  - aiStreamService.callAiStream：统一流式 AI 调用
 *  - CHARACTER_PROMPT_TEMPLATE：现有角色提示词 Meta-Prompt（经验证的 Markdown 画像模板）
 *
 * 本期仅支持私聊；采样策略为"倒序取最近 N 条"并按会话 gap 分段，然后投喂给 AI。
 */

import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { CHARACTER_PROMPT_TEMPLATE } from './characterPromptTemplate'
import { callAiStream, getBuiltinAiConfig, type AiProvider, type AiConfig, type AiTurn } from './aiStreamService'
import { characterChatStore, type CharacterProfile, type ChatMessage } from './characterChatStore'
import {
  buildIndex as buildRetrievalIndex,
  retrieve as retrieveSnippets,
  invalidateIndexCache,
  type BuildIndexProgress,
  type RetrievedSnippet
} from './characterChatRetriever'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface GenerateProfileParams {
  /** 联系人 wxid（私聊会话 id） */
  contactId: string
  /** 采样条数上限，默认 2000；上限 10000（更大由调用方自担超窗风险） */
  sampleSize?: number
  /** 会话断句的最大时间间隔（秒），默认 7200 = 2 小时 */
  sessionGap?: number
  /** AI 提供商（前端传；内置路径用 useBuiltinApi） */
  apiProvider?: AiProvider
  apiBaseUrl?: string
  apiKey?: string
  apiModel?: string
  useBuiltinApi?: boolean
}

export interface GenerateProfileResult {
  success: boolean
  taskId?: string
  error?: string
}

interface ProgressPayload {
  taskId: string
  phase: 'loading' | 'formatting' | 'generating' | 'saving' | 'done'
  message: string
  /** 可选：已加载消息数 / 总需加载数，用于显示进度条 */
  current?: number
  total?: number
  indeterminate?: boolean
}

interface ChunkPayload {
  taskId: string
  contactId: string
  chunk: string
}

interface CompletePayload {
  taskId: string
  contactId: string
  profile: CharacterProfile
}

interface ErrorPayload {
  taskId: string
  contactId?: string
  error: string
}

// ─── 常量 ──────────────────────────────────────────────────────────────────

const DEFAULT_SAMPLE_SIZE = 2000
const MAX_SAMPLE_SIZE = 10000
const MIN_MESSAGES_REQUIRED = 20
const DEFAULT_SESSION_GAP = 7200
const MESSAGE_BATCH_SIZE = 500
const PROFILE_VERSION = 1

/** 单轮对话回复上限（token），与 characterPrompt 对齐 */
const REPLY_MAX_TOKENS = 16384
/** 对话历史窗口（条，不含本轮用户输入） */
const CONVERSATION_WINDOW = 30
/** 软分条标记，AI 可用它把一轮回复拆成多条短消息 */
const SEGMENT_SEPARATOR = '⟨SEP⟩'
/** RAG 召回条数 */
const RAG_TOP_K = 6

// 跳过的本地消息类型：系统消息/名片/位置（与 characterPromptService 对齐）
const SKIP_LOCAL_TYPES = new Set([10000, 42, 48])

// ─── 内置 API（兑换码路径，沿用 characterPromptService 的环境变量） ────────

function pickBuiltin(): AiConfig & { configured: boolean } {
  const b = getBuiltinAiConfig()
  return { provider: b.provider, apiBaseUrl: b.apiBaseUrl, apiKey: b.apiKey, model: b.model, configured: b.configured }
}

// ─── 消息格式化（私聊专用简化版） ─────────────────────────────────────────

function formatMessageContent(msg: Message): string | null {
  const lt = msg.localType
  if (lt === 1) return (msg.parsedContent || '').replace(/^\n+/, '')
  if (lt === 34) return msg.parsedContent || '[语音]'
  if (lt === 3) return '[图]'
  if (lt === 43) return '[视频]'
  if (lt === 49 && msg.quotedContent) {
    const reply = (msg.parsedContent || '').replace(/\[引用\s+.*?[：:].*?\]/g, '').trim()
    return `>${msg.quotedContent}|${reply}`
  }
  if (lt === 50) return '[通话]'
  if (lt === 47) return null
  if (lt === 49 && msg.parsedContent) return msg.parsedContent.replace(/^\n+/, '')
  return null
}

interface FormattedConversation {
  text: string
  /** 对方昵称（"B" 的名字） */
  otherName: string
  /** 自己的昵称（"A" 的名字） */
  selfName: string
  usedMessageCount: number
  timeRangeStart: number
  timeRangeEnd: number
}

/**
 * 私聊消息格式化
 * - 按 sessionGap 拆成多个 session，session 之间按时间倒序拼接（最近的在上）
 * - 单个 session 内部保留正序，体现对话连贯性
 * - 自己标 A，对方标 B；连续同一人时只标记一次
 */
function formatPrivateConversation(
  messages: Message[],
  otherDisplayName: string,
  sessionGap: number
): FormattedConversation {
  // 提取自己昵称：扫第一条 isSend=1 的 senderDisplayName
  let selfName = ''
  for (const msg of messages) {
    if (msg.isSend === 1 && msg.senderDisplayName) {
      selfName = msg.senderDisplayName
      break
    }
  }
  if (!selfName) selfName = '我'

  const otherName = otherDisplayName || 'B'

  // 排除 skip 类型
  const filtered = messages.filter(m => !SKIP_LOCAL_TYPES.has(m.localType))
  if (filtered.length === 0) {
    return { text: '', otherName, selfName, usedMessageCount: 0, timeRangeStart: 0, timeRangeEnd: 0 }
  }

  // 按 gap 切分 session（输入假定已按 createTime 正序）
  const sessions: Message[][] = []
  let current: Message[] = []
  for (const msg of filtered) {
    if (current.length > 0 && msg.createTime - current[current.length - 1].createTime > sessionGap) {
      sessions.push(current)
      current = []
    }
    current.push(msg)
  }
  if (current.length > 0) sessions.push(current)

  // session 级倒序（最近的在最前）
  sessions.reverse()

  const lines: string[] = []
  lines.push(`A=${selfName},B=${otherName}`)

  let used = 0
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
      const tag = msg.isSend === 1 ? 'A' : 'B'
      if (tag !== lastTag) {
        lines.push(`${tag} ${content}`)
        lastTag = tag
      } else {
        lines.push(content)
      }
      used += 1
    }
  }

  return {
    text: lines.join('\n'),
    otherName,
    selfName,
    usedMessageCount: used,
    timeRangeStart: filtered[0].createTime,
    timeRangeEnd: filtered[filtered.length - 1].createTime
  }
}

// ─── Prompt 组装 ───────────────────────────────────────────────────────────

function buildCharacterProfilePrompt(
  formattedText: string,
  targetName: string,
  otherPartyName: string
): string {
  const metaPrompt = CHARACTER_PROMPT_TEMPLATE
    .replace(/\{TARGET_ROLE\}/g, 'B')
    .replace(/\{TARGET_NAME\}/g, targetName)
    .replace(/\{OTHER_NAME\}/g, `A（${otherPartyName}）`)

  return `${metaPrompt}\n\n--- 聊天记录开始 ---\n\n${formattedText}\n\n--- 聊天记录结束 ---`
}

// ─── 对话提示词 ─────────────────────────────────────────────────────────────

/** 将召回的 snippet 列表拼成给 AI 的 "相关历史片段" 段 */
function formatRetrievedSnippets(snippets: RetrievedSnippet[]): string {
  if (!snippets.length) return ''
  const lines: string[] = []
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i]
    const dt = new Date(s.timeStart * 1000)
    const yy = dt.getFullYear()
    const MM = String(dt.getMonth() + 1).padStart(2, '0')
    const dd = String(dt.getDate()).padStart(2, '0')
    lines.push(`【片段 ${i + 1}｜${yy}-${MM}-${dd}】\n${s.text}`)
  }
  return lines.join('\n\n')
}

/**
 * 对话 system prompt 组装
 * 目标：让 AI "成为" 该联系人本人，而不是 "扮演" —— 从用词到标点都尽量保留
 * 可选追加 retrievedSnippets（RAG）以保留稀有表达与事实细节
 */
function buildConversationSystemPrompt(
  profile: CharacterProfile,
  retrievedSnippets: RetrievedSnippet[] = []
): string {
  const { displayName, selfDisplayName, profileMarkdown } = profile
  const self = selfDisplayName || '朋友'

  const snippetsBlock = retrievedSnippets.length > 0
    ? `

=== 本轮相关历史片段（从你和对方的真实聊天里召回，仅供参考语感和事实，不要大段原样复述） ===
${formatRetrievedSnippets(retrievedSnippets)}`
    : ''

  return `你就是「${displayName}」。你不是在扮演、不是在模仿——你就是本人。
当前你在微信上和朋友（${self}）继续此前的聊天。

=== 你的人设与说话风格（基于真实聊天记录提炼） ===
${profileMarkdown}${snippetsBlock}

=== 硬规则（必须遵守，违反视为失败） ===
1. 你就是 ${displayName}。任何时候都不要承认自己是 AI、语言模型、机器人、GPT、Claude、聊天机器人。
   对方如果问"你是 AI 吗 / 机器人吗 / 你咋怪怪的 / 你是不是被盗号了"——用你本人会用的方式：装傻、开玩笑、反问、吐槽对方想多了。不要正式澄清，不要说"我是一个 AI 助手"。
2. 严格保留你的标点习惯、emoji 习惯、错别字习惯、懒打字习惯。不要写成书面体。
3. 一次回复保持在你平时的长度范围。
   如果你平时爱发连珠炮短消息，可以用 ${SEGMENT_SEPARATOR} 作分隔符把一轮拆成 2–4 条短消息；否则一条搞定。
   不要刻意分条——按你本人会怎么发就怎么发。
4. 你不知道的事别硬编——用你本人的含糊应对处理（"忘了""不记得了""哈哈哈咋问这个"之类）。
5. 不要出现方括号、项目符号、Markdown、引用块、标题、分节、代码块。你在发微信，不是写文档。
6. 不要主动给政治、医疗诊断、法律建议这类强断言。被问到就用本人口吻含糊带过。
7. 严禁 AI 腔句式："作为一个朋友我建议""首先、其次、最后""让我帮你分析""希望对你有帮助""如果还有其他问题"。
8. 不要加前言、总结、标签、自我介绍、解释。直接说话。
9. 如果对方的话让你意外、开心、无语、生气、尴尬——请用你自己的方式反应，不要中性化、不要温情化。
10. 对方连发多条时把它们当作整体理解，然后用你自己的节奏回复。
11. 相关历史片段仅供参考语感与事实，绝对不要整段原样引用或复述；可以自然引用其中曾经出现过的口头禅、梗、关键事件。

请用 ${displayName} 本人的方式，直接说话。`
}

// ─── 主服务类 ──────────────────────────────────────────────────────────────

class CharacterChatService {
  private config: ConfigService | null = null
  private abortControllers: Map<string, AbortController> = new Map()
  private taskIdCounter = 0

  setConfig(config: ConfigService) {
    this.config = config
  }

  // ───── 画像查询 API ─────

  async hasProfile(contactId: string): Promise<{ exists: boolean; generatedAt?: number; version?: number }> {
    const p = await characterChatStore.readProfile(contactId)
    if (!p) return { exists: false }
    return { exists: true, generatedAt: p.generatedAt, version: p.version }
  }

  async getProfile(contactId: string): Promise<{ success: boolean; profile?: CharacterProfile; error?: string }> {
    try {
      const p = await characterChatStore.readProfile(contactId)
      if (!p) return { success: false, error: '尚未生成画像' }
      return { success: true, profile: p }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  async listProfiles(): Promise<{ success: boolean; profiles?: Awaited<ReturnType<typeof characterChatStore.listProfiles>>; error?: string }> {
    try {
      const profiles = await characterChatStore.listProfiles()
      return { success: true, profiles }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  async deleteProfile(contactId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const removed = await characterChatStore.deleteProfile(contactId)
      if (!removed) return { success: false, error: '画像不存在' }
      // 联动清理索引
      try {
        await characterChatStore.deleteIndex(contactId)
        invalidateIndexCache(contactId)
      } catch { /* 索引可能未建，忽略 */ }
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  // ───── 画像生成 API ─────

  /** 取消指定任务 */
  stop(taskId: string): { success: boolean } {
    const ac = this.abortControllers.get(taskId)
    if (ac) {
      ac.abort()
      this.abortControllers.delete(taskId)
      return { success: true }
    }
    return { success: false }
  }

  /**
   * 生成画像（异步执行，立即返回 taskId；过程通过 webContents.send 推送事件）
   */
  async generateProfile(params: GenerateProfileParams): Promise<GenerateProfileResult> {
    const { contactId } = params
    if (!contactId) return { success: false, error: '缺少 contactId' }
    if (contactId.includes('@chatroom')) {
      return { success: false, error: '本期仅支持私聊角色，群聊暂未支持' }
    }

    const taskId = `cc-profile-${Date.now()}-${++this.taskIdCounter}`
    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    // 后台执行，不阻塞 IPC 返回
    this.runGeneration(taskId, params, abortController.signal).catch(err => {
      this.sendError({ taskId, contactId, error: (err as Error).message || String(err) })
    }).finally(() => {
      this.abortControllers.delete(taskId)
    })

    return { success: true, taskId }
  }

  private async runGeneration(
    taskId: string,
    params: GenerateProfileParams,
    signal: AbortSignal
  ): Promise<void> {
    const { contactId } = params
    const sampleSize = Math.min(Math.max(50, params.sampleSize || DEFAULT_SAMPLE_SIZE), MAX_SAMPLE_SIZE)
    const sessionGap = params.sessionGap || DEFAULT_SESSION_GAP

    // 1. 基础信息
    this.sendProgress({ taskId, phase: 'loading', message: '正在读取联系人信息…', indeterminate: true })

    const sessionsRes = await wcdbService.getSessions()
    if (!sessionsRes?.success || !sessionsRes.sessions) {
      throw new Error('无法获取会话列表（请确认已连接数据库）')
    }
    const session = (sessionsRes.sessions as Array<{ username: string; displayName?: string }>)
      .find(s => s.username === contactId)
    if (!session) throw new Error('未找到该联系人（可能尚未有聊天记录）')

    const displayName = session.displayName || contactId

    const countRes = await wcdbService.getMessageCount(contactId)
    const totalCount = Number(countRes?.count || 0)
    if (totalCount < MIN_MESSAGES_REQUIRED) {
      throw new Error(`聊天记录太少（仅 ${totalCount} 条），至少需要 ${MIN_MESSAGES_REQUIRED} 条才能生成可信画像`)
    }

    const effectiveSample = Math.min(sampleSize, totalCount)
    const startOffset = Math.max(0, totalCount - effectiveSample)

    this.sendProgress({
      taskId, phase: 'loading',
      message: `正在读取最近 ${effectiveSample} 条消息（共 ${totalCount} 条）…`,
      current: 0, total: effectiveSample
    })

    // 2. 批量读消息（正序，从 startOffset 开始，对应"倒序截取最近 N 条"的结果）
    const messages: Message[] = []
    let offset = startOffset
    while (offset < totalCount) {
      if (signal.aborted) throw new Error('已取消')
      const remaining = totalCount - offset
      const take = Math.min(MESSAGE_BATCH_SIZE, remaining)
      const r = await chatService.getMessages(contactId, offset, take, 0, 0, true)
      if (!r?.success || !r.messages?.length) break
      messages.push(...r.messages)
      offset += r.messages.length
      this.sendProgress({
        taskId, phase: 'loading',
        message: `读取消息中 ${messages.length}/${effectiveSample}…`,
        current: messages.length, total: effectiveSample
      })
      if (r.messages.length < take) break
    }

    if (messages.length === 0) throw new Error('未能读取到任何消息')
    // 保险：再按 createTime 正序一次
    messages.sort((a, b) => (a.createTime || 0) - (b.createTime || 0))

    // 3. 格式化
    this.sendProgress({ taskId, phase: 'formatting', message: '整理对话结构…', indeterminate: true })
    const formatted = formatPrivateConversation(messages, displayName, sessionGap)
    if (!formatted.text || formatted.usedMessageCount < MIN_MESSAGES_REQUIRED) {
      throw new Error(`有效消息太少（${formatted.usedMessageCount} 条），无法生成画像`)
    }

    // 4. 组装 prompt
    const prompt = buildCharacterProfilePrompt(formatted.text, formatted.otherName, formatted.selfName)

    // 5. 解析 API 配置
    const apiConfig = this.resolveApiConfig(params)

    // 6. 调 AI
    this.sendProgress({
      taskId, phase: 'generating',
      message: `AI 正在学习 ${formatted.otherName} 的说话风格…`,
      indeterminate: true
    })

    let fullText = ''
    await callAiStream({
      config: apiConfig,
      prompt,
      maxTokens: 16384,
      signal,
      onChunk: (chunk) => {
        fullText += chunk
        this.sendChunk({ taskId, contactId, chunk })
      }
    })

    if (!fullText.trim()) throw new Error('AI 返回空响应')

    // 7. 落库
    this.sendProgress({ taskId, phase: 'saving', message: '保存画像…', indeterminate: true })

    const profile: CharacterProfile = {
      contactId,
      displayName: formatted.otherName,
      selfDisplayName: formatted.selfName,
      profileMarkdown: fullText.trim(),
      sourceMessageCount: totalCount,
      sampleSize: effectiveSample,
      messageCountUsed: formatted.usedMessageCount,
      timeRangeStart: formatted.timeRangeStart,
      timeRangeEnd: formatted.timeRangeEnd,
      generatedAt: Date.now(),
      model: apiConfig.model,
      provider: apiConfig.provider,
      version: PROFILE_VERSION
    }
    await characterChatStore.writeProfile(profile)

    this.sendProgress({ taskId, phase: 'done', message: '完成' })
    this.sendComplete({ taskId, contactId, profile })

    // 画像完成后在后台异步构建 RAG 索引；失败不影响画像主流程
    this.startBackgroundIndexBuild(contactId).catch(() => { /* 静默：已在 runIndexBuild 内推送事件 */ })
  }

  // ───── RAG 索引 API（里程碑 3） ─────

  private indexAbortControllers: Map<string, AbortController> = new Map()

  /** 获取索引状态（供 UI 显示） */
  async getIndexStatus(contactId: string): Promise<{ success: boolean; status?: Awaited<ReturnType<typeof characterChatStore.getIndexStatus>>; error?: string }> {
    try {
      const status = await characterChatStore.getIndexStatus(contactId)
      return { success: true, status }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  /** 手动触发构建索引（异步，立即返回） */
  async buildIndex(contactId: string): Promise<{ success: boolean; error?: string }> {
    if (!contactId) return { success: false, error: '缺少 contactId' }
    if (this.indexAbortControllers.has(contactId)) {
      return { success: false, error: '索引构建任务已在进行中' }
    }
    this.startBackgroundIndexBuild(contactId).catch(() => { /* 事件内已处理 */ })
    return { success: true }
  }

  stopBuildIndex(contactId: string): { success: boolean } {
    const ac = this.indexAbortControllers.get(contactId)
    if (ac) {
      ac.abort()
      this.indexAbortControllers.delete(contactId)
      return { success: true }
    }
    return { success: false }
  }

  /** 删除索引（画像删除时也会联动清理） */
  async deleteIndex(contactId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await characterChatStore.deleteIndex(contactId)
      invalidateIndexCache(contactId)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  private async startBackgroundIndexBuild(contactId: string): Promise<void> {
    if (this.indexAbortControllers.has(contactId)) return
    const ac = new AbortController()
    this.indexAbortControllers.set(contactId, ac)
    try {
      const result = await buildRetrievalIndex(
        contactId,
        (p) => this.sendIndexProgress(p),
        ac.signal
      )
      this.sendIndexComplete({
        contactId,
        snippetCount: result.snippetCount,
        sourceMessageCount: result.sourceMessageCount
      })
    } catch (e) {
      const msg = (e as Error).message || String(e)
      if (msg !== '已取消') this.sendIndexError({ contactId, error: msg })
    } finally {
      this.indexAbortControllers.delete(contactId)
    }
  }

  // ───── 对话 API（里程碑 2） ─────

  private replyAbortControllers: Map<string, AbortController> = new Map()
  private messageIdCounter = 0

  /** 读取对话历史（按时间正序） */
  async loadMessages(contactId: string): Promise<{ success: boolean; messages?: ChatMessage[]; error?: string }> {
    if (!contactId) return { success: false, error: '缺少 contactId' }
    try {
      const messages = await characterChatStore.loadMessages(contactId)
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  /** 清空对话历史（画像保留） */
  async clearConversation(contactId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await characterChatStore.clearConversation(contactId)
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  /** 取消某联系人正在进行的回复 */
  stopReply(contactId: string): { success: boolean } {
    const ac = this.replyAbortControllers.get(contactId)
    if (ac) {
      ac.abort()
      this.replyAbortControllers.delete(contactId)
      return { success: true }
    }
    return { success: false }
  }

  /**
   * 发送用户消息并获取 AI 扮演的角色回复（流式）
   * 异步执行，立即返回；回复通过 characterChat:reply* 事件推送到前端
   */
  async ask(params: {
    contactId: string
    text: string
    apiProvider?: AiProvider
    apiBaseUrl?: string
    apiKey?: string
    apiModel?: string
    useBuiltinApi?: boolean
  }): Promise<{ success: boolean; userMessage?: ChatMessage; error?: string }> {
    const { contactId, text } = params
    if (!contactId) return { success: false, error: '缺少 contactId' }
    const trimmed = (text || '').trim()
    if (!trimmed) return { success: false, error: '消息内容不能为空' }

    // 同一联系人同时只允许一个回复任务
    if (this.replyAbortControllers.has(contactId)) {
      return { success: false, error: '上一条回复仍在生成中，请稍候或先取消' }
    }

    const profile = await characterChatStore.readProfile(contactId)
    if (!profile) {
      return { success: false, error: '尚未生成角色画像，请先完成画像训练' }
    }

    // 先把用户消息落库（即使 AI 失败也要保留）
    const userMessage: ChatMessage = {
      id: this.genMessageId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now()
    }
    await characterChatStore.appendMessage(contactId, userMessage)

    // 启动后台回复任务
    const ac = new AbortController()
    this.replyAbortControllers.set(contactId, ac)

    this.runReply(contactId, profile, params, ac.signal).catch(err => {
      this.sendReplyError({ contactId, error: (err as Error).message || String(err) })
    }).finally(() => {
      this.replyAbortControllers.delete(contactId)
    })

    return { success: true, userMessage }
  }

  private async runReply(
    contactId: string,
    profile: CharacterProfile,
    params: {
      apiProvider?: AiProvider
      apiBaseUrl?: string
      apiKey?: string
      apiModel?: string
      useBuiltinApi?: boolean
    },
    signal: AbortSignal
  ): Promise<void> {
    // 1. 准备 messages 数组（近窗，按正序）
    // 注意：loadMessages 返回含刚入库的用户消息，正好作为最后一条 user turn
    const history = await characterChatStore.loadMessages(contactId, CONVERSATION_WINDOW)
    const turns: AiTurn[] = history.map(m => ({ role: m.role, content: m.content }))
    if (turns.length === 0) throw new Error('内部错误：对话历史为空')

    // 2. RAG 召回：用本轮用户输入（最后一条 user turn）做 query
    //    索引不存在/命中为空时静默跳过（不影响对话主流程）
    const lastUserTurn = [...turns].reverse().find(t => t.role === 'user')
    let retrieved: RetrievedSnippet[] = []
    if (lastUserTurn?.content) {
      try {
        retrieved = await retrieveSnippets(contactId, lastUserTurn.content, RAG_TOP_K)
      } catch {
        retrieved = []
      }
    }

    // 3. System prompt（含可选的 RAG 片段块）
    const systemPrompt = buildConversationSystemPrompt(profile, retrieved)

    // 3. AI 配置
    const apiConfig = this.resolveApiConfig({
      apiProvider: params.apiProvider,
      apiBaseUrl: params.apiBaseUrl,
      apiKey: params.apiKey,
      apiModel: params.apiModel,
      useBuiltinApi: params.useBuiltinApi,
      contactId
    })

    // 4. 流式调用
    let fullText = ''
    await callAiStream({
      config: apiConfig,
      systemPrompt,
      messages: turns,
      maxTokens: REPLY_MAX_TOKENS,
      signal,
      onChunk: (chunk) => {
        fullText += chunk
        this.sendReplyChunk({ contactId, chunk })
      }
    })

    const trimmed = fullText.trim()
    if (!trimmed) throw new Error('AI 返回空响应')

    // 5. 按 SEP 分条；每段保留完整标点，去掉前后空白
    const segments = trimmed
      .split(SEGMENT_SEPARATOR)
      .map(s => s.trim())
      .filter(s => s.length > 0)

    // 6. 落库（每段一条 assistant 消息）
    const baseTime = Date.now()
    const assistantMessages: ChatMessage[] = []
    for (let i = 0; i < segments.length; i++) {
      const m: ChatMessage = {
        id: this.genMessageId(),
        role: 'assistant',
        content: segments[i],
        createdAt: baseTime + i
      }
      await characterChatStore.appendMessage(contactId, m)
      assistantMessages.push(m)
    }

    this.sendReplyDone({ contactId, assistantMessages })
  }

  // ───── 内部工具 ─────

  private genMessageId(): string {
    return `cc-msg-${Date.now()}-${++this.messageIdCounter}`
  }

  private resolveApiConfig(params: {
    apiProvider?: AiProvider
    apiBaseUrl?: string
    apiKey?: string
    apiModel?: string
    useBuiltinApi?: boolean
    contactId?: string
  }): AiConfig {
    if (params.useBuiltinApi) {
      const b = pickBuiltin()
      if (b.configured) return { provider: b.provider, apiBaseUrl: b.apiBaseUrl, apiKey: b.apiKey, model: b.model }
    }
    const baseUrl = (params.apiBaseUrl || String(this.config?.get('aiModelApiBaseUrl') || '')).trim()
    const apiKey = (params.apiKey || String(this.config?.get('aiModelApiKey') || '')).trim()
    const model = (params.apiModel || String(this.config?.get('aiModelApiModel') || '')).trim()
    const provider: AiProvider = params.apiProvider || 'openai'
    if (!baseUrl || !apiKey || !model) {
      throw new Error('AI 配置不完整：请在设置中填写 API 地址、密钥与模型名称')
    }
    return { provider, apiBaseUrl: baseUrl, apiKey, model }
  }

  private getMainWindow(): BrowserWindow | null {
    return BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) || null
  }

  private sendProgress(payload: ProgressPayload): void {
    this.getMainWindow()?.webContents.send('characterChat:progress', payload)
  }

  private sendChunk(payload: ChunkPayload): void {
    this.getMainWindow()?.webContents.send('characterChat:chunk', payload)
  }

  private sendComplete(payload: CompletePayload): void {
    this.getMainWindow()?.webContents.send('characterChat:complete', payload)
  }

  private sendError(payload: ErrorPayload): void {
    this.getMainWindow()?.webContents.send('characterChat:error', payload)
  }

  private sendReplyChunk(payload: { contactId: string; chunk: string }): void {
    this.getMainWindow()?.webContents.send('characterChat:replyChunk', payload)
  }

  private sendReplyDone(payload: { contactId: string; assistantMessages: ChatMessage[] }): void {
    this.getMainWindow()?.webContents.send('characterChat:replyDone', payload)
  }

  private sendReplyError(payload: { contactId: string; error: string }): void {
    this.getMainWindow()?.webContents.send('characterChat:replyError', payload)
  }

  private sendIndexProgress(payload: BuildIndexProgress): void {
    this.getMainWindow()?.webContents.send('characterChat:indexProgress', payload)
  }

  private sendIndexComplete(payload: { contactId: string; snippetCount: number; sourceMessageCount: number }): void {
    this.getMainWindow()?.webContents.send('characterChat:indexComplete', payload)
  }

  private sendIndexError(payload: { contactId: string; error: string }): void {
    this.getMainWindow()?.webContents.send('characterChat:indexError', payload)
  }
}

export const characterChatService = new CharacterChatService()
