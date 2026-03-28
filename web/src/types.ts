export interface ExploreEvent {
  schema_version: string
  run_id: string
  event: string
  ts_ms: number
  seq: number
  trace_id?: string
  data: any
}

export interface ChartSpec {
  chart_type: 'bar' | 'line' | 'pie' | 'auto' | 'none'
  x?: { field: string; label: string; type: 'category' | 'time' }
  y?: { field: string; label: string }[]
  display_mode?: 'chart' | 'table' | 'both'
  round_index?: number
}

export interface SQLResult {
  columns: string[]
  rows: any[][]
  sql?: string
  total_count?: number
  round_index?: number
}

export type Phase = 'thinking' | 'planning' | 'querying' | 'answering' | 'done'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sqlResults: SQLResult[]
  sqlStatements: string[]
  isStreaming: boolean
  phase?: Phase
  error?: string
  chartSpec?: ChartSpec
}

export type Language = 'en' | 'zh'

export interface Conversation {
  id: string
  sessionId: string
  title: string
  messages: Message[]
  createdAt: number
  updatedAt: number
}
