export const QQ_AUTH_URL = 'https://graph.qq.com/oauth2.0/authorize'
import { runtimeSecret } from './runtime-secrets.ts'
export const QQ_TOKEN_URL = 'https://graph.qq.com/oauth2.0/token'
export const QQ_OPENID_URL = 'https://graph.qq.com/oauth2.0/me'
export const QQ_USERINFO_URL = 'https://graph.qq.com/user/get_user_info'

export class QQOAuthError extends Error {
  declare name: string
  declare code: any
  declare status: any

  constructor(code, message = 'QQ 登录暂时无法完成', status = 502) {
    super(message)
    this.name = 'QQOAuthError'
    this.code = code
    this.status = status
  }
}

function endpoint(value, fallback, name) {
  const text = String(value || fallback).trim()
  let url
  try { url = new URL(text) } catch { return { value: '', error: `${name} invalid` } }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    return { value: '', error: `${name} invalid` }
  }
  return { value: url.toString(), error: '' }
}

export function qqOAuthConfig(env = process.env) {
  const appId = runtimeSecret('QQ_OAUTH_APP_ID', env) || String(env.QQ_CONNECT_APP_ID || '').trim()
  const appKey = runtimeSecret('QQ_OAUTH_APP_KEY', env) || String(env.QQ_CONNECT_APP_KEY || '').trim()
  const redirect = endpoint(env.QQ_OAUTH_REDIRECT_URI || env.QQ_CONNECT_REDIRECT_URI, '', 'QQ_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.QQ_OAUTH_AUTH_URL, QQ_AUTH_URL, 'QQ_OAUTH_AUTH_URL')
  const token = endpoint(env.QQ_OAUTH_TOKEN_URL, QQ_TOKEN_URL, 'QQ_OAUTH_TOKEN_URL')
  const openid = endpoint(env.QQ_OAUTH_OPENID_URL, QQ_OPENID_URL, 'QQ_OAUTH_OPENID_URL')
  const userinfo = endpoint(env.QQ_OAUTH_USERINFO_URL, QQ_USERINFO_URL, 'QQ_OAUTH_USERINFO_URL')
  const scope = String(env.QQ_OAUTH_SCOPE || 'get_user_info').trim() || 'get_user_info'
  const configurationError = redirect.error || auth.error || token.error || openid.error || userinfo.error || (!appId || !appKey ? 'QQ OAuth credentials are not configured' : '')
  return {
    enabled: !configurationError,
    appId,
    appKey,
    redirectUri: redirect.value,
    authUrl: auth.value,
    tokenUrl: token.value,
    openidUrl: openid.value,
    userInfoUrl: userinfo.value,
    scope,
  }
}

export function qqAuthorizationUrl(config, { state }: Record<string, any>) {
  if (!config?.enabled || !state) throw new QQOAuthError('qq_unavailable', 'QQ 登录尚未配置', 503)
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
  }).toString()
  return url.toString()
}

function parseProviderBody(text, code) {
  const body = String(text || '').trim()
  if (!body) throw new QQOAuthError(code)
  try {
    const data = JSON.parse(body)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid object')
    return data
  } catch {}
  const jsonp = /^\s*callback\s*\(\s*([\s\S]*?)\s*\)\s*;?\s*$/.exec(body)
  if (jsonp) {
    try {
      const data = JSON.parse(jsonp[1])
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid object')
      return data
    } catch {}
  }
  const params = new URLSearchParams(body)
  const data = Object.fromEntries(params.entries())
  if (Object.keys(data).length) return data
  throw new QQOAuthError(code)
}

async function providerBody(response, code) {
  let text
  try { text = await response.text() } catch { throw new QQOAuthError(code) }
  const data = parseProviderBody(text, code)
  if (!response.ok) throw new QQOAuthError(code)
  return data
}

export async function exchangeQQCode(config, code, fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new QQOAuthError('qq_exchange_failed')
  const url = new URL(config.tokenUrl)
  url.search = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.appId,
    client_secret: config.appKey,
    code: String(code),
    redirect_uri: config.redirectUri,
    fmt: 'json',
  }).toString()
  let response
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) }) } catch { throw new QQOAuthError('qq_exchange_failed') }
  const data = await providerBody(response, 'qq_exchange_failed')
  if (data.error || typeof data.access_token !== 'string' || !data.access_token.trim()) throw new QQOAuthError('qq_exchange_failed')
  return data
}

export async function fetchQQOpenId(config, accessToken, fetchImpl = fetch) {
  if (!config?.enabled || !accessToken) throw new QQOAuthError('qq_identity_failed')
  const url = new URL(config.openidUrl)
  url.search = new URLSearchParams({ access_token: String(accessToken), fmt: 'json', unionid: '1' }).toString()
  let response
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) }) } catch { throw new QQOAuthError('qq_identity_failed') }
  const data = await providerBody(response, 'qq_identity_failed')
  if (data.error || typeof data.openid !== 'string' || !data.openid.trim()) throw new QQOAuthError('qq_identity_failed')
  if (data.client_id && String(data.client_id) !== config.appId) throw new QQOAuthError('qq_identity_invalid')
  return data
}

export async function fetchQQUserInfo(config, accessToken, openid, fetchImpl = fetch) {
  if (!config?.enabled || !accessToken || !openid) throw new QQOAuthError('qq_profile_failed')
  const url = new URL(config.userInfoUrl)
  url.search = new URLSearchParams({
    access_token: String(accessToken),
    oauth_consumer_key: config.appId,
    openid: String(openid),
  }).toString()
  let response
  try { response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) }) } catch { throw new QQOAuthError('qq_profile_failed') }
  const data = await providerBody(response, 'qq_profile_failed')
  if (String(data.ret ?? '0') !== '0') throw new QQOAuthError('qq_profile_failed')
  return data
}

export function validateQQIdentity({ config, openId, openid, profile }: Record<string, any>) {
  const subjectId = String(openId || openid || '').trim()
  if (!config?.enabled || !subjectId || subjectId.length > 255) throw new QQOAuthError('qq_identity_invalid')
  const name = String(profile?.nickname || '').trim().slice(0, 60) || 'QQ 用户'
  const avatar = String(profile?.figureurl_qq_2 || profile?.figureurl_qq_1 || profile?.figureurl_2 || profile?.figureurl_1 || '').trim()
  if (avatar) {
    try {
      const parsed = new URL(avatar)
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error('invalid avatar')
    } catch { throw new QQOAuthError('qq_identity_invalid') }
  }
  return {
    subject: `${config.appId}:${subjectId}`,
    openid: subjectId,
    unionid: String(profile?.unionid || '').trim().slice(0, 255),
    name,
    avatar,
  }
}
