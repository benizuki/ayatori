<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { cancelBusinessFlowImport, commitBusinessFlowImport, createBusinessFlowImport, getBusinessFlowImport, listBusinessFlowImports, retryBusinessFlowImport, updateBusinessFlowImportCandidate, type BusinessFlowImportCandidate, type BusinessFlowImportJob } from '../../../api/imports'
import type { BusinessProcessMaster, Department } from '../../../models'

const props = defineProps<{
  modelValue: boolean
  departments: Department[]
  businesses: BusinessProcessMaster[]
  defaultDepartmentId: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  apply: [job: BusinessFlowImportJob]
}>()

const departmentId = ref('')
const file = ref<File | null>(null)
const jobs = ref<BusinessFlowImportJob[]>([])
const current = ref<BusinessFlowImportJob | null>(null)
const loading = ref(false)
const uploading = ref(false)
const committing = ref(false)
const error = ref('')
let pollTimer: number | undefined

const activeStatuses = new Set(['queued', 'preprocessing', 'classifying', 'extracting', 'assembling', 'committing'])
const canCommit = computed(() => current.value?.status === 'ready_for_review' && current.value.candidates.some((item) => item.selected))
const businessOptions = computed(() => [
  { title: '新しい業務として作成', value: '' },
  ...props.businesses
    .filter((item) => item.departmentId === departmentId.value)
    .map((item) => ({ title: `${item.code}｜${item.name}`, value: item.id })),
])

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function stopPolling() {
  window.clearTimeout(pollTimer)
}

function schedulePoll() {
  stopPolling()
  if (!current.value || !activeStatuses.has(current.value.status)) return
  pollTimer = window.setTimeout(() => void refreshCurrent(), 2500)
}

async function refreshCurrent() {
  if (!current.value) return
  try {
    current.value = await getBusinessFlowImport(current.value.id)
    schedulePoll()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解析状況を取得できませんでした。'
  }
}

async function loadJobs() {
  loading.value = true
  error.value = ''
  try {
    jobs.value = await listBusinessFlowImports()
    const preferred = jobs.value.find((item) => activeStatuses.has(item.status) || item.status === 'ready_for_review') ?? jobs.value[0]
    current.value = preferred ? await getBusinessFlowImport(preferred.id) : null
    if (current.value?.department_id) departmentId.value = current.value.department_id
    schedulePoll()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '資料解析の履歴を取得できませんでした。'
  } finally {
    loading.value = false
  }
}

function chooseFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value || !departmentId.value) return
  uploading.value = true
  error.value = ''
  try {
    current.value = await createBusinessFlowImport(file.value, departmentId.value)
    file.value = null
    await loadJobs()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '資料をアップロードできませんでした。'
  } finally {
    uploading.value = false
  }
}

async function openJob(job: BusinessFlowImportJob) {
  error.value = ''
  try {
    current.value = await getBusinessFlowImport(job.id)
    departmentId.value = current.value.department_id
    schedulePoll()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '解析結果を取得できませんでした。'
  }
}

async function updateCandidate(candidate: BusinessFlowImportCandidate, update: { title?: string; selected?: boolean; target_business_id?: string }) {
  if (!current.value) return
  Object.assign(candidate, update)
  try {
    current.value = await updateBusinessFlowImportCandidate(current.value.id, candidate.id, update)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '業務候補を更新できませんでした。'
  }
}

async function cancel() {
  if (!current.value) return
  current.value = await cancelBusinessFlowImport(current.value.id)
  schedulePoll()
}

async function retry() {
  if (!current.value) return
  current.value = await retryBusinessFlowImport(current.value.id)
  schedulePoll()
}

async function commit() {
  if (!current.value || !canCommit.value) return
  committing.value = true
  error.value = ''
  try {
    const ids = current.value.candidates.filter((item) => item.selected).map((item) => item.id)
    current.value = await commitBusinessFlowImport(current.value.id, ids)
    emit('apply', current.value)
    emit('update:modelValue', false)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'As-Isを確定できませんでした。'
  } finally {
    committing.value = false
  }
}

watch(() => props.modelValue, (open) => {
  if (open) {
    departmentId.value ||= props.defaultDepartmentId || props.departments[0]?.id || ''
    void loadJobs()
  } else stopPolling()
})

