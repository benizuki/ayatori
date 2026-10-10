<script setup lang="ts">
import { computed } from 'vue'
import {
  CATEGORY_ACTIONS,
  CATEGORY_HINTS,
  CATEGORY_SLUGS,
  TASK_CATEGORIES,
  TASK_MAP_COLUMNS,
  TASK_VALUES,
  UNCLASSIFIED,
  VALUE_HINTS,
  VALUE_SLUGS,
  emptyValueCounts,
  harvestScore,
  summarizeTasks,
  taskValue,
} from '../task-categories'
import type { BusinessProcessMaster, BusinessTask, TaskCategory, TaskValue } from '../../../models'

const props = defineProps<{
  businesses: BusinessProcessMaster[]
  selectedTaskId: string
  focusStepIds: string[]
  focusBusinessId: string
}>()

const emit = defineEmits<{ selectTask: [businessId: string, taskId: string]; selectBusiness: [id: string] }>()

const rows = computed(() => props.businesses
  .map(summarizeTasks)
  .filter((summary) => summary.total > 0)
  .sort((left, right) => harvestScore(right) - harvestScore(left) || right.total - left.total))

const columnTotals = computed(() => {
  const totals = Object.fromEntries(TASK_MAP_COLUMNS.map((category) => [category, 0])) as Record<TaskCategory, number>
  for (const row of rows.value) {
    for (const category of TASK_MAP_COLUMNS) totals[category] += row.byCategory[category].length
  }
  return totals
})

const valueTotals = computed(() => {
  const totals = emptyValueCounts()
  for (const row of rows.value) {
    for (const value of TASK_VALUES) totals[value] += row.byValue[value]
  }
  return totals
})

const totalTasks = computed(() => rows.value.reduce((sum, row) => sum + row.total, 0))
const judgedTasks = computed(() => rows.value.reduce((sum, row) => sum + row.judged, 0))

/** 価値区分が決まっているうち削減候補が占める割合。1つの数字で刈り取りシロの大きさを示す。 */
const overallWaste = computed(() => (judgedTasks.value ? valueTotals.value.削減候補 / judgedTasks.value : 0))

const maxColumn = computed(() => Math.max(1, ...TASK_CATEGORIES.map((category) => columnTotals.value[category])))

const gridStyle = computed(() => ({
  gridTemplateColumns: `190px repeat(${TASK_MAP_COLUMNS.length}, 152px) 84px`,
}))

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

function categoryClass(category: TaskCategory) {
  return `task-cat--${CATEGORY_SLUGS[category]}`
}

function valueClass(value: TaskValue | null) {
  return value ? `task-val--${VALUE_SLUGS[value]}` : ''
}

function chipTitle(task: BusinessTask) {
  const value = taskValue(task)
  const parts = [task.name]
  if (value) parts.push(`${value}${task.value ? '' : '（分類から推定）'}`)
  if (task.mappedReason) parts.push(`AIの分類根拠: ${task.mappedReason}`)
  if (task.valueReason) parts.push(`AIの価値判断: ${task.valueReason}`)
  return parts.join('／')
}
</script>

<template>
  <div class="task-map">
    <div v-if="!rows.length" class="task-map__empty">
      <v-icon size="26">mdi-table-large-plus</v-icon>
      <span>タスクを登録すると、ここに分類別のマップが出ます。右の一覧から業務を選んでください。</span>
    </div>

    <template v-else>
      <div class="task-map__headline">
        <article>
          <small>タスク総数</small><b>{{ totalTasks }}</b>
          <em v-if="columnTotals[UNCLASSIFIED]">未分類 {{ columnTotals[UNCLASSIFIED] }}</em>
        </article>
        <article class="task-map__headline--accent">
          <small>削減候補の割合</small><b>{{ percent(overallWaste) }}</b>
          <em>
            <template v-for="value in TASK_VALUES" :key="`value-${value}`">
              <span class="task-map__value" :class="valueClass(value)" :title="VALUE_HINTS[value]">{{ value }} {{ valueTotals[value] }}</span>
            </template>
          </em>
          <em>タスク数の構成比（工数比ではありません）</em>
        </article>
        <article
          v-for="category in TASK_CATEGORIES"
          :key="`total-${category}`"
          class="task-map__headline--bar"
          :class="categoryClass(category)"
        >
          <small>{{ category }}</small>
          <b>{{ columnTotals[category] }}</b>
          <span><i :style="{ width: `${(columnTotals[category] / maxColumn) * 100}%` }"></i></span>
        </article>
      </div>

      <div class="task-map__scroll">
        <div class="task-grid" :style="gridStyle">
          <div class="task-grid__corner">業務 ／ 分類</div>
          <div
            v-for="category in TASK_MAP_COLUMNS"
            :key="`head-${category}`"
            class="task-grid__head"
            :class="categoryClass(category)"
            :title="CATEGORY_HINTS[category]"
          >
            <b>{{ category }}</b>
            <small>{{ columnTotals[category] }}</small>
          </div>
          <div class="task-grid__head task-grid__head--metric" title="価値区分が決まっているタスクのうち、削減候補の割合">削減候補</div>

          <template v-for="row in rows" :key="row.business.id">
            <div class="task-grid__row-head" @click="emit('selectBusiness', row.business.id)">
              <b>{{ row.business.name }}</b>
              <small>
                {{ row.total }}タスク
                <template v-if="row.business.volumeBand && row.business.volumeBand !== '未確認'">
                  ・量{{ row.business.volumeBand }}
                </template>
              </small>
            </div>
            <div
              v-for="category in TASK_MAP_COLUMNS"
              :key="`${row.business.id}-${category}`"
              class="task-grid__cell"
              :class="categoryClass(category)"
            >
              <button
                v-for="task in row.byCategory[category]"
                :key="task.id"
                type="button"
                class="task-chip"
                :class="[categoryClass(category), valueClass(taskValue(task)), { selected: task.id === selectedTaskId || (row.business.id === focusBusinessId && focusStepIds.includes(task.sourceStepId ?? '')), auto: !!task.mappedBy }]"
                :title="chipTitle(task)"
                @click="emit('selectTask', row.business.id, task.id)"
              >{{ task.name }}</button>
            </div>
            <div class="task-grid__metric" :class="{ high: row.wasteRatio >= 0.5 }">
              {{ row.judged ? percent(row.wasteRatio) : '—' }}
            </div>
          </template>
        </div>
      </div>

      <ul class="task-map__actions">
        <li v-for="category in TASK_CATEGORIES" :key="`action-${category}`">
          <b :class="categoryClass(category)">{{ category }}</b>
          <span>{{ CATEGORY_ACTIONS[category] }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>
