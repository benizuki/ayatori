<script setup lang="ts">
import { toRef } from 'vue'
import type { TenantRecord } from '../../../api/auth'
import type { BusinessProcessMaster, Department, ProcessModel, Stage } from '../../../models'
import type { DepartmentForm, DepartmentReferenceCounts } from '../types'

const props = defineProps<{
  departments: Department[]
  tenants: TenantRecord[]
  currentTenantName?: string
  editingDepartmentId: string
  form: DepartmentForm
  canManageTenantAssignments: boolean
  stages: Stage[]
  iconOptions: Array<{ title: string; value: string }>
  error: string
  referenceCounts: (departmentId: string) => DepartmentReferenceCounts
  linkedBusinesses: (departmentId: string) => BusinessProcessMaster[]
  linkedModels: (departmentId: string) => ProcessModel[]
}>()

const open = defineModel<boolean>('open', { required: true })
const deleteOpen = defineModel<boolean>('deleteOpen', { required: true })
const form = toRef(props, 'form')

const emit = defineEmits<{
  add: []
  select: [department: Department]
  reassignBusiness: [business: BusinessProcessMaster, departmentId: string]
  reassignModel: [model: ProcessModel, departmentId: string]
  requestDelete: []
  delete: []
  save: []
}>()
</script>

