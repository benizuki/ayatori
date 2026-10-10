import { CATEGORY_REVIEW, type EcrsPrinciple } from './process-improvement'
import { classifyTaskName } from '../master/task-categories'
import type { BusinessTask } from '../../models'
import type { ProcessAiOpportunityResponse } from '../../api/process'
import type { OperationalAsset, ProcessAssetRelation, ProcessModel, ProcessStep } from '../../models'
import { isSystemAsset, normalizedAssetKey, processStepLane } from './process-model'

export type AiCapability = '読む・抽出' | '検索・要約' | '照合・構造化' | '判断支援' | '文面生成' | 'システム操作' | '監視・催促'
export type AiProposalKind = 'agent' | 'assist' | 'automation' | 'process-change' | 'human' | 'needs-info'
export type AiProposalPriority = 'high' | 'medium' | 'low'
export type AiEvidenceLevel = '高' | '中' | '低'

export interface AiProposalData {
  id: string
  assetId: string
  name: string
  type: OperationalAsset['type']
  relation: ProcessAssetRelation
  inferred?: boolean
}

export interface AiProposal {
  ecrs: EcrsPrinciple[]
  before: string
  after: string
  improvementActions: string[]
  id: string
  kind: AiProposalKind
  kindLabel: string
  priority: AiProposalPriority
  priorityLabel: string
  title: string
  summary: string
  actor: string
  stepIds: string[]
  stepLabels: string[]
  inputData: AiProposalData[]
  outputData: AiProposalData[]
  systemNames: string[]
  capabilities: AiCapability[]
  aiActions: string[]
  reasons: string[]
  expectedBenefits: string[]
  humanRole: string
  requirements: string[]
  risks: string[]
  missingInformation: string[]
  evidenceLevel: AiEvidenceLevel
}

export interface ProcessAiProposalSet {
  proposals: AiProposal[]
  recommendedCount: number
  agentCandidateCount: number
  assistCandidateCount: number
  automationCandidateCount: number
  needsInfoCount: number
  /** rule = 画面内のルール判定、llm = Geminiが工程をまとめ直した結果。 */
  source: 'rule' | 'llm'
  generatedAt?: string
  /** LLMがどの提案にも入れなかった工程。取りこぼしを隠さずに示す。 */
  uncoveredStepLabels?: string[]
}

/** As-Isから、LLMへ渡す事実だけを取り出す。判断材料は工程・データ・システムに限る。 */
export interface ProcessAiEvidence {
  title: string
  department: string
  steps: Array<{
    id: string
    label: string
    actor: string
    description: string
    duration: string
    monthly_volume: string
    risk: string
    branch_labels: string[]
    leads_to_gateway: boolean
    category: BusinessTask['category']
    category_source: 'map' | 'ai' | 'inferred'
  }>
  connections: Array<{ from_id: string; to_id: string; label: string }>
  data_items: Array<{ step_id: string; name: string; type: string; relation: string }>
  systems: Array<{ step_id: string; name: string }>
}

const unstructuredTypes = new Set<OperationalAsset['type']>(['ファイル', 'メール', 'チャット', '紙帳票'])
const structuredTypes = new Set<OperationalAsset['type']>(['Excel・台帳'])

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function orderedProcessSteps(model: ProcessModel) {
  const stepById = new Map(model.steps.map((step) => [step.id, step]))
  const sourceOrder = new Map(model.steps.map((step, index) => [step.id, index]))
  const outgoing = new Map<string, string[]>()
  const indegree = new Map(model.steps.map((step) => [step.id, 0]))
  model.connections.forEach((connection) => {
    if (!stepById.has(connection.from) || !stepById.has(connection.to)) return
    outgoing.set(connection.from, [...(outgoing.get(connection.from) ?? []), connection.to])
    indegree.set(connection.to, (indegree.get(connection.to) ?? 0) + 1)
  })

  const queue = model.steps
    .filter((step) => (indegree.get(step.id) ?? 0) === 0)
    .sort((left, right) => (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0))
  const result: ProcessStep[] = []
  const visited = new Set<string>()
  while (queue.length) {
    const step = queue.shift()!
    if (visited.has(step.id)) continue
    visited.add(step.id)
    result.push(step)
    ;(outgoing.get(step.id) ?? []).forEach((targetId) => {
      indegree.set(targetId, (indegree.get(targetId) ?? 1) - 1)
      if (indegree.get(targetId) === 0) {
        const target = stepById.get(targetId)
        if (target) queue.push(target)
      }
    })
    queue.sort((left, right) => (sourceOrder.get(left.id) ?? 0) - (sourceOrder.get(right.id) ?? 0))
  }
  model.steps.forEach((step) => {
    if (!visited.has(step.id)) result.push(step)
  })
  return result
}

