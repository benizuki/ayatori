import { computed, ref } from 'vue'
import type { NavigationItem, NavigationKey, ViewKey } from '../../components/layout/types'

const navItems: NavigationItem[] = [
  { key: 'overview', label: 'ダッシュボード', icon: 'mdi-view-dashboard-outline' },
  { key: 'processMap', label: '業務マップ', icon: 'mdi-graph-outline' },
  { key: 'sessions', label: 'ヒアリング一覧', icon: 'mdi-format-list-bulleted-square' },
  { key: 'interview', label: '業務ヒアリング', icon: 'mdi-message-processing-outline' },
  { key: 'process', label: 'As-Isプロセス', icon: 'mdi-vector-polyline' },
  { key: 'tenants', label: 'テナント管理', icon: 'mdi-office-building-cog-outline' },
  { key: 'orgUnits', label: '組織マスター', icon: 'mdi-sitemap-outline' },
  { key: 'master', label: '業務マスター', icon: 'mdi-book-open-outline' },
  { key: 'users', label: 'ユーザー管理', icon: 'mdi-account-cog-outline' },
  { key: 'aiUsage', label: 'AI利用状況', icon: 'mdi-chart-timeline-variant' },
  { key: 'backups', label: 'SQLiteバックアップ', icon: 'mdi-database-export-outline' },
  { key: 'systemSettings', label: 'システム設定', icon: 'mdi-cog-outline' },
]

/** サイドメニューでは「マスタ設定」1つにまとめ、画面上部のタブで切り替える画面。 */
const MASTER_VIEWS: readonly ViewKey[] = ['tenants', 'orgUnits', 'master', 'users']
const mastersNavItem: NavigationItem<'masters'> = { key: 'masters', label: 'マスタ設定', icon: 'mdi-folder-cog-outline' }

/**
 * サイドメニューに出さず、親画面から開く画面。開いている間は親の項目を光らせる。
 * 業務ヒアリングはヒアリングの実施中だけ使う画面なので、ヒアリング一覧の下に置く。
 */
const SUB_VIEW_PARENTS: Partial<Record<ViewKey, ViewKey>> = { interview: 'sessions' }

function isSubView(view: ViewKey) {
  return view in SUB_VIEW_PARENTS
}

function isMasterView(view: ViewKey) {
  return MASTER_VIEWS.includes(view)
}

function createAppShell() {
  const currentView = ref<ViewKey>('overview')
  const mobileNav = ref(false)
  const sidebarHidden = ref(false)
  // 「マスタ設定」を開き直したとき、前回見ていたタブへ戻す。
  const lastMasterView = ref<ViewKey | null>(null)

  /**
   * Side effects each domain wants to run when its view opens (loading users,
   * syncing sessions, …). Registered by the owning composable so that `goTo`
   * does not have to know about every feature.
   */
  const enterHooks = new Map<ViewKey, (() => void)[]>()

  function onEnterView(view: ViewKey, handler: () => void) {
    const handlers = enterHooks.get(view) ?? []
    handlers.push(handler)
    enterHooks.set(view, handlers)
  }

  function goTo(view: ViewKey) {
    currentView.value = view
    if (isMasterView(view)) lastMasterView.value = view
    mobileNav.value = false
    enterHooks.get(view)?.forEach((handler) => handler())
  }

  function setSidebarHidden(hidden: boolean) {
    sidebarHidden.value = hidden
  }

  /** サイドメニューで強調する項目。マスター系の画面では「マスタ設定」を光らせる。 */
  const activeNavKey = computed<NavigationKey>(() => {
    if (isMasterView(currentView.value)) return 'masters'
    return SUB_VIEW_PARENTS[currentView.value] ?? currentView.value
  })
  const inMasterSettings = computed(() => isMasterView(currentView.value))
  const pageTitle = computed(() => {
    const labelOf = (view: ViewKey) => navItems.find((item) => item.key === view)?.label ?? ''
    const label = labelOf(currentView.value)
    if (inMasterSettings.value) return `${mastersNavItem.label} / ${label}`
    const parent = SUB_VIEW_PARENTS[currentView.value]
    return parent ? `${labelOf(parent)} / ${label}` : label
  })

  return {
    navItems,
    mastersNavItem,
    isMasterView,
    isSubView,
    currentView,
    activeNavKey,
    inMasterSettings,
    lastMasterView,
    mobileNav,
    sidebarHidden,
    pageTitle,
    goTo,
    onEnterView,
    setSidebarHidden,
  }
}

export type AppShell = ReturnType<typeof createAppShell>

let shell: AppShell | null = null

/** Navigation and chrome state shared by the app shell and every feature. */
export function useAppShell(): AppShell {
  if (!shell) shell = createAppShell()
  return shell
}
