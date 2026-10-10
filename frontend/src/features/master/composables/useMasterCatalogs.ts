import { computed, ref, type Ref } from 'vue'
import type { BusinessProcessMaster, Department } from '../../../models'
import { emptyBusinessMaster } from '../business-master'

export function useMasterCatalogs(options: {
  departments: Department[]
  businessMasters: Ref<BusinessProcessMaster[]>
}) {
  const selectedBusinessId = ref('ap-invoice')
  const selectedBusinessDepartmentId = ref(options.departments[0]?.id ?? '')
  /**
   * 業務マスターは常にいずれかの業務領域を選んだ状態で表示する。領域の削除や
   * テナント切替で存在しないIDが残った場合は先頭の領域へ戻す。
   */
  const businessDepartmentId = computed({
    get: () => (options.departments.some((item) => item.id === selectedBusinessDepartmentId.value)
      ? selectedBusinessDepartmentId.value
      : options.departments[0]?.id ?? ''),
    set: (value: string) => { selectedBusinessDepartmentId.value = value },
  })
  const businessSearch = ref('')

  // 業務が0件でもテンプレートが参照できるよう、最後は空の業務を返す。
  const selectedBusiness = computed(() => (
    options.businessMasters.value.find((item) => item.id === selectedBusinessId.value)
    ?? options.businessMasters.value[0]
    ?? emptyBusinessMaster()
  ))

  const filteredBusinesses = computed(() => options.businessMasters.value.filter((item) => {
    const inDepartment = item.departmentId === businessDepartmentId.value
    const query = businessSearch.value.trim().toLowerCase()
    return inDepartment && (!query || `${item.name} ${item.code}`.toLowerCase().includes(query))
  }))

  return {
    selectedBusinessId,
    businessDepartmentId,
    businessSearch,
    selectedBusiness,
    filteredBusinesses,
  }
}
