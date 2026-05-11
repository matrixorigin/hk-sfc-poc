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

// 蜡烛图 OHLC 列名候选词（小写匹配，处理 open_price / open / 开盘等多种形式）
const OHLC_PATTERNS = {
  open: [/(^|[_\s-])open([_\s-]|$)/, /开盘/, /siopne/],
  close: [/(^|[_\s-])close([_\s-]|$)/, /收盘/, /siclse/],
  high: [/(^|[_\s-])high([_\s-]|$)/, /最高/, /sihige/],
  low: [/(^|[_\s-])low([_\s-]|$)/, /最低/, /silowe/],
}

// detectOHLC: 扫描列名，返回各角色的候选列（按匹配度排序）
export function detectOHLC(columns: string[]): { open?: string; close?: string; high?: string; low?: string } {
  const lower = columns.map((c) => c.toLowerCase())
  const out: { [k: string]: string | undefined } = {}
  for (const role of ['open', 'close', 'high', 'low'] as const) {
    for (let i = 0; i < lower.length; i++) {
      if (OHLC_PATTERNS[role].some((re) => re.test(lower[i]))) {
        out[role] = columns[i]
        break
      }
    }
  }
  return out
}

// chartTypeAvailability: 返回当前数据能否画这个图表类型 + 不能的原因
export function chartTypeAvailability(
  result: SQLResult,
  type: 'bar' | 'hbar' | 'line' | 'pie' | 'combo' | 'heatmap' | 'candlestick'
): { ok: boolean; reason?: string } {
  if (!result || result.rows.length === 0 || result.columns.length < 2) {
    return { ok: false, reason: '数据为空或列太少' }
  }
  const roles = classifyColumns(result)

  switch (type) {
    case 'bar':
    case 'hbar':
    case 'line':
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      return { ok: true }

    case 'pie':
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      if (roles.dimensions.length < 1) return { ok: false, reason: '需要 ≥ 1 个类别列' }
      return { ok: true }

    case 'combo':
      if (roles.metrics.length < 2) return { ok: false, reason: '需要 ≥ 2 个数值列' }
      return { ok: true }

    case 'heatmap': {
      // 需要两个低基数类别列 + 一个数值列
      const catDims = result.columns.filter((c, ci) => {
        const vals = result.rows.map((r) => r[ci])
        if (!isIdentifierColumn(c, vals) && !isDateLike(vals.map(String))) return false
        const uniq = new Set(vals.map(String)).size
        return uniq >= 2 && uniq <= 30
      })
      if (catDims.length < 2) return { ok: false, reason: '需要 ≥ 2 个类别列' }
      if (roles.metrics.length < 1) return { ok: false, reason: '需要 ≥ 1 个数值列' }
      return { ok: true }
    }

    case 'candlestick': {
      const ohlc = detectOHLC(result.columns)
      const missing = (['open', 'close', 'high', 'low'] as const).filter((k) => !ohlc[k])
      if (missing.length > 0) return { ok: false, reason: `需要 OHLC 4 列（缺 ${missing.join('/')})` }
      const hasTime = result.columns.some((_c, ci) =>
        isDateLike(result.rows.map((r) => String(r[ci] ?? '')))
      )
      if (!hasTime) return { ok: false, reason: '需要 1 个时间维度列' }
      return { ok: true }
    }
  }
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
