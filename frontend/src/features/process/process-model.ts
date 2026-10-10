import type { OperationalAsset, OperationalAssetType, ProcessAssetLink, ProcessAssetRelation, ProcessConnection, ProcessModel, ProcessStep } from "../../models"
import { planProcessLayout } from "./process-layout"

export function cloneProcessStep(step: ProcessStep): ProcessStep {
  return {
    ...step,
    evidence: [...(step.evidence ?? [])],
    sourceFragmentIds: [...(step.sourceFragmentIds ?? [])],
    sourceQuotes: [...(step.sourceQuotes ?? [])],
    inputs: step.inputs?.map((ref) => ({ ...ref, assetIds: ref.assetIds ? [...ref.assetIds] : undefined })),
    outputs: step.outputs?.map((ref) => ({ ...ref, assetIds: ref.assetIds ? [...ref.assetIds] : undefined })),
  }
}

export function cloneConnections(connections: ProcessConnection[]) {
  return connections.map((connection) => ({ ...connection }))
}

export function cloneAssets(assets: OperationalAsset[] = []) {
  return assets.map((asset) => ({
    ...asset,
    sourceFragmentIds: [...(asset.sourceFragmentIds ?? [])],
    aliases: [...(asset.aliases ?? [])],
  }))
}

export function cloneAssetLinks(links: ProcessAssetLink[] = []) {
  return links.map((link) => ({
    ...link,
    position: link.position ? { ...link.position } : undefined,
    systemLanePosition: link.systemLanePosition ? { ...link.systemLanePosition } : undefined,
  }))
}

export const operationalAssetTypes: OperationalAssetType[] = ['業務システム', 'SaaS', 'Excel・台帳', 'ファイル', '共有フォルダ', 'メール', 'チャット', '紙帳票', 'データベース・API', 'その他']
export const processAssetRelations: ProcessAssetRelation[] = ['入力', '参照', '更新', '出力']

export function normalizedAssetKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/microsoft/g, '').replace(/[\s　_・\-／/]+/g, '')
}

export function isChatAssetName(name: string) {
  return /チャット|chat|slack|teams/i.test(name)
}

export function inferAssetType(name: string): OperationalAssetType {
  if (/excel|csv|access|台帳|チェックリスト/i.test(name)) return 'Excel・台帳'
  if (/outlook|メール|mail/i.test(name)) return 'メール'
  if (isChatAssetName(name)) return 'チャット'
  if (/共有フォルダ|ファイルサーバ|sharepoint|box|drive/i.test(name)) return '共有フォルダ'
  if (/紙|帳票|申請書/i.test(name)) return '紙帳票'
  if (/pdf|ファイル|文書/i.test(name)) return 'ファイル'
  if (/api|database|データベース|db\b/i.test(name)) return 'データベース・API'
  if (/salesforce|servicenow|workday/i.test(name)) return 'SaaS'
  return '業務システム'
}

export function inferAssetRelation(step: ProcessStep): ProcessAssetRelation {
  const text = `${step.label} ${step.description ?? ''}`
  if (/送信|通知|出力|発行|保存|作成/.test(text)) return '出力'
  if (/登録|更新|入力|記入|転記|アップロード/.test(text)) return '更新'
  if (/受領|受信|取得|取込/.test(text)) return '入力'
  return '参照'
}

export function systemAssetNames(system?: string) {
  if (!system || /^(未確認|未設定|なし|不明|-)$/.test(system.trim())) return []
  return [...new Set(system.split(/\s*(?:\/|／|、|,|\+|\||・)\s*/).map((name) => name.trim()).filter((name) => name && !/^(未確認|未設定|なし|不明|-)$/.test(name)))]
}

