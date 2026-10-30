import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowRight, DotsThree, FolderSimple, House, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import './studioHome.css'
import { systemTrashName } from '../lib/systemTrash'
import { useLang } from '../i18n'
import FeedbackNotice from '../components/FeedbackNotice'

const InspirationLibrary = lazy(() => import('../library/InspirationLibrary'))

type ProjectItem = { id: string; name: string; createdAt?: string | null; lastOpenedAt?: string | null; fileCount?: number }

type StudioHomeProps = {
  csrf?: string
  owner?: string
  active?: string
  initialSection?: 'home' | 'projects' | 'cases'
  sectionRequest?: number
  onOpen(id: string): void
  onRemoved?(id: string): void
}

function stamp(value: string | null | undefined, locale: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit' }).format(date)
}

function uniqueName(projects: ProjectItem[], base: string) {
  const names = new Set(projects.map(item => item.name))
  if (!names.has(base)) return base
  for (let index = 2; index < 80; index += 1) if (!names.has(`${base} ${index}`)) return `${base} ${index}`
  return `${base} ${new Date().getHours()}${new Date().getMinutes()}`
}

export default function StudioHome({ csrf, owner, active = 'home', initialSection = 'home', sectionRequest = 0, onOpen, onRemoved }: StudioHomeProps) {
  const { t, locale } = useLang()
  const [pane, setPane] = useState<'home' | 'projects'>(active === 'projects' ? 'projects' : 'home')
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [query, setQuery] = useState('')

  async function load() {
    const response = await fetch('/api/imagine/workspace/projects', {
      headers: { ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(owner ? { 'x-workspace-owner': owner } : {}) },
      cache: 'no-store',
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !Array.isArray(data.projects)) throw new Error(data.error || t('studio.home.error.load'))
    setProjects(data.projects)
    setError('')
    setStatus('ready')
    const headers = { ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(owner ? { 'x-workspace-owner': owner } : {}) }
    const found: Record<string, string> = {}
    await Promise.all(data.projects.slice(0, 8).map(async (item: ProjectItem) => {
      try {
        const response = await fetch(`/api/imagine/workspace/files?project=${encodeURIComponent(item.id)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`, { headers, cache: 'no-store' })
        const body = await response.json().catch(() => ({}))
        const file = (body.entries || []).find((entry: { mime?: string; path?: string }) => /^image\//.test(entry.mime || '') && entry.path)
        if (file?.path) found[item.id] = `/api/imagine/workspace/files?project=${encodeURIComponent(item.id)}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}&path=${encodeURIComponent(file.path)}&preview=1&previewSize=320`
      } catch { /* 封面读不到仍可进入项目 */ }
    }))
    setPreviews(found)
  }

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    load().catch(failure => { if (!cancelled) { setStatus('error'); setError(failure.message) } })
    return () => { cancelled = true }
  }, [csrf, owner])

  useEffect(() => {
    setPane(initialSection === 'projects' ? 'projects' : 'home')
    if (initialSection !== 'cases') return
    const frame = requestAnimationFrame(() => document.getElementById('studio-inspiration')?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [initialSection, sectionRequest])

  async function mutate(path: string, body: Record<string, unknown>) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(owner ? { 'x-workspace-owner': owner } : {}) },
      body: JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || t('studio.home.error.action'))
    return data
  }

  async function createAndOpen() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = await mutate('/api/imagine/workspace/projects', { name: uniqueName(projects, t('studio.home.untitled')) })
      const id = data.project?.id
      if (!id) throw new Error(t('studio.home.error.noProject'))
      onOpen(id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('studio.home.error.create'))
    } finally { setBusy(false) }
  }

  // 客户端里 window.prompt 不可用，改名直接在卡片上编辑：回车保存，Esc 取消。
  function startRename(item: ProjectItem) { setMenuFor(null); setRenaming(item.id); setDraftName(item.name) }
  async function rename(item: ProjectItem) {
    const name = draftName.trim()
    setRenaming(null)
    if (!name || name === item.name) return
    setBusy(true)
    try { await mutate('/api/imagine/workspace/projects/rename', { id: item.id, name }); await load() }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('studio.home.error.rename')) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (!menuFor) return
    const dismiss = (event: Event) => { if (!(event.target instanceof Element && event.target.closest('.studio-home__menu, .studio-home__more'))) setMenuFor(null) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuFor(null) }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [menuFor])

  async function remove(item: ProjectItem) {
    setMenuFor(null)
    const bin = t(systemTrashName() === '废纸篓' ? 'studio.home.trashMac' : 'studio.home.trashWin')
    if (!window.confirm(t('studio.home.confirmDelete', { name: item.name, bin }))) return
    setBusy(true)
    try {
      await mutate('/api/imagine/workspace/projects/remove', { id: item.id })
      onRemoved?.(item.id)
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : t('studio.home.error.delete')) }
    finally { setBusy(false) }
  }

  const recent = [...projects].sort((left, right) => Date.parse(right.lastOpenedAt || right.createdAt || '') - Date.parse(left.lastOpenedAt || left.createdAt || '')).slice(0, 4)
  const keyword = query.trim().toLowerCase()
  const shown = pane === 'projects' ? projects.filter(item => !keyword || item.name.toLowerCase().includes(keyword)) : recent

  return (
    <div className="studio-home">
      <FeedbackNotice message={error} onClose={() => setError('')} />
      <nav aria-label={t('studio.home.navLabel')}>
        <button type="button" aria-current={pane === 'home' ? 'page' : undefined} onClick={() => setPane('home')}><House size={18} />{t('studio.home.home')}</button>
        <button type="button" aria-current={pane === 'projects' ? 'page' : undefined} onClick={() => { setPane('projects'); document.getElementById('studio-projects')?.scrollIntoView({ block: 'start' }) }}><FolderSimple size={18} />{t('studio.home.projects')}</button>
        <button type="button" onClick={() => document.getElementById('studio-inspiration')?.scrollIntoView({ block: 'start' })}>{t('studio.home.featured')}</button>
      </nav>
      <div className="studio-home__main">
        <section className="studio-home__hero" aria-label={t('studio.home.newCanvas')}>
          <button type="button" onClick={() => void createAndOpen()} disabled={busy}>
            <span><Plus size={22} /></span>
            {t('studio.home.newCanvas')}
          </button>
        </section>
        <section className="studio-home__section" id="studio-projects">
          <header>
            <h2>{pane === 'projects' ? t('studio.home.all') : t('studio.home.recent')}</h2>
            {pane === 'home' ? <button type="button" onClick={() => setPane('projects')}>{t('studio.home.viewAll')} <ArrowRight size={14} /></button>
              : <label className="studio-home__search"><MagnifyingGlass size={15} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('studio.home.search')} aria-label={t('studio.home.search')} /></label>}
          </header>
          {status === 'error' && <button type="button" className="studio-home__retry" onClick={() => { setStatus('loading'); load().catch(failure => { setStatus('error'); setError(failure.message) }) }}>{t('studio.home.retry')}</button>}
          {status === 'loading' && <div className="studio-home__grid">{[0, 1, 2, 3].map(item => <div className="studio-home__card is-loading" key={item} />)}</div>}
          {status === 'ready' && <div className="studio-home__grid">
            {shown.map(item => (
              <article key={item.id}>
                {renaming === item.id ? <div className="studio-home__card">
                  <span className="studio-home__mark">{previews[item.id] ? <img src={previews[item.id]} alt="" /> : Array.from(String(item.name || t('studio.home.initial')))[0]}</span>
                  <input className="studio-home__rename" autoFocus value={draftName} maxLength={40} aria-label={t('studio.home.projectName')} onChange={event => setDraftName(event.target.value)}
                    onBlur={() => void rename(item)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null) }} />
                </div> : <button type="button" className="studio-home__card" onClick={() => onOpen(item.id)}>
                  <span className="studio-home__mark">{previews[item.id] ? <img src={previews[item.id]} alt="" /> : Array.from(String(item.name || t('studio.home.initial')))[0]}</span>
                  <span><strong>{item.name}</strong><small>{stamp(item.lastOpenedAt || item.createdAt, locale) || t('studio.home.openProject')}</small></span>
                </button>}
                {renaming !== item.id && <button type="button" className="studio-home__more" aria-label={t('studio.home.moreActions', { name: item.name })} aria-haspopup="menu" aria-expanded={menuFor === item.id} disabled={busy} onClick={() => setMenuFor(menuFor === item.id ? null : item.id)}><DotsThree size={18} weight="bold" /></button>}
                {menuFor === item.id && <div className="studio-home__menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenuFor(null); onOpen(item.id) }}>{t('studio.home.open')}</button>
                  <button type="button" role="menuitem" onClick={() => startRename(item)}>{t('studio.home.rename')}</button>
                  <button type="button" role="menuitem" className="is-danger" onClick={() => remove(item)}>{t('studio.home.delete')}</button>
                </div>}
              </article>
            ))}
            {!shown.length && <button type="button" className="studio-home__card is-empty" onClick={() => void createAndOpen()} disabled={busy}><span className="studio-home__mark"><Plus size={18} /></span><span><strong>{t('studio.home.startCreating')}</strong><small>{t('studio.home.newProject')}</small></span></button>}
          </div>}
        </section>
        <section className="studio-home__library" id="studio-inspiration" aria-label={t('studio.home.featured')}>
          <header><h2>{t('studio.home.featured')}</h2></header>
          <Suspense fallback={<p className="studio-home__retry">{t('studio.home.featuredOpening')}</p>}>
            <InspirationLibrary embedded />
          </Suspense>
        </section>
      </div>
    </div>
  )
}
