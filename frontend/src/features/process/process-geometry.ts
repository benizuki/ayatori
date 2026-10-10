/**
 * As-Isキャンバスの幾何計算。ノードの接続点、接続線の経路、アセット注釈の配置を、
 * モデルから座標を返す純粋な関数として持つ（Vueの状態に依存しない）。
 */
import {
  isSystemAsset,
  PROCESS_SYSTEM_LANE,
  PROCESS_VERTICAL_ASSET_GAP,
  type ProcessLaneLayout,
} from './process-model'
import { assetRoleShortLabel } from './process-information'
import type {
  OperationalAsset,
  OperationalAssetType,
  ProcessAssetLink,
  ProcessConnection,
  ProcessConnectionAnchor,
  ProcessModel,
  ProcessStep,
} from '../../models'

export interface AssetAnnotationInput {
  model: ProcessModel | undefined
  steps: ProcessStep[]
  assets: OperationalAsset[]
  laneLayouts: ProcessLaneLayout[]
  /** アセットを置けるキャンバスの高さ（システムレーンの下端の計算に使う）。 */
  processCanvasHeight: number
}

export function stepAnchor(step: ProcessStep, side: 'left' | 'right' | 'top' | 'bottom', offset = 0) {
  const radius = step.type === 'gateway' ? 31 : 18
  if (step.type === 'start' || step.type === 'end' || step.type === 'gateway') {
    // Offsets slide the anchor along the side while the outward distance
    // shrinks so the point stays on the circle/diamond boundary.
    const clamped = Math.max(-(radius - 12), Math.min(radius - 12, offset))
    const outward = step.type === 'gateway'
      ? radius - Math.abs(clamped)
      : Math.sqrt(Math.max(radius * radius - clamped * clamped, 144))
    if (side === 'left' || side === 'right') return { x: step.x + (side === 'right' ? outward : -outward), y: step.y + clamped }
    return { x: step.x + clamped, y: step.y + (side === 'bottom' ? outward : -outward) }
  }
  const width = step.width ?? 120
  if (side === 'left' || side === 'right') {
    const y = Math.max(step.y + 8, Math.min(step.y + 32, step.y + 20 + offset))
    return { x: step.x + (side === 'right' ? width : 0), y }
  }
  const x = Math.max(step.x + 12, Math.min(step.x + width - 12, step.x + width / 2 + offset))
  return { x, y: step.y + (side === 'bottom' ? 40 : 0) }
}

export function stepCenter(step: ProcessStep) {
  return {
    x: step.type === 'task' ? step.x + (step.width ?? 120) / 2 : step.x,
    y: step.type === 'task' ? step.y + 20 : step.y,
  }
}

export function resolveConnectionSides(
  connection: { fromAnchor?: ProcessConnectionAnchor; toAnchor?: ProcessConnectionAnchor },
  from: ProcessStep,
  to: ProcessStep,
): { sourceSide: ProcessConnectionAnchor; targetSide: ProcessConnectionAnchor } {
  const fromCenter = stepCenter(from)
  const toCenter = stepCenter(to)
  const deltaX = toCenter.x - fromCenter.x
  const deltaY = toCenter.y - fromCenter.y
  const downstreamEnd = from.type === 'task' && to.type === 'end' && deltaY > 28
  const horizontalBranch = Math.abs(deltaX) > Math.abs(deltaY) * 1.15
  const autoSourceSide: ProcessConnectionAnchor = horizontalBranch
    ? deltaX < 0 ? 'left' : 'right'
    : deltaY < 0 ? 'top' : 'bottom'
  const autoTargetSide: ProcessConnectionAnchor = horizontalBranch
    ? deltaX < 0 ? 'right' : 'left'
    : deltaY < 0 ? 'bottom' : 'top'
  return {
    sourceSide: connection.fromAnchor ?? (downstreamEnd ? 'bottom' : autoSourceSide),
    targetSide: connection.toAnchor ?? (downstreamEnd ? 'top' : autoTargetSide),
  }
}

