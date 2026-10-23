import { ChatCircleText, ClockCounterClockwise, FolderSimple, GearSix, House, Images, Lightbulb, UserCircle } from '@phosphor-icons/react'

export type DesktopRailView = 'home' | 'projects' | 'cases' | 'assets' | 'canvas' | 'settings' | 'account' | 'feedback'

type DesktopRailProps = {
  active: DesktopRailView
  onHome(): void
  onProjects(): void
  onCases(): void
  onAssets(): void
  onSettings(): void
  onFeedback(): void
  onAccount(): void
  feedbackUnread?: number
}

export default function DesktopRail({ active, onHome, onProjects, onCases, onAssets, onSettings, onFeedback, onAccount, feedbackUnread = 0 }: DesktopRailProps) {
  return (
    <aside className="desktop-edge-rail" aria-label="妙图导航">
      <div className="desktop-edge-rail__masthead">
        <button type="button" className="desktop-edge-rail__brand" aria-label="妙图首页" onClick={onHome}>
          <img src="/miaoimg-logo.png" alt="" /><span>妙图</span>
        </button>
      </div>
      <nav className="desktop-edge-rail__nav" aria-label="工作区">
        <button type="button" aria-current={active === 'home' ? 'page' : undefined} onClick={onHome}>
          <House size={19} aria-hidden="true" /><span>首页</span>
        </button>
        <button type="button" aria-current={active === 'projects' || active === 'canvas' ? 'page' : undefined} onClick={onProjects}>
          <FolderSimple size={19} aria-hidden="true" /><span>项目</span>
        </button>
        <button type="button" aria-current={active === 'assets' ? 'page' : undefined} onClick={onAssets}>
          <ClockCounterClockwise size={19} aria-hidden="true" /><span>资产</span>
        </button>
      </nav>
      {/* 和 LibTV 一样分组：上面是自己的东西，「社区」下面是大家的作品。 */}
      <p className="desktop-edge-rail__group">社区</p>
      <nav className="desktop-edge-rail__nav" aria-label="社区">
        <button type="button" aria-current={active === 'cases' ? 'page' : undefined} onClick={onCases}>
          <Images size={19} aria-hidden="true" /><span>创作精选</span>
        </button>
      </nav>
      <p className="desktop-edge-rail__group">更多</p>
      <nav className="desktop-edge-rail__nav" aria-label="更多">
        <button type="button" aria-current={active === 'feedback' ? 'page' : undefined} onClick={onFeedback}>
          <ChatCircleText size={19} aria-hidden="true" /><span>反馈</span>{feedbackUnread > 0 && <i className="desktop-edge-rail__dot" aria-label="有新回复" />}
        </button>
        <button type="button" aria-current={active === 'settings' ? 'page' : undefined} onClick={onSettings}>
          <GearSix size={19} aria-hidden="true" /><span>设置</span>
        </button>
      </nav>
      <button type="button" className="desktop-edge-rail__account desktop-edge-rail__changelog" onClick={() => window.dispatchEvent(new Event('miao-show-release-notes'))}>
        <Lightbulb size={19} aria-hidden="true" /><span>版本更新记录</span>
      </button>
      <button type="button" className="desktop-edge-rail__account" aria-current={active === 'account' ? 'page' : undefined} onClick={onAccount}>
        <UserCircle size={20} aria-hidden="true" /><span>账号</span>
      </button>
    </aside>
  )
}
