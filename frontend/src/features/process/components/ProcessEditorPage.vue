<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useProcessEditor } from '../useProcessEditor'
import { isSystemAsset } from '../process-model'
import {
  INFORMATION_ASSET_ROLE,
  informationFindings,
  syncAssetLinksFromInformation,
  type InformationDirection,
} from '../process-information'
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore'
import { businessDepth } from '../../master/process-hierarchy'
import type { ProcessAssetLink, ProcessStep } from '../../../models'
import ProcessAiProposalPanel from './ProcessAiProposalPanel.vue'
import StepInformationDialog from './StepInformationDialog.vue'
import type { ProcessAssetAnnotation } from '../process-geometry'

/** Steps that hand off to the interview workflow stay with the app shell. */
// v-select用の選択肢。undefinedとbooleanを値に持つため定数で持つ。
const PROCESS_RISK_OPTIONS = [
  { value: undefined, label: 'なし' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '要確認' },
  { value: 'high', label: '高' },
]
const PROCESS_REVIEW_OPTIONS = [
  { value: true, label: '要確認' },
  { value: false, label: '確認済み' },
]

const props = defineProps<{ canEdit: boolean }>()
const { businessMasters } = useWorkspaceStore()

const emit = defineEmits<{
  continueInterview: []
  startDiscoveryInterview: []
  showImprovementMap: [stepIds: string[]]
}>()

const {
  layoutElement,
  svgElement,
  selectedStep,
  processZoom,
  processTool,
  showProcessAssets,
  showBottlenecks,
  showHandoffs,
  stepHeat,
  handoffConnectionIds,
  processPropertiesOpen,
  processPropertiesWidth,
  resizingProcessProperties,
  resizingLaneLabel,
  connectionFrom,
  laneEditorOpen,
  newProcessLaneName,
  assetLinkCandidateId,
  panning,
  versionDialog,
  evidenceDialog,
  activeProcessModel,
  activeProcessSteps,
  activeProcessAssets,
  selected,
  selectProcessBusiness,
  selectedConnections,
  selectedInputConnections,
  selectedOutputConnections,
  selectedStepAssetLinks,
  availableAssetsForSelectedStep,
  availableProcessLanes,
  processCanvasWidth,
  processCanvasHeight,
  processSvgStyle,
  processLayoutStyle,
  processSwimlanes,
  visibleProcessAssetAnnotations,
  processConnectorPaths,
  selectedProcessDepartmentName,
  selectedProcessSourceFragments,
  copyingProcessBitmap,
  copyProcessAsBitmap,
  openProcessDetailsDialog,
  saveProcess,
  markProcessDirty,
  extractInformationItems,
  assetExtractionLoading,
  hasUnsavedProcessChanges,
  openProcessInterviewHistory,
  setProcessTool,
  openLaneManagement,
  autoArrangeProcess,
  addProcessStep,
  changeProcessZoom,
  openAssetManagement,
  startCanvasPan,
  moveOnCanvas,
  endCanvasPointer,
  startLaneResize,
  startNodeDrag,
  startAssetDrag,
  startConnectionAnchorDrag,
  openAssetAnnotation,
  selectProcessStep,
  proposalFocusStepId,
  proposalViewRequested,
  improvementReviews,
  improvementStale,
  reviewImprovement,
  activeAiProposalSet,
  aiProposalGenerating,
  aiProposalError,
  generateAiProposals,
  startProcessPropertiesResize,
  moveProcessPropertiesResize,
  endProcessPropertiesResize,
  resetProcessPropertiesWidth,
  resizeProcessPropertiesByKeyboard,
  deleteSelectedProcessStep,
  resizeSelectedStepToLabel,
  finishSelectedStepLabelEdit,
  assignSelectedStepToLane,
  addProcessLane,
  syncSelectedStepSystemAssets,
  reflowProcessAssets,
  linkAssetToSelectedStep,
  unlinkAssetFromSelectedStep,
  deleteConnection,
  attachEvidence,
} = useProcessEditor()

const drilldownBusinessItems = computed(() => businessMasters.value
  .filter((business) => business.id !== activeProcessModel.value?.businessId)
  .sort((left, right) => {
    const leftIsChild = left.parentId === activeProcessModel.value?.businessId ? 0 : 1
    const rightIsChild = right.parentId === activeProcessModel.value?.businessId ? 0 : 1
    return leftIsChild - rightIsChild || left.name.localeCompare(right.name, 'ja')
  })
  .map((business) => ({
    title: `${business.parentId === activeProcessModel.value?.businessId ? '下位業務｜' : `L${businessDepth(business, businessMasters.value)}｜`}${business.name}`,
    value: business.id,
  })))

function openSelectedDrilldown() {
  if (selected.value?.childBusinessId) selectProcessBusiness(selected.value.childBusinessId)
}

function assetForLink(link: ProcessAssetLink) {
  return activeProcessAssets.value.find((asset) => asset.id === link.assetId)
}

function stepLabel(stepId: string) {
  return activeProcessSteps.value.find((step) => step.id === stepId)?.label
}

function isUnknownValue(value?: string) {
  return !value || value.includes('未確認') || value.includes('不明')
}

/** 文字幅の概算。全角は1文字あたり11px、半角は6.4pxとして、ピルの幅を決める。 */
function textWidth(text: string) {
  return [...text].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 11.5 : 6.6), 0)
}

/** タスクの下に並べる属性（システム・所要時間）。未確認の値は出さず、わかっている情報だけを見せる。 */
function stepPills(step: ProcessStep) {
  const hasAssetLinks = showProcessAssets.value && (activeProcessModel.value.assetLinks ?? []).some((link) => link.stepId === step.id)
  const items: { kind: 'system' | 'duration'; text: string }[] = []
  if (!hasAssetLinks && !isUnknownValue(step.system)) items.push({ kind: 'system', text: step.system as string })
  if (!isUnknownValue(step.duration)) items.push({ kind: 'duration', text: step.duration as string })
  let cursor = step.x
  return items.map((item) => {
    const width = Math.min(150, textWidth(item.text) + 26)
    const pill = { ...item, x: cursor, width }
    cursor += width + 6
    return pill
  })
}

