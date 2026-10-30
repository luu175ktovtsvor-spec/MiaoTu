import { WarningCircle } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { films } from './films'
import { useSitePlayback } from './useSitePlayback'
export default function FilmPlayer({ id, title, onPause, src, poster, controls = true, playing = true }: { id: string, title: string, onPause: () => void, src?: string, poster?: string, controls?: boolean, playing?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const source = src || films.find(film => film.id === id)?.video || ''
  const restart = useSitePlayback(ref, source, playing)
  useEffect(() => {
    setBuffering(playing && (ref.current?.readyState || 0) < 3)
  }, [playing, source])
  const retry = () => {
    if (!ref.current) return onPause()
    setFailed(false); setBuffering(true); restart()
  }
  return <><video ref={ref} poster={poster || films.find(film => film.id === id)?.poster || `/landing/film-${id}.webp?v=20261014`} controls={controls && playing} playsInline preload={playing ? 'auto' : 'metadata'} aria-label={title} aria-hidden={!playing} onWaiting={() => setBuffering(true)} onPlaying={() => { setFailed(false); setBuffering(false) }} onPause={() => setBuffering(false)} onEnded={() => setBuffering(false)} onError={() => { setFailed(true); setBuffering(false) }}/>{playing && buffering && !failed && <span className="site-film-buffering" role="status" aria-label="正在缓冲 / Buffering"/>}{playing && failed && <button className="site-film-error" onClick={retry}><WarningCircle size={24}/><span>点击重试 / Retry</span></button>}</>
}
