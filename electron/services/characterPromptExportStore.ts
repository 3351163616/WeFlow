/**
 * 角色提示词：磁盘持久化导出存储
 *
 * 职责：把一个会话的聊天记录以 JSONL 形式落盘到用户指定目录，
 * 下次生成时优先读文件，命中则秒级复用；count 变化时支持增量追加。
 */

import { join } from 'path'
import { createHash } from 'crypto'
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync
} from 'fs'
import type { Message } from './chatService'
import { chatService } from './chatService'
import { wcdbService } from './wcdbService'

const SCHEMA_VERSION = 1

export interface ExportMeta {
  schemaVersion: number
  sessionId: string
  sessionDisplayName: string
  selfDisplayName: string
  messageCount: number
  lastCreateTime: number   // 最后一条消息的 createTime（秒）
  exportedAt: number       // 导出/更新时的本地时间戳（毫秒）
  myWxid: string
}

/** 压缩格式：落盘用的最小字段集（每行一个对象） */
interface CompactMessage {
  t: number        // createTime
  s: number        // isSend 0|1
  n?: string       // senderDisplayName
  u?: string       // senderUsername（群聊）
  lt?: number      // localType
  c?: string       // parsedContent
  qc?: string      // quotedContent
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 80)
}

function buildPaths(dir: string, myWxid: string, sessionId: string): { jsonl: string; meta: string; sessionDir: string } {
  const base = myWxid ? join(dir, sanitize(myWxid)) : dir
  const key = sanitize(sessionId) + '_' + createHash('md5').update(sessionId).digest('hex').slice(0, 6)
  return {
    sessionDir: base,
    jsonl: join(base, `${key}.weflow-chat.jsonl`),
    meta: join(base, `${key}.meta.json`)
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function toCompact(m: Message): CompactMessage {
  const msg = m as Message & {
    createTime?: number
    isSend?: number
    senderDisplayName?: string
    senderUsername?: string
    localType?: number
    parsedContent?: string
    quotedContent?: string
  }
  const out: CompactMessage = {
    t: Number(msg.createTime || 0),
    s: Number(msg.isSend ?? 0)
  }
  if (msg.senderDisplayName) out.n = msg.senderDisplayName
  if (msg.senderUsername) out.u = msg.senderUsername
  if (typeof msg.localType === 'number') out.lt = msg.localType
  if (msg.parsedContent) out.c = msg.parsedContent
  if (msg.quotedContent) out.qc = msg.quotedContent
  return out
}

function fromCompact(c: CompactMessage): Message {
  const m = {
    createTime: c.t,
    isSend: c.s,
    senderDisplayName: c.n || '',
    senderUsername: c.u || '',
    localType: c.lt ?? 1,
    parsedContent: c.c || '',
    quotedContent: c.qc || ''
  } as unknown as Message
  return m
}

export interface ExportProgressPayload {
  stage: 'checking' | 'exporting' | 'reading' | 'appending'
  message: string
  current?: number
  total?: number
  indeterminate?: boolean
}

export interface EnsureExportResult {
  messages: Message[]
  hitKind: 'full' | 'incremental' | 'miss'
  meta: ExportMeta
  path: string
}

class CharacterPromptExportStore {
  /**
   * 核心入口：确保磁盘上有最新版本的会话记录，并返回 Message[]。
   *
   * 流程：
   * 1. 若 meta + jsonl 都不存在 → 全量从 DB 导出写盘
   * 2. 若存在但 DB 的消息数 > meta.messageCount → 增量抓取追加
   * 3. 若存在且数量一致 → 直接读文件
   * 4. 若 DB 数量 < meta.messageCount 或 schema 不匹配 → 作废重抽
   */
  async ensureExport(params: {
    dir: string
    sessionId: string
    myWxid: string
    sessionDisplayName: string
    selfDisplayName: string
    onProgress?: (payload: ExportProgressPayload) => void
    signal?: AbortSignal
  }): Promise<EnsureExportResult> {
    const { dir, sessionId, myWxid, sessionDisplayName, selfDisplayName, onProgress, signal } = params
    const { jsonl, meta: metaPath, sessionDir } = buildPaths(dir, myWxid, sessionId)
    ensureDir(sessionDir)

    // 1. 读取旧 meta
    let oldMeta: ExportMeta | null = null
    if (existsSync(metaPath) && existsSync(jsonl)) {
      try {
        const raw = readFileSync(metaPath, 'utf-8')
        const parsed = JSON.parse(raw) as ExportMeta
        if (parsed.schemaVersion === SCHEMA_VERSION) {
          oldMeta = parsed
        }
      } catch { /* 解析失败 → 作废 */ }
    }

    // 2. 快速 count 探测（WCDB 单条 SQL，毫秒级）
    onProgress?.({ stage: 'checking', message: '检查本地缓存...', indeterminate: true })
    const countResult = await wcdbService.getMessageCount(sessionId)
    const dbCount = Number(countResult?.count || 0)

    // 3. 命中判定
    if (oldMeta && oldMeta.messageCount === dbCount && dbCount > 0) {
      onProgress?.({
        stage: 'reading',
        message: '命中磁盘缓存，正在读取...',
        current: 0,
        total: dbCount,
        indeterminate: false
      })
      const messages = this.readJsonl(jsonl, (loaded) => {
        onProgress?.({
          stage: 'reading',
          message: `正在从磁盘读取聊天记录...`,
          current: loaded,
          total: dbCount,
          indeterminate: false
        })
      })
      return { messages, hitKind: 'full', meta: oldMeta, path: jsonl }
    }

    // 4. 增量命中：已导出部分有效，仅追加新消息
    if (oldMeta && dbCount > oldMeta.messageCount) {
      const delta = dbCount - oldMeta.messageCount
      onProgress?.({
        stage: 'reading',
        message: `读取已缓存消息并追加 ${delta} 条新消息...`,
        current: 0,
        total: dbCount,
        indeterminate: false
      })
      const existing = this.readJsonl(jsonl, (loaded) => {
        onProgress?.({
          stage: 'reading',
          message: `正在从磁盘读取已缓存消息...`,
          current: loaded,
          total: oldMeta.messageCount,
          indeterminate: false
        })
      })
      const newMessages = await this.loadFromDB(sessionId, oldMeta.messageCount, delta, (loaded) => {
        onProgress?.({
          stage: 'appending',
          message: `正在追加新消息到磁盘...`,
          current: oldMeta.messageCount + loaded,
          total: dbCount,
          indeterminate: false
        })
      }, signal)
      this.appendJsonl(jsonl, newMessages)
      const merged = [...existing, ...newMessages]
      const newMeta: ExportMeta = {
        ...oldMeta,
        messageCount: dbCount,
        lastCreateTime: this.lastCreateTimeOf(merged),
        exportedAt: Date.now(),
        sessionDisplayName,
        selfDisplayName
      }
      writeFileSync(metaPath, JSON.stringify(newMeta, null, 2), 'utf-8')
      return { messages: merged, hitKind: 'incremental', meta: newMeta, path: jsonl }
    }

    // 5. 未命中 / 作废：全量导出
    onProgress?.({
      stage: 'exporting',
      message: `正在从数据库全量导出聊天记录...`,
      current: 0,
      total: dbCount,
      indeterminate: false
    })
    const allMessages = await this.loadFromDB(sessionId, 0, dbCount, (loaded) => {
      onProgress?.({
        stage: 'exporting',
        message: `正在从数据库导出聊天记录...`,
        current: loaded,
        total: dbCount,
        indeterminate: false
      })
    }, signal)
    this.writeJsonl(jsonl, allMessages)
    const newMeta: ExportMeta = {
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      sessionDisplayName,
      selfDisplayName,
      messageCount: allMessages.length,
      lastCreateTime: this.lastCreateTimeOf(allMessages),
      exportedAt: Date.now(),
      myWxid
    }
    writeFileSync(metaPath, JSON.stringify(newMeta, null, 2), 'utf-8')
    return { messages: allMessages, hitKind: 'miss', meta: newMeta, path: jsonl }
  }

  private async loadFromDB(
    sessionId: string,
    startOffset: number,
    expectedTotal: number,
    onProgress?: (loaded: number) => void,
    signal?: AbortSignal
  ): Promise<Message[]> {
    const all: Message[] = []
    const BATCH = 500
    let offset = startOffset
    while (true) {
      if (signal?.aborted) throw new Error('已取消')
      const r = await chatService.getMessages(sessionId, offset, BATCH, undefined, undefined, true)
      const batch: Message[] = r?.messages || []
      if (batch.length === 0) break
      all.push(...batch)
      onProgress?.(all.length)
      if (batch.length < BATCH) break
      offset += BATCH
      if (expectedTotal > 0 && all.length >= expectedTotal - startOffset) break
    }
    return all
  }

  private writeJsonl(path: string, messages: Message[]) {
    const lines = messages.map(m => JSON.stringify(toCompact(m))).join('\n')
    writeFileSync(path, lines + (messages.length > 0 ? '\n' : ''), 'utf-8')
  }

  private appendJsonl(path: string, messages: Message[]) {
    if (messages.length === 0) return
    const lines = messages.map(m => JSON.stringify(toCompact(m))).join('\n') + '\n'
    appendFileSync(path, lines, 'utf-8')
  }

  private readJsonl(path: string, onProgress?: (loaded: number) => void): Message[] {
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf-8')
    const out: Message[] = []
    let counter = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as CompactMessage
        out.push(fromCompact(parsed))
        counter++
        if (onProgress && counter % 2000 === 0) onProgress(counter)
      } catch { /* 忽略损坏行 */ }
    }
    onProgress?.(out.length)
    return out
  }

  private lastCreateTimeOf(messages: Message[]): number {
    let last = 0
    for (const m of messages) {
      const t = Number((m as { createTime?: number }).createTime || 0)
      if (t > last) last = t
    }
    return last
  }

  /** 删除某个会话的导出文件（提供清理入口） */
  removeExport(params: { dir: string; sessionId: string; myWxid: string }): { success: boolean } {
    try {
      const { jsonl, meta } = buildPaths(params.dir, params.myWxid, params.sessionId)
      const fs = require('fs') as typeof import('fs')
      if (fs.existsSync(jsonl)) fs.unlinkSync(jsonl)
      if (fs.existsSync(meta)) fs.unlinkSync(meta)
      return { success: true }
    } catch {
      return { success: false }
    }
  }
}

export const characterPromptExportStore = new CharacterPromptExportStore()
