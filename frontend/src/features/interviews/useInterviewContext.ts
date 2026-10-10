import { computed, ref } from 'vue'
import { initialDepartmentIds } from '../../api/initial-data'
import { emptyBusinessMaster } from '../master/business-master'
import type { InterviewMessage } from '../../models'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'

export type InterviewStartStyle = 'free' | 'guided'
export type InterviewMode = 'guided' | 'discovery'

/**
 * Identity of the interview currently under way. Kept separate from the
 * interview workflow itself because the process editor and the discovery
 * workbench both read it, and importing the full workflow there would create a
 * dependency cycle.
 */
function createInterviewContext() {
  const workspace = useWorkspaceStore()

  const interviewMode = ref<InterviewMode>('discovery')
  const interviewStartStyle = ref<InterviewStartStyle>('free')
  const selectedInterviewBusiness = ref('ap-invoice')
  const discoveryDepartmentId = ref<string>(initialDepartmentIds.accounting)
  const discoveryParticipant = ref('')
  // 起動直後は表示中のヒアリングなし。保存済みの続きは利用者の設定から復元する。
  const activeInterviewId = ref('')
  /** Live transcript of the interview on screen. */
  const messages = ref<InterviewMessage[]>([])

  /** 業務指定ヒアリングの対象候補。業務マスターが正本なので専用マスターは持たない。 */
  const selectableInterviewBusinesses = computed(() => workspace.businessMasters.value.filter(
    (item) => item.departmentId === discoveryDepartmentId.value,
  ))
  const selectedInterviewMaster = computed(() => (
    workspace.businessMasters.value.find((item) => item.id === selectedInterviewBusiness.value)
    ?? selectableInterviewBusinesses.value[0]
    ?? workspace.businessMasters.value[0]
    ?? emptyBusinessMaster()
  ))

  const currentInterviewDepartmentId = computed(() => discoveryDepartmentId.value)
  const currentInterviewDepartmentName = computed(() => (
    workspace.departments.find((item) => item.id === currentInterviewDepartmentId.value)?.name ?? currentInterviewDepartmentId.value
  ))
  const currentInterviewParticipant = computed(() => discoveryParticipant.value)

  const activeInterviewFragments = computed(() => workspace.workFragments.value.filter(
    (fragment) => fragment.interviewId === activeInterviewId.value,
  ))
  const activeInterviewLaneCandidates = computed(() => [...new Set(activeInterviewFragments.value
    .flatMap((fragment) => [fragment.actor, fragment.nextActor])
    .map((actor) => actor?.trim())
    .filter((actor): actor is string => Boolean(actor && !['未確認', '不明', '要確認', '未設定'].includes(actor))))])

  return {
    interviewMode,
    interviewStartStyle,
    selectedInterviewBusiness,
    discoveryDepartmentId,
    discoveryParticipant,
    activeInterviewId,
    messages,
    selectableInterviewBusinesses,
    selectedInterviewMaster,
    currentInterviewDepartmentId,
    currentInterviewDepartmentName,
    currentInterviewParticipant,
    activeInterviewFragments,
    activeInterviewLaneCandidates,
  }
}

export type InterviewContext = ReturnType<typeof createInterviewContext>

let context: InterviewContext | null = null

export function useInterviewContext(): InterviewContext {
  if (!context) context = createInterviewContext()
  return context
}
