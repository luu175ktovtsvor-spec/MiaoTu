import FeedbackNotice from '../components/FeedbackNotice'
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, Copy, FilmStrip, Images, MagnifyingGlass, Play, Sparkle, X } from '@phosphor-icons/react'
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
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
import catalog from './showcase.json'
import { readOriginalPrompt, readPromptTranslation } from './showcasePrompts'
import './inspiration.css'

const VideoPlayer = lazy(() => import('./VideoPlayer'))
type Film = (typeof catalog.films)[number]
const PAGE_SIZE = 24
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
  const title = excerpt(item.localized_prompt || item.prompt_text, 55)
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

function ImageLibrary({ notify, inputRef }: any) {
  const archive = usePromptArchiveApi()
  const { lang: uiLang } = useLang()
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
  const tagLabels = useMemo(() => new Map(archive.tags.map((tag: any) => [tag.value, tag.label])), [archive.tags])
  return <>
    <div className="inspiration-section-title"><div><span className="inspiration-kicker">THE PROMPT COLLECTION</span><h1>{L('画面背后的灵感。')}</h1><p>{L('图片与视频都在这里。找到喜欢的画面，读懂提示词，再带回你的画布。')}</p></div><span className="inspiration-count">{new Intl.NumberFormat().format(archive.stats.prompts || 0)}<small>{L('条提示词')}</small></span></div>
    {!archive.gallerySession && <div className="inspiration-media-tabs" role="group" aria-label={L('媒体类型')}>{[['all', L('全部灵感')], ['image', L('图片')], ['video', L('视频')]].map(([value, label]) => <button key={value} aria-pressed={archive.selectedMedia === value} onClick={() => { setSelectedId(null); archive.setSelectedMedia(value) }}>{value === 'video' ? <FilmStrip size={16} /> : <Images size={16} />}{label}</button>)}</div>}
    <Search value={archive.query} onChange={archive.setQuery} onSubmit={archive.submitQuery} inputRef={inputRef} label={L('搜索主题、风格、镜头或模型…')} />
    <div className="inspiration-image-filters">
      <select aria-label={L('模型筛选')} value={archive.selectedTool} onChange={event => archive.setSelectedTool(event.target.value)}><option value="">{L('全部模型')}</option>{archive.tools.map((tool: string) => <option key={tool}>{tool}</option>)}</select>
      <select aria-label={L('视觉风格')} value={archive.selectedTag} onChange={event => archive.setSelectedTag(event.target.value)}><option value="">{L('全部风格')}</option>{archive.tags.map((tag: any) => <option key={tag.value} value={tag.value}>{tag.label}</option>)}</select>
      <select aria-label={L('排序')} value={archive.sortOrder} onChange={event => archive.setSortOrder(event.target.value)}><option value="newest">{L('最近更新')}</option><option value="oldest">{L('最早收录')}</option></select>
      <span>{new Intl.NumberFormat().format(archive.filteredCount)} {L('个结果')}</span>
      {archive.hasActiveFilters && <button onClick={archive.resetFilters}>{L('重置筛选')}</button>}
    </div>
    <GallerySessionPanel session={archive.gallerySession} missingReferences={archive.missingSessionReferences} onCopied={notify} />
    <div className="inspiration-image-gallery"><PromptGallery items={items} loading={archive.loading} error={archive.error} hasMore={archive.hasMore} onLoadMore={archive.loadMore} onRetry={archive.retry} onReset={archive.resetFilters} onSelect={(item: any) => setSelectedId(item.tweet_id)} onCopied={notify} hasActiveFilters={archive.hasActiveFilters} tagLabels={tagLabels} preserveOrder={!!archive.gallerySession} Card={ImageCard} /></div>
    {archive.datasetVersion && <p className="inspiration-muted">{L('图库持续更新 · 数据版本 ')}{archive.datasetVersion}</p>}
    {selected >= 0 && <FilmDetail key={items[selected].tweet_id} archiveItem={items[selected]} film={{ id: items[selected].tweet_id, title: [excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90), excerpt(items[selected].localized_prompt || items[selected].prompt_text, 90)], category: items[selected].videos?.length ? [L('视频提示词'), L('视频提示词')] : [L('图片提示词'), L('图片提示词')], poster: firstImageSources(items[selected])[0] || '', video: '', hasPrompt: !!items[selected].prompt_text, model: items[selected].tool === 'None' ? '' : items[selected].tool, sourceUrl: items[selected].tweet_url } as Film} onClose={close} onStep={step} notify={notify} />}
  </>
}

