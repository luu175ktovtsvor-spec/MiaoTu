import { createHash, createPublicKey, createVerify } from 'node:crypto'
import { runtimeSecret } from './runtime-secrets.ts'

export class ExtraOAuthError extends Error {
  declare name: string
  declare code: any
  declare status: any

  constructor(code, message = '第三方登录暂时无法完成', status = 502) {
    super(message)
    this.name = 'ExtraOAuthError'
    this.code = code
    this.status = status
  }
}

function endpoint(value, fallback, name, { required = true }: Record<string, any> = {}) {
  const raw = String(value || fallback || '').trim()
  if (!raw && !required) return { value: '', error: '' }
  let url
  try { url = new URL(raw) } catch { return { value: '', error: `${name} invalid` } }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) {
    return { value: '', error: `${name} invalid` }
  }
  return { value: url.toString(), error: '' }
}

function requiredConfig({ clientId, clientSecret, redirect, endpoints = [], extraError = '' }: Record<string, any>) {
  return redirect.error || endpoints.find((item) => item.error)?.error || extraError || (!clientId || !clientSecret ? 'OAuth credentials are not configured' : '')
}

function cleanScope(value, fallback) {
  return String(value || fallback || '').trim().replace(/\s+/g, ' ')
}

export const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USERINFO_URL = 'https://api.github.com/user'
export const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails'

export function githubOAuthConfig(env = process.env) {
  const clientId = runtimeSecret('GITHUB_OAUTH_CLIENT_ID', env)
  const clientSecret = runtimeSecret('GITHUB_OAUTH_CLIENT_SECRET', env)
  const redirect = endpoint(env.GITHUB_OAUTH_REDIRECT_URI, '', 'GITHUB_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.GITHUB_OAUTH_AUTH_URL, GITHUB_AUTH_URL, 'GITHUB_OAUTH_AUTH_URL')
  const token = endpoint(env.GITHUB_OAUTH_TOKEN_URL, GITHUB_TOKEN_URL, 'GITHUB_OAUTH_TOKEN_URL')
  const userinfo = endpoint(env.GITHUB_OAUTH_USERINFO_URL, GITHUB_USERINFO_URL, 'GITHUB_OAUTH_USERINFO_URL')
  const emails = endpoint(env.GITHUB_OAUTH_EMAILS_URL, GITHUB_EMAILS_URL, 'GITHUB_OAUTH_EMAILS_URL')
  const configurationError = requiredConfig({ clientId, clientSecret, redirect, endpoints: [auth, token, userinfo, emails] })
  return { enabled: !configurationError, clientId, clientSecret, redirectUri: redirect.value, authUrl: auth.value, tokenUrl: token.value, userInfoUrl: userinfo.value, emailsUrl: emails.value, scope: cleanScope(env.GITHUB_OAUTH_SCOPE, 'read:user user:email') }
}

export function githubAuthorizationUrl(config, { state }: Record<string, any>) {
  if (!config?.enabled || !state) throw new ExtraOAuthError('github_unavailable', 'GitHub 登录尚未配置', 503)
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope, state, allow_signup: 'true' }).toString()
  return url.toString()
}

export const WECHAT_AUTH_URL = 'https://open.weixin.qq.com/connect/qrconnect'
export const WECHAT_TOKEN_URL = 'https://api.weixin.qq.com/sns/oauth2/access_token'
export const WECHAT_USERINFO_URL = 'https://api.weixin.qq.com/sns/userinfo'

