import { createHash } from 'node:crypto'
import type { ManagementStore } from '../management-store.ts'
import { cookieToken, sessionCookie, oauthStateCookie } from '../http-auth.ts'
import { GoogleOAuthError, exchangeGoogleCode, fetchGoogleUserInfo, googleAuthorizationUrl, googleOAuthConfig, oauthToken, validateGoogleIdentity } from '../google-oauth.ts'
import { QQOAuthError, exchangeQQCode, fetchQQOpenId, fetchQQUserInfo, qqAuthorizationUrl, qqOAuthConfig, validateQQIdentity } from '../qq-oauth.ts'
import {
  ExtraOAuthError,
  dingTalkAuthorizationUrl,
  dingTalkOAuthConfig,
  exchangeDingTalkCode,
  exchangeGithubCode,
  exchangeLinuxDoCode,
  exchangeOIDCCode,
  exchangeWeChatCode,
  fetchDingTalkIdentity,
  fetchGithubIdentity,
  fetchLinuxDoIdentity,
  fetchOIDCIdentity,
  fetchWeChatIdentity,
  githubAuthorizationUrl,
  githubOAuthConfig,
  linuxDoAuthorizationUrl,
  linuxDoOAuthConfig,
  oidcAuthorizationUrl,
  oidcOAuthConfig,
  resolveOIDCConfig,
  wechatAuthorizationUrl,
  wechatOAuthConfig,
} from '../oauth-extra.ts'

type OAuthAccounts = Pick<ManagementStore, 'saveOAuthState' | 'consumeOAuthState' | 'loginGoogle' | 'loginQQ' | 'loginGitHub' | 'loginWeChat' | 'loginDingTalk' | 'loginLinuxDo' | 'loginOIDC'>

