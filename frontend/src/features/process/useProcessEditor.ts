import { computeStepHeat, findHandoffConnectionIds } from './process-insight-model'
import { emptyReview, type ImprovementReview } from './process-improvement'
import { computed, ref } from 'vue'
import { initialDepartmentIds } from '../../api/initial-data'
import { getSavedInterviewSession, type SavedInterviewSession } from '../../api/interview'
import { generateProcessAiOpportunities } from '../../api/process'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { useInterviewContext } from '../interviews/useInterviewContext'
import { useAuthSession } from '../admin/useAuthSession'
import { emptyBusinessMaster } from '../master/business-master'
import type { ProcessHistoryMessage, ProcessHistorySession } from '../interviews/types'
import { useProcessBitmap } from './composables/useProcessBitmap'
import { useProcessAssets } from './useProcessAssets'
import { useProcessCanvas } from './useProcessCanvas'
import { useProcessPropertiesPanel } from './useProcessPropertiesPanel'
import { useProcessLanes } from './useProcessLanes'
import { buildConnectorPaths, buildProcessAssetAnnotations } from './process-geometry'
import { cloneInformation, normalizeProcessInformation } from './process-information'
import {
  buildProcessAiEvidence,
  buildProcessAiProposals,
  toProcessAiProposalSet,
} from './process-ai-opportunity-model'
import {
  arrangeProcessVertically,
  cloneAssetLinks,
  cloneAssets,
  cloneConnections,
  cloneProcessStep,
  ensureProcessAssets,
  normalizeProcessLaneLayout,
  PROCESS_LANE_TOP,
  PROCESS_VERTICAL_FLOW_TOP,
  PROCESS_VERTICAL_LANE_BASE_WIDTH,
  PROCESS_VERTICAL_LEVEL_GAP,
  PROCESS_VERTICAL_TRACK_GAP,
  PROCESS_SYSTEM_LANE,
  isSystemAsset,
  processLaneLayouts,
  readableTaskWidth,
  setStepVerticalLanePosition,
  shiftContentsWithLaneOffsets,
  verticalAssetSideRows,
  verticalLayoutNeedsRepair,
} from './process-model'
import type {
  ProcessStep,
  ProcessVersion,
} from '../../models'

/**
 * Everything the As-Is process editor owns: the selected business, canvas and
 * lane geometry, asset management, versioning.
 */
