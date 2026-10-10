<script setup lang="ts">
import { computed } from 'vue'
import type { ProcessModel, WorkFragment } from '../../../models'

const props = defineProps<{
  model?: ProcessModel
  fragments: WorkFragment[]
}>()

const open = defineModel<boolean>({ required: true })

const previewSteps = computed(() => {
  if (props.model) {
    return props.model.steps
      .filter((step) => step.type === 'task')
      .sort((left, right) => left.x - right.x || left.y - right.y)
      .map((step) => ({
        id: step.id,
        title: step.label,
        actor: step.actor || '未確認',
        system: step.system || '未確認',
        standardTime: step.duration || '未確認',
        processingVolume: step.monthlyVolume || '未確認',
      }))
  }
  return [...props.fragments].reverse().map((fragment) => ({
    id: fragment.id,
    title: fragment.title,
    actor: fragment.actor || '未確認',
    system: fragment.tools.filter((tool) => tool !== '未確認').join('・') || '未確認',
    standardTime: fragment.standardTime || '未確認',
    processingVolume: fragment.processingVolume || '未確認',
  }))
})

const lanes = computed(() => [...new Set(previewSteps.value.map((step) => step.actor))])
</script>

<template>
  <v-dialog v-model="open" max-width="1280" scrollable>
    <section class="interview-asis-preview">
      <header>
        <div>
          <span>{{ model ? 'CURRENT AS-IS' : 'INTERVIEW DRAFT' }}</span>
          <h2>{{ model?.title || 'ヒアリング途中のAs-Isプレビュー' }}</h2>
          <p>{{ model ? '保存されているAs-Isを、ヒアリングを離れずに確認できます。' : '現在までに抽出した工程を仮の順序で表示しています。' }}</p>
        </div>
        <button type="button" title="閉じる" @click="open = false"><v-icon>mdi-close</v-icon></button>
      </header>

      <div class="interview-asis-preview__meta">
        <span><v-icon size="16">mdi-format-list-numbered</v-icon>タスク {{ previewSteps.length }}件</span>
        <span><v-icon size="16">mdi-account-multiple-outline</v-icon>担当レーン {{ lanes.length }}件</span>
        <em>{{ model ? model.reviewStatus : 'ヒアリング途中・未確定' }}</em>
      </div>

      <div v-if="previewSteps.length" class="interview-asis-preview__canvas">
        <div class="interview-asis-preview__flow">
          <template v-for="(step, index) in previewSteps" :key="step.id">
            <article>
              <small>{{ step.actor }}</small>
              <b>{{ step.title }}</b>
              <dl>
                <div><dt>システム</dt><dd>{{ step.system }}</dd></div>
                <div><dt>標準時間</dt><dd>{{ step.standardTime }}</dd></div>
                <div><dt>処理件数</dt><dd>{{ step.processingVolume }}</dd></div>
              </dl>
            </article>
            <v-icon v-if="index < previewSteps.length - 1" size="24">mdi-arrow-right</v-icon>
          </template>
        </div>
      </div>
      <div v-else class="interview-asis-preview__empty">
        <v-icon size="34">mdi-vector-polyline</v-icon>
        <b>確認できる工程がまだありません</b>
        <span>回答または添付資料からタスクが抽出されると、ここに途中のAs-Isが表示されます。</span>
      </div>

      <footer>
        <span>このプレビューを閉じてもヒアリング内容は保持されます。</span>
        <button type="button" @click="open = false">ヒアリングへ戻る</button>
      </footer>
    </section>
  </v-dialog>
</template>
