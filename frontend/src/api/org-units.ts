import { authFetch } from './http'

// 全社は全部門を統括するポジション。配下を持たなくてもテナント全体を範囲にする。
export type OrgUnitKind = '全社' | '部門' | '課' | 'チーム' | 'その他'

export interface OrgUnitRecord {
  id: string
  tenant_id: string
  parent_id: string
  name: string
  kind: OrgUnitKind
  sort_order: number
  /** この組織が担当する業務マスターの部門。多対多で紐づく。 */
  department_ids: string[]
  updated_at: string
}

/** tenantIdを渡すと、選択中テナント以外の組織も引ける（所属の設定に使う）。 */
export async function getOrgUnits(tenantId = ''): Promise<OrgUnitRecord[]> {
  const query = tenantId ? `?${new URLSearchParams({ tenant_id: tenantId })}` : ''
  const response = await authFetch(`/api/org-units${query}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `組織マスター取得API error: ${response.status}`)
  }
  return await response.json() as OrgUnitRecord[]
}

export async function saveOrgUnit(payload: {
  id?: string
  parent_id: string
  name: string
  kind: OrgUnitKind
  sort_order: number
  department_ids: string[]
}): Promise<OrgUnitRecord> {
  const { id, ...body } = payload
  const response = await authFetch(id ? `/api/org-units/${encodeURIComponent(id)}` : '/api/org-units', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(detail.detail || `組織マスター保存API error: ${response.status}`)
  }
  return await response.json() as OrgUnitRecord
}

export async function deleteOrgUnit(orgUnitId: string): Promise<void> {
  const response = await authFetch(`/api/org-units/${encodeURIComponent(orgUnitId)}`, { method: 'DELETE' })
  if (!response.ok && response.status !== 404) {
    const detail = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(detail.detail || `組織マスター削除API error: ${response.status}`)
  }
}
