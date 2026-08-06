import { ApiError, apiFetch, parseJSON, responseError } from './client'

const BASE = '/api/auth'

export interface AuthUser {
  id: string
  username: string
  is_admin: boolean
  is_active: boolean
  expires_at: string | null
  remark: string
  created_at: string
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const resp = await apiFetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }, { skipUnauthorized: true })
  return parseJSON<AuthUser>(resp)
}

export async function logout(): Promise<void> {
  await apiFetch(`${BASE}/logout`, { method: 'POST' }, { skipUnauthorized: true })
}

export async function getMe(): Promise<AuthUser | null> {
  const resp = await apiFetch(`${BASE}/me`, undefined, { skipUnauthorized: true })
  if (resp.status === 401) {
    const message = await responseError(resp)
    if (message === 'unauthorized' || message === 'invalid username or password') return null
    throw new ApiError(resp.status, message)
  }
  return parseJSON<AuthUser>(resp)
}
