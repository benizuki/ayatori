import { authFetch } from './http'

export interface AiUsageReport {
  date_from: string
  date_to: string
  scope: 'tenant' | 'self'
  total_calls: number
  total_tokens: number
  rate_limit_per_minute: number
  rate_limit_per_day: number
  used_today: number
  by_user: Array<{ user_email: string; calls: number; total_duration_ms: number; errors: number; rate_limited: number; prompt_tokens: number; output_tokens: number; total_tokens: number }>
  by_feature: Array<{ feature: string; calls: number; total_duration_ms: number; total_tokens: number }>
  by_day: Array<{ day: string; calls: number; total_tokens: number }>
}

export interface SQLiteBackupRecord {
  id: string
  filename: string
  created_at: string
  size_bytes: number
}

export interface SQLiteTableStatistics {
  name: string
  row_count: number
  table_bytes: number
  index_bytes: number
  total_bytes: number
}

export interface SQLiteDatabaseStatistics {
  database_filename: string
  journal_mode: string
  last_modified_at: string
  database_bytes: number
  wal_bytes: number
  shm_bytes: number
  active_files_bytes: number
  allocated_bytes: number
  logical_used_bytes: number
  unused_bytes: number
  usage_percent: number
  total_records: number
  table_count: number
  backup_bytes: number
  backup_count: number
  tables: SQLiteTableStatistics[]
}

export async function getSQLiteBackups(): Promise<SQLiteBackupRecord[]> {
  const response = await authFetch('/api/backups')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `バックアップ一覧API error: ${response.status}`)
  }
  return await response.json() as SQLiteBackupRecord[]
}

export async function getSQLiteDatabaseStatistics(): Promise<SQLiteDatabaseStatistics> {
  const response = await authFetch('/api/backups/statistics')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `データ量取得API error: ${response.status}`)
  }
  return await response.json() as SQLiteDatabaseStatistics
}

export async function createSQLiteBackup(): Promise<SQLiteBackupRecord> {
  const response = await authFetch('/api/backups', { method: 'POST' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `バックアップ作成API error: ${response.status}`)
  }
  return await response.json() as SQLiteBackupRecord
}

export async function downloadSQLiteBackup(backup: SQLiteBackupRecord): Promise<void> {
  const response = await authFetch(`/api/backups/${encodeURIComponent(backup.id)}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `バックアップダウンロードAPI error: ${response.status}`)
  }
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = backup.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

export async function getAiUsage(dateFrom: string, dateTo: string): Promise<AiUsageReport> {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo })
  const response = await authFetch(`/api/ai-usage?${params}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `AI利用状況API error: ${response.status}`)
  }
  return await response.json() as AiUsageReport
}
