// @ts-nocheck
// Adapted from Open Image Prompts SmartVideo (MIT), with visible-only loading and explicit failures.
import { WarningCircle } from '@phosphor-icons/react'
import { useEffect, useRef, useState } from 'react'
import { useLang } from '../../i18n'

export default function SmartVideo({ sources, poster, alt = '', className = '', playing = false, controls = false, loop = false, muted = true, eager = false, fit = 'contain' }) {
  const { t } = useLang()
  const availableSources = [...new Set((sources || []).filter(Boolean))]
  const sourceKey = availableSources.join('|')
  const [sourceIndex, setSourceIndex] = useState(0)
  const [nearby, setNearby] = useState(eager || controls)
  const videoRef = useRef(null)
  const wrapperRef = useRef(null)
  useEffect(() => { setSourceIndex(0) }, [sourceKey])
  useEffect(() => {
    if (eager || controls) return
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), { rootMargin: '160px' })
    if (wrapperRef.current) observer.observe(wrapperRef.current)
    return () => observer.disconnect()
  }, [eager, controls])
  const source = availableSources[sourceIndex]
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (playing && nearby) video.play().catch(() => {})
    else if (!controls) video.pause()
    const onVisibility = () => {
      if (document.hidden) video.pause()
      else if (playing && nearby) video.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [playing, nearby, source, controls])
  return (
    <div ref={wrapperRef} className={`relative overflow-hidden bg-surface ${className}`}>
      {source ? <video key={source} ref={videoRef}
        src={nearby || controls ? source : undefined} poster={poster || undefined}
        aria-label={alt} controls={controls} loop={loop} muted={muted} playsInline
        preload={nearby || controls ? 'metadata' : 'none'}
        onError={() => setSourceIndex((index) => index + 1)}
        className={`h-full w-full ${fit === 'contain' ? 'object-contain' : 'object-cover'}`}
      /> : <div role="status" className="flex h-full min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted">
        <WarningCircle size={24} /><span>{t('video.unavailable')}</span>
      </div>}
    </div>
  )
}
