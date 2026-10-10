import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/features/process/process-information.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { addStepInformation, assetRoleShortLabel, convertDocumentAssetsToPlaces, detachAssetFromStepInformation, documentNameFromAsset, informationFindings, informationOnAsset, normalizeProcessInformation, pruneUnusedInformation, removeStepInformation, renameInformation, suppressUnusedStepAssets, syncAssetLinksFromInformation } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const step = (id, type = 'task') => ({ id, label: id, actor: 'A', type, x: 0, y: 0, connections: [], updatedAt: '', reviewStatus: '編集中' })
const model = (steps, connections = []) => ({ businessId: 'b', departmentId: 'd', title: 't', steps, connections, updatedAt: '', reviewStatus: '編集中' })

const asset = (id, name, type) => ({ id, name, type, purpose: '', owner: '', location: '', dataDescription: '', status: '未確認', confidence: 50, sourceFragmentIds: [] })

test('同じ名前の情報は1つにまとめ、タスク間で共有する', () => {
  const target = model([step('a'), step('b')])
  addStepInformation(target, target.steps[0], 'outputs', '照合結果')
  addStepInformation(target, target.steps[1], 'inputs', ' 照合結果 ')
  assert.equal(target.information.length, 1)
  assert.equal(target.steps[0].outputs[0].informationId, target.steps[1].inputs[0].informationId)
})

test('使われない出力・出どころ不明の入力・重複する出力を見つける', () => {
  const target = model([step('make'), step('copy'), step('use'), step('end', 'end')], [{ id: 'c', from: 'use', to: 'end' }])
  const [make, copy, use] = target.steps
  addStepInformation(target, make, 'outputs', '支払予定表')
  addStepInformation(target, copy, 'outputs', '支払予定表')
  addStepInformation(target, make, 'outputs', 'レビュー結果')
  addStepInformation(target, use, 'inputs', '請求書')
  addStepInformation(target, use, 'outputs', '証憑')

  const kinds = (item) => informationFindings(target, item).map((finding) => finding.kind).sort()
  assert.deepEqual(kinds(make), ['duplicate-output', 'unused-output', 'unused-output'])
  assert.deepEqual(kinds(use), ['unknown-source'])
})

test('最後のタスクの出力は業務の成果物なので、使われない出力として挙げない', () => {
  const target = model([step('last'), step('end', 'end')], [{ id: 'c', from: 'last', to: 'end' }])
  addStepInformation(target, target.steps[0], 'outputs', '支払完了通知')
  assert.deepEqual(informationFindings(target, target.steps[0]), [])
})

test('1つの情報に媒体を複数付けられ、どの媒体から見ても同じ情報として集まる', () => {
  const target = model([step('receive')])
  addStepInformation(target, target.steps[0], 'inputs', '請求書', ['mail', 'paper'])
  assert.deepEqual(informationOnAsset(target, 'mail').map((item) => item.name), ['請求書'])
  assert.deepEqual(informationOnAsset(target, 'paper').map((item) => item.name), ['請求書'])
})

test('名前を変えると全タスクで変わり、別の情報と同じ名前にはできない', () => {
  const target = model([step('a'), step('b')])
  const invoice = addStepInformation(target, target.steps[0], 'outputs', '請求書')
  addStepInformation(target, target.steps[1], 'inputs', '請求書')
  addStepInformation(target, target.steps[1], 'outputs', '照合結果')
  assert.equal(renameInformation(target, invoice.id, '請求書データ'), 'renamed')
  assert.equal(target.information.find((item) => item.id === target.steps[1].inputs[0].informationId).name, '請求書データ')
  assert.equal(renameInformation(target, invoice.id, '照合結果'), 'duplicate')
  assert.equal(invoice.name, '請求書データ')
})

test('外した情報がどこからも使われなくなれば一覧から消す', () => {
  const target = model([step('a')])
  const information = addStepInformation(target, target.steps[0], 'inputs', '請求書')
  removeStepInformation(target.steps[0], 'inputs', information.id)
  pruneUnusedInformation(target)
  assert.equal(target.information.length, 0)
})

