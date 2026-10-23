import Hls from 'hls.js/light'
import { type RefObject, useEffect, useRef, useState } from 'react'
import adaptive from './adaptive.json'
import { playbackUrl } from './playback'

export function useSitePlayback(ref: RefObject<HTMLVideoElement | null>, source: string, playing: boolean) {
  const controller = useRef<Hls | null>(null)
  const [attempt, setAttempt] = useState(0)
  const fallback = playbackUrl(source)
  const playlist = (adaptive as Record<string, { master: string; manifest: string; low: string }>)[source]
  useEffect(() => {
    const video = ref.current
    if (!video) return
    let stopped = false
    let recovery: (() => void) | undefined
    const pauseOthers = () => document.querySelectorAll('video').forEach(other => { if (other !== video) other.pause() })
    const start = () => {
      pauseOthers()
      if (controller.current) {
        controller.current.config.maxBufferLength = 30
        if (stopped) controller.current.startLoad()
      }
      stopped = false
    }
    const stop = () => { controller.current?.stopLoad(); stopped = true }
    const seek = () => {
      if (stopped && controller.current) {
        controller.current.config.maxBufferLength = video.paused ? 4 : 30
        controller.current.startLoad(video.currentTime); stopped = false
      }
    }
    const prioritize = (event: Event) => { if (event.target instanceof HTMLVideoElement && event.target !== video) { video.pause(); stop() } }
    video.addEventListener('play', start)
    video.addEventListener('pause', stop)
    video.addEventListener('ended', stop)
    video.addEventListener('seeking', seek)
    document.addEventListener('play', prioritize, true)
    if (playlist && Hls.isSupported()) {
      // Start on the sharpest step instead of probing at 360p; ABR still steps
      // down when segments arrive slower than they play. No cap to the box size,
      // so small cards and fullscreen both get the full-quality picture. Measured
      // on a 4 Mbps link: the stock 0.95/0.7 factors fell to 360p for 8 s, these
      // held 720p–1080p with the same single start-up stall.
      const engine = new Hls({ startLevel: -1, testBandwidth: false, abrEwmaDefaultEstimate: 8_000_000, abrEwmaDefaultEstimateMax: 8_000_000,
        abrBandWidthFactor: 1, abrBandWidthUpFactor: 0.9, capLevelToPlayerSize: false,
        maxBufferLength: 4, maxMaxBufferLength: 60, backBufferLength: 5, lowLatencyMode: false, progressive: true })
      controller.current = engine
      video.dataset.playback = 'adaptive'
      engine.on(Hls.Events.LEVEL_SWITCHED, (_, data) => { video.dataset.levelHeight = String(engine.levels[data.level]?.height || 0) })
      engine.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        const resume = !video.paused
        const position = video.currentTime
        engine.destroy(); controller.current = null
        video.dataset.playback = 'progressive-fallback'
        recovery = () => {
          if (position > 0 && position < video.duration) video.currentTime = position
          if (resume) video.play().catch(() => {})
        }
        video.addEventListener('loadedmetadata', recovery, { once: true })
        video.src = fallback
      })
      // These are fixed VOD manifests, already shipped with the page. Avoid two
      // network round trips before the first segment, while retaining real URLs
      // for every media segment and the higher-quality rendition.
      const masterAddress = new URL(playlist.master, location.origin)
      const absolute = (text: string, base: URL) => text.split('\n').map(line => line && !line.startsWith('#') ? new URL(line, base).href : line).join('\n')
      const lowAddress = new URL('low/index.m3u8', masterAddress)
      const lowBlob = URL.createObjectURL(new Blob([absolute(playlist.low, lowAddress)], { type: 'application/vnd.apple.mpegurl' }))
      const masterText = absolute(playlist.manifest, masterAddress).replace(lowAddress.href, lowBlob)
      const masterBlob = URL.createObjectURL(new Blob([masterText], { type: 'application/vnd.apple.mpegurl' }))
      engine.on(Hls.Events.DESTROYING, () => { URL.revokeObjectURL(lowBlob); URL.revokeObjectURL(masterBlob) })
      engine.loadSource(masterBlob)
      engine.attachMedia(video)
    } else if (playlist && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.dataset.playback = 'adaptive-native'
      video.src = playlist.master
    } else { video.dataset.playback = 'progressive'; video.src = fallback }
    const observer = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) video.pause() }, { threshold: .05 })
    observer.observe(video)
    const hide = () => { if (document.hidden) video.pause() }
    document.addEventListener('visibilitychange', hide)
    return () => {
      observer.disconnect(); document.removeEventListener('visibilitychange', hide)
      video.removeEventListener('play', start); video.removeEventListener('pause', stop)
      video.removeEventListener('ended', stop)
      video.removeEventListener('seeking', seek); document.removeEventListener('play', prioritize, true)
      if (recovery) video.removeEventListener('loadedmetadata', recovery)
      controller.current?.destroy(); controller.current = null
      video.pause(); video.removeAttribute('src'); video.load()
    }
  }, [source, fallback, playlist, attempt])
  useEffect(() => {
    const video = ref.current
    if (!video) return
    const engine = controller.current
    if (engine) engine.config.maxBufferLength = playing ? 30 : 3
    if (playing) video.play().catch(() => {})
    else video.pause()
  }, [playing, source, playlist, attempt])
  return () => setAttempt(value => value + 1)
}