function gatewayBranchLabelPosition(
  step: ProcessStep,
  sourceSide: ProcessConnectionAnchor,
  start: { x: number; y: number },
  branchOffset: number,
): { x: number; y: number } | undefined {
  if (step.type !== 'gateway') return undefined

  // Keep a condition next to the first segment leaving the gateway. Placing
  // it at the route midpoint makes long branches look unrelated to the
  // decision that produced them.
  if (sourceSide === 'left') return { x: start.x - 42, y: start.y - 11 + branchOffset }
  if (sourceSide === 'right') return { x: start.x + 42, y: start.y - 11 + branchOffset }
  if (sourceSide === 'top') return { x: start.x + 28 + branchOffset, y: start.y - 34 }
  return { x: start.x + 28 + branchOffset, y: start.y + 34 }
}


type Point = { x: number; y: number }
type Box = { left: number; right: number; top: number; bottom: number }

/** 線が避けるときの、ノードの外形からの余白。 */
const OBSTACLE_PADDING = 10
/** 角の丸み。短い線分では線分の半分までに抑える。 */
const CORNER_RADIUS = 12
/** 迂回する線を、避けるノードの外形（余白込み）からさらにどれだけ離すか。 */
const DETOUR_CLEARANCE = 14
/** 他の接続が出入りする辺の側へ迂回するときに足す余白。 */
const BUSY_SIDE_EXTRA_CLEARANCE = 44
/** 進む線を左へ迂回させるときの減点。左は戻りの線が通るため。 */
const LEFT_DETOUR_PENALTY = 120
/** 戻りの線をノードの左端からどれだけ離して通すか。複数あるときは外側へ順にずらす。 */
const BACK_EDGE_GAP = 22
const BACK_EDGE_STEP = 10
/** 戻りの線がノードの上下から出入りするときの、縦方向の逃げ。 */
const BACK_EDGE_STUB = 14

export type ObstacleBox = Box & { id?: string }

export function stepBox(step: ProcessStep, padding = 0): Box {
  if (step.type === 'task') {
    return { left: step.x - padding, right: step.x + (step.width ?? 120) + padding, top: step.y - padding, bottom: step.y + 40 + padding }
  }
  const radius = (step.type === 'gateway' ? 31 : 18) + padding
  return { left: step.x - radius, right: step.x + radius, top: step.y - radius, bottom: step.y + radius }
}

/** 軸に平行な線分が箱を横切るか。端点が箱の縁に触れるだけなら横切らない扱いにする。 */
function segmentHitsBox(a: Point, b: Point, box: Box) {
  if (a.x === b.x) {
    const top = Math.min(a.y, b.y)
    const bottom = Math.max(a.y, b.y)
    return a.x > box.left && a.x < box.right && bottom > box.top && top < box.bottom
  }
  if (a.y === b.y) {
    const left = Math.min(a.x, b.x)
    const right = Math.max(a.x, b.x)
    return a.y > box.top && a.y < box.bottom && right > box.left && left < box.right
  }
  return false
}

function pathHits(points: Point[], boxes: Box[]) {
  let hits = 0
  for (let index = 1; index < points.length; index += 1) {
    hits += boxes.filter((box) => segmentHitsBox(points[index - 1], points[index], box)).length
  }
  return hits
}

/** 同じ点と、一直線に並ぶ途中の点を除く。角の丸めが余計な角を作らないようにする。 */
function simplifyPoints(points: Point[]) {
  const unique = points.filter((point, index) => index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y)
  return unique.filter((point, index) => {
    if (index === 0 || index === unique.length - 1) return true
    const previous = unique[index - 1]
    const next = unique[index + 1]
    return !((previous.x === point.x && point.x === next.x) || (previous.y === point.y && point.y === next.y))
  })
}