export function wechatOAuthConfig(env = process.env) {
  const appId = runtimeSecret('WECHAT_OAUTH_APP_ID', env) || String(env.WECHAT_CONNECT_APP_ID || '').trim()
  const appSecret = runtimeSecret('WECHAT_OAUTH_APP_SECRET', env) || String(env.WECHAT_CONNECT_APP_SECRET || '').trim()
  const redirect = endpoint(env.WECHAT_OAUTH_REDIRECT_URI || env.WECHAT_CONNECT_REDIRECT_URI, '', 'WECHAT_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.WECHAT_OAUTH_AUTH_URL, WECHAT_AUTH_URL, 'WECHAT_OAUTH_AUTH_URL')
  const token = endpoint(env.WECHAT_OAUTH_TOKEN_URL, WECHAT_TOKEN_URL, 'WECHAT_OAUTH_TOKEN_URL')
  const userinfo = endpoint(env.WECHAT_OAUTH_USERINFO_URL, WECHAT_USERINFO_URL, 'WECHAT_OAUTH_USERINFO_URL')
  const configurationError = redirect.error || auth.error || token.error || userinfo.error || (!appId || !appSecret ? 'WeChat OAuth credentials are not configured' : '')
  return { enabled: !configurationError, appId, appSecret, redirectUri: redirect.value, authUrl: auth.value, tokenUrl: token.value, userInfoUrl: userinfo.value, scope: cleanScope(env.WECHAT_OAUTH_SCOPE || env.WECHAT_CONNECT_SCOPE, 'snsapi_login') }
}

export function wechatAuthorizationUrl(config, { state }: Record<string, any>) {
  if (!config?.enabled || !state) throw new ExtraOAuthError('wechat_unavailable', '微信登录尚未配置', 503)
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams({ appid: config.appId, redirect_uri: config.redirectUri, response_type: 'code', scope: config.scope, state }).toString()
  url.hash = 'wechat_redirect'
  return url.toString()
}

export const DINGTALK_AUTH_URL = 'https://login.dingtalk.com/oauth2/auth'
export const DINGTALK_TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken'
export const DINGTALK_USERINFO_URL = 'https://api.dingtalk.com/v1.0/contact/users/me'

export function dingTalkOAuthConfig(env = process.env) {
  const clientId = runtimeSecret('DINGTALK_OAUTH_CLIENT_ID', env) || String(env.DINGTALK_CONNECT_CLIENT_ID || '').trim()
  const clientSecret = runtimeSecret('DINGTALK_OAUTH_CLIENT_SECRET', env) || String(env.DINGTALK_CONNECT_CLIENT_SECRET || '').trim()
  const redirect = endpoint(env.DINGTALK_OAUTH_REDIRECT_URI || env.DINGTALK_CONNECT_REDIRECT_URI, '', 'DINGTALK_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.DINGTALK_OAUTH_AUTH_URL || env.DINGTALK_CONNECT_AUTHORIZE_URL, DINGTALK_AUTH_URL, 'DINGTALK_OAUTH_AUTH_URL')
  const token = endpoint(env.DINGTALK_OAUTH_TOKEN_URL || env.DINGTALK_CONNECT_TOKEN_URL, DINGTALK_TOKEN_URL, 'DINGTALK_OAUTH_TOKEN_URL')
  const userinfo = endpoint(env.DINGTALK_OAUTH_USERINFO_URL || env.DINGTALK_CONNECT_USERINFO_URL, DINGTALK_USERINFO_URL, 'DINGTALK_OAUTH_USERINFO_URL')
  const configurationError = requiredConfig({ clientId, clientSecret, redirect, endpoints: [auth, token, userinfo] })
  return { enabled: !configurationError, clientId, clientSecret, redirectUri: redirect.value, authUrl: auth.value, tokenUrl: token.value, userInfoUrl: userinfo.value, scope: cleanScope(env.DINGTALK_OAUTH_SCOPE || env.DINGTALK_CONNECT_SCOPES, 'openid') }
}

export function dingTalkAuthorizationUrl(config, { state }: Record<string, any>) {
  if (!config?.enabled || !state) throw new ExtraOAuthError('dingtalk_unavailable', '钉钉登录尚未配置', 503)
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams({ client_id: config.clientId, response_type: 'code', scope: config.scope, state, redirect_uri: config.redirectUri }).toString()
  return url.toString()
}

const LINUXDO_AUTH_URL = 'https://connect.linux.do/oauth2/authorize'
const LINUXDO_TOKEN_URL = 'https://connect.linux.do/oauth2/token'
const LINUXDO_USERINFO_URL = 'https://connect.linux.do/api/user'

export function linuxDoOAuthConfig(env = process.env) {
  const clientId = runtimeSecret('LINUXDO_OAUTH_CLIENT_ID', env) || String(env.LINUXDO_CONNECT_CLIENT_ID || '').trim()
  const clientSecret = runtimeSecret('LINUXDO_OAUTH_CLIENT_SECRET', env) || String(env.LINUXDO_CONNECT_CLIENT_SECRET || '').trim()
  const redirect = endpoint(env.LINUXDO_OAUTH_REDIRECT_URI || env.LINUXDO_CONNECT_REDIRECT_URI, '', 'LINUXDO_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.LINUXDO_OAUTH_AUTH_URL || env.LINUXDO_CONNECT_AUTHORIZE_URL, LINUXDO_AUTH_URL, 'LINUXDO_OAUTH_AUTH_URL')
  const token = endpoint(env.LINUXDO_OAUTH_TOKEN_URL || env.LINUXDO_CONNECT_TOKEN_URL, LINUXDO_TOKEN_URL, 'LINUXDO_OAUTH_TOKEN_URL')
  const userinfo = endpoint(env.LINUXDO_OAUTH_USERINFO_URL || env.LINUXDO_CONNECT_USERINFO_URL, LINUXDO_USERINFO_URL, 'LINUXDO_OAUTH_USERINFO_URL')
  const configurationError = requiredConfig({ clientId, clientSecret, redirect, endpoints: [auth, token, userinfo] })
  return { enabled: !configurationError, clientId, clientSecret, redirectUri: redirect.value, authUrl: auth.value, tokenUrl: token.value, userInfoUrl: userinfo.value, scope: cleanScope(env.LINUXDO_OAUTH_SCOPE || env.LINUXDO_CONNECT_SCOPES, 'openid profile email'), usePKCE: String(env.LINUXDO_OAUTH_USE_PKCE || 'true').toLowerCase() !== 'false' }
}

export function linuxDoAuthorizationUrl(config, { state, codeChallenge = '' }: Record<string, any>) {
  if (!config?.enabled || !state) throw new ExtraOAuthError('linuxdo_unavailable', 'Linux.do 登录尚未配置', 503)
  const params: Record<string, any> = { response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope, state }
  if (codeChallenge) { params.code_challenge = codeChallenge; params.code_challenge_method = 'S256' }
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}

export function oidcOAuthConfig(env = process.env) {
  const clientId = runtimeSecret('OIDC_OAUTH_CLIENT_ID', env) || String(env.OIDC_CONNECT_CLIENT_ID || '').trim()
  const clientSecret = runtimeSecret('OIDC_OAUTH_CLIENT_SECRET', env) || String(env.OIDC_CONNECT_CLIENT_SECRET || '').trim()
  const issuer = endpoint(env.OIDC_OAUTH_ISSUER_URL || env.OIDC_CONNECT_ISSUER_URL, '', 'OIDC_OAUTH_ISSUER_URL')
  const redirect = endpoint(env.OIDC_OAUTH_REDIRECT_URI || env.OIDC_CONNECT_REDIRECT_URI, '', 'OIDC_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.OIDC_OAUTH_AUTH_URL || env.OIDC_CONNECT_AUTHORIZE_URL, '', 'OIDC_OAUTH_AUTH_URL', { required: false })
  const token = endpoint(env.OIDC_OAUTH_TOKEN_URL || env.OIDC_CONNECT_TOKEN_URL, '', 'OIDC_OAUTH_TOKEN_URL', { required: false })
  const userinfo = endpoint(env.OIDC_OAUTH_USERINFO_URL || env.OIDC_CONNECT_USERINFO_URL, '', 'OIDC_OAUTH_USERINFO_URL', { required: false })
  const jwks = endpoint(env.OIDC_OAUTH_JWKS_URL || env.OIDC_CONNECT_JWKS_URL, '', 'OIDC_OAUTH_JWKS_URL', { required: false })
  const configurationError = issuer.error || redirect.error || auth.error || token.error || userinfo.error || jwks.error || (!clientId || !clientSecret ? 'OIDC credentials are not configured' : '')
  return {
    enabled: !configurationError,
    clientId,
    clientSecret,
    issuerUrl: issuer.value,
    redirectUri: redirect.value,
    authUrl: auth.value,
    tokenUrl: token.value,
    userInfoUrl: userinfo.value,
    jwksUrl: jwks.value,
    providerName: String(env.OIDC_OAUTH_PROVIDER_NAME || env.OIDC_CONNECT_PROVIDER_NAME || 'OIDC').trim().slice(0, 40) || 'OIDC',
    scope: cleanScope(env.OIDC_OAUTH_SCOPE || env.OIDC_CONNECT_SCOPES, 'openid profile email'),
    usePKCE: String(env.OIDC_OAUTH_USE_PKCE || 'true').toLowerCase() !== 'false',
    requireEmailVerified: String(env.OIDC_OAUTH_REQUIRE_EMAIL_VERIFIED || 'false').toLowerCase() === 'true',
  }
}

export function oidcAuthorizationUrl(config, { state, nonce = '', codeChallenge = '' }: Record<string, any>) {
  if (!config?.enabled || !config.authUrl || !state) throw new ExtraOAuthError('oidc_unavailable', 'OIDC 登录尚未配置', 503)
  const params: Record<string, any> = { response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri, scope: config.scope, state }
  if (nonce) params.nonce = nonce
  if (codeChallenge) { params.code_challenge = codeChallenge; params.code_challenge_method = 'S256' }
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams(params).toString()
  return url.toString()
}

async function responseData(response, code, { allowForm = false, allowArray = false }: Record<string, any> = {}) {
  let text = ''
  try { text = await response.text() } catch { throw new ExtraOAuthError(code) }
  let data
  try { data = JSON.parse(text) } catch {
    if (allowForm) data = Object.fromEntries(new URLSearchParams(text).entries())
  }
  if (!data || typeof data !== 'object' || (!allowArray && Array.isArray(data)) || !response.ok) throw new ExtraOAuthError(code)
  if (data.error || (data.errcode !== undefined && String(data.errcode) !== '0')) throw new ExtraOAuthError(code)
  return data
}

async function requestJson(url, options, code, fetchImpl = fetch) {
  let response
  const { allowForm = false, allowArray = false, ...fetchOptions } = options || {}
  try { response = await fetchImpl(url, { ...fetchOptions, signal: AbortSignal.timeout(10_000) }) } catch { throw new ExtraOAuthError(code) }
  return responseData(response, code, { allowForm, allowArray })
}

function bearerHeaders(token, userAgent = 'MiaoImg OAuth') {
  return { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': userAgent }
}

function avatarUrl(value, code) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid')
  } catch { throw new ExtraOAuthError(code) }
  return raw.slice(0, 2048)
}

export async function exchangeGithubCode(config, code, fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new ExtraOAuthError('github_exchange_failed')
  const data = await requestJson(config.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'MiaoImg OAuth' }, body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: String(code), redirect_uri: config.redirectUri }), allowForm: true }, 'github_exchange_failed', fetchImpl)
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new ExtraOAuthError('github_exchange_failed')
  return data
}

