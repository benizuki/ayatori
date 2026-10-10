import { postJson } from './http'
import { type LlmFragment, type LlmInterviewAttachment } from './interview'

/** 工程が入力・出力する情報。asset_keysは取得元・格納先の置き場所。 */
export interface LlmProcessDraftInformation {
  name: string
  asset_keys: string[]
  items: string[]
}

export interface LlmProcessDraftNode {
  key: string
  label: string
  type: 'start' | 'task' | 'gateway' | 'end'
  actor: string
  order: number
  system: string
  duration: string
  monthly_volume: string
  description: string
  confidence: number
  source_fragment_ids: string[]
  needs_review: boolean
  inputs?: LlmProcessDraftInformation[]
  outputs?: LlmProcessDraftInformation[]
}

export interface LlmProcessDraftFlow {
  from_key: string
  to_key: string
  label: string
}

export interface LlmProcessDraftAsset {
  key: string
  name: string
  type: '業務システム' | 'SaaS' | 'Excel・台帳' | 'ファイル' | '共有フォルダ' | 'メール' | 'チャット' | '紙帳票' | 'データベース・API' | 'その他'
  purpose: string
  owner: string
  location: string
  data_description: string
  confidence: number
  source_fragment_ids: string[]
  needs_review: boolean
}

export interface LlmProcessDraftAssetLink {
  asset_key: string
  node_key: string
  relation: '入力' | '参照' | '更新' | '出力'
  data_description: string
}

export interface LlmProcessDraftResponse {
  title: string
  summary: string
  start_condition: string
  end_condition: string
  lanes: string[]
  nodes: LlmProcessDraftNode[]
  flows: LlmProcessDraftFlow[]
  assets: LlmProcessDraftAsset[]
  asset_links: LlmProcessDraftAssetLink[]
  assumptions: string[]
  review_items: string[]
  provider: string
  model: string
}

export interface AssetLedgerField {
  name: string
  description: string
  data_type: '文字列' | '数値' | '日付' | '金額' | '真偽値' | '選択肢' | '識別子' | 'その他'
  confidence: number
}

export interface AssetDocumentExtractionResponse {
  document_type: string
  summary: string
  fields: AssetLedgerField[]
  warnings: string[]
  provider: string
  model: string
}

export type TaskCategoryName = '作業' | '確認' | '登録' | '伝達' | '手戻り' | '未分類'

export type TaskValueName = '付加価値' | '必要' | '削減候補'

export interface TaskClassificationResult {
  index: number
  category: TaskCategoryName
  reason: string
  value: TaskValueName | null
  value_reason: string
}

export interface TaskClassificationResponse {
  items: TaskClassificationResult[]
  provider: string
  model: string
}

export async function requestProcessDraft(payload: {
  session_id: string
  department: string
  participant: string
  fragments: Array<LlmFragment & { id: string; source_quote: string; source_time: string }>
  business_context?: Record<string, unknown> | null
}): Promise<LlmProcessDraftResponse> {
  return postJson<LlmProcessDraftResponse>('/api/process/draft', payload, 90_000)
}

export async function classifyBusinessTasks(payload: {
  business_name: string
  business_description: string
  start_condition: string
  end_condition: string
  tasks: Array<{
    index: number
    name: string
    current_category: TaskCategoryName
    fixed: boolean
    current_value: TaskValueName | null
    value_fixed: boolean
  }>
}): Promise<TaskClassificationResponse> {
  return postJson<TaskClassificationResponse>('/api/tasks/classify', payload, 120_000)
}

export async function extractAssetDocumentFields(payload: {
  asset_name: string
  existing_description: string
  attachment: LlmInterviewAttachment
}): Promise<AssetDocumentExtractionResponse> {
  return postJson<AssetDocumentExtractionResponse>('/api/assets/extract-fields', payload, 90_000)
}

export interface ProcessAiProposalResponseItem {
  id: string
  kind: 'agent' | 'assist' | 'automation' | 'process-change' | 'human' | 'needs-info'
  ecrs?: Array<'E' | 'C' | 'R' | 'S'>
  before?: string
  after?: string
  improvement_actions?: string[]
  priority: 'high' | 'medium' | 'low'
  title: string
  summary: string
  actor: string
  step_ids: string[]
  step_labels: string[]
  input_data: Array<{ name: string; type: string; relation: string }>
  output_data: Array<{ name: string; type: string; relation: string }>
  system_names: string[]
  capabilities: string[]
  ai_actions: string[]
  reasons: string[]
  expected_benefits: string[]
  human_role: string
  requirements: string[]
  risks: string[]
  missing_information: string[]
  evidence_level: '高' | '中' | '低'
}

export interface ProcessAiOpportunityResponse {
  proposals: ProcessAiProposalResponseItem[]
  recommended_count: number
  agent_candidate_count: number
  assist_candidate_count: number
  automation_candidate_count: number
  needs_info_count: number
  uncovered_step_labels: string[]
  generated_at: string
}

/** As-Isの事実を渡し、AI活用提案をGeminiに組み立てさせる。失敗時は呼び出し側でルール判定を使う。 */
export async function generateProcessAiOpportunities(
  evidence: unknown,
  signal?: AbortSignal,
): Promise<ProcessAiOpportunityResponse> {
  return postJson<ProcessAiOpportunityResponse>('/api/process/ai-opportunities', evidence, 180_000, signal)
}
