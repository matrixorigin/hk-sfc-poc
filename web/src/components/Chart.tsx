import ReactECharts from 'echarts-for-react'
import type { SQLResult } from '../types'

interface ChartProps {
  result: SQLResult
}

// ── 工具函数 ──

function isNumeric(value: any): boolean {
  if (value === null || value === undefined || value === '') return false
  return !isNaN(Number(value))
}

function isDateLike(values: string[]): boolean {
  if (values.length < 3) return false
  const datePattern = /\d{4}[-/]\d{2}|^\d{6,8}$|T\d{2}:\d{2}/
  return values.filter((v) => datePattern.test(v)).length >= values.length * 0.5
}

function findDateColumnIndex(result: SQLResult): number {
  for (let ci = 0; ci < result.columns.length; ci++) {
    const values = result.rows.map((row) => String(row[ci] ?? ''))
    if (isDateLike(values)) return ci
  }
  return -1
}

function formatDateValue(v: string): string {
  return v.replace(/T\d{2}:\d{2}:\d{2}[\w:.]*Z?$/, '')
}

/** 判断是否为标识/常量列（不应作为数据系列） */
function isIdentifierColumn(colName: string, values: any[]): boolean {
  const lc = colName.toLowerCase()
  // 列名含 code/id/name/symbol 的大概率是标识列
  if (/\b(code|id|name|symbol|ticker|stock|participant|industry)\b/.test(lc)) return true
  // HK POC specific: SISTKC (stock code), SISTKN (stock name) are identifier columns
  if (/^(sistkc|sistkn|stkcd|stock_code|securitycode)$/.test(lc)) return true
  // 唯一值极少（< 5）的数值列很可能是标识
  const uniqueVals = new Set(values.map((v) => String(v)))
  if (uniqueVals.size <= 3 && values.length > 10) return true
  return false
}

/** 将 DB 列名转为可读标签 */
function formatColumnName(col: string): string {
  const map: Record<string, string> = {
    closing_price: 'Closing Price',
    close_price: 'Close Price',
    open_price: 'Open Price',
    high_price: 'High',
    low_price: 'Low',
    ma_50: '50-Day MA',
    ma_20: '20-Day MA',
    ma_10: '10-Day MA',
    trade_date: 'Date',
    stock_code: 'Stock',
    total_volume: 'Volume',
    market_cap: 'Market Cap',
    revenue: 'Revenue',
    net_profit: 'Net Profit',
    shareholding: 'Shareholding',
    SICLSE: 'Closing Price',
    SIOPNE: 'Open Price',
    SIHIGE: 'High',
    SILOWE: 'Low',
    SITOQY: 'Volume',
    SISTKC: 'Stock Code',
  }
  if (map[col]) return map[col]
  // snake_case → Title Case
  return col
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ── 金融配色 ──
const COLORS = [
  '#1a73e8', // 蓝
  '#e8710a', // 橙
  '#0d9488', // 青
  '#7c3aed', // 紫
  '#dc2626', // 红
  '#16a34a', // 绿
]

// ── 核心 ──

function canRenderChart(result: SQLResult): boolean {
  if (result.columns.length < 2) return false
  if (result.rows.length < 3) return false
  const dateCol = findDateColumnIndex(result)
  if (dateCol < 0) return false

  // 日期列必须有足够的不同值才是时间序列（排名表同一天重复 N 次不该画图）
  const uniqueDates = new Set(result.rows.map((row) => String(row[dateCol] ?? '')))
  if (uniqueDates.size < 3) return false

  const hasNumericCol = result.columns.some(
    (col, ci) =>
      ci !== dateCol &&
      !isIdentifierColumn(col, result.rows.map((r) => r[ci])) &&
      result.rows.some((row) => isNumeric(row[ci]))
  )
  return hasNumericCol
}

export function Chart({ result }: ChartProps) {
  if (!canRenderChart(result)) return null

  const { columns, rows } = result
  const dateCol = findDateColumnIndex(result)
  const xData = rows.map((row) => formatDateValue(String(row[dateCol] ?? '')))

  // 过滤掉日期列和标识列，只保留真正的数值系列
  const numericSeries = columns
    .map((col, ci) => ({ col, colIndex: ci }))
    .filter(
      ({ col, colIndex }) =>
        colIndex !== dateCol &&
        !isIdentifierColumn(col, rows.map((r) => r[colIndex])) &&
        rows.some((row) => isNumeric(row[colIndex]))
    )

  const series = numericSeries.map(({ col, colIndex }, idx) => ({
    name: formatColumnName(col),
    type: 'line' as const,
    data: rows.map((row) => {
      const v = row[colIndex]
      return isNumeric(v) ? Number(v) : null
    }),
    smooth: true,
    symbol: 'none',
    lineStyle: { width: 2 },
    itemStyle: { color: COLORS[idx % COLORS.length] },
  }))

  const needSlider = xData.length > 60

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
      data: numericSeries.map((s) => formatColumnName(s.col)),
      top: 4,
      textStyle: { fontSize: 12, color: '#6b7280' },
      icon: 'roundRect',
      itemWidth: 16,
      itemHeight: 3,
    },
    grid: {
      left: 60,
      right: 20,
      top: 36,
      bottom: needSlider ? 70 : 36,
      containLabel: false,
    },
    xAxis: {
      type: 'category',
      data: xData,
      boundaryGap: false,
      axisLabel: {
        fontSize: 11,
        color: '#9ca3af',
        rotate: xData.length > 30 ? 45 : 0,
        interval: Math.max(0, Math.floor(xData.length / 12) - 1),
        formatter: (v: string) => {
          // 只显示月-日，省略年份（除了第一个和跨年点）
          const m = v.match(/^\d{4}-(\d{2}-\d{2})/)
          return m ? m[1] : v
        },
      },
      axisLine: { lineStyle: { color: '#e5e7eb' } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: '#f3f4f6', type: 'dashed' } },
      axisLabel: { fontSize: 11, color: '#9ca3af' },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series,
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
    <div
      className="chart-wrapper"
      style={{
        marginTop: 12,
        padding: '12px 12px 4px',
        background: '#fff',
        borderRadius: 8,
        border: '1px solid #f0f0f0',
      }}
    >
      <ReactECharts option={option} style={{ height: needSlider ? 340 : 300 }} />
    </div>
  )
}
