import { lazy, Suspense, useEffect, useState } from 'react'
import { ArrowRight, DotsThree, FolderSimple, House, MagnifyingGlass, Plus } from '@phosphor-icons/react'
import './studioHome.css'
import { systemTrashName } from '../lib/systemTrash'

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

function stamp(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(date)
}

function uniqueName(projects: ProjectItem[]) {
  const names = new Set(projects.map(item => item.name))
  if (!names.has('未命名')) return '未命名'
  for (let index = 2; index < 80; index += 1) if (!names.has(`未命名 ${index}`)) return `未命名 ${index}`
  return `未命名 ${new Date().getHours()}${new Date().getMinutes()}`
}

export default function StudioHome({ csrf, owner, active = 'home', initialSection = 'home', sectionRequest = 0, onOpen, onRemoved }: StudioHomeProps) {
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
    if (!response.ok || !Array.isArray(data.projects)) throw new Error(data.error || '项目列表读取失败')
    setProjects(data.projects)
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
    if (!response.ok) throw new Error(data.error || '项目操作失败')
    return data
  }

  async function createAndOpen() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = await mutate('/api/imagine/workspace/projects', { name: uniqueName(projects) })
      const id = data.project?.id
      if (!id) throw new Error('没有拿到新项目')
      onOpen(id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '新建失败')
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
    catch (failure) { setError(failure instanceof Error ? failure.message : '重命名失败') }
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
    const bin = systemTrashName()
    if (item.id === 'default' || !window.confirm(`删除「${item.name}」？\n\n项目里的画布、素材和文档会移到电脑的${bin}。想彻底释放空间，在${bin}里清空即可。`)) return
    setBusy(true)
    try {
      await mutate('/api/imagine/workspace/projects/remove', { id: item.id })
      onRemoved?.(item.id)
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : '删除失败') }
    finally { setBusy(false) }
  }

  const recent = [...projects].sort((left, right) => Date.parse(right.lastOpenedAt || right.createdAt || '') - Date.parse(left.lastOpenedAt || left.createdAt || '')).slice(0, 4)
  const keyword = query.trim().toLowerCase()
  const shown = pane === 'projects' ? projects.filter(item => !keyword || item.name.toLowerCase().includes(keyword)) : recent

  return (
    <div className="studio-home">
      <nav aria-label="项目">
        <button type="button" aria-current={pane === 'home' ? 'page' : undefined} onClick={() => setPane('home')}><House size={18} />首页</button>
        <button type="button" aria-current={pane === 'projects' ? 'page' : undefined} onClick={() => { setPane('projects'); document.getElementById('studio-projects')?.scrollIntoView({ block: 'start' }) }}><FolderSimple size={18} />项目</button>
        <button type="button" onClick={() => document.getElementById('studio-inspiration')?.scrollIntoView({ block: 'start' })}>创作精选</button>
      </nav>
      <div className="studio-home__main">
        <section className="studio-home__hero" aria-label="新建画布创作">
          <button type="button" onClick={() => void createAndOpen()} disabled={busy}>
            <span><Plus size={22} /></span>
            新建画布创作
          </button>
        </section>
        <section className="studio-home__section" id="studio-projects">
          <header>
            <h2>{pane === 'projects' ? '全部项目' : '最近项目'}</h2>
            {pane === 'home' ? <button type="button" onClick={() => setPane('projects')}>查看全部 <ArrowRight size={14} /></button>
              : <label className="studio-home__search"><MagnifyingGlass size={15} /><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索项目" aria-label="搜索项目" /></label>}
          </header>
          {status === 'error' && <button type="button" className="studio-home__retry" onClick={() => { setStatus('loading'); load().catch(failure => { setStatus('error'); setError(failure.message) }) }}>{error || '读取失败，点击重试'}</button>}
          {status === 'loading' && <div className="studio-home__grid">{[0, 1, 2, 3].map(item => <div className="studio-home__card is-loading" key={item} />)}</div>}
          {status === 'ready' && <div className="studio-home__grid">
            {shown.map(item => (
              <article key={item.id}>
                {renaming === item.id ? <div className="studio-home__card">
                  <span className="studio-home__mark">{previews[item.id] ? <img src={previews[item.id]} alt="" /> : Array.from(item.name || '项')[0]}</span>
                  <input className="studio-home__rename" autoFocus value={draftName} maxLength={40} aria-label="项目名称" onChange={event => setDraftName(event.target.value)}
                    onBlur={() => void rename(item)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setRenaming(null) }} />
                </div> : <button type="button" className="studio-home__card" onClick={() => onOpen(item.id)}>
                  <span className="studio-home__mark">{previews[item.id] ? <img src={previews[item.id]} alt="" /> : Array.from(item.name || '项')[0]}</span>
                  <span><strong>{item.name}</strong><small>{stamp(item.lastOpenedAt || item.createdAt) || '打开项目'}</small></span>
                </button>}
                {renaming !== item.id && <button type="button" className="studio-home__more" aria-label={`${item.name} 更多操作`} aria-haspopup="menu" aria-expanded={menuFor === item.id} disabled={busy} onClick={() => setMenuFor(menuFor === item.id ? null : item.id)}><DotsThree size={18} weight="bold" /></button>}
                {menuFor === item.id && <div className="studio-home__menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setMenuFor(null); onOpen(item.id) }}>打开</button>
                  <button type="button" role="menuitem" onClick={() => startRename(item)}>重命名</button>
                  {item.id !== 'default' && <button type="button" role="menuitem" className="is-danger" onClick={() => remove(item)}>删除项目</button>}
                </div>}
              </article>
            ))}
            {!shown.length && <button type="button" className="studio-home__card is-empty" onClick={() => void createAndOpen()} disabled={busy}><span className="studio-home__mark"><Plus size={18} /></span><span><strong>开始创作</strong><small>新建一个项目</small></span></button>}
          </div>}
        </section>
        <section className="studio-home__library" id="studio-inspiration" aria-label="创作精选">
          <header><h2>创作精选</h2></header>
          <Suspense fallback={<p className="studio-home__retry">正在打开创作精选…</p>}>
            <InspirationLibrary embedded />
          </Suspense>
        </section>
      </div>
    </div>
  )
}
