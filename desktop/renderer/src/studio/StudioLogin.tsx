import { useEffect, useRef, useState } from 'react'
import { useLang } from '../i18n'
import { landingEntry } from '../siteOrigins'
import { thumbnailSources } from '../media'
import { reloadWorkspace } from '../desktop/navigation'
import type { OAuthEntry, StudioSession } from './studioState'

type LoginMode = 'otp'
type StudioLoginProps = {
  onSuccess(session: StudioSession, mode: LoginMode): void | Promise<void>;
  registrationEnabled?: boolean;
  googleLogin?: OAuthEntry | null;
  qqLogin?: OAuthEntry | null;
  githubLogin?: OAuthEntry | null;
  wechatLogin?: OAuthEntry | null;
  dingtalkLogin?: OAuthEntry | null;
  linuxdoLogin?: OAuthEntry | null;
  oidcLogin?: OAuthEntry | null;
}

const GOOGLE_ERROR_KEYS = {
  google_denied: 'studio.google.denied',
  google_unavailable: 'studio.google.unavailable',
  google_state_invalid: 'studio.google.state',
  google_code_missing: 'studio.google.failed',
  google_email_unverified: 'studio.google.email',
  google_account_disabled: 'studio.google.account',
  google_account_conflict: 'studio.google.account',
}
const QQ_ERROR_KEYS = {
  qq_denied: 'studio.qq.denied',
  qq_unavailable: 'studio.qq.unavailable',
  qq_state_invalid: 'studio.qq.state',
  qq_code_missing: 'studio.qq.failed',
  qq_account_disabled: 'studio.qq.account',
  qq_account_conflict: 'studio.qq.account',
}
const EXTRA_ERROR_KEYS = {
  github_denied: 'studio.github.denied',
  github_unavailable: 'studio.github.unavailable',
  github_state_invalid: 'studio.github.state',
  github_code_missing: 'studio.github.failed',
  github_email_unverified: 'studio.github.email',
  github_account_disabled: 'studio.github.account',
  github_account_conflict: 'studio.github.account',
  github_exchange_failed: 'studio.github.failed',
  github_profile_failed: 'studio.github.failed',
  github_email_failed: 'studio.github.email',
  wechat_denied: 'studio.wechat.denied',
  wechat_unavailable: 'studio.wechat.unavailable',
  wechat_state_invalid: 'studio.wechat.state',
  wechat_code_missing: 'studio.wechat.failed',
  wechat_account_disabled: 'studio.wechat.account',
  wechat_account_conflict: 'studio.wechat.account',
  dingtalk_denied: 'studio.dingtalk.denied',
  dingtalk_unavailable: 'studio.dingtalk.unavailable',
  dingtalk_state_invalid: 'studio.dingtalk.state',
  dingtalk_code_missing: 'studio.dingtalk.failed',
  dingtalk_account_disabled: 'studio.dingtalk.account',
  dingtalk_account_conflict: 'studio.dingtalk.account',
  linuxdo_denied: 'studio.linuxdo.denied',
  linuxdo_unavailable: 'studio.linuxdo.unavailable',
  linuxdo_state_invalid: 'studio.linuxdo.state',
  linuxdo_code_missing: 'studio.linuxdo.failed',
  linuxdo_account_disabled: 'studio.linuxdo.account',
  linuxdo_account_conflict: 'studio.linuxdo.account',
  oidc_denied: 'studio.oidc.denied',
  oidc_unavailable: 'studio.oidc.unavailable',
  oidc_state_invalid: 'studio.oidc.state',
  oidc_code_missing: 'studio.oidc.failed',
  oidc_email_unverified: 'studio.oidc.email',
  oidc_account_disabled: 'studio.oidc.account',
  oidc_account_conflict: 'studio.oidc.account',
}

