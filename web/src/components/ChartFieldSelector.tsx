import { useMemo } from 'react'
import type { ChartSpec, SQLResult } from '../types'
import { useT } from '../i18n'
import { classifyColumns, formatColumnName } from '../utils/chartFieldRoles'

export type ChartType = 'line' | 'bar' | 'pie' | 'none'

interface ChartFieldSelectorProps {
  result: SQLResult
  spec: ChartSpec
  effectiveChartType: ChartType
  effectiveX?: string
  effectiveY: string[]
  effectiveSeries?: string
  onChange: (patch: Partial<ChartSpec>) => void
}

const CHART_TYPES: { key: ChartType; en: string; zh: string }[] = [
  { key: 'line', en: 'Line', zh: '折线' },
  { key: 'bar', en: 'Bar', zh: '柱状' },
  { key: 'pie', en: 'Pie', zh: '饼图' },
  { key: 'none', en: 'Hide', zh: '隐藏' },
]

const BAR_MODES: { key: 'group' | 'stack'; en: string; zh: string }[] = [
  { key: 'group', en: 'Grouped', zh: '分组' },
  { key: 'stack', en: 'Stacked', zh: '堆叠' },
]

const NONE_VALUE = '__none__'

export function ChartFieldSelector({
  result,
  spec,
  effectiveChartType,
  effectiveX,
  effectiveY,
  effectiveSeries,
  onChange,
}: ChartFieldSelectorProps) {
  const { lang } = useT()
  const zh = lang === 'zh'

  const roles = useMemo(() => classifyColumns(result), [result])
  const allCols = result.columns

  const isPie = effectiveChartType === 'pie'
  const isHidden = effectiveChartType === 'none'

  // 三个角色的字段池都不能跟其它角色已选的字段冲突。
  // 当前选中的字段始终保留（即使它不在 classify 的候选里，也要让用户看见自己选了什么）。
  const dimensionOptions = useMemo(() => {
    const set = new Set(roles.dimensions)
    effectiveY.forEach((y) => set.delete(y))
    if (effectiveSeries) set.delete(effectiveSeries)
    if (effectiveX) set.add(effectiveX)
    return allCols.filter((c) => set.has(c))
  }, [roles.dimensions, allCols, effectiveX, effectiveY, effectiveSeries])

  const metricOptions = useMemo(() => {
    const set = new Set(roles.metrics)
    if (effectiveX) set.delete(effectiveX)
    if (effectiveSeries) set.delete(effectiveSeries)
    effectiveY.forEach((y) => set.add(y))
    return allCols.filter((c) => set.has(c))
  }, [roles.metrics, allCols, effectiveX, effectiveY, effectiveSeries])

  const legendOptions = useMemo(() => {
    const set = new Set(roles.legends)
    if (effectiveX) set.delete(effectiveX)
    effectiveY.forEach((y) => set.delete(y))
    if (effectiveSeries) set.add(effectiveSeries)
    return allCols.filter((c) => set.has(c))
  }, [roles.legends, allCols, effectiveX, effectiveY, effectiveSeries])

  // series 数 ≥ 2 时显示堆叠/分组切换（多指标或多 legend 都算）
  const seriesCount = effectiveSeries ? Infinity : effectiveY.length
  const showStackToggle = effectiveChartType === 'bar' && seriesCount >= 2

  function handleChartType(t: ChartType) {
    const patch: Partial<ChartSpec> = { chart_type: t, user_edited: true }
    // 饼图：清掉 series + 裁剪 y 到 1 个，避免 chip active 状态与实际渲染不一致
    if (t === 'pie') {
      patch.series = undefined
      if (effectiveY.length > 1) {
        patch.y = [{ field: effectiveY[0], label: formatColumnName(effectiveY[0]) }]
      }
    }
    onChange(patch)
  }

  function handleX(field: string) {
    const patch: Partial<ChartSpec> = {
      x: { field, label: formatColumnName(field) },
      user_edited: true,
    }
    // 若新选的 x 撞到 series → 清 series
    if (field === effectiveSeries) patch.series = undefined
    // 若新选的 x 撞到某个 metric → 从 y 中剔除（保底至少 1 个）
    if (effectiveY.includes(field)) {
      const next = effectiveY.filter((f) => f !== field)
      patch.y = next.length > 0
        ? next.map((f) => ({ field: f, label: formatColumnName(f) }))
        : undefined
    }
    onChange(patch)
  }

  function handleToggleMetric(field: string) {
    const current = new Set(effectiveY)
    if (current.has(field)) {
      if (current.size <= 1) return // 至少保留一个
      current.delete(field)
    } else {
      // 饼图只允许一个指标
      if (isPie) current.clear()
      current.add(field)
    }
    onChange({
      y: Array.from(current).map((f) => ({ field: f, label: formatColumnName(f) })),
      user_edited: true,
    })
  }

  function handleSeries(field: string) {
    if (field === NONE_VALUE) {
      // 取消 legend 时把 bar_mode 也复位（stack 在无 legend 时通常没意义）
      onChange({ series: undefined, bar_mode: undefined, user_edited: true })
      return
    }
    const patch: Partial<ChartSpec> = {
      series: { field, label: formatColumnName(field) },
      user_edited: true,
    }
    // 若新选的 legend 撞到 metric → 剔除
    if (effectiveY.includes(field)) {
      const next = effectiveY.filter((f) => f !== field)
      patch.y = next.length > 0
        ? next.map((f) => ({ field: f, label: formatColumnName(f) }))
        : undefined
    }
    onChange(patch)
  }

  function handleBarMode(m: 'group' | 'stack') {
    onChange({ bar_mode: m, user_edited: true })
  }

  return (
    <div className="chart-field-selector">
      {/* 图表类型 */}
      <div className="cfs-group">
        {CHART_TYPES.map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={`cfs-chip ${effectiveChartType === opt.key ? 'active' : ''}`}
            onClick={() => handleChartType(opt.key)}
          >
            {zh ? opt.zh : opt.en}
          </button>
        ))}
      </div>

      {!isHidden && (
        <>
          {/* 维度 */}
          <div className="cfs-group">
            <label className="cfs-label">{zh ? '维度' : 'Dimension'}</label>
            <select
              className="cfs-select"
              value={effectiveX ?? ''}
              onChange={(e) => handleX(e.target.value)}
              disabled={dimensionOptions.length === 0}
            >
              {dimensionOptions.map((c) => (
                <option key={c} value={c}>
                  {formatColumnName(c)}
                </option>
              ))}
            </select>
          </div>

          {/* 指标（多选 chip） */}
          <div className="cfs-group">
            <label className="cfs-label">{zh ? '指标' : 'Metric'}</label>
            <div className="cfs-chips">
              {metricOptions.map((c) => {
                const selected = effectiveY.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    className={`cfs-chip ${selected ? 'active' : ''}`}
                    onClick={() => handleToggleMetric(c)}
                    title={isPie && selected ? (zh ? '饼图仅支持一个指标' : 'Pie chart supports only one metric') : ''}
                  >
                    {formatColumnName(c)}
                  </button>
                )
              })}
              {metricOptions.length === 0 && (
                <span className="cfs-hint">{zh ? '无可用数值列' : 'no numeric column'}</span>
              )}
            </div>
          </div>

          {/* 图例 */}
          {!isPie && (
            <div className="cfs-group">
              <label className="cfs-label">{zh ? '图例' : 'Legend'}</label>
              <select
                className="cfs-select"
                value={effectiveSeries ?? NONE_VALUE}
                onChange={(e) => handleSeries(e.target.value)}
                disabled={legendOptions.length === 0}
              >
                <option value={NONE_VALUE}>{zh ? '（无）' : '(none)'}</option>
                {legendOptions.map((c) => (
                  <option key={c} value={c}>
                    {formatColumnName(c)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 柱图 分组/堆叠：≥2 系列时可见 */}
          {showStackToggle && (
            <div className="cfs-group">
              {BAR_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`cfs-chip ${(spec.bar_mode ?? 'group') === m.key ? 'active' : ''}`}
                  onClick={() => handleBarMode(m.key)}
                >
                  {zh ? m.zh : m.en}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