function FilmDetail({ film, archiveItem, onClose, onStep, notify }: { film: Film; archiveItem?: any; onClose: () => void; onStep: (delta: number) => void; notify: (text: string) => void }) {
  const { lang: uiLang } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  // film.category / title 等数据只有中/英两份，按内容语言选下标；界面文字走 L()。
  const locale = contentLang(uiLang) === 'zh' ? 0 : 1
  const zh = locale === 0
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retry, setRetry] = useState(0)
  const [mediaIndex, setMediaIndex] = useState(0)
  const [showTranslation, setShowTranslation] = useState(false)
  const [filmTranslation, setFilmTranslation] = useState<{ zh: boolean; text: string } | null>(null)
  const [translationFailed, setTranslationFailed] = useState(false)
  const [translationRetry, setTranslationRetry] = useState(0)
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
    const file = 'promptFile' in film ? String(film.promptFile) : ''
    const controller = new AbortController()
    setPrompt(archiveItem?.prompt_text || ''); setFailed(false); setLoading(Boolean(file)); setCopied(false); setMediaIndex(0); setShowTranslation(false)
    if (file) {
      readOriginalPrompt(file, film.id, controller.signal)
        .then(text => { if (!controller.signal.aborted) setPrompt(text) })
        .catch(() => { if (!controller.signal.aborted) setFailed(true) })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }
    return () => { controller.abort(); clearTimeout(copyTimer.current) }
  }, [film.id, retry, archiveItem?.prompt_text])
  useEffect(() => {
    const controller = new AbortController()
    setFilmTranslation(null); setTranslationFailed(false); setShowTranslation(false)
    const file = 'translationFile' in film ? String(film.translationFile) : ''
    if (!archiveItem && file) {
      readPromptTranslation(file, film.id, zh ? 'zh-Hans' : 'en', controller.signal)
        .then(text => { if (!controller.signal.aborted) setFilmTranslation({ zh, text }) })
        .catch(() => { if (!controller.signal.aborted) setTranslationFailed(true) })
    }
    return () => controller.abort()
  }, [film.id, zh, archiveItem, translationRetry])
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
        {archiveItem && currentMedia?.type !== 'video' ? <div className="inspiration-still"><SmartImage key={film.id + '-' + mediaIndex} sources={currentMedia?.sources || [film.poster]} alt={film.title[locale]} eager fit="contain" className="h-full w-full" />{currentMedia?.type === 'video-link' && <p>{L('这条记录未提供可播放的原片，请查看原作来源。')}</p>}</div> : <Suspense fallback={<img src={film.poster} alt={film.title[locale]} />}><VideoPlayer key={film.id + '-' + mediaIndex} source={archiveItem ? currentMedia.sources[0] : film.video} poster={currentMedia?.poster || film.poster} title={film.title[locale]} /></Suspense>}
        {archiveMedia.length > 1 && <div className="inspiration-media-nav"><button onClick={() => setMediaIndex(value => (value - 1 + archiveMedia.length) % archiveMedia.length)} aria-label={L('上一份素材')}><ArrowLeft size={16} /></button><span>{currentMedia?.type.startsWith('video') ? L('视频') : L('图片')} · {mediaIndex + 1} / {archiveMedia.length}</span><button onClick={() => setMediaIndex(value => (value + 1) % archiveMedia.length)} aria-label={L('下一份素材')}><ArrowRight size={16} /></button></div>}
        <div className="inspiration-film-context"><span>{film.category[locale]}</span><h2 id="film-detail-title">{film.title[locale]}</h2>{'summary' in film && <p>{film.summary[locale] || film.summary[0]}</p>}{archiveItem?.author && <p>@{archiveItem.author}{publishedAt && ` · ${publishedAt}`}</p>}<a href={archiveItem ? currentMedia?.sourceUrl || archiveItem.tweet_url : film.video} target="_blank" rel="noreferrer">{currentMedia?.type === 'image' ? L('查看原图') : L('打开完整原片')}<ArrowUpRight size={14} /></a></div></div>
      <aside className="inspiration-prompt-panel"><div className="inspiration-prompt-heading"><BookOpen size={18} /><h3>{showTranslation ? L('提示词译文') : L('原始提示词')}</h3>{'model' in film && <small>{film.model}</small>}</div>
        {translated && <button className="inspiration-translate" onClick={() => setShowTranslation(value => !value)}>{showTranslation ? L('查看原文') : L('查看译文')}</button>}
        {translationFailed && prompt && <button className="inspiration-translate" onClick={() => setTranslationRetry(value => value + 1)}>{L('译文暂时无法读取 · 重试')}</button>}
        <div className="inspiration-prompt-scroll">{loading ? <p className="inspiration-muted">{L('正在读取提示词…')}</p> : failed ? <div className="inspiration-empty"><p>{L('提示词暂时无法读取')}</p><button onClick={() => setRetry(value => value + 1)}>{L('重新读取')}</button></div> : prompt ? <pre>{showTranslation ? translated : prompt}</pre> : <div className="inspiration-empty"><BookOpen size={30} /><p>{L('先从画面里找到灵感。')}</p><span>{L('这条作品的原始提示词暂未收录。你仍可观看原片，或将封面带入画布作参考。')}</span></div>}</div>
        <div className="inspiration-prompt-actions">{prompt && <button className="inspiration-action-secondary" onClick={copy}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? L('已复制') : L('复制原始提示词')}</button>}{prompt && <button className="inspiration-action-primary" onClick={() => useInCanvas('prompt')}><Sparkle size={17} />{L('带入画布创作')}<ArrowUpRight size={16} /></button>}<button className="inspiration-action-secondary" onClick={() => useInCanvas('reference')}><Images size={17} />{L('以封面作参考')}</button>{'sourceUrl' in film && film.sourceUrl && <a href={film.sourceUrl} target="_blank" rel="noreferrer">{L('查看原作来源')}<ArrowUpRight size={13} /></a>}</div>
      </aside></div>
    </div>
  </div>
}

