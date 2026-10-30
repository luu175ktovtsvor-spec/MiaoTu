import FeedbackNotice from '../components/FeedbackNotice'
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, Copy, FilmStrip, Images, MagnifyingGlass, Play, Sparkle, X } from '@phosphor-icons/react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '../i18n'
import LanguageControl from '../LanguageControl'
import { contentLang, intlLocale, isChineseLang } from '../shellLanguage'
import { studioText } from '../studio/studioText'
import { writeClipboard } from '../clipboard'
import { writeLibrarySelection } from '../libraryHandoff'
import { assetUrl, firstImageSources, mediaItems } from '../media'
import { usePromptArchiveApi } from '../hooks/usePromptArchiveApi'
import PromptGallery from '../components/PromptGallery'
import GallerySessionPanel from '../components/GallerySessionPanel'
import SmartImage from '../components/ui/SmartImage'
import type { Film, FilmPlayback } from '../../../../server/showcase-schema'
import { readShowcaseDetail } from './showcasePrompts'
import './inspiration.css'

const VideoPlayer = lazy(() => import('./VideoPlayer'))
const excerpt = (text: string, length = 50) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, length)

function Search({ value, onChange, onSubmit, inputRef, label }: any) {
  const { t } = useLang()
  return <form className="inspiration-search" role="search" onSubmit={event => { event.preventDefault(); onSubmit?.() }}>
    <MagnifyingGlass size={19} />
    <input ref={inputRef} value={value} onChange={event => onChange(event.target.value)} placeholder={label} aria-label={label} />
    {value ? <button type="button" aria-label={t('filter.search.clear')} onClick={() => { onChange(''); onSubmit?.('') }}><X size={16} /></button> : <kbd>/</kbd>}
  </form>
}

function ImageCard({ item, index, onSelect }: any) {
  const { lang: uiLang } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  const title = excerpt(item.title?.[contentLang(uiLang) === 'zh' ? 0 : 1] || item.localized_prompt || item.prompt_text, 55)
  const hasVideo = !!item.videos?.length
  const ratio = hasVideo ? 16 / 9 : item._ratio > .5 && item._ratio < 2 ? item._ratio : .85
  const sources = hasVideo && item.videos[0].poster ? [assetUrl(item.videos[0].poster), ...firstImageSources(item)] : firstImageSources(item)
  return <article className="inspiration-image-card masonry-item" data-prompt-id={item.tweet_id}>
    <button type="button" onClick={onSelect} aria-label={title}>
      <div className="inspiration-image-media" style={{ aspectRatio: ratio }}>
        <SmartImage sources={sources} alt={title} eager={index < 4} className="h-full w-full" />
        {!!item.videos?.length && <span className="inspiration-image-video"><Play size={13} weight="fill" />{L('视频')}</span>}
      </div>
      <h3>{title}</h3>
      <p>{item.tool && item.tool !== 'None' ? item.tool : L('创作参考')}</p>
    </button>
  </article>
}

