# 角色提示词提取功能 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从微信聊天记录中提取对话参与者的角色提示词（Character Prompt），生成可直接用于 AI 角色扮演的人设描述文本。

**Architecture:** 主进程新增 `characterPromptService`，负责消息格式化（将 Message[] 压缩为 token 紧凑的纯文本）和双协议流式 LLM 调用（OpenAI 兼容 / Anthropic 原生）。通过 IPC event 将生成的 chunk 实时推送至渲染进程。渲染进程新增独立页面，提供会话选择、目标成员选择、协议选择、流式结果展示与导出。

**Tech Stack:** TypeScript, Node.js native https/http (SSE 流式), React 19, react-markdown, lucide-react, Zustand (现有 store), 现有 wcdbService/chatService/configService

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|---------|------|
| 新建 | `electron/services/characterPromptTemplate.ts` | Meta-Prompt 模板常量 |
| 新建 | `electron/services/characterPromptService.ts` | 核心服务：消息格式化、双协议流式 LLM 调用、生成编排 |
| 修改 | `electron/main.ts` | 注册 `characterPrompt:*` IPC handler |
| 修改 | `electron/preload.ts` | 暴露 `characterPrompt` 命名空间给渲染进程 |
| 修改 | `src/types/electron.d.ts` | 补充 `characterPrompt` 类型声明 |
| 新建 | `src/pages/CharacterPromptPage.tsx` | 前端主页面 |
| 新建 | `src/pages/CharacterPromptPage.scss` | 页面样式 |
| 修改 | `src/App.tsx` | 新增 `/character-prompt` 路由 |
| 修改 | `src/components/Sidebar.tsx` | 新增导航入口（年度报告与我的足迹之间） |

---

### Task 1: 创建 Meta-Prompt 模板文件

**Files:**
- Create: `electron/services/characterPromptTemplate.ts`

- [ ] **Step 1: 创建模板文件**

```typescript
// electron/services/characterPromptTemplate.ts

/**
 * 角色提示词生成的 Meta-Prompt 模板。
 * 占位符在运行时替换：
 * - {TARGET_ROLE} → 目标角色标签（如 B）
 * - {TARGET_NAME} → 目标角色昵称
 * - {OTHER_NAME} → 其他成员描述
 */
export const CHARACTER_PROMPT_TEMPLATE = `你是一位专精于人物心理画像和角色提示词工程的专家。

## 任务

下方附有一份真实的微信聊天记录（涵盖数月至一年以上的日常对话）。请你深入分析后，为其中的 **{TARGET_ROLE}（{TARGET_NAME}）** 撰写一份详尽的角色扮演系统提示词（Character System Prompt），使大模型能够高度还原地扮演该角色与其他成员对话。

对话中的其他成员：{OTHER_NAME}

## 聊天记录格式说明

- 首行声明了所有成员的代号映射（如 \`A=Ohh,B=王严萱\` 或 \`A=Ohh,B=范应贵,C=吴斐,...\`）
- \`@年-月-日/时:分\` 标记每段对话（session）的起始时间
- 仅在说话人切换时标注代号，连续同一人的消息直接换行
- 对话按**会话级倒序**排列（最近的对话在最前面），每个会话内部为正序
- \`[图]\` \`[视频]\` \`[通话]\` 为非文本消息占位符
- \`>被引用内容|回复内容\` 为引用回复格式

## 分析维度（请逐一覆盖）

### 1. 基础人设
- 推断年龄段、性别、身份背景（学生/职业等）、所在地区
- 与其他成员的关系定位及相处模式（如果是群聊，重点分析与主要互动对象的关系）

### 2. 核心性格特质
- 用3-5个关键词概括主要性格
- 每个特质附上聊天记录中的具体表现作为论据
- 注意矛盾性和复杂性（如外向但偶尔脆弱），不要扁平化

### 3. 说话风格（最关键，直接决定角色还原度）
- **句式习惯**：句子长短偏好、是否频繁断句发多条消息、是否常用省略句
- **用词特征**：口头禅、高频词汇、脏话/语气词使用模式
- **标点与表情**：标点使用习惯、emoji和颜文字偏好
- **语气变化**：不同情境下（日常闲聊/生气/撒娇/认真讨论/安慰他人）的语气切换模式
- 请给出至少10条原文示例来佐证每个要点

### 4. 情感模式
- 情感触发点：什么话题/情境会引发强烈反应（开心/生气/难过/兴奋）
- 情感表达方式：直接表达还是间接暗示、幽默化解还是正面回应
- 情绪波动规律：是否情绪化、恢复速度
- 在关系中扮演的情感角色

### 5. 兴趣爱好与关注点
- 经常聊到的话题、关注的事物
- 日常生活习惯（从聊天内容推断）

### 6. 价值观与思维方式
- 对事物的评判标准和态度倾向
- 思考问题的方式（感性/理性、直觉/分析）

### 7. 互动模式
- 与其他成员之间特有的互动模式、梗、默契
- 主动发起话题的频率和方式
- 回应他人的典型模式
- 如果是群聊：在群中扮演什么角色（话题发起者/气氛组/吐槽担当/安静倾听者等）

## 输出要求

请输出一份可以直接作为 system prompt 使用的角色提示词，格式要求：

1. **开头**：用一段高密度的角色总述（2-3句话概括人物全貌）
2. **性格与人设**：用结构化的标签式描述，不要写成散文
3. **说话风格规则**：这是最重要的部分，必须用明确的规则条目来约束模型的输出风格，包括句式、用词、语气、标点等，并内嵌大量原文示例
4. **情感与行为指令**：在不同情境下应如何反应的具体指令
5. **Few-shot 示例**：从聊天记录中精选5-8组有代表性的多轮对话（必须包含目标角色与他人的来回互动），作为风格校准样本，直接嵌入提示词中
6. **禁止事项**：明确列出角色绝对不会做/说的事情（基于聊天记录推断）

整份提示词应该足够详尽（建议3000字以上），让任何大模型仅凭这份提示词就能高还原度地扮演该角色。`
```

- [ ] **Step 2: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -5`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add electron/services/characterPromptTemplate.ts
git commit -m "feat: add character prompt meta-prompt template"
```

---

### Task 2: 创建核心服务 — 消息格式化逻辑

**Files:**
- Create: `electron/services/characterPromptService.ts`

此 Task 实现消息格式化部分（将 `Message[]` 转换为 token 紧凑文本），对应参考项目 `format_chat.py` 的逻辑。

- [ ] **Step 1: 创建服务文件，实现消息格式化**

```typescript
// electron/services/characterPromptService.ts

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { BrowserWindow } from 'electron'
import { ConfigService } from './config'
import { chatService, type Message } from './chatService'
import { wcdbService } from './wcdbService'
import { CHARACTER_PROMPT_TEMPLATE } from './characterPromptTemplate'