export async function fetchGithubIdentity(config, accessToken, fetchImpl = fetch) {
  if (!config?.enabled || !accessToken) throw new ExtraOAuthError('github_profile_failed')
  const profile = await requestJson(config.userInfoUrl, { headers: bearerHeaders(accessToken, 'MiaoImg OAuth') }, 'github_profile_failed', fetchImpl)
  const emails = await requestJson(config.emailsUrl, { headers: bearerHeaders(accessToken, 'MiaoImg OAuth'), allowArray: true }, 'github_email_failed', fetchImpl)
  if (!Array.isArray(emails)) throw new ExtraOAuthError('github_email_failed')
  const emailRow = emails.find((item) => item?.verified === true && item?.primary === true) || emails.find((item) => item?.verified === true)
  if (!emailRow?.email) throw new ExtraOAuthError('github_email_unverified', 'GitHub 没有返回已验证邮箱', 422)
  const subject = String(profile.id || '').trim()
  const email = String(emailRow.email || '').trim().toLowerCase()
  if (!subject || subject.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)) throw new ExtraOAuthError('github_identity_invalid')
  return { subject, email, emailVerified: true, name: String(profile.name || profile.login || '').trim().slice(0, 60), avatar: avatarUrl(profile.avatar_url, 'github_identity_invalid') }
}

