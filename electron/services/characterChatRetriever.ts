/**
 * 模拟微信角色聊天 · RAG 检索器（里程碑 3）
 *
 * MVP 策略：
 * - tokenize：字符 2-gram + 英文/数字 alpha 单词（不引入 jieba，避免 vite 打包风险）
 * - 索引：BM25 倒排表，JSON 文件持久化
 * - snippet：按 session gap（2 小时）切段后，每段按 4 条消息滑动切块
 * - retrieve：按 query 打分取 top K，LRU 缓存 3 个联系人
 *
 * 与画像生成的分工：
 * - 画像（M1）：基于最近 N 条提炼 Markdown 风格画像（语感锚）
 * - 索引（M3）：覆盖更大范围消息（默认 30000 条），做事实/表达召回
 */

import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import {
  characterChatStore,
  INDEX_VERSION,
  type CharacterSnippet,
  type CharacterSnippetIndex
} from './characterChatStore'

// ─── 常量 ──────────────────────────────────────────────────────────────────

/** 最大索引消息数（覆盖大部分联系人，同时限制索引体积） */
const MAX_INDEX_MESSAGES = 30000
const MESSAGE_BATCH_SIZE = 500
/** session gap：超过该秒数认为是新会话 */
const SESSION_GAP_SECONDS = 7200
/** 每个 snippet 包含的消息条数（3-5 为宜，取 4 平衡召回粒度与上下文） */
const SNIPPET_MESSAGES_PER_CHUNK = 4
/** 跳过的消息类型（与 characterChatService.SKIP_LOCAL_TYPES 对齐） */
const SKIP_LOCAL_TYPES = new Set([10000, 42, 48])
/** 标点/空白去除集（tokenize 用） */
const STOP_CHARS = new Set(
  ' \n\t\r,.!?，。！？、；;:：""\'\'"\'()（）[]【】{}<>《》/\\|*-_+=~`@#$%^&\u3000…·'.split('')
)

/** BM25 超参 */
const K1 = 1.5
const B = 0.75

// ─── 分词 ──────────────────────────────────────────────────────────────────

/**
 * 中英混合 tokenize
 * - 英文/数字按单词（lowercase）
 * - 中文等其它字符：单字 + 相邻 2-gram
 * - 去除标点空白
 */
export function tokenize(text: string): string[] {
  const cleaned = (text || '').toLowerCase().normalize('NFKC')
  const tokens: string[] = []

  // 1. 提取英文/数字单词
  const alphaNumRe = /[a-z0-9]+/g
  for (const m of cleaned.matchAll(alphaNumRe)) {
    if (m[0].length >= 1) tokens.push(m[0])
  }

  // 2. 非英文/数字部分按字符切（CJK / 符号等）
  const nonAlpha = cleaned.replace(alphaNumRe, ' ')
  const chars: string[] = []
  for (const ch of nonAlpha) {
    if (STOP_CHARS.has(ch)) continue
    if (/\s/.test(ch)) continue
    chars.push(ch)
  }
  // 单字
  for (const ch of chars) tokens.push(ch)
  // 2-gram
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1])
  }
  return tokens
}

// ─── snippet 切分 ──────────────────────────────────────────────────────────

function formatMessageContent(msg: Message): string | null {
  const lt = msg.localType
  if (lt === 1) return (msg.parsedContent || '').replace(/^\n+/, '').trim() || null
  if (lt === 34) return '[语音]'
  if (lt === 3) return '[图]'
  if (lt === 43) return '[视频]'
  if (lt === 49 && msg.quotedContent) {
    const reply = (msg.parsedContent || '').replace(/\[引用\s+.*?[：:].*?\]/g, '').trim()
    return `>${msg.quotedContent}|${reply}`
  }
  if (lt === 50) return '[通话]'
  if (lt === 47) return null
  if (lt === 49 && msg.parsedContent) return msg.parsedContent.replace(/^\n+/, '').trim() || null
  return null
}

/**
 * 按 session gap 切分，然后每 SNIPPET_MESSAGES_PER_CHUNK 条合并一个 snippet
 * messages 输入为正序
 */
