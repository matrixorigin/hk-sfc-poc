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

// 结构化 reason，便于 i18n 翻译
// 全手动原则：chip 灰态只看「列数够不够」，不区分数值/类别/时间。
export type AvailReason =
  | { kind: 'empty' }
  | { kind: 'need-cols'; n: number }

// 不同图表类型所需的最少列数（用户手动绑定字段，引擎只检查列够不够）
const MIN_COLS: Record<
  'bar' | 'hbar' | 'line' | 'pie' | 'combo' | 'heatmap' | 'candlestick',
  number
> = {
  bar: 2,        // X + ≥1 Y
  hbar: 2,
  line: 2,
  pie: 2,        // X + 1 Y
  combo: 3,      // X + ≥2 Y
  heatmap: 3,    // X + Y + value
  candlestick: 5, // time + open/close/high/low
}

// chartTypeAvailability: 返回当前数据能否画这个图表类型 + 结构化 reason
export function chartTypeAvailability(
  result: SQLResult,
  type: 'bar' | 'hbar' | 'line' | 'pie' | 'combo' | 'heatmap' | 'candlestick'
): { ok: true } | { ok: false; reason: AvailReason } {
  if (!result || result.rows.length === 0) {
    return { ok: false, reason: { kind: 'empty' } }
  }
  const need = MIN_COLS[type]
  if (result.columns.length < need) {
    return { ok: false, reason: { kind: 'need-cols', n: need } }
  }
  return { ok: true }
}

