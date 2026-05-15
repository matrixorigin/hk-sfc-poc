import ReactECharts from 'echarts-for-react'
import type { ChartSpec, ChartType, SQLResult } from '../types'
import { useT, tpl } from '../i18n'
import {
  formatColumnName,
  formatDateValue,
  isDateLike,
  isNumeric,
} from '../utils/chartFieldRoles'

interface ChartProps {
  result: SQLResult
  spec?: ChartSpec
}

// canChartResult: 是否值得显示整个 chart-section（含字段选择器）。
// 只看数据形状：≥2 列。具体能画哪个类型由 chartTypeAvailability 决定。
export function canChartResult(result: SQLResult): boolean {
  if (!result || result.rows.length === 0) return false
  return result.columns.length >= 2
}

// ── 解析后的 spec ──

export type ResolvedChartType = ChartType
export type AxisSide = 'primary' | 'secondary'

export interface ResolvedYItem {
  field: string
  axis: AxisSide
  subType?: 'bar' | 'line'
}

// 结构化 reason key，便于 i18n
export type MissingField = 'dim' | 'metric' | '2-metrics' | 'dim-x' | 'dim-y' | 'ohlc' | 'time'

export type ResolveReason =
  | { kind: 'type-not-set' }
  | { kind: 'missing-field'; what: MissingField }
  | { kind: 'data-mismatch'; detail: string }

export interface ResolvedSpec {
  chartType: ResolvedChartType
  xField?: string
  yItems: ResolvedYItem[]
  seriesField?: string
  y2Field?: string
  ohlc?: { open: string; close: string; high: string; low: string }
  barMode: 'group' | 'stack'
  showMarkers: boolean
  showDataLabels: boolean
  sort?: { field?: string; order?: 'asc' | 'desc' | 'none' }
  topN?: number
  reason?: ResolveReason
}

export function resolveSpec(result: SQLResult, spec?: ChartSpec): ResolvedSpec {
  const cols = result.columns
  const has = (f?: string) => !!f && cols.includes(f)

  const chartType: ResolvedChartType = spec?.chart_type ?? 'auto'
  const xField = has(spec?.x?.field) ? spec!.x!.field : undefined

  let seriesField: string | undefined
  if (has(spec?.series?.field)) seriesField = spec!.series!.field
  if (seriesField === xField) seriesField = undefined

  let yItems: ResolvedYItem[] = (spec?.y ?? [])
    .filter((y) => has(y.field) && y.field !== xField && y.field !== seriesField)
    .map((y) => ({
      field: y.field,
      axis: y.axis === 'secondary' ? 'secondary' : 'primary',
      subType: y.sub_type,
    }))

  if (chartType === 'pie' && yItems.length > 1) yItems = [yItems[0]]

  const y2Field =
    has(spec?.y2?.field) && spec!.y2!.field !== xField ? spec!.y2!.field : undefined

  let ohlc: ResolvedSpec['ohlc']
  if (spec?.ohlc) {
    const { open, close, high, low } = spec.ohlc
    if (has(open) && has(close) && has(high) && has(low)) {
      ohlc = { open, close, high, low }
    }
  }

  const seriesCount = seriesField ? Infinity : yItems.length
  const barMode = spec?.bar_mode === 'stack' && seriesCount >= 2 ? 'stack' : 'group'

  let reason: ResolveReason | undefined

  if (chartType === 'auto') {
    reason = { kind: 'type-not-set' }
  } else if (chartType === 'none') {
    // 用户主动隐藏 — 上层直接 null
  } else if (chartType === 'bar' || chartType === 'hbar' || chartType === 'line') {
    if (!xField) reason = { kind: 'missing-field', what: 'dim' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: 'metric' }
  } else if (chartType === 'pie') {
    if (!xField) reason = { kind: 'missing-field', what: 'dim' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: 'metric' }
  } else if (chartType === 'combo') {
    if (!xField) reason = { kind: 'missing-field', what: 'dim' }
    else if (yItems.length < 2) reason = { kind: 'missing-field', what: '2-metrics' }
  } else if (chartType === 'heatmap') {
    if (!xField) reason = { kind: 'missing-field', what: 'dim-x' }
    else if (!y2Field) reason = { kind: 'missing-field', what: 'dim-y' }
    else if (yItems.length === 0) reason = { kind: 'missing-field', what: 'metric' }
  } else if (chartType === 'candlestick') {
    if (!xField) reason = { kind: 'missing-field', what: 'time' }
    else if (!ohlc) reason = { kind: 'missing-field', what: 'ohlc' }
  }

  return {
    chartType,
    xField,
    yItems,
    seriesField,
    y2Field,
    ohlc,
    barMode,
    showMarkers: !!spec?.show_markers,
    showDataLabels: !!spec?.show_data_labels,
    sort: spec?.sort,
    topN: spec?.top_n,
    reason,
  }
}

