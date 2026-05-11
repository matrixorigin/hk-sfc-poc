import { useMemo, useState } from 'react'
import type { ChartSpec, ChartType, SQLResult } from '../types'
import { useT, tpl } from '../i18n'
import {
  chartTypeAvailability,
  classifyColumns,
  detectOHLC,
  formatColumnName,
  type AvailReason,
} from '../utils/chartFieldRoles'

interface ChartFieldSelectorProps {
  result: SQLResult
  spec: ChartSpec
  onChange: (patch: Partial<ChartSpec>) => void
}

const CHART_TYPES: { key: ChartType; tKey: string }[] = [
  { key: 'line', tKey: 'chartTypeLine' },
  { key: 'bar', tKey: 'chartTypeBar' },
  { key: 'hbar', tKey: 'chartTypeHbar' },
  { key: 'pie', tKey: 'chartTypePie' },
  { key: 'combo', tKey: 'chartTypeCombo' },
  { key: 'heatmap', tKey: 'chartTypeHeatmap' },
  { key: 'candlestick', tKey: 'chartTypeCandlestick' },
  { key: 'none', tKey: 'chartTypeHide' },
]

const NONE_VALUE = '__none__'

function reasonToText(t: (k: any) => string, r: AvailReason): string {
  switch (r.kind) {
    case 'empty': return t('chartReasonEmpty')
    case 'need-metrics': return tpl(t('chartReasonNeedMetrics'), { n: r.n })
    case 'need-types': return tpl(t('chartReasonNeedTypes'), { n: r.n })
    case 'need-ohlc': return tpl(t('chartReasonNeedOhlc'), { missing: r.missing.join(' / ') })
    case 'need-time': return t('chartReasonNeedTime')
  }
}