export default function InspirationLibrary({ embedded = false }: { embedded?: boolean }) {
  const { lang: uiLang } = useLang()
  const L = (zh: string, vars?: Record<string, unknown>) => studioText(zh, uiLang, vars)
  const locale = contentLang(uiLang) === 'zh' ? 0 : 1, zh = locale === 0
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
    const previous = document.title; document.title = L('妙图 · 创作灵感')
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
    {!embedded && window.miaoDesktop && <div className="inspiration-titlebar">{L('妙图 · 创作灵感')}</div>}
    {!embedded && <aside className="inspiration-sidebar"><a className="inspiration-brand" href="/"><img src="/miaoimg-logo.png" alt="" /><strong>{isChineseLang(uiLang) ? <>妙图<small>MIAOIMG</small></> : 'MiaoImg'}</strong></a><span className="inspiration-nav-label">{L('发现与探索')}</span><nav aria-label={L('案例导航')}><button aria-current={tab === 'films' ? 'page' : undefined} onClick={() => setTab('films')}><FilmStrip size={20} />{L('视频精选')}<small>{catalog.films.length}</small></button><button aria-current={tab === 'prompts' ? 'page' : undefined} onClick={() => setTab('prompts')}><Images size={20} />{L('提示词灵感')}</button></nav><div className="inspiration-sidebar-note"><Sparkle size={22} /><p>{L('你的灵感，值得被创造。')}</p><span>{L('从画面到提示词，继续你的创作。')}</span></div><div className="inspiration-sidebar-bottom"><a href="/"><ArrowLeft size={17} />{L('返回创作画布')}</a><LanguageControl compact /></div></aside>}
    <main className="inspiration-main">{embedded ? <div className="inspiration-embedded-tabs" role="tablist" aria-label={L('案例')}><button type="button" role="tab" aria-selected={tab === 'films'} onClick={() => setTab('films')}>{L('视频精选')}</button><button type="button" role="tab" aria-selected={tab === 'prompts'} onClick={() => setTab('prompts')}>{L('提示词')}</button></div> : <div className="inspiration-topline"><span>{L('创作资源')}<i>/</i>{L('案例')}</span><a href="/">{L('打开画布')}<ArrowUpRight size={15} /></a></div>}
    {tab === 'prompts' ? <ImageLibrary notify={notify} inputRef={input} /> : <>
      {!embedded && <div className="inspiration-section-title"><div><span className="inspiration-kicker">A PLACE FOR YOUR NEXT IDEA</span><h1>{L('创造你的无限可能。')}</h1><p>{L('浏览精彩作品，拆解创作提示，把喜欢的灵感带回画布。')}</p></div></div>}
      {!embedded && !query && theme === 'all' && !promptOnly && currentPage === 0 && <div className="inspiration-featured"><button className="inspiration-featured-main" onClick={() => setSelectedId(featured.id)}><img src={featured.poster} alt={featured.title[locale]} fetchPriority="high" /><div><span className="inspiration-featured-label">{L('本期灵感 · 动画与想象')}</span><h2>{L('想象力，不止一种表达。')}</h2><span className="inspiration-featured-watch"><Play size={14} weight="fill" />{L('探索这条作品')}</span></div></button><button className="inspiration-featured-side" onClick={() => setSelectedId(sideFeatured.id)}><img src={sideFeatured.poster} alt={sideFeatured.title[locale]} /><div><span>{L('换一个创作视角')}</span><h2>{L('让平常，变得不寻常。')}</h2><span className="inspiration-round-play"><Play size={15} weight="fill" /></span></div></button></div>}
      <div className="inspiration-browse-heading"><h2>{L('探索作品')}<span>{matching.length}</span></h2><Search value={query} onChange={setQuery} inputRef={input} label={L('搜索作品、题材或镜头灵感')} /></div>
      <div className="inspiration-filters"><div className="inspiration-themes" role="group" aria-label={L('视频题材')}>{[{ id: 'all', category: [L('全部作品'), L('全部作品')] }, ...catalog.themes].map(item => <button key={item.id} aria-pressed={theme === item.id} onClick={() => setTheme(item.id)}>{item.category[locale]}</button>)}</div><label className="inspiration-prompt-filter"><input type="checkbox" checked={promptOnly} onChange={event => setPromptOnly(event.target.checked)} />{L('有原始提示词')}</label></div>
      <div className="inspiration-film-grid">{shown.map((film, index) => <article className="inspiration-film-card" key={film.id} data-film-id={film.id}><button onClick={() => setSelectedId(film.id)} aria-label={`${L('查看作品')} · ${film.title[locale]}`}><div className="inspiration-film-cover"><img src={film.poster} alt={film.title[locale]} loading="lazy" decoding="async" /><span className="inspiration-card-play"><Play size={18} weight="fill" /></span><span className="inspiration-card-category">{film.category[locale]}</span></div><div className="inspiration-film-meta"><h3>{film.title[locale]}</h3><span>{film.hasPrompt ? <><BookOpen size={12} />{L('原始提示词')}</> : <><FilmStrip size={12} />{L('作品欣赏')}</>}</span><ArrowUpRight className="inspiration-card-arrow" size={17} /></div></button></article>)}</div>
      {!matching.length && <div className="inspiration-empty inspiration-no-results"><MagnifyingGlass size={32} /><h3>{L('换个词，再找找灵感。')}</h3><p>{L('试试“广告”“动画”或“旅行”，也可以重置筛选。')}</p><button onClick={() => { setQuery(''); setTheme('all'); setPromptOnly(false) }}>{L('重置筛选')}</button></div>}
      {!!matching.length && <div className="inspiration-pagination"><span>{L('共 {n} 条作品', { n: matching.length })}</span><div><button disabled={currentPage === 0} aria-label={L('上一页')} onClick={() => { setPage(currentPage - 1); document.querySelector('.inspiration-browse-heading')?.scrollIntoView({ block: 'start' }) }}><ArrowLeft size={17} /></button><span>{currentPage + 1} <small>/ {pages}</small></span><button disabled={currentPage >= pages - 1} aria-label={L('下一页')} onClick={() => { setPage(currentPage + 1); document.querySelector('.inspiration-browse-heading')?.scrollIntoView({ block: 'start' }) }}><ArrowRight size={17} /></button></div><small>{L('点击作品，查看原片与创作提示')}</small></div>}
    </>}
    {!embedded && <footer className="inspiration-footer"><span>{L('妙图 MiaoImg')}</span><span>{L('让灵感继续发生。')}</span></footer>}</main>
    {selected && <FilmDetail key={selected.id} film={selected} onClose={close} onStep={step} notify={notify} />}
    {toast && <FeedbackNotice message={toast} error={false} />}
  </div>
}
