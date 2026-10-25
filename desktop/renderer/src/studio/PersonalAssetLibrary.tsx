import FeedbackNotice from '../components/FeedbackNotice'
import { ArrowSquareOut, FilmStrip, FolderSimple, ImageSquare, MusicNotes, X } from '@phosphor-icons/react'
import { useEffect, useMemo, useState } from 'react'
import { studioText } from './studioText'

type ProjectItem = {
  id: string
  name: string
  fileCount?: number
}

type WorkspaceEntry = {
  path: string
  mime: string
  size?: number
  revision?: string
  updatedAt?: string
}

type MediaKind = 'image' | 'video' | 'audio'
type MediaFilter = 'all' | MediaKind

type MediaItem = WorkspaceEntry & {
  kind: MediaKind
  name: string
}

type PersonalAssetLibraryProps = {
  csrf?: string
  owner?: string
  lang: 'zh' | 'en'
  project: string
  onOpenProject(id: string): void
}

function mediaKind(mime: string): MediaKind | null {
  if (/^image\//i.test(mime)) return 'image'
  if (/^video\//i.test(mime)) return 'video'
  if (/^audio\//i.test(mime)) return 'audio'
  return null
}

function fileName(path: string) {
  return path.split('/').pop() || path
}

function readableSize(value?: number) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function dateLabel(value: string | undefined, locale: string) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}

export default function PersonalAssetLibrary({ csrf, owner, lang, project, onOpenProject }: PersonalAssetLibraryProps) {
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [selectedProject, setSelectedProject] = useState(project)
  const [entries, setEntries] = useState<WorkspaceEntry[]>([])
  const [filter, setFilter] = useState<MediaFilter>('all')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [preview, setPreview] = useState<MediaItem | null>(null)

  const headers = useMemo(() => ({
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    ...(owner ? { 'x-workspace-owner': owner } : {}),
  }), [csrf, owner])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    fetch('/api/imagine/workspace/projects', { headers, cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !Array.isArray(data.projects)) throw new Error(data.error || studioText('项目列表读取失败', lang))
        const list = data.projects as ProjectItem[]
        if (controller.signal.aborted) return
        setProjects(list)
        setSelectedProject(current => list.some(item => item.id === current)
          ? current
          : list.some(item => item.id === project) ? project : list[0]?.id || '')
      })
      .catch(cause => {
        if (controller.signal.aborted) return
        setStatus('error')
        setError(cause instanceof Error ? cause.message : studioText('项目列表读取失败', lang))
      })
    return () => controller.abort()
  }, [headers, lang, project, reload])

  useEffect(() => {
    if (!selectedProject) {
      if (projects.length === 0) setStatus('ready')
      return undefined
    }
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    const params = new URLSearchParams({ project: selectedProject })
    if (owner) params.set('owner', owner)
    fetch(`/api/imagine/workspace/files?${params}`, { headers, cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok || !Array.isArray(data.entries)) throw new Error(data.error || studioText('资产读取失败', lang))
        if (!controller.signal.aborted) {
          setEntries(data.entries as WorkspaceEntry[])
          setStatus('ready')
        }
      })
      .catch(cause => {
        if (controller.signal.aborted) return
        setStatus('error')
        setError(cause instanceof Error ? cause.message : studioText('资产读取失败', lang))
      })
    return () => controller.abort()
  }, [headers, lang, owner, selectedProject, reload])

  useEffect(() => {
    if (!preview) return undefined
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(null) }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [preview])

  const media = useMemo(() => entries.flatMap(entry => {
    const kind = mediaKind(entry.mime)
    return kind ? [{ ...entry, kind, name: fileName(entry.path) } satisfies MediaItem] : []
  }).sort((left, right) => Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || '')), [entries])

  const counts = useMemo(() => ({
    all: media.length,
    image: media.filter(item => item.kind === 'image').length,
    video: media.filter(item => item.kind === 'video').length,
    audio: media.filter(item => item.kind === 'audio').length,
  }), [media])

  const visible = filter === 'all' ? media : media.filter(item => item.kind === filter)
  const selected = projects.find(item => item.id === selectedProject)

  const fileUrl = (item: MediaItem, preview = false) => {
    const params = new URLSearchParams({ project: selectedProject, path: item.path })
    if (owner) params.set('owner', owner)
    if (item.revision) params.set('v', item.revision)
    if (preview && (item.kind === 'image' || item.kind === 'video')) {
      params.set('preview', '1')
      params.set('previewSize', '320')
    }
    return `/api/imagine/workspace/files?${params}`
  }

  const chooseProject = (id: string) => {
    setSelectedProject(id)
    setFilter('all')
    setPreview(null)
  }

  return (
    <section className="asset-library" aria-labelledby="personal-assets-title">
      <header className="asset-library__header">
        <div>
          <h2 id="personal-assets-title">{studioText('个人资产库', lang)}</h2>
          <p>{studioText('按项目查看妙图项目里的图片、视频和音频，文件都保存在这台电脑上。', lang)}</p>
        </div>
        {projects.length > 0 && <div className="asset-library__actions">
          <label>
            <span>{studioText('项目', lang)}</span>
            <select value={selectedProject} onChange={event => chooseProject(event.target.value)} disabled={!projects.length}>
              {projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {selectedProject && <button type="button" onClick={() => onOpenProject(selectedProject)}>{studioText('打开项目', lang)} <ArrowSquareOut size={14} /></button>}
        </div>}
      </header>

      <div className="asset-library__toolbar">
        <div className="studio-seg" role="group" aria-label={studioText('资产类型', lang)}>
          {([
            ['all', '全部'],
            ['image', '图片'],
            ['video', '视频'],
            ['audio', '音频'],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-selected={filter === value} onClick={() => setFilter(value)}>
              {studioText(label, lang)} <span>{counts[value]}</span>
            </button>
          ))}
        </div>
        <span>{selected ? studioText('{n} 个媒体文件', lang, { n: visible.length }) : ''}</span>
      </div>

      {status === 'loading' && <p className="asset-library__state">{studioText('正在读取资产…', lang)}</p>}
      {status === 'error' && (
        <FeedbackNotice message={error} action={studioText('重试', lang)} onAction={() => setReload(value => value + 1)} />
      )}
      {status === 'ready' && projects.length === 0 && (
        <div className="asset-library__empty">
          <FolderSimple size={24} />
          <strong>{studioText('还没有妙图项目', lang)}</strong>
          <span>{studioText('新建项目并把素材放进画布后，会显示在这里。', lang)}</span>
        </div>
      )}
      {status === 'ready' && projects.length > 0 && visible.length === 0 && (
        <div className="asset-library__empty">
          <FolderSimple size={24} />
          <strong>{studioText('这个筛选下还没有素材', lang)}</strong>
          <span>{studioText('切回“全部”，或者到项目里导入图片、视频和音频。', lang)}</span>
        </div>
      )}
      {status === 'ready' && visible.length > 0 && (
        <div className="asset-grid">
          {visible.map(item => (
            <button type="button" className="asset-card" key={item.path} onClick={() => setPreview(item)} title={item.path}>
              <span className={`asset-card__media is-${item.kind}`}>
                {item.kind === 'image'
                  ? <img src={fileUrl(item, true)} alt="" loading="lazy" />
                  : item.kind === 'video'
                    ? <img src={fileUrl(item, true)} alt="" loading="lazy" />
                    : <MusicNotes size={30} aria-hidden="true" />}
                <span className="asset-card__kind">
                  {item.kind === 'image' ? <ImageSquare size={13} /> : item.kind === 'video' ? <FilmStrip size={13} /> : <MusicNotes size={13} />}
                  {studioText(item.kind === 'image' ? '图片' : item.kind === 'video' ? '视频' : '音频', lang)}
                </span>
              </span>
              <span className="asset-card__name">{item.name}</span>
              <span className="asset-card__meta">
                <span>{selected?.name || ''}</span>
                <span>{readableSize(item.size)}</span>
              </span>
              <span className="asset-card__time">{dateLabel(item.updatedAt, lang === 'en' ? 'en' : 'zh-CN')}</span>
            </button>
          ))}
        </div>
      )}

      {preview && (
        <div className="asset-preview" role="dialog" aria-modal="true" aria-label={preview.name} onMouseDown={() => setPreview(null)}>
          <div className="asset-preview__panel" onMouseDown={event => event.stopPropagation()}>
            <header>
              <div>
                <strong>{preview.name}</strong>
                <span>{preview.path}</span>
              </div>
              <button type="button" aria-label={studioText('关闭预览', lang)} onClick={() => setPreview(null)}><X size={18} /></button>
            </header>
            <div className="asset-preview__stage">
              {preview.kind === 'image' && <img src={fileUrl(preview)} alt={preview.name} />}
              {preview.kind === 'video' && <video src={fileUrl(preview)} controls autoPlay playsInline />}
              {preview.kind === 'audio' && (
                <div className="asset-preview__audio">
                  <MusicNotes size={42} />
                  <audio src={fileUrl(preview)} controls autoPlay />
                </div>
              )}
            </div>
            <footer>
              <span>{readableSize(preview.size)}</span>
              <a href={fileUrl(preview)} target="_blank" rel="noreferrer">{studioText('打开原文件', lang)} <ArrowSquareOut size={14} /></a>
            </footer>
          </div>
        </div>
      )}
    </section>
  )
}