test('アセットから読んだ情報を別の保管型アセットへ入れていれば、転記の候補として挙げる', () => {
  const target = model([step('copy'), step('end', 'end')], [{ id: 'c', from: 'copy', to: 'end' }])
  target.assets = [asset('excel', '支払予定表', 'Excel・台帳'), asset('bank', 'ネットバンキング', '業務システム'), asset('mail', 'メール', 'メール')]
  const schedule = addStepInformation(target, target.steps[0], 'inputs', '支払予定表', ['excel'])
  schedule.items = ['支払先', '口座', '金額']
  const transfer = addStepInformation(target, target.steps[0], 'outputs', '総合振込データ', ['bank'])
  transfer.items = ['支払先', '金額', '振込日']
  const kinds = informationFindings(target, target.steps[0]).map((finding) => finding.kind)
  assert.ok(kinds.includes('transcription'))

  // 伝達型（メール）は情報が残る場所ではないので、転記の取得元にしない。
  target.steps[0].inputs[0].assetIds = ['mail']
  assert.ok(!informationFindings(target, target.steps[0]).some((finding) => finding.kind === 'transcription'))
})

test('同じ情報を複数の保管型アセットへ格納していれば、二重管理の候補として挙げる', () => {
  const target = model([step('a'), step('b'), step('use')])
  target.assets = [asset('sap', 'SAP', '業務システム'), asset('excel', '台帳', 'Excel・台帳')]
  addStepInformation(target, target.steps[0], 'outputs', '支払予定', ['sap'])
  addStepInformation(target, target.steps[1], 'outputs', '支払予定', ['excel'])
  addStepInformation(target, target.steps[2], 'inputs', '支払予定')
  assert.ok(informationFindings(target, target.steps[0]).some((finding) => finding.kind === 'duplicate-storage'))
})

test('書類名のアセットは情報と置き場所（Excel・紙・ファイル）に分ける', () => {
  assert.equal(documentNameFromAsset('Excel支払予定表'), '支払予定表')
  assert.equal(documentNameFromAsset('紙の稟議書'), '稟議書')
  assert.equal(documentNameFromAsset('請求書PDF'), '請求書')

  const target = model([step('make'), step('approve')])
  target.assets = [asset('sap', 'SAP', '業務システム'), asset('xls', 'Excel支払予定表', 'Excel・台帳'), asset('ringi', '紙の稟議書', '紙帳票')]
  // 取得元・格納先に書類名のアセットを指定していた箇所。
  addStepInformation(target, target.steps[0], 'outputs', '支払予定表', ['xls'])
  // 情報未特定で書類名のアセットを使っていた箇所。
  target.assetLinks = [{ id: 'auto', assetId: 'ringi', stepId: 'approve', relation: '出力' }]
  convertDocumentAssetsToPlaces(target)

  assert.deepEqual(target.assets.map((item) => item.name).sort(), ['Excel', 'SAP', '紙'].sort())
  const excel = target.assets.find((item) => item.name === 'Excel')
  const paper = target.assets.find((item) => item.name === '紙')
  assert.deepEqual(target.steps[0].outputs[0].assetIds, [excel.id])
  const ringi = target.information.find((item) => item.name === '稟議書')
  assert.deepEqual(target.steps[1].outputs, [{ informationId: ringi.id, assetIds: [paper.id] }])
  assert.equal(target.assetLinks.length, 0)
  // 業務システム欄の書類名から、書類のアセットを作り直さない。
  assert.ok(target.suppressedAssetKeys.length === 2)

  // 置き場所だけになったら、もう一度読み込んでも変わらない。
  const before = JSON.stringify(target)
  convertDocumentAssetsToPlaces(target)
  assert.equal(JSON.stringify(target), before)
})

