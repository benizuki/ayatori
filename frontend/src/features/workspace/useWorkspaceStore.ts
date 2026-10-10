import { reactive, ref } from 'vue'
import {
  businessProcessMasters,
  departments as seedDepartments,
  initialDepartmentIds,
  interviewTopicTemplates as seedInterviewTopicTemplates,
  workFragments as seedWorkFragments,
} from '../../api/initial-data'
import { saveAppState } from '../../api/app-state'
import { getActiveTenantId } from '../../api/http'
import { inferCoverageKey } from '../master/topic-utils'
import { normalizeBusinessHierarchy, normalizeBusinessRelations } from '../master/process-hierarchy'
import { migrateTaskCategory } from '../master/task-categories'
import { normalizeProcessInformation } from '../process/process-information'
import {
  arrangeProcessVertically,
  ensureProcessAssets,
  normalizeProcessLaneLayout,
  verticalLayoutNeedsRepair,
} from '../process/process-model'
import type { InterviewSessionSummary } from '../interviews/types'
import type {
  BusinessProcessMaster,
  BusinessProcessRelation,
  Department,
  InterviewTopic,
  ProcessModel,
  ProcessStep,
  ProcessVersion,
  WorkFragment,
} from '../../models'

/**
 * Extra keys the app shell contributes to the persisted payload. These live in
 * App.vue because they describe the current selection rather than the data set.
 */
export interface AppStatePersistenceOptions {
  extras: () => Record<string, unknown>
  canSave: () => boolean
}

