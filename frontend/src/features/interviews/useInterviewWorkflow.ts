import { computed, nextTick, ref } from 'vue'
import { deleteSavedInterviewSession, getSavedInterviewSession, getUserInterviewPreference, requestLlmInterview, saveUserInterviewPreference, startLlmInterview, toLlmFragment, type LlmInterviewResponse } from '../../api/interview'
import { processTimestamp } from '../../utils/timestamp'
import { useAppShell } from '../shell/useAppShell'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { useAuthSession } from '../admin/useAuthSession'
import { useProcessEditor } from '../process/useProcessEditor'
import { useInterviewVoice } from './composables/useInterviewVoice'
import { useInterviewAttachments } from './useInterviewAttachments'
import { useInterviewDraft } from './useInterviewDraft'
import { useInterviewFragments } from './useInterviewFragments'
import { useInterviewSessionList } from './useInterviewSessionList'
import { useInterviewSessionSync } from './useInterviewSessionSync'
import { refinementContextForModel } from './process-draft-model'
import { useInterviewContext } from './useInterviewContext'
import type { InterviewSessionStatus, InterviewSessionSummary } from './types'

/**
 * ヒアリングの進行（開始・再開・中断・削除、AIとの対話）をまとめ、画面へ公開する。
 * 一覧（useInterviewSessionList）、同期（useInterviewSessionSync）、添付（useInterviewAttachments）、
 * 作業断片（useInterviewFragments）、As-Isの生成（useInterviewDraft）は別ファイルに分けてある。
 */
