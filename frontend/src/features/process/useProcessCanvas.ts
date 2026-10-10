import { ref, type ComputedRef, type Ref } from 'vue'
import type {
  OperationalAsset,
  ProcessAssetLanePosition,
  ProcessConnectionAnchor,
  ProcessModel,
  ProcessStep,
} from '../../models'
import { stepAnchor } from './process-geometry'
import {
  isSystemAsset,
  normalizeProcessLaneLayout,
  PROCESS_SYSTEM_LANE,
  processLaneLayouts,
  shiftContentsWithLaneOffsets,
  type ProcessLaneLayout,
} from './process-model'

export interface ProcessCanvasDeps {
  processTool: Ref<'select' | 'pan' | 'connect'>
  selectedStep: Ref<string>
  processPropertiesOpen: Ref<boolean>
  processZoom: Ref<number>
  svgElement: Ref<SVGSVGElement | null>
  activeProcessModel: ComputedRef<ProcessModel>
  activeProcessSteps: ComputedRef<ProcessStep[]>
  activeProcessAssets: ComputedRef<OperationalAsset[]>
  activeProcessLaneLayouts: ComputedRef<ProcessLaneLayout[]>
  processCanvasWidth: ComputedRef<number>
  processCanvasHeight: ComputedRef<number>
  /** ドラッグ中に図が縮んでスクロール位置がずれないよう、今の大きさを最小値として保つ。 */
  holdCanvasSize: () => void
  markProcessDirty: () => void
  openAssetManagement: (assetId?: string) => void
}

/**
 * As-Isキャンバス上のポインタ操作。ノード・アセットのドラッグ、接続点の付け替え、
 * レーン幅の変更、キャンバスのパンを、押下・移動・解放の流れで受け持つ。
 */
