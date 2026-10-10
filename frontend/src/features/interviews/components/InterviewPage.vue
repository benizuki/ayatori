<script setup lang="ts">
import { ref } from 'vue'
import type { InterviewMessage, WorkFragment } from '../../../models'
import type { InterviewSessionSummary } from '../types'

interface ConsultantTopic {
  id: string
  name: string
  questionCount: number
}

interface QueuedAttachment {
  id: string
  name: string
  size: number
  previewUrl?: string
}

defineProps<{
  // heading / mode
  isRefinementInterview: boolean
  interviewMode: 'guided' | 'discovery'
  guideName: string
  hasProcessModel: boolean
  hasPreviewProcess: boolean
  canEdit: boolean
  activeSession?: InterviewSessionSummary
  completionScore: number
  // sidebar
  participant: string
  departmentName: string
  coverage: number
  consultantTopics: ConsultantTopic[]
  topicStates: ('done' | 'active' | 'pending')[]
  topicStatuses: string[]
  activeFragments: WorkFragment[]
  laneCandidateCount: number
  // chat
  messages: InterviewMessage[]
  response: string
  aiThinking: boolean
  llmConnectionStatus: 'unknown' | 'connected' | 'error'
  llmStatusDetail: string
  interviewPhase: string
  pendingInterviewText: string
  pendingAttachmentCount: number
  queuedAttachments: QueuedAttachment[]
  attachmentError: string
  attachmentDragActive: boolean
  // draft
  draftGenerating: boolean
  draftGenerationError: string
  // voice
  voiceInputSupported: boolean
  voiceOutputSupported: boolean
  isVoiceListening: boolean
  isVoiceTranscribing: boolean
  isAiSpeaking: boolean
  voicePlaybackEnabled: boolean
  voiceStatus: string
  voiceError: string
  // extraction panel
  confirmedFactCount: number
  missingItems: string[]
  formatAttachmentSize: (size: number) => string
}>()

const emit = defineEmits<{
  'update:response': [value: string]
  'update:attachmentDragActive': [value: boolean]
  goToSessions: []
  goToProcess: []
  suspend: []
  cancelAndDelete: []
  startDiscoveryInterview: []
  continueFromProcess: []
  retryConnection: []
  toggleVoicePlayback: []
  toggleVoiceInput: []
  speak: [text: string]
  send: []
  paste: [event: ClipboardEvent]
  drop: [event: DragEvent]
  attachmentInput: [event: Event]
  removeAttachment: [id: string]
  stopSending: []
  generateDraft: []
  previewAsIs: []
}>()

const chatBody = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const responseComposing = ref(false)

function onResponseKeydown(event: KeyboardEvent) {
  if (
    event.key !== 'Enter'
    || event.shiftKey
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.isComposing
    || responseComposing.value
    || event.keyCode === 229
  ) return
  event.preventDefault()
  emit('send')
}

/** Called by the app shell after a new message lands. */
function scrollChatToBottom() {
  chatBody.value?.scrollTo({ top: chatBody.value.scrollHeight, behavior: 'smooth' })
}

defineExpose({ scrollChatToBottom })
</script>

