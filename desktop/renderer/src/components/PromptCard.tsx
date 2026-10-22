// @ts-nocheck
import { Copy, Play } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { writeClipboard } from '../clipboard'
import { useLang } from '../i18n'
import { firstImageSources, videoSources } from '../media'
import SmartVideo from './ui/SmartVideo'
import SmartImage from './ui/SmartImage'

function excerpt(text, limit = 130) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

function reasonLabel(reason) {
  if (typeof reason === 'string') return reason
  if (!reason || typeof reason !== 'object') return ''
  if (reason.value) return reason.value
  if (reason.values?.length) return reason.values.slice(0, 2).join(' · ')
  if (reason.type === 'image_available' && reason.count) return `${reason.count} images`
  return ''
}

export default function PromptCard({ item, index, onSelect, onCopied, tagLabels }) {
  const { t, locale } = useLang()
  const [hovering, setHovering] = useState(false)
  const previewVideo = (item.videos || []).map((video) => ({ video, sources: videoSources(video) })).find((entry) => entry.sources.length)
  const imageCount = item.images?.length || 0
  const hasVideo = Boolean(item.videos?.length)
  const tool = item.tool && item.tool !== 'None' ? item.tool : null
  const ratio = item._ratio && item._ratio > 0.2 && item._ratio < 5 ? item._ratio : null
  const isRelated = item.session_reference?.match_kind === 'related'
  const missingConstraints = (item.session_reference?.missing_constraints || []).slice(0, 2)
  const matchReasons = (item.session_reference?.match_reasons || [])
    .map(reasonLabel)
    .filter(Boolean)
    .slice(0, 2)
  const tagNames = (item._tagValues || [])
    .map((value) => tagLabels?.get(value))
    .filter(Boolean)
    .slice(0, 2)

  const date = new Date(item.created_at)
  const dateLabel = Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)

  async function handleCopy(event) {
    event.stopPropagation()
    try {
      await writeClipboard(item.prompt_text)
      onCopied?.(t('card.copied'))
    } catch {
      onCopied?.(t('card.copyFailed'))
    }
  }

  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        opacity: { duration: 0.3, delay: Math.min((index % 24) * 0.015, 0.18) },
        y: { type: 'spring', stiffness: 140, damping: 24, delay: Math.min((index % 24) * 0.015, 0.18) },
      }}
      data-prompt-id={item.tweet_id}
      className="masonry-item relative"
    >
      <button
        type="button"
        onClick={() => { setHovering(false); onSelect() }}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        onFocus={() => setHovering(true)}
        onBlur={() => setHovering(false)}
        className="wall-card focus-ring block w-full text-left"
        style={ratio ? { aspectRatio: `${ratio}` } : undefined}
        aria-label={t('card.open')}
      >
        {previewVideo && !imageCount ? (
          <SmartVideo sources={previewVideo.sources} alt={t('card.video')}
            className={`h-full w-full ${ratio ? '' : 'aspect-[4/5]'}`}
            playing={hovering} loop muted eager={index < 3} fit="cover" />
        ) : (
          <SmartImage sources={firstImageSources(item)} alt={t('card.alt')}
            className={`h-full w-full ${ratio ? '' : 'aspect-[4/5]'}`} eager={index < 6} />
        )}
        {previewVideo && imageCount > 0 && hovering && (
          <SmartVideo sources={previewVideo.sources} alt={t('card.video')}
            className="pointer-events-none absolute inset-0 h-full w-full"
            playing loop muted eager fit="cover" />
        )}

        <div className="card-top pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
          {tool ? (
            <span className="card-tag card-tag--tool font-mono text-[10px] font-medium">{tool}</span>
          ) : (
            <span />
          )}
          {(imageCount > 1 || hasVideo) && (
            <span className="card-tag inline-flex items-center gap-1 font-mono text-[10px]">
              {hasVideo ? (
                <>
                  <Play size={10} weight="fill" /> {t('card.video')}
                </>
              ) : (
                t('card.imageCount', { n: imageCount })
              )}
            </span>
          )}
        </div>

        <div className="card-veil pointer-events-none absolute inset-x-0 bottom-0 px-3.5 pb-3.5 pt-12">
          {isRelated && (
            <div className="mb-2 flex flex-wrap gap-1">
              <span className="card-flag">
                {t('session.related')}
                {missingConstraints.length > 0 && ` · ${t('session.missingConstraint', { value: missingConstraints.join(' · ') })}`}
              </span>
            </div>
          )}
          {matchReasons.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1">
              {matchReasons.map((reason, reasonIndex) => (
                <span key={`${reason}-${reasonIndex}`} className="card-flag card-flag--match">
                  {reason}
                </span>
              ))}
            </div>
          )}
          {tagNames.length > 0 && (
            <div className="card-tags mb-2 flex flex-wrap gap-1">
              {tagNames.map((name) => (
                <span key={name} className="card-tag font-mono text-[9.5px]">{name}</span>
              ))}
            </div>
          )}
          <p className="card-excerpt">{excerpt(item.localized_prompt || item.prompt_text)}</p>
          {dateLabel && <p className="card-date">{dateLabel}</p>}
        </div>
      </button>

      <button
        type="button"
        onClick={handleCopy}
        aria-label={t('card.copyAria')}
        className="card-copy focus-ring absolute bottom-3 right-3 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-medium"
      >
        <Copy size={11} />
        <span className="mobile-copy-label">{t('card.copy')}</span>
      </button>
    </motion.article>
  )
}