function reviewQuestions(step: ProcessStep) {
  const connections = activeProcessModel.value.connections ?? []
  const assetLinks = activeProcessModel.value.assetLinks ?? []
  const incoming = connections.filter((connection) => connection.to === step.id)
  const outgoing = connections.filter((connection) => connection.from === step.id)
  const questions: string[] = []
  if (!step.needsReview && step.risk !== 'medium' && step.risk !== 'high') return questions
  if ((step.confidence ?? 100) < 80) questions.push(`ヒアリング根拠の確度が${step.confidence ?? 0}%です。担当者に、この作業内容で合っているか確認してください。`)
  if (!step.sourceQuotes?.length) questions.push('この工程に紐づく発言根拠が不足しています。どの発言・資料を根拠にするか確認してください。')
  if (isUnknownValue(step.system)) questions.push('利用する業務システムやExcel・台帳が未確認です。実際に使うシステム名、ファイル名、管理台帳を確認してください。')
  if (isUnknownValue(step.duration)) questions.push('標準時間が未確認です。1件あたりの作業時間、待ち時間、月次・随時の違いを確認してください。')
  if (isUnknownValue(step.monthlyVolume)) questions.push('月間件数が未確認です。おおよその処理件数と繁忙期の増減を確認してください。')
  if (step.type === 'gateway' && outgoing.some((connection) => !connection.label)) questions.push('分岐条件または分岐結果のラベルが不足しています。条件、判断基準、例外時の行き先を確認してください。')
  if (step.type !== 'start' && !incoming.length) questions.push('この工程の前工程が未接続です。何をきっかけに開始するか確認してください。')
  if (step.type !== 'end' && !outgoing.length) questions.push('この工程の次工程が未接続です。完了後に誰へ渡すか、またはここで終了するか確認してください。')
  if (step.type === 'task' && !assetLinks.some((link) => link.stepId === step.id) && !isUnknownValue(step.system)) questions.push('利用する業務システムは記載されていますが、業務アセットとの紐付けがありません。入力・参照・更新・出力の関係を確認してください。')
  if (step.risk === 'high') questions.push('高リスク工程です。属人化、手作業、判断ミス、不正・統制上の懸念がないか確認してください。')
  if (!questions.length) questions.push('AIが要確認と判定しています。ヒアリング根拠を見ながら、工程名・担当・前後関係に誤りがないか確認してください。')
  return [...new Set(questions)]
}

function reviewSummary(step: ProcessStep) {
  const question = reviewQuestions(step)[0]
  if (!question) return ''
  if (question.includes('分岐')) return '確認: 分岐条件'
  if (question.includes('システム') || question.includes('台帳')) return '確認: 利用アセット'
  if (question.includes('前工程') || question.includes('きっかけ')) return '確認: 前工程'
  if (question.includes('次工程') || question.includes('渡す')) return '確認: 次工程'
  if (question.includes('標準時間')) return '確認: 作業時間'
  if (question.includes('月間件数')) return '確認: 件数'
  if (question.includes('確度') || question.includes('根拠')) return '確認: 根拠'
  if (question.includes('高リスク')) return '確認: リスク'
  return '確認: 内容'
}

const canvasScrollElement = ref<HTMLElement | null>(null)
const STEP_TIP_MAX_WIDTH = 460
const STEP_TIP_MIN_WIDTH = 300
type CanvasBounds = { left: number; top: number; right: number; bottom: number }
const stepTipBounds = ref<CanvasBounds | null>(null)

function measureVisibleCanvasBounds(): CanvasBounds {
  const element = canvasScrollElement.value
  if (!element) return { left: 0, top: 0, right: processCanvasWidth.value, bottom: processCanvasHeight.value }
  return {
    left: element.scrollLeft / processZoom.value,
    top: element.scrollTop / processZoom.value,
    right: (element.scrollLeft + element.clientWidth) / processZoom.value,
    bottom: (element.scrollTop + element.clientHeight) / processZoom.value,
  }
}

function stepTipWidth() {
  const bounds = stepTipBounds.value ?? measureVisibleCanvasBounds()
  return Math.max(STEP_TIP_MIN_WIDTH, Math.min(STEP_TIP_MAX_WIDTH, bounds.right - bounds.left - 24))
}

function stepTipX(step: ProcessStep) {
  const bounds = stepTipBounds.value ?? measureVisibleCanvasBounds()
  const width = stepTipWidth()
  const nodeCenter = step.type === 'task' ? step.x + (step.width || 120) / 2 : step.x
  const preferred = nodeCenter - width / 2
  const minimum = bounds.left + 12
  const maximum = Math.max(minimum, bounds.right - width - 12)
  return Math.min(Math.max(preferred, minimum), maximum)
}

function stepTipHeight(step: ProcessStep) {
  const width = stepTipWidth()
  const descriptionCharacters = Math.max(18, Math.floor((width - 28) / 14))
  const titleCharacters = Math.max(10, Math.floor((width - 108) / 15))
  const wrappedLines = (text: string, charactersPerLine: number) => Math.max(
    1,
    text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0),
  )
  const description = step.description?.trim() ?? ''
  let height = 31 + wrappedLines(step.label, titleCharacters) * 21
  if (description) height += 9 + wrappedLines(description, descriptionCharacters) * 23
  if (step.needsReview && reviewSummary(step)) {
    height += 35 + reviewQuestions(step).slice(0, 2).reduce((sum, question) => sum + wrappedLines(question, descriptionCharacters) * 19 + 4, 0)
  }
  const bounds = stepTipBounds.value ?? measureVisibleCanvasBounds()
  const visibleHeight = Math.max(160, bounds.bottom - bounds.top - 24)
  return Math.min(visibleHeight, Math.max(96, height))
}

function stepTipY(step: ProcessStep) {
  const tipHeight = stepTipHeight(step)
  const bounds = stepTipBounds.value ?? measureVisibleCanvasBounds()
  const belowY = step.type === 'task' ? step.y + 48 : step.y + 42
  const aboveY = step.type === 'task' ? step.y - tipHeight - 8 : step.y - tipHeight - 18
  const minimum = bounds.top + 12
  const preferred = aboveY >= minimum ? aboveY : belowY
  const maximum = Math.max(minimum, bounds.bottom - tipHeight - 12)
  return Math.min(Math.max(preferred, minimum), maximum)
}

const STEP_TIP_DELAY_MS = 500
const STEP_TIP_CLOSE_DELAY_MS = 160

const hoveredStepTipId = ref('')
let stepTipTimer: number | undefined
let stepTipCloseTimer: number | undefined

/** Resolved from the live step list so a moved or deleted step drops its tip. */
const hoveredStepTip = computed(() => {
  if (!hoveredStepTipId.value) return undefined
  const step = activeProcessSteps.value.find((item) => item.id === hoveredStepTipId.value)
  return step && (step.description?.trim() || (step.needsReview && reviewSummary(step))) ? step : undefined
})

function openStepTip(step: ProcessStep) {
  window.clearTimeout(stepTipTimer)
  window.clearTimeout(stepTipCloseTimer)
  if (!step.description?.trim() && !(step.needsReview && reviewSummary(step))) return
  stepTipTimer = window.setTimeout(() => {
    stepTipBounds.value = measureVisibleCanvasBounds()
    hoveredStepTipId.value = step.id
  }, STEP_TIP_DELAY_MS)
}

function closeStepTip() {
  window.clearTimeout(stepTipTimer)
  window.clearTimeout(stepTipCloseTimer)
  hoveredStepTipId.value = ''
  stepTipBounds.value = null
}

function keepStepTipOpen() {
  window.clearTimeout(stepTipCloseTimer)
}

function scheduleCloseStepTip() {
  window.clearTimeout(stepTipTimer)
  window.clearTimeout(stepTipCloseTimer)
  stepTipCloseTimer = window.setTimeout(closeStepTip, STEP_TIP_CLOSE_DELAY_MS)
}

onBeforeUnmount(() => {
  window.clearTimeout(stepTipTimer)
  window.clearTimeout(stepTipCloseTimer)
})

const selectedReviewQuestions = computed(() => (selected.value ? reviewQuestions(selected.value) : []))

