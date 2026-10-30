import { Play } from '@phosphor-icons/react'
import { lazy, Suspense, useState } from 'react'

import { films, filmThemes } from './films'
import { landingCopy } from './copy'
import FilmLoading from './FilmLoading'

const FilmPlayer = lazy(() => import('./FilmPlayer'))

export default function VideoShowcase({ lang }: { lang: string }) {
  const locale = lang === 'zh' ? 0 : 1
  const c = landingCopy[lang as 'zh'] || landingCopy.en
  const [filter, setFilter] = useState('all')
  const [active, setActive] = useState<string | null>(null)
  const [warmed, setWarmed] = useState<string | null>(null)
  const initial = typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches ? 6 : 12
  const [limit, setLimit] = useState(initial)
  const matching = filter === 'all' ? films : films.filter(film => film.theme === filter)
  const shown = matching.slice(0, limit)
  return <section className="site-section site-films" id="films">
    <div className="site-container">
      <div className="site-section-heading site-heading-split" data-reveal><div><p className="site-kicker">{c.filmsKicker}</p><h2>{c.filmsTitle[0]}<br/><span>{c.filmsTitle[1]}</span></h2></div><p>{c.filmsBody}</p></div>
      <div className="site-film-filters" role="group" aria-label={c.filmsThemes} data-reveal>{[{id:'all',category:[c.filmsAll,c.filmsAll]},...filmThemes].map(film=><button key={film.id} aria-pressed={filter === film.id} onClick={() => { setActive(null); setWarmed(null); setFilter(film.id); setLimit(initial) }}>{film.category[locale]}</button>)}</div>
      <div className="site-film-grid" id="film-results">{shown.map(film=><article key={film.id} className="site-film" data-film-id={film.id}><div className="site-film-media">{(active === film.id || warmed === film.id) && <Suspense fallback={<FilmLoading poster={film.poster || `/landing/film-${film.id}.webp?v=20261014`} playing={active === film.id}/>}><FilmPlayer key={film.id} id={film.id} title={film.title[locale]} playing={active === film.id} onPause={() => setActive(null)}/></Suspense>}{active !== film.id && <button className="site-film-play" onPointerEnter={() => { if (!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) setWarmed(film.id) }} onFocus={() => setWarmed(film.id)} onPointerDown={() => setWarmed(film.id)} onClick={() => setActive(film.id)} aria-label={`${c.filmsPlay} · ${film.title[locale]}`}><img src={film.poster || `/landing/film-${film.id}.webp?v=20261014`} width="960" height="600" loading="lazy" fetchPriority="low" decoding="async" alt={film.title[locale]}/><span className="site-play-circle"><Play size={18} weight="fill"/></span></button>}</div><div className="site-film-caption"><h3>{film.title[locale]}</h3><span>{film.category[locale]}</span></div></article>)}</div>
      <div className="site-film-more">{limit < matching.length && <button className="site-button site-button-secondary" aria-controls="film-results" onClick={() => setLimit(current => current + 24)}>{c.filmsMore}</button>}</div>
    </div>
  </section>
}