/**
 * 途中のノードを横切る線分を、そのノードの脇へ迂回させる。
 * 線分ごとに局所的に回り込むので、経路全体の形（どの辺から出てどの辺へ入るか）は変えない。
 * busySides は他の接続が出入りしている辺。そちらへ回ると線が並走するので、遠回りにならない範囲で避ける。
 */
function detourAroundObstacles(points: Point[], boxes: ObstacleBox[], busySides: Set<string> = new Set()) {
  const busyPenalty = (hits: ObstacleBox[], side: ProcessConnectionAnchor) => (
    hits.some((box) => box.id && busySides.has(`${box.id}:${side}`)) ? 80 : 0
  )
  const result: Point[] = [points[0]]
  for (let index = 1; index < points.length; index += 1) {
    const a = result[result.length - 1]
    const b = points[index]
    const vertical = a.x === b.x
    const hits = boxes.filter((box) => segmentHitsBox(a, b, box))
    if (!hits.length || (a.x !== b.x && a.y !== b.y)) {
      result.push(b)
      continue
    }
    if (vertical) {
      const down = b.y > a.y
      const enter = down ? Math.min(...hits.map((box) => box.top)) : Math.max(...hits.map((box) => box.bottom))
      const leave = down ? Math.max(...hits.map((box) => box.bottom)) : Math.min(...hits.map((box) => box.top))
      // 回り込んだ先にも札やノードがあれば、さらに外側へ広げる。
      const channel = (side: 'left' | 'right') => {
        // 他の接続が出入りする辺の側では、その線の折れ位置（辺から34px）より外を通し、並走を避けて直交させる。
        const clearance = DETOUR_CLEARANCE + (busyPenalty(hits, side) ? BUSY_SIDE_EXTRA_CLEARANCE : 0)
        let x = side === 'left' ? Math.min(...hits.map((box) => box.left)) - clearance : Math.max(...hits.map((box) => box.right)) + clearance
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const blockers = boxes.filter((box) => segmentHitsBox({ x, y: enter }, { x, y: leave }, box) || segmentHitsBox({ x: a.x, y: enter }, { x, y: enter }, box))
          if (!blockers.length) break
          x = side === 'left' ? Math.min(...blockers.map((box) => box.left)) - DETOUR_CLEARANCE : Math.max(...blockers.map((box) => box.right)) + DETOUR_CLEARANCE
        }
        return x
      }
      const candidates = [channel('right'), channel('left')].map((x) => [{ x: a.x, y: enter }, { x, y: enter }, { x, y: leave }, { x: a.x, y: leave }])
      const best = candidates.reduce((chosen, candidate) => {
        const side = candidate[1].x > a.x ? 'right' : 'left'
        // 左側は戻りの線の通り道なので、進む線の迂回は右を優先する。
        const score = pathHits([a, ...candidate, b], boxes) * 1000 + busyPenalty(hits, side) + (side === 'left' ? LEFT_DETOUR_PENALTY : 0) + Math.abs(candidate[1].x - a.x)
        return score < chosen.score ? { candidate, score } : chosen
      }, { candidate: candidates[0], score: Infinity })
      result.push(...best.candidate, b)
    } else {
      const right = b.x > a.x
      const enter = right ? Math.min(...hits.map((box) => box.left)) : Math.max(...hits.map((box) => box.right))
      const leave = right ? Math.max(...hits.map((box) => box.right)) : Math.min(...hits.map((box) => box.left))
      const topY = Math.min(...hits.map((box) => box.top)) - DETOUR_CLEARANCE
      const bottomY = Math.max(...hits.map((box) => box.bottom)) + DETOUR_CLEARANCE
      const candidates = [topY, bottomY].map((y) => [{ x: enter, y: a.y }, { x: enter, y }, { x: leave, y }, { x: leave, y: a.y }])
      const best = candidates.reduce((chosen, candidate) => {
        const side = candidate[1].y > a.y ? 'bottom' : 'top'
        const score = pathHits([a, ...candidate, b], boxes) * 1000 + busyPenalty(hits, side) + Math.abs(candidate[1].y - a.y)
        return score < chosen.score ? { candidate, score } : chosen
      }, { candidate: candidates[0], score: Infinity })
      result.push(...best.candidate, b)
    }
  }
  return simplifyPoints(result)
}