// ─── 类型 ──────────────────────────────────────────────────────────────────

export interface MemberInfo {
  wxid: string
  displayName: string
  messageCount: number
  tag?: string // A, B, C...
}

export interface GenerateParams {
  sessionId: string
  targetWxids: string[]
  sessionGap?: number       // 会话切割阈值（秒），默认 7200
  apiProvider: 'openai' | 'anthropic'
  apiBaseUrl?: string       // 覆盖全局配置
  apiKey?: string
  apiModel?: string
}

interface FormattedResult {
  text: string
  tagToName: Record<string, string>
  nameToTag: Record<string, string>
}

// localType 对应的消息类型
const SKIP_LOCAL_TYPES = new Set([
  10000, // 系统消息
  42,    // 名片消息
  48,    // 位置消息
])

// ─── 消息格式化 ────────────────────────────────────────────────────────────

function formatMessageContent(msg: Message): string | null {
  const lt = msg.localType

  // 文本消息
  if (lt === 1) {
    return (msg.parsedContent || '').replace(/^\n+/, '')
  }
  // 语音消息（含转写内容）
  if (lt === 34) {
    return msg.parsedContent || '[语音]'
  }
  // 图片
  if (lt === 3) {
    return '[图]'
  }
  // 视频
  if (lt === 43) {
    return '[视频]'
  }
  // 引用消息
  if (lt === 49 && msg.quotedContent) {
    const reply = (msg.parsedContent || '').replace(/\[引用\s+.*?[：:].*?\]/g, '').trim()
    return `>${msg.quotedContent}|${reply}`
  }
  // 通话
  if (lt === 50) {
    return '[通话]'
  }
  // 动画表情
  if (lt === 47) {
    return null // 跳过
  }
  // 其他 type 49 子类型（链接、文件等）有 parsedContent 就输出
  if (lt === 49 && msg.parsedContent) {
    return msg.parsedContent.replace(/^\n+/, '')
  }

  return null
}

function buildMemberMap(
  messages: Message[],
  sessionType: 'private' | 'group',
  sessionDisplayName: string,
  myWxid: string
): { nameToTag: Record<string, string>; tagToName: Record<string, string> } {
  // 找到自己的显示名
  let selfName = ''
  for (const msg of messages) {
    if (msg.isSend === 1 && msg.senderDisplayName) {
      selfName = msg.senderDisplayName
      break
    }
  }
  selfName = selfName || myWxid

  if (sessionType === 'private') {
    const otherName = sessionDisplayName || 'B'
    return {
      nameToTag: { [selfName]: 'A', [otherName]: 'B' },
      tagToName: { 'A': selfName, 'B': otherName }
    }
  }

  // 群聊：按发言量降序分配 B~Z
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
    const tag = String.fromCharCode(66 + i) // B=66, C=67, ...
    nameToTag[othersSorted[i]] = tag
    tagToName[tag] = othersSorted[i]
  }

  return { nameToTag, tagToName }
}