/** ステップ詳細のタブ。確認ポイントは詳細と分け、件数だけをタブに出す。選んだタブはステップを替えても保つ。 */
const propertiesTab = ref<'detail' | 'review'>('detail')
const reviewPointCount = computed(() => selectedReviewQuestions.value.length + selectedInformationFindings.value.length
  + (activeProcessModel.value?.reviewItems?.length ?? 0) + (activeProcessModel.value?.assumptions?.length ?? 0))

// --- タスクの入力・出力する情報 -------------------------------------------
const INFORMATION_GROUPS: Array<{ direction: InformationDirection; label: string; icon: string }> = [
  { direction: 'inputs', label: '入力', icon: 'mdi-login' },
  { direction: 'outputs', label: '出力', icon: 'mdi-logout' },
]
const selectedInformationFindings = computed(() => (
  selected.value && activeProcessModel.value ? informationFindings(activeProcessModel.value, selected.value) : []
))

/** 情報の取得元・格納先が変わったら、タスクとアセットの紐付けと図のレーンを作り直す。 */
function informationChanged() {
  if (activeProcessModel.value) syncAssetLinksFromInformation(activeProcessModel.value)
  reflowProcessAssets()
}

function stepTypeLabel(type: ProcessStep['type']) {
  return type === 'gateway' ? '判断・分岐' : type === 'start' ? '開始イベント' : type === 'end' ? '終了イベント' : '業務ステップ'
}

function informationOf(id: string) {
  return activeProcessModel.value?.information?.find((item) => item.id === id)
}


const stepInformationDialog = ref(false)

/** タスクのダブルクリックで、扱う情報を広い画面で確認・編集する。 */
function openStepInformationDialog(step: ProcessStep) {
  if (step.type !== 'task') return
  selectProcessStep(step)
  stepInformationDialog.value = true
}

const informationFileInput = ref<HTMLInputElement | null>(null)
const extractionTargetId = ref('')

/** 帳票や台帳の資料を選び、この情報に含まれる項目をAIで読み取る。 */
function pickInformationDocument(informationId: string) {
  extractionTargetId.value = informationId
  if (informationFileInput.value) informationFileInput.value.value = ''
  informationFileInput.value?.click()
}

const evidenceCount = computed(() => activeProcessSteps.value.reduce((sum, step) => sum + (step.evidence?.length ?? 0), 0))
const needsReviewCount = computed(() => activeProcessSteps.value.filter((step) => step.needsReview).length)
const highRiskCount = computed(() => activeProcessSteps.value.filter((step) => step.risk === 'high').length)
const labelledConnectors = computed(() => processConnectorPaths.value.filter((item) => item.label))
const editableConnectorPaths = computed(() => processConnectorPaths.value.filter((item) => item.from === selectedStep.value || item.to === selectedStep.value))

/** Paths whose direction already matches the arrow (from -> to / asset <-> step), so a
 *  particle animated along `path` naturally moves the way information actually flows. */
const flowingConnectorPaths = computed(() => processConnectorPaths.value.filter((item) => item.path && (item.from === selectedStep.value || item.to === selectedStep.value)))
/**
 * システムレーンへの関連線は全レーンを横切るので、選択中のステップ以外は薄く描く。
 * 消してしまうと、システムレーンにアセットだけが孤立して見えるため。
 */
function isFaintAssetAssociation(annotation: ProcessAssetAnnotation) {
  return isSystemAsset(annotation.asset) && annotation.stepId !== selectedStep.value
}
const flowingAssetAnnotations = computed(() => visibleProcessAssetAnnotations.value.filter((annotation) => annotation.stepId === selectedStep.value))

// 1本の経路に2粒子を流す。負のbeginで2つ目を途中から始め、待ち時間なく等間隔に見せる。
const connectorParticles = computed(() => flowingConnectorPaths.value.flatMap((item) => [
  { key: `${item.id}-a`, path: item.path, begin: '0s' },
  { key: `${item.id}-b`, path: item.path, begin: '-0.8s' },
]))
type ProcessView = 'flow' | 'ai'

const processView = ref<ProcessView>(proposalViewRequested.value ? 'ai' : 'flow')
proposalViewRequested.value = false
const improvementStepIds = ref<string[]>([])
watch(() => activeProcessModel.value?.businessId, () => {
  improvementStepIds.value = []
  proposalFocusStepId.value = ''
})
function showImprovementSteps(stepIds: string[]) {
  improvementStepIds.value = stepIds.filter((id) => activeProcessSteps.value.some((step) => step.id === id))
  selectedStep.value = improvementStepIds.value[0] ?? ''
  setProcessView('flow')
}

const processHeaderCollapsed = ref(true)
const showPropertiesPanel = computed(() => Boolean(
  processPropertiesOpen.value
  && selected.value
  && processView.value === 'flow',
))

function setProcessView(view: ProcessView) {
  processView.value = view
  closeStepTip()
}

function startOutputConnection() {
  setProcessTool('connect')
  connectionFrom.value = selected.value?.id ?? ''
}
</script>

