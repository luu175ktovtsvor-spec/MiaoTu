import FeedbackNotice from '../components/FeedbackNotice'
import { useLang } from '../i18n'
import { isChineseLang } from '../shellLanguage'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSessionViewReceipt } from './useSessionViewReceipt'
import { ArrowRight, EnvelopeSimple, Eye, EyeSlash, LockKey, SignOut, SpinnerGap, X } from '@phosphor-icons/react'
import './desktop.css'

// 登录弹窗左侧轮播的精选作品（来自首页案例库，素材经本机转发）。
const LOGIN_SHOWCASE = [
  { poster: '/showcase/20261014-expanded/extra-c27c28c33e87.webp', video: '/showcase/20261014-expanded/extra-c27c28c33e87.mp4' },
  { poster: '/showcase/20261014-expanded/extra-9b7e2d16b997.webp', video: '/showcase/20261014-expanded/extra-9b7e2d16b997.mp4' },
]
declare global { interface Window { miaoDesktop?: { platform: string; getDocumentEpoch?(): Promise<string>; getSessionTransition?(): string | undefined; completeSessionChange?(id: string): Promise<boolean>; flushSave?(): Promise<void>; reload?(): Promise<void>; registerSaveHandler?(callback: () => Promise<void>): () => void; readClipboardText(): Promise<string>; writeClipboardText(text: string): Promise<void>; readClipboardMedia(): Promise<{ name: string; type: string; data: string }[]>; openComputerPermissions(): Promise<void>; computerStatus(): Promise<{ enabled: boolean; directory: string; error?: string }>; enableComputer(): Promise<{ enabled: boolean; directory: string; error?: string }>; disableComputer(): Promise<{ enabled: boolean; directory: string; error?: string }>; chooseComputerDirectory(): Promise<{ enabled: boolean; directory: string; error?: string }>; minimize(): Promise<void>; maximize(): Promise<void>; close(): Promise<void>; openData(): Promise<void> } } }

