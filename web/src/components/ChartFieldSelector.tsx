import { useMemo, useState } from 'react'
import type { ChartSpec, ChartType, SQLResult } from '../types'
import { useT, tpl } from '../i18n'
import {
  chartTypeAvailability,
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
    case 'need-cols': return tpl(t('chartReasonNeedCols'), { n: r.n })
  }
}

export function ChartFieldSelector({ result, spec, onChange }: ChartFieldSelectorProps) {
  const { t } = useT()
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

  // 下拉选项规则：所有列都可选，仅排除已被其他角色占用的列（避免一列同时绑两个角色）。
  // 当前角色已绑的列要保留在自己的下拉里（让 select 能正确显示已选值）。
  const dimensionOptions = useMemo(() => {
    const used = new Set<string>()
    yFields.forEach((y) => used.add(y))
    if (seriesField) used.add(seriesField)
    if (y2Field) used.add(y2Field)
    if (xField) used.delete(xField)
    return allCols.filter((c) => !used.has(c))
  }, [allCols, xField, yFields, seriesField, y2Field])

  const metricOptions = useMemo(() => {
    const used = new Set<string>()
    if (xField) used.add(xField)
    if (seriesField) used.add(seriesField)
    if (y2Field) used.add(y2Field)
    yFields.forEach((y) => used.delete(y))
    return allCols.filter((c) => !used.has(c))
  }, [allCols, xField, yFields, seriesField, y2Field])

  const legendOptions = useMemo(() => {
    const used = new Set<string>()
    if (xField) used.add(xField)
    yFields.forEach((y) => used.add(y))
    if (y2Field) used.add(y2Field)
    if (seriesField) used.delete(seriesField)
    return allCols.filter((c) => !used.has(c))
  }, [allCols, xField, yFields, seriesField, y2Field])

  const y2Options = useMemo(() => {
    const used = new Set<string>()
    if (xField) used.add(xField)
    yFields.forEach((y) => used.add(y))
    if (seriesField) used.add(seriesField)
    if (y2Field) used.delete(y2Field)
    return allCols.filter((c) => !used.has(c))
  }, [allCols, xField, yFields, seriesField, y2Field])

  const seriesCount = seriesField ? Infinity : yFields.length
  const showStackToggle =
    (chartType === 'bar' || chartType === 'hbar' || chartType === 'combo') && seriesCount >= 2

  function handleChartType(t2: ChartType) {
    // 切类型只改 chart_type，不动 x/y/series/ohlc — spec 是用户意图的单一记录，
    // 视图层（resolveSpec）按当前类型决定怎么渲染。
    onChange({ chart_type: t2, user_edited: true })
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
    // pie 模式不再裁剪 — 用户可以绑多个，渲染层只取首项，切回 line 完整恢复
    if (yFields.includes(field)) {
      const next = yFields.filter((f) => f !== field)
      onChange({
        y: next.length > 0
          ? next.map((f) => ({ field: f, label: formatColumnName(f), axis: yAxisMap.get(f), sub_type: ySubTypeMap.get(f) }))
          : undefined,
        user_edited: true,
      })
    } else {
      const next = [...yFields, field]
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
              {yFields.map((f, idx) => {
                const axis = yAxisMap.get(f) ?? 'primary'
                const sub = ySubTypeMap.get(f) ?? 'bar'
                // 饼图渲染只取首项，非首项给灰底视觉提示（数据仍保留，切回 line 完整恢复）
                const dimmed = isPie && idx > 0
                return (
                  <span
                    key={f}
                    className={`cfs-mpill ${dimmed ? 'dimmed' : ''}`}
                    title={dimmed ? t('chartPieOnlyFirst') : undefined}
                  >
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
                    {!isPie && (
                      <span
                        className={`axis ${axis === 'secondary' ? 'r' : ''}`}
                        onClick={() => handleToggleAxis(f)}
                        title={t('chartAxisToggleTitle')}
                      >
                        {axis === 'secondary' ? 'R' : 'L'}
                      </span>
                    )}
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
