import { authFetch } from './http'

export interface AppStateRecord {
  payload: Record<string, unknown>
  updated_at: string
}

export async function getAppState(): Promise<AppStateRecord> {
  const response = await authFetch('/api/app-state')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `アプリ状態API error: ${response.status}`)
  }
  return await response.json() as AppStateRecord
}

export async function saveAppState(payload: Record<string, unknown>): Promise<AppStateRecord> {
  const response = await authFetch('/api/app-state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `アプリ状態保存API error: ${response.status}`)
  }
  return await response.json() as AppStateRecord
}