export function ensureProcessAssets(model: ProcessModel) {
  model.assets = cloneAssets(model.assets)
  model.assets.forEach((asset) => {
    if (isChatAssetName(asset.name)) asset.type = 'チャット'
  })
  model.assetLinks = cloneAssetLinks(model.assetLinks)
  model.assetLinks.forEach((link) => {
    if (link.dataDescription === undefined) {
      link.dataDescription = model.assets?.find((asset) => asset.id === link.assetId)?.dataDescription ?? ''
    }
  })
  model.suppressedAssetKeys = [...new Set(model.suppressedAssetKeys ?? [])]
  model.suppressedAssetLinkKeys = [...new Set(model.suppressedAssetLinkKeys ?? [])]
  const suppressedAssetKeys = new Set(model.suppressedAssetKeys)
  const suppressedAssetLinkKeys = new Set(model.suppressedAssetLinkKeys)
  const byKey = new Map(model.assets.map((asset) => [normalizedAssetKey(asset.name), asset]))
  model.steps.forEach((step) => {
    systemAssetNames(step.system).forEach((name) => {
      const key = normalizedAssetKey(name)
      if (suppressedAssetKeys.has(key)) return
      let asset = byKey.get(key)
      if (!asset) {
        asset = {
          id: `asset-${model.businessId}-${Date.now()}-${model.assets!.length + 1}`,
          name,
          type: inferAssetType(name),
          purpose: `${step.label}で利用`,
          owner: '未確認',
          location: '未確認',
          dataDescription: '',
          status: '未確認',
          confidence: step.confidence ?? 50,
          sourceFragmentIds: [...(step.sourceFragmentIds ?? [])],
        }
        model.assets!.push(asset)
        byKey.set(key, asset)
      }
      const alreadyLinked = model.assetLinks!.some((link) => link.assetId === asset!.id && link.stepId === step.id)
      const linkKey = `${asset.id}:${step.id}`
      if (!alreadyLinked && !suppressedAssetLinkKeys.has(linkKey)) {
        model.assetLinks!.push({
          id: `asset-link-${model.businessId}-${Date.now()}-${model.assetLinks!.length + 1}`,
          assetId: asset.id,
          stepId: step.id,
          relation: inferAssetRelation(step),
          dataDescription: asset.dataDescription,
        })
      }
    })
  })
  const validAssetIds = new Set(model.assets.map((asset) => asset.id))
  const validStepIds = new Set(model.steps.map((step) => step.id))
  model.assetLinks = model.assetLinks.filter((link, index, links) => validAssetIds.has(link.assetId) && validStepIds.has(link.stepId) && links.findIndex((item) => item.assetId === link.assetId && item.stepId === link.stepId && item.relation === link.relation) === index)
}

export const PROCESS_LANE_TOP = 25
export const PROCESS_VERTICAL_LANE_LEFT = 25
export const PROCESS_VERTICAL_LANE_BASE_WIDTH = 160
export const PROCESS_VERTICAL_TRACK_GAP = 180
export const PROCESS_VERTICAL_FLOW_TOP = 105
export const PROCESS_VERTICAL_LEVEL_GAP = 150
export const PROCESS_VERTICAL_MAX_TRACKS = 2
export const PROCESS_VERTICAL_BRANCH_ROW_GAP = 90
export const PROCESS_VERTICAL_ASSET_GAP = 10
export const PROCESS_SYSTEM_LANE = 'システム'

export type ProcessLaneLayout = {
  label: string
  x: number
  y: number
  width: number
  height: number
  maxTrack: number
  trackGap: number
  /** Track centers relative to the lane center. */
  trackOffsets?: number[]
  assetSideReserve: number
  minimumSize: number
}

export function processStepLane(step: ProcessStep) {
  return (step.lane ?? step.actor).trim()
}

export function isSystemAsset(asset: Pick<OperationalAsset, 'type'>) {
  return asset.type === '業務システム'
    || asset.type === 'SaaS'
    || asset.type === '共有フォルダ'
    || asset.type === 'データベース・API'
}

export function verticalAssetSideRows(model: Pick<ProcessModel, 'assetLinks' | 'assets'>, stepId: string) {
  const links = (model.assetLinks ?? []).filter((link) => {
    if (link.stepId !== stepId) return false
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    return !asset || !isSystemAsset(asset)
  })
  const left = links.filter((link) => link.relation === '入力' || link.relation === '参照').length
  return Math.max(left, links.length - left)
}

/** タスクの横に付くアセットの札（システムレーン以外）の幅。札の幅の決め方は図の描画と合わせる。 */
function sideAssetBadgeWidth(model: Pick<ProcessModel, 'assetLinks' | 'assets'>, stepId: string, side: 'left' | 'right') {
  const widths = (model.assetLinks ?? []).flatMap((link) => {
    if (link.stepId !== stepId) return []
    const linkSide = link.relation === '入力' || link.relation === '参照' ? 'left' : 'right'
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    if (linkSide !== side || !asset || isSystemAsset(asset)) return []
    return [Math.min(176, Math.max(108, Math.min(asset.name.length, 14) * 10 + 2 * 10 + 40)) + PROCESS_VERTICAL_ASSET_GAP]
  })
  return Math.max(0, ...widths)
}