function workGroups(model: ProcessModel) {
  const systemActorKeys = new Set((model.assets ?? []).filter(isSystemAsset).map((asset) => normalizedAssetKey(asset.name)))
  const tasks = orderedProcessSteps(model).filter((step) => step.type === 'task')
  const actorForStep = (step: ProcessStep) => {
    const actor = processStepLane(step) || '担当未確認'
    return systemActorKeys.has(normalizedAssetKey(actor)) ? '自動処理' : actor
  }
  const actors = unique(tasks.map(actorForStep))
  const orderById = new Map(tasks.map((step, index) => [step.id, index]))

  return actors.flatMap((actor) => {
    const actorSteps = tasks.filter((step) => actorForStep(step) === actor)
    const groups: ProcessStep[][] = []
    for (let index = 0; index < actorSteps.length; index += 1) groups.push(actorSteps.slice(index, index + 1))
    return groups.map((steps, index) => ({
      id: `ai-proposal-${normalizedAssetKey(actor) || 'unknown'}-${index + 1}`,
      actor,
      steps,
      order: Math.min(...steps.map((step) => orderById.get(step.id) ?? Number.MAX_SAFE_INTEGER)),
    }))
  }).sort((left, right) => left.order - right.order)
}

function hasUnknown(value?: string) {
  return !value || /未確認|不明|未設定/.test(value)
}

function isToolAsset(asset: OperationalAsset) {
  return isSystemAsset(asset) || /webブラウザ|ブラウザ|browser/i.test(asset.name)
}

function inferredDataFromText(text: string): AiProposalData[] {
  const items: AiProposalData[] = []
  const add = (name: string, relation: ProcessAssetRelation) => {
    const assetId = `inferred-${normalizedAssetKey(name)}`
    if (!items.some((item) => item.assetId === assetId && item.relation === relation)) {
      items.push({ id: `${assetId}-${relation}`, assetId, name: `${name}（推定）`, type: 'その他', relation, inferred: true })
    }
  }
  if (/申請/.test(text)) add('申請内容', '入力')
  if (/依頼|問い合わせ/.test(text)) add('依頼・問い合わせ内容', '入力')
  if (/MACアドレス/i.test(text)) add('MACアドレス', '参照')
  if (/端末情報/.test(text)) add('端末情報', '参照')
  if (/登録|更新|訂正|反映/.test(text)) {
    add(/MACアドレス/i.test(text) ? 'MACアドレス登録情報' : /端末情報/.test(text) ? '端末登録情報' : '登録・更新情報', '更新')
  }
  if (/通知|連絡|回答|返信|メール.*送信|送信.*メール/.test(text)) add('通知・回答内容', '出力')
  return items
}

function priorityFor(kind: AiProposalKind, dataCount: number, stepCount: number, hasRisk: boolean): AiProposalPriority {
  if (kind === 'needs-info' || kind === 'human') return 'low'
  const score = (kind === 'agent' ? 3 : 2) + (dataCount ? 1 : 0) + (stepCount > 1 ? 1 : 0) - (hasRisk ? 1 : 0)
  return score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low'
}

function expectedBenefits(capabilities: AiCapability[]) {
  const benefits: string[] = []
  if (capabilities.includes('読む・抽出') || capabilities.includes('検索・要約')) benefits.push('文書・メールの読取時間を削減')
  if (capabilities.includes('照合・構造化')) benefits.push('転記・照合作業と入力ミスを削減')
  if (capabilities.includes('判断支援')) benefits.push('判断根拠を提示し、確認品質を平準化')
  if (capabilities.includes('文面生成')) benefits.push('通知・回答文の作成時間を削減')
  if (capabilities.includes('システム操作')) benefits.push('複数画面への手入力と操作待ちを削減')
  if (capabilities.includes('監視・催促')) benefits.push('確認漏れ・催促漏れ・滞留を削減')
  return benefits.length ? benefits : ['効果を判断するため、作業時間と件数を追加確認']
}

