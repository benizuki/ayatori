import { getAppState } from '../../api/app-state'
import type {
  BusinessProcessMaster,
  BusinessProcessRelation,
  Department,
  ProcessModel,
  ProcessVersion,
  WorkFragment,
} from '../../models'
import { useAuthSession } from '../admin/useAuthSession'
import { useInterviewContext } from '../interviews/useInterviewContext'
import { useInterviewWorkflow } from '../interviews/useInterviewWorkflow'
import { useProcessEditor } from '../process/useProcessEditor'
import { useWorkspaceStore } from './useWorkspaceStore'

/**
 * テナントの切り替えや初回表示のたびに、アプリ状態をサーバから読み直して各画面の状態へ反映する。
 * 保存データが無いテナントは同梱の初期データへ戻す。
 */
export function useWorkspaceRestore() {
  const {
    departments,
    businessMasters,
    processModels,
    processVersions,
    workFragments,
    migrateDepartmentId,
    cloneDepartment,
    normalizeMasters,
    setBusinessRelations,
    normalizeProcessModel,
    scheduleAppStateSave,
    persistAllCollections,
    resetCollectionsToSeeds,
  } = useWorkspaceStore()
  const { loginRequired } = useAuthSession()
  const { interviewStartStyle, selectedInterviewBusiness, discoveryDepartmentId, activeInterviewId } = useInterviewContext()
  const { processBusinessId, processDepartmentId, pendingProcessDepartmentId } = useProcessEditor()
  const { clearDisplayedInterview, interviewSessionDepartmentId, setInterviewSessionDepartment, syncSavedInterviewSessionSummaries } = useInterviewWorkflow()

  function resetWorkspaceToSeeds() {
    resetCollectionsToSeeds()
    processBusinessId.value = businessMasters.value[0]?.id ?? ''
    processDepartmentId.value = businessMasters.value[0]?.departmentId ?? departments[0]?.id ?? ''
    pendingProcessDepartmentId.value = processDepartmentId.value
    discoveryDepartmentId.value = departments[0]?.id ?? ''
    interviewSessionDepartmentId.value = 'all'
    selectedInterviewBusiness.value = businessMasters.value[0]?.id ?? ''
    clearDisplayedInterview()
  }

  async function restoreAppStateFromBackend() {
    try {
      const record = await getAppState()
      const payload = record.payload
      if (!payload || !Object.keys(payload).length) {
        resetWorkspaceToSeeds()
        scheduleAppStateSave()
        return
      }
      const shouldPersistDepartmentIdMigration = /"(?:id|departmentId|processDepartmentId)":"(?:accounting|hr|procurement|it)"/.test(JSON.stringify(payload))
        || Object.values((payload.processModels ?? {}) as Record<string, Partial<ProcessModel>>).some((model) => !model.departmentId)
        || Object.values((payload.processModels ?? {}) as Record<string, Partial<ProcessModel>>).some((model) => model.layoutDirection !== 'vertical')
        || (Array.isArray(payload.departments) && (payload.departments as Department[]).some((department) => !department.tenantId))
      // ヒアリングの要約はサーバの記録から組み立てる。旧版が保存した要約は読まず、次の保存で取り除く。
      const shouldDropLegacyInterviewSummaries = 'interviewSessions' in payload
      // 0件も利用者が選んだ状態なので、空配列でも保存内容をそのまま反映する。
      if (Array.isArray(payload.departments)) {
        departments.splice(0, departments.length, ...(payload.departments as Department[]).map(cloneDepartment))
      }
      if (Array.isArray(payload.workFragments)) {
        workFragments.value = (payload.workFragments as WorkFragment[]).map((fragment) => ({
          ...fragment,
          departmentId: migrateDepartmentId(fragment.departmentId),
        }))
      }
      if (Array.isArray(payload.businessMasters)) businessMasters.value = normalizeMasters(payload.businessMasters as BusinessProcessMaster[])
      setBusinessRelations(Array.isArray(payload.businessRelations) ? payload.businessRelations as BusinessProcessRelation[] : [])
      if (payload.processModels && typeof payload.processModels === 'object') {
        processModels.value = payload.processModels as Record<string, ProcessModel>
        Object.values(processModels.value).forEach(normalizeProcessModel)
      }
      if (payload.processVersions && typeof payload.processVersions === 'object') processVersions.value = payload.processVersions as Record<string, ProcessVersion[]>
      if (!loginRequired.value && typeof payload.activeInterviewId === 'string') activeInterviewId.value = payload.activeInterviewId
      if (typeof payload.processBusinessId === 'string' && processModels.value[payload.processBusinessId]) processBusinessId.value = payload.processBusinessId
      if (typeof payload.processDepartmentId === 'string') processDepartmentId.value = migrateDepartmentId(payload.processDepartmentId)
      if (payload.interviewStartStyle === 'free' || payload.interviewStartStyle === 'guided') interviewStartStyle.value = payload.interviewStartStyle
      if (typeof payload.selectedInterviewBusiness === 'string') selectedInterviewBusiness.value = payload.selectedInterviewBusiness
      if (!businessMasters.value.some((business) => business.id === selectedInterviewBusiness.value)) selectedInterviewBusiness.value = businessMasters.value[0]?.id ?? ''
      persistAllCollections()
      if (!departments.some((department) => department.id === discoveryDepartmentId.value)) discoveryDepartmentId.value = departments[0]?.id ?? ''
      if (interviewSessionDepartmentId.value !== 'all' && !departments.some((department) => department.id === interviewSessionDepartmentId.value)) setInterviewSessionDepartment('all')
      if (!processModels.value[processBusinessId.value]) processBusinessId.value = Object.keys(processModels.value)[0] ?? processBusinessId.value
      processDepartmentId.value = processModels.value[processBusinessId.value]?.departmentId ?? processDepartmentId.value
      pendingProcessDepartmentId.value = processDepartmentId.value
      if (shouldPersistDepartmentIdMigration || shouldDropLegacyInterviewSummaries) scheduleAppStateSave()
    } catch (error) {
      console.warn('App state restore failed', error)
    } finally {
      await syncSavedInterviewSessionSummaries()
    }
  }

  return { resetWorkspaceToSeeds, restoreAppStateFromBackend }
}
