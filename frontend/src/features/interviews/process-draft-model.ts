/**
 * ヒアリングの結果からAs-Isを組み立てる、Vueに依存しない変換。
 * 状態の読み書きは useInterviewWorkflow が行い、ここは入力から結果を返すだけにする。
 */
import { toLlmFragment, type LlmFragment } from '../../api/interview'
import type { LlmProcessDraftResponse } from '../../api/process'
import type {
  BusinessProcessMaster,
  InterviewDataItem,
  OperationalAsset,
  ProcessAssetLink,
  ProcessConnection,
  ProcessModel,
  ProcessStep,
  ProcessVersion,
  WorkFragment,
} from '../../models'
import { processTimestamp } from '../../utils/timestamp'
import { addStepInformation, cloneInformation, ensureInformation } from '../process/process-information'
import {
  arrangeProcessVertically,
  cloneAssetLinks,
  cloneAssets,
  cloneConnections,
  cloneProcessStep,
  ensureProcessAssets,
  inferAssetType,
  normalizeProcessLaneLayout,
  normalizedAssetKey,
  PROCESS_VERTICAL_FLOW_TOP,
  PROCESS_VERTICAL_LEVEL_GAP,
} from '../process/process-model'

function informationForContext(model: ProcessModel, refs: ProcessStep['inputs']) {
  return (refs ?? []).flatMap((ref) => {
    const information = model.information?.find((item) => item.id === ref.informationId)
    if (!information) return []
    const assets = (ref.assetIds ?? []).map((id) => model.assets?.find((asset) => asset.id === id)?.name).filter(Boolean)
    return [{ name: information.name, assets, items: information.items ?? [], provisional: Boolean(information.provisional) }]
  })
}

export function refinementContextForModel(model: ProcessModel): Record<string, unknown> {
  return {
    analysis_mode: 'refinement',
    source_process_id: model.businessId,
    name: model.title,
    summary: model.summary,
    asis_process: {
      lanes: model.lanes ?? [],
      steps: model.steps.map((step) => ({
        id: step.id,
        label: step.label,
        type: step.type,
        actor: step.actor,
        lane: step.lane ?? step.actor,
        description: step.description,
        duration: step.duration,
        system: step.system,
        monthly_volume: step.monthlyVolume,
        needs_review: step.needsReview,
        // 人が確認した情報名をAIがそのまま使えるよう、入力・出力の情報を名前で渡す。
        inputs: informationForContext(model, step.inputs),
        outputs: informationForContext(model, step.outputs),
      })),
      flows: model.connections.map((connection) => ({
        id: connection.id,
        from: connection.from,
        to: connection.to,
        label: connection.label ?? '',
      })),
      assets: model.assets ?? [],
    },
    review_items: model.reviewItems ?? [],
    assumptions: model.assumptions ?? [],
  }
}

export function processDraftFragmentPayload(fragment: WorkFragment) {
  return {
    id: fragment.id,
    ...toLlmFragment(fragment)!,
    source_quote: fragment.sourceQuote,
    source_time: fragment.sourceTime,
  }
}

export function mergeInterviewDataItems(
  existing: InterviewDataItem[] = [],
  incoming: LlmFragment['data_items'] = [],
) {
  const items = new Map(existing.map((item) => [
    `${item.name.trim().toLocaleLowerCase()}\u0000${item.sourceDocument.trim().toLocaleLowerCase()}`,
    item,
  ]))
  incoming.forEach((item) => {
    const normalized: InterviewDataItem = {
      name: item.name.trim(),
      description: item.description.trim(),
      dataType: item.data_type,
      sourceDocument: item.source_document.trim(),
      confidence: item.confidence,
    }
    if (!normalized.name) return
    const key = `${normalized.name.toLocaleLowerCase()}\u0000${normalized.sourceDocument.toLocaleLowerCase()}`
    const previous = items.get(key)
    items.set(key, previous ? { ...previous, ...normalized, confidence: Math.max(previous.confidence, normalized.confidence) } : normalized)
  })
  return [...items.values()]
}

