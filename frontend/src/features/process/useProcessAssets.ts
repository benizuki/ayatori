import { computed, ref, type ComputedRef } from 'vue'
import type { LlmInterviewAttachment } from '../../api/interview'
import { extractAssetDocumentFields, type AssetLedgerField } from '../../api/process'
import type { OperationalAsset, ProcessAssetLink, ProcessModel, ProcessStep } from '../../models'
import { interviewAttachmentMaxBytes, readFileAsDataUrl, supportedInterviewAttachmentTypes } from '../../utils/attachments'
import { useAuthSession } from '../admin/useAuthSession'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import { ensureProcessAssets, normalizeProcessLaneLayout, normalizedAssetKey, systemAssetNames } from './process-model'
import {
  detachAssetFromAllInformation,
  normalizeProcessInformation,
  detachAssetFromStepInformation,
  splitInformationItems,
  syncAssetLinksFromInformation,
} from './process-information'

export interface ProcessAssetDeps {
  activeProcessModel: ComputedRef<ProcessModel>
  activeProcessAssets: ComputedRef<OperationalAsset[]>
  selected: ComputedRef<ProcessStep | undefined>
  /** 選択中のステップに紐付いたアセットの関係。 */
  selectedStepAssetLinks: ComputedRef<ProcessAssetLink[]>
  markProcessDirty: () => void
}

/**
 * 業務アセット（システム・台帳・帳票など）の管理。追加・削除、ステップとの紐付けと、
 * 資料から情報の項目を抽出するダイアログの状態を持つ。
 */
