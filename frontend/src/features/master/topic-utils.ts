import type { InterviewTopic } from '../../models'

export type CoverageKey = NonNullable<InterviewTopic['coverageKey']>

export const coverageDimensions: { key: CoverageKey; label: string; icon: string }[] = [
  { key: 'purpose', label: '目的・成果', icon: 'mdi-bullseye-arrow' },
  { key: 'flow', label: '基本フロー', icon: 'mdi-transit-connection-variant' },
  { key: 'role', label: '役割・承認', icon: 'mdi-account-check-outline' },
  { key: 'evidence', label: '入出力・証跡', icon: 'mdi-file-document-check-outline' },
  { key: 'system', label: '業務システム', icon: 'mdi-monitor-dashboard' },
  { key: 'volume', label: '件数・時間', icon: 'mdi-timer-sand' },
  { key: 'exception', label: '判断・例外', icon: 'mdi-call-split' },
  { key: 'control', label: '統制・リスク', icon: 'mdi-shield-check-outline' },
  { key: 'issue', label: '課題・改善', icon: 'mdi-lightbulb-on-outline' },
]

export function inferCoverageKey(topic: InterviewTopic): CoverageKey | undefined {
  if (topic.coverageKey) return topic.coverageKey
  const text = `${topic.id} ${topic.name} ${topic.description}`
  if (/目的|成果|purpose/.test(text)) return 'purpose'
  if (/フロー|開始|終了|flow|schedule/.test(text)) return 'flow'
  if (/証跡|帳票|ファイル|保存|evidence/.test(text)) return 'evidence'
  if (/担当|承認|役割|権限|role|approval/.test(text)) return 'role'
  if (/システム|SAP|Excel|メール|受付経路|channel/.test(text)) return 'system'
  if (/件数|時間|繁閑|業務量|volume/.test(text)) return 'volume'
  if (/例外|判断|差戻|不一致|exception|three-way/.test(text)) return 'exception'
  if (/統制|監査|規程|個人情報|control|policy/.test(text)) return 'control'
  if (/課題|改善|issue/.test(text)) return 'issue'
  return undefined
}

export function buildQuestionExamples(topic: InterviewTopic, businessName: string, variant = 0) {
  const keyword = topic.keywords?.slice(0, 3).join('・') || topic.name
  const questions = [
    `${businessName}における「${topic.name}」について、現在の進め方を具体的に教えてください。`,
    topic.answerType === '数値'
      ? `${keyword}について、通常月と繁忙期それぞれの件数や所要時間はどの程度ですか？`
      : topic.answerType === '条件分岐'
        ? `${keyword}によって処理や承認先が変わる条件と、例外時の対応を教えてください。`
        : topic.answerType === 'ファイル・証跡'
          ? `${keyword}に関して利用・保存している帳票、ファイル、承認記録を教えてください。`
          : `${topic.description}。実例を一つ挙げて、担当者と利用する業務システムも教えてください。`,
    variant % 2 === 0
      ? 'この観点で、SAP外のExcel・メール作業や、待ち時間・手戻りはありますか？'
      : '通常と異なるケースは月にどの程度発生し、誰がどのように判断していますか？',
  ]
  return questions.slice(0, Math.min(3, topic.questionCount))
}
