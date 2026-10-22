import { incomingRequestSignal } from './http-request-lifetime.ts'

// Transport bytes and model context tokens are separate budgets. Multimodal
// tool results can exceed the old 16 MiB boundary while still fitting the model.
export const MODEL_REQUEST_MAX_BYTES = 64 * 1024 * 1024

// Preserve the SDK's server-directed retry policy across both cloud and local
// relays, without copying cookies, credentials or hop-by-hop stream headers.
export function modelResponseHeaders(response: { headers: Headers }) {
  const headers: Record<string, string> = {
    'content-type': response.headers.get('content-type') || 'application/json',
    'cache-control': 'no-store', 'x-accel-buffering': 'no',
  }
  for (const name of ['retry-after', 'retry-after-ms', 'x-should-retry']) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  return headers
}

// A text inference connection failure is retryable by Pi. It must not become
// HTTP 400, which tells the model adapter that retrying cannot help.
export function isTransientModelFailure(value) {
  const message = [value?.message || value || '', value?.code, value?.cause?.code].filter(Boolean).join(' ')
  return /fetch failed|network(?:error| error)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|socket hang up|connect timeout|connection (?:closed|reset)|暂时无法读取服务响应|文本服务连接暂时中断/i.test(message)
    // Chromium distinguishes a failed connection from a user abort, certificate
    // rejection or policy block. Only connection failures reach Pi's retry policy.
    || /\bnet::ERR_(?:CONNECTION_(?:CLOSED|RESET|REFUSED|ABORTED|FAILED|TIMED_OUT)|NAME_(?:NOT_RESOLVED|RESOLUTION_FAILED)|INTERNET_DISCONNECTED|NETWORK_CHANGED|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_(?:FAILED|HOST_UNREACHABLE)|EMPTY_RESPONSE)\b/i.test(message)
}

// Share bounded, cancellable body reads with ordinary JSON and file uploads.
// The registered host signal is service-only; it never adds reader cancellation
// to an already dispatched billed model request.
export function readBytesRequest(request, { maxBytes = MODEL_REQUEST_MAX_BYTES, tooLargeMessage = '请求体过大', signal }: Record<string, any> = {}) {
  signal = incomingRequestSignal(request, signal)
  return new Promise<Buffer>((resolve, reject) => {
    const chunks = []
    let size = 0, settled = false
    const cleanup = () => {
      request.off('error', fail)
      request.off('aborted', aborted)
      request.off('data', data)
      request.off('end', end)
      signal?.removeEventListener('abort', cancelled)
    }
    const fail = error => {
      if (settled) return
      settled = true; chunks.length = 0
      cleanup()
      // Flush the caller's JSON error before retiring an upload. A later
      // shutdown/socket error still needs a listener while this reader drains.
      const drained = () => {
        request.off('error', drainingError)
        request.off('end', drained)
        request.off('close', drained)
      }
      const drainingError = () => {}
      request.on('error', drainingError)
      request.once('end', drained)
      request.once('close', drained)
      request.resume()
      reject(error)
    }
    const tooLarge = () => fail(Object.assign(new Error(tooLargeMessage), { status: 413 }))
    const aborted = () => fail(Object.assign(new Error('模型请求连接已断开'), { status: 499 }))
    const cancelled = () => fail(signal.reason || new DOMException('模型请求已取消', 'AbortError'))
    const data = chunk => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) { tooLarge(); return }
      chunks.push(chunk)
    }
    const end = () => {
      if (settled) return
      const bytes = Buffer.concat(chunks)
      chunks.length = 0; settled = true; cleanup(); resolve(bytes)
    }
    request.on('error', fail)
    request.on('aborted', aborted)
    request.on('data', data)
    request.on('end', end)
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    else if (request.aborted) aborted()
    else if (Number(request.headers['content-length']) > maxBytes) tooLarge()
  })
}

export async function readJsonRequest(request, { objectOnly = true, invalidMessage = '请求格式无效', invalidStatus = 400, emptyBody = '{}', ...options }: Record<string, any> = {}) {
  const bytes = await readBytesRequest(request, options)
  // Shutdown may have started between the final body event and this continuation.
  incomingRequestSignal(request, options.signal)?.throwIfAborted()
  try {
    const body = JSON.parse(bytes.toString('utf8') || emptyBody)
    if (objectOnly && (!body || typeof body !== 'object' || Array.isArray(body))) throw new Error('Invalid model payload')
    return body
  } catch { throw Object.assign(new Error(invalidMessage), { status: invalidStatus }) }
}

export function readModelJson(request, maxBytes = MODEL_REQUEST_MAX_BYTES, signal?: AbortSignal) {
  return readJsonRequest(request, { maxBytes, signal, tooLargeMessage: '对话素材超过传输上限，请新建对话或减少参考素材后再发送', invalidMessage: '模型请求格式无效' })
}