function createInterviewWorkflow() {
  const workspace = useWorkspaceStore()
  const {
    departments,
    businessMasters,
    processModels,
    workFragments,
    interviewSessions,
    notify,
    commonBusinessInterviewTopics,
    scheduleAppStateSave,
  } = workspace
  const { goTo, onEnterView } = useAppShell()
  const { loginRequired, currentUser, canEdit } = useAuthSession()
  const context = useInterviewContext()
  const {
    interviewMode,
    interviewStartStyle,
    selectedInterviewBusiness,
    discoveryDepartmentId,
    discoveryParticipant,
    activeInterviewId,
    messages,
    selectableInterviewBusinesses,
    currentInterviewDepartmentName,
    currentInterviewDepartmentId,
    currentInterviewParticipant,
    selectedInterviewMaster,
  } = context
  const processEditor = useProcessEditor()
  const {
    activeProcessModel,
    selectedProcessSourceFragments,
    selectProcessBusiness,
  } = processEditor


  const discoveryQuestionStage = ref(0)
  const activeDiscoveryFragmentId = ref('')
  const aiThinking = ref(false)
  const llmConnectionStatus = ref<'unknown' | 'connected' | 'error'>('unknown')
  const llmStatusDetail = ref('')
  const pendingInterviewText = ref('')
  const replacePendingUserMessage = ref(false)
  let llmRequestController: AbortController | null = null

  const {
    queuedInterviewAttachments,
    pendingInterviewAttachments,
    interviewAttachmentError,
    interviewAttachmentDragActive,
    onInterviewAttachmentInput,
    onInterviewPaste,
    onInterviewDrop,
    removeInterviewAttachment,
    formatAttachmentSize,
    clearInterviewAttachments,
  } = useInterviewAttachments()

  const { applyLlmWorkFragment, applyExtractedWorkFragments } = useInterviewFragments(activeDiscoveryFragmentId)
  const {
    asIsProcessForSession,
    sessionHasAsIsProcess,
    refreshAsIsFlags,
    llmInterviewStatus,
    syncInterviewDepartmentName,
    syncSavedInterviewSessionSummaries,
  } = useInterviewSessionSync()
  const {
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
  } = useInterviewSessionList(asIsProcessForSession)

  const response = ref('')
  /** Bound by App.vue to the InterviewPage instance. */
  const interviewPage = ref<{ scrollChatToBottom: () => void } | null>(null)
  const {
    voiceInputSupported,
    voiceOutputSupported,
    isVoiceListening,
    isVoiceTranscribing,
    isAiSpeaking,
    voicePlaybackEnabled,
    voiceStatus,
    voiceError,
    stopAiSpeech,
    unlockAiAudio,
    speakAiMessage,
    toggleVoicePlayback,
    isTimestampOnlyText,
    cancelVoiceInput,
    toggleVoiceInput,
  } = useInterviewVoice(response)
  const interviewCompletionScore = ref(0)
  const interviewPhase = ref<LlmInterviewResponse['phase']>('スコープ・目的')
  const interviewMissingItems = ref<string[]>([])
  const interviewConfirmedFacts = ref<string[]>([])
  const processInterviewContext = ref<Record<string, unknown> | null>(null)
  const interviewAsIsPreviewOpen = ref(false)
  const createDialog = ref(false)

  async function selectActiveInterviewForCurrentUser(sessionId: string) {
    activeInterviewId.value = sessionId
    scheduleAppStateSave()
    if (!loginRequired.value || !currentUser.value) return
    try {
      await saveUserInterviewPreference(sessionId || null)
    } catch (error) {
      console.warn('User interview preference could not be saved', error)
    }
  }

  const consultantTopics: { id: string; name: string; phase: LlmInterviewResponse['phase']; questionCount: number }[] = [
    { id: 'scope', name: '目的・範囲', phase: 'スコープ・目的', questionCount: 0 },
    { id: 'flow', name: '基本フロー', phase: '基本フロー', questionCount: 0 },
    { id: 'handoff', name: '役割・引き継ぎ', phase: '役割・引き継ぎ', questionCount: 0 },
    { id: 'system', name: '業務システム・データ', phase: 'システム・データ', questionCount: 0 },
    { id: 'volume', name: '件数・時間', phase: '件数・時間', questionCount: 0 },
    { id: 'exception', name: '判断・例外', phase: '判断・例外', questionCount: 0 },
    { id: 'issue', name: '差異・課題', phase: '差異・課題', questionCount: 0 },
    { id: 'gap', name: '補足確認', phase: '補足確認', questionCount: 0 },
    { id: 'summary', name: 'As-Is要約確認', phase: '要約確認', questionCount: 0 },
  ]

  /**
   * 業務指定ヒアリングでLLMへ渡す確認項目。業務マスターに固有の観点があればそれを、
   * 無ければ全業務共通の基本項目を土台にする。深掘り論点は業務名からLLMが決める。
   */
  const guidedInterviewTopics = computed(() => (
    selectedInterviewMaster.value.interviewTopics.length
      ? selectedInterviewMaster.value.interviewTopics
      : commonBusinessInterviewTopics()
  ))

  const currentBusinessContext = computed<Record<string, unknown> | null>(() => processInterviewContext.value ?? (interviewMode.value === 'guided' ? {
    analysis_mode: 'guided_topics',
    guide_id: selectedInterviewMaster.value.id,
    guide_type: 'business_master',
    target_business_name: selectedInterviewMaster.value.name,
    guide_name: selectedInterviewMaster.value.name,
    guide_description: selectedInterviewMaster.value.description,
    known_start_condition: selectedInterviewMaster.value.startCondition,
    known_end_condition: selectedInterviewMaster.value.endCondition,
    domain_consultant_instruction: '対象業務名から買掛・売掛などの業務ドメインを判断し、一般的な業務知識を使って深掘り観点を選ぶ。ただし回答にない事実は確定しない。',
    department: currentInterviewDepartmentName.value,
    interviewTopics: guidedInterviewTopics.value.map((topic) => ({
      name: topic.name,
      description: topic.description,
      required: topic.required,
      answerType: topic.answerType,
      keywords: topic.keywords ?? [],
      coverageKey: topic.coverageKey,
    })),
  } : null))
  const isRefinementInterview = computed(() => processInterviewContext.value?.analysis_mode === 'refinement')
  const {
    draftGenerating,
    draftGenerationError,
    generateEditableProcessDraft,
    generateDraftFromInterview,
    updateAsIsFromInterviewSession,
    updateAsIsFromInterviewSessionId,
  } = useInterviewDraft({
    currentBusinessContext,
    isRefinementInterview,
    processInterviewContext,
    interviewCompletionScore,
    interviewPhase,
    interviewTranscriptDialog,
    activeInterviewSession,
    selectActiveInterviewForCurrentUser,
    upsertInterviewSession,
  })
  const discoveryCoverage = computed(() => interviewCompletionScore.value)

  function interviewTopicState(index: number) {
    if (interviewPhase.value === '完了') return 'done'
    const currentIndex = consultantTopics.findIndex((topic) => topic.phase === interviewPhase.value)
    if (index < currentIndex) return 'done'
    return index === currentIndex ? 'active' : 'pending'
  }

  function interviewTopicStatus(index: number, questionCount: number) {
    const state = interviewTopicState(index)
    void questionCount
    return state === 'done' ? '確認済み' : state === 'active' ? '確認中' : '未確認'
  }
  const interviewTopicStates = computed(() => consultantTopics.map((_, index) => interviewTopicState(index)))
  const interviewTopicStatuses = computed(() => consultantTopics.map((topic, index) => interviewTopicStatus(index, topic.questionCount)))

  function clearDisplayedInterview() {
    activeInterviewId.value = ''
    discoveryParticipant.value = ''
    messages.value = []
    pendingInterviewText.value = ''
    clearInterviewAttachments()
    discoveryQuestionStage.value = 0
    interviewCompletionScore.value = 0
    interviewPhase.value = 'スコープ・目的'
    interviewMissingItems.value = []
    interviewConfirmedFacts.value = []
    activeDiscoveryFragmentId.value = ''
    llmConnectionStatus.value = 'unknown'
    llmStatusDetail.value = ''
    processInterviewContext.value = null
  }

  async function restoreCurrentUserInterview() {
    if (!loginRequired.value || !currentUser.value) {
      const localSession = interviewSessions.value.find((item) => item.id === activeInterviewId.value)
      if (localSession?.mode === 'reflection') {
        clearDisplayedInterview()
        scheduleAppStateSave()
        return false
      }
      return await restoreSavedInterviewSession()
    }
    let preferredSessionId = ''
    try {
      const preference = await getUserInterviewPreference()
      preferredSessionId = preference.active_interview_id || ''
    } catch (error) {
      console.warn('User interview preference could not be restored', error)
    }
    const session = interviewSessions.value.find((item) => item.id === preferredSessionId)
    if (!session || session.mode === 'reflection') {
      clearDisplayedInterview()
      if (preferredSessionId) {
        try {
          await saveUserInterviewPreference(null)
        } catch (error) {
          console.warn('Stale user interview preference could not be cleared', error)
        }
      }
      return false
    }
    activeInterviewId.value = session.id
    discoveryDepartmentId.value = session.departmentId
    discoveryParticipant.value = session.participant
    messages.value = []
    const restored = await restoreSavedInterviewSession()
    if (!restored) {
      interviewCompletionScore.value = session.completionScore
      interviewPhase.value = session.phase === '未開始' ? 'スコープ・目的' : session.phase
    }
    if (!preferredSessionId) {
      try {
        await saveUserInterviewPreference(session.id)
      } catch (error) {
        console.warn('Local user interview preference could not be synchronized', error)
      }
    }
    return true
  }

  function upsertInterviewSession(status?: InterviewSessionStatus, patch: Partial<InterviewSessionSummary> = {}) {
    if (!activeInterviewId.value.trim()) activeInterviewId.value = `interview-${Date.now()}`
    const now = processTimestamp()
    const departmentName = currentInterviewDepartmentName.value
    const existing = interviewSessions.value.find((session) => session.id === activeInterviewId.value)
    const fragmentCount = workFragments.value.filter((fragment) => fragment.interviewId === activeInterviewId.value).length
    const requestedStatus = status ?? existing?.status ?? '進行中'
    const summary: InterviewSessionSummary = {
      id: activeInterviewId.value,
      title: isRefinementInterview.value
        ? `${processInterviewContext.value?.name ?? 'As-Is'} 追加ヒアリング`
        : `${departmentName}｜${currentInterviewParticipant.value} ヒアリング`,
      participant: currentInterviewParticipant.value,
      departmentId: currentInterviewDepartmentId.value,
      departmentName,
      status: existing?.status === 'As-Is作成済' ? 'As-Is作成済' : requestedStatus,
      phase: interviewPhase.value || existing?.phase || '未開始',
      completionScore: interviewCompletionScore.value,
      messageCount: messages.value.length,
      fragmentCount,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sourceProcessId: existing?.sourceProcessId,
      transcript: messages.value.map((message) => ({
        role: message.role === 'ai' ? 'assistant' : 'user',
        text: message.text,
      })),
      transcriptAvailable: existing?.transcriptAvailable,
      mode: 'interview',
      ownerEmail: existing?.ownerEmail,
      ...patch,
    }
    const index = interviewSessions.value.findIndex((session) => session.id === summary.id)
    if (index >= 0) interviewSessions.value.splice(index, 1, summary)
    else interviewSessions.value.unshift(summary)
    return summary
  }

  function suspendCurrentInterview() {
    if (!activeInterviewId.value) return
    cancelVoiceInput()
    stopAiSpeech()
    upsertInterviewSession('中断')
    pendingInterviewText.value = ''
    clearInterviewAttachments()
    notify('ヒアリングを中断しました。一覧から再開できます。')
    goTo('sessions')
  }

  function cleanupInterviewLocalData(sessionId: string) {
    workFragments.value = workFragments.value.filter((fragment) => fragment.interviewId !== sessionId)
  }

  async function deleteInterviewSession(session: InterviewSessionSummary, fromActiveInterview = false) {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを削除できません')
      return
    }
    // Checked against the live models rather than the cached status, so a stale
    // 'As-Is作成済' label can never block a delete after the As-Is is gone.
    if (sessionHasAsIsProcess(session.id)) {
      notify('As-Is作成済みのヒアリングはプロセスの根拠として保持しています。先にAs-Isを削除してください。')
      return
    }
    const label = fromActiveInterview ? 'このヒアリングを中止して削除しますか？' : `「${session.title}」を削除しますか？`
    const detail = session.fragmentCount > 0 ? `\n抽出済みの作業断片 ${session.fragmentCount}件も削除されます。` : ''
    if (!window.confirm(`${label}${detail}\nこの操作は元に戻せません。`)) return
    cancelVoiceInput()
    stopAiSpeech()
    try {
      if (session.id.trim()) await deleteSavedInterviewSession(session.id)
      interviewSessions.value = interviewSessions.value.filter((item) => item.id !== session.id)
      cleanupInterviewLocalData(session.id)
      if (activeInterviewId.value === session.id) {
        clearDisplayedInterview()
        await selectActiveInterviewForCurrentUser('')
      }
      scheduleAppStateSave()
      notify(fromActiveInterview ? 'ヒアリングを中止して削除しました' : 'ヒアリングを削除しました')
      goTo('sessions')
    } catch (error) {
      notify(error instanceof Error ? error.message : 'ヒアリングを削除できませんでした')
    }
  }

  function cancelAndDeleteCurrentInterview() {
    const session = activeInterviewSession.value ?? upsertInterviewSession('中断')
    void deleteInterviewSession(session, true)
  }

  async function resumeInterviewSession(session: InterviewSessionSummary, startIfMissing = true) {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを再開できません')
      return
    }
    unlockAiAudio()
    cancelVoiceInput()
    stopAiSpeech()
    await selectActiveInterviewForCurrentUser(session.id)
    discoveryDepartmentId.value = session.departmentId
    discoveryParticipant.value = session.participant
    const sourceModel = session.sourceProcessId ? processModels.value[session.sourceProcessId] : undefined
    processInterviewContext.value = sourceModel ? refinementContextForModel(sourceModel) : null
    interviewMode.value = 'discovery'
    activeDiscoveryFragmentId.value = workFragments.value.find((fragment) => fragment.interviewId === session.id)?.id ?? ''
    pendingInterviewText.value = ''
    clearInterviewAttachments()
    const restored = await restoreSavedInterviewSession()
    // 保存済み会話の開始時点ではなく、現在の手修正済みAs-Isを追加質問の正本にする。
    if (sourceModel) processInterviewContext.value = refinementContextForModel(sourceModel)
    if (!restored) {
      messages.value = []
      interviewCompletionScore.value = session.completionScore
      interviewPhase.value = session.phase === '未開始' ? 'スコープ・目的' : session.phase
    }
    upsertInterviewSession(session.status === '完了' || session.status === 'As-Is作成済' ? session.status : '進行中')
    goTo('interview')
    if (startIfMissing && !restored && session.status !== '完了' && session.status !== 'As-Is作成済') {
      await beginConsultantInterview()
    }
  }

  function syncConsultantState(result: LlmInterviewResponse) {
    discoveryQuestionStage.value = result.next_stage
    interviewCompletionScore.value = result.session_state.completion_score
    interviewPhase.value = result.session_state.phase
    interviewMissingItems.value = [...result.session_state.missing_items]
    interviewConfirmedFacts.value = [...result.session_state.confirmed_facts]
    llmConnectionStatus.value = 'connected'
    llmStatusDetail.value = `${result.model}｜${result.session_state.phase}`
    upsertInterviewSession(llmInterviewStatus(result))
  }

  async function restoreSavedInterviewSession() {
    if (!activeInterviewId.value) return false
    try {
      const saved = await getSavedInterviewSession(activeInterviewId.value)
      if (!saved || !saved.messages.length) return false
      const state = saved.session_state
      // 廃止した業務振り返りは復元しない。
      if (state.analysis_mode === 'daily_reflection') return false
      const department = departments.find((item) => item.name === state.department)
      if (department) discoveryDepartmentId.value = department.id
      discoveryParticipant.value = state.participant
      discoveryQuestionStage.value = state.current_stage
      interviewCompletionScore.value = state.completion_score
      interviewPhase.value = state.phase
      interviewMissingItems.value = [...state.missing_items]
      interviewConfirmedFacts.value = [...state.confirmed_facts]
      interviewMode.value = 'discovery'
      processInterviewContext.value = state.business_context
      messages.value = saved.messages.map((message, index) => ({
        id: Date.now() + index,
        role: message.role === 'assistant' ? 'ai' : 'user',
        speaker: message.role === 'assistant' ? 'Ayatori AI' : `${state.participant}｜${state.department}`,
        time: '保存済み',
        text: message.text,
        tags: message.role === 'assistant' ? ['保存済み'] : undefined,
      }))
      llmConnectionStatus.value = 'connected'
      llmStatusDetail.value = `保存済みセッション｜${state.phase}`
      return true
    } catch (error) {
      llmStatusDetail.value = error instanceof Error ? error.message : '保存済みヒアリングを復元できませんでした'
      return false
    }
  }

  const interviewPreviewProcess = computed(() => asIsProcessForSession(activeInterviewId.value))

  function openInterviewAsIsPreview() {
    interviewAsIsPreviewOpen.value = true
  }

  function openAsIsForInterviewSession(session: InterviewSessionSummary) {
    const model = asIsProcessForSession(session.id)
    if (!model) {
      refreshAsIsFlags()
      notify('選択したヒアリングに対応するAs-Isプロセスが見つかりませんでした。')
      return
    }
    selectProcessBusiness(model.businessId)
    goTo('process')
  }

  function startDiscoveryInterview() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを開始できません')
      return
    }
    // ヒアリングは業務領域に紐づけて保存するため、1件も無い状態では始められない。
    if (!departments.length) {
      notify('先に業務領域マスターへ業務領域を追加してください')
      return
    }
    interviewStartStyle.value = 'free'
    processInterviewContext.value = null
    discoveryParticipant.value = ''
    createDialog.value = true
  }

  function startGuidedInterview() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを開始できません')
      return
    }
    if (!departments.length) {
      notify('先に業務領域マスターへ業務領域を追加してください')
      return
    }
    interviewStartStyle.value = 'guided'
    ensureSelectedInterviewBusiness()
    processInterviewContext.value = null
    discoveryParticipant.value = ''
    createDialog.value = true
  }

  function startBusinessMasterInterview(businessId: string) {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを開始できません')
      return
    }
    interviewStartStyle.value = 'guided'
    // 対象業務の業務領域へ揃えないと、候補の絞り込みで選択が外れてしまう。
    const business = businessMasters.value.find((item) => item.id === businessId)
    if (business) discoveryDepartmentId.value = business.departmentId
    selectedInterviewBusiness.value = businessId
    discoveryParticipant.value = ''
    createDialog.value = true
  }

  /** 業務領域を切り替えたときに、対象業務がその領域の候補から外れないようにする。 */
  function ensureSelectedInterviewBusiness() {
    if (selectableInterviewBusinesses.value.some((business) => business.id === selectedInterviewBusiness.value)) return
    selectedInterviewBusiness.value = selectableInterviewBusinesses.value[0]?.id ?? ''
  }

  async function continueInterviewFromProcess() {
    if (!canEdit.value) {
      notify('viewer権限では追加ヒアリングを開始できません')
      return
    }
    const model = activeProcessModel.value
    if (!model) return
    unlockAiAudio()
    cancelVoiceInput()
    stopAiSpeech()
    voiceError.value = ''
    voiceStatus.value = ''
    interviewMode.value = 'discovery'
    await selectActiveInterviewForCurrentUser(`interview-refine-${Date.now()}`)
    discoveryDepartmentId.value = model.departmentId ?? discoveryDepartmentId.value
    discoveryParticipant.value = selectedProcessSourceFragments.value.at(-1)?.participant || discoveryParticipant.value
    activeDiscoveryFragmentId.value = ''
    discoveryQuestionStage.value = 0
    interviewCompletionScore.value = 0
    interviewPhase.value = '差異・課題'
    interviewMissingItems.value = [...(model.reviewItems ?? [])]
    interviewConfirmedFacts.value = model.steps.map((step) => `${step.label}（${step.actor}）`)
    processInterviewContext.value = refinementContextForModel(model)
    llmConnectionStatus.value = 'unknown'
    llmStatusDetail.value = ''
    pendingInterviewText.value = ''
    queuedInterviewAttachments.value = []
    pendingInterviewAttachments.value = []
    replacePendingUserMessage.value = false
    interviewAttachmentError.value = ''
    messages.value = []
    upsertInterviewSession('進行中', { sourceProcessId: model.businessId, title: `${model.title} 追加ヒアリング` })
    goTo('interview')
    await beginConsultantInterview()
  }

  async function sendMessage() {
    if (!canEdit.value) {
      notify('viewer権限では回答を送信できません')
      return
    }
    unlockAiAudio()
    const inputText = response.value.trim()
    if (isTimestampOnlyText(inputText)) {
      voiceError.value = '録音時間だけが入力されています。もう一度音声入力をお試しください。'
      return
    }
    if ((!inputText && !queuedInterviewAttachments.value.length) || isVoiceListening.value || isVoiceTranscribing.value || aiThinking.value || pendingInterviewText.value || pendingInterviewAttachments.value.length) return
    const text = inputText || '添付した現在業務の資料を分析してください。'
    const attachments = [...queuedInterviewAttachments.value]
    messages.value.push({
      id: Date.now(),
      role: 'user',
      speaker: `${currentInterviewParticipant.value}｜${currentInterviewDepartmentName.value}`,
      time: processTimestamp(),
      text,
      attachments: attachments.map((item) => ({ name: item.name, mimeType: item.mime_type, size: item.size, previewUrl: item.previewUrl })),
    })
    response.value = ''
    upsertInterviewSession('進行中')
    pendingInterviewText.value = text
    pendingInterviewAttachments.value = attachments
    queuedInterviewAttachments.value = []
    await requestConsultantTurn(text, attachments)
  }

  function isAbortError(error: unknown) {
    return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
  }

  async function requestConsultantTurn(sourceText: string, attachments = pendingInterviewAttachments.value) {
    scheduleAppStateSave()
    aiThinking.value = true
    const requestController = new AbortController()
    llmRequestController = requestController
    const replacePendingMessage = replacePendingUserMessage.value
    replacePendingUserMessage.value = false
    await nextTick()
    interviewPage.value?.scrollChatToBottom()
    try {
      const activeFragment = workFragments.value.find((item) => item.id === activeDiscoveryFragmentId.value)
      const result = await requestLlmInterview({
        session_id: activeInterviewId.value,
        department: currentInterviewDepartmentName.value,
        participant: currentInterviewParticipant.value,
        stage: discoveryQuestionStage.value,
        messages: messages.value.slice(-200).map((message) => ({
          role: message.role === 'ai' ? 'assistant' as const : 'user' as const,
          text: message.text,
        })),
        attachments: attachments.map((item) => ({ name: item.name, mime_type: item.mime_type, data: item.data })),
        active_fragment: toLlmFragment(activeFragment),
        business_context: currentBusinessContext.value,
        replace_pending_user_message: replacePendingMessage,
      }, requestController.signal)
      applyExtractedWorkFragments(result.extracted_fragments ?? [], sourceText)
      applyLlmWorkFragment(result.fragment, result.fragment_action, sourceText)
      syncConsultantState(result)
      pendingInterviewText.value = ''
      pendingInterviewAttachments.value = []
      messages.value.push({ id: Date.now() + 1, role: 'ai', speaker: 'Ayatori AI', time: 'いま', text: result.reply, tags: [...result.tags.slice(0, 3), 'Gemini'] })
      upsertInterviewSession(llmInterviewStatus(result))
      speakAiMessage(result.reply)
    } catch (error) {
      if (isAbortError(error)) {
        llmStatusDetail.value = '送信を停止しました。内容を修正して再送信できます。'
        return
      }
      llmConnectionStatus.value = 'error'
      llmStatusDetail.value = error instanceof Error ? error.message : 'LLM APIへ接続できませんでした'
    } finally {
      if (llmRequestController === requestController) llmRequestController = null
      aiThinking.value = false
      await nextTick()
      interviewPage.value?.scrollChatToBottom()
    }
  }

  async function beginConsultantInterview() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを開始できません')
      return
    }
    aiThinking.value = true
    const requestController = new AbortController()
    llmRequestController = requestController
    try {
      const result = await startLlmInterview({
        session_id: activeInterviewId.value,
        department: currentInterviewDepartmentName.value,
        participant: currentInterviewParticipant.value,
        business_context: currentBusinessContext.value,
      }, requestController.signal)
      syncConsultantState(result)
      messages.value = [{ id: Date.now(), role: 'ai', speaker: 'Ayatori AI', time: 'いま', text: result.reply, tags: [...result.tags.slice(0, 3), 'Gemini'] }]
      upsertInterviewSession(llmInterviewStatus(result))
      speakAiMessage(result.reply)
    } catch (error) {
      if (isAbortError(error)) {
        llmStatusDetail.value = '質問の生成を停止しました。再接続で再試行できます。'
        return
      }
      llmConnectionStatus.value = 'error'
      llmStatusDetail.value = error instanceof Error ? error.message : 'LLM APIへ接続できませんでした'
    } finally {
      if (llmRequestController === requestController) llmRequestController = null
      aiThinking.value = false
    }
  }

  function stopPendingInterviewTurn() {
    if (!aiThinking.value && !pendingInterviewText.value && !pendingInterviewAttachments.value.length) return
    llmRequestController?.abort()
    const text = pendingInterviewText.value
    if (text) {
      response.value = text
      queuedInterviewAttachments.value = [...pendingInterviewAttachments.value]
      const lastMessage = messages.value.at(-1)
      if (lastMessage?.role === 'user' && lastMessage.text === text) messages.value.pop()
      replacePendingUserMessage.value = true
      scheduleAppStateSave()
    }
    pendingInterviewText.value = ''
    pendingInterviewAttachments.value = []
    aiThinking.value = false
    llmConnectionStatus.value = messages.value.some((message) => message.role === 'ai') ? 'connected' : 'unknown'
    llmStatusDetail.value = text
      ? '送信を停止しました。内容を修正して再送信できます。'
      : '質問の生成を停止しました。再接続で再試行できます。'
  }

  async function retryLlmConnection() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを再接続できません')
      return
    }
    if (aiThinking.value) return
    llmConnectionStatus.value = 'unknown'
    if (pendingInterviewText.value || pendingInterviewAttachments.value.length) await requestConsultantTurn(pendingInterviewText.value, pendingInterviewAttachments.value)
    else await beginConsultantInterview()
  }

  async function startInterview() {
    if (!canEdit.value) {
      notify('viewer権限ではヒアリングを開始できません')
      return
    }
    const participant = discoveryParticipant.value.trim()
    if (!participant) {
      notify('参加者を入力してください')
      return
    }
    discoveryParticipant.value = participant
    unlockAiAudio()
    cancelVoiceInput()
    stopAiSpeech()
    voiceError.value = ''
    voiceStatus.value = ''
    ensureSelectedInterviewBusiness()
    interviewMode.value = interviewStartStyle.value === 'guided' ? 'guided' : 'discovery'
    processInterviewContext.value = null
    await selectActiveInterviewForCurrentUser(`interview-${Date.now()}`)
    discoveryQuestionStage.value = 0
    activeDiscoveryFragmentId.value = ''
    llmConnectionStatus.value = 'unknown'
    llmStatusDetail.value = ''
    pendingInterviewText.value = ''
    queuedInterviewAttachments.value = []
    pendingInterviewAttachments.value = []
    replacePendingUserMessage.value = false
    interviewAttachmentError.value = ''
    interviewCompletionScore.value = 0
    interviewPhase.value = 'スコープ・目的'
    interviewMissingItems.value = []
    interviewConfirmedFacts.value = []
    createDialog.value = false
    messages.value = []
    goTo('interview')
    await beginConsultantInterview()
  }

  onEnterView('sessions', () => void syncSavedInterviewSessionSummaries())

  return {
    response,
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
    aiThinking,
    llmConnectionStatus,
    llmStatusDetail,
    pendingInterviewText,
    queuedInterviewAttachments,
    pendingInterviewAttachments,
    stopPendingInterviewTurn,
    interviewAttachmentError,
    interviewAttachmentDragActive,
    interviewCompletionScore,
    interviewPhase,
    interviewMissingItems,
    interviewConfirmedFacts,
    processInterviewContext,
    draftGenerating,
    draftGenerationError,
    interviewAsIsPreviewOpen,
    interviewPreviewProcess,
    createDialog,
    consultantTopics,
    // voice
    voiceInputSupported,
    voiceOutputSupported,
    isVoiceListening,
    isVoiceTranscribing,
    isAiSpeaking,
    voicePlaybackEnabled,
    voiceStatus,
    voiceError,
    speakAiMessage,
    toggleVoicePlayback,
    toggleVoiceInput,
    // derived
    currentBusinessContext,
    isRefinementInterview,
    interviewTranscriptMessages,
    interviewTranscriptFragments,
    interviewTranscriptCanUpdateAsIs,
    discoveryCoverage,
    interviewSessionGroups,
    filteredInterviewSessions,
    departmentFilteredInterviewSessions,
    activeInterviewSession,
    editingInterviewSession,
    interviewSessionCounts,
    interviewTopicStates,
    interviewTopicStatuses,
    // actions
    clearDisplayedInterview,
    restoreCurrentUserInterview,
    setInterviewSessionDepartment,
    openInterviewSessionEditor,
    openInterviewTranscript,
    openInterviewHistoryAttachment,
    saveInterviewSessionMetadata,
    suspendCurrentInterview,
    deleteInterviewSession,
    cancelAndDeleteCurrentInterview,
    resumeInterviewSession,
    updateAsIsFromInterviewSession,
    updateAsIsFromInterviewSessionId,
    openAsIsForInterviewSession,
    sessionHasAsIsProcess,
    refreshAsIsFlags,
    syncSavedInterviewSessionSummaries,
    syncInterviewDepartmentName,
    startDiscoveryInterview,
    startGuidedInterview,
    startBusinessMasterInterview,
    continueInterviewFromProcess,
    onInterviewAttachmentInput,
    onInterviewPaste,
    onInterviewDrop,
    removeInterviewAttachment,
    formatAttachmentSize,
    sendMessage,
    retryLlmConnection,
    generateEditableProcessDraft,
    generateDraftFromInterview,
    openInterviewAsIsPreview,
    startInterview,
    interviewPage,
    ensureSelectedInterviewBusiness,
  }
}

export type InterviewWorkflow = ReturnType<typeof createInterviewWorkflow>

let workflow: InterviewWorkflow | null = null

export function useInterviewWorkflow(): InterviewWorkflow {
  if (!workflow) workflow = createInterviewWorkflow()
  return workflow
}
