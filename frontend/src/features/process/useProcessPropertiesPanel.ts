import { ref, type Ref } from 'vue'

const DEFAULT_WIDTH = 340
const MIN_WIDTH = 300

/** 右側のステップ詳細パネルの幅。つかんで動かす・キーボードで調整する・既定へ戻す。 */
export function useProcessPropertiesPanel(layoutElement: Ref<HTMLElement | null>) {
  const processPropertiesWidth = ref(DEFAULT_WIDTH)
  const resizingProcessProperties = ref(false)
  const processPropertiesResizeStart = ref({ clientX: 0, width: DEFAULT_WIDTH, maxWidth: 560 })

  function startProcessPropertiesResize(event: PointerEvent) {
    const layoutWidth = layoutElement.value?.getBoundingClientRect().width ?? window.innerWidth
    resizingProcessProperties.value = true
    processPropertiesResizeStart.value = {
      clientX: event.clientX,
      width: processPropertiesWidth.value,
      maxWidth: Math.max(MIN_WIDTH, Math.min(600, layoutWidth - 470)),
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  function moveProcessPropertiesResize(event: PointerEvent) {
    if (!resizingProcessProperties.value) return
    const { clientX, width, maxWidth } = processPropertiesResizeStart.value
    processPropertiesWidth.value = Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, width - (event.clientX - clientX))))
  }

  function endProcessPropertiesResize() {
    if (!resizingProcessProperties.value) return
    resizingProcessProperties.value = false
  }

  function resetProcessPropertiesWidth() {
    processPropertiesWidth.value = DEFAULT_WIDTH
  }

  function resizeProcessPropertiesByKeyboard(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowLeft' ? 20 : -20
    const layoutWidth = layoutElement.value?.getBoundingClientRect().width ?? window.innerWidth
    const maxWidth = Math.max(MIN_WIDTH, Math.min(600, layoutWidth - 470))
    processPropertiesWidth.value = Math.min(maxWidth, Math.max(MIN_WIDTH, processPropertiesWidth.value + delta))
  }

  return {
    processPropertiesWidth,
    resizingProcessProperties,
    startProcessPropertiesResize,
    moveProcessPropertiesResize,
    endProcessPropertiesResize,
    resetProcessPropertiesWidth,
    resizeProcessPropertiesByKeyboard,
  }
}
