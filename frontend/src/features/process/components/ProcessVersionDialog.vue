<script setup lang="ts">
import type { ProcessModel, ProcessVersion } from '../../../models'

defineProps<{
  modelValue: boolean
  model: ProcessModel
  stepCount: number
  versions: ProcessVersion[]
  /** Number of steps that differ from the current model, per version id. */
  difference: (version: ProcessVersion) => number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  restore: [version: ProcessVersion]
}>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="720" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card">
      <div class="process-dialog-header">
        <span><v-icon>mdi-history</v-icon></span>
        <div>
          <small>VERSION HISTORY</small>
          <h2>保存版を比較</h2>
          <p>{{ model.title }}の現在版と過去の保存版を比較します。</p>
        </div>
        <button @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <div class="version-current">
        <span><v-icon>mdi-source-branch-check</v-icon></span>
        <div><b>現在の編集内容</b><small>{{ stepCount }}ステップ・{{ model.connections.length }}接続</small></div>
        <em>{{ model.updatedAt }}</em>
      </div>

      <div v-if="versions.length" class="version-list">
        <article v-for="version in versions" :key="version.id">
          <span class="version-dot"></span>
          <div><b>{{ version.label }}</b><small>{{ version.savedAt }}｜{{ version.steps.length }}ステップ・{{ version.connections.length }}接続</small></div>
          <em :class="{ unchanged: difference(version) === 0 }">{{ difference(version) === 0 ? '変更なし' : `${difference(version)}ステップ変更` }}</em>
          <button @click="emit('restore', version)">この版を復元</button>
        </article>
      </div>
      <div v-else class="empty-version">
        <v-icon size="35">mdi-history</v-icon>
        <b>保存版はまだありません</b>
        <p>プロセスを保存すると、比較用の版がここに追加されます。</p>
      </div>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">閉じる</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
