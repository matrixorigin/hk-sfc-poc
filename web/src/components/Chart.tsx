import ReactECharts from 'echarts-for-react'
import type { SQLResult } from '../types'

interface ChartProps {
  result: SQLResult
}

function isNumeric(value: any): boolean {
  if (value === null || value === undefined || value === '') return false
  return !isNaN(Number(value))
}

// Check if x-axis values look like a time series or ordered sequence
function isTimeSeries(values: string[]): boolean {
  if (values.length < 3) return false
  // Check if values contain date-like patterns
  const datePattern = /\d{4}[-/]\d{2}|^\d{6,8}$/
  return values.filter((v) => datePattern.test(v)).length >= values.length * 0.5
}

function canRenderChart(result: SQLResult): boolean {
  // Need at least 2 columns and 3 data points for a meaningful chart
  if (result.columns.length < 2) return false
  if (result.rows.length < 3) return false

  // Need at least one numeric column (besides x-axis)
  const hasNumericCol = result.columns.slice(1).some((_, ci) =>
    result.rows.some((row) => isNumeric(row[ci + 1]))
  )
  if (!hasNumericCol) return false

  // X-axis should be a time series or ordered sequence, not random category names
  const xValues = result.rows.map((row) => String(row[0] ?? ''))
  if (!isTimeSeries(xValues)) return false

  return true
}

export function Chart({ result }: ChartProps) {
  if (!canRenderChart(result)) return null

  const { columns, rows } = result

  const xData = rows.map((row) => String(row[0] ?? ''))

  const seriesCols = columns.slice(1).map((col, i) => ({
    col,
    colIndex: i + 1,
  }))

  const numericSeries = seriesCols.filter(({ colIndex }) =>
    rows.some((row) => isNumeric(row[colIndex]))
  )

  const series = numericSeries.map(({ col, colIndex }) => ({
    name: col,
    type: 'line' as const,
    data: rows.map((row) => {
      const v = row[colIndex]
      return isNumeric(v) ? Number(v) : null
    }),
    smooth: true,
  }))

  const option = {
    tooltip: { trigger: 'axis' as const },
    legend: {
      data: numericSeries.map((s) => s.col),
      bottom: 0,
      type: 'scroll' as const,
    },
    xAxis: {
      type: 'category' as const,
      data: xData,
      axisLabel: { rotate: xData.length > 10 ? 30 : 0 },
    },
    yAxis: { type: 'value' as const },
    series,
    grid: { left: 60, right: 20, top: 30, bottom: 50 },
  }

  return (
    <div className="chart-wrapper" style={{ marginTop: 12, padding: 12 }}>
      <ReactECharts option={option} style={{ height: 300 }} />
    </div>
  )
}
