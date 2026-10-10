<script setup lang="ts">
import type { Department } from '../../../models'

defineProps<{
  modelValue: boolean
  title: string
  departmentId: string
  departments: Department[]
  error: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:title': [value: string]
  'update:departmentId': [value: string]
  save: []
}>()
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="560" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card process-details-dialog-card">
      <div class="process-dialog-header">
        <span><v-icon>mdi-file-document-edit-outline</v-icon></span>
        <div>
          <small>AS-IS SETTINGS</small>
          <h2>業務情報を編集</h2>
          <p>As-Isに表示する業務名と紐付け部門を変更します。</p>
        </div>
        <button aria-label="業務情報の編集を閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text class="process-details-form">
        <v-text-field
          :model-value="title"
          label="業務名"
          maxlength="80"
          placeholder="例：請求書受領〜支払承認"
          :hint="`${title.length}/80文字`"
          persistent-hint
          density="comfortable"
          @update:model-value="(value: string) => emit('update:title', value)"
          @keydown.enter.prevent="emit('save')"
        ></v-text-field>
        <v-select
          :model-value="departmentId"
          :items="departments"
          item-title="name"
          item-value="id"
          label="紐付ける業務領域"
          placeholder="業務領域を選択"
          hint="このAs-Isを管理・検索する業務領域です。"
          persistent-hint
          density="comfortable"
          @update:model-value="(value: string) => emit('update:departmentId', value)"
        ></v-select>
        <p v-if="error" class="process-details-error"><v-icon size="17">mdi-alert-circle-outline</v-icon>{{ error }}</p>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">キャンセル</v-btn>
        <v-btn color="primary" prepend-icon="mdi-content-save-outline" :disabled="!title.trim() || !departmentId" @click="emit('save')">変更を保存</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
