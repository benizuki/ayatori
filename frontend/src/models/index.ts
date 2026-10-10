import type { ImprovementPlan } from '../features/process/process-improvement'

/** Shared domain models used across application features. */
export type Stage = '未着手' | '調査中' | '分析中' | 'To-Be設計' | '合意済み'

export interface Department {
  id: string
  tenantId?: string
  name: string
  owner: string
  stage: Stage
  progress: number
  interviews: number
  processes: number
  icon: string
  color: string
}

export interface InterviewMessage {
  id: number
  role: 'ai' | 'user'
  speaker: string
  time: string
  text: string
  tags?: string[]
  attachments?: Array<{
    name: string
    mimeType: string
    size: number
    previewUrl?: string
  }>
}

/**
 * 業務の中でやり取りされる情報のまとまり（請求書、照合結果、支払予定など）。
 * 項目の単位では細かすぎて聞き取りにくいので、書類やデータのまとまりを単位にする。
 */
export interface ProcessInformation {
  id: string
  name: string
  /** まとまりに含まれる項目。必要なときだけ持つ。 */
  items?: string[]
  /**
   * アセットの紐付けから仮の名前で作った情報。何の書類・データかが分からないので、
   * 人が名前を付けるまでは情報の流れの指摘から外す。
   */
  provisional?: boolean
}

/**
 * タスクが入力・出力する情報。assetIdsは、入力なら取得元、出力なら格納先・送付先のアセット。
 * 請求書がメールのPDFと紙の両方で届くように、1つとは限らない。無くてもよい。
 */
export interface StepInformationRef {
  informationId: string
  assetIds?: string[]
}

export interface ProcessStep {
  id: string
  label: string
  actor: string
  lane?: string
  /** Alternate branch track within the assigned swimlane (0 is the main track). */
  laneTrack?: number
  /** このタスクが使う情報。 */
  inputs?: StepInformationRef[]
  /** このタスクが作る・更新する情報。 */
  outputs?: StepInformationRef[]
  type: 'start' | 'task' | 'gateway' | 'end'
  x: number
  y: number
  width?: number
  duration?: string
  system?: string
  risk?: 'high' | 'medium' | 'low'
  monthlyVolume?: string
  description?: string
  evidence?: string[]
  confidence?: number
  sourceFragmentIds?: string[]
  sourceQuotes?: string[]
  needsReview?: boolean
  /** Optional lower-level business process opened when this task is drilled down. */
  childBusinessId?: string
}

export interface ProcessConnection {
  id: string
  from: string
  to: string
  label?: string
  fromAnchor?: ProcessConnectionAnchor
  toAnchor?: ProcessConnectionAnchor
}

export type OperationalAssetType = '業務システム' | 'SaaS' | 'Excel・台帳' | 'ファイル' | '共有フォルダ' | 'メール' | 'チャット' | '紙帳票' | 'データベース・API' | 'その他'
export type ProcessAssetRelation = '入力' | '参照' | '更新' | '出力'
export type ProcessAssetLayoutDirection = 'horizontal' | 'vertical'
export type ProcessConnectionAnchor = 'top' | 'right' | 'bottom' | 'left'

export interface ProcessAssetLanePosition {
  layoutDirection: ProcessAssetLayoutDirection
  x: number
  y: number
}

export interface OperationalAsset {
  id: string
  name: string
  type: OperationalAssetType
  purpose: string
  owner: string
  location: string
  dataDescription: string
  status: '未確認' | '確認済み'
  confidence: number
  sourceFragmentIds: string[]
  aliases?: string[]
}

export interface ProcessAssetLink {
  id: string
  assetId: string
  stepId: string
  relation: ProcessAssetRelation
  /**
   * この紐付けのもとになった情報。情報の取得元・格納先から自動で作った紐付けだけが持ち、
   * 無いものは「どの情報か未特定」のアセット利用として扱う。
   */
  informationIds?: string[]
  /** 旧データの、工程で扱う項目の記述。今は情報への移行にだけ使う。 */
  dataDescription?: string
  position?: ProcessAssetLanePosition
  systemLanePosition?: ProcessAssetLanePosition
}

export interface ProcessModel {
  improvementPlan?: ImprovementPlan
  businessId: string
  departmentId: string
  title: string
  steps: ProcessStep[]
  connections: ProcessConnection[]
  updatedAt: string
  reviewStatus: '編集中' | 'レビュー依頼中' | '承認済み'
  reviewer?: string
  reviewNote?: string
  sourceType?: 'master' | 'interview' | 'document'
  sourceInterviewId?: string
  sourceImportId?: string
  layoutDirection?: 'horizontal' | 'vertical'
  lanes?: string[]
  laneHeights?: Record<string, number>
  laneWidths?: Record<string, number>
  layoutPositionsCustomized?: boolean
  summary?: string
  assumptions?: string[]
  reviewItems?: string[]
  assets?: OperationalAsset[]
  assetLinks?: ProcessAssetLink[]
  /** タスクの入力・出力として使う情報の一覧。未設定なら旧データとして資産の紐付けから作る。 */
  information?: ProcessInformation[]
  /** Asset names the user explicitly removed from automatic step synchronization. */
  suppressedAssetKeys?: string[]
  /** Asset/step pairs the user explicitly unlinked from automatic synchronization. */
  suppressedAssetLinkKeys?: string[]
}

