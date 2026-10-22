import { createHash, createPublicKey, createVerify, randomBytes, X509Certificate } from 'node:crypto'
import { runtimeSecret } from './runtime-secrets.ts'
import { normalizeEmail, validEmail } from './management-store.ts'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'

const jwksCache = new Map()

export class GoogleOAuthError extends Error {
  declare name: string
  declare code: any
  declare status: any

  constructor(code, message = 'Google 登录暂时无法完成', status = 502) {
    super(message)
    this.name = 'GoogleOAuthError'
    this.code = code
    this.status = status
  }
}

export function oauthToken() {
  return randomBytes(32).toString('base64url')
}

export function oauthTokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
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

export function googleOAuthConfig(env = process.env) {
  const clientId = runtimeSecret('GOOGLE_OAUTH_CLIENT_ID', env)
  const clientSecret = runtimeSecret('GOOGLE_OAUTH_CLIENT_SECRET', env)
  const redirect = endpoint(env.GOOGLE_OAUTH_REDIRECT_URI, '', 'GOOGLE_OAUTH_REDIRECT_URI')
  const auth = endpoint(env.GOOGLE_OAUTH_AUTH_URL, GOOGLE_AUTH_URL, 'GOOGLE_OAUTH_AUTH_URL')
  const token = endpoint(env.GOOGLE_OAUTH_TOKEN_URL, GOOGLE_TOKEN_URL, 'GOOGLE_OAUTH_TOKEN_URL')
  const userinfo = endpoint(env.GOOGLE_OAUTH_USERINFO_URL, GOOGLE_USERINFO_URL, 'GOOGLE_OAUTH_USERINFO_URL')
  const jwks = endpoint(env.GOOGLE_OAUTH_JWKS_URL, GOOGLE_JWKS_URL, 'GOOGLE_OAUTH_JWKS_URL')
  const configurationError = redirect.error || auth.error || token.error || userinfo.error || jwks.error || (!clientId || !clientSecret ? 'Google OAuth credentials are not configured' : '')
  return {
    enabled: !configurationError,
    clientId,
    clientSecret,
    redirectUri: redirect.value,
    authUrl: auth.value,
    tokenUrl: token.value,
    userInfoUrl: userinfo.value,
    jwksUrl: jwks.value,
  }
}

export function googleAuthorizationUrl(config, { state, nonce }: Record<string, any>) {
  if (!config?.enabled || !state || !nonce) throw new GoogleOAuthError('google_unavailable', 'Google 登录尚未配置', 503)
  const url = new URL(config.authUrl)
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  }).toString()
  return url.toString()
}

async function jsonResponse(response, code) {
  let data = {}
  try { data = await response.json() } catch { throw new GoogleOAuthError(code) }
  return { response, data }
}

export async function exchangeGoogleCode(config, code, fetchImpl = fetch) {
  if (!config?.enabled || !code) throw new GoogleOAuthError('google_exchange_failed')
  let response
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new GoogleOAuthError('google_exchange_failed')
  }
  const { data }: Record<string, any> = await jsonResponse(response, 'google_exchange_failed')
  if (!response.ok || typeof data.access_token !== 'string' || typeof data.id_token !== 'string') throw new GoogleOAuthError('google_exchange_failed')
  return data
}

export async function fetchGoogleUserInfo(config, accessToken, fetchImpl = fetch) {
  if (!config?.enabled || !accessToken) throw new GoogleOAuthError('google_profile_failed')
  let response
  try {
    response = await fetchImpl(config.userInfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new GoogleOAuthError('google_profile_failed')
  }
  const { data }: Record<string, any> = await jsonResponse(response, 'google_profile_failed')
  if (!response.ok || typeof data.sub !== 'string') throw new GoogleOAuthError('google_profile_failed')
  return data
}

function idTokenParts(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new GoogleOAuthError('google_identity_invalid')
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      claims: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], 'base64url'),
    }
  } catch { throw new GoogleOAuthError('google_identity_invalid') }
}

function claimAudienceMatches(claim, clientId) {
  if (Array.isArray(claim)) return claim.includes(clientId)
  return claim === clientId
}

