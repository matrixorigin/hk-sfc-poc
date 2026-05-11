import { useMemo } from 'react'
import type { ChartSpec, ChartType, SQLResult } from '../types'
import { useT } from '../i18n'
import {
  chartTypeAvailability,
  classifyColumns,
  detectOHLC,
  formatColumnName,
} from '../utils/chartFieldRoles'

interface ChartFieldSelectorProps {
  result: SQLResult
  spec: ChartSpec
  onChange: (patch: Partial<ChartSpec>) => void
}

const CHART_TYPES: { key: ChartType; en: string; zh: string }[] = [
  { key: 'line', en: 'Line', zh: '折线' },
  { key: 'bar', en: 'Bar', zh: '柱状' },
  { key: 'hbar', en: 'H-Bar', zh: '条形' },
  { key: 'pie', en: 'Pie', zh: '饼图' },
  { key: 'combo', en: 'Combo', zh: '组合' },
  { key: 'heatmap', en: 'Heatmap', zh: '热力' },
  { key: 'candlestick', en: 'Candle', zh: '蜡烛' },
  { key: 'none', en: 'Hide', zh: '隐藏' },
]

const NONE_VALUE = '__none__'

export function ChartFieldSelector({ result, spec, onChange }: ChartFieldSelectorProps) {
  const { lang } = useT()
  const zh = lang === 'zh'

  const roles = useMemo(() => classifyColumns(result), [result])
  const allCols = result.columns

  const chartType = spec.chart_type ?? 'auto'
  const xField = spec.x?.field
  const yFields = (spec.y ?? []).map((y) => y.field)
  const yAxisMap = new Map((spec.y ?? []).map((y) => [y.field, y.axis ?? 'primary']))
  const ySubTypeMap = new Map((spec.y ?? []).map((y) => [y.field, y.sub_type]))
  const seriesField = spec.series?.field
  const y2Field = spec.y2?.field

  const isPie = chartType === 'pie'
  const isHidden = chartType === 'none'
  const isAuto = chartType === 'auto'
  const isHeatmap = chartType === 'heatmap'
  const isCandle = chartType === 'candlestick'
  const isGeneric = !isHidden && !isHeatmap && !isCandle && !isAuto

  // 字段候选过滤（互斥）
  const dimensionOptions = useMemo(() => {
    const set = new Set(roles.dimensions)
    yFields.forEach((y) => set.delete(y))
    if (seriesField) set.delete(seriesField)
    if (y2Field) set.delete(y2Field)
    if (xField) set.add(xField)
    return allCols.filter((c) => set.has(c))
  }, [roles.dimensions, allCols, xField, yFields, seriesField, y2Field])

  const metricOptions = useMemo(() => {
    const set = new Set(roles.metrics)
    if (xField) set.delete(xField)
    if (seriesField) set.delete(seriesField)
    if (y2Field) set.delete(y2Field)
    yFields.forEach((y) => set.add(y))
    return allCols.filter((c) => set.has(c))
  }, [roles.metrics, allCols, xField, yFields, seriesField, y2Field])

  const legendOptions = useMemo(() => {
    const set = new Set(roles.legends)
    if (xField) set.delete(xField)
    yFields.forEach((y) => set.delete(y))
    if (seriesField) set.add(seriesField)
    return allCols.filter((c) => set.has(c))
  }, [roles.legends, allCols, xField, yFields, seriesField])

  const y2Options = useMemo(() => {
    const set = new Set(roles.dimensions)
    if (xField) set.delete(xField)
    yFields.forEach((y) => set.delete(y))
    if (y2Field) set.add(y2Field)
    return allCols.filter((c) => set.has(c))
  }, [roles.dimensions, allCols, xField, yFields, y2Field])

  // stack/group toggle 可见条件
  const seriesCount = seriesField ? Infinity : yFields.length
  const showStackToggle =
    (chartType === 'bar' || chartType === 'hbar' || chartType === 'combo') && seriesCount >= 2

  // ── handlers ──

  function handleChartType(t: ChartType) {
    const patch: Partial<ChartSpec> = { chart_type: t, user_edited: true }
    if (t === 'pie') {
      patch.series = undefined
      if (yFields.length > 1) {
        patch.y = [{ field: yFields[0], label: formatColumnName(yFields[0]) }]
      }
    }
    if (t === 'candlestick' && !spec.ohlc) {
      // 自动检测预填 OHLC 4 字段
      const det = detectOHLC(allCols)
      if (det.open && det.close && det.high && det.low) {
        patch.ohlc = { open: det.open, close: det.close, high: det.high, low: det.low }
      }
    }
    onChange(patch)
  }

  function handleX(field: string) {
    if (field === NONE_VALUE) {
      onChange({ x: undefined, user_edited: true })
      return
    }
    const patch: Partial<ChartSpec> = {
      x: { field, label: formatColumnName(field) },
      user_edited: true,
    }
    if (field === seriesField) patch.series = undefined
    if (field === y2Field) patch.y2 = undefined
    if (yFields.includes(field)) {
      const next = yFields.filter((f) => f !== field)
      patch.y = next.length > 0
        ? next.map((f) => ({ field: f, label: formatColumnName(f), axis: yAxisMap.get(f), sub_type: ySubTypeMap.get(f) }))
        : undefined
    }
    onChange(patch)
  }

  function handleToggleMetric(field: string) {
    if (yFields.includes(field)) {
      // 移除（饼图至少保留 1 个；其它无限制）
      if (isPie && yFields.length <= 1) return
      const next = yFields.filter((f) => f !== field)
      onChange({
        y: next.length > 0
          ? next.map((f) => ({ field: f, label: formatColumnName(f), axis: yAxisMap.get(f), sub_type: ySubTypeMap.get(f) }))
          : undefined,
        user_edited: true,
      })
    } else {
      let next = [...yFields, field]
      if (isPie) next = [field]
      onChange({
        y: next.map((f) => ({
          field: f,
          label: formatColumnName(f),
          axis: yAxisMap.get(f),
          sub_type: ySubTypeMap.get(f),
        })),
        user_edited: true,
      })
    }
  }

  function handleToggleAxis(field: string) {
    const current = yAxisMap.get(field) ?? 'primary'
    const next = current === 'primary' ? 'secondary' : 'primary'
    onChange({
      y: yFields.map((f) => ({
        field: f,
        label: formatColumnName(f),
        axis: f === field ? next : yAxisMap.get(f),
        sub_type: ySubTypeMap.get(f),
      })),
      user_edited: true,
    })
  }

  function handleToggleSubType(field: string) {
    const current = ySubTypeMap.get(field) ?? 'bar'
    const next = current === 'bar' ? 'line' : 'bar'
    onChange({
      y: yFields.map((f) => ({
        field: f,
        label: formatColumnName(f),
        axis: yAxisMap.get(f),
        sub_type: f === field ? next : ySubTypeMap.get(f),
      })),
      user_edited: true,
    })
  }

  function handleSeries(field: string) {
    if (field === NONE_VALUE) {
      onChange({ series: undefined, bar_mode: undefined, user_edited: true })
      return
    }
    const patch: Partial<ChartSpec> = {
      series: { field, label: formatColumnName(field) },
      user_edited: true,
    }
    if (yFields.includes(field)) {
      const next = yFields.filter((f) => f !== field)
      patch.y = next.length > 0
        ? next.map((f) => ({ field: f, label: formatColumnName(f), axis: yAxisMap.get(f), sub_type: ySubTypeMap.get(f) }))
        : undefined
    }
    onChange(patch)
  }

  function handleY2(field: string) {
    if (field === NONE_VALUE) {
      onChange({ y2: undefined, user_edited: true })
      return
    }
    onChange({ y2: { field, label: formatColumnName(field) }, user_edited: true })
  }

  function handleOHLC(role: 'open' | 'close' | 'high' | 'low', field: string) {
    const cur = spec.ohlc ?? { open: '', close: '', high: '', low: '' }
    onChange({
      ohlc: { ...cur, [role]: field === NONE_VALUE ? '' : field },
      user_edited: true,
    })
  }

  function handleBarMode(m: 'group' | 'stack') {
    onChange({ bar_mode: m, user_edited: true })
  }

  function handleSortField(field: string) {
    if (field === NONE_VALUE) {
      onChange({ sort: undefined, user_edited: true })
      return
    }
    const order = spec.sort?.order ?? 'desc'
    onChange({ sort: { field, order }, user_edited: true })
  }

  function handleSortOrder(order: 'asc' | 'desc') {
    if (!spec.sort?.field) return
    onChange({ sort: { ...spec.sort, order }, user_edited: true })
  }

  function handleTopN(v: string) {
    const n = v === '' ? 0 : parseInt(v, 10)
    onChange({ top_n: isNaN(n) ? 0 : n, user_edited: true })
  }

  function handleMarker(b: boolean) {
    onChange({ show_markers: b, user_edited: true })
  }
  function handleDataLabel(b: boolean) {
    onChange({ show_data_labels: b, user_edited: true })
  }

  // ── render ──

  return (
    <div className="chart-field-selector">

      {/* 图表类型 strip — 8 chip + 灰掉 */}
      <div className="cfs-row">
        <span className="cfs-label">{zh ? '图表' : 'Chart'}</span>
        {CHART_TYPES.map((opt) => {
          const isHide = opt.key === 'none'
          const avail = isHide ? { ok: true } : chartTypeAvailability(result, opt.key as any)
          const disabled = !avail.ok
          const active = chartType === opt.key
          return (
            <button
              key={opt.key}
              type="button"
              className={`cfs-chip ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
              onClick={() => !disabled && handleChartType(opt.key)}
              title={disabled ? (avail as any).reason : ''}
              disabled={disabled}
            >
              {zh ? opt.zh : opt.en}
              {disabled && <span className="cfs-warn" aria-hidden>!</span>}
            </button>
          )
        })}
      </div>

      {/* 字段控制区 — 按 chartType 分支 */}
      {isAuto && (
        <div className="cfs-hint" style={{ padding: '6px 4px' }}>
          {zh ? '请选择图表类型' : 'Please choose a chart type'}
        </div>
      )}

      {isGeneric && (
        <>
          <div className="cfs-row">
            <span className="cfs-label">{zh ? '维度' : 'Dimension'}</span>
            <select
              className="cfs-select"
              value={xField ?? NONE_VALUE}
              onChange={(e) => handleX(e.target.value)}
            >
              <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
              {dimensionOptions.map((c) => (
                <option key={c} value={c}>{formatColumnName(c)}</option>
              ))}
            </select>

            <span className="cfs-label" style={{ marginLeft: 12 }}>{zh ? '指标' : 'Metric'}</span>
            <div className="cfs-mpills">
              {yFields.map((f) => {
                const axis = yAxisMap.get(f) ?? 'primary'
                const sub = ySubTypeMap.get(f) ?? 'bar'
                return (
                  <span key={f} className="cfs-mpill">
                    <span className="lbl">{formatColumnName(f)}</span>
                    {chartType === 'combo' && (
                      <span
                        className="sub"
                        onClick={() => handleToggleSubType(f)}
                        title={zh ? '切换 柱/线' : 'Toggle bar/line'}
                      >
                        {sub === 'bar' ? '▮' : '∿'}
                      </span>
                    )}
                    <span
                      className={`axis ${axis === 'secondary' ? 'r' : ''}`}
                      onClick={() => handleToggleAxis(f)}
                      title={zh ? '主/副 Y 轴切换' : 'Toggle primary/secondary Y axis'}
                    >
                      {axis === 'secondary' ? 'R' : 'L'}
                    </span>
                    <span className="x" onClick={() => handleToggleMetric(f)}>×</span>
                  </span>
                )
              })}
              {metricOptions
                .filter((c) => !yFields.includes(c))
                .slice(0, 6)
                .map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="cfs-mpill dashed"
                    onClick={() => handleToggleMetric(c)}
                  >
                    + {formatColumnName(c)}
                  </button>
                ))}
            </div>
          </div>

          {!isPie && (
            <div className="cfs-row">
              <span className="cfs-label">{zh ? '图例' : 'Legend'}</span>
              <select
                className="cfs-select"
                value={seriesField ?? NONE_VALUE}
                onChange={(e) => handleSeries(e.target.value)}
                disabled={legendOptions.length === 0}
              >
                <option value={NONE_VALUE}>{zh ? '（无）' : '(none)'}</option>
                {legendOptions.map((c) => (
                  <option key={c} value={c}>{formatColumnName(c)}</option>
                ))}
              </select>

              {showStackToggle && (
                <>
                  <span className="cfs-label" style={{ marginLeft: 12 }}>{zh ? '模式' : 'Mode'}</span>
                  <button
                    type="button"
                    className={`cfs-chip ${(spec.bar_mode ?? 'group') === 'group' ? 'active' : ''}`}
                    onClick={() => handleBarMode('group')}
                  >
                    {zh ? '分组' : 'Group'}
                  </button>
                  <button
                    type="button"
                    className={`cfs-chip ${spec.bar_mode === 'stack' ? 'active' : ''}`}
                    onClick={() => handleBarMode('stack')}
                  >
                    {zh ? '堆叠' : 'Stack'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* 排序 / TopN / Markers */}
          <div className="cfs-row">
            <span className="cfs-label">{zh ? '排序' : 'Sort'}</span>
            <select
              className="cfs-select"
              value={spec.sort?.field ?? NONE_VALUE}
              onChange={(e) => handleSortField(e.target.value)}
            >
              <option value={NONE_VALUE}>{zh ? '（默认）' : '(default)'}</option>
              {metricOptions.map((c) => (
                <option key={c} value={c}>{zh ? '按 ' : 'By '}{formatColumnName(c)}</option>
              ))}
            </select>
            {spec.sort?.field && (
              <>
                <button
                  type="button"
                  className={`cfs-chip ${spec.sort?.order === 'desc' ? 'active' : ''}`}
                  onClick={() => handleSortOrder('desc')}
                >↓</button>
                <button
                  type="button"
                  className={`cfs-chip ${spec.sort?.order === 'asc' ? 'active' : ''}`}
                  onClick={() => handleSortOrder('asc')}
                >↑</button>
              </>
            )}
            <span className="cfs-label" style={{ marginLeft: 12 }}>Top N</span>
            <select
              className="cfs-select"
              value={spec.top_n ?? 0}
              onChange={(e) => handleTopN(e.target.value)}
              style={{ minWidth: 70 }}
            >
              <option value="0">{zh ? '全部' : 'All'}</option>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>

            {(chartType === 'line' || chartType === 'combo') && (
              <label className="cfs-check" style={{ marginLeft: 16 }}>
                <input
                  type="checkbox"
                  checked={!!spec.show_markers}
                  onChange={(e) => handleMarker(e.target.checked)}
                />
                <span className="box" />
                {zh ? '显示标记点' : 'Show markers'}
              </label>
            )}
            <label className="cfs-check" style={{ marginLeft: 12 }}>
              <input
                type="checkbox"
                checked={!!spec.show_data_labels}
                onChange={(e) => handleDataLabel(e.target.checked)}
              />
              <span className="box" />
              {zh ? '显示数据标签' : 'Show labels'}
            </label>
          </div>
        </>
      )}

      {isHeatmap && (
        <div className="cfs-row">
          <span className="cfs-label">{zh ? '维度 X' : 'Axis X'}</span>
          <select className="cfs-select" value={xField ?? NONE_VALUE} onChange={(e) => handleX(e.target.value)}>
            <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
            {dimensionOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          <span className="cfs-label" style={{ marginLeft: 12 }}>{zh ? '维度 Y' : 'Axis Y'}</span>
          <select className="cfs-select" value={y2Field ?? NONE_VALUE} onChange={(e) => handleY2(e.target.value)}>
            <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
            {y2Options.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          <span className="cfs-label" style={{ marginLeft: 12 }}>{zh ? '指标' : 'Metric'}</span>
          <select
            className="cfs-select"
            value={yFields[0] ?? NONE_VALUE}
            onChange={(e) => {
              const f = e.target.value
              if (f === NONE_VALUE) onChange({ y: undefined, user_edited: true })
              else onChange({ y: [{ field: f, label: formatColumnName(f) }], user_edited: true })
            }}
          >
            <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
            {metricOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>
        </div>
      )}

      {isCandle && (
        <div className="cfs-row" style={{ flexWrap: 'wrap' }}>
          <span className="cfs-label">{zh ? '时间' : 'Time'}</span>
          <select className="cfs-select" value={xField ?? NONE_VALUE} onChange={(e) => handleX(e.target.value)}>
            <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
            {dimensionOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          {(['open', 'close', 'high', 'low'] as const).map((role) => (
            <span key={role} className="cfs-group">
              <span className="cfs-label" style={{ marginLeft: 8 }}>
                {zh ? { open: '开盘', close: '收盘', high: '最高', low: '最低' }[role] : role.toUpperCase()}
              </span>
              <select
                className="cfs-select"
                value={spec.ohlc?.[role] ?? NONE_VALUE}
                onChange={(e) => handleOHLC(role, e.target.value)}
              >
                <option value={NONE_VALUE}>{zh ? '— 未选 —' : '— unset —'}</option>
                {metricOptions.map((c) => (
                  <option key={c} value={c}>{formatColumnName(c)}</option>
                ))}
              </select>
            </span>
          ))}
        </div>
      )}

    </div>
  )
}
