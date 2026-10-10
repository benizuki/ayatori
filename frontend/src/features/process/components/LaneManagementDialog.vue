<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { ProcessStep } from '../../../models'

const props = defineProps<{
  modelValue: boolean
  lanes: string[]
  steps: ProcessStep[]
  newLaneName: string
  bulkMoveFrom: string
  bulkMoveTo: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:newLaneName': [value: string]
  'update:bulkMoveFrom': [value: string]
  'update:bulkMoveTo': [value: string]
  rename: [index: number, nextName: string]
  move: [index: number, direction: -1 | 1]
  requestDelete: [index: number]
  addLane: []
  bulkMove: []
  save: []
}>()

// 入力中の値を下書きとして持ち、確定後は必ずlanesの内容へ表示を合わせ直す。
// 重複や空欄で改名が却下された場合も、これで元の名前へ戻る。
const laneDrafts = ref<string[]>([])
watch(
  () => props.lanes,
  (lanes) => { laneDrafts.value = [...lanes] },
  { immediate: true, deep: true },
)

function commitRename(index: number) {
  emit('rename', index, laneDrafts.value[index] ?? '')
  void nextTick(() => { laneDrafts.value[index] = props.lanes[index] ?? '' })
}

function stepCount(lane: string) {
  return props.steps.filter((step) => (step.lane ?? step.actor) === lane).length
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="760" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card lane-management-dialog">
      <div class="process-dialog-header">
        <span><v-icon>mdi-table-row</v-icon></span>
        <div>
          <small>SWIMLANE MANAGEMENT</small>
          <h2>担当レーンを管理</h2>
          <p>名称・順序・所属ステップを、実際の役割分担に合わせて編集します。</p>
        </div>
        <button aria-label="レーン管理を閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text>
        <div class="lane-management-list">
          <article v-for="(lane, index) in lanes" :key="`${lane}-${index}`">
            <span class="lane-order">{{ index + 1 }}</span>
            <div>
              <v-text-field
                v-model="laneDrafts[index]"
                :aria-label="`レーン${index + 1}の名前`"
                maxlength="40"
                density="compact"
                hide-details
                @blur="commitRename(index)"
                @keydown.enter.prevent="commitRename(index)"
              ></v-text-field>
              <small>{{ stepCount(lane) }}ステップ</small>
            </div>
            <div class="lane-row-actions">
              <button :disabled="index === 0" title="上へ移動" @click="emit('move', index, -1)"><v-icon size="17">mdi-arrow-up</v-icon></button>
              <button :disabled="index === lanes.length - 1" title="下へ移動" @click="emit('move', index, 1)"><v-icon size="17">mdi-arrow-down</v-icon></button>
              <button class="delete" :disabled="lanes.length <= 1" title="レーンを削除" @click="emit('requestDelete', index)"><v-icon size="17">mdi-trash-can-outline</v-icon></button>
            </div>
          </article>
        </div>

        <div class="lane-management-add">
          <v-text-field
            :model-value="newLaneName"
            label="追加するレーン名"
            placeholder="新しい担当部門・役割名"
            density="compact"
            hide-details
            @update:model-value="(value: string) => emit('update:newLaneName', value)"
            @keydown.enter.prevent="emit('addLane')"
          ></v-text-field>
          <button :disabled="!newLaneName.trim()" @click="emit('addLane')"><v-icon size="17">mdi-plus</v-icon>レーンを追加</button>
        </div>

        <section class="lane-bulk-move">
          <div>
            <v-icon>mdi-account-switch-outline</v-icon>
            <span><b>所属ステップを一括移動</b><small>レーンは残したまま、すべてのステップを別の担当へ移します。</small></span>
          </div>
          <div>
            <v-select
              :model-value="bulkMoveFrom"
              :items="lanes"
              aria-label="移動元レーン"
              density="compact"
              hide-details
              @update:model-value="(value: string) => emit('update:bulkMoveFrom', value)"
            ></v-select>
            <v-icon size="18">mdi-arrow-right</v-icon>
            <v-select
              :model-value="bulkMoveTo"
              :items="lanes"
              aria-label="移動先レーン"
              density="compact"
              hide-details
              @update:model-value="(value: string) => emit('update:bulkMoveTo', value)"
            ></v-select>
            <button :disabled="!bulkMoveFrom || !bulkMoveTo || bulkMoveFrom === bulkMoveTo" @click="emit('bulkMove')">一括移動</button>
          </div>
        </section>
      </v-card-text>

      <v-card-actions>
        <span class="lane-save-note"><v-icon size="16">mdi-information-outline</v-icon>変更は「保存して閉じる」で版として保存されます。</span>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">閉じる</v-btn>
        <v-btn color="primary" prepend-icon="mdi-content-save-outline" @click="emit('save')">保存して閉じる</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