function createWorkspaceStore() {
  const legacyDepartmentIds: Record<string, string> = {
    accounting: initialDepartmentIds.accounting,
    hr: initialDepartmentIds.hr,
    procurement: initialDepartmentIds.procurement,
    it: initialDepartmentIds.it,
  }

  function migrateDepartmentId(departmentId: string) {
    return legacyDepartmentIds[departmentId] ?? departmentId
  }

  function cloneDepartment(department: Department): Department {
    return {
      ...department,
      id: migrateDepartmentId(department.id),
      tenantId: department.tenantId || getActiveTenantId(),
    }
  }

  function loadDepartments(): Department[] {
    return seedDepartments.map(cloneDepartment)
  }

  const departments = reactive<Department[]>(loadDepartments())

  function generateDepartmentId() {
    let id = ''
    do {
      id = crypto.randomUUID().replaceAll('-', '').slice(0, 8)
    } while (departments.some((department) => department.id === id))
    return id
  }

  function normalizeTopic(topic: InterviewTopic): InterviewTopic {
    return {
      ...topic,
      answerType: topic.answerType ?? (inferCoverageKey(topic) === 'volume' ? '数値' : inferCoverageKey(topic) === 'exception' ? '条件分岐' : '自由記述'),
      keywords: topic.keywords ?? [],
      questionExamples: topic.questionExamples ?? [],
      source: topic.source ?? (topic.category === '共通' ? '標準テンプレート' : '手動'),
      coverageKey: inferCoverageKey(topic),
    }
  }

  function cloneTopic(topic: InterviewTopic): InterviewTopic {
    return {
      ...topic,
      keywords: [...(topic.keywords ?? [])],
      questionExamples: [...(topic.questionExamples ?? [])],
    }
  }

  function normalizeMasters(items: BusinessProcessMaster[]): BusinessProcessMaster[] {
    return normalizeBusinessHierarchy(items.map((business) => {
      const storedStatus = String(business.status)
      const status: BusinessProcessMaster['status'] = storedStatus === '公開' || storedStatus === '作成完了'
        ? '作成完了'
        : '作成中'
      return {
        ...business,
        departmentId: migrateDepartmentId(business.departmentId),
        status,
        parentId: business.parentId ?? '',
        interviewTopics: business.interviewTopics.map(normalizeTopic),
        tasks: business.tasks?.map((task) => ({ ...task, category: migrateTaskCategory(task.category) })),
      }
    }))
  }

  function loadBusinessMasters(): BusinessProcessMaster[] {
    return normalizeMasters(structuredClone(businessProcessMasters))
  }

  const businessMasters = ref<BusinessProcessMaster[]>(loadBusinessMasters())
  const businessRelations = ref<BusinessProcessRelation[]>([])

  function setBusinessRelations(relations: BusinessProcessRelation[]) {
    businessRelations.value = normalizeBusinessRelations(structuredClone(relations), businessMasters.value)
  }

  function processModelDepartmentId(model: ProcessModel) {
    const businessDepartmentId = businessMasters.value.find((business) => business.id === model.businessId)?.departmentId
    return migrateDepartmentId(model.departmentId || businessDepartmentId || departments[0]?.id || '')
  }

  /**
   * まだAs-Isが無い業務の初期フロー。開始と終了だけを置き、工程はヒアリングや手入力で足す。
   * 業務名から工程を推測した見本は、実データと見分けが付かないため置かない。
   */
  function createProcessModel(business: BusinessProcessMaster): ProcessModel {
    const lane = business.ownerRole || '業務担当'
    const steps: ProcessStep[] = [
      { id: `${business.id}-start`, label: business.startCondition || '業務開始', actor: lane, lane, type: 'start', x: 0, y: 0 },
      { id: `${business.id}-end`, label: business.endCondition || '業務完了', actor: lane, lane, type: 'end', x: 0, y: 0 },
    ]
    const model: ProcessModel = {
      businessId: business.id,
      departmentId: business.departmentId,
      title: `${business.name} As-Is`,
      layoutDirection: 'vertical',
      lanes: [lane],
      steps,
      connections: [{ id: `flow-${business.id}-start-end`, from: steps[0].id, to: steps[1].id }],
      updatedAt: '未保存',
      reviewStatus: '編集中',
      sourceType: 'master',
    }
    arrangeProcessVertically(model)
    normalizeProcessLaneLayout(model)
    return model
  }

  /** Brings a stored or restored model up to the shape the editor expects. */
  function normalizeProcessModel(model: ProcessModel) {
    model.departmentId = processModelDepartmentId(model)
    // 横向きは廃止。旧データは座標系が異なるので縦向きに並べ直す。
    const legacyHorizontal = model.layoutDirection !== 'vertical'
    model.layoutDirection = 'vertical'
    model.lanes = [...(model.lanes ?? [])]
    model.laneHeights = { ...(model.laneHeights ?? {}) }
    model.laneWidths = { ...(model.laneWidths ?? {}) }
    model.steps.forEach((step) => {
      if (step.childBusinessId && (!businessMasters.value.some((business) => business.id === step.childBusinessId) || step.childBusinessId === model.businessId)) {
        step.childBusinessId = undefined
      }
    })
    ensureProcessAssets(model)
    normalizeProcessInformation(model)
    let arranged = false
    if (legacyHorizontal || (!model.layoutPositionsCustomized && verticalLayoutNeedsRepair(model))) {
      arrangeProcessVertically(model)
      arranged = true
    }
    normalizeProcessLaneLayout(model, { preserveStepPositions: !arranged })
  }

  function loadProcessModels(): Record<string, ProcessModel> {
    // Process data is tenant-scoped and the backend is its single source of truth.
    // LocalStorage used to be read here first, which could resurrect deleted assets
    // when the subsequent backend restore contained an older snapshot.
    const saved: Record<string, ProcessModel> = {}
    businessMasters.value.forEach((business) => {
      saved[business.id] = createProcessModel(business)
      normalizeProcessModel(saved[business.id])
    })
    return saved
  }

  function loadProcessVersions(): Record<string, ProcessVersion[]> {
    return {}
  }

  function loadInterviewSessions(): InterviewSessionSummary[] {
    return []
  }

  /**
   * 業務指定ヒアリングの土台になる共通確認項目。業務ごとの深掘り論点はLLMが
   * 対象業務名から組み立てるため、ここは全業務で同じ項目を返す。
   */
  function commonBusinessInterviewTopics() {
    return seedInterviewTopicTemplates.map((topic) => cloneTopic(normalizeTopic(topic)))
  }

  function loadWorkFragments() {
    return seedWorkFragments.map((item) => ({ ...item, departmentId: migrateDepartmentId(item.departmentId), tools: [...item.tools] }))
  }

  const processModels = ref<Record<string, ProcessModel>>(loadProcessModels())
  const processVersions = ref<Record<string, ProcessVersion[]>>(loadProcessVersions())
  const interviewSessions = ref<InterviewSessionSummary[]>(loadInterviewSessions())
  const workFragments = ref<WorkFragment[]>(loadWorkFragments())

  const snackbar = ref(false)
  const snackbarMessage = ref('保存しました')

  function notify(message: string) {
    snackbarMessage.value = message
    snackbar.value = true
  }

  let appStateSaveTimer: number | undefined
  let appStateSaveChain: Promise<unknown> = Promise.resolve()
  let persistence: AppStatePersistenceOptions = { extras: () => ({}), canSave: () => true }

  function configureAppStatePersistence(options: AppStatePersistenceOptions) {
    persistence = options
  }

  function appStatePayload() {
    return {
      departments,
      workFragments: workFragments.value,
      businessMasters: businessMasters.value,
      businessRelations: businessRelations.value,
      processModels: processModels.value,
      processVersions: processVersions.value,
      ...persistence.extras(),
    }
  }

  function enqueueAppStateSave() {
    if (!persistence.canSave()) return Promise.resolve()
    const payload = appStatePayload()
    const save = appStateSaveChain
      .catch(() => undefined)
      .then(() => saveAppState(payload))
    appStateSaveChain = save.catch(() => undefined)
    return save
  }

  function scheduleAppStateSave() {
    if (!persistence.canSave()) return
    window.clearTimeout(appStateSaveTimer)
    appStateSaveTimer = window.setTimeout(() => {
      void enqueueAppStateSave().catch((error) => {
        console.warn('App state save failed', error)
      })
    }, 250)
  }

  /** Cancels the pending debounce and writes immediately (used before switching tenant). */
  async function flushAppStateSave() {
    window.clearTimeout(appStateSaveTimer)
    if (!persistence.canSave()) return
    await enqueueAppStateSave()
  }

  function persistDepartments() {
    scheduleAppStateSave()
  }

  function persistBusinessMasters() {
    scheduleAppStateSave()
  }

  function persistProcessState() {
    scheduleAppStateSave()
  }

  /** Keeps the in-memory collections ready after a backend restore. */
  function persistAllCollections() {
  }

  /** Replaces every collection with the bundled seed data. */
  function resetCollectionsToSeeds() {
    departments.splice(0, departments.length, ...seedDepartments.map(cloneDepartment))
    interviewSessions.value = []
    workFragments.value = seedWorkFragments.map((item) => ({
      ...item,
      tools: [...item.tools],
    }))
    businessMasters.value = normalizeMasters(structuredClone(businessProcessMasters))
    businessRelations.value = []
    processModels.value = Object.fromEntries(
      businessMasters.value.map((business) => [business.id, createProcessModel(business)]),
    )
    processVersions.value = {}
  }

  return {
    // collections
    departments,
    businessMasters,
    businessRelations,
    processModels,
    processVersions,
    interviewSessions,
    workFragments,
    // department helpers
    migrateDepartmentId,
    cloneDepartment,
    generateDepartmentId,
    // master helpers
    normalizeTopic,
    cloneTopic,
    normalizeMasters,
    setBusinessRelations,
    commonBusinessInterviewTopics,
    // process helpers
    createProcessModel,
    processModelDepartmentId,
    normalizeProcessModel,
    // notifications
    snackbar,
    snackbarMessage,
    notify,
    // persistence
    configureAppStatePersistence,
    scheduleAppStateSave,
    flushAppStateSave,
    persistDepartments,
    persistBusinessMasters,
    persistProcessState,
    persistAllCollections,
    resetCollectionsToSeeds,
  }
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>

let store: WorkspaceStore | null = null

/**
 * Shared workspace data. Created lazily so that `loadInitialData()` has already
 * populated the seed modules by the time the collections are built.
 */
export function useWorkspaceStore(): WorkspaceStore {
  if (!store) store = createWorkspaceStore()
  return store
}
