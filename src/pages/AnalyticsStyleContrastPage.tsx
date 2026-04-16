import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, Square, Copy, Loader2, KeyRound, Plug } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SessionPicker, type SessionPickerOption } from '../components/SessionPicker'
import { AiConnectionTester } from '../components/AiConnectionTester'
import '../pages/CharacterPromptPage.scss'

type ApiMode = 'self' | 'redeem'

const STORAGE_KEY_MODE = 'cp_api_mode'
const STORAGE_KEY_PROVIDER = 'cp_api_provider'
const STORAGE_KEY_URL = 'cp_api_url'
const STORAGE_KEY_KEY = 'cp_api_key'
const STORAGE_KEY_MODEL = 'cp_api_model'

export default function AnalyticsStyleContrastPage() {
  const [apiMode, setApiMode] = useState<ApiMode>(
    () => (localStorage.getItem(STORAGE_KEY_MODE) as ApiMode) || 'redeem'
  )
  const [apiProvider, setApiProvider] = useState<'openai' | 'anthropic'>(
    () => (localStorage.getItem(STORAGE_KEY_PROVIDER) as 'openai' | 'anthropic') || 'openai'
  )
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(STORAGE_KEY_URL) || '')
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(STORAGE_KEY_KEY) || '')
  const [apiModel, setApiModel] = useState(() => localStorage.getItem(STORAGE_KEY_MODEL) || '')

  const [remainingUses, setRemainingUses] = useState(0)
  const [sessions, setSessions] = useState<SessionPickerOption[]>([])
  const [selectedSession, setSelectedSession] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [taskId, setTaskId] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [resultText, setResultText] = useState('')
  const [meta, setMeta] = useState<{ selfName: string; otherName: string } | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const resultTextRef = useRef('')

  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODE, apiMode) }, [apiMode])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_PROVIDER, apiProvider) }, [apiProvider])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_URL, apiUrl) }, [apiUrl])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_KEY, apiKey) }, [apiKey])
  useEffect(() => { localStorage.setItem(STORAGE_KEY_MODEL, apiModel) }, [apiModel])

  useEffect(() => {
    window.electronAPI.analyticsAi.getRemainingUses().then(r => setRemainingUses(r.remaining))
  }, [])

  useEffect(() => {
    window.electronAPI.chat.getSessions().then((result) => {
      if (result.success && result.sessions) {
        const privates = (result.sessions as SessionPickerOption[])
          .filter(s => s.displayName && !s.username.includes('@chatroom'))
          .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
        setSessions(privates)
      }
    })
  }, [])

  useEffect(() => {
    const offProg = window.electronAPI.analyticsAi.onProgress((p) => setStatusMessage(p.message))
    const offChunk = window.electronAPI.analyticsAi.onChunk((p) => {
      resultTextRef.current += p.chunk
      setResultText(resultTextRef.current)
      requestAnimationFrame(() => {
        if (resultRef.current) resultRef.current.scrollTop = resultRef.current.scrollHeight
      })
    })
    const offComp = window.electronAPI.analyticsAi.onComplete((p) => {
      setIsGenerating(false)
      setStatusMessage('风格对比生成完成')
      if (p.meta) setMeta(p.meta)
    })
    const offErr = window.electronAPI.analyticsAi.onError((p) => {
      setIsGenerating(false)
      setStatusMessage(`错误: ${p.error}`)
    })
    const offUses = window.electronAPI.analyticsAi.onUsesUpdated((p) => setRemainingUses(p.remaining))
    return () => { offProg(); offChunk(); offComp(); offErr(); offUses() }
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!selectedSession) return
    if (apiMode === 'redeem' && remainingUses <= 0) {
      setStatusMessage('可用次数已耗尽，请兑换新的使用码')
      return
    }
    if (apiMode === 'self' && (!apiUrl || !apiKey)) {
      setStatusMessage('请先填写 API 地址和 Key')
      return
    }
    setIsGenerating(true)
    setResultText('')
    resultTextRef.current = ''
    setMeta(null)
    setStatusMessage('正在启动...')

    const params: Record<string, unknown> = { sessionId: selectedSession, apiProvider }
    if (apiMode === 'self') {
      params.apiBaseUrl = apiUrl
      params.apiKey = apiKey
      params.apiModel = apiModel
    } else {
      params.useBuiltinApi = true
    }

    const r = await window.electronAPI.analyticsAi.generateStyleContrast(
      params as Parameters<typeof window.electronAPI.analyticsAi.generateStyleContrast>[0]
    )
    if (r.success && r.taskId) setTaskId(r.taskId)
    else {
      setStatusMessage(`启动失败: ${r.error}`)
      setIsGenerating(false)
    }
  }, [selectedSession, apiMode, remainingUses, apiUrl, apiKey, apiModel, apiProvider])

  const handleStop = useCallback(() => {
    if (taskId) window.electronAPI.analyticsAi.stop(taskId)
    setIsGenerating(false)
    setStatusMessage('已取消')
  }, [taskId])

  const handleCopy = useCallback(() => {
    if (resultText) {
      navigator.clipboard.writeText(resultText)
      setStatusMessage('已复制到剪贴板')
    }
  }, [resultText])

  const canGenerate = selectedSession && (
    apiMode === 'self' ? (apiUrl && apiKey) : remainingUses > 0
  )

  return (
    <div className="character-prompt-page">
      <div className="page-header">
        <div className="header-left">
          <h2>AI 风格对比</h2>
          <p>基于双人聊天记录，由 AI 深度挖掘两人的性格差异、话题偏好与关系特征</p>
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

      {apiMode === 'redeem' && (
        <div className="redeem-section">
          <div className="redeem-status">
            剩余可用次数：<span className="remaining-count">{remainingUses}</span> 次（与角色提示词共用）
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            若无可用次数，请前往"角色提示词"页面兑换
          </div>
        </div>
      )}

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

      <div className="config-section single-col">
        <div className="config-row full-row">
          <label>选择会话</label>
          <SessionPicker
            sessions={sessions}
            value={selectedSession}
            onChange={setSelectedSession}
            disabled={isGenerating}
            placeholder="请选择一个双人会话（不支持群聊）..."
          />
        </div>
      </div>

      <div className="actions">
        {!isGenerating ? (
          <button className="generate-btn" onClick={handleGenerate} disabled={!canGenerate}>
            <Sparkles size={16} />
            生成风格对比
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

      <div className="result-section">
        <div className="result-header">
          <span className="result-title">
            {meta ? `${meta.selfName} × ${meta.otherName} 的风格对比` : '分析结果'}
          </span>
          {resultText && (
            <div className="result-actions">
              <button onClick={handleCopy}><Copy size={14} />复制</button>
            </div>
          )}
        </div>
        <div className="result-content" ref={resultRef}>
          {resultText ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{resultText}</ReactMarkdown>
          ) : isGenerating ? (
            <div className="placeholder">
              <Loader2 size={16} className="spin" style={{ marginRight: 8 }} />
              {statusMessage || '正在加载...'}
            </div>
          ) : (
            <div className="placeholder">
              选择双人会话，点击"生成风格对比"开始
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
