import { DownloadSimple, SpinnerGap } from '@phosphor-icons/react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import FeedbackNotice from '../components/FeedbackNotice'
import { useLang } from '../i18n'
import { studioText } from '../studio/studioText'
import { desktopUpdateAction, desktopUpdateBridge, performDesktopUpdate, setDesktopUpdatePhase, subscribeDesktopUpdateAction, type DesktopUpdateSnapshot } from './desktopUpdateClient'

// The host stays outside the account-keyed page tree, so navigating away from
// the footer cannot detach a requested download before its native installation.
export function DesktopUpdateHost() {
  const { lang } = useLang()
  const language = useRef(lang); language.current = lang
  const [notice, setNotice] = useState({ message: '', error: false })
  useEffect(() => {
    const bridge = desktopUpdateBridge()
    if (!bridge) return
    const controller = new AbortController()
    const run = () => {
      if (desktopUpdateAction().busy) return
      setDesktopUpdatePhase('getting'); setNotice({ message: '', error: false })
      void performDesktopUpdate(bridge, setDesktopUpdatePhase, controller.signal).then(result => {
        if (controller.signal.aborted) return
        if (result === 'latest') setNotice({ message: studioText('当前已是最新版本', language.current), error: false })
        if (result === 'unavailable') setNotice({ message: studioText('请从官网下载客户端。', language.current), error: false })
      }).catch(() => {
        if (!controller.signal.aborted) setNotice({ message: studioText('暂时无法更新，请稍后重试。', language.current), error: true })
      }).finally(() => { if (!controller.signal.aborted) setDesktopUpdatePhase('idle') })
    }
    window.addEventListener('miao-desktop-update-now', run)
    return () => { controller.abort(); setDesktopUpdatePhase('idle'); window.removeEventListener('miao-desktop-update-now', run) }
  }, [])
  return <FeedbackNotice message={notice.message} error={notice.error} onClose={() => setNotice({ message: '', error: false })} />
}

export function DesktopUpdateButton() {
  const { lang } = useLang()
  const L = (value: string, vars?: Record<string, unknown>) => studioText(value, lang, vars)
  const action = useSyncExternalStore(subscribeDesktopUpdateAction, desktopUpdateAction, desktopUpdateAction)
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot | null>(null)
  const native = desktopUpdateBridge()
  useEffect(() => {
    if (!native) return
    let disposed = false
    const unsubscribe = native.onUpdateStatus(value => { if (!disposed) setSnapshot(value) })
    void native.updateStatus().then(value => { if (!disposed) setSnapshot(value) }).catch(() => {})
    return () => { disposed = true; unsubscribe() }
  }, [native])
  if (!native) return null
  const downloading = action.phase === 'downloading' || snapshot?.state === 'downloading'
  const percent = typeof snapshot?.percent === 'number' && Number.isFinite(snapshot.percent) ? Math.max(0, Math.min(100, Math.round(snapshot.percent))) : null
  const available = ['available', 'ready'].includes(snapshot?.state || '')
  // 没有新版本就不占位；有新版本、或正在下载/重启时才冒出一个图标。
  if (!available && !downloading && !action.busy) return null
  const label = action.phase === 'installing' ? L('正在重启更新…') : downloading ? percent == null ? L('下载更新') : L('正在下载 {percent}%', { percent }) : action.busy ? L('正在获取新版…') : L('有新版本')
  return <button type="button" className="desktop-update-button" disabled={action.busy} aria-busy={action.busy} aria-label={label} title={snapshot?.version ? `${label} · v${snapshot.version}` : label} onClick={() => window.dispatchEvent(new Event('miao-desktop-update-now'))}>
    {action.busy || downloading ? <SpinnerGap size={18} className="desktop-update-spinner" aria-hidden="true" /> : <DownloadSimple size={18} aria-hidden="true" />}
    {available && !action.busy && <i className="desktop-update-available" aria-hidden="true" />}
    {downloading && percent != null && <i className="desktop-update-progress" aria-hidden="true" style={{ width: `${percent}%` }} />}
  </button>
}
