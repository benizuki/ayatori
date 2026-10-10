/**
 * タスクの入力・出力として扱う情報（請求書、照合結果など）。
 * 情報をアセットの説明文ではなくタスクに紐付けることで、どのタスクが作りどのタスクが使うかを追えるようにする。
 * アセットは情報の置き場所で、入力情報の取得元・出力情報の格納先として添える。タスクとアセットの紐付けはここから求める。
 */
import { normalizedAssetKey } from './process-model'
import type { OperationalAsset, OperationalAssetType, ProcessAssetLink, ProcessAssetRelation, ProcessInformation, ProcessModel, ProcessStep, StepInformationRef } from '../../models'

export type InformationDirection = 'inputs' | 'outputs'

/** 入力情報のアセットは取得元、出力情報のアセットは格納先・送付先。紐付けの向きもここから決まる。 */
export const INFORMATION_ASSET_ROLE: Record<InformationDirection, { label: string; relation: ProcessAssetRelation }> = {
  inputs: { label: '取得元', relation: '入力' },
  outputs: { label: '格納先・送付先', relation: '出力' },
}

/** 紐付けの向き。参照・更新は、更新と新規を区別しないので入力・出力にまとめる。 */
export function assetLinkDirection(relation: ProcessAssetRelation): InformationDirection {
  return relation === '入力' || relation === '参照' ? 'inputs' : 'outputs'
}

/** 図の札に出す短い向き。メールやチャットは情報が残らないので「送付」と書く。 */
export function assetRoleShortLabel(relation: ProcessAssetRelation, asset: Pick<OperationalAsset, 'type'>) {
  if (assetLinkDirection(relation) === 'inputs') return '取得'
  return isTransmissionAsset(asset) ? '送付' : '格納'
}

/**
 * 情報が残る場所（保管型）か、人から人へ移る通り道（伝達型）か。
 * 紙帳票は両方を兼ねるが、転記の判定では情報が残る側として扱う。
 */
export function isTransmissionAsset(asset: Pick<OperationalAsset, 'type'>) {
  return asset.type === 'メール' || asset.type === 'チャット'
}

/**
 * 情報の取得元・格納先から、タスクとアセットの紐付けを作り直す。紐付けは手で管理せず情報から求める。
 * 情報が付いていない紐付け（業務システム欄から作ったもの、以前の版のもの、手で紐付けたもの）は、
 * 紐付けの向きのまま仮の名前の情報に変えてから求める。
 */
export function syncAssetLinksFromInformation(model: ProcessModel) {
  const previous = model.assetLinks ?? []
  convertUnspecifiedLinksToInformation(model)
  const assetIds = new Set((model.assets ?? []).map((asset) => asset.id))
  const derived = new Map<string, ProcessAssetLink>()
  for (const step of model.steps) {
    if (step.type !== 'task') continue
    for (const direction of ['inputs', 'outputs'] as const) {
      const relation = INFORMATION_ASSET_ROLE[direction].relation
      for (const ref of step[direction] ?? []) {
        for (const assetId of ref.assetIds ?? []) {
          if (!assetIds.has(assetId)) continue
          const id = `info-link-${step.id}-${assetId}-${direction}`
          const link = derived.get(id) ?? (() => {
            // 図の上でアセットを動かした位置は、同じ組の以前の紐付けから引き継ぐ。
            const before = previous.find((item) => item.id === id) ?? previous.find((item) => !item.informationIds && item.stepId === step.id && item.assetId === assetId)
            const created: ProcessAssetLink = { id, assetId, stepId: step.id, relation, informationIds: [], position: before?.position, systemLanePosition: before?.systemLanePosition }
            derived.set(id, created)
            return created
          })()
          if (!link.informationIds!.includes(ref.informationId)) link.informationIds!.push(ref.informationId)
        }
      }
    }
  }
  model.assetLinks = [...derived.values()]
}

/** 何の情報か分からない紐付けに付ける仮の名前。タスクごとに別の情報になるよう、タスク名を添える。 */
export function provisionalInformationName(asset: Pick<OperationalAsset, 'name' | 'type'>, direction: InformationDirection, step: Pick<ProcessStep, 'label'>) {
  const action = direction === 'inputs' ? 'から取得する情報' : isTransmissionAsset(asset) ? 'で送る情報' : 'へ格納する情報'
  return `${asset.name}${action}（${step.label}）`
}

/**
 * 情報が付いていない紐付けを、その向きの入力・出力の情報に変える。向きは紐付けから分かるので、
 * 参照は入力、更新は出力として扱う。同じタスクがすでにそのアセットを情報の取得元・格納先にしていれば、紐付けは不要なので捨てる。
 */
