import { publicAddresses } from './network/public-host.ts'
import { fetchPinnedResponse } from './network/pinned-fetch.ts'

const decodedEncodings = new Set(['gzip', 'x-gzip', 'deflate', 'br'])
const redirects = new Set([301, 302, 303, 307, 308])
const failure = (status = 502) => Object.assign(new Error('视频内容读取失败'), { status })

export function videoResponseEncoding(response: Response) {
  const codings = response.headers.get('content-encoding')?.toLowerCase().split(',').map(value => value.trim()) || []
  const identity = !codings.length || codings.every(value => value === 'identity')
  return { identity, decoded: identity || codings.every(value => decodedEncodings.has(value)) }
}

// Validate before forwarding any partial headers. Use decimal integers without
// precision loss, including a provider that omits Content-Length for a range.
export function videoRangeLength(response: Response): bigint {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '')
  if (!match) throw failure()
  const start = BigInt(match[1]), end = BigInt(match[2])
  if (end < start || match[3] !== '*' && end >= BigInt(match[3])) throw failure()
  const length = end - start + 1n
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || BigInt(declared) !== length)) throw failure()
  return length
}

export async function fetchVideoContent(target: string, {
  provider, providerConfig, range, ifRange, signal, headersTimeoutMs = 0, fetchImpl = fetch,
}: {
  provider: string
  providerConfig: { baseUrl?: string; apiKey?: string }
  range?: string
  ifRange?: string
  signal?: AbortSignal
  headersTimeoutMs?: number
  fetchImpl?: typeof fetch
}) {
  signal?.throwIfAborted()
  let address: URL
  try { address = new URL(target) } catch { throw failure() }
  let trustedOrigin = ''
  try {
    const configured = new URL(providerConfig.baseUrl || '')
    if (['http:', 'https:'].includes(configured.protocol) && !configured.username && !configured.password) trustedOrigin = configured.origin
  } catch {}

  async function readHop(url: URL, headers: Record<string, string>) {
    const deadline = new AbortController()
    const lifetime = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
    const timer = headersTimeoutMs > 0 ? setTimeout(() => deadline.abort(new DOMException('Video headers timed out', 'TimeoutError')), headersTimeoutMs) : null
    timer?.unref()
    try {
      // Only the server-configured provider origin may intentionally be local.
      // Every other origin, including redirected CDN URLs, must resolve publicly
      // and connect to those addresses rather than re-resolving in fetch.
      if (url.origin === trustedOrigin) return await fetchImpl(url, { headers, signal: lifetime, redirect: 'manual' })
      const addresses = await publicAddresses(url.hostname.replace(/^\[|\]$/g, ''), { signal: lifetime })
      lifetime.throwIfAborted()
      return await fetchPinnedResponse(url, addresses, { headers, signal: lifetime, allowPartial: Boolean(range), fetchImpl })
    } catch (error) {
      signal?.throwIfAborted()
      if (deadline.signal.aborted) throw failure(504)
      if (error?.status === 422) throw failure()
      throw error
    } finally { if (timer) clearTimeout(timer) }
  }

  for (let hop = 0; ; hop++) {
    signal?.throwIfAborted()
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw failure()
    const needsKey = provider === 'metaso' && address.protocol === 'https:' && /(^|\.)metaso\.cn$/i.test(address.hostname)
    const headers: Record<string, string> = { 'accept-encoding': 'identity', ...(range ? { range, ...(ifRange ? { 'if-range': ifRange } : {}) } : {}) }
    let response = await readHop(address, needsKey && providerConfig.apiKey ? { ...headers, authorization: `Bearer ${providerConfig.apiKey}` } : headers)
    if ([401, 403].includes(response.status) && providerConfig.apiKey && address.origin === trustedOrigin && !needsKey) {
      await response.body?.cancel().catch(() => {})
      signal?.throwIfAborted()
      response = await readHop(address, { ...headers, authorization: `Bearer ${providerConfig.apiKey}` })
    }
    if (redirects.has(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      // Retain Fetch's standard redirect ceiling, independently of model work.
      if (!location || hop === 20) throw failure()
      try { address = new URL(location, address) } catch { throw failure() }
      // Recompute credentials for the new origin; a CDN never inherits the
      // configured provider's Authorization header from the previous hop.
      continue
    }
    const encoding = videoResponseEncoding(response)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() || ''
    try {
      // Fetch decodes supported codings. Encoded ranges cannot describe those
      // decoded bytes, and a full download cannot accept unsolicited ranges.
      if (response.ok && (!encoding.decoded || response.status === 206 && (!range || !encoding.identity)
        || /^(text\/html|application\/(?:[a-z0-9.-]+\+)?json)$/.test(contentType))) throw failure()
      if (response.status === 206) videoRangeLength(response)
    } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    return response
  }
}
