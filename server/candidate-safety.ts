/** Isolated acceptance must never dispatch production jobs, payments or mail. */
export const candidateMode = process.env.MIAO_CANDIDATE_MODE === 'true'

export function candidateRequestAllowed(method: string, pathname: string, admin = false) {
  if (!candidateMode) return
  const read = method === 'GET' || method === 'HEAD'
  const allowed = admin
    ? read || method === 'POST' && pathname === '/api/admin/login'
    : read && (['/health','/api/health','/api/imagine/health','/api/imagine/config','/api/imagine/session','/api/imagine/email/config'].includes(pathname)
      || pathname.startsWith('/api/imagine/feedback'))
      || method === 'POST' && ['/api/imagine/login-password','/api/imagine/logout','/api/imagine/estimate','/api/imagine/video/estimate'].includes(pathname)
  if (!allowed) throw Object.assign(new Error('隔离验收环境未开放此操作'), { status: 503 })
}

if (candidateMode) {
  if (!process.env.OIP_DATA_DIR || !process.env.OIP_MEDIA_ROOT) throw new Error('Candidate mode requires explicit isolated data and media directories')
  let database: URL
  try { database = new URL(process.env.MIAO_DATABASE_URL || 'postgresql://invalid/') } catch { throw new Error('Invalid private candidate database configuration') }
  if (!/candidate/i.test(database.pathname)) throw new Error('Candidate mode requires a dedicated candidate database')
  if (!/candidate/i.test(process.env.MIAO_REDIS_NAMESPACE || '')) throw new Error('Candidate mode requires a dedicated Redis namespace')
  process.env.ENABLE_MODEL_CALLS = 'false'
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw Object.assign(new Error('External requests are disabled in isolated acceptance'), { code: 'CANDIDATE_EXTERNAL_REQUEST_BLOCKED' })
    return originalFetch(input, options)
  }
}
