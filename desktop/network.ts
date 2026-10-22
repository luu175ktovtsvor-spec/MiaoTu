import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

function nativeResponseHeaders(values) {
  const headers = new Headers()
  for (const [key, items] of Object.entries(values)) for (const value of Array.isArray(items) ? items : [items]) if (value !== undefined) {
    const text = String(value)
    headers.append(key, /[^\x00-\xff]/.test(text) ? Buffer.from(text).toString('latin1') : text)
  }
  return headers
}

// Reuse Chromium's network stack and the session's proxy settings.
// Credentials are explicit; never redirect or retry a lost application request.
export function createDesktopFetch(session, request?: typeof import('electron').net.request) {
  return async (input, init: Record<string, any> = {}) => {
    if (input instanceof Request) {
      const normalized = new Request(input, init)
      input = normalized.url
      init = { ...init, method: normalized.method, headers: normalized.headers, body: normalized.body || undefined, signal: normalized.signal, redirect: normalized.redirect }
    }
    const url = new URL(String(input))
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('请求地址无效')
    init.signal?.throwIfAborted()
    // Electron 44 fetch pipes into a non-chunked ClientRequest, which buffers
    // the entire body. Native chunked requests retain Chromium's proxy support
    // while Node's pipeline owns backpressure, file errors and cancellation.
    const stream = init.body instanceof Blob ? init.body.size > 0 ? init.body.stream() : undefined
      : init.body instanceof ReadableStream ? init.body : undefined
    const redirect = init.redirect === 'manual' ? 'manual' : 'error'
    // Electron 44 session.fetch rejects a manual redirect instead of returning
    // its status. net.request exposes it without following, including for GET.
    if (request && (stream || redirect === 'manual')) {
      const headers = new Headers(init.headers)
      if (!headers.has('content-type') && init.body instanceof Blob && init.body.type) headers.set('content-type', init.body.type)
      const method = String(init.method || 'GET').toUpperCase()
      if (stream && (method === 'GET' || method === 'HEAD')) throw new TypeError('Request with GET/HEAD method cannot have body')
      return new Promise<Response>((resolve, reject) => {
        const outgoing = request({ url: url.href, session, method, credentials: 'omit', redirect, origin: headers.get('origin') || undefined })
        const upload = outgoing as unknown as Writable
        if (stream) outgoing.chunkedEncoding = true
        for (const [key, value] of headers) if (key !== 'content-length' && key !== 'transfer-encoding') outgoing.setHeader(key, value)
        const source = stream ? Readable.fromWeb(stream) : Readable.from([])
        let incoming: Readable | undefined
        let failed = false
        const cleanup = () => init.signal?.removeEventListener('abort', abort)
        const fail = error => {
          if (failed) return
          failed = true; cleanup()
          source.destroy(error); outgoing.abort(); incoming?.destroy(error); reject(error)
        }
        const abort = () => {
          const reason = init.signal.reason || new DOMException('The operation was aborted', 'AbortError')
          fail(reason)
        }
        init.signal?.addEventListener('abort', abort, { once: true })
        outgoing.once('error', fail)
        if (redirect === 'manual') outgoing.once('redirect', (status, _method, redirectUrl, values) => {
          const headers = nativeResponseHeaders(values)
          if (!headers.has('location')) headers.set('location', redirectUrl)
          resolve(new Response(null, { status, headers }))
          cleanup(); source.destroy(); outgoing.abort()
        })
        outgoing.on('response', response => {
          incoming = response as unknown as Readable
          incoming.once('close', () => {
            cleanup()
            // An early rejection can finish its response before the upload.
            // Do not keep reading the original after the caller has its reply.
            if (!incoming.readableEnded || !upload.writableFinished) { source.destroy(); outgoing.abort() }
          })
          try {
            const responseHeaders = nativeResponseHeaders(response.headers)
            const noBody = method === 'HEAD' || [204, 205, 304].includes(response.statusCode)
            const body = noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
            if (noBody) incoming.resume()
            resolve(new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers: responseHeaders }))
          } catch (error) { fail(error) }
        })
        void pipeline(source, upload, ...(init.signal ? [{ signal: init.signal }] : [])).catch(fail)
      })
    }
    return session.fetch(url.href, { ...init, credentials: 'omit', redirect })
  }
}
