import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/features/master/task-categories.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { classifyTaskName, migrateTaskCategory, summarizeTasks, harvestScore, taskValue } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const business = (tasks, volumeBand = '中') => ({ id: 'invoice', name: '請求書処理', departmentId: 'acc', volumeBand, tasks })

test('価値区分は人やAIが決めたものを優先し、なければ分類から推定する', () => {
  assert.equal(taskValue({ category: '作業' }), '付加価値')
  assert.equal(taskValue({ category: '伝達' }), '削減候補')
  assert.equal(taskValue({ category: '登録', value: '付加価値' }), '付加価値')
  assert.equal(taskValue({ category: '未分類' }), null)
})

test('削減候補の割合は価値区分が決まったタスクだけを母数にする', () => {
  const summary = summarizeTasks(business([
    { id: 'a', name: '仕訳計上', category: '登録', value: '付加価値', departmentId: 'acc' },
    { id: 'b', name: '支払内容を承認', category: '確認', departmentId: 'acc' },
    { id: 'c', name: '証憑を転記', category: '登録', value: '削減候補', departmentId: 'acc' },
    { id: 'd', name: '月次報告', category: '伝達', departmentId: 'acc' },
    { id: 'e', name: '謎のタスク', category: '未分類', departmentId: 'acc' },
  ]))
  assert.deepEqual(summary.byValue, { 付加価値: 1, 必要: 1, 削減候補: 2 })
  assert.equal(summary.judged, 4)
  assert.equal(summary.wasteRatio, 0.5)
  // 発生量「中」の重みは2。
  assert.equal(harvestScore(summary), 4)
})

test('経理の言い回しも名前から分類できる', () => {
  assert.equal(classifyTaskName('承認依頼を作成'), '伝達')
  assert.equal(classifyTaskName('証憑を共有フォルダへ保存'), '登録')
  assert.equal(classifyTaskName('仕訳計上・消込'), '登録')
  assert.equal(classifyTaskName('総合振込データを銀行へ送信'), '登録')
  assert.equal(classifyTaskName('差異の内容を購買へ問い合わせ'), '伝達')
})

test('承認は確認に、申請と報告は伝達にまとめる', () => {
  assert.equal(classifyTaskName('支払内容を承認'), '確認')
  assert.equal(classifyTaskName('月次報告を作成'), '伝達')
  assert.equal(migrateTaskCategory('承認'), '確認')
  assert.equal(migrateTaskCategory('申請'), '伝達')
  assert.equal(migrateTaskCategory('報告'), '伝達')
  assert.equal(migrateTaskCategory('登録'), '登録')
  assert.equal(migrateTaskCategory('存在しない分類'), '未分類')
})

test('差し戻しや訂正は、他の分類語を含んでいても手戻りにする', () => {
  assert.equal(classifyTaskName('差し戻し内容を修正'), '手戻り')
  assert.equal(classifyTaskName('訂正請求書を取引先へ依頼'), '手戻り')
  assert.equal(classifyTaskName('不備のため再申請'), '手戻り')
  // 「修正」だけでは通常の改訂と区別できない。
  assert.notEqual(classifyTaskName('契約書案を修正'), '手戻り')
  assert.equal(taskValue({ category: '手戻り' }), '削減候補')
})
