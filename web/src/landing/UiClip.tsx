import { useEffect, useRef } from 'react'
import connectionsVideo from './assets/redesign/ui-connections.mp4'
import connectionsPoster from './assets/redesign/ui-connections.jpg'
import settingsVideo from './assets/redesign/ui-settings.mp4'
import settingsPoster from './assets/redesign/ui-settings.jpg'
import editVideo from './assets/redesign/ui-edit.mp4'
import editPoster from './assets/redesign/ui-edit.jpg'

const clips = {
  'ui-connections': { video: connectionsVideo, poster: connectionsPoster },
  'ui-settings': { video: settingsVideo, poster: settingsPoster },
  'ui-edit': { video: editVideo, poster: editPoster },
} as const
export type UiClipName = keyof typeof clips

// Decorative product recordings load only while visible. The still image is
// enough for reduced-motion/save-data visitors and before entering the viewport.
export default function UiClip({ name, label }: { name: UiClipName, label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video || !('IntersectionObserver' in window)) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const connection = (navigator as Navigator & { connection?: EventTarget & { saveData?: boolean } }).connection
    let visible = false
    let released = false
    const release = () => {
      video.pause()
      if (video.hasAttribute('src')) { video.removeAttribute('src'); video.load() }
    }
    const update = () => {
      const filmPlaying = Array.from(document.querySelectorAll<HTMLVideoElement>('video:not([data-ambient])')).some(other => !other.paused && !other.ended)
      if (released || !visible || document.hidden || motion.matches || connection?.saveData || filmPlaying) return release()
      if (!video.hasAttribute('src')) video.src = clips[name].video
      video.play().catch(() => {})
    }
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update() }, { threshold: 0.25 })
    const onPlay = (event: Event) => {
      if (event.target instanceof HTMLVideoElement && !event.target.hasAttribute('data-ambient')) release()
    }
    observer.observe(video)
    document.addEventListener('visibilitychange', update)
    document.addEventListener('play', onPlay, true)
    motion.addEventListener('change', update)
    connection?.addEventListener('change', update)
    return () => {
      released = true
      observer.disconnect()
      document.removeEventListener('visibilitychange', update)
      document.removeEventListener('play', onPlay, true)
      motion.removeEventListener('change', update)
      connection?.removeEventListener('change', update)
      release()
    }
  }, [name])
  return <video ref={ref} poster={clips[name].poster} muted loop playsInline preload="none" aria-label={label} data-ambient=""/>
}
