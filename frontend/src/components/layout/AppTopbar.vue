<script setup lang="ts">
import { computed } from 'vue'
import type { AuthRole, AuthUser } from '../../api/auth'
import type { SelectItem, ViewKey } from './types'

const props = defineProps<{
  currentView: ViewKey
  sidebarHidden: boolean
  pageTitle: string
  processDepartmentId: string
  processDepartments: SelectItem[]
  processBusinessId: string
  processBusinesses: SelectItem[]
  currentUser: AuthUser | null
  tenantRole: AuthRole
  userInitials: string
}>()

const processDepartmentSelectItems = computed(() => props.processDepartments.map((item) => ({
  ...item,
  title: item.count === undefined ? item.title : `${item.title}（${item.count}）`,
})))

const emit = defineEmits<{
  openMobile: []
  showSidebar: []
  selectProcessDepartment: [departmentId: string]
  selectProcessBusiness: [businessId: string]
  openSpeechSettings: []
  logout: []
}>()

function selectDepartment(departmentId: string) {
  emit('selectProcessDepartment', departmentId)
}

function selectBusiness(businessId: string) {
  emit('selectProcessBusiness', businessId)
}
</script>

<template>
  <header class="topbar" :class="{ 'topbar--process': currentView === 'process' }">
    <button class="mobile-menu" @click="emit('openMobile')"><v-icon>mdi-menu</v-icon></button>
    <button
      v-if="sidebarHidden"
      class="sidebar-show-button"
      title="サイドメニューを展開"
      aria-label="サイドメニューを展開"
      @click="emit('showSidebar')"
    >
      <v-icon size="20">mdi-menu-open</v-icon>
    </button>
    <div class="breadcrumbs">
      <span>Ayatori</span>
      <v-icon size="15">mdi-chevron-right</v-icon>
      <strong>{{ pageTitle }}</strong>
    </div>

    <div v-if="currentView === 'process'" class="process-app-picker">
      <label>
        <span>業務部門</span>
        <div>
          <v-icon size="17">mdi-domain</v-icon>
          <v-select
            class="process-picker-select"
            :model-value="processDepartmentId"
            :items="processDepartmentSelectItems"
            item-title="title"
            item-value="value"
            variant="plain"
            density="compact"
            hide-details
            menu-icon=""
            aria-label="As-Isの業務部門"
            @update:model-value="selectDepartment"
          ></v-select>
          <v-icon size="16">mdi-chevron-down</v-icon>
        </div>
      </label>
      <v-icon class="process-picker-arrow" size="18">mdi-chevron-right</v-icon>
      <label class="process-business-picker">
        <span>業務一覧</span>
        <div>
          <v-icon size="17">mdi-vector-polyline</v-icon>
          <v-select
            class="process-picker-select"
            :model-value="processBusinessId"
            :items="processBusinesses"
            item-title="title"
            item-value="value"
            variant="plain"
            density="compact"
            hide-details
            menu-icon=""
            aria-label="As-Isの業務一覧"
            @update:model-value="selectBusiness"
          ></v-select>
          <v-icon size="16">mdi-chevron-down</v-icon>
        </div>
      </label>
    </div>

    <div class="topbar__actions">
      <button class="theme-toggle" title="読み上げの設定" aria-label="読み上げの設定" @click="emit('openSpeechSettings')">
        <v-icon size="18">mdi-account-voice</v-icon>
      </button>
      <div class="topbar-user">
        <div class="avatar topbar-user__avatar" :title="currentUser?.name || 'ローカル利用'">
          {{ currentUser ? userInitials : 'AY' }}
        </div>
        <div class="topbar-user__details">
          <strong>{{ currentUser?.name || 'ローカル利用' }}</strong>
          <span>{{ currentUser ? `${tenantRole}｜${currentUser.department || '部門未設定'}` : 'ログインなし（開発モード）' }}</span>
        </div>
        <button
          v-if="currentUser"
          class="topbar-user__logout"
          title="ログアウト"
          aria-label="ログアウト"
          @click="emit('logout')"
        >
          <v-icon size="18">mdi-logout</v-icon>
        </button>
        <v-icon v-else class="topbar-user__more" size="18">mdi-dots-horizontal</v-icon>
      </div>
    </div>
  </header>
</template>