export function verticalProcessLaneLayouts(model: ProcessModel): ProcessLaneLayout[] {
  const lanes = model.lanes?.length
    ? model.lanes
    : [...new Set(model.steps.map(processStepLane).filter(Boolean))]
  const hasSystemLaneAssets = (model.assetLinks ?? []).some((link) => {
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    return Boolean(asset && isSystemAsset(asset))
  })
  const laneLabels = hasSystemLaneAssets && !lanes.includes(PROCESS_SYSTEM_LANE)
    ? [...lanes, PROCESS_SYSTEM_LANE]
    : lanes
  const firstLaneTaskIds = new Set(model.steps
    .filter((step) => step.type === 'task' && processStepLane(step) === laneLabels[0])
    .map((step) => step.id))
  const firstLaneLeftAssetWidths = (model.assetLinks ?? []).flatMap((link) => {
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    if (!firstLaneTaskIds.has(link.stepId)
      || (link.relation !== '入力' && link.relation !== '参照')
      || !asset
      || isSystemAsset(asset)) return []
    const compactNameLength = Math.min(asset.name.length, 14)
    return [Math.min(176, Math.max(108, compactNameLength * 10 + link.relation.length * 10 + 40))]
  })
  const firstLaneLeftAssetReserve = firstLaneLeftAssetWidths.length
    ? Math.max(...firstLaneLeftAssetWidths) + PROCESS_VERTICAL_ASSET_GAP + 10
    : 0
  let x = PROCESS_VERTICAL_LANE_LEFT + firstLaneLeftAssetReserve
  return laneLabels.map((label) => {
    const laneSteps = model.steps.filter((step) => processStepLane(step) === label)
    const maxTrack = Math.max(0, ...laneSteps.map((step) => Math.max(0, step.laneTrack ?? 0)))
    // Reserve only the width each track actually needs. A single long task must
    // not multiply the gap of every branch track in the lane.
    const trackWidths = Array.from({ length: maxTrack + 1 }, (_, track) => (
      label === PROCESS_SYSTEM_LANE
        ? 240
        : Math.max(150, ...laneSteps
          .filter((step) => Math.max(0, step.laneTrack ?? 0) === track)
          .map(readableTaskWidth))
    ))
    // 列と列の間には、左の列の右側の札と、右の列の左側の札が並ぶ。その幅を見込んで間を空ける。
    const trackSideReserve = (track: number, side: 'left' | 'right') => Math.max(0, ...laneSteps
      .filter((step) => Math.max(0, step.laneTrack ?? 0) === track)
      .map((step) => sideAssetBadgeWidth(model, step.id, side)))
    const trackGaps = trackWidths.slice(1).map((_, index) => 40 + trackSideReserve(index, 'right') + trackSideReserve(index + 1, 'left'))
    const trackContentWidth = trackWidths.reduce((total, width) => total + width, 0)
      + trackGaps.reduce((total, gap) => total + gap, 0)
    let trackCursor = -trackContentWidth / 2
    const trackOffsets = trackWidths.map((width, index) => {
      const center = trackCursor + width / 2
      trackCursor += width + (trackGaps[index] ?? 0)
      return center
    })
    const trackGap = trackOffsets.length > 1
      ? Math.max(...trackOffsets.slice(1).map((offset, index) => offset - trackOffsets[index]))
      : PROCESS_VERTICAL_TRACK_GAP
    const assetSideReserve = 0
    const automaticWidth = Math.max(PROCESS_VERTICAL_LANE_BASE_WIDTH, trackContentWidth + 80)
    const width = Math.max(automaticWidth, model.laneWidths?.[label] ?? 0)
    const layout = { label, x, y: PROCESS_LANE_TOP, width, height: 0, maxTrack, trackGap, trackOffsets, assetSideReserve, minimumSize: automaticWidth }
    x += width
    return layout
  })
}

export function processLaneLayouts(model: ProcessModel): ProcessLaneLayout[] {
  return verticalProcessLaneLayouts(model)
}

/**
 * レーンのサイズを変えると後続レーンの開始位置がずれる。ステップと配置を保存した
 * アセットを同じ量だけ動かし、レーンとの相対位置を保ったままにする。
 * previousLayouts はサイズ変更前の processLaneLayouts の結果を渡す。
 */
