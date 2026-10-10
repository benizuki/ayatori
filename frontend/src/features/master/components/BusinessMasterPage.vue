<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { businessDepth, businessRelationTypes } from '../process-hierarchy'
import type { BusinessProcessMaster, BusinessProcessRelation, BusinessProcessRelationType, Department, ProcessModel } from '../../../models'
import type { BusinessFlowImportJob } from '../../../api/imports'
import BusinessFlowImportDialog from './BusinessFlowImportDialog.vue'

const props = defineProps<{
  departments: Department[]
  businessMasters: BusinessProcessMaster[]
  processModels: Record<string, ProcessModel>
  filteredBusinesses: BusinessProcessMaster[]
  selectedBusiness: BusinessProcessMaster
  selectedBusinessId: string
  selectedAsIsModel: ProcessModel | null
  asIsBusinessCount: number
  asIsTaskCount: number
  canEdit: boolean
  validParentBusinesses: BusinessProcessMaster[]
  selectedBusinessRelations: BusinessProcessRelation[]
}>()

const departmentId = defineModel<string>('departmentId', { required: true })
const search = defineModel<string>('search', { required: true })
const business = toRef(props, 'selectedBusiness')
const asIsModel = toRef(props, 'selectedAsIsModel')
const relationTargetId = ref('')
const relationType = ref<BusinessProcessRelationType>('前後工程')
const relationLabel = ref('')
const importDialog = ref(false)
const activeTab = ref<'basic' | 'relations' | 'asis'>('basic')
const tabs = computed(() => [
  { key: 'basic' as const, label: '基本情報', icon: 'mdi-card-text-outline', badge: undefined },
  { key: 'relations' as const, label: '業務間の関連', icon: 'mdi-transit-connection-variant', badge: props.selectedBusinessRelations.length },
  { key: 'asis' as const, label: 'As-Isプロセス', icon: 'mdi-sitemap-outline', badge: undefined },
])
const businessCountByDepartment = computed(() => {
  const counts: Record<string, number> = {}
  props.businessMasters.forEach((item) => { counts[item.departmentId] = (counts[item.departmentId] ?? 0) + 1 })
  return counts
})
// 業務領域が多いと横に収まらないため、6件を超えたら選択式にする。
const areaAsSelect = computed(() => props.departments.length > 6)
const areaItems = computed(() => props.departments.map((department) => ({
  title: `${department.name}（${businessCountByDepartment.value[department.id] ?? 0}）`,
  value: department.id,
})))
const hierarchyLevel = computed(() => businessDepth(business.value, props.businessMasters))
const parentItems = computed(() => [
  { title: '最上位業務（親なし）', value: '' },
  ...props.validParentBusinesses.map((item) => ({ title: `${item.code}｜${item.name}`, value: item.id })),
])
const relationTargetItems = computed(() => props.businessMasters
  .filter((item) => item.id !== business.value.id)
  .map((item) => ({ title: `${item.code}｜${item.name}`, value: item.id })))

const emit = defineEmits<{
  manageDepartments: []
  add: []
  select: [id: string]
  openAsIs: []
  delete: []
  startInterview: [id: string]
  save: []
  addRelation: [toBusinessId: string, type: BusinessProcessRelationType, label: string, fromBusinessId?: string]
  deleteRelation: [id: string]
  applyImport: [job: BusinessFlowImportJob]
}>()

function isInterviewGenerated(model?: ProcessModel) {
  return Boolean(model && (model.sourceType === 'interview' || model.sourceType === 'document' || model.sourceInterviewId))
}

function taskCount(model?: ProcessModel) {
  return model?.steps.filter((step) => step.type === 'task').length ?? 0
}

function processStatus(model?: ProcessModel) {
  if (!model) return 'As-Is未作成'
  return isInterviewGenerated(model) ? 'As-Is作成済み' : '初期モデル'
}

function businessName(id: string) {
  return props.businessMasters.find((item) => item.id === id)?.name ?? '削除済み業務'
}

function addRelation() {
  if (!relationTargetId.value) return
  emit('addRelation', relationTargetId.value, relationType.value, relationLabel.value)
  relationTargetId.value = ''
  relationLabel.value = ''
}
</script>

