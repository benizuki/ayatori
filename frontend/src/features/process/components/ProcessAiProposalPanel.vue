<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AiProposal, ProcessAiProposalSet } from '../process-ai-opportunity-model'
import { ECRS_LABELS, REVIEW_STATUSES, emptyReview, nonnegativeHours, summarizeImprovementImpact, type EcrsPrinciple, type ImprovementReview } from '../process-improvement'
import { useWorkspaceStore } from '../../workspace/useWorkspaceStore'

const props = defineProps<{
  title: string
  proposalSet: ProcessAiProposalSet
  generating: boolean
  error: string
  canEdit: boolean
  reviews: Record<string, ImprovementReview>
  stale: boolean
  focusStepId: string
}>()
const emit = defineEmits<{
  generate: []
  review: [id: string, changes: Partial<ImprovementReview>]
  showSteps: [stepIds: string[]]
  showMap: [stepIds: string[]]
  clearFocus: []
}>()
const { notify } = useWorkspaceStore()
const principle = ref<EcrsPrinciple | ''>('')
const status = ref('すべて')
const method = ref('すべて')
const confirmRegenerate = ref(false)
const reviewOf = (id: string) => props.reviews[id] ?? emptyReview()
const impact = computed(() => summarizeImprovementImpact(props.proposalSet.proposals, props.reviews, null))
const methods = ['すべて', '運用変更', '通常自動化', 'AI支援', 'AI Agent', '人中心', '追加調査']
const visible = computed(() => props.proposalSet.proposals.filter((proposal) =>
  (!principle.value || proposal.ecrs.includes(principle.value))
  && (status.value === 'すべて' || reviewOf(proposal.id).status === status.value)
  && (method.value === 'すべて' || proposal.kindLabel === method.value)
  && (!props.focusStepId || proposal.stepIds.includes(props.focusStepId)),
))
function generate() {
  if (Object.values(props.reviews).some((review) => review.status !== '未検討' || review.reason || review.laborHours !== null || review.waitingHours !== null)) confirmRegenerate.value = true
  else emit('generate')
}
function markdown(proposal: AiProposal) {
  const review = reviewOf(proposal.id)
  return [
    `## ${proposal.title}`,
    `- ECRS: ${proposal.ecrs.map((key) => `${key} ${ECRS_LABELS[key]}`).join(' / ') || '未判定'}`,
    `- 実現手段: ${proposal.kindLabel} / ${proposal.priorityLabel}`,
    `- 対象工程: ${proposal.stepLabels.join(' / ')}`,
    `- 現状: ${proposal.before || '未確認'}`,
    `- 変更後: ${proposal.after || '未確認'}`,
    ...proposal.improvementActions.map((action) => `- 変更手順: ${action}`),
    ...proposal.aiActions.map((action) => `- 実現手段の詳細: ${action}`),
    ...proposal.reasons.map((reason) => `- 根拠: ${reason}`),
    ...proposal.expectedBenefits.map((benefit) => `- 期待効果: ${benefit}`),
    `- 人の役割: ${proposal.humanRole}`,
    ...proposal.requirements.map((item) => `- 導入条件: ${item}`),
    ...proposal.risks.map((item) => `- リスク: ${item}`),
    ...proposal.missingInformation.map((item) => `- 要確認: ${item}`),
    `- 検討状況: ${review.status} / 理由・試算根拠: ${review.reason || '未記入'}`,
    `- 月間削減工数（試算）: ${review.laborHours ?? '未入力'} 時間`,
    `- 1件あたり待ち時間短縮（試算・合計対象外）: ${review.waitingHours ?? '未入力'} 時間`,
  ].join('\n')
}
async function copy() {
  try {
    await navigator.clipboard.writeText([`# ${props.title} 業務改善提案`, props.stale ? '注意: As-Isまたは分類が更新されています。再検討が必要です。' : '', props.proposalSet.source === 'rule' ? 'ルールによる検討のたたき台（未検証）' : 'AI生成による改善仮説', ...visible.value.map(markdown)].join('\n\n'))
    notify('表示中の改善提案をコピーしました')
  } catch { notify('改善提案をコピーできませんでした') }
}
</script>