function createProcessEditor() {
  const {
    departments,
    businessMasters,
    processModels,
    processVersions,
    workFragments,
    interviewSessions,
    notify,
    createProcessModel,
    processModelDepartmentId,
    migrateDepartmentId,
    persistProcessState,
    flushAppStateSave,
    persistBusinessMasters,
  } = useWorkspaceStore()
  const { canEdit } = useAuthSession()
  const { selectedInterviewBusiness, activeInterviewFragments, activeInterviewId, messages } = useInterviewContext()

  /** Bound by ProcessEditorPage via template refs. */
  const layoutElement = ref<HTMLElement | null>(null)
  const svgElement = ref<SVGSVGElement | null>(null)

  // --- selection / canvas state -------------------------------------------
  const selectedStep = ref('register')
  const processBusinessId = ref('ap-invoice')
  const processDepartmentId = ref(migrateDepartmentId(initialDepartmentIds.accounting))
  const pendingProcessDepartmentId = ref(processDepartmentId.value)
  const processZoom = ref(1)
  const showProcessAssets = ref(true)
  const showBottlenecks = ref(true)
  const showHandoffs = ref(true)
  const processTool = ref<'select' | 'pan' | 'connect'>('select')
  const processPropertiesOpen = ref(true)
  const connectionFrom = ref('')
  const processDetailsDialog = ref(false)
  const processDetailsError = ref('')
  const processDetailsForm = ref({ title: '', departmentId: '' })
  const versionDialog = ref(false)
  const evidenceDialog = ref(false)
  const interviewHistoryDialog = ref(false)
  const interviewHistoryLoading = ref(false)
  const interviewHistoryError = ref('')
  const interviewHistorySessions = ref<ProcessHistorySession[]>([])
  const selectedHistorySessionId = ref('')

  if (!processModels.value[processBusinessId.value]) processBusinessId.value = Object.keys(processModels.value)[0] ?? 'ap-invoice'
  processDepartmentId.value = processModels.value[processBusinessId.value]?.departmentId ?? processDepartmentId.value
  pendingProcessDepartmentId.value = processDepartmentId.value

  // --- derived model ------------------------------------------------------
  const selectedProcessBusiness = computed(() => businessMasters.value.find((item) => item.id === processBusinessId.value) ?? businessMasters.value[0] ?? emptyBusinessMaster())
  const activeProcessModel = computed(() => processModels.value[processBusinessId.value])
  const activeProcessSteps = computed(() => activeProcessModel.value?.steps ?? [])
  const activeProcessAssets = computed(() => activeProcessModel.value?.assets ?? [])
  // 何もない所をクリックして選択を外したら（空文字）、どのステップも選ばない。
  const selected = computed(() => (selectedStep.value
    ? activeProcessSteps.value.find((step) => step.id === selectedStep.value) ?? activeProcessSteps.value.find((step) => step.type === 'task') ?? activeProcessSteps.value[0]
    : undefined))
  const selectedConnections = computed(() => activeProcessModel.value?.connections.filter((connection) => connection.from === selected.value?.id || connection.to === selected.value?.id) ?? [])
  const selectedInputConnections = computed(() => selectedConnections.value.filter((connection) => connection.to === selected.value?.id))
  const selectedOutputConnections = computed(() => selectedConnections.value.filter((connection) => connection.from === selected.value?.id))
  const selectedStepAssetLinks = computed(() => (activeProcessModel.value?.assetLinks ?? []).filter((link) => link.stepId === selected.value?.id))
  const availableProcessLanes = computed(() => [...new Set([
    ...(activeProcessModel.value?.lanes ?? []),
    ...activeProcessSteps.value.map((step) => step.lane ?? step.actor),
  ].map((lane) => lane?.trim()).filter((lane): lane is string => Boolean(lane)))])
  const activeVersions = computed(() => processVersions.value[processBusinessId.value] ?? [])
  const activeProcessLaneLayouts = computed(() => activeProcessModel.value ? processLaneLayouts(activeProcessModel.value) : [])
  /**
   * キャンバスの最小の大きさ。端にあるステップやアセットを内側へドラッグすると図が縮み、
   * スクロール位置が押し戻されて図全体がずれ、カーソルと動かしている物がずれる。
   * ドラッグを始めたときの大きさを、同じ業務を開いている間は下回らないようにする。
   */
  const canvasSizeFloor = ref({ businessId: '', width: 0, height: 0 })
  const canvasFloorFor = (key: 'width' | 'height') => (
    canvasSizeFloor.value.businessId === activeProcessModel.value?.businessId ? canvasSizeFloor.value[key] : 0
  )
  const processCanvasWidth = computed(() => {
    const finalLane = activeProcessLaneLayouts.value.at(-1)
    const assetRightEdge = Math.max(0, ...processAssetAnnotations.value.map((annotation) => annotation.x + annotation.width + 25))
    return Math.max(600, canvasFloorFor('width'), finalLane ? finalLane.x + finalLane.width + 25 : 600, assetRightEdge, ...activeProcessSteps.value.map((step) => step.x + (step.width ?? 50) + 50))
  })
  const processCanvasHeight = computed(() => Math.max(720, canvasFloorFor('height'), ...activeProcessSteps.value.map((step) => {
    const assetRows = activeProcessModel.value ? verticalAssetSideRows(activeProcessModel.value, step.id) : 0
    return step.y + 120 + Math.max(0, assetRows - 4) * 15
  })))
  function holdCanvasSize() {
    canvasSizeFloor.value = {
      businessId: activeProcessModel.value?.businessId ?? '',
      width: processCanvasWidth.value,
      height: processCanvasHeight.value,
    }
  }
  /**
   * 未保存の編集がある業務。キャンバス上の編集は「As-Isを保存」まで書き込まないため、
   * どの業務に未反映の変更が残っているかを覚えておく。
   */
  const unsavedProcessBusinessIds = ref<Record<string, boolean>>({})
  const hasUnsavedProcessChanges = computed(() => Boolean(unsavedProcessBusinessIds.value[processBusinessId.value]))
  const unsavedProcessCount = computed(() => Object.keys(unsavedProcessBusinessIds.value).length)

  function markProcessDirty(businessId = processBusinessId.value) {
    if (!businessId || unsavedProcessBusinessIds.value[businessId]) return
    unsavedProcessBusinessIds.value = { ...unsavedProcessBusinessIds.value, [businessId]: true }
  }

  /**
   * ボタン操作による確定。アプリ状態はまとめて書かれるため、キャンバス上の
   * 未保存編集もここで一緒に書き込まれる。書き込みが通ってから表示を消す。
   */
  async function commitProcessState(businessId = processBusinessId.value) {
    persistProcessState()
    try {
      await flushAppStateSave()
      clearProcessDirty(businessId)
    } catch (error) {
      console.warn('Process state save failed', error)
    }
  }

  function clearProcessDirty(businessId = processBusinessId.value) {
    if (!unsavedProcessBusinessIds.value[businessId]) return
    const { [businessId]: _saved, ...rest } = unsavedProcessBusinessIds.value
    unsavedProcessBusinessIds.value = rest
  }

  /**
   * ECRS業務改善提案。既定はルールによるたたき台。検討結果と根拠をAs-Isに保存する。
   * 生成結果は業務ごとに保持し、タブを切り替えるたびに呼び直さない。
   */
  const proposalFocusStepId = ref('')
  const proposalViewRequested = ref(false)
  const improvementTasks = computed(() => businessMasters.value.find((business) => business.id === processBusinessId.value)?.tasks ?? [])
  const improvementEvidenceKey = computed(() => activeProcessModel.value ? JSON.stringify(buildProcessAiEvidence(activeProcessModel.value, improvementTasks.value)) : '')
  const aiProposalGenerating = ref(false)
  const aiProposalErrors = ref<Record<string, string>>({})
  const aiProposalError = computed(() => aiProposalErrors.value[processBusinessId.value] ?? '')
  const ruleAiProposalSet = computed(() => (
    activeProcessModel.value
      ? buildProcessAiProposals(activeProcessModel.value, improvementTasks.value)
      : { proposals: [], recommendedCount: 0, agentCandidateCount: 0, assistCandidateCount: 0, automationCandidateCount: 0, needsInfoCount: 0, source: 'rule' as const }
  ))
  const activeAiProposalSet = computed(() => (
    activeProcessModel.value?.improvementPlan?.proposalSet ?? ruleAiProposalSet.value
  ))

  const improvementReviews = computed(() => activeProcessModel.value?.improvementPlan?.reviews ?? {})
  const improvementStale = computed(() => Boolean(activeProcessModel.value?.improvementPlan && activeProcessModel.value.improvementPlan.evidenceKey !== improvementEvidenceKey.value))

  function ensureImprovementPlan() {
    const model = activeProcessModel.value
    if (!model || !canEdit.value) return
    model.improvementPlan ??= { evidenceKey: improvementEvidenceKey.value, proposalSet: activeAiProposalSet.value, reviews: {}, baselineHours: null }
    markProcessDirty()
    return model.improvementPlan
  }

  function reviewImprovement(id: string, changes: Partial<ImprovementReview>) {
    if (!activeAiProposalSet.value.proposals.some((proposal) => proposal.id === id)) return
    const plan = ensureImprovementPlan()
    if (plan) plan.reviews[id] = { ...emptyReview(), ...plan.reviews[id], ...changes }
  }

  async function generateAiProposals() {
    const model = activeProcessModel.value
    if (!model || aiProposalGenerating.value || !canEdit.value) return
    const businessId = processBusinessId.value
    const evidence = buildProcessAiEvidence(model, improvementTasks.value)
    const evidenceKey = JSON.stringify(evidence)
    aiProposalGenerating.value = true
    aiProposalErrors.value[businessId] = ''
    try {
      const response = await generateProcessAiOpportunities(evidence)
      if (processModels.value[businessId] !== model) return
      model.improvementPlan = { evidenceKey, proposalSet: toProcessAiProposalSet(response), reviews: {}, baselineHours: model.improvementPlan?.baselineHours ?? null }
      markProcessDirty(businessId)
      notify('業務改善提案を生成しました。「As-Isを保存」で保存できます')
    } catch (error) {
      // 生成に失敗してもルール判定の結果は残す。画面を空にしない。
      if (processModels.value[businessId] === model) aiProposalErrors.value[businessId] = error instanceof Error ? error.message : '業務改善提案を生成できませんでした'
    } finally {
      aiProposalGenerating.value = false
    }
  }

  const { copyingProcessBitmap, copyProcessAsBitmap } = useProcessBitmap({
    svgElement,
    canvasWidth: processCanvasWidth,
    canvasHeight: processCanvasHeight,
    notify,
  })
  const processSvgStyle = computed(() => ({ width: `${processCanvasWidth.value * processZoom.value}px`, height: `${processCanvasHeight.value * processZoom.value}px` }))
  const processLayoutStyle = computed(() => ({ '--process-properties-width': `${processPropertiesWidth.value}px` }))
  const processSwimlanes = computed(() => {
    const lanes = activeProcessModel.value?.lanes ?? []
    const hasSyntheticSystemLane = activeProcessLaneLayouts.value.some((lane) => lane.label === PROCESS_SYSTEM_LANE)
    if (lanes.length || hasSyntheticSystemLane) {
      return activeProcessLaneLayouts.value.map((lane) => ({
        ...lane,
        y: PROCESS_LANE_TOP,
        height: processCanvasHeight.value - PROCESS_LANE_TOP - 25,
        labelX: lane.x + 12,
        labelY: PROCESS_LANE_TOP + 22,
      }))
    }
    return [{ label: '業務担当', x: 18, y: PROCESS_LANE_TOP, width: processCanvasWidth.value - 36, height: processCanvasHeight.value - 50, maxTrack: 0, trackGap: PROCESS_VERTICAL_TRACK_GAP, assetSideReserve: 0, minimumSize: PROCESS_VERTICAL_LANE_BASE_WIDTH, labelX: 30, labelY: 47 }]
  })

  const processAssetAnnotations = computed(() => buildProcessAssetAnnotations({
    model: activeProcessModel.value,
    steps: activeProcessSteps.value,
    assets: activeProcessAssets.value,
    laneLayouts: activeProcessLaneLayouts.value,
    processCanvasHeight: processCanvasHeight.value,
  }))
  const persistentProcessAssetAnnotations = computed(() => processAssetAnnotations.value.filter((annotation) => isSystemAsset(annotation.asset)))
  const visibleProcessAssetAnnotations = computed(() => showProcessAssets.value
    ? processAssetAnnotations.value
    : persistentProcessAssetAnnotations.value)
  const stepHeat = computed(() => computeStepHeat(activeProcessSteps.value))
  const handoffConnectionIds = computed(() => findHandoffConnectionIds(activeProcessModel.value))
  // ノードの横に付くアセット札も、接続線が突き抜けないよう障害物として渡す。
  const processConnectorPaths = computed(() => buildConnectorPaths(
    activeProcessModel.value?.connections ?? [],
    activeProcessSteps.value,
    visibleProcessAssetAnnotations.value
      .filter((annotation) => !isSystemAsset(annotation.asset))
      .map((annotation) => ({ id: annotation.stepId, left: annotation.x - 4, right: annotation.x + annotation.width + 4, top: annotation.y - 4, bottom: annotation.y + annotation.height + 4 })),
  ))

  const processDepartmentItems = computed(() => departments.flatMap((department) => {
    const count = Object.values(processModels.value).filter((model) => processModelDepartmentId(model) === department.id).length
    return count ? [{ title: department.name, value: department.id, count }] : []
  }))
  const filteredProcessSelectItems = computed(() => Object.values(processModels.value).flatMap((model) => {
    return processModelDepartmentId(model) === processDepartmentId.value ? [{ title: model.title, value: model.businessId }] : []
  }))
  const selectedProcessDepartmentName = computed(() => departments.find((department) => department.id === activeProcessModel.value?.departmentId)?.name ?? '部門未設定')
  const activeProcessSourceFragmentIds = computed(() => {
    const model = activeProcessModel.value
    if (!model) return new Set<string>()
    const matchingBusiness = businessMasters.value.find((business) => business.id === model.businessId)
    return new Set([
      ...(matchingBusiness?.sourceFragmentIds ?? []),
      ...model.steps.flatMap((step) => step.sourceFragmentIds ?? []),
      ...(model.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
    ])
  })
  const selectedProcessSourceFragments = computed(() => {
    const sourceIds = activeProcessSourceFragmentIds.value
    if (sourceIds.size) return workFragments.value.filter((fragment) => sourceIds.has(fragment.id))
    if (processBusinessId.value === selectedInterviewBusiness.value) return activeInterviewFragments.value
    return []
  })
  const selectedProcessInterviewSessionIds = computed(() => {
    const refinementIds = interviewSessions.value
      .filter((session) => session.sourceProcessId === activeProcessModel.value?.businessId)
      .map((session) => session.id)
    const refinementIdSet = new Set(refinementIds)
    const evidenceIds = [
      activeProcessModel.value?.sourceInterviewId,
      ...selectedProcessSourceFragments.value.map((fragment) => fragment.interviewId),
    ].filter((id): id is string => Boolean(id))
    const initialIds = evidenceIds.filter((id) => !refinementIdSet.has(id))
    return [...new Set([...initialIds, ...refinementIds])]
  })
  const selectedProcessHistorySession = computed(() => interviewHistorySessions.value.find((session) => session.id === selectedHistorySessionId.value) ?? interviewHistorySessions.value[0])
  const selectedHistorySourceFragments = computed(() => workFragments.value.filter((fragment) => fragment.interviewId === selectedProcessHistorySession.value?.id))

  function processTimestamp() {
    return new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const {
    laneEditorOpen,
    newProcessLaneName,
    laneManagementDialog,
    laneDeleteDialog,
    laneDeleteDestination,
    laneBulkMoveFrom,
    laneBulkMoveTo,
    managedNewLaneName,
    laneDeleteTarget,
    laneDeleteStepCount,
    ensureProcessLanes,
    assignSelectedStepToLane,
    addProcessLane,
    openLaneManagement,
    renameProcessLane,
    moveProcessLane,
    addManagedProcessLane,
    requestDeleteProcessLane,
    confirmDeleteProcessLane,
    moveAllLaneSteps,
    saveLaneManagement,
  } = useProcessLanes({ activeProcessModel, activeProcessSteps, selected, availableProcessLanes, saveProcess })

  const {
    assetManagementDialog,
    selectedAssetId,
    assetSearch,
    assetLinkCandidateId,
    assetExtractionDialog,
    assetExtractionLoading,
    assetExtractionError,
    assetExtractionFileName,
    assetExtractionDocumentType,
    assetExtractionSummary,
    assetExtractionWarnings,
    assetExtractionFields,
    selectedAssetExtractionFields,
    selectedManagedAsset,
    filteredProcessAssets,
    availableAssetsForSelectedStep,
    openAssetManagement,
    extractInformationItems,
    applyExtractedInformationItems,
    addOperationalAsset,
    deleteOperationalAsset,
    linkAssetToSelectedStep,
    unlinkAssetFromSelectedStep,
    syncSelectedStepSystemAssets,
    reflowProcessAssets,
  } = useProcessAssets({ activeProcessModel, activeProcessAssets, selected, selectedStepAssetLinks, markProcessDirty })

  const {
    processPropertiesWidth,
    resizingProcessProperties,
    startProcessPropertiesResize,
    moveProcessPropertiesResize,
    endProcessPropertiesResize,
    resetProcessPropertiesWidth,
    resizeProcessPropertiesByKeyboard,
  } = useProcessPropertiesPanel(layoutElement)

  const {
    resizingLaneLabel,
    panning,
    startLaneResize,
    startNodeDrag,
    startAssetDrag,
    startConnectionAnchorDrag,
    openAssetAnnotation,
    startCanvasPan,
    moveOnCanvas,
    endCanvasPointer,
  } = useProcessCanvas({
    processTool,
    selectedStep,
    processPropertiesOpen,
    processZoom,
    svgElement,
    activeProcessModel,
    activeProcessSteps,
    activeProcessAssets,
    activeProcessLaneLayouts,
    processCanvasWidth,
    processCanvasHeight,
    holdCanvasSize,
    markProcessDirty,
    openAssetManagement,
  })

  function selectProcessBusiness(id: string) {
    processBusinessId.value = id
    if (!processModels.value[id]) {
      const business = businessMasters.value.find((item) => item.id === id)
      if (business) {
        processModels.value[id] = createProcessModel(business)
        ensureProcessAssets(processModels.value[id])
        normalizeProcessInformation(processModels.value[id])
        normalizeProcessLaneLayout(processModels.value[id])
      }
    }
    selectedStep.value = processModels.value[id]?.steps.find((step) => step.type === 'task')?.id ?? processModels.value[id]?.steps[0]?.id ?? ''
    const departmentId = processModels.value[id]?.departmentId
    if (departmentId) {
      processDepartmentId.value = departmentId
      pendingProcessDepartmentId.value = departmentId
    }
    connectionFrom.value = ''
    processPropertiesOpen.value = true
  }

  function selectProcessDepartment(id: string) {
    processDepartmentId.value = id
    const currentProcessDepartment = processModels.value[processBusinessId.value]?.departmentId
    if (currentProcessDepartment === id) return
    const firstBusiness = Object.values(processModels.value).find((model) => processModelDepartmentId(model) === id)
    if (firstBusiness) selectProcessBusiness(firstBusiness.businessId)
  }

  function historySessionFromSaved(id: string, saved: SavedInterviewSession | null): ProcessHistorySession {
    const sessionFragments = workFragments.value.filter((fragment) => fragment.interviewId === id)
    const localSession = interviewSessions.value.find((session) => session.id === id)
    const isRefinement = localSession?.sourceProcessId === activeProcessModel.value?.businessId
    const hasUnappliedFragments = sessionFragments.some((fragment) => !activeProcessSourceFragmentIds.value.has(fragment.id))
    const participant = saved?.session_state.participant || sessionFragments[0]?.participant || '担当者未確認'
    const department = saved?.session_state.department || departments.find((item) => item.id === sessionFragments[0]?.departmentId)?.name || '部門未確認'
    const localMessages = id === activeInterviewId.value ? messages.value.map((message): ProcessHistoryMessage => ({
      role: message.role === 'ai' ? 'assistant' : 'user',
      text: message.text,
      speaker: message.speaker,
      time: message.time,
    })) : []
    const savedMessages = saved?.messages.map((message): ProcessHistoryMessage => ({
      role: message.role,
      text: message.text,
      speaker: message.role === 'assistant' ? 'Ayatori AI' : `${participant}｜${department}`,
      time: '保存済み',
      attachments: [...(message.attachments ?? [])],
    })) ?? []
    return {
      id,
      kind: isRefinement ? 'refinement' : 'initial',
      canUpdateAsIs: Boolean(
        isRefinement
        && (hasUnappliedFragments || localSession?.status === '完了')
      ),
      participant,
      department,
      phase: saved?.session_state.phase ?? '記録のみ',
      completionScore: saved?.session_state.completion_score ?? 0,
      updatedAt: saved?.updated_at || sessionFragments.at(-1)?.sourceTime || '更新日時不明',
      evidence: [...(saved?.session_state.evidence ?? [])],
      messages: savedMessages.length ? savedMessages : localMessages,
      saved: Boolean(saved),
    }
  }

  async function openProcessInterviewHistory() {
    interviewHistoryDialog.value = true
    interviewHistoryLoading.value = true
    interviewHistoryError.value = ''
    const sessionIds = selectedProcessInterviewSessionIds.value
    if (!sessionIds.length) {
      interviewHistorySessions.value = []
      selectedHistorySessionId.value = ''
      interviewHistoryLoading.value = false
      return
    }
    const failures: string[] = []
    const sessions = await Promise.all(sessionIds.map(async (id) => {
      try {
        return historySessionFromSaved(id, await getSavedInterviewSession(id))
      } catch {
        failures.push(id)
        return historySessionFromSaved(id, null)
      }
    }))
    interviewHistorySessions.value = sessions
    selectedHistorySessionId.value = sessions[0]?.id ?? ''
    interviewHistoryError.value = failures.length ? `${failures.length}件の保存済み会話を読み込めませんでした。作業断片の根拠は確認できます。` : ''
    interviewHistoryLoading.value = false
  }

  function historyFragmentStepNames(fragmentId: string) {
    return activeProcessSteps.value.filter((step) => step.sourceFragmentIds?.includes(fragmentId)).map((step) => step.label)
  }

  function archiveProcessVersion(label: string) {
    const model = activeProcessModel.value
    if (!model) return
    const version: ProcessVersion = {
      id: `version-${Date.now()}`,
      businessId: model.businessId,
      savedAt: processTimestamp(),
      label,
      steps: model.steps.map(cloneProcessStep),
      connections: cloneConnections(model.connections),
      layoutDirection: 'vertical',
      lanes: [...(model.lanes ?? [])],
      laneHeights: { ...(model.laneHeights ?? {}) },
      laneWidths: { ...(model.laneWidths ?? {}) },
      layoutPositionsCustomized: model.layoutPositionsCustomized,
      assets: cloneAssets(model.assets),
      assetLinks: cloneAssetLinks(model.assetLinks),
      information: cloneInformation(model.information),
      suppressedAssetKeys: [...(model.suppressedAssetKeys ?? [])],
      suppressedAssetLinkKeys: [...(model.suppressedAssetLinkKeys ?? [])],
    }
    processVersions.value[model.businessId] = [version, ...(processVersions.value[model.businessId] ?? [])].slice(0, 10)
  }

  function normalizeProcessTitle() {
    const model = activeProcessModel.value
    if (!model) return
    model.title = model.title.trim() || `${selectedProcessBusiness.value.name} (As-Is)`
  }

  function openProcessDetailsDialog() {
    const model = activeProcessModel.value
    if (!model) return
    processDetailsForm.value = {
      title: model.title,
      departmentId: model.departmentId,
    }
    processDetailsError.value = ''
    processDetailsDialog.value = true
  }

  function saveProcessDetails() {
    if (!canEdit.value) return
    const model = activeProcessModel.value
    const title = processDetailsForm.value.title.trim()
    const departmentId = processDetailsForm.value.departmentId
    if (!model) return
    if (!title) {
      processDetailsError.value = '業務名を入力してください。'
      return
    }
    if (!departments.some((department) => department.id === departmentId)) {
      processDetailsError.value = '紐付ける部門を選択してください。'
      return
    }
    model.title = title
    pendingProcessDepartmentId.value = departmentId
    processDetailsError.value = ''
    saveProcess()
    processDetailsDialog.value = false
  }

  async function saveProcess() {
    if (!canEdit.value) {
      notify('viewer権限ではAs-Isを保存できません')
      return
    }
    const model = activeProcessModel.value
    if (!model) return
    if (pendingProcessDepartmentId.value) {
      model.departmentId = pendingProcessDepartmentId.value
      processDepartmentId.value = pendingProcessDepartmentId.value
    }
    normalizeProcessTitle()
    archiveProcessVersion(`保存版 ${activeVersions.value.length + 1}`)
    model.updatedAt = processTimestamp()
    model.reviewStatus = model.reviewStatus === '承認済み' ? '承認済み' : '編集中'
    const business = businessMasters.value.find((item) => item.id === model.businessId)
    if (business) {
      business.asIsModelId = model.businessId
      business.asIsUpdatedAt = model.updatedAt
      business.asIsSourceInterviewId = model.sourceInterviewId
      business.departmentId = model.departmentId
      if (model.summary) business.description = model.summary
    }
    persistProcessState()
    persistBusinessMasters()
    try {
      await flushAppStateSave()
      // 書き込みが通ってから未保存表示を消す。失敗したら未保存のまま残す。
      clearProcessDirty(model.businessId)
      notify(`「${model.title}」を保存しました`)
    } catch (error) {
      notify(error instanceof Error ? `As-Isを保存できませんでした：${error.message}` : 'As-Isを保存できませんでした')
    }
  }

  function changeProcessZoom(delta: number) {
    processZoom.value = Math.min(1.5, Math.max(0.6, Number((processZoom.value + delta).toFixed(1))))
  }

  function autoArrangeProcess() {
    const model = activeProcessModel.value
    if (!model) return
    // Return manually widened lanes to the compact size required by the
    // current branch tracks when the user explicitly requests auto-arrange.
    model.laneWidths = {}
    arrangeProcessVertically(model)
    normalizeProcessLaneLayout(model)
    model.layoutPositionsCustomized = true
    markProcessDirty()
    notify('接続順と担当レーンに沿って自動整列しました')
  }

  function setProcessTool(tool: 'select' | 'pan' | 'connect') {
    processTool.value = tool
    if (tool !== 'connect') connectionFrom.value = ''
  }

  function selectProcessStep(step: ProcessStep) {
    if (processTool.value === 'connect') {
      if (!connectionFrom.value) {
        connectionFrom.value = step.id
        notify(`接続元「${step.label}」を選択しました。接続先を選んでください`)
        return
      }
      if (connectionFrom.value === step.id) {
        connectionFrom.value = ''
        return
      }
      const exists = activeProcessModel.value.connections.some((item) => item.from === connectionFrom.value && item.to === step.id)
      if (!exists) {
        activeProcessModel.value.connections.push({ id: `flow-${Date.now()}`, from: connectionFrom.value, to: step.id })
        normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
      }
      connectionFrom.value = ''
      processTool.value = 'select'
      selectedStep.value = step.id
      notify('ステップを接続しました')
      return
    }
    selectedStep.value = step.id
    processPropertiesOpen.value = true
  }

  function resizeSelectedStepToLabel() {
    const step = selected.value
    if (step?.type === 'task') step.width = readableTaskWidth(step)
  }

  function finishSelectedStepLabelEdit() {
    const model = activeProcessModel.value
    // ラベルが伸びるとレーン幅の下限が変わり、後続レーンの位置がずれる。
    const previousLayouts = model ? processLaneLayouts(model) : []
    resizeSelectedStepToLabel()
    if (model) {
      shiftContentsWithLaneOffsets(model, previousLayouts)
      normalizeProcessLaneLayout(model, { preserveStepPositions: true })
    }
  }

  function addProcessStep(type: 'task' | 'gateway' = 'task') {
    if (!canEdit.value) return
    const id = `step-${Date.now()}`
    const actor = selected.value?.actor || '業務担当'
    const lane = selected.value?.lane ?? selected.value?.actor ?? availableProcessLanes.value[0] ?? actor
    const laneIndex = Math.max(0, availableProcessLanes.value.indexOf(lane))
    const laneLayout = processLaneLayouts(activeProcessModel.value)[laneIndex]
    const centerY = selected.value
      ? (selected.value.type === 'task' ? selected.value.y + 20 : selected.value.y) + PROCESS_VERTICAL_LEVEL_GAP
      : PROCESS_VERTICAL_FLOW_TOP
    const step: ProcessStep = type === 'gateway'
      ? { id, label: '新しい判断条件', actor, lane, laneTrack: 0, type: 'gateway', x: 560, y: centerY, risk: 'medium' }
      : { id, label: '新しい業務ステップ', actor, lane, laneTrack: 0, type: 'task', x: 360, y: centerY - 20, width: 145, duration: '要確認', system: '未設定', monthlyVolume: '要確認', evidence: [] }
    activeProcessModel.value.steps.push(step)
    if (laneLayout) setStepVerticalLanePosition(step, laneLayout)
    selectedStep.value = id
    processPropertiesOpen.value = true
    processTool.value = 'select'
  }

  function deleteSelectedProcessStep() {
    if (!canEdit.value) return
    const step = selected.value
    if (!step || step.type === 'start' || step.type === 'end') return
    activeProcessModel.value.steps = activeProcessModel.value.steps.filter((item) => item.id !== step.id)
    activeProcessModel.value.connections = activeProcessModel.value.connections.filter((item) => item.from !== step.id && item.to !== step.id)
    activeProcessModel.value.assetLinks = (activeProcessModel.value.assetLinks ?? []).filter((link) => link.stepId !== step.id)
    normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
    selectedStep.value = activeProcessModel.value.steps.find((item) => item.type === 'task')?.id ?? activeProcessModel.value.steps[0]?.id ?? ''
  }

  function deleteConnection(id: string) {
    if (!canEdit.value) return
    activeProcessModel.value.connections = activeProcessModel.value.connections.filter((item) => item.id !== id)
    normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
  }

  function attachEvidence(event: Event) {
    if (!canEdit.value) return
    const input = event.target as HTMLInputElement
    if (!selected.value || !input.files?.length) return
    selected.value.evidence = [...(selected.value.evidence ?? []), ...Array.from(input.files).map((file) => file.name)]
    input.value = ''
  }

  function versionDifference(version: ProcessVersion) {
    const currentSteps = activeProcessModel.value.steps
    const currentMap = new Map(currentSteps.map((step) => [step.id, JSON.stringify(step)]))
    const previousMap = new Map(version.steps.map((step) => [step.id, JSON.stringify(step)]))
    const ids = new Set([...currentMap.keys(), ...previousMap.keys()])
    const stepChanges = [...ids].filter((id) => currentMap.get(id) !== previousMap.get(id)).length
    return stepChanges
  }

  function restoreVersion(version: ProcessVersion) {
    archiveProcessVersion('版復元前')
    activeProcessModel.value.steps = version.steps.map(cloneProcessStep)
    activeProcessModel.value.connections = cloneConnections(version.connections)
    activeProcessModel.value.layoutDirection = 'vertical'
    activeProcessModel.value.lanes = [...(version.lanes ?? activeProcessModel.value.lanes ?? [])]
    activeProcessModel.value.layoutPositionsCustomized = version.layoutPositionsCustomized
    activeProcessModel.value.assets = cloneAssets(version.assets)
    activeProcessModel.value.assetLinks = cloneAssetLinks(version.assetLinks)
    // 情報を持たない古い版は、紐付けの記述から作り直す。
    activeProcessModel.value.information = version.information ? cloneInformation(version.information) : undefined
    activeProcessModel.value.suppressedAssetKeys = [...(version.suppressedAssetKeys ?? [])]
    activeProcessModel.value.suppressedAssetLinkKeys = [...(version.suppressedAssetLinkKeys ?? [])]
    ensureProcessAssets(activeProcessModel.value)
    normalizeProcessInformation(activeProcessModel.value)
    activeProcessModel.value.laneHeights = { ...(version.laneHeights ?? activeProcessModel.value.laneHeights ?? {}) }
    activeProcessModel.value.laneWidths = { ...(version.laneWidths ?? activeProcessModel.value.laneWidths ?? {}) }
    // 横向きで保存された版は座標系が異なるため、縦向きに並べ直す。
    if (version.layoutDirection !== 'vertical' || verticalLayoutNeedsRepair(activeProcessModel.value)) arrangeProcessVertically(activeProcessModel.value)
    normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
    activeProcessModel.value.updatedAt = processTimestamp()
    selectedStep.value = activeProcessModel.value.steps.find((step) => step.type === 'task')?.id ?? activeProcessModel.value.steps[0]?.id ?? ''
    void commitProcessState()
    versionDialog.value = false
    notify(`${version.label}を復元しました`)
  }

  return {
    // state
    selectedStep,
    processBusinessId,
    hasUnsavedProcessChanges,
    unsavedProcessCount,
    markProcessDirty,
    proposalFocusStepId,
    proposalViewRequested,
    improvementReviews,
    improvementStale,
    reviewImprovement,
    activeAiProposalSet,
    aiProposalGenerating,
    aiProposalError,
    generateAiProposals,
    processDepartmentId,
    pendingProcessDepartmentId,
    processZoom,
    showProcessAssets,
    showBottlenecks,
    showHandoffs,
    stepHeat,
    handoffConnectionIds,
    processTool,
    processPropertiesOpen,
    processPropertiesWidth,
    resizingProcessProperties,
    connectionFrom,
    laneEditorOpen,
    newProcessLaneName,
    laneManagementDialog,
    laneDeleteDialog,
    laneDeleteDestination,
    laneBulkMoveFrom,
    laneBulkMoveTo,
    managedNewLaneName,
    resizingLaneLabel,
    processDetailsDialog,
    processDetailsError,
    processDetailsForm,
    versionDialog,
    evidenceDialog,
    assetManagementDialog,
    selectedAssetId,
    assetSearch,
    assetLinkCandidateId,
    assetExtractionDialog,
    assetExtractionLoading,
    assetExtractionError,
    assetExtractionFileName,
    assetExtractionDocumentType,
    assetExtractionSummary,
    assetExtractionWarnings,
    assetExtractionFields,
    selectedAssetExtractionFields,
    interviewHistoryDialog,
    interviewHistoryLoading,
    interviewHistoryError,
    interviewHistorySessions,
    selectedHistorySessionId,
    panning,
    layoutElement,
    svgElement,
    // derived
    selectedProcessBusiness,
    activeProcessModel,
    activeProcessSteps,
    activeProcessAssets,
    selected,
    selectedConnections,
    selectedInputConnections,
    selectedOutputConnections,
    selectedStepAssetLinks,
    selectedManagedAsset,
    filteredProcessAssets,
    availableAssetsForSelectedStep,
    availableProcessLanes,
    laneDeleteTarget,
    laneDeleteStepCount,
    activeVersions,
    processCanvasWidth,
    processCanvasHeight,
    processSvgStyle,
    processLayoutStyle,
    processSwimlanes,
    persistentProcessAssetAnnotations,
    visibleProcessAssetAnnotations,
    processConnectorPaths,
    processDepartmentItems,
    filteredProcessSelectItems,
    selectedProcessDepartmentName,
    selectedProcessSourceFragments,
    selectedProcessInterviewSessionIds,
    selectedProcessHistorySession,
    selectedHistorySourceFragments,
    copyingProcessBitmap,
    copyProcessAsBitmap,
    // actions
    ensureProcessLanes,
    assignSelectedStepToLane,
    addProcessLane,
    openLaneManagement,
    renameProcessLane,
    moveProcessLane,
    addManagedProcessLane,
    requestDeleteProcessLane,
    confirmDeleteProcessLane,
    moveAllLaneSteps,
    saveLaneManagement,
    selectProcessBusiness,
    selectProcessDepartment,
    openProcessInterviewHistory,
    historyFragmentStepNames,
    archiveProcessVersion,
    openAssetManagement,
    extractInformationItems,
    applyExtractedInformationItems,
    addOperationalAsset,
    deleteOperationalAsset,
    linkAssetToSelectedStep,
    unlinkAssetFromSelectedStep,
    syncSelectedStepSystemAssets,
    reflowProcessAssets,
    normalizeProcessTitle,
    openProcessDetailsDialog,
    saveProcessDetails,
    saveProcess,
    changeProcessZoom,
    autoArrangeProcess,
    setProcessTool,
    selectProcessStep,
    resizeSelectedStepToLabel,
    finishSelectedStepLabelEdit,
    startLaneResize,
    startNodeDrag,
    startAssetDrag,
    startConnectionAnchorDrag,
    openAssetAnnotation,
    startCanvasPan,
    moveOnCanvas,
    endCanvasPointer,
    startProcessPropertiesResize,
    moveProcessPropertiesResize,
    endProcessPropertiesResize,
    resetProcessPropertiesWidth,
    resizeProcessPropertiesByKeyboard,
    addProcessStep,
    deleteSelectedProcessStep,
    deleteConnection,
    attachEvidence,
    versionDifference,
    restoreVersion,
  }
}

export type ProcessEditor = ReturnType<typeof createProcessEditor>

let editor: ProcessEditor | null = null

export function useProcessEditor(): ProcessEditor {
  if (!editor) editor = createProcessEditor()
  return editor
}
