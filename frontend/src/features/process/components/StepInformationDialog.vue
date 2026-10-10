<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  addStepInformation,
  informationFindings,
  pruneUnusedInformation,
  removeStepInformation,
  renameInformation,
  suppressUnusedStepAssets,
  splitInformationItems,
  type InformationDirection,
} from '../process-information'
import type { OperationalAsset, ProcessModel, ProcessStep, StepInformationRef } from '../../../models'

/**
 * タスクで扱う情報を、広い画面で確認・編集する。タスクのダブルクリックで開く。
 * 以前はアセットごとに書いていた「扱う情報」を、タスクの入力・出力として見直すための画面。
 */
const props = defineProps<{
  modelValue: boolean
  model?: ProcessModel
  step?: ProcessStep
  assets: OperationalAsset[]
  canEdit: boolean
  extracting: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  change: []
  extract: [informationId: string]
}>()

const GROUPS: Array<{ direction: InformationDirection; label: string; icon: string; placeholder: string; empty: string }> = [
  { direction: 'inputs', label: '入力する情報', icon: 'mdi-login', placeholder: '例：請求書、発注データ', empty: 'このタスクが使う情報はまだありません。' },
  { direction: 'outputs', label: '出力する情報', icon: 'mdi-logout', placeholder: '例：照合結果、支払予定', empty: 'このタスクが作る・更新する情報はまだありません。' },
]

const newName = ref<Record<InformationDirection, string>>({ inputs: '', outputs: '' })
const renameError = ref<Record<string, string>>({})

const informationNames = computed(() => (props.model?.information ?? []).map((item) => item.name))
const findings = computed(() => (props.model && props.step ? informationFindings(props.model, props.step) : []))

function informationOf(id: string) {
  return props.model?.information?.find((item) => item.id === id)
}

/** 同じ情報を出力・入力している他のタスク。名前を変えると、ここに挙がるタスクの表示も変わる。 */
function otherSteps(informationId: string, direction: InformationDirection) {
  return (props.model?.steps ?? []).filter((item) => item.id !== props.step?.id
    && (item[direction] ?? []).some((ref) => ref.informationId === informationId))
}

function add(direction: InformationDirection) {
  if (!props.canEdit || !props.model || !props.step || !newName.value[direction].trim()) return
  addStepInformation(props.model, props.step, direction, newName.value[direction])
  newName.value[direction] = ''
  emit('change')
}

function remove(direction: InformationDirection, informationId: string) {
  if (!props.canEdit || !props.model || !props.step) return
  const removedAssets = (props.step[direction] ?? []).find((ref) => ref.informationId === informationId)?.assetIds ?? []
  removeStepInformation(props.step, direction, informationId)
  suppressUnusedStepAssets(props.model, props.step, removedAssets)
  pruneUnusedInformation(props.model)
  emit('change')
}

function rename(informationId: string, event: Event) {
  const input = event.target as HTMLInputElement
  if (!props.model) return
  const result = renameInformation(props.model, informationId, input.value)
  if (result === 'duplicate') {
    renameError.value = { ...renameError.value, [informationId]: '同じ名前の情報がすでにあります。同じ情報なら、いったん外してからその名前で追加してください。' }
    input.value = informationOf(informationId)?.name ?? ''
    return
  }
  renameError.value = { ...renameError.value, [informationId]: '' }
  if (result === 'renamed') emit('change')
  else input.value = informationOf(informationId)?.name ?? ''
}

function setAssets(ref: StepInformationRef, assetIds: string[] | null) {
  const removed = (ref.assetIds ?? []).filter((id) => !assetIds?.includes(id))
  ref.assetIds = assetIds?.length ? [...assetIds] : undefined
  if (props.model && props.step) suppressUnusedStepAssets(props.model, props.step, removed)
  emit('change')
}