export function processModelFromDraft(
  result: LlmProcessDraftResponse,
  business: BusinessProcessMaster,
  fragments: WorkFragment[],
  interviewId: string,
): ProcessModel {
  const fragmentMap = new Map(fragments.map((fragment) => [fragment.id, fragment]))
  const lanes = [...new Set([
    ...result.lanes.filter(Boolean),
    ...result.nodes.map((node) => node.actor).filter(Boolean),
  ])]
  const normalizedLanes = lanes.length ? lanes : ['未確認']
  const orderValues = [...new Set(result.nodes.map((node) => node.order))].sort((a, b) => a - b)
  const orderIndex = new Map(orderValues.map((order, index) => [order, index]))
  const keyToId = new Map<string, string>()
  const laneOrderTrackCounts = new Map<string, number>()
  const steps = result.nodes.map((node, index): ProcessStep => {
    const id = `draft-${business.id}-${index + 1}`
    keyToId.set(node.key, id)
    const laneIndex = Math.max(0, normalizedLanes.indexOf(node.actor))
    const trackKey = `${node.actor}\u0000${node.order}`
    const laneTrack = laneOrderTrackCounts.get(trackKey) ?? 0
    laneOrderTrackCounts.set(trackKey, laneTrack + 1)
    // 仮配置。arrangeProcessVertically が接続順とレーンから最終位置を決める。
    const centerX = 75 + (laneIndex * 2 + laneTrack) * 190
    const centerY = PROCESS_VERTICAL_FLOW_TOP + (orderIndex.get(node.order) ?? index) * PROCESS_VERTICAL_LEVEL_GAP
    const sourceFragments = node.source_fragment_ids.map((fragmentId) => fragmentMap.get(fragmentId)).filter((fragment): fragment is WorkFragment => Boolean(fragment))
    return {
      id,
      label: node.label,
      actor: node.actor,
      lane: node.actor,
      laneTrack,
      type: node.type,
      x: node.type === 'task' ? centerX - 75 : centerX,
      y: node.type === 'task' ? centerY - 20 : centerY,
      width: node.type === 'task' ? 150 : undefined,
      duration: node.duration || '未確認',
      system: node.system || '未確認',
      monthlyVolume: node.monthly_volume || '未確認',
      description: node.description,
      risk: node.needs_review ? 'medium' : sourceFragments.some((fragment) => fragment.personalization === '高') ? 'high' : undefined,
      confidence: node.confidence,
      sourceFragmentIds: [...node.source_fragment_ids],
      sourceQuotes: sourceFragments.map((fragment) => `${fragment.sourceTime}｜「${fragment.sourceQuote}」`),
      needsReview: node.needs_review,
      evidence: [],
    }
  })
  const connections = result.flows.flatMap((flow, index): ProcessConnection[] => {
    const from = keyToId.get(flow.from_key)
    const to = keyToId.get(flow.to_key)
    return from && to ? [{ id: `draft-flow-${business.id}-${index + 1}`, from, to, label: flow.label || undefined }] : []
  })
  const assetKeyToId = new Map<string, string>()
  const assetNameToAsset = new Map<string, OperationalAsset>()
  const assets: OperationalAsset[] = []
  ;(result.assets ?? []).forEach((sourceAsset, index) => {
    const normalizedName = normalizedAssetKey(sourceAsset.name)
    let asset = assetNameToAsset.get(normalizedName)
    if (!asset) {
      asset = {
        id: `draft-asset-${business.id}-${index + 1}`,
        name: sourceAsset.name,
        type: sourceAsset.type || inferAssetType(sourceAsset.name),
        purpose: sourceAsset.purpose,
        owner: sourceAsset.owner || '未確認',
        location: sourceAsset.location || '未確認',
        dataDescription: sourceAsset.data_description,
        status: sourceAsset.needs_review ? '未確認' : '確認済み',
        confidence: sourceAsset.confidence,
        sourceFragmentIds: [...sourceAsset.source_fragment_ids],
        aliases: [],
      }
      assets.push(asset)
      assetNameToAsset.set(normalizedName, asset)
    } else {
      asset.aliases = [...new Set([...(asset.aliases ?? []), sourceAsset.name].filter((name) => name !== asset!.name))]
      asset.sourceFragmentIds = [...new Set([...asset.sourceFragmentIds, ...sourceAsset.source_fragment_ids])]
    }
    assetKeyToId.set(sourceAsset.key, asset.id)
  })
  const assetLinks = (result.asset_links ?? []).flatMap((sourceLink, index): ProcessAssetLink[] => {
    const assetId = assetKeyToId.get(sourceLink.asset_key)
    const stepId = keyToId.get(sourceLink.node_key)
    return assetId && stepId ? [{
      id: `draft-asset-link-${business.id}-${index + 1}`,
      assetId,
      stepId,
      relation: sourceLink.relation,
      dataDescription: sourceLink.data_description,
    }] : []
  })
  const model: ProcessModel = {
    businessId: business.id,
    departmentId: fragments[0]?.departmentId ?? business.departmentId,
    title: result.title,
    steps,
    connections,
    information: [],
    updatedAt: processTimestamp(),
    reviewStatus: '編集中',
    sourceType: 'interview',
    sourceInterviewId: interviewId,
    layoutDirection: 'vertical',
    lanes: normalizedLanes,
    summary: result.summary,
    assumptions: [...result.assumptions],
    reviewItems: [...result.review_items],
    assets,
    assetLinks,
  }
  // AIが工程ごとに出した入力・出力の情報を、同じ名前は同じ情報として登録する。
  result.nodes.forEach((node) => {
    const step = steps.find((item) => item.id === keyToId.get(node.key))
    if (!step || step.type !== 'task') return
    for (const [direction, entries] of [['inputs', node.inputs ?? []], ['outputs', node.outputs ?? []]] as const) {
      for (const entry of entries) {
        const assetIds = [...new Set(entry.asset_keys.map((key) => assetKeyToId.get(key)).filter((id): id is string => Boolean(id)))]
        const information = addStepInformation(model, step, direction, entry.name, assetIds)
        if (!information) continue
        const ref = step[direction]?.find((item) => item.informationId === information.id)
        if (ref) ref.assetIds = [...new Set([...(ref.assetIds ?? []), ...assetIds])].filter(Boolean)
        if (ref && !ref.assetIds?.length) ref.assetIds = undefined
        if (entry.items.length) information.items = [...new Set([...(information.items ?? []), ...entry.items])]
      }
    }
  })
  ensureProcessAssets(model)
  arrangeProcessVertically(model)
  normalizeProcessLaneLayout(model)
  return model
}

