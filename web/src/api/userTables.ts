export interface ColumnInfo {
  name: string
  inferred_type?: string
  type?: string
  comment?: string
  samples?: string[]
}

export interface PreviewResult {
  file_key: string
  sheet_name: string
  columns: ColumnInfo[]
  preview_rows: string[][]
  total_rows: number
}

export interface UserTableMeta {
  table_name: string
  table_comment: string
  row_count: number
  created_at: string
  source: string
}

export interface DataPreviewResult {
  columns: string[]
  rows: string[][]
  total: number
}

const BASE = '/api/user-tables'

async function parseJSON<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function uploadPreview(file: File): Promise<PreviewResult> {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(`${BASE}/preview`, { method: 'POST', body: form })
  return parseJSON<PreviewResult>(resp)
}

export async function createTable(req: {
  file_key: string
  table_name: string
  table_comment: string
  columns: ColumnInfo[]
}): Promise<{ table_name: string; row_count: number }> {
  const resp = await fetch(`${BASE}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  return parseJSON<{ table_name: string; row_count: number }>(resp)
}

export async function listUserTables(): Promise<UserTableMeta[]> {
  const resp = await fetch(BASE)
  return parseJSON<UserTableMeta[]>(resp)
}

export async function deleteUserTable(name: string): Promise<void> {
  const resp = await fetch(`${BASE}/${name}`, { method: 'DELETE' })
  if (!resp.ok) {
    throw new Error(`delete failed: ${resp.status}`)
  }
}

export async function updateMetadata(
  name: string,
  req: { table_comment: string; columns: { name: string; comment: string }[] }
): Promise<void> {
  const resp = await fetch(`${BASE}/${name}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!resp.ok) {
    throw new Error(`update metadata failed: ${resp.status}`)
  }
}

export async function previewTableData(name: string): Promise<DataPreviewResult> {
  const resp = await fetch(`${BASE}/${name}/preview`)
  return parseJSON<DataPreviewResult>(resp)
}

export async function getTableColumns(name: string): Promise<ColumnInfo[]> {
  const resp = await fetch(`${BASE}/${name}/columns`)
  return parseJSON<ColumnInfo[]>(resp)
}
