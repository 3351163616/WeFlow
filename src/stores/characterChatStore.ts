import { create } from 'zustand'

/**
 * 模拟微信角色聊天 · 前端状态（里程碑 1：画像生成与查询）
 */

export interface CharacterProfile {
  contactId: string
  displayName: string
  selfDisplayName: string
  profileMarkdown: string
  sourceMessageCount: number
  sampleSize: number
  messageCountUsed: number
  timeRangeStart: number
  timeRangeEnd: number
  generatedAt: number
  model: string
  provider: 'openai' | 'anthropic'
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

export type GenerationPhase = 'idle' | 'loading' | 'formatting' | 'generating' | 'saving' | 'done'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface IndexStatus {
  exists: boolean
  buildAt?: number
  totalSnippets?: number
  sourceMessageCount?: number
  version?: number
}

export type IndexPhase = 'loading' | 'segmenting' | 'indexing' | 'writing' | 'done'

export interface IndexProgress {
  phase: IndexPhase
  message: string
  current?: number
  total?: number
  indeterminate?: boolean
}

interface CharacterChatState {
  // 当前生成任务
  taskId: string
  currentContactId: string
  isGenerating: boolean

  // 实时流式输出
  streamingText: string

  // 进度
  progressPhase: GenerationPhase
  progressMessage: string
  progressCurrent?: number
  progressTotal?: number
  progressIndeterminate: boolean

  // 结果与错误
  errorMessage: string
  lastCompletedContactId: string

  // 缓存
  profilesCache: Record<string, CharacterProfile>
  profilesSummary: CharacterProfileSummary[]
  summaryLoaded: boolean

  // ── 对话状态（里程碑 2） ──
  /** 每个联系人的消息列表（按时间正序） */
  messages: Record<string, ChatMessage[]>
  /** 是否已从后端拉过该联系人的消息 */
  conversationLoaded: Record<string, boolean>
  /** 实时流式中的 assistant 未完成文本（一轮回复累积） */
  replyStreamingText: Record<string, string>
  /** 是否正在等待/生成回复 */
  isReplying: Record<string, boolean>
  /** 最近一次回复错误 */
  replyError: Record<string, string>

  // ── RAG 索引状态（里程碑 3） ──
  indexStatus: Record<string, IndexStatus>
  indexBuilding: Record<string, boolean>
  indexProgress: Record<string, IndexProgress>
  indexError: Record<string, string>

  // 监听器标志
  listenersAttached: boolean
}

interface CharacterChatActions {
  startTask: (taskId: string, contactId: string) => void
  appendChunk: (contactId: string, chunk: string) => void
  setProgress: (payload: {
    phase?: GenerationPhase
    message?: string
    current?: number
    total?: number
    indeterminate?: boolean
  }) => void
  completeTask: (contactId: string, profile: CharacterProfile) => void
  errorTask: (error: string) => void
  resetTask: () => void

  setProfile: (profile: CharacterProfile) => void
  setProfilesSummary: (list: CharacterProfileSummary[]) => void
  removeProfile: (contactId: string) => void

  // 对话 actions
  setConversation: (contactId: string, messages: ChatMessage[]) => void
  appendMessage: (contactId: string, message: ChatMessage) => void
  appendMessages: (contactId: string, messages: ChatMessage[]) => void
  appendStreamChunk: (contactId: string, chunk: string) => void
  startReply: (contactId: string) => void
  finishReply: (contactId: string, assistantMessages: ChatMessage[]) => void
  setReplyError: (contactId: string, error: string) => void
  clearReply: (contactId: string) => void
  clearConversation: (contactId: string) => void

  // 索引 actions
  setIndexStatus: (contactId: string, status: IndexStatus) => void
  startIndexBuild: (contactId: string) => void
  setIndexProgress: (contactId: string, progress: IndexProgress) => void
  finishIndexBuild: (contactId: string, snippetCount: number, sourceMessageCount: number) => void
  setIndexError: (contactId: string, error: string) => void