export async function exchangeWeChatCode(config, code, fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new ExtraOAuthError('wechat_exchange_failed')
  const url = new URL(config.tokenUrl)
  url.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret, code: String(code), grant_type: 'authorization_code' }).toString()
  return requestJson(url, {}, 'wechat_exchange_failed', fetchImpl)
}

export async function fetchWeChatIdentity(config, token, fetchImpl = fetch) {
  if (!config?.enabled || !token?.access_token || !token.openid) throw new ExtraOAuthError('wechat_identity_failed')
  const url = new URL(config.userInfoUrl)
  url.search = new URLSearchParams({ access_token: token.access_token, openid: token.openid, lang: 'zh_CN' }).toString()
  const profile = await requestJson(url, {}, 'wechat_identity_failed', fetchImpl)
  const openid = String(profile.openid || token.openid || '').trim()
  if (!openid || openid.length > 255) throw new ExtraOAuthError('wechat_identity_invalid')
  return { subject: `${config.appId}:${openid}`, name: String(profile.nickname || '').trim().slice(0, 60), avatar: avatarUrl(profile.headimgurl, 'wechat_identity_invalid'), appId: config.appId, unionid: String(profile.unionid || token.unionid || '').trim().slice(0, 255) }
}

export async function exchangeDingTalkCode(config, code, fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new ExtraOAuthError('dingtalk_exchange_failed')
  const data = await requestJson(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ clientId: config.clientId, clientSecret: config.clientSecret, code: String(code), grantType: 'authorization_code' }) }, 'dingtalk_exchange_failed', fetchImpl)
  if (typeof data.accessToken !== 'string' || !data.accessToken.trim()) throw new ExtraOAuthError('dingtalk_exchange_failed')
  return data
}