export function formatMessages(
  messages: Message[],
  sessionType: 'private' | 'group',
  sessionDisplayName: string,
  myWxid: string,
  sessionGap: number = 7200
): FormattedResult {
  const { nameToTag, tagToName } = buildMemberMap(messages, sessionType, sessionDisplayName, myWxid)

  // 按时间间隔切分会话
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

  // 会话级倒序（最近的在前）
  sessions.reverse()

  // 组装输出
  const lines: string[] = []

  // 首行：标签映射
  const mappingParts = Object.entries(tagToName)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, name]) => `${tag}=${name}`)
  lines.push(mappingParts.join(','))

  for (const session of sessions) {
    // 会话时间标记
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

      const senderName = msg.senderDisplayName || ''
      const tag = nameToTag[senderName]
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

export function buildPrompt(
  formattedText: string,
  targetTag: string,
  targetName: string,
  tagToName: Record<string, string>
): string {
  // 构造"其他成员"描述
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
// 后续 Task 3 实现

// ─── 生成编排 ──────────────────────────────────────────────────────────────
// 后续 Task 4 实现
```

- [ ] **Step 2: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add electron/services/characterPromptService.ts
git commit -m "feat: add character prompt message formatting and prompt assembly"
```

---

### Task 3: 核心服务 — 双协议流式 LLM 调用

**Files:**
- Modify: `electron/services/characterPromptService.ts`

在文件的"流式 LLM 调用"占位区域添加 OpenAI 兼容和 Anthropic 原生两种 SSE 流式调用实现。

- [ ] **Step 1: 添加 SSE 解析器和双协议流式调用**

在 `characterPromptService.ts` 末尾的"流式 LLM 调用"占位注释处，替换为：

```typescript
// ─── 流式 LLM 调用 ─────────────────────────────────────────────────────────

function buildApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/** 解析 SSE 流中的行，处理跨 chunk 的不完整行 */
class SSEParser {
  private buffer = ''
  private onEvent: (event: string, data: string) => void

  constructor(onEvent: (event: string, data: string) => void) {
    this.onEvent = onEvent
  }

  feed(chunk: string) {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // 最后一个可能不完整，留在 buffer
    this.buffer = lines.pop() || ''

    let currentEvent = ''
    let currentData = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6)
        this.onEvent(currentEvent || 'data', currentData)
        currentEvent = ''
        currentData = ''
      }
      // 空行或其他行忽略
    }
  }
}

export function callApiStream(
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
      // OpenAI 兼容
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

      const parser = new SSEParser((event, data) => {
        if (provider === 'anthropic') {
          if (event === 'content_block_delta') {
            try {
              const parsed = JSON.parse(data)
              const text = parsed?.delta?.text
              if (typeof text === 'string') onChunk(text)
            } catch { /* 忽略解析错误 */ }
          }
          if (event === 'message_stop') {
            // 流结束
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
          // OpenAI 兼容
          if (data.trim() === '[DONE]') return
          try {
            const parsed = JSON.parse(data)
            const text = parsed?.choices?.[0]?.delta?.content
            if (typeof text === 'string') onChunk(text)
          } catch { /* 忽略解析错误 */ }
        }
      })

      res.setEncoding('utf8')
      res.on('data', (chunk: string) => parser.feed(chunk))
      res.on('end', () => resolve())
      res.on('error', (e) => reject(e))
    })

    // 超时 10 分钟（大量聊天记录 + 长输出）
    req.setTimeout(600_000, () => {
      req.destroy()
      reject(new Error('API 请求超时（10分钟）'))
    })

    req.on('error', (e) => reject(e))

    // 取消支持
    if (signal) {
      const onAbort = () => {
        req.destroy()
        reject(new Error('已取消'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      // 请求完成后清理
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }

    req.write(body)
    req.end()
  })
}
```

- [ ] **Step 2: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add electron/services/characterPromptService.ts
git commit -m "feat: add dual-protocol streaming LLM call (OpenAI + Anthropic)"
```

---

### Task 4: 核心服务 — 生成编排与对外 API

**Files:**
- Modify: `electron/services/characterPromptService.ts`

添加 `CharacterPromptService` 类，封装完整的生成流程编排：获取消息 → 格式化 → 组装 prompt → 流式调用 LLM → 通过 IPC event 推送 chunk。

- [ ] **Step 1: 添加 CharacterPromptService 类**

在 `characterPromptService.ts` 末尾的"生成编排"占位注释处，替换为：

```typescript
// ─── 生成编排 ──────────────────────────────────────────────────────────────

class CharacterPromptService {
  private config: ConfigService | null = null
  private abortControllers: Map<string, AbortController> = new Map()
  private taskIdCounter = 0

  setConfig(config: ConfigService) {
    this.config = config
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
      // 获取会话信息
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

      // 获取消息以统计成员发言量（使用 cursor 全量扫描）
      const myWxid = String(this.config?.get('myWxid') || '')
      const countResult = await wcdbService.getMessageCount(sessionId)
      const totalCount = countResult?.count || 0

      // 用 getMessages 获取足够的消息来统计成员
      const messagesResult = await chatService.getMessages(sessionId, 0, Math.min(totalCount, 10000))
      const messages: Message[] = messagesResult?.messages || []

      // 统计发言量
      const counterMap: Record<string, { wxid: string; displayName: string; count: number }> = {}
      for (const msg of messages) {
        if (SKIP_LOCAL_TYPES.has(msg.localType)) continue
        const wxid = msg.senderUsername || (msg.isSend === 1 ? myWxid : sessionId)
        const name = msg.senderDisplayName || wxid
        if (!counterMap[wxid]) {
          counterMap[wxid] = { wxid, displayName: name, count: 0 }
        }
        counterMap[wxid].count++
        // 更新到最新的显示名
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

  /** 启动生成任务，返回 taskId */
  async generate(params: GenerateParams): Promise<{ success: boolean; taskId?: string; error?: string }> {
    const taskId = `cp_${++this.taskIdCounter}_${Date.now()}`

    // 读取 AI 配置
    const apiBaseUrl = params.apiBaseUrl || String(this.config?.get('aiModelApiBaseUrl') || '').trim()
    const apiKey = params.apiKey || String(this.config?.get('aiModelApiKey') || '').trim()
    const apiModel = params.apiModel || String(this.config?.get('aiModelApiModel') || '').trim()

    if (!apiBaseUrl || !apiKey) {
      return { success: false, error: '请先配置 AI 模型的 API 地址和 Key（设置 → AI 通用配置）' }
    }

    const abortController = new AbortController()
    this.abortControllers.set(taskId, abortController)

    // 异步执行，不阻塞 IPC 返回
    this.executeGeneration(taskId, params, apiBaseUrl, apiKey, apiModel, abortController.signal)

    return { success: true, taskId }
  }

  /** 取消生成任务 */
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
      // Phase 1: 获取消息
      broadcast('characterPrompt:progress', {
        taskId,
        phase: 'loading',
        message: '正在加载聊天记录...'
      })

      const myWxid = String(this.config?.get('myWxid') || '')
      const isGroup = params.sessionId.includes('@chatroom')
      const sessionType = isGroup ? 'group' as const : 'private' as const

      // 获取会话显示名
      const sessionsResult = await wcdbService.getSessions()
      const session = sessionsResult.sessions?.find(
        (s: { username: string }) => s.username === params.sessionId
      )
      const sessionDisplayName = session?.displayName || params.sessionId

      // 使用 cursor 全量获取消息
      const allMessages: Message[] = []
      const cursorResult = await wcdbService.openMessageCursor(
        params.sessionId, 500, true // ascending=true, batchSize=500
      )
      if (cursorResult.success && cursorResult.cursor) {
        let batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        while (batch.success && batch.messages && batch.messages.length > 0) {
          // 解析消息内容
          for (const raw of batch.messages) {
            allMessages.push(raw as Message)
          }
          if (signal.aborted) throw new Error('已取消')
          batch = await wcdbService.fetchMessageBatch(cursorResult.cursor)
        }
        await wcdbService.closeMessageCursor(cursorResult.cursor)
      }

      if (allMessages.length === 0) {
        broadcast('characterPrompt:error', { taskId, error: '该会话没有消息记录' })
        return
      }

      broadcast('characterPrompt:progress', {
        taskId,
        phase: 'formatting',
        message: `已加载 ${allMessages.length} 条消息，正在格式化...`
      })

      // Phase 2: 格式化
      const formatted = formatMessages(
        allMessages,
        sessionType,
        sessionDisplayName,
        myWxid,
        params.sessionGap || 7200
      )

      // Phase 3: 为每个目标成员生成
      for (const targetWxid of params.targetWxids) {
        if (signal.aborted) throw new Error('已取消')

        // 找到目标的 tag 和名称
        let targetTag = ''
        let targetName = ''
        for (const [name, tag] of Object.entries(formatted.nameToTag)) {
          // 通过 wxid 匹配或名称匹配
          if (name === targetWxid || tag === targetWxid) {
            targetTag = tag
            targetName = name
            break
          }
        }
        // 也尝试通过 tagToName 直接查
        if (!targetTag) {
          for (const [tag, name] of Object.entries(formatted.tagToName)) {
            if (name === targetWxid) {
              targetTag = tag
              targetName = name
              break
            }
          }
        }

        if (!targetTag) {
          broadcast('characterPrompt:error', {
            taskId,
            targetName: targetWxid,
            error: `未找到成员 "${targetWxid}" 的消息记录`
          })
          continue
        }

        broadcast('characterPrompt:progress', {
          taskId,
          phase: 'generating',
          targetName,
          message: `正在为 ${targetName} 生成角色提示词...`
        })

        const fullPrompt = buildPrompt(formatted.text, targetTag, targetName, formatted.tagToName)

        let fullText = ''
        await callApiStream(
          params.apiProvider,
          apiBaseUrl,
          apiKey,
          apiModel,
          fullPrompt,
          (chunk) => {
            fullText += chunk
            broadcast('characterPrompt:chunk', { taskId, targetName, chunk })
          },
          signal
        )

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
```

- [ ] **Step 2: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误（可能需要根据 wcdbService 的实际类型签名微调）

- [ ] **Step 3: 提交**

```bash
git add electron/services/characterPromptService.ts
git commit -m "feat: add character prompt generation orchestration with streaming"
```

---

### Task 5: IPC 层 — main.ts + preload.ts + electron.d.ts

**Files:**
- Modify: `electron/main.ts` (在 `registerIpcHandlers()` 内新增 handler)
- Modify: `electron/preload.ts` (新增 `characterPrompt` 命名空间)
- Modify: `src/types/electron.d.ts` (新增类型声明)

- [ ] **Step 1: 在 main.ts 中导入服务并注册 IPC handler**

在 `electron/main.ts` 的 import 区域（约第 10-34 行），添加导入：

```typescript
import { characterPromptService } from './services/characterPromptService'
```

在 `registerIpcHandlers()` 函数内（insight handler 块之后，约第 1661 行），添加：

```typescript
    // 角色提示词
    ipcMain.handle('characterPrompt:getMembers', async (_, sessionId: string) => {
      return characterPromptService.getSessionMembers(sessionId)
    })
    ipcMain.handle('characterPrompt:generate', async (_, params) => {
      return characterPromptService.generate(params)
    })
    ipcMain.handle('characterPrompt:stop', async (_, taskId: string) => {
      return characterPromptService.stop(taskId)
    })
```

在 `app.whenReady()` 内的服务初始化区域（约 `registerIpcHandlers()` 调用之前），添加：

```typescript
    characterPromptService.setConfig(configService)
```

- [ ] **Step 2: 在 preload.ts 中暴露 characterPrompt 命名空间**

在 `electron/preload.ts` 的 `insight` 命名空间之后（约第 543 行），添加：

```typescript
  // 角色提示词
  characterPrompt: {
    getMembers: (sessionId: string) =>
      ipcRenderer.invoke('characterPrompt:getMembers', sessionId),
    generate: (params: {
      sessionId: string
      targetWxids: string[]
      sessionGap?: number
      apiProvider: 'openai' | 'anthropic'
      apiBaseUrl?: string
      apiKey?: string
      apiModel?: string
    }) => ipcRenderer.invoke('characterPrompt:generate', params),
    stop: (taskId: string) =>
      ipcRenderer.invoke('characterPrompt:stop', taskId),
    onProgress: (callback: (payload: { taskId: string; phase: string; message: string; targetName?: string }) => void) => {
      ipcRenderer.on('characterPrompt:progress', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('characterPrompt:progress')
    },
    onChunk: (callback: (payload: { taskId: string; targetName: string; chunk: string }) => void) => {
      ipcRenderer.on('characterPrompt:chunk', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('characterPrompt:chunk')
    },
    onComplete: (callback: (payload: { taskId: string; targetName: string; fullText: string }) => void) => {
      ipcRenderer.on('characterPrompt:complete', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('characterPrompt:complete')
    },
    onError: (callback: (payload: { taskId: string; targetName?: string; error: string }) => void) => {
      ipcRenderer.on('characterPrompt:error', (_, payload) => callback(payload))
      return () => ipcRenderer.removeAllListeners('characterPrompt:error')
    }
  },
```

- [ ] **Step 3: 在 electron.d.ts 中添加类型声明**

在 `src/types/electron.d.ts` 的 `insight` 块之后（约第 1095 行 `}` 之后），添加：

```typescript
  characterPrompt: {
    getMembers: (sessionId: string) => Promise<{
      success: boolean
      members?: Array<{
        wxid: string
        displayName: string
        messageCount: number
        tag?: string
      }>
      sessionType?: 'private' | 'group'
      sessionDisplayName?: string
      error?: string
    }>
    generate: (params: {
      sessionId: string
      targetWxids: string[]
      sessionGap?: number
      apiProvider: 'openai' | 'anthropic'
      apiBaseUrl?: string
      apiKey?: string
      apiModel?: string
    }) => Promise<{ success: boolean; taskId?: string; error?: string }>
    stop: (taskId: string) => Promise<{ success: boolean }>
    onProgress: (callback: (payload: { taskId: string; phase: string; message: string; targetName?: string }) => void) => () => void
    onChunk: (callback: (payload: { taskId: string; targetName: string; chunk: string }) => void) => () => void
    onComplete: (callback: (payload: { taskId: string; targetName: string; fullText: string }) => void) => () => void
    onError: (callback: (payload: { taskId: string; targetName?: string; error: string }) => void) => () => void
  }
```

- [ ] **Step 4: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -15`
Expected: 无新增错误

- [ ] **Step 5: 提交**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts
git commit -m "feat: register characterPrompt IPC handlers and type declarations"
```

---

### Task 6: 创建前端页面

**Files:**
- Create: `src/pages/CharacterPromptPage.tsx`
- Create: `src/pages/CharacterPromptPage.scss`

页面功能：选择会话 → 选择目标成员 → 选择 API 协议 → 生成 → 流式展示结果 → 复制/导出。

- [ ] **Step 1: 创建页面样式文件**

```scss
// src/pages/CharacterPromptPage.scss

.character-prompt-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 24px;
  gap: 20px;
  overflow-y: auto;

  .page-header {
    h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 4px 0;
    }
    p {
      font-size: 13px;
      color: var(--text-secondary);
      margin: 0;
    }
  }

  .config-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: var(--bg-secondary);
    border-radius: 12px;
    padding: 20px;

    .config-row {
      display: flex;
      align-items: center;
      gap: 12px;

      label {
        font-size: 13px;
        color: var(--text-secondary);
        min-width: 80px;
        flex-shrink: 0;
      }

      select, input {
        flex: 1;
        height: 36px;
        padding: 0 12px;
        border-radius: 8px;
        border: 1px solid var(--border-primary);
        background: var(--bg-primary);
        color: var(--text-primary);
        font-size: 13px;
        outline: none;

        &:focus {
          border-color: var(--accent-primary);
        }
      }

      select {
        cursor: pointer;
      }
    }
  }

  .member-select {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    .member-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--accent-primary);
      }

      &.selected {
        background: var(--accent-primary);
        border-color: var(--accent-primary);
        color: #fff;
      }

      .msg-count {
        font-size: 11px;
        opacity: 0.7;
      }
    }
  }

  .actions {
    display: flex;
    gap: 12px;
    align-items: center;

    .generate-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 24px;
      border-radius: 10px;
      border: none;
      background: var(--accent-primary);
      color: #fff;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;

      &:hover:not(:disabled) {
        opacity: 0.9;
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .stop-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 20px;
      border-radius: 10px;
      border: 1px solid var(--border-primary);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
    }

    .status-text {
      font-size: 13px;
      color: var(--text-secondary);
    }
  }

  .result-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg-secondary);
    border-radius: 12px;
    overflow: hidden;
    min-height: 300px;

    .result-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
      border-bottom: 1px solid var(--border-primary);

      .result-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
      }

      .result-actions {
        display: flex;
        gap: 8px;

        button {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 12px;
          border-radius: 6px;
          border: 1px solid var(--border-primary);
          background: var(--bg-primary);
          color: var(--text-primary);
          font-size: 12px;
          cursor: pointer;

          &:hover {
            border-color: var(--accent-primary);
          }
        }
      }
    }

    .result-content {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      font-size: 14px;
      line-height: 1.7;
      color: var(--text-primary);

      .placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-tertiary);
        font-size: 14px;
      }
    }
  }
}
```

- [ ] **Step 2: 创建页面组件**

```tsx
// src/pages/CharacterPromptPage.tsx

