import ReactECharts from 'echarts-for-react'
import type { SQLResult } from '../types'

interface ChartProps {
  result: SQLResult
}

function isNumeric(value: any): boolean {
  if (value === null || value === undefined || value === '') return false
  return !isNaN(Number(value))
}

function canRenderChart(result: SQLResult): boolean {
  if (result.columns.length < 2) return false
  if (!result.rows.length) return false
  // 检查是否至少有一列数值
  const hasNumericCol = result.columns.some((_, ci) =>
    result.rows.some((row) => isNumeric(row[ci]))
  )
  return hasNumericCol
}

export function Chart({ result }: ChartProps) {
  if (!canRenderChart(result)) return null

  const { columns, rows } = result

  // 第一列作为 x 轴，其余数值列作为系列
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
    type: 'line',
    data: rows.map((row) => {
      const v = row[colIndex]
      return isNumeric(v) ? Number(v) : null
    }),
    smooth: true,
  }))

  const option = {
    tooltip: { trigger: 'axis' },
    legend: { data: numericSeries.map((s) => s.col) },
    xAxis: {
      type: 'category',
      data: xData,
      axisLabel: { rotate: xData.length > 10 ? 30 : 0 },
    },
    yAxis: { type: 'value' },
    series,
    grid: { left: 40, right: 20, top: 40, bottom: 40 },
  }

  return (
    <div className="chart-wrapper" style={{ marginTop: 12, padding: 12 }}>
      <ReactECharts option={option} style={{ height: 280 }} />
    </div>
  )
}
