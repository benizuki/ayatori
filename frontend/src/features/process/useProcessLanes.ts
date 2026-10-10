import { computed, ref, type ComputedRef } from 'vue'
import type { ProcessModel, ProcessStep } from '../../models'
import { useAuthSession } from '../admin/useAuthSession'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { normalizeProcessLaneLayout, processLaneLayouts, processStepLane, setStepVerticalLanePosition } from './process-model'

export interface ProcessLaneDeps {
  activeProcessModel: ComputedRef<ProcessModel | undefined>
  activeProcessSteps: ComputedRef<ProcessStep[]>
  selected: ComputedRef<ProcessStep | undefined>
  /** モデルのレーンと、ステップの担当から求めたレーン名の一覧。 */
  availableProcessLanes: ComputedRef<string[]>
  saveProcess: () => void | Promise<void>
}

/**
 * 担当レーンの追加・改名・並べ替え・削除と、レーン間のステップ移動。
 * ダイアログの状態もここで持つ。
 */
export function useProcessLanes(deps: ProcessLaneDeps) {
  const { activeProcessModel, activeProcessSteps, selected, availableProcessLanes, saveProcess } = deps
  const { notify } = useWorkspaceStore()
  const { canEdit } = useAuthSession()

  const laneEditorOpen = ref(false)
  const newProcessLaneName = ref('')
  const laneManagementDialog = ref(false)
  const laneDeleteDialog = ref(false)
  const laneDeleteIndex = ref(-1)
  const laneDeleteDestination = ref('')
  const laneBulkMoveFrom = ref('')
  const laneBulkMoveTo = ref('')
  const managedNewLaneName = ref('')

  const laneDeleteTarget = computed(() => activeProcessModel.value?.lanes?.[laneDeleteIndex.value] ?? '')
  const laneDeleteStepCount = computed(() => activeProcessSteps.value.filter((step) => (step.lane ?? step.actor) === laneDeleteTarget.value).length)

  // --- actions -----------------------------------------------------------
  function positionStepInLane(step: ProcessStep, laneIndex: number) {
    const model = activeProcessModel.value
    if (!model) return
    const lane = processLaneLayouts(model)[laneIndex]
    if (lane) setStepVerticalLanePosition(step, lane)
  }

  function ensureProcessLanes() {
    const model = activeProcessModel.value
    if (!model) return []
    if (!model.lanes?.length) {
      model.lanes = [...availableProcessLanes.value]
      model.steps.forEach((step) => {
        const laneIndex = model.lanes?.indexOf(step.lane ?? step.actor) ?? -1
        if (laneIndex >= 0) positionStepInLane(step, laneIndex)
      })
    }
    return model.lanes
  }

  function assignSelectedStepToLane(lane: string) {
    const step = selected.value
    const model = activeProcessModel.value
    const normalizedLane = lane.trim()
    if (!step || !model || !normalizedLane) return
    const lanes = ensureProcessLanes()
    if (!lanes.includes(normalizedLane)) lanes.push(normalizedLane)
    step.lane = normalizedLane
    const overlappingTracks = new Set(model.steps
      .filter((item) => item.id !== step.id
        && processStepLane(item) === normalizedLane
        && Math.abs(item.y - step.y) < 100)
      .map((item) => item.laneTrack ?? 0))
    let laneTrack = 0
    while (overlappingTracks.has(laneTrack)) laneTrack += 1
    step.laneTrack = laneTrack
    normalizeProcessLaneLayout(model)
  }

  function addProcessLane() {
    if (!canEdit.value) return
    const name = newProcessLaneName.value.trim()
    if (!name) return
    assignSelectedStepToLane(name)
    newProcessLaneName.value = ''
    laneEditorOpen.value = false
    notify(`担当レーン「${name}」を追加し、選択中のステップを移動しました`)
  }

  function reflowProcessLanes() {
    const model = activeProcessModel.value
    if (!model?.lanes?.length) return
    normalizeProcessLaneLayout(model)
  }

  function openLaneManagement() {
    const lanes = ensureProcessLanes()
    laneBulkMoveFrom.value = lanes[0] ?? ''
    laneBulkMoveTo.value = lanes[1] ?? lanes[0] ?? ''
    managedNewLaneName.value = ''
    laneManagementDialog.value = true
  }

  // 入力欄のDOMを書き戻さず、レーン名の状態だけを判断する。呼び出し側は
  // このあとlanesの内容へ表示を合わせ直す。
  function renameProcessLane(index: number, nextValue: string) {
    const model = activeProcessModel.value
    const currentName = model?.lanes?.[index]
    const nextName = nextValue.trim()
    if (!model?.lanes || !currentName) return
    if (nextName === currentName) return
    if (!nextName || model.lanes.some((lane, laneIndex) => laneIndex !== index && lane === nextName)) {
      notify(nextName ? `「${nextName}」はすでに存在します` : 'レーン名は空欄にできません')
      return
    }
    model.lanes[index] = nextName
    model.steps.forEach((step) => { if ((step.lane ?? step.actor) === currentName) step.lane = nextName })
    if (model.laneHeights?.[currentName]) {
      model.laneHeights[nextName] = model.laneHeights[currentName]
      delete model.laneHeights[currentName]
    }
    if (model.laneWidths?.[currentName]) {
      model.laneWidths[nextName] = model.laneWidths[currentName]
      delete model.laneWidths[currentName]
    }
    if (laneBulkMoveFrom.value === currentName) laneBulkMoveFrom.value = nextName
    if (laneBulkMoveTo.value === currentName) laneBulkMoveTo.value = nextName
    reflowProcessLanes()
  }

  function moveProcessLane(index: number, direction: -1 | 1) {
    const lanes = activeProcessModel.value?.lanes
    const nextIndex = index + direction
    if (!lanes || nextIndex < 0 || nextIndex >= lanes.length) return
    const [lane] = lanes.splice(index, 1)
    lanes.splice(nextIndex, 0, lane)
    reflowProcessLanes()
  }

  function addManagedProcessLane() {
    if (!canEdit.value) return
    const lanes = ensureProcessLanes()
    const name = managedNewLaneName.value.trim()
    if (!name) return
    if (lanes.includes(name)) {
      notify(`「${name}」はすでに存在します`)
      return
    }
    lanes.push(name)
    managedNewLaneName.value = ''
    laneBulkMoveTo.value = name
  }

  function requestDeleteProcessLane(index: number) {
    const lanes = activeProcessModel.value?.lanes ?? []
    if (lanes.length <= 1) return
    laneDeleteIndex.value = index
    laneDeleteDestination.value = lanes.find((_, laneIndex) => laneIndex !== index) ?? ''
    laneDeleteDialog.value = true
  }

  function confirmDeleteProcessLane() {
    if (!canEdit.value) return
    const model = activeProcessModel.value
    const target = laneDeleteTarget.value
    const destination = laneDeleteDestination.value
    if (!model?.lanes || !target || !destination || target === destination) return
    const movedCount = model.steps.filter((step) => (step.lane ?? step.actor) === target).length
    model.steps.forEach((step) => { if ((step.lane ?? step.actor) === target) step.lane = destination })
    model.lanes.splice(laneDeleteIndex.value, 1)
    if (model.laneHeights) delete model.laneHeights[target]
    if (model.laneWidths) delete model.laneWidths[target]
    laneDeleteDialog.value = false
    laneDeleteIndex.value = -1
    laneBulkMoveFrom.value = model.lanes[0] ?? ''
    laneBulkMoveTo.value = model.lanes[1] ?? model.lanes[0] ?? ''
    reflowProcessLanes()
    notify(`「${target}」を削除し、${movedCount}件のステップを「${destination}」へ移動しました`)
  }

  function moveAllLaneSteps() {
    if (!canEdit.value) return
    const from = laneBulkMoveFrom.value
    const to = laneBulkMoveTo.value
    if (!from || !to || from === to) return
    const targets = activeProcessSteps.value.filter((step) => (step.lane ?? step.actor) === from)
    targets.forEach((step) => { step.lane = to })
    reflowProcessLanes()
    notify(`${targets.length}件のステップを「${from}」から「${to}」へ移動しました`)
  }

  function saveLaneManagement() {
    saveProcess()
    laneManagementDialog.value = false
  }

  return {
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
  }
}
