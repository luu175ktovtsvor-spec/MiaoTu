type WorkspaceFiles = {
  stat(path: string, signal?: AbortSignal): Promise<{ size: number; mime: string }>;
  read(path: string, signal?: AbortSignal): Promise<Blob>;
  write(path: string, content: Blob, exclusive?: boolean, signal?: AbortSignal): Promise<unknown>;
}
const statusOf = (error: unknown) => {
  const value = error as { status?: number; response?: { status?: number } }
  return value?.response?.status ?? value?.status
}

// Import the bytes into the captured workspace. Address equality is not content
// equality: an image at the same URL can change while an old node still uses it.
export async function importLibraryReference(sources: readonly string[], files: WorkspaceFiles,
  signal: AbortSignal, assertCurrent: () => void): Promise<{ path: string; mimeType: string }> {
  const check = () => { signal.throwIfAborted(); assertCurrent() }
  let image: Blob | undefined
  for (const source of new Set(sources.filter(Boolean))) {
    check()
    try {
      const response = await fetch(source, { signal })
      try { check() } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); continue }
      const candidate = await response.blob()
      check()
      if (candidate.size && (!candidate.type || candidate.type.startsWith('image/'))) { image = candidate; break }
    } catch { check() }
  }
  if (!image) throw new Error('参考图无法读取')
  if (!globalThis.crypto?.subtle) throw new Error('当前环境无法校验参考图，请重新打开妙图')
  const digest = async (blob: Blob) => {
    const bytes = await blob.arrayBuffer()
    check()
    const value = await crypto.subtle.digest('SHA-256', bytes)
    check()
    return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  const fingerprint = await digest(image)
  const mimeType = image.type || 'image/jpeg'
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' })[mimeType] || 'img'
  const path = `assets/library-${fingerprint}.${extension}`
  const existing = async () => {
    check()
    const metadata = await files.stat(path, signal)
    check()
    if (metadata.size !== image.size || !metadata.mime.startsWith('image/')) throw new Error('已保存的参考图校验失败，请重新选择')
    const original = await files.read(path, signal)
    if (original.size !== image.size || await digest(original) !== fingerprint) throw new Error('已保存的参考图校验失败，请重新选择')
    return { path, mimeType: metadata.mime }
  }
  try { return await existing() }
  catch (error) { check(); if (statusOf(error) !== 404) throw error }
  try {
    await files.write(path, image, true, signal)
    check()
    return { path, mimeType }
  } catch (error) {
    check()
    if (statusOf(error) !== 409) throw error
    return existing()
  }
}
