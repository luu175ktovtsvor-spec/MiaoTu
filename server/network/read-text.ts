// Response.text() decodes UTF-8 and strips its BOM. Stream with the same rules,
// enforcing an existing UTF-16 string-length limit before buffering the rest.
export async function readLimitedResponseText(response: Pick<Response, 'body'>, { maxLength, signal, tooLarge }: {
  maxLength: number; signal?: AbortSignal; tooLarge: () => Error;
}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) throw new RangeError('Invalid response length limit')
  const reader = response.body?.getReader()
  if (!reader) { signal?.throwIfAborted(); return '' }
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  const chunks: string[] = []
  const decoder = new TextDecoder('utf-8')
  let length = 0, complete = false
  const append = (text: string) => {
    length += text.length
    if (length > maxLength) throw tooLarge()
    if (text) chunks.push(text)
  }
  try {
    signal?.throwIfAborted()
    signal?.addEventListener('abort', abort, { once: true })
    while (true) {
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      append(decoder.decode(value, { stream: true }))
    }
    append(decoder.decode())
    complete = true
    return chunks.join('')
  } finally {
    signal?.removeEventListener('abort', abort)
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
