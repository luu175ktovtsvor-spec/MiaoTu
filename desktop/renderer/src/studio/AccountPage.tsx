import { CaretDown, ShieldCheck, SignOut, UserCircle } from '@phosphor-icons/react'
import { studioText } from './studioText'
import type { SessionUser } from './studioState'

type PasswordForm = { currentPassword: string; newPassword: string }
type Props = {
  lang: string; user?: SessionUser | null; name: string; onName(value: string): void
  profileBusy: boolean; passwordBusy: boolean; logoutBusy: boolean; hasPassword: boolean
  password: PasswordForm; onPassword(field: keyof PasswordForm, value: string): void
  onSave(): void; onChangePassword(): void; onLogout(): void
}

export default function AccountPage(props: Props) {
  const { lang, user, name, password, hasPassword } = props
  const L = (text: string) => studioText(text, lang)
  const locked = props.profileBusy || props.passwordBusy || props.logoutBusy
  return <main className="studio-record account-page" aria-labelledby="account-page-title">
    <header className="account-heading">
      <div><h1 id="account-page-title">{L('账号')}</h1><p>{L('个人资料')} <span aria-hidden="true">/</span> {L('账号安全')}</p></div>
      <button className="account-logout" type="button" onClick={props.onLogout} disabled={locked} aria-busy={props.logoutBusy}>
        <SignOut size={16} aria-hidden="true" />{L(props.logoutBusy ? '正在退出…' : '退出登录')}
      </button>
    </header>
    <div className="account-profile-grid">
      <section className="account-card" aria-labelledby="account-profile-title">
        <header className="account-card__heading"><UserCircle size={20} aria-hidden="true" /><h2 id="account-profile-title">{L('个人资料')}</h2></header>
        <div className="account-identity">
          <span className="account-avatar" aria-hidden="true">{Array.from(user?.name || user?.email || 'M')[0]}</span>
          <div className="account-email"><span>{L('登录邮箱')}</span><p>{user?.email || '—'}</p></div>
        </div>
        <form className="account-form" onSubmit={event => { event.preventDefault(); props.onSave() }}>
          <div className="account-field"><label htmlFor="account-nickname">{L('昵称')}<span className="account-field__count">{name.length}/60</span></label>
            <input id="account-nickname" type="text" autoComplete="nickname" value={name} onChange={event => props.onName(event.target.value)} maxLength={60} required disabled={locked} />
          </div>
          <footer className="account-form__footer"><button className="account-save" type="submit" disabled={locked || !name.trim() || name.trim() === user?.name} aria-busy={props.profileBusy}>{L(props.profileBusy ? '正在保存…' : '保存昵称')}</button></footer>
        </form>
      </section>
      <section className="account-card account-security-card" aria-labelledby="account-security-title">
        <header className="account-card__heading"><ShieldCheck size={20} aria-hidden="true" /><h2 id="account-security-title">{L('账号安全')}</h2></header>
        <details className="account-security">
          <summary>{L(hasPassword ? '修改密码' : '设置密码')}<CaretDown size={16} aria-hidden="true" /></summary>
          <form className="account-form" onSubmit={event => { event.preventDefault(); props.onChangePassword() }}>
            {hasPassword && <div className="account-field"><label htmlFor="account-current-password">{L('原密码')}</label><input id="account-current-password" type="password" autoComplete="current-password" value={password.currentPassword} onChange={event => props.onPassword('currentPassword', event.target.value)} required disabled={locked} /></div>}
            <div className="account-field"><label htmlFor="account-new-password">{L(hasPassword ? '新密码' : '密码')}</label><input id="account-new-password" type="password" autoComplete="new-password" placeholder={L('至少 8 位')} value={password.newPassword} onChange={event => props.onPassword('newPassword', event.target.value)} minLength={8} maxLength={128} required disabled={locked} /></div>
            {!hasPassword && <p className="account-form__hint">{L('设置后可使用邮箱和密码登录。')}</p>}
            <footer className="account-form__footer"><button className="account-save" type="submit" disabled={locked}>{L(props.passwordBusy ? '正在保存…' : hasPassword ? '修改密码' : '设置密码')}</button></footer>
          </form>
        </details>
      </section>
    </div>
  </main>
}