export function shiftContentsWithLaneOffsets(model: ProcessModel, previousLayouts: ProcessLaneLayout[]) {
  const offsets = new Map<string, number>()
  processLaneLayouts(model).forEach((lane) => {
    const previous = previousLayouts.find((item) => item.label === lane.label)
    if (!previous) return
    const offset = Math.round(lane.x - previous.x)
    if (offset) offsets.set(lane.label, offset)
  })
  if (!offsets.size) return
  const offsetByStepId = new Map<string, number>()
  model.steps.forEach((step) => {
    const offset = offsets.get(processStepLane(step))
    if (!offset) return
    offsetByStepId.set(step.id, offset)
    step.x += offset
  })
  const systemLaneOffset = offsets.get(PROCESS_SYSTEM_LANE) ?? 0
  ;(model.assetLinks ?? []).forEach((link) => {
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    // システムアセットはシステムレーンに置かれるため、紐づくステップではなく
    // システムレーンのずれに従う。
    const offset = asset && isSystemAsset(asset)
      ? systemLaneOffset
      : offsetByStepId.get(link.stepId) ?? 0
    if (!offset) return
    // position と systemLanePosition が同じオブジェクトを指す場合に二重加算しない。
    new Set([link.position, link.systemLanePosition]).forEach((position) => {
      if (!position || position.layoutDirection !== 'vertical') return
      position.x += offset
    })
  })
}

export function setStepVerticalLanePosition(step: ProcessStep, lane: ProcessLaneLayout) {
  const track = Math.min(lane.maxTrack, Math.max(0, step.laneTrack ?? 0))
  const trackOffset = lane.trackOffsets?.[track] ?? (track - lane.maxTrack / 2) * lane.trackGap
  const centerX = lane.x + lane.width / 2 + trackOffset
  step.x = step.type === 'task' ? centerX - (step.width ?? readableTaskWidth(step)) / 2 : centerX
}

/** Keep alternate paths owned by the same actor on separate rows of one lane. */
export function normalizeProcessLaneLayout(model: ProcessModel, options: { preserveStepPositions?: boolean } = {}) {
  if (!model.lanes?.length) model.lanes = [...new Set(model.steps.map(processStepLane).filter(Boolean))]
  model.steps.forEach((step) => { step.laneTrack = Math.max(0, step.laneTrack ?? 0) })
  // Deleted or moved branches can leave gaps such as tracks 0 and 3. Pack the
  // remaining tracks so invisible empty columns do not keep the lane wide.
  if (!options.preserveStepPositions) {
    const stepsByLane = new Map<string, ProcessStep[]>()
    model.steps.forEach((step) => {
      const lane = processStepLane(step)
      stepsByLane.set(lane, [...(stepsByLane.get(lane) ?? []), step])
    })
    stepsByLane.forEach((steps) => {
      const tracks = [...new Set(steps.map((step) => Math.max(0, step.laneTrack ?? 0)))].sort((a, b) => a - b)
      const compactTrack = new Map(tracks.map((track, index) => [track, index]))
      steps.forEach((step) => { step.laneTrack = compactTrack.get(Math.max(0, step.laneTrack ?? 0)) ?? 0 })
    })
  }
  const layouts = processLaneLayouts(model)
  if (options.preserveStepPositions) return
  model.steps.forEach((step) => {
    const lane = layouts.find((item) => item.label === processStepLane(step))
    if (!lane) return
    setStepVerticalLanePosition(step, lane)
  })
}

export function readableTaskWidth(step: ProcessStep) {
  if (step.type !== 'task') return step.type === 'gateway' ? 62 : 44
  const labelWidth = Array.from(step.label).reduce((width, character) => width + (/^[\x00-\xff]$/.test(character) ? 7.5 : 13), 0) + 38
  return Math.min(520, Math.max(150, Math.ceil(labelWidth)))
}

/** 工程の縦方向の段。戻りの線（差し戻し・再照合）を除いた流れで決める。 */
export function processLevels(model: Pick<ProcessModel, 'steps' | 'connections'>) {
  return planProcessLayout(model.steps, model.connections).levels
}

/**
 * 自動整列。人がフロー図を描くときのように、本流を担当ごとの中央の列にそろえ、
 * 例外や差し戻しの工程はその担当の脇の列に出す。段は戻りの線を除いた流れで決める。
 */
