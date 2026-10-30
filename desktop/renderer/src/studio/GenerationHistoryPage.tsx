import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { ArrowClockwise, ArrowLeft, ArrowRight, FilmStrip, ImageSquare, Plus, Sparkle } from '@phosphor-icons/react'
import { useLang } from '../i18n'
import FeedbackNotice from '../components/FeedbackNotice'
import StudioPicker from './StudioPicker'
import ModelLogo from './ModelLogo'
import LocalTaskRecovery from './LocalTaskRecovery'
import HistoryResultDialog from './HistoryResultDialog'
import { HistoryCard } from './historyView'
import { HISTORY_KINDS } from './history'
import { studioPage, studioRecords, studioText } from './studioText'
import type { HistoryItem, HistoryProgress, HistoryState } from './studioState'
import './historyPage.css'

type ProjectEntry = { id: string; name?: string }
type HistoryModel = { id: string; label?: string; group?: string }
export type GenerationHistoryPageProps = {
  lang: string; locale: string; owner: string; project: string; state: HistoryState
  progress: Record<string, HistoryProgress>; now: number; kind: string; model: string; models: HistoryModel[]
  onKind(value: string): void; onModel(value: string): void; onPage(page: number): void
  onProject(value: string): void; onRefresh(): void; onCreate(): void; signedIn: boolean; onLogin(): void
}

