<script setup lang="ts">
import { ref } from 'vue'
import type { AuthRole, TenantRecord } from '../../api/auth'
import type { NavigationItem, NavigationKey } from './types'

const artworkFailed = ref(false)
const artworkUrl = `${import.meta.env.BASE_URL}auth/ayatori-loom.png`
const sealUrl = `${import.meta.env.BASE_URL}auth/ayatori-seal.svg`

defineProps<{
  mobileOpen: boolean
  hidden: boolean
  tenantName: string
  tenantRole: AuthRole
  departmentCount: number
  tenants: TenantRecord[]
  activeTenantId: string
  tenantSwitching: boolean
  navigationItems: NavigationItem<NavigationKey>[]
  /** 強調する項目。マスター系の画面を開いている間は masters になる。 */
  activeKey: NavigationKey
}>()

const emit = defineEmits<{
  toggleHidden: [hidden: boolean]
  selectTenant: [tenantId: string]
  navigate: [key: NavigationKey]
  closeMobile: []
}>()

function selectTenant(tenantId: string) {
  emit('selectTenant', tenantId)
}
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar--open': mobileOpen, 'sidebar--hidden': hidden }">
    <button
      class="sidebar-hide-button"
      :title="hidden ? 'サイドメニューを展開' : 'サイドメニューを折りたたむ'"
      :aria-label="hidden ? 'サイドメニューを展開' : 'サイドメニューを折りたたむ'"
      @click="emit('toggleHidden', !hidden)"
    >
      <v-icon size="19">{{ hidden ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
    </button>

    <div class="brand">
      <img class="brand__seal" :src="sealUrl" alt="" aria-hidden="true">
      <div>
        <div class="brand__name">Ayatori</div>
        <div class="brand__tag">あやとり ・ 業務の見える化</div>
      </div>
    </div>

    <div class="workspace-label">WORKSPACE</div>
    <div class="workspace-switcher" :title="hidden ? tenantName || 'テナントを選択' : undefined">
      <span class="workspace-switcher__icon"><v-icon size="18">mdi-office-building-outline</v-icon></span>
      <span>
        <strong>{{ tenantName || 'テナントを選択' }}</strong>
        <small>{{ tenantRole }}｜{{ departmentCount }}部門</small>
      </span>
      <v-select
        class="workspace-switcher__select"
        :model-value="activeTenantId"
        :items="tenants.filter((item) => item.enabled)"
        item-title="name"
        item-value="id"
        variant="plain"
        density="compact"
        hide-details
        menu-icon=""
        :disabled="tenantSwitching"
        aria-label="利用するテナント"
        @update:model-value="selectTenant"
      ></v-select>
      <v-icon size="18">mdi-chevron-down</v-icon>
    </div>

    <nav class="main-nav">
      <button
        v-for="item in navigationItems"
        :key="item.key"
        :class="{ active: activeKey === item.key }"
        :title="hidden ? item.label : undefined"
        @click="emit('navigate', item.key)"
      >
        <v-icon size="21">{{ item.icon }}</v-icon>
        <span>{{ item.label }}</span>
      </button>
    </nav>
    <div v-if="!artworkFailed" class="sidebar-artwork" aria-hidden="true">
      <img :src="artworkUrl" alt="" loading="lazy" @error="artworkFailed = true">
    </div>
  </aside>
  <div v-if="mobileOpen" class="nav-backdrop" @click="emit('closeMobile')"></div>
</template>
