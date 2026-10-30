import { lazy, Suspense } from 'react'
import ReleaseNotesOnVersion from './components/ReleaseNotesModal'
import { useLang } from './i18n'
import './components/feedback.css'

const StudioPage = lazy(() => import('./studio/StudioPage'))
const InspirationLibrary = lazy(() => import('./library/InspirationLibrary'))

function StudioLoading() {
  const { t } = useLang()
  return <div className="studio-login" aria-busy="true"><main><p>{t('app.studioLoading')}</p></main></div>
}

function DesktopContent() {
  // 独立灵感库页只用于开发预览（MIAO_DESKTOP_PREVIEW_LIBRARY），正式窗口总是进工作台。
  const library = new URLSearchParams(window.location.search).has('library')
  return <Suspense fallback={<StudioLoading />}>{library ? <InspirationLibrary /> : <StudioPage />}</Suspense>
}

export default function App() {
  return <><ReleaseNotesOnVersion /><DesktopContent /></>
}
