import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, Sparkles, Trash2, RotateCcw, Loader2, Users, AlertCircle, Info,
  Send, ScrollText, X, StopCircle
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useCharacterChatStore,
  type CharacterProfile,
  type ChatMessage
} from '../stores/characterChatStore'
import './CharacterChatPage.scss'

const SAMPLE_SIZE_OPTIONS = [
  { value: 500, label: '精简（500 条，快）' },
  { value: 2000, label: '推荐（2000 条，均衡）' },
  { value: 5000, label: '深度（5000 条，慢但细致）' }
]

const STORAGE_KEY_SAMPLE = 'cc_sample_size'
const SEGMENT_SEPARATOR = '⟨SEP⟩'

function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function formatRelative(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return formatTime(ts).slice(0, 10)
}

/** 去掉分隔符，用于生成中预览 */
function stripSep(text: string): string {
  return text.split(SEGMENT_SEPARATOR).join('\n').trim()
}

export default function CharacterChatPage() {
  const navigate = useNavigate()
  const { contactId: routeContactId } = useParams<{ contactId?: string }>()
  const contactId = routeContactId || ''

  const {
    isGenerating, currentContactId, streamingText,
    progressPhase, progressMessage, progressCurrent, progressTotal, progressIndeterminate,
    errorMessage, profilesCache, profilesSummary, summaryLoaded,
    messages, conversationLoaded, replyStreamingText, isReplying, replyError,
    startTask, resetTask, setProfile, setProfilesSummary, removeProfile,
    setConversation, appendMessage, startReply, setReplyError,
    clearConversation: clearConvStore
  } = useCharacterChatStore()

  const [sampleSize, setSampleSize] = useState<number>(() => {
    const s = localStorage.getItem(STORAGE_KEY_SAMPLE)
    const n = s ? Number(s) : NaN
    return Number.isFinite(n) && SAMPLE_SIZE_OPTIONS.some(o => o.value === n) ? n : 2000
  })
  const [loadingProfile, setLoadingProfile] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showProfileDrawer, setShowProfileDrawer] = useState(false)
  const [inputText, setInputText] = useState('')

  const profile = contactId ? profilesCache[contactId] : undefined
  const isCurrentContactGenerating = isGenerating && currentContactId === contactId

  const conversation = (contactId && messages[contactId]) || []
  const streamText = (contactId && replyStreamingText[contactId]) || ''
  const replying = !!(contactId && isReplying[contactId])
  const thisReplyError = (contactId && replyError[contactId]) || ''

  const listRef = useRef<HTMLDivElement>(null)

  // 初次进入：拉列表
  useEffect(() => {
    if (summaryLoaded) return
    window.electronAPI.characterChat.listProfiles().then(r => {
      if (r.success) setProfilesSummary(r.profiles || [])
    })
  }, [summaryLoaded, setProfilesSummary])

  // contactId 变化：拉该联系人的画像（已缓存则跳过）
  useEffect(() => {
    if (!contactId || profile || isCurrentContactGenerating) return
    setLoadingProfile(true)
    window.electronAPI.characterChat.getProfile(contactId).then(r => {
      if (r.success && r.profile) setProfile(r.profile as CharacterProfile)
    }).finally(() => setLoadingProfile(false))
  }, [contactId, profile, isCurrentContactGenerating, setProfile])

  // 画像加载完后拉对话历史
  useEffect(() => {
    if (!contactId || !profile) return
    if (conversationLoaded[contactId]) return
    window.electronAPI.characterChat.loadMessages(contactId).then(r => {
      if (r.success) setConversation(contactId, (r.messages as ChatMessage[]) || [])
    })
  }, [contactId, profile, conversationLoaded, setConversation])

  // 保存 sampleSize
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SAMPLE, String(sampleSize))
  }, [sampleSize])

  // 新消息自动滚底
  useEffect(() => {
    if (!listRef.current) return
    listRef.current.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [conversation.length, streamText, replying])

  const handleGenerate = useCallback(async () => {
    if (!contactId) return
    resetTask()
    const res = await window.electronAPI.characterChat.generateProfile({
      contactId,
      sampleSize
    })
    if (res.success && res.taskId) {
      startTask(res.taskId, contactId)
    } else {
      useCharacterChatStore.getState().errorTask(res.error || '启动失败')
    }
  }, [contactId, sampleSize, resetTask, startTask])

  const handleDeleteProfile = useCallback(async () => {
    if (!contactId) return
    if (!window.confirm(`确认删除「${profile?.displayName || contactId}」的角色画像？此操作不可撤销，对话历史也将被清空。`)) return
    setDeleting(true)
    // 先清对话，再删画像
    await window.electronAPI.characterChat.clearConversation(contactId)
    const r = await window.electronAPI.characterChat.deleteProfile(contactId)
    setDeleting(false)
    if (r.success) {
      removeProfile(contactId)
      clearConvStore(contactId)
      setShowProfileDrawer(false)
    } else {
      alert(`删除失败：${r.error || '未知错误'}`)
    }
  }, [contactId, profile, removeProfile, clearConvStore])

  const handleClearConversation = useCallback(async () => {
    if (!contactId) return
    if (!window.confirm('确认清空本次对话记录？画像保留，但所有消息将被删除。')) return
    const r = await window.electronAPI.characterChat.clearConversation(contactId)
    if (r.success) {
      clearConvStore(contactId)
    } else {
      alert(`清空失败：${r.error || '未知错误'}`)
    }
  }, [contactId, clearConvStore])

  const handleSend = useCallback(async () => {
    if (!contactId || !profile) return
    const text = inputText.trim()
    if (!text) return
    if (replying) return

    setInputText('')
    startReply(contactId)

    const res = await window.electronAPI.characterChat.ask({ contactId, text })
    if (!res.success) {
      setReplyError(contactId, res.error || '发送失败')
      return
    }
    if (res.userMessage) {
      appendMessage(contactId, res.userMessage as ChatMessage)
    }
  }, [contactId, profile, inputText, replying, startReply, setReplyError, appendMessage])

  const handleStopReply = useCallback(async () => {
    if (!contactId) return
    await window.electronAPI.characterChat.stopReply(contactId)
    useCharacterChatStore.getState().clearReply(contactId)
  }, [contactId])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const progressPercent = useMemo(() => {
    if (progressIndeterminate || !progressTotal || typeof progressCurrent !== 'number') return null
    return Math.min(100, Math.round((progressCurrent / progressTotal) * 100))
  }, [progressCurrent, progressTotal, progressIndeterminate])

  // ─── 子视图渲染 ───

  const renderEmpty = () => (
    <div className="cc-empty">
      <Users size={48} />
      <h3>尚未生成任何角色画像</h3>
      <p>请到联系人页选择一位好友，点击"与 TA AI 聊天"进入本功能。</p>
      <button className="cc-btn-primary" onClick={() => navigate('/contacts')}>
        前往联系人页
      </button>
    </div>
  )

  const renderList = () => (
    <div className="cc-list">
      <div className="cc-list-head">
        <h3>已生成的角色画像</h3>
        <span className="cc-count">{profilesSummary.length} 位</span>
      </div>
      <div className="cc-cards">
        {profilesSummary.map(s => (
          <button key={s.contactId} className="cc-card" onClick={() => navigate(`/character-chat/${encodeURIComponent(s.contactId)}`)}>
            <div className="cc-card-name">{s.displayName}</div>
            <div className="cc-card-meta">
              <span>采样 {s.messageCountUsed} / {s.sourceMessageCount} 条</span>
              <span>·</span>
              <span>{formatRelative(s.generatedAt)}</span>
            </div>
            <div className="cc-card-model">{s.model || '—'}</div>
          </button>
        ))}
      </div>
    </div>
  )

  const renderGenerationGate = () => (
    <div className="cc-gate">
      <div className="cc-gate-card">
        <div className="cc-gate-icon"><Sparkles size={32} /></div>
        <h3>为 TA 生成角色画像</h3>
        <p className="cc-gate-desc">
          WeFlow 将读取你与 TA 的历史聊天记录，交给 AI 提炼出一份详尽的说话风格画像，
          用于后续模拟对话。数据仅在本地处理，只发送给你自行配置的 AI 服务。
        </p>

        <div className="cc-gate-row">
          <label>采样规模</label>
          <select value={sampleSize} onChange={e => setSampleSize(Number(e.target.value))}>
            {SAMPLE_SIZE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div className="cc-gate-hint">
          <Info size={14} />
          <span>按时间从新到旧截取最近 N 条消息进行训练，数量越多越还原但耗时更久</span>
        </div>

        <button className="cc-btn-primary cc-btn-lg" onClick={handleGenerate}>
          <Sparkles size={16} />
          开始生成画像
        </button>

        <div className="cc-gate-tip">
          提示：请先在「设置」或「角色提示词」页面配置好 AI API（aiModelApi* 字段），
          否则生成将无法启动。
        </div>
      </div>
    </div>
  )

  const renderGenerating = () => (
    <div className="cc-generating">
      <div className="cc-prog-head">
        <Loader2 className="cc-spin" size={20} />
        <div className="cc-prog-msg">{progressMessage || '生成中…'}</div>
      </div>
      {progressPercent !== null && (
        <div className="cc-prog-bar">
          <div className="cc-prog-fill" style={{ width: `${progressPercent}%` }} />
        </div>
      )}
      {progressIndeterminate && (
        <div className="cc-prog-bar cc-prog-indeterminate"><div className="cc-prog-fill" /></div>
      )}
      <div className="cc-phase-pills">
        {(['loading', 'formatting', 'generating', 'saving'] as const).map(p => {
          const order: readonly string[] = ['loading', 'formatting', 'generating', 'saving']
          const curIdx = order.indexOf(progressPhase)
          const pIdx = order.indexOf(p)
          const isActive = progressPhase === p
          const isDone = curIdx > pIdx
          return (
            <span key={p} className={`cc-pill ${isActive ? 'active' : ''} ${isDone ? 'done' : ''}`}>
              {({ loading: '读取', formatting: '整理', generating: 'AI 学习', saving: '保存' } as const)[p]}
            </span>
          )
        })}
      </div>
      {streamingText && (
        <div className="cc-stream">
          <div className="cc-stream-head">实时预览</div>
          <div className="cc-stream-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  )

  const renderError = () => (
    <div className="cc-error">
      <AlertCircle size={32} />
      <h3>生成失败</h3>
      <p>{errorMessage}</p>
      <button className="cc-btn-primary" onClick={handleGenerate}>重试</button>
    </div>
  )

  const renderChat = (p: CharacterProfile) => (
    <div className="cc-chat">
      <div className="cc-chat-topbar">
        <button className="cc-icon-btn cc-chat-back" title="返回" onClick={() => navigate(-1)}>
          <ArrowLeft size={16} />
        </button>
        <div className="cc-chat-title">
          <div className="cc-avatar">{p.displayName.slice(0, 1)}</div>
          <div>
            <div className="cc-chat-name">{p.displayName}</div>
            <div className="cc-chat-sub">
              {replying ? '正在输入…' : `AI 模拟对话 · 基于 ${p.messageCountUsed} 条真实消息`}
            </div>
          </div>
        </div>
        <div className="cc-chat-actions">
          <button className="cc-icon-btn" title="查看画像" onClick={() => setShowProfileDrawer(true)}>
            <ScrollText size={16} />
          </button>
          <button className="cc-icon-btn" title="清空对话" onClick={handleClearConversation} disabled={replying}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="cc-chat-body" ref={listRef}>
        {conversation.length === 0 && !replying && (
          <div className="cc-chat-hint">
            <div className="cc-hint-card">
              <Sparkles size={18} />
              <div>
                <div className="cc-hint-title">开始一段对话</div>
                <div className="cc-hint-desc">像平时发微信那样随便聊——TA 的说话风格已学习完毕。</div>
              </div>
            </div>
          </div>
        )}

        {conversation.map(m => (
          <div key={m.id} className={`cc-msg cc-msg-${m.role}`}>
            {m.role === 'assistant' && <div className="cc-msg-avatar">{p.displayName.slice(0, 1)}</div>}
            <div className="cc-bubble">{m.content}</div>
          </div>
        ))}

        {replying && (
          <div className="cc-msg cc-msg-assistant cc-msg-streaming">
            <div className="cc-msg-avatar">{p.displayName.slice(0, 1)}</div>
            {streamText ? (
              <div className="cc-bubble">{stripSep(streamText)}<span className="cc-cursor" /></div>
            ) : (
              <div className="cc-bubble cc-typing">
                <span /><span /><span />
              </div>
            )}
          </div>
        )}

        {thisReplyError && (
          <div className="cc-reply-error">
            <AlertCircle size={14} />
            <span>{thisReplyError}</span>
          </div>
        )}
      </div>

      <div className="cc-input-area">
        <textarea
          className="cc-input"
          placeholder={replying ? `等 ${p.displayName} 回复…` : `给 ${p.displayName} 发消息…`}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          disabled={replying}
        />
        <div className="cc-input-actions">
          <div className="cc-input-tip">Enter 发送 · Shift+Enter 换行</div>
          {replying ? (
            <button className="cc-send-btn cc-stop-btn" onClick={handleStopReply}>
              <StopCircle size={16} />
              停止
            </button>
          ) : (
            <button className="cc-send-btn" onClick={handleSend} disabled={!inputText.trim()}>
              <Send size={16} />
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )

  const renderProfileDrawer = (p: CharacterProfile) => (
    <div className="cc-drawer-overlay" onClick={() => setShowProfileDrawer(false)}>
      <div className="cc-drawer" onClick={e => e.stopPropagation()}>
        <div className="cc-drawer-head">
          <h3>{p.displayName} · 角色画像</h3>
          <button className="cc-icon-btn" onClick={() => setShowProfileDrawer(false)}>
            <X size={16} />
          </button>
        </div>
        <div className="cc-drawer-meta">
          <span>采样 {p.messageCountUsed} / {p.sourceMessageCount} 条</span>
          <span>·</span>
          <span>{p.model}</span>
          <span>·</span>
          <span>{formatRelative(p.generatedAt)}生成</span>
        </div>
        <div className="cc-drawer-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.profileMarkdown}</ReactMarkdown>
        </div>
        <div className="cc-drawer-foot">
          <button className="cc-btn-ghost" onClick={handleGenerate} disabled={isGenerating}>
            <RotateCcw size={14} />
            重新训练画像
          </button>
          <button className="cc-btn-danger" onClick={handleDeleteProfile} disabled={deleting || isGenerating}>
            <Trash2 size={14} />
            删除画像与对话
          </button>
        </div>
      </div>
    </div>
  )

  // ─── 主渲染分支 ───

  let body: React.ReactNode
  if (!contactId) {
    body = profilesSummary.length > 0 ? renderList() : renderEmpty()
  } else if (isCurrentContactGenerating) {
    body = renderGenerating()
  } else if (errorMessage && currentContactId === contactId) {
    body = renderError()
  } else if (loadingProfile) {
    body = <div className="cc-loading"><Loader2 className="cc-spin" /> 加载中…</div>
  } else if (profile) {
    body = renderChat(profile)
  } else {
    body = renderGenerationGate()
  }

  const showHeader = !profile || !contactId || isCurrentContactGenerating
    || (errorMessage && currentContactId === contactId) || loadingProfile

  return (
    <div className={`character-chat-page ${profile && contactId && !isCurrentContactGenerating ? 'cc-chat-mode' : ''}`}>
      {showHeader && (
        <div className="cc-header">
          <button className="cc-back" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} />
            返回
          </button>
          <h2>AI 私聊</h2>
          <span className="cc-header-badge">模拟微信角色聊天 · MVP</span>
        </div>
      )}
      <div className="cc-content">{body}</div>
      {showProfileDrawer && profile && renderProfileDrawer(profile)}
    </div>
  )
}
