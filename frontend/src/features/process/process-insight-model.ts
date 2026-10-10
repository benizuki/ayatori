import type { ProcessModel, ProcessStep } from '../../models'

/** 1営業日を8時間として、「2日」のような所要時間を分に換算する。 */
const MINUTES_PER_DAY = 8 * 60

const UNIT_MINUTES: Record<string, number> = { 分: 1, 時間: 60, h: 60, 日: MINUTES_PER_DAY, 営業日: MINUTES_PER_DAY, 週: MINUTES_PER_DAY * 5 }

/**
 * 所要時間の自由記述（「10分」「1〜2日」「半日」「30分〜1時間」）を分にする。
 * 範囲は中間値を採る。読み取れない値（「未確認」など）は null。
 */
export function parseDurationMinutes(text?: string): number | null {
  const value = (text ?? '').replace(/\s/g, '').replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
  if (!value) return null
  if (value.includes('半日')) return MINUTES_PER_DAY / 2
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(営業日|時間|分|日|週|h)?/g)]
  if (!parts.length) return null
  // 単位は後ろの数値から借りる（「1〜2日」の1は日）。
  const amounts: number[] = []
  let unit: string | undefined
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    unit = parts[index][2] ?? unit
    if (!unit) return null
    amounts.unshift(Number(parts[index][1]) * UNIT_MINUTES[unit])
  }
  return amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length
}

export type HeatLevel = 0 | 1 | 2 | 3

export interface StepHeat {
  minutes: number
  level: HeatLevel
}

/**
 * 工程ごとの所要時間を、最長の工程に対する比でヒートの段階（0〜3）にする。
 * 実測が無くても「どこが突出して長いか」を相対で示すためで、段階の絶対値に意味は持たせない。
 */
export function computeStepHeat(steps: ProcessStep[]): Map<string, StepHeat> {
  const timed = steps
    .filter((step) => step.type === 'task')
    .map((step) => ({ id: step.id, minutes: parseDurationMinutes(step.duration) }))
    .filter((item): item is { id: string; minutes: number } => item.minutes !== null && item.minutes > 0)
  const longest = Math.max(0, ...timed.map((item) => item.minutes))
  const result = new Map<string, StepHeat>()
  timed.forEach(({ id, minutes }) => {
    const ratio = minutes / longest
    // 工程が1つだけ、または全て短い場合に色を付けないよう、半日未満は強調しない。
    const level: HeatLevel = minutes < MINUTES_PER_DAY / 2 / 4 ? 0 : ratio >= 0.6 ? 3 : ratio >= 0.3 ? 2 : ratio >= 0.12 ? 1 : 0
    result.set(id, { minutes, level })
  })
  return result
}

export function formatMinutes(minutes: number) {
  if (minutes >= MINUTES_PER_DAY) return `${Math.round((minutes / MINUTES_PER_DAY) * 10) / 10}日`
  if (minutes >= 60) return `${Math.round((minutes / 60) * 10) / 10}時間`
  return `${Math.round(minutes)}分`
}

/** 担当（レーン）をまたぐ接続。ここが受け渡しで、待ちや認識違いが生まれやすい。 */
export function findHandoffConnectionIds(model: Pick<ProcessModel, 'steps' | 'connections'>): Set<string> {
  const laneOf = new Map(model.steps.map((step) => [step.id, step.lane || step.actor]))
  const ids = new Set<string>()
  model.connections.forEach((connection) => {
    const from = laneOf.get(connection.from)
    const to = laneOf.get(connection.to)
    if (from && to && from !== to) ids.add(connection.id)
  })
  return ids
}