export function mergeProcessDraftWithExisting(existing: ProcessModel, generated: ProcessModel): ProcessModel {
  const generatedToExistingStepId = new Map<string, string>()
  const usedExistingStepIds = new Set<string>()
  const matchedGeneratedStepIds = new Set<string>()
  const normalizedText = (value?: string) => (value ?? '').trim().toLocaleLowerCase()
  const generatedFragmentIds = (step: ProcessStep) => new Set(step.sourceFragmentIds ?? [])

  const matchedStepFor = (generatedStep: ProcessStep) => {
    const fragmentIds = generatedFragmentIds(generatedStep)
    return existing.steps.find((existingStep) => {
      if (usedExistingStepIds.has(existingStep.id) || existingStep.type !== generatedStep.type) return false
      if (normalizedText(existingStep.label) === normalizedText(generatedStep.label)) return true
      return (existingStep.sourceFragmentIds ?? []).some((fragmentId) => fragmentIds.has(fragmentId))
    })
  }

  const steps = existing.steps.map(cloneProcessStep)
  generated.steps.forEach((generatedStep) => {
    const existingStep = matchedStepFor(generatedStep)
    if (!existingStep) return
    usedExistingStepIds.add(existingStep.id)
    matchedGeneratedStepIds.add(generatedStep.id)
    generatedToExistingStepId.set(generatedStep.id, existingStep.id)
    const target = steps.find((step) => step.id === existingStep.id)!
    target.sourceFragmentIds = [...new Set([...(target.sourceFragmentIds ?? []), ...(generatedStep.sourceFragmentIds ?? [])])]
    target.sourceQuotes = [...new Set([...(target.sourceQuotes ?? []), ...(generatedStep.sourceQuotes ?? [])])]
    target.evidence = [...new Set([...(target.evidence ?? []), ...(generatedStep.evidence ?? [])])]
    target.confidence = Math.max(target.confidence ?? 0, generatedStep.confidence ?? 0)
    target.needsReview = Boolean(target.needsReview || generatedStep.needsReview)
  })
  const addedSteps = generated.steps.filter((step) => !matchedGeneratedStepIds.has(step.id)).map(cloneProcessStep)
  steps.push(...addedSteps)

  const remapStepId = (id: string) => generatedToExistingStepId.get(id) ?? id
  const connections = cloneConnections(existing.connections)
  const connectionKeys = new Set(connections.map((connection) => `${connection.from}\u0000${connection.to}`))
  generated.connections.forEach((connection) => {
    const remapped = { ...connection, from: remapStepId(connection.from), to: remapStepId(connection.to) }
    const key = `${remapped.from}\u0000${remapped.to}`
    if (!connectionKeys.has(key) && steps.some((step) => step.id === remapped.from) && steps.some((step) => step.id === remapped.to)) {
      connections.push(remapped)
      connectionKeys.add(key)
    }
  })

  const assets: OperationalAsset[] = cloneAssets(existing.assets)
  const generatedToExistingAssetId = new Map<string, string>()
  ;(generated.assets ?? []).forEach((generatedAsset) => {
    const fragmentIds = new Set(generatedAsset.sourceFragmentIds)
    const existingAsset = assets.find((asset) => (
      normalizedAssetKey(asset.name) === normalizedAssetKey(generatedAsset.name)
      || asset.sourceFragmentIds.some((fragmentId) => fragmentIds.has(fragmentId))
    ))
    if (!existingAsset) {
      assets.push(structuredClone(generatedAsset))
      return
    }
    generatedToExistingAssetId.set(generatedAsset.id, existingAsset.id)
    existingAsset.sourceFragmentIds = [...new Set([...existingAsset.sourceFragmentIds, ...generatedAsset.sourceFragmentIds])]
    existingAsset.aliases = [...new Set([...(existingAsset.aliases ?? []), ...(generatedAsset.aliases ?? [])])]
    existingAsset.confidence = Math.max(existingAsset.confidence, generatedAsset.confidence)
  })

  const assetLinks: ProcessAssetLink[] = cloneAssetLinks(existing.assetLinks)
  const assetLinkKeys = new Set(assetLinks.map((link) => `${link.assetId}\u0000${link.stepId}\u0000${link.relation}`))
  ;(generated.assetLinks ?? []).forEach((link) => {
    const remapped = {
      ...link,
      assetId: generatedToExistingAssetId.get(link.assetId) ?? link.assetId,
      stepId: remapStepId(link.stepId),
    }
    const key = `${remapped.assetId}\u0000${remapped.stepId}\u0000${remapped.relation}`
    if (!assetLinkKeys.has(key)) {
      assetLinks.push(remapped)
      assetLinkKeys.add(key)
    }
  })

  // 情報は名前でまとめる。既存の情報名を正として、AIが出した同名の情報は既存の情報に寄せる。
  const informationHolder = { information: cloneInformation(existing.information ?? []) } as ProcessModel
  const generatedToMergedInformationId = new Map<string, string>()
  ;(generated.information ?? []).forEach((item) => {
    const target = ensureInformation(informationHolder, item.name)
    if (!target) return
    if (item.items?.length) target.items = [...new Set([...(target.items ?? []), ...item.items])]
    generatedToMergedInformationId.set(item.id, target.id)
  })
  const remapRefs = (refs: ProcessStep['inputs']) => (refs ?? []).flatMap((ref) => {
    const informationId = generatedToMergedInformationId.get(ref.informationId)
    if (!informationId) return []
    const assetIds = ref.assetIds?.map((id) => generatedToExistingAssetId.get(id) ?? id)
    return [{ informationId, assetIds: assetIds?.length ? [...new Set(assetIds)] : undefined }]
  })
  addedSteps.forEach((step) => {
    step.inputs = remapRefs(step.inputs)
    step.outputs = remapRefs(step.outputs)
  })
  // 既存の工程に対応した生成工程の情報は、既存の工程にまだ無いものだけ足す。
  generated.steps.forEach((generatedStep) => {
    const target = steps.find((step) => step.id === generatedToExistingStepId.get(generatedStep.id))
    if (!target) return
    for (const direction of ['inputs', 'outputs'] as const) {
      for (const ref of remapRefs(generatedStep[direction])) {
        const existingRef = target[direction]?.find((item) => item.informationId === ref.informationId)
        if (existingRef) {
          const assetIds = [...new Set([...(existingRef.assetIds ?? []), ...(ref.assetIds ?? [])])]
          existingRef.assetIds = assetIds.length ? assetIds : undefined
        } else {
          target[direction] = [...(target[direction] ?? []), ref]
        }
      }
    }
  })

  return {
    ...generated,
    departmentId: existing.departmentId,
    title: existing.title,
    summary: existing.summary,
    steps,
    connections,
    reviewStatus: existing.reviewStatus,
    reviewer: existing.reviewer,
    reviewNote: existing.reviewNote,
    layoutDirection: existing.layoutDirection,
    lanes: [...new Set([...(existing.lanes ?? []), ...(generated.lanes ?? [])])],
    laneHeights: { ...(generated.laneHeights ?? {}), ...(existing.laneHeights ?? {}) },
    laneWidths: { ...(generated.laneWidths ?? {}), ...(existing.laneWidths ?? {}) },
    layoutPositionsCustomized: existing.layoutPositionsCustomized,
    assumptions: [...new Set([...(existing.assumptions ?? []), ...(generated.assumptions ?? [])])],
    reviewItems: [...new Set([...(existing.reviewItems ?? []), ...(generated.reviewItems ?? [])])],
    assets,
    assetLinks,
    information: informationHolder.information,
    suppressedAssetKeys: [...(existing.suppressedAssetKeys ?? [])],
    suppressedAssetLinkKeys: [...(existing.suppressedAssetLinkKeys ?? [])],
  }
}

