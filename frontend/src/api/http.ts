// Authentication is held by an HttpOnly cookie and sent automatically by the
// browser. The active tenant is only a non-sensitive UI preference; the
// backend still validates tenant access on every request.
const ACTIVE_TENANT_COOKIE_NAME = 'ayatori_active_tenant'

const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function readCookie(name: string) {
  if (typeof document === 'undefined') return ''
  const prefix = `${name}=`
  const value = document.cookie
    .split('; ')
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length)
  return value ? decodeURIComponent(value) : ''
}

function writeCookie(name: string, value: string) {
  if (typeof document === 'undefined') return
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${PREFERENCE_COOKIE_MAX_AGE}; Path=/; SameSite=Lax`
}

let activeTenantId = readCookie(ACTIVE_TENANT_COOKIE_NAME) || 'default'

export function getActiveTenantId() {
  return activeTenantId
}

export function setActiveTenantId(tenantId: string) {
  activeTenantId = tenantId.trim().toLowerCase() || 'default'
  writeCookie(ACTIVE_TENANT_COOKIE_NAME, activeTenantId)
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {})
  headers.set('X-Tenant-ID', activeTenantId)
  return fetch(input, { ...init, credentials: init.credentials ?? 'include', headers })
}

export async function postJson<T>(path: string, payload: unknown, timeout: number, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeout)
  const abortRequest = () => controller.abort()
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort()
    else externalSignal.addEventListener('abort', abortRequest, { once: true })
  }
  try {
    const response = await authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string }
      throw new Error(body.detail || `LLM API error: ${response.status}`)
    }
    return await response.json() as T
  } finally {
    window.clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortRequest)
  }
}

export function jsonPut(body: unknown): RequestInit {
  return { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
