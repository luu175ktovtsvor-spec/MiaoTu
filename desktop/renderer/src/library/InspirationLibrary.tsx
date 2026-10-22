import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, Copy, FilmStrip, Images, MagnifyingGlass, Play, Sparkle, X } from '@phosphor-icons/react'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useLang } from '../i18n'
import { writeClipboard } from '../clipboard'
import { writeLibrarySelection } from '../libraryHandoff'
import { assetUrl, firstImageSources, mediaItems } from '../media'
import { usePromptArchiveApi } from '../hooks/usePromptArchiveApi'
import PromptGallery from '../components/PromptGallery'
import GallerySessionPanel from '../components/GallerySessionPanel'
import SmartImage from '../components/ui/SmartImage'
import catalog from './showcase.json'
import './inspiration.css'

const VideoPlayer = lazy(() => import('./VideoPlayer'))
type Film = (typeof catalog.films)[number]
const PAGE_SIZE = 24
const promptCache = new Map<string, Record<string, string>>()
const excerpt = (text: string, length = 50) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, length)

function Search({ value, onChange, onSubmit, inputRef, label }: any) {
  return <form className="inspiration-search" role="search" onSubmit={event => { event.preventDefault(); onSubmit?.() }}>
    <MagnifyingGlass size={19} />
    <input ref={inputRef} value={value} onChange={event => onChange(event.target.value)} placeholder={label} aria-label={label} />
    {value ? <button type="button" aria-label="清空搜索 / Clear search" onClick={() => { onChange(''); onSubmit?.('') }}><X size={16} /></button> : <kbd>/</kbd>}
  </form>
}

function ImageCard({ item, index, onSelect }: any) {
  const { lang } = useLang()
  const title = excerpt(item.localized_prompt || item.prompt_text, 55)
  const hasVideo = !!item.videos?.length
  const ratio = hasVideo ? 16 / 9 : item._ratio > .5 && item._ratio < 2 ? item._ratio : .85
  const sources = hasVideo && item.videos[0].poster ? [assetUrl(item.videos[0].poster), ...firstImageSources(item)] : firstImageSources(item)
  return <article className="inspiration-image-card masonry-item" data-prompt-id={item.tweet_id}>
    <button type="button" onClick={onSelect} aria-label={title}>
      <div className="inspiration-image-media" style={{ aspectRatio: ratio }}>
        <SmartImage sources={sources} alt={title} eager={index < 4} className="h-full w-full" />
        {!!item.videos?.length && <span className="inspiration-image-video"><Play size={13} weight="fill" />{lang === 'zh' ? '视频' : 'Video'}</span>}
      </div>
      <h3>{title}</h3>
      <p>{item.tool && item.tool !== 'None' ? item.tool : (lang === 'zh' ? '创作参考' : 'Creative reference')}</p>
    </button>
  </article>
}