export async function fetchDingTalkIdentity(config, token, fetchImpl = fetch) {
  if (!config?.enabled || !token?.accessToken) throw new ExtraOAuthError('dingtalk_identity_failed')
  const profile = await requestJson(config.userInfoUrl, { headers: { ...bearerHeaders(token.accessToken), 'x-acs-dingtalk-access-token': token.accessToken } }, 'dingtalk_identity_failed', fetchImpl)
  const subject = String(profile.unionId || profile.openId || profile.userid || '').trim()
  if (!subject || subject.length > 255) throw new ExtraOAuthError('dingtalk_identity_invalid')
  const email = String(profile.email || profile.org_email || '').trim().toLowerCase()
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)
  return { subject: `${config.clientId}:${subject}`, name: String(profile.nick || profile.name || profile.nickname || '').trim().slice(0, 60), email: valid && profile.email_verified === true ? email : '', emailVerified: valid && profile.email_verified === true, avatar: avatarUrl(profile.avatarUrl || profile.avatar_url, 'dingtalk_identity_invalid'), appId: config.clientId }
}

export async function exchangeLinuxDoCode(config, code, codeVerifier = '', fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new ExtraOAuthError('linuxdo_exchange_failed')
  const body: Record<string, any> = { grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code: String(code), redirect_uri: config.redirectUri }
  if (codeVerifier) body.code_verifier = codeVerifier
  const data = await requestJson(config.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), allowForm: true }, 'linuxdo_exchange_failed', fetchImpl)
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new ExtraOAuthError('linuxdo_exchange_failed')
  return data
}

