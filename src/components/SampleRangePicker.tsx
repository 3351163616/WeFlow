import { useMemo, useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import './SampleRangePicker.scss'

/** 预设百分比档位 */
const PRESETS = [10, 25, 50, 75, 100] as const
/** 消息数少于此值时强制全量，不允许用户选择 */
const FORCE_FULL_THRESHOLD = 50
/** 超过此条数提示"可能撑爆 Prompt" */
const DEFAULT_BUDGET = 5000
/** 默认档位：min(25%, 2000) 的依据见需求说明 */
const DEFAULT_CAP = 2000

export interface SampleRangePickerProps {
  totalCount: number
  value: number
  onChange: (count: number) => void
  disabled?: boolean
  /** 预算上限，超过时高亮警告。默认 5000 */
  maxBudget?: number
  className?: string
}

/** 根据总数和百分比计算消息条数 */
export function calcSampleSize(totalCount: number, percent: number): number {
  if (totalCount <= 0) return 0
  if (percent >= 100) return totalCount
  return Math.max(1, Math.round(totalCount * percent / 100))
}

/** 计算默认采样条数：min(25%, 2000) 与总数的下界 */
export function defaultSampleSize(totalCount: number): number {
  if (totalCount <= 0) return 0
  if (totalCount < FORCE_FULL_THRESHOLD) return totalCount
  return Math.min(Math.round(totalCount * 0.25), DEFAULT_CAP)
}

/** 判断一个条数是否等于某个预设百分比（容差 1 条） */
function matchPreset(totalCount: number, count: number): number | null {
  for (const p of PRESETS) {
    const expect = calcSampleSize(totalCount, p)
    if (Math.abs(expect - count) <= 1) return p
  }
  return null
}

export function SampleRangePicker({
  totalCount,
  value,
  onChange,
  disabled,
  maxBudget = DEFAULT_BUDGET,
  className
}: SampleRangePickerProps) {
  const forceFull = totalCount > 0 && totalCount < FORCE_FULL_THRESHOLD

  // 自定义输入框的本地状态（未提交时允许临时值）
  const [customInput, setCustomInput] = useState<string>('')
  const activePreset = useMemo(() => matchPreset(totalCount, value), [totalCount, value])
  const isCustom = activePreset === null

  useEffect(() => {
    if (isCustom) setCustomInput(String(value))
  }, [value, isCustom])

  const overBudget = value > maxBudget

  const handlePreset = (p: number) => {
    if (disabled) return
    onChange(calcSampleSize(totalCount, p))
  }

  const handleCustomBlur = () => {
    const n = Math.max(1, Math.min(totalCount, parseInt(customInput, 10) || 0))
    if (n > 0) onChange(n)
    else setCustomInput(String(value))
  }

  if (totalCount <= 0) {
    return (
      <div className={`sample-range-picker empty ${className || ''}`}>
        <span className="srp-hint">请先选择会话</span>
      </div>
    )
  }

  return (
    <div className={`sample-range-picker ${className || ''}`}>
      <div className="srp-main">
        {forceFull ? (
          <div className="srp-forced-full">
            <span className="srp-badge">已全量使用</span>
            <span className="srp-hint">消息总数 {totalCount} 条不足 {FORCE_FULL_THRESHOLD} 条，已自动采用全部</span>
          </div>
        ) : (
          <>
            <div className="srp-presets">
              {PRESETS.map((p) => {
                const count = calcSampleSize(totalCount, p)
                const active = activePreset === p
                return (
                  <button
                    key={p}
                    type="button"
                    className={`srp-preset ${active ? 'active' : ''}`}
                    onClick={() => handlePreset(p)}
                    disabled={disabled}
                    title={`${p}% ≈ ${count.toLocaleString()} 条`}
                  >
                    {p}%
                  </button>
                )
              })}
              <button
                type="button"
                className={`srp-preset ${isCustom ? 'active' : ''}`}
                onClick={() => !disabled && onChange(value)}
                disabled={disabled}
              >
                自定义
              </button>
            </div>

            {isCustom && (
              <div className="srp-custom">
                <input
                  type="number"
                  min={1}
                  max={totalCount}
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onBlur={handleCustomBlur}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  }}
                  disabled={disabled}
                />
                <span className="srp-custom-unit">条</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className={`srp-readout ${overBudget ? 'warn' : ''}`}>
        <span className="srp-readout-main">
          已选 <strong>{value.toLocaleString()}</strong> 条
          <span className="srp-readout-sep"> / </span>
          共 {totalCount.toLocaleString()} 条
        </span>
        {overBudget && (
          <span className="srp-readout-warn">
            <AlertTriangle size={12} />
            超出建议预算（{maxBudget.toLocaleString()}），生成耗时可能偏长或被截断
          </span>
        )}
      </div>
    </div>
  )
}
