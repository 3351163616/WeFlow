import { useState, useEffect, useRef, useMemo, useCallback, KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { Search, ChevronDown, X, Check, Users, User } from 'lucide-react'
import { Avatar } from './Avatar'
import './SessionPicker.scss'

export interface SessionPickerOption {
  username: string
  displayName: string
  avatarUrl?: string
  lastTimestamp?: number
  messageCount?: number
}

interface SessionPickerProps {
  sessions: SessionPickerOption[]
  value: string
  onChange: (username: string) => void
  disabled?: boolean
  placeholder?: string
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

export function SessionPicker({
  sessions, value, onChange, disabled, placeholder = '选择会话...'
}: SessionPickerProps) {
  const [open, setOpen] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle | null>(null)

  const selected = useMemo(
    () => sessions.find(s => s.username === value),
    [sessions, value]
  )

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return sessions
    return sessions.filter(s =>
      s.displayName.toLowerCase().includes(kw) ||
      s.username.toLowerCase().includes(kw)
    )
  }, [sessions, keyword])

  // 打开时自动聚焦搜索、重置 activeIndex
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
        setKeyword('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // activeIndex 变化时滚动到可见区
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
        setKeyword('')
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      setKeyword('')
    }
  }, [open, filtered, activeIndex, onChange])

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
            <span className="sp-item-name">{s.displayName || s.username}</span>
            <span className="sp-item-time">{formatRelativeTime(s.lastTimestamp)}</span>
          </div>
          <div className="sp-item-bottom">
            <span className={`sp-item-tag ${isGroup ? 'group' : 'private'}`}>
              {isGroup ? <Users size={10} /> : <User size={10} />}
              {isGroup ? '群聊' : '私聊'}
            </span>
            {typeof s.messageCount === 'number' && s.messageCount > 0 && (
              <span className="sp-item-count">{s.messageCount} 条</span>
            )}
          </div>
        </div>
        {isSelected && <Check size={16} className="sp-item-check" />}
      </div>
    )
  }, [filtered, value, activeIndex, onChange])

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
              placeholder="搜索会话名称..."
              value={keyword}
              onChange={e => { setKeyword(e.target.value); setActiveIndex(0) }}
              className="sp-search-input"
            />
            {keyword && (
              <button
                type="button"
                className="sp-search-clear"
                onClick={() => { setKeyword(''); inputRef.current?.focus() }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <div className="sp-empty">无匹配会话</div>
          ) : (
            <Virtuoso
              ref={virtuosoRef}
              className="sp-list"
              style={{ height: 340 }}
              totalCount={filtered.length}
              itemContent={renderItem}
              overscan={200}
            />
          )}

          <div className="sp-footer">
            共 {filtered.length} 个会话
            {keyword && sessions.length !== filtered.length && ` / ${sessions.length}`}
            <span className="sp-hint">↑↓ 选择　Enter 确定　Esc 关闭</span>
          </div>
        </div>
      )}
    </div>
  )
}