/** 直角の折れ線を、角だけ小さく丸めたSVGパスにする。 */
export function roundedOrthogonalPath(points: Point[], radius = CORNER_RADIUS) {
  const simplified = simplifyPoints(points)
  if (simplified.length < 2) return ''
  let path = `M${simplified[0].x} ${simplified[0].y}`
  for (let index = 1; index < simplified.length - 1; index += 1) {
    const previous = simplified[index - 1]
    const corner = simplified[index]
    const next = simplified[index + 1]
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y)
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y)
    const r = Math.min(radius, inLength / 2, outLength / 2)
    const before = { x: corner.x - Math.sign(corner.x - previous.x) * r, y: corner.y - Math.sign(corner.y - previous.y) * r }
    const after = { x: corner.x + Math.sign(next.x - corner.x) * r, y: corner.y + Math.sign(next.y - corner.y) * r }
    path += ` L${before.x} ${before.y} Q${corner.x} ${corner.y} ${after.x} ${after.y}`
  }
  const last = simplified[simplified.length - 1]
  return `${path} L${last.x} ${last.y}`
}

function pathLength(points: Point[]) {
  return points.reduce((total, point, index) => (index ? total + Math.abs(point.x - points[index - 1].x) + Math.abs(point.y - points[index - 1].y) : 0), 0)
}

/** 横に出て縦に入る、または縦に出て横に入るL字の経路。 */
function lShapedRoutes(from: ProcessStep, to: ProcessStep) {
  const fromCenter = stepCenter(from)
  const toCenter = stepCenter(to)
  const horizontalSide: ProcessConnectionAnchor = toCenter.x > fromCenter.x ? 'right' : 'left'
  const verticalSide: ProcessConnectionAnchor = toCenter.y > fromCenter.y ? 'bottom' : 'top'
  const opposite = (side: ProcessConnectionAnchor): ProcessConnectionAnchor => (
    side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top'
  )
  const routes: Array<{ sourceSide: ProcessConnectionAnchor; points: Point[] }> = []
  const sideStart = stepAnchor(from, horizontalSide)
  const topEnd = stepAnchor(to, opposite(verticalSide))
  if (horizontalSide === 'right' ? topEnd.x > sideStart.x : topEnd.x < sideStart.x) {
    routes.push({ sourceSide: horizontalSide, points: [sideStart, { x: topEnd.x, y: sideStart.y }, topEnd] })
  }
  const bottomStart = stepAnchor(from, verticalSide)
  const sideEnd = stepAnchor(to, opposite(horizontalSide))
  if (verticalSide === 'bottom' ? sideEnd.y > bottomStart.y : sideEnd.y < bottomStart.y) {
    routes.push({ sourceSide: verticalSide, points: [bottomStart, { x: bottomStart.x, y: sideEnd.y }, sideEnd] })
  }
  return routes
}

/**
 * 上にあるノードへ戻る接続（差し戻し・再照合など）か。
 * 本流と同じ場所を通すと進む線と見分けられないため、別の経路で描く。
 * 人が接続点を指定した線はその指定に従う。
 */
function isBackEdge(connection: ProcessConnection, from: ProcessStep, to: ProcessStep) {
  if (connection.fromAnchor || connection.toAnchor) return false
  return stepCenter(to).y < stepCenter(from).y - 20
}

/**
 * 接続線の経路を求める。extraObstacles はノードの横に付くアセット札など、線が避けたい追加の箱。
 * id には札が付いているステップのidを入れる。
 */