test('情報が付いていないアセットの紐付けは、向きのまま仮の名前の入力・出力の情報に変える', () => {
  const target = model([step('fix'), step('book')])
  target.assets = [asset('mail', 'メール', 'メール'), asset('sap', 'SAP', '業務システム')]
  target.assetLinks = [
    { id: 'l1', assetId: 'mail', stepId: 'fix', relation: '参照', position: { x: 1, y: 2, layoutDirection: 'vertical' } },
    { id: 'l2', assetId: 'sap', stepId: 'book', relation: '更新', dataDescription: '・取引先［文字列］、金額' },
    { id: 'l3', assetId: 'sap', stepId: 'fix', relation: '参照' },
  ]
  normalizeProcessInformation(target)
  const nameOf = (ref) => target.information.find((item) => item.id === ref.informationId)
  // 参照は入力、更新は出力。タスクごとに別の仮の情報にする。
  assert.deepEqual(target.steps[0].inputs.map((ref) => nameOf(ref).name), ['メールから取得する情報（fix）', 'SAPから取得する情報（fix）'])
  assert.deepEqual(target.steps[1].outputs.map((ref) => nameOf(ref).name), ['SAPへ格納する情報（book）'])
  assert.ok(target.information.every((item) => item.provisional))
  // 紐付けに書かれていた項目は、何の情報かを決める手がかりとして残す。
  assert.deepEqual(nameOf(target.steps[1].outputs[0]).items, ['取引先', '金額'])
  // 紐付けは情報から作り直し、図で動かした位置は引き継ぐ。
  assert.ok(target.assetLinks.every((link) => link.informationIds?.length))
  assert.deepEqual(target.assetLinks.find((link) => link.assetId === 'mail').position, { x: 1, y: 2, layoutDirection: 'vertical' })
  assert.equal(assetRoleShortLabel('出力', target.assets[0]), '送付')

  // もう一度整えても変わらない。
  const before = JSON.stringify(target)
  normalizeProcessInformation(target)
  assert.equal(JSON.stringify(target), before)
})

test('仮の名前の情報は名前を付けるよう促し、名前を付けるまで流れの指摘からは外す', () => {
  const target = model([step('a')])
  target.assets = [asset('sap', 'SAP', '業務システム')]
  target.assetLinks = [{ id: 'l', assetId: 'sap', stepId: 'a', relation: '更新' }]
  normalizeProcessInformation(target)
  assert.deepEqual(informationFindings(target, target.steps[0]).map((finding) => finding.kind), ['provisional-name'])

  const id = target.steps[0].outputs[0].informationId
  renameInformation(target, id, '支払予定')
  assert.equal(target.information[0].provisional, undefined)
  assert.deepEqual(informationFindings(target, target.steps[0]).map((finding) => finding.kind), ['unused-output'])
})

test('情報から外したアセットは、業務システム欄から紐付け直さない', () => {
  const target = model([step('a')])
  const information = addStepInformation(target, target.steps[0], 'inputs', '請求書', ['mail', 'paper'])
  target.steps[0].inputs[0].assetIds = ['paper']
  suppressUnusedStepAssets(target, target.steps[0], ['mail'])
  assert.deepEqual(target.suppressedAssetLinkKeys, ['mail:a'])
  // まだ使っているアセットは抑止しない。
  suppressUnusedStepAssets(target, target.steps[0], ['paper'])
  assert.deepEqual(target.suppressedAssetLinkKeys, ['mail:a'])
  assert.ok(information)
})

test('情報の取得元・格納先を外すと、タスクとアセットの紐付けも消える', () => {
  const target = model([step('register')])
  target.assets = [asset('mail', 'メール', 'メール'), asset('sap', 'SAP', '業務システム')]
  addStepInformation(target, target.steps[0], 'inputs', '請求書', ['mail'])
  addStepInformation(target, target.steps[0], 'outputs', '請求書データ', ['sap'])
  syncAssetLinksFromInformation(target)
  assert.deepEqual(target.assetLinks.map((link) => [link.assetId, link.relation]), [['mail', '入力'], ['sap', '出力']])
  detachAssetFromStepInformation(target.steps[0], 'sap', 'outputs')
  syncAssetLinksFromInformation(target)
  assert.deepEqual(target.assetLinks.map((link) => link.assetId), ['mail'])
})

