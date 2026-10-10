import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

// Bundle the production TypeScript with Vite's esbuild dependency; no browser or API calls.
const result = await build({ entryPoints: [new URL('../src/features/process/process-ai-opportunity-model.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { buildProcessAiEvidence, buildProcessAiProposals, toProcessAiProposalSet } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
const model = {
  businessId: 'qa', departmentId: 'manufacturing', title: '製造日報', updatedAt: '', reviewStatus: '編集中',
  steps: [
    { id: 'register', type: 'task', label: '実績を登録', lane: '製造担当', x: 100, y: 100 },
    { id: 'report', type: 'task', label: '日報へ転記', lane: '管理担当', x: 300, y: 100 },
  ],
  connections: [{ id: 'flow', from: 'register', to: 'report', label: '登録後' }],
  assets: [], assetLinks: [],
}

test('manual map category overrides the name; keyword and AI categories remain identified as tentative', () => {
  for (const [mappedBy, source] of [[undefined, 'map'], ['keyword', 'inferred'], ['llm', 'ai']]) {
    const evidence = buildProcessAiEvidence(model, [{ id: 'task', sourceStepId: 'report', category: '伝達', mappedBy }])
    assert.equal(evidence.steps[1].category, '伝達')
    assert.equal(evidence.steps[1].category_source, source)
    assert.equal(evidence.steps[0].category_source, 'inferred')
  }
})
test('actual connections and unknown quantities are preserved, not interpreted as category order or zero', () => {
  const evidence = buildProcessAiEvidence(model)
  assert.deepEqual(evidence.connections, [{ from_id: 'register', to_id: 'report', label: '登録後' }])
  assert.equal(evidence.steps[0].duration, '')
  assert.equal(evidence.steps[0].monthly_volume, '')
})
test('rule fallback covers each task with a conditional ECRS change and does not invent numbers', () => {
  const set = buildProcessAiProposals(model)
  assert.equal(set.source, 'rule')
  assert.equal(set.proposals.length, 2)
  assert.deepEqual(set.proposals.flatMap(p => p.stepIds).sort(), ['register', 'report'])
  for (const proposal of set.proposals) {
    assert.ok(proposal.ecrs.length)
    assert.ok(proposal.before)
    assert.match(proposal.after, /条件を確認して検討/)
    assert.ok(proposal.improvementActions.length)
    assert.equal(/\d/.test(proposal.after), false)
  }
})
test('AI response mapping retains cross-step alternatives and operation changes', () => {
  const item = {
    id: 'change', kind: 'process-change', priority: 'high', title: '二重入力を廃止', summary: '正本から日報を作成',
    ecrs: ['E', 'C'], before: '転記している', after: '一度の入力を共有', improvement_actions: ['正本を決める'],
    actor: '製造担当、管理担当', step_ids: ['register', 'report'], step_labels: ['実績を登録', '日報へ転記'],
    input_data: [], output_data: [], system_names: [], capabilities: [], ai_actions: [], reasons: [],
    expected_benefits: [], human_role: '', requirements: [], risks: [], missing_information: [], evidence_level: '低',
  }
  const set = toProcessAiProposalSet({ proposals: [item, { ...item, id: 'alternative' }], recommended_count: 2 })
  assert.equal(set.proposals[0].kindLabel, '運用変更')
  assert.deepEqual(set.proposals[0].ecrs, ['E', 'C'])
  assert.deepEqual(set.proposals[1].stepIds, ['register', 'report'])
  assert.deepEqual(set.proposals[0].improvementActions, ['正本を決める'])
})