export function buildConnectorPaths(connections: ProcessConnection[], steps: ProcessStep[], extraObstacles: ObstacleBox[] = []) {
  const resolved = connections.map((connection) => {
    const from = steps.find((step) => step.id === connection.from)
    const to = steps.find((step) => step.id === connection.to)
    if (!from || !to) {
      return { connection, from: undefined, to: undefined, back: false, sourceSide: 'right' as ProcessConnectionAnchor, targetSide: 'left' as ProcessConnectionAnchor }
    }
    const back = isBackEdge(connection, from, to)
    const sides = back
      ? { sourceSide: 'left' as ProcessConnectionAnchor, targetSide: 'left' as ProcessConnectionAnchor }
      : resolveConnectionSides(connection, from, to)
    return { connection, from, to, back, ...sides }
  })

  // 同じノードの同じ辺に複数の接続が付く場合、接続点が1点に重ならないよう
  // 相手ノードの位置順に辺に沿って分散させる（順序が保たれるため交差しない）。
  const sideGroups = new Map<string, { connectionId: string; endpoint: 'source' | 'target'; order: number }[]>()
  const busySides = new Set<string>()
  for (const entry of resolved) {
    // 戻りの線は上下の端から専用の位置で出入りするので、辺の分散には加えない。
    if (!entry.from || !entry.to || entry.back) continue
    busySides.add(`${entry.from.id}:${entry.sourceSide}`)
    busySides.add(`${entry.to.id}:${entry.targetSide}`)
    const fromCenter = stepCenter(entry.from)
    const toCenter = stepCenter(entry.to)
    const sourceKey = `${entry.from.id}:${entry.sourceSide}`
    const targetKey = `${entry.to.id}:${entry.targetSide}`
    const sourceOrder = entry.sourceSide === 'left' || entry.sourceSide === 'right' ? toCenter.y : toCenter.x
    const targetOrder = entry.targetSide === 'left' || entry.targetSide === 'right' ? fromCenter.y : fromCenter.x
    sideGroups.set(sourceKey, [...(sideGroups.get(sourceKey) ?? []), { connectionId: entry.connection.id, endpoint: 'source', order: sourceOrder }])
    sideGroups.set(targetKey, [...(sideGroups.get(targetKey) ?? []), { connectionId: entry.connection.id, endpoint: 'target', order: targetOrder }])
  }
  const anchorOffsets = new Map<string, number>()
  for (const members of sideGroups.values()) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => a.order - b.order)
    sorted.forEach((member, index) => {
      anchorOffsets.set(`${member.endpoint}:${member.connectionId}`, (index - (sorted.length - 1) / 2) * 14)
    })
  }

  // 戻りの線が複数あるとき、長いものほど外側を通すと互いに交差しにくい。
  const backOrder = new Map(resolved
    .filter((entry) => entry.back && entry.from && entry.to)
    .sort((a, b) => (stepCenter(a.from!).y - stepCenter(a.to!).y) - (stepCenter(b.from!).y - stepCenter(b.to!).y))
    .map((entry, index) => [entry.connection.id, index]))

  return resolved.map(({ connection, from, to, back, sourceSide, targetSide }) => {
    if (!from || !to) return { ...connection, path: '', back: false, labelX: 0, labelY: 0, startPoint: undefined, endPoint: undefined }

    const sourceOffset = anchorOffsets.get(`source:${connection.id}`) ?? 0
    const targetOffset = anchorOffsets.get(`target:${connection.id}`) ?? 0
    const branchOffset = sourceOffset
    const obstacles: ObstacleBox[] = [
      ...steps
        .filter((step) => step.id !== from.id && step.id !== to.id)
        .map((step) => ({ ...stepBox(step, OBSTACLE_PADDING), id: step.id })),
      // 接続元・接続先自身の札は接続点のすぐ脇にあるので、避けると線が札の周りを回ってしまう。
      ...extraObstacles.filter((box) => box.id !== from.id && box.id !== to.id),
    ]

    // 戻りの線は、出る側の下端の左寄りから出て、戻り先の上端の左寄りへ入る。
    // 左の辺から出入りすると、ノードの左に付くアセット札を突き抜けるため。
    const backInset = (step: ProcessStep) => (step.type === 'task' ? -((step.width ?? 120) / 2 - 16) : -12)
    const start = back ? stepAnchor(from, 'bottom', backInset(from)) : stepAnchor(from, sourceSide, sourceOffset)
    const end = back ? stepAnchor(to, 'top', backInset(to)) : stepAnchor(to, targetSide, targetOffset)
    const gatewayLabel = gatewayBranchLabelPosition(from, sourceSide, start, branchOffset)
    const labelPosition = (labelX: number, labelY: number) => ({
      labelX: gatewayLabel?.x ?? labelX,
      labelY: gatewayLabel?.y ?? labelY,
    })
    const finish = (points: Point[], label: { labelX: number; labelY: number }, routed = true) => {
      if (routed && pathHits(points, obstacles) && !connection.fromAnchor && !connection.toAnchor) {
        // 既定の辺の組み合わせだと途中のノードに当たるとき、L字の経路で当たらないものがあればそちらを使う。
        // 迂回させるより線が短く、分岐から横へ出る線は分岐の向きとしても読みやすい。
        const alternative = lShapedRoutes(from, to)
          .filter((route) => !pathHits(route.points, obstacles))
          .sort((left, right) => pathLength(left.points) - pathLength(right.points))[0]
        if (alternative) {
          const branchLabel = gatewayBranchLabelPosition(from, alternative.sourceSide, alternative.points[0], 0)
          return {
            ...connection,
            path: roundedOrthogonalPath(alternative.points),
            back,
            labelX: branchLabel?.x ?? (alternative.points[0].x + alternative.points[1].x) / 2,
            labelY: branchLabel?.y ?? alternative.points[0].y - 9,
            startPoint: alternative.points[0],
            endPoint: alternative.points[alternative.points.length - 1],
          }
        }
      }
      return {
        ...connection,
        path: roundedOrthogonalPath(routed ? detourAroundObstacles(points, obstacles, busySides) : points),
        back,
        ...label,
        startPoint: start,
        endPoint: end,
      }
    }

    if (back) {
      // 本流の左側の余白を通して戻す。通り道にノードやアセット札があれば、さらにその外側へ逃がす。
      const below = start.y + BACK_EDGE_STUB
      const above = end.y - BACK_EDGE_STUB
      let channelX = Math.min(stepBox(from).left, stepBox(to).left) - BACK_EDGE_GAP - (backOrder.get(connection.id) ?? 0) * BACK_EDGE_STEP
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const route = [{ x: start.x, y: below }, { x: channelX, y: below }, { x: channelX, y: above }, { x: end.x, y: above }]
        const blockers = obstacles.filter((box) => route.some((point, index) => index > 0 && segmentHitsBox(route[index - 1], point, box)))
        if (!blockers.length) break
        channelX = Math.min(...blockers.map((box) => box.left)) - BACK_EDGE_STEP
      }
      const labelWidth = Array.from(connection.label ?? '').length * 11
      return finish(
        [start, { x: start.x, y: below }, { x: channelX, y: below }, { x: channelX, y: above }, { x: end.x, y: above }, end],
        { labelX: channelX - 6 - labelWidth / 2, labelY: (start.y + end.y) / 2 + 4 },
        false,
      )
    }

    if (sourceSide === 'bottom' && targetSide === 'top' && start.y <= end.y && Math.abs(start.x - end.x) <= 10) {
      return finish([start, { x: start.x, y: end.y }], labelPosition(end.x + 18, (start.y + end.y) / 2))
    }
    if (sourceSide === 'left' || sourceSide === 'right') {
      const bendX = sourceSide === 'left'
        ? Math.min(start.x - 24 - branchOffset, end.x + 34)
        : Math.max(start.x + 24 + branchOffset, end.x - 34)
      if (targetSide === 'top' || targetSide === 'bottom') {
        // A top/bottom target must be approached vertically. The former
        // H-V-H route ended with a horizontal segment even when the target
        // anchor was on the top or bottom of the node.
        const bendY = targetSide === 'top' ? end.y - 24 : end.y + 24
        return finish(
          [start, { x: bendX, y: start.y }, { x: bendX, y: bendY }, { x: end.x, y: bendY }, end],
          labelPosition(bendX + (sourceSide === 'left' ? -9 : 9), (start.y + bendY) / 2),
        )
      }
      return finish(
        [start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end],
        labelPosition(bendX + (sourceSide === 'left' ? -9 : 9), (start.y + end.y) / 2),
      )
    }
    const bendY = sourceSide === 'top'
      ? Math.min(start.y - 24 - branchOffset, end.y + 34)
      : Math.max(start.y + 24 + branchOffset, end.y - 34)
    if (targetSide === 'left' || targetSide === 'right') {
      const bendX = targetSide === 'left' ? end.x - 24 : end.x + 24
      return finish(
        [start, { x: start.x, y: bendY }, { x: bendX, y: bendY }, { x: bendX, y: end.y }, end],
        labelPosition((start.x + bendX) / 2, bendY - 9),
      )
    }
    return finish(
      [start, { x: start.x, y: bendY }, { x: end.x, y: bendY }, end],
      labelPosition((start.x + end.x) / 2, bendY - 9),
    )
  })
}

