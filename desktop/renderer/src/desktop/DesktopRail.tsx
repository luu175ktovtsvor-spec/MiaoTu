import { ChatCircleText, ClockCounterClockwise, FolderSimple, GearSix, House, Images, UserCircle, Wallet } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import { isChineseLang } from '../shellLanguage'
import { DesktopUpdateButton } from './DesktopUpdate'

export type DesktopRailView = 'home' | 'projects' | 'cases' | 'assets' | 'canvas' | 'settings' | 'account' | 'feedback' | 'billing' | 'history'

type DesktopRailProps = {
  active: DesktopRailView
  onHome(): void
  onProjects(): void
  onCases(): void
  onAssets(): void
  onHistory(): void
  onBilling(): void
  onSettings(): void
  onFeedback(): void
  onAccount(): void
  feedbackUnread?: number
}

export default function DesktopRail({ active, onHome, onProjects, onCases, onAssets, onHistory, onBilling, onSettings, onFeedback, onAccount, feedbackUnread = 0 }: DesktopRailProps) {
  const { t, lang } = useLang()
  return (
    <aside className="desktop-edge-rail" aria-label={t('desktop.nav.label')}>
      <div className="desktop-edge-rail__masthead">
        <button type="button" className="desktop-edge-rail__brand" aria-label={t('desktop.nav.home')} onClick={onHome}>
          <img src="/miaoimg-logo.png" alt="" /><span className="desktop-edge-rail__wordmark">{t('app.title')}{isChineseLang(lang) && <small>MiaoImg</small>}</span>
        </button>
        <DesktopUpdateButton />
      </div>
      <div className="desktop-edge-rail__body">
      <nav className="desktop-edge-rail__nav" aria-label={t('desktop.nav.workspace')}>
        <button type="button" aria-current={active === 'home' ? 'page' : undefined} onClick={onHome}>
          <House size={19} aria-hidden="true" /><span>{t('desktop.nav.home')}</span>
        </button>
        <button type="button" aria-current={active === 'account' ? 'page' : undefined} onClick={onAccount}>
          <UserCircle size={19} aria-hidden="true" /><span>{t('desktop.nav.account')}</span>
        </button>
        <button type="button" aria-current={active === 'projects' || active === 'canvas' ? 'page' : undefined} onClick={onProjects}>
          <FolderSimple size={19} aria-hidden="true" /><span>{t('desktop.nav.projects')}</span>
        </button>
        <button type="button" aria-current={active === 'assets' ? 'page' : undefined} onClick={onAssets}>
          <Images size={19} aria-hidden="true" /><span>{t('desktop.nav.assets')}</span>
        </button>
        <button type="button" aria-current={active === 'history' ? 'page' : undefined} onClick={onHistory}><ClockCounterClockwise size={19} aria-hidden="true" /><span>{t('desktop.nav.history')}</span></button>
      </nav>
      {/* 和 LibTV 一样分组：上面是自己的东西，「社区」下面是大家的作品。 */}
      <p className="desktop-edge-rail__group">{t('desktop.nav.community')}</p>
      <nav className="desktop-edge-rail__nav" aria-label={t('desktop.nav.community')}>
        <button type="button" aria-current={active === 'cases' ? 'page' : undefined} onClick={onCases}>
          <Images size={19} aria-hidden="true" /><span>{t('desktop.nav.cases')}</span>
        </button>
      </nav>
      <p className="desktop-edge-rail__group">{t('desktop.nav.more')}</p>
      <nav className="desktop-edge-rail__nav" aria-label={t('desktop.nav.more')}>
        <button type="button" aria-current={active === 'billing' ? 'page' : undefined} onClick={onBilling}><Wallet size={19} aria-hidden="true" /><span>{t('desktop.nav.credits')}</span></button>
        <button type="button" aria-current={active === 'feedback' ? 'page' : undefined} onClick={onFeedback}>
          <ChatCircleText size={19} aria-hidden="true" /><span>{t('desktop.nav.feedback')}</span>{feedbackUnread > 0 && <i className="desktop-edge-rail__dot" aria-label={t('desktop.nav.newReplies')} />}
        </button>
        <button type="button" aria-current={active === 'settings' ? 'page' : undefined} onClick={onSettings}>
          <GearSix size={19} aria-hidden="true" /><span>{t('desktop.nav.settings')}</span>
        </button>
      </nav>
      </div>
    </aside>
  )
}
