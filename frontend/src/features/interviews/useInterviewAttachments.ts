import { ref } from 'vue'
import type { LlmInterviewAttachment } from '../../api/interview'
import {
  interviewAttachmentMaxBytes,
  interviewAttachmentTotalMaxBytes,
  readFileAsDataUrl,
  supportedInterviewAttachmentTypes,
} from '../../utils/attachments'

export type InterviewUpload = LlmInterviewAttachment & { id: string; size: number; previewUrl?: string }

/**
 * ヒアリングへ添付する画像・PDF。
 * queued は送信前の添付、pending は送信中（失敗時に戻せるよう保持）の添付。
 */
export function useInterviewAttachments() {
  const queuedInterviewAttachments = ref<InterviewUpload[]>([])
  const pendingInterviewAttachments = ref<InterviewUpload[]>([])
  const interviewAttachmentError = ref('')
  const interviewAttachmentDragActive = ref(false)

  async function addInterviewAttachments(files: File[] | FileList) {
    interviewAttachmentError.value = ''
    const incoming = Array.from(files)
    for (const file of incoming) {
      const mimeType = file.type as LlmInterviewAttachment['mime_type']
      if (!supportedInterviewAttachmentTypes.has(mimeType)) {
        interviewAttachmentError.value = 'PNG・JPEG・WebP・PDFのみ添付できます。'
        continue
      }
      if (queuedInterviewAttachments.value.length >= 4) {
        interviewAttachmentError.value = '一度に添付できる資料は4件までです。'
        break
      }
      if (file.size > interviewAttachmentMaxBytes) {
        interviewAttachmentError.value = `${file.name}は8MBを超えています。`
        continue
      }
      const totalBytes = queuedInterviewAttachments.value.reduce((sum, item) => sum + item.size, 0)
      if (totalBytes + file.size > interviewAttachmentTotalMaxBytes) {
        interviewAttachmentError.value = '添付資料の合計は20MB以内にしてください。'
        break
      }
      if (queuedInterviewAttachments.value.some((item) => item.name === file.name && item.size === file.size)) continue
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
        queuedInterviewAttachments.value.push({
          id: `attachment-${Date.now()}-${queuedInterviewAttachments.value.length}`,
          name: file.name || `貼り付け画像-${queuedInterviewAttachments.value.length + 1}.png`,
          mime_type: mimeType,
          data,
          size: file.size,
          previewUrl: mimeType.startsWith('image/') ? dataUrl : undefined,
        })
      } catch (error) {
        interviewAttachmentError.value = error instanceof Error ? error.message : '添付資料を読み込めませんでした。'
      }
    }
  }

  function onInterviewAttachmentInput(event: Event) {
    const input = event.target as HTMLInputElement
    if (input.files?.length) void addInterviewAttachments(input.files)
    input.value = ''
  }

  function onInterviewPaste(event: ClipboardEvent) {
    const files = event.clipboardData?.files
    if (!files?.length) return
    event.preventDefault()
    void addInterviewAttachments(files)
  }

  function onInterviewDrop(event: DragEvent) {
    interviewAttachmentDragActive.value = false
    if (event.dataTransfer?.files.length) void addInterviewAttachments(event.dataTransfer.files)
  }

  function removeInterviewAttachment(id: string) {
    queuedInterviewAttachments.value = queuedInterviewAttachments.value.filter((item) => item.id !== id)
    interviewAttachmentError.value = ''
  }

  function formatAttachmentSize(size: number) {
    return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(size / 1024))}KB`
  }

  /** 添付とエラー表示をすべて空にする。 */
  function clearInterviewAttachments() {
    pendingInterviewAttachments.value = []
    queuedInterviewAttachments.value = []
    interviewAttachmentError.value = ''
  }

  return {
    queuedInterviewAttachments,
    pendingInterviewAttachments,
    interviewAttachmentError,
    interviewAttachmentDragActive,
    addInterviewAttachments,
    onInterviewAttachmentInput,
    onInterviewPaste,
    onInterviewDrop,
    removeInterviewAttachment,
    formatAttachmentSize,
    clearInterviewAttachments,
  }
}
