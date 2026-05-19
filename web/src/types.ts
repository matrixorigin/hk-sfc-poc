export interface ExploreEvent {
  schema_version?: string
  run_id?: string
  event: string
  ts_ms?: number
  seq?: number
  trace_id?: string
  data: any
}

export type ChartType =
  | 'bar'
  | 'hbar'
  | 'line'
  | 'pie'
  | 'combo'
  | 'heatmap'
  | 'candlestick'
  | 'auto'
  | 'none'

export interface ChartSpec {
  chart_type: ChartType

  // 通用三要素（bar/hbar/line/pie/combo）
  x?: { field: string; label?: string; type?: 'category' | 'time' }
  y?: {
    field: string
    label?: string
    axis?: 'primary' | 'secondary'   // 主/副 Y 轴；不设默认 primary
    sub_type?: 'bar' | 'line'        // combo 用：该指标渲染为 bar 还是 line
  }[]
  series?: { field: string; label?: string }   // 图例分组维度

  // 热力图：第二维度
  y2?: { field: string; label?: string }

  // 蜡烛图：OHLC 4 字段绑定
  ohlc?: { open: string; close: string; low: string; high: string }

  // 风格
  bar_mode?: 'group' | 'stack'
  orientation?: 'vertical' | 'horizontal'   // 由 chart_type 决定（hbar=horizontal），保留以备扩展
  sort?: { field?: string; order?: 'asc' | 'desc' | 'none' }
  top_n?: number                            // 0 / undefined = 全部
  show_markers?: boolean                     // line/combo 上是否显示点位
  show_data_labels?: boolean                 // 柱顶/点位是否显示数值

  display_mode?: 'chart' | 'table' | 'both'
  round_index?: number
  // user_edited: 标记用户是否手动改过；前端用它阻止上游推荐覆盖用户选择。
  user_edited?: boolean

  // Legacy shape emitted by older moi builds. Normalize at the boundary.
  x_field?: string
  y_fields?: string[]
}

export interface SQLResult {
  columns: string[]
  rows: any[][]
  sql?: string
  total_count?: number
  round_index?: number
}

export type Phase = 'thinking' | 'planning' | 'querying' | 'answering' | 'done'

export interface MetricExplainItem {
  column: string
  name: string
  explain: string
  code: string
  source: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sqlResults: SQLResult[]
  sqlStatements: string[]
  isStreaming: boolean
  phase?: Phase
  phaseHistory?: Phase[]
  error?: string
  chartSpec?: ChartSpec
  feedbackQuestion?: string
  metricExplanations?: MetricExplainItem[]
}

export type Language = 'en' | 'zh'

// ConversationMeta 对应 GET /api/conversations 的单条元信息。
// 前端不再持有会话的完整 messages，messages 按需拉取。
export interface ConversationMeta {
  id: string
  title: string
  created_at: number
  updated_at: number
}

// StoredMessage 对应 GET /api/conversations/:id/messages 返回的原始消息结构。
// 前端加载历史时需要映射为 Message（见 App.tsx 的 fromStoredMessage）。
export interface StoredMessage {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  content: string
  sql_statements?: string[]
  sql_results?: SQLResult[]
  chart_spec?: ChartSpec
  phase_history?: Phase[]
  error?: string
  feedback_question?: string
  status: 'pending' | 'done' | 'failed'
  seq: number
  created_at: number
  metric_explanations?: MetricExplainItem[]
}

// fromStoredMessage 把后端存储结构映射为前端运行时的 Message。
export function fromStoredMessage(m: StoredMessage): Message {
  return {
    id: m.id,
    role: m.role,
    content: m.content ?? '',
    sqlResults: (m.sql_results ?? []).map((r) => ({
      ...r,
      columns: r.columns ?? [],
      rows: r.rows ?? [],
    })),
    sqlStatements: m.sql_statements ?? [],
    isStreaming: m.status === 'pending',
    phase: m.status === 'done' ? 'done' : undefined,
    phaseHistory: m.phase_history as Phase[] | undefined,
    error: m.error,
    chartSpec: normalizeChartSpec(m.chart_spec),
    feedbackQuestion: m.feedback_question,
    metricExplanations: m.metric_explanations,
  }
}

export function normalizeChartSpec(spec?: ChartSpec): ChartSpec | undefined {
  if (!spec) return undefined
  const legacy = spec as ChartSpec & { x_field?: string; y_fields?: string[] }
  const { x_field, y_fields, ...rest } = legacy
  const normalized: ChartSpec = { ...rest }

  if (!normalized.x && x_field) {
    normalized.x = {
      field: x_field,
      label: x_field,
      type: inferAxisType(x_field),
    }
  }
  if ((!normalized.y || normalized.y.length === 0) && y_fields?.length) {
    normalized.y = y_fields
      .filter((field) => !!field)
      .map((field) => ({ field, label: field, axis: 'primary' }))
  }
  return normalized
}

function inferAxisType(field: string): 'category' | 'time' {
  const f = field.toLowerCase()
  return f.includes('date') || f.includes('time') || f.includes('month') || f.includes('year')
    ? 'time'
    : 'category'
}
