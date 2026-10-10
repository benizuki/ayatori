import type { WorkFragment } from '../models'
import { authFetch, postJson } from './http'

export interface LlmInterviewMessage {
  role: 'user' | 'assistant'
  text: string
  attachments?: SavedInterviewAttachment[]
}

export interface SavedInterviewAttachment {
  id: string
  name: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'
  size: number
  uploaded_at: string
}

export interface LlmInterviewAttachment {
  name: string
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'
  data: string
}

export interface LlmInterviewDataItem {
  name: string
  description: string
  data_type: '文字列' | '数値' | '日付' | '金額' | '真偽値' | '選択肢' | '識別子' | 'その他'
  source_document: string
  confidence: number
}

export interface LlmFragment {
  title: string
  description: string
  actor: string
  trigger: string
  tools: string[]
  output: string
  next_step: string
  next_actor: string
  standard_time: string
  processing_volume: string
  source_document: string
  source_reference: string
  data_items: LlmInterviewDataItem[]
  personalization: '高' | '中' | '低'
  confidence: number
}

export interface LlmInterviewRequest {
  session_id: string
  department: string
  participant: string
  stage: number
  messages: LlmInterviewMessage[]
  attachments?: LlmInterviewAttachment[]
  active_fragment: LlmFragment | null
  business_context?: Record<string, unknown> | null
  replace_pending_user_message?: boolean
}

export interface LlmInterviewResponse {
  reply: string
  next_stage: number
  tags: string[]
  fragment_action: 'create' | 'update' | 'complete' | 'none'
  fragment: LlmFragment | null
  extracted_fragments: LlmFragment[]
  phase: 'スコープ・目的' | '基本フロー' | '役割・引き継ぎ' | 'システム・データ' | '件数・時間' | '判断・例外' | '差異・課題' | '補足確認' | '要約確認' | '完了'
  current_step: string
  confirmed_facts: string[]
  missing_items: string[]
  contradictions: string[]
  completion_score: number
  is_complete: boolean
  session_state: {
    session_id: string
    department: string
    participant: string
    analysis_mode: string
    owner_email: string
    business_context: Record<string, unknown> | null
    phase: LlmInterviewResponse['phase']
    current_stage: number
    current_step: string
    confirmed_facts: string[]
    missing_items: string[]
    asked_questions: string[]
    contradictions: string[]
    process_steps: string[]
    evidence: string[]
    process_end_confirmed: boolean
    gap_review_status: '未開始' | '確認中' | '完了'
    completion_score: number
    is_complete: boolean
  }
  provider: string
  model: string
}

export interface SavedInterviewSession {
  session_state: LlmInterviewResponse['session_state']
  messages: LlmInterviewMessage[]
  updated_at: string
}

export interface SavedInterviewSessionSummary {
  session_id: string
  department: string
  participant: string
  phase: LlmInterviewResponse['phase']
  completion_score: number
  message_count: number
  created_at?: string
  updated_at: string
  is_complete: boolean
  analysis_mode: string
  owner_email: string
  source_process_id?: string
}

export interface AudioTranscriptionResponse {
  transcript: string
  provider: string
  model: string
}

export interface UserInterviewPreference {
  active_interview_id: string | null
  updated_at: string
}

export function toLlmFragment(fragment?: WorkFragment): LlmFragment | null {
  if (!fragment) return null
  return {
    title: fragment.title,
    description: fragment.description,
    actor: fragment.actor,
    trigger: fragment.trigger,
    tools: [...fragment.tools],
    output: fragment.output,
    next_step: fragment.nextStep,
    next_actor: fragment.nextActor || '未確認',
    standard_time: fragment.standardTime || '未確認',
    processing_volume: fragment.processingVolume || '未確認',
    source_document: fragment.sourceDocument || '',
    source_reference: fragment.sourceReference || '',
    data_items: (fragment.dataItems ?? []).map((item) => ({
      name: item.name,
      description: item.description,
      data_type: item.dataType,
      source_document: item.sourceDocument,
      confidence: item.confidence,
    })),
    personalization: fragment.personalization,
    confidence: fragment.confidence,
  }
}

export async function requestLlmInterview(payload: LlmInterviewRequest, signal?: AbortSignal): Promise<LlmInterviewResponse> {
  return postInterview('/api/interview/respond', payload, signal)
}

export async function startLlmInterview(payload: { session_id: string; department: string; participant: string; business_context?: Record<string, unknown> | null }, signal?: AbortSignal): Promise<LlmInterviewResponse> {
  return postInterview('/api/interview/start', payload, signal)
}

