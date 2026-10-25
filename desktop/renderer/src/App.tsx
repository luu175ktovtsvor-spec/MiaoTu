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
  const params = new URLSearchParams(window.location.search)
  const pick = params.get('pick')
  const studio = params.get('studio') === '1' || params.has('play')
  const library = !studio && (params.has('library') || params.has('session') || params.has('focus') || params.has('q') || ['prompt', 'reference'].includes(pick))
  const selectionMode = pick === 'prompt' || pick === 'reference' ? pick : null
  return <Suspense fallback={<StudioLoading />}>{library ? <InspirationLibrary selectionMode={selectionMode} /> : <StudioPage />}</Suspense>
}

export default function App() {
  return <><ReleaseNotesOnVersion /><DesktopContent /></>
}
