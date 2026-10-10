import { computed, ref } from 'vue'
import {
  fetchSavedInterviewAttachment,
  getSavedInterviewSession,
  updateSavedInterviewMetadata,
  type SavedInterviewAttachment,
  type SavedInterviewSession,
} from '../../api/interview'
import type { ProcessModel } from '../../models'
import { useAuthSession } from '../admin/useAuthSession'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import type { InterviewSessionGroup, InterviewSessionStatus, InterviewSessionSummary } from './types'
import { useInterviewContext } from './useInterviewContext'

/**
 * ヒアリング一覧の画面状態。絞り込み、業務ごとのグループ化、部門・参加者の編集、
 * 会話履歴ダイアログを受け持つ。一覧そのものは workspace の interviewSessions を読む。
 */
export function useInterviewSessionList(asIsProcessForSession: (sessionId: string) => ProcessModel | undefined) {
  const { departments, businessMasters, processModels, workFragments, interviewSessions, notify } = useWorkspaceStore()
  const { canEdit } = useAuthSession()
  const { activeInterviewId, discoveryDepartmentId, discoveryParticipant, messages } = useInterviewContext()

  const interviewSessionFilter = ref<'すべて' | InterviewSessionStatus>('すべて')
  const interviewSessionDepartmentId = ref('all')
  const interviewSessionEditorOpen = ref(false)
  const interviewSessionEditorSaving = ref(false)
  const editingInterviewSessionId = ref('')
  const interviewSessionEditorError = ref('')
  const interviewSessionEditorForm = ref({ departmentId: '', participant: '' })
  const interviewTranscriptDialog = ref(false)
  const interviewTranscriptLoading = ref(false)
  const interviewTranscriptError = ref('')
  const interviewTranscriptSession = ref<InterviewSessionSummary | null>(null)
  const interviewTranscriptRecord = ref<SavedInterviewSession | null>(null)

  // 廃止した業務振り返りの保存済みセッションは一覧に出さない。
  const sortedInterviewSessions = computed(() => interviewSessions.value
    .filter((session) => session.mode !== 'reflection')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))

  function interviewSessionGroupId(session: InterviewSessionSummary) {
    return session.sourceProcessId || asIsProcessForSession(session.id)?.businessId || session.id
  }

  const interviewSessionGroups = computed<InterviewSessionGroup[]>(() => {
    const grouped = new Map<string, InterviewSessionSummary[]>()
    sortedInterviewSessions.value.forEach((session) => {
      const groupId = interviewSessionGroupId(session)
      grouped.set(groupId, [...(grouped.get(groupId) ?? []), session])
    })
    return [...grouped.entries()].map(([id, sessions]) => {
      const orderedSessions = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const latest = orderedSessions.at(-1)!
      const sourceModel = processModels.value[id] ?? sessions.map((session) => asIsProcessForSession(session.id)).find(Boolean)
      const status: InterviewSessionStatus = sessions.some((session) => session.status === '進行中')
        ? '進行中'
        : sessions.some((session) => session.status === '中断')
          ? '中断'
          : sourceModel || sessions.some((session) => session.status === 'As-Is作成済')
            ? 'As-Is作成済'
            : '完了'
      return {
        id,
        businessId: sourceModel?.businessId,
        title: sourceModel?.title ?? orderedSessions[0].title.replace(/\s*追加ヒアリング$/, ''),
        departmentId: latest.departmentId,
        departmentName: latest.departmentName,
        status,
        phase: latest.phase,
        completionScore: Math.max(...sessions.map((session) => session.completionScore)),
        messageCount: sessions.reduce((total, session) => total + session.messageCount, 0),
        fragmentCount: sessions.reduce((total, session) => total + session.fragmentCount, 0),
        createdAt: orderedSessions[0].createdAt,
        updatedAt: latest.updatedAt,
        sessions: orderedSessions,
      }
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  const departmentFilteredInterviewSessions = computed(() => interviewSessionGroups.value.filter((group) => (
    interviewSessionDepartmentId.value === 'all' || group.departmentId === interviewSessionDepartmentId.value
  )))

  const filteredInterviewSessions = computed(() => departmentFilteredInterviewSessions.value.filter((group) => {
    if (interviewSessionFilter.value === 'すべて') return true
    if (interviewSessionFilter.value === '完了') return group.status === '完了' || group.status === 'As-Is作成済'
    return group.status === interviewSessionFilter.value
  }))

  const activeInterviewSession = computed(() => interviewSessions.value.find((session) => session.id === activeInterviewId.value))

  const editingInterviewSession = computed(() => interviewSessions.value.find((session) => session.id === editingInterviewSessionId.value))

  const interviewSessionCounts = computed(() => departmentFilteredInterviewSessions.value.reduce((counts, group) => {
    counts[group.status] = (counts[group.status] ?? 0) + 1
    if (group.status === 'As-Is作成済') counts['完了'] = (counts['完了'] ?? 0) + 1
    return counts
  }, {} as Record<InterviewSessionStatus, number>))

  const interviewTranscriptMessages = computed(() => {
    const savedMessages = interviewTranscriptRecord.value?.messages ?? []
    if (savedMessages.length) return savedMessages
    return interviewTranscriptSession.value?.transcript ?? []
  })

  const interviewTranscriptFragments = computed(() => workFragments.value.filter(
    (fragment) => fragment.interviewId === interviewTranscriptSession.value?.id,
  ))

  const interviewTranscriptCanUpdateAsIs = computed(() => {
    const session = interviewTranscriptSession.value
    if (!session?.sourceProcessId) return false
    const sourceModel = processModels.value[session.sourceProcessId]
    if (!sourceModel) return false
    const matchingBusiness = businessMasters.value.find((business) => business.id === sourceModel.businessId)
    const incorporatedIds = new Set([
      ...(matchingBusiness?.sourceFragmentIds ?? []),
      ...sourceModel.steps.flatMap((step) => step.sourceFragmentIds ?? []),
      ...(sourceModel.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
    ])
    const hasUnappliedFragments = interviewTranscriptFragments.value.some((fragment) => !incorporatedIds.has(fragment.id))
    return hasUnappliedFragments || session.status === '完了'
  })

  function setInterviewSessionDepartment(departmentId: string) {
    interviewSessionDepartmentId.value = departmentId
  }

  function openInterviewSessionEditor(session: InterviewSessionSummary) {
    editingInterviewSessionId.value = session.id
    interviewSessionEditorForm.value = {
      departmentId: session.departmentId,
      participant: session.participant,
    }
    interviewSessionEditorError.value = ''
    interviewSessionEditorOpen.value = true
  }

  async function openInterviewTranscript(session: InterviewSessionSummary) {
    interviewTranscriptSession.value = session
    interviewTranscriptRecord.value = null
    interviewTranscriptError.value = ''
    interviewTranscriptDialog.value = true
    interviewTranscriptLoading.value = true
    try {
      const saved = await getSavedInterviewSession(session.id)
      if (!saved) {
        interviewTranscriptError.value = session.transcript?.length
          ? '会話データベースから取得できなかったため、この画面に残っている会話を表示しています。'
          : session.messageCount > 0
            ? '発言数だけが残っており、会話本文は保存されていません。'
          : 'このヒアリングの会話全文は保存されていません。抽出済みの発言根拠を確認できます。'
        return
      }
      interviewTranscriptRecord.value = saved
      if (!saved.messages.length) {
        interviewTranscriptError.value = 'このヒアリングには保存済みの質問・回答がありません。'
      }
    } catch (error) {
      interviewTranscriptError.value = error instanceof Error ? error.message : 'ヒアリング内容を取得できませんでした。'
    } finally {
      interviewTranscriptLoading.value = false
    }
  }

  async function openInterviewHistoryAttachment(sessionId: string, attachment: SavedInterviewAttachment) {
    const preview = window.open('about:blank', '_blank')
    if (preview) preview.opener = null
    try {
      const blob = await fetchSavedInterviewAttachment(sessionId, attachment.id)
      const url = URL.createObjectURL(blob)
      if (preview) preview.location.replace(url)
      else {
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = attachment.name
        anchor.click()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000)
    } catch (error) {
      preview?.close()
      notify(error instanceof Error ? error.message : '添付資料を開けませんでした')
    }
  }

  async function saveInterviewSessionMetadata() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリング情報を編集できません')
      return
    }
    const session = interviewSessions.value.find((item) => item.id === editingInterviewSessionId.value)
    const department = departments.find((item) => item.id === interviewSessionEditorForm.value.departmentId)
    const participant = interviewSessionEditorForm.value.participant.trim()
    if (!session || !department || interviewSessionEditorSaving.value) return
    if (!participant) {
      interviewSessionEditorError.value = '参加者を入力してください。'
      return
    }
    interviewSessionEditorSaving.value = true
    interviewSessionEditorError.value = ''
    try {
      const saved = await updateSavedInterviewMetadata(session.id, department.name, participant)
      const previousDepartmentName = session.departmentName
      session.departmentId = department.id
      session.departmentName = department.name
      session.participant = participant
      if (session.title.startsWith(`${previousDepartmentName}｜`)) {
        session.title = `${department.name}｜${participant} ヒアリング`
      }
      if (saved?.updated_at) session.updatedAt = saved.updated_at
      workFragments.value.forEach((fragment) => {
        if (fragment.interviewId === session.id) {
          fragment.departmentId = department.id
          fragment.participant = participant
        }
      })
      if (activeInterviewId.value === session.id) {
        discoveryDepartmentId.value = department.id
        discoveryParticipant.value = participant
        messages.value.forEach((message) => {
          if (message.role === 'user') message.speaker = `${participant}｜${department.name}`
        })
      }
      interviewSessionEditorOpen.value = false
      notify(`「${session.title}」の部門・参加者を更新しました`)
    } catch (error) {
      interviewSessionEditorError.value = error instanceof Error ? error.message : 'ヒアリング情報を更新できませんでした'
    } finally {
      interviewSessionEditorSaving.value = false
    }
  }

  return {
    interviewSessionFilter,
    interviewSessionDepartmentId,
    interviewSessionEditorOpen,
    interviewSessionEditorSaving,
    interviewSessionEditorError,
    interviewSessionEditorForm,
    interviewTranscriptDialog,
    interviewTranscriptLoading,
    interviewTranscriptError,
    interviewTranscriptSession,
    interviewTranscriptRecord,
    interviewTranscriptMessages,
    interviewTranscriptFragments,
    interviewTranscriptCanUpdateAsIs,
    interviewSessionGroups,
    departmentFilteredInterviewSessions,
    filteredInterviewSessions,
    activeInterviewSession,
    editingInterviewSession,
    interviewSessionCounts,
    setInterviewSessionDepartment,
    openInterviewSessionEditor,
    openInterviewTranscript,
    openInterviewHistoryAttachment,
    saveInterviewSessionMetadata,
  }
}
