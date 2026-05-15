const BASE = '/api/auth'

export interface AuthUser {
  username: string
}

async function parseJSON<T>(resp: Response): Promise<T> {
  const data = await resp.json()
  if (!resp.ok) {
    throw new Error(data.error || `HTTP ${resp.status}`)
  }
  return data as T
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return parseJSON<AuthUser>(resp)
}

export async function register(username: string, password: string): Promise<AuthUser> {
  const resp = await fetch(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return parseJSON<AuthUser>(resp)
}

export async function logout(): Promise<void> {
  await fetch(`${BASE}/logout`, { method: 'POST' })
}

export async function getMe(): Promise<AuthUser | null> {
  try {
    const resp = await fetch(`${BASE}/me`)
    if (resp.status === 401) return null
    return parseJSON<AuthUser>(resp)
  } catch {
    return null
  }
}