function aiActionsFor(options: {
  kind: AiProposalKind
  capabilities: AiCapability[]
  inputData: AiProposalData[]
  outputData: AiProposalData[]
  systemNames: string[]
  stepLabels: string[]
}) {
  const { kind, capabilities, inputData, outputData, systemNames, stepLabels } = options
  const inputNames = unique(inputData.map((item) => item.name))
  const outputNames = unique(outputData.map((item) => item.name))
  const inputs = inputNames.length ? inputNames.join('・') : '申請・依頼内容'
  const outputs = outputNames.length ? outputNames.join('・') : '処理結果'
  const systems = systemNames.length ? systemNames.join('・') : '対象システム'
  const actions: string[] = []

  if (kind === 'needs-info') return [
    '入力データ、出力データ、判断基準、処理件数を追加ヒアリングする',
    '実データ例を確認した後に、AIへ任せる範囲を再判定する',
  ]
  if (kind === 'human') return [
    '現時点ではAIに実行させず、人が行う判断と責任範囲を明確にする',
    '定型部分や参照データが判明した段階で、AI支援の可否を再評価する',
  ]
  if (kind === 'automation') return [
    `${stepLabels.join(' → ')}を、確定した業務ルールに沿って自動実行する`,
    `${systems}への入力結果を検証し、失敗時は処理を停止して担当者へ通知する`,
  ]

  if (capabilities.includes('読む・抽出')) actions.push(`${inputs}を読み取り、登録・判断に必要な項目を抽出して構造化する`)
  if (capabilities.includes('検索・要約')) actions.push(`${inputs}と関連資料を検索し、担当者が確認すべき要点と根拠をまとめる`)
  if (capabilities.includes('照合・構造化')) actions.push(`${inputs}を既存台帳・マスタと照合し、表記揺れ、重複、不足項目を検出する`)
  if (capabilities.includes('判断支援')) actions.push('業務ルールに照らして処理可否を判定し、判断理由と参照根拠を提示する')
  if (capabilities.includes('システム操作')) actions.push(`${systems}で「${stepLabels.join(' → ')}」を実行し、登録結果を読み戻して検証する`)
  if (capabilities.includes('文面生成')) actions.push(`${outputs}をもとに通知・回答文を作成し、送信前の確認内容を担当者へ提示する`)
  if (capabilities.includes('監視・催促')) actions.push('処理状態と期限を監視し、滞留時は自動催促、例外時は担当者へエスカレーションする')

  return unique(actions).slice(0, 5)
}

