export type ViewKey =
  | 'overview'
  | 'sessions'
  | 'interview'
  | 'process'
  | 'processMap'
  | 'master'
  | 'users'
  | 'aiUsage'
  | 'backups'
  | 'systemSettings'
  | 'orgUnits'
  | 'tenants'

/** サイドメニューの項目。masters はマスター系の画面をまとめた入口で、画面そのものは持たない。 */
export type NavigationKey = ViewKey | 'masters'

export interface NavigationItem<Key extends NavigationKey = ViewKey> {
  key: Key
  label: string
  icon: string
}

export interface SelectItem {
  title: string
  value: string
  count?: number
}
