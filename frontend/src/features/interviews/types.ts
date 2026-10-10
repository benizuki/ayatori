import type { LlmInterviewResponse, SavedInterviewAttachment, SavedInterviewSession } from '../../api/interview'

export type InterviewSessionStatus = '進行中' | '中断' | '完了' | 'As-Is作成済'

export interface InterviewSessionSummary {
  id: string
  title: string
  participant: string
  departmentId: string
  departmentName: string
  status: InterviewSessionStatus
  phase: LlmInterviewResponse['phase'] | '未開始'
  completionScore: number
  messageCount: number
  fragmentCount: number
  createdAt: string
  updatedAt: string
  sourceProcessId?: string
  transcript?: SavedInterviewSession['messages']
  transcriptAvailable?: boolean
  // reflection は廃止した業務振り返りの保存済みデータ。一覧からは除外する。
  mode?: 'interview' | 'reflection'
  ownerEmail?: string
}

export interface InterviewSessionGroup {
  id: string
  businessId?: string
  title: string
  departmentId: string
  departmentName: string
  status: InterviewSessionStatus
  phase: InterviewSessionSummary['phase']
  completionScore: number
  messageCount: number
  fragmentCount: number
  createdAt: string
  updatedAt: string
  sessions: InterviewSessionSummary[]
}

export interface ProcessHistoryMessage {
  role: 'user' | 'assistant'
  text: string
  speaker: string
  time: string
  attachments?: SavedInterviewAttachment[]
}

export interface ProcessHistorySession {
  id: string
  kind: 'initial' | 'refinement'
  canUpdateAsIs: boolean
  participant: string
  department: string
  phase: string
  completionScore: number
  updatedAt: string
  evidence: string[]
  messages: ProcessHistoryMessage[]
  saved: boolean
}