<template>
  <section class="page master-page">
    <header class="bm-bar">
      <h1>業務マスター</h1>
      <ul class="bm-stats" aria-label="登録状況">
        <li><v-icon size="18">mdi-file-tree-outline</v-icon><b>{{ businessMasters.length }}</b>登録業務</li>
        <li class="bm-stats__mint"><v-icon size="18">mdi-transit-connection-variant</v-icon><b>{{ asIsBusinessCount }}</b>As-Is紐付け済み</li>
        <li class="bm-stats__orange"><v-icon size="18">mdi-checkbox-marked-outline</v-icon><b>{{ asIsTaskCount }}</b>As-Isタスク</li>
      </ul>
      <span class="bm-bar__hint" role="img" aria-label="ここに登録した業務が、業務指定ヒアリングの対象候補になります。" title="ここに登録した業務が、業務指定ヒアリングの対象候補になります。"><v-icon size="18">mdi-information-outline</v-icon></span>
      <div class="heading-actions"><v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" :disabled="!props.canEdit || departments.length === 0" @click="importDialog = true">資料からAs-Is生成</v-btn><v-btn variant="outlined" prepend-icon="mdi-domain" :disabled="!props.canEdit" @click="emit('manageDepartments')">業務領域を管理</v-btn><v-btn color="primary" prepend-icon="mdi-plus" :disabled="!props.canEdit || departments.length === 0" @click="emit('add')">業務を追加</v-btn></div>
    </header>

    <div class="bm-workspace">
      <aside class="panel master-catalog bm-side">
        <v-select
          v-if="areaAsSelect"
          v-model="departmentId"
          :items="areaItems"
          label="業務領域"
          class="bm-areas-select"
          density="compact"
          hide-details
        ></v-select>
        <div v-else class="bm-areas" role="group" aria-label="業務領域">
          <button
            v-for="department in departments"
            :key="department.id"
            type="button"
            :class="{ active: departmentId === department.id }"
            :aria-pressed="departmentId === department.id"
            :title="`${department.name}（調査中 ${department.processes}）`"
            @click="departmentId = department.id"
          >
            <v-icon size="16" :style="{ color: department.color }">{{ department.icon }}</v-icon>
            <span>{{ department.name }}</span>
            <em>{{ businessCountByDepartment[department.id] ?? 0 }}</em>
          </button>
          <span v-if="departments.length === 0" class="bm-areas__empty">業務領域がありません</span>
        </div>
        <div class="master-pane-title"><span>業務一覧</span><em>{{ filteredBusinesses.length }}件</em></div>
        <v-text-field
          v-model="search"
          placeholder="業務名・コードを検索"
          prepend-inner-icon="mdi-magnify"
          class="master-search-field"
          density="compact"
          hide-details
        ></v-text-field>
        <div class="catalog-list">
          <button v-for="item in filteredBusinesses" :key="item.id" :class="{ active: selectedBusinessId === item.id }" @click="emit('select', item.id)">
            <div class="catalog-item__top"><em :class="{ draft: item.status === '作成中' }">{{ item.status }}</em></div>
            <b>{{ item.name }}</b><small>{{ item.code }}</small>
            <div class="catalog-item__meta"><span><v-icon size="14">mdi-transit-connection-variant</v-icon>{{ processStatus(processModels[item.id]) }}</span><span :class="`fit fit--${item.sapScope}`">{{ taskCount(processModels[item.id]) }}タスク</span></div>
          </button>
          <div v-if="filteredBusinesses.length === 0" class="catalog-empty"><v-icon>mdi-database-search-outline</v-icon><span>一致する業務がありません</span></div>
        </div>
      </aside>

      <section v-if="businessMasters.length === 0" class="panel master-editor">
        <div v-if="departments.length === 0" class="asis-master-empty"><v-icon size="28">mdi-domain-off</v-icon><div><b>業務領域が登録されていません</b><span>「業務領域を管理」から業務領域を追加すると、業務を登録できます。</span></div><button class="save-button" :disabled="!props.canEdit" @click="emit('manageDepartments')">業務領域を管理</button></div>
        <div v-else class="asis-master-empty"><v-icon size="28">mdi-file-tree-outline</v-icon><div><b>業務が登録されていません</b><span>「業務を追加」から調査対象の業務を登録してください。</span></div><button class="save-button" :disabled="!props.canEdit" @click="emit('add')">業務を追加</button></div>
      </section>

      <section v-else class="panel master-editor bm-editor">
        <header class="master-editor__header">
          <div class="business-title-edit"><span :style="{ background: departments.find((item) => item.id === business.departmentId)?.color + '18', color: departments.find((item) => item.id === business.departmentId)?.color }"><v-icon>{{ departments.find((item) => item.id === business.departmentId)?.icon }}</v-icon></span><div><small>{{ departments.find((item) => item.id === business.departmentId)?.name }} / {{ business.category }}</small><input v-model="business.name" aria-label="業務名" :readonly="!props.canEdit" /></div></div>
          <div class="editor-actions">
            <v-select
              v-model="business.status"
              :items="['作成中', '作成完了']"
              :disabled="!props.canEdit"
              label="作成状態"
              class="publish-control-field"
              density="compact"
              hide-details
            ></v-select>
            <button class="preview-button" :disabled="!props.canEdit" title="この業務を対象にヒアリングを開始" @click="emit('startInterview', business.id)"><v-icon size="17">mdi-message-processing-outline</v-icon>ヒアリング</button>
            <button class="preview-button asis-confirm-button" @click="emit('openAsIs')"><v-icon size="17">mdi-check-circle-outline</v-icon>As-Is確認</button>
            <button class="save-button" :disabled="!props.canEdit" @click="emit('save')"><v-icon size="17">mdi-content-save-outline</v-icon>変更を保存</button>
            <v-menu location="bottom end" :close-on-content-click="true">
              <template #activator="{ props: menu }">
                <button v-bind="menu" type="button" class="bm-more-button" title="その他の操作" aria-label="その他の操作"><v-icon size="20">mdi-dots-horizontal</v-icon></button>
              </template>
              <div class="bm-more-menu">
                <button class="delete-business-button" :disabled="!props.canEdit" title="この業務を削除" @click="emit('delete')"><v-icon size="17">mdi-trash-can-outline</v-icon>削除</button>
              </div>
            </v-menu>
          </div>
        </header>

        <nav class="bm-tabs" role="tablist" aria-label="業務マスターの区画">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            role="tab"
            :class="{ active: activeTab === tab.key }"
            :aria-selected="activeTab === tab.key"
            @click="activeTab = tab.key"
          ><v-icon size="18">{{ tab.icon }}</v-icon>{{ tab.label }}<em v-if="tab.badge !== undefined">{{ tab.badge }}</em></button>
          <span class="bm-tabs__meta">最終更新 {{ business.updatedAt }}</span>
        </nav>

        <div class="master-editor__body bm-body" role="tabpanel">
          <div v-if="activeTab === 'basic'" class="bm-form">
            <div v-if="business.sourceFragmentIds?.length" class="master-provenance"><span><v-icon>mdi-text-box-search-outline</v-icon></span><div><b>ヒアリングから生成したAs-Isマスター</b><small>成熟度 {{ business.maturity }}｜根拠となる作業断片 {{ business.sourceFragmentIds.length }}件｜業務バリエーション {{ business.variants?.length ?? 0 }}件</small></div></div>
            <div class="bm-form__ids">
              <v-text-field v-model="business.code" label="業務コード" :readonly="!props.canEdit" density="comfortable" hide-details></v-text-field>
              <v-select
                v-model="business.departmentId"
                :items="departments"
                item-title="name"
                item-value="id"
                label="業務領域"
                :disabled="!props.canEdit"
                density="comfortable"
                hide-details
              ></v-select>
              <v-select
                v-model="business.parentId"
                :items="parentItems"
                label="親業務"
                :disabled="!props.canEdit"
                density="comfortable"
                hide-details
              ></v-select>
              <div class="hierarchy-level-display"><span>階層レベル</span><b>L{{ hierarchyLevel }}</b><small>{{ hierarchyLevel === 0 ? '全体・上位業務' : hierarchyLevel === 1 ? '業務コンポーネント' : '詳細・下位業務' }}</small></div>
            </div>
            <div class="bm-form__text">
              <v-textarea v-model="business.description" label="業務の説明" :readonly="!props.canEdit" variant="outlined" density="comfortable" rows="8" no-resize hide-details></v-textarea>
              <div class="bm-form__conditions">
                <v-textarea v-model="business.startCondition" label="開始条件" :readonly="!props.canEdit" variant="outlined" density="comfortable" rows="3" no-resize hide-details></v-textarea>
                <v-textarea v-model="business.endCondition" label="終了条件" :readonly="!props.canEdit" variant="outlined" density="comfortable" rows="3" no-resize hide-details></v-textarea>
              </div>
            </div>
          </div>

          <div v-else-if="activeTab === 'relations'" class="bm-relations">
            <section class="business-relation-editor">
              <header><div><h3>業務間の関連</h3><p>親子階層とは別に、前後工程・例外・データ連携などを管理します。</p></div><span>{{ selectedBusinessRelations.length }}件</span></header>
              <div v-if="selectedBusinessRelations.length" class="business-relation-list">
                <article v-for="relation in selectedBusinessRelations" :key="relation.id">
                  <span>{{ relation.fromBusinessId === business.id ? '接続先' : '接続元' }}</span>
                  <b>{{ businessName(relation.fromBusinessId === business.id ? relation.toBusinessId : relation.fromBusinessId) }}</b>
                  <em>{{ relation.type }}</em>
                  <small>{{ relation.label || '補足なし' }}</small>
                  <button :disabled="!props.canEdit" title="関連を削除" @click="emit('deleteRelation', relation.id)"><v-icon size="16">mdi-close</v-icon></button>
                </article>
              </div>
              <div v-else class="business-relation-empty">この業務の前後・例外・バリエーションはまだ登録されていません。</div>
              <div class="business-relation-add">
                <v-select v-model="relationTargetId" :items="relationTargetItems" label="接続先業務" :disabled="!props.canEdit" density="compact" hide-details></v-select>
                <v-select v-model="relationType" :items="businessRelationTypes" label="関連種別" :disabled="!props.canEdit" density="compact" hide-details></v-select>
                <v-text-field v-model="relationLabel" label="補足（任意）" :readonly="!props.canEdit" density="compact" hide-details></v-text-field>
                <button class="save-button" :disabled="!props.canEdit || !relationTargetId" @click="addRelation"><v-icon size="16">mdi-link-plus</v-icon>追加</button>
              </div>
            </section>
          </div>

          <div v-else class="bm-asis">
            <div class="bm-asis__state">
              <b>{{ processStatus(asIsModel ?? undefined) }}</b>
              <span>業務マスターはAs-Isを参照します</span>
              <span v-if="asIsModel" class="master-asis-lanes"><span v-for="lane in asIsModel.lanes ?? []" :key="lane">{{ lane }}</span></span>
              <em v-if="asIsModel" class="bm-asis__review-status">{{ asIsModel.reviewStatus }}</em>
            </div>
            <div v-if="asIsModel" class="asis-master-card">
              <div class="asis-master-metrics">
                <div><b>{{ taskCount(asIsModel) }}</b><span>タスク</span></div>
                <div><b>{{ asIsModel.connections.length }}</b><span>接続</span></div>
                <div><b>{{ asIsModel.assets?.length ?? 0 }}</b><span>アセット</span></div>
                <div><b>{{ asIsModel.lanes?.length ?? 0 }}</b><span>レーン</span></div>
              </div>
              <div class="asis-master-summary"><span><v-icon size="17">mdi-text-box-outline</v-icon></span><div><b>{{ asIsModel.title }}</b><p>{{ asIsModel.summary || business.description || 'As-Isの概要は未確認です。' }}</p></div></div>
              <div class="bm-asis__cols" :class="{ 'bm-asis__cols--single': !asIsModel.assets?.length && !asIsModel.reviewItems?.length }">
                <div class="asis-master-flow"><div><b>業務フロー</b><small>保存されているAs-Isのタスク順序</small></div><ol><li v-for="step in asIsModel.steps.filter((item) => item.type === 'task').slice(0, 8)" :key="step.id"><span>{{ step.actor || '担当未確認' }}</span><b>{{ step.label }}</b></li></ol><small v-if="taskCount(asIsModel) > 8">ほか{{ taskCount(asIsModel) - 8 }}タスク</small></div>
                <div v-if="asIsModel.assets?.length || asIsModel.reviewItems?.length" class="bm-asis__side">
                  <div v-if="asIsModel.assets?.length" class="asis-master-assets"><b>利用アセット</b><span v-for="asset in asIsModel.assets.slice(0, 10)" :key="asset.id"><v-icon size="14">{{ asset.type === '業務システム' ? 'mdi-monitor-dashboard' : 'mdi-file-outline' }}</v-icon>{{ asset.name }}</span></div>
                  <div v-if="asIsModel.reviewItems?.length" class="asis-master-review"><v-icon size="17">mdi-alert-circle-outline</v-icon><span><b>要確認事項 {{ asIsModel.reviewItems.length }}件</b><small>{{ asIsModel.reviewItems.slice(0, 2).join(' / ') }}</small></span></div>
                </div>
              </div>
            </div>
            <div v-else class="asis-master-empty"><v-icon size="28">mdi-transit-connection-variant</v-icon><div><b>As-Isプロセスはまだありません</b><span>ヒアリングを実施するか、As-Is画面から業務フローを作成してください。</span></div><button class="save-button" :disabled="!props.canEdit" @click="emit('openAsIs')">As-Isを作成</button></div>
            <div class="asis-master-note"><v-icon size="17">mdi-lightbulb-on-outline</v-icon><span>業務指定ヒアリングでは、この業務の確認観点（未設定なら全業務共通の基本項目）をもとに、業務名に応じた深掘りをAIが判断します。</span></div>
          </div>
        </div>
      </section>
    </div>
  </section>
  <BusinessFlowImportDialog
    v-model="importDialog"
    :departments="departments"
    :businesses="businessMasters"
    :default-department-id="departmentId"
    @apply="emit('applyImport', $event)"
  />
</template>
