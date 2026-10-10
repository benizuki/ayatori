import type { TaskCategory } from '../../models'
import type { AiProposal, ProcessAiProposalSet } from './process-ai-opportunity-model'

export const ECRS_LABELS = { E: '排除', C: '結合と分離', R: '入替えと代替', S: '簡素化' } as const
export type EcrsPrinciple = keyof typeof ECRS_LABELS
export const REVIEW_STATUSES = ['未検討', '採用候補', '保留', '見送り'] as const
export interface ImprovementReview {
  status: typeof REVIEW_STATUSES[number]
  reason: string
  laborHours: number | null
  waitingHours: number | null
}
export interface ImprovementPlan {
  evidenceKey: string
  proposalSet: ProcessAiProposalSet
  reviews: Record<string, ImprovementReview>
  baselineHours: number | null
}
export const emptyReview = (): ImprovementReview => ({ status: '未検討', reason: '', laborHours: null, waitingHours: null })
export function nonnegativeHours(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export const CATEGORY_REVIEW: Record<TaskCategory, { principle: EcrsPrinciple; question: string; change: string }> = {
  作業: { principle: 'C', question: '共通の準備をまとめ、定型処理と例外対応を分離できないか？', change: '共通する準備があればまとめる。定型処理の条件を定め、例外だけ担当者へ振り分ける。' },
  確認: { principle: 'R', question: '同じ内容を重複して確認・承認していないか？ 不備を入力時点で検出したり、条件付きで権限を委譲したりできないか？', change: '確認と承認の目的と重複を調べる。入力時に検出できる不備は前倒しする。品質・安全・責任分担上必要な承認は維持し、委譲できる範囲があれば判断条件と担当を定める。' },
  登録: { principle: 'E', question: '同じ情報を別の台帳へ転記していないか？', change: '転記元と登録先の項目・利用目的を確認し、重複があれば正本を決めて二重入力を廃止する。' },
  伝達: { principle: 'E', question: '既にある情報を再提出していないか？ 誰が何の判断に使う共有か？', change: '受け手と用途を確認し、既存データで足りる申請項目や使われていない報告は廃止する。必要な内容は既存データから渡す。' },
  手戻り: { principle: 'E', question: 'なぜ差し戻されたか？ 不備を前工程で防げないか？', change: '差し戻しの理由を集計し、多い不備は入力時の必須項目やチェックで前工程に防ぐ。' },
  未分類: { principle: 'S', question: '目的・成果物・手順は明確か？ 手順や入力項目を減らせないか？', change: '目的と手順を確認し、不要な手順・項目があれば減らして標準化する。' },
}

/** 同じ工程に重なる採用候補はすべて集計から外し、効果を水増ししない。 */
export function summarizeImprovementImpact(proposals: AiProposal[], reviews: Record<string, ImprovementReview>, baseline: number | null) {
  const candidates = proposals.filter((proposal) => reviews[proposal.id]?.status === '採用候補')
  const overlapping = candidates.filter((proposal) => candidates.some((other) => other.id !== proposal.id && other.stepIds.some((id) => proposal.stepIds.includes(id))))
  const conflictIds = new Set(overlapping.map((proposal) => proposal.id))
  const included = candidates.filter((proposal) => !conflictIds.has(proposal.id))
  const known = included.filter((proposal) => nonnegativeHours(reviews[proposal.id]?.laborHours) !== null)
  const savings = known.reduce((sum, proposal) => sum + (nonnegativeHours(reviews[proposal.id]?.laborHours) ?? 0), 0)
  const validBaseline = baseline !== null && Number.isFinite(baseline) && baseline > 0
  const invalidTotal = validBaseline && savings >= baseline
  return {
    conflictIds, savings, knownCount: known.length, candidateCount: candidates.length,
    unknownCount: included.length - known.length, invalidTotal,
    targetSavings: validBaseline ? baseline * (1 - 1 / 1.7) : null,
    productivity: validBaseline && !invalidTotal && known.length ? baseline / (baseline - savings) : null,
  }
}
