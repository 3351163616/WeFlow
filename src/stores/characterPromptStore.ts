import { create } from 'zustand'
import type { ProgressStage } from '../components/GenerationProgress'

interface CharacterPromptState {
  // 任务状态
  taskId: string
  isGenerating: boolean
  isPaused: boolean

  // 结果
  resultText: string
  pendingBuffer: string       // 暂停期间累积的 chunk
  currentTarget: string

  // 进度
  progressStage: ProgressStage
  progressMessage: string
  progressCurrent?: number
  progressTotal?: number
  progressIndeterminate: boolean

  // 其它
  statusMessage: string
  errorMessage: string
  remainingUses: number

  // 订阅初始化标记
  listenersAttached: boolean
}

interface CharacterPromptActions {
  startTask: (taskId: string) => void
  setPaused: (paused: boolean) => void
  appendChunk: (chunk: string, targetName?: string) => void
  setProgress: (payload: {
    stage?: ProgressStage
    message?: string
    current?: number
    total?: number
    indeterminate?: boolean
    targetName?: string
  }) => void
  setRemainingUses: (n: number) => void
  setStatusMessage: (msg: string) => void
  completeTask: (targetName?: string) => void
  errorTask: (error: string) => void
  resetTask: () => void
  markListenersAttached: () => void
}

const INITIAL_STATE: CharacterPromptState = {
  taskId: '',
  isGenerating: false,
  isPaused: false,
  resultText: '',
  pendingBuffer: '',
  currentTarget: '',
  progressStage: 'idle',
  progressMessage: '',
  progressCurrent: undefined,
  progressTotal: undefined,
  progressIndeterminate: false,
  statusMessage: '',
  errorMessage: '',
  remainingUses: 0,
  listenersAttached: false
}

export const useCharacterPromptStore = create<CharacterPromptState & CharacterPromptActions>()((set, get) => ({
  ...INITIAL_STATE,

  startTask: (taskId) => set({
    taskId,
    isGenerating: true,
    isPaused: false,
    resultText: '',
    pendingBuffer: '',
    errorMessage: '',
    statusMessage: '正在启动...',
    progressStage: 'checking',
    progressMessage: '正在启动...',
    progressCurrent: undefined,
    progressTotal: undefined,
    progressIndeterminate: true,
    currentTarget: ''
  }),

  setPaused: (paused) => {
    const state = get()
    if (paused) {
      set({ isPaused: true })
    } else {
      // 恢复：把 pendingBuffer flush 到 resultText
      set({
        isPaused: false,
        resultText: state.resultText + state.pendingBuffer,
        pendingBuffer: ''
      })
    }
  },

  appendChunk: (chunk, targetName) => {
    const state = get()
    if (state.isPaused) {
      // 暂停中：累积到缓冲区，不更新 resultText
      set({
        pendingBuffer: state.pendingBuffer + chunk,
        currentTarget: targetName || state.currentTarget
      })
    } else {
      set({
        resultText: state.resultText + chunk,
        currentTarget: targetName || state.currentTarget
      })
    }
  },

  setProgress: (payload) => {
    set((prev) => {
      const hasCurrent = 'current' in payload
      const hasTotal = 'total' in payload
      // 若明确传了 indeterminate 优先用之；否则根据是否有数字化 current/total 推断
      let nextIndeterminate: boolean
      if ('indeterminate' in payload) {
        nextIndeterminate = !!payload.indeterminate
      } else if (hasCurrent && hasTotal && typeof payload.current === 'number' && typeof payload.total === 'number' && payload.total > 0) {
        nextIndeterminate = false
      } else {
        nextIndeterminate = prev.progressIndeterminate
      }
      return {
        progressStage: payload.stage ?? prev.progressStage,
        progressMessage: payload.message ?? prev.progressMessage,
        progressCurrent: hasCurrent ? payload.current : prev.progressCurrent,
        progressTotal: hasTotal ? payload.total : prev.progressTotal,
        progressIndeterminate: nextIndeterminate,
        currentTarget: payload.targetName || prev.currentTarget,
        statusMessage: payload.message ?? prev.statusMessage
      }
    })
  },

  setRemainingUses: (n) => set({ remainingUses: n }),

  setStatusMessage: (msg) => set({ statusMessage: msg }),

  completeTask: (targetName) => {
    const state = get()
    // 完成时也要 flush 缓冲
    set({
      isGenerating: false,
      isPaused: false,
      resultText: state.resultText + state.pendingBuffer,
      pendingBuffer: '',
      statusMessage: `${targetName || state.currentTarget || ''} 的角色提示词生成完成`.trim()
    })
  },

  errorTask: (error) => {
    const state = get()
    set({
      isGenerating: false,
      isPaused: false,
      resultText: state.resultText + state.pendingBuffer,
      pendingBuffer: '',
      errorMessage: error,
      statusMessage: `错误: ${error}`
    })
  },

  resetTask: () => set({
    ...INITIAL_STATE,
    remainingUses: get().remainingUses,
    listenersAttached: get().listenersAttached
  }),

  markListenersAttached: () => set({ listenersAttached: true })
}))

/**
 * 在 App 级别调用一次：注册全局 IPC 监听器
 * 重复调用会被 listenersAttached 保护
 */
export function initCharacterPromptListeners() {
  const state = useCharacterPromptStore.getState()
  if (state.listenersAttached) return
  useCharacterPromptStore.getState().markListenersAttached()

  const api = window.electronAPI.characterPrompt

  api.onProgress((payload) => {
    useCharacterPromptStore.getState().setProgress({
      stage: payload.stage as ProgressStage | undefined,
      message: payload.message,
      current: payload.current,
      total: payload.total,
      indeterminate: payload.indeterminate,
      targetName: payload.targetName
    })
  })

  api.onChunk((payload) => {
    useCharacterPromptStore.getState().appendChunk(payload.chunk, payload.targetName)
  })

  api.onComplete((payload) => {
    useCharacterPromptStore.getState().completeTask(payload.targetName)
  })

  api.onError((payload) => {
    useCharacterPromptStore.getState().errorTask(payload.error)
  })

  api.onUsesUpdated((payload) => {
    useCharacterPromptStore.getState().setRemainingUses(payload.remaining)
  })

  // 初始化剩余次数
  api.getRemainingUses().then(r => useCharacterPromptStore.getState().setRemainingUses(r.remaining))
}
