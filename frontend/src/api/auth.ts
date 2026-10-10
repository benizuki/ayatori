import { authFetch } from './http'

export type AuthRole = 'admin' | 'user' | 'viewer'

/**
 * システムロール。admin=全テナントの管理、viewer=全テナントの閲覧、
 * none=システム権限なし（所属テナントの権限だけで動く）。
 */
export type SystemRole = 'none' | 'admin' | 'viewer'

export interface TenantMembership {
  tenant_id: string
  role: AuthRole
  /** 組織はテナントごとに別なので、所属もテナントごとに持つ。 */
  org_unit_id?: string
}

export interface TenantRecord {
  id: string
  name: string
  description: string
  enabled: boolean
  created_at?: string | null
  updated_at?: string | null
}

export interface AuthConfig {
  google_oauth_enabled: boolean
  google_client_id: string
  // メールアドレスだけで入れるお試しログイン（Docker Composeの体験用）
  demo_login_enabled?: boolean
}

export interface AuthUser {
  email: string
  name: string
  google_subject?: string | null
  oauth_name?: string | null
  oauth_picture?: string | null
  department?: string | null
  department_id?: string | null
  org_unit_id?: string | null
  role: SystemRole
  tenant_memberships: TenantMembership[]
}

export interface AuthLoginResponse {
  token?: string | null
  user: AuthUser
}

export interface UserMasterEntry {
  email: string
  name: string
  department?: string | null
  department_id?: string | null
  org_unit_id?: string | null
  role: SystemRole
  tenant_memberships: TenantMembership[]
  enabled: boolean
  google_subject?: string | null
  created_at?: string | null
  updated_at?: string | null
}

export async function getAuthConfig(): Promise<AuthConfig> {
  const response = await fetch('/api/auth/config')
  if (!response.ok) throw new Error('認証設定を取得できませんでした。')
  return await response.json() as AuthConfig
}

export async function loginWithGoogleCredential(credential: string): Promise<AuthLoginResponse> {
  const response = await fetch('/api/auth/google', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `GoogleログインAPI error: ${response.status}`)
  }
  const result = await response.json() as AuthLoginResponse
  return result
}

export async function loginWithDemoEmail(email: string): Promise<AuthLoginResponse> {
  const response = await fetch('/api/auth/demo', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string | { msg?: string }[] }
    const detail = Array.isArray(body.detail) ? 'メールアドレスの形式が正しくありません。' : body.detail
    throw new Error(detail || `お試しログインAPI error: ${response.status}`)
  }
  return await response.json() as AuthLoginResponse
}

export async function getCurrentUser(): Promise<AuthUser> {
  const response = await authFetch('/api/auth/me')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ログイン状態確認API error: ${response.status}`)
  }
  return await response.json() as AuthUser
}

export async function logout(): Promise<void> {
  await authFetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
}

export async function getUsers(): Promise<UserMasterEntry[]> {
  const response = await authFetch('/api/users')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ユーザー一覧API error: ${response.status}`)
  }
  return await response.json() as UserMasterEntry[]
}

export async function getTenants(): Promise<TenantRecord[]> {
  const response = await authFetch('/api/tenants')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `テナント一覧API error: ${response.status}`)
  }
  return await response.json() as TenantRecord[]
}

export async function saveTenant(tenant: TenantRecord, originalId?: string): Promise<TenantRecord> {
  const response = await authFetch(originalId ? `/api/tenants/${encodeURIComponent(originalId)}` : '/api/tenants', {
    method: originalId ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tenant),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `テナント保存API error: ${response.status}`)
  }
  return await response.json() as TenantRecord
}

export async function moveDepartmentToTenant(
  departmentId: string,
  targetTenantId: string,
): Promise<{ department_id: string; source_tenant_id: string; target_tenant_id: string; moved_interview_ids: string[] }> {
  const response = await authFetch(`/api/departments/${encodeURIComponent(departmentId)}/tenant`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_tenant_id: targetTenantId }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `部門のテナント変更API error: ${response.status}`)
  }
  return await response.json()
}

export async function saveUser(user: UserMasterEntry, originalEmail?: string): Promise<UserMasterEntry> {
  const response = await authFetch(originalEmail ? `/api/users/${encodeURIComponent(originalEmail)}` : '/api/users', {
    method: originalEmail ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(user),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ユーザー保存API error: ${response.status}`)
  }
  return await response.json() as UserMasterEntry
}

export async function deleteUser(email: string): Promise<void> {
  const response = await authFetch(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ユーザー削除API error: ${response.status}`)
  }
}
