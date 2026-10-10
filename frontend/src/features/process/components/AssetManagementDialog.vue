<script setup lang="ts">
import { operationalAssetTypes } from '../process-model'
import type { OperationalAsset, ProcessAssetLink, ProcessInformation, ProcessStep, WorkFragment } from '../../../models'

const props = defineProps<{
  modelValue: boolean
  search: string
  assets: OperationalAsset[]
  selectedAssetId: string
  selectedAsset?: OperationalAsset
  assetLinks: ProcessAssetLink[]
  information: ProcessInformation[]
  steps: ProcessStep[]
  workFragments: WorkFragment[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'update:search': [value: string]
  'update:selectedAssetId': [value: string]
  addAsset: []
  deleteAsset: [assetId: string]
  reflowAssets: []
  unlinkAsset: [linkId: string]
}>()

/**
 * このアセットを媒体としてやり取りされる情報。タスクの入力・出力から求めるので、ここでは編集しない。
 */
function informationOnSelectedAsset() {
  const assetId = props.selectedAsset?.id
  if (!assetId) return []
  return props.information.flatMap((information) => {
    const inputs = props.steps.filter((step) => (step.inputs ?? []).some((ref) => ref.informationId === information.id && ref.assetIds?.includes(assetId)))
    const outputs = props.steps.filter((step) => (step.outputs ?? []).some((ref) => ref.informationId === information.id && ref.assetIds?.includes(assetId)))
    return inputs.length || outputs.length ? [{ information, inputs, outputs }] : []
  })
}

function typeIcon(type: OperationalAsset['type']) {
  if (type === 'Excel・台帳') return 'mdi-microsoft-excel'
  if (type === 'メール') return 'mdi-email-outline'
  if (type === 'チャット') return 'mdi-chat-outline'
  if (type === '紙帳票') return 'mdi-file-document-outline'
  if (type === '共有フォルダ') return 'mdi-folder-network-outline'
  return 'mdi-database-outline'
}

function linkedStepCount(assetId: string) {
  return new Set(props.assetLinks.filter((link) => link.assetId === assetId).map((link) => link.stepId)).size
}

function linksForSelectedAsset() {
  return props.assetLinks.filter((link) => link.assetId === props.selectedAsset?.id)
}

function stepForLink(link: ProcessAssetLink) {
  return props.steps.find((step) => step.id === link.stepId)
}

function fragmentTitles(fragmentIds: string[]) {
  return fragmentIds
    .map((id) => props.workFragments.find((fragment) => fragment.id === id)?.title)
    .filter(Boolean)
    .join('、')
}

</script>

<template>
  <v-dialog :model-value="modelValue" max-width="1280" @update:model-value="emit('update:modelValue', $event)">
    <v-card class="process-dialog-card asset-management-dialog">
      <div class="process-dialog-header">
        <span><v-icon>mdi-database-edit-outline</v-icon></span>
        <div>
          <small>OPERATIONAL ASSETS</small>
          <h2>業務アセットを管理</h2>
          <p>アセットは情報の置き場所です（業務システム、共有フォルダ、Excel、紙、メールなど）。請求書や支払予定表のような書類はアセットではなく、工程の「入力・出力する情報」で登録し、その取得元・格納先にアセットを選びます。</p>
        </div>
        <button aria-label="業務アセット管理を閉じる" @click="emit('update:modelValue', false)"><v-icon>mdi-close</v-icon></button>
      </div>

      <v-card-text class="asset-management-body">
        <aside class="asset-catalog">
          <v-text-field
            :model-value="search"
            aria-label="アセットを検索"
            placeholder="名称・種類で検索"
            prepend-inner-icon="mdi-magnify"
            class="asset-search-field"
            density="compact"
            hide-details
            @update:model-value="(value: string) => emit('update:search', value)"
          ></v-text-field>
          <button class="add-asset-button" @click="emit('addAsset')"><v-icon size="17">mdi-plus</v-icon>アセットを追加</button>
          <div class="asset-catalog-list">
            <button
              v-for="asset in assets"
              :key="asset.id"
              :class="{ active: selectedAssetId === asset.id }"
              @click="emit('update:selectedAssetId', asset.id)"
            >
              <span class="asset-type-icon"><v-icon size="18">{{ typeIcon(asset.type) }}</v-icon></span>
              <span><b>{{ asset.name }}</b><small>{{ asset.type }}・{{ linkedStepCount(asset.id) }}工程</small></span>
              <em :class="{ confirmed: asset.status === '確認済み' }">{{ asset.status }}</em>
            </button>
            <p v-if="!assets.length">該当するアセットはありません</p>
          </div>
        </aside>

        <section v-if="selectedAsset" class="asset-editor">
          <header>
            <div><span>{{ selectedAsset.type }}</span><h3>{{ selectedAsset.name }}</h3></div>
            <button class="delete-asset-button" @click="emit('deleteAsset', selectedAsset.id)"><v-icon size="17">mdi-trash-can-outline</v-icon>削除</button>
          </header>
          <div class="asset-editor-grid">
            <v-text-field v-model="selectedAsset.name" label="アセット名" maxlength="80" class="asset-field--half" density="comfortable" hide-details></v-text-field>
            <v-select v-model="selectedAsset.type" :items="operationalAssetTypes" label="種類" density="comfortable" hide-details></v-select>
            <v-select v-model="selectedAsset.status" :items="['未確認', '確認済み']" label="確認状態" density="comfortable" hide-details></v-select>
            <v-text-field v-model="selectedAsset.purpose" label="用途" placeholder="例：端末情報と登録状況を管理" class="asset-field--half" density="comfortable" hide-details></v-text-field>
            <v-text-field v-model="selectedAsset.owner" label="管理部門・オーナー" placeholder="未確認" density="comfortable" hide-details></v-text-field>
            <v-text-field v-model="selectedAsset.location" label="保管場所・URL" placeholder="未確認" density="comfortable" hide-details></v-text-field>
            <label class="asset-confidence-field">
              <span>抽出確度</span>
              <div class="asset-confidence"><input v-model.number="selectedAsset.confidence" type="range" min="0" max="100"/><b>{{ selectedAsset.confidence }}%</b></div>
            </label>
          </div>

          <div class="asset-linked-information">
            <h4>やり取りされる情報 <span>{{ informationOnSelectedAsset().length }}</span></h4>
            <article v-for="entry in informationOnSelectedAsset()" :key="entry.information.id">
              <b>{{ entry.information.name }}</b>
              <small v-if="entry.information.items?.length">{{ entry.information.items.join('、') }}</small>
              <span v-if="entry.outputs.length"><v-icon size="15">mdi-logout</v-icon>格納・送付するタスク：{{ entry.outputs.map((step) => step.label).join('・') }}</span>
              <span v-if="entry.inputs.length"><v-icon size="15">mdi-login</v-icon>取得するタスク：{{ entry.inputs.map((step) => step.label).join('・') }}</span>
            </article>
            <p v-if="!informationOnSelectedAsset().length" class="asset-linked-information__empty"><v-icon size="16">mdi-alert-circle-outline</v-icon>どの情報の取得元・格納先にもなっていません。役割を確認し、使っていなければ棚卸しの対象です。工程の詳細の「入力・出力する情報」で取得元・格納先に選ぶと、ここに集まります。</p>
          </div>

          <div class="asset-linked-processes">
            <h4>工程との紐付け <span>{{ linksForSelectedAsset().length }}</span></h4>
            <article v-for="link in linksForSelectedAsset()" :key="link.id">
              <span><v-icon size="16">mdi-vector-polyline</v-icon><b>{{ stepForLink(link)?.label }}</b></span>
              <em class="asset-link-role">{{ link.relation === '入力' ? '取得元' : '格納先' }}</em>
              <button title="情報の取得元・格納先からこのアセットを外す" @click="emit('unlinkAsset', link.id)"><v-icon size="16">mdi-link-off</v-icon></button>
              <small class="asset-link-information">{{ (link.informationIds ?? []).map((id) => information.find((item) => item.id === id)?.name).filter(Boolean).join('・') }}</small>
            </article>
            <p v-if="!linksForSelectedAsset().length">工程との紐付けはありません。工程の「入力・出力する情報」で取得元・格納先に選ぶと紐付きます。</p>
          </div>

          <div class="asset-source">
            <v-icon size="18">mdi-message-text-outline</v-icon>
            <span>
              <b>ヒアリング根拠 {{ selectedAsset.sourceFragmentIds.length }}件</b>
              <small>{{ selectedAsset.sourceFragmentIds.length ? fragmentTitles(selectedAsset.sourceFragmentIds) : '手動で追加されたアセットです' }}</small>
            </span>
          </div>
        </section>

        <section v-else class="asset-editor-empty">
          <v-icon size="42">mdi-database-search-outline</v-icon>
          <b>アセットを選択してください</b>
          <p>左の一覧から選ぶか、新しいアセットを追加します。</p>
        </section>
      </v-card-text>

      <v-card-actions>
        <span class="asset-save-note"><v-icon size="16">mdi-information-outline</v-icon>変更内容は画面上部の「As-Isを保存」で保存します。</span>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="emit('update:modelValue', false)">閉じる</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
