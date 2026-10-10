import {
  getSavedInterviewSessionSummaries,
  updateSavedInterviewMetadata,
  type LlmInterviewResponse,
  type SavedInterviewSessionSummary,
} from '../../api/interview'
import { processTimestamp } from '../../utils/timestamp'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import type { InterviewSessionStatus, InterviewSessionSummary } from './types'
import { useInterviewContext } from './useInterviewContext'

/**
 * ヒアリング一覧の元データ（サーバの要約）との同期と、ヒアリングに対応するAs-Isの判定。
 * 一覧はアプリ状態へ保存せず、サーバの記録から毎回組み立てる。
 */
export function useInterviewSessionSync() {
  const { departments, businessMasters, processModels, workFragments, interviewSessions } = useWorkspaceStore()
  const { discoveryDepartmentId } = useInterviewContext()

  function interviewStateIsCompleteLike(phase: string, completionScore: number, isComplete = false) {
    return isComplete
      || phase === '完了'
      || completionScore >= 100
      || (phase === '要約確認' && completionScore >= 90)
  }

  function savedSummaryIsComplete(summary: SavedInterviewSessionSummary) {
    return interviewStateIsCompleteLike(summary.phase, summary.completion_score, summary.is_complete)
  }

  function llmInterviewStatus(result: LlmInterviewResponse): InterviewSessionStatus {
    return interviewStateIsCompleteLike(
      result.session_state.phase,
      result.session_state.completion_score,
      result.session_state.is_complete || result.is_complete,
    )
      ? '完了'
      : '進行中'
  }

  function asIsProcessForSession(sessionId: string) {
    const models = Object.values(processModels.value)
    const directModel = models.find((model) => model.sourceInterviewId === sessionId)
    if (directModel) return directModel
  
    const sourceProcessId = interviewSessions.value.find((session) => session.id === sessionId)?.sourceProcessId
    if (sourceProcessId && processModels.value[sourceProcessId]) return processModels.value[sourceProcessId]
  
    const fragmentIds = new Set(workFragments.value.filter((fragment) => fragment.interviewId === sessionId).map((fragment) => fragment.id))
    if (!fragmentIds.size) return undefined
    const sourceBusiness = businessMasters.value.find((business) => (
      business.asIsSourceInterviewId === sessionId
      || business.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId))
    ))
    const sourceBusinessModelId = sourceBusiness?.asIsModelId ?? sourceBusiness?.id
    if (sourceBusinessModelId && processModels.value[sourceBusinessModelId]) return processModels.value[sourceBusinessModelId]
  
    return models.find((model) => {
      return model.steps.some((step) => step.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId)))
        || model.assets?.some((asset) => asset.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId)))
    })
  }

  function sessionHasAsIsProcess(sessionId: string) {
    const models = Object.values(processModels.value)
    if (models.some((model) => model.sourceInterviewId === sessionId)) return true
    const fragmentIds = new Set(workFragments.value.filter((fragment) => fragment.interviewId === sessionId).map((fragment) => fragment.id))
    if (!fragmentIds.size) return false
    const sourceBusiness = businessMasters.value.find((business) => (
      business.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId))
    ))
    const sourceBusinessModelId = sourceBusiness?.asIsModelId ?? sourceBusiness?.id
    if (sourceBusinessModelId && processModels.value[sourceBusinessModelId]) return true
    return models.some((model) => (
      model.steps.some((step) => step.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId)))
      || model.assets?.some((asset) => asset.sourceFragmentIds?.some((fragmentId) => fragmentIds.has(fragmentId)))
    ))
  }

  /**
   * Demotes sessions still labelled 'As-Is作成済' whose As-Is has since been
   * deleted. Runs independently of the network so a failed sync cannot leave a
   * session permanently undeletable.
   */
  function refreshAsIsFlags() {
    let changed = false
    interviewSessions.value.forEach((session) => {
      if (session.status === 'As-Is作成済' && !sessionHasAsIsProcess(session.id)) {
        session.status = '完了'
        changed = true
      }
    })
    return changed
  }

  /** 部門名を変えたら、その部門のヒアリングの部門名もサーバへ反映する（名前で部門と結び付けているため）。 */
  async function syncInterviewDepartmentName(departmentId: string, departmentName: string) {
    const targets = interviewSessions.value.filter((session) => session.departmentId === departmentId && session.transcriptAvailable !== false)
    await Promise.all(targets.map((session) => (
      updateSavedInterviewMetadata(session.id, departmentName, session.participant).catch((error) => {
        console.warn('Interview department name could not be synced', error)
      })
    )))
  }

  function sessionSummaryFromSaved(summary: SavedInterviewSessionSummary): InterviewSessionSummary {
    const department = departments.find((item) => item.name === summary.department)
    const departmentId = department?.id ?? discoveryDepartmentId.value
    const departmentName = department?.name ?? summary.department
    const updatedAt = summary.updated_at || processTimestamp()
    const sourceProcessTitle = summary.source_process_id ? processModels.value[summary.source_process_id]?.title : ''
    const hasAsIsProcess = sessionHasAsIsProcess(summary.session_id)
    const isComplete = savedSummaryIsComplete(summary)
    return {
      id: summary.session_id,
      // 追加ヒアリングは対象As-Isの名前で呼ぶ。タイトルは保存せず、サーバの記録から毎回組み立てる。
      title: sourceProcessTitle
        ? `${sourceProcessTitle} 追加ヒアリング`
        : `${departmentName}｜${summary.participant} ヒアリング`,
      participant: summary.participant,
      departmentId,
      departmentName,
      status: hasAsIsProcess ? 'As-Is作成済' : isComplete ? '完了' : '中断',
      phase: summary.phase,
      completionScore: summary.completion_score,
      messageCount: summary.message_count,
      fragmentCount: workFragments.value.filter((fragment) => fragment.interviewId === summary.session_id).length,
      createdAt: summary.created_at || updatedAt,
      updatedAt,
      transcriptAvailable: true,
      mode: summary.analysis_mode === 'daily_reflection' ? 'reflection' : 'interview',
      ownerEmail: summary.owner_email || undefined,
      sourceProcessId: summary.source_process_id || undefined,
    }
  }

  async function syncSavedInterviewSessionSummaries() {
    refreshAsIsFlags()
    try {
      const savedSummaries = await getSavedInterviewSessionSummaries()
      const savedSessionIds = new Set(savedSummaries.map((summary) => summary.session_id))
      savedSummaries.forEach((savedSummary) => {
        const existing = interviewSessions.value.find((session) => session.id === savedSummary.session_id)
        if (!existing) {
          interviewSessions.value.push(sessionSummaryFromSaved(savedSummary))
          return
        }
        const nextMessageCount = savedSummary.message_count
        const nextUpdatedAt = savedSummary.updated_at || existing.updatedAt
        const nextCompletionScore = Math.max(existing.completionScore, savedSummary.completion_score)
        const nextPhase = savedSummary.phase || existing.phase
        const savedDepartment = departments.find((department) => department.name === savedSummary.department)
        const nextDepartmentId = savedDepartment?.id ?? existing.departmentId
        const nextDepartmentName = savedDepartment?.name ?? savedSummary.department ?? existing.departmentName
        const nextParticipant = savedSummary.participant || existing.participant
        const nextSourceProcessId = savedSummary.source_process_id || existing.sourceProcessId
        // 'As-Is作成済' must stay derived from the models that actually exist:
        // once the As-Is is deleted the session has to become deletable again.
        const nextStatus: InterviewSessionStatus = sessionHasAsIsProcess(savedSummary.session_id)
          ? 'As-Is作成済'
          : savedSummaryIsComplete(savedSummary) || existing.status === 'As-Is作成済'
            ? '完了'
            : existing.status
        if (
          existing.messageCount !== nextMessageCount
          || existing.updatedAt !== nextUpdatedAt
          || existing.completionScore !== nextCompletionScore
          || existing.phase !== nextPhase
          || existing.departmentId !== nextDepartmentId
          || existing.departmentName !== nextDepartmentName
          || existing.participant !== nextParticipant
          || existing.sourceProcessId !== nextSourceProcessId
          || existing.status !== nextStatus
          || existing.transcriptAvailable !== true
        ) {
          if (
            existing.title.startsWith(`${existing.departmentName}｜`)
            && (existing.departmentName !== nextDepartmentName || existing.participant !== nextParticipant)
          ) {
            existing.title = `${nextDepartmentName}｜${nextParticipant} ヒアリング`
          }
          existing.messageCount = nextMessageCount
          existing.updatedAt = nextUpdatedAt
          existing.completionScore = nextCompletionScore
          existing.phase = nextPhase
          existing.departmentId = nextDepartmentId
          existing.departmentName = nextDepartmentName
          existing.participant = nextParticipant
          existing.sourceProcessId = nextSourceProcessId
          existing.status = nextStatus
          existing.transcriptAvailable = true
        }
      })
      interviewSessions.value.forEach((session) => {
        if (savedSessionIds.has(session.id) || session.transcriptAvailable === false) return
        session.transcriptAvailable = false
      })
    } catch (error) {
      console.warn('Saved interview summaries could not be synced', error)
    }
  }

  return {
    asIsProcessForSession,
    sessionHasAsIsProcess,
    refreshAsIsFlags,
    llmInterviewStatus,
    syncInterviewDepartmentName,
    syncSavedInterviewSessionSummaries,
  }
}
