import { Square, Database, FileText, Cpu, Sparkles, HardDrive, CheckCircle2, Pause, Play } from 'lucide-react'
import './GenerationProgress.scss'

export type ProgressStage =
  | 'checking'
  | 'exporting'
  | 'reading'
  | 'appending'
  | 'loaded'
  | 'formatting'
  | 'prompting'
  | 'streaming'
  | 'idle'

interface GenerationProgressProps {
  visible: boolean
  stage: ProgressStage
  message: string
  current?: number
  total?: number
  indeterminate?: boolean
  targetName?: string
  streamedChars?: number
  paused?: boolean
  bufferedChars?: number
  onStop?: () => void
  onPause?: () => void
  onResume?: () => void
}

const STAGE_META: Record<ProgressStage, { icon: React.ReactNode; label: string; hint: string }> = {
  idle: { icon: <Sparkles size={14} />, label: '准备中', hint: '初始化任务...' },
  checking: { icon: <HardDrive size={14} />, label: '检查缓存', hint: '核对本地已导出的聊天记录' },
  exporting: { icon: <Database size={14} />, label: '从数据库导出', hint: '首次导出会花费几秒到几十秒' },
  reading: { icon: <HardDrive size={14} />, label: '读取本地缓存', hint: '命中磁盘，通常很快' },
  appending: { icon: <Database size={14} />, label: '追加新消息', hint: '仅增量同步数据库中的新消息' },
  loaded: { icon: <CheckCircle2 size={14} />, label: '加载完成', hint: '准备进入下一阶段' },
  formatting: { icon: <FileText size={14} />, label: '格式化', hint: '压缩成 A/B 标签化结构' },
  prompting: { icon: <Cpu size={14} />, label: '等待 AI 响应', hint: '正在与模型建立连接' },
  streaming: { icon: <Sparkles size={14} />, label: 'AI 生成中', hint: '逐 token 流式输出' }
}

const STAGE_ORDER: ProgressStage[] = ['exporting', 'formatting', 'prompting', 'streaming']

function formatNumber(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function GenerationProgress({
  visible, stage, message, current, total, indeterminate, targetName, streamedChars,
  paused, bufferedChars, onStop, onPause, onResume
}: GenerationProgressProps) {
  if (!visible) return null

  const meta = STAGE_META[stage] || STAGE_META.idle
  const hasDeterminate = !indeterminate && typeof current === 'number' && typeof total === 'number' && total > 0
  const percent = hasDeterminate ? Math.min(100, Math.round(((current as number) / (total as number)) * 100)) : 0

  // 阶段索引（用于顶部 stepper）
  const normalizedStage: ProgressStage =
    stage === 'checking' || stage === 'reading' || stage === 'appending' || stage === 'loaded' ? 'exporting' : stage
  const currentStageIdx = STAGE_ORDER.indexOf(normalizedStage)

  // 仅在流式阶段允许暂停
  const canPause = stage === 'streaming' && !!(onPause || onResume)

  return (
    <div className={`generation-progress ${paused ? 'paused' : ''}`}>
      {/* 顶部阶段条 */}
      <div className="gp-stepper">
        {STAGE_ORDER.map((s, idx) => {
          const active = idx === currentStageIdx
          const done = idx < currentStageIdx
          return (
            <div key={s} className={`gp-step ${active ? 'active' : ''} ${done ? 'done' : ''}`}>
              <span className="gp-step-dot" />
              <span className="gp-step-label">{STAGE_META[s].label}</span>
            </div>
          )
        })}
      </div>

      <div className="gp-body">
        <div className="gp-header">
          <span className="gp-stage-icon">{meta.icon}</span>
          <span className="gp-stage-label">
            {meta.label}
            {paused && <span className="gp-paused-tag">已暂停</span>}
          </span>
          {targetName && <span className="gp-target">· {targetName}</span>}
          {hasDeterminate && (
            <span className="gp-percent">{percent}%</span>
          )}
          <div className="gp-actions">
            {canPause && !paused && (
              <button type="button" className="gp-action-btn" onClick={onPause} title="暂停渲染（不中断 AI）">
                <Pause size={12} />
                暂停
              </button>
            )}
            {canPause && paused && (
              <button type="button" className="gp-action-btn primary" onClick={onResume} title="继续渲染">
                <Play size={12} />
                继续
                {typeof bufferedChars === 'number' && bufferedChars > 0 && (
                  <span className="gp-buffered-count">+{bufferedChars}</span>
                )}
              </button>
            )}
            {onStop && (
              <button type="button" className="gp-stop-btn" onClick={onStop}>
                <Square size={12} />
                停止
              </button>
            )}
          </div>
        </div>

        <div className={`gp-bar ${hasDeterminate ? 'determinate' : 'indeterminate'} ${paused ? 'frozen' : ''}`}>
          <div
            className="gp-bar-fill"
            style={hasDeterminate ? { width: `${percent}%` } : undefined}
          />
        </div>

        <div className="gp-meta">
          <span className="gp-message">
            {paused ? `已暂停 · AI 仍在接收中（${bufferedChars || 0} 字待补齐）` : (message || meta.hint)}
          </span>
          <span className="gp-stats">
            {hasDeterminate && (
              <>
                <strong>{formatNumber(current as number)}</strong>
                <span className="gp-stats-sep">/</span>
                <span>{formatNumber(total as number)} 条</span>
              </>
            )}
            {stage === 'streaming' && typeof streamedChars === 'number' && streamedChars > 0 && (
              <><strong>{formatNumber(streamedChars)}</strong> 字</>
            )}
          </span>
        </div>
      </div>
    </div>
  )
}