<template>
  <v-dialog v-model="open" max-width="1040">
    <v-card class="dialog-card department-master-dialog">
      <v-card-title>業務領域マスター</v-card-title>
      <v-card-subtitle>業務調査で使用する業務領域、責任者、進捗を一元管理します。利用者の所属組織とは別のものです。</v-card-subtitle>
      <v-card-text>
        <div class="department-master-layout">
          <aside class="department-master-list">
            <div class="department-master-list__header"><span>登録済みの業務領域</span><button @click="emit('add')"><v-icon size="17">mdi-plus</v-icon>追加</button></div>
            <button v-for="department in departments" :key="department.id" :class="{ active: editingDepartmentId === department.id }" @click="emit('select', department)">
              <i :style="{ color: department.color, background: department.color + '16' }"><v-icon size="19">{{ department.icon }}</v-icon></i>
              <span><b>{{ department.name }}</b><small>{{ tenants.find((tenant) => tenant.id === department.tenantId)?.name || currentTenantName }}｜{{ department.id }}｜{{ department.owner }}</small></span>
              <em>{{ referenceCounts(department.id).businesses }}</em>
            </button>
            <p v-if="departments.length === 0" class="department-master-list__empty"><v-icon size="18">mdi-domain-off</v-icon>業務領域はまだありません。右の入力欄から追加してください。</p>
          </aside>

          <section class="department-master-editor">
            <div class="department-master-preview">
              <i :style="{ color: form.color, background: form.color + '16' }"><v-icon size="24">{{ form.icon }}</v-icon></i>
              <span><small>{{ editingDepartmentId ? '業務領域を編集' : '新しい業務領域を追加' }}</small><b>{{ form.name || '業務領域名未入力' }}</b></span>
            </div>
            <div class="department-master-form">
              <label><span>業務領域ID（自動生成）</span><output class="department-id-display"><code>{{ form.id }}</code><v-icon size="16">mdi-lock-outline</v-icon></output><small>新規登録時に8文字のUIDを自動生成します。</small></label>
              <v-select
                v-model="form.tenantId"
                :items="tenants.filter((item) => item.enabled)"
                item-title="name"
                item-value="id"
                label="所属テナント"
                :disabled="!canManageTenantAssignments"
                :hint="canManageTenantAssignments ? undefined : 'テナントの変更はシステム管理者のみ実行できます。'"
                :persistent-hint="!canManageTenantAssignments"
                :hide-details="canManageTenantAssignments"
                density="comfortable"
              ></v-select>
              <v-text-field v-model="form.name" label="業務領域名" placeholder="例：営業企画" density="comfortable" hide-details></v-text-field>
              <v-text-field v-model="form.owner" label="調査責任者" placeholder="例：山田 太郎" density="comfortable" hide-details></v-text-field>
              <v-select v-model="form.stage" :items="stages" label="調査フェーズ" density="comfortable" hide-details></v-select>
              <label><span>調査進捗</span><div class="department-progress-input"><input v-model.number="form.progress" type="range" min="0" max="100" /><b>{{ form.progress }}%</b></div></label>
              <v-select
                v-model="form.icon"
                :items="iconOptions"
                item-title="title"
                item-value="value"
                label="アイコン"
                density="comfortable"
                hide-details
              ></v-select>
              <label><span>表示色</span><div class="department-color-input"><input v-model="form.color" type="color" /><input v-model="form.color" maxlength="7" /></div></label>
            </div>

            <section v-if="editingDepartmentId" class="department-link-management">
              <header><div><b>業務領域の紐付け</b><small>業務とAs-Isごとに、対象の業務領域を変更できます。</small></div><v-icon size="19">mdi-source-branch</v-icon></header>
              <div class="department-link-columns">
                <div class="department-link-group">
                  <div class="department-link-group__title"><span><v-icon size="17">mdi-book-open-outline</v-icon>業務</span><em>{{ linkedBusinesses(editingDepartmentId).length }}件</em></div>
                  <div class="department-link-list">
                    <article v-for="business in linkedBusinesses(editingDepartmentId)" :key="business.id">
                      <span><b>{{ business.name }}</b><small>{{ business.status }}｜確認観点 {{ business.interviewTopics.length }}項目</small></span>
                      <v-select
                        :model-value="business.departmentId"
                        :items="departments"
                        item-title="name"
                        item-value="id"
                        aria-label="業務の業務領域"
                        density="compact"
                        hide-details
                        @update:model-value="(value: string) => emit('reassignBusiness', business, value)"
                      ></v-select>
                    </article>
                    <p v-if="linkedBusinesses(editingDepartmentId).length === 0"><v-icon size="18">mdi-link-off</v-icon>紐付く業務はありません</p>
                  </div>
                </div>
                <div class="department-link-group">
                  <div class="department-link-group__title"><span><v-icon size="17">mdi-vector-polyline</v-icon>As-Is</span><em>{{ linkedModels(editingDepartmentId).length }}件</em></div>
                  <div class="department-link-list">
                    <article v-for="model in linkedModels(editingDepartmentId)" :key="model.businessId">
                      <span><b>{{ model.title }}</b><small>{{ model.reviewStatus }}｜{{ model.steps.length }}ステップ</small></span>
                      <v-select
                        :model-value="model.departmentId"
                        :items="departments"
                        item-title="name"
                        item-value="id"
                        aria-label="As-Isの業務領域"
                        density="compact"
                        hide-details
                        @update:model-value="(value: string) => emit('reassignModel', model, value)"
                      ></v-select>
                    </article>
                    <p v-if="linkedModels(editingDepartmentId).length === 0"><v-icon size="18">mdi-link-off</v-icon>紐付くAs-Isはありません</p>
                  </div>
                </div>
              </div>
            </section>

            <div v-if="editingDepartmentId" class="department-reference-summary">
              <v-icon size="18">mdi-link-variant</v-icon>
              <span>業務 {{ referenceCounts(editingDepartmentId).businesses }}件・As-Is {{ referenceCounts(editingDepartmentId).asIsModels }}件・ヒアリング {{ referenceCounts(editingDepartmentId).interviews }}件・作業断片 {{ referenceCounts(editingDepartmentId).fragments }}件から参照</span>
            </div>
            <p v-if="error" class="department-form-error"><v-icon size="17">mdi-alert-circle-outline</v-icon>{{ error }}</p>
          </section>
        </div>
      </v-card-text>
      <v-card-actions>
        <v-btn v-if="editingDepartmentId" color="error" variant="text" prepend-icon="mdi-trash-can-outline" @click="emit('requestDelete')">削除</v-btn>
        <v-spacer></v-spacer>
        <v-btn variant="text" @click="open = false">閉じる</v-btn>
        <v-btn color="primary" prepend-icon="mdi-content-save-outline" @click="emit('save')">業務領域を保存</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <v-dialog v-model="deleteOpen" max-width="470">
    <v-card class="delete-dialog-card">
      <div class="delete-dialog-icon"><v-icon size="27">mdi-trash-can-outline</v-icon></div>
      <v-card-title>この業務領域を削除しますか？</v-card-title>
      <v-card-text><b>{{ departments.find((item) => item.id === editingDepartmentId)?.name }}</b><span>{{ editingDepartmentId }}</span><p>業務領域マスターから削除します。この操作は取り消せません。</p><p v-if="referenceCounts(editingDepartmentId).orphanFragments">ヒアリングが残っていない作業断片 {{ referenceCounts(editingDepartmentId).orphanFragments }}件も一緒に削除されます。</p><p v-if="referenceCounts(editingDepartmentId).orphanAsIsModels">業務が残っていないAs-Is {{ referenceCounts(editingDepartmentId).orphanAsIsModels }}件も一緒に削除されます。</p></v-card-text>
      <v-card-actions><v-spacer></v-spacer><v-btn variant="text" @click="deleteOpen = false">キャンセル</v-btn><v-btn color="error" prepend-icon="mdi-trash-can-outline" @click="emit('delete')">業務領域を削除</v-btn></v-card-actions>
    </v-card>
  </v-dialog>
</template>