/** Builds prioritized, explainable recommendations from the current As-Is evidence. */
export function buildProcessAiProposals(model: ProcessModel, tasks: BusinessTask[] = []): ProcessAiProposalSet {
  const assetById = new Map((model.assets ?? []).map((asset) => [asset.id, asset]))
  const proposals = workGroups(model).map((group): AiProposal => {
    const stepIds = group.steps.map((step) => step.id)
    const stepIdSet = new Set(stepIds)
    const links = (model.assetLinks ?? []).filter((link) => stepIdSet.has(link.stepId))
    const linkedData = links.flatMap((link) => {
      const asset = assetById.get(link.assetId)
      if (!asset || isToolAsset(asset)) return []
      return [{ id: `${asset.id}-${link.relation}`, assetId: asset.id, name: asset.name, type: asset.type, relation: link.relation }]
    }).filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index)
    const text = group.steps.map((step) => `${step.label} ${step.description ?? ''}`).join(' ')
    const data = linkedData.length ? linkedData : inferredDataFromText(text)
    const inputData = data.filter((item) => item.relation === '入力' || item.relation === '参照')
    const outputData = data.filter((item) => item.relation === '更新' || item.relation === '出力')
    const systemNames = unique(links.flatMap((link) => {
      const asset = assetById.get(link.assetId)
      return asset && isToolAsset(asset) ? [asset.name] : []
    }))
    const connections = model.connections.filter((connection) => stepIdSet.has(connection.from) || stepIdSet.has(connection.to))
    const touchesGateway = connections.some((connection) => {
      const otherId = stepIdSet.has(connection.from) ? connection.to : connection.from
      return model.steps.find((step) => step.id === otherId)?.type === 'gateway'
    })
    const hasDecision = touchesGateway || connections.some((connection) => Boolean(connection.label))
    const hasRisk = group.steps.some((step) => step.risk === 'high')
    const capabilities: AiCapability[] = []
    if (inputData.some((item) => unstructuredTypes.has(item.type))) capabilities.push('読む・抽出')
    if (inputData.some((item) => item.type === 'ファイル' || item.type === 'チャット')) capabilities.push('検索・要約')
    if (data.some((item) => structuredTypes.has(item.type))) capabilities.push('照合・構造化')
    if (hasDecision) capabilities.push('判断支援')
    if (outputData.some((item) => unstructuredTypes.has(item.type)) || /通知|連絡|回答|返信|メール|文書|報告/.test(text)) capabilities.push('文面生成')
    if (systemNames.length && /登録|更新|入力|送信|取得|照会|検索|確認|反映|処理/.test(text)) capabilities.push('システム操作')
    if (/監視|催促|督促|待ち|追跡|フォロー|問い合わせ|確認依頼/.test(text)) capabilities.push('監視・催促')
    const uniqueCapabilities = unique(capabilities)
    const missingInformation = unique([
      ...(!linkedData.length ? ['工程で扱うシステム以外の入力・出力データ（現在の表示は工程名からの推定）'] : []),
      ...(group.steps.some((step) => hasUnknown(step.duration)) ? ['標準作業時間・待ち時間'] : []),
      ...(group.steps.some((step) => hasUnknown(step.monthlyVolume)) ? ['月間件数・繁忙期の処理量'] : []),
      ...(hasDecision && group.steps.every((step) => !step.description) ? ['判断基準・例外条件'] : []),
    ])
    const requiresGenerativeReasoning = inputData.some((item) => unstructuredTypes.has(item.type))
      || hasDecision
      || uniqueCapabilities.includes('文面生成')
      || uniqueCapabilities.includes('検索・要約')
      || uniqueCapabilities.includes('監視・催促')
    const automationCandidate = uniqueCapabilities.includes('システム操作')
      && !requiresGenerativeReasoning
    const agentCandidate = uniqueCapabilities.includes('システム操作')
      && !automationCandidate
      && (uniqueCapabilities.length >= 2 || group.steps.length >= 2)
    const insufficient = !linkedData.length && !systemNames.length && uniqueCapabilities.length === 0
    const kind: AiProposalKind = insufficient
      ? 'needs-info'
      : automationCandidate ? 'automation'
        : agentCandidate ? 'agent'
          : uniqueCapabilities.length ? 'assist' : 'human'
    const reasons = unique([
      ...(inputData.some((item) => unstructuredTypes.has(item.type)) ? ['メール・文書などの非構造データを読み取る工程'] : []),
      ...(hasDecision ? ['分岐・判断を含み、根拠提示による支援余地がある'] : []),
      ...(systemNames.length > 1 ? ['複数システムをまたぐ操作がある'] : []),
      ...(group.steps.length > 1 ? [`同じ担当による${group.steps.length}工程をまとめられる`] : []),
      ...(uniqueCapabilities.includes('システム操作') ? ['登録・更新などの定型システム操作がある'] : []),
      ...(!uniqueCapabilities.length ? ['現時点の情報ではAIが担う具体的能力を特定できない'] : []),
    ])
    const requirements = unique([
      ...(inputData.some((item) => unstructuredTypes.has(item.type)) ? ['過去の入力例、帳票・メール形式、正解データを準備'] : []),
      ...(uniqueCapabilities.includes('システム操作') ? ['APIまたは安全な画面操作手段、実行権限、操作ログを整備'] : []),
      ...(hasDecision ? ['判断基準と例外時のエスカレーション条件を明文化'] : []),
      ...(kind === 'agent' ? ['停止手段、再実行方針、監査ログ、段階的な権限付与を設計'] : []),
      ...missingInformation.map((item) => `${item}を追加確認`),
    ])
    const risks = unique([
      ...(inputData.some((item) => unstructuredTypes.has(item.type)) ? ['機密情報・個人情報の入力範囲と保存先を制御'] : []),
      ...(uniqueCapabilities.includes('システム操作') ? ['誤登録・重複実行を防ぐ検証とロールバックが必要'] : []),
      ...(hasDecision ? ['AIの誤判断を前提に、人の確認・説明可能性を確保'] : []),
      ...(hasRisk ? ['高リスク工程のため、自律実行範囲を限定'] : []),
    ])
    const evidencePoints = linkedData.length + systemNames.length + group.steps.filter((step) => step.description || step.sourceQuotes?.length).length
    const evidenceLevel: AiEvidenceLevel = evidencePoints >= 4 ? '高' : evidencePoints >= 2 ? '中' : '低'
    const priority = priorityFor(kind, data.length, group.steps.length, hasRisk)
    const labels = group.steps.map((step) => step.label)
    const aiActions = aiActionsFor({
      kind,
      capabilities: uniqueCapabilities,
      inputData,
      outputData,
      systemNames,
      stepLabels: labels,
    })

    const category = tasks.find((task) => task.sourceStepId === stepIds[0])?.category ?? classifyTaskName(labels[0] ?? '')
    const review = CATEGORY_REVIEW[category]
    return {
      ecrs: [review.principle],
      before: group.steps.map((step) => `${step.label}${step.description ? `：${step.description}` : ''}`).join(' / '),
      after: `条件を確認して検討：${review.change}`,
      improvementActions: [review.question, review.change],
      id: group.id,
      kind,
      kindLabel: kind === 'agent' ? 'AI Agent'
        : kind === 'assist' ? 'AI支援'
          : kind === 'automation' ? '通常自動化'
            : kind === 'needs-info' ? '追加調査' : '人中心',
      priority,
      priorityLabel: priority === 'high' ? '優先度 高' : priority === 'medium' ? '優先度 中' : '優先度 低',
      title: `${labels[0] ?? '対象工程'}の業務見直し`,
      summary: review.question,
      actor: group.actor,
      stepIds,
      stepLabels: labels,
      inputData,
      outputData,
      systemNames,
      capabilities: uniqueCapabilities,
      aiActions,
      reasons,
      expectedBenefits: expectedBenefits(uniqueCapabilities),
      humanRole: kind === 'agent'
        ? hasDecision || hasRisk ? '例外判断と最終承認を人に残す' : '例外発生時のみ人へ引き継ぐ'
        : kind === 'assist' ? 'AIの出力を確認し、採用・修正して確定する'
          : kind === 'automation' ? 'ルール変更と例外処理を管理する'
            : kind === 'needs-info' ? '作業実態とデータを説明する' : '判断と実行を継続する',
      requirements,
      risks,
      missingInformation,
      evidenceLevel,
    }
  }).sort((left, right) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 }
    const kindOrder: Record<AiProposalKind, number> = { agent: 0, assist: 1, automation: 2, 'process-change': 3, 'needs-info': 4, human: 5 }
    return priorityOrder[left.priority] - priorityOrder[right.priority] || kindOrder[left.kind] - kindOrder[right.kind]
  })

  return {
    proposals,
    recommendedCount: proposals.filter((proposal) => proposal.kind === 'agent' || proposal.kind === 'assist' || proposal.kind === 'automation').length,
    agentCandidateCount: proposals.filter((proposal) => proposal.kind === 'agent').length,
    assistCandidateCount: proposals.filter((proposal) => proposal.kind === 'assist').length,
    automationCandidateCount: proposals.filter((proposal) => proposal.kind === 'automation').length,
    needsInfoCount: proposals.filter((proposal) => proposal.kind === 'needs-info').length,
    source: 'rule',
  }
}