function ImageLibrary({ selectionMode, notify, inputRef }: any) {
  const archive = usePromptArchiveApi()
  const { lang } = useLang()
  const zh = lang === 'zh'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const items = archive.visibleItems
  const selected = items.findIndex((item: any) => item.tweet_id === selectedId)
  const close = useCallback(() => setSelectedId(null), [])
  const step = useCallback((delta: number) => {
    if (items.length) setSelectedId(items[(selected + delta + items.length) % items.length].tweet_id)
  }, [items, selected])
  useEffect(() => { if (archive.focusId) setSelectedId(archive.focusId) }, [archive.focusId])
  const tagLabels = useMemo(() => new Map(archive.tags.map((tag: any) => [tag.value, tag.label])), [archive.tags])
  return <>
    <div className="inspiration-section-title"><div><span className="inspiration-kicker">THE PROMPT COLLECTION</span><h1>{zh ? '画面背后的灵感。' : 'The idea behind the image.'}</h1><p>{zh ? '图片与视频都在这里。找到喜欢的画面，读懂提示词，再带回你的画布。' : 'Images, films and the prompts behind them. Find a look and make it your own.'}</p></div><span className="inspiration-count">{new Intl.NumberFormat().format(archive.stats.prompts || 0)}<small>{zh ? '条提示词' : 'prompts'}</small></span></div>
    {!archive.gallerySession && <div className="inspiration-media-tabs" role="group" aria-label={zh ? '媒体类型' : 'Media type'}>{[['all', zh ? '全部灵感' : 'All'], ['image', zh ? '图片' : 'Images'], ['video', zh ? '视频' : 'Videos']].map(([value, label]) => <button key={value} aria-pressed={archive.selectedMedia === value} onClick={() => { setSelectedId(null); archive.setSelectedMedia(value) }}>{value === 'video' ? <FilmStrip size={16} /> : <Images size={16} />}{label}</button>)}</div>}
    <Search value={archive.query} onChange={archive.setQuery} onSubmit={archive.submitQuery} inputRef={inputRef} label={zh ? '搜索主题、风格、镜头或模型…' : 'Search subjects, styles, shots or models…'} />
    <div className="inspiration-image-filters">
      <select aria-label={zh ? '模型筛选' : 'Model'} value={archive.selectedTool} onChange={event => archive.setSelectedTool(event.target.value)}><option value="">{zh ? '全部模型' : 'All models'}</option>{archive.tools.map((tool: string) => <option key={tool}>{tool}</option>)}</select>
      <select aria-label={zh ? '视觉风格' : 'Visual style'} value={archive.selectedTag} onChange={event => archive.setSelectedTag(event.target.value)}><option value="">{zh ? '全部风格' : 'All styles'}</option>{archive.tags.map((tag: any) => <option key={tag.value} value={tag.value}>{tag.label}</option>)}</select>
      <select aria-label={zh ? '排序' : 'Order'} value={archive.sortOrder} onChange={event => archive.setSortOrder(event.target.value)}><option value="newest">{zh ? '最近更新' : 'Newest first'}</option><option value="oldest">{zh ? '最早收录' : 'Oldest first'}</option></select>
      <span>{new Intl.NumberFormat().format(archive.filteredCount)} {zh ? '个结果' : 'results'}</span>
      {archive.hasActiveFilters && <button onClick={archive.resetFilters}>{zh ? '重置筛选' : 'Reset'}</button>}
    </div>
    <GallerySessionPanel session={archive.gallerySession} missingReferences={archive.missingSessionReferences} onCopied={notify} />
    <div className="inspiration-image-gallery"><PromptGallery items={items} loading={archive.loading} error={archive.error} hasMore={archive.hasMore} onLoadMore={archive.loadMore} onRetry={archive.retry} onReset={archive.resetFilters} onSelect={(item: any) => setSelectedId(item.tweet_id)} onCopied={notify} hasActiveFilters={archive.hasActiveFilters} tagLabels={tagLabels} preserveOrder={!!archive.gallerySession} Card={ImageCard} /></div>
    {archive.datasetVersion && <p className="inspiration-muted">{zh ? '图库持续更新 · 数据版本 ' : 'Continuously updated · Dataset '}{archive.datasetVersion}</p>}
    {selected >= 0 && <FilmDetail archiveItem={items[selected]} film={{ id: items[selected].tweet_id, title: [excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90), excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90)], category: items[selected].videos?.length ? ['视频提示词', 'Video prompt'] : ['图片提示词', 'Image prompt'], poster: firstImageSources(items[selected])[0] || '', video: '', hasPrompt: !!items[selected].prompt_text, model: items[selected].tool === 'None' ? '' : items[selected].tool, sourceUrl: items[selected].tweet_url } as Film} onClose={close} onStep={step} selectionMode={selectionMode} notify={notify} />}
  </>
}

