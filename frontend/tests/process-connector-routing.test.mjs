import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const result = await build({
  entryPoints: [new URL('../src/features/process/process-geometry.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { buildConnectorPaths, roundedOrthogonalPath, stepBox } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const task = (id, x, y) => ({ id, label: id, actor: 'A', type: 'task', x, y, width: 150, connections: [], updatedAt: '', reviewStatus: '編集中' })

/** パスの頂点を取り出す。Qの制御点は角そのものなので、角の位置として扱う。 */
function vertices(path) {
  return [...path.matchAll(/[MLQ]\s*(-?[\d.]+)\s+(-?[\d.]+)(?:\s+(-?[\d.]+)\s+(-?[\d.]+))?/g)]
    .flatMap((match) => match[3] === undefined
      ? [{ x: Number(match[1]), y: Number(match[2]) }]
      : [{ x: Number(match[1]), y: Number(match[2]) }, { x: Number(match[3]), y: Number(match[4]) }])
}

function crosses(path, box) {
  const points = vertices(path)
  return points.some((point, index) => {
    if (!index) return false
    const previous = points[index - 1]
    const midX = (previous.x + point.x) / 2
    const midY = (previous.y + point.y) / 2
    return midX > box.left && midX < box.right && midY > box.top && midY < box.bottom
  })
}

test('途中にあるタスクの上を素通りせず、脇へ回り込む', () => {
  const top = task('top', 100, 0)
  const middle = task('middle', 100, 150)
  const bottom = task('bottom', 100, 300)
  const [connection] = buildConnectorPaths([{ id: 'c', from: 'top', to: 'bottom' }], [top, middle, bottom])
  assert.equal(crosses(connection.path, stepBox(middle)), false)
})

test('上へ戻る線は左側を回り、戻りの線として印を付ける', () => {
  const upper = task('upper', 100, 0)
  const lower = task('lower', 100, 300)
  const [connection] = buildConnectorPaths([{ id: 'c', from: 'lower', to: 'upper', label: '再照合' }], [upper, lower])
  assert.equal(connection.back, true)
  assert.ok(Math.min(...vertices(connection.path).map((point) => point.x)) < 100)
})

test('人が接続点を指定した線は戻りの経路に変えない', () => {
  const upper = task('upper', 100, 0)
  const lower = task('lower', 100, 300)
  const [connection] = buildConnectorPaths([{ id: 'c', from: 'lower', to: 'upper', fromAnchor: 'top', toAnchor: 'bottom' }], [upper, lower])
  assert.equal(connection.back, false)
})

test('直角の角を丸める', () => {
  const path = roundedOrthogonalPath([{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 50, y: 50 }])
  assert.equal(path, 'M0 0 L0 38 Q0 50 12 50 L50 50')
})
