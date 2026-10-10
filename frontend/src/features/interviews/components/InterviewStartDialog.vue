<script setup lang="ts">
import type { BusinessProcessMaster, Department, InterviewTopic } from '../../../models'

const props = defineProps<{
  departments: Department[]
  selectableBusinesses: BusinessProcessMaster[]
  selectedBusiness: BusinessProcessMaster
  commonTopics: InterviewTopic[]
  canEdit: boolean
}>()

const open = defineModel<boolean>('open', { required: true })
const style = defineModel<'free' | 'guided'>('style', { required: true })
const departmentId = defineModel<string>('departmentId', { required: true })
const participant = defineModel<string>('participant', { required: true })
const businessId = defineModel<string>('businessId', { required: true })

const emit = defineEmits<{
  ensureBusiness: []
  start: []
}>()
</script>

<template>
  <v-dialog v-model="open" max-width="720">
    <v-card class="dialog-card interview-start-dialog">
      <v-card-title>担当者ヒアリングを開始</v-card-title>
      <v-card-subtitle>自由探索、または業務マスターから対象業務を選んで開始できます。</v-card-subtitle>
      <v-card-text>
        <div class="interview-style-options">
          <button :class="{ active: style === 'free' }" @click="style = 'free'"><v-icon size="22">mdi-radar</v-icon><span><b>自由探索</b><small>業務名や確認項目を決めず、担当者の話からAIが作業断片とAs-Is候補を発見します。</small></span></button>
          <button :class="{ active: style === 'guided' }" @click="style = 'guided'; emit('ensureBusiness')"><v-icon size="22">mdi-clipboard-list-outline</v-icon><span><b>業務指定</b><small>業務マスターから対象業務を選び、その業務の専門家としてAIがAs-Isに必要な項目を確認します。</small></span></button>
        </div>
        <v-select
          v-model="departmentId"
          :items="departments"
          item-title="name"
          item-value="id"
          label="対象の業務領域"
          hide-details
          @update:model-value="emit('ensureBusiness')"
        ></v-select>
        <v-text-field v-model="participant" class="interview-participant-field" label="参加者" maxlength="120" placeholder="例：佐藤 美咲"></v-text-field>
        <div v-if="style === 'guided'" class="guide-template-select">
          <v-select
            v-model="businessId"
            :items="props.selectableBusinesses"
            item-title="name"
            item-value="id"
            label="対象の業務"
            :hint="props.selectableBusinesses.length ? '業務マスターに登録された業務から選びます' : 'この業務領域には業務が登録されていません。業務マスターで追加してください'"
            persistent-hint
          ></v-select>
          <p>{{ props.selectedBusiness.description || '説明が未登録の業務です。ヒアリングの回答から補完されます。' }}</p>
          <div class="guide-topic-chips"><span v-for="topic in props.commonTopics" :key="topic.id"><v-icon size="14">{{ topic.required ? 'mdi-check-circle' : 'mdi-circle-outline' }}</v-icon>{{ topic.name }}</span></div>
        </div>
        <div class="discovery-start-note"><v-icon size="18">mdi-information-outline</v-icon><span>{{ style === 'guided' ? '選択した業務名と確認項目がAIへのガイドとして渡されます。回答の流れに合わせて順序や聞き方は調整されます。' : 'AIが日常の作業、担当、業務システム、判断条件を質問し、回答からAs-Isプロセスを作成します。' }}</span></div>
      </v-card-text>
      <v-card-actions><v-spacer></v-spacer><v-btn variant="text" @click="open = false">キャンセル</v-btn><v-btn color="primary" :prepend-icon="style === 'guided' ? 'mdi-clipboard-list-outline' : 'mdi-radar'" :disabled="!canEdit || !participant.trim() || (style === 'guided' && !businessId)" @click="emit('start')">{{ style === 'guided' ? '業務指定で開始' : '自由探索で開始' }}</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