export default function StudioLogin({ onSuccess, registrationEnabled = true, googleLogin = null, qqLogin = null, githubLogin = null, wechatLogin = null, dingtalkLogin = null, linuxdoLogin = null, oidcLogin = null }: StudioLoginProps) {
  const { lang, t } = useLang()
  const oidcProviderName = oidcLogin?.providerName || 'OIDC'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codeSent, setCodeSent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [inspirationImages, setInspirationImages] = useState([])
  const reloadTimer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; window.clearTimeout(reloadTimer.current) }
  }, [])

  useEffect(() => {
    if (!cooldown) return undefined
    const timer = window.setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  useEffect(() => {
    const controller = new AbortController()
    fetch('./api/prompts?limit=24&offset=0&sort=newest', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('inspiration unavailable')))
      .then((data) => {
        const seen = new Set()
        const images = (data.items || []).flatMap((item) => (item.images || []).flatMap((image) => thumbnailSources(image).slice(0, 1)))
          .filter((src) => {
            if (!src || seen.has(src)) return false
            seen.add(src)
            return true
          })
          .slice(0, 24)
        setInspirationImages(images)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('oauth_error')
    if (!code) return
    setError(t(GOOGLE_ERROR_KEYS[code] || QQ_ERROR_KEYS[code] || EXTRA_ERROR_KEYS[code] || 'studio.login.failed', { provider: oidcProviderName }))
    params.delete('oauth_error')
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`
    window.history.replaceState({}, '', next)
  }, [oidcProviderName, t])

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const path = './api/imagine/email/verify-code'
      const body = { email, password, code, ...(name.trim() ? { name: name.trim() } : {}) }
      // 首个请求偶发挂起（网关长连接/网络抖动）会导致界面一直“处理中”；
      // 每次请求 8 秒超时，失败自动再试一次，仍然失败就回到可重试的错误态。
      const request = async () => {
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), 8000)
        try {
          return await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
        } finally {
          window.clearTimeout(timer)
        }
      }
      let response
      try {
        response = await request()
      } catch {
        response = await request()
      }
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('studio.login.failed'))
      if (!mounted.current) return
      await onSuccess(data.session, 'otp')
      if (!mounted.current) return
      try { window.sessionStorage.removeItem('miao-login-retry-at') } catch { /* 忽略隐私模式下的存储异常 */ }
      // 兜底：会话 Cookie 已经下发，如果旧页面状态没有完成切换（旧缓存/竞态），自动重载一次进入工作台。
      window.clearTimeout(reloadTimer.current)
      if (mounted.current) reloadTimer.current = window.setTimeout(() => {
        if (mounted.current && document.querySelector('.studio-login')) void reloadWorkspace().catch(failure => setError(failure.message))
      }, 1500)
    } catch (failure) {
      if (!mounted.current) return
      // 请求超时/被中断时服务端可能已经下发会话 Cookie；自动重载验证一次，避免一直停在“处理中”。
      if ((failure as { name?: string })?.name === 'AbortError') {
        const key = 'miao-login-retry-at'
        let last = 0
        try { last = Number(window.sessionStorage.getItem(key) || 0) } catch { last = 0 }
        if (Date.now() - last > 60_000) {
          try { window.sessionStorage.setItem(key, String(Date.now())) } catch { /* 忽略 */ }
          void reloadWorkspace().catch(error => setError(error.message))
          return
        }
      }
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  async function requestCode() {
    if (!email.trim() || cooldown > 0 || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('./api/imagine/email/request-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || t('studio.login.failed'))
      setCodeSent(true)
      setCooldown(Number(data.cooldown) || 60)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy(false)
    }
  }

  const incomplete = !email.trim() || password.length < 8 || !codeSent || !/^\d{6}$/.test(code.trim())

  return (
    <div className="studio-login">
      <div className="grain-overlay" aria-hidden="true" />
      {inspirationImages.length > 0 && <aside className="studio-login__gallery" aria-hidden="true">
        {[0, 1, 2].map((column) => {
          const images = inspirationImages.filter((_, index) => index % 3 === column)
          // 三份拷贝配合 keyframes 里 -1/3 的位移，循环处不会跳；每列 8 张、去重后共 24 张
          const track = [...images, ...images, ...images]
          return <div className={`studio-login__gallery-column studio-login__gallery-column--${column + 1}`} key={column}><div className="studio-login__gallery-track">{track.map((src, index) => <img src={src} alt="" loading="lazy" key={`${src}-${index}`} />)}</div></div>
        })}
      </aside>}
      <main>
        <a className="studio-login__brand" href={landingEntry()}>
          <img src="/miaoimg-logo.png" alt="" width="36" height="36" />
          <span>妙图</span>
        </a>
        <h1>{t('studio.login')}</h1>
        <p>{registrationEnabled ? t('studio.login.codePassword') : t('studio.login.codePassword.existing')}</p>
        <form onSubmit={submit}>
          <input
            aria-label={t('studio.email')}
            type="email"
            autoComplete="email"
            placeholder={t('studio.email.placeholder')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            aria-label={t('studio.password')}
            type="password"
            autoComplete="current-password"
            placeholder={t('studio.password.placeholder')}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="studio-login__otp-row">
            <input
              aria-label={t('studio.login.otp.code')}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder={t('studio.login.otp.code.placeholder')}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
            <button type="button" onClick={requestCode} disabled={!email.trim() || busy || cooldown > 0}>
              {cooldown > 0 ? `${cooldown}s` : t('studio.login.otp.send')}
            </button>
          </div>
          {registrationEnabled && (
            <input
              aria-label={t('studio.name')}
              type="text"
              autoComplete="nickname"
              placeholder={t('studio.name.placeholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
          <button className="studio-login__submit" type="submit" disabled={busy || incomplete}>
            {busy ? t('studio.processing') : t('studio.login.submit')}
          </button>
        </form>
        {(googleLogin?.enabled || qqLogin?.enabled || githubLogin?.enabled || wechatLogin?.enabled || dingtalkLogin?.enabled || linuxdoLogin?.enabled || oidcLogin?.enabled) && <>
          <div className="studio-login__divider"><span>{t('studio.google.divider')}</span></div>
          {googleLogin?.enabled && <a className="studio-login__google" href="./api/imagine/oauth/google/start">{t('studio.google.submit')}</a>}
          {qqLogin?.enabled && <a className="studio-login__qq" href="./api/imagine/oauth/qq/start">{t('studio.qq.submit')}</a>}
          {githubLogin?.enabled && <a className="studio-login__github" href="./api/imagine/oauth/github/start">{t('studio.github.submit')}</a>}
          {wechatLogin?.enabled && <a className="studio-login__wechat" href="./api/imagine/oauth/wechat/start">{t('studio.wechat.submit')}</a>}
          {dingtalkLogin?.enabled && <a className="studio-login__dingtalk" href="./api/imagine/oauth/dingtalk/start">{t('studio.dingtalk.submit')}</a>}
          {linuxdoLogin?.enabled && <a className="studio-login__linuxdo" href="./api/imagine/oauth/linuxdo/start">{t('studio.linuxdo.submit')}</a>}
          {oidcLogin?.enabled && <a className="studio-login__oidc" href="./api/imagine/oauth/oidc/start">{lang === 'zh' ? `使用${oidcProviderName}登录` : t('studio.oidc.submit', { provider: oidcProviderName })}</a>}
        </>}
        {error && <p role="alert">{error}</p>}
        <nav className="studio-login__links" aria-label={t('studio.leave')}>
          <a href="/?landing=1">{t('studio.home')}</a>
          <a href="/?library=1">{t('studio.library')}</a>
        </nav>
      </main>
    </div>
  )
}
