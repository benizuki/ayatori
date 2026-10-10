import type {
  BusinessProcessMaster,
  BusinessTask,
  BusinessVolumeBand,
  Department,
  ProcessModel,
  TaskCategory,
  TaskValue,
} from '../../models'

export const UNCLASSIFIED: TaskCategory = '未分類'

/**
 * 見直しの着眼点となる5分類。IEの工程分析（加工・検査・運搬・不良）に対応させている。
 * 実際の工程順序はAs-Isフローで確認する。価値の有無は分類ではなくTaskValueで持つ。
 * 手戻りは前工程の不備から生じるので、他の分類と分けて数え、原因の工程を探す手がかりにする。
 */
export const TASK_CATEGORIES: TaskCategory[] = ['作業', '確認', '登録', '伝達', '手戻り']

/** マップの列。分類できなかったタスクは最後の未分類列へ置く。 */
export const TASK_MAP_COLUMNS: TaskCategory[] = [...TASK_CATEGORIES, UNCLASSIFIED]

/**
 * 7分類だった頃の保存データを読み替える。承認は確認へ、申請と報告は伝達へまとめた。
 * 打ち手が同じで、統制上なくせるかどうかは価値区分で表せるため。
 */
const LEGACY_CATEGORIES: Record<string, TaskCategory> = { 申請: '伝達', 報告: '伝達', 承認: '確認' }

export function migrateTaskCategory(category: string): TaskCategory {
  if (category in LEGACY_CATEGORIES) return LEGACY_CATEGORIES[category]
  return (TASK_MAP_COLUMNS as string[]).includes(category) ? (category as TaskCategory) : UNCLASSIFIED
}

export const TASK_VALUES: TaskValue[] = ['付加価値', '必要', '削減候補']

/**
 * 価値区分を人もAIも決めていないときの推定値。業務の目的を見ないと決まらないので、あくまで初期値。
 * 確認・登録は統制や記帳で残ることが多いため必要、伝達は受け渡しなので削減候補に置く。
 */
export const DEFAULT_TASK_VALUES: Record<TaskCategory, TaskValue | null> = {
  作業: '付加価値',
  確認: '必要',
  登録: '必要',
  伝達: '削減候補',
  手戻り: '削減候補',
  未分類: null,
}

export const VALUE_SLUGS: Record<TaskValue, string> = {
  付加価値: 'value',
  必要: 'required',
  削減候補: 'waste',
}

export const VALUE_HINTS: Record<TaskValue, string> = {
  付加価値: '業務の成果物そのものを作る、決める',
  必要: '成果は生まないが、統制・法令・記帳のためになくせない',
  削減候補: 'なくしても業務の成果が変わらない',
}

/** 価値区分。人かAIが決めていればそれを、なければ分類からの推定を返す。未分類なら判定できない。 */
export function taskValue(task: Pick<BusinessTask, 'category' | 'value'>): TaskValue | null {
  return task.value ?? DEFAULT_TASK_VALUES[task.category]
}

export const VOLUME_BANDS: BusinessVolumeBand[] = ['大', '中', '小', '未確認']

/** CSSの色トークンに対応させるための識別子。分類名は日本語なのでクラス名には使えない。 */
export const CATEGORY_SLUGS: Record<TaskCategory, string> = {
  作業: 'work',
  確認: 'check',
  登録: 'register',
  伝達: 'relay',
  手戻り: 'rework',
  未分類: 'unknown',
}

export const CATEGORY_ACTIONS: Record<TaskCategory, string> = {
  作業: 'C：共通作業をまとめ、定型と例外を分離できないか？',
  確認: 'E・R：重複確認や承認段階を減らし、不備検出の前倒しや権限委譲ができないか？',
  登録: 'E・C：二重入力をなくし、一度の入力を共有できないか？',
  伝達: 'E：既にある情報の再提出や、使われない共有をやめられないか？',
  手戻り: 'E：差し戻しの原因を特定し、前工程で不備を防げないか？',
  未分類: 'S：目的・成果物・手順を確認し、簡素化できないか？',
}

export const CATEGORY_HINTS: Record<TaskCategory, string> = {
  作業: '成果物を実際に作る、判断して値を決める作業',
  確認: '内容の照合、チェック、突き合わせ、上長承認、決裁',
  登録: 'システムへの入力、マスター登録、台帳への転記、記録の保存',
  伝達: '申請、依頼、報告、連絡、問い合わせ。情報を他の人へ渡す行為',
  手戻り: '差し戻し・不備による修正、訂正、再提出、やり直し',
  未分類: '名前から分類できなかったタスク',
}

/**
 * タスク名からの自動分類。上から順に当て、最初に一致した分類を採る。同じ分類が2か所に出るのは優先順位のため。
 * 「差し戻し内容を修正」「訂正請求書を依頼」は他の分類語を含むので、手戻りを最初に当てる。
 * 「承認依頼を作成」は承認の手続きを回す行為なので、申請・依頼の語を確認より先に当てる。
 * 「共有フォルダへ保存」が伝達にならないよう、登録を報告・共有の語より先に置いている。
 * 「修正」単独は通常の改訂でも使うため、手戻りの語に含めない。
 */
