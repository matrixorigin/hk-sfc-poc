export interface ExploreEvent {
  schema_version: string
  run_id: string
  event: string
  ts_ms: number
  seq: number
  trace_id?: string
  data: any
}

export interface SQLResult {
  columns: string[]
  rows: any[][]
  sql?: string
  total_count?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  sqlResults: SQLResult[]
  sqlStatements: string[]
  isStreaming: boolean
  error?: string
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
