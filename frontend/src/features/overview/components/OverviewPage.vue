<script setup lang="ts">
import { computed } from 'vue'
import type { BusinessProcessMaster, Department, ProcessModel, TaskCategory } from '../../../models'
import { CATEGORY_SLUGS, TASK_CATEGORIES, TASK_MAP_COLUMNS, UNCLASSIFIED } from '../../master/task-categories'
import { summarizeTaskCategoriesByDepartment, totalTaskCategories } from '../task-category-summary'

const props = defineProps<{
  departments: Department[]
  businessMasters: BusinessProcessMaster[]
  processModels: Record<string, ProcessModel>
  canEdit: boolean
}>()

/** 工程が1つ以上あるAs-Isだけを「作成済み」と数える。開始・終了だけの初期フローは含めない。 */
const createdAsIsModels = computed(() => {
  const businessIds = new Set(props.businessMasters.map((business) => business.id))
  return Object.values(props.processModels).filter((model) => (
    businessIds.has(model.businessId) && model.steps.some((step) => step.type === 'task')
  ))
})
const createdAsIsTaskCount = computed(() => createdAsIsModels.value.reduce(
  (sum, model) => sum + model.steps.filter((step) => step.type === 'task').length,
  0,
))

const categoryRows = computed(() => summarizeTaskCategoriesByDepartment(props.departments, props.businessMasters))
const categoryTotals = computed(() => totalTaskCategories(categoryRows.value))
const totalTasks = computed(() => categoryRows.value.reduce((sum, row) => sum + row.taskCount, 0))
const totalBusinesses = computed(() => categoryRows.value.reduce((sum, row) => sum + row.businessCount, 0))

function categoryClass(category: TaskCategory) {
  return `task-cat--${CATEGORY_SLUGS[category]}`
}

function categoryShare(count: number, total: number) {
  return total ? `${Math.round((count / total) * 100)}%` : '0%'
}

const emit = defineEmits<{
  startGuidedInterview: []
  startDiscoveryInterview: []
}>()
</script>

<template>
  <section class="page page--overview">
    <div class="page-heading">
      <div>
        <div class="eyebrow">BUSINESS ANALYSIS DASHBOARD</div>
        <h1>業務調査の現在地</h1>
        <p>部門横断のヒアリングとAs-Isプロセスを一つの場所で確認します。</p>
      </div>
      <div class="heading-actions">
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-clipboard-list-outline" :disabled="!canEdit || departments.length === 0" @click="emit('startGuidedInterview')">
          観点を選んで開始
        </v-btn>
        <v-btn color="primary" prepend-icon="mdi-radar" :disabled="!canEdit || departments.length === 0" @click="emit('startDiscoveryInterview')">
          自由探索で開始
        </v-btn>
      </div>
    </div>

    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-card__top">
          <span>作成したAs-Is</span>
          <div class="metric-icon metric-icon--blue"><v-icon>mdi-vector-square</v-icon></div>
        </div>
        <div class="metric-main"><strong>{{ createdAsIsModels.length }}</strong><span>プロセス</span></div>
        <div class="metric-split"><span><b>{{ businessMasters.length }}</b> 業務中</span><span><b>{{ createdAsIsTaskCount }}</b> 工程</span></div>
      </article>
    </div>

    <section class="panel overview-task-summary">
      <div class="panel__header">
        <div>
          <h2>業務領域別 タスク分類</h2>
          <p>業務マップのタスクを、業務が所属する領域ごとに集計しています。</p>
        </div>
        <div class="overview-task-summary__stats" aria-label="集計概要">
          <span><b>{{ totalBusinesses }}</b>業務</span>
          <span><b>{{ totalTasks }}</b>タスク</span>
          <span v-if="categoryTotals[UNCLASSIFIED]" class="overview-task-summary__unclassified">
            未分類 <b>{{ categoryTotals[UNCLASSIFIED] }}</b>
          </span>
        </div>
      </div>

      <div v-if="departments.length" class="overview-task-matrix-scroll">
        <div class="overview-task-matrix">
          <div class="overview-task-matrix__row overview-task-matrix__head">
            <span>業務領域</span>
            <span
              v-for="category in TASK_CATEGORIES"
              :key="category"
              :class="categoryClass(category)"
            >{{ category }}</span>
            <span :class="categoryClass(UNCLASSIFIED)">未分類</span>
            <span>合計</span>
          </div>

          <div v-for="row in categoryRows" :key="row.department.id" class="overview-task-matrix__row">
            <div class="overview-task-matrix__area">
              <i :style="{ background: row.department.color + '18', color: row.department.color }">
                <v-icon size="18">{{ row.department.icon }}</v-icon>
              </i>
              <span>
                <b>{{ row.department.name }}</b>
                <small>{{ row.businessCount }}業務</small>
              </span>
            </div>
            <div
              v-for="category in TASK_MAP_COLUMNS"
              :key="category"
              class="overview-task-matrix__count"
              :class="[categoryClass(category), { empty: row.byCategory[category] === 0 }]"
              :title="`${row.department.name}｜${category} ${row.byCategory[category]}件（${categoryShare(row.byCategory[category], row.taskCount)}）`"
            >
              <b>{{ row.byCategory[category] }}</b>
              <small>{{ categoryShare(row.byCategory[category], row.taskCount) }}</small>
            </div>
            <div class="overview-task-matrix__total"><b>{{ row.taskCount }}</b><small>タスク</small></div>
          </div>

          <div class="overview-task-matrix__row overview-task-matrix__footer">
            <span>全領域</span>
            <span v-for="category in TASK_MAP_COLUMNS" :key="category" :class="categoryClass(category)">
              <b>{{ categoryTotals[category] }}</b>
            </span>
            <span><b>{{ totalTasks }}</b></span>
          </div>
        </div>
      </div>
      <div v-else class="overview-task-summary__empty">
        <v-icon>mdi-table-off</v-icon>
        <span>業務領域を登録すると、分類別の件数を表示します。</span>
      </div>
    </section>
  </section>
</template>
