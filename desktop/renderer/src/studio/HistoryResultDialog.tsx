import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowSquareOut, Check, Copy, DownloadSimple, FilmStrip, ImageSquare, X } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import { writeClipboard } from '../clipboard'
import LocalTaskRecovery from './LocalTaskRecovery'
import { ProgressRing } from './historyView'
import { ACTIVE_STATUSES, STATUS_LABEL, historyTime, waitingText } from './history'
import { studioPoint, studioText } from './studioText'
import type { HistoryItem, HistoryProgress } from './studioState'

type ResultMedia = { key: string; type: 'image' | 'video'; url: string; thumbnail?: string }

function originalMedia(item: HistoryItem): ResultMedia[] {
  const result: ResultMedia[] = []
  for (const image of item.images || []) if (image.url) result.push({ key: 'image:' + image.url, type: 'image', url: image.url, thumbnail: image.thumbnailUrl })
  if (item.video?.url) result.push({ key: 'video:' + item.video.url, type: 'video', url: item.video.url, thumbnail: item.video.thumbnailUrl })
  for (const file of item.localRecovery?.items || []) if (file.url && /^(image|video)\//.test(file.mime)) result.push({ key: file.mime + ':' + file.url, type: file.mime.startsWith('video/') ? 'video' : 'image', url: file.url, thumbnail: file.thumbnailUrl })
  const seen = new Set<string>()
  const unique = result.filter(media => !seen.has(media.url) && Boolean(seen.add(media.url)))
  return item.kind === 'video' || item.video ? unique.sort((a, b) => Number(b.type === 'video') - Number(a.type === 'video')) : unique
}

function cost(item: HistoryItem) {
  const reserved = ACTIVE_STATUSES.has(item.status) && item.status !== 'saving'
  const value = reserved ? item.reservedPoints ?? item.cost?.reservedPoints ?? item.points : item.chargedPoints ?? item.cost?.points ?? item.points
  const raw: unknown = value
  const number = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  return { reserved, value: Number.isFinite(number) ? number : null }
}

export default function HistoryResultDialog({ item, lang, locale, progress, now, onClose }: {
  item: HistoryItem; lang: string; locale: string; progress?: HistoryProgress; now: number; onClose(): void
}) {
  const { t } = useLang()
  const L = (text: string, vars?: Record<string, unknown>) => studioText(text, lang, vars)
  const panel = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), video = useRef<HTMLVideoElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [index, setIndex] = useState(0), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState(false)
  const [mediaFailed, setMediaFailed] = useState(false), [attempt, setAttempt] = useState(0)
  const media = useMemo(() => originalMedia(item), [item])
  const current = media[Math.min(index, Math.max(0, media.length - 1))]
  const pending = ACTIVE_STATUSES.has(item.status)
  const status = item.localRecovery?.saved ? item.localRecovery.saved < item.localRecovery.total ? '部分已保存' : '文件已在这台电脑上'
    : item.status === 'saving' && item.error ? '保存暂未完成' : STATUS_LABEL[progress?.status || item.status] || item.status
  const price = cost(item)
  const createdAt = new Date(item.created_at || '').getTime()
  const elapsed = Number.isFinite(createdAt) ? Math.max(0, Math.floor((now - createdAt) / 1000)) : null

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; close.current?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], video[controls], [tabindex="0"]') || [])].filter(el => el.getClientRects().length)
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard)
    return () => { document.removeEventListener('keydown', keyboard); document.body.style.overflow = overflow; clearTimeout(timer.current); previous?.focus() }
  }, [onClose])
  useEffect(() => { setMediaFailed(false) }, [current?.key])
  useEffect(() => {
    const element = video.current
    return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load() } }
  }, [current?.key, mediaFailed, attempt])

  async function copyPrompt() {
    try { await writeClipboard(item.prompt || ''); setCopied(true); setCopyError(false); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1800) }
    catch { setCopyError(true) }
  }

  return <div className="history-result-mask" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="history-result" role="dialog" aria-modal="true" aria-labelledby="history-result-title" ref={panel}>
      <header className="history-result-header"><div><span>{item.kind === 'video' || item.video ? <FilmStrip size={17} /> : <ImageSquare size={17} />}</span><h2 id="history-result-title">{L('生成详情')}</h2></div><button type="button" ref={close} className="history-result-close" aria-label={t('dialog.close')} onClick={onClose}><X size={19} /></button></header>
      <div className="history-result-body">
        <div className="history-result-media">
          <div className="history-result-stage" data-media-state={mediaFailed ? 'error' : current ? 'original' : pending ? 'pending' : 'unavailable'}>
            {current && !mediaFailed ? current.type === 'video'
              ? <video ref={video} key={`${current.key}:${attempt}`} src={current.url} poster={current.thumbnail} controls playsInline preload="metadata" onError={() => setMediaFailed(true)} />
              : <img key={`${current.key}:${attempt}`} src={current.url} alt={L('生成详情')} onError={() => setMediaFailed(true)} />
              : <div className="history-result-media-state">
                {pending && progress ? <ProgressRing percent={progress.percent ?? 0} estimated={progress.estimated} showPercent={progress.showPercent ?? true} indeterminate={['submitting', 'confirming'].includes(progress.status)} label={L('生成进度')} approx={L('≈')} statusText={L(status)} /> : item.kind === 'video' || item.video ? <FilmStrip size={32} /> : <ImageSquare size={32} />}
                <strong>{L(mediaFailed ? '加载失败，请重试' : pending ? status : '该记录没有可展示的媒体')}</strong>
                {pending && elapsed != null && <span>{waitingText(elapsed, lang)}</span>}
                {mediaFailed && <button type="button" onClick={() => { setMediaFailed(false); setAttempt(value => value + 1) }}>{L('重试')}</button>}
              </div>}
          </div>
          {media.length > 1 && <div className="history-result-media-nav" role="group" aria-label={L('生成详情')}>
            {media.map((entry, i) => <button key={entry.key} type="button" aria-label={`${L(entry.type === 'video' ? '视频' : '图片')} ${i + 1}`} aria-pressed={i === index} onClick={() => setIndex(i)}>
              {entry.thumbnail ? <img src={entry.thumbnail} loading="lazy" alt="" /> : entry.type === 'video' ? <FilmStrip size={18} /> : <ImageSquare size={18} />}<span>{i + 1}</span>
            </button>)}
          </div>}
          {current && <div className="history-result-media-actions"><span>{Math.min(index + 1, media.length)} / {media.length}</span><div><a href={current.url} target="_blank" rel="noopener noreferrer"><ArrowSquareOut size={15} />{L(current.type === 'video' ? '打开完整原片' : '查看原图')}</a><a href={current.url} download><DownloadSimple size={15} />{L('下载')}</a></div></div>}
          <LocalTaskRecovery recovery={item.localRecovery} lang={lang} />
        </div>
        <aside className="history-result-info">
          <div className={`history-result-status${item.status === 'failed' ? ' is-error' : ''}${pending ? ' is-pending' : ''}`}><span />{L(status)}</div>
          {current && pending && progress && <div className="history-result-inline-progress"><ProgressRing percent={progress.percent ?? 0} estimated={progress.estimated} showPercent={progress.showPercent ?? true} indeterminate={['submitting', 'confirming'].includes(progress.status)} label={L('生成进度')} approx={L('≈')} statusText={L(status)} /><span>{elapsed == null ? L(status) : waitingText(elapsed, lang)}</span></div>}
          <dl className="history-result-facts">
            <div><dt>{L('模型')}</dt><dd>{item.modelLabel || item.model || '—'}</dd></div>
            <div><dt>{L('时间')}</dt><dd>{historyTime(item, locale, lang) || '—'}</dd></div>
            <div><dt>{L(price.reserved ? '生成预扣' : '消耗')}</dt><dd>{price.value == null ? '—' : studioPoint(price.value, lang)}</dd></div>
          </dl>
          {item.error && <div className="history-result-error" role="alert">{L(item.error)}</div>}
          {item.delivery?.target === 'desktop' && <p className="history-result-delivery">{L(item.delivery.status === 'saved' ? '已保存到这台电脑' : item.delivery.status === 'expired' ? '服务器暂存已过期' : '等待桌面保存')}</p>}
          <section className="history-result-prompt"><div><h3>{L('原始提示词')}</h3>{item.prompt && <button type="button" onClick={copyPrompt} aria-label={L(copied ? '已复制' : '复制原始提示词')}>{copied ? <Check size={15} /> : <Copy size={15} />}{L(copied ? '已复制' : '复制原始提示词')}</button>}</div><pre>{item.prompt || '—'}</pre>{copyError && <p role="alert">{L('复制失败，请重试')}</p>}</section>
        </aside>
      </div>
    </div>
  </div>
}