// ── 排序 / TopN 预处理 ──
function applySortAndTopN(result: SQLResult, resolved: ResolvedSpec): SQLResult {
  let rows = result.rows
  const { sort, topN } = resolved

  if (sort?.field && sort.order !== 'none') {
    const idx = result.columns.indexOf(sort.field)
    if (idx >= 0) {
      const dir = sort.order === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        const va = a[idx]
        const vb = b[idx]
        if (isNumeric(va) && isNumeric(vb)) return (Number(va) - Number(vb)) * dir
        return String(va ?? '').localeCompare(String(vb ?? '')) * dir
      })
    }
  }
  if (topN && topN > 0 && rows.length > topN) rows = rows.slice(0, topN)

  return { ...result, rows }
}

// ── 配色 ──
const COLORS = [
  '#1a73e8',
  '#e8710a',
  '#0d9488',
  '#7c3aed',
  '#dc2626',
  '#16a34a',
  '#0891b2',
  '#ca8a04',
  '#db2777',
  '#65a30d',
]

const LEGEND_MAX = 30

// ── series 构建 helpers ──

interface SeriesData {
  name: string
  data: (number | null)[]
}

interface BuiltSeries {
  xData: string[]
  series: SeriesData[]
  truncated: boolean
}

function buildSeriesWithLegend(
  result: SQLResult,
  xField: string,
  yField: string,
  seriesField: string,
  formatX: (v: string) => string
): BuiltSeries {
  const xIdx = result.columns.indexOf(xField)
  const yIdx = result.columns.indexOf(yField)
  const sIdx = result.columns.indexOf(seriesField)

  const xOrder: string[] = []
  const xSeen = new Set<string>()
  for (const row of result.rows) {
    const xv = String(row[xIdx] ?? '')
    if (!xSeen.has(xv)) {
      xSeen.add(xv)
      xOrder.push(xv)
    }
  }

  const seriesOrder: string[] = []
  const seriesSeen = new Set<string>()
  for (const row of result.rows) {
    const sv = String(row[sIdx] ?? '')
    if (!seriesSeen.has(sv)) {
      seriesSeen.add(sv)
      seriesOrder.push(sv)
    }
  }

  const truncated = seriesOrder.length > LEGEND_MAX
  const visibleSeries = truncated ? seriesOrder.slice(0, LEGEND_MAX) : seriesOrder

  const valueMap = new Map<string, Map<string, number>>()
  for (const sv of visibleSeries) valueMap.set(sv, new Map())
  for (const row of result.rows) {
    const sv = String(row[sIdx] ?? '')
    if (!valueMap.has(sv)) continue
    const xv = String(row[xIdx] ?? '')
    const yv = row[yIdx]
    if (isNumeric(yv)) valueMap.get(sv)!.set(xv, Number(yv))
  }

  const series: SeriesData[] = visibleSeries.map((sv) => ({
    name: sv,
    data: xOrder.map((xv) => {
      const v = valueMap.get(sv)!.get(xv)
      return v === undefined ? null : v
    }),
  }))

  return { xData: xOrder.map(formatX), series, truncated }
}

function buildSeriesPlain(
  result: SQLResult,
  xField: string,
  yFields: string[],
  formatX: (v: string) => string
): BuiltSeries {
  const xIdx = result.columns.indexOf(xField)
  const xData = result.rows.map((r) => formatX(String(r[xIdx] ?? '')))

  const series: SeriesData[] = yFields.map((yField) => {
    const yIdx = result.columns.indexOf(yField)
    return {
      name: formatColumnName(yField),
      data: result.rows.map((r) => (isNumeric(r[yIdx]) ? Number(r[yIdx]) : null)),
    }
  })
  return { xData, series, truncated: false }
}

