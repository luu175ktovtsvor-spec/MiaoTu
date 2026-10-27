import { readJsonRequest } from './model-transport.ts'
import { failure } from './management-store.ts'
export function cookieToken(request, name = 'miao_session') { return new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(request.headers.cookie || '')?.[1] || '' }
export function json(response,status,value,headers: Record<string, any>={}) {
  const body=JSON.stringify(value)
  // Chromium can defer an early final response on a reusable HTTP/1 connection
  // until the upload ends. Finish a rejected, unread upload with the JSON error.
  const closeUpload = status >= 400 && response.req && !response.req.complete && response.req.httpVersionMajor === 1
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...headers,...(closeUpload ? {connection:'close'} : {})})
  response.end(body)
}
function secureCookie(request) {
  const configuredOrigin = String(process.env.OIP_PUBLIC_ORIGIN || '').trim()
  let configuredHttps = false
  try {
    const configured = new URL(configuredOrigin)
    const forwardedHost = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim()
    configuredHttps = configured.protocol === 'https:' && forwardedHost === configured.host
  } catch {}
  return request.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production' || configuredHttps
}
export function sessionCookie(request,token,expire=false,name='miao_session') {
  const secure = secureCookie(request)
  return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expire?0:43200}${secure?'; Secure':''}`
}
export function oauthStateCookie(request, token = '', expire = false, name = 'miao_google_state') { const secure=secureCookie(request);return `${name}=${expire?'':token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expire?0:600}${secure?'; Secure':''}` }
export function bodyJson(request, max = 64000, signal?: AbortSignal) { return readJsonRequest(request, { maxBytes: max, objectOnly: false, tooLargeMessage: '请求过大', invalidMessage: '请求格式错误', invalidStatus: 422, emptyBody: '', signal }) }
export function sameOrigin(request) {
  const origin = request.headers.origin
  if (!origin) throw failure('请求来源无效', 403)
  try {
    const value = new URL(origin)
    const configured = [process.env.OIP_PUBLIC_ORIGIN, ...(process.env.OIP_PUBLIC_ORIGINS || '').split(',')]
      .map(item => String(item || '').trim().replace(/\/$/, ''))
      .filter(Boolean)
    if (configured.length ? configured.includes(value.origin) : value.host === request.headers.host) return
  } catch {}
  throw failure('请求来源无效', 403)
}
export function mutation(request,session) { sameOrigin(request); if (!session || request.headers['x-csrf-token']!==session.csrf) throw failure('会话失效，请重新登录',403) }
const attempts=new Map()
function isLoopback(value) {
  const address = String(value || '').toLowerCase()
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function loginRate(request) {
  const remote = String(request.socket?.remoteAddress || '')
  const forwarded = isLoopback(remote) ? String(request.headers?.['x-real-ip'] || request.headers?.['x-forwarded-for'] || '').split(',')[0].trim() : ''
  const ip = (forwarded || remote || 'unknown').slice(0, 64)
  const now = Date.now()
  for (const [key, value] of attempts) if (now - value.at > 600000) attempts.delete(key)
  const row = attempts.get(ip) || { at: now, count: 0 }
  row.count++
  attempts.set(ip, row)
  if (row.count > 12) throw failure('登录尝试过多，请十分钟后重试', 429)
}
