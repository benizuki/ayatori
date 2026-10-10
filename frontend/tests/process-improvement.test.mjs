import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/features/process/process-improvement.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { emptyReview, nonnegativeHours, summarizeImprovementImpact } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

const proposals = [
  { id: 'eliminate', stepIds: ['register', 'report'] },
  { id: 'automate', stepIds: ['register'] },
  { id: 'simplify', stepIds: ['apply'] },
]
const candidate = (laborHours, waitingHours = null) => ({ ...emptyReview(), status: '採用候補', laborHours, waitingHours })

test('overlapping adopted alternatives are all excluded; unrelated savings remain', () => {
  const impact = summarizeImprovementImpact(proposals, { eliminate: candidate(30), automate: candidate(20), simplify: candidate(10) }, 100)
  assert.deepEqual([...impact.conflictIds], ['eliminate', 'automate'])
  assert.equal(impact.savings, 10)
  assert.equal(impact.knownCount, 1)
  assert.equal(impact.productivity, 100 / 90)
})
test('pending or rejected alternatives do not block a candidate; waiting time never counts as labor', () => {
  const impact = summarizeImprovementImpact(proposals, { eliminate: candidate(40, 500), automate: { ...candidate(20), status: '見送り' } }, 100)
  assert.equal(impact.conflictIds.size, 0)
  assert.equal(impact.savings, 40)
  assert.equal(impact.productivity, 100 / 60)
})
test('missing estimates are not interpreted as measured zero', () => {
  const impact = summarizeImprovementImpact(proposals, { eliminate: candidate(null) }, 100)
  assert.equal(impact.unknownCount, 1)
  assert.equal(impact.knownCount, 0)
  assert.equal(impact.productivity, null)
})
test('zero is a valid estimate, but missing/zero/negative baselines cannot yield productivity', () => {
  for (const baseline of [null, 0, -1]) {
    const impact = summarizeImprovementImpact(proposals, { eliminate: candidate(0) }, baseline)
    assert.equal(impact.knownCount, 1)
    assert.equal(impact.productivity, null)
    assert.equal(impact.targetSavings, null)
  }
})
test('savings at or above total labor are flagged without displaying infinite/negative productivity', () => {
  for (const hours of [100, 110]) {
    const impact = summarizeImprovementImpact(proposals, { eliminate: candidate(hours) }, 100)
    assert.equal(impact.invalidTotal, true)
    assert.equal(impact.productivity, null)
  }
})
test('1.7x goal uses reciprocal productivity, not 70% labor reduction', () => {
  const impact = summarizeImprovementImpact([], {}, 170)
  assert.ok(Math.abs(impact.targetSavings - 70) < 0.000001)
})
test('invalid numbers cannot poison totals; blank input remains unknown', () => {
  for (const value of ['', null, undefined, -1, 'bad', Infinity]) assert.equal(nonnegativeHours(value), null)
  assert.equal(nonnegativeHours('0'), 0)
  assert.equal(nonnegativeHours('12.5'), 12.5)
})
