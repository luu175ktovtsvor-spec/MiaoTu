import { Play } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { FilmPlayer } from './VideoShowcase'
import { landingCopy } from './copy'
import city from './assets/turkey/city.jpg'
import sea from './assets/turkey/sea.jpg'
import balloon from './assets/turkey/balloon.jpg'
import night from './assets/turkey/night.jpg'
import './canvas-film.css'

const filmBase = '/showcase/turkey-3d-20261023/'
// Stage coordinates (1600 × 900). The film screen is the video generation node;
// the cards on the left are its inputs, wired with the canvas' selected-edge glow.
const SCREEN = { x: 420, y: 150, w: 1100, h: 618.75 }
const INPUTS = [
  { kind: 'text', x: 40, y: 96, w: 290, h: 196, z: 60 },
  { kind: 'image', src: city, x: 70, y: 352, w: 250, h: 141, z: 110, zh: '雾中的伊斯坦布尔', en: 'Istanbul in fog' },
  { kind: 'image', src: sea, x: 30, y: 548, w: 250, h: 141, z: 30, zh: '安塔利亚碧海', en: 'Antalya coast' },
  { kind: 'image', src: balloon, x: 96, y: 740, w: 220, h: 124, z: 140, zh: '卡帕多奇亚热气球', en: 'Cappadocia balloons' },
] as const
const PROMPT = {
  zh: ['土耳其 · 30 秒旅行片', '创作一支 30 秒的超写实电影感 FPV 旅行短片 展现土耳其的未来活力、自然之美与文化气质'],
  en: ['Turkey · 30-second travel film', 'Create a 30-second ultra-realistic cinematic FPV travel film showcasing the energy and beauty of Turkey'],
}
const LAYERS = [[12, .06, '36 64'], [7, .12, '36 64'], [4, .15, '36 64'], [4, .18, '0 6 30 64'], [4, .21, '0 12 24 64'], [4, .27, '0 18 18 64'], [4, .38, '0 24 12 64'], [4, .6, '0 30 6 64']] as const
const target = { x: SCREEN.x - 1, y: SCREEN.y + SCREEN.h / 2 }
const edge = (n: typeof INPUTS[number]) => { const sx = n.x + n.w + 1, sy = n.y + n.h / 2, cx = (sx + target.x) / 2; return `M${sx},${sy} C${cx},${sy} ${cx},${target.y} ${target.x},${target.y}` }

export default function CanvasFilm({ lang }: { lang: string }) {
  const zh = lang === 'zh'
  const [intent, setIntent] = useState(false)
  const [active, setActive] = useState(false)
  const stage = useRef<HTMLDivElement>(null)
  const c = landingCopy[zh ? 'zh' : 'en'].film
  const title = c.label
  // The stage starts tilted back like the camera in the film and settles flat
  // as it scrolls into view. Reduced motion keeps it flat.
  useEffect(() => {
    const el = stage.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let raf = 0
    const update = () => { raf = 0; const r = el.getBoundingClientRect(); const p = Math.min(1, Math.max(0, 1 - (r.top - window.innerHeight * 0.18) / (window.innerHeight * 0.62))); el.style.setProperty('--p', p.toFixed(3)) }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll) }
  }, [])
  return <div className="canvas-film" id="canvas-film">
    <div className="canvas-film-stage" ref={stage}>
      <div className="canvas-film-world">
        <div className="canvas-film-grid" aria-hidden="true"/>
        <svg className="canvas-film-edges" viewBox="0 0 1600 900" aria-hidden="true">
          {INPUTS.map((n, i) => <g key={i}>
            <path d={edge(n)} className="canvas-film-edge-base"/>
            <g className="canvas-film-flow" style={{ animationDelay: `${i * -0.7}s` }}>
              <path d={edge(n)} className="canvas-film-edge-core"/>
              {LAYERS.map(([w, o, dash], j) => <path key={j} d={edge(n)} pathLength={300} strokeDasharray={dash} strokeWidth={w} strokeOpacity={o}/>)}
            </g>
          </g>)}
        </svg>
        {INPUTS.map((n, i) => <div key={i} className={`canvas-film-node canvas-film-node-${n.kind}`} aria-hidden="true"
          style={{ left: `${n.x / 16}%`, top: `${n.y / 9}%`, width: `${n.w / 16}%`, height: `${n.h / 9}%`, ['--z' as string]: `${n.z}px`, ['--i' as string]: i }}>
          <span className="canvas-film-node-title">{n.kind === 'text' ? (zh ? '提示词' : 'Prompt') : zh ? n.zh : n.en}</span>
          <div className="canvas-film-node-card">
            {n.kind === 'text' ? <div className="canvas-film-node-text"><b>{PROMPT[zh ? 'zh' : 'en'][0]}</b><p>{PROMPT[zh ? 'zh' : 'en'][1]}</p></div> : <img src={n.src} alt="" loading="lazy" decoding="async"/>}
          </div>
          <i className="canvas-film-handle"/>
        </div>)}
        <div className="canvas-film-screen-wrap" style={{ left: `${SCREEN.x / 16}%`, top: `${SCREEN.y / 9}%`, width: `${SCREEN.w / 16}%` }}>
          <span className="canvas-film-node-title canvas-film-screen-title">{zh ? '视频生成 · Seedance 2.5' : 'Video generation · Seedance 2.5'}</span>
          <div className="canvas-film-glow" aria-hidden="true"/>
          <div className="canvas-film-screen">
            {(intent || active) && <FilmPlayer id="hero" title={title} src={filmBase + 'brand-film.mp4'} poster={filmBase + 'poster.jpg'} playing={active} onPause={() => setActive(false)}/>}
            {!active && <button className="site-film-play" onPointerEnter={() => setIntent(true)} onPointerDown={() => setIntent(true)} onFocus={() => setIntent(true)} onClick={() => setActive(true)} aria-label={c.play}>
              <img src={filmBase + 'poster.jpg'} width="1920" height="1080" fetchPriority="high" decoding="async" alt={title}/>
              <span className="site-play-circle"><Play size={23} weight="fill"/></span>
              <span className="canvas-film-bar" aria-hidden="true"><span className="canvas-film-label"><i/>{title}</span><span className="canvas-film-play-hint"><Play size={13} weight="fill"/>{c.play}</span></span>
            </button>}
          </div>
          <i className="canvas-film-handle canvas-film-handle-in"/>
        </div>
      </div>
    </div>
  </div>
}
