<script setup lang="ts">
import { computed, ref } from 'vue'
import { CATEGORY_REVIEW, ECRS_LABELS } from '../../process/process-improvement'
import TaskCategoryMap from './TaskCategoryMap.vue'
import {
  DEFAULT_TASK_VALUES,
  TASK_MAP_COLUMNS,
  TASK_VALUES,
  UNCLASSIFIED,
  VALUE_HINTS,
  VOLUME_BANDS,
  classifyTaskName,
  createTask,
  hasTasks,
  summarizeTasks,
  tasksFromProcessModel,
} from '../task-categories'
import { classifyBusinessTasks } from '../../../api/process'
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore'
import type {
  BusinessProcessMaster,
  BusinessTask,
  BusinessVolumeBand,
  Department,
  ProcessModel,
  TaskCategory,
  TaskValue,
} from '../../../models'

const props = defineProps<{
  departments: Department[]
  businesses: BusinessProcessMaster[]
  processModels: Record<string, ProcessModel>
  selectedId: string
  canEdit: boolean
  focusStepIds: string[]
}>()

const emit = defineEmits<{ select: [id: string]; openAsIs: [id: string]; openImprovements: [businessId: string, stepId: string]; clearFocus: [] }>()

const { businessMasters, persistBusinessMasters, notify } = useWorkspaceStore()

const selectedTaskId = ref('')
const selectedTask = computed(() => selectedTasks.value.find((task) => task.id === selectedTaskId.value))
const selectedReview = computed(() => selectedTask.value ? CATEGORY_REVIEW[selectedTask.value.category] : null)
const mappedFocusCount = computed(() => selectedTasks.value.filter((task) => props.focusStepIds.includes(task.sourceStepId ?? '')).length)
const newTaskName = ref('')
const classifying = ref(false)
const removeConfirmId = ref('')
/** 空なら全業務領域。絞り込みはマップ・未登録一覧・一括分類の対象範囲に効く。 */
const departmentFilter = ref<string[]>([])

const UNSET_DEPARTMENT = '__unset__'

function departmentKey(business: BusinessProcessMaster) {
  return props.departments.some((department) => department.id === business.departmentId)
    ? business.departmentId
    : UNSET_DEPARTMENT
}