export async function fetchLinuxDoIdentity(config, token, fetchImpl = fetch) {
  if (!config?.enabled || !token?.access_token) throw new ExtraOAuthError('linuxdo_identity_failed')
  const profile = await requestJson(config.userInfoUrl, { headers: bearerHeaders(token.access_token) }, 'linuxdo_identity_failed', fetchImpl)
  const subject = String(profile.sub || profile.id || profile.user_id || '').trim()
  if (!subject || subject.length > 255) throw new ExtraOAuthError('linuxdo_identity_invalid')
  const email = String(profile.email || '').trim().toLowerCase()
  const verified = profile.email_verified === true || profile.email_verified === 'true'
  return { subject, name: String(profile.name || profile.username || profile.login || '').trim().slice(0, 60), email: verified && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email) ? email : '', emailVerified: verified, avatar: avatarUrl(profile.avatar_url || profile.avatar, 'linuxdo_identity_invalid') }
}

export async function resolveOIDCConfig(config, fetchImpl = fetch) {
  if (!config?.enabled) throw new ExtraOAuthError('oidc_unavailable', 'OIDC 登录尚未配置', 503)
  if (config.authUrl && config.tokenUrl && config.userInfoUrl && config.jwksUrl) return config
  const discoveryUrl = new URL('.well-known/openid-configuration', config.issuerUrl.endsWith('/') ? config.issuerUrl : `${config.issuerUrl}/`)
  const discovery = await requestJson(discoveryUrl, { headers: { accept: 'application/json' } }, 'oidc_discovery_failed', fetchImpl)
  const endpointFromDiscovery = (value, code) => {
    const raw = String(value || '').trim()
    if (!raw) return ''
    const parsed = endpoint(raw, '', code, { required: true })
    if (parsed.error) throw new ExtraOAuthError('oidc_discovery_failed')
    return parsed.value
  }
  const discoveredIssuer = String(discovery.issuer || config.issuerUrl).replace(/\/$/, '')
  const configuredIssuer = String(config.issuerUrl || '').replace(/\/$/, '')
  if (!discoveredIssuer || discoveredIssuer !== configuredIssuer) throw new ExtraOAuthError('oidc_discovery_failed')
  const resolved = {
    ...config,
    issuerUrl: discoveredIssuer,
    authUrl: config.authUrl || endpointFromDiscovery(discovery.authorization_endpoint, 'authorization_endpoint'),
    tokenUrl: config.tokenUrl || endpointFromDiscovery(discovery.token_endpoint, 'token_endpoint'),
    userInfoUrl: config.userInfoUrl || endpointFromDiscovery(discovery.userinfo_endpoint, 'userinfo_endpoint'),
    jwksUrl: config.jwksUrl || endpointFromDiscovery(discovery.jwks_uri, 'jwks_uri'),
  }
  if (!resolved.authUrl || !resolved.tokenUrl || !resolved.userInfoUrl || !resolved.jwksUrl) throw new ExtraOAuthError('oidc_discovery_failed')
  return resolved
}

export async function exchangeOIDCCode(config, code, codeVerifier = '', fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new ExtraOAuthError('oidc_exchange_failed')
  const body: Record<string, any> = { grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret, code: String(code), redirect_uri: config.redirectUri }
  if (codeVerifier) body.code_verifier = codeVerifier
  const data = await requestJson(config.tokenUrl, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), allowForm: true }, 'oidc_exchange_failed', fetchImpl)
  if (typeof data.access_token !== 'string' || !data.access_token.trim()) throw new ExtraOAuthError('oidc_exchange_failed')
  return data
}

