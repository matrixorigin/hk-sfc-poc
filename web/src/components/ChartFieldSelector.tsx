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

  // 维度选项：dimensions ∪ 当前选中（避免数据不兼容时显示空白）
  const dimensionOptions = useMemo(() => {
    const set = new Set(roles.dimensions)
    if (effectiveX) set.add(effectiveX)
    return allCols.filter((c) => set.has(c))
  }, [roles.dimensions, allCols, effectiveX])

  const metricOptions = useMemo(() => {
    const set = new Set(roles.metrics)
    effectiveY.forEach((y) => set.add(y))
    return allCols.filter((c) => set.has(c))
  }, [roles.metrics, allCols, effectiveY])

  const legendOptions = useMemo(() => {
    const set = new Set(roles.legends)
    if (effectiveSeries) set.add(effectiveSeries)
    // 排除当前 x 维度
    if (effectiveX) set.delete(effectiveX)
    return allCols.filter((c) => set.has(c))
  }, [roles.legends, allCols, effectiveX, effectiveSeries])

  function handleChartType(t: ChartType) {
    const patch: Partial<ChartSpec> = { chart_type: t, user_edited: true }
    // 切饼图时清掉 series（饼图不支持图例分组）
    if (t === 'pie') patch.series = undefined
    onChange(patch)
  }

  function handleX(field: string) {
    onChange({
      x: { field, label: formatColumnName(field) },
      user_edited: true,
      // 若新选的 x 等于现有 series，清空 series
      ...(field === effectiveSeries ? { series: undefined } : {}),
    })
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
      onChange({ series: undefined, user_edited: true })
    } else {
      onChange({
        series: { field, label: formatColumnName(field) },
        user_edited: true,
      })
    }
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

          {/* 柱图 分组/堆叠 */}
          {effectiveChartType === 'bar' && effectiveSeries && (
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