const CATEGORY_KEYWORDS: Array<{ category: TaskCategory; keywords: string[] }> = [
  { category: '手戻り', keywords: ['差し戻', '差戻', '訂正', '再提出', '再申請', '再依頼', '再作成', '再発行', 'やり直', '手戻', '不備対応', '不備修正'] },
  { category: '伝達', keywords: ['申請', '起票', '上申', '願', 'ワークフロー入力', '依頼'] },
  { category: '確認', keywords: ['確認', 'チェック', '照合', '突合', '検証', '検収', 'レビュー', '点検', '査定', '審査', '受付', '受け付', '受領', '受け取', '承認', '決裁', '稟議', '押印', '査閲', '許可', '回覧'] },
  { category: '登録', keywords: ['登録', '入力', '更新', '反映', '転記', '設定', '発行', '起案', '計上', '消込', '確定', '保存', '格納', '保管', 'ファイリング', '送信', '伝送', 'アップロード'] },
  { category: '伝達', keywords: ['報告', '集計', '通知', '連絡', '共有', '送付', '配信', '回答', '問い合わせ', '問合せ'] },
  { category: '作業', keywords: ['作成', '実施', '処理', '対応', '手配', '算出', '積算', '見積', '設計', '調整', '交渉', '分析', 'スキャン', '電子化', 'pdf'] },
]

export function classifyTaskName(name: string): TaskCategory {
  const text = name.normalize('NFKC').toLowerCase()
  for (const rule of CATEGORY_KEYWORDS) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) return rule.category
  }
  return UNCLASSIFIED
}

export interface TaskSummary {
  business: BusinessProcessMaster
  tasks: BusinessTask[]
  byCategory: Record<TaskCategory, BusinessTask[]>
  byValue: Record<TaskValue, number>
  total: number
  /** 分類済みのタスク数。未分類を母数に入れると割合が読み違いになる。 */
  classified: number
  /** 価値区分が決まっているタスク数。割合の母数。 */
  judged: number
  /** 価値区分が決まっているうち、削減候補が占める割合。高いほど刈り取りシロが大きい。 */
  wasteRatio: number
}

const VOLUME_WEIGHT: Record<BusinessVolumeBand, number> = {
  大: 3,
  中: 2,
  小: 1,
  未確認: 1,
}

function emptyBuckets(): Record<TaskCategory, BusinessTask[]> {
  return { 作業: [], 確認: [], 登録: [], 伝達: [], 手戻り: [], 未分類: [] }
}

export function emptyValueCounts(): Record<TaskValue, number> {
  return { 付加価値: 0, 必要: 0, 削減候補: 0 }
}

export function summarizeTasks(business: BusinessProcessMaster): TaskSummary {
  const tasks = business.tasks ?? []
  const byCategory = emptyBuckets()
  const byValue = emptyValueCounts()
  for (const task of tasks) {
    byCategory[task.category].push(task)
    const value = taskValue(task)
    if (value) byValue[value] += 1
  }
  const judged = TASK_VALUES.reduce((sum, value) => sum + byValue[value], 0)
  return {
    business,
    tasks,
    byCategory,
    byValue,
    total: tasks.length,
    classified: tasks.length - byCategory[UNCLASSIFIED].length,
    judged,
    wasteRatio: judged ? byValue.削減候補 / judged : 0,
  }
}

export function hasTasks(business: BusinessProcessMaster): boolean {
  return (business.tasks ?? []).length > 0
}

/**
 * 刈り取りの優先度。削減候補のタスク数に発生量の重みを掛ける。
 * タスク数だけで並べると、年に数回しか起きない重い業務が上位に来てしまう。
 */
export function harvestScore(summary: TaskSummary): number {
  return summary.byValue.削減候補 * VOLUME_WEIGHT[summary.business.volumeBand ?? '未確認']
}

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `task-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function createTask(name: string, departmentId: string, sourceStepId?: string): BusinessTask {
  const category = classifyTaskName(name)
  return {
    id: newId(),
    name: name.trim() || '名称未設定',
    category,
    departmentId,
    mappedBy: category === UNCLASSIFIED ? undefined : 'keyword',
    sourceStepId,
  }
}

/**
 * As-Isプロセスのステップをタスクとして取り込む。
 * 既に取り込んだステップは飛ばすので、追記しても重複しない。
 */
export function tasksFromProcessModel(
  business: BusinessProcessMaster,
  model: ProcessModel | undefined,
  departments: Department[],
): BusinessTask[] {
  if (!model) return []
  const imported = new Set((business.tasks ?? []).map((task) => task.sourceStepId).filter(Boolean))
  return model.steps
    .filter((step) => step.type === 'task' && step.label.trim() && !imported.has(step.id))
    .map((step) => {
      // 担当は自由記述なので、部門名と一致したときだけ紐づける。
      const department = departments.find((item) => step.actor && step.actor.includes(item.name))
      return createTask(step.label, department?.id || business.departmentId || '', step.id)
    })
}
