import { Play } from '@phosphor-icons/react'
import { useState } from 'react'
import { FilmPlayer } from './VideoShowcase'
import { landingCopy } from './copy'
import './canvas-film.css'

const filmBase = '/showcase/turkey-film-clean-20261014/'
export default function CanvasFilm({ lang }: { lang: string }) {
  const zh = lang === 'zh'
  const [intent, setIntent] = useState(false)
  const [active, setActive] = useState(false)
  const title = zh ? '看看如何创作' : 'See what you can create'
  const c = landingCopy[zh ? 'zh' : 'en'].film
  return <div className="canvas-film" id="canvas-film">
    <div className="canvas-film-glow" aria-hidden="true"/>
    <div className="canvas-film-screen">
      {(intent || active) && <FilmPlayer id="hero" title={title} src={filmBase + 'brand-film.mp4'} poster={filmBase + 'poster.jpg'} playing={active} onPause={() => setActive(false)}/>}
      {!active && <button className="site-film-play" onPointerEnter={() => setIntent(true)} onPointerDown={() => setIntent(true)} onFocus={() => setIntent(true)} onClick={() => setActive(true)} aria-label={zh ? '播放视频' : 'Play video'}>
        <img src={filmBase + 'poster.jpg'} width="1920" height="1080" fetchPriority="high" decoding="async" alt={title}/>
        <span className="site-play-circle"><Play size={23} weight="fill"/></span>
        <span className="canvas-film-bar" aria-hidden="true"><span className="canvas-film-label"><i/>{title}</span><span className="canvas-film-play-hint"><Play size={13} weight="fill"/>{c.play}</span></span>
      </button>}
    </div>
  </div>
}
