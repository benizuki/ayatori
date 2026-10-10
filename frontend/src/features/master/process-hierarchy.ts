import type { BusinessProcessMaster, BusinessProcessRelation } from '../../models'

export const businessRelationTypes = [
  '前後工程',
  '呼び出し',
  '分岐・バリエーション',
  '例外・差戻し',
  'データ連携',
  '共通システム',
  'その他',
] as const

export function businessDepth(business: BusinessProcessMaster, businesses: BusinessProcessMaster[]) {
  const byId = new Map(businesses.map((item) => [item.id, item]))
  const visited = new Set([business.id])
  let depth = 0
  let parentId = business.parentId ?? ''
  while (parentId && byId.has(parentId) && !visited.has(parentId)) {
    visited.add(parentId)
    depth += 1
    parentId = byId.get(parentId)?.parentId ?? ''
  }
  return depth
}

export function businessDescendantIds(businessId: string, businesses: BusinessProcessMaster[]) {
  const descendants = new Set<string>()
  const pending = [businessId]
  while (pending.length) {
    const parentId = pending.shift()!
    businesses.forEach((item) => {
      if (item.parentId !== parentId || descendants.has(item.id)) return
      descendants.add(item.id)
      pending.push(item.id)
    })
  }
  return descendants
}

export function normalizeBusinessHierarchy(businesses: BusinessProcessMaster[]) {
  const ids = new Set(businesses.map((item) => item.id))
  businesses.forEach((business) => {
    business.parentId = business.parentId?.trim() ?? ''
    if (business.parentId === business.id || !ids.has(business.parentId)) business.parentId = ''
  })
  businesses.forEach((business) => {
    if (businessDescendantIds(business.id, businesses).has(business.id)) business.parentId = ''
  })
  return businesses
}

export function normalizeBusinessRelations(relations: BusinessProcessRelation[], businesses: BusinessProcessMaster[]) {
  const ids = new Set(businesses.map((item) => item.id))
  const seen = new Set<string>()
  return relations.filter((relation) => {
    if (!relation.id || !ids.has(relation.fromBusinessId) || !ids.has(relation.toBusinessId) || relation.fromBusinessId === relation.toBusinessId) return false
    const key = `${relation.fromBusinessId}\u0000${relation.toBusinessId}\u0000${relation.type}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
