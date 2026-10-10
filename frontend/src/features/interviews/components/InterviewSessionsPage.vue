<script setup lang="ts">
import { computed } from 'vue'
import type { Department } from '../../../models'
import type { InterviewSessionGroup, InterviewSessionStatus, InterviewSessionSummary } from '../types'

const props = defineProps<{
  departmentId: string
  departments: Department[]
  allSessions: InterviewSessionGroup[]
  filteredSessions: InterviewSessionGroup[]
  departmentSessionCount: number
  sessionCounts: Partial<Record<InterviewSessionStatus | 'すべて', number>>
  activeFilter: InterviewSessionStatus | 'すべて'
  canEdit: boolean
}>()

const emit = defineEmits<{
  sync: []
  startGuidedInterview: []
  startDiscoveryInterview: []
  selectDepartment: [departmentId: string]
  selectFilter: [filter: InterviewSessionStatus | 'すべて']
  edit: [session: InterviewSessionSummary]
  openTranscript: [session: InterviewSessionSummary]
  resume: [session: InterviewSessionSummary]
  openAsIsUpdate: [session: InterviewSessionSummary]
  openAsIs: [session: InterviewSessionSummary]
  delete: [session: InterviewSessionSummary]
}>()

const localDateTimeFormatter = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

// Tolerates missing timestamps: sessions persisted by older builds can lack
// createdAt, and throwing here would blank the whole list and make every row's
// buttons unreachable.
function formatLocalDateTime(value: string | undefined) {
  const timestamp = (value ?? '').trim()
  if (!timestamp) return '—'
  if (!timestamp || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) return value

  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? value : localDateTimeFormatter.format(date)
}

function sessionKind(group: InterviewSessionGroup, session: InterviewSessionSummary) {
  const sessionIndex = group.sessions.findIndex((item) => item.id === session.id)
  if (sessionIndex <= 0) return '初回ヒアリング'
  return `追加ヒアリング ${sessionIndex}`
}

function groupParticipants(group: InterviewSessionGroup) {
  return [...new Set(group.sessions.map((session) => session.participant).filter(Boolean))].join('、') || '参加者未設定'
}

// 件数つきのラベルを作り、v-selectの選択肢として渡す。
const departmentFilterItems = computed(() => [
  { id: 'all', label: `すべての業務領域（${props.allSessions.length}）` },
  ...props.departments.map((department) => ({
    id: department.id,
    label: `${department.name}（${
      props.allSessions.filter((group) => group.departmentId === department.id).length
    }）`,
  })),
])
</script>

