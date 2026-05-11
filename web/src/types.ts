export interface ExploreEvent {
  schema_version?: string
  run_id?: string
  event: string
  ts_ms?: number
  seq?: number
  trace_id?: string
  data: any
}

export interface ChartSpec {
  chart_type: 'bar' | 'line' | 'pie' | 'auto' | 'none'
  x?: { field: string; label?: string; type?: 'category' | 'time' }
  y?: { field: string; label?: string }[]
  // series: 图例分组维度。存在时按该字段把数据透视成多条 series。
  series?: { field: string; label?: string }
  // bar_mode: 柱状图多 series 的排列方式，默认 group。
  bar_mode?: 'group' | 'stack'
  display_mode?: 'chart' | 'table' | 'both'
  round_index?: number
  // user_edited: 标记用户是否手动改过；前端用它阻止上游推荐覆盖用户选择。
  user_edited?: boolean
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
    sqlResults: m.sql_results ?? [],
    sqlStatements: m.sql_statements ?? [],
    isStreaming: m.status === 'pending',
    phase: m.status === 'done' ? 'done' : undefined,
    phaseHistory: m.phase_history as Phase[] | undefined,
    error: m.error,
    chartSpec: m.chart_spec,
    feedbackQuestion: m.feedback_question,
    metricExplanations: m.metric_explanations,
  }
}
