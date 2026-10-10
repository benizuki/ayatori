import { authFetch, jsonPut } from './http'

// ---- システム設定（AIの接続方法・モデル・Google Cloud の認証）。システム管理者だけが使う。----

export type GeminiApiKeySource = 'environment' | 'stored' | 'none'

export interface GeminiSettings {
  source: GeminiApiKeySource
  configured: boolean
  key_hint?: string
}

export async function getGeminiSettings(): Promise<GeminiSettings> {
  const response = await authFetch('/api/settings/gemini')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `AI設定取得API error: ${response.status}`)
  }
  return await response.json() as GeminiSettings
}

export async function saveGeminiApiKey(apiKey: string): Promise<GeminiSettings> {
  const response = await authFetch('/api/settings/gemini', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `APIキー保存API error: ${response.status}`)
  }
  return await response.json() as GeminiSettings
}

export async function deleteGeminiApiKey(): Promise<void> {
  const response = await authFetch('/api/settings/gemini', { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `APIキー削除API error: ${response.status}`)
  }
}

/** ② Vertex AI（Google Cloud）への接続。Vertex AI と Cloud Text-to-Speech で共通に使う。 */
export interface GoogleCloudAuthSettings {
  project: string
  location: string
  /** Kubernetes 上でだけ使う Workload Identity 連携の識別子（任意）。 */
  wif_project_number: string
  wif_pool_id: string
  wif_provider_id: string
  wif_service_account: string
}

export interface GoogleCloudSettingsResponse extends GoogleCloudAuthSettings {
  environment: { project: string; location: string }
  /** いま使われる認証。Kubernetes 上で WIF が設定されていれば wif、それ以外は adc（google.auth.default）。 */
  active_auth: 'adc' | 'wif'
  running_on_kubernetes: boolean
}

/** 接続方法。gemini-api は ① Gemini APIキー、vertex は ② Vertex AI。 */
export type AiConnection = 'gemini-api' | 'vertex'

/** 読み上げの方式。gemini-tts は ① 固定、cloud-tts は ② 固定。 */
export type SpeechEngine = 'gemini-tts' | 'cloud-tts'

export type AiRole = 'chat' | 'transcription' | 'speech'

export interface AiModelValues {
  chat_connection: AiConnection
  chat_model: string
  transcription_connection: AiConnection
  transcription_model: string
  speech_engine: SpeechEngine
  speech_model: string
}

/** 役割ごとの接続方法とモデル。空の項目は環境変数に従う。 */
export interface AiModelSettings {
  chat_connection: '' | AiConnection
  chat_model: string
  transcription_connection: '' | AiConnection
  transcription_model: string
  speech_engine: '' | SpeechEngine
  speech_model: string
}

export interface AiModelSettingsResponse extends AiModelSettings {
  environment: AiModelValues
  effective: AiModelValues
}

export interface WorkloadIdentityInfo {
  subject: string
  namespace: string
  service_account: string
  issuer: string
  jwks: Record<string, unknown>
}

export interface ConnectionCheckResult {
  ok: boolean
  step: 'credentials' | 'sts' | 'api'
  message: string
}

async function settingsRequest<T>(path: string, label: string, init?: RequestInit): Promise<T> {
  const response = await authFetch(path, init)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `${label} API error: ${response.status}`)
  }
  return await response.json() as T
}

export function getGoogleCloudAuth(): Promise<GoogleCloudSettingsResponse> {
  return settingsRequest('/api/settings/google-cloud', 'Google Cloud設定取得')
}

export function saveGoogleCloudAuth(settings: GoogleCloudAuthSettings): Promise<GoogleCloudSettingsResponse> {
  return settingsRequest('/api/settings/google-cloud', 'Google Cloud設定保存', jsonPut(settings))
}

export function getWorkloadIdentity(): Promise<WorkloadIdentityInfo> {
  return settingsRequest('/api/settings/google-cloud/workload-identity', 'Workload Identity情報取得')
}

export function getAiModels(): Promise<AiModelSettingsResponse> {
  return settingsRequest('/api/settings/ai-models', 'AIモデル設定取得')
}

export function saveAiModels(settings: AiModelSettings): Promise<AiModelSettingsResponse> {
  return settingsRequest('/api/settings/ai-models', 'AIモデル設定保存', jsonPut(settings))
}

export function checkAiModel(role: AiRole): Promise<ConnectionCheckResult> {
  return settingsRequest(`/api/settings/ai-models/${role}/check`, '接続確認', { method: 'POST' })
}