function MediaLibrary({ notify, inputRef, media }: any) {
  const archive = usePromptArchiveApi({ media, unified: true })
  const { lang: uiLang, t } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  const zh = contentLang(uiLang) === 'zh'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const items = archive.visibleItems
  const selected = items.findIndex((item: any) => item.tweet_id === selectedId)
  const close = useCallback(() => setSelectedId(null), [])
  const step = useCallback((delta: number) => {
    if (items.length) setSelectedId(items[(selected + delta + items.length) % items.length].tweet_id)
  }, [items, selected])
  useEffect(() => { if (archive.focusId) setSelectedId(archive.focusId) }, [archive.focusId])
  const groupNames: Record<string, string> = { theme: L('视频题材'), subject_type: L('主体'), visual_style: L('视觉风格'), scene: L('场景'), composition: L('构图'), camera_lens: L('镜头'), lighting: L('光照'), human_attributes: L('人物'), quality_flags: L('质量'), workflow: L('工作流'), color_palette: L('色彩'), mood: L('氛围'), usage: L('用途') }
  const tagGroups = Object.entries(archive.tags.reduce((groups: Record<string, any[]>, tag: any) => { const group = tag.value.split(':')[0]; (groups[group] ||= []).push(tag); return groups }, {})).sort(([a], [b]) => Object.keys(groupNames).indexOf(a) - Object.keys(groupNames).indexOf(b))
  const tagLabels = useMemo(() => new Map(archive.tags.map((tag: any) => [tag.value, tag.label])), [archive.tags])
  return <>
    <Search value={archive.query} onChange={archive.setQuery} onSubmit={archive.submitQuery} inputRef={inputRef} label={L('搜索主题、风格、镜头或模型…')} />
    <div className="inspiration-image-filters">
      <select aria-label={L('模型筛选')} value={archive.selectedTool} onChange={event => archive.setSelectedTool(event.target.value)}><option value="">{L('全部模型')}</option>{archive.tools.map((tool: string) => <option key={tool}>{tool}</option>)}</select>
      <select aria-label={L('标签')} value={archive.selectedTag} onChange={event => archive.setSelectedTag(event.target.value)}><option value="">{t('filter.allTags')}</option>{tagGroups.map(([group, tags]) => <optgroup key={group} label={groupNames[group] || t('filter.moreTags')}>{(tags as any[]).map(tag => <option key={tag.value} value={tag.value}>{tag.label}</option>)}</optgroup>)}</select>
      <select aria-label={L('排序')} value={archive.sortOrder} onChange={event => archive.setSortOrder(event.target.value)}><option value="newest">{L('最近更新')}</option><option value="oldest">{L('最早收录')}</option></select>
      <span>{new Intl.NumberFormat().format(archive.filteredCount)} {L('个结果')}</span>
      {archive.hasActiveFilters && <button onClick={archive.resetFilters}>{L('重置筛选')}</button>}
    </div>
    <GallerySessionPanel session={archive.gallerySession} missingReferences={archive.missingSessionReferences} onCopied={notify} />
    <div className="inspiration-image-gallery"><PromptGallery items={items} loading={archive.loading} error={archive.error} hasMore={archive.hasMore} onLoadMore={archive.loadMore} onRetry={archive.retry} onReset={archive.resetFilters} onSelect={(item: any) => setSelectedId(item.tweet_id)} onCopied={notify} hasActiveFilters={archive.hasActiveFilters} tagLabels={tagLabels} preserveOrder={!!archive.gallerySession} Card={ImageCard} /></div>
    {selected >= 0 && <FilmDetail key={items[selected].tweet_id} archiveItem={items[selected]} film={{ id: items[selected].tweet_id, title: items[selected].title || [excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90), excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90)], category: items[selected].videos?.length ? [L('视频提示词'), L('视频提示词')] : [L('图片提示词'), L('图片提示词')], poster: firstImageSources(items[selected])[0] || '', video: '', hasPrompt: !!items[selected].prompt_text, model: items[selected].tool === 'None' ? '' : items[selected].tool, sourceUrl: items[selected].tweet_url } as Film} onClose={close} onStep={step} notify={notify} />}
  </>
}