// ── Empty state ──
function EmptyChartState({ reason }: { reason: ResolveReason }) {
  const { t } = useT()
  let msg = ''
  let hint = ''
  if (reason.kind === 'type-not-set') {
    msg = t('chartEmptyTypeNotSet')
    hint = t('chartEmptyTypeNotSetHint')
  } else if (reason.kind === 'missing-field') {
    const fieldKey: Record<MissingField, string> = {
      'dim': t('chartMissingDim'),
      'metric': t('chartMissingMetric'),
      '2-metrics': t('chartMissing2Metrics'),
      'dim-x': t('chartMissingDimX'),
      'dim-y': t('chartMissingDimY'),
      'ohlc': t('chartMissingOhlc'),
      'time': t('chartMissingTime'),
    }
    msg = tpl(t('chartEmptyMissing'), { what: fieldKey[reason.what] })
    hint = t('chartEmptyMissingHint')
  } else if (reason.kind === 'data-mismatch') {
    msg = t('chartEmptyDataMismatch')
    hint = reason.detail
  }
  return (
    <div className="chart-wrapper chart-empty">
      <div className="chart-empty-msg">{msg}</div>
      <div className="chart-empty-hint">{hint}</div>
    </div>
  )
}

// ── DataZoom helpers ──
// 当 X 类目数过多时，默认窗口大致只展示 ~TARGET_VISIBLE 根，让初始视图可读；
// 用户可拖动滑块查看其他区间。
const ZOOM_TARGET_VISIBLE = 200
function defaultZoomStart(count: number): number {
  if (count <= ZOOM_TARGET_VISIBLE) return 0
  return Math.max(0, 100 - (ZOOM_TARGET_VISIBLE / count) * 100)
}

// ── X 轴 label 旋转 helpers ──
function labelRotate(count: number, isDate: boolean, maxLen: number): number {
  if (isDate) return count > 30 ? 45 : 0
  if (maxLen <= 4 && count <= 12) return 0
  if (maxLen <= 8 && count <= 10) return 30
  return 45
}

function labelBottom(count: number, isDate: boolean, maxLen: number): number {
  const r = labelRotate(count, isDate, maxLen)
  if (r === 0) return 36
  if (r === 30) return 56
  const truncated = Math.min(maxLen, 13)
  return Math.min(120, 36 + truncated * 6)
}

function buildYAxis(side: 'left' | 'right') {
  return {
    type: 'value' as const,
    position: side,
    splitLine:
      side === 'left'
        ? { lineStyle: { color: '#f3f4f6', type: 'dashed' as const } }
        : { show: false },
    axisLabel: { fontSize: 11, color: '#9ca3af' },
    axisLine: { show: false },
    axisTick: { show: false },
  }
}

function dataLabel(show: boolean, position: 'top' | 'right' | 'inside' = 'top') {
  if (!show) return { show: false }
  return {
    show: true,
    fontSize: 10,
    color: '#374151',
    position,
    distance: 12,
    overflow: 'truncate' as const,
    width: 120,
    formatter: (p: any) => {
      const v = typeof p.value === 'number' ? p.value : (Array.isArray(p.value) ? p.value[1] : p.value)
      const s = String(v ?? '')
      return s.length > 14 ? s.slice(0, 12) + '…' : s
    },
  }
}

const chartWrapperStyle: React.CSSProperties = {
  marginTop: 12,
  padding: '12px 12px 4px',
  background: '#fff',
  borderRadius: 8,
  border: '1px solid #f0f0f0',
}

function TruncationHint() {
  return (
    <div style={{ fontSize: 11, color: '#9ca3af', padding: '0 4px 4px' }}>
      图例项过多，已截断为前 {LEGEND_MAX} 个
    </div>
  )
}