function dateKey(value?: string) {
  const date = new Date(value || '')
  return Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export default function GenerationHistoryPage(props: GenerationHistoryPageProps) {
  const { lang, locale, owner, project, state, progress, now, kind, model, models, signedIn } = props
  const { t } = useLang()
  const L = (text: string) => studioText(text, lang)
  const tabsId = useId()
  const [projects, setProjects] = useState<{ owner: string; items: ProjectEntry[] }>({ owner: '', items: [] })
  const [selection, setSelection] = useState<{ scope: string; id: string } | null>(null)
  const closeSelection = useCallback(() => setSelection(null), [])
  const scope = `${owner}:${project}`
  const stateMatches = (!state.owner || state.owner === owner) && (!state.project || state.project === project)
  const items = stateMatches ? state.items : []
  const busy = !stateMatches || state.status === 'loading' || state.status === 'idle'
  const selected = selection?.scope === scope ? items.find(item => (item.requestId || item.id) === selection.id) : null

  useEffect(() => {
    if (!signedIn || !owner) return
    const controller = new AbortController()
    fetch('./api/imagine/workspace/projects', { signal: controller.signal, cache: 'no-store' })
      .then(async response => response.ok ? response.json() : null)
      .then(data => {
        if (!controller.signal.aborted && Array.isArray(data?.projects)) {
          setProjects({ owner, items: data.projects.filter(item => typeof item.id === 'string') })
        }
      })
      .catch(() => { /* A project list failure must not hide the selected project's history. */ })
    return () => controller.abort()
  }, [owner, signedIn])

  useEffect(() => { setSelection(null) }, [scope, kind, model, state.page])

  const projectOptions = projects.owner === owner ? projects.items.map(item => ({ value: item.id, label: item.name || L('项目') })) : []
  if (!projectOptions.some(item => item.value === project)) projectOptions.unshift({ value: project, label: L('项目') })
  const modelOptions = [{ value: '', label: L('全部模型') }, ...models.map(item => ({ value: item.id, label: item.label || item.id, group: item.group, leading: <ModelLogo model={item.id} size={17} /> }))]
  if (model && !modelOptions.some(item => item.value === model)) modelOptions.push({ value: model, label: model })

  const groups = useMemo(() => {
    const grouped = new Map<string, { date?: string; items: HistoryItem[] }>()
    for (const item of items) {
      const key = dateKey(item.created_at)
      const group = grouped.get(key) || { date: item.created_at, items: [] }
      group.items.push(item); grouped.set(key, group)
    }
    return [...grouped.entries()]
  }, [items])
  const formatDay = (value?: string) => {
    const date = new Date(value || '')
    if (Number.isNaN(date.getTime())) return '—'
    return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' as const }) }).format(date)
  }
  const pageCount = Math.max(1, Math.ceil(state.total / Math.max(1, state.limit)))

  function selectKind(value: string) {
    if (value === kind) return
    if (model) props.onModel('')
    props.onKind(value)
  }

  return <main className="studio-record generation-history-page">
    <header className="generation-history-header">
      <div className="generation-history-heading"><h1>{L('生成历史')}</h1><span className="generation-history-total">{!busy || items.length ? studioRecords(state.total, lang) : '—'}</span></div>
      <div className="generation-history-actions">
        <button type="button" className="generation-history-refresh" aria-label={t('studio.reload')} aria-busy={busy || state.refreshing} onClick={props.onRefresh} disabled={busy}><ArrowClockwise size={17} />{t('studio.reload')}</button>
        <button type="button" className="generation-history-create" onClick={props.onCreate}><Plus size={16} />{L('去画布')}</button>
      </div>
    </header>

    {!signedIn ? <section className="generation-history-empty generation-history-signin">
      <span className="generation-history-empty__icon"><ImageSquare size={25} /></span>
      <h2>{L('登录后可查看生成记录')}</h2>
      <button type="button" className="generation-history-create" onClick={props.onLogin}>{L('登录查看')}</button>
    </section> : <>
      <section className="generation-history-toolbar" aria-label={L('生成历史')}>
        <div className="generation-history-kinds" role="tablist" aria-label={L('生成类型')}>
          {HISTORY_KINDS.map(([value, label], index) => <button key={value} type="button" id={`${tabsId}-${value}`} role="tab" aria-controls={`${tabsId}-panel`} aria-selected={kind === value} tabIndex={kind === value ? 0 : -1} onClick={() => selectKind(value)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? HISTORY_KINDS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + HISTORY_KINDS.length) % HISTORY_KINDS.length
            selectKind(HISTORY_KINDS[next][0]); document.getElementById(`${tabsId}-${HISTORY_KINDS[next][0]}`)?.focus()
          }}>{value === 'image' ? <ImageSquare size={15} /> : value === 'video' ? <FilmStrip size={15} /> : <Sparkle size={15} />}{L(label)}</button>)}
        </div>
        <div className="generation-history-pickers">
          <StudioPicker compact label={L('项目')} value={project} options={projectOptions} onChange={props.onProject} />
          <StudioPicker compact label={L('模型筛选')} value={model} options={modelOptions} onChange={props.onModel} />
        </div>
      </section>

      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${kind}`}>
      {state.error && <FeedbackNotice message={state.error} action={t('studio.reload')} onAction={props.onRefresh} />}
      {busy && !items.length ? <div className="generation-history-skeleton" role="status" aria-label={L('正在读取历史记录…')}>
        {Array.from({ length: 6 }, (_, index) => <div className="generation-history-skeleton-card" key={index}><span /><i /><i /></div>)}
      </div> : !items.length && state.status === 'ready' && !state.error ? <section className="generation-history-empty">
        <span className="generation-history-empty__icon"><Sparkle size={25} /></span>
        <h2>{L('还没有生成记录')}</h2><p>{L('去画布上做第一张吧，出的图和视频都会留在这里。')}</p>
        <button type="button" className="generation-history-create" onClick={props.onCreate}><Plus size={15} />{L('去画布')}</button>
      </section> : <div className="generation-history-groups" aria-busy={state.refreshing || undefined}>
        {groups.map(([key, group]) => <section className="generation-history-day" key={key}>
          <h2>{formatDay(group.date)}</h2>
          <div className="generation-history-grid">
            {group.items.map(item => <article className="generation-history-entry" key={item.requestId || item.id} data-request-id={item.requestId || item.id}>
              <HistoryCard item={item} lang={lang} locale={locale} progress={progress} now={now} onOpen={entry => setSelection({ scope, id: entry.requestId || entry.id || '' })} />
              <LocalTaskRecovery recovery={item.localRecovery} lang={lang} />
            </article>)}
          </div>
        </section>)}
      </div>}

      {state.total > state.limit && <nav className="generation-history-pagination" aria-label={L('生成历史')}>
        <span>{studioRecords(state.total, lang)}</span>
        <div><button type="button" aria-label={L('上一页')} disabled={busy || state.refreshing || state.page <= 1} onClick={() => props.onPage(Math.max(1, state.page - 1))}><ArrowLeft size={16} /></button><span>{studioPage(state.page, pageCount, lang)}</span><button type="button" aria-label={L('下一页')} disabled={busy || state.refreshing || state.page >= pageCount} onClick={() => props.onPage(state.page + 1)}><ArrowRight size={16} /></button></div>
      </nav>}
      </div>
    </>}
    {selected && <HistoryResultDialog key={`${scope}:${selected.requestId || selected.id}`} item={selected} lang={lang} locale={locale} progress={progress[selected.requestId]} now={now} onClose={closeSelection} />}
  </main>
}
