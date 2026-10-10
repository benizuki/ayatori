import { normalizeProcessInformation } from '../process/process-information'
import { ref, type Ref } from 'vue'
import { getSavedInterviewSession, type SavedInterviewSession } from '../../api/interview'
import { requestProcessDraft, type LlmProcessDraftResponse } from '../../api/process'
import type { BusinessProcessMaster, ProcessModel, WorkFragment } from '../../models'
import { useAuthSession } from '../admin/useAuthSession'
import { useProcessEditor } from '../process/useProcessEditor'
import { useAppShell } from '../shell/useAppShell'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import {
  applyInterviewDraftToBusiness,
  businessFromInterviewDraft,
  businessFromProcessModel,
  draftBusinessContext,
  mergeProcessDraftWithExisting,
  processDraftFragmentPayload,
  processModelFromDraft,
  versionBeforeGeneration,
} from './process-draft-model'
import type { InterviewSessionStatus, InterviewSessionSummary } from './types'
import { useInterviewContext } from './useInterviewContext'

/** ヒアリングの進行状態のうち、As-Isの生成・更新が読み書きするもの（useInterviewWorkflow が持つ）。 */
export interface InterviewDraftDeps {
  currentBusinessContext: Ref<Record<string, unknown> | null>
  isRefinementInterview: Ref<boolean>
  processInterviewContext: Ref<Record<string, unknown> | null>
  interviewCompletionScore: Ref<number>
  interviewPhase: Ref<string>
  interviewTranscriptDialog: Ref<boolean>
  activeInterviewSession: Ref<InterviewSessionSummary | undefined>
  selectActiveInterviewForCurrentUser: (sessionId: string) => Promise<void>
  upsertInterviewSession: (status?: InterviewSessionStatus, patch?: Partial<InterviewSessionSummary>) => InterviewSessionSummary
}

/**
 * ヒアリングの結果から、As-Isプロセスを生成・更新する。
 * 業務マスターの用意、版の退避、AIへの依頼、既存As-Isとの統合までを受け持つ。
 */