// ── LineChart ──
function LineChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, yItems, seriesField, showMarkers, showDataLabels } = resolved
  if (!xField || yItems.length === 0) return null

  const yFields = yItems.map((y) => y.field)
  const built = seriesField
    ? buildSeriesWithLegend(result, xField, yFields[0], seriesField, formatDateValue)
    : buildSeriesPlain(result, xField, yFields, formatDateValue)
  if (built.series.length === 0) return null

  const xIsDate = isDateLike(built.xData)
  const maxLabelLen = built.xData.reduce((m, v) => Math.max(m, v.length), 0)

  // 双轴：根据 yItems[].axis 决定，无 series 模式下生效
  const hasSecondary = !seriesField && yItems.some((y) => y.axis === 'secondary')
  const secondaryFieldNames = new Set(
    yItems.filter((y) => y.axis === 'secondary').map((y) => formatColumnName(y.field))
  )

  const seriesOpt = built.series.map((s, idx) => ({
    name: s.name,
    type: 'line' as const,
    data: s.data,
    smooth: !showMarkers,
    symbol: showMarkers ? 'circle' : 'none',
    symbolSize: 6,
    showSymbol: showMarkers,
    lineStyle: { width: 2 },
    itemStyle: { color: COLORS[idx % COLORS.length] },
    yAxisIndex: hasSecondary && secondaryFieldNames.has(s.name) ? 1 : 0,
    label: dataLabel(showDataLabels),
  }))

  const needSlider = built.xData.length > 60

  const option: any = {
    color: COLORS,
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: '#e5e7eb',
      textStyle: { color: '#374151', fontSize: 12 },
      axisPointer: { type: 'cross', crossStyle: { color: '#9ca3af' } },
    },
    legend: {
      data: seriesOpt.map((s) => s.name),
      top: 4,
      textStyle: { fontSize: 12, color: '#6b7280' },
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 3,
      type: 'scroll',
    },
    grid: {
      left: 60,
      right: hasSecondary ? 60 : 20,
      top: 36,
      bottom: needSlider ? 90 : labelBottom(built.xData.length, xIsDate, maxLabelLen),
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      data: built.xData,
      boundaryGap: false,
      axisLabel: {
        fontSize: 11,
        color: '#9ca3af',
        rotate: labelRotate(built.xData.length, xIsDate, maxLabelLen),
        interval: xIsDate
          ? Math.max(0, Math.floor(built.xData.length / 12) - 1)
          : 'auto',
        formatter: (v: string) => {
          if (xIsDate) {
            const m = v.match(/^\d{4}-(\d{2}-\d{2})/)
            return m ? m[1] : v
          }
          return v.length > 12 ? v.slice(0, 12) + '…' : v
        },
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
    },
    yAxis: hasSecondary ? [buildYAxis('left'), buildYAxis('right')] : buildYAxis('left'),
    series: seriesOpt,
    ...(needSlider
      ? {
          dataZoom: [
            {
              type: 'slider',
              bottom: 8,
              height: 24,
              borderColor: '#e5e7eb',
              fillerColor: 'rgba(26,115,232,0.08)',
              handleStyle: { color: '#1a73e8' },
              textStyle: { fontSize: 10, color: '#9ca3af' },
              start: defaultZoomStart(built.xData.length),
              end: 100,
            },
            { type: 'inside', start: defaultZoomStart(built.xData.length), end: 100 },
          ],
        }
      : {}),
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      {built.truncated && <TruncationHint />}
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: needSlider ? 340 : 300 }} />
    </div>
  )
}

