import type { ChartSpec, ConversationMeta, StoredMessage } from '../types'
import { apiFetch } from './client'

const BASE = '/api/conversations'

async function parseJSON<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}: ${text}`)
  }
  return resp.json() as Promise<T>
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const resp = await apiFetch(BASE)
  const data = await parseJSON<{ conversations: ConversationMeta[] }>(resp)
  return data.conversations ?? []
}

export async function createConversation(): Promise<string> {
  const resp = await apiFetch(BASE, { method: 'POST' })
  const data = await parseJSON<{ id: string }>(resp)
  return data.id
}

export async function updateConversationTitle(id: string, title: string): Promise<void> {
  const resp = await apiFetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  if (!resp.ok) {
    throw new Error(`update title failed: ${resp.status}`)
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const resp = await apiFetch(`${BASE}/${id}`, { method: 'DELETE' })
  if (!resp.ok) {
    throw new Error(`delete failed: ${resp.status}`)
  }
}

export async function listMessages(id: string): Promise<StoredMessage[]> {
  const resp = await apiFetch(`${BASE}/${id}/messages`)
  const data = await parseJSON<{ messages: StoredMessage[] }>(resp)
  return data.messages ?? []
}

export async function updateMessageChartSpec(
  conversationId: string,
  messageId: string,
  spec: ChartSpec
): Promise<void> {
  const resp = await apiFetch(
    `${BASE}/${conversationId}/messages/${messageId}/chart-spec`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    }
  )
  if (!resp.ok) {
    throw new Error(`update chart_spec failed: ${resp.status}`)
  }
}