export interface ProcessVersion {
  id: string
  businessId: string
  savedAt: string
  label: string
  steps: ProcessStep[]
  connections: ProcessConnection[]
  layoutDirection?: 'horizontal' | 'vertical'
  lanes?: string[]
  laneHeights?: Record<string, number>
  laneWidths?: Record<string, number>
  layoutPositionsCustomized?: boolean
  assets?: OperationalAsset[]
  assetLinks?: ProcessAssetLink[]
  information?: ProcessInformation[]
  suppressedAssetKeys?: string[]
  suppressedAssetLinkKeys?: string[]
}

export interface InterviewTopic {
  id: string
  name: string
  description: string
  required: boolean
  questionCount: number
  category: '共通' | '業務固有'
  answerType?: '自由記述' | '数値' | '選択肢' | '条件分岐' | 'ファイル・証跡'
  keywords?: string[]
  questionExamples?: string[]
  source?: '標準テンプレート' | 'AI提案' | '手動' | '他業務コピー'
  coverageKey?: 'purpose' | 'flow' | 'role' | 'evidence' | 'system' | 'volume' | 'exception' | 'issue' | 'control'
}

export type MasterMaturity = '発見' | '仮説' | '確認中' | '検証済み' | '標準化済み'

export type BusinessProcessRelationType = '前後工程' | '呼び出し' | '分岐・バリエーション' | '例外・差戻し' | 'データ連携' | '共通システム' | 'その他'

/** Cross-process relationship kept separately from the decomposition tree. */
export interface BusinessProcessRelation {
  id: string
  fromBusinessId: string
  toBusinessId: string
  type: BusinessProcessRelationType
  label?: string
  description?: string
}

export interface InterviewDataItem {
  name: string
  description: string
  dataType: '文字列' | '数値' | '日付' | '金額' | '真偽値' | '選択肢' | '識別子' | 'その他'
  sourceDocument: string
  confidence: number
}

export interface WorkFragment {
  id: string
  title: string
  description: string
  departmentId: string
  actor: string
  participant: string
  trigger: string
  tools: string[]
  output: string
  nextStep: string
  nextActor?: string
  standardTime?: string
  processingVolume?: string
  sourceDocument?: string
  sourceReference?: string
  dataItems?: InterviewDataItem[]
  personalization: '高' | '中' | '低'
  sourceQuote: string
  sourceTime: string
  interviewId: string
  confidence: number
}

export interface ProcessVariant {
  id: string
  name: string
  actor: string
  difference: string
  sourceFragmentIds: string[]
}

/**
 * タスクの分類。打ち手が分類ごとにほぼ決まるため、これを見直しの着眼点にする。
 * 価値の有無は業務によって変わるので、分類とは別にTaskValueで持つ。
 */
export type TaskCategory = '作業' | '確認' | '登録' | '伝達' | '手戻り' | '未分類'
/**
 * 業務の成果に対する価値区分。経理の「仕訳計上」のように、登録でも業務の本体になりうる。
 * 付加価値=成果物そのもの、必要=統制・法令上なくせない、削減候補=なくしても成果が変わらない。
 */
export type TaskValue = '付加価値' | '必要' | '削減候補'
/** 正確な件数は測れないため、大・中・小の感覚値で優先順位を付ける。 */
export type BusinessVolumeBand = '大' | '中' | '小' | '未確認'

export interface BusinessTask {
  id: string
  name: string
  category: TaskCategory
  /**
   * 担当部門。業務が組織に紐づくので画面では使わない。以前のデータを読めるよう残している。
   * どの部門が関わるかは、As-Isのレーンを組織に結び付けて求めるのが正確。
   */
  departmentId: string
  /** 分類を誰が決めたか。keyword=名前の規則、llm=AI、未設定=人。 */
  mappedBy?: 'keyword' | 'llm'
  /** AIが分類したときの根拠。人が直せるように残す。 */
  mappedReason?: string
  /** 価値区分。未設定なら分類から推定する。 */
  value?: TaskValue
  /** 価値区分を誰が決めたか。llm=AI、未設定=人（valueがあるとき）。 */
  valueBy?: 'llm'
  /** AIが価値区分を決めたときの根拠。 */
  valueReason?: string
  /** 取り込み元のAs-Isステップ。二重に取り込まないための目印。 */
  sourceStepId?: string
}

export interface BusinessProcessMaster {
  id: string
  code: string
  name: string
  departmentId: string
  category: string
  description: string
  startCondition: string
  endCondition: string
  sapScope: '標準' | '拡張' | '周辺' | '未判定'
  sapModule: string
  ownerRole: string
  status: '作成中' | '作成完了'
  updatedAt: string
  /** 業務固有の確認観点。空の場合は共通確認項目がヒアリングへ渡される。 */
  interviewTopics: InterviewTopic[]
  maturity?: MasterMaturity
  sourceFragmentIds?: string[]
  variants?: ProcessVariant[]
  /** Canonical As-Is process record associated with this business master. */
  asIsModelId?: string
  asIsUpdatedAt?: string
  asIsSourceInterviewId?: string
  /** Empty for a top-level process; points to the process decomposed by this record. */
  parentId?: string
  /** この業務を構成するタスク。業務マップの集計単位になる。 */
  tasks?: BusinessTask[]
  /** 発生量の感覚値。タスク数だけで並べると、年に数回の業務が上位へ来てしまう。 */
  volumeBand?: BusinessVolumeBand
}
