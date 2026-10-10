/**
 * As-Isフローの自動整列の計画。人がフロー図を描くときの決まりを、座標を決める前の段・列の割り当てとして表す。
 * - 戻りの線（差し戻し・再照合）は工程の順番の計算に入れない。入れると循環して、後ろの工程が一列ずつ下に積まれる。
 * - 開始から終了までのいつもの流れ（本流）を担当ごとの中央の列にそろえ、例外や差し戻しの工程は脇の列に出す。
 * Vueの状態や座標系には依存しない。座標は process-model の arrangeProcessVertically が決める。
 */
import type { ProcessConnection, ProcessStep } from '../../models'

type LayoutStep = Pick<ProcessStep, 'id' | 'type' | 'x'>
type LayoutConnection = Pick<ProcessConnection, 'id' | 'from' | 'to' | 'label'>

/** 分岐の条件名から、いつもの流れか例外かを推し量る。決められないものは中立にする。 */
const EXCEPTION_LABEL = /差し?戻|不備|不一致|否認|却下|差異あり|ng|エラー|例外|再|不可|否/i
const NORMAL_LABEL = /なし|承認|ok|一致|問題なし|可$|完了|通常/i

export function branchTendency(label = ''): -1 | 0 | 1 {
  const text = label.normalize('NFKC').trim()
  if (!text) return 0
  if (EXCEPTION_LABEL.test(text)) return -1
  if (NORMAL_LABEL.test(text)) return 1
  return 0
}

/**
 * 戻りの線を見つける。開始から接続順にたどり、たどっている途中の工程へ戻る接続を戻りの線とする。
 * 開始が無い・たどり着けない工程は、残りから同じようにたどる。
 */
export function findBackEdges(steps: LayoutStep[], connections: LayoutConnection[]) {
  const outgoing = new Map<string, LayoutConnection[]>()
  connections.forEach((connection) => outgoing.set(connection.from, [...(outgoing.get(connection.from) ?? []), connection]))
  const state = new Map<string, 'visiting' | 'done'>()
  const back = new Set<string>()
  const roots = [...steps.filter((step) => step.type === 'start'), ...steps.filter((step) => step.type !== 'start')]
  for (const root of roots) {
    if (state.has(root.id)) continue
    // 再帰の深さを気にしなくてよいよう、明示的なスタックでたどる。
    const stack: Array<{ id: string; index: number }> = [{ id: root.id, index: 0 }]
    state.set(root.id, 'visiting')
    while (stack.length) {
      const frame = stack[stack.length - 1]
      const edges = outgoing.get(frame.id) ?? []
      if (frame.index >= edges.length) {
        state.set(frame.id, 'done')
        stack.pop()
        continue
      }
      const edge = edges[frame.index++]
      const status = state.get(edge.to)
      if (status === 'visiting') back.add(edge.id)
      else if (!status && steps.some((step) => step.id === edge.to)) {
        state.set(edge.to, 'visiting')
        stack.push({ id: edge.to, index: 0 })
      }
    }
  }
  return back
}

export interface ProcessLayoutPlan {
  /** 縦方向の段。戻りの線を除いた流れで、前の工程より必ず下になる最小の段。 */
  levels: Map<string, number>
  /** 本流に乗る工程。担当ごとの中央の列に置く。 */
  mainPath: Set<string>
  backEdges: Set<string>
}

export function planProcessLayout(steps: LayoutStep[], connections: LayoutConnection[]): ProcessLayoutPlan {
  const ids = new Set(steps.map((step) => step.id))
  const backEdges = findBackEdges(steps, connections)
  const forward = connections.filter((connection) => !backEdges.has(connection.id) && ids.has(connection.from) && ids.has(connection.to))
  const outgoing = new Map<string, LayoutConnection[]>()
  const incomingCount = new Map(steps.map((step) => [step.id, 0]))
  forward.forEach((connection) => {
    outgoing.set(connection.from, [...(outgoing.get(connection.from) ?? []), connection])
    incomingCount.set(connection.to, (incomingCount.get(connection.to) ?? 0) + 1)
  })

  // 段：戻りの線を除くと循環しないので、前の工程の段+1の最大を取れば必ず決まる。
  const levels = new Map(steps.map((step) => [step.id, 0]))
  const order: string[] = []
  const remaining = new Map(incomingCount)
  const queue = steps.filter((step) => (remaining.get(step.id) ?? 0) === 0).sort((a, b) => a.x - b.x).map((step) => step.id)
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const connection of outgoing.get(id) ?? []) {
      levels.set(connection.to, Math.max(levels.get(connection.to) ?? 0, (levels.get(id) ?? 0) + 1))
      remaining.set(connection.to, (remaining.get(connection.to) ?? 1) - 1)
      if (remaining.get(connection.to) === 0) queue.push(connection.to)
    }
  }

  // 本流：各工程から終了までの最長の長さを求め、分岐では長く続く方、いつもの流れらしい条件名の方を選ぶ。
  const toEnd = new Map<string, number>()
  for (const id of [...order].reverse()) {
    const next = (outgoing.get(id) ?? []).map((connection) => (toEnd.get(connection.to) ?? 0) + 1)
    toEnd.set(id, Math.max(0, ...next))
  }
  const mainPath = new Set<string>()
  const start = steps.find((step) => step.type === 'start') ?? steps.find((step) => (incomingCount.get(step.id) ?? 0) === 0)
  let current = start?.id
  while (current && !mainPath.has(current)) {
    mainPath.add(current)
    const candidates = outgoing.get(current) ?? []
    if (!candidates.length) break
    const score = (connection: LayoutConnection) => (toEnd.get(connection.to) ?? 0) * 10 + branchTendency(connection.label) * 15
    current = [...candidates].sort((a, b) => score(b) - score(a))[0].to
  }
  return { levels, mainPath, backEdges }
}
