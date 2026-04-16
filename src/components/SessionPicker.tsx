import { useState, useEffect, useRef, useMemo, useCallback, KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Search, ChevronDown, X, Check, Users, User, MessagesSquare, ArrowUp, Clock, Hash } from 'lucide-react'
import { Avatar } from './Avatar'
import { getPinyinInitials } from '../utils/pinyinInitials'
import './SessionPicker.scss'

export interface SessionPickerOption {
  username: string
  displayName: string
  avatarUrl?: string
  lastTimestamp?: number
  messageCount?: number
  alias?: string       // 微信号（wxid 之外的 alias/微信号）
  isPinned?: boolean   // 置顶（若数据源无则忽略）
}

type TypeFilter = 'all' | 'private' | 'group'
type SortKey = 'recent' | 'count' | 'name'

interface SessionPickerProps {
  sessions: SessionPickerOption[]
  value: string
  onChange: (username: string) => void
  disabled?: boolean
  placeholder?: string
  /** 允许隐藏类型 Tab（父级已做过滤时） */
  hideTypeFilter?: boolean
}

function formatRelativeTime(ts?: number): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`
}

/** 高亮关键词片段 */
function Highlight({ text, keyword }: { text: string; keyword: string }) {
  if (!keyword) return <>{text}</>
  const lowerText = text.toLowerCase()
  const lowerKw = keyword.toLowerCase()
  const idx = lowerText.indexOf(lowerKw)
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="sp-hl">{text.slice(idx, idx + keyword.length)}</mark>
      {text.slice(idx + keyword.length)}
    </>
  )
}

export function SessionPicker({
  sessions, value, onChange, disabled, placeholder = '选择会话...', hideTypeFilter
}: SessionPickerProps) {
  const [open, setOpen] = useState(false)
  const [rawKeyword, setRawKeyword] = useState('')
  const [keyword, setKeyword] = useState('')  // 防抖后的关键词
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    (typeof window !== 'undefined' && (localStorage.getItem('sp_sort_key') as SortKey)) || 'recent'
  )
  const [activeIndex, setActiveIndex] = useState(0)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)

  useEffect(() => { try { localStorage.setItem('sp_sort_key', sortKey) } catch { /* ignore */ } }, [sortKey])

  // 防抖
  useEffect(() => {
    const t = setTimeout(() => setKeyword(rawKeyword.trim()), 150)
    return () => clearTimeout(t)
  }, [rawKeyword])

  const selected = useMemo(
    () => sessions.find(s => s.username === value),
    [sessions, value]
  )

  // 预计算每个会话的拼音首字母（缓存）
  const sessionsWithInitials = useMemo(
    () => sessions.map(s => ({
      ...s,
      _initials: getPinyinInitials(s.displayName || '')
    })),
    [sessions]
  )

  const filtered = useMemo(() => {
    let list = sessionsWithInitials

    // 类型过滤
    if (typeFilter !== 'all') {
      list = list.filter(s => {
        const isGroup = s.username.includes('@chatroom')
        return typeFilter === 'group' ? isGroup : !isGroup
      })
    }

    // 关键词过滤
    const kw = keyword.toLowerCase()
    if (kw) {
      list = list.filter(s => {
        if (s.displayName.toLowerCase().includes(kw)) return true
        if (s.username.toLowerCase().includes(kw)) return true
        if (s.alias && s.alias.toLowerCase().includes(kw)) return true
        // 拼音首字母匹配（仅当关键词为纯字母时）
        if (/^[a-z0-9]+$/.test(kw) && s._initials.includes(kw)) return true
        return false
      })
    }

    // 排序
    const sorted = [...list]
    if (sortKey === 'recent') {
      sorted.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0))
    } else if (sortKey === 'count') {
      sorted.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0))
    } else if (sortKey === 'name') {
      sorted.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || '', 'zh-Hans-CN'))
    }

    // 置顶优先
    sorted.sort((a, b) => {
      if (a.isPinned === b.isPinned) return 0
      return a.isPinned ? -1 : 1
    })

    return sorted
  }, [sessionsWithInitials, typeFilter, keyword, sortKey])

  // 打开时自动聚焦 + 重置
  useEffect(() => {
    if (open) {
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
        setRawKeyword('')
        setKeyword('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (open && filtered.length > 0) {
      virtuosoRef.current?.scrollIntoView({ index: activeIndex, behavior: 'auto' })
    }
  }, [activeIndex, open, filtered.length])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[activeIndex]
      if (target) {
        onChange(target.username)
        setOpen(false)
        setRawKeyword('')
        setKeyword('')
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setRawKeyword('')
      setKeyword('')
    }
  }, [open, filtered, activeIndex, onChange])

  const scrollToTop = useCallback(() => {
    virtuosoRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])

  const renderItem = useCallback((index: number) => {
    const s = filtered[index]
    if (!s) return null
    const isGroup = s.username.includes('@chatroom')
    const isSelected = s.username === value
    const isActive = index === activeIndex
    return (
      <div
        className={`sp-item ${isSelected ? 'selected' : ''} ${isActive ? 'active' : ''}`}
        onClick={() => {
          onChange(s.username)
          setOpen(false)
          setRawKeyword('')
          setKeyword('')
        }}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <Avatar
          src={s.avatarUrl}
          name={s.displayName || s.username}
          size={40}
          className={isGroup ? 'group' : ''}
        />
        <div className="sp-item-info">
          <div className="sp-item-top">
            <span className="sp-item-name">
              <Highlight text={s.displayName || s.username} keyword={keyword} />
            </span>
            <span className="sp-item-time">{formatRelativeTime(s.lastTimestamp)}</span>
          </div>
          <div className="sp-item-bottom">
            <span className={`sp-item-tag ${isGroup ? 'group' : 'private'}`}>
              {isGroup ? <Users size={10} /> : <User size={10} />}
              {isGroup ? '群聊' : '私聊'}
            </span>
            {s.isPinned && <span className="sp-item-pinned">置顶</span>}
            {typeof s.messageCount === 'number' && s.messageCount > 0 && (
              <span className="sp-item-count">
                <Hash size={9} />
                {s.messageCount}
              </span>
            )}
          </div>
        </div>
        {isSelected && <Check size={16} className="sp-item-check" />}
      </div>
    )
  }, [filtered, value, activeIndex, onChange, keyword])

  const groupCount = useMemo(
    () => sessions.filter(s => s.username.includes('@chatroom')).length,
    [sessions]
  )
  const privateCount = sessions.length - groupCount

  return (
    <div
      className={`session-picker ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
      ref={wrapRef}
      onKeyDown={handleKeyDown}
      tabIndex={disabled ? -1 : 0}
    >
      <div
        className="sp-trigger"
        onClick={() => !disabled && setOpen(o => !o)}
        role="combobox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <Avatar
              src={selected.avatarUrl}
              name={selected.displayName || selected.username}
              size={26}
              className={selected.username.includes('@chatroom') ? 'group' : ''}
            />
            <span className="sp-trigger-name">{selected.displayName || selected.username}</span>
            {selected.username.includes('@chatroom') && (
              <span className="sp-trigger-badge">群</span>
            )}
          </>
        ) : (
          <span className="sp-trigger-placeholder">{placeholder}</span>
        )}
        <ChevronDown size={16} className="sp-trigger-caret" />
      </div>

      {open && (
        <div className="sp-panel">
          <div className="sp-search-row">
            <Search size={14} className="sp-search-icon" />
            <input
              ref={inputRef}
              type="text"
              placeholder="搜索名称 / wxid / 微信号 / 拼音首字母"
              value={rawKeyword}
              onChange={e => { setRawKeyword(e.target.value); setActiveIndex(0) }}
              className="sp-search-input"
            />
            {rawKeyword && (
              <button
                type="button"
                className="sp-search-clear"
                onClick={() => { setRawKeyword(''); setKeyword(''); inputRef.current?.focus() }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="sp-toolbar">
            {!hideTypeFilter && (
              <div className="sp-type-filter">
                <button
                  type="button"
                  className={typeFilter === 'all' ? 'active' : ''}
                  onClick={() => setTypeFilter('all')}
                ><MessagesSquare size={11} />全部 <span className="sp-count-tag">{sessions.length}</span></button>
                <button
                  type="button"
                  className={typeFilter === 'private' ? 'active' : ''}
                  onClick={() => setTypeFilter('private')}
                ><User size={11} />私聊 <span className="sp-count-tag">{privateCount}</span></button>
                <button
                  type="button"
                  className={typeFilter === 'group' ? 'active' : ''}
                  onClick={() => setTypeFilter('group')}
                ><Users size={11} />群聊 <span className="sp-count-tag">{groupCount}</span></button>
              </div>
            )}
            <div className="sp-sort-row">
              <span className="sp-sort-label">排序</span>
              <button
                type="button"
                className={sortKey === 'recent' ? 'active' : ''}
                onClick={() => setSortKey('recent')}
                title="最近活跃优先"
              ><Clock size={11} />活跃</button>
              <button
                type="button"
                className={sortKey === 'count' ? 'active' : ''}
                onClick={() => setSortKey('count')}
                title="消息数量优先"
              ><Hash size={11} />数量</button>
              <button
                type="button"
                className={sortKey === 'name' ? 'active' : ''}
                onClick={() => setSortKey('name')}
                title="按名称 A-Z 排序"
              >A→Z</button>
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="sp-empty">
              无匹配会话
              {keyword && <div className="sp-empty-hint">当前关键词：&quot;{keyword}&quot;</div>}
            </div>
          ) : (
            <div className="sp-list-wrap">
              <Virtuoso
                ref={virtuosoRef}
                className="sp-list"
                style={{ height: 340 }}
                totalCount={filtered.length}
                itemContent={renderItem}
                overscan={200}
                atTopStateChange={(atTop) => setShowBackToTop(!atTop)}
              />
              {showBackToTop && (
                <button
                  type="button"
                  className="sp-back-to-top"
                  onClick={scrollToTop}
                  title="回到顶部"
                >
                  <ArrowUp size={14} />
                </button>
              )}
            </div>
          )}

          <div className="sp-footer">
            <span>
              {filtered.length} 个会话
              {(keyword || typeFilter !== 'all') && sessions.length !== filtered.length && ` / 共 ${sessions.length}`}
            </span>
            <span className="sp-hint">↑↓ 选择　Enter 确定　Esc 关闭</span>
          </div>
        </div>
      )}
    </div>
  )
}
