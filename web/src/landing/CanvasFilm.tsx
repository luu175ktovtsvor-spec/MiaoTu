import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { landingCopy } from './copy'
import city from './assets/turkey/city.jpg'
import sea from './assets/turkey/sea.jpg'
import balloon from './assets/turkey/balloon.jpg'
import CanvasFilmStage, { heroFilmBase } from './CanvasFilmStage'
import './canvas-film.css'
import FilmLoading from './FilmLoading'
const FilmPlayer = lazy(() => import('./FilmPlayer'))
export default function CanvasFilm({ lang }: { lang: string }) {
  const [intent, setIntent] = useState(false)
  const [active, setActive] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const title = landingCopy[lang === 'zh' ? 'zh' : 'en'].film.label
  // The stage starts tilted back like the camera in the film and settles flat
  // as it scrolls into view. Reduced motion keeps it flat.
  useEffect(() => {
    const el = stage.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const update = () => { raf = 0; const r = el.getBoundingClientRect(); const p = Math.min(1, Math.max(0, 1 - (r.top - window.innerHeight * 0.18) / (window.innerHeight * 0.62))); el.style.setProperty('--p', p.toFixed(3)) }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    // Keep the build-rendered first paint unchanged; parallax starts with user scroll.
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll) }
  }, [])
  return <CanvasFilmStage lang={lang} images={{ city, sea, balloon }} stageRef={stage} active={active}
    onIntent={() => setIntent(true)} onPlay={() => setActive(true)}
    player={(intent || active) && <Suspense fallback={<FilmLoading poster={heroFilmBase + 'poster.jpg'} playing={active}/>}><FilmPlayer id="hero" title={title} src={heroFilmBase + 'brand-film.mp4'} poster={heroFilmBase + 'poster.jpg'} playing={active} onPause={() => setActive(false)}/></Suspense>}/>
}