/** 生成前のAs-Isを、版として退避するための記録を作る。 */
export function versionBeforeGeneration(model: ProcessModel): ProcessVersion {
  return {
    id: `version-${Date.now()}`,
    businessId: model.businessId,
    savedAt: processTimestamp(),
    label: 'ヒアリング再生成前',
    steps: model.steps.map(cloneProcessStep),
    connections: cloneConnections(model.connections),
    layoutDirection: 'vertical',
    lanes: [...(model.lanes ?? [])],
    laneHeights: { ...(model.laneHeights ?? {}) },
    laneWidths: { ...(model.laneWidths ?? {}) },
    assets: cloneAssets(model.assets),
    assetLinks: cloneAssetLinks(model.assetLinks),
    information: cloneInformation(model.information),
    suppressedAssetKeys: [...(model.suppressedAssetKeys ?? [])],
    suppressedAssetLinkKeys: [...(model.suppressedAssetLinkKeys ?? [])],
  }
}

const DRAFT_TITLE_SUFFIX = /\s*(As-Is|業務ドラフト|ドラフト)$/i

/** ヒアリングの結果から、新しい業務マスターを作る。 */
export function businessFromInterviewDraft(
  result: LlmProcessDraftResponse,
  fragments: WorkFragment[],
  options: { id: string; code: number; departmentId: string },
): BusinessProcessMaster {
  return {
    id: options.id,
    code: `INT-${String(options.code).padStart(3, '0')}`,
    name: result.title.replace(DRAFT_TITLE_SUFFIX, '') || 'ヒアリング業務',
    departmentId: options.departmentId,
    category: 'ヒアリングから生成',
    description: result.summary,
    startCondition: result.start_condition,
    endCondition: result.end_condition,
    sapScope: fragments.some((fragment) => fragment.tools.includes('SAP')) ? '拡張' : '周辺',
    sapModule: [...new Set(fragments.flatMap((fragment) => fragment.tools).filter((tool) => /SAP/i.test(tool)))].join(' / ') || '未判定',
    ownerRole: fragments.find((fragment) => fragment.actor && fragment.actor !== '未確認')?.actor ?? '未確認',
    status: '作成中',
    updatedAt: 'ヒアリングから生成',
    // 生成した業務マスターは、後で作るAs-Isプロセスが裏付けになる。
    // 確認観点は業務マスター側で育てるため、生成時は空で作る。
    interviewTopics: [],
    maturity: '確認中',
    sourceFragmentIds: fragments.map((fragment) => fragment.id),
  }
}