export function useInterviewDraft(deps: InterviewDraftDeps) {
  const {
    currentBusinessContext,
    isRefinementInterview,
    processInterviewContext,
    interviewCompletionScore,
    interviewPhase,
    interviewTranscriptDialog,
    activeInterviewSession,
    selectActiveInterviewForCurrentUser,
    upsertInterviewSession,
  } = deps
  const { departments, businessMasters, processModels, processVersions, workFragments, interviewSessions, notify, persistBusinessMasters, persistProcessState } = useWorkspaceStore()
  const { currentView } = useAppShell()
  const { canEdit } = useAuthSession()
  const {
    interviewMode,
    selectedInterviewMaster,
    discoveryDepartmentId,
    discoveryParticipant,
    activeInterviewId,
    messages,
    currentInterviewDepartmentId,
    currentInterviewDepartmentName,
    currentInterviewParticipant,
    activeInterviewFragments,
  } = useInterviewContext()
  const { selectProcessBusiness, processPropertiesOpen, processTool } = useProcessEditor()

  const draftGenerating = ref(false)
  const draftGenerationError = ref('')

  function ensureInterviewDraftBusiness(result: LlmProcessDraftResponse, fragments: WorkFragment[]) {
    let business = interviewMode.value === 'guided'
      ? selectedInterviewMaster.value
      : businessMasters.value.find((item) => item.id === `interview-draft-${activeInterviewId.value}`)
    if (!business) {
      business = businessFromInterviewDraft(result, fragments, {
        id: `interview-draft-${activeInterviewId.value}`,
        code: businessMasters.value.length + 1,
        departmentId: currentInterviewDepartmentId.value,
      })
      businessMasters.value.unshift(business)
    } else {
      applyInterviewDraftToBusiness(business, result, fragments)
    }
    persistBusinessMasters()
    return business
  }

  function ensureSourceProcessBusiness(model: ProcessModel, fragments: WorkFragment[]) {
    const existing = businessMasters.value.find((business) => business.id === model.businessId)
    if (existing) return existing
    const business = businessFromProcessModel(model, fragments, businessMasters.value.length + 1)
    businessMasters.value.unshift(business)
    persistBusinessMasters()
    return business
  }

  function archiveModelBeforeGeneration(model: ProcessModel) {
    processVersions.value[model.businessId] = [versionBeforeGeneration(model), ...(processVersions.value[model.businessId] ?? [])].slice(0, 10)
  }

  async function generateEditableProcessDraft(fragments: WorkFragment[], preferredBusiness?: BusinessProcessMaster) {
    if (!canEdit.value) {
      notify('viewer権限ではAs-Isを作成・更新できません')
      return
    }
    if (!fragments.length || draftGenerating.value) return
    draftGenerating.value = true
    draftGenerationError.value = ''
    try {
      const existingModel = preferredBusiness ? processModels.value[preferredBusiness.id] : undefined
      const businessContext = preferredBusiness ? draftBusinessContext(preferredBusiness, existingModel) : currentBusinessContext.value
      const result = await requestProcessDraft({
        session_id: activeInterviewId.value,
        department: preferredBusiness ? departments.find((item) => item.id === preferredBusiness.departmentId)?.name ?? preferredBusiness.departmentId : currentInterviewDepartmentName.value,
        participant: currentInterviewParticipant.value,
        business_context: businessContext,
        fragments: fragments.map(processDraftFragmentPayload),
      })
      const business = preferredBusiness ?? ensureInterviewDraftBusiness(result, fragments)
      business.sourceFragmentIds = [...new Set([...(business.sourceFragmentIds ?? []), ...fragments.map((fragment) => fragment.id)])]
      const previous = processModels.value[business.id]
      if (previous) archiveModelBeforeGeneration(previous)
      const generatedModel = processModelFromDraft(result, business, fragments, activeInterviewId.value)
      const model = previous ? mergeProcessDraftWithExisting(previous, generatedModel) : generatedModel
      // AIが作ったアセットの紐付けを、タスクの入力・出力の情報に変える。
      normalizeProcessInformation(model)
      processModels.value[business.id] = model
      business.asIsModelId = model.businessId
      business.asIsUpdatedAt = model.updatedAt
      // 初回ヒアリングを業務グループの起点として保持する。追加ヒアリングで上書きしない。
      business.asIsSourceInterviewId ??= model.sourceInterviewId
      upsertInterviewSession('As-Is作成済', { title: model.title })
      selectProcessBusiness(business.id)
      processPropertiesOpen.value = true
      processTool.value = 'select'
      persistProcessState()
      persistBusinessMasters()
      currentView.value = 'process'
      notify(`${fragments.length}件のヒアリング断片からAs-Isを${previous ? '更新' : '生成'}しました`)
    } catch (error) {
      draftGenerationError.value = error instanceof Error ? error.message : '業務ドラフトを生成できませんでした'
      notify(draftGenerationError.value)
    } finally {
      draftGenerating.value = false
    }
  }

  function generateDraftFromInterview() {
    if (isRefinementInterview.value) {
      const sourceProcessId = activeInterviewSession.value?.sourceProcessId
        ?? String(processInterviewContext.value?.source_process_id ?? '')
      const sourceModel = sourceProcessId ? processModels.value[sourceProcessId] : undefined
      if (!sourceModel) {
        notify('更新対象のAs-Isプロセスが見つかりませんでした。As-Is画面から追加ヒアリングを開始し直してください。')
        return
      }
      const modelFragmentIds = new Set([
        ...sourceModel.steps.flatMap((step) => step.sourceFragmentIds ?? []),
        ...(sourceModel.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
      ])
      const sourceFragments = workFragments.value.filter((fragment) => modelFragmentIds.has(fragment.id))
      const business = ensureSourceProcessBusiness(sourceModel, sourceFragments)
      const fragmentIds = new Set([
        ...(business.sourceFragmentIds ?? []),
        ...sourceModel.steps.flatMap((step) => step.sourceFragmentIds ?? []),
        ...(sourceModel.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
        ...activeInterviewFragments.value.map((fragment) => fragment.id),
      ])
      const combinedFragments = workFragments.value.filter((fragment) => fragmentIds.has(fragment.id))
      return generateEditableProcessDraft(combinedFragments, business)
    }
    return generateEditableProcessDraft(activeInterviewFragments.value)
  }

  async function updateAsIsFromInterviewSession(session: InterviewSessionSummary) {
    if (!canEdit.value) {
      notify('viewer権限ではAs-Isを更新できません')
      return
    }
    interviewTranscriptDialog.value = false
    const sourceModel = session.sourceProcessId ? processModels.value[session.sourceProcessId] : undefined
    if (!sourceModel) {
      notify('更新対象のAs-Isプロセスが見つかりませんでした。')
      return
    }
  
    const incorporatedFragmentIds = new Set([
      ...sourceModel.steps.flatMap((step) => step.sourceFragmentIds ?? []),
      ...(sourceModel.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
    ])
    const sourceFragments = workFragments.value.filter((fragment) => incorporatedFragmentIds.has(fragment.id))
    const business = ensureSourceProcessBusiness(sourceModel, sourceFragments)
    const relatedRefinementSessionIds = new Set(
      interviewSessions.value
        .filter((item) => (
          item.sourceProcessId === sourceModel.businessId
          && (item.id === session.id || item.status === '完了' || item.status === 'As-Is作成済')
        ))
        .map((item) => item.id),
    )
    relatedRefinementSessionIds.add(session.id)
    const combinedFragments = workFragments.value.filter((fragment) => (
      business.sourceFragmentIds?.includes(fragment.id)
      || incorporatedFragmentIds.has(fragment.id)
      || relatedRefinementSessionIds.has(fragment.interviewId)
    ))
    if (!combinedFragments.length) {
      notify('As-Isへ反映できるヒアリング内容が見つかりませんでした。')
      return
    }
  
    await selectActiveInterviewForCurrentUser(session.id)
    discoveryDepartmentId.value = session.departmentId
    discoveryParticipant.value = session.participant
    interviewMode.value = 'discovery'
    let savedSession: SavedInterviewSession | null = null
    try {
      savedSession = await getSavedInterviewSession(session.id)
    } catch {
      // The locally retained transcript and fragments are enough to update the
      // flow when the saved conversation endpoint is temporarily unavailable.
    }
    interviewCompletionScore.value = savedSession?.session_state.completion_score ?? session.completionScore
    const savedPhase = savedSession?.session_state.phase ?? session.phase
    interviewPhase.value = savedPhase === '未開始' ? 'スコープ・目的' : savedPhase
    const transcript = savedSession?.messages.length ? savedSession.messages : (session.transcript ?? [])
    messages.value = transcript.map((message, index) => ({
      id: index + 1,
      role: message.role === 'assistant' ? 'ai' : 'user',
      speaker: message.role === 'assistant' ? 'Ayatori AI' : `${session.participant}｜${session.departmentName}`,
      time: '保存済み',
      text: message.text,
    }))
    processInterviewContext.value = {
      analysis_mode: 'refinement',
      source_process_id: sourceModel.businessId,
      name: sourceModel.title,
      summary: sourceModel.summary,
    }
    notify('初回と追加ヒアリングを統合してAs-Isフローを更新しています。')
    await generateEditableProcessDraft(combinedFragments, business)
  }

  function updateAsIsFromInterviewSessionId(sessionId: string) {
    const session = interviewSessions.value.find((item) => item.id === sessionId)
    if (!session) {
      notify('更新元の追加ヒアリングが見つかりませんでした。')
      return
    }
    return updateAsIsFromInterviewSession(session)
  }

  return {
    draftGenerating,
    draftGenerationError,
    generateEditableProcessDraft,
    generateDraftFromInterview,
    updateAsIsFromInterviewSession,
    updateAsIsFromInterviewSessionId,
  }
}
