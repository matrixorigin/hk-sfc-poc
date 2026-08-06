import { apiFetch, handleXHRUnauthorized } from './client'

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

export async function uploadPreview(
  file: File,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal
): Promise<PreviewResult> {
  const form = new FormData()
  form.append('file', file)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${BASE}/preview`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText))
      } else {
        handleXHRUnauthorized(xhr.status, xhr.responseText)
        reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText}`))
      }
    }
    xhr.onerror = () => reject(new Error('network error'))
    signal?.addEventListener('abort', () => xhr.abort())
    xhr.onabort = () => reject(new Error('aborted'))
    xhr.send(form)
  })
}

export interface ImportProgress {
  phase: 'preparing' | 'reading' | 'importing' | 'done' | 'error'
  current?: number
  total?: number
  message?: string
}

export async function createTable(
  req: {
    file_key: string
    table_name: string
    table_comment: string
    columns: ColumnInfo[]
  },
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await apiFetch(`${BASE}/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!resp.ok && !resp.headers.get('content-type')?.includes('text/event-stream')) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }

  const reader = resp.body?.getReader()
  if (!reader) throw new Error('no response body')

  const decoder = new TextDecoder()
  let buf = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const p: ImportProgress = JSON.parse(line.slice(6))
      if (p.phase === 'error') throw new Error(p.message || 'import failed')
      onProgress?.(p)
    }
  }
}

export async function listUserTables(): Promise<UserTableMeta[]> {
  const resp = await apiFetch(BASE)
  return parseJSON<UserTableMeta[]>(resp)
}

export async function deleteUserTable(name: string): Promise<void> {
  const resp = await apiFetch(`${BASE}/${name}`, { method: 'DELETE' })
  if (!resp.ok) {
    throw new Error(`delete failed: ${resp.status}`)
  }
}

export async function updateMetadata(
  name: string,
  req: { table_comment: string; columns: { name: string; comment: string }[] }
): Promise<void> {
  const resp = await apiFetch(`${BASE}/${name}/metadata`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!resp.ok) {
    throw new Error(`update metadata failed: ${resp.status}`)
  }
}

export async function previewTableData(name: string): Promise<DataPreviewResult> {
  const resp = await apiFetch(`${BASE}/${name}/preview`)
  return parseJSON<DataPreviewResult>(resp)
}

export async function getTableColumns(name: string): Promise<ColumnInfo[]> {
  const resp = await apiFetch(`${BASE}/${name}/columns`)
  return parseJSON<ColumnInfo[]>(resp)
}