function FilmDetail({ film, archiveItem, onClose, onStep, selectionMode, notify }: { film: Film; archiveItem?: any; onClose: () => void; onStep: (delta: number) => void; selectionMode: string | null; notify: (text: string) => void }) {
  const { lang } = useLang()
  const locale = lang === 'zh' ? 0 : 1
  const zh = locale === 0
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retry, setRetry] = useState(0)
  const [mediaIndex, setMediaIndex] = useState(0)
  const [showTranslation, setShowTranslation] = useState(false)
  const archiveMedia = useMemo(() => archiveItem ? mediaItems(archiveItem).sort((a, b) => Number(b.type.startsWith('video')) - Number(a.type.startsWith('video'))) : [], [archiveItem])
  const currentMedia = archiveMedia[mediaIndex]
  const translated = archiveItem?.localized_prompt && archiveItem.localized_prompt !== archiveItem.prompt_text ? archiveItem.localized_prompt : ''
  const published = archiveItem?.created_at ? new Date(archiveItem.created_at) : null
  const publishedAt = published && !Number.isNaN(published.getTime()) ? new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en').format(published) : ''
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const file = 'promptFile' in film ? String(film.promptFile) : ''
    const controller = new AbortController()
    setPrompt(archiveItem?.prompt_text || ''); setFailed(false); setLoading(Boolean(file)); setCopied(false); setMediaIndex(0); setShowTranslation(false)
    if (file) {
      const ready = promptCache.get(file)
      const load = ready ? Promise.resolve(ready) : fetch('./' + file, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('prompt unavailable')
        const result = await response.json()
        if (promptCache.size >= 12) promptCache.delete(promptCache.keys().next().value!)
        promptCache.set(file, result)
        return result
      })
      load.then(data => { if (!controller.signal.aborted) { if (!data[film.id]) throw new Error('missing prompt'); setPrompt(data[film.id]) } }).catch(error => { if (error.name !== 'AbortError') setFailed(true) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }
    return () => { controller.abort(); clearTimeout(copyTimer.current) }
  }, [film.id, retry, archiveItem?.prompt_text])
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
    catch { notify(zh ? '复制失败，请重试' : 'Could not copy. Please retry.') }
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
      <header><span>{zh ? (archiveItem ? '提示词灵感' : '视频灵感') : 'Inspiration'} <small> / {film.category[locale]}</small></span><div><button onClick={() => onStep(-1)} aria-label={zh ? '上一条作品' : 'Previous item'}><ArrowLeft size={18} /></button><button onClick={() => onStep(1)} aria-label={zh ? '下一条作品' : 'Next item'}><ArrowRight size={18} /></button><button ref={closeRef} onClick={onClose} aria-label={zh ? '关闭详情' : 'Close details'}><X size={21} /></button></div></header>
      <div className="inspiration-detail-body"><div className="inspiration-screen">
        {archiveItem && currentMedia?.type !== 'video' ? <div className="inspiration-still"><SmartImage key={film.id + '-' + mediaIndex} sources={currentMedia?.sources || [film.poster]} alt={film.title[locale]} eager fit="contain" className="h-full w-full" />{currentMedia?.type === 'video-link' && <p>{zh ? '这条记录未提供可播放的原片，请查看原作来源。' : 'No playable clip is available. View the original source.'}</p>}</div> : <Suspense fallback={<img src={film.poster} alt={film.title[locale]} />}><VideoPlayer key={film.id + '-' + mediaIndex} source={archiveItem ? currentMedia.sources[0] : film.video} poster={currentMedia?.poster || film.poster} title={film.title[locale]} /></Suspense>}
        {archiveMedia.length > 1 && <div className="inspiration-media-nav"><button onClick={() => setMediaIndex(value => (value - 1 + archiveMedia.length) % archiveMedia.length)} aria-label={zh ? '上一份素材' : 'Previous media'}><ArrowLeft size={16} /></button><span>{currentMedia?.type.startsWith('video') ? (zh ? '视频' : 'Video') : (zh ? '图片' : 'Image')} · {mediaIndex + 1} / {archiveMedia.length}</span><button onClick={() => setMediaIndex(value => (value + 1) % archiveMedia.length)} aria-label={zh ? '下一份素材' : 'Next media'}><ArrowRight size={16} /></button></div>}
        <div className="inspiration-film-context"><span>{film.category[locale]}</span><h2 id="film-detail-title">{film.title[locale]}</h2>{'summary' in film && <p>{film.summary[locale] || film.summary[0]}</p>}{archiveItem?.author && <p>@{archiveItem.author}{publishedAt && ` · ${publishedAt}`}</p>}<a href={archiveItem ? currentMedia?.sourceUrl || archiveItem.tweet_url : film.video} target="_blank" rel="noreferrer">{zh ? (currentMedia?.type === 'image' ? '查看原图' : '打开完整原片') : 'Open original media'}<ArrowUpRight size={14} /></a></div></div>
      <aside className="inspiration-prompt-panel"><div className="inspiration-prompt-heading"><BookOpen size={18} /><h3>{zh ? (showTranslation ? '提示词译文' : '原始提示词') : (showTranslation ? 'Translated prompt' : 'Original prompt')}</h3>{'model' in film && <small>{film.model}</small>}</div>
        {translated && <button className="inspiration-translate" onClick={() => setShowTranslation(value => !value)}>{zh ? (showTranslation ? '查看原文' : '查看译文') : (showTranslation ? 'View original' : 'View translation')}</button>}
        <div className="inspiration-prompt-scroll">{loading ? <p className="inspiration-muted">{zh ? '正在读取提示词…' : 'Loading prompt…'}</p> : failed ? <div className="inspiration-empty"><p>{zh ? '提示词暂时无法读取' : 'Could not load this prompt'}</p><button onClick={() => setRetry(value => value + 1)}>{zh ? '重新读取' : 'Retry'}</button></div> : prompt ? <pre>{showTranslation ? translated : prompt}</pre> : <div className="inspiration-empty"><BookOpen size={30} /><p>{zh ? '先从画面里找到灵感。' : 'Let the film spark an idea.'}</p><span>{zh ? '这条作品的原始提示词暂未收录。你仍可观看原片，或将封面带入画布作参考。' : 'The original prompt is not available for this film. Watch the original or use its cover as a visual reference.'}</span></div>}</div>
        <div className="inspiration-prompt-actions">{prompt && <button className="inspiration-action-secondary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? (zh ? '已复制' : 'Copied') : (zh ? '复制原始提示词' : 'Copy original prompt')}</button>}{selectionMode !== 'reference' && prompt && <button className="inspiration-action-primary" onClick={() => useInCanvas('prompt')}><Sparkle size={17} />{zh ? '带入画布创作' : 'Use on canvas'}<ArrowUpRight size={16} /></button>}{selectionMode !== 'prompt' && <button className="inspiration-action-secondary" onClick={() => useInCanvas('reference')}><Images size={17} />{zh ? '以封面作参考' : 'Use cover as reference'}</button>}{'sourceUrl' in film && film.sourceUrl && <a href={film.sourceUrl} target="_blank" rel="noreferrer">{zh ? '查看原作来源' : 'View original source'}<ArrowUpRight size={13} /></a>}</div>
      </aside></div>
    </div>
  </div>
}