function convertUnspecifiedLinksToInformation(model: ProcessModel) {
  for (const link of model.assetLinks ?? []) {
    if (link.informationIds) continue
    const asset = (model.assets ?? []).find((item) => item.id === link.assetId)
    const step = model.steps.find((item) => item.id === link.stepId)
    if (!asset || !step || step.type !== 'task') continue
    const alreadyUsed = [...(step.inputs ?? []), ...(step.outputs ?? [])].some((ref) => ref.assetIds?.includes(asset.id))
    if (alreadyUsed) continue
    const direction = assetLinkDirection(link.relation)
    const name = provisionalInformationName(asset, direction, step)
    const isNew = !(model.information ?? []).some((item) => informationKey(item.name) === informationKey(name))
    const information = ensureInformation(model, name)
    if (!information) continue
    if (isNew) information.provisional = true
    // 紐付けに工程で扱う項目が書かれていれば、何の情報かを決める手がかりとして項目に残す。
    const items = legacyItemNames(link.dataDescription ?? '')
    if (items.length) information.items = [...new Set([...(information.items ?? []), ...items])]
    mergeAssetIntoRef(step, direction, information.id, asset.id)
  }
}

/** タスクの情報から、指定したアセットを取得元・格納先として外す。紐付けを外す操作の裏側。 */
export function detachAssetFromStepInformation(step: ProcessStep, assetId: string, direction?: InformationDirection) {
  for (const key of direction ? [direction] : (['inputs', 'outputs'] as const)) {
    for (const ref of step[key] ?? []) {
      if (!ref.assetIds?.includes(assetId)) continue
      const rest = ref.assetIds.filter((id) => id !== assetId)
      ref.assetIds = rest.length ? rest : undefined
    }
  }
}

/**
 * タスクの情報から外したアセットのうち、そのタスクでもう使っていないものは、業務システム欄から自動で紐付け直さない。
 * 外したはずのアセットが、仮の名前の情報として戻ってこないようにするため。
 */
export function suppressUnusedStepAssets(model: ProcessModel, step: ProcessStep, assetIds: string[]) {
  const used = new Set([...(step.inputs ?? []), ...(step.outputs ?? [])].flatMap((ref) => ref.assetIds ?? []))
  const keys = assetIds.filter((id) => !used.has(id)).map((id) => `${id}:${step.id}`)
  if (keys.length) model.suppressedAssetLinkKeys = [...new Set([...(model.suppressedAssetLinkKeys ?? []), ...keys])]
}

/** アセットを消すときに、全タスクの情報からも取り除く。 */
export function detachAssetFromAllInformation(model: ProcessModel, assetId: string) {
  model.steps.forEach((step) => detachAssetFromStepInformation(step, assetId))
}

