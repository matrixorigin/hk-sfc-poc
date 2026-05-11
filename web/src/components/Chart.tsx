import ReactECharts from 'echarts-for-react'
import type { SQLResult, ChartSpec } from '../types'
import {
  classifyColumns,
  findCategoryColumnIndex,
  findXAxisIndex,
  formatColumnName,
  formatDateValue,
  isIdentifierColumn,
  isNumeric,
} from '../utils/chartFieldRoles'

interface ChartProps {
  result: SQLResult
  spec?: ChartSpec
}

export function canChartResult(result: SQLResult): boolean {
  return isTimeSeriesLike(result) || isCategoricalLike(result)
}

// ── 适合性评估（自动推荐用，不作为渲染门禁）──

function isTimeSeriesLike(result: SQLResult): boolean {
  if (result.columns.length < 2) return false
  if (result.rows.length < 3) return false
  const roles = classifyColumns(result)
  const dateCol = result.columns.findIndex((c) => roles.dimensions.includes(c) && hasEnoughDates(result, c))
  if (dateCol < 0) return false
  return roles.metrics.length > 0
}

function hasEnoughDates(result: SQLResult, colName: string): boolean {
  const ci = result.columns.indexOf(colName)
  if (ci < 0) return false
  const uniq = new Set(result.rows.map((r) => String(r[ci] ?? '')))
  return uniq.size >= 3
}

function isCategoricalLike(result: SQLResult): boolean {
  if (result.columns.length < 2 || result.rows.length < 1) return false
  const roles = classifyColumns(result)
  return roles.metrics.length > 0
}

// ── 解析有效字段：spec 优先，缺失则自动推断 ──

export type ResolvedChartType = 'line' | 'bar' | 'pie' | 'none'

export interface ResolvedSpec {
  chartType: ResolvedChartType
  xField?: string
  yFields: string[]
  seriesField?: string
  barMode: 'group' | 'stack'
}

