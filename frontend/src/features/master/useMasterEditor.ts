import { computed, ref } from 'vue'
import { interviewTopicTemplates } from '../../api/initial-data'
import { useAppShell } from '../shell/useAppShell'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { useInterviewContext } from '../interviews/useInterviewContext'
import { useAuthSession } from '../admin/useAuthSession'
import { useProcessEditor } from '../process/useProcessEditor'
import { useMasterCatalogs } from './composables/useMasterCatalogs'
import { businessDescendantIds } from './process-hierarchy'
import type { BusinessFlowImportJob } from '../../api/imports'
import type { BusinessProcessRelation, BusinessProcessRelationType, OperationalAsset, ProcessConnection, ProcessModel, ProcessStep, ProcessVersion, WorkFragment } from '../../models'

/** Business master authoring. */
function createMasterEditor() {
  const {
    departments,
    businessMasters,
    businessRelations,
    processModels,
    processVersions,
    workFragments,
    notify,
    persistBusinessMasters,
    persistProcessState,
    scheduleAppStateSave,
  } = useWorkspaceStore()
  const { goTo } = useAppShell()
  const { canEdit } = useAuthSession()
  const { selectedInterviewBusiness } = useInterviewContext()
  const { processBusinessId, selectProcessBusiness } = useProcessEditor()

  const deleteDialog = ref(false)

  const {
    selectedBusinessId,
    businessDepartmentId: masterDepartment,
    businessSearch: masterSearch,
    selectedBusiness,
    filteredBusinesses: filteredBusinessMasters,
  } = useMasterCatalogs({
    departments,
    businessMasters,
  })
  const selectedDepartmentName = computed(() => departments.find((item) => item.id === selectedBusiness.value.departmentId)?.name ?? '')
  const selectedAsIsModel = computed(() => processModels.value[selectedBusiness.value.id] ?? null)
  const asIsModels = computed(() => businessMasters.value
    .map((business) => processModels.value[business.id])
    .filter((model): model is ProcessModel => Boolean(model && (model.sourceType === 'interview' || model.sourceType === 'document' || model.sourceInterviewId))))
  const asIsBusinessCount = computed(() => asIsModels.value.length)
  const asIsTaskCount = computed(() => asIsModels.value.reduce(
    (count, model) => count + model.steps.filter((step) => step.type === 'task').length,
    0,
  ))
  const validParentBusinesses = computed(() => {
    const blocked = businessDescendantIds(selectedBusiness.value.id, businessMasters.value)
    blocked.add(selectedBusiness.value.id)
    return businessMasters.value.filter((item) => !blocked.has(item.id))
  })
  const selectedBusinessRelations = computed(() => businessRelations.value.filter((relation) => (
    relation.fromBusinessId === selectedBusiness.value.id || relation.toBusinessId === selectedBusiness.value.id
  )))

  function selectBusiness(id: string) {
    const business = businessMasters.value.find((item) => item.id === id)
    if (business) masterDepartment.value = business.departmentId
    selectedBusinessId.value = id
  }

  function openAsIs() {
    selectProcessBusiness(selectedBusiness.value.id)
    goTo('process')
  }

  function openAsIsById(id: string) {
    selectBusiness(id)
    selectProcessBusiness(id)
    goTo('process')
  }

  function addBusiness() {
    if (!canEdit.value) return
    // 業務は必ず業務領域に属する。領域が無い状態で作ると行き場のない業務になる。
    if (!departments.length) {
      notify('先に業務領域マスターへ業務領域を追加してください')
      return
    }
    const id = `business-${Date.now()}`
    businessMasters.value.unshift({
      id,
      code: 'NEW-000',
      name: '新しい業務',
      departmentId: masterDepartment.value || departments[0].id,
      category: '未分類',
      description: '',
      startCondition: '',
      endCondition: '',
      sapScope: '未判定',
      sapModule: '',
      ownerRole: '',
      status: '作成中',
      updatedAt: '未保存',
      interviewTopics: [
        { ...structuredClone(interviewTopicTemplates[0]), id: `purpose-${Date.now()}` },
        { ...structuredClone(interviewTopicTemplates[1]), id: `flow-${Date.now()}` },
      ],
      parentId: '',
    })
    selectedBusinessId.value = id
  }

  function saveBusiness() {
    if (!canEdit.value || !selectedBusiness.value.id) return
    const descendants = businessDescendantIds(selectedBusiness.value.id, businessMasters.value)
    if (selectedBusiness.value.parentId && descendants.has(selectedBusiness.value.parentId)) {
      selectedBusiness.value.parentId = ''
      notify('循環する親子関係は保存できないため、最上位業務に戻しました')
      return
    }
    selectedBusiness.value.updatedAt = 'たった今'
    persistBusinessMasters()
    notify(`「${selectedBusiness.value.name}」を保存しました`)
  }

  function applyBusinessFlowImport(job: BusinessFlowImportJob) {
    if (!canEdit.value) return
    const selected = job.candidates.filter((candidate) => candidate.selected && candidate.draft)
    selected.forEach((candidate) => {
      const draft = candidate.draft!
      const importedFragments: WorkFragment[] = candidate.fragments.map((fragment) => ({
        id: fragment.id,
        title: fragment.title,
        description: fragment.description,
        departmentId: job.department_id,
        actor: fragment.actor,
        participant: '業務フロー資料',
        trigger: fragment.trigger,
        tools: [...fragment.tools],
        output: fragment.output,
        nextStep: fragment.next_step,
        nextActor: fragment.next_actor,
        standardTime: fragment.standard_time,
        processingVolume: fragment.processing_volume,
        sourceDocument: fragment.source_document || job.file_name,
        sourceReference: fragment.source_reference,
        dataItems: fragment.data_items.map((item) => ({
          name: item.name,
          description: item.description,
          dataType: item.data_type,
          sourceDocument: item.source_document,
          confidence: item.confidence,
        })),
        personalization: fragment.personalization,
        sourceQuote: fragment.source_quote || `${job.file_name} ${fragment.source_reference}`,
        sourceTime: fragment.source_time || '資料インポート',
        interviewId: job.id,
        confidence: fragment.confidence,
      }))
      const knownFragmentIds = new Set(workFragments.value.map((fragment) => fragment.id))
      workFragments.value.push(...importedFragments.filter((fragment) => !knownFragmentIds.has(fragment.id)))

      let business = candidate.target_business_id
        ? businessMasters.value.find((item) => item.id === candidate.target_business_id)
        : undefined
      if (!business) {
        business = {
          id: `document-${crypto.randomUUID()}`,
          code: `DOC-${String(businessMasters.value.length + 1).padStart(3, '0')}`,
          name: candidate.title,
          departmentId: job.department_id,
          category: '業務フロー資料から生成',
          description: draft.summary || candidate.summary,
          startCondition: draft.start_condition,
          endCondition: draft.end_condition,
          sapScope: importedFragments.some((fragment) => fragment.tools.some((tool) => /SAP/i.test(tool))) ? '拡張' : '周辺',
          sapModule: [...new Set(importedFragments.flatMap((fragment) => fragment.tools).filter((tool) => /SAP/i.test(tool)))].join(' / ') || '未判定',
          ownerRole: draft.nodes.find((node) => node.type === 'task')?.actor || '未確認',
          status: '作成中',
          updatedAt: '資料から生成',
          interviewTopics: [],
          maturity: '仮説',
          sourceFragmentIds: importedFragments.map((fragment) => fragment.id),
        }
        businessMasters.value.unshift(business)
      } else {
        const previous = processModels.value[business.id]
        if (previous) {
          const version: ProcessVersion = {
            id: `version-${crypto.randomUUID()}`,
            businessId: previous.businessId,
            savedAt: new Date().toISOString(),
            label: '資料インポート前',
            steps: structuredClone(previous.steps),
            connections: structuredClone(previous.connections),
            layoutDirection: previous.layoutDirection,
            lanes: [...(previous.lanes ?? [])],
            laneHeights: { ...(previous.laneHeights ?? {}) },
            laneWidths: { ...(previous.laneWidths ?? {}) },
            layoutPositionsCustomized: previous.layoutPositionsCustomized,
            assets: structuredClone(previous.assets ?? []),
            assetLinks: structuredClone(previous.assetLinks ?? []),
            information: structuredClone(previous.information ?? []),
            suppressedAssetKeys: [...(previous.suppressedAssetKeys ?? [])],
            suppressedAssetLinkKeys: [...(previous.suppressedAssetLinkKeys ?? [])],
          }
          processVersions.value[business.id] = [version, ...(processVersions.value[business.id] ?? [])].slice(0, 10)
        }
        business.description = draft.summary || business.description
        business.startCondition = draft.start_condition || business.startCondition
        business.endCondition = draft.end_condition || business.endCondition
        business.updatedAt = '資料から更新'
        business.maturity = '仮説'
        business.sourceFragmentIds = [...new Set([...(business.sourceFragmentIds ?? []), ...importedFragments.map((fragment) => fragment.id)])]
      }

      const lanes = [...new Set([...draft.lanes, ...draft.nodes.map((node) => node.actor).filter(Boolean)])]
      const normalizedLanes = lanes.length ? lanes : ['未確認']
      const orderValues = [...new Set(draft.nodes.map((node) => node.order))].sort((a, b) => a - b)
      const orderIndex = new Map(orderValues.map((order, index) => [order, index]))
      const keyToId = new Map<string, string>()
      const steps: ProcessStep[] = draft.nodes.map((node, index) => {
        const id = `document-step-${business!.id}-${index + 1}`
        keyToId.set(node.key, id)
        const laneIndex = Math.max(0, normalizedLanes.indexOf(node.actor))
        return {
          id,
          label: node.label,
          actor: node.actor,
          lane: node.actor,
          type: node.type,
          x: 80 + (orderIndex.get(node.order) ?? index) * 190,
          y: 100 + laneIndex * 150,
          width: node.type === 'task' ? 150 : undefined,
          duration: node.duration,
          system: node.system,
          monthlyVolume: node.monthly_volume,
          description: node.description,
          confidence: node.confidence,
          sourceFragmentIds: [...node.source_fragment_ids],
          sourceQuotes: node.source_fragment_ids.flatMap((id) => {
            const fragment = importedFragments.find((item) => item.id === id)
            return fragment ? [`${fragment.sourceDocument} ${fragment.sourceReference}`] : []
          }),
          needsReview: node.needs_review,
          risk: node.needs_review ? 'medium' : undefined,
          evidence: [],
        }
      })
      const connections: ProcessConnection[] = draft.flows.flatMap((flow, index) => {
        const from = keyToId.get(flow.from_key)
        const to = keyToId.get(flow.to_key)
        return from && to ? [{ id: `document-flow-${business!.id}-${index + 1}`, from, to, label: flow.label || undefined }] : []
      })
      const assetKeyToId = new Map<string, string>()
      const assets: OperationalAsset[] = draft.assets.map((asset, index) => {
        const id = `document-asset-${business!.id}-${index + 1}`
        assetKeyToId.set(asset.key, id)
        return {
          id,
          name: asset.name,
          type: asset.type,
          purpose: asset.purpose,
          owner: asset.owner,
          location: asset.location,
          dataDescription: asset.data_description,
          status: asset.needs_review ? '未確認' : '確認済み',
          confidence: asset.confidence,
          sourceFragmentIds: [...asset.source_fragment_ids],
        }
      })
      const model: ProcessModel = {
        businessId: business.id,
        departmentId: business.departmentId,
        title: draft.title || candidate.title,
        summary: draft.summary,
        steps,
        connections,
        updatedAt: new Date().toISOString(),
        reviewStatus: '編集中',
        sourceType: 'document',
        sourceImportId: job.id,
        layoutDirection: 'vertical',
        lanes: normalizedLanes,
        assumptions: [...draft.assumptions],
        reviewItems: [...new Set([
          ...draft.review_items,
          ...candidate.warnings,
          ...importedFragments.flatMap((fragment) => [
            fragment.actor === '未確認' ? `「${fragment.title}」の実行担当を確認してください。` : '',
            fragment.standardTime === '未確認' ? `「${fragment.title}」の処理時間を確認してください。` : '',
            fragment.processingVolume === '未確認' ? `「${fragment.title}」の処理件数を確認してください。` : '',
          ]).filter(Boolean),
        ])],
        assets,
        assetLinks: draft.asset_links.flatMap((link, index) => {
          const assetId = assetKeyToId.get(link.asset_key)
          const stepId = keyToId.get(link.node_key)
          return assetId && stepId ? [{
            id: `document-asset-link-${business!.id}-${index + 1}`,
            assetId,
            stepId,
            relation: link.relation,
            dataDescription: link.data_description,
          }] : []
        }),
      }
      processModels.value[business.id] = model
      business.asIsModelId = business.id
      business.asIsUpdatedAt = model.updatedAt
      selectedBusinessId.value = business.id
      masterDepartment.value = business.departmentId
    })
    persistBusinessMasters()
    persistProcessState()
    scheduleAppStateSave()
    notify(`${selected.length}件のAs-Isを業務マスターへ登録しました`)
  }

  function addBusinessRelation(toBusinessId: string, type: BusinessProcessRelationType, label = '', fromBusinessId = selectedBusiness.value.id) {
    if (!canEdit.value || !fromBusinessId || !toBusinessId || toBusinessId === fromBusinessId) return
    const duplicate = businessRelations.value.some((relation) => (
      relation.fromBusinessId === fromBusinessId
      && relation.toBusinessId === toBusinessId
      && relation.type === type
    ))
    if (duplicate) {
      notify('同じ業務間関連はすでに登録されています')
      return
    }
    const relation: BusinessProcessRelation = {
      id: `business-relation-${crypto.randomUUID()}`,
      fromBusinessId,
      toBusinessId,
      type,
      label: label.trim(),
    }
    businessRelations.value.push(relation)
    persistBusinessMasters()
    notify('業務間の関連を追加しました')
  }

  function deleteBusinessRelation(relationId: string) {
    if (!canEdit.value) return
    const index = businessRelations.value.findIndex((relation) => relation.id === relationId)
    if (index < 0) return
    businessRelations.value.splice(index, 1)
    persistBusinessMasters()
    notify('業務間の関連を削除しました')
  }

  function deleteBusiness() {
    if (!canEdit.value) return
    const index = businessMasters.value.findIndex((item) => item.id === selectedBusiness.value.id)
    if (index < 0) return
    const [deleted] = businessMasters.value.splice(index, 1)
    businessMasters.value.forEach((business) => {
      if (business.parentId === deleted.id) business.parentId = ''
    })
    businessRelations.value = businessRelations.value.filter((relation) => (
      relation.fromBusinessId !== deleted.id && relation.toBusinessId !== deleted.id
    ))
    Object.values(processModels.value).forEach((model) => {
      model.steps.forEach((step) => {
        if (step.childBusinessId === deleted.id) step.childBusinessId = undefined
      })
    })
    delete processModels.value[deleted.id]
    delete processVersions.value[deleted.id]
    // 初期データを整理しきれるよう最後の1件も削除できる。0件になった場合は空の選択に戻す。
    const nextBusinessId = (businessMasters.value[index] ?? businessMasters.value[index - 1] ?? businessMasters.value[0])?.id ?? ''
    selectedBusinessId.value = nextBusinessId
    if (processBusinessId.value === deleted.id) selectProcessBusiness(nextBusinessId)
    if (selectedInterviewBusiness.value === deleted.id) selectedInterviewBusiness.value = nextBusinessId
    persistBusinessMasters()
    persistProcessState()
    deleteDialog.value = false
    notify(`「${deleted.name}」を削除しました`)
  }
  return {
    deleteDialog,
    selectedBusinessId,
    masterDepartment,
    masterSearch,
    selectedBusiness,
    filteredBusinessMasters,
    selectedDepartmentName,
    selectedAsIsModel,
    asIsBusinessCount,
    asIsTaskCount,
    validParentBusinesses,
    selectedBusinessRelations,
    selectBusiness,
    openAsIs,
    openAsIsById,
    addBusiness,
    saveBusiness,
    applyBusinessFlowImport,
    addBusinessRelation,
    deleteBusinessRelation,
    deleteBusiness,
  }
}

export type MasterEditor = ReturnType<typeof createMasterEditor>

let masterEditor: MasterEditor | null = null

export function useMasterEditor(): MasterEditor {
  if (!masterEditor) masterEditor = createMasterEditor()
  return masterEditor
}