export function buildSnippets(messages: Message[]): CharacterSnippet[] {
  // 预处理
  const valid: Array<{ m: Message; content: string; tag: 'A' | 'B' }> = []
  for (const m of messages) {
    if (SKIP_LOCAL_TYPES.has(m.localType)) continue
    const c = formatMessageContent(m)
    if (!c) continue
    valid.push({ m, content: c, tag: m.isSend === 1 ? 'A' : 'B' })
  }
  if (valid.length === 0) return []

  // session 切分
  const sessions: typeof valid[] = []
  let cur: typeof valid = []
  for (const item of valid) {
    if (cur.length > 0 && item.m.createTime - cur[cur.length - 1].m.createTime > SESSION_GAP_SECONDS) {
      sessions.push(cur)
      cur = []
    }
    cur.push(item)
  }
  if (cur.length > 0) sessions.push(cur)

  // 每 session 内按 chunk 切
  const snippets: CharacterSnippet[] = []
  let seq = 0
  for (const session of sessions) {
    for (let i = 0; i < session.length; i += SNIPPET_MESSAGES_PER_CHUNK) {
      const chunk = session.slice(i, i + SNIPPET_MESSAGES_PER_CHUNK)
      if (chunk.length < 2) continue // 单条上下文太少，跳过
      const lines = chunk.map(x => `${x.tag}: ${x.content}`)
      const text = lines.join('\n')
      snippets.push({
        id: `s-${chunk[0].m.createTime}-${seq++}`,
        text,
        tokens: text.length, // 中文近似每字 1 token，英文略多但可接受
        timeStart: chunk[0].m.createTime,
        timeEnd: chunk[chunk.length - 1].m.createTime,
        messageLocalIds: chunk.map(x => x.m.localId ?? x.m.messageKey)
      })
    }
  }
  return snippets
}

// ─── BM25 索引构建 ─────────────────────────────────────────────────────────

export function buildBM25Index(
  contactId: string,
  snippets: CharacterSnippet[],
  sourceMessageCount: number
): CharacterSnippetIndex {
  const postings: Record<string, Array<[string, number]>> = {}
  const snippetMeta: Record<string, { length: number }> = {}
  let totalLen = 0

  for (const snip of snippets) {
    const tokens = tokenize(snip.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    snippetMeta[snip.id] = { length: tokens.length }
    totalLen += tokens.length
    for (const [term, f] of tf) {
      let arr = postings[term]
      if (!arr) { arr = []; postings[term] = arr }
      arr.push([snip.id, f])
    }
  }

  return {
    version: INDEX_VERSION,
    contactId,
    buildAt: Date.now(),
    totalSnippets: snippets.length,
    avgLength: snippets.length > 0 ? totalLen / snippets.length : 0,
    postings,
    snippetMeta,
    sourceMessageCount
  }
}

// ─── 索引加载（带 LRU 缓存） ───────────────────────────────────────────────

interface CachedIndexEntry {
  index: CharacterSnippetIndex
  snippetsById: Map<string, CharacterSnippet>
  lastUsedAt: number
}

const indexCache: Map<string, CachedIndexEntry> = new Map()
const INDEX_CACHE_LIMIT = 3

function touchCache(contactId: string, entry: CachedIndexEntry): void {
  entry.lastUsedAt = Date.now()
  indexCache.set(contactId, entry)
  if (indexCache.size > INDEX_CACHE_LIMIT) {
    let oldestKey = ''
    let oldestTs = Infinity
    for (const [k, v] of indexCache.entries()) {
      if (v.lastUsedAt < oldestTs) { oldestTs = v.lastUsedAt; oldestKey = k }
    }
    if (oldestKey && oldestKey !== contactId) indexCache.delete(oldestKey)
  }
}

export function invalidateIndexCache(contactId?: string): void {
  if (contactId) indexCache.delete(contactId)
  else indexCache.clear()
}

async function loadIndexWithCache(contactId: string): Promise<CachedIndexEntry | null> {
  const cached = indexCache.get(contactId)
  if (cached) {
    cached.lastUsedAt = Date.now()
    return cached
  }
  const index = await characterChatStore.readIndex(contactId)
  if (!index) return null
  const snippets = await characterChatStore.readSnippets(contactId)
  const snippetsById = new Map(snippets.map(s => [s.id, s]))
  const entry: CachedIndexEntry = { index, snippetsById, lastUsedAt: Date.now() }
  touchCache(contactId, entry)
  return entry
}

// ─── 检索 ──────────────────────────────────────────────────────────────────

export interface RetrievedSnippet extends CharacterSnippet {
  score: number
}

/**
 * BM25 检索
 * 如果索引不存在或 query 无命中 term 返回 []
 */
export async function retrieve(
  contactId: string,
  query: string,
  K: number = 6
): Promise<RetrievedSnippet[]> {
  if (!query || !query.trim()) return []
  const entry = await loadIndexWithCache(contactId)
  if (!entry) return []
  const { index, snippetsById } = entry
  const N = index.totalSnippets
  if (N === 0) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []
  const uniqueQuery = [...new Set(queryTokens)]

  const avgdl = index.avgLength || 1
  const scores = new Map<string, number>()

  for (const term of uniqueQuery) {
    const postings = index.postings[term]
    if (!postings) continue
    const df = postings.length
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1)
    if (idf <= 0) continue
    for (const [sid, tf] of postings) {
      const dl = index.snippetMeta[sid]?.length || avgdl
      const numer = tf * (K1 + 1)
      const denom = tf + K1 * (1 - B + B * dl / avgdl)
      const contrib = idf * (numer / denom)
      scores.set(sid, (scores.get(sid) || 0) + contrib)
    }
  }

  if (scores.size === 0) return []

  const sorted = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, K)

  const results: RetrievedSnippet[] = []
  for (const [sid, score] of sorted) {
    const snip = snippetsById.get(sid)
    if (snip) results.push({ ...snip, score })
  }
  return results
}

