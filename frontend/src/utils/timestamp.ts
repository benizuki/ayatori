/** Short local timestamp used for "last updated" labels across the app. */
export function processTimestamp() {
  return new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
