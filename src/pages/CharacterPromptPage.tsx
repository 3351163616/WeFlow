import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Sparkles, Copy, Download, Loader2, KeyRound, Plug, ArrowDownToLine } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SessionPicker } from '../components/SessionPicker'
import { AiConnectionTester } from '../components/AiConnectionTester'
import { GenerationProgress } from '../components/GenerationProgress'
import { useCharacterPromptStore } from '../stores/characterPromptStore'
import './CharacterPromptPage.scss'

type ApiMode = 'self' | 'redeem'

interface SessionOption {
  username: string
  displayName: string
  type: number
  lastTimestamp?: number
  avatarUrl?: string
}

interface MemberOption {
  wxid: string
  displayName: string
  messageCount: number
}

// 持久化 key
const STORAGE_KEY_MODE = 'cp_api_mode'
const STORAGE_KEY_PROVIDER = 'cp_api_provider'
const STORAGE_KEY_URL = 'cp_api_url'
const STORAGE_KEY_KEY = 'cp_api_key'
const STORAGE_KEY_MODEL = 'cp_api_model'

export default function CharacterPromptPage() {
  const location = useLocation()
  const initialSessionId = (location.state as { sessionId?: string } | null)?.sessionId

  // API 模式
  const [apiMode, setApiMode] = useState<ApiMode>(
    () => (localStorage.getItem(STORAGE_KEY_MODE) as ApiMode) || 'self'
  )

  // 自备 API 配置（持久化）
  const [apiProvider, setApiProvider] = useState<'openai' | 'anthropic'>(
    () => (localStorage.getItem(STORAGE_KEY_PROVIDER) as 'openai' | 'anthropic') || 'openai'
  )
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(STORAGE_KEY_URL) || '')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY_KEY) || '')
  const [apiModel, setApiModel] = useState(() => localStorage.getItem(STORAGE_KEY_MODEL) || '')

  // 兑换码
  const [redeemInput, setRedeemInput] = useState('')
  const [redeemMessage, setRedeemMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)
  const [isRedeeming, setIsRedeeming] = useState(false)
  const [exportDir, setExportDir] = useState('')

  // 会话 & 成员
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [selectedSession, setSelectedSession] = useState('')
  const [members, setMembers] = useState<MemberOption[]>([])
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [loadingMembers, setLoadingMembers] = useState(false)

  // 生成状态 — 全部来自全局 store（跨路由持久）
  const taskId = useCharacterPromptStore(s => s.taskId)
  const isGenerating = useCharacterPromptStore(s => s.isGenerating)
  const isPaused = useCharacterPromptStore(s => s.isPaused)
  const resultText = useCharacterPromptStore(s => s.resultText)
  const pendingBufferLen = useCharacterPromptStore(s => s.pendingBuffer.length)
  const currentTarget = useCharacterPromptStore(s => s.currentTarget)
  const progressStage = useCharacterPromptStore(s => s.progressStage)
  const progressCurrent = useCharacterPromptStore(s => s.progressCurrent)
  const progressTotal = useCharacterPromptStore(s => s.progressTotal)
  const progressIndeterminate = useCharacterPromptStore(s => s.progressIndeterminate)
  const progressMessage = useCharacterPromptStore(s => s.progressMessage)
  const statusMessage = useCharacterPromptStore(s => s.statusMessage)
  const errorMessage = useCharacterPromptStore(s => s.errorMessage)
  const remainingUses = useCharacterPromptStore(s => s.remainingUses)
  const storeStartTask = useCharacterPromptStore(s => s.startTask)
  const storeSetPaused = useCharacterPromptStore(s => s.setPaused)
  const storeResetTask = useCharacterPromptStore(s => s.resetTask)
  const storeSetStatus = useCharacterPromptStore(s => s.setStatusMessage)
  const storeSetRemaining = useCharacterPromptStore(s => s.setRemainingUses)
  const storeErrorTask = useCharacterPromptStore(s => s.errorTask)

  const resultRef = useRef<HTMLDivElement>(null)
  // 智能粘底：用户是否主动脱离底部
  const stickToBottomRef = useRef(true)
  const [isStuckToBottom, setIsStuckToBottom] = useState(true)

  // 持久化 API 配置
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODE, apiMode) }, [apiMode])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_PROVIDER, apiProvider) }, [apiProvider])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_URL, apiUrl) }, [apiUrl])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_KEY, apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODEL, apiModel) }, [apiModel])

  // 加载剩余次数 & 导出目录（剩余次数已由 store 初始化订阅）
  useEffect(() => {
    window.electronAPI.characterPrompt.getExportDir().then(r => setExportDir(r.dir || ''))
  }, [])

  // 加载会话列表
  useEffect(() => {
    window.electronAPI.chat.getSessions().then((result) => {
      if (result.success && result.sessions) {
        const sorted = (result.sessions as SessionOption[])
          .filter(s => s.displayName)
          .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
        setSessions(sorted)
      }
    })
  }, [])

  // 路由传参自动选中
  useEffect(() => {
    if (initialSessionId && sessions.length > 0) {
      setSelectedSession(initialSessionId)
    }
  }, [initialSessionId, sessions])

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
        if (result.sessionType === 'private' && result.members.length >= 2) {
          const other = result.members[1]
          if (other) setSelectedMembers(new Set([other.wxid]))
        } else {
          setSelectedMembers(new Set())
        }
      }
    })
  }, [selectedSession])

  // IPC 监听已在 App 根部全局注册（initCharacterPromptListeners），无需在此订阅
  // 结果区域智能粘底：仅当用户处于底部 30px 以内时才自动滚动
  useEffect(() => {
    if (stickToBottomRef.current && resultRef.current) {
      requestAnimationFrame(() => {
        if (resultRef.current) resultRef.current.scrollTop = resultRef.current.scrollHeight
      })
    }
  }, [resultText])

  // 监听滚动，判断是否仍粘底
  const handleResultScroll = useCallback(() => {
    const el = resultRef.current
    if (!el) return
    const threshold = 30
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distanceFromBottom <= threshold
    stickToBottomRef.current = atBottom
    setIsStuckToBottom(atBottom)
  }, [])

  const handleJumpToBottom = useCallback(() => {
    const el = resultRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stickToBottomRef.current = true
    setIsStuckToBottom(true)
  }, [])

  // 新生成开始时默认重置为粘底
  useEffect(() => {
    if (isGenerating && resultText === '') {
      stickToBottomRef.current = true
      setIsStuckToBottom(true)
    }
  }, [isGenerating, resultText])

  // 兑换码提交
  const handleRedeem = useCallback(async () => {
    if (!redeemInput.trim() || isRedeeming) return
    setRedeemMessage(null)
    setIsRedeeming(true)
    try {
      const result = await window.electronAPI.characterPrompt.redeemCode(redeemInput.trim())
      if (result.success) {
        setRedeemMessage({
          text: `兑换成功！获得 ${result.addedUses} 次，当前剩余 ${result.totalRemaining} 次`,
          type: 'success'
        })
        storeSetRemaining(result.totalRemaining || 0)
        setRedeemInput('')
      } else {
        setRedeemMessage({ text: result.error || '兑换失败', type: 'error' })
      }
    } catch (e) {
      setRedeemMessage({ text: `兑换失败：${(e as Error).message}`, type: 'error' })
    } finally {
      setIsRedeeming(false)
    }
  }, [redeemInput, isRedeeming, storeSetRemaining])

  const handlePickExportDir = useCallback(async () => {
    const r = await window.electronAPI.characterPrompt.pickExportDir()
    if (!r.canceled && r.dir) {
      setExportDir(r.dir)
      storeSetStatus(`已设置导出目录：${r.dir}`)
    }
    return r
  }, [storeSetStatus])

  const handleClearExportDir = useCallback(async () => {
    await window.electronAPI.characterPrompt.setExportDir('')
    setExportDir('')
    storeSetStatus('已清除导出目录（下次将仅使用内存缓存）')
  }, [storeSetStatus])

  // 生成
  const handleGenerate = useCallback(async () => {
    if (!selectedSession || selectedMembers.size === 0) return

    // 兑换码路径检查次数
    if (apiMode === 'redeem' && remainingUses <= 0) {
      storeSetStatus('可用次数已耗尽，请兑换新的使用码')
      return
    }

    // 自备 API 路径检查配置
    if (apiMode === 'self' && (!apiUrl || !apiKey)) {
      storeSetStatus('请先填写 API 地址和 Key')
      return
    }

    // 导出目录：未设置则弹窗要求选择；已设置则直接复用
    let effectiveDir = exportDir
    if (!effectiveDir) {
      const r = await window.electronAPI.characterPrompt.pickExportDir()
      if (r.canceled || !r.dir) {
        storeSetStatus('已取消：需要选择一个导出目录用于保存聊天记录')
        return
      }
      effectiveDir = r.dir
      setExportDir(r.dir)
    }

    const params: Record<string, unknown> = {
      sessionId: selectedSession,
      targetWxids: Array.from(selectedMembers),
      apiProvider
    }

    if (apiMode === 'self') {
      params.apiBaseUrl = apiUrl
      params.apiKey = apiKey
      params.apiModel = apiModel
    } else {
      params.useBuiltinApi = true
    }

    const result = await window.electronAPI.characterPrompt.generate(
      params as Parameters<typeof window.electronAPI.characterPrompt.generate>[0]
    )

    if (result.success && result.taskId) {
      storeStartTask(result.taskId)
    } else {
      storeErrorTask(result.error || '启动失败')
    }
  }, [selectedSession, selectedMembers, apiMode, apiProvider, apiUrl, apiKey, apiModel, remainingUses, exportDir, storeSetStatus, storeStartTask, storeErrorTask])

  const handleStop = useCallback(() => {
    if (taskId) {
      window.electronAPI.characterPrompt.stop(taskId)
      storeResetTask()
      storeSetStatus('已取消')
    }
  }, [taskId, storeResetTask, storeSetStatus])

  const handlePause = useCallback(() => storeSetPaused(true), [storeSetPaused])
  const handleResume = useCallback(() => storeSetPaused(false), [storeSetPaused])

  const handleCopy = useCallback(() => {
    if (resultText) {
      navigator.clipboard.writeText(resultText)
      storeSetStatus('已复制到剪贴板')
    }
  }, [resultText])

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
        storeSetStatus('已导出到 ' + result.filePath)
      } else {
        storeSetStatus('导出失败: ' + (writeResult.error || ''))
      }
    }
  }, [resultText, currentTarget])

  const toggleMember = (name: string) => {
    setSelectedMembers(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const canGenerate = selectedSession && selectedMembers.size > 0 && (
    apiMode === 'self' ? (apiUrl && apiKey) : remainingUses > 0
  )

  return (
    <div className="character-prompt-page">
      <div className="page-header">
        <div className="header-left">
          <h2>角色提示词</h2>
          <p>从聊天记录中提取对话参与者的性格特征、说话风格，生成可用于 AI 角色扮演的人设描述</p>
        </div>
        <div className="path-selector">
          <div
            className={`path-card ${apiMode === 'redeem' ? 'active' : ''}`}
            onClick={() => !isGenerating && setApiMode('redeem')}
          >
            <span className="path-title"><KeyRound size={13} />兑换码</span>
          </div>
          <div
            className={`path-card ${apiMode === 'self' ? 'active' : ''}`}
            onClick={() => !isGenerating && setApiMode('self')}
          >
            <span className="path-title"><Plug size={13} />自备 API</span>
          </div>
        </div>
      </div>

      {/* 兑换码区域 */}
      {apiMode === 'redeem' && (
        <div className="redeem-section">
          <div className="redeem-status">
            剩余可用次数：<span className="remaining-count">{remainingUses}</span> 次
          </div>

          <div className="redeem-input-row">
            <input
              type="text"
              value={redeemInput}
              onChange={e => setRedeemInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleRedeem()}
              placeholder="输入兑换码（示例：WF7K2M9X）"
              disabled={isGenerating || isRedeeming}
              maxLength={12}
              aria-label="兑换码输入框"
            />
            <button
              type="button"
              className="redeem-btn"
              onClick={handleRedeem}
              disabled={!redeemInput.trim() || isGenerating || isRedeeming}
              aria-label="提交兑换码"
            >
              {isRedeeming ? (
                <>
                  <Loader2 size={14} className="spin" />
                  <span>兑换中...</span>
                </>
              ) : (
                <>
                  <KeyRound size={14} />
                  <span>兑换</span>
                </>
              )}
            </button>
          </div>

          {redeemMessage && (
            <div className={`redeem-message ${redeemMessage.type}`} role="status">
              {redeemMessage.type === 'success' ? '✓ ' : '✕ '}
              {redeemMessage.text}
            </div>
          )}

          <div className="payment-guide">
            <div className="guide-title">获取兑换码</div>
            <div className="qr-container">
              <img src="./images/wechat-payment-qr.jpg" alt="微信收款码" />
              <div className="qr-hint">扫描微信收款码付款后，获取兑换码输入上方框中</div>
            </div>
          </div>
        </div>
      )}

      {/* 自备 API 配置 */}
      {apiMode === 'self' && (
        <div className="config-section">
          <div className="config-row">
            <label>API 协议</label>
            <select value={apiProvider} onChange={e => setApiProvider(e.target.value as 'openai' | 'anthropic')} disabled={isGenerating}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div className="config-row">
            <label>模型</label>
            <input type="text" value={apiModel} onChange={e => setApiModel(e.target.value)} placeholder="如 gpt-4o" disabled={isGenerating} />
          </div>
          <div className="config-row full-row">
            <label>API 地址</label>
            <input type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)} placeholder="如 https://api.openai.com/v1" disabled={isGenerating} />
          </div>
          <div className="config-row full-row">
            <label>API Key</label>
            <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-..." disabled={isGenerating} />
          </div>
          <AiConnectionTester
            provider={apiProvider}
            apiBaseUrl={apiUrl}
            apiKey={apiKey}
            apiModel={apiModel}
            disabled={isGenerating}
          />
        </div>
      )}

      {/* 会话和成员选择 */}
      <div className="config-section single-col">
        <div className="config-row full-row">
          <label>选择会话</label>
          <SessionPicker
            sessions={sessions}
            value={selectedSession}
            onChange={setSelectedSession}
            disabled={isGenerating}
            placeholder="请选择要分析的会话..."
          />
        </div>
        <div className="config-row full-row">
          <label>目标成员</label>
          {loadingMembers ? (
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', marginRight: 4 }} />
              加载中...
            </span>
          ) : members.length > 0 ? (
            <div className="member-select">
              {members.map(m => {
                // 兜底：若 displayName 仍是 wxid_xxx 形式，前端再做一次友好化处理，避免暴露原始 wxid
                const looksLikeRawWxid = /^wxid_[A-Za-z0-9_\-]+$/.test(m.displayName)
                  || m.displayName === m.wxid
                const friendlyName = looksLikeRawWxid ? '未命名成员' : m.displayName
                return (
                  <div
                    key={m.wxid}
                    className={`member-chip ${selectedMembers.has(m.wxid) ? 'selected' : ''}`}
                    onClick={() => !isGenerating && toggleMember(m.wxid)}
                    title={looksLikeRawWxid ? m.wxid : undefined}
                  >
                    <span>{friendlyName}</span>
                    <span className="msg-count">{m.messageCount}条</span>
                  </div>
                )
              })}
            </div>
          ) : (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>请先选择会话</span>
          )}
        </div>
      </div>

      {/* 导出目录 */}
      <div className="export-dir-row">
        <div className="export-dir-label">聊天记录导出目录</div>
        <div className="export-dir-value">
          {exportDir ? (
            <>
              <span className="export-dir-path" title={exportDir}>{exportDir}</span>
              <button type="button" className="export-dir-btn" onClick={handlePickExportDir} disabled={isGenerating}>更换</button>
              <button type="button" className="export-dir-btn ghost" onClick={handleClearExportDir} disabled={isGenerating}>清除</button>
            </>
          ) : (
            <>
              <span className="export-dir-hint">未设置 — 首次生成时会提示选择，选中后记住此目录；后续相同会话将直接读磁盘</span>
              <button type="button" className="export-dir-btn" onClick={handlePickExportDir} disabled={isGenerating}>选择目录</button>
            </>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="actions">
        {!isGenerating ? (
          <button className="generate-btn" onClick={handleGenerate} disabled={!canGenerate}>
            <Sparkles size={16} />
            生成角色提示词
            {apiMode === 'redeem' && remainingUses > 0 && ` (${remainingUses})`}
          </button>
        ) : null}
        {!isGenerating && errorMessage ? (
          <details className="error-box">
            <summary>生成失败，点击展开详情</summary>
            <pre>{errorMessage}</pre>
          </details>
        ) : (!isGenerating && statusMessage && (
          <span className="status-text">{statusMessage}</span>
        ))}
      </div>

      {/* 生成进度（带进度条 + 暂停/继续/停止 按钮） */}
      <GenerationProgress
        visible={isGenerating}
        stage={progressStage}
        message={progressMessage}
        current={progressCurrent}
        total={progressTotal}
        indeterminate={progressIndeterminate}
        targetName={currentTarget}
        streamedChars={resultText.length}
        paused={isPaused}
        bufferedChars={pendingBufferLen}
        onStop={handleStop}
        onPause={handlePause}
        onResume={handleResume}
      />

      {/* 结果展示 */}
      <div className="result-section">
        <div className="result-header">
          <span className="result-title">
            {currentTarget ? `${currentTarget} 的角色提示词` : '生成结果'}
          </span>
          {resultText && (
            <div className="result-actions">
              <button onClick={handleCopy}><Copy size={14} />复制</button>
              <button onClick={handleExport}><Download size={14} />导出</button>
            </div>
          )}
        </div>
        <div className="result-content-wrap">
          <div className="result-content" ref={resultRef} onScroll={handleResultScroll}>
            {resultText ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
            ) : (
              <div className="placeholder">
                选择会话和目标成员，点击"生成角色提示词"开始
              </div>
            )}
          </div>
          {isGenerating && !isStuckToBottom && resultText && (
            <button
              type="button"
              className="jump-to-bottom-btn"
              onClick={handleJumpToBottom}
              title="跳到最新"
            >
              <ArrowDownToLine size={14} />
              跳到最新
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