/** 既存の業務マスターへ、ヒアリングの結果を反映する。 */
export function applyInterviewDraftToBusiness(
  business: BusinessProcessMaster,
  result: LlmProcessDraftResponse,
  fragments: WorkFragment[],
) {
  business.description = result.summary || business.description
  business.startCondition = result.start_condition || business.startCondition
  business.endCondition = result.end_condition || business.endCondition
  business.updatedAt = 'ヒアリングから更新'
  business.sourceFragmentIds = [...new Set([...(business.sourceFragmentIds ?? []), ...fragments.map((fragment) => fragment.id)])]
}

/** 業務マスターが無いAs-Isプロセスから、対応する業務マスターを作る。 */
export function businessFromProcessModel(
  model: ProcessModel,
  fragments: WorkFragment[],
  code: number,
): BusinessProcessMaster {
  const startStep = model.steps.find((step) => step.type === 'start')
  const endStep = model.steps.find((step) => step.type === 'end')
  return {
    id: model.businessId,
    code: `INT-${String(code).padStart(3, '0')}`,
    name: model.title.replace(DRAFT_TITLE_SUFFIX, '') || 'ヒアリング業務',
    departmentId: model.departmentId,
    category: 'ヒアリングから生成',
    description: model.summary ?? '',
    startCondition: startStep?.label ?? '未確認',
    endCondition: endStep?.label ?? '未確認',
    sapScope: fragments.some((fragment) => fragment.tools.some((tool) => /SAP/i.test(tool))) ? '拡張' : '周辺',
    sapModule: [...new Set(fragments.flatMap((fragment) => fragment.tools).filter((tool) => /SAP/i.test(tool)))].join(' / ') || '未判定',
    ownerRole: model.steps.find((step) => step.type === 'task')?.actor ?? '未確認',
    status: '作成中',
    updatedAt: model.updatedAt,
    interviewTopics: [],
    maturity: '確認中',
    sourceFragmentIds: [...new Set([
      ...model.steps.flatMap((step) => step.sourceFragmentIds ?? []),
      ...(model.assets ?? []).flatMap((asset) => asset.sourceFragmentIds),
    ])],
    asIsModelId: model.businessId,
    asIsUpdatedAt: model.updatedAt,
    asIsSourceInterviewId: model.sourceInterviewId,
  }
}