<template>
  <section class="page page--interview">
    <div class="page-heading page-heading--compact">
      <div>
        <div class="eyebrow">{{ isRefinementInterview ? 'AS-IS REFINEMENT INTERVIEW' : interviewMode === 'guided' ? 'GUIDED BUSINESS INTERVIEW' : 'BUSINESS DISCOVERY INTERVIEW' }}</div>
        <h1>{{ isRefinementInterview ? 'As-Is追加ヒアリング' : interviewMode === 'guided' ? '業務指定ヒアリング' : '自由探索ヒアリング' }}</h1>
        <p>{{ isRefinementInterview ? '現在のAs-Is図に残る不明点を確認し、プロセスをブラッシュアップします。' : interviewMode === 'guided' ? `「${guideName}」業務の確認項目に沿って、現状プロセスを確認します。` : '業務マスターは不要です。担当者の日常業務を会話から構造化します。' }}</p>
      </div>
      <div class="interview-heading-actions">
        <button class="session-list-link" @click="emit('goToSessions')"><v-icon size="18">mdi-format-list-bulleted-square</v-icon>一覧へ</button>
        <button class="suspend-interview-button" :disabled="!canEdit || aiThinking" @click="emit('suspend')"><v-icon size="18">mdi-pause-circle-outline</v-icon>中断</button>
        <button class="cancel-interview-button" :disabled="!canEdit || aiThinking" @click="emit('cancelAndDelete')"><v-icon size="18">mdi-trash-can-outline</v-icon>中止して削除</button>
        <div class="session-status discovery"><span></span>{{ activeSession?.status ?? (isRefinementInterview ? 'ブラッシュアップ中' : 'ヒアリング中') }} <b>{{ completionScore }}%</b></div>
        <button
          v-if="activeFragments.length || isRefinementInterview"
          class="draft-heading-action"
          :class="{ error: draftGenerationError }"
          :disabled="!canEdit || draftGenerating"
          :title="draftGenerationError || (isRefinementInterview ? '初回と追加ヒアリングの内容を統合してAs-Is図を更新します' : 'ヒアリング結果からAs-Is図を作成します')"
          @click="emit('generateDraft')"
        >
          <v-icon size="17" :class="{ 'draft-spin': draftGenerating }">{{ draftGenerating ? 'mdi-loading' : 'mdi-vector-polyline-edit' }}</v-icon>{{ draftGenerating ? (isRefinementInterview ? '更新中' : '組み立て中') : (isRefinementInterview ? 'As-Isを更新' : 'As-Isを作成') }}
        </button>
      </div>
    </div>

    <div class="analysis-loop panel">
      <button :class="{ active: !isRefinementInterview }" :disabled="!canEdit" @click="emit('startDiscoveryInterview')">
        <span>1</span>
        <div><b>担当者にヒアリング</b><small>日常業務をそのまま話す</small></div>
        <v-icon size="18">mdi-chevron-right</v-icon>
      </button>
      <button :disabled="!activeFragments.length && !hasPreviewProcess" @click="emit('previewAsIs')">
        <span>2</span>
        <div><b>途中As-Isを確認</b><small>ヒアリング画面内でプレビュー</small></div>
        <v-icon size="18">mdi-chevron-right</v-icon>
      </button>
      <button :class="{ active: isRefinementInterview }" :disabled="!canEdit || !hasProcessModel" @click="emit('continueFromProcess')">
        <span>3</span>
        <div><b>追加ヒアリングで更新</b><small>図の不明点をブラッシュアップ</small></div>
        <v-icon size="18">mdi-refresh</v-icon>
      </button>
    </div>

    <div class="interview-layout">
      <section class="panel interview-sidebar">
        <div class="interview-person">
          <div class="avatar avatar--large">{{ participant.slice(0, 1) }}</div>
          <div><b>{{ participant }}</b><span>{{ departmentName }}</span></div>
        </div>
        <div class="coverage">
          <div><b>現状分析カバレッジ</b><strong>{{ coverage }}%</strong></div>
          <div class="mini-progress"><span :style="{ width: `${coverage}%` }"></span></div>
        </div>
        <div class="topic-list" role="list" aria-label="確認する観点">
          <div
            v-for="(topic, index) in consultantTopics"
            :key="topic.id"
            class="topic-item"
            role="listitem"
            :class="{ done: topicStates[index] === 'done', active: topicStates[index] === 'active' }"
          >
            <v-icon>{{ topicStates[index] === 'done' ? 'mdi-check-circle' : topicStates[index] === 'active' ? 'mdi-progress-question' : 'mdi-circle-outline' }}</v-icon>
            <span><b>{{ topic.name }}</b><small>{{ topicStatuses[index] }}</small></span>
          </div>
        </div>
        <div class="evidence-box">
          <v-icon>mdi-text-box-search-outline</v-icon>
          <div><b>ヒアリングから抽出した作業</b><span>{{ activeFragments.length }}件をAs-Is作成に利用</span></div>
          <v-icon size="18">mdi-check-circle-outline</v-icon>
        </div>
      </section>

      <section class="panel chat-panel">
        <div class="chat-header">
          <div>
            <span class="ai-orb"><v-icon>mdi-account-tie-outline</v-icon></span>
            <div><b>Ayatori Consulting Agent</b><span>{{ llmConnectionStatus === 'connected' ? `Gemini｜${interviewPhase}` : llmConnectionStatus === 'error' ? 'Geminiの応答待ちで停止中' : 'Geminiへ接続中' }}</span></div>
          </div>
          <div class="voice-controls">
            <button
              type="button"
              :class="{ active: voicePlaybackEnabled, speaking: isAiSpeaking }"
              :disabled="!voiceOutputSupported"
              :title="voicePlaybackEnabled ? 'Gemini自然音声の自動読み上げを停止' : 'Gemini自然音声で自動読み上げ'"
              @click="emit('toggleVoicePlayback')"
            >
              <v-icon>{{ voicePlaybackEnabled ? 'mdi-volume-high' : 'mdi-volume-off' }}</v-icon>
            </button>
          </div>
        </div>

        <div v-if="llmConnectionStatus === 'error'" class="llm-error-banner" :title="llmStatusDetail">
          <v-icon size="18">mdi-cloud-alert-outline</v-icon>
          <span><b>Geminiに接続できないためヒアリングを停止しています</b><small>{{ pendingInterviewText ? '回答は保存済みです。再接続後に同じターンから再開します。' : '質問は生成されていません。接続を確認して再試行してください。' }}</small><small v-if="llmStatusDetail" class="llm-error-detail">{{ llmStatusDetail }}</small></span>
          <button :disabled="!canEdit" @click="emit('retryConnection')"><v-icon size="17">mdi-refresh</v-icon>再接続</button>
        </div>

        <div ref="chatBody" class="chat-body">
          <div v-for="message in messages" :key="message.id" class="message" :class="`message--${message.role}`">
            <div class="message__meta"><b>{{ message.speaker }}</b><span>{{ message.time }}</span></div>
            <div class="message__bubble">
              <div v-if="message.attachments?.length" class="message-attachments">
                <article v-for="attachment in message.attachments" :key="`${message.id}-${attachment.name}`">
                  <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
                  <span v-else><v-icon size="25">mdi-file-pdf-box</v-icon></span>
                  <div><b>{{ attachment.name }}</b><small>{{ attachment.mimeType === 'application/pdf' ? 'PDF資料' : '画像' }}・{{ formatAttachmentSize(attachment.size) }}</small></div>
                </article>
              </div>
              <div class="message-text">{{ message.text }}</div>
              <button
                v-if="message.role === 'ai'"
                type="button"
                class="message-speak-button"
                :disabled="!voiceOutputSupported"
                title="Gemini自然音声でこの質問を読み上げる"
                @click="emit('speak', message.text)"
              >
                <v-icon size="16">mdi-waveform</v-icon>自然音声で読み上げ
              </button>
            </div>
            <div v-if="message.tags" class="message-tags"><span v-for="tag in message.tags" :key="tag">{{ tag }}</span></div>
          </div>
          <div v-if="aiThinking" class="typing"><span></span><span></span><span></span> 質問を組み立てています</div>
        </div>

        <p v-if="voiceStatus || voiceError" class="voice-status-bar" :class="{ error: voiceError, listening: isVoiceListening }">
          <v-icon size="16">{{ voiceError ? 'mdi-alert-circle-outline' : isVoiceListening ? 'mdi-microphone' : isVoiceTranscribing ? 'mdi-waveform' : 'mdi-check-circle-outline' }}</v-icon>{{ voiceError || voiceStatus }}
        </p>

        <form
          class="chat-input"
          :class="{ 'chat-input--dragging': attachmentDragActive }"
          @submit.prevent="emit('send')"
          @dragover.prevent="emit('update:attachmentDragActive', true)"
          @dragleave="emit('update:attachmentDragActive', false)"
          @drop.prevent="emit('drop', $event)"
        >
          <div v-if="queuedAttachments.length" class="attachment-queue">
            <article v-for="attachment in queuedAttachments" :key="attachment.id">
              <img v-if="attachment.previewUrl" :src="attachment.previewUrl" :alt="attachment.name" />
              <span v-else><v-icon size="24">mdi-file-pdf-box</v-icon></span>
              <div><b>{{ attachment.name }}</b><small>{{ formatAttachmentSize(attachment.size) }}</small></div>
              <button type="button" title="添付を取り消す" :disabled="!canEdit" @click="emit('removeAttachment', attachment.id)"><v-icon size="17">mdi-close</v-icon></button>
            </article>
          </div>
          <div v-if="attachmentDragActive" class="attachment-drop-hint"><v-icon size="22">mdi-tray-arrow-down</v-icon>ここに画像・PDFをドロップ</div>
          <p v-if="attachmentError" class="attachment-error"><v-icon size="16">mdi-alert-circle-outline</v-icon>{{ attachmentError }}</p>
          <textarea
            :value="response"
            rows="2"
            :disabled="!canEdit || isVoiceListening || isVoiceTranscribing || !!pendingInterviewText || pendingAttachmentCount > 0 || llmConnectionStatus === 'error'"
            :placeholder="pendingInterviewText || pendingAttachmentCount ? '回答は保存済みです。Geminiへ再接続してください' : isVoiceListening ? '音声を録音しています…' : isVoiceTranscribing ? 'Geminiが文字起こししています…' : '回答を入力、またはマイクで話してください…'"
            @input="emit('update:response', ($event.target as HTMLTextAreaElement).value)"
            @paste="emit('paste', $event)"
            @compositionstart="responseComposing = true"
            @compositionend="responseComposing = false"
            @keydown="onResponseKeydown"
          ></textarea>
          <div>
            <span>
              <button type="button" title="画像・PDFを添付" :disabled="!canEdit" @click="fileInput?.click()"><v-icon size="20">mdi-paperclip</v-icon></button>
              <input ref="fileInput" class="attachment-file-input" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple @change="emit('attachmentInput', $event)" />
              <button
                type="button"
                class="voice-input-button"
                :class="{ active: isVoiceListening }"
                :disabled="!canEdit || !voiceInputSupported || isVoiceTranscribing || aiThinking || !!pendingInterviewText || pendingAttachmentCount > 0 || llmConnectionStatus === 'error'"
                :title="!voiceInputSupported ? 'このブラウザは音声入力に対応していません' : isVoiceTranscribing ? 'Geminiが文字起こし中です' : isVoiceListening ? '録音を停止して文字起こし' : '音声で回答'"
                @click="emit('toggleVoiceInput')"
              >
                <v-icon size="20">{{ isVoiceListening ? 'mdi-stop' : isVoiceTranscribing ? 'mdi-loading' : 'mdi-microphone-outline' }}</v-icon>
              </button>
            </span>
            <span class="input-hint">{{ pendingInterviewText || pendingAttachmentCount ? '再接続待ち' : isVoiceListening ? '話し終えたら停止' : isVoiceTranscribing ? 'Geminiが文字起こし中' : 'マイクで回答・Enterで送信' }}</span>
            <button
              v-if="aiThinking"
              type="button"
              class="stop-request-button"
              title="Geminiへの送信を停止し、内容を修正する"
              :disabled="!canEdit"
              @click="emit('stopSending')"
            >
              <v-icon size="16">mdi-stop-circle-outline</v-icon>停止して修正
            </button>
            <button
              type="submit"
              class="send-button"
              :disabled="!canEdit || isVoiceListening || isVoiceTranscribing || !!pendingInterviewText || pendingAttachmentCount > 0 || aiThinking || (!response.trim() && !queuedAttachments.length)"
            >
              <v-icon size="20">mdi-arrow-up</v-icon>
            </button>
          </div>
        </form>
      </section>

      <aside class="panel extraction-panel">
        <div class="panel__header">
          <div><h2>回答から抽出した作業</h2><p>As-Is作成用に自動で構造化</p></div>
          <span class="live-dot">LIVE</span>
        </div>
        <div class="consultant-state-card">
          <div><span>{{ interviewPhase }}</span><strong>{{ completionScore }}%</strong></div>
          <p><v-icon size="15">mdi-check-circle-outline</v-icon>確認済み {{ confirmedFactCount }}件</p>
          <p><v-icon size="15">mdi-help-circle-outline</v-icon>未確認 {{ missingItems.length }}件</p>
          <small v-if="missingItems.length">次の重点：{{ missingItems.slice(0, 2).join('・') }}</small>
        </div>
        <div class="extract-group">
          <h3><v-icon size="17">mdi-text-box-search-outline</v-icon> 今回確認した作業 <span>{{ activeFragments.length }}</span></h3>
          <div v-for="fragment in activeFragments.slice(0, 4)" :key="fragment.id" class="extract-card discovery-extract-card">
            <b>{{ fragment.title }}</b>
            <span><v-icon size="14">mdi-account-outline</v-icon>{{ fragment.actor }}<template v-if="fragment.nextActor && fragment.nextActor !== '未確認'"> → {{ fragment.nextActor }}</template></span>
            <span><v-icon size="14">mdi-tools</v-icon>{{ fragment.tools.join('・') }}</span>
            <span v-if="fragment.standardTime && fragment.standardTime !== '未確認'"><v-icon size="14">mdi-timer-outline</v-icon>標準時間 {{ fragment.standardTime }}</span>
            <span v-if="fragment.processingVolume && fragment.processingVolume !== '未確認'"><v-icon size="14">mdi-counter</v-icon>処理件数 {{ fragment.processingVolume }}</span>
            <span v-if="fragment.dataItems?.length" class="fragment-data-count"><v-icon size="14">mdi-table-large</v-icon>データ項目 {{ fragment.dataItems.length }}件</span>
            <div v-if="fragment.dataItems?.length" class="fragment-data-items">
              <em v-for="item in fragment.dataItems.slice(0, 3)" :key="`${item.sourceDocument}-${item.name}`">{{ item.name }}</em>
              <em v-if="fragment.dataItems.length > 3">+{{ fragment.dataItems.length - 3 }}</em>
            </div>
            <small :class="`personalization personalization--${fragment.personalization}`">属人性 {{ fragment.personalization }}</small>
          </div>
          <div v-if="activeFragments.length === 0" class="extract-empty">Geminiが回答から作業情報を抽出します</div>
        </div>
        <div v-if="activeFragments.length" class="extract-empty">{{ isRefinementInterview ? '初回と追加ヒアリングを統合した更新は、上部の「As-Isを更新」ボタンから実行します' : 'As-Is作成は上部の「As-Isを作成」ボタンから実行します' }}</div>
      </aside>
    </div>
  </section>
</template>
