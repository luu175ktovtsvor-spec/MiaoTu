// The native host preserves the document and local API until its editors save.
// Standalone renderer previews keep their normal browser reload behavior.
export async function reloadWorkspace() {
  if (window.miaoDesktop?.reload) return window.miaoDesktop.reload()
  await window.miaoDesktop?.flushSave?.()
  window.location.reload()
}

export async function navigateWorkspace(url: string, current = () => true) {
  await window.miaoDesktop?.flushSave?.()
  if (!current()) return
  window.location.assign(url)
}