  markListenersAttached: () => void
}

const INITIAL_STATE: CharacterChatState = {
  taskId: '',
  currentContactId: '',
  isGenerating: false,
  streamingText: '',
  progressPhase: 'idle',
  progressMessage: '',
  progressCurrent: undefined,
  progressTotal: undefined,
  progressIndeterminate: false,
  errorMessage: '',
  lastCompletedContactId: '',
  profilesCache: {},
  profilesSummary: [],
  summaryLoaded: false,
  messages: {},
  conversationLoaded: {},
  replyStreamingText: {},
  isReplying: {},
  replyError: {},
  indexStatus: {},
  indexBuilding: {},
  indexProgress: {},
  indexError: {},
  listenersAttached: false
}

export const useCharacterChatStore = create<CharacterChatState & CharacterChatActions>()((set, get) => ({
  ...INITIAL_STATE,

  startTask: (taskId, contactId) => set({
    taskId,
    currentContactId: contactId,
    isGenerating: true,
    streamingText: '',
    errorMessage: '',
    progressPhase: 'loading',
    progressMessage: '正在启动…',
    progressCurrent: undefined,
    progressTotal: undefined,
    progressIndeterminate: true
  }),

  appendChunk: (contactId, chunk) => {
    const state = get()
    // 只追加属于当前任务的 chunk
    if (state.currentContactId && state.currentContactId !== contactId) return
    set({ streamingText: state.streamingText + chunk })
  },

  setProgress: (payload) => set((prev) => {
    const hasCurrent = 'current' in payload
    const hasTotal = 'total' in payload
    let nextIndeterminate = prev.progressIndeterminate
    if ('indeterminate' in payload) nextIndeterminate = !!payload.indeterminate
    else if (hasCurrent && hasTotal && typeof payload.current === 'number' && typeof payload.total === 'number' && payload.total > 0) {
      nextIndeterminate = false
    }
    return {
      progressPhase: payload.phase ?? prev.progressPhase,
      progressMessage: payload.message ?? prev.progressMessage,
      progressCurrent: hasCurrent ? payload.current : prev.progressCurrent,
      progressTotal: hasTotal ? payload.total : prev.progressTotal,
      progressIndeterminate: nextIndeterminate
    }
  }),

  completeTask: (contactId, profile) => {
    const state = get()
    set({
      isGenerating: false,
      progressPhase: 'done',
      progressMessage: '完成',
      lastCompletedContactId: contactId,
      profilesCache: { ...state.profilesCache, [contactId]: profile }
    })
  },

  errorTask: (error) => set({
    isGenerating: false,
    errorMessage: error,
    progressPhase: 'idle'
  }),

  resetTask: () => set({
    taskId: '',
    currentContactId: '',
    isGenerating: false,
    streamingText: '',
    errorMessage: '',
    progressPhase: 'idle',
    progressMessage: '',
    progressCurrent: undefined,
    progressTotal: undefined,
    progressIndeterminate: false
  }),

  setProfile: (profile) => {
    const state = get()
    set({ profilesCache: { ...state.profilesCache, [profile.contactId]: profile } })
  },

  setProfilesSummary: (list) => set({ profilesSummary: list, summaryLoaded: true }),

  removeProfile: (contactId) => {
    const state = get()
    const nextCache = { ...state.profilesCache }
    delete nextCache[contactId]
    set({
      profilesCache: nextCache,
      profilesSummary: state.profilesSummary.filter(p => p.contactId !== contactId)
    })
  },

  // ── 对话 actions ──
  setConversation: (contactId, messages) => {
    const state = get()
    set({
      messages: { ...state.messages, [contactId]: messages },
      conversationLoaded: { ...state.conversationLoaded, [contactId]: true }
    })
  },

  appendMessage: (contactId, message) => {
    const state = get()
    const prev = state.messages[contactId] || []
    set({
      messages: { ...state.messages, [contactId]: [...prev, message] }
    })
  },

  appendMessages: (contactId, newMessages) => {
    const state = get()
    const prev = state.messages[contactId] || []
    set({
      messages: { ...state.messages, [contactId]: [...prev, ...newMessages] }
    })
  },

  appendStreamChunk: (contactId, chunk) => {
    const state = get()
    const prev = state.replyStreamingText[contactId] || ''
    set({
      replyStreamingText: { ...state.replyStreamingText, [contactId]: prev + chunk }
    })
  },

  startReply: (contactId) => {
    const state = get()
    set({
      isReplying: { ...state.isReplying, [contactId]: true },
      replyStreamingText: { ...state.replyStreamingText, [contactId]: '' },
      replyError: { ...state.replyError, [contactId]: '' }
    })
  },

  finishReply: (contactId, assistantMessages) => {
    const state = get()
    const prev = state.messages[contactId] || []
    set({
      messages: { ...state.messages, [contactId]: [...prev, ...assistantMessages] },
      replyStreamingText: { ...state.replyStreamingText, [contactId]: '' },
      isReplying: { ...state.isReplying, [contactId]: false }
    })
  },

  setReplyError: (contactId, error) => {
    const state = get()
    set({
      replyError: { ...state.replyError, [contactId]: error },
      isReplying: { ...state.isReplying, [contactId]: false },
      replyStreamingText: { ...state.replyStreamingText, [contactId]: '' }
    })
  },

  clearReply: (contactId) => {
    const state = get()
    set({
      replyStreamingText: { ...state.replyStreamingText, [contactId]: '' },
      isReplying: { ...state.isReplying, [contactId]: false },
      replyError: { ...state.replyError, [contactId]: '' }
    })
  },

  clearConversation: (contactId) => {
    const state = get()
    set({
      messages: { ...state.messages, [contactId]: [] },
      conversationLoaded: { ...state.conversationLoaded, [contactId]: true },
      replyStreamingText: { ...state.replyStreamingText, [contactId]: '' },
      isReplying: { ...state.isReplying, [contactId]: false },
      replyError: { ...state.replyError, [contactId]: '' }
    })
  },

  // ── 索引 actions ──
  setIndexStatus: (contactId, status) => {
    const state = get()
    set({ indexStatus: { ...state.indexStatus, [contactId]: status } })
  },

  startIndexBuild: (contactId) => {
    const state = get()
    set({
      indexBuilding: { ...state.indexBuilding, [contactId]: true },
      indexError: { ...state.indexError, [contactId]: '' },
      indexProgress: {
        ...state.indexProgress,
        [contactId]: { phase: 'loading', message: '准备中…', indeterminate: true }
      }
    })
  },

  setIndexProgress: (contactId, progress) => {
    const state = get()
    set({ indexProgress: { ...state.indexProgress, [contactId]: progress } })
  },

  finishIndexBuild: (contactId, snippetCount, sourceMessageCount) => {
    const state = get()
    set({
      indexBuilding: { ...state.indexBuilding, [contactId]: false },
      indexStatus: {
        ...state.indexStatus,
        [contactId]: {
          exists: true,
          buildAt: Date.now(),
          totalSnippets: snippetCount,
          sourceMessageCount
        }
      },
      indexProgress: {
        ...state.indexProgress,
        [contactId]: { phase: 'done', message: `已索引 ${snippetCount} 个片段` }
      }
    })
  },

  setIndexError: (contactId, error) => {
    const state = get()
    set({
      indexBuilding: { ...state.indexBuilding, [contactId]: false },
      indexError: { ...state.indexError, [contactId]: error }
    })
  },

  markListenersAttached: () => set({ listenersAttached: true })
}))

/**
 * 在 App 级别调用一次：注册全局 IPC 监听器
 */
export function initCharacterChatListeners() {
  const store = useCharacterChatStore.getState()
  if (store.listenersAttached) return
  store.markListenersAttached()

  const api = window.electronAPI.characterChat

  api.onProgress((payload) => {
    useCharacterChatStore.getState().setProgress({
      phase: payload.phase,
      message: payload.message,
      current: payload.current,
      total: payload.total,
      indeterminate: payload.indeterminate
    })
  })

  api.onChunk((payload) => {
    useCharacterChatStore.getState().appendChunk(payload.contactId, payload.chunk)
  })

  api.onComplete((payload) => {
    const profile = payload.profile as CharacterProfile
    useCharacterChatStore.getState().completeTask(payload.contactId, profile)
  })

  api.onError((payload) => {
    useCharacterChatStore.getState().errorTask(payload.error)
  })

  api.onReplyChunk((payload) => {
    useCharacterChatStore.getState().appendStreamChunk(payload.contactId, payload.chunk)
  })

  api.onReplyDone((payload) => {
    // 后端已把 assistantMessages 切好片；前端做 staggered 动画追加
    const { contactId, assistantMessages } = payload
    const msgs = assistantMessages as ChatMessage[]
    if (msgs.length <= 1) {
      useCharacterChatStore.getState().finishReply(contactId, msgs)
      return
    }
    // 分条：首条立即 append，后续按节奏 stagger
    const store = useCharacterChatStore.getState()
    store.finishReply(contactId, [msgs[0]])
    let i = 1
    const scheduleNext = () => {
      if (i >= msgs.length) return
      // 300-1000ms 随机 + 每字 15ms 小幅叠加模拟打字
      const seg = msgs[i]
      const delay = 350 + Math.random() * 500 + Math.min(seg.content.length * 15, 600)
      setTimeout(() => {
        useCharacterChatStore.getState().appendMessage(contactId, seg)
        i++
        scheduleNext()
      }, delay)
    }
    scheduleNext()
  })

  api.onReplyError((payload) => {
    useCharacterChatStore.getState().setReplyError(payload.contactId, payload.error)
  })

  api.onIndexProgress((payload) => {
    useCharacterChatStore.getState().setIndexProgress(payload.contactId, {
      phase: payload.phase,
      message: payload.message,
      current: payload.current,
      total: payload.total,
      indeterminate: payload.indeterminate
    })
    // 首次收到进度 → 标记构建中
    const st = useCharacterChatStore.getState()
    if (!st.indexBuilding[payload.contactId]) {
      st.startIndexBuild(payload.contactId)
    }
  })

  api.onIndexComplete((payload) => {
    useCharacterChatStore.getState().finishIndexBuild(
      payload.contactId,
      payload.snippetCount,
      payload.sourceMessageCount
    )
  })

  api.onIndexError((payload) => {
    useCharacterChatStore.getState().setIndexError(payload.contactId, payload.error)
  })
}
