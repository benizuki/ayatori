import { nextTick, ref, type Ref } from 'vue'

type BitmapMimeType = 'image/bmp' | 'image/png'

export function useProcessBitmap(options: {
  svgElement: Ref<SVGSVGElement | null>
  canvasWidth: Ref<number>
  canvasHeight: Ref<number>
  notify: (message: string) => void
}) {
  const copying = ref(false)

  function documentStyles() {
    return Array.from(document.styleSheets).flatMap((styleSheet) => {
      try {
        return Array.from(styleSheet.cssRules, (rule) => rule.cssText)
      } catch {
        return []
      }
    }).join('\n')
  }

  function pngBlob(canvas: HTMLCanvasElement) {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('PNG画像を作成できませんでした。'))
      }, 'image/png')
    })
  }

  function bmpBlob(canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('画像変換用のキャンバスを作成できませんでした。')

    const width = canvas.width
    const height = canvas.height
    const pixels = context.getImageData(0, 0, width, height).data
    const pixelBytes = width * height * 4
    const buffer = new ArrayBuffer(54 + pixelBytes)
    const view = new DataView(buffer)

    view.setUint16(0, 0x4d42, true)
    view.setUint32(2, buffer.byteLength, true)
    view.setUint32(10, 54, true)
    view.setUint32(14, 40, true)
    view.setInt32(18, width, true)
    view.setInt32(22, height, true)
    view.setUint16(26, 1, true)
    view.setUint16(28, 32, true)
    view.setUint32(34, pixelBytes, true)
    view.setInt32(38, 3780, true)
    view.setInt32(42, 3780, true)

    let offset = 54
    for (let y = height - 1; y >= 0; y -= 1) {
      for (let x = 0; x < width; x += 1) {
        const source = (y * width + x) * 4
        view.setUint8(offset, pixels[source + 2])
        view.setUint8(offset + 1, pixels[source + 1])
        view.setUint8(offset + 2, pixels[source])
        view.setUint8(offset + 3, 255)
        offset += 4
      }
    }

    return new Blob([buffer], { type: 'image/bmp' })
  }

  async function render(mimeType: BitmapMimeType) {
    await nextTick()
    const source = options.svgElement.value
    if (!source) throw new Error('コピーするAs-Is図が見つかりませんでした。')

    const width = Math.max(1, Math.ceil(options.canvasWidth.value))
    const height = Math.max(1, Math.ceil(options.canvasHeight.value))
    const clone = source.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(width))
    clone.setAttribute('height', String(height))
    clone.setAttribute('viewBox', `0 0 ${width} ${height}`)
    clone.removeAttribute('style')
    clone.querySelectorAll('.selected, .connecting').forEach((element) => element.classList.remove('selected', 'connecting'))
    clone.querySelectorAll('.lane-resize-handle, .review-tip').forEach((element) => element.remove())

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = documentStyles()
    clone.prepend(style)

    const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' })
    const imageUrl = URL.createObjectURL(svgBlob)
    const image = new Image()
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('As-Is図を画像に変換できませんでした。'))
        image.src = imageUrl
      })

      const maxPixels = 16_000_000
      const scale = Math.min(2, Math.sqrt(maxPixels / (width * height)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('画像変換用のキャンバスを作成できませんでした。')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)

      return mimeType === 'image/bmp' ? bmpBlob(canvas) : pngBlob(canvas)
    } finally {
      URL.revokeObjectURL(imageUrl)
    }
  }

  async function copy() {
    if (copying.value) return
    copying.value = true
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('このブラウザは画像のクリップボードコピーに対応していません。')
      }

      const supports = ClipboardItem as typeof ClipboardItem & { supports?: (type: string) => boolean }
      const mimeType: BitmapMimeType = supports.supports?.('image/bmp') ? 'image/bmp' : 'image/png'
      await navigator.clipboard.write([new ClipboardItem({ [mimeType]: render(mimeType) })])
      options.notify(mimeType === 'image/bmp'
        ? 'As-Isフロー図をBMP画像としてコピーしました'
        : 'As-Isフロー図を画像としてコピーしました（貼り付け時はビットマップ画像になります）')
    } catch (error) {
      console.error('Process bitmap copy failed', error)
      options.notify(error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'クリップボードへのアクセスを許可して、もう一度お試しください'
        : error instanceof Error ? error.message : 'As-Isフロー図をコピーできませんでした')
    } finally {
      copying.value = false
    }
  }

  return {
    copyingProcessBitmap: copying,
    copyProcessAsBitmap: copy,
  }
}
