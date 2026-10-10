import { authFetch } from './http'
import { type LlmFragment } from './interview'
import { type LlmProcessDraftResponse } from './process'

export type BusinessFlowImportStatus = 'queued' | 'preprocessing' | 'classifying' | 'extracting' | 'assembling' | 'ready_for_review' | 'committing' | 'completed' | 'failed' | 'cancelled'

export interface BusinessFlowImportCandidate {
  id: string
  title: string
  summary: string
  confidence: number
  page_references: string[]
  fragments: Array<LlmFragment & { id: string; source_quote: string; source_time: string }>
  warnings: string[]
  draft: LlmProcessDraftResponse | null
  selected: boolean
  target_business_id: string
}

export interface BusinessFlowImportJob {
  id: string
  department_id: string
  file_name: string
  file_size: number
  status: BusinessFlowImportStatus
  stage: string
  progress: number
  total_pages: number
  processed_pages: number
  candidate_count: number
  error: string
  created_at: string
  updated_at: string
  candidates: BusinessFlowImportCandidate[]
}

async function importResponse(response: Response): Promise<BusinessFlowImportJob> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `業務フロー資料API error: ${response.status}`)
  }
  return await response.json() as BusinessFlowImportJob
}

export async function createBusinessFlowImport(file: File, departmentId: string): Promise<BusinessFlowImportJob> {
  const body = new FormData()
  body.append('department_id', departmentId)
  body.append('file', file)
  return importResponse(await authFetch('/api/business-flow-imports', { method: 'POST', body }))
}

export async function getBusinessFlowImport(jobId: string): Promise<BusinessFlowImportJob> {
  return importResponse(await authFetch(`/api/business-flow-imports/${encodeURIComponent(jobId)}`))
}

export async function listBusinessFlowImports(): Promise<BusinessFlowImportJob[]> {
  const response = await authFetch('/api/business-flow-imports')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `業務フロー資料一覧API error: ${response.status}`)
  }
  return await response.json() as BusinessFlowImportJob[]
}

export async function updateBusinessFlowImportCandidate(
  jobId: string,
  candidateId: string,
  update: { title?: string; selected?: boolean; target_business_id?: string },
): Promise<BusinessFlowImportJob> {
  return importResponse(await authFetch(
    `/api/business-flow-imports/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) },
  ))
}

export async function commitBusinessFlowImport(jobId: string, candidateIds: string[]): Promise<BusinessFlowImportJob> {
  return importResponse(await authFetch(`/api/business-flow-imports/${encodeURIComponent(jobId)}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate_ids: candidateIds }),
  }))
}

export async function cancelBusinessFlowImport(jobId: string): Promise<BusinessFlowImportJob> {
  return importResponse(await authFetch(`/api/business-flow-imports/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }))
}

export async function retryBusinessFlowImport(jobId: string): Promise<BusinessFlowImportJob> {
  return importResponse(await authFetch(`/api/business-flow-imports/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }))
}