/** 項目は1行に1つ、または読点区切りで書ける。 */
function setItems(informationId: string, text: string) {
  const information = informationOf(informationId)
  if (!information) return
  const items = splitInformationItems(text)
  information.items = items.length ? items : undefined
  emit('change')
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1080" scrollable @update:model-value="emit('update:modelValue', $event)">
    <v-card v-if="step && model" class="process-dialog-card step-information-dialog">
      <div class="process-dialog-header">
        <span><v-icon>mdi-swap-horizontal-bold</v-icon></span>
        <div>
          <small>TASK INFORMATION</small>
          <h2>{{ step.label }} で扱う情報</h2>
          <p>このタスクが使う情報と作る情報を、書類やデータのまとまりの単位で確認・編集します。入力はどのアセットから取得し、出力はどのアセットへ格納・送付するかを指定します。項目は同じ情報を扱う全タスクで共有します。</p>
        </div>
        <button aria-label="扱う情報の編集を閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text class="step-information-dialog__body">
        <section v-for="group in GROUPS" :key="group.direction" class="step-information-dialog__group" :class="`step-information-dialog__group--${group.direction}`">
          <header><v-icon size="19">{{ group.icon }}</v-icon>{{ group.label }}<em>{{ step[group.direction]?.length ?? 0 }}</em></header>

          <article v-for="ref in step[group.direction] ?? []" :key="ref.informationId">
            <div class="step-information-dialog__title">
              <input
                :value="informationOf(ref.informationId)?.name ?? ''"
                :class="{ provisional: informationOf(ref.informationId)?.provisional }"
                :title="informationOf(ref.informationId)?.provisional ? 'アセットの紐付けから作った仮の名前です。何の書類・データかが分かる名前に変えてください' : ''"
                aria-label="情報の名前"
                :readonly="!canEdit"
                @change="rename(ref.informationId, $event)"
                @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
              />
              <button type="button" title="帳票・台帳の資料から項目を抽出" :disabled="!canEdit || extracting" @click="emit('extract', ref.informationId)"><v-icon size="17">mdi-file-search-outline</v-icon>資料から抽出</button>
              <button type="button" class="remove" :title="`${group.label}から外す`" :disabled="!canEdit" @click="remove(group.direction, ref.informationId)"><v-icon size="17">mdi-close</v-icon></button>
            </div>
            <p v-if="renameError[ref.informationId]" class="step-information-dialog__error">{{ renameError[ref.informationId] }}</p>
            <v-select
              :model-value="ref.assetIds ?? []"
              :items="assets"
              item-title="name"
              item-value="id"
:label="`${group.direction === 'inputs' ? '取得元' : '格納先・送付先'}のアセット（複数可）`"
              :disabled="!canEdit"
              multiple
              chips
              closable-chips
              clearable
              density="compact"
              hide-details
              @update:model-value="(value: string[] | null) => setAssets(ref, value)"
            ></v-select>
            <label>
              <span>含まれる項目（1行に1つ、または読点区切り）</span>
              <textarea
                :value="informationOf(ref.informationId)?.items?.join('\n') ?? ''"
                rows="5"
                :readonly="!canEdit"
                placeholder="例：請求番号&#10;取引先&#10;金額&#10;支払期日"
                @change="setItems(ref.informationId, ($event.target as HTMLTextAreaElement).value)"
              ></textarea>
            </label>
            <small class="step-information-dialog__links">
              <template v-if="otherSteps(ref.informationId, 'outputs').length">出力するタスク：{{ otherSteps(ref.informationId, 'outputs').map((item) => item.label).join('・') }}</template>
              <template v-if="otherSteps(ref.informationId, 'outputs').length && otherSteps(ref.informationId, 'inputs').length"> ／ </template>
              <template v-if="otherSteps(ref.informationId, 'inputs').length">使うタスク：{{ otherSteps(ref.informationId, 'inputs').map((item) => item.label).join('・') }}</template>
              <template v-if="!otherSteps(ref.informationId, 'outputs').length && !otherSteps(ref.informationId, 'inputs').length">他のタスクでは扱っていません</template>
            </small>
          </article>
          <p v-if="!(step[group.direction]?.length)" class="step-information-dialog__empty">{{ group.empty }}</p>

          <div v-if="canEdit" class="step-information-dialog__add">
            <input
              v-model="newName[group.direction]"
              list="step-information-dialog-names"
              :aria-label="`${group.label}を追加`"
              :placeholder="group.placeholder"
              @keydown.enter.prevent="add(group.direction)"
            />
            <button type="button" :disabled="!newName[group.direction].trim()" @click="add(group.direction)"><v-icon size="17">mdi-plus</v-icon>追加</button>
          </div>
        </section>
        <datalist id="step-information-dialog-names">
          <option v-for="name in informationNames" :key="name" :value="name"></option>
        </datalist>

        <div v-if="findings.length" class="step-information-findings step-information-dialog__findings">
          <p v-for="finding in findings" :key="`${finding.kind}-${finding.informationId}`" :class="`finding--${finding.kind}`">
            <v-icon size="16">{{ finding.kind === 'unknown-source' ? 'mdi-help-circle-outline' : 'mdi-alert-circle-outline' }}</v-icon>{{ finding.message }}
          </p>
        </div>
      </v-card-text>

      <v-card-actions>
        <small class="step-information-dialog__note"><v-icon size="15">mdi-information-outline</v-icon>変更内容は画面上部の「As-Isを保存」で保存します。</small>
        <v-spacer></v-spacer>
        <v-btn variant="flat" color="primary" @click="emit('update:modelValue', false)">閉じる</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
