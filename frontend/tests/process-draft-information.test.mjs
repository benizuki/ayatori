import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  stdin: {
    contents: `
      export { processModelFromDraft, mergeProcessDraftWithExisting } from './src/features/interviews/process-draft-model.ts'
      export { normalizeProcessInformation } from './src/features/process/process-information.ts'
    `,
    resolveDir: new URL('..', import.meta.url).pathname,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { processModelFromDraft, mergeProcessDraftWithExisting, normalizeProcessInformation } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const business = { id: 'ap', name: '請求書処理', departmentId: 'acc' }
const node = (key, label, type = 'task', extra = {}) => ({
  key, label, type, actor: '買掛金担当', order: 1, system: '', duration: '未確認', monthly_volume: '未確認',
  description: '', confidence: 80, source_fragment_ids: [], needs_review: false, ...extra,
})
const draft = (nodes, assets = []) => ({
  title: '請求書処理', summary: '', start_condition: '', end_condition: '', lanes: ['買掛金担当'],
  nodes, flows: [], assets, asset_links: [], assumptions: [], review_items: [], provider: 'test', model: 'test',
})
const asset = (key, name, type) => ({ key, name, type, purpose: '', owner: '未確認', location: '未確認', data_description: '', confidence: 80, source_fragment_ids: [], needs_review: false })

test('AIが工程ごとに出した入力・出力の情報を、同じ名前は同じ情報として取り込む', () => {
  const model = processModelFromDraft(draft([
    node('register', '請求書を登録', 'task', {
      inputs: [{ name: '請求書', asset_keys: ['mail'], items: ['請求番号', '金額'] }],
      outputs: [{ name: '請求書データ', asset_keys: ['sap'], items: [] }],
    }),
    node('match', '発注データと照合', 'task', {
      inputs: [{ name: '請求書データ', asset_keys: ['sap'], items: [] }],
      outputs: [{ name: '照合結果', asset_keys: [], items: [] }],
    }),
  ], [asset('mail', 'メール', 'メール'), asset('sap', 'SAP', '業務システム')]), business, [], 'interview')
  normalizeProcessInformation(model)

  const [register, match] = model.steps
  const nameOf = (ref) => model.information.find((item) => item.id === ref.informationId).name
  assert.deepEqual(register.inputs.map(nameOf), ['請求書'])
  assert.equal(register.outputs[0].informationId, match.inputs[0].informationId)
  assert.deepEqual(model.information.find((item) => item.name === '請求書').items, ['請求番号', '金額'])
  assert.ok(model.information.every((item) => !item.provisional))
  const assetName = (id) => model.assets.find((item) => item.id === id).name
  assert.deepEqual(register.inputs[0].assetIds.map(assetName), ['メール'])
  assert.deepEqual(model.assetLinks.map((link) => [assetName(link.assetId), link.relation]).sort(), [['SAP', '入力'], ['SAP', '出力'], ['メール', '入力']].sort())
})

test('追加ヒアリングでは既存の情報名を正とし、新しい情報だけを足す', () => {
  const existing = processModelFromDraft(draft([
    node('register', '請求書を登録', 'task', { outputs: [{ name: '請求書データ', asset_keys: [], items: [] }] }),
  ]), business, [], 'first')
  normalizeProcessInformation(existing)
  const generated = processModelFromDraft(draft([
    node('register', '請求書を登録', 'task', {
      inputs: [{ name: '請求書', asset_keys: [], items: [] }],
      outputs: [{ name: '請求書データ', asset_keys: [], items: ['金額'] }],
    }),
    node('book', '支払予定を計上', 'task', { inputs: [{ name: '請求書データ', asset_keys: [], items: [] }] }),
  ]), business, [], 'second')

  const merged = mergeProcessDraftWithExisting(existing, generated)
  normalizeProcessInformation(merged)
  const invoiceData = merged.information.filter((item) => item.name === '請求書データ')
  assert.equal(invoiceData.length, 1)
  assert.deepEqual(invoiceData[0].items, ['金額'])
  const register = merged.steps.find((step) => step.label === '請求書を登録')
  const book = merged.steps.find((step) => step.label === '支払予定を計上')
  assert.equal(register.inputs.length, 1)
  assert.equal(book.inputs[0].informationId, invoiceData[0].id)
})