export function resolveSpec(result: SQLResult, spec?: ChartSpec): ResolvedSpec {
  // 1) chartType
  let chartType: ResolvedChartType
  if (spec?.chart_type === 'none') chartType = 'none'
  else if (spec?.chart_type && spec.chart_type !== 'auto') chartType = spec.chart_type
  else if (isTimeSeriesLike(result)) chartType = 'line'
  else if (isCategoricalLike(result)) chartType = 'bar'
  else chartType = 'none'

  // 2) xField
  let xField: string | undefined
  if (spec?.x?.field && result.columns.includes(spec.x.field)) {
    xField = spec.x.field
  } else {
    const idx = chartType === 'bar' || chartType === 'pie'
      ? findCategoryColumnIndex(result)
      : findXAxisIndex(result)
    xField = idx >= 0 ? result.columns[idx] : undefined
  }

  // 3) yFields
  let yFields: string[] = []
  if (spec?.y && spec.y.length > 0) {
    yFields = spec.y.map((y) => y.field).filter((f) => result.columns.includes(f))
  }
  if (yFields.length === 0) {
    // 自动取所有数值非标识列（排除 x、series）
    const series = spec?.series?.field
    yFields = result.columns.filter((c, ci) => {
      if (c === xField || c === series) return false
      if (isIdentifierColumn(c, result.rows.map((r) => r[ci]))) return false
      return result.rows.some((r) => isNumeric(r[ci]))
    })
  }
  // 饼图限制为单指标
  if (chartType === 'pie' && yFields.length > 1) yFields = [yFields[0]]

  // 4) seriesField
  let seriesField: string | undefined
  if (spec?.series?.field && result.columns.includes(spec.series.field) && chartType !== 'pie') {
    seriesField = spec.series.field
  }
  if (seriesField === xField) seriesField = undefined

  return {
    chartType,
    xField,
    yFields,
    seriesField,
    barMode: spec?.bar_mode ?? 'group',
  }
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

const LEGEND_MAX = 30 // 图例分组最多展示 30 个值，超出截断

// ── series 构建（pivot 与否分两路） ──

interface SeriesData {
  name: string
  data: (number | null)[]
}

interface BuiltSeries {
  xData: string[]
  series: SeriesData[]
  truncated: boolean
}

// 当多个指标的量级差异超过此倍数时，自动启用第二条 y 轴。
const DUAL_AXIS_RATIO = 50

// splitYByMagnitude 按指标的绝对值上限，把 yFields 划成 left/right 两组。
// 仅当存在「连续两个指标之间的最大值之比 > DUAL_AXIS_RATIO」时才切分。
function splitYByMagnitude(
  result: SQLResult,
  yFields: string[]
): { leftAxis: string[]; rightAxis: string[] } {
  if (yFields.length < 2) return { leftAxis: yFields, rightAxis: [] }

  const items = yFields
    .map((f) => {
      const idx = result.columns.indexOf(f)
      let max = 0
      for (const r of result.rows) {
        const v = r[idx]
        if (isNumeric(v)) {
          const abs = Math.abs(Number(v))
          if (abs > max) max = abs
        }
      }
      return { f, max }
    })
    .sort((a, b) => b.max - a.max)

  // 找相邻两档之间最大跳跃；阈值 > DUAL_AXIS_RATIO 才认为值得分两轴
  let splitAt = -1
  let bestRatio = DUAL_AXIS_RATIO
  for (let i = 0; i < items.length - 1; i++) {
    const lo = items[i + 1].max
    const ratio = lo > 0 ? items[i].max / lo : Infinity
    if (ratio > bestRatio) {
      bestRatio = ratio
      splitAt = i
    }
  }
  if (splitAt < 0) return { leftAxis: yFields, rightAxis: [] }

  return {
    leftAxis: items.slice(0, splitAt + 1).map((x) => x.f),
    rightAxis: items.slice(splitAt + 1).map((x) => x.f),
  }
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

  // 收集 x 的有序唯一值（按首次出现顺序）
  const xOrder: string[] = []
  const xSeen = new Set<string>()
  for (const row of result.rows) {
    const xv = String(row[xIdx] ?? '')
    if (!xSeen.has(xv)) {
      xSeen.add(xv)
      xOrder.push(xv)
    }
  }

  // 收集 series 唯一值（按首次出现顺序）
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

  // 构建 (series, x) → value 索引
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

// ── 子图表组件 ──

function LineChart({ result, resolved }: { result: SQLResult; resolved: ResolvedSpec }) {
  const { xField, yFields, seriesField } = resolved
  if (!xField || yFields.length === 0) return null

  const built = seriesField
    ? buildSeriesWithLegend(result, xField, yFields[0], seriesField, formatDateValue)
    : buildSeriesPlain(result, xField, yFields, formatDateValue)
  if (built.series.length === 0) return null

  // 多指标且无图例分组时，按量级自动分配双 y 轴
  const axisSplit = seriesField
    ? { leftAxis: yFields, rightAxis: [] as string[] }
    : splitYByMagnitude(result, yFields)
  const useDualAxis = axisSplit.rightAxis.length > 0
  // series.name → field 反查，用于决定 yAxisIndex
  const rightFieldSet = new Set(
    axisSplit.rightAxis.map((f) => formatColumnName(f))
  )

  const seriesOpt = built.series.map((s, idx) => ({
    name: s.name,
    type: 'line' as const,
    data: s.data,
    smooth: true,
    symbol: 'none',
    lineStyle: { width: 2 },
    itemStyle: { color: COLORS[idx % COLORS.length] },
    yAxisIndex: useDualAxis && rightFieldSet.has(s.name) ? 1 : 0,
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
      right: useDualAxis ? 60 : 20,
      top: 36,
      bottom: needSlider ? 70 : 36,
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      data: built.xData,
      boundaryGap: false,
      axisLabel: {
        fontSize: 11,
        color: '#9ca3af',
        rotate: built.xData.length > 30 ? 45 : 0,
        interval: Math.max(0, Math.floor(built.xData.length / 12) - 1),
        formatter: (v: string) => {
          const m = v.match(/^\d{4}-(\d{2}-\d{2})/)
          return m ? m[1] : v
        },
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
    },
    yAxis: useDualAxis
      ? [
          buildYAxis('left'),
          buildYAxis('right'),
        ]
      : buildYAxis('left'),
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
              start: 70,
              end: 100,
            },
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

function BarChart({ result, resolved }: { result: SQLResult; resolved: ResolvedSpec }) {
  const { xField, yFields, seriesField, barMode } = resolved
  if (!xField || yFields.length === 0) return null

  const built = seriesField
    ? buildSeriesWithLegend(result, xField, yFields[0], seriesField, (v) => v)
    : buildSeriesPlain(result, xField, yFields, (v) => v)
  if (built.series.length === 0) return null

  // 多指标且无图例 → 量级分轴；堆叠模式下强制单轴
  const axisSplit = seriesField || barMode === 'stack'
    ? { leftAxis: yFields, rightAxis: [] as string[] }
    : splitYByMagnitude(result, yFields)
  const useDualAxis = axisSplit.rightAxis.length > 0
  const rightFieldSet = new Set(
    axisSplit.rightAxis.map((f) => formatColumnName(f))
  )

  const stackKey = barMode === 'stack' ? 'total' : undefined
  const seriesOpt = built.series.map((s, idx) => ({
    name: s.name,
    type: 'bar' as const,
    data: s.data,
    itemStyle: { color: COLORS[idx % COLORS.length] },
    ...(stackKey ? { stack: stackKey } : {}),
    yAxisIndex: useDualAxis && rightFieldSet.has(s.name) ? 1 : 0,
  }))

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
    grid: { left: 60, right: useDualAxis ? 60 : 20, top: 36, bottom: 36, containLabel: false },
    xAxis: {
      type: 'category',
      data: built.xData,
      axisLabel: {
        fontSize: 11,
        color: '#9ca3af',
        rotate: built.xData.length > 8 ? 45 : 0,
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
    },
    yAxis: useDualAxis
      ? [buildYAxis('left'), buildYAxis('right')]
      : buildYAxis('left'),
    series: seriesOpt,
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      {built.truncated && <TruncationHint />}
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: 300 }} />
    </div>
  )
}

function PieChart({ result, resolved }: { result: SQLResult; resolved: ResolvedSpec }) {
  const { xField, yFields } = resolved
  if (!xField || yFields.length === 0) return null

  const nameIdx = result.columns.indexOf(xField)
  const valueIdx = result.columns.indexOf(yFields[0])
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
    legend: { orient: 'vertical', right: 10, top: 'center', textStyle: { fontSize: 12 }, type: 'scroll' },
    series: [{
      type: 'pie',
      radius: ['40%', '70%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
      data,
    }],
  }

  return (
    <div className="chart-wrapper" style={chartWrapperStyle}>
      <ReactECharts option={option} notMerge lazyUpdate style={{ height: 300 }} />
    </div>
  )
}

function buildYAxis(side: 'left' | 'right') {
  return {
    type: 'value' as const,
    position: side,
    splitLine: side === 'left'
      ? { lineStyle: { color: '#f3f4f6', type: 'dashed' as const } }
      : { show: false },
    axisLabel: { fontSize: 11, color: '#9ca3af' },
    axisLine: { show: false },
    axisTick: { show: false },
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

// ── 路由入口 ──

export function Chart({ result, spec }: ChartProps) {
  const resolved = resolveSpec(result, spec)
  if (resolved.chartType === 'none') return null

  switch (resolved.chartType) {
    case 'line':
      return <LineChart result={result} resolved={resolved} />
    case 'bar':
      return <BarChart result={result} resolved={resolved} />
    case 'pie':
      return <PieChart result={result} resolved={resolved} />
    default:
      return null
  }
}
