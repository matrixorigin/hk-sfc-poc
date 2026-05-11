import type { SQLResult } from '../types'

export function isNumeric(value: any): boolean {
  if (value === null || value === undefined || value === '') return false
  return !isNaN(Number(value))
}

export function isDateLike(values: string[]): boolean {
  if (values.length < 3) return false
  // 收紧 bare-digit 形式到严格 8 位（YYYYMMDD），避免误捕成交量等 6-7 位整数。
  const datePattern = /\d{4}[-/]\d{1,2}[-/]?|^\d{8}$|T\d{2}:\d{2}/
  return values.filter((v) => datePattern.test(v)).length >= values.length * 0.5
}

export function isIdentifierColumn(colName: string, values: any[]): boolean {
  const lc = colName.toLowerCase()
  if (/\b(code|id|name|symbol|ticker|stock|participant|industry)\b/.test(lc)) return true
  if (/^(sistkc|sistkn|stkcd|stock_code|securitycode)$/.test(lc)) return true
  const uniqueVals = new Set(values.map((v) => String(v)))
  if (uniqueVals.size <= 3 && values.length > 10) return true
  return false
}

export function findDateColumnIndex(result: SQLResult): number {
  for (let ci = 0; ci < result.columns.length; ci++) {
    const values = result.rows.map((row) => String(row[ci] ?? ''))
    if (isDateLike(values)) return ci
  }
  return -1
}

export function findCategoryColumnIndex(result: SQLResult): number {
  for (let ci = 0; ci < result.columns.length; ci++) {
    if (isIdentifierColumn(result.columns[ci], result.rows.map((r) => r[ci]))) {
      return ci
    }
  }
  for (let ci = 0; ci < result.columns.length; ci++) {
    const hasStrings = result.rows.some(
      (row) => typeof row[ci] === 'string' && !isNumeric(row[ci])
    )
    if (hasStrings) return ci
  }
  return 0
}

export function findXAxisIndex(result: SQLResult): number {
  const dateCol = findDateColumnIndex(result)
  if (dateCol >= 0) {
    const uniq = new Set(result.rows.map((r) => String(r[dateCol] ?? '')))
    if (uniq.size >= 3) return dateCol
  }
  return findCategoryColumnIndex(result)
}

export function formatDateValue(v: string): string {
  return v.replace(/T\d{2}:\d{2}:\d{2}[\w:.]*Z?$/, '')
}

const COLUMN_LABELS: Record<string, string> = {
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

export function formatColumnName(col: string): string {
  if (COLUMN_LABELS[col]) return COLUMN_LABELS[col]
  return col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface ColumnRoles {
  // 适合做 x 轴 / 类别维度的列
  dimensions: string[]
  // 适合做 y 轴指标的列（数值列且不是标识/常量列）
  metrics: string[]
  // 适合做图例分组维度的列（类别列且基数 2-30）
  legends: string[]
}

export function classifyColumns(result: SQLResult): ColumnRoles {
  const { columns, rows } = result
  const dimensions: string[] = []
  const metrics: string[] = []
  const legends: string[] = []

  for (let ci = 0; ci < columns.length; ci++) {
    const col = columns[ci]
    const values = rows.map((r) => r[ci])
    const stringValues = values.map((v) => String(v ?? ''))
    const uniqueCount = new Set(stringValues).size
    const identifier = isIdentifierColumn(col, values)
    const dateLike = isDateLike(stringValues)
    const numericMajority = rows.length > 0 && rows.filter((r) => isNumeric(r[ci])).length >= rows.length * 0.7

    // 维度候选：日期列、标识列、或非数值占多数的列
    if (dateLike || identifier || !numericMajority) {
      dimensions.push(col)
    }
    // 指标候选：数值列且不是标识列
    if (numericMajority && !identifier) {
      metrics.push(col)
    }
    // 图例候选：低基数类别列（2-30 个唯一值），日期与纯数值指标除外。
    // 标识列即使值看起来是数字（如 5 位股票代码），也算图例候选。
    if (
      !dateLike &&
      uniqueCount >= 2 &&
      uniqueCount <= 30 &&
      (identifier || !numericMajority)
    ) {
      legends.push(col)
    }
  }

  return { dimensions, metrics, legends }
}