function decodeJwt(token, code) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new ExtraOAuthError(code)
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')), claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), input: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') }
  } catch { throw new ExtraOAuthError(code) }
}

function oidcJwkKey(jwk, code) {
  try { return createPublicKey({ key: jwk, format: 'jwk' }) } catch { throw new ExtraOAuthError(code) }
}

async function verifyOIDCIdToken(config, token, nonceHash, fetchImpl) {
  const parsed = decodeJwt(token, 'oidc_identity_invalid')
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid || !parsed.signature.length) throw new ExtraOAuthError('oidc_identity_invalid')
  const jwks = await requestJson(config.jwksUrl, { headers: { accept: 'application/json' } }, 'oidc_identity_invalid', fetchImpl)
  const jwk = Array.isArray(jwks.keys) ? jwks.keys.find((item) => item?.kid === parsed.header.kid) : null
  if (!jwk) throw new ExtraOAuthError('oidc_identity_invalid')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(parsed.input)
  verifier.end()
  if (!verifier.verify(oidcJwkKey(jwk, 'oidc_identity_invalid'), parsed.signature)) throw new ExtraOAuthError('oidc_identity_invalid')
  const issuer = String(parsed.claims.iss || '').replace(/\/$/, '')
  const expectedIssuer = String(config.issuerUrl || '').replace(/\/$/, '')
  const now = Math.floor(Date.now() / 1000)
  const audience = parsed.claims.aud
  const audienceMatches = Array.isArray(audience) ? audience.includes(config.clientId) : audience === config.clientId
  const azpMatches = !Array.isArray(audience) || audience.length < 2 ? true : parsed.claims.azp === config.clientId
  if (!issuer || issuer !== expectedIssuer || !audienceMatches || !azpMatches || !Number.isFinite(Number(parsed.claims.exp)) || Number(parsed.claims.exp) < now - 60 || (nonceHash && !hashNonce(parsed.claims.nonce, nonceHash))) throw new ExtraOAuthError('oidc_identity_invalid')
  return parsed.claims
}

function hashNonce(value, expectedHash) {
  if (!value || !expectedHash || !/^[a-f0-9]{64}$/i.test(String(expectedHash))) return false
  return createHash('sha256').update(String(value)).digest('hex') === String(expectedHash).toLowerCase()
}

export async function fetchOIDCIdentity(config, tokens, nonceHash = '', fetchImpl = fetch) {
  if (!config?.enabled || !tokens?.access_token) throw new ExtraOAuthError('oidc_identity_failed')
  if (!tokens.id_token) throw new ExtraOAuthError('oidc_identity_invalid')
  const claims = await verifyOIDCIdToken(config, tokens.id_token, nonceHash, fetchImpl)
  const profile = await requestJson(config.userInfoUrl, { headers: bearerHeaders(tokens.access_token) }, 'oidc_identity_failed', fetchImpl)
  const subject = String(claims.sub || profile.sub || '').trim()
  if (!subject || subject.length > 255 || (claims.sub && profile.sub && String(profile.sub) !== subject)) throw new ExtraOAuthError('oidc_identity_invalid')
  const email = String(profile.email || claims.email || '').trim().toLowerCase()
  const verified = profile.email_verified === true || profile.email_verified === 'true' || claims.email_verified === true || claims.email_verified === 'true'
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email)
  if (config.requireEmailVerified && (!valid || !verified)) throw new ExtraOAuthError('oidc_email_unverified', 'OIDC 返回的邮箱尚未验证', 422)
  return { subject: `${config.issuerUrl}:${subject}`, name: String(profile.name || profile.preferred_username || claims.name || claims.preferred_username || '').trim().slice(0, 60), email: valid && verified ? email : '', emailVerified: valid && verified, avatar: avatarUrl(profile.picture || claims.picture, 'oidc_identity_invalid'), label: config.providerName, appId: config.issuerUrl }
}
