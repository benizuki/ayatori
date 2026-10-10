import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/features/process/process-model.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { arrangeProcessVertically, processLevels } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)
const layout = await build({
  entryPoints: [new URL('../src/features/process/process-layout.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { branchTendency, planProcessLayout } = await import(
  `data:text/javascript;base64,${Buffer.from(layout.outputFiles[0].text).toString('base64')}`
)

const step = (id, type = 'task', lane = '買掛金担当') => ({ id, label: id, actor: lane, lane, type, x: 0, y: 0, connections: [], updatedAt: '', reviewStatus: '編集中' })
const flow = (from, to, label = '') => ({ id: `${from}-${to}`, from, to, label })

// 請求書処理の骨格：照合で差異があれば購買へ確認して訂正を依頼し、照合へ戻る。承認で差し戻されれば修正して申請へ戻る。
const invoice = () => ({
  businessId: 'ap', departmentId: 'acc', title: '請求書処理', updatedAt: '', reviewStatus: '編集中',
  lanes: ['買掛金担当', '購買担当', '部門長'],
  steps: [
    step('start', 'start'), step('register'), step('match'), step('g-match', 'gateway'),
    step('confirm-diff', 'task', '購買担当'), step('request-fix'), step('check-account'), step('make-approval'),
    step('approve', 'task', '部門長'), step('g-approve', 'gateway', '部門長'), step('fix-reject'), step('book'), step('end', 'end'),
  ],
  connections: [
    flow('start', 'register'), flow('register', 'match'), flow('match', 'g-match'),
    flow('g-match', 'confirm-diff', 'あり'), flow('confirm-diff', 'request-fix'), flow('request-fix', 'match', '再照合'),
    flow('g-match', 'check-account', 'なし'), flow('check-account', 'make-approval'), flow('make-approval', 'approve'),
    flow('approve', 'g-approve'), flow('g-approve', 'fix-reject', '差し戻し'), flow('fix-reject', 'make-approval', '再申請'),
    flow('g-approve', 'book', '承認'), flow('book', 'end'),
  ],
})

test('戻りの線を除いて段を決めるので、差し戻しがあっても後ろの工程が下に積まれない', () => {
  const model = invoice()
  const { levels, backEdges } = planProcessLayout(model.steps, model.connections)
  assert.deepEqual([...backEdges].sort(), ['fix-reject-make-approval', 'request-fix-match'])
  // 差異なしの勘定科目確認は、差異ありの購買確認と同じ段に並ぶ。
  assert.equal(levels.get('check-account'), levels.get('confirm-diff'))
  assert.equal(levels.get('end'), 9)
  assert.equal(processLevels(model).get('end'), 9)
})

test('本流は長く続く方・いつもの流れらしい条件名の方を選ぶ', () => {
  const model = invoice()
  const { mainPath } = planProcessLayout(model.steps, model.connections)
  assert.ok(mainPath.has('check-account'))
  assert.ok(mainPath.has('book'))
  assert.ok(!mainPath.has('confirm-diff'))
  assert.ok(!mainPath.has('fix-reject'))
  assert.equal(branchTendency('差し戻し'), -1)
  assert.equal(branchTendency('承認'), 1)
  assert.equal(branchTendency('はい'), 0)
})

test('本流が通る担当では、脇道の工程を本流の列から外して右の列に置く', () => {
  const model = invoice()
  arrangeProcessVertically(model)
  const byId = (id) => model.steps.find((item) => item.id === id)
  assert.equal(byId('check-account').laneTrack, 0)
  assert.equal(byId('request-fix').laneTrack, 1)
  assert.equal(byId('fix-reject').laneTrack, 1)
  assert.ok(byId('request-fix').x > byId('check-account').x)
  // 本流が通らない担当の工程は、その担当の列にそのまま置く。
  assert.equal(byId('confirm-diff').laneTrack, 0)
  // 本流の工程は、上から下へ順に並ぶ。
  const mainOrder = ['register', 'match', 'check-account', 'make-approval', 'book'].map((id) => byId(id).y)
  assert.deepEqual([...mainOrder].sort((a, b) => a - b), mainOrder)
})
