<script setup lang="ts">
import { computed } from 'vue'
import type { SavedInterviewAttachment, SavedInterviewSession } from '../../../api/interview'
import type { WorkFragment } from '../../../models'
import type { InterviewSessionSummary, ProcessHistoryMessage } from '../types'
import InterviewHistoryConversation from './InterviewHistoryConversation.vue'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{
  session: InterviewSessionSummary | null
  record: SavedInterviewSession | null
  messages: SavedInterviewSession['messages']
  fragments: WorkFragment[]
  canUpdateAsIs: boolean
  loading: boolean
  error: string
}>()

const emit = defineEmits<{
  openAttachment: [sessionId: string, attachment: SavedInterviewAttachment]
  updateAsIs: [session: InterviewSessionSummary]
}>()

const displayMessages = computed<ProcessHistoryMessage[]>(() => {
  if (!props.session) return []
  return props.messages.map((message) => ({
    role: message.role,
    text: message.text,
    speaker: message.role === 'assistant' ? 'Ayatori AI' : props.session?.participant || '担当者',
    time: '保存済み',
    attachments: message.attachments,
  }))
})

function openAttachment(sessionId: string, attachment: SavedInterviewAttachment) {
  emit('openAttachment', sessionId, attachment)
}

function updateAsIs() {
  if (!props.session) return
  open.value = false
  emit('updateAsIs', props.session)
}
</script>

<template>
  <v-dialog v-model="open" width="calc(100vw - 44px)" max-width="1320">
    <v-card class="process-dialog-card interview-history-dialog interview-transcript-dialog">
      <div class="process-dialog-header interview-history-header">
        <span><v-icon>mdi-message-text-outline</v-icon></span>
        <div>
          <small>INTERVIEW TRANSCRIPT</small>
          <h2>ヒアリング履歴</h2>
          <p>{{ session?.title || '保存されたAIの質問と担当者の回答を確認します。' }}</p>
        </div>
        <div class="interview-history-actions">
          <v-btn
            v-if="canUpdateAsIs"
            class="history-update-action"
            color="primary"
            variant="flat"
            prepend-icon="mdi-vector-polyline-edit"
            @click="updateAsIs"
          >As-Isを更新</v-btn>
          <span class="history-retention-note">
            <v-icon size="16">mdi-database-check-outline</v-icon>会話はセッション単位で保存
          </span>
          <v-btn class="history-close-text" variant="text" @click="open = false">閉じる</v-btn>
          <button aria-label="ヒアリング内容を閉じる" @click="open = false">
            <v-icon>mdi-close</v-icon>
          </button>
        </div>
      </div>

      <div v-if="loading" class="interview-history-loading">
        <v-progress-circular indeterminate color="primary" size="34"></v-progress-circular>
        <b>保存済みの会話を読み込んでいます</b>
      </div>
      <div v-else-if="session" class="interview-history-content">
        <div v-if="error" class="history-load-warning">
          <v-icon size="18">mdi-alert-outline</v-icon>{{ error }}
        </div>
        <v-card-text class="interview-history-body">
          <InterviewHistoryConversation
            :messages="displayMessages"
            :session-id="session.id"
            search-label="ヒアリング内容を検索"
            empty-description="右側に発言根拠がある場合は、抽出されたヒアリング内容を確認できます。"
            :reset-key="session.id"
            :active="open"
            @open-attachment="openAttachment"
          />
          <aside class="interview-history-context">
            <section class="history-session-summary">
              <div>
                <span><v-icon size="18">mdi-account-voice</v-icon></span>
                <div><b>{{ session.participant }}</b><small>{{ session.departmentName }}</small></div>
              </div>
              <dl>
                <div><dt>ステータス</dt><dd>{{ session.status }}</dd></div>
                <div><dt>確認フェーズ</dt><dd>{{ record?.session_state.phase || session.phase }}</dd></div>
                <div><dt>カバレッジ</dt><dd>{{ record?.session_state.completion_score ?? session.completionScore }}%</dd></div>
                <div><dt>最終保存</dt><dd>{{ record?.updated_at || session.updatedAt }}</dd></div>
              </dl>
              <div class="history-coverage">
                <i><span :style="{ width: `${record?.session_state.completion_score ?? session.completionScore}%` }"></span></i>
              </div>
            </section>
            <section class="history-fragments">
              <h3>抽出された発言根拠 <span>{{ fragments.length }}</span></h3>
              <article v-for="fragment in fragments" :key="fragment.id">
                <header><b>{{ fragment.title }}</b><em>{{ fragment.confidence }}%</em></header>
                <blockquote>「{{ fragment.sourceQuote }}」</blockquote>
              </article>
              <p v-if="!fragments.length" class="history-no-fragments">
                このセッションから抽出された発言根拠はありません。
              </p>
            </section>
          </aside>
        </v-card-text>
      </div>
    </v-card>
  </v-dialog>
</template>