// ── BarChart（含 hbar 模式）──
function BarChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, yItems, seriesField, barMode, chartType, showDataLabels } = resolved
  if (!xField || yItems.length === 0) return null

  const isHorizontal = chartType === 'hbar'
  const yFields = yItems.map((y) => y.field)
  const built = seriesField
    ? buildSeriesWithLegend(result, xField, yFields[0], seriesField, (v) => v)
    : buildSeriesPlain(result, xField, yFields, (v) => v)
  if (built.series.length === 0) return null

  // 双轴：stack 强制单轴；series 模式（legend）单轴
  const hasSecondary =
    !seriesField && barMode !== 'stack' && yItems.some((y) => y.axis === 'secondary')
  const secondaryFieldNames = new Set(
    yItems.filter((y) => y.axis === 'secondary').map((y) => formatColumnName(y.field))
  )

  const stackKey = barMode === 'stack' ? 'total' : undefined
  const seriesOpt = built.series.map((s, idx) => ({
    name: s.name,
    type: 'bar' as const,
    data: s.data,
    itemStyle: { color: COLORS[idx % COLORS.length] },
    ...(stackKey ? { stack: stackKey } : {}),
    yAxisIndex: !isHorizontal && hasSecondary && secondaryFieldNames.has(s.name) ? 1 : 0,
    xAxisIndex: isHorizontal && hasSecondary && secondaryFieldNames.has(s.name) ? 1 : 0,
    label: dataLabel(showDataLabels, isHorizontal ? 'right' : 'top'),
  }))

  const xIsDate = isDateLike(built.xData)
  const maxLabelLen = built.xData.reduce((m, v) => Math.max(m, v.length), 0)

  // 垂直柱状图在类目过多时启用滑块；hbar 用画布纵向滚动，不走 dataZoom。
  const needSlider = !isHorizontal && built.xData.length > 60

  // hbar：x 是 value，y 是 category
  const catAxis = {
    type: 'category' as const,
    data: built.xData,
    axisLabel: {
      fontSize: 11,
      color: '#9ca3af',
      rotate: isHorizontal ? 0 : labelRotate(built.xData.length, xIsDate, maxLabelLen),
      interval: isHorizontal ? 0 : 'auto',
      formatter: (v: string) => (v.length > 14 ? v.slice(0, 14) + '…' : v),
    },
    axisLine: { lineStyle: { color: '#e5e7eb' } },
    axisTick: { show: false },
  }
  const valAxes = hasSecondary ? [buildYAxis('left'), buildYAxis('right')] : buildYAxis('left')

  const option: any = {
    color: COLORS,
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(255,255,255,0.96)',
      borderColor: '#e5e7eb',
      textStyle: { color: '#374151', fontSize: 12 },
    },
    legend: {
      data: seriesOpt.map((s) => s.name),
      top: 4,
      textStyle: { fontSize: 12, color: '#6b7280' },
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 3,
      type: 'scroll',
    },
    grid: {
      left: isHorizontal ? 120 : 60,
      right: !isHorizontal && hasSecondary ? 60 : 20,
      top: 36,
      bottom: needSlider ? 90 : (isHorizontal ? 36 : labelBottom(built.xData.length, xIsDate, maxLabelLen)),
      containLabel: false,
    },
    xAxis: isHorizontal ? valAxes : catAxis,
    yAxis: isHorizontal ? catAxis : valAxes,
    series: seriesOpt,
    ...(needSlider
      ? {
          dataZoom: [
            {
              type: 'slider',
              bottom: 8,
              height: 24,
              borderColor: '#e5e7eb',
              fillerColor: 'rgba(26,115,232,0.08)',
              handleStyle: { color: '#1a73e8' },
              textStyle: { fontSize: 10, color: '#9ca3af' },
              start: defaultZoomStart(built.xData.length),
              end: 100,
            },
            { type: 'inside', start: defaultZoomStart(built.xData.length), end: 100 },
          ],
        }
      : {}),
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      {built.truncated && <TruncationHint />}
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{
          height: isHorizontal ? Math.max(300, built.xData.length * 22) : (needSlider ? 340 : 300),
        }}
      />
    </div>
  )
}

// ── PieChart ──
function PieChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, yItems, showDataLabels } = resolved
  if (!xField || yItems.length === 0) return null

  const nameIdx = result.columns.indexOf(xField)
  const valueIdx = result.columns.indexOf(yItems[0].field)
  if (nameIdx < 0 || valueIdx < 0) return null

  const data = result.rows
    .filter((row) => isNumeric(row[valueIdx]))
    .slice(0, 20)
    .map((row) => ({
      name: String(row[nameIdx] ?? ''),
      value: Number(row[valueIdx]),
    }))
  if (data.length === 0) return null

  const option: any = {
    color: COLORS,
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: {
      orient: 'vertical',
      right: 10,
      top: 'center',
      textStyle: { fontSize: 12 },
      type: 'scroll',
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '70%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
        label: showDataLabels
          ? { show: true, fontSize: 11, formatter: '{b}\n{d}%' }
          : { show: false },
        emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
        data,
      },
    ],
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: 300 }} />
    </div>
  )
}

