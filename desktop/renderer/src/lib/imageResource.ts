/** Own a browser-decoded image until its consumer releases it. */
export function acquireImage(source: string, signal?: AbortSignal, crossOrigin?: string): Promise<{ image: HTMLImageElement; release(): void }> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    if (crossOrigin !== undefined && !source.startsWith('data:')) image.crossOrigin = crossOrigin
    let settled = false
    let released = false
    const release = () => {
      if (released) return
      released = true
      image.removeAttribute('src')
    }
    const cleanup = () => {
      image.onload = image.onerror = null
      signal?.removeEventListener('abort', abort)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      release()
      reject(error)
    }
    const abort = () => fail(signal?.reason ?? new DOMException('Image loading cancelled', 'AbortError'))
    image.onerror = () => fail(new Error('Unable to load image'))
    image.onload = () => {
      if (settled) return
      if (signal?.aborted) { abort(); return }
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) { fail(new Error('Invalid image dimensions')); return }
      settled = true
      cleanup()
      resolve({ image, release })
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    else image.src = source
  })
}
