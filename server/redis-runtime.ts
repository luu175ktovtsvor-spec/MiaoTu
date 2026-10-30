import { createHash } from 'node:crypto'

const ATOMIC_LIMIT = `
local retry=0
for i,key in ipairs(KEYS) do
  local count=tonumber(redis.call('GET',key) or '0')
  if count>=tonumber(ARGV[i+1]) then
    local ttl=redis.call('PTTL',key)
    if ttl<0 then return redis.error_reply('limiter key has no expiry') end
    retry=math.max(retry,ttl)
  end
end
if retry>0 then return retry end
for _,key in ipairs(KEYS) do
  local count=redis.call('INCR',key)
  if count==1 then redis.call('PEXPIRE',key,ARGV[1]) end
end
return 0`

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const unavailable = () => Object.assign(new Error('服务暂时繁忙，请稍后再试'), { status: 503, retryAfter: 2 })

/** Disposable data only: never store balances, sessions, orders or task truth. */
export class RedisRuntime {
  readonly configured: boolean
  readonly namespace: string
  private url: string
  private client: any
  private connecting: Promise<any> | null = null
  private stopped = false

  constructor(url = process.env.MIAO_REDIS_URL || '', namespace = process.env.MIAO_REDIS_NAMESPACE || `miaoimg:${process.env.MIAO_EDITION || 'cn'}`) {
    if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(namespace)) throw new Error('Invalid Redis namespace')
    if (url) {
      let protocol: string
      try { protocol = new URL(url).protocol } catch { throw new Error('Invalid private Redis connection configuration') }
      if (!['redis:', 'rediss:'].includes(protocol)) throw new Error('MIAO_REDIS_URL must use Redis')
    }
    this.url = url; this.configured = Boolean(url); this.namespace = namespace
  }

  private async connection() {
    if (this.stopped || !this.configured) throw unavailable()
    if (this.client?.isReady) return this.client.withCommandOptions({ timeout: 1500 })
    if (!this.connecting && !this.client?.isOpen) {
      this.connecting = (async () => {
        const { createClient } = await import('redis')
        const client = createClient({ url: this.url, disableOfflineQueue: true,
          socket: { connectTimeout: 2000, reconnectStrategy: false } })
        client.on('error', () => {}) // Credentials and connection strings must not enter logs.
        this.client = client
        try { await client.connect(); return client }
        catch { if (client.isOpen) client.destroy(); this.client = null; throw unavailable() }
      })().finally(() => { this.connecting = null })
    }
    if (this.connecting) await this.connecting
    if (!this.client?.isReady) throw unavailable()
    return this.client.withCommandOptions({ timeout: 1500 })
  }

  async ping() { const client = await this.connection(); return client.ping() }

  async limit(budgets: Array<[string, number]>, windowMs: number): Promise<number> {
    if (!budgets.length) return 0
    if (!Number.isSafeInteger(windowMs) || windowMs < 1 || budgets.some(([, n]) => !Number.isSafeInteger(n) || n < 1)) throw new Error('Invalid rate budget')
    try {
      const client = await this.connection()
      // One hash tag keeps the IP+account check atomic on clustered Redis too.
      const keys = budgets.map(([key]) => `{${this.namespace}:limit}:${hash(key)}`)
      const retry = Number(await client.eval(ATOMIC_LIMIT, { keys, arguments: [String(windowMs), ...budgets.map(([, limit]) => String(limit))] }))
      if (!Number.isFinite(retry) || retry < 0) throw unavailable()
      return Math.ceil(retry / 1000)
    } catch { throw unavailable() }
  }

  async cacheJson<T>(key: string, seconds: number, load: () => Promise<T> | T): Promise<T> {
    if (!this.configured) return load()
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 300) throw new Error('Cache TTL must be 1–300 seconds')
    const name = `${this.namespace}:cache:${hash(key)}`
    let client: any
    try {
      client = await this.connection()
      const stored = await client.get(name)
      if (stored !== null && Buffer.byteLength(stored) <= 262144) {
        try { return JSON.parse(stored) } catch { /* Reload corrupt disposable data. */ }
      }
    } catch { /* Cache failure falls back to its authoritative source. */ }
    const value = await load()
    const encoded = JSON.stringify(value)
    if (client && encoded !== undefined && Buffer.byteLength(encoded) <= 262144) {
      try { await client.set(name, encoded, { EX: seconds }) } catch { /* Cache is optional. */ }
    }
    return value
  }

  async close() {
    this.stopped = true
    await this.connecting?.catch(() => {})
    if (this.client?.isOpen) this.client.destroy()
    this.client = null
  }
}

export const redisRuntime = new RedisRuntime()