export function useProcessCanvas(deps: ProcessCanvasDeps) {
  const {
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
  } = deps

  const resizingLaneLabel = ref('')
  const laneResizeStart = ref({ clientX: 0, size: 0 })
  const draggingStepId = ref('')
  const dragStart = ref({ clientX: 0, clientY: 0, x: 0, y: 0 })
  const draggingAssetLinkId = ref('')
  const suppressNextAssetClick = ref(false)
  const assetDragStart = ref({ clientX: 0, clientY: 0, x: 0, y: 0, width: 0, height: 0 })
  const draggingConnectionAnchor = ref<{ connectionId: string; endpoint: 'from' | 'to' } | null>(null)
  const panning = ref(false)
  const panStart = ref({ clientX: 0, clientY: 0, scrollLeft: 0, scrollTop: 0 })
  /** 背景を押してから動かしたか。動かさずに離したら、何もない所のクリックとして選択を外す。 */
  const panMoved = ref(false)

  function startLaneResize(event: PointerEvent, lane: string, size: number) {
    resizingLaneLabel.value = lane
    laneResizeStart.value = { clientX: event.clientX, size }
    draggingStepId.value = ''
    panning.value = false
    ;(event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId)
  }

  function startNodeDrag(event: PointerEvent, step: ProcessStep) {
    if (processTool.value !== 'select') return
    event.stopPropagation()
    selectedStep.value = step.id
    processPropertiesOpen.value = true
    holdCanvasSize()
    draggingStepId.value = step.id
    dragStart.value = { clientX: event.clientX, clientY: event.clientY, x: step.x, y: step.y }
    ;(event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId)
  }

  function startAssetDrag(
    event: PointerEvent,
    annotation: { id: string; asset: OperationalAsset; x: number; y: number; width: number; height: number },
  ) {
    if (processTool.value !== 'select') return
    event.stopPropagation()
    holdCanvasSize()
    draggingAssetLinkId.value = annotation.id
    draggingConnectionAnchor.value = null
    suppressNextAssetClick.value = false
    assetDragStart.value = {
      clientX: event.clientX,
      clientY: event.clientY,
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.height,
    }
    ;(event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId)
  }

  function connectionAnchorAtPoint(step: ProcessStep, event: PointerEvent): ProcessConnectionAnchor {
    const svg = svgElement.value
    if (!svg) return 'bottom'
    const rect = svg.getBoundingClientRect()
    const x = (event.clientX - rect.left) / Math.max(rect.width, 1) * processCanvasWidth.value
    const y = (event.clientY - rect.top) / Math.max(rect.height, 1) * processCanvasHeight.value
    const candidates: Array<{ side: ProcessConnectionAnchor; point: { x: number; y: number } }> = [
      { side: 'top', point: stepAnchor(step, 'top') },
      { side: 'right', point: stepAnchor(step, 'right') },
      { side: 'bottom', point: stepAnchor(step, 'bottom') },
      { side: 'left', point: stepAnchor(step, 'left') },
    ]
    let nearest = {
      ...candidates[0],
      distance: Math.hypot(candidates[0].point.x - x, candidates[0].point.y - y),
    }
    candidates.slice(1).forEach((candidate) => {
      const distance = Math.hypot(candidate.point.x - x, candidate.point.y - y)
      if (distance < nearest.distance) nearest = { ...candidate, distance }
    })
    return nearest.side
  }

  function startConnectionAnchorDrag(event: PointerEvent, connectionId: string, endpoint: 'from' | 'to') {
    if (processTool.value !== 'select') return
    const connection = activeProcessModel.value?.connections.find((item) => item.id === connectionId)
    if (!connection) return
    event.stopPropagation()
    draggingConnectionAnchor.value = { connectionId, endpoint }
    draggingAssetLinkId.value = ''
    draggingStepId.value = ''
    panning.value = false
    ;(event.currentTarget as SVGElement).setPointerCapture?.(event.pointerId)
  }

  function openAssetAnnotation(assetId: string) {
    if (suppressNextAssetClick.value) {
      suppressNextAssetClick.value = false
      return
    }
    openAssetManagement(assetId)
  }

  function startCanvasPan(event: PointerEvent) {
    if (processTool.value === 'connect' || event.button !== 0) return
    const canvas = event.currentTarget as HTMLElement
    panning.value = true
    panMoved.value = false
    panStart.value = { clientX: event.clientX, clientY: event.clientY, scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop }
    canvas.setPointerCapture?.(event.pointerId)
  }

  function moveOnCanvas(event: PointerEvent) {
    if (draggingConnectionAnchor.value) {
      const model = activeProcessModel.value
      const { connectionId, endpoint } = draggingConnectionAnchor.value
      const connection = model?.connections.find((item) => item.id === connectionId)
      const stepId = endpoint === 'from' ? connection?.from : connection?.to
      const step = activeProcessSteps.value.find((item) => item.id === stepId)
      if (!model || !connection || !step) return
      const anchor = connectionAnchorAtPoint(step, event)
      if (endpoint === 'from') connection.fromAnchor = anchor
      else connection.toAnchor = anchor
      return
    }
    if (resizingLaneLabel.value) {
      const model = activeProcessModel.value
      if (!model) return
      const previousLayouts = processLaneLayouts(model)
      const laneLayout = previousLayouts.find((lane) => lane.label === resizingLaneLabel.value)
      if (!laneLayout) return
      const delta = event.clientX - laneResizeStart.value.clientX
      const nextSize = Math.max(laneLayout.minimumSize, Math.round(laneResizeStart.value.size + delta / processZoom.value))
      model.laneWidths = { ...(model.laneWidths ?? {}), [resizingLaneLabel.value]: nextSize }
      // サイズ変更でずれた後続レーンに、タスクや分岐、アセットを追従させる。
      shiftContentsWithLaneOffsets(model, previousLayouts)
      normalizeProcessLaneLayout(model, { preserveStepPositions: true })
      return
    }
    if (draggingAssetLinkId.value) {
      const model = activeProcessModel.value
      const link = model?.assetLinks?.find((item) => item.id === draggingAssetLinkId.value)
      const asset = link ? activeProcessAssets.value.find((item) => item.id === link.assetId) : undefined
      const systemLane = model
        ? processLaneLayouts(model).find((lane) => lane.label === PROCESS_SYSTEM_LANE)
        : undefined
      if (!model || !link || !asset) return
      const { clientX, clientY, x, y, width, height } = assetDragStart.value
      const constrainedToSystemLane = isSystemAsset(asset) && Boolean(systemLane)
      const laneX = constrainedToSystemLane ? systemLane!.x : 12
      const laneWidth = constrainedToSystemLane
        ? systemLane!.width
        : Math.max(600, ...activeProcessLaneLayouts.value.map((lane) => lane.x + lane.width + 25), ...activeProcessSteps.value.map((item) => item.x + (item.width ?? 50) + 50))
      const laneY = constrainedToSystemLane ? systemLane!.y : 12
      const laneHeight = constrainedToSystemLane
        ? Math.max(systemLane!.height, processCanvasHeight.value - systemLane!.y - 25)
        : Math.max(720, ...activeProcessSteps.value.map((item) => item.y + 120))
      const nextX = x + (event.clientX - clientX) / processZoom.value
      const nextY = y + (event.clientY - clientY) / processZoom.value
      const nextPosition: ProcessAssetLanePosition = {
        layoutDirection: 'vertical',
        x: Math.round(Math.min(Math.max(laneX + 12, nextX), Math.max(laneX + 12, laneX + laneWidth - width - 12))),
        y: Math.round(Math.min(Math.max(laneY + 12, nextY), Math.max(laneY + 12, laneY + laneHeight - height - 12))),
      }
      link.position = nextPosition
      // 同じオブジェクトを共有すると片方の更新がもう片方にも波及する。
      if (isSystemAsset(asset)) link.systemLanePosition = { ...nextPosition }
      suppressNextAssetClick.value = true
      return
    }
    if (draggingStepId.value) {
      const step = activeProcessSteps.value.find((item) => item.id === draggingStepId.value)
      if (!step) return
      step.x = Math.max(35, Math.round(dragStart.value.x + (event.clientX - dragStart.value.clientX) / processZoom.value))
      step.y = Math.max(45, Math.round(dragStart.value.y + (event.clientY - dragStart.value.clientY) / processZoom.value))
    }
    if (panning.value) {
      if (Math.hypot(event.clientX - panStart.value.clientX, event.clientY - panStart.value.clientY) > 4) panMoved.value = true
      const canvas = event.currentTarget as HTMLElement
      canvas.scrollLeft = panStart.value.scrollLeft - (event.clientX - panStart.value.clientX)
      canvas.scrollTop = panStart.value.scrollTop - (event.clientY - panStart.value.clientY)
    }
  }

  /** released は指を離したとき。キャンバスの外へ出ただけ（pointerleave）では選択を外さない。 */
  function endCanvasPointer(released = false) {
    if (released && panning.value && !panMoved.value && processTool.value === 'select') selectedStep.value = ''
    const wasDraggingStep = Boolean(draggingStepId.value)
    const wasResizingLane = Boolean(resizingLaneLabel.value)
    const wasDraggingAsset = Boolean(draggingAssetLinkId.value)
    const wasDraggingConnectionAnchor = Boolean(draggingConnectionAnchor.value)
    if (wasDraggingAsset || wasDraggingConnectionAnchor) markProcessDirty()
    if (draggingStepId.value && activeProcessModel.value) {
      activeProcessModel.value.layoutPositionsCustomized = true
    }
    if (draggingStepId.value && activeProcessModel.value?.lanes?.length) {
      const step = activeProcessSteps.value.find((item) => item.id === draggingStepId.value)
      if (step) {
        const layouts = processLaneLayouts(activeProcessModel.value)
        const crossAxisCenter = step.type === 'task' ? step.x + (step.width ?? 120) / 2 : step.x
        const matchedLaneIndex = layouts.findIndex((lane) => crossAxisCenter >= lane.x && crossAxisCenter < lane.x + lane.width)
        const laneStart = layouts[0]?.x ?? 0
        const laneIndex = matchedLaneIndex >= 0 ? matchedLaneIndex : crossAxisCenter < laneStart ? 0 : layouts.length - 1
        const lane = layouts[laneIndex] ?? layouts.at(-1)
        if (lane) {
          step.lane = lane.label
          step.laneTrack = lane.trackOffsets?.reduce((closestTrack, offset, track) => (
            Math.abs(crossAxisCenter - lane.x - lane.width / 2 - offset)
              < Math.abs(crossAxisCenter - lane.x - lane.width / 2 - (lane.trackOffsets?.[closestTrack] ?? 0))
              ? track
              : closestTrack
          ), 0) ?? 0
          activeProcessModel.value.layoutPositionsCustomized = true
          normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
        }
      }
    }
    if (wasDraggingStep || wasResizingLane) markProcessDirty()
    resizingLaneLabel.value = ''
    draggingStepId.value = ''
    draggingAssetLinkId.value = ''
    draggingConnectionAnchor.value = null
    panning.value = false
  }

  return {
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
  }
}
