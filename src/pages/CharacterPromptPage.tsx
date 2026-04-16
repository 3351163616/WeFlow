import { useState, useEffect, useRef, useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { Sparkles, Square, Copy, Download, Loader2, KeyRound, Plug } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './CharacterPromptPage.scss'

type ApiMode = 'self' | 'redeem'

interface SessionOption {
  username: string
  displayName: string
  type: number
  lastTimestamp?: number
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
  const [remainingUses, setRemainingUses] = useState(0)

  // 会话 & 成员
  const [sessions, setSessions] = useState<SessionOption[]>([])
  const [selectedSession, setSelectedSession] = useState('')
  const [members, setMembers] = useState<MemberOption[]>([])
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set())
  const [loadingMembers, setLoadingMembers] = useState(false)

  // 生成状态
  const [isGenerating, setIsGenerating] = useState(false)
  const [taskId, setTaskId] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [resultText, setResultText] = useState('')
  const [currentTarget, setCurrentTarget] = useState('')
  const resultRef = useRef<HTMLDivElement>(null)
  const resultTextRef = useRef('')

  // 持久化 API 配置
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODE, apiMode) }, [apiMode])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_PROVIDER, apiProvider) }, [apiProvider])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_URL, apiUrl) }, [apiUrl])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_KEY, apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODEL, apiModel) }, [apiModel])

  // 加载剩余次数
  useEffect(() => {
    window.electronAPI.characterPrompt.getRemainingUses().then(r => setRemainingUses(r.remaining))
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

  // IPC 事件监听
  useEffect(() => {
    const removeProgress = window.electronAPI.characterPrompt.onProgress((payload) => {
      setStatusMessage(payload.message)
      if (payload.targetName) setCurrentTarget(payload.targetName)
    })
    const removeChunk = window.electronAPI.characterPrompt.onChunk((payload) => {
      resultTextRef.current += payload.chunk
      setResultText(resultTextRef.current)
      requestAnimationFrame(() => {
        if (resultRef.current) resultRef.current.scrollTop = resultRef.current.scrollHeight
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
    const removeUses = window.electronAPI.characterPrompt.onUsesUpdated((payload) => {
      setRemainingUses(payload.remaining)
    })
    return () => { removeProgress(); removeChunk(); removeComplete(); removeError(); removeUses() }
  }, [])

  // 兑换码提交
  const handleRedeem = useCallback(async () => {
    if (!redeemInput.trim()) return
    setRedeemMessage(null)
    const result = await window.electronAPI.characterPrompt.redeemCode(redeemInput.trim())
    if (result.success) {
      setRedeemMessage({ text: `兑换成功！获得 ${result.addedUses} 次使用权限，当前剩余 ${result.totalRemaining} 次`, type: 'success' })
      setRemainingUses(result.totalRemaining || 0)
      setRedeemInput('')
    } else {
      setRedeemMessage({ text: result.error || '兑换失败', type: 'error' })
    }
  }, [redeemInput])

  // 生成
  const handleGenerate = useCallback(async () => {
    if (!selectedSession || selectedMembers.size === 0) return

    // 兑换码路径检查次数
    if (apiMode === 'redeem' && remainingUses <= 0) {
      setStatusMessage('可用次数已耗尽，请兑换新的使用码')
      return
    }

    // 自备 API 路径检查配置
    if (apiMode === 'self' && (!apiUrl || !apiKey)) {
      setStatusMessage('请先填写 API 地址和 Key')
      return
    }

    setIsGenerating(true)
    setResultText('')
    resultTextRef.current = ''
    setStatusMessage('正在启动...')

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

    const result = await window.electronAPI.characterPrompt.generate(params as Parameters<typeof window.electronAPI.characterPrompt.generate>[0])

    if (result.success && result.taskId) {
      setTaskId(result.taskId)
    } else {
      setStatusMessage(`启动失败: ${result.error}`)
      setIsGenerating(false)
    }
  }, [selectedSession, selectedMembers, apiMode, apiProvider, apiUrl, apiKey, apiModel, remainingUses])

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
        setStatusMessage('导出失败: ' + (writeResult.error || ''))
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
              placeholder="输入兑换码"
              disabled={isGenerating}
              maxLength={12}
            />
            <button onClick={handleRedeem} disabled={!redeemInput.trim() || isGenerating}>
              兑换
            </button>
          </div>

          {redeemMessage && (
            <div className={`redeem-message ${redeemMessage.type}`}>{redeemMessage.text}</div>
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
        </div>
      )}

      {/* 会话和成员选择 */}
      <div className="config-section single-col">
        <div className="config-row full-row">
          <label>选择会话</label>
          <select value={selectedSession} onChange={e => setSelectedSession(e.target.value)} disabled={isGenerating}>
            <option value="">请选择...</option>
            {sessions.map(s => (
              <option key={s.username} value={s.username}>
                {s.displayName}{s.username.includes('@chatroom') ? ' (群聊)' : ''}
              </option>
            ))}
          </select>
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
              {members.map(m => (
                <div
                  key={m.wxid}
                  className={`member-chip ${selectedMembers.has(m.wxid) ? 'selected' : ''}`}
                  onClick={() => !isGenerating && toggleMember(m.wxid)}
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
      </div>

      {/* 操作按钮 */}
      <div className="actions">
        {!isGenerating ? (
          <button className="generate-btn" onClick={handleGenerate} disabled={!canGenerate}>
            <Sparkles size={16} />
            生成角色提示词
            {apiMode === 'redeem' && remainingUses > 0 && ` (${remainingUses})`}
          </button>
        ) : (
          <button className="stop-btn" onClick={handleStop}>
            <Square size={14} />
            停止生成
          </button>
        )}
        {statusMessage && (
          statusMessage.startsWith('错误') ? (
            <details className="error-box">
              <summary>生成失败，点击展开详情</summary>
              <pre>{statusMessage}</pre>
            </details>
          ) : (
            <span className="status-text">{statusMessage}</span>
          )
        )}
      </div>

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