// ── ComboChart：每个 metric 按 subType 渲染 bar 或 line ──
function ComboChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, yItems, showDataLabels, showMarkers } = resolved
  if (!xField || yItems.length < 2) return null

  const built = buildSeriesPlain(
    result,
    xField,
    yItems.map((y) => y.field),
    (v) => v
  )
  if (built.series.length === 0) return null

  const xIsDate = isDateLike(built.xData)
  const maxLabelLen = built.xData.reduce((m, v) => Math.max(m, v.length), 0)
  const hasSecondary = yItems.some((y) => y.axis === 'secondary')

  const seriesOpt = built.series.map((s, idx) => {
    const yi = yItems[idx]
    const isLine = yi.subType === 'line'
    return {
      name: s.name,
      type: isLine ? ('line' as const) : ('bar' as const),
      data: s.data,
      ...(isLine
        ? {
            smooth: !showMarkers,
            symbol: showMarkers ? 'circle' : 'none',
            symbolSize: 6,
            showSymbol: showMarkers,
            lineStyle: { width: 2 },
          }
        : {}),
      itemStyle: { color: COLORS[idx % COLORS.length] },
      yAxisIndex: hasSecondary && yi.axis === 'secondary' ? 1 : 0,
      label: dataLabel(showDataLabels),
    }
  })

  const option: any = {
    color: COLORS,
    tooltip: { trigger: 'axis', backgroundColor: 'rgba(255,255,255,0.96)', borderColor: '#e5e7eb' },
    legend: { data: seriesOpt.map((s) => s.name), top: 4, type: 'scroll' },
    grid: {
      left: 60,
      right: hasSecondary ? 60 : 20,
      top: 36,
      bottom: labelBottom(built.xData.length, xIsDate, maxLabelLen),
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      data: built.xData,
      axisLabel: {
        fontSize: 11,
        color: '#9ca3af',
        rotate: labelRotate(built.xData.length, xIsDate, maxLabelLen),
        formatter: (v: string) => (v.length > 12 ? v.slice(0, 12) + '…' : v),
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
    },
    yAxis: hasSecondary ? [buildYAxis('left'), buildYAxis('right')] : buildYAxis('left'),
    series: seriesOpt,
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: 320 }} />
    </div>
  )
}

// ── HeatmapChart ──
function HeatmapChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, y2Field, yItems } = resolved
  if (!xField || !y2Field || yItems.length === 0) return null
  const metricField = yItems[0].field

  const xIdx = result.columns.indexOf(xField)
  const yIdx = result.columns.indexOf(y2Field)
  const vIdx = result.columns.indexOf(metricField)
  if (xIdx < 0 || yIdx < 0 || vIdx < 0) return null

  // 收集唯一值
  const xOrder: string[] = []
  const yOrder: string[] = []
  const xSeen = new Set<string>()
  const ySeen = new Set<string>()
  for (const row of result.rows) {
    const xv = String(row[xIdx] ?? '')
    const yv = String(row[yIdx] ?? '')
    if (!xSeen.has(xv)) {
      xSeen.add(xv)
      xOrder.push(xv)
    }
    if (!ySeen.has(yv)) {
      ySeen.add(yv)
      yOrder.push(yv)
    }
  }

  // 构建 [xIdx, yIdx, value] 三元组
  const data: [number, number, number][] = []
  let min = Infinity
  let max = -Infinity
  for (const row of result.rows) {
    const xv = String(row[xIdx] ?? '')
    const yv = String(row[yIdx] ?? '')
    const val = row[vIdx]
    if (!isNumeric(val)) continue
    const xi = xOrder.indexOf(xv)
    const yi = yOrder.indexOf(yv)
    const v = Number(val)
    data.push([xi, yi, v])
    if (v < min) min = v
    if (v > max) max = v
  }
  if (data.length === 0) return null

  const option: any = {
    tooltip: { position: 'top' },
    grid: { left: 100, right: 40, top: 60, bottom: 60, containLabel: false },
    xAxis: {
      type: 'category',
      data: xOrder.map((v) => (v.length > 12 ? v.slice(0, 12) + '…' : v)),
      axisLabel: { fontSize: 11, color: '#6b7280', rotate: xOrder.length > 10 ? 45 : 0 },
      splitArea: { show: true },
    },
    yAxis: {
      type: 'category',
      data: yOrder.map((v) => (v.length > 14 ? v.slice(0, 14) + '…' : v)),
      axisLabel: { fontSize: 11, color: '#6b7280' },
      splitArea: { show: true },
    },
    visualMap: {
      min,
      max,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
      inRange: { color: ['#eef2ff', '#1a73e8', '#1e3a8a'] },
      textStyle: { fontSize: 10, color: '#6b7280' },
    },
    series: [
      {
        name: formatColumnName(metricField),
        type: 'heatmap',
        data,
        label: { show: true, fontSize: 10, color: '#1f2937' },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.3)' } },
      },
    ],
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: Math.max(300, yOrder.length * 28 + 120) }} />
    </div>
  )
}