export function useProcessAssets(deps: ProcessAssetDeps) {
  const { activeProcessModel, activeProcessAssets, selected, selectedStepAssetLinks, markProcessDirty } = deps
  const { notify } = useWorkspaceStore()
  const { canEdit } = useAuthSession()

  const assetManagementDialog = ref(false)
  const selectedAssetId = ref('')
  const assetSearch = ref('')
  const assetLinkCandidateId = ref('')
  const assetExtractionDialog = ref(false)
  const assetExtractionLoading = ref(false)
  const assetExtractionError = ref('')
  const assetExtractionFileName = ref('')
  const assetExtractionDocumentType = ref('')
  const assetExtractionSummary = ref('')
  const assetExtractionWarnings = ref<string[]>([])
  const assetExtractionFields = ref<AssetLedgerField[]>([])
  const selectedAssetExtractionFields = ref<number[]>([])
  /** 抽出した項目を入れる先の情報。項目は書類やデータのまとまり（情報）が持つ。 */
  const extractionInformationId = ref('')

  const selectedManagedAsset = computed(() => activeProcessAssets.value.find((asset) => asset.id === selectedAssetId.value))
  const filteredProcessAssets = computed(() => {
    const query = normalizedAssetKey(assetSearch.value)
    return query ? activeProcessAssets.value.filter((asset) => normalizedAssetKey(`${asset.name}${asset.type}${asset.purpose}`).includes(query)) : activeProcessAssets.value
  })
  const availableAssetsForSelectedStep = computed(() => {
    const linked = new Set(selectedStepAssetLinks.value.map((link) => link.assetId))
    return activeProcessAssets.value.filter((asset) => !linked.has(asset.id))
  })

  function openAssetManagement(assetId = '') {
    ensureProcessAssets(activeProcessModel.value)
    normalizeProcessInformation(activeProcessModel.value)
    selectedAssetId.value = assetId || activeProcessAssets.value[0]?.id || ''
    assetSearch.value = ''
    assetManagementDialog.value = true
  }

  /** 帳票・台帳・画面の資料から、情報に含まれる項目を読み取る。 */
  async function extractInformationItems(informationId: string, event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    const information = activeProcessModel.value.information?.find((item) => item.id === informationId)
    if (!file || !information || !canEdit.value) return
    extractionInformationId.value = informationId
    const mimeType = file.type as LlmInterviewAttachment['mime_type']
    assetExtractionDialog.value = true
    assetExtractionLoading.value = true
    assetExtractionError.value = ''
    assetExtractionFileName.value = file.name
    assetExtractionDocumentType.value = ''
    assetExtractionSummary.value = ''
    assetExtractionWarnings.value = []
    assetExtractionFields.value = []
    selectedAssetExtractionFields.value = []
    try {
      if (!supportedInterviewAttachmentTypes.has(mimeType)) throw new Error('PNG・JPEG・WebP・PDFのみ解析できます。')
      if (file.size > interviewAttachmentMaxBytes) throw new Error('ファイルは8MB以下にしてください。')
      const dataUrl = await readFileAsDataUrl(file)
      const data = dataUrl.split(',', 2)[1]
      if (!data) throw new Error('ファイルを読み込めませんでした。')
      const result = await extractAssetDocumentFields({
        asset_name: information.name,
        existing_description: (information.items ?? []).join('、'),
        attachment: { name: file.name, mime_type: mimeType, data },
      })
      assetExtractionDocumentType.value = result.document_type
      assetExtractionSummary.value = result.summary
      assetExtractionWarnings.value = result.warnings
      assetExtractionFields.value = result.fields
      selectedAssetExtractionFields.value = result.fields.map((_, index) => index)
      if (!result.fields.length && !result.warnings.length) assetExtractionError.value = '項目を抽出できませんでした。別の資料をお試しください。'
    } catch (error) {
      assetExtractionError.value = error instanceof Error ? error.message : '資料から項目を抽出できませんでした。'
    } finally {
      assetExtractionLoading.value = false
      input.value = ''
    }
  }

  function applyExtractedInformationItems() {
    const information = activeProcessModel.value.information?.find((item) => item.id === extractionInformationId.value)
    if (!information) return
    const existing = new Set(information.items ?? [])
    const names = selectedAssetExtractionFields.value
      .map((index) => assetExtractionFields.value[index])
      .filter((field): field is AssetLedgerField => Boolean(field))
      .flatMap((field) => splitInformationItems(field.name))
      .filter((name) => !existing.has(name))
    information.items = [...existing, ...names]
    assetExtractionDialog.value = false
    markProcessDirty()
    notify(`${names.length}件の項目を「${information.name}」へ追加しました`)
  }

  function addOperationalAsset() {
    if (!canEdit.value) return
    const model = activeProcessModel.value
    const asset: OperationalAsset = {
      id: `asset-${model.businessId}-${Date.now()}`,
      name: '新しい業務アセット',
      type: '業務システム',
      purpose: '',
      owner: '未確認',
      location: '未確認',
      dataDescription: '',
      status: '未確認',
      confidence: 50,
      sourceFragmentIds: [],
    }
    model.assets = [...(model.assets ?? []), asset]
    selectedAssetId.value = asset.id
    markProcessDirty()
  }

  function deleteOperationalAsset(assetId: string) {
    if (!canEdit.value) return
    const model = activeProcessModel.value
    const asset = model.assets?.find((item) => item.id === assetId)
    if (!asset || !window.confirm(`「${asset.name}」を削除しますか？\n工程との紐付けも削除されます。`)) return
    const assetKey = normalizedAssetKey(asset.name)
    model.assets = (model.assets ?? []).filter((item) => item.id !== assetId)
    detachAssetFromAllInformation(model, assetId)
    model.assetLinks = (model.assetLinks ?? []).filter((link) => link.assetId !== assetId)
    syncAssetLinksFromInformation(model)
    model.suppressedAssetKeys = [...new Set([...(model.suppressedAssetKeys ?? []), assetKey])]
    model.suppressedAssetLinkKeys = (model.suppressedAssetLinkKeys ?? []).filter((key) => !key.startsWith(`${assetId}:`))
    normalizeProcessLaneLayout(model, { preserveStepPositions: true })
    selectedAssetId.value = model.assets[0]?.id ?? ''
    markProcessDirty()
    notify(`「${asset.name}」を削除しました`)
  }

  function linkAssetToSelectedStep() {
    const model = activeProcessModel.value
    if (!selected.value || !assetLinkCandidateId.value) return
    const asset = model.assets?.find((item) => item.id === assetLinkCandidateId.value)
    model.assetLinks = [...(model.assetLinks ?? []), {
      id: `asset-link-${model.businessId}-${Date.now()}`,
      assetId: assetLinkCandidateId.value,
      stepId: selected.value.id,
      relation: '参照',
      dataDescription: asset?.dataDescription ?? '',
    }]
    model.suppressedAssetLinkKeys = (model.suppressedAssetLinkKeys ?? []).filter((key) => key !== `${assetLinkCandidateId.value}:${selected.value!.id}`)
    if (asset) model.suppressedAssetKeys = (model.suppressedAssetKeys ?? []).filter((key) => key !== normalizedAssetKey(asset.name))
    normalizeProcessLaneLayout(model, { preserveStepPositions: true })
    assetLinkCandidateId.value = ''
    markProcessDirty()
  }

  function unlinkAssetFromSelectedStep(linkId: string) {
    const model = activeProcessModel.value
    const link = (model.assetLinks ?? []).find((item) => item.id === linkId)
    if (!link) return
    // 情報から作った紐付けは、その情報の取得元・格納先からアセットを外すことで解除する。
    const step = model.steps.find((item) => item.id === link.stepId)
    if (link.informationIds && step) detachAssetFromStepInformation(step, link.assetId, link.relation === '入力' ? 'inputs' : 'outputs')
    model.assetLinks = (model.assetLinks ?? []).filter((item) => item.id !== linkId)
    syncAssetLinksFromInformation(model)
    model.suppressedAssetLinkKeys = [...new Set([...(model.suppressedAssetLinkKeys ?? []), `${link.assetId}:${link.stepId}`])]
    normalizeProcessLaneLayout(model, { preserveStepPositions: true })
    markProcessDirty()
  }

  function syncSelectedStepSystemAssets() {
    const model = activeProcessModel.value
    const step = selected.value
    if (!step) return
    const names = systemAssetNames(step.system).map(normalizedAssetKey)
    model.suppressedAssetKeys = (model.suppressedAssetKeys ?? []).filter((key) => !names.includes(key))
    model.suppressedAssetLinkKeys = (model.suppressedAssetLinkKeys ?? []).filter((key) => !key.endsWith(`:${step.id}`))
    ensureProcessAssets(model)
    // 業務システム欄に書かれたアセットを、情報と置き場所の関係に整える。
    normalizeProcessInformation(model)
    normalizeProcessLaneLayout(model, { preserveStepPositions: true })
    markProcessDirty()
  }

  function reflowProcessAssets() {
    if (activeProcessModel.value) normalizeProcessLaneLayout(activeProcessModel.value, { preserveStepPositions: true })
    markProcessDirty()
  }

  return {
    assetManagementDialog,
    selectedAssetId,
    assetSearch,
    assetLinkCandidateId,
    assetExtractionDialog,
    assetExtractionLoading,
    assetExtractionError,
    assetExtractionFileName,
    assetExtractionDocumentType,
    assetExtractionSummary,
    assetExtractionWarnings,
    assetExtractionFields,
    selectedAssetExtractionFields,
    selectedManagedAsset,
    filteredProcessAssets,
    availableAssetsForSelectedStep,
    openAssetManagement,
    extractInformationItems,
    applyExtractedInformationItems,
    addOperationalAsset,
    deleteOperationalAsset,
    linkAssetToSelectedStep,
    unlinkAssetFromSelectedStep,
    syncSelectedStepSystemAssets,
    reflowProcessAssets,
  }
}
