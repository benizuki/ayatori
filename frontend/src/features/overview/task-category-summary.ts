import type { BusinessProcessMaster, Department, TaskCategory } from '../../models'
import { TASK_MAP_COLUMNS } from '../master/task-categories'

export interface DepartmentTaskCategorySummary {
  department: Department
  businessCount: number
  taskCount: number
  byCategory: Record<TaskCategory, number>
}

export function emptyTaskCategoryCounts(): Record<TaskCategory, number> {
  return { 作業: 0, 確認: 0, 登録: 0, 伝達: 0, 手戻り: 0, 未分類: 0 }
}

/** 業務マスターが所属する業務領域を基準に、配下のタスクを分類別に集計する。 */
export function summarizeTaskCategoriesByDepartment(
  departments: Department[],
  businesses: BusinessProcessMaster[],
): DepartmentTaskCategorySummary[] {
  const summaries = new Map<string, DepartmentTaskCategorySummary>(
    departments.map((department) => [department.id, {
      department,
      businessCount: 0,
      taskCount: 0,
      byCategory: emptyTaskCategoryCounts(),
    }]),
  )

  for (const business of businesses) {
    const summary = summaries.get(business.departmentId)
    if (!summary) continue
    summary.businessCount += 1
    for (const task of business.tasks ?? []) {
      summary.taskCount += 1
      summary.byCategory[task.category] += 1
    }
  }

  return departments.map((department) => summaries.get(department.id)!)
}

export function totalTaskCategories(
  summaries: DepartmentTaskCategorySummary[],
): Record<TaskCategory, number> {
  const totals = emptyTaskCategoryCounts()
  for (const summary of summaries) {
    for (const category of TASK_MAP_COLUMNS) totals[category] += summary.byCategory[category]
  }
  return totals
}
