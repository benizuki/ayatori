<script setup lang="ts">
import { toRef } from 'vue'
import type { Department } from '../../../models'
import type { InterviewSessionSummary } from '../types'

const props = defineProps<{
  session?: InterviewSessionSummary
  form: { departmentId: string; participant: string }
  departments: Department[]
  error: string
  saving: boolean
}>()

const open = defineModel<boolean>({ required: true })
const form = toRef(props, 'form')
const emit = defineEmits<{ save: [] }>()
</script>

<template>
  <v-dialog v-model="open" max-width="560">
    <v-card class="dialog-card interview-session-editor-card">
      <v-card-title>ヒアリング情報を編集</v-card-title>
      <v-card-subtitle>部門と参加者は「保存」でまとめて確定します。</v-card-subtitle>
      <v-card-text>
        <div v-if="session" class="interview-session-editor-summary">
          <v-icon size="20">mdi-message-text-clock-outline</v-icon>
          <span><b>{{ session.title }}</b><small>{{ session.updatedAt }}｜{{ session.status }}</small></span>
        </div>
        <div class="interview-session-editor-form">
          <v-select
            v-model="form.departmentId"
            :items="departments"
            item-title="name"
            item-value="id"
            label="対象の業務領域"
            density="comfortable"
            hide-details
          ></v-select>
          <v-text-field
            v-model="form.participant"
            label="参加者"
            maxlength="120"
            placeholder="例：佐藤 美咲"
            density="comfortable"
            hide-details
            @keyup.enter="emit('save')"
          ></v-text-field>
        </div>
        <p v-if="error" class="interview-session-editor-error"><v-icon size="17">mdi-alert-circle-outline</v-icon>{{ error }}</p>
      </v-card-text>
      <v-card-actions><v-spacer></v-spacer><v-btn variant="text" :disabled="saving" @click="open = false">キャンセル</v-btn><v-btn color="primary" prepend-icon="mdi-content-save-outline" :loading="saving" :disabled="!form.departmentId || !form.participant.trim()" @click="emit('save')">保存</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
