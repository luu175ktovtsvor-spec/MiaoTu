type FetchLike = (input: any, init?: Record<string, any>) => Promise<Response>

const PRIMARY = 'https://miaoimg.cn'
const RELAY = 'https://admin.miaoimg.cn'

function waitForRoute<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Keep the account origin stable while selecting a transport before sending data. */
export function createCloudTransport(fetchImpl: FetchLike, {
  primaryOrigin = PRIMARY,
  probeTimeoutMs = 3500,
  relayTimeoutMs = 5000,
  routeTtlMs = 60000,
  retryAfterMs = 30000,
  now = Date.now,
}: Record<string, any> = {}): FetchLike {
  // An isolated development/candidate origin must never contact production.
  if (primaryOrigin !== PRIMARY) return fetchImpl
  const unavailableUntil = new Map<string, number>()
  let selected: { origin: string, expires: number } | undefined
  let selection: { generation: number, promise: Promise<string> } | undefined
  let generation = 0

  function failed(origin: string) {
    unavailableUntil.set(origin, now() + retryAfterMs)
    if (selected?.origin === origin) selected = undefined
    generation++
  }

  async function healthy(origin: string) {
    const signal = AbortSignal.timeout(origin === PRIMARY ? probeTimeoutMs : relayTimeoutMs)
    try {
      const response = await fetchImpl(new URL('/health', origin), {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { accept: 'application/json' }, signal,
      })
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return false }
      const value = await response.json()
      return value?.ok === true
    } catch { return false }
  }

  function route(signal?: AbortSignal) {
    const time = now()
    if (selected && selected.expires > time && (unavailableUntil.get(selected.origin) || 0) <= time) {
      return waitForRoute(Promise.resolve(selected.origin), signal)
    }
    if (!selection || selection.generation !== generation) {
      const revision = generation
      const promise = (async () => {
        for (const origin of [PRIMARY, RELAY]) {
          if ((unavailableUntil.get(origin) || 0) > now()) continue
          if (await healthy(origin)) {
            if (revision === generation) {
              unavailableUntil.delete(origin)
              selected = { origin, expires: now() + (origin === RELAY ? Math.min(routeTtlMs, retryAfterMs) : routeTtlMs) }
            }
            return origin
          }
          unavailableUntil.set(origin, now() + retryAfterMs)
        }
        throw Object.assign(new Error('暂时无法连接云端，请稍后重试'), { code: 'CLOUD_CONNECTION_UNAVAILABLE' })
      })()
      selection = { generation: revision, promise }
      void promise.finally(() => { if (selection?.promise === promise) selection = undefined }).catch(() => {})
    }
    return waitForRoute(selection.promise, signal)
  }

  function transportUrl(url: URL, origin: string) {
    return new URL(url.pathname + url.search, origin)
  }

  return async (input, init: Record<string, any> = {}) => {
    // CloudGateway supplies an explicit URL and credentials. Other URLs keep
    // their existing fetch policy; never forward their credentials to a relay.
    if (input instanceof Request) return fetchImpl(input, init)
    const url = new URL(String(input))
    if (url.origin !== PRIMARY) return fetchImpl(input, init)
    init.signal?.throwIfAborted()
    const origin = await route(init.signal)
    init.signal?.throwIfAborted()
    try {
      return await fetchImpl(transportUrl(url, origin), init)
    } catch (error) {
      if (init.signal?.aborted) throw error
      failed(origin)
      // A lost POST may already have been accepted and charged. Route future
      // polling through the relay, but never replay this application request.
      const method = String(init.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') throw error
      const alternate = await route(init.signal)
      init.signal?.throwIfAborted()
      try { return await fetchImpl(transportUrl(url, alternate), init) }
      catch (nextError) { if (!init.signal?.aborted) failed(alternate); throw nextError }
    }
  }
}
