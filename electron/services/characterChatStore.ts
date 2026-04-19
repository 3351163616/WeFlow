/**
 * 模拟微信角色聊天 · 本地存储
 *
 * 持久化策略：JSON 文件 + JSONL 追加（不引入 better-sqlite3），路径约定：
 *   <userData>/characterChat/profiles/<safeContactId>.json            （角色画像）
 *   <userData>/characterChat/conversations/<safeContactId>.jsonl      （对话消息流）
 *   <userData>/characterChat/snippets/<safeContactId>.snippets.jsonl  （RAG 片段原文）
 *   <userData>/characterChat/snippets/<safeContactId>.index.json      （BM25 倒排索引）
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

/**
 * RAG snippet（连续多条消息合并后的原始片段）
 * 保留首尾时间，便于注入 prompt 时附带时间上下文
 */
export interface CharacterSnippet {
  id: string
  /** A/B 标签格式的片段原文，如 "A: 你今天干嘛\nB: 在家睡觉\nA: 那我去找你" */
  text: string
  tokens: number
  /** 首条消息时间（秒） */
  timeStart: number
  /** 尾条消息时间（秒） */
  timeEnd: number
  /** 包含的原始消息 localId 列表，便于回溯 */
  messageLocalIds: Array<number | string>
}

/**
 * BM25 倒排索引
 * postings: term → [[snippetId, tf], ...]
 */
export interface CharacterSnippetIndex {
  version: number
  contactId: string
  buildAt: number
  totalSnippets: number
  avgLength: number
  /** 倒排表：term → 命中 snippet 的 (id, term frequency) */
  postings: Record<string, Array<[string, number]>>
  /** snippet 元数据：id → { length: 总 token 数 } */
  snippetMeta: Record<string, { length: number }>
  /** 构建时扫描的消息数（便于判断增量） */
  sourceMessageCount: number
}

/** 索引状态（用于 UI 展示） */
export interface CharacterIndexStatus {
  exists: boolean
  buildAt?: number
  totalSnippets?: number
  sourceMessageCount?: number
  version?: number
}

const PROFILE_VERSION = 1
export const INDEX_VERSION = 1

function getStoreRoot(): string {
  return join(app.getPath('userData'), 'characterChat')
}

function getProfilesDir(): string {
  return join(getStoreRoot(), 'profiles')
}

function getConversationsDir(): string {
  return join(getStoreRoot(), 'conversations')
}

function getSnippetsDir(): string {
  return join(getStoreRoot(), 'snippets')
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

function getSnippetsPath(contactId: string): string {
  return join(getSnippetsDir(), `${safeFileName(contactId)}.snippets.jsonl`)
}

function getIndexPath(contactId: string): string {
  return join(getSnippetsDir(), `${safeFileName(contactId)}.index.json`)
}

async function ensureDirs(): Promise<void> {
  await mkdir(getProfilesDir(), { recursive: true })
  await mkdir(getConversationsDir(), { recursive: true })
  await mkdir(getSnippetsDir(), { recursive: true })
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
  },

  // ─── RAG 索引存储 ─────────────────────────────────────────────────────

  getSnippetsPath,
  getIndexPath,

  /** 写 snippets.jsonl（整体覆盖，不增量追加） */
  async writeSnippets(contactId: string, snippets: CharacterSnippet[]): Promise<void> {
    await ensureDirs()
    const p = getSnippetsPath(contactId)
    const body = snippets.map(s => JSON.stringify(s)).join('\n') + (snippets.length > 0 ? '\n' : '')
    await writeFile(p, body, 'utf-8')
  },

  /** 读全部 snippets */
  async readSnippets(contactId: string): Promise<CharacterSnippet[]> {
    const p = getSnippetsPath(contactId)
    if (!existsSync(p)) return []
    try {
      const raw = await readFile(p, 'utf-8')
      const lines = raw.split('\n').filter(l => l.trim())
      const out: CharacterSnippet[] = []
      for (const line of lines) {
        try {
          const s = JSON.parse(line) as CharacterSnippet
          if (s && s.id && typeof s.text === 'string') out.push(s)
        } catch {
          /* 跳过损坏行 */
        }
      }
      return out
    } catch {
      return []
    }
  },

  async writeIndex(index: CharacterSnippetIndex): Promise<void> {
    await ensureDirs()
    const p = getIndexPath(index.contactId)
    await writeFile(p, JSON.stringify(index), 'utf-8')
  },

  async readIndex(contactId: string): Promise<CharacterSnippetIndex | null> {
    const p = getIndexPath(contactId)
    if (!existsSync(p)) return null
    try {
      const raw = await readFile(p, 'utf-8')
      const data = JSON.parse(raw) as CharacterSnippetIndex
      if (!data.contactId || !data.postings) return null
      return data
    } catch {
      return null
    }
  },

  async deleteIndex(contactId: string): Promise<boolean> {
    const idxPath = getIndexPath(contactId)
    const snipPath = getSnippetsPath(contactId)
    let removed = false
    if (existsSync(idxPath)) { await unlink(idxPath); removed = true }
    if (existsSync(snipPath)) { await unlink(snipPath); removed = true }
    return removed
  },

  async getIndexStatus(contactId: string): Promise<CharacterIndexStatus> {
    const p = getIndexPath(contactId)
    if (!existsSync(p)) return { exists: false }
    try {
      const raw = await readFile(p, 'utf-8')
      const data = JSON.parse(raw) as CharacterSnippetIndex
      return {
        exists: true,
        buildAt: data.buildAt,
        totalSnippets: data.totalSnippets,
        sourceMessageCount: data.sourceMessageCount,
        version: data.version
      }
    } catch {
      return { exists: false }
    }
  }
}

export type { CharacterProfile as CharacterProfileType }