<template>
  <section class="page interview-sessions-page">
    <div class="page-heading page-heading--compact">
      <div>
        <div class="eyebrow">INTERVIEW SESSIONS</div>
        <h1>ヒアリング一覧</h1>
        <p>中断中のヒアリングを再開し、完了・As-Is作成済みの状態を確認します。</p>
      </div>
      <div class="heading-actions">
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-database-sync-outline" @click="emit('sync')">
          保存済みを同期
        </v-btn>
        <v-btn variant="tonal" color="primary" prepend-icon="mdi-clipboard-list-outline" :disabled="!canEdit" @click="emit('startGuidedInterview')">
          業務指定
        </v-btn>
        <v-btn color="primary" prepend-icon="mdi-radar" :disabled="!canEdit" @click="emit('startDiscoveryInterview')">
          自由探索
        </v-btn>
      </div>
    </div>

    <div class="session-department-toolbar panel">
      <label>
        <span>表示する部門</span>
        <v-select
          :model-value="departmentId"
          :items="departmentFilterItems"
          item-title="label"
          item-value="id"
          aria-label="ヒアリング一覧の表示業務領域"
          prepend-inner-icon="mdi-domain"
          density="compact"
          hide-details
          @update:model-value="(value: string) => emit('selectDepartment', value)"
        ></v-select>
      </label>
      <p>
        <v-icon size="17">mdi-filter-variant</v-icon>
        {{ departmentId === 'all'
          ? '全社のヒアリングを表示中'
          : `${departments.find((department) => department.id === departmentId)?.name ?? '選択部門'}のヒアリングを表示中` }}
      </p>
    </div>

    <div class="session-management-summary">
      <button
        v-for="status in ['すべて', '進行中', '中断', '完了', 'As-Is作成済'] as const"
        :key="status"
        :class="{ active: activeFilter === status }"
        @click="emit('selectFilter', status)"
      >
        <span>{{ status }}</span>
        <b>{{ status === 'すべて' ? departmentSessionCount : sessionCounts[status] ?? 0 }}</b>
      </button>
    </div>

    <section class="panel interview-session-list">
      <article
        v-for="group in filteredSessions"
        :key="group.id"
        :class="`session-group session-row--${group.status}`"
      >
        <header class="session-group__header">
          <div class="session-row__main">
            <span class="session-status-pill">{{ group.status }}</span>
            <h2>{{ group.title }}</h2>
            <p>{{ groupParticipants(group) }}｜{{ group.departmentName }}｜初回＋追加 {{ Math.max(0, group.sessions.length - 1) }}回</p>
          </div>
          <div class="session-row__metrics">
            <span><b>{{ group.completionScore }}%</b><small>最大カバレッジ</small></span>
            <span><b>{{ group.messageCount }}</b><small>総発言</small></span>
            <span><b>{{ group.fragmentCount }}</b><small>作業断片</small></span>
          </div>
          <div class="session-row__date">
            <b>{{ formatLocalDateTime(group.updatedAt) }}</b>
            <small>{{ formatLocalDateTime(group.createdAt) }} 初回開始</small>
          </div>
          <div class="session-group__primary-action">
            <button v-if="group.businessId" @click="emit('openAsIs', group.sessions[group.sessions.length - 1])">
              <v-icon size="18">mdi-vector-polyline</v-icon>As-Isへ
            </button>
          </div>
        </header>

        <div class="session-group__sessions">
          <section v-for="session in group.sessions" :key="session.id" class="session-group__session">
            <div class="session-group__kind">
              <b>{{ sessionKind(group, session) }}</b>
              <span :class="`session-status-pill session-status-pill--small`">{{ session.status }}</span>
            </div>
            <div class="session-group__detail">
              <b>{{ session.participant }}｜{{ session.phase }}</b>
              <small>{{ formatLocalDateTime(session.updatedAt) }}｜発言 {{ session.messageCount }}件｜断片 {{ session.fragmentCount }}件</small>
            </div>
            <div class="session-group__session-actions">
              <button title="部門・参加者を編集" :disabled="!canEdit" @click="emit('edit', session)">
                <v-icon size="16">mdi-pencil-outline</v-icon>編集
              </button>
              <button @click="emit('openTranscript', session)">
                <v-icon size="17">mdi-message-text-outline</v-icon>履歴
              </button>
              <button v-if="session.sourceProcessId && session.status === '完了'" @click="emit('openAsIsUpdate', session)">
                <v-icon size="17">mdi-vector-polyline-edit</v-icon>As-Is更新
              </button>
              <button v-else-if="session.status !== 'As-Is作成済'" :disabled="!canEdit" @click="emit('resume', session)">
                <v-icon size="17">mdi-play-circle-outline</v-icon>{{ session.status === '中断' ? '再開' : '開く' }}
              </button>
              <button
                class="session-row__delete"
                :disabled="!canEdit || session.status === 'As-Is作成済'"
                title="この回のヒアリングを削除"
                @click="emit('delete', session)"
              >
                <v-icon size="17">mdi-trash-can-outline</v-icon>削除
              </button>
            </div>
          </section>
        </div>
      </article>

      <div v-if="!filteredSessions.length" class="session-empty">
        <v-icon size="42">mdi-message-processing-outline</v-icon>
        <b>{{ allSessions.length ? '条件に一致するヒアリングがありません' : 'ヒアリングはまだありません' }}</b>
        <p>{{ allSessions.length
          ? '表示部門またはステータスを変更してください。'
          : '新しいヒアリングを開始すると、ここに中断・再開できるセッションとして保存されます。' }}</p>
      </div>
    </section>
  </section>
</template>