export function compactAssetName(name: string) {
  return name.length > 14 ? `${name.slice(0, 13)}…` : name
}

export function assetTypeAbbreviation(type: OperationalAssetType) {
  if (type === 'Excel・台帳') return 'XL'
  if (type === 'メール') return 'ML'
  if (type === 'チャット') return 'CHAT'
  if (type === '紙帳票') return 'DOC'
  if (type === 'ファイル') return 'FILE'
  if (type === '共有フォルダ') return 'DIR'
  if (type === 'データベース・API') return 'DB'
  if (type === 'SaaS') return 'SaaS'
  return 'SYS'
}

export function buildProcessAssetAnnotations({ model, steps, assets, laneLayouts, processCanvasHeight }: AssetAnnotationInput) {
  const sideIndexByStep = new Map<string, number>()
  const sideCountByStep = new Map<string, number>()
  const systemIndexByStep = new Map<string, number>()
  ;(model?.assetLinks ?? []).forEach((link) => {
    const side = link.relation === '入力' || link.relation === '参照' ? 'left' : 'right'
    const key = `${link.stepId}:${side}`
    sideCountByStep.set(key, (sideCountByStep.get(key) ?? 0) + 1)
  })
  const systemAssetCountByStep = new Map<string, number>()
  ;(model?.assetLinks ?? []).forEach((link) => {
    const asset = assets.find((item) => item.id === link.assetId)
    if (!asset || !isSystemAsset(asset)) return
    systemAssetCountByStep.set(link.stepId, (systemAssetCountByStep.get(link.stepId) ?? 0) + 1)
  })
  // 横向き時代に保存された位置は座標系が異なるため使わない。
  const savedAssetPosition = (link: ProcessAssetLink) => {
    if (link.position?.layoutDirection === 'vertical') return link.position
    if (link.systemLanePosition?.layoutDirection === 'vertical') return link.systemLanePosition
    return undefined
  }
  return (model?.assetLinks ?? []).flatMap((link) => {
    const step = steps.find((item) => item.id === link.stepId)
    const asset = assets.find((item) => item.id === link.assetId)
    if (!step || !asset || step.type !== 'task') return []
    const width = Math.min(176, Math.max(108, compactAssetName(asset.name).length * 10 + 2 * 10 + 40))
    if (isSystemAsset(asset)) {
      const systemLane = laneLayouts.find((lane) => lane.label === PROCESS_SYSTEM_LANE)
      if (!systemLane) return []
      const index = systemIndexByStep.get(step.id) ?? 0
      const count = systemAssetCountByStep.get(step.id) ?? 1
      systemIndexByStep.set(step.id, index + 1)
      const flowsIntoStep = link.relation === '入力' || link.relation === '参照'
      const height = 40
      const laneCenterX = systemLane.x + systemLane.width / 2
      const defaultX = laneCenterX - width / 2
      const defaultY = step.y + 20 - height / 2 + (index - (count - 1) / 2) * 30
      const savedPosition = savedAssetPosition(link)
      const systemLaneHeight = Math.max(
        systemLane.height,
        processCanvasHeight - systemLane.y - 25,
      )
      const x = savedPosition
        ? Math.min(Math.max(systemLane.x + 12, savedPosition.x), Math.max(systemLane.x + 12, systemLane.x + systemLane.width - width - 12))
        : defaultX
      const y = savedPosition
        ? Math.min(Math.max(systemLane.y + 12, savedPosition.y), Math.max(systemLane.y + 12, systemLane.y + systemLaneHeight - height - 12))
        : defaultY
      const stepPoint = stepAnchor(step, 'right')
      const assetPoint = { x, y: y + height / 2 }
      const associationStart = flowsIntoStep ? assetPoint : stepPoint
      const associationEnd = flowsIntoStep ? stepPoint : assetPoint
      const bendX = Math.round((associationStart.x + associationEnd.x) / 2)
      return [{
        ...link,
        asset,
        x,
        y,
        width,
        height,
        typeLabel: assetTypeAbbreviation(asset.type),
        label: compactAssetName(asset.name),
        associationStart,
        associationEnd,
        path: `M ${associationStart.x} ${associationStart.y} H ${bendX} V ${associationEnd.y} H ${associationEnd.x}`,
      }]
    }
    const side = link.relation === '入力' || link.relation === '参照' ? 'left' : 'right'
    const sideKey = `${step.id}:${side}`
    const index = sideIndexByStep.get(sideKey) ?? 0
    const count = sideCountByStep.get(sideKey) ?? 1
    sideIndexByStep.set(sideKey, index + 1)
    const centerY = step.y + 20
    const groupHeight = count * 24 + Math.max(0, count - 1) * 6
    const defaultX = side === 'left'
      ? step.x - width - PROCESS_VERTICAL_ASSET_GAP
      : step.x + (step.width ?? 120) + PROCESS_VERTICAL_ASSET_GAP
    const defaultY = centerY - groupHeight / 2 + index * 30
    const canvasWidth = Math.max(
      600,
      ...laneLayouts.map((lane) => lane.x + lane.width + 25),
      ...steps.map((item) => item.x + (item.width ?? 50) + 50),
    )
    const canvasHeight = Math.max(720, ...steps.map((item) => item.y + 120))
    const savedPosition = savedAssetPosition(link)
    const x = savedPosition
      ? Math.min(Math.max(12, savedPosition.x), Math.max(12, canvasWidth - width - 12))
      : defaultX
    const y = savedPosition
      ? Math.min(Math.max(12, savedPosition.y), Math.max(12, canvasHeight - 24 - 12))
      : defaultY
    const stepPoint = stepAnchor(step, side)
    const assetPoint = { x: side === 'left' ? x + width : x, y: y + 12 }
    const flowsIntoStep = link.relation === '入力' || link.relation === '参照'
    const associationStart = flowsIntoStep ? assetPoint : stepPoint
    const associationEnd = flowsIntoStep ? stepPoint : assetPoint
    return [{
      ...link,
      asset,
      x,
      y,
      width,
      height: 24,
      typeLabel: assetTypeAbbreviation(asset.type),
      label: `${assetRoleShortLabel(link.relation, asset)}｜${compactAssetName(asset.name)}`,
      associationStart,
      associationEnd,
      path: `M ${associationStart.x} ${associationStart.y} L ${associationEnd.x} ${associationEnd.y}`,
    }]
  })
}

export type ProcessAssetAnnotation = ReturnType<typeof buildProcessAssetAnnotations>[number]