function newInformationId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `info-${crypto.randomUUID()}`
    : `info-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function informationKey(name: string) {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
}

/** 読点・カンマ・改行で区切られた項目を配列にする。 */
export function splitInformationItems(text: string) {
  return [...new Set(text.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean))]
}

export function cloneInformation(information: ProcessInformation[] = []) {
  return information.map((item) => ({ ...item, items: item.items ? [...item.items] : undefined }))
}

export function cloneInformationRefs(refs: StepInformationRef[] = []) {
  return refs.map((ref) => ({ ...ref, assetIds: ref.assetIds ? [...ref.assetIds] : undefined }))
}

/** 同じ名前の情報があればそれを、なければ新しく作って返す。 */
export function ensureInformation(model: ProcessModel, name: string): ProcessInformation | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  model.information ??= []
  const existing = model.information.find((item) => informationKey(item.name) === informationKey(trimmed))
  if (existing) return existing
  const created: ProcessInformation = { id: newInformationId(), name: trimmed }
  model.information.push(created)
  return created
}

/**
 * 情報の名前を変える。同じ情報を扱う全タスクの表示が変わる。
 * 別の情報と同じ名前にすると2つの情報の区別がつかなくなるので、その場合は変えない。
 */
export function renameInformation(model: ProcessModel, informationId: string, name: string): 'renamed' | 'unchanged' | 'duplicate' {
  const information = model.information?.find((item) => item.id === informationId)
  const trimmed = name.trim()
  if (!information || !trimmed || trimmed === information.name) return 'unchanged'
  if ((model.information ?? []).some((item) => item.id !== informationId && informationKey(item.name) === informationKey(trimmed))) return 'duplicate'
  information.name = trimmed
  // 人が名前を付けたら仮ではなくなり、情報の流れの指摘の対象になる。
  delete information.provisional
  return 'renamed'
}

export function addStepInformation(model: ProcessModel, step: ProcessStep, direction: InformationDirection, name: string, assetIds: string[] = []) {
  const information = ensureInformation(model, name)
  if (!information) return undefined
  const refs = step[direction] ?? []
  if (!refs.some((ref) => ref.informationId === information.id)) {
    step[direction] = [...refs, { informationId: information.id, assetIds: assetIds.length ? [...assetIds] : undefined }]
  }
  return information
}

export function removeStepInformation(step: ProcessStep, direction: InformationDirection, informationId: string) {
  step[direction] = (step[direction] ?? []).filter((ref) => ref.informationId !== informationId)
}

/** どのタスクからも参照されなくなった情報を一覧から取り除く。 */
export function pruneUnusedInformation(model: ProcessModel) {
  const used = new Set(model.steps.flatMap((step) => [...(step.inputs ?? []), ...(step.outputs ?? [])].map((ref) => ref.informationId)))
  model.information = (model.information ?? []).filter((item) => used.has(item.id))
}

/** 以前の抽出は「・項目名［型］：説明」の形で書いていたので、項目名だけを取り出す。 */
export function legacyItemNames(text: string) {
  return splitInformationItems(text).map((item) => item.replace(/^[・\-\s]+/, '').replace(/[［[：:].*$/, '').trim()).filter(Boolean)
}

/**
 * 読み込み時や紐付けが変わったときに、アセットと情報の関係を整える。
 * 1. 書類名のアセット（Excel支払予定表など）を、情報と置き場所（Excel・紙・ファイル）に分ける。
 * 2. 情報が付いていない紐付けを、その向きの入力・出力の情報（仮の名前）に変える。
 * 3. 情報の取得元・格納先から、タスクとアセットの紐付けを作り直す。
 */
export function normalizeProcessInformation(model: ProcessModel) {
  model.information ??= []
  convertDocumentAssetsToPlaces(model)
  syncAssetLinksFromInformation(model)
}

/** アセットでやり取りされる情報。アセットの「扱う情報」をタスクの紐付けから求める。 */
export function informationOnAsset(model: ProcessModel, assetId: string) {
  const ids = new Set(model.steps.flatMap((step) => [...(step.inputs ?? []), ...(step.outputs ?? [])])
    .filter((ref) => ref.assetIds?.includes(assetId))
    .map((ref) => ref.informationId))
  return (model.information ?? []).filter((item) => ids.has(item.id))
}

export interface InformationFinding {
  kind: 'unused-output' | 'unknown-source' | 'duplicate-output' | 'transcription' | 'duplicate-storage' | 'provisional-name'
  /** 指摘の対象の情報。 */
  informationId: string
  message: string
}

/**
 * 情報の流れから、見直しの手がかりになる箇所を挙げる。
 * - 使われない出力：作ったのにどのタスクも入力していない。最後のタスクの出力は業務の成果物なので除く。
 * - 出どころ不明の入力：どのタスクも出力していない。社外や他業務から受け取る情報なら問題ない。
 * - 重複する出力：同じ情報を複数のタスクが出力している。転記や二重入力の可能性がある。
 * - 仮の名前：アセットの紐付けから作った情報。何の書類・データかが分かる名前を付けるまで、他の指摘からは外す。
 */
export function informationFindings(model: ProcessModel, step: ProcessStep): InformationFinding[] {
  const nameOf = (id: string) => (model.information ?? []).find((item) => item.id === id)?.name ?? '名称未設定の情報'
  const provisional = (id: string) => Boolean((model.information ?? []).find((item) => item.id === id)?.provisional)
  const findings: InformationFinding[] = [...step.inputs ?? [], ...step.outputs ?? []]
    .filter((ref) => provisional(ref.informationId))
    .map((ref) => ({
      kind: 'provisional-name' as const,
      informationId: ref.informationId,
      message: `「${nameOf(ref.informationId)}」は、アセットの紐付けから作った仮の名前です。何の書類・データかが分かる名前（例：請求書、支払予定）に変えてください。タスクをダブルクリックすると編集できます。`,
    }))
  const tasks = model.steps.filter((item) => item.type === 'task')
  const endIds = new Set(model.steps.filter((item) => item.type === 'end').map((item) => item.id))
  const leadsToEnd = model.connections.some((connection) => connection.from === step.id && endIds.has(connection.to))
  for (const ref of (step.outputs ?? []).filter((item) => !provisional(item.informationId))) {
    const consumers = tasks.filter((item) => item.id !== step.id && (item.inputs ?? []).some((input) => input.informationId === ref.informationId))
    if (!consumers.length && !leadsToEnd) {
      // 格納先・送付先があれば、この業務の外（他業務や社外）で使われている可能性がある。
      const targets = (ref.assetIds ?? []).map((id) => model.assets?.find((asset) => asset.id === id)?.name).filter(Boolean)
      const message = targets.length
        ? `この業務の中に「${nameOf(ref.informationId)}」を使うタスクはありません。${targets.map((name) => `「${name}」`).join('・')}の先で他業務や社外が使っていれば問題ありません。誰も使っていなければ、作るのをやめられないか確認してください。`
        : `「${nameOf(ref.informationId)}」を入力に使うタスクがありません。使われていなければ、作るのをやめられないか確認してください。`
      findings.push({ kind: 'unused-output', informationId: ref.informationId, message })
    }
    const otherProducers = tasks.filter((item) => item.id !== step.id && (item.outputs ?? []).some((output) => output.informationId === ref.informationId))
    if (otherProducers.length) {
      findings.push({ kind: 'duplicate-output', informationId: ref.informationId, message: `「${nameOf(ref.informationId)}」を${otherProducers.map((item) => `「${item.label}」`).join('・')}でも出力しています。転記や二重入力になっていないか確認してください。` })
    }
  }
  for (const ref of (step.inputs ?? []).filter((item) => !provisional(item.informationId))) {
    const producers = tasks.filter((item) => item.id !== step.id && (item.outputs ?? []).some((output) => output.informationId === ref.informationId))
    if (!producers.length) {
      findings.push({ kind: 'unknown-source', informationId: ref.informationId, message: `「${nameOf(ref.informationId)}」を出力するタスクがありません。社外や他業務から受け取る情報なら問題ありません。そうでなければ、作る工程が漏れていないか確認してください。` })
    }
  }
  findings.push(...assetFindings(model, step))
  return findings
}

/**
 * アセットの使い方から見える手がかり。
 * - 転記：あるアセットから読んだ情報を、別の保管型アセットへ人手で入れている。同じ情報か、項目が2つ以上重なる情報を対象にする。
 * - 二重管理：同じ情報が、複数の保管型アセットへ格納されている。
 * 仮の名前の情報は、何の情報か分からないので対象にしない。
 */
function assetFindings(model: ProcessModel, step: ProcessStep): InformationFinding[] {
  const assetById = new Map((model.assets ?? []).map((asset) => [asset.id, asset]))
  const informationById = new Map((model.information ?? []).map((item) => [item.id, item]))
  const storageAssets = (ref: StepInformationRef) => (ref.assetIds ?? [])
    .map((id) => assetById.get(id))
    .filter((asset): asset is OperationalAsset => Boolean(asset && !isTransmissionAsset(asset)))
  const names = (assets: OperationalAsset[]) => assets.map((asset) => `「${asset.name}」`).join('・')
  const named = (ref: StepInformationRef) => !informationById.get(ref.informationId)?.provisional
  const findings: InformationFinding[] = []

  for (const output of (step.outputs ?? []).filter(named)) {
    const targets = storageAssets(output)
    if (!targets.length) continue
    for (const input of (step.inputs ?? []).filter(named)) {
      const sources = storageAssets(input).filter((asset) => !targets.some((target) => target.id === asset.id))
      if (!sources.length) continue
      const sameInformation = input.informationId === output.informationId
      const inputItems = new Set(informationById.get(input.informationId)?.items ?? [])
      const sharedItems = (informationById.get(output.informationId)?.items ?? []).filter((item) => inputItems.has(item))
      if (!sameInformation && sharedItems.length < 2) continue
      const what = sameInformation
        ? `「${informationById.get(input.informationId)?.name}」`
        : `「${informationById.get(input.informationId)?.name}」の項目（${sharedItems.slice(0, 3).join('、')}${sharedItems.length > 3 ? 'など' : ''}）`
      findings.push({
        kind: 'transcription',
        informationId: output.informationId,
        message: `${names(sources)}から読んだ${what}を、${names(targets.filter((target) => !sources.some((source) => source.id === target.id)))}へ入れています。人手で転記していないか確認してください。システム連携や自動化の候補です。`,
      })
      break
    }
    const storedIn = new Map<string, OperationalAsset>()
    model.steps.forEach((item) => (item.outputs ?? [])
      .filter((ref) => ref.informationId === output.informationId)
      .forEach((ref) => storageAssets(ref).forEach((asset) => storedIn.set(asset.id, asset))))
    if (storedIn.size >= 2) {
      findings.push({
        kind: 'duplicate-storage',
        informationId: output.informationId,
        message: `「${informationById.get(output.informationId)?.name}」を${names([...storedIn.values()])}の複数の場所に格納しています。二重管理になっていないか、正本をどこにするか確認してください。`,
      })
    }
  }
  return findings
}

/**
 * アセットは置き場所だけを表す。書類はアセットではなく情報で、紙・Excel・ファイルという置き場所にある。
 * 種類ごとの置き場所の名前。この名前のアセットを置き場所として1つだけ持つ。
 */
export const DOCUMENT_PLACES: Partial<Record<OperationalAssetType, string>> = {
  'Excel・台帳': 'Excel',
  ファイル: 'ファイル',
  紙帳票: '紙',
}

/** 「Excel支払予定表」「紙の稟議書」「請求書PDF」のような書類名のアセットから、情報の名前を取り出す。 */
export function documentNameFromAsset(name: string) {
  const stripped = name
    .replace(/^(excel|エクセル|紙の?|pdfの?|ファイルの?)\s*/i, '')
    .replace(/\s*[（(]?(excel|xlsx?|csv|pdf|紙|ファイル)[)）]?$/i, '')
    .trim()
  return stripped || name.trim()
}

function mergeAssetIntoRef(step: ProcessStep, direction: InformationDirection, informationId: string, assetId: string) {
  const refs = step[direction] ?? []
  const existing = refs.find((ref) => ref.informationId === informationId)
  if (existing) existing.assetIds = [...new Set([...(existing.assetIds ?? []), assetId])]
  else step[direction] = [...refs, { informationId, assetIds: [assetId] }]
}

/**
 * 書類名のアセット（種類がExcel・台帳、ファイル、紙帳票で、置き場所の名前ではないもの）を、
 * 情報と置き場所に分ける。取得元・格納先に指定されていた箇所は置き場所に置き換え、
 * 情報が付いていない紐付けは、その書類を入力・出力する情報に変える。
 * 業務システム欄に書類名が書かれていても作り直さないよう、元のアセット名は抑止する。
 */
export function convertDocumentAssetsToPlaces(model: ProcessModel) {
  const documents = (model.assets ?? []).filter((asset) => {
    const place = DOCUMENT_PLACES[asset.type]
    return place && asset.name.trim() !== place
  })
  if (!documents.length) return
  for (const document of documents) {
    const placeName = DOCUMENT_PLACES[document.type]!
    let place = (model.assets ?? []).find((asset) => asset.type === document.type && asset.name.trim() === placeName)
    if (!place) {
      place = {
        id: `asset-${model.businessId}-place-${normalizedAssetKey(placeName)}`,
        name: placeName,
        type: document.type,
        purpose: `${placeName}の書類・データの置き場所`,
        owner: '未確認',
        location: '未確認',
        dataDescription: '',
        status: '未確認',
        confidence: document.confidence,
        sourceFragmentIds: [...document.sourceFragmentIds],
      }
      model.assets = [...(model.assets ?? []), place]
    }
    const placeId = place.id
    for (const step of model.steps) {
      for (const direction of ['inputs', 'outputs'] as const) {
        for (const ref of step[direction] ?? []) {
          if (ref.assetIds?.includes(document.id)) ref.assetIds = [...new Set(ref.assetIds.map((id) => (id === document.id ? placeId : id)))]
        }
      }
    }
    const unspecified = (model.assetLinks ?? []).filter((link) => link.assetId === document.id && !link.informationIds)
    if (unspecified.length) {
      const information = ensureInformation(model, documentNameFromAsset(document.name))
      if (information) {
        // 書類の項目は、工程ごとの記述と書類全体の項目候補の両方から集める。
        const items = [document.dataDescription ?? '', ...unspecified.map((link) => link.dataDescription ?? '')].flatMap(legacyItemNames)
        if (items.length) information.items = [...new Set([...(information.items ?? []), ...items])]
        for (const link of unspecified) {
          const step = model.steps.find((item) => item.id === link.stepId)
          if (step) mergeAssetIntoRef(step, link.relation === '入力' || link.relation === '参照' ? 'inputs' : 'outputs', information.id, placeId)
        }
      }
    }
    model.assets = (model.assets ?? []).filter((asset) => asset.id !== document.id)
    model.assetLinks = (model.assetLinks ?? []).filter((link) => link.assetId !== document.id)
    model.suppressedAssetKeys = [...new Set([...(model.suppressedAssetKeys ?? []), normalizedAssetKey(document.name)])]
  }
}