<template>
  <div class="ai-proposal-view improvement-view" role="region" aria-label="業務改善提案の内容" tabindex="0">
    <header class="ai-proposal-hero">
      <div>
        <span>業務の見直し → 実現手段の検討</span>
        <h2>業務改善提案</h2>
        <p>ECRSで業務を見直し、運用変更・通常自動化・AI活用を組み合わせます。</p>
        <p>{{ proposalSet.source === 'llm' ? 'AI生成による改善仮説' : 'ルールによる検討のたたき台（未検証）' }}<template v-if="proposalSet.generatedAt"> ｜ {{ new Date(proposalSet.generatedAt).toLocaleString('ja-JP') }}</template></p>
        <p>提案と検討結果は「As-Isを保存」で保存します。</p>
      </div>
      <v-btn v-if="canEdit" color="primary" prepend-icon="mdi-lightbulb-on-outline" :loading="generating" @click="generate">{{ proposalSet.source === 'llm' ? '改善案を再生成' : 'AIで改善案を作る' }}</v-btn>
    </header>
    <v-alert v-if="error" type="error">{{ error }} 現在の提案を保持しています。</v-alert>
    <v-alert v-if="stale" type="warning">As-Isまたは業務マップの分類が変わっています。現在の提案は変更前の情報に基づくため、再生成して検討し直してください。</v-alert>
    <v-alert v-if="proposalSet.uncoveredStepLabels?.length" type="info">未提案の工程：{{ proposalSet.uncoveredStepLabels.join('、') }}</v-alert>

    <nav class="improvement-filters" aria-label="改善案の絞り込み">
      <v-btn :variant="principle === '' ? 'flat' : 'outlined'" @click="principle = ''">ECRSすべて</v-btn>
      <v-btn v-for="(label, key) in ECRS_LABELS" :key="key" :variant="principle === key ? 'flat' : 'outlined'" @click="principle = key">{{ key }} {{ label }}</v-btn>
      <v-select v-model="method" label="実現手段" :items="methods" hide-details />
      <v-select v-model="status" label="検討状況" :items="['すべて', ...REVIEW_STATUSES]" hide-details />
      <v-btn variant="text" prepend-icon="mdi-content-copy" :disabled="!visible.length" @click="copy">表示中の提案をコピー</v-btn>
    </nav>
    <v-alert v-if="focusStepId" type="info">業務マップで選択したタスクの提案に絞り込んでいます。<v-btn variant="text" @click="emit('clearFocus')">全工程を表示</v-btn></v-alert>

    <article v-for="proposal in visible" :key="proposal.id" class="improvement-card">
      <div class="improvement-badges">
        <span v-for="key in proposal.ecrs" :key="key" class="improvement-badge" :class="`improvement-badge--${key}`"><b>{{ key }}</b>{{ ECRS_LABELS[key] }}</span>
        <span class="improvement-badge improvement-badge--method"><v-icon size="16">mdi-tools</v-icon>{{ proposal.kindLabel }}</span>
        <span class="improvement-badge" :class="`improvement-badge--${proposal.priority}`">{{ proposal.priorityLabel }}</span>
        <span class="improvement-badge improvement-badge--status" :class="{ 'improvement-badge--accepted': reviewOf(proposal.id).status === '採用候補', 'improvement-badge--held': reviewOf(proposal.id).status === '保留' }">{{ reviewOf(proposal.id).status }}</span>
      </div>
      <h3 class="improvement-title">{{ proposal.title }}</h3><p class="improvement-summary">{{ proposal.summary }}</p>
      <div class="improvement-before-after">
        <section class="improvement-before"><h4><v-icon size="18">mdi-clipboard-text-outline</v-icon>現状</h4><p>{{ proposal.before || '未確認。改善案を再生成してください。' }}</p></section>
        <section class="improvement-after"><h4><v-icon size="18">mdi-arrow-right-circle-outline</v-icon>変更後の案</h4><p>{{ proposal.after || '未確認。改善案を再生成してください。' }}</p></section>
      </div>
      <section class="improvement-actions"><h4><v-icon size="18">mdi-format-list-numbered</v-icon>具体的な変更手順</h4><ol><li v-for="action in proposal.improvementActions" :key="action">{{ action }}</li></ol></section>
      <p class="improvement-target"><b>対象工程</b>{{ proposal.stepLabels.join(' ／ ') }}</p>
      <div class="improvement-links">
      <v-btn variant="outlined" prepend-icon="mdi-sitemap-outline" @click="emit('showSteps', proposal.stepIds)">フローで対象工程を確認</v-btn>
      <v-btn variant="text" prepend-icon="mdi-table-large" @click="emit('showMap', proposal.stepIds)">業務マップで確認</v-btn>
      </div>
      <details class="improvement-details">
        <summary>根拠・実現手段・導入条件</summary>
        <p v-if="proposalSet.source === 'rule'">以下の実現手段は現在の工程から判定した参考候補です。ECRSで変更後の業務を決めた後、必要性と適用可否を再評価してください。</p>
        <div class="improvement-before-after">
          <section><h4>提案の根拠</h4><ul><li v-for="reason in proposal.reasons" :key="reason">{{ reason }}</li></ul></section>
          <section><h4>実現手段：{{ proposal.kindLabel }}</h4><ul><li v-for="action in proposal.aiActions" :key="action">{{ action }}</li></ul><p v-if="!proposal.aiActions.length">具体的な変更手順に沿って運用を見直します。</p></section>
          <section><h4>期待効果</h4><ul><li v-for="benefit in proposal.expectedBenefits" :key="benefit">{{ benefit }}</li></ul></section>
          <section><h4>人の役割</h4><p>{{ proposal.humanRole || '未確認' }}</p><p>現担当：{{ proposal.actor }}</p></section>
          <section><h4>導入条件</h4><ul><li v-for="item in proposal.requirements" :key="item">{{ item }}</li></ul></section>
          <section><h4>リスク</h4><ul><li v-for="item in proposal.risks" :key="item">{{ item }}</li></ul><p v-if="!proposal.risks.length">導入前に品質・安全・責任分担への影響を確認してください。</p></section>
          <section><h4>利用データ・システム</h4><p>入力・参照：{{ proposal.inputData.map(item => item.name).join('、') || '未確認' }}</p><p>更新・出力：{{ proposal.outputData.map(item => item.name).join('、') || '未確認' }}</p><p>システム：{{ proposal.systemNames.join('、') || '未確認' }}</p></section>
        </div>
      </details>
      <section v-if="proposal.missingInformation.length" class="improvement-questions"><h4><v-icon size="18">mdi-comment-question-outline</v-icon>追加で確認すること</h4><ul><li v-for="item in proposal.missingInformation" :key="item">{{ item }}</li></ul></section>
      <div class="improvement-review">
        <v-select label="検討状況" :items="REVIEW_STATUSES" :model-value="reviewOf(proposal.id).status" :disabled="!canEdit || generating" @update:model-value="emit('review', proposal.id, { status: $event })" />
        <v-text-field label="月間削減工数の試算（時間）" type="number" min="0" :model-value="reviewOf(proposal.id).laborHours" :disabled="!canEdit || generating" @update:model-value="emit('review', proposal.id, { laborHours: nonnegativeHours($event) })" />
        <v-text-field label="1件あたり待ち時間短縮の試算（時間）" type="number" min="0" :model-value="reviewOf(proposal.id).waitingHours" :disabled="!canEdit || generating" @update:model-value="emit('review', proposal.id, { waitingHours: nonnegativeHours($event) })" />
      </div>
      <v-textarea label="検討理由・試算の根拠（件数 × 1件あたり削減時間など）" rows="2" auto-grow maxlength="2000" :model-value="reviewOf(proposal.id).reason" :disabled="!canEdit || generating" @update:model-value="emit('review', proposal.id, { reason: $event })" />
      <p v-if="impact.conflictIds.has(proposal.id)">この採用候補は他の採用候補と対象工程が重なります。削減効果を重複して見積もっていないか確認してください。</p>
    </article>
    <v-alert v-if="!visible.length" type="info">該当する提案はありません。絞り込みを解除するか、As-Isの工程を確認して改善案を生成してください。</v-alert>
    <v-dialog v-model="confirmRegenerate" max-width="520">
      <v-card title="改善案を再生成しますか？" text="生成に成功すると、現在の提案と検討状況・理由・各案の試算値を置き換えます。必要な検討結果は先にコピーしてください。">
        <v-card-actions><v-spacer /><v-btn @click="confirmRegenerate = false">キャンセル</v-btn><v-btn color="primary" @click="confirmRegenerate = false; emit('generate')">再生成</v-btn></v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>
