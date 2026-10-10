import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/features/process/process-insight-model.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { parseDurationMinutes, computeStepHeat, findHandoffConnectionIds } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('所要時間の自由記述を分に換算する', () => {
  assert.equal(parseDurationMinutes('10分'), 10)
  assert.equal(parseDurationMinutes('2時間'), 120)
  assert.equal(parseDurationMinutes('1日'), 480)
  assert.equal(parseDurationMinutes('1〜2日'), 720)
  assert.equal(parseDurationMinutes('半日'), 240)
  assert.equal(parseDurationMinutes('30分〜1時間'), 45)
  assert.equal(parseDurationMinutes('未確認'), null)
  assert.equal(parseDurationMinutes(undefined), null)
})

test('最長の工程に対する比でヒートの段階を決める', () => {
  const steps = [
    { id: 'a', type: 'task', duration: '10分' },
    { id: 'b', type: 'task', duration: '1日' },
    { id: 'c', type: 'task', duration: '2日' },
    { id: 'd', type: 'task', duration: '未確認' },
    { id: 'e', type: 'gateway', duration: '3日' },
  ]
  const heat = computeStepHeat(steps)
  assert.equal(heat.get('a').level, 0)
  assert.equal(heat.get('b').level, 2)
  assert.equal(heat.get('c').level, 3)
  assert.equal(heat.has('d'), false)
  assert.equal(heat.has('e'), false)
})

test('レーンをまたぐ接続だけを受け渡しとして拾う', () => {
  const ids = findHandoffConnectionIds({
    steps: [
      { id: 'a', lane: '担当', actor: '担当' },
      { id: 'b', lane: '担当', actor: '担当' },
      { id: 'c', lane: '部門長', actor: '部門長' },
    ],
    connections: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }],
  })
  assert.deepEqual([...ids], ['bc'])
})
