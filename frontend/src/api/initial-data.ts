import type {
  BusinessProcessMaster,
  Department,
  InterviewMessage,
  InterviewTopic,
  ProcessStep,
  WorkFragment,
} from '../models'

interface InitialData {
  initialDepartmentIds: Record<'accounting' | 'hr' | 'procurement' | 'it', string>
  departments: Department[]
  interviewTopicTemplates: InterviewTopic[]
  interviewMessages: InterviewMessage[]
  processSteps: ProcessStep[]
  businessProcessMasters: BusinessProcessMaster[]
  workFragments: WorkFragment[]
}

export let initialDepartmentIds: InitialData['initialDepartmentIds'] = {
  accounting: '',
  hr: '',
  procurement: '',
  it: '',
}
export let departments: Department[] = []
export let interviewTopicTemplates: InterviewTopic[] = []
export let interviewMessages: InterviewMessage[] = []
export let processSteps: ProcessStep[] = []
export let businessProcessMasters: BusinessProcessMaster[] = []
export let workFragments: WorkFragment[] = []

export async function loadInitialData(): Promise<void> {
  const response = await fetch('/api/initial-data', {
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`初期データを取得できませんでした (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const data = await response.json() as InitialData
  if (
    !data.initialDepartmentIds
    || !Array.isArray(data.departments)
    || !Array.isArray(data.interviewTopicTemplates)
    || !Array.isArray(data.interviewMessages)
    || !Array.isArray(data.processSteps)
    || !Array.isArray(data.businessProcessMasters)
    || !Array.isArray(data.workFragments)
  ) {
    throw new Error('バックエンドから取得した初期データの形式が不正です。')
  }
  initialDepartmentIds = data.initialDepartmentIds
  departments = data.departments
  interviewTopicTemplates = data.interviewTopicTemplates
  interviewMessages = data.interviewMessages
  processSteps = data.processSteps
  businessProcessMasters = data.businessProcessMasters
  workFragments = data.workFragments
}
