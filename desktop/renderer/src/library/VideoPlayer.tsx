import Hls from 'hls.js/light'
import { useEffect, useRef, useState } from 'react'
import adaptive from './adaptive.json'
import prepared from './playback.json'

export default function VideoPlayer({ source, poster, title }: { source: string; poster: string; title: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const video = ref.current!
    const entry = (adaptive as Record<string, { master: string; manifest: string; low: string }>)[source]
    const fallback = (prepared as Record<string, string>)[source] || source
    let engine: Hls | undefined
    const blobs: string[] = []
    let disposed = false
    setError(false)
    const play = () => { if (!disposed && !document.hidden) video.play().catch(() => {}) }
    const failed = () => setError(true)
    const fallbackToFile = () => {
      const position = video.currentTime
      const resume = !video.paused
      engine?.destroy(); engine = undefined
      video.dataset.playback = 'progressive'
      video.src = fallback
      video.addEventListener('loadedmetadata', () => {
        if (disposed) return
        if (position > 0 && position < video.duration) video.currentTime = position
        if (resume) play()
      }, { once: true })
    }
    if (entry && Hls.isSupported()) {
      // Same policy as the website: begin on the sharpest step, fall back only when the link can't keep up.
      engine = new Hls({ startLevel: -1, testBandwidth: false, abrEwmaDefaultEstimate: 8_000_000, abrEwmaDefaultEstimateMax: 8_000_000,
        abrBandWidthFactor: 1, abrBandWidthUpFactor: 0.9, capLevelToPlayerSize: false,
        maxBufferLength: 4, maxMaxBufferLength: 60, backBufferLength: 4, lowLatencyMode: false })
      video.dataset.playback = 'adaptive'
      const absolute = (text: string, base: URL) => text.split('\n').map(line => line && !line.startsWith('#') ? new URL(line, base).href : line).join('\n')
      const masterAddress = new URL(entry.master, location.origin)
      const lowAddress = new URL('low/index.m3u8', masterAddress)
      const lowBlob = URL.createObjectURL(new Blob([absolute(entry.low, lowAddress)], { type: 'application/vnd.apple.mpegurl' }))
      const masterBlob = URL.createObjectURL(new Blob([absolute(entry.manifest, masterAddress).replace(lowAddress.href, lowBlob)], { type: 'application/vnd.apple.mpegurl' }))
      blobs.push(lowBlob, masterBlob)
      engine.on(Hls.Events.MANIFEST_PARSED, play)
      engine.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) fallbackToFile() })
      engine.loadSource(masterBlob); engine.attachMedia(video)
    } else {
      video.src = entry && video.canPlayType('application/vnd.apple.mpegurl') ? entry.master : fallback
      video.dataset.playback = entry ? 'adaptive-native' : 'progressive'
      video.addEventListener('loadedmetadata', play, { once: true })
    }
    const stop = () => engine?.stopLoad()
    const start = () => { engine?.startLoad(video.currentTime); engine && (engine.config.maxBufferLength = 30) }
    const seek = () => engine?.startLoad(video.currentTime)
    const hide = () => { if (document.hidden) { video.pause(); stop() } }
    video.addEventListener('error', failed); video.addEventListener('pause', stop)
    video.addEventListener('play', start); video.addEventListener('seeking', seek)
    document.addEventListener('visibilitychange', hide)
    return () => {
      disposed = true
      video.removeEventListener('error', failed); video.removeEventListener('pause', stop)
      video.removeEventListener('play', start); video.removeEventListener('seeking', seek)
      video.removeEventListener('loadedmetadata', play); document.removeEventListener('visibilitychange', hide)
      engine?.destroy(); blobs.forEach(URL.revokeObjectURL)
      video.pause(); video.removeAttribute('src'); video.load()
    }
  }, [source, attempt])
  return <div className="inspiration-player">
    <video ref={ref} poster={poster} aria-label={title} controls playsInline preload="none" />
    {error && <button className="inspiration-player-error" onClick={() => setAttempt(value => value + 1)}>播放失败 · 点击重试 / Retry</button>}
  </div>
}
