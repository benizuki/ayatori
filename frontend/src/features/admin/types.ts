import type { Stage } from '../../models'

export type DepartmentForm = {
  id: string
  tenantId: string
  name: string
  owner: string
  stage: Stage
  progress: number
  icon: string
  color: string
}

export type DepartmentReferenceCounts = {
  asIsModels: number
  businesses: number
  interviews: number
  /** 残っているヒアリングに属する作業断片。削除の妨げになる。 */
  fragments: number
  /** ヒアリングが残っていない作業断片。業務領域と一緒に削除される。 */
  orphanFragments: number
  /** 業務が残っていないAs-Is。業務領域と一緒に削除される。 */
  orphanAsIsModels: number
}
