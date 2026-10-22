import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSessionViewReceipt } from './useSessionViewReceipt'
import { ArrowRight, EnvelopeSimple, Eye, EyeSlash, LockKey, SignOut, SpinnerGap, X } from '@phosphor-icons/react'
import './desktop.css'
declare global { interface Window { miaoDesktop?: { platform: string; getDocumentEpoch?(): Promise<string>; getSessionTransition?(): string | undefined; completeSessionChange?(id: string): Promise<boolean>; flushSave?(): Promise<void>; reload?(): Promise<void>; registerSaveHandler?(callback: () => Promise<void>): () => void; readClipboardText(): Promise<string>; writeClipboardText(text: string): Promise<void>; readClipboardMedia(): Promise<{ name: string; type: string; data: string }[]>; openComputerPermissions(): Promise<void>; computerStatus(): Promise<{ enabled: boolean; directory: string; error?: string }>; enableComputer(): Promise<{ enabled: boolean; directory: string; error?: string }>; disableComputer(): Promise<{ enabled: boolean; directory: string; error?: string }>; chooseComputerDirectory(): Promise<{ enabled: boolean; directory: string; error?: string }>; minimize(): Promise<void>; maximize(): Promise<void>; close(): Promise<void>; openData(): Promise<void> } } }

export default function DesktopBar({ children }: { children: ReactNode }) {
  const [state, setState] = useState<any>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const statusEpoch = useRef(0)
  const [registrationEnabled, setRegistrationEnabled] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [showPassword, setShowPassword] = useState(false)
  const [code, setCode] = useState(''), [codeSent, setCodeSent] = useState(false), [cooldown, setCooldown] = useState(0), [sending, setSending] = useState(false)
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
      if (!response.ok) throw new Error('账号信息暂不可用，请稍后重试')
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
      if (!response.ok) throw new Error(result.error || '操作失败，请重试')
      const epoch = statusReadEpoch = ++statusEpoch.current
      const sessionTransition = native.getSessionTransition?.()
      const next = await fetch('/api/desktop/status', { cache: 'no-store' })
      if (!next.ok) throw new Error('账号状态读取失败，请重试')
      const value = await next.json()
      if (epoch === statusEpoch.current) setState({ ...value, sessionTransition })
      setOpen(false); setRefresh(value => value + 1)
      return true
    } catch (e) {
      if (statusReadEpoch === undefined || statusReadEpoch === statusEpoch.current) setError(e instanceof Error ? e.message : '操作失败，请重试')
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
      if (!response.ok) throw new Error(result.error || '验证码发送失败，请稍后重试')
      setCodeSent(true); setCooldown(Number(result.cooldown) || 60)
    } catch (e) { setError(e instanceof Error ? e.message : '验证码发送失败，请稍后重试') }
    finally { setSending(false) }
  }
  const codeIncomplete = !codeSent || !/^\d{6}$/.test(code.trim()) || password.length < 8
  return <>
    <div key={account?.id || account?.workspaceKey || 'local'}>{children}</div>
    {native.platform !== 'darwin' && <div className="desktop-window-buttons"><button aria-label="最小化" onClick={() => native.minimize()}>−</button><button aria-label="最大化" onClick={() => native.maximize()}>□</button><button aria-label="关闭" onClick={() => native.close()}>×</button></div>}
    {open && <div className="desktop-account-mask" onClick={event => { if (event.target === event.currentTarget) close() }}>
      <section ref={panel} className="desktop-account-panel" role="dialog" aria-modal="true" aria-labelledby="desktop-account-title" aria-describedby="desktop-account-description" tabIndex={-1} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); close() }
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || [])
        const first = controls[0], last = controls.at(-1)
        if (!first || !last) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus() }
      }}>
        <button className="desktop-account-close" type="button" aria-label="关闭账号窗口" disabled={busy} onClick={close}><X size={20} /></button>
        <div className="desktop-account-brand"><img src="/miaoimg-logo.png" alt="" /><span>妙图</span></div>
        <h2 id="desktop-account-title">{account ? '账号' : '登录妙图'}</h2>
        <p id="desktop-account-description" className="desktop-account-description">{account ? '账号与积分。画布和素材保存在这台电脑。' : registrationEnabled ? '验证码和密码登录，新邮箱会创建账号。' : '验证码和密码登录。'}</p>
        {loading ? <div className="desktop-account-loading" role="status"><SpinnerGap size={22} className="desktop-account-spinner" />正在读取账号…</div> : (!state || state.statusUnavailable) ? <>
          <p role="alert" className="desktop-account-error">{error || '暂时无法读取账号，请重试'}</p>
          <button className="desktop-account-submit" onClick={() => setRefresh(value => value + 1)}>重试</button>
        </> : !account ? <>
          <form id="desktop-account-form" noValidate onSubmit={async event => {
            event.preventDefault(); if (busy || sending) return
            if (!event.currentTarget.checkValidity() || password.length < 8 || !/^\d{6}$/.test(code.trim())) { setError(password.length < 8 ? '请设置至少 8 位密码' : '请填写邮箱、密码和 6 位验证码'); event.currentTarget.querySelector<HTMLElement>(':invalid')?.focus(); return }
            const ok = await action('/api/imagine/email/verify-code', { email: email.trim(), code: code.trim(), password, ...(name.trim() ? { name: name.trim() } : {}) })
            setPassword(''); setCode('')
            if (ok) { setOpen(false); window.dispatchEvent(new Event('miao-desktop-session')) }
          }}>
            <label className="desktop-account-field"><span>邮箱</span><div className="desktop-account-input"><EnvelopeSimple size={18} aria-hidden="true" /><input id="desktop-account-email" name="miao-account-email" type="email" autoComplete="off" value={email} onChange={e => { setEmail(e.target.value); setError('') }} placeholder="输入邮箱地址" required disabled={busy} /></div></label>
            <div className="desktop-account-field"><label htmlFor="desktop-account-password">密码</label><div className="desktop-account-input"><LockKey size={18} aria-hidden="true" /><input id="desktop-account-password" name="miao-account-password" type={showPassword ? 'text' : 'password'} autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setError('') }} placeholder="至少 8 位" required minLength={8} maxLength={128} disabled={busy} /><button type="button" className="desktop-account-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} disabled={busy} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeSlash size={19} /> : <Eye size={19} />}</button></div></div>
            <div className="desktop-account-field"><label htmlFor="desktop-account-code">验证码</label><div className="desktop-account-input"><input id="desktop-account-code" name="miao-account-code" inputMode="numeric" autoComplete="off" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }} placeholder="6 位验证码" required disabled={busy} /><button type="button" className="desktop-account-send" disabled={!email.trim() || busy || sending || cooldown > 0} onClick={requestCode}>{cooldown > 0 ? `${cooldown}s` : sending ? '发送中…' : '获取验证码'}</button></div></div>
            {registrationEnabled && <label className="desktop-account-field"><span>昵称<span>选填，新账号使用</span></span><div className="desktop-account-input"><input name="miao-account-name" autoComplete="off" value={name} maxLength={60} onChange={e => { setName(e.target.value); setError('') }} placeholder="在妙图中显示的名字" disabled={busy} /></div></label>}
            {error && <p role="alert" className="desktop-account-error">{error}</p>}
            <button className="desktop-account-submit" disabled={busy || sending || codeIncomplete}>{busy ? <><SpinnerGap size={18} className="desktop-account-spinner" />处理中…</> : <>进入妙图<ArrowRight size={18} /></>}</button>
          </form>
        </> : <>
          <div className="desktop-account-profile"><div className="desktop-account-avatar">{Array.from(String(account.name || account.email || '妙'))[0]}</div><div><strong>{account.name || '妙图用户'}</strong><p>{account.email}</p></div></div>
          <div className="desktop-account-balance"><span>可用积分</span><strong>{Number(account.points || 0).toLocaleString('zh-CN')}<small>积分</small></strong></div>
          {error && <p role="alert" className="desktop-account-error">{error}</p>}
          <button className="desktop-account-submit" type="button" disabled={busy} onClick={() => { close(); window.dispatchEvent(new Event('miao-open-account-surface')) }}>充值与积分明细<ArrowRight size={18} /></button>
          <button className="desktop-account-signout" disabled={busy} onClick={async () => { if (await action('/api/desktop/logout', {})) { setPassword(''); setCode(''); setError(''); window.dispatchEvent(new Event('miao-desktop-session')) } }}><SignOut size={18} />{busy ? '处理中…' : '退出登录'}</button>
        </>}
      </section>
    </div>}
  </>
}
