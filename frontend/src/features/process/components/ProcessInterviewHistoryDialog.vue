<script setup lang="ts">
import type { SavedInterviewAttachment } from '../../../api/interview'
import type { WorkFragment } from '../../../models'
import InterviewHistoryConversation from '../../interviews/components/InterviewHistoryConversation.vue'
import type { ProcessHistorySession } from '../../interviews/types'

const open = defineModel<boolean>({ required: true })
const props = defineProps<{
  processTitle: string
  loading: boolean
  error: string
  sessions: ProcessHistorySession[]
  selectedSessionId: string
  selectedSession?: ProcessHistorySession
  sourceFragments: WorkFragment[]
  stepNamesByFragmentId: (fragmentId: string) => string[]
}>()

const emit = defineEmits<{
  selectSession: [sessionId: string]
  openAttachment: [sessionId: string, attachment: SavedInterviewAttachment]
  updateAsIs: [sessionId: string]
}>()

function openAttachment(sessionId: string, attachment: SavedInterviewAttachment) {
  emit('openAttachment', sessionId, attachment)
}

function updateAsIs() {
  if (!props.selectedSession?.canUpdateAsIs) return
  open.value = false
  emit('updateAsIs', props.selectedSession.id)
}
</script>

<template>
  <v-dialog v-model="open" width="calc(100vw - 44px)" max-width="1480">
    <v-card class="process-dialog-card interview-history-dialog">
      <div class="process-dialog-header interview-history-header">
        <span><v-icon>mdi-message-text-clock-outline</v-icon></span>
        <div>
          <small>INTERVIEW TRANSCRIPT</small>
          <h2>ヒアリング内容のやり取り</h2>
          <p>{{ processTitle }}を作成した質問・回答と、抽出された根拠を確認します。</p>
        </div>
        <div class="interview-history-actions">
          <v-btn
            v-if="selectedSession?.canUpdateAsIs"
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
          <button aria-label="ヒアリング履歴を閉じる" @click="open = false">
            <v-icon>mdi-close</v-icon>
          </button>
        </div>
      </div>

      <div v-if="loading" class="interview-history-loading">
        <v-progress-circular indeterminate color="primary" size="34"></v-progress-circular>
        <b>保存済みの会話を読み込んでいます</b>
      </div>
      <div v-else class="interview-history-content">
        <div v-if="sessions.length" class="history-session-tabs">
          <button
            v-for="session in sessions"
            :key="session.id"
            :class="{ active: selectedSessionId === session.id }"
            @click="emit('selectSession', session.id)"
          >
            <span>{{ session.participant.slice(0, 1) }}</span>
            <div>
              <b>{{ session.participant }}</b>
              <small>{{ session.department }}｜{{ session.messages.length }}発言</small>
            </div>
            <em :class="{ 'fragment-only': !session.saved }">{{ session.kind === 'refinement' ? '追加' : '初回' }}・{{ session.saved ? '保存済み' : '断片のみ' }}</em>
          </button>
        </div>
        <div v-if="error" class="history-load-warning">
          <v-icon size="18">mdi-alert-outline</v-icon>{{ error }}
        </div>

        <v-card-text v-if="selectedSession" class="interview-history-body">
          <InterviewHistoryConversation
            :messages="selectedSession.messages"
            :session-id="selectedSession.id"
            search-label="ヒアリング履歴を検索"
            empty-description="この古いヒアリングでは会話全文が保存されていません。右側の作業断片から、担当者の発言根拠を確認できます。"
            :reset-key="selectedSession.id"
            :active="open"
            @open-attachment="openAttachment"
          />
          <aside class="interview-history-context">
            <section class="history-session-summary">
              <div>
                <span><v-icon size="18">mdi-account-voice</v-icon></span>
                <div><b>{{ selectedSession.participant }}</b><small>{{ selectedSession.department }}</small></div>
              </div>
              <dl>
                <div><dt>確認フェーズ</dt><dd>{{ selectedSession.phase }}</dd></div>
                <div><dt>カバレッジ</dt><dd>{{ selectedSession.completionScore }}%</dd></div>
                <div><dt>最終保存</dt><dd>{{ selectedSession.updatedAt }}</dd></div>
              </dl>
              <div class="history-coverage">
                <i><span :style="{ width: `${selectedSession.completionScore}%` }"></span></i>
              </div>
            </section>
            <section v-if="selectedSession.evidence.length" class="history-evidence">
              <h3>添付・証跡 <span>{{ selectedSession.evidence.length }}</span></h3>
              <p v-for="item in selectedSession.evidence" :key="item">
                <v-icon size="15">mdi-paperclip</v-icon>{{ item }}
              </p>
            </section>
            <section class="history-fragments">
              <h3>抽出された作業断片 <span>{{ sourceFragments.length }}</span></h3>
              <article v-for="fragment in sourceFragments" :key="fragment.id">
                <header><b>{{ fragment.title }}</b><em>{{ fragment.confidence }}%</em></header>
                <blockquote>「{{ fragment.sourceQuote }}」</blockquote>
                <p v-if="stepNamesByFragmentId(fragment.id).length">
                  <v-icon size="14">mdi-vector-polyline</v-icon>
                  {{ stepNamesByFragmentId(fragment.id).join('、') }}に反映
                </p>
              </article>
              <p v-if="!sourceFragments.length" class="history-no-fragments">
                このセッションから抽出された作業断片はありません。
              </p>
            </section>
          </aside>
        </v-card-text>
        <div v-else class="history-empty-all">
          <v-icon size="43">mdi-message-question-outline</v-icon>
          <b>このAs-Isに紐づくヒアリング履歴はありません</b>
          <p>担当者への追加ヒアリングを開始すると、以後の質問と回答が保存されます。</p>
        </div>
      </div>
    </v-card>
  </v-dialog>
</template>