function categorySource(task?: BusinessTask): 'map' | 'ai' | 'inferred' {
  if (!task || task.mappedBy === 'keyword') return 'inferred'
  return task.mappedBy === 'llm' ? 'ai' : 'map'
}

/** As-Isの事実だけを抜き出してLLMへ渡す。工程のまとめ方と提案文はLLM側で決める。 */
export function buildProcessAiEvidence(model: ProcessModel, mapTasks: BusinessTask[] = []): ProcessAiEvidence {
  const assetById = new Map((model.assets ?? []).map((asset) => [asset.id, asset]))
  const gatewayIds = new Set(model.steps.filter((step) => step.type === 'gateway').map((step) => step.id))
  const tasks = orderedProcessSteps(model).filter((step) => step.type === 'task')
  const taskIds = new Set(tasks.map((step) => step.id))
  const links = (model.assetLinks ?? []).filter((link) => taskIds.has(link.stepId))

  return {
    title: model.title,
    department: model.departmentId,
    connections: model.connections.map((connection) => ({ from_id: connection.from, to_id: connection.to, label: connection.label ?? '' })),
    steps: tasks.map((step) => {
      const outgoing = model.connections.filter((connection) => connection.from === step.id)
      return {
        id: step.id,
        category: mapTasks.find((task) => task.sourceStepId === step.id)?.category ?? classifyTaskName(step.label),
        category_source: categorySource(mapTasks.find((task) => task.sourceStepId === step.id)),
        label: step.label,
        actor: processStepLane(step),
        description: step.description ?? '',
        duration: hasUnknown(step.duration) ? '' : step.duration ?? '',
        monthly_volume: hasUnknown(step.monthlyVolume) ? '' : step.monthlyVolume ?? '',
        risk: step.risk ?? '',
        branch_labels: unique(outgoing.map((connection) => connection.label ?? '').filter(Boolean)),
        leads_to_gateway: outgoing.some((connection) => gatewayIds.has(connection.to)),
      }
    }),
    data_items: [
      ...links.flatMap((link) => {
        const asset = assetById.get(link.assetId)
        if (!asset || isToolAsset(asset)) return []
        return [{ step_id: link.stepId, name: asset.name, type: asset.type, relation: link.relation }]
      }),
      // タスクが入力・出力する情報。どの工程が作り、どの工程が使うかをAIが読めるようにする。
      ...tasks.flatMap((step) => ([['inputs', '入力'], ['outputs', '出力']] as const).flatMap(([direction, relation]) => (
        (step[direction] ?? []).flatMap((ref) => {
          const information = model.information?.find((item) => item.id === ref.informationId)
          return information ? [{ step_id: step.id, name: information.name, type: '情報', relation }] : []
        })
      ))),
    ],
    systems: links.flatMap((link) => {
      const asset = assetById.get(link.assetId)
      return asset && isToolAsset(asset) ? [{ step_id: link.stepId, name: asset.name }] : []
    }),
  }
}

