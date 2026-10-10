import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({ entryPoints: [new URL('../src/features/process/process-model.ts', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false })
const { ensureProcessAssets } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

test('legacy asset fields are copied to each step link without sharing later edits', () => {
  const model = {
    businessId: 'asset-data', departmentId: 'it', title: '申請', updatedAt: '', reviewStatus: '編集中',
    steps: [
      { id: 'receive', type: 'task', label: '申請を受け付ける', lane: '担当者', system: '申請台帳', x: 0, y: 0 },
      { id: 'approve', type: 'task', label: '申請を承認する', lane: '承認者', system: '申請台帳', x: 200, y: 0 },
    ],
    connections: [],
    assets: [{
      id: 'ledger', name: '申請台帳', type: 'Excel・台帳', purpose: '', owner: '', location: '',
      dataDescription: '申請番号、申請者、承認状態', status: '確認済み', confidence: 100, sourceFragmentIds: [],
    }],
    assetLinks: [
      { id: 'receive-link', assetId: 'ledger', stepId: 'receive', relation: '入力' },
      { id: 'approve-link', assetId: 'ledger', stepId: 'approve', relation: '更新' },
    ],
  }

  ensureProcessAssets(model)
  assert.equal(model.assetLinks[0].dataDescription, '申請番号、申請者、承認状態')
  assert.equal(model.assetLinks[1].dataDescription, '申請番号、申請者、承認状態')

  model.assetLinks[1].dataDescription = '申請番号、承認者、承認日時、承認状態'
  assert.equal(model.assetLinks[0].dataDescription, '申請番号、申請者、承認状態')
})
