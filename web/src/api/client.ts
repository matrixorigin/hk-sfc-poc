export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let unauthorizedHandler: ((message: string) => void) | null = null

export function setUnauthorizedHandler(handler: ((message: string) => void) | null) {
  unauthorizedHandler = handler
}

export async function responseError(resp: Response): Promise<string> {
  const raw = await resp.text().catch(() => '')
  if (!raw) return `HTTP ${resp.status}`
  try {
    const data = JSON.parse(raw) as { error?: unknown }
    return typeof data.error === 'string' ? data.error : raw
  } catch {
    return raw
  }
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { skipUnauthorized?: boolean } = {}
): Promise<Response> {
  const resp = await fetch(input, init)
  if (resp.status === 401 && !options.skipUnauthorized) {
    const message = await responseError(resp.clone())
    unauthorizedHandler?.(message)
  }
  return resp
}

export async function parseJSON<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    throw new ApiError(resp.status, await responseError(resp))
  }
  return resp.json() as Promise<T>
}

export function handleXHRUnauthorized(status: number, responseText: string) {
  if (status !== 401) return
  let message = responseText || 'Login expired; please log in again'
  try {
    const data = JSON.parse(responseText) as { error?: unknown }
    if (typeof data.error === 'string') message = data.error
  } catch {
    // Keep the raw response.
  }
  unauthorizedHandler?.(message)
}