// ── CandlestickChart ──
function CandlestickChart({
  result,
  resolved,
}: {
  result: SQLResult
  resolved: ResolvedSpec
}) {
  const { xField, ohlc } = resolved
  if (!xField || !ohlc) return null

  const xIdx = result.columns.indexOf(xField)
  const oIdx = result.columns.indexOf(ohlc.open)
  const cIdx = result.columns.indexOf(ohlc.close)
  const hIdx = result.columns.indexOf(ohlc.high)
  const lIdx = result.columns.indexOf(ohlc.low)

  const xData: string[] = []
  const series: [number, number, number, number][] = []
  for (const row of result.rows) {
    const xv = formatDateValue(String(row[xIdx] ?? ''))
    const o = row[oIdx]
    const c = row[cIdx]
    const h = row[hIdx]
    const l = row[lIdx]
    if (!isNumeric(o) || !isNumeric(c) || !isNumeric(h) || !isNumeric(l)) continue
    xData.push(xv)
    series.push([Number(o), Number(c), Number(l), Number(h)])
  }
  if (series.length === 0) return null

  const option: any = {
    color: ['#dc2626', '#16a34a'], // 红涨绿跌（HK 习惯）
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    grid: { left: 60, right: 20, top: 36, bottom: xData.length > 30 ? 70 : 40, containLabel: false },
    xAxis: {
      type: 'category',
      data: xData,
      boundaryGap: true,
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, color: '#9ca3af', rotate: xData.length > 20 ? 45 : 0 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      scale: true,
      splitLine: { lineStyle: { color: '#f3f4f6', type: 'dashed' } },
      axisLabel: { fontSize: 11, color: '#9ca3af' },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    ...(xData.length > 30
      ? {
          dataZoom: [
            { type: 'inside', start: 50, end: 100 },
            { type: 'slider', bottom: 8, height: 24, borderColor: '#e5e7eb', start: 50, end: 100 },
          ],
        }
      : {}),
    series: [
      {
        type: 'candlestick',
        data: series,
        itemStyle: {
          color: '#dc2626',         // 涨色（HK）
          color0: '#16a34a',        // 跌色
          borderColor: '#dc2626',
          borderColor0: '#16a34a',
        },
      },
    ],
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: xData.length > 30 ? 360 : 300 }} />
    </div>
  )
}

// ── 路由 ──
export function Chart({ result, spec }: ChartProps) {
  const resolved = resolveSpec(result, spec)
  if (resolved.chartType === 'none') return null
  if (resolved.reason) return <EmptyChartState reason={resolved.reason} />

  const sortedResult = applySortAndTopN(result, resolved)

  switch (resolved.chartType) {
    case 'line':
      return <LineChart result={sortedResult} resolved={resolved} />
    case 'bar':
    case 'hbar':
      return <BarChart result={sortedResult} resolved={resolved} />
    case 'pie':
      return <PieChart result={sortedResult} resolved={resolved} />
    case 'combo':
      return <ComboChart result={sortedResult} resolved={resolved} />
    case 'heatmap':
      return <HeatmapChart result={sortedResult} resolved={resolved} />
    case 'candlestick':
      return <CandlestickChart result={sortedResult} resolved={resolved} />
    default:
      return null
  }
}