export default function DesktopBar({ children }: { children: ReactNode }) {
  const { t, lang, locale } = useLang()
  const [state, setState] = useState<any>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const statusEpoch = useRef(0)
  const [registrationEnabled, setRegistrationEnabled] = useState(false)
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false), [cooldown, setCooldown] = useState(0), [sending, setSending] = useState(false)
  const [mode, setMode] = useState<'code' | 'password' | 'reset'>('code')
  const [showcase] = useState(() => LOGIN_SHOWCASE[Math.floor(Math.random() * LOGIN_SHOWCASE.length)])
  const panel = useRef<HTMLElement>(null)
  const native = window.miaoDesktop
  const account = state?.cloud?.account
  const close = () => { if (!busy) { setOpen(false); setPassword(''); setCode(''); setShowPassword(false) } }
  // Acknowledge only the status read initiated for this transition, after React
  // has actually committed its login gate/new workspace and retired the editor.
  useSessionViewReceipt(state?.sessionTransition)
  useEffect(() => {
    if (!native) return
    document.documentElement.classList.add('miao-desktop', 'miao-desktop-' + native.platform)
    const show = () => { setOpen(true); setError('') }
    const restored = () => { ++statusEpoch.current; setRefresh(value => value + 1) }
    window.addEventListener('miao-desktop-account', show)
    window.addEventListener('miao-desktop-session', restored)
    window.addEventListener('online', restored)
    return () => { window.removeEventListener('miao-desktop-account', show); window.removeEventListener('miao-desktop-session', restored); window.removeEventListener('online', restored); document.documentElement.classList.remove('miao-desktop', 'miao-desktop-' + native.platform) }
  }, [])
  useEffect(() => {
    if (!native) return
    const controller = new AbortController()
    fetch('/api/imagine/config', { signal: controller.signal }).then(response => response.ok ? response.json() : null)
      .then(value => { if (!controller.signal.aborted) setRegistrationEnabled(Boolean(value?.registrationEnabled)) }).catch(() => {})
    return () => controller.abort()
  }, [open])
  useEffect(() => { if (!cooldown) return undefined; const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer) }, [cooldown])
  useEffect(() => {
    if (!native) return
    const controller = new AbortController()
    const epoch = ++statusEpoch.current
    const sessionTransition = native.getSessionTransition?.()
    if (!state || state.statusUnavailable) setLoading(true)
    fetch('/api/desktop/status', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('desktop.account.unavailable'))
      const value = await response.json()
      if (!controller.signal.aborted && epoch === statusEpoch.current) setState({ ...value, sessionTransition })
    }).catch(e => {
      if (controller.signal.aborted || epoch !== statusEpoch.current) return
      // The old editor already saved before this native transition. If the
      // local status read fails, retire it into the existing retry view before
      // acknowledging; otherwise disabled input could make retry impossible.
      if (sessionTransition) setState({ statusUnavailable: true, sessionTransition })
      setError(e.message)
    })
      .finally(() => { if (!controller.signal.aborted && epoch === statusEpoch.current) setLoading(false) })
    return () => controller.abort()
  }, [open, refresh])
  useEffect(() => { if (!native || !account) return; const timer = window.setInterval(() => setRefresh(value => value + 1), 30000); return () => window.clearInterval(timer); }, [Boolean(account)]);
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => panel.current?.focus())
    return () => { cancelAnimationFrame(frame); previous?.focus() }
  }, [open])
  if (!native) return <>{children}</>
  async function action(path: string, body: any) {
    setBusy(true); setError('')
    let statusReadEpoch: number | undefined
    try {
      if (path === '/api/desktop/logout') await native.flushSave?.()
      const { session } = await (await fetch('/api/imagine/session')).json()
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('desktop.action.failed'))
      const epoch = statusReadEpoch = ++statusEpoch.current
      const sessionTransition = native.getSessionTransition?.()
      const next = await fetch('/api/desktop/status', { cache: 'no-store' })
      if (!next.ok) throw new Error(t('desktop.account.statusFailed'))
      const value = await next.json()
      if (epoch === statusEpoch.current) setState({ ...value, sessionTransition })
      setOpen(false); setRefresh(value => value + 1)
      return true
    } catch (e) {
      if (statusReadEpoch === undefined || statusReadEpoch === statusEpoch.current) setError(e instanceof Error ? e.message : t('desktop.action.failed'))
      return false
    }
    finally { setBusy(false) }
  }
  async function requestCode() {
    if (!email.trim() || cooldown > 0 || busy || sending) return
    setSending(true); setError('')
    try {
      const response = await fetch('/api/imagine/email/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email.trim() }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('desktop.email.codeFailed'))
      setCodeSent(true); setCooldown(Number(result.cooldown) || 60)
    } catch (e) { setError(e instanceof Error ? e.message : t('desktop.email.codeFailed')) }
    finally { setSending(false) }
  }
  // 验证码登录（新邮箱自动注册）和密码登录二选一；忘记密码时用验证码重设。
  const submitReady = Boolean(email.trim()) && (mode === 'password' ? password.length >= 8 : /^\d{6}$/.test(code.trim()) && (mode === 'code' || password.length >= 8))
  function switchMode(next: 'code' | 'password' | 'reset') { setMode(next); setError(''); setPassword(''); setShowPassword(false) }
  const loginView = !loading && Boolean(state) && !state.statusUnavailable && !account
  return <>
    <div key={account?.id || account?.workspaceKey || 'local'}>{children}</div>
    {native.platform !== 'darwin' && <div className="desktop-window-buttons"><button aria-label={t('desktop.window.minimize')} onClick={() => native.minimize()}>−</button><button aria-label={t('desktop.window.maximize')} onClick={() => native.maximize()}>□</button><button aria-label={t('desktop.window.close')} onClick={() => native.close()}>×</button></div>}
    {open && <div className={'desktop-account-mask' + (loginView ? ' is-login' : '')} onClick={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={panel} className={'desktop-account-panel' + (loginView ? ' is-login' : '')} role="dialog" aria-modal="true" aria-labelledby="desktop-account-title" aria-describedby={loginView || !account ? 'desktop-account-description' : undefined} tabIndex={-1} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])
        const first = controls[0], last = controls.at(-1)
        if (!first || !last) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus() }
      }}>
        <button className="desktop-account-close" type="button" aria-label={t('desktop.account.close')} disabled={busy} onClick={close}><X size={20} /></button>
        {loginView ? <>
          <div className="desktop-login-showcase" aria-hidden="true">
            <video src={showcase.video} poster={showcase.poster} autoPlay muted loop playsInline preload="auto" />
            <div><strong>{t('desktop.showcase.title')}</strong><span>{t('desktop.showcase.description')}</span></div>
          </div>
          <div className="desktop-login-body">
            <div className="desktop-login-head">
              <div className="desktop-account-brand"><img src="/miaoimg-logo.png" alt="" /><span>{t('app.title')}</span></div>
              <h2 id="desktop-account-title">{mode === 'reset' ? t('desktop.login.resetTitle') : mode === 'password' ? t('desktop.login.passwordTitle') : t('desktop.login.emailTitle')}</h2>
              <p id="desktop-account-description" className="desktop-account-description">{mode === 'reset' ? t('desktop.login.resetDescription') : mode === 'password' ? t('desktop.login.passwordDescription') : t('desktop.login.emailDescription')}</p>
            </div>
            <form id="desktop-account-form" noValidate onSubmit={async event => {
              event.preventDefault(); if (busy || sending) return
              const problem = !email.trim() || !event.currentTarget.checkValidity() ? t('desktop.validation.email')
                : mode !== 'password' && !/^\d{6}$/.test(code.trim()) ? t('desktop.validation.code')
                : mode !== 'code' && password.length < 8 ? (mode === 'reset' ? t('desktop.validation.newPassword') : t('desktop.validation.password')) : ''
              if (problem) { setError(problem); return }
              const ok = mode === 'code' ? await action('/api/imagine/email/verify-code', { email: email.trim(), code: code.trim() })
                : mode === 'password' ? await action('/api/desktop/login', { email: email.trim(), password })
                : await action('/api/imagine/password/reset', { email: email.trim(), code: code.trim(), password })
              setPassword(''); setCode('')
              if (ok) { setOpen(false); setMode('code'); window.dispatchEvent(new Event('miao-desktop-session')) }
            }}>
              <div className="desktop-account-input"><input id="desktop-account-email" name="miao-account-email" type="email" autoComplete="off" aria-label={t('studio.email')} value={email} onChange={e => { setEmail(e.target.value); setError('') }} placeholder={t('desktop.email.placeholder')} required disabled={busy} /></div>
              {mode !== 'password' && <div className="desktop-account-input"><input id="desktop-account-code" name="miao-account-code" inputMode="numeric" autoComplete="off" aria-label={t('studio.login.otp.code')} pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }} placeholder={t('desktop.code.placeholder')} required disabled={busy} /><button type="button" className="desktop-account-send" disabled={!email.trim() || busy || sending || cooldown > 0} onClick={requestCode}>{cooldown > 0 ? t('desktop.email.cooldown', { n: cooldown }) : sending ? t('studio.processing') : codeSent ? t('desktop.email.resend') : t('studio.login.otp.send')}</button></div>}
              {mode !== 'code' && <div className="desktop-account-input"><input id="desktop-account-password" name="miao-account-password" type={showPassword ? 'text' : 'password'} autoComplete="off" aria-label={mode === 'reset' ? t('studio.password') : t('studio.password')} value={password} onChange={e => { setPassword(e.target.value); setError('') }} placeholder={mode === 'reset' ? t('desktop.password.newPlaceholder') : t('desktop.password.placeholder')} required minLength={8} maxLength={128} disabled={busy} /><button type="button" className="desktop-account-password-toggle" aria-label={showPassword ? t('desktop.password.hide') : t('desktop.password.show')} aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeSlash size={19} /> : <Eye size={19} />}</button></div>}
              {mode === 'password' && <button type="button" className="desktop-account-link desktop-account-forgot" disabled={busy} onClick={() => switchMode('reset')}>{t('desktop.password.forgot')}</button>}
              {error && <FeedbackNotice message={error} onClose={() => setError('')} />}
              <button className="desktop-account-submit" disabled={busy || sending || !submitReady}>{busy ? <><SpinnerGap size={18} className="desktop-account-spinner" />{t('studio.processing')}</> : mode === 'reset' ? t('desktop.submit.reset') : registrationEnabled && mode === 'code' ? t('desktop.submit.register') : t('studio.login.submit')}</button>
              {mode === 'code' && registrationEnabled && <p className="desktop-login-note">{t('desktop.email.unregistered')}</p>}
            </form>
            <div className="desktop-login-methods" role="group" aria-label={t('desktop.login.methods')}>
              <button type="button" aria-pressed={mode === 'code'} disabled={busy} onClick={() => switchMode('code')}><EnvelopeSimple size={22} />{t('desktop.login.codeMethod')}</button>
              <button type="button" aria-pressed={mode !== 'code'} disabled={busy} onClick={() => switchMode('password')}><LockKey size={22} />{t('desktop.login.passwordMethod')}</button>
            </div>
          </div>
        </> : <>
        <div className="desktop-account-brand"><img src="/miaoimg-logo.png" alt="" /><span>{t('app.title')}</span></div>
        <h2 id="desktop-account-title">{t('desktop.account.title')}</h2>
        {!account && <p id="desktop-account-description" className="desktop-account-description">{t('desktop.account.reading')}</p>}
        {loading ? <div className="desktop-account-loading" role="status"><SpinnerGap size={22} className="desktop-account-spinner" />{t('desktop.account.reading')}</div> : (!state || state.statusUnavailable) ? <>
          <FeedbackNotice message={error || t('desktop.account.readFailed')} action={t('desktop.retry')} onAction={() => setRefresh(value => value + 1)} />
          <button className="desktop-account-submit" onClick={() => setRefresh(value => value + 1)}>{t('desktop.retry')}</button>
        </> : <>
          <div className="desktop-account-profile"><div className="desktop-account-avatar">{Array.from(String(account.name || account.email || (isChineseLang(lang) ? '妙' : 'M')))[0]}</div><div><strong>{account.name || t('desktop.account.user')}</strong><p>{account.email}</p></div></div>
          <div className="desktop-account-balance"><span>{t('desktop.account.availableCredits')}</span><strong>{Number(account.points || 0).toLocaleString(locale)}<small>{t('desktop.account.credits')}</small></strong></div>
          {error && <FeedbackNotice message={error} onClose={() => setError('')} />}
          <button className="desktop-account-submit" type="button" disabled={busy} onClick={() => { close(); window.dispatchEvent(new Event('miao-open-billing-surface')) }}>{t('desktop.account.creditsDetails')}<ArrowRight size={18} /></button>
          <button className="desktop-account-settings" type="button" disabled={busy} onClick={() => { close(); window.dispatchEvent(new Event('miao-open-account-surface')) }}>{t('desktop.nav.account')}<ArrowRight size={16} /></button>
          <button className="desktop-account-signout" disabled={busy} onClick={async () => { if (await action('/api/desktop/logout', {})) { setPassword(''); setCode(''); setError(''); window.dispatchEvent(new Event('miao-desktop-session')) } }}><SignOut size={18} />{busy ? t('desktop.account.signingOut') : t('desktop.account.signOut')}</button>
        </>}
        </>}
      </section>
    </div>}
  </>
}
