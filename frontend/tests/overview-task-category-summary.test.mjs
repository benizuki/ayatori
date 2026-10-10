import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/features/overview/task-category-summary.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { summarizeTaskCategoriesByDepartment, totalTaskCategories } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const departments = [
  { id: 'sales', name: '営業', owner: '', stage: '調査中', progress: 0, interviews: 0, processes: 0, icon: '', color: '' },
  { id: 'accounting', name: '経理', owner: '', stage: '調査中', progress: 0, interviews: 0, processes: 0, icon: '', color: '' },
]

test('業務が所属する領域ごとにタスク分類を集計する', () => {
  const businesses = [{
    id: 'order', departmentId: 'sales', tasks: [
      { id: 'a', name: '申請する', category: '伝達', departmentId: 'sales' },
      { id: 'b', name: '承認する', category: '確認', departmentId: 'accounting' },
      { id: 'c', name: '処理する', category: '作業', departmentId: 'sales' },
    ],
  }, {
    id: 'invoice', departmentId: 'accounting', tasks: [
      { id: 'd', name: '登録する', category: '登録', departmentId: 'accounting' },
      { id: 'e', name: '分類待ち', category: '未分類', departmentId: 'accounting' },
    ],
  }]

  const summaries = summarizeTaskCategoriesByDepartment(departments, businesses)
  assert.equal(summaries[0].businessCount, 1)
  assert.equal(summaries[0].taskCount, 3)
  assert.equal(summaries[0].byCategory.伝達, 1)
  assert.equal(summaries[0].byCategory.確認, 1)
  assert.equal(summaries[1].byCategory.登録, 1)
  assert.equal(summaries[1].byCategory.未分類, 1)

  const totals = totalTaskCategories(summaries)
  assert.deepEqual(totals, { 作業: 1, 確認: 1, 登録: 1, 伝達: 1, 手戻り: 0, 未分類: 1 })
})

test('業務やタスクがない領域も0件で表示対象に残す', () => {
  const summaries = summarizeTaskCategoriesByDepartment(departments, [])
  assert.equal(summaries.length, 2)
  assert.equal(summaries[1].businessCount, 0)
  assert.equal(summaries[1].taskCount, 0)
})
