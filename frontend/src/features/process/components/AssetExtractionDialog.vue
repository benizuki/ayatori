<script setup lang="ts">
import type { AssetLedgerField } from '../../../api/process'

defineProps<{
  modelValue: boolean
  loading: boolean
  error: string
  fileName: string
  documentType: string
  summary: string
  fields: AssetLedgerField[]
  warnings: string[]
  selectedFieldIndexes: number[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:selectedFieldIndexes': [value: number[]]
  apply: []
}>()

function toggleField(index: number, current: number[]) {
  const next = current.includes(index) ? current.filter((item) => item !== index) : [...current, index]
  emit('update:selectedFieldIndexes', next)
}
</script>

<template>
  <v-dialog :model-value="modelValue" max-width="720" persistent @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card asset-extraction-dialog">
      <div class="process-dialog-header">
        <span><v-icon>mdi-text-box-search-outline</v-icon></span>
        <div>
          <small>AI FIELD EXTRACTION</small>
          <h2>資料から項目を抽出</h2>
          <p>{{ fileName || 'PDF・スクリーンショットを解析します' }}</p>
        </div>
        <button v-if="!loading" aria-label="項目の抽出を閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text>
        <div v-if="loading" class="asset-extraction-loading">
          <v-progress-circular color="primary" indeterminate size="42"/>
          <b>Geminiが資料を解析しています</b>
          <p>列見出しや入力欄を読み取り、項目の候補を作成しています。</p>
        </div>
        <template v-else>
          <p v-if="error" class="asset-extraction-error"><v-icon size="19">mdi-alert-circle-outline</v-icon>{{ error }}</p>
          <div v-if="fields.length" class="asset-extraction-result">
            <header>
              <div><b>{{ documentType || '資料' }}</b><span>{{ summary }}</span></div>
              <em>{{ fields.length }}項目</em>
            </header>
            <div class="asset-extraction-fields">
              <label v-for="(field, index) in fields" :key="`${field.name}-${index}`">
                <input
                  type="checkbox"
                  :value="index"
                  :checked="selectedFieldIndexes.includes(index)"
                  @change="toggleField(index, selectedFieldIndexes)"
                />
                <span><b>{{ field.name }}</b><small>{{ field.description || '説明は資料から特定できませんでした' }}</small></span>
                <em>{{ field.data_type }}</em>
                <strong>{{ field.confidence }}%</strong>
              </label>
            </div>
            <div v-if="warnings.length" class="asset-extraction-warnings">
              <p v-for="warning in warnings" :key="warning"><v-icon size="16">mdi-alert-outline</v-icon>{{ warning }}</p>
            </div>
          </div>
        </template>
      </v-card-text>

      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn variant="text" :disabled="loading" @click="emit('update:modelValue', false)">キャンセル</v-btn>
        <v-btn color="primary" prepend-icon="mdi-check" :disabled="loading || !selectedFieldIndexes.length" @click="emit('apply')">選択した項目を反映</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