export function arrangeProcessVertically(model: ProcessModel) {
  const plan = planProcessLayout(model.steps, model.connections)
  const levels = plan.levels
  model.steps.forEach((step) => {
    if (step.type === 'task') step.width = readableTaskWidth(step)
    step.laneTrack = 0
  })
  const laneLevelGroups = new Map<string, ProcessStep[]>()
  const branchRows = new Map<string, number>()
  model.steps.forEach((step) => {
    const key = `${processStepLane(step)}\u0000${levels.get(step.id) ?? 0}`
    laneLevelGroups.set(key, [...(laneLevelGroups.get(key) ?? []), step])
  })
  // 本流が通る担当では、脇道の工程を本流の列（左）に置かず、右の列へ出す。
  const lanesWithMainPath = new Set(model.steps.filter((step) => plan.mainPath.has(step.id)).map(processStepLane))
  const rowsByLevel = new Map<number, number>()
  laneLevelGroups.forEach((steps, key) => {
    const sorted = [...steps].sort((a, b) => Number(plan.mainPath.has(b.id)) - Number(plan.mainPath.has(a.id)) || a.x - b.x)
    const lane = key.split('\u0000')[0]
    const firstSlot = !plan.mainPath.has(sorted[0].id) && lanesWithMainPath.has(lane) ? 1 : 0
    sorted.forEach((step, index) => {
      const slot = firstSlot + index
      step.laneTrack = slot % PROCESS_VERTICAL_MAX_TRACKS
      branchRows.set(step.id, Math.floor(slot / PROCESS_VERTICAL_MAX_TRACKS))
    })
    const level = Number(key.split('\u0000')[1])
    rowsByLevel.set(level, Math.max(rowsByLevel.get(level) ?? 1, Math.ceil((firstSlot + sorted.length) / PROCESS_VERTICAL_MAX_TRACKS)))
  })

  const maxLevel = Math.max(0, ...levels.values())
  const levelCenters: number[] = [PROCESS_VERTICAL_FLOW_TOP]
  for (let level = 1; level <= maxLevel; level += 1) {
    const previousAssetRows = Math.max(0, ...model.steps
      .filter((step) => (levels.get(step.id) ?? 0) === level - 1)
      .map((step) => verticalAssetSideRows(model, step.id)))
    levelCenters[level] = levelCenters[level - 1]
      + PROCESS_VERTICAL_LEVEL_GAP
      + ((rowsByLevel.get(level - 1) ?? 1) - 1) * PROCESS_VERTICAL_BRANCH_ROW_GAP
      + Math.max(0, previousAssetRows - 4) * 30
  }
  model.steps.forEach((step) => {
    const centerY = (levelCenters[levels.get(step.id) ?? 0] ?? PROCESS_VERTICAL_FLOW_TOP)
      + (branchRows.get(step.id) ?? 0) * PROCESS_VERTICAL_BRANCH_ROW_GAP
    step.y = step.type === 'task' ? centerY - 20 : centerY
  })
  // 整列し直したら、人が付け替えた接続点は新しい位置に合わなくなるので自動に戻す。
  model.connections.forEach((connection) => {
    delete connection.fromAnchor
    delete connection.toAnchor
  })
  const layouts = verticalProcessLaneLayouts(model)
  model.steps.forEach((step) => {
    const lane = layouts.find((item) => item.label === processStepLane(step))
    if (lane) setStepVerticalLanePosition(step, lane)
  })
}

export function verticalLayoutNeedsRepair(model: ProcessModel) {
  model.steps.forEach((step) => { if (step.type === 'task') step.width = readableTaskWidth(step) })
  return model.steps.some((step, index) => model.steps.slice(index + 1).some((other) => {
    if (processStepLane(step) !== processStepLane(other) || (step.laneTrack ?? 0) !== (other.laneTrack ?? 0)) return false
    const stepTop = step.type === 'task' ? step.y : step.y - (step.type === 'gateway' ? 31 : 18)
    const stepBottom = step.type === 'task' ? step.y + 40 : step.y + (step.type === 'gateway' ? 31 : 18)
    const otherTop = other.type === 'task' ? other.y : other.y - (other.type === 'gateway' ? 31 : 18)
    const otherBottom = other.type === 'task' ? other.y + 40 : other.y + (other.type === 'gateway' ? 31 : 18)
    return Math.min(stepBottom, otherBottom) - Math.max(stepTop, otherTop) > -38
  }))
}