onUnmounted(stopPolling)
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1160" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="flow-import-dialog">
      <header class="flow-import-dialog__header">
        <div><span><v-icon>mdi-file-tree-outline</v-icon></span><div><h2>業務フロー資料からAs-Isを生成</h2><p>PDF・画像を解析し、複数業務を候補に分けてから登録します。</p></div></div>
        <button title="閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </header>

      <v-card-text class="flow-import-dialog__body">
        <p v-if="error" class="flow-import-error"><v-icon size="18">mdi-alert-circle-outline</v-icon>{{ error }}</p>
        <section class="flow-import-upload">
          <v-select v-model="departmentId" :items="departments" item-title="name" item-value="id" label="対象の業務領域" density="comfortable" hide-details></v-select>
          <label><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" @change="chooseFile"><span><v-icon size="19">mdi-paperclip</v-icon>{{ file?.name || 'PDF・画像を選択' }}</span></label>
          <v-btn color="primary" prepend-icon="mdi-cloud-upload-outline" :disabled="!file || !departmentId" :loading="uploading" @click="upload">解析を開始</v-btn>
        </section>

        <div class="flow-import-layout">
          <aside>
            <h3>解析履歴 <small>{{ jobs.length }}件</small></h3>
            <button v-for="job in jobs" :key="job.id" :class="{ active: current?.id === job.id }" @click="openJob(job)">
              <v-icon size="18">{{ job.status === 'completed' ? 'mdi-check-circle-outline' : job.status === 'failed' ? 'mdi-alert-outline' : 'mdi-file-document-outline' }}</v-icon>
              <span><b>{{ job.file_name }}</b><small>{{ formatDate(job.created_at) }}・{{ job.candidate_count }}業務</small></span>
            </button>
            <div v-if="!jobs.length && !loading" class="flow-import-empty">解析履歴はありません。</div>
          </aside>

          <main
            v-if="current"
            class="flow-import-results"
            tabindex="0"
            aria-label="抽出したAs-Is候補一覧"
          >
            <section class="flow-import-progress">
              <div><span><b>{{ current.file_name }}</b><small>{{ formatSize(current.file_size) }}<template v-if="current.total_pages">・{{ current.total_pages }}ページ</template></small></span><em>{{ current.progress }}%</em></div>
              <v-progress-linear :model-value="current.progress" color="primary" height="8" rounded></v-progress-linear>
              <p>{{ current.stage }}<template v-if="current.processed_pages">（{{ current.processed_pages }}/{{ current.total_pages }}ページ）</template></p>
              <p v-if="current.error" class="flow-import-error">{{ current.error }}</p>
              <div class="flow-import-progress__actions">
                <v-btn v-if="activeStatuses.has(current.status)" size="small" variant="text" @click="cancel">キャンセル</v-btn>
                <v-btn v-if="current.status === 'failed' || current.status === 'cancelled'" size="small" variant="outlined" prepend-icon="mdi-reload" @click="retry">再実行</v-btn>
              </div>
            </section>

            <section v-if="current.candidates.length" class="flow-import-candidates">
              <header><div><h3>抽出した業務候補</h3><p>登録対象と、既存業務へ紐付けるかを確認してください。</p></div><span>{{ current.candidates.filter((item) => item.selected).length }}/{{ current.candidates.length }}件</span></header>
              <article v-for="candidate in current.candidates" :key="candidate.id" :class="{ disabled: !candidate.selected }">
                <v-checkbox
                  class="flow-import-candidate__selection"
                  :model-value="candidate.selected"
                  :label="candidate.selected ? '登録する' : '登録しない'"
                  :aria-label="`${candidate.title}を登録対象にする`"
                  color="primary"
                  density="compact"
                  hide-details
                  @update:model-value="updateCandidate(candidate, { selected: Boolean($event) })"
                ></v-checkbox>
                <div class="flow-import-candidate__content">
                  <v-text-field :model-value="candidate.title" label="業務名" density="compact" hide-details :disabled="!candidate.selected" @change="updateCandidate(candidate, { title: ($event.target as HTMLInputElement).value })"></v-text-field>
                  <p>{{ candidate.summary || '資料から抽出した業務候補です。' }}</p>
                  <div class="flow-import-candidate__meta"><span>{{ candidate.fragments.length }}工程</span><span>{{ candidate.draft?.nodes.length ?? 0 }}ノード</span><span>確信度 {{ candidate.confidence }}%</span><span>{{ candidate.page_references.join('、') || 'ページ不明' }}</span></div>
                  <p v-if="candidate.warnings.length" class="flow-import-warning"><v-icon size="15">mdi-alert-outline</v-icon>{{ candidate.warnings.join(' / ') }}</p>
                </div>
                <v-select :model-value="candidate.target_business_id" :items="businessOptions" label="登録先" density="compact" hide-details :disabled="!candidate.selected" @update:model-value="updateCandidate(candidate, { target_business_id: String($event ?? '') })"></v-select>
              </article>
            </section>
          </main>
          <main v-else class="flow-import-empty"><v-icon size="34">mdi-file-search-outline</v-icon><span>資料を選択して解析を開始してください。</span></main>
        </div>
      </v-card-text>

      <v-card-actions>
        <v-btn variant="text" @click="emit('update:modelValue', false)">閉じる</v-btn>
        <v-btn color="primary" prepend-icon="mdi-check-circle-outline" :disabled="!canCommit" :loading="committing" @click="commit">選択したAs-Isを登録</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
