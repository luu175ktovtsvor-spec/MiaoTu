import { failure } from './management-store.ts'

type RequestLike = {
  socket?: { remoteAddress?: string }
  headers?: Record<string, any>
}

type SessionLike = { role?: string; userId?: string } | null | undefined

type Rule = {
  env: string
  fallbackIp: number
  fallbackUser: number
}

// These limits are deliberately server-side and configurable. They are an
// abuse brake for replayed client requests, not a claim that the desktop app
// itself can be trusted.
const RULES: Record<string, Rule> = Object.freeze({
  image: { env: 'MIAO_RATE_IMAGE_PER_MINUTE', fallbackIp: 20, fallbackUser: 12 },
  video: { env: 'MIAO_RATE_VIDEO_PER_MINUTE', fallbackIp: 10, fallbackUser: 6 },
  text: { env: 'MIAO_RATE_TEXT_PER_MINUTE', fallbackIp: 120, fallbackUser: 80 },
  media: { env: 'MIAO_RATE_MEDIA_PER_MINUTE', fallbackIp: 20, fallbackUser: 12 },
  agent: { env: 'MIAO_RATE_AGENT_PER_MINUTE', fallbackIp: 60, fallbackUser: 40 },
  mcp: { env: 'MIAO_RATE_MCP_PER_MINUTE', fallbackIp: 120, fallbackUser: 80 },
  web: { env: 'MIAO_RATE_WEB_PER_MINUTE', fallbackIp: 120, fallbackUser: 80 },
  provider: { env: 'MIAO_RATE_PROVIDER_PER_MINUTE', fallbackIp: 30, fallbackUser: 20 },
})

const WINDOW_MS = 60_000
const MAX_BUCKETS = 20_000
const buckets = new Map<string, { started: number; count: number; touched: number }>()

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : fallback
}

function loopback(value: unknown) {
  const address = String(value || '').toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function clientAddress(request: RequestLike) {
  const remote = String(request.socket?.remoteAddress || '').trim()
  const forwarded = loopback(remote)
    ? String(request.headers?.['x-real-ip'] || request.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    : ''
  return (forwarded || remote || 'unknown').slice(0, 128)
}

function cleanup(now: number) {
  for (const [key, bucket] of buckets) if (now - bucket.touched > WINDOW_MS * 2) buckets.delete(key)
  while (buckets.size > MAX_BUCKETS) {
    const oldest = buckets.keys().next().value
    if (oldest === undefined) break
    buckets.delete(oldest)
  }
}

function ruleFor(operation: string, env = process.env) {
  const rule = RULES[operation]
  if (!rule) return null
  const configured = positiveInteger(env[rule.env], rule.fallbackUser)
  // A single setting controls the account budget. IP protection stays at the
  // wider default so several users behind one office NAT are not blocked by a
  // single account.
  return { ip: Math.max(configured, rule.fallbackIp), user: configured }
}

/**
 * Apply a bounded sliding-window budget to an expensive API operation.
 * Call this before reading a large request body or dispatching an upstream
 * request. A rejected request does not consume a token.
 */
export function enforceRequestLimit(request: RequestLike, session: SessionLike, operation: string, env = process.env) {
  const limits = ruleFor(operation, env)
  if (!limits) return
  const now = Date.now()
  cleanup(now)
  const keys = [
    [`ip:${operation}:${clientAddress(request)}`, limits.ip],
    ...(session?.role === 'user' && session.userId ? [[`user:${operation}:${session.userId}`, limits.user]] : []),
  ] as Array<[string, number]>
  for (const [key, limit] of keys) {
    const bucket = buckets.get(key)
    if (bucket && now - bucket.started < WINDOW_MS && bucket.count >= limit) {
      throw Object.assign(failure('请求过于频繁，请稍后再试', 429), { retryAfter: Math.ceil((bucket.started + WINDOW_MS - now) / 1000) })
    }
  }
  for (const [key] of keys) {
    const previous = buckets.get(key)
    const bucket = !previous || now - previous.started >= WINDOW_MS
      ? { started: now, count: 1, touched: now }
      : { started: previous.started, count: previous.count + 1, touched: now }
    buckets.set(key, bucket)
  }
}

export function requestOperation(pathname: string, method: string) {
  if (method !== 'POST') return ''
  if (['/api/imagine/generate', '/api/imagine/desktop/generate', '/api/imagine/estimate'].includes(pathname)) return 'image'
  if (['/api/imagine/video', '/api/imagine/desktop/video', '/api/imagine/video/estimate'].includes(pathname)) return 'video'
  if (pathname === '/api/ai/media/generate') return 'media'
  if (pathname === '/api/ai/generate' || pathname === '/api/imagine/text' || pathname.startsWith('/api/imagine/desktop/model/')) return 'text'
  if (pathname === '/api/agent' || pathname.startsWith('/api/agent/')) return 'agent'
  if (pathname === '/mcp' || pathname.startsWith('/api/mcp/')) return 'mcp'
  if (pathname === '/api/imagine/desktop/web') return 'web'
  if (pathname === '/api/imagine/providers/models') return 'provider'
  return ''
}
