import { useEffect, useState } from 'react'
import { useLang } from '../i18n'
import { RELEASE_NOTES, type ReleaseNotes } from '../releaseNotes'
import './releaseNotes.css'

type DesktopUpdateStatus = { currentVersion?: string }
type DesktopBridge = { updateStatus?: () => Promise<DesktopUpdateStatus> }

function ReleaseNotesModal({ version, notes, onClose }: { version: string; notes: ReleaseNotes; onClose: () => void }) {
  const { lang } = useLang()
  const text = (value: { zh: string; en: string }) => value[lang === 'en' ? 'en' : 'zh']
  const sections = [
    ['修复', 'Fixes', notes.fixes],
    ['优化', 'Improvements', notes.improvements],
    ['已知问题', 'Known issues', notes.knownIssues],
  ] as const
  return <div className="release-notes-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className="release-notes-modal" role="dialog" aria-modal="true" aria-labelledby="release-notes-title">
      <button className="release-notes-close" type="button" aria-label={lang === 'en' ? 'Close release notes' : '关闭更新说明'} onClick={onClose}>×</button>
      <div className="release-notes-kicker">MiaoImg · v{version}</div>
      <h2 id="release-notes-title">{text(notes.title)}</h2>
      <p className="release-notes-intro">{lang === 'en' ? 'Here is what changed in this version.' : '这次更新，我们修复了问题，也把使用体验做得更顺手。'}</p>
      <div className="release-notes-sections">
        {sections.filter(([, , items]) => items.length > 0).map(([zh, en, items]) => <section key={zh} className="release-notes-section">
          <h3>{lang === 'en' ? en : zh}</h3>
          <ul>{items.map(item => <li key={item.zh}>{text(item)}</li>)}</ul>
        </section>)}
      </div>
      <button className="release-notes-confirm" type="button" onClick={onClose}>{lang === 'en' ? 'Start using MiaoImg' : '开始使用妙图'}</button>
    </section>
  </div>
}

export default function ReleaseNotesOnVersion() {
  const [state, setState] = useState<{ version: string; notes: ReleaseNotes } | null>(null)
  // 不随启动自动弹出；只由侧边栏「版本更新记录」按需打开。
  useEffect(() => {
    const bridge = (window as Window & { miaoDesktop?: DesktopBridge }).miaoDesktop
    const show = () => {
      if (!bridge?.updateStatus) return
      void bridge.updateStatus().then(status => {
        const version = String(status?.currentVersion || '')
        if (RELEASE_NOTES[version]) setState({ version, notes: RELEASE_NOTES[version] })
      }).catch(() => {})
    }
    window.addEventListener('miao-show-release-notes', show)
    return () => window.removeEventListener('miao-show-release-notes', show)
  }, [])
  if (!state) return null
  const close = () => {
    setState(null)
  }
  return <ReleaseNotesModal version={state.version} notes={state.notes} onClose={close} />
}
