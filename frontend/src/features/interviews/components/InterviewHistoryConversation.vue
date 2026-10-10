<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SavedInterviewAttachment } from '../../../api/interview'
import type { ProcessHistoryMessage } from '../types'

const props = defineProps<{
  messages: ProcessHistoryMessage[]
  sessionId: string
  searchLabel: string
  emptyDescription: string
  resetKey?: string
  active?: boolean
}>()

const emit = defineEmits<{
  openAttachment: [sessionId: string, attachment: SavedInterviewAttachment]
}>()

const search = ref('')
const role = ref<'すべて' | 'AI' | '担当者'>('すべて')

watch(
  [() => props.resetKey, () => props.active],
  ([, active]) => {
    if (active === false) return
    search.value = ''
    role.value = 'すべて'
  },
)

const filteredMessages = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return props.messages.filter((message) => {
    const matchesRole = role.value === 'すべて'
      || (role.value === 'AI' && message.role === 'assistant')
      || (role.value === '担当者' && message.role === 'user')
    const attachmentNames = message.attachments?.map((attachment) => attachment.name).join(' ') ?? ''
    return matchesRole
      && (!query || `${message.text} ${message.speaker} ${attachmentNames}`.toLocaleLowerCase().includes(query))
  })
})

function formatAttachmentSize(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <section class="interview-transcript-pane">
    <header class="transcript-toolbar">
      <label>
        <v-icon size="18">mdi-magnify</v-icon>
        <input v-model="search" :aria-label="searchLabel" placeholder="質問・回答を検索" />
      </label>
      <div>
        <button
          v-for="filterRole in ['すべて', 'AI', '担当者'] as const"
          :key="filterRole"
          :class="{ active: role === filterRole }"
          @click="role = filterRole"
        >
          {{ filterRole }}
        </button>
      </div>
    </header>

    <div v-if="messages.length" class="interview-transcript-list">
      <article
        v-for="(message, index) in filteredMessages"
        :key="`${sessionId}-${index}-${message.role}`"
        :class="`history-message--${message.role}`"
      >
        <header>
          <span>{{ message.role === 'assistant' ? 'AI' : message.speaker.slice(0, 1) }}</span>
          <div>
            <b>{{ message.speaker }}</b>
            <small>#{{ index + 1 }}｜{{ message.time }}</small>
          </div>
        </header>
        <p>{{ message.text }}</p>
        <div v-if="message.attachments?.length" class="history-message-attachments">
          <button
            v-for="attachment in message.attachments"
            :key="attachment.id"
            @click="emit('openAttachment', sessionId, attachment)"
          >
            <v-icon size="22">
              {{ attachment.mime_type === 'application/pdf' ? 'mdi-file-pdf-box' : 'mdi-file-image-outline' }}
            </v-icon>
            <span>
              <b>{{ attachment.name }}</b>
              <small>{{ formatAttachmentSize(attachment.size) }}｜クリックして確認</small>
            </span>
            <v-icon size="16">mdi-open-in-new</v-icon>
          </button>
        </div>
      </article>
      <div v-if="!filteredMessages.length" class="history-empty-filter">
        <v-icon size="30">mdi-text-search</v-icon>
        <b>一致する発言がありません</b>
        <span>検索語または表示対象を変更してください。</span>
      </div>
    </div>
    <div v-else class="history-empty-conversation">
      <v-icon size="38">mdi-message-off-outline</v-icon>
      <b>保存済みの会話はありません</b>
      <p>{{ emptyDescription }}</p>
    </div>
  </section>
</template>