export default function InspirationLibrary({ selectionMode = null, embedded = false }: { selectionMode?: string | null; embedded?: boolean }) {
  const { lang, setLang } = useLang()
  const locale = lang === 'zh' ? 0 : 1, zh = locale === 0
  const [tab, setTab] = useState(() => ['session', 'focus', 'q', 'pick'].some(key => new URLSearchParams(location.search).has(key)) ? 'prompts' : 'films')
  const [query, setQuery] = useState(''), [theme, setTheme] = useState('all'), [page, setPage] = useState(0)
  const [promptOnly, setPromptOnly] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const input = useRef<HTMLInputElement>(null)
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const matching = useMemo(() => catalog.films.filter(film => (theme === 'all' || film.theme === theme) && (!promptOnly || film.hasPrompt) && (!deferredQuery || [film.title.join(' '), film.category.join(' '), 'summary' in film ? film.summary.join(' ') : '', 'model' in film ? film.model : ''].join(' ').toLowerCase().includes(deferredQuery))), [theme, deferredQuery, promptOnly])
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE)), currentPage = Math.min(page, pages - 1)
  const shown = matching.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const selected = selectedId ? matching.find(film => film.id === selectedId) : null
  const close = useCallback(() => setSelectedId(null), [])
  const step = useCallback((delta: number) => setSelectedId(current => matching[(matching.findIndex(film => film.id === current) + delta + matching.length) % matching.length]?.id || null), [matching])
  const notify = useCallback((text: string) => { clearTimeout(toastTimer.current); setToast(text); toastTimer.current = setTimeout(() => setToast(''), 2600) }, [])
  useEffect(() => { setPage(0) }, [theme, deferredQuery, promptOnly])
  useEffect(() => {
    if (embedded) return undefined
    const previous = document.title; document.title = zh ? '妙图 · 创作灵感' : 'MiaoImg · Inspiration'
    const referrer = document.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'; document.head.appendChild(referrer)
    return () => { document.title = previous; referrer.remove() }
  }, [embedded, zh])
  useEffect(() => {
    const search = (event: KeyboardEvent) => {
      if (event.key === '/' && !selectedId && !event.isComposing && !(event.target as Element)?.closest('input,textarea,select,[contenteditable="true"]')) { event.preventDefault(); input.current?.focus() }
    }
    document.addEventListener('keydown', search)
    return () => { document.removeEventListener('keydown', search); clearTimeout(toastTimer.current) }
  }, [selectedId])
  const featured = catalog.films.find(film => film.id === 'extra-c27c28c33e87') || catalog.films[0]
  const sideFeatured = catalog.films.find(film => film.id === 'extra-9b7e2d16b997') || catalog.films[1]
  return <div className={embedded ? 'inspiration-app is-embedded' : 'inspiration-app'} id={embedded ? 'studio-inspiration' : undefined}>
    {!embedded && window.miaoDesktop && <div className="inspiration-titlebar">{zh ? '妙图 · 创作灵感' : 'MiaoImg · Inspiration'}</div>}
    {!embedded && <aside className="inspiration-sidebar"><a className="inspiration-brand" href="/"><img src="/miaoimg-logo.png" alt="" /><strong>妙图<small>MIAOIMG</small></strong></a><span className="inspiration-nav-label">{zh ? '发现与探索' : 'DISCOVER'}</span><nav aria-label={zh ? '案例导航' : 'Cases navigation'}><button aria-current={tab === 'films' ? 'page' : undefined} onClick={() => setTab('films')}><FilmStrip size={20} />{zh ? '视频精选' : 'Curated films'}<small>{catalog.films.length}</small></button><button aria-current={tab === 'prompts' ? 'page' : undefined} onClick={() => setTab('prompts')}><Images size={20} />{zh ? '提示词灵感' : 'Prompt collection'}</button></nav><div className="inspiration-sidebar-note"><Sparkle size={22} /><p>{zh ? '你的灵感，值得被创造。' : 'Your ideas deserve to be created.'}</p><span>{zh ? '从画面到提示词，继续你的创作。' : 'From a reference to your next creation.'}</span></div><div className="inspiration-sidebar-bottom"><a href="/"><ArrowLeft size={17} />{zh ? '返回创作画布' : 'Back to canvas'}</a><button onClick={() => setLang(zh ? 'en' : 'zh')}>{zh ? '中文 / EN' : 'EN / 中文'}</button></div></aside>}
    <main className="inspiration-main">{embedded ? <div className="inspiration-embedded-tabs" role="tablist" aria-label={zh ? '案例' : 'Cases'}><button type="button" role="tab" aria-selected={tab === 'films'} onClick={() => setTab('films')}>{zh ? '视频精选' : 'Films'}</button><button type="button" role="tab" aria-selected={tab === 'prompts'} onClick={() => setTab('prompts')}>{zh ? '提示词' : 'Prompts'}</button></div> : <div className="inspiration-topline"><span>{zh ? '创作资源' : 'CREATIVE RESOURCES'}<i>/</i>{zh ? '案例' : 'CASES'}</span><a href="/">{zh ? '打开画布' : 'Open canvas'}<ArrowUpRight size={15} /></a></div>}
    {selectionMode && <div className="inspiration-selection">{zh ? (selectionMode === 'prompt' ? '选择一条提示词，继续画布中的创作。' : '选择一张图片或视频封面，作为画布参考。') : 'Choose a reference to continue on your canvas.'}<a href="/?library=1">{zh ? '取消选择' : 'Cancel selection'}</a></div>}
    {tab === 'prompts' ? <ImageLibrary selectionMode={selectionMode} notify={notify} inputRef={input} /> : <>
      {!embedded && <div className="inspiration-section-title"><div><span className="inspiration-kicker">A PLACE FOR YOUR NEXT IDEA</span><h1>{zh ? '创造你的无限可能。' : 'Create your infinite possibilities.'}</h1><p>{zh ? '浏览精彩作品，拆解创作提示，把喜欢的灵感带回画布。' : 'Explore remarkable films, find their prompts, and bring an idea to your canvas.'}</p></div></div>}
      {!embedded && !query && theme === 'all' && !promptOnly && currentPage === 0 && <div className="inspiration-featured"><button className="inspiration-featured-main" onClick={() => setSelectedId(featured.id)}><img src={featured.poster} alt={featured.title[locale]} fetchPriority="high" /><div><span className="inspiration-featured-label">{zh ? '本期灵感 · 动画与想象' : 'IN FOCUS · ANIMATION & IMAGINATION'}</span><h2>{zh ? '想象力，不止一种表达。' : 'Imagination takes many forms.'}</h2><span className="inspiration-featured-watch"><Play size={14} weight="fill" />{zh ? '探索这条作品' : 'Explore this film'}</span></div></button><button className="inspiration-featured-side" onClick={() => setSelectedId(sideFeatured.id)}><img src={sideFeatured.poster} alt={sideFeatured.title[locale]} /><div><span>{zh ? '换一个创作视角' : 'A DIFFERENT PERSPECTIVE'}</span><h2>{zh ? '让平常，变得不寻常。' : 'Make the ordinary extraordinary.'}</h2><span className="inspiration-round-play"><Play size={15} weight="fill" /></span></div></button></div>}
      <div className="inspiration-browse-heading"><h2>{zh ? '探索作品' : 'Explore the collection'}<span>{matching.length}</span></h2><Search value={query} onChange={setQuery} inputRef={input} label={zh ? '搜索作品、题材或镜头灵感' : 'Search films, themes or shot ideas'} /></div>
      <div className="inspiration-filters"><div className="inspiration-themes" role="group" aria-label={zh ? '视频题材' : 'Film themes'}>{[{ id: 'all', category: [zh ? '全部作品' : 'All films', 'All films'] }, ...catalog.themes].map(item => <button key={item.id} aria-pressed={theme === item.id} onClick={() => setTheme(item.id)}>{item.category[locale]}</button>)}</div><label className="inspiration-prompt-filter"><input type="checkbox" checked={promptOnly} onChange={event => setPromptOnly(event.target.checked)} />{zh ? '有原始提示词' : 'Original prompt available'}</label></div>
      <div className="inspiration-film-grid">{shown.map((film, index) => <article className="inspiration-film-card" key={film.id} data-film-id={film.id}><button onClick={() => setSelectedId(film.id)} aria-label={`${zh ? '查看作品' : 'Explore'} · ${film.title[locale]}`}><div className="inspiration-film-cover"><img src={film.poster} alt={film.title[locale]} loading="lazy" decoding="async" /><span className="inspiration-card-play"><Play size={18} weight="fill" /></span><span className="inspiration-card-category">{film.category[locale]}</span></div><div className="inspiration-film-meta"><h3>{film.title[locale]}</h3><span>{film.hasPrompt ? <><BookOpen size={12} />{zh ? '原始提示词' : 'Original prompt'}</> : <><FilmStrip size={12} />{zh ? '作品欣赏' : 'Film reference'}</>}</span><ArrowUpRight className="inspiration-card-arrow" size={17} /></div></button></article>)}</div>
      {!matching.length && <div className="inspiration-empty inspiration-no-results"><MagnifyingGlass size={32} /><h3>{zh ? '换个词，再找找灵感。' : 'Try another idea.'}</h3><p>{zh ? '试试“广告”“动画”或“旅行”，也可以重置筛选。' : 'Try advertising, animation or travel, or reset the filters.'}</p><button onClick={() => { setQuery(''); setTheme('all'); setPromptOnly(false) }}>{zh ? '重置筛选' : 'Reset filters'}</button></div>}
      {!!matching.length && <div className="inspiration-pagination"><span>{zh ? `共 ${matching.length} 条作品` : `${matching.length} films`}</span><div><button disabled={currentPage === 0} aria-label={zh ? '上一页' : 'Previous page'} onClick={() => { setPage(currentPage - 1); document.querySelector('.inspiration-browse-heading')?.scrollIntoView({ block: 'start' }) }}><ArrowLeft size={17} /></button><span>{currentPage + 1} <small>/ {pages}</small></span><button disabled={currentPage >= pages - 1} aria-label={zh ? '下一页' : 'Next page'} onClick={() => { setPage(currentPage + 1); document.querySelector('.inspiration-browse-heading')?.scrollIntoView({ block: 'start' }) }}><ArrowRight size={17} /></button></div><small>{zh ? '点击作品，查看原片与创作提示' : 'Open a film to discover the prompt'}</small></div>}
    </>}
    {!embedded && <footer className="inspiration-footer"><span>妙图 MiaoImg</span><span>{zh ? '让灵感继续发生。' : 'Keep the inspiration going.'}</span></footer>}</main>
    {selected && <FilmDetail film={selected} onClose={close} onStep={step} selectionMode={selectionMode} notify={notify} />}
    {toast && <div className="inspiration-toast" role="status">{toast}</div>}
  </div>
}