<template>
  <section class="page page--process" :class="{ 'page--process-compact': processHeaderCollapsed }">
    <div v-show="!processHeaderCollapsed" class="page-heading page-heading--compact">
      <div class="process-heading-main">
        <div class="eyebrow">AS-IS PROCESS MODELER</div>
        <div class="process-title-display">
          <h1>{{ activeProcessModel.title }}</h1>
        <button type="button" title="業務名と紐付け部門を編集" aria-label="業務名と紐付け部門を編集" :disabled="!props.canEdit" @click="openProcessDetailsDialog()"><v-icon size="19">mdi-pencil-outline</v-icon></button>
        </div>
        <p>{{ selectedProcessDepartmentName }} ｜ 最終更新 {{ activeProcessModel.updatedAt }} ｜ {{ evidenceCount }}件の証跡 ｜ {{ activeProcessModel.sourceType === 'interview' ? `ヒアリング${selectedProcessSourceFragments.length}件から生成` : activeProcessModel.sourceType === 'document' ? `業務フロー資料${selectedProcessSourceFragments.length}件から生成` : '既存のAs-Isプロセス' }}</p>
      </div>
      <div class="heading-actions process-heading-actions">
        <span class="review-status" :class="`review-status--${activeProcessModel.reviewStatus}`">{{ activeProcessModel.reviewStatus }}</span>
        <span v-if="hasUnsavedProcessChanges" class="unsaved-badge" title="編集内容はまだ保存されていません"><v-icon size="16">mdi-circle-medium</v-icon>未保存の変更</span>
        <v-btn variant="outlined" prepend-icon="mdi-history" @click="versionDialog = true">版を比較</v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-message-text-clock-outline" @click="openProcessInterviewHistory()">ヒアリング履歴</v-btn>
        <v-btn class="process-heading-collapse" variant="text" prepend-icon="mdi-chevron-up" @click="processHeaderCollapsed = true">上部を折りたたむ</v-btn>
      </div>
    </div>

    <div v-show="!processHeaderCollapsed" class="process-loop-wrap">
      <div class="analysis-loop analysis-loop--process panel">
        <button class="analysis-loop__step--interview" :disabled="!props.canEdit" @click="emit('startDiscoveryInterview')">
          <span><v-icon size="16">mdi-account-voice</v-icon><em>1</em></span>
          <div><b>担当者にヒアリング</b><small>自由探索または業務指定で開始</small></div>
          <v-icon size="18">mdi-chevron-right</v-icon>
        </button>
        <button class="active analysis-loop__step--model" aria-current="step">
          <span><v-icon size="16">mdi-vector-polyline-edit</v-icon><em>2</em></span>
          <div><b>As-Isプロセスを作成</b><small>図を編集・確認</small></div>
          <v-icon size="18">mdi-chevron-right</v-icon>
        </button>
        <button class="analysis-loop__step--update" :disabled="!props.canEdit" @click="emit('continueInterview')">
          <span><v-icon size="16">mdi-message-question-outline</v-icon><em>3</em></span>
          <div><b>追加ヒアリングで更新</b><small>不明点をAIが質問</small></div>
          <v-icon size="18">mdi-refresh</v-icon>
        </button>
      </div>
    </div>

    <div v-if="processHeaderCollapsed" class="process-overview-compact panel">
      <div class="process-overview-summary"><v-icon size="18">mdi-vector-polyline</v-icon><b>{{ activeProcessModel.title }}</b><span v-if="hasUnsavedProcessChanges">未保存の変更あり</span></div>
      <div class="process-overview-actions">
        <button class="process-overview-expand" @click="processHeaderCollapsed = false"><v-icon size="18">mdi-chevron-down</v-icon>上部情報を表示</button>
      </div>
    </div>

    <div class="process-toolbar panel">
      <div class="process-tools">
        <div class="process-direction-toggle process-view-toggle" role="group" aria-label="図の表示形式">
          <button  data-tip="工程の流れを詳しく表示" :class="{ active: processView === 'flow' }" :aria-pressed="processView === 'flow'" @click="setProcessView('flow')"><v-icon>mdi-sitemap-outline</v-icon>フロー</button>
          <button  data-tip="ECRSによる業務の見直しと実現手段を確認" :class="{ active: processView === 'ai' }" :aria-pressed="processView === 'ai'" @click="setProcessView('ai')"><v-icon>mdi-robot-outline</v-icon>業務改善提案</button>
        </div>
        <template v-if="processView === 'flow'">
          <v-btn v-if="improvementStepIds.length" size="small" variant="text" @click="setProcessView('ai')">対象{{ improvementStepIds.length }}工程を強調中・改善案へ戻る</v-btn>
          <i></i>
          <button  data-tip="選択・移動" :class="{ active: processTool === 'select' }" @click="setProcessTool('select')"><v-icon>mdi-cursor-default-outline</v-icon></button>
          <button  data-tip="キャンバスを移動" :class="{ active: processTool === 'pan' }" @click="setProcessTool('pan')"><v-icon>mdi-hand-back-right-outline</v-icon></button>
          <button  data-tip="ステップを接続" :class="{ active: processTool === 'connect' }" @click="setProcessTool('connect')"><v-icon>mdi-vector-line</v-icon></button>
          <button class="lane-manage-button"  data-tip="レーン管理" aria-label="レーン管理" @click="openLaneManagement()"><v-icon>mdi-table-row</v-icon></button>
          <button class="auto-arrange-button"  data-tip="自動整列（接続順に並べ直す）" aria-label="自動整列" @click="autoArrangeProcess()"><v-icon>mdi-view-grid-plus-outline</v-icon></button>
          <button class="asset-view-toggle" :class="{ active: showProcessAssets }" :aria-pressed="showProcessAssets"  data-tip="アセット表示" aria-label="アセット表示" @click="showProcessAssets = !showProcessAssets"><v-icon>{{ showProcessAssets ? 'mdi-database-eye' : 'mdi-database-eye-off-outline' }}</v-icon></button>
          <button class="asset-view-toggle" :class="{ active: showBottlenecks }" :aria-pressed="showBottlenecks" aria-label="ボトルネック"  data-tip="ボトルネック（所要時間が長い工程を色の濃さで示す）" @click="showBottlenecks = !showBottlenecks"><v-icon>mdi-timer-sand</v-icon></button>
          <button class="asset-view-toggle" :class="{ active: showHandoffs }" :aria-pressed="showHandoffs" aria-label="受け渡し"  data-tip="受け渡し（担当をまたぐ接続を強調する）" @click="showHandoffs = !showHandoffs"><v-icon>mdi-swap-horizontal</v-icon></button>
          <i></i>
          <button class="tool-with-label" :disabled="!props.canEdit" @click="addProcessStep('task')"><v-icon>mdi-checkbox-blank-outline</v-icon>タスク</button>
          <button class="tool-with-label" :disabled="!props.canEdit" @click="addProcessStep('gateway')"><v-icon>mdi-rhombus-outline</v-icon>分岐</button>
          <i></i>
          <button  data-tip="縮小" @click="changeProcessZoom(-0.1)"><v-icon>mdi-minus</v-icon></button><span>{{ Math.round(processZoom * 100) }}%</span><button  data-tip="拡大" @click="changeProcessZoom(0.1)"><v-icon>mdi-plus</v-icon></button>
        </template>
      </div>
      <div class="process-legend">
        <template v-if="processView === 'flow'">
          <span v-if="processTool === 'connect'" class="connect-hint"><v-icon size="16">mdi-information-outline</v-icon>{{ connectionFrom ? '接続先のステップを選択' : '接続元のステップを選択' }}</span>
          <span><i class="risk-high"></i>高リスク</span>
          <span><i class="risk-medium"></i>要確認</span>
          <button class="bitmap-copy-button" :disabled="copyingProcessBitmap"  data-tip="As-Isフロー図全体を画像としてクリップボードへコピー" @click="copyProcessAsBitmap()"><v-icon size="18">{{ copyingProcessBitmap ? 'mdi-loading mdi-spin' : 'mdi-content-copy' }}</v-icon>{{ copyingProcessBitmap ? 'コピー中' : '画像をコピー' }}</button>
        </template>
        <template v-else-if="processView === 'ai'">
          <span class="analysis-stat ai-opportunity-stat"><v-icon size="16">mdi-lightbulb-on-outline</v-icon>{{ activeAiProposalSet.recommendedCount }} 推奨</span>
          <span class="analysis-stat ai-opportunity-stat"><v-icon size="16">mdi-creation-outline</v-icon>{{ activeAiProposalSet.assistCandidateCount }} AI支援</span>
          <span class="analysis-stat ai-opportunity-stat agent"><v-icon size="16">mdi-robot-outline</v-icon>{{ activeAiProposalSet.agentCandidateCount }} Agent候補</span>
        </template>
      </div>
      <button class="process-save-button" :class="{ 'process-save-button--dirty': hasUnsavedProcessChanges }" :disabled="!props.canEdit" :data-tip="hasUnsavedProcessChanges ? 'As-Isを保存（未保存の変更あり）' : 'As-Isを保存'" aria-label="As-Isを保存" @click="saveProcess()"><v-icon>mdi-content-save-outline</v-icon>保存</button>
    </div>

    <div
      ref="layoutElement"
      class="process-layout"
      :class="{ 'process-layout--wide': !showPropertiesPanel, 'process-layout--resizing': resizingProcessProperties }"
      :style="processLayoutStyle"
    >
      <section class="panel canvas-panel">
        <div
          v-if="processView === 'flow'"
          ref="canvasScrollElement"
          class="canvas-scroll"
          :class="[`tool-${processTool}`, { panning }]"
          @pointerdown="closeStepTip(); startCanvasPan($event)"
          @pointermove="moveOnCanvas($event)"
          @pointerup="endCanvasPointer(true)"
          @pointercancel="endCanvasPointer()"
          @pointerleave="endCanvasPointer()"
        >
          <svg
            ref="svgElement"
            class="process-svg process-svg--vertical"
            :style="processSvgStyle"
            :viewBox="`0 0 ${processCanvasWidth} ${processCanvasHeight}`"
            role="img"
            :aria-label="`${activeProcessModel.title}のプロセス図`"
          >
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9a9081" /></marker>
              <marker id="handoff-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#c0703a" /></marker>
              <marker id="asset-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#728b66" /></marker>
              <pattern id="grid" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#dce3df" /></pattern>
            </defs>
            <rect x="0" y="0" :width="processCanvasWidth" :height="processCanvasHeight" fill="url(#grid)"/>

            <g class="swimlanes">
              <template v-for="lane in processSwimlanes" :key="`${lane.label}-${lane.x}-${lane.y}`">
                <rect :x="lane.x" :y="lane.y" :width="lane.width" :height="lane.height"/>
                <rect class="lane-head" :x="lane.x" :y="lane.y" :width="lane.width" height="34" rx="0"/>
                <text :x="lane.labelX" :y="lane.labelY">{{ lane.label }}</text>
                <line
                  class="lane-resize-handle"
                  :class="{ active: resizingLaneLabel === lane.label, 'lane-resize-handle--vertical': true }"
                  :x1="lane.x + lane.width"
                  :x2="lane.x + lane.width"
                  :y1="lane.y"
                  :y2="lane.y + lane.height"
                  @pointerdown.stop="startLaneResize($event, lane.label, lane.width)"
                />
              </template>
            </g>

            <g class="connectors" marker-end="url(#arrow)">
              <path
                v-for="connection in processConnectorPaths"
                :key="connection.id"
                :d="connection.path"
                :class="{ 'connector-flowing': connection.from === selectedStep || connection.to === selectedStep, 'connector-handoff': showHandoffs && handoffConnectionIds.has(connection.id), 'connector-back': connection.back }"
                :marker-end="showHandoffs && handoffConnectionIds.has(connection.id) ? 'url(#handoff-arrow)' : undefined"
              />
              <text v-for="connection in labelledConnectors" :key="`${connection.id}-label`" class="flow-label" :x="connection.labelX" :y="connection.labelY" text-anchor="middle">{{ connection.label }}</text>
            </g>

            <g class="asset-associations">
              <path
                v-for="annotation in visibleProcessAssetAnnotations"
                :key="`${annotation.id}-path`"
                :d="annotation.path"
                :class="[`relation-${annotation.relation}`, { 'asset-path-flowing': annotation.stepId === selectedStep, 'asset-path-faint': isFaintAssetAssociation(annotation) }]"
                marker-end="url(#asset-arrow)"
              />
            </g>

            <!-- 選択中のステップに出入りする情報の流れを、経路に沿って動く粒子で表す。 -->
            <g class="flow-particles" aria-hidden="true">
              <circle v-for="particle in connectorParticles" :key="`flow-${particle.key}`" r="4.5" class="flow-dot flow-dot--connector">
                <animateMotion :path="particle.path" :begin="particle.begin" dur="1.6s" repeatCount="indefinite"/>
              </circle>
              <circle
                v-for="annotation in flowingAssetAnnotations"
                :key="`flow-asset-${annotation.id}`"
                r="4"
                :class="['flow-dot', 'flow-dot--asset', `flow-dot--relation-${annotation.relation}`]"
              >
                <animateMotion :path="annotation.path" dur="1.3s" repeatCount="indefinite"/>
              </circle>
            </g>

            <g class="process-assets">
              <g
                v-for="annotation in visibleProcessAssetAnnotations"
                :key="annotation.id"
                class="process-asset-node"
                :class="[`asset-type-${annotation.asset.type}`, `relation-${annotation.relation}`]"
                @pointerdown.stop="startAssetDrag($event, annotation)"
                @click.stop="openAssetAnnotation(annotation.asset.id)"
              >
                <title>{{ annotation.asset.name }}｜{{ annotation.asset.type }}｜{{ annotation.relation }}</title>
                <rect :x="annotation.x" :y="annotation.y" :width="annotation.width" :height="annotation.height" rx="6"/>
                <rect
                  class="asset-kind"
                  :x="annotation.x + 3"
                  :y="annotation.y + (annotation.height >= 40 ? 8 : 3)"
                  width="29"
                  :height="annotation.height >= 40 ? 24 : 18"
                  rx="4"
                />
                <text class="asset-kind-label" :x="annotation.x + 17.5" :y="annotation.y + annotation.height / 2 + 3.5" text-anchor="middle">{{ annotation.typeLabel }}</text>
                <text class="asset-node-label" :x="annotation.x + 38" :y="annotation.y + annotation.height / 2 + 4">{{ annotation.label }}</text>
              </g>
            </g>

            <g
              v-for="step in activeProcessSteps"
              :key="step.id"
              class="process-node"
              :class="[{ selected: selectedStep === step.id, 'improvement-highlight': improvementStepIds.includes(step.id), connecting: connectionFrom === step.id }, `risk-${step.risk || 'none'}`, `heat-${showBottlenecks ? stepHeat.get(step.id)?.level ?? 0 : 0}`]"
              @pointerdown="startNodeDrag($event, step)"
              @click.stop="selectProcessStep(step); openStepTip(step)"
              @dblclick.stop="openStepInformationDialog(step)"
              @pointerenter="openStepTip(step)"
              @pointerleave="scheduleCloseStepTip"
            >
              <template v-if="step.type === 'start' || step.type === 'end'">
                <circle :cx="step.x" :cy="step.y" r="18" :class="step.type"/>
                <path v-if="step.type === 'start'" :d="`M ${step.x - 4} ${step.y - 7} L ${step.x + 7} ${step.y} L ${step.x - 4} ${step.y + 7} Z`" class="terminal-glyph"/>
                <rect v-else :x="step.x - 6" :y="step.y - 6" width="12" height="12" rx="2.5" class="terminal-glyph"/>
                <text :x="step.x" :y="step.y + 35" text-anchor="middle">{{ step.label }}</text>
              </template>
              <template v-else-if="step.type === 'gateway'">
                <rect :x="step.x - 22" :y="step.y - 22" width="44" height="44" :transform="`rotate(45 ${step.x} ${step.y})`" class="gateway"/>
                <text :x="step.x" :y="step.y" text-anchor="middle" dominant-baseline="middle" class="gateway-mark">×</text>
                <text :x="step.x" :y="step.y - 40" text-anchor="middle" class="gateway-label">{{ step.label }}</text>
              </template>
              <template v-else>
                <rect :x="step.x" :y="step.y" :width="step.width" height="40" rx="10" class="task"/>
                <clipPath :id="`task-clip-${step.id}`"><rect :x="step.x" :y="step.y" :width="step.width" height="40" rx="10"/></clipPath>
                <rect :x="step.x" :y="step.y" width="6" height="40" class="task-accent" :clip-path="`url(#task-clip-${step.id})`"/>
                <text :x="step.x + 6 + ((step.width || 120) - 6) / 2" :y="step.y + 25" text-anchor="middle">{{ step.label }}</text>
                <g v-for="pill in stepPills(step)" :key="pill.kind" class="step-pill" :class="`step-pill--${pill.kind}`">
                  <title v-if="pill.kind === 'duration' && showBottlenecks && stepHeat.get(step.id)?.level">所要時間が長い工程です（{{ pill.text }}）</title>
                  <rect :x="pill.x" :y="step.y + 46" :width="pill.width" height="20" rx="10"/>
                  <path v-if="pill.kind === 'duration'" :d="`M ${pill.x + 10} ${step.y + 56} m -4.5 0 a 4.5 4.5 0 1 0 9 0 a 4.5 4.5 0 1 0 -9 0 M ${pill.x + 10} ${step.y + 53.5} v 2.7 l 1.9 1.1`" class="step-pill-icon"/>
                  <rect v-else :x="pill.x + 6" :y="step.y + 52" width="8" height="8" rx="2" class="step-pill-icon step-pill-icon--solid"/>
                  <text :x="pill.x + 19" :y="step.y + 60.5">{{ pill.text }}</text>
                </g>
                <circle v-if="step.risk === 'high' || step.risk === 'medium'" :cx="step.x + (step.width || 120) - 2" :cy="step.y + 2" r="7" class="risk-badge"/>
              </template>
              <g
                v-if="step.needsReview"
                class="review-mark"
                role="img"
                :aria-label="`要確認：${reviewQuestions(step).join('、')}`"
              >
                <circle :cx="step.type === 'task' ? step.x + 9 : step.x + 25" :cy="step.type === 'task' ? step.y + 7 : step.y - 25" r="8"/>
                <text :x="step.type === 'task' ? step.x + 9 : step.x + 25" :y="step.type === 'task' ? step.y + 11 : step.y - 21" text-anchor="middle">?</text>
              </g>
            </g>

            <g v-if="processTool === 'select'" class="connection-handles">
              <template v-for="connection in editableConnectorPaths" :key="`${connection.id}-handles`">
                <circle
                  v-if="connection.startPoint"
                  :cx="connection.startPoint.x"
                  :cy="connection.startPoint.y"
                  r="6"
                  class="connection-handle"
                  @pointerdown.stop="startConnectionAnchorDrag($event, connection.id, 'from')"
                >
                  <title>接続元の接続点を変更</title>
                </circle>
                <circle
                  v-if="connection.endPoint"
                  :cx="connection.endPoint.x"
                  :cy="connection.endPoint.y"
                  r="6"
                  class="connection-handle"
                  @pointerdown.stop="startConnectionAnchorDrag($event, connection.id, 'to')"
                >
                  <title>接続先の接続点を変更</title>
                </circle>
              </template>
            </g>

            <g v-if="hoveredStepTip" class="step-tip-layer">
              <foreignObject
                class="step-tip"
                :x="stepTipX(hoveredStepTip)"
                :y="stepTipY(hoveredStepTip)"
                :width="stepTipWidth()"
                :height="stepTipHeight(hoveredStepTip)"
                @pointerdown.stop
                @pointerenter="keepStepTipOpen"
                @pointerleave="scheduleCloseStepTip"
              >
                <div class="step-tip-card">
                  <strong><span>業務内容</span>{{ hoveredStepTip.label }}</strong>
                  <p v-if="hoveredStepTip.description?.trim()" class="step-tip-description">{{ hoveredStepTip.description }}</p>
                  <section v-if="hoveredStepTip.needsReview && reviewSummary(hoveredStepTip)" class="step-tip-review">
                    <b>{{ reviewSummary(hoveredStepTip) }}</b>
                    <p v-for="question in reviewQuestions(hoveredStepTip).slice(0, 2)" :key="question">{{ question }}</p>
                  </section>
                </div>
              </foreignObject>
            </g>
          </svg>
        </div>
        <ProcessAiProposalPanel
          v-else-if="processView === 'ai'"
          :title="activeProcessModel.title"
          :proposal-set="activeAiProposalSet"
          :generating="aiProposalGenerating"
          :error="aiProposalError"
          :can-edit="canEdit"
          :reviews="improvementReviews"
          :stale="improvementStale"
          :focus-step-id="proposalFocusStepId"
          :key="activeProcessModel.businessId"
          @review="reviewImprovement"
          @show-steps="showImprovementSteps"
          @show-map="emit('showImprovementMap', $event)"
          @clear-focus="proposalFocusStepId = ''"
          @generate="generateAiProposals"
        />
        <div class="canvas-insights">
          <div>
            <v-icon>{{ processView === 'flow' ? 'mdi-creation' : 'mdi-robot-outline' }}</v-icon>
            <template v-if="processView === 'flow'">
              <span v-if="activeProcessModel.sourceType === 'interview' || activeProcessModel.sourceType === 'document'"><b>業務ドラフト</b> {{ needsReviewCount }}件が要確認です。ノードを選ぶと根拠を確認できます。</span>
              <span v-else-if="highRiskCount"><b>リスク</b> 高リスクの工程が{{ highRiskCount }}件あります。ノードを選ぶと詳細を確認できます。</span>
              <span v-else><b>工程</b> ノードを選ぶと担当・時間・根拠を確認できます。</span>
            </template>
            <span v-else><b>業務改善提案</b> {{ activeAiProposalSet.recommendedCount }}件の推奨候補と、{{ activeAiProposalSet.needsInfoCount }}件の追加調査項目を提示しています。</span>
          </div>
          <div>
            <button v-if="processView === 'flow' && !processPropertiesOpen" @click="processPropertiesOpen = true"><v-icon size="16">mdi-dock-right</v-icon>詳細を表示</button>
          </div>
        </div>
      </section>

      <div
        v-if="showPropertiesPanel"
        class="process-panel-resizer"
        :class="{ active: resizingProcessProperties }"
        role="separator"
        aria-label="フロー図とステップ詳細の幅を調整"
        aria-orientation="vertical"
        :aria-valuenow="processPropertiesWidth"
        aria-valuemin="300"
        aria-valuemax="600"
        tabindex="0"
        title="左右にドラッグして幅を調整・ダブルクリックで初期幅に戻す"
        @pointerdown="startProcessPropertiesResize($event)"
        @pointermove="moveProcessPropertiesResize($event)"
        @pointerup="endProcessPropertiesResize()"
        @pointercancel="endProcessPropertiesResize()"
        @dblclick="resetProcessPropertiesWidth()"
        @keydown="resizeProcessPropertiesByKeyboard($event)"
      >
        <i></i>
        <span v-if="resizingProcessProperties">{{ processPropertiesWidth }}px</span>
      </div>

      <aside v-if="showPropertiesPanel && selected" class="panel properties-panel process-properties-editor">
        <div class="properties-header">
          <span>ステップ詳細</span>
          <div>
            <button v-if="selected.type !== 'start' && selected.type !== 'end'" title="ステップを削除" @click="deleteSelectedProcessStep()"><v-icon>mdi-trash-can-outline</v-icon></button>
            <button title="詳細を閉じる" @click="processPropertiesOpen = false"><v-icon>mdi-close</v-icon></button>
          </div>
        </div>

        <div class="selected-title">
          <!-- 種類はアイコンで分かるので、文字では出さない。読み上げとホバーには種類名を残す。 -->
          <span
            class="step-type"
            :class="`step-type--${selected.type}`"
            role="img"
            :aria-label="stepTypeLabel(selected.type)"
            :title="stepTypeLabel(selected.type)"
          ><v-icon>{{ selected.type === 'gateway' ? 'mdi-rhombus-outline' : selected.type === 'start' || selected.type === 'end' ? 'mdi-circle-outline' : 'mdi-checkbox-blank-outline' }}</v-icon></span>
          <div>
            <input v-model="selected.label" aria-label="業務ステップ名" :title="selected.label" :readonly="!props.canEdit" @input="resizeSelectedStepToLabel()" @blur="finishSelectedStepLabelEdit()" />
          </div>
        </div>

        <div class="properties-tabs" role="tablist" aria-label="ステップ詳細の表示">
          <button type="button" role="tab" :aria-selected="propertiesTab === 'detail'" :class="{ active: propertiesTab === 'detail' }" @click="propertiesTab = 'detail'"><v-icon size="17">mdi-text-box-outline</v-icon>詳細</button>
          <button type="button" role="tab" :aria-selected="propertiesTab === 'review'" :class="{ active: propertiesTab === 'review' }" @click="propertiesTab = 'review'">
            <v-icon size="17">mdi-comment-question-outline</v-icon>確認ポイント<em v-if="reviewPointCount">{{ reviewPointCount }}</em>
          </button>
        </div>

        <template v-if="propertiesTab === 'detail'">
          <div class="property-form">
            <label class="property-form__wide lane-property">
              <span>担当レーン</span>
              <div class="lane-selector">
                <v-select
                  :model-value="selected.lane ?? selected.actor"
                  :items="availableProcessLanes"
                  aria-label="担当レーン"
                  :disabled="!props.canEdit"
                  density="compact"
                  hide-details
                  @update:model-value="(value: string) => assignSelectedStepToLane(value)"
                ></v-select>
                <button type="button" title="新しい担当レーンを追加" @click="laneEditorOpen = !laneEditorOpen"><v-icon size="17">mdi-plus</v-icon>追加</button>
              </div>
              <div v-if="laneEditorOpen" class="lane-add-row">
                <v-text-field
                  v-model="newProcessLaneName"
                  aria-label="新しい担当レーン名"
                  placeholder="例：購買部門"
                  :readonly="!props.canEdit"
                  density="compact"
                  hide-details
                  @keydown.enter.prevent="addProcessLane()"
                ></v-text-field>
                <button type="button" :disabled="!newProcessLaneName.trim()" @click="addProcessLane()">追加して移動</button>
              </div>
              <small>選択または左右ドラッグで、このステップの担当レーンを変更できます。</small>
            </label>
            <v-text-field v-model="selected.system" label="業務システム" :readonly="!props.canEdit" placeholder="例：SAP / Excel" density="compact" hide-details @blur="syncSelectedStepSystemAssets()"></v-text-field>
            <v-text-field v-model="selected.duration" label="標準時間" :readonly="!props.canEdit" placeholder="例：15分/件" density="compact" hide-details></v-text-field>
            <v-text-field v-model="selected.monthlyVolume" label="月間件数" :readonly="!props.canEdit" placeholder="例：1,240件" density="compact" hide-details></v-text-field>
            <div v-if="selected.type === 'task'" class="property-form__wide process-drilldown-property">
              <span>詳細業務へのドリルダウン</span>
              <v-select
                v-model="selected.childBusinessId"
                :items="drilldownBusinessItems"
                aria-label="詳細業務へのドリルダウン"
                placeholder="このタスクを深掘りする業務を選択"
                :disabled="!props.canEdit"
                clearable
                density="compact"
                hide-details
                @update:model-value="markProcessDirty()"
              ></v-select>
              <button type="button" :disabled="!selected.childBusinessId" @click="openSelectedDrilldown"><v-icon size="17">mdi-arrow-down-bold-box-outline</v-icon>下位As-Isを開く</button>
              <small>人が連続して行う作業を別の業務フローとして分解し、このタスクから開けます。</small>
            </div>
            <label class="property-form__wide process-property-select">
              <span>リスク</span>
              <v-select
                v-model="selected.risk"
                :items="PROCESS_RISK_OPTIONS"
                item-title="label"
                item-value="value"
                aria-label="リスク"
                :disabled="!props.canEdit"
                density="compact"
                hide-details
              ></v-select>
            </label>
            <label class="property-form__wide process-property-select">
              <span>確認状態</span>
              <v-select
                v-model="selected.needsReview"
                :items="PROCESS_REVIEW_OPTIONS"
                item-title="label"
                item-value="value"
                aria-label="確認状態"
                :disabled="!props.canEdit"
                density="compact"
                hide-details
              ></v-select>
            </label>
            <label class="property-form__wide step-description-field"><span>補足説明</span><textarea v-model="selected.description" rows="6" :readonly="!props.canEdit" placeholder="判断条件や作業内容を入力"></textarea></label>
          </div>

          <!-- 入力・出力の情報は、ここでは要約だけを見せる。編集はタスクのダブルクリックで開く画面で行う。 -->
          <div v-if="selected.type === 'task'" class="property-section step-information-summary">
            <div class="property-section-heading">
              <h3>入力・出力する情報 <span>{{ (selected.inputs?.length ?? 0) + (selected.outputs?.length ?? 0) }}</span></h3>
              <button class="manage-assets-link" title="タスクのダブルクリックでも開けます" @click="openStepInformationDialog(selected)"><v-icon size="18">mdi-pencil-outline</v-icon>編集</button>
            </div>
            <dl>
              <div v-for="group in INFORMATION_GROUPS" :key="group.direction" :class="`step-information-summary--${group.direction}`">
                <dt><v-icon size="16">{{ group.icon }}</v-icon>{{ group.label }}</dt>
                <dd v-if="selected[group.direction]?.length">
                  <span v-for="ref in selected[group.direction]" :key="ref.informationId">
                    <em v-if="informationOf(ref.informationId)?.provisional" class="information-provisional" title="アセットの紐付けから作った仮の名前です">仮</em>{{ informationOf(ref.informationId)?.name ?? '名称未設定の情報' }}<small v-if="ref.assetIds?.length">{{ INFORMATION_ASSET_ROLE[group.direction].label }}：{{ ref.assetIds.map((id) => activeProcessAssets.find((asset) => asset.id === id)?.name).filter(Boolean).join('・') }}</small>
                  </span>
                </dd>
                <dd v-else class="empty">未設定</dd>
              </div>
            </dl>
            <small class="step-information-summary__hint">タスクをダブルクリックすると、情報の追加・名前・取得元と格納先・項目を編集できます。</small>
          </div>

          <div class="property-section step-assets-section">
            <div class="property-section-heading">
              <h3>利用アセット <span>{{ selectedStepAssetLinks.length }}</span></h3>
              <button class="manage-assets-link" @click="openAssetManagement()"><v-icon size="18">mdi-database-edit-outline</v-icon>一覧を管理</button>
            </div>
            <div v-if="selectedStepAssetLinks.length" class="step-asset-list">
              <article v-for="link in selectedStepAssetLinks" :key="link.id">
                <button class="step-asset-main" @click="openAssetManagement(link.assetId)">
                  <span><v-icon size="20">mdi-database-outline</v-icon></span>
                  <div><b>{{ assetForLink(link)?.name }}</b><small>{{ assetForLink(link)?.type }}・{{ assetForLink(link)?.status }}</small></div>
                </button>
                <span class="step-asset-role" :class="link.relation === '入力' ? 'step-asset-role--source' : 'step-asset-role--target'">{{ link.relation === '入力' ? '取得元' : '格納先' }}</span>
                <button class="unlink-asset" title="情報の取得元・格納先からこのアセットを外す" @click="unlinkAssetFromSelectedStep(link.id)"><v-icon size="16">mdi-link-off</v-icon></button>
                <small class="step-asset-information">{{ (link.informationIds ?? []).map((id) => informationOf(id)?.name).filter(Boolean).join('・') }}</small>
              </article>
            </div>
            <p v-if="!selectedStepAssetLinks.length && activeProcessAssets.length" class="step-asset-empty">「入力・出力する情報」で取得元・格納先にアセットを選ぶと、ここに表示されます。</p>
            <button v-if="!activeProcessAssets.length" class="empty-asset-button" @click="openAssetManagement()"><v-icon size="19">mdi-plus</v-icon>最初のアセットを登録</button>
          </div>

          <div class="property-section connection-editor">
            <h3>接続 <span>{{ selectedConnections.length }}</span></h3>
            <div class="connection-groups">
              <section class="connection-group connection-group--input">
                <header><span><v-icon size="18">mdi-login</v-icon>入力</span><em>{{ selectedInputConnections.length }}</em></header>
                <div v-if="selectedInputConnections.length" class="connection-list">
                  <article v-for="connection in selectedInputConnections" :key="connection.id">
                    <v-icon size="18">mdi-arrow-right</v-icon>
                    <span>{{ stepLabel(connection.from) }}<small>→ {{ selected.label }}</small></span>
                    <input v-model="connection.label" aria-label="入力接続の条件ラベル" :readonly="!props.canEdit" placeholder="条件ラベル"/>
                    <button title="入力接続を削除" @click="deleteConnection(connection.id)"><v-icon size="18">mdi-close</v-icon></button>
                  </article>
                </div>
                <p v-else class="connection-empty">入力接続はありません</p>
              </section>
              <section class="connection-group connection-group--output">
                <header><span><v-icon size="18">mdi-logout</v-icon>出力</span><em>{{ selectedOutputConnections.length }}</em></header>
                <div v-if="selectedOutputConnections.length" class="connection-list">
                  <article v-for="connection in selectedOutputConnections" :key="connection.id">
                    <v-icon size="18">mdi-arrow-right</v-icon>
                    <span>{{ selected.label }}<small>→ {{ stepLabel(connection.to) }}</small></span>
                    <input v-model="connection.label" aria-label="出力接続の条件ラベル" :readonly="!props.canEdit" placeholder="条件ラベル"/>
                    <button title="出力接続を削除" @click="deleteConnection(connection.id)"><v-icon size="18">mdi-close</v-icon></button>
                  </article>
                </div>
                <button class="empty-connection" @click="startOutputConnection"><v-icon size="18">mdi-plus</v-icon>出力接続を追加</button>
              </section>
            </div>
          </div>

          <div class="property-section step-evidence-section">
            <div class="property-section-heading">
              <h3>証跡 <span>{{ selected.evidence?.length ?? 0 }}</span></h3>
              <label class="attach-evidence"><v-icon size="16">mdi-paperclip</v-icon>追加<input type="file" multiple @change="attachEvidence($event)" /></label>
            </div>
            <button v-for="file in selected.evidence" :key="file" class="evidence-link" @click="evidenceDialog = true">
              <v-icon>mdi-file-document-outline</v-icon>
              <span>{{ file }}<small>このステップに紐づく証跡</small></span>
              <v-icon size="16">mdi-open-in-new</v-icon>
            </button>
            <p v-if="!selected.evidence?.length" class="empty-evidence">証跡ファイルはまだありません</p>
          </div>

          <div v-if="selected.sourceQuotes?.length" class="property-section interview-evidence">
            <div class="property-section-heading">
              <h3>ヒアリング根拠 <span>{{ selected.sourceQuotes.length }}</span></h3>
              <em>確度 {{ selected.confidence ?? 0 }}%</em>
            </div>
            <blockquote v-for="quote in selected.sourceQuotes" :key="quote"><v-icon size="20">mdi-format-quote-open</v-icon><p>{{ quote }}</p></blockquote>
          </div>
        </template>

        <template v-else>
          <div v-if="selectedReviewQuestions.length || selectedInformationFindings.length" class="property-section step-review-questions">
            <div class="property-section-heading">
              <h3>確認ポイント <span>{{ selectedReviewQuestions.length + selectedInformationFindings.length }}</span></h3>
              <em>{{ selectedReviewQuestions.length ? reviewSummary(selected) : '確認: 情報の流れ' }}</em>
            </div>
            <p v-for="question in selectedReviewQuestions" :key="question"><v-icon size="18">mdi-comment-question-outline</v-icon>{{ question }}</p>
            <p v-for="finding in selectedInformationFindings" :key="`${finding.kind}-${finding.informationId}`"><v-icon size="18">{{ finding.kind === 'unknown-source' ? 'mdi-help-circle-outline' : 'mdi-swap-horizontal' }}</v-icon>{{ finding.message }}</p>
          </div>

          <div v-if="activeProcessModel.reviewItems?.length || activeProcessModel.assumptions?.length" class="property-section draft-review-list">
            <h3>ドラフト全体の確認事項</h3>
            <p v-for="item in activeProcessModel.reviewItems" :key="item"><v-icon size="18">mdi-help-circle-outline</v-icon>{{ item }}</p>
            <p v-for="item in activeProcessModel.assumptions" :key="item"><v-icon size="18">mdi-alert-outline</v-icon>{{ item }}</p>
          </div>
            <p v-if="!reviewPointCount" class="properties-tab-empty"><v-icon size="18">mdi-check-circle-outline</v-icon>このステップに確認ポイントはありません。</p>
        </template>
      </aside>
    </div>
    <!-- 情報の項目を資料から抽出するときのファイル選択。パネルを閉じていてもダイアログから使えるよう外に置く。 -->
    <input ref="informationFileInput" class="attachment-file-input" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" @change="extractInformationItems(extractionTargetId, $event)"/>
    <StepInformationDialog
      v-model="stepInformationDialog"
      :model="activeProcessModel"
      :step="selected"
      :assets="activeProcessAssets"
      :can-edit="props.canEdit"
      :extracting="assetExtractionLoading"
      @change="informationChanged()"
      @extract="pickInformationDocument"
    />
  </section>
</template>