function FilmDetail({ film, version = '', archiveItem, onClose, onStep, notify }: { film: Film; version?: string; archiveItem?: any; onClose: () => void; onStep: (delta: number) => void; notify: (text: string) => void }) {
  const { lang: uiLang } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  // film.category / title 等数据只有中/英两份，按内容语言选下标；界面文字走 L()。
  const locale = contentLang(uiLang) === 'zh' ? 0 : 1
  const zh = locale === 0
  const [prompt, setPrompt] = useState('')
  const [filmPlayback, setFilmPlayback] = useState<FilmPlayback | undefined>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retry, setRetry] = useState(0)
  const [mediaIndex, setMediaIndex] = useState(0)
  const [showTranslation, setShowTranslation] = useState(false)
  const [filmTranslation, setFilmTranslation] = useState<{ zh: boolean; text: string } | null>(null)
    const archiveMedia = useMemo(() => archiveItem ? mediaItems(archiveItem).sort((a, b) => Number(b.type.startsWith('video')) - Number(a.type.startsWith('video'))) : [], [archiveItem])
  const currentMedia = archiveMedia[mediaIndex]
  const localized = archiveItem ? archiveItem.localized_prompt : filmTranslation?.zh === zh ? filmTranslation.text : ''
  const translated = localized && localized !== prompt ? localized : ''
  const published = archiveItem?.created_at ? new Date(archiveItem.created_at) : null
  const publishedAt = published && !Number.isNaN(published.getTime()) ? new Intl.DateTimeFormat(intlLocale(uiLang)).format(published) : ''
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    setPrompt(archiveItem?.prompt_text || ''); setFailed(false); setLoading(!archiveItem); setCopied(false); setMediaIndex(0); setShowTranslation(false)
    setFilmTranslation(null); setFilmPlayback(archiveItem?.playback)
    if (!archiveItem) {
      readShowcaseDetail(film.id, version, controller.signal)
        .then(detail => {
          if (controller.signal.aborted) return
          setPrompt(detail.prompt); setFilmPlayback(detail.playback)
          setFilmTranslation({ zh, text: detail.translations[zh ? 'zh-Hans' : 'en'] || '' })
        })
        .catch(() => { if (!controller.signal.aborted) setFailed(true) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }
    return () => { controller.abort(); clearTimeout(copyTimer.current) }
  }, [film.id, version, retry, archiveItem, zh])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'; closeRef.current?.focus()
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const controls = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],video[controls],[tabindex="0"]') || [])]
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', keys)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keys); previous?.focus() }
  }, [onClose])
  async function copy() {
    try { await writeClipboard(prompt); setCopied(true); copyTimer.current = setTimeout(() => setCopied(false), 1800) }
    catch { notify(L('复制失败，请重试')) }
  }
  function useInCanvas(type: 'prompt' | 'reference') {
    try {
      const reference = archiveItem?.images?.[0] || { local: null, url: new URL(film.poster, 'https://miaoimg.cn').href }
      writeLibrarySelection(type === 'prompt' ? { mode: type, type, text: prompt } : { mode: type, type, images: [{ local: reference.local || null, url: reference.url || null }] })
      location.href = '/'
    } catch (error) { notify((error as Error).message) }
  }
  return <div className="inspiration-modal-mask" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="inspiration-detail" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="film-detail-title">
      <header><span>{archiveItem ? L('提示词灵感') : L('视频灵感')} <small> / {film.category[locale]}</small></span><div><button onClick={() => onStep(-1)} aria-label={L('上一条作品')}><ArrowLeft size={18} /></button><button onClick={() => onStep(1)} aria-label={L('下一条作品')}><ArrowRight size={18} /></button><button ref={closeRef} onClick={onClose} aria-label={L('关闭详情')}><X size={21} /></button></div></header>
      <div className="inspiration-detail-body"><div className="inspiration-screen">
        {archiveItem && currentMedia?.type !== 'video' ? <div className="inspiration-still"><SmartImage key={film.id + '-' + mediaIndex} sources={currentMedia?.sources || [film.poster]} alt={film.title[locale]} eager fit="contain" className="h-full w-full" />{currentMedia?.type === 'video-link' && <p>{L('这条记录未提供可播放的原片，请查看原作来源。')}</p>}</div> : <Suspense fallback={<img src={film.poster} alt={film.title[locale]} />}><VideoPlayer playback={filmPlayback} key={film.id + '-' + mediaIndex} source={archiveItem ? currentMedia.sources[0] : film.video} poster={currentMedia?.poster || film.poster} title={film.title[locale]} /></Suspense>}
        {archiveMedia.length > 1 && <div className="inspiration-media-nav"><button onClick={() => setMediaIndex(value => (value - 1 + archiveMedia.length) % archiveMedia.length)} aria-label={L('上一份素材')}><ArrowLeft size={16} /></button><span>{currentMedia?.type.startsWith('video') ? L('视频') : L('图片')} · {mediaIndex + 1} / {archiveMedia.length}</span><button onClick={() => setMediaIndex(value => (value + 1) % archiveMedia.length)} aria-label={L('下一份素材')}><ArrowRight size={16} /></button></div>}
        <div className="inspiration-film-context"><span>{film.category[locale]}</span><h2 id="film-detail-title">{film.title[locale]}</h2>{'summary' in film && <p>{film.summary?.[locale] || film.summary?.[0]}</p>}{archiveItem?.author && <p>@{archiveItem.author}{publishedAt && ` · ${publishedAt}`}</p>}<a href={archiveItem ? currentMedia?.sourceUrl || archiveItem.tweet_url : film.video} target="_blank" rel="noreferrer">{currentMedia?.type === 'image' ? L('查看原图') : L('打开完整原片')}<ArrowUpRight size={14} /></a></div></div>
      <aside className="inspiration-prompt-panel"><div className="inspiration-prompt-heading"><BookOpen size={18} /><h3>{showTranslation ? L('提示词译文') : L('原始提示词')}</h3>{'model' in film && <small>{film.model}</small>}</div>
        {translated && <button className="inspiration-translate" onClick={() => setShowTranslation(value => !value)}>{showTranslation ? L('查看原文') : L('查看译文')}</button>}
        <div className="inspiration-prompt-scroll">{loading ? <p className="inspiration-muted">{L('正在读取提示词…')}</p> : failed ? <div className="inspiration-empty"><p>{L('提示词暂时无法读取')}</p><button onClick={() => setRetry(value => value + 1)}>{L('重新读取')}</button></div> : prompt ? <pre>{showTranslation ? translated : prompt}</pre> : <div className="inspiration-empty"><BookOpen size={30} /><p>{L('先从画面里找到灵感。')}</p><span>{L('这条作品的原始提示词暂未收录。你仍可观看原片，或将封面带入画布作参考。')}</span></div>}</div>
        <div className="inspiration-prompt-actions">{prompt && <button className="inspiration-action-secondary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? L('已复制') : L('复制原始提示词')}</button>}{prompt && <button className="inspiration-action-primary" onClick={() => useInCanvas('prompt')}><Sparkle size={17} />{L('带入画布创作')}<ArrowUpRight size={16} /></button>}<button className="inspiration-action-secondary" onClick={() => useInCanvas('reference')}><Images size={17} />{L('以封面作参考')}</button>{'sourceUrl' in film && film.sourceUrl && <a href={film.sourceUrl} target="_blank" rel="noreferrer">{L('查看原作来源')}<ArrowUpRight size={13} /></a>}</div>
      </aside></div>
    </div>
  </div>
}

