<script setup lang="ts">
import type { ProcessStep } from '../../../models'

defineProps<{
  modelValue: boolean
  step?: ProcessStep
  businessName: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="620" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card evidence-dialog-card">
      <div class="process-dialog-header">
        <span><v-icon>mdi-file-document-multiple-outline</v-icon></span>
        <div>
          <small>PROCESS EVIDENCE</small>
          <h2>{{ step?.label }}の証跡</h2>
          <p>ファイル名とプロセス上の紐づきを確認できます。</p>
        </div>
        <button @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text>
        <article v-for="file in step?.evidence" :key="file">
          <v-icon>mdi-file-document-outline</v-icon>
          <div><b>{{ file }}</b><span>{{ businessName }}｜{{ step?.label }}</span></div>
          <em>登録済み</em>
        </article>
        <p class="evidence-note"><v-icon size="17">mdi-information-outline</v-icon>このプロトタイプではファイル名と紐づきを保存します。ファイル本体の保管先は今後接続します。</p>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="primary" @click="emit('update:modelValue', false)">閉じる</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