const departmentFilters = computed(() => {
  const counts = new Map<string, number>()
  for (const business of props.businesses) {
    const key = departmentKey(business)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const items = props.departments
    .filter((department) => counts.has(department.id))
    .map((department) => ({ id: department.id, name: department.name, count: counts.get(department.id) ?? 0 }))
  if (counts.has(UNSET_DEPARTMENT)) {
    items.push({ id: UNSET_DEPARTMENT, name: '領域未設定', count: counts.get(UNSET_DEPARTMENT) ?? 0 })
  }
  return items
})

const visibleBusinesses = computed(() => {
  if (!departmentFilter.value.length) return props.businesses
  return props.businesses.filter((business) => departmentFilter.value.includes(departmentKey(business)))
})

function toggleDepartment(id: string) {
  departmentFilter.value = departmentFilter.value.includes(id)
    ? departmentFilter.value.filter((value) => value !== id)
    : [...departmentFilter.value, id]
}

const pending = computed(() => visibleBusinesses.value.filter((business) => !hasTasks(business)))
const selected = computed(() => props.businesses.find((business) => business.id === props.selectedId))
const selectedTasks = computed(() => selected.value?.tasks ?? [])
const selectedSummary = computed(() => (selected.value ? summarizeTasks(selected.value) : null))

const unclassifiedCount = computed(
  () => visibleBusinesses.value.reduce(
    (sum, business) => sum + (business.tasks ?? []).filter((task) => task.category === UNCLASSIFIED).length,
    0,
  ),
)
const importableCount = computed(() => {
  const business = selected.value
  if (!business) return 0
  return tasksFromProcessModel(business, props.processModels[business.id], props.departments).length
})

function mutate(id: string, change: (business: BusinessProcessMaster) => void) {
  const business = businessMasters.value.find((item) => item.id === id)
  if (!business || !props.canEdit) return
  change(business)
  persistBusinessMasters()
}

function updateTasks(id: string, change: (tasks: BusinessTask[]) => BusinessTask[]) {
  mutate(id, (business) => {
    business.tasks = change(business.tasks ?? [])
  })
}

function addTask() {
  const business = selected.value
  const name = newTaskName.value.trim()
  if (!business || !name) return
  const task = createTask(name, business.departmentId || props.departments[0]?.id || '')
  updateTasks(business.id, (tasks) => [...tasks, task])
  selectedTaskId.value = task.id
  newTaskName.value = ''
}

function updateTask(taskId: string, changes: Partial<BusinessTask>) {
  const business = selected.value
  if (!business) return
  updateTasks(business.id, (tasks) => tasks.map(
    (task) => (task.id === taskId ? { ...task, ...changes } : task),
  ))
}

function setCategory(taskId: string, category: TaskCategory) {
  // 人が触れた分類は判定の印を外し、再実行で上書きされないようにする。
  updateTask(taskId, { category, mappedBy: undefined, mappedReason: undefined })
}

/** 空文字は「分類から推定」に戻す。人が決めた区分はAIの再判定で上書きしない。 */
function setValue(taskId: string, value: TaskValue | '') {
  updateTask(taskId, { value: value || undefined, valueBy: undefined, valueReason: undefined })
}

function estimatedLabel(category: TaskCategory) {
  const value = DEFAULT_TASK_VALUES[category]
  return value ? `推定:${value}` : '推定:—'
}

function isValueFixed(task: BusinessTask) {
  return !!task.value && !task.valueBy
}

function removeTask(taskId: string) {
  const business = selected.value
  if (!business) return
  updateTasks(business.id, (tasks) => tasks.filter((task) => task.id !== taskId))
  if (selectedTaskId.value === taskId) selectedTaskId.value = ''
}

function setVolumeBand(band: BusinessVolumeBand | null) {
  const business = selected.value
  if (!business || !band) return
  mutate(business.id, (target) => {
    target.volumeBand = band
  })
}

/** As-Isからの取り込みと分類はひと続きにする。取り込んだだけでは未分類が残り、使えないため。 */
async function importFromProcess() {
  const business = selected.value
  if (!business) return
  const imported = tasksFromProcessModel(business, props.processModels[business.id], props.departments)
  if (!imported.length) {
    notify('取り込めるAs-Isのステップがありませんでした')
    return
  }
  updateTasks(business.id, (tasks) => [...tasks, ...imported])
  const classified = await classifyWithAi({ silent: true })
  if (classified === null) {
    // 分類に失敗しても取り込み自体は成功している。やり直しはボタンからできる。
    notify(`${imported.length}タスクを取り込みました。AIでの分類は失敗したので「AIで分類」から試してください`)
    return
  }
  notify(`${imported.length}タスクを取り込み、${classified}件をAIで分類しました`)
}

/** マップから外す。タスクを消して未登録一覧へ戻す。 */
function removeFromMap() {
  const business = selected.value
  if (!business) return
  const count = (business.tasks ?? []).length
  updateTasks(business.id, () => [])
  selectedTaskId.value = ''
  removeConfirmId.value = ''
  notify(`${business.name}をマップから外しました（${count}タスクを削除）`)
}

/**
 * 選んだ業務のタスクをAIで分類する。業務名と業務内容を文脈として渡すので、
 * 「部長へ回す」のように名前だけでは判断できないタスクも分類できる。
 * 人が決めた分類は送信時にfixedとして伝え、上書きしない。
 */
async function classifyWithAi(options: { silent?: boolean } = {}): Promise<number | null> {
  const business = selected.value
  if (!business || classifying.value || !props.canEdit) return null
  const tasks = business.tasks ?? []
  if (!tasks.length) return 0
  classifying.value = true
  try {
    const response = await classifyBusinessTasks({
      business_name: business.name,
      business_description: business.description,
      start_condition: business.startCondition,
      end_condition: business.endCondition,
      tasks: tasks.map((task, index) => ({
        index,
        name: task.name,
        current_category: task.category,
        fixed: !task.mappedBy && task.category !== UNCLASSIFIED,
        current_value: task.value ?? null,
        value_fixed: isValueFixed(task),
      })),
    })
    const byIndex = new Map(response.items.map((item) => [item.index, item]))
    let applied = 0
    updateTasks(business.id, (current) => current.map((task, index) => {
      const result = byIndex.get(index)
      if (!result) return task
      let next = task
      // 人が決めた分類は触らない。変わらなかったタスクも印だけは更新しない。
      const categoryFixed = !task.mappedBy && task.category !== UNCLASSIFIED
      if (!categoryFixed && !(result.category === task.category && task.mappedBy === 'llm')) {
        next = { ...next, category: result.category, mappedBy: 'llm', mappedReason: result.reason }
      }
      // 価値区分も同じく、人が決めたものは触らない。
      if (result.value && !isValueFixed(task) && !(result.value === task.value && task.valueBy === 'llm')) {
        next = { ...next, value: result.value, valueBy: 'llm', valueReason: result.value_reason }
      }
      if (next !== task) applied += 1
      return next
    }))
    if (!options.silent) {
      notify(applied ? `${applied}タスクをAIで分類しました。根拠を確認して直してください` : 'AIの分類は現在の内容と同じでした')
    }
    return applied
  } catch (error) {
    if (!options.silent) notify(error instanceof Error ? error.message : 'AIでの分類に失敗しました')
    return null
  } finally {
    classifying.value = false
  }
}

/** 未分類のタスクを名前から一括で分類する。絞り込み中は表示している業務だけが対象。 */
function autoMapUnclassified() {
  let applied = 0
  for (const business of visibleBusinesses.value) {
    const targets = (business.tasks ?? []).filter((task) => task.category === UNCLASSIFIED)
    if (!targets.length) continue
    updateTasks(business.id, (tasks) => tasks.map((task) => {
      if (task.category !== UNCLASSIFIED) return task
      const category = classifyTaskName(task.name)
      if (category === UNCLASSIFIED) return task
      applied += 1
      return { ...task, category, mappedBy: 'keyword' as const }
    }))
  }
  notify(applied ? `${applied}タスクを自動で分類しました。推定なので確認してください` : '名前から分類できるタスクがありませんでした')
}

function selectTask(businessId: string, taskId: string) {
  if (businessId !== props.selectedId) emit('select', businessId)
  selectedTaskId.value = taskId
}

function selectBusiness(id: string) {
  emit('select', id)
  selectedTaskId.value = ''
  removeConfirmId.value = ''
}

function departmentName(departmentId: string) {
  return props.departments.find((department) => department.id === departmentId)?.name || '部門未設定'
}
</script>

<template>
  <section class="page business-map-page">
    <div class="page-heading page-heading--compact">
      <div>
        <div class="eyebrow">TASK CATEGORY LANDSCAPE</div>
        <h1>業務マップ</h1>
        <p>
          業務ごとのタスクを作業・確認・登録・伝達・手戻りの5分類へ並べ、どの分類に手間が溜まっているかを見ます。
          分類ごとにECRSの問いで見直します。タスク数の割合は工数や削減可能率を表しません。工程順序はAs-Isフローで確認します。
        </p>
      </div>
      <div class="heading-actions">
        <v-btn
          v-if="canEdit && unclassifiedCount"
          variant="outlined"
          prepend-icon="mdi-auto-fix"
          @click="autoMapUnclassified"
        >未分類{{ unclassifiedCount }}件を自動分類</v-btn>
      </div>
    </div>

    <div v-if="departmentFilters.length > 1" class="task-filter">
      <span>業務領域</span>
      <button
        type="button"
        :class="{ active: !departmentFilter.length }"
        @click="departmentFilter = []"
      >すべて（{{ businesses.length }}）</button>
      <button
        v-for="item in departmentFilters"
        :key="item.id"
        type="button"
        :class="{ active: departmentFilter.includes(item.id) }"
        @click="toggleDepartment(item.id)"
      >{{ item.name }}（{{ item.count }}）</button>
    </div>

    <div class="task-layout">
      <section class="panel task-panel">
        <TaskCategoryMap
          :businesses="visibleBusinesses"
          :selected-task-id="selectedTaskId"
          :focus-step-ids="focusStepIds"
          :focus-business-id="selectedId"
          @select-task="selectTask"
          @select-business="selectBusiness"
        />
      </section>

      <aside class="panel task-editor">
        <div class="panel__header">
          <div>
            <h2>タスクの登録</h2>
            <p v-if="!selected">マップの行、または下の未登録一覧から業務を選ぶと登録できます。</p>
            <p v-else>{{ selected.code }}・{{ departmentName(selected.departmentId) }}</p>
          </div>
        </div>

        <template v-if="selected">
          <v-alert v-if="focusStepIds.length" type="info">改善案の対象{{ focusStepIds.length }}工程のうち、マップにある{{ mappedFocusCount }}タスクを強調しています。未取り込みの工程はAs-Isから取り込めます。<v-btn variant="text" @click="emit('clearFocus')">強調を解除</v-btn></v-alert>
          <section v-if="selectedTask && selectedReview" class="improvement-map-prompt">
            <b>{{ selectedTask.name }}の見直し</b>
            <p>{{ selectedReview.principle }} {{ ECRS_LABELS[selectedReview.principle] }}：{{ selectedReview.question }}</p>
            <p>{{ selectedReview.change }}</p>
            <v-btn v-if="selectedTask.sourceStepId && processModels[selected.id]?.steps.some(step => step.id === selectedTask?.sourceStepId)" color="primary" variant="outlined" @click="emit('openImprovements', selected.id, selectedTask.sourceStepId)">このタスクの改善案を開く</v-btn>
            <p v-else>このタスクはAs-Is工程に紐付いていません。As-Isを整備して取り込むと、工程ごとの改善案を開けます。</p>
          </section>
          <h3 class="task-editor__name">{{ selected.name }}</h3>
          <p v-if="selectedSummary && selectedSummary.total" class="task-editor__summary">
            全{{ selectedSummary.total }}タスク・削減候補 {{ Math.round(selectedSummary.wasteRatio * 100) }}%
            <template v-if="selectedSummary.byCategory[UNCLASSIFIED].length">
              ・未分類 {{ selectedSummary.byCategory[UNCLASSIFIED].length }}
            </template>
          </p>

          <div v-if="canEdit" class="task-editor__add">
            <input
              v-model="newTaskName"
              type="text"
              placeholder="タスク名（例：購買申請の起票）"
              aria-label="タスク名"
              @keyup.enter="addTask"
            >
            <button type="button" :disabled="!newTaskName.trim()" @click="addTask">
              <v-icon size="16">mdi-plus</v-icon>追加
            </button>
          </div>
          <p v-if="canEdit" class="task-editor__note">
            <v-icon size="14">mdi-auto-fix</v-icon>追加すると名前から分類を自動判定します。違っていれば下で直してください。
          </p>

          <div class="task-editor__tools">
            <v-btn
              v-if="canEdit && importableCount"
              variant="tonal"
              size="small"
              prepend-icon="mdi-import"
              :loading="classifying"
              @click="importFromProcess"
            >As-Isから{{ importableCount }}タスク取り込んで分類</v-btn>
            <v-btn
              v-if="canEdit && selectedTasks.length"
              variant="tonal"
              size="small"
              color="primary"
              prepend-icon="mdi-brain"
              :loading="classifying"
              @click="classifyWithAi"
            >AIで分類</v-btn>
          </div>
          <p v-if="canEdit && selectedTasks.length" class="task-editor__note">
            <v-icon size="14">mdi-information-outline</v-icon>
            AIには業務名と業務内容を渡し、分類と価値区分（付加価値・必要・削減候補）を判断させます。人が決めたものは変えません。
          </p>

          <div v-if="selectedTasks.length" class="task-editor__rows">
            <div
              v-for="task in selectedTasks"
              :key="task.id"
              class="task-editor__row"
              :class="{ selected: task.id === selectedTaskId }"
            >
              <button
                type="button"
                class="task-editor__row-name"
                :title="[task.name, task.mappedReason, task.valueReason].filter(Boolean).join('／')"
                @click="selectedTaskId = task.id"
              >
                {{ task.name }}
                <em v-if="task.mappedBy === 'llm'" class="llm">AI</em>
                <em v-else-if="task.mappedBy === 'keyword'">推定</em>
              </button>
              <select
                :value="task.category"
                :disabled="!canEdit"
                aria-label="分類"
                @change="setCategory(task.id, ($event.target as HTMLSelectElement).value as TaskCategory)"
              >
                <option v-for="category in TASK_MAP_COLUMNS" :key="category" :value="category">{{ category }}</option>
              </select>
              <select
                :value="task.value ?? ''"
                :disabled="!canEdit"
                aria-label="価値区分"
                :title="task.value ? VALUE_HINTS[task.value] : '分類からの推定。業務の目的に照らして直してください'"
                :class="{ estimated: !task.value, llm: task.valueBy === 'llm' }"
                @change="setValue(task.id, ($event.target as HTMLSelectElement).value as TaskValue | '')"
              >
                <option value="">{{ estimatedLabel(task.category) }}</option>
                <option v-for="value in TASK_VALUES" :key="value" :value="value">{{ value }}</option>
              </select>
              <button type="button" aria-label="削除" :disabled="!canEdit" @click="removeTask(task.id)">
                <v-icon size="16">mdi-close</v-icon>
              </button>
            </div>
          </div>
          <p v-else class="task-editor__empty">まだタスクがありません。上の入力欄から追加してください。</p>

          <v-select
            :model-value="selected.volumeBand ?? '未確認'"
            :items="VOLUME_BANDS"
            label="発生量"
            density="comfortable"
            :disabled="!canEdit"
            hint="正確な件数は測れないため、大・中・小の感覚値で優先順位を付けます。"
            persistent-hint
            @update:model-value="setVolumeBand"
          ></v-select>

          <div class="task-editor__footer">
            <v-btn variant="outlined" size="small" prepend-icon="mdi-open-in-new" @click="emit('openAsIs', selected.id)">As-Isを開く</v-btn>
            <v-btn v-if="processModels[selected.id]" variant="outlined" size="small" prepend-icon="mdi-lightbulb-on-outline" @click="emit('openImprovements', selected.id, '')">業務全体の改善案</v-btn>
            <v-spacer></v-spacer>
            <template v-if="canEdit && selectedTasks.length">
              <template v-if="removeConfirmId === selected.id">
                <span class="task-editor__confirm">{{ selectedTasks.length }}タスクを削除します</span>
                <v-btn variant="text" size="small" @click="removeConfirmId = ''">やめる</v-btn>
                <v-btn variant="tonal" size="small" color="error" @click="removeFromMap">外す</v-btn>
              </template>
              <v-btn
                v-else
                variant="text"
                size="small"
                prepend-icon="mdi-close-circle-outline"
                @click="removeConfirmId = selected.id"
              >マップから外す</v-btn>
            </template>
          </div>
        </template>
      </aside>
    </div>

    <section v-if="pending.length" class="panel task-pending">
      <div class="panel__header">
        <div>
          <h2>タスク未登録の業務（{{ pending.length }}）</h2>
          <p>「この業務、どんなタスクがありますか」と聞いて埋めていきます。全業務を埋める必要はなく、量の多い業務から入れてください。</p>
        </div>
      </div>
      <div class="task-pending__items">
        <button
          v-for="business in pending"
          :key="business.id"
          type="button"
          :class="{ active: business.id === selectedId }"
          @click="selectBusiness(business.id)"
        >
          <b>{{ business.name }}</b>
          <small>{{ departmentName(business.departmentId) }}</small>
        </button>
      </div>
    </section>
  </section>
</template>