export default function InspirationLibrary({ embedded = false }: { embedded?: boolean }) {
  const { lang: uiLang } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  useEffect(() => {
    if (embedded) return
    const previous = document.title; document.title = L('灵感库')
    return () => { document.title = previous }
  }, [embedded, uiLang])
  const [media, setMedia] = useState<'image' | 'video'>('image')
  const [toast, setToast] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const notify = useCallback((text: string) => { clearTimeout(timer.current); setToast(text); timer.current = setTimeout(() => setToast(''), 2600) }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === '/' && !event.isComposing && !(event.target as Element)?.closest('input,textarea,select,[contenteditable="true"]')) { event.preventDefault(); input.current?.focus() }
    }
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('keydown', key); clearTimeout(timer.current) }
  }, [])
  return <div className={embedded ? 'inspiration-app is-embedded' : 'inspiration-app'} id={embedded ? 'studio-inspiration' : undefined}>
    {!embedded && window.miaoDesktop && <div className="inspiration-titlebar">{L('灵感库')}</div>}
    {!embedded && <aside className="inspiration-sidebar"><a className="inspiration-brand" href="/"><img src="/miaoimg-logo.png" alt="" /><strong>{isChineseLang(uiLang) ? '妙图' : 'MiaoImg'}</strong></a><nav aria-label={L('灵感库')}>{(['image', 'video'] as const).map(value => <button key={value} aria-current={media === value ? 'page' : undefined} onClick={() => setMedia(value)}>{value === 'image' ? <Images size={20} /> : <FilmStrip size={20} />}{L(value === 'image' ? '图片' : '视频')}</button>)}</nav><div className="inspiration-sidebar-bottom"><a href="/"><ArrowLeft size={17} />{L('返回创作画布')}</a><LanguageControl compact /></div></aside>}
    <main className="inspiration-main">
      {embedded && <div className="inspiration-embedded-tabs" role="tablist" aria-label={L('灵感库')}>{(['image', 'video'] as const).map(value => <button key={value} type="button" role="tab" aria-selected={media === value} onClick={() => setMedia(value)}>{L(value === 'image' ? '图片' : '视频')}</button>)}</div>}
      <MediaLibrary key={media} media={media} notify={notify} inputRef={input} />
    </main>
    {toast && <FeedbackNotice message={toast} error={false} />}
  </div>
}