function hashMatches(value, expectedHash) {
  return Boolean(value && expectedHash && oauthTokenHash(value) === expectedHash)
}

async function googleJwks(config, fetchImpl, force = false) {
  const cached = jwksCache.get(config.jwksUrl)
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys
  let response
  try { response = await fetchImpl(config.jwksUrl, { signal: AbortSignal.timeout(10_000) }) } catch { throw new GoogleOAuthError('google_identity_invalid') }
  const { data }: Record<string, any> = await jsonResponse(response, 'google_identity_invalid')
  if (!response.ok || !Array.isArray(data.keys)) throw new GoogleOAuthError('google_identity_invalid')
  const keys = data.keys.filter((key) => key && (key.kid || key.key || key.x5c))
  jwksCache.set(config.jwksUrl, { keys, expiresAt: Date.now() + 60 * 60 * 1000 })
  return keys
}

function publicKeyForJwk(jwk) {
  try {
    if (jwk.key) return jwk.key
    if (jwk.kty === 'RSA' && jwk.n && jwk.e) return createPublicKey({ key: jwk, format: 'jwk' })
    if (Array.isArray(jwk.x5c) && jwk.x5c[0]) return new X509Certificate(Buffer.from(jwk.x5c[0], 'base64')).publicKey
  } catch {}
  return null
}

async function verifyGoogleIdToken(config, token, nonceHash, fetchImpl) {
  const parsed = idTokenParts(token)
  if (parsed.header.alg !== 'RS256' || !parsed.header.kid || !parsed.signature.length) throw new GoogleOAuthError('google_identity_invalid')
  let keys = await googleJwks(config, fetchImpl)
  let jwk = keys.find((key) => key.kid === parsed.header.kid)
  if (!jwk) {
    keys = await googleJwks(config, fetchImpl, true)
    jwk = keys.find((key) => key.kid === parsed.header.kid)
  }
  const publicKey = publicKeyForJwk(jwk || {})
  if (!publicKey) throw new GoogleOAuthError('google_identity_invalid')
  const verifier = createVerify('RSA-SHA256')
  verifier.update(parsed.signingInput)
  verifier.end()
  let valid = false
  try { valid = verifier.verify(publicKey, parsed.signature) } catch {}
  if (!valid) throw new GoogleOAuthError('google_identity_invalid')
  const claims = parsed.claims
  const issuer = String(claims.iss || '')
  const now = Math.floor(Date.now() / 1000)
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(issuer)) throw new GoogleOAuthError('google_identity_invalid')
  if (!claimAudienceMatches(claims.aud, config.clientId) || (Array.isArray(claims.aud) && claims.azp !== config.clientId)) throw new GoogleOAuthError('google_identity_invalid')
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < now - 60) throw new GoogleOAuthError('google_identity_invalid')
  if (!hashMatches(claims.nonce, nonceHash)) throw new GoogleOAuthError('google_identity_invalid')
  return claims
}

export async function validateGoogleIdentity({ config, tokens, profile, nonceHash, fetchImpl = fetch }: Record<string, any>) {
  const claims = await verifyGoogleIdToken(config, tokens?.id_token, nonceHash, fetchImpl)
  if (typeof claims.sub !== 'string' || claims.sub.length < 1 || claims.sub.length > 255 || profile?.sub !== claims.sub) throw new GoogleOAuthError('google_identity_invalid')

  const email = normalizeEmail(profile.email || claims.email)
  const emailVerified = profile.email_verified === true || profile.email_verified === 'true' || claims.email_verified === true || claims.email_verified === 'true'
  if (!validEmail(email) || !emailVerified) throw new GoogleOAuthError('google_email_unverified', 'Google 账号邮箱尚未验证', 422)
  if (claims.email && normalizeEmail(claims.email) !== email) throw new GoogleOAuthError('google_identity_invalid')
  return {
    subject: claims.sub,
    email,
    name: String(profile.name || claims.name || email.split('@')[0]).trim().slice(0, 60),
    emailVerified: true,
  }
}
