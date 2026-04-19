/**
 * 模拟微信角色聊天 · 本地存储
 *
 * 持久化策略：JSON 文件 + JSONL 追加（不引入 better-sqlite3），路径约定：
 *   <userData>/characterChat/profiles/<safeContactId>.json        （角色画像）
 *   <userData>/characterChat/conversations/<safeContactId>.jsonl  （对话消息流，每行一条）
 *
 * MVP 阶段每个联系人仅一个默认会话；未来扩展多会话时可改为目录结构。
 */

import { app } from 'electron'
import { mkdir, readFile, writeFile, readdir, unlink, stat, appendFile } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'

export interface CharacterProfile {
  /** 联系人 wxid（即会话 sessionId；本期仅支持私聊） */
  contactId: string
  /** 展示用昵称（备注 > 昵称 > wxid） */
  displayName: string
  /** 用户自己的昵称，用于生成时映射"A" */
  selfDisplayName: string
  /** AI 生成的完整角色画像（Markdown 长文本） */
  profileMarkdown: string
  /** 生成时原始可用消息总数（对方+自己，来自 getMessageCount） */
  sourceMessageCount: number
  /** 目标采样条数（用户/默认策略给出） */
  sampleSize: number
  /** 实际写入 prompt 的消息条数 */
  messageCountUsed: number
  /** 消息跨度起始时间（秒，Unix timestamp） */
  timeRangeStart: number
  /** 消息跨度结束时间（秒） */
  timeRangeEnd: number
  generatedAt: number
  model: string
  provider: 'openai' | 'anthropic'
  /** 画像 schema 版本，便于未来做兼容迁移 */
  version: number
}

export interface CharacterProfileSummary {
  contactId: string
  displayName: string
  sourceMessageCount: number
  messageCountUsed: number
  generatedAt: number
  model: string
  version: number
}

/**
 * 对话消息（存储格式）
 * role = 'user' 代表真人用户输入；'assistant' 代表 AI 扮演的角色回复
 */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

const PROFILE_VERSION = 1

function getStoreRoot(): string {
  return join(app.getPath('userData'), 'characterChat')
}

function getProfilesDir(): string {
  return join(getStoreRoot(), 'profiles')
}

function getConversationsDir(): string {
  return join(getStoreRoot(), 'conversations')
}

/**
 * 将 contactId 转换为安全文件名
 * 微信 wxid 通常是 a-zA-Z0-9_- 组成，chatroomId 带 @chatroom 后缀；
 * 其它字符一律替换为下划线，避免路径遍历与平台差异
 */
function safeFileName(contactId: string): string {
  return contactId.replace(/[^a-zA-Z0-9_\-@]/g, '_')
}

function getProfilePath(contactId: string): string {
  return join(getProfilesDir(), `${safeFileName(contactId)}.json`)
}

function getConversationPath(contactId: string): string {
  return join(getConversationsDir(), `${safeFileName(contactId)}.jsonl`)
}

async function ensureDirs(): Promise<void> {
  await mkdir(getProfilesDir(), { recursive: true })
  await mkdir(getConversationsDir(), { recursive: true })
}

export const characterChatStore = {
  getStoreRoot,
  getProfilesDir,
  getProfilePath,

  async hasProfile(contactId: string): Promise<boolean> {
    const p = getProfilePath(contactId)
    return existsSync(p)
  },

  async readProfile(contactId: string): Promise<CharacterProfile | null> {
    const p = getProfilePath(contactId)
    if (!existsSync(p)) return null
    try {
      const raw = await readFile(p, 'utf-8')
      const data = JSON.parse(raw) as CharacterProfile
      // 基础 schema 校验；缺字段视为损坏，返回 null 触发重建
      if (!data.contactId || typeof data.profileMarkdown !== 'string') return null
      return data
    } catch {
      return null
    }
  },

  async writeProfile(profile: CharacterProfile): Promise<void> {
    await ensureDirs()
    const p = getProfilePath(profile.contactId)
    const payload: CharacterProfile = { ...profile, version: profile.version || PROFILE_VERSION }
    await writeFile(p, JSON.stringify(payload, null, 2), 'utf-8')
  },

  async deleteProfile(contactId: string): Promise<boolean> {
    const p = getProfilePath(contactId)
    if (!existsSync(p)) return false
    await unlink(p)
    return true
  },

  async listProfiles(): Promise<CharacterProfileSummary[]> {
    const dir = getProfilesDir()
    if (!existsSync(dir)) return []
    const files = await readdir(dir)
    const summaries: CharacterProfileSummary[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readFile(join(dir, f), 'utf-8')
        const data = JSON.parse(raw) as CharacterProfile
        if (!data.contactId) continue
        summaries.push({
          contactId: data.contactId,
          displayName: data.displayName || data.contactId,
          sourceMessageCount: data.sourceMessageCount || 0,
          messageCountUsed: data.messageCountUsed || 0,
          generatedAt: data.generatedAt || 0,
          model: data.model || '',
          version: data.version || 1
        })
      } catch {
        // 忽略损坏文件
      }
    }
    // 按最近生成时间倒序
    summaries.sort((a, b) => b.generatedAt - a.generatedAt)
    return summaries
  },

  /** 用于调试：获取画像文件大小（字节） */
  async getProfileSize(contactId: string): Promise<number> {
    const p = getProfilePath(contactId)
    if (!existsSync(p)) return 0
    const s = await stat(p)
    return s.size
  },

  // ─── 对话消息存储 ─────────────────────────────────────────────────────

  getConversationPath,

  /** 追加一条消息到对话 JSONL 文件 */
  async appendMessage(contactId: string, msg: ChatMessage): Promise<void> {
    await ensureDirs()
    const p = getConversationPath(contactId)
    await appendFile(p, JSON.stringify(msg) + '\n', 'utf-8')
  },

  /**
   * 读取最近 N 条消息（按时间正序返回）
   * limit 不传或 <= 0 则全量返回
   */
  async loadMessages(contactId: string, limit = 0): Promise<ChatMessage[]> {
    const p = getConversationPath(contactId)
    if (!existsSync(p)) return []
    try {
      const raw = await readFile(p, 'utf-8')
      const lines = raw.split('\n').filter(l => l.trim())
      const all: ChatMessage[] = []
      for (const line of lines) {
        try {
          const m = JSON.parse(line) as ChatMessage
          if (m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')) {
            all.push(m)
          }
        } catch {
          // 损坏行跳过
        }
      }
      if (limit > 0 && all.length > limit) return all.slice(all.length - limit)
      return all
    } catch {
      return []
    }
  },

  /** 清空对话历史（删除 JSONL 文件；画像保留） */
  async clearConversation(contactId: string): Promise<boolean> {
    const p = getConversationPath(contactId)
    if (!existsSync(p)) return false
    await unlink(p)
    return true
  },

  /** 获取对话消息数量（快速计数，不解析内容） */
  async getMessageCount(contactId: string): Promise<number> {
    const p = getConversationPath(contactId)
    if (!existsSync(p)) return 0
    try {
      const raw = await readFile(p, 'utf-8')
      return raw.split('\n').filter(l => l.trim()).length
    } catch {
      return 0
    }
  }
}

export type { CharacterProfile as CharacterProfileType }