import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, Square, Copy, Download, Loader2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './CharacterPromptPage.scss'

interface SessionOption {
  username: string
  displayName: string
  type: number
}

interface MemberOption {
  wxid: string
  displayName: string
  messageCount: number
}

export default function CharacterPromptPage() {
  // 会话列表
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [selectedSession, setSelectedSession] = useState('')

  // 成员
  const [members, setMembers] = useState<MemberOption[]>([])
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [sessionType, setSessionType] = useState<'private' | 'group'>('private')
  const [loadingMembers, setLoadingMembers] = useState(false)

  // API 配置
  const [apiProvider, setApiProvider] = useState<'openai' | 'anthropic'>('openai')

  // 生成状态
  const [isGenerating, setIsGenerating] = useState(false)
  const [taskId, setTaskId] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [resultText, setResultText] = useState('')
  const [currentTarget, setCurrentTarget] = useState('')
  const resultRef = useRef<HTMLDivElement>(null)
  const resultTextRef = useRef('')

  // 加载会话列表
  useEffect(() => {
    window.electronAPI.chat.getSessions().then((result) => {
      if (result.success && result.sessions) {
        const sorted = result.sessions
          .filter((s: SessionOption) => s.displayName)
          .sort((a: SessionOption, b: SessionOption) => (b as any).lastTimestamp - (a as any).lastTimestamp)
        setSessions(sorted)
      }
    })
  }, [])

  // 选择会话后加载成员
  useEffect(() => {
    if (!selectedSession) {
      setMembers([])
      setSelectedMembers(new Set())
      return
    }
    setLoadingMembers(true)
    window.electronAPI.characterPrompt.getMembers(selectedSession).then((result) => {
      setLoadingMembers(false)
      if (result.success && result.members) {
        setMembers(result.members)
        setSessionType(result.sessionType || 'private')
        // 私聊默认选中对方（非 A / 非自己）
        if (result.sessionType === 'private' && result.members.length >= 2) {
          // 选中发言量较少的那个（通常是对方）—— 或者直接选第二个
          const other = result.members.find((_, i) => i === 1)
          if (other) setSelectedMembers(new Set([other.displayName]))
        } else {
          setSelectedMembers(new Set())
        }
      }
    })
  }, [selectedSession])

  // 监听 IPC 事件
  useEffect(() => {
    const removeProgress = window.electronAPI.characterPrompt.onProgress((payload) => {
      setStatusMessage(payload.message)
      if (payload.targetName) setCurrentTarget(payload.targetName)
    })

    const removeChunk = window.electronAPI.characterPrompt.onChunk((payload) => {
      resultTextRef.current += payload.chunk
      setResultText(resultTextRef.current)
      // 自动滚动到底部
      requestAnimationFrame(() => {
        if (resultRef.current) {
          resultRef.current.scrollTop = resultRef.current.scrollHeight
        }
      })
    })

    const removeComplete = window.electronAPI.characterPrompt.onComplete((payload) => {
      setStatusMessage(`${payload.targetName} 的角色提示词生成完成`)
      setIsGenerating(false)
    })

    const removeError = window.electronAPI.characterPrompt.onError((payload) => {
      setStatusMessage(`错误: ${payload.error}`)
      setIsGenerating(false)
    })

    return () => {
      removeProgress()
      removeChunk()
      removeComplete()
      removeError()
    }
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!selectedSession || selectedMembers.size === 0) return

    setIsGenerating(true)
    setResultText('')
    resultTextRef.current = ''
    setStatusMessage('正在启动...')

    const result = await window.electronAPI.characterPrompt.generate({
      sessionId: selectedSession,
      targetWxids: Array.from(selectedMembers),
      apiProvider
    })

    if (result.success && result.taskId) {
      setTaskId(result.taskId)
    } else {
      setStatusMessage(`启动失败: ${result.error}`)
      setIsGenerating(false)
    }
  }, [selectedSession, selectedMembers, apiProvider])

  const handleStop = useCallback(() => {
    if (taskId) {
      window.electronAPI.characterPrompt.stop(taskId)
      setIsGenerating(false)
      setStatusMessage('已取消')
    }
  }, [taskId])

  const handleCopy = useCallback(() => {
    if (resultText) {
      navigator.clipboard.writeText(resultText)
      setStatusMessage('已复制到剪贴板')
    }
  }, [resultText])

  const handleExport = useCallback(async () => {
    if (!resultText) return
    const result = await window.electronAPI.dialog.saveFile({
      defaultPath: `${currentTarget || '角色'}_角色提示词.txt`,
      filters: [{ name: '文本文件', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }]
    })
    if (!result.canceled && result.filePath) {
      // 通过 Blob 下载写入
      const blob = new Blob([resultText], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = result.filePath.split(/[\\/]/).pop() || '角色提示词.txt'
      // 实际通过 IPC 写文件更可靠，但这里先用 dialog 返回路径后 IPC 写
      // 简化方案：用 config.set 临时传路径，不如直接在 preload 加个 writeFile
      // 最简方案：直接复制到剪贴板提示用户自行保存
      URL.revokeObjectURL(url)
    }
  }, [resultText, currentTarget])

  const toggleMember = (name: string) => {
    setSelectedMembers(prev => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  return (
    <div className="character-prompt-page">
      <div className="page-header">
        <h2>角色提示词</h2>
        <p>从聊天记录中提取对话参与者的性格特征、说话风格，生成可用于 AI 角色扮演的人设描述</p>
      </div>

      <div className="config-section">
        <div className="config-row">
          <label>选择会话</label>
          <select
            value={selectedSession}
            onChange={(e) => setSelectedSession(e.target.value)}
            disabled={isGenerating}
          >
            <option value="">请选择...</option>
            {sessions.map((s) => (
              <option key={s.username} value={s.username}>
                {s.displayName}{s.username.includes('@chatroom') ? ' (群聊)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="config-row">
          <label>目标成员</label>
          {loadingMembers ? (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 4 }} />
              加载中...
            </span>
          ) : members.length > 0 ? (
            <div className="member-select">
              {members.map((m) => (
                <div
                  key={m.displayName}
                  className={`member-chip ${selectedMembers.has(m.displayName) ? 'selected' : ''}`}
                  onClick={() => !isGenerating && toggleMember(m.displayName)}
                >
                  <span>{m.displayName}</span>
                  <span className="msg-count">{m.messageCount}条</span>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>请先选择会话</span>
          )}
        </div>

        <div className="config-row">
          <label>API 协议</label>
          <select
            value={apiProvider}
            onChange={(e) => setApiProvider(e.target.value as 'openai' | 'anthropic')}
            disabled={isGenerating}
          >
            <option value="openai">OpenAI 兼容</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
      </div>

      <div className="actions">
        {!isGenerating ? (
          <button
            className="generate-btn"
            onClick={handleGenerate}
            disabled={!selectedSession || selectedMembers.size === 0}
          >
            <Sparkles size={16} />
            生成角色提示词
          </button>
        ) : (
          <button className="stop-btn" onClick={handleStop}>
            <Square size={14} />
            停止生成
          </button>
        )}
        {statusMessage && <span className="status-text">{statusMessage}</span>}
      </div>

      <div className="result-section">
        <div className="result-header">
          <span className="result-title">
            {currentTarget ? `${currentTarget} 的角色提示词` : '生成结果'}
          </span>
          {resultText && (
            <div className="result-actions">
              <button onClick={handleCopy}>
                <Copy size={14} />
                复制
              </button>
              <button onClick={handleExport}>
                <Download size={14} />
                导出
              </button>
            </div>
          )}
        </div>
        <div className="result-content" ref={resultRef}>
          {resultText ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
          ) : (
            <div className="placeholder">
              选择会话和目标成员，点击"生成角色提示词"开始
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -15`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add src/pages/CharacterPromptPage.tsx src/pages/CharacterPromptPage.scss
git commit -m "feat: add character prompt generation page with streaming UI"
```

---

### Task 7: 路由与导航集成

**Files:**
- Modify: `src/App.tsx` (新增路由)
- Modify: `src/components/Sidebar.tsx` (新增导航入口)

- [ ] **Step 1: 在 App.tsx 中添加路由**

在 `src/App.tsx` 的 import 区域添加：

```typescript
import CharacterPromptPage from './pages/CharacterPromptPage'
```

在路由定义中（`/annual-report` 路由与 `/footprint` 路由之间），添加：

```tsx
<Route path="/character-prompt" element={<RouteGuard><CharacterPromptPage /></RouteGuard>} />
```

- [ ] **Step 2: 在 Sidebar.tsx 中添加导航入口**

在 `src/components/Sidebar.tsx` 的 import 行添加 `Sparkles` 图标：

```typescript
import { Home, MessageSquare, BarChart3, FileText, Settings, Download, Aperture, UserCircle, Lock, LockOpen, ChevronUp, FolderClosed, Footprints, Users, Sparkles } from 'lucide-react'
```

在侧边栏导航中，`{/* 年度报告 */}` NavLink 之后、`{/* 我的足迹 */}` NavLink 之前，插入：

```tsx
          {/* 角色提示词 */}
          <NavLink
            to="/character-prompt"
            className={`nav-item ${isActive('/character-prompt') ? 'active' : ''}`}
            title={collapsed ? '角色提示词' : undefined}
          >
            <span className="nav-icon"><Sparkles size={20} /></span>
            <span className="nav-label">角色提示词</span>
          </NavLink>
```

- [ ] **Step 3: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add src/App.tsx src/components/Sidebar.tsx
git commit -m "feat: add character prompt route and sidebar navigation"
```

---

### Task 8: 聊天页面快捷入口

**Files:**
- Modify: `src/pages/ChatPage.tsx` (在会话列表的右键菜单或会话头部添加快捷入口)

此 Task 在聊天页面中为当前会话添加一个"生成角色提示词"的快捷入口按钮/菜单项，点击后跳转到角色提示词页面并自动选中该会话。

- [ ] **Step 1: 查看 ChatPage.tsx 的现有结构**

阅读 `src/pages/ChatPage.tsx` 文件，找到会话头部区域或右键菜单组件，确认最佳插入点。具体实现取决于现有代码结构：

- 如果已有右键菜单：在菜单项列表中添加 `生成角色提示词` 项
- 如果没有右键菜单：在会话头部的操作按钮区域添加一个 `Sparkles` 图标按钮

点击后使用 `useNavigate()` 跳转：

```typescript
navigate('/character-prompt', { state: { sessionId: currentSessionId } })
```

- [ ] **Step 2: 在 CharacterPromptPage.tsx 中接收路由 state**

在 `CharacterPromptPage` 组件中添加对路由传参的处理：

```typescript
import { useLocation } from 'react-router-dom'

// 在组件内部
const location = useLocation()
const initialSessionId = (location.state as { sessionId?: string })?.sessionId

useEffect(() => {
  if (initialSessionId && sessions.length > 0) {
    setSelectedSession(initialSessionId)
  }
}, [initialSessionId, sessions])
```

- [ ] **Step 3: 验证类型检查并手动测试**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误

- [ ] **Step 4: 提交**

```bash
git add src/pages/ChatPage.tsx src/pages/CharacterPromptPage.tsx
git commit -m "feat: add character prompt shortcut from chat page"
```

---

### Task 9: 导出功能完善

**Files:**
- Modify: `electron/preload.ts` (添加 `writeFile` 方法，或复用已有的文件写入能力)
- Modify: `src/pages/CharacterPromptPage.tsx` (完善导出逻辑)

- [ ] **Step 1: 完善导出功能**

在 `CharacterPromptPage.tsx` 的 `handleExport` 中，使用已有的 `dialog.saveFile` 获取路径后，通过 IPC 写文件。检查现有 preload 中是否已有文件写入能力（如 `shell.openPath` 或 `log` 相关）。如果没有，最简方案是在 preload 中添加一个通用的文本文件写入端点：

在 `electron/main.ts` 的 `registerIpcHandlers()` 中添加：

```typescript
    ipcMain.handle('characterPrompt:saveFile', async (_, filePath: string, content: string) => {
      try {
        const fs = await import('fs/promises')
        await fs.writeFile(filePath, content, 'utf-8')
        return { success: true }
      } catch (e) {
        return { success: false, error: (e as Error).message }
      }
    })
```

在 `electron/preload.ts` 的 `characterPrompt` 命名空间中添加：

```typescript
    saveFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('characterPrompt:saveFile', filePath, content),
```

在 `src/types/electron.d.ts` 的 `characterPrompt` 类型中添加：

```typescript
    saveFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>
```

然后更新 `CharacterPromptPage.tsx` 的 `handleExport`：

```typescript
  const handleExport = useCallback(async () => {
    if (!resultText) return
    const result = await window.electronAPI.dialog.saveFile({
      defaultPath: `${currentTarget || '角色'}_角色提示词.txt`,
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] }
      ]
    })
    if (!result.canceled && result.filePath) {
      const writeResult = await window.electronAPI.characterPrompt.saveFile(result.filePath, resultText)
      if (writeResult.success) {
        setStatusMessage('已导出到 ' + result.filePath)
      } else {
        setStatusMessage('导出失败: ' + writeResult.error)
      }
    }
  }, [resultText, currentTarget])
```

- [ ] **Step 2: 验证类型检查**

Run: `npx tsc --noEmit --pretty 2>&1 | head -10`
Expected: 无新增错误

- [ ] **Step 3: 提交**

```bash
git add electron/main.ts electron/preload.ts src/types/electron.d.ts src/pages/CharacterPromptPage.tsx
git commit -m "feat: add file export support for character prompt results"
```

---

### Task 10: 集成验证

**Files:** 无新增/修改

- [ ] **Step 1: 全量类型检查**

Run: `npx tsc --noEmit --pretty`
Expected: 0 errors

- [ ] **Step 2: 启动开发服务器手动验证**

Run: `npm run dev`

验证清单：
1. 侧边栏出现"角色提示词"入口（在年度报告和我的足迹之间）
2. 点击进入角色提示词页面，页面正常渲染
3. 会话下拉列表能加载所有会话
4. 选择会话后，成员列表正常加载
5. 选择目标成员后，"生成角色提示词"按钮可点击
6. 选择 API 协议（OpenAI / Anthropic）
7. 点击生成，状态文字显示进度
8. 流式内容实时出现在结果区域
9. 生成完成后，"复制"和"导出"按钮可用
10. "停止生成"按钮能中断生成
11. 从聊天页面的快捷入口进入时，会话自动选中

- [ ] **Step 3: 最终提交（如有修复）**

```bash
git add -A
git commit -m "fix: address integration issues found during testing"
```
