import type { AuthUser } from './auth'
import { apiFetch, parseJSON } from './client'

const BASE = '/api/users'

export interface CreateUserPayload {
  username: string
  password: string
  expires_at: string | null
  is_active: boolean
  remark: string
}

export interface UpdateUserPayload {
  password?: string
  is_active?: boolean
  expires_at?: string | null
  remark?: string
}

export async function listUsers(): Promise<AuthUser[]> {
  const resp = await apiFetch(BASE)
  const data = await parseJSON<{ users: AuthUser[] }>(resp)
  return data.users ?? []
}

export async function createUser(payload: CreateUserPayload): Promise<AuthUser> {
  const resp = await apiFetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await parseJSON<{ user: AuthUser }>(resp)
  return data.user
}

export async function updateUser(id: string, payload: UpdateUserPayload): Promise<AuthUser> {
  const resp = await apiFetch(`${BASE}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await parseJSON<{ user: AuthUser }>(resp)
  return data.user
}
