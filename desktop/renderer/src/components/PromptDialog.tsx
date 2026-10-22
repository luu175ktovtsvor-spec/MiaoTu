// @ts-nocheck
import {
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  Play,
  WarningCircle,
  X,
} from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../clipboard'
import { writeLibrarySelection } from '../libraryHandoff'
import { useLang } from '../i18n'
import { mediaItems } from '../media'
import SmartImage from './ui/SmartImage'
import SmartVideo from './ui/SmartVideo'

export default function PromptDialog({ item, position, total, onClose, onStep, onCopied, selectionMode = null }) {
  const { t, locale } = useLang()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [copyState, setCopyState] = useState('idle')
  const [showOriginal, setShowOriginal] = useState(true)
  const closeButtonRef = useRef(null)
  const resetTimerRef = useRef(null)
  const detailScrollRef = useRef(null)
  const touchStartRef = useRef(null)
  const media = mediaItems(item)
  const currentMedia = media[currentIndex]
  const hasReadingTranslation = Boolean(item.localized_prompt && item.localized_prompt !== item.prompt_text)
  const displayedPrompt = showOriginal || !hasReadingTranslation ? item.prompt_text : item.localized_prompt

  const showPrevious = () => {
    setCurrentIndex((index) => (index - 1 + media.length) % media.length)
  }

  const showNext = () => {
    setCurrentIndex((index) => (index + 1) % media.length)
  }

  useEffect(() => {
    setCurrentIndex(0)
    setCopyState('idle')
    setShowOriginal(true)
    detailScrollRef.current?.scrollTo({ top: 0 })
    window.clearTimeout(resetTimerRef.current)
  }, [item.tweet_id])

  function handleTouchStart(event) {
    const touch = event.changedTouches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
  }

  function handleTouchEnd(event) {
    const start = touchStartRef.current
    touchStartRef.current = null
    if (!start) return
    const touch = event.changedTouches[0]
    const deltaX = touch.clientX - start.x
    const deltaY = touch.clientY - start.y
    if (Math.abs(deltaX) < 56 || Math.abs(deltaX) < Math.abs(deltaY) * 1.35) return

    if (media.length > 1) {
      if (deltaX < 0) showNext()
      else showPrevious()
      return
    }
    onStep(deltaX < 0 ? 1 : -1)
  }

  useEffect(() => {
    const previousFocus = document.activeElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowLeft') onStep(-1)
      if (event.key === 'ArrowRight') onStep(1)
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus?.()
      window.clearTimeout(resetTimerRef.current)
    }
  }, [onClose, onStep])

  function mediaLabel(entry, index) {
    return entry.type === 'video-link' || entry.type === 'video'
      ? t('dialog.media.video', { n: index + 1 })
      : t('dialog.media.image', { n: index + 1 })
  }

  const date = new Date(item.created_at)
  const fullDate = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)

  async function copyPrompt() {
    try {
      await writeClipboard(item.prompt_text)
      setCopyState('copied')
      onCopied?.(t('card.copied'))
    } catch {
      setCopyState('error')
    }

    window.clearTimeout(resetTimerRef.current)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 2200)
  }

  function selectForStudio(type) {
    try {
      const referenceImage = item.images?.find((image) => image?.local || image?.url)
      // 交出去的图片只带画布取图要用的两项（local 优先、url 兜底），上游的媒体 id / tags 不写进交接记录。
      const reference = referenceImage ? [{ local: referenceImage.local ?? null, url: referenceImage.url ?? null }] : []
      writeLibrarySelection(type === 'prompt'
        ? { mode: 'prompt', type, text: item.prompt_text || '' }
        : { mode: 'reference', type, images: reference })
      window.location.href = '/'
    } catch (error) {
      onCopied?.(error.message || t('selection.saveFailed'))
    }
  }

  const hasReference = Boolean(item.images?.some((image) => image?.local || image?.url))

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
      className="fixed inset-0 z-40 grid bg-abyss"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.985 }}
        transition={{ type: 'spring', stiffness: 260, damping: 28 }}
        className="relative grid h-full w-full grid-rows-[minmax(42dvh,1fr)_minmax(0,1fr)] overflow-hidden bg-abyss md:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.7fr)] md:grid-rows-1"
      >
        <section
          className="lib-dialog__stage relative min-h-[42dvh] touch-pan-y overflow-hidden md:min-h-0"
          aria-label="Media"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {currentMedia?.type === 'video' ? (
            <div className="flex h-full flex-col justify-center gap-3 p-4 pt-16 pb-14">
              <SmartVideo key={`${item.tweet_id}-${currentIndex}`} sources={currentMedia.sources}
                poster={currentMedia.poster} alt={mediaLabel(currentMedia, currentIndex)} controls muted={false} eager
                className="min-h-0 flex-1" />
              <a href={currentMedia.sourceUrl} target="_blank" rel="noopener noreferrer"
                className="focus-ring self-center text-xs text-muted underline">{t('dialog.openVideo')}</a>
            </div>
          ) : currentMedia?.type === 'video-link' ? (
            <VideoPreview media={currentMedia} />
          ) : currentMedia ? (
            <>
              <img
                src={currentMedia.sources[0]}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 hidden h-full w-full scale-125 object-cover opacity-25 blur-2xl md:block"
              />
              <SmartImage
                sources={currentMedia.sources}
                mobileSources={currentMedia.mobileSources}
                alt={mediaLabel(currentMedia, currentIndex)}
                className="relative h-full w-full"
                eager
                fit="contain"
              />
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted">{t('dialog.noMedia')}</div>
          )}

          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-abyss/80 to-transparent" />

          <div className="absolute left-4 top-4 flex items-center gap-2 md:left-5 md:top-5">
            <div className="lib-dialog__media-btn flex items-center gap-1 rounded-full p-1">
              <button
                type="button"
                onClick={() => onStep(-1)}
                aria-label={t('dialog.prevItem')}
                className="focus-ring grid size-7 place-items-center rounded-full text-body transition-colors hover:text-ink"
              >
                <CaretLeft size={15} />
              </button>
              <span className="min-w-[68px] text-center font-mono text-[10.5px] tabular-nums text-muted">
                {position} / {total}
              </span>
              <button
                type="button"
                onClick={() => onStep(1)}
                aria-label={t('dialog.nextItem')}
                className="focus-ring grid size-7 place-items-center rounded-full text-body transition-colors hover:text-ink"
              >
                <CaretRight size={15} />
              </button>
            </div>
            {media.length > 1 && (
              <span className="lib-dialog__media-btn rounded-full px-3 py-1.5 font-mono text-[10px] text-muted">
                {currentIndex + 1} / {media.length}
              </span>
            )}
          </div>

          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="lib-dialog__media-btn focus-ring absolute right-4 top-4 grid size-10 place-items-center rounded-full text-ink md:right-5 md:top-5"
            aria-label={t('dialog.close')}
          >
            <X size={17} />
          </button>

          {media.length > 1 && (
            <>
              <MediaNavButton direction="left" onClick={showPrevious} label={t('dialog.prevMedia')}>
                <CaretLeft size={17} />
              </MediaNavButton>
              <MediaNavButton direction="right" onClick={showNext} label={t('dialog.nextMedia')}>
                <CaretRight size={17} />
              </MediaNavButton>
              <div className="lib-dialog__media-btn absolute bottom-4 left-1/2 flex -translate-x-1/2 gap-1.5 rounded-full p-2">
                {media.map((entry, index) => (
                  <button
                    key={`${entry.type}-${index}`}
                    type="button"
                    onClick={() => setCurrentIndex(index)}
                    aria-label={t('dialog.mediaLabel', { label: mediaLabel(entry, index) })}
                    aria-current={index === currentIndex}
                    className={`h-1.5 rounded-full transition-[width,background-color] duration-300 ${
                      index === currentIndex ? 'w-6 bg-brass' : 'w-1.5 bg-white/35 hover:bg-white/60'
                    }`}
                  />
                ))}
              </div>
            </>
          )}

          <p className="pointer-events-none absolute bottom-4 right-4 hidden items-center gap-1.5 font-mono text-[10px] text-faint md:flex">
            <span className="kbd">←</span>
            <span className="kbd">→</span>
            {t('dialog.stepHint')}
          </p>
        </section>

        <section ref={detailScrollRef} className="lib-dialog__panel custom-scrollbar flex min-h-0 flex-col overflow-y-auto border-t border-line md:border-l md:border-t-0">
          <div className="border-b border-line px-5 py-5 md:px-7 md:py-6">
            <div className="min-w-0">
              <h2 id="prompt-dialog-title" className="truncate font-display text-[26px] font-[560] leading-tight tracking-[-0.02em] text-ink">
                {item.tool && item.tool !== 'None' ? item.tool : t('dialog.promptDetail')}
              </h2>
              <p className="mt-1.5 font-mono text-[11px] text-muted">{fullDate}</p>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {item.tool && item.tool !== 'None' && <MetaTag accent>{item.tool}</MetaTag>}
              <MetaTag>
                {t(`dialog.images.${(item.images?.length || 0) === 1 ? 'one' : 'other'}`, { n: item.images?.length || 0 })}
              </MetaTag>
              {item.videos?.length > 0 && (
                <MetaTag>{t(`dialog.videos.${item.videos.length === 1 ? 'one' : 'other'}`, { n: item.videos.length })}</MetaTag>
              )}
            </div>
          </div>

          <div className="flex flex-1 flex-col px-4 pb-24 pt-4 md:px-7 md:py-6">
            <div className="mb-3.5 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-[13px] font-semibold text-ink">{t('dialog.fullPrompt')}</h3>
                <p className="mt-0.5 font-mono text-[10.5px] text-faint">{t('dialog.promptNote')}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {hasReadingTranslation && (
                  <button
                    type="button"
                    onClick={() => setShowOriginal((value) => !value)}
                    className="lib-dialog__ghost focus-ring px-3.5 py-2.5 text-xs font-medium"
                  >
                    {showOriginal ? t('dialog.showTranslation') : t('dialog.showOriginal')}
                  </button>
                )}
                <button
                  type="button"
                  onClick={copyPrompt}
                  className={`focus-ring hidden min-w-[104px] shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-4 py-2.5 text-xs font-semibold transition-colors active:scale-[0.97] sm:inline-flex ${
                    copyState === 'error'
                      ? 'bg-error-soft text-error'
                      : copyState === 'copied'
                        ? 'bg-brass-soft text-brass-strong'
                        : 'lib-dialog__primary'
                  }`}
                >
                  {copyState === 'copied' ? <Check size={14} /> : copyState === 'error' ? <WarningCircle size={14} /> : <Copy size={14} />}
                  {copyState === 'copied' ? t('dialog.copied') : copyState === 'error' ? t('dialog.copyFailed') : hasReadingTranslation ? t('dialog.copyOriginal') : t('dialog.copy')}
                </button>
              </div>
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
              {selectionMode !== 'reference' && (
                <button type="button" className="lib-dialog__ghost focus-ring px-3.5 py-2 font-medium" onClick={() => selectForStudio('prompt')}>
                  {t(selectionMode === 'prompt' ? 'selection.useThisPrompt' : 'selection.sendToCanvas')}
                </button>
              )}
              {selectionMode !== 'prompt' && hasReference && (
                <button type="button" className="lib-dialog__ghost focus-ring px-3.5 py-2 font-medium" onClick={() => selectForStudio('reference')}>
                  {t('selection.useAsReference')}
                </button>
              )}
            </div>
            <div className="lib-dialog__prompt flex flex-1 p-4 md:p-5">
              <pre className="prompt-pre">{displayedPrompt}</pre>
            </div>

          </div>
        </section>

        <div className="absolute inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur-xl md:hidden">
          <button
            type="button"
            onClick={copyPrompt}
            className={`focus-ring inline-flex h-11 w-full items-center justify-center gap-2 rounded-full text-xs font-semibold transition-colors active:scale-[0.98] ${
              copyState === 'error'
                ? 'bg-error-soft text-error'
                : copyState === 'copied'
                  ? 'bg-brass-soft text-brass-strong'
                  : 'bg-brass text-[#17140f]'
            }`}
          >
            {copyState === 'copied' ? <Check size={15} /> : copyState === 'error' ? <WarningCircle size={15} /> : <Copy size={15} />}
            {copyState === 'copied' ? t('dialog.copied') : copyState === 'error' ? t('dialog.copyFailed') : hasReadingTranslation ? t('dialog.copyOriginal') : t('dialog.copy')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

function VideoPreview({ media }) {
  const { t } = useLang()
  return (
    <div className="relative grid h-full place-items-center">
      {media.sources.length > 0 && (
        <SmartImage sources={media.sources} alt="Video preview" className="absolute inset-0 h-full w-full opacity-60" eager />
      )}
      <a href={media.url} target="_blank" rel="noopener noreferrer" className="lib-dialog__media-btn relative inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-ink">
        <Play size={15} weight="fill" />
        {t('dialog.openVideo')}
      </a>
    </div>
  )
}

function MediaNavButton({ direction, onClick, label, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`lib-dialog__media-btn focus-ring absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full text-ink ${
        direction === 'left' ? 'left-4' : 'right-4'
      }`}
    >
      {children}
    </button>
  )
}

function MetaTag({ children, accent = false }) {
  return (
    <span
      className={`${accent ? 'lib-dialog__meta--accent' : 'lib-dialog__meta'} rounded-full px-3 py-1 text-[11px] font-medium`}
    >
      {children}
    </span>
  )
}
