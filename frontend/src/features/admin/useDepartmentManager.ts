import { ref } from 'vue'
import { moveDepartmentToTenant } from '../../api/auth'
import { useInterviewContext } from '../interviews/useInterviewContext'
import { useInterviewWorkflow } from '../interviews/useInterviewWorkflow'
import { useMasterEditor } from '../master/useMasterEditor'
import type { BusinessProcessMaster, Department, ProcessModel, Stage } from '../../models'
import { useProcessEditor } from '../process/useProcessEditor'
import { useWorkspaceRestore } from '../workspace/useWorkspaceRestore'
import { useWorkspaceStore } from '../workspace/useWorkspaceStore'
import type { DepartmentForm } from './types'
import { useAuthSession } from './useAuthSession'

/**
 * 業務領域マスターの管理ダイアログ。追加・編集・削除（参照が残る間は拒否）と、
 * 別テナントへの移管を受け持つ。
 */
export function useDepartmentManager() {
  const {
    departments,
    businessMasters,
    processModels,
    processVersions,
    interviewSessions,
    workFragments,
    processModelDepartmentId,
    generateDepartmentId,
    notify,
    flushAppStateSave,
    persistDepartments,
    persistBusinessMasters,
    persistProcessState,
  } = useWorkspaceStore()
  const { canEdit, activeTenantId, tenants } = useAuthSession()
  const { discoveryDepartmentId } = useInterviewContext()
  const { interviewSessionDepartmentId, setInterviewSessionDepartment, syncInterviewDepartmentName } = useInterviewWorkflow()
  const { processBusinessId, processDepartmentId, pendingProcessDepartmentId } = useProcessEditor()
  const { masterDepartment } = useMasterEditor()
  const { resetWorkspaceToSeeds, restoreAppStateFromBackend } = useWorkspaceRestore()

  const departmentManagerOpen = ref(false)
  const departmentDeleteDialog = ref(false)
  const editingDepartmentId = ref('')
  const departmentFormError = ref('')
  const departmentStages: Stage[] = ['未着手', '調査中', '分析中', 'To-Be設計', '合意済み']
  const departmentIconOptions = [
    { title: 'オフィス', value: 'mdi-domain' },
    { title: '経理・財務', value: 'mdi-calculator-variant-outline' },
    { title: '人事・総務', value: 'mdi-account-group-outline' },
    { title: '調達・購買', value: 'mdi-cart-outline' },
    { title: 'IT・情報システム', value: 'mdi-laptop' },
    { title: '営業', value: 'mdi-handshake-outline' },
    { title: '製造', value: 'mdi-factory' },
    { title: '物流', value: 'mdi-truck-outline' },
  ]
  const emptyDepartmentForm = (): DepartmentForm => ({
    id: generateDepartmentId(),
    tenantId: activeTenantId.value,
    name: '',
    owner: '',
    stage: '未着手',
    progress: 0,
    icon: 'mdi-domain',
    color: '#557a43',
  })
  const departmentForm = ref<DepartmentForm>(emptyDepartmentForm())

  function departmentReferences(departmentId: string) {
    const businesses = businessMasters.value.filter((item) => item.departmentId === departmentId).length
    const departmentModels = Object.values(processModels.value).filter((model) => processModelDepartmentId(model) === departmentId)
    // 業務を消せばAs-Isも一緒に消えるが、業務が既に無いAs-Isは画面から辿れない。
    // 作業断片と同じく、残った業務に紐づくものだけを削除の妨げとする。
    const asIsModels = departmentModels.filter((model) => businessMasters.value.some((business) => business.id === model.businessId)).length
    const orphanAsIsModels = departmentModels.length - asIsModels
    const interviews = interviewSessions.value.filter((item) => item.departmentId === departmentId).length
    const departmentFragments = workFragments.value.filter((item) => item.departmentId === departmentId)
    // 作業断片はヒアリングを消せば一緒に消えるが、初期データのようにヒアリングを持たない
    // 断片は利用者が消す手段がない。残っているヒアリングに属する断片だけを削除の妨げとし、
    // 行き場のない断片は業務領域と一緒に片付ける。
    const fragments = departmentFragments.filter((fragment) => interviewSessions.value.some((session) => session.id === fragment.interviewId)).length
    const orphanFragments = departmentFragments.length - fragments
    return {
      businesses,
      asIsModels,
      orphanAsIsModels,
      interviews,
      fragments,
      orphanFragments,
      total: businesses + asIsModels + interviews + fragments,
    }
  }

  function linkedBusinessMasters(departmentId: string) {
    return businessMasters.value.filter((business) => business.departmentId === departmentId)
  }

  function linkedProcessModels(departmentId: string) {
    return Object.values(processModels.value).filter((model) => processModelDepartmentId(model) === departmentId)
  }

  function reassignBusinessMasterDepartment(business: BusinessProcessMaster, departmentId: string) {
    business.departmentId = departmentId
    persistBusinessMasters()
    notify(`「${business.name}」の業務領域を変更しました`)
  }

  function reassignProcessModelDepartment(model: ProcessModel, departmentId: string) {
    model.departmentId = departmentId
    if (model.businessId === processBusinessId.value) {
      processDepartmentId.value = departmentId
      pendingProcessDepartmentId.value = departmentId
    }
    persistProcessState()
    notify(`「${model.title}」の業務領域を変更しました`)
  }

  function selectDepartmentForEditing(department: Department) {
    editingDepartmentId.value = department.id
    departmentForm.value = {
      id: department.id,
      tenantId: department.tenantId || activeTenantId.value,
      name: department.name,
      owner: department.owner,
      stage: department.stage,
      progress: department.progress,
      icon: department.icon,
      color: department.color,
    }
    departmentFormError.value = ''
  }

  function openDepartmentManager(departmentId = '') {
    if (!canEdit.value) {
      notify('viewer権限では業務領域を管理できません')
      return
    }
    departmentManagerOpen.value = true
    const selected = departments.find((item) => item.id === departmentId)
      ?? departments.find((item) => item.id === masterDepartment.value)
      ?? departments[0]
    if (selected) selectDepartmentForEditing(selected)
    else openNewDepartment()
  }

  function openNewDepartment() {
    if (!canEdit.value) return
    editingDepartmentId.value = ''
    departmentForm.value = emptyDepartmentForm()
    departmentFormError.value = ''
  }

  async function saveDepartment() {
    if (!canEdit.value) {
      notify('viewer権限では業務領域を保存できません')
      return
    }
    const form = departmentForm.value
    let id = editingDepartmentId.value || form.id || generateDepartmentId()
    const name = form.name.trim()
    const owner = form.owner.trim()
    if (!name) {
      departmentFormError.value = '業務領域名を入力してください。'
      return
    }
    if (!editingDepartmentId.value) {
      if (!/^[0-9a-f]{8}$/.test(id) || departments.some((item) => item.id === id)) id = generateDepartmentId()
      form.id = id
    }
    const normalized: DepartmentForm = {
      ...form,
      id,
      name,
      owner: owner || '責任者未設定',
      progress: Math.min(100, Math.max(0, Number(form.progress) || 0)),
      color: /^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#557a43',
    }
    const existing = departments.find((item) => item.id === editingDepartmentId.value)
    const tenantChanged = Boolean(
      normalized.tenantId
      && normalized.tenantId !== activeTenantId.value
    )
    if (existing) {
      const previousName = existing.name
      Object.assign(existing, normalized, {
        id: existing.id,
        tenantId: activeTenantId.value,
      })
      interviewSessions.value
        .filter((session) => session.departmentId === existing.id)
        .forEach((session) => { session.departmentName = normalized.name })
      if (previousName !== normalized.name) void syncInterviewDepartmentName(existing.id, normalized.name)
    } else {
      const created: Department = {
        ...normalized,
        tenantId: activeTenantId.value,
        interviews: 0,
        processes: 0,
      }
      departments.push(created)
      selectDepartmentForEditing(created)
    }
    if (tenantChanged) {
      try {
        await flushAppStateSave()
        await moveDepartmentToTenant(id, normalized.tenantId)
        resetWorkspaceToSeeds()
        await restoreAppStateFromBackend()
        const next = departments[0]
        if (next) selectDepartmentForEditing(next)
        else departmentManagerOpen.value = false
        departmentFormError.value = ''
        notify(`「${normalized.name}」を「${tenants.value.find((tenant) => tenant.id === normalized.tenantId)?.name || normalized.tenantId}」へ移管しました`)
        return
      } catch (error) {
        departmentFormError.value = error instanceof Error ? error.message : '業務領域のテナントを変更できませんでした。'
        return
      }
    }
    persistDepartments()
    departmentFormError.value = ''
    notify(`「${normalized.name}」を業務領域マスターに保存しました`)
  }

  function requestDepartmentDeletion() {
    const target = departments.find((item) => item.id === editingDepartmentId.value)
    if (!target) return
    const references = departmentReferences(target.id)
    if (references.total > 0) {
      departmentFormError.value = `この業務領域は業務${references.businesses}件、As-Is ${references.asIsModels}件、ヒアリング${references.interviews}件、作業断片${references.fragments}件から参照されているため削除できません。`
      return
    }
    departmentDeleteDialog.value = true
  }

  function deleteDepartment() {
    if (!canEdit.value) {
      notify('viewer権限では業務領域を削除できません')
      return
    }
    const index = departments.findIndex((item) => item.id === editingDepartmentId.value)
    if (index < 0 || departmentReferences(departments[index].id).total > 0) return
    // 参照の解決は業務領域が残っているうちに済ませる。削除後は既定の領域へ寄ってしまう。
    const orphanModelIds = Object.values(processModels.value)
      .filter((model) => processModelDepartmentId(model) === departments[index].id)
      .map((model) => model.businessId)
    const [deleted] = departments.splice(index, 1)
    const removedFragments = workFragments.value.filter((fragment) => fragment.departmentId === deleted.id).length
    if (removedFragments) workFragments.value = workFragments.value.filter((fragment) => fragment.departmentId !== deleted.id)
    orphanModelIds.forEach((businessId) => {
      delete processModels.value[businessId]
      delete processVersions.value[businessId]
    })
    const next = departments[index] ?? departments[index - 1] ?? departments[0]
    // 0件になったら編集対象が無くなるため、新規追加のフォームへ切り替える。
    if (next) selectDepartmentForEditing(next)
    else openNewDepartment()
    if (discoveryDepartmentId.value === deleted.id) discoveryDepartmentId.value = next?.id ?? ''
    if (masterDepartment.value === deleted.id) masterDepartment.value = next?.id ?? ''
    if (interviewSessionDepartmentId.value === deleted.id) setInterviewSessionDepartment('all')
    if (processDepartmentId.value === deleted.id) processDepartmentId.value = next?.id ?? ''
    persistDepartments()
    departmentDeleteDialog.value = false
    notify(removedFragments
      ? `「${deleted.name}」と紐付く作業断片${removedFragments}件を業務領域マスターから削除しました`
      : `「${deleted.name}」を業務領域マスターから削除しました`)
  }

  return {
    departmentManagerOpen,
    departmentDeleteDialog,
    editingDepartmentId,
    departmentFormError,
    departmentStages,
    departmentIconOptions,
    departmentForm,
    departmentReferences,
    linkedBusinessMasters,
    linkedProcessModels,
    reassignBusinessMasterDepartment,
    reassignProcessModelDepartment,
    selectDepartmentForEditing,
    openDepartmentManager,
    openNewDepartment,
    saveDepartment,
    requestDepartmentDeletion,
    deleteDepartment,
  }
}