export function ChartFieldSelector({ result, spec, onChange }: ChartFieldSelectorProps) {
  const { t } = useT()
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

  // 默认折叠；遇到需要绑定字段才能渲染的情况自动展开
  const [userExpanded, setUserExpanded] = useState(false)
  const forceExpand =
    isHeatmap || isCandle ||
    (!isAuto && !isHidden && (!xField || yFields.length === 0)) ||
    (chartType === 'combo' && yFields.length < 2)
  const expanded = userExpanded || forceExpand

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

  const seriesCount = seriesField ? Infinity : yFields.length
  const showStackToggle =
    (chartType === 'bar' || chartType === 'hbar' || chartType === 'combo') && seriesCount >= 2

  function handleChartType(t2: ChartType) {
    const patch: Partial<ChartSpec> = { chart_type: t2, user_edited: true }
    if (t2 === 'pie') {
      patch.series = undefined
      if (yFields.length > 1) {
        patch.y = [{ field: yFields[0], label: formatColumnName(yFields[0]) }]
      }
    }
    if (t2 === 'candlestick' && !spec.ohlc) {
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

  const OHLC_LABEL: Record<'open' | 'close' | 'high' | 'low', string> = {
    open: t('chartOpen'),
    close: t('chartClose'),
    high: t('chartHigh'),
    low: t('chartLow'),
  }

  // ── render ──

  return (
    <div className="chart-field-selector">

      {/* Row 1：图表类型 + 折叠开关 */}
      <div className="cfs-row">
        <span className="cfs-label">{t('chartType')}</span>
        {CHART_TYPES.map((opt) => {
          const isHide = opt.key === 'none'
          const avail = isHide ? { ok: true as const } : chartTypeAvailability(result, opt.key as any)
          const disabled = !avail.ok
          const active = chartType === opt.key
          const tip = disabled && !avail.ok ? reasonToText(t as any, (avail as any).reason) : ''
          return (
            <button
              key={opt.key}
              type="button"
              className={`cfs-chip ${active ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
              onClick={() => !disabled && handleChartType(opt.key)}
              title={tip}
              aria-disabled={disabled}
            >
              {t(opt.tKey as any)}
              {disabled && <span className="cfs-warn" aria-hidden>!</span>}
            </button>
          )
        })}

        {/* 折叠开关：非 hidden/auto/forceExpand 时显示 */}
        {!isHidden && !forceExpand && (
          <button
            type="button"
            className="cfs-toggle"
            onClick={() => setUserExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? t('chartHideConfig') : t('chartShowConfig')}
            <span className="cfs-toggle-arrow" aria-hidden>
              {expanded ? '▲' : '▼'}
            </span>
          </button>
        )}
      </div>

      {/* 折叠 / 展开 */}
      {isAuto && (
        <div className="cfs-hint" style={{ padding: '6px 4px' }}>
          {t('chartEmptyTypeNotSet')}
        </div>
      )}

      {expanded && isGeneric && (
        <>
          <div className="cfs-row">
            <span className="cfs-label">{t('chartDimension')}</span>
            <select
              className="cfs-select"
              value={xField ?? NONE_VALUE}
              onChange={(e) => handleX(e.target.value)}
            >
              <option value={NONE_VALUE}>{t('chartUnset')}</option>
              {dimensionOptions.map((c) => (
                <option key={c} value={c}>{formatColumnName(c)}</option>
              ))}
            </select>

            <span className="cfs-label" style={{ marginLeft: 12 }}>{t('chartMetric')}</span>
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
                        title={t('chartSubtypeToggleTitle')}
                      >
                        {sub === 'bar' ? '▮' : '∿'}
                      </span>
                    )}
                    <span
                      className={`axis ${axis === 'secondary' ? 'r' : ''}`}
                      onClick={() => handleToggleAxis(f)}
                      title={t('chartAxisToggleTitle')}
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
              <span className="cfs-label">{t('chartLegend')}</span>
              <select
                className="cfs-select"
                value={seriesField ?? NONE_VALUE}
                onChange={(e) => handleSeries(e.target.value)}
                disabled={legendOptions.length === 0}
              >
                <option value={NONE_VALUE}>{t('chartNone')}</option>
                {legendOptions.map((c) => (
                  <option key={c} value={c}>{formatColumnName(c)}</option>
                ))}
              </select>

              {showStackToggle && (
                <>
                  <span className="cfs-label" style={{ marginLeft: 12 }}>{t('chartMode')}</span>
                  <button
                    type="button"
                    className={`cfs-chip ${(spec.bar_mode ?? 'group') === 'group' ? 'active' : ''}`}
                    onClick={() => handleBarMode('group')}
                  >
                    {t('chartModeGroup')}
                  </button>
                  <button
                    type="button"
                    className={`cfs-chip ${spec.bar_mode === 'stack' ? 'active' : ''}`}
                    onClick={() => handleBarMode('stack')}
                  >
                    {t('chartModeStack')}
                  </button>
                </>
              )}
            </div>
          )}

          <div className="cfs-row">
            <span className="cfs-label">{t('chartSort')}</span>
            <select
              className="cfs-select"
              value={spec.sort?.field ?? NONE_VALUE}
              onChange={(e) => handleSortField(e.target.value)}
            >
              <option value={NONE_VALUE}>{t('chartDefault')}</option>
              {metricOptions.map((c) => (
                <option key={c} value={c}>
                  {tpl(t('chartSortBy'), { field: formatColumnName(c) })}
                </option>
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
            <span className="cfs-label" style={{ marginLeft: 12 }}>{t('chartTopN')}</span>
            <select
              className="cfs-select"
              value={spec.top_n ?? 0}
              onChange={(e) => handleTopN(e.target.value)}
              style={{ minWidth: 70 }}
            >
              <option value="0">{t('chartTopNAll')}</option>
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
                {t('chartShowMarkers')}
              </label>
            )}
            <label className="cfs-check" style={{ marginLeft: 12 }}>
              <input
                type="checkbox"
                checked={!!spec.show_data_labels}
                onChange={(e) => handleDataLabel(e.target.checked)}
              />
              <span className="box" />
              {t('chartShowLabels')}
            </label>
          </div>
        </>
      )}

      {expanded && isHeatmap && (
        <div className="cfs-row">
          <span className="cfs-label">{t('chartDimensionX')}</span>
          <select className="cfs-select" value={xField ?? NONE_VALUE} onChange={(e) => handleX(e.target.value)}>
            <option value={NONE_VALUE}>{t('chartUnset')}</option>
            {dimensionOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          <span className="cfs-label" style={{ marginLeft: 12 }}>{t('chartDimensionY')}</span>
          <select className="cfs-select" value={y2Field ?? NONE_VALUE} onChange={(e) => handleY2(e.target.value)}>
            <option value={NONE_VALUE}>{t('chartUnset')}</option>
            {y2Options.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          <span className="cfs-label" style={{ marginLeft: 12 }}>{t('chartMetric')}</span>
          <select
            className="cfs-select"
            value={yFields[0] ?? NONE_VALUE}
            onChange={(e) => {
              const f = e.target.value
              if (f === NONE_VALUE) onChange({ y: undefined, user_edited: true })
              else onChange({ y: [{ field: f, label: formatColumnName(f) }], user_edited: true })
            }}
          >
            <option value={NONE_VALUE}>{t('chartUnset')}</option>
            {metricOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>
        </div>
      )}

      {expanded && isCandle && (
        <div className="cfs-row" style={{ flexWrap: 'wrap' }}>
          <span className="cfs-label">{t('chartTime')}</span>
          <select className="cfs-select" value={xField ?? NONE_VALUE} onChange={(e) => handleX(e.target.value)}>
            <option value={NONE_VALUE}>{t('chartUnset')}</option>
            {dimensionOptions.map((c) => (
              <option key={c} value={c}>{formatColumnName(c)}</option>
            ))}
          </select>

          {(['open', 'close', 'high', 'low'] as const).map((role) => (
            <span key={role} className="cfs-group">
              <span className="cfs-label" style={{ marginLeft: 8 }}>{OHLC_LABEL[role]}</span>
              <select
                className="cfs-select"
                value={spec.ohlc?.[role] ?? NONE_VALUE}
                onChange={(e) => handleOHLC(role, e.target.value)}
              >
                <option value={NONE_VALUE}>{t('chartUnset')}</option>
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