// ─── 一键构建（对外入口，由 characterChatService 调度） ─────────────────────

export interface BuildIndexProgress {
  contactId: string
  phase: 'loading' | 'segmenting' | 'indexing' | 'writing' | 'done'
  message: string
  current?: number
  total?: number
  indeterminate?: boolean
}

export type BuildIndexProgressCallback = (p: BuildIndexProgress) => void

export async function buildIndex(
  contactId: string,
  onProgress?: BuildIndexProgressCallback,
  signal?: AbortSignal
): Promise<{ snippetCount: number; sourceMessageCount: number }> {
  if (!contactId) throw new Error('缺少 contactId')
  if (contactId.includes('@chatroom')) throw new Error('本期仅支持私聊索引')

  const emit = (p: Omit<BuildIndexProgress, 'contactId'>) => onProgress?.({ ...p, contactId })

  // 1. 计数
  emit({ phase: 'loading', message: '准备读取消息…', indeterminate: true })
  const countRes = await wcdbService.getMessageCount(contactId)
  const totalCount = Number(countRes?.count || 0)
  if (totalCount < 20) throw new Error(`消息太少（${totalCount} 条），不足以建立检索索引`)

  const target = Math.min(totalCount, MAX_INDEX_MESSAGES)
  const startOffset = Math.max(0, totalCount - target)

  // 2. 拉消息（正序批读）
  emit({ phase: 'loading', message: `准备读取最近 ${target} 条消息…`, current: 0, total: target })
  const messages: Message[] = []
  let offset = startOffset
  while (offset < totalCount) {
    if (signal?.aborted) throw new Error('已取消')
    const remaining = totalCount - offset
    const take = Math.min(MESSAGE_BATCH_SIZE, remaining)
    const r = await chatService.getMessages(contactId, offset, take, 0, 0, true)
    if (!r?.success || !r.messages?.length) break
    messages.push(...r.messages)
    offset += r.messages.length
    emit({ phase: 'loading', message: `读取消息 ${messages.length}/${target}…`, current: messages.length, total: target })
    if (r.messages.length < take) break
  }
  if (messages.length === 0) throw new Error('未读取到消息')
  messages.sort((a, b) => (a.createTime || 0) - (b.createTime || 0))

  // 3. 切分 snippet
  emit({ phase: 'segmenting', message: '切分对话片段…', indeterminate: true })
  const snippets = buildSnippets(messages)
  if (snippets.length === 0) throw new Error('未能生成任何片段（消息多为非文本）')

  // 4. 构建索引
  emit({ phase: 'indexing', message: `构建倒排索引（${snippets.length} 片段）…`, indeterminate: true })
  const index = buildBM25Index(contactId, snippets, messages.length)

  // 5. 写盘
  emit({ phase: 'writing', message: '写入索引…', indeterminate: true })
  await characterChatStore.writeSnippets(contactId, snippets)
  await characterChatStore.writeIndex(index)

  // 6. 让缓存重新加载
  invalidateIndexCache(contactId)

  emit({ phase: 'done', message: '索引构建完成' })
  return { snippetCount: snippets.length, sourceMessageCount: messages.length }
}