/** 既存のAs-Isを材料として、AIへ渡す業務の文脈を組み立てる。 */
export function draftBusinessContext(business: BusinessProcessMaster, existingModel: ProcessModel | undefined) {
  return {
    analysis_mode: existingModel ? 'refinement' : 'draft',
    id: business.id,
    name: business.name,
    description: business.description,
    startCondition: business.startCondition,
    endCondition: business.endCondition,
    ownerRole: business.ownerRole,
    existing_asis: existingModel ? {
      title: existingModel.title,
      summary: existingModel.summary,
      lanes: existingModel.lanes ?? [],
      steps: existingModel.steps.map((step) => ({
        id: step.id,
        label: step.label,
        type: step.type,
        actor: step.actor,
        lane: step.lane ?? step.actor,
        description: step.description,
        source_fragment_ids: step.sourceFragmentIds ?? [],
      })),
      flows: existingModel.connections.map((connection) => ({
        from: connection.from,
        to: connection.to,
        label: connection.label ?? '',
      })),
      assets: (existingModel.assets ?? []).map((asset) => ({
        name: asset.name,
        type: asset.type,
        purpose: asset.purpose,
        source_fragment_ids: asset.sourceFragmentIds,
      })),
      assumptions: existingModel.assumptions ?? [],
      review_items: existingModel.reviewItems ?? [],
    } : undefined,
  }
}
