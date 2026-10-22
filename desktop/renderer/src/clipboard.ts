export async function writeClipboard(text) {
  if (window.miaoDesktop) return window.miaoDesktop.writeClipboardText(text)
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('copy failed')
}

export const writeClipboardText = writeClipboard

export async function readClipboardText() {
  if (window.miaoDesktop) return window.miaoDesktop.readClipboardText()
  if (navigator.clipboard?.readText) return navigator.clipboard.readText()
  return ''
}
