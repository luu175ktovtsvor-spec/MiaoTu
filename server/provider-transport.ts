import { readFileSync } from 'node:fs'
import { connect } from 'node:tls'

const HOSTS = new Set(['ark.cn-beijing.volces.com', 'api.suihemedia.cloud', 'metaso.cn'])

export function probeProviderConnection(url: URL, timeout = 2000): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    const socket = connect({ host: url.hostname, port: 443, servername: url.hostname, rejectUnauthorized: true })
    const finish = value => { if (!done) { done = true; clearTimeout(timer); socket.destroy(); resolve(value) } }
    const timer = setTimeout(() => finish(false), timeout)
    timer.unref()
    socket.once('secureConnect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

// Route selection happens before sending a model request. A lost submission is
// never replayed: it may already have been accepted by the supplier.
export function createProviderTransport(fetchImpl: typeof fetch, {
  relayUrl, token, probe = probeProviderConnection, now = Date.now, retryAfterMs = 30000,
}: { relayUrl: string; token: string; probe?: (url: URL) => Promise<boolean>; now?: () => number; retryAfterMs?: number }) {
  const relay = new URL(relayUrl)
  if (relay.protocol !== 'https:' || relay.origin !== 'https://admin.miaoimg.cn' || relay.pathname !== '/__miaoimg-provider/request') throw new Error('Invalid provider relay configuration')
  const routes = new Map<string, { direct: boolean, expires: number }>()
  const pending = new Map<string, Promise<boolean>>()
  async function direct(url: URL) {
    const current = routes.get(url.hostname)
    if (current && current.expires > now()) return current.direct
    if (!pending.has(url.hostname)) {
      const request = probe(url).catch(() => false).then(value => {
        routes.set(url.hostname, { direct: value, expires: now() + retryAfterMs }); return value
      }).finally(() => pending.delete(url.hostname))
      pending.set(url.hostname, request)
    }
    return pending.get(url.hostname)!
  }
  async function throughRelay(url: URL, init: RequestInit & { duplex?: string }) {
    // Normalize once so multipart boundaries and Blob content types describe
    // the exact bytes forwarded through the relay, including streamed uploads.
    const normalized = new Request(url, { ...init, duplex: 'half' } as RequestInit)
    const upstreamHeaders = new Headers(normalized.headers)
    for (const key of ['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization']) upstreamHeaders.delete(key)
    const response = await fetchImpl(relay, { ...init, body: normalized.body || undefined, duplex: 'half', redirect: 'manual',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/octet-stream',
        'x-miao-upstream-url': url.href, 'x-miao-upstream-headers': Buffer.from(JSON.stringify([...upstreamHeaders])).toString('base64') } } as RequestInit)
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Provider relay did not follow the supplier redirect')
    }
    return response
  }
  return async (input: any, init: RequestInit & { duplex?: string } = {}) => {
    if (input instanceof Request) return fetchImpl(input, init as RequestInit)
    const url = new URL(String(input))
    if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || !HOSTS.has(url.hostname)) return fetchImpl(input, init as RequestInit)
    init.signal?.throwIfAborted()
    const useDirect = await direct(url)
    init.signal?.throwIfAborted()
    if (!useDirect) return throughRelay(url, init)
    try { return await fetchImpl(input, init as RequestInit) }
    catch (error) {
      if (init.signal?.aborted) throw error
      routes.set(url.hostname, { direct: false, expires: now() + retryAfterMs })
      if (!['GET', 'HEAD'].includes(String(init.method || 'GET').toUpperCase())) throw error
      return throughRelay(url, init)
    }
  }
}

export function installProviderTransport(env = process.env) {
  if (!env.OIP_PROVIDER_RELAY_URL || !env.OIP_PROVIDER_RELAY_KEY_FILE) return
  const token = readFileSync(env.OIP_PROVIDER_RELAY_KEY_FILE, 'utf8').trim()
  if (token.length < 32) throw new Error('Provider relay key is missing or too short')
  globalThis.fetch = createProviderTransport(globalThis.fetch.bind(globalThis), { relayUrl: env.OIP_PROVIDER_RELAY_URL, token }) as typeof fetch
}