export async function transcribeInterviewAudio(audio: Blob): Promise<AudioTranscriptionResponse> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await authFetch('/api/interview/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': audio.type || 'audio/webm' },
      body: audio,
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string }
      throw new Error(body.detail || `音声文字起こしAPI error: ${response.status}`)
    }
    return await response.json() as AudioTranscriptionResponse
  } finally {
    window.clearTimeout(timeoutId)
  }
}

/** 利用者ごとの読み上げの好み。voice が空ならシステムの既定の声を使う。 */
export interface SpeechPreferences {
  voice: string
  tone: 'default' | 'calm' | 'friendly' | 'cheerful'
  pace: 'normal' | 'slow' | 'fast'
}

export interface SpeechOption {
  id: string
  label: string
}

export interface SpeechPreferencesResponse extends SpeechPreferences {
  default_voice: string
  voices: SpeechOption[]
  tones: SpeechOption[]
  paces: SpeechOption[]
}

export async function getSpeechPreferences(): Promise<SpeechPreferencesResponse> {
  const response = await authFetch('/api/user-preferences/speech')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `読み上げ設定取得API error: ${response.status}`)
  }
  return await response.json() as SpeechPreferencesResponse
}

export async function saveSpeechPreferences(preferences: SpeechPreferences): Promise<SpeechPreferencesResponse> {
  const response = await authFetch('/api/user-preferences/speech', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `読み上げ設定保存API error: ${response.status}`)
  }
  return await response.json() as SpeechPreferencesResponse
}

/** preferences を渡すと保存前の試聴になる。省くと本人の保存済みの好みで読み上げる。 */
export async function synthesizeInterviewSpeech(text: string, signal?: AbortSignal, preferences?: SpeechPreferences): Promise<Blob> {
  const response = await authFetch('/api/interview/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preferences ? { text, preferences } : { text }),
    signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `音声生成API error: ${response.status}`)
  }
  return response.blob()
}

export async function streamInterviewSpeech(
  text: string,
  signal?: AbortSignal,
): Promise<{ stream: ReadableStream<Uint8Array>; sampleRate: number }> {
  const response = await authFetch('/api/interview/speech/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ストリーミング音声生成API error: ${response.status}`)
  }
  if (!response.body) throw new Error('ストリーミング音声を受信できませんでした。')
  const sampleRate = Number(response.headers.get('X-Audio-Sample-Rate')) || 24_000
  return { stream: response.body, sampleRate }
}

export async function getSavedInterviewSession(sessionId: string): Promise<SavedInterviewSession | null> {
  const response = await authFetch(`/api/interview/${encodeURIComponent(sessionId)}`)
  if (response.status === 404) return null
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ヒアリング履歴API error: ${response.status}`)
  }
  return await response.json() as SavedInterviewSession
}

export async function fetchSavedInterviewAttachment(sessionId: string, attachmentId: string): Promise<Blob> {
  const response = await authFetch(`/api/interview/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`)
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `添付ファイル取得API error: ${response.status}`)
  }
  return await response.blob()
}

export async function updateSavedInterviewMetadata(sessionId: string, department: string, participant: string): Promise<SavedInterviewSession | null> {
  const response = await authFetch(`/api/interview/${encodeURIComponent(sessionId)}/metadata`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ department, participant }),
  })
  if (response.status === 404) return null
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ヒアリング情報更新API error: ${response.status}`)
  }
  return await response.json() as SavedInterviewSession
}

export async function deleteSavedInterviewSession(sessionId: string): Promise<void> {
  if (!sessionId.trim()) return
  const response = await authFetch(`/api/interview/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  if (response.status === 404) return
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ヒアリング削除API error: ${response.status}`)
  }
}

export async function getSavedInterviewSessionSummaries(): Promise<SavedInterviewSessionSummary[]> {
  const response = await authFetch('/api/interviews')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ヒアリング一覧API error: ${response.status}`)
  }
  return await response.json() as SavedInterviewSessionSummary[]
}

export async function getUserInterviewPreference(): Promise<UserInterviewPreference> {
  const response = await authFetch('/api/user-preferences/interview')
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { detail?: string }
    throw new Error(body.detail || `ヒアリング表示設定取得API error: ${response.status}`)
  }
  return await response.json() as UserInterviewPreference
}

export async function saveUserInterviewPreference(activeInterviewId: string | null): Promise<UserInterviewPreference> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await authFetch('/api/user-preferences/interview', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active_interview_id: activeInterviewId }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { detail?: string }
      throw new Error(body.detail || `ヒアリング表示設定保存API error: ${response.status}`)
    }
    return await response.json() as UserInterviewPreference
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function postInterview(path: string, payload: unknown, signal?: AbortSignal): Promise<LlmInterviewResponse> {
  // 添付時は文書専用解析とヒアリング応答の2段階になるため、通常より長く待つ。
  return postJson<LlmInterviewResponse>(path, payload, 120_000, signal)
}