const KIND_LABELS: Record<AiProposalKind, string> = {
  agent: 'AI Agent',
  assist: 'AI支援',
  automation: '通常自動化',
  'process-change': '運用変更',
  'needs-info': '追加調査',
  human: '人中心',
}

const PRIORITY_LABELS: Record<AiProposalPriority, string> = {
  high: '優先度 高',
  medium: '優先度 中',
  low: '優先度 低',
}

/** バックエンドの提案を画面のAiProposal形へ写す。件数はサーバー側の集計をそのまま使う。 */
export function toProcessAiProposalSet(response: ProcessAiOpportunityResponse): ProcessAiProposalSet {
  const toData = (items: Array<{ name: string; type: string; relation: string }>, prefix: string) => (
    items.map((item, index): AiProposalData => ({
      id: `${prefix}-${index}`,
      assetId: `${prefix}-${index}`,
      name: item.name,
      type: item.type as OperationalAsset['type'],
      relation: item.relation as ProcessAssetRelation,
    }))
  )
  return {
    proposals: response.proposals.map((proposal): AiProposal => ({
      ecrs: proposal.ecrs ?? [],
      before: proposal.before ?? '',
      after: proposal.after ?? '',
      improvementActions: proposal.improvement_actions ?? [],
      id: proposal.id,
      kind: proposal.kind,
      kindLabel: KIND_LABELS[proposal.kind],
      priority: proposal.priority,
      priorityLabel: PRIORITY_LABELS[proposal.priority],
      title: proposal.title,
      summary: proposal.summary,
      actor: proposal.actor,
      stepIds: proposal.step_ids,
      stepLabels: proposal.step_labels,
      inputData: toData(proposal.input_data, `${proposal.id}-in`),
      outputData: toData(proposal.output_data, `${proposal.id}-out`),
      systemNames: proposal.system_names,
      capabilities: proposal.capabilities as AiCapability[],
      aiActions: proposal.ai_actions,
      reasons: proposal.reasons,
      expectedBenefits: proposal.expected_benefits,
      humanRole: proposal.human_role,
      requirements: proposal.requirements,
      risks: proposal.risks,
      missingInformation: proposal.missing_information,
      evidenceLevel: proposal.evidence_level,
    })),
    recommendedCount: response.recommended_count,
    agentCandidateCount: response.agent_candidate_count,
    assistCandidateCount: response.assist_candidate_count,
    automationCandidateCount: response.automation_candidate_count,
    needsInfoCount: response.needs_info_count,
    source: 'llm',
    generatedAt: response.generated_at,
    uncoveredStepLabels: response.uncovered_step_labels,
  }
}