// Third-party login orchestration owns state cookies and provider callbacks.
// The host supplies its existing account store; importing this module starts no service.
export function createOAuthLogin({ management }: { management: OAuthAccounts }) {
  function redirect(response, location, headers: Record<string, any> = {}) {
    response.writeHead(303, { location, 'cache-control': 'no-store', ...headers })
    response.end()
  }

  function googleErrorCode(error) {
    if (error instanceof GoogleOAuthError) return error.code
    if (error?.status === 403) return 'google_account_disabled'
    if (error?.status === 409) return 'google_account_conflict'
    return 'google_login_failed'
  }

  function redirectGoogleError(request, response, code) {
    const location = `/?oauth_error=${encodeURIComponent(code || 'google_login_failed')}`
    redirect(response, location, { 'set-cookie': oauthStateCookie(request, '', true) })
  }

  function startGoogleLogin(request, response) {
    const config = googleOAuthConfig(process.env)
    if (!config.enabled) { redirectGoogleError(request, response, 'google_unavailable'); return }
    const state = oauthToken()
    const nonce = oauthToken()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    management.saveOAuthState({ provider: 'google', state, nonce, redirectUri: config.redirectUri, expiresAt })
    redirect(response, googleAuthorizationUrl(config, { state, nonce }), { 'set-cookie': oauthStateCookie(request, state) })
  }

  async function completeGoogleLogin(request, response, url) {
    const state = String(url.searchParams.get('state') || '').trim()
    const stateCookie = cookieToken(request, 'miao_google_state')
    if (!state || !stateCookie) { redirectGoogleError(request, response, 'google_state_invalid'); return }
    const config = googleOAuthConfig(process.env)
    const stored = config.enabled ? management.consumeOAuthState({ provider: 'google', state, stateCookie }) : null
    if (!stored || stored.redirectUri !== config.redirectUri) { redirectGoogleError(request, response, 'google_state_invalid'); return }
    if (url.searchParams.get('error')) { redirectGoogleError(request, response, 'google_denied'); return }
    const code = String(url.searchParams.get('code') || '').trim()
    if (!code) { redirectGoogleError(request, response, 'google_code_missing'); return }
    try {
      const tokens: any = await exchangeGoogleCode(config, code)
      const profile = await fetchGoogleUserInfo(config, tokens.access_token)
      const identity = await validateGoogleIdentity({ config, tokens, profile, nonceHash: stored.nonceHash })
      const session = management.loginGoogle(identity)
      redirect(response, '/', { 'set-cookie': [sessionCookie(request, session.token), oauthStateCookie(request, '', true)] })
    } catch (error) {
      redirectGoogleError(request, response, googleErrorCode(error))
    }
  }

  function qqErrorCode(error) {
    if (error instanceof QQOAuthError) return error.code
    if (error?.status === 403) return 'qq_account_disabled'
    if (error?.status === 409) return 'qq_account_conflict'
    return 'qq_login_failed'
  }

  function redirectQQError(request, response, code) {
    const location = `/?oauth_error=${encodeURIComponent(code || 'qq_login_failed')}`
    redirect(response, location, { 'set-cookie': oauthStateCookie(request, '', true, 'miao_qq_state') })
  }

  function startQQLogin(request, response) {
    const config = qqOAuthConfig(process.env)
    if (!config.enabled) { redirectQQError(request, response, 'qq_unavailable'); return }
    const state = oauthToken()
    const nonce = oauthToken()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    management.saveOAuthState({ provider: 'qq', state, nonce, redirectUri: config.redirectUri, expiresAt })
    redirect(response, qqAuthorizationUrl(config, { state }), { 'set-cookie': oauthStateCookie(request, state, false, 'miao_qq_state') })
  }

  async function completeQQLogin(request, response, url) {
    const state = String(url.searchParams.get('state') || '').trim()
    const stateCookie = cookieToken(request, 'miao_qq_state')
    if (!state || !stateCookie) { redirectQQError(request, response, 'qq_state_invalid'); return }
    const config = qqOAuthConfig(process.env)
    const stored = config.enabled ? management.consumeOAuthState({ provider: 'qq', state, stateCookie }) : null
    if (!stored || stored.redirectUri !== config.redirectUri) { redirectQQError(request, response, 'qq_state_invalid'); return }
    if (url.searchParams.get('error') || url.searchParams.get('error_code')) { redirectQQError(request, response, 'qq_denied'); return }
    const code = String(url.searchParams.get('code') || '').trim()
    if (!code) { redirectQQError(request, response, 'qq_code_missing'); return }
    try {
      const tokens = await exchangeQQCode(config, code)
      const openId = await fetchQQOpenId(config, tokens.access_token)
      const profile = await fetchQQUserInfo(config, tokens.access_token, openId.openid)
      const identity = validateQQIdentity({ config, openId: openId.openid, profile: { ...profile, unionid: openId.unionid } })
      const session = management.loginQQ({ ...identity, appId: config.appId })
      redirect(response, '/', { 'set-cookie': [sessionCookie(request, session.token), oauthStateCookie(request, '', true, 'miao_qq_state')] })
    } catch (error) {
      redirectQQError(request, response, qqErrorCode(error))
    }
  }

  const EXTRA_OAUTH = {
    github: {
      cookie: 'miao_github_state',
      config: githubOAuthConfig,
      startUrl: githubAuthorizationUrl,
      exchange: (config, code) => exchangeGithubCode(config, code),
      identity: (config, tokens) => fetchGithubIdentity(config, tokens.access_token),
      login: (identity, config) => management.loginGitHub({ ...identity, appId: config.clientId }),
    },
    wechat: {
      cookie: 'miao_wechat_state',
      config: wechatOAuthConfig,
      startUrl: wechatAuthorizationUrl,
      exchange: (config, code) => exchangeWeChatCode(config, code),
      identity: (config, tokens) => fetchWeChatIdentity(config, tokens),
      login: (identity, config) => management.loginWeChat({ ...identity, appId: config.appId }),
    },
    dingtalk: {
      cookie: 'miao_dingtalk_state',
      config: dingTalkOAuthConfig,
      startUrl: dingTalkAuthorizationUrl,
      exchange: (config, code) => exchangeDingTalkCode(config, code),
      identity: (config, tokens) => fetchDingTalkIdentity(config, tokens),
      login: (identity, config) => management.loginDingTalk({ ...identity, appId: config.clientId }),
    },
    linuxdo: {
      cookie: 'miao_linuxdo_state',
      verifierCookie: 'miao_linuxdo_verifier',
      config: linuxDoOAuthConfig,
      startUrl: linuxDoAuthorizationUrl,
      exchange: (config, code, verifier) => exchangeLinuxDoCode(config, code, verifier),
      identity: (config, tokens) => fetchLinuxDoIdentity(config, tokens),
      login: (identity) => management.loginLinuxDo(identity),
    },
    oidc: {
      cookie: 'miao_oidc_state',
      verifierCookie: 'miao_oidc_verifier',
      config: oidcOAuthConfig,
      startUrl: oidcAuthorizationUrl,
      exchange: (config, code, verifier) => exchangeOIDCCode(config, code, verifier),
      identity: (config, tokens, nonceHash) => fetchOIDCIdentity(config, tokens, nonceHash),
      login: (identity) => management.loginOIDC(identity),
    },
  }

  function extraProvider(key) {
    return EXTRA_OAUTH[key]
  }

  function extraCookieNames(provider) {
    return [provider.cookie, provider.verifierCookie].filter(Boolean)
  }

  function clearOAuthCookies(request, provider) {
    return extraCookieNames(provider).map((name) => oauthStateCookie(request, '', true, name))
  }

  function extraErrorCode(providerName, error) {
    if (error instanceof ExtraOAuthError) return error.code
    if (error?.status === 403) return `${providerName}_account_disabled`
    if (error?.status === 409) return `${providerName}_account_conflict`
    return `${providerName}_login_failed`
  }

  function redirectExtraError(request, response, providerName, code) {
    const provider = extraProvider(providerName)
    const location = `/?oauth_error=${encodeURIComponent(code || `${providerName}_login_failed`)}`
    redirect(response, location, { 'set-cookie': clearOAuthCookies(request, provider) })
  }

  function extraStartConfig(providerName, config) {
    return providerName === 'oidc' ? resolveOIDCConfig(config) : Promise.resolve(config)
  }

  async function startExtraLogin(request, response, providerName) {
    const provider = extraProvider(providerName)
    let config = provider.config(process.env)
    if (!config.enabled) { redirectExtraError(request, response, providerName, `${providerName}_unavailable`); return }
    try {
      config = await extraStartConfig(providerName, config)
      const state = oauthToken()
      const nonce = oauthToken()
      let verifier = ''
      let challenge = ''
      if (config.usePKCE) {
        verifier = `${oauthToken()}${oauthToken()}`
        challenge = createHash('sha256').update(verifier).digest('base64url')
      }
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      management.saveOAuthState({ provider: providerName, state, nonce, redirectUri: config.redirectUri, expiresAt })
      const location = providerName === 'oidc'
        ? provider.startUrl(config, { state, nonce, codeChallenge: challenge })
        : provider.startUrl(config, { state, codeChallenge: challenge })
      const cookies = [oauthStateCookie(request, state, false, provider.cookie)]
      if (provider.verifierCookie) cookies.push(oauthStateCookie(request, verifier, false, provider.verifierCookie))
      redirect(response, location, { 'set-cookie': cookies })
    } catch (error) {
      redirectExtraError(request, response, providerName, extraErrorCode(providerName, error))
    }
  }

  async function completeExtraLogin(request, response, url, providerName) {
    const provider = extraProvider(providerName)
    const state = String(url.searchParams.get('state') || '').trim()
    const stateCookie = cookieToken(request, provider.cookie)
    if (!state || !stateCookie) { redirectExtraError(request, response, providerName, `${providerName}_state_invalid`); return }
    let config = provider.config(process.env)
    try {
      config = await extraStartConfig(providerName, config)
      const stored = config.enabled ? management.consumeOAuthState({ provider: providerName, state, stateCookie }) : null
      if (!stored || stored.redirectUri !== config.redirectUri) { redirectExtraError(request, response, providerName, `${providerName}_state_invalid`); return }
      if (url.searchParams.get('error') || url.searchParams.get('error_code')) { redirectExtraError(request, response, providerName, `${providerName}_denied`); return }
      const code = String(url.searchParams.get('code') || '').trim()
      if (!code) { redirectExtraError(request, response, providerName, `${providerName}_code_missing`); return }
      const verifier = provider.verifierCookie ? cookieToken(request, provider.verifierCookie) : ''
      if (config.usePKCE && !verifier) { redirectExtraError(request, response, providerName, `${providerName}_state_invalid`); return }
      const tokens = await provider.exchange(config, code, verifier)
      const identity = await provider.identity(config, tokens, stored.nonceHash)
      const session = provider.login(identity, config)
      redirect(response, '/', { 'set-cookie': [sessionCookie(request, session.token), ...clearOAuthCookies(request, provider)] })
    } catch (error) {
      redirectExtraError(request, response, providerName, extraErrorCode(providerName, error))
    }
  }

  return {
    async handle(request, response, url: URL) {
      if (url.pathname === '/api/imagine/oauth/google/start' && request.method === 'GET') {
        startGoogleLogin(request, response)
        return true
      }
      if (url.pathname === '/api/imagine/oauth/google/callback' && request.method === 'GET') {
        await completeGoogleLogin(request, response, url)
        return true
      }
      if (url.pathname === '/api/imagine/oauth/qq/start' && request.method === 'GET') {
        startQQLogin(request, response)
        return true
      }
      if (url.pathname === '/api/imagine/oauth/qq/callback' && request.method === 'GET') {
        await completeQQLogin(request, response, url)
        return true
      }
      for (const providerName of Object.keys(EXTRA_OAUTH)) {
        if (url.pathname === `/api/imagine/oauth/${providerName}/start` && request.method === 'GET') {
          await startExtraLogin(request, response, providerName)
          return true
        }
        if (url.pathname === `/api/imagine/oauth/${providerName}/callback` && request.method === 'GET') {
          await completeExtraLogin(request, response, url, providerName)
          return true
        }
      }
      return false
    },
  }
}
