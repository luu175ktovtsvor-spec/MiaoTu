import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, ArrowLeft, ChatCircleText, CheckCircle, EnvelopeSimple, Tray, MagnifyingGlass, Paperclip, PaperPlaneTilt, Tag, UserCircle } from '@phosphor-icons/react'
import { ADMIN_API_BASE } from './api-base'
import { isDiscardedAdminRequest } from './useAdminSession'
import './feedback.css'

type Api = (path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<any>
type View = 'open' | 'unread' | 'closed' | 'all'
type FeedbackItem = {
  id: string; number: number; title: string; category: string; status: string; unread: boolean;
  labels: string[]; comments: number; attachments: number; createdAt: string; updatedAt: string;
  user?: { id: string; name: string; email: string };
}
type FeedbackDetail = FeedbackItem & {
  body: string; context: Record<string, string>;
  thread: { id: string; author: string; body: string; createdAt: string }[];
  files: { id: string; name: string }[];
}
type FeedbackList = { items: FeedbackItem[]; total: number; page: number; limit: number; stats: { open: number; closed: number; unread: number } }
const CATEGORY = { bug: ['问题', 'Bug'], feature: ['建议', 'Idea'], question: ['咨询', 'Question'] } as const
const LABELS = [['已确认', 'Confirmed'], ['处理中', 'In progress'], ['已修复', 'Fixed'], ['下个版本', 'Next release'], ['无法复现', 'Cannot reproduce'], ['重复', 'Duplicate']] as const

export default function AdminFeedback({ api, lang }: { api: Api; lang: string }) {
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  const [view, setView] = useState<View>('open')
  const [category, setCategory] = useState(''), [search, setSearch] = useState(''), [query, setQuery] = useState(''), [page, setPage] = useState(1)
  const [list, setList] = useState<FeedbackList>({ items: [], total: 0, page: 1, limit: 30, stats: { open: 0, closed: 0, unread: 0 } })
  const [loaded, setLoaded] = useState(false), [listLoading, setListLoading] = useState(true), [detailLoading, setDetailLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null), [detail, setDetail] = useState<FeedbackDetail | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false)
  const [listError, setListError] = useState(''), [detailError, setDetailError] = useState(''), [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0), [detailRefresh, setDetailRefresh] = useState(0)
  const activeId = useRef(selectedId), mounted = useRef(true), mutation = useRef(false), listRevision = useRef(0)
  activeId.current = selectedId
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 200); return () => clearTimeout(timer) }, [search])
  useEffect(() => {
    const controller = new AbortController(), revision = ++listRevision.current
    setListLoading(true); setListError('')
    const params = new URLSearchParams({ page: String(page), limit: '30', search: query, category,
      status: view === 'open' || view === 'closed' ? view : '', ...(view === 'unread' ? { unread: '1' } : {}) })
    api(`feedback?${params}`, 'GET', undefined, controller.signal).then(data => {
      if (controller.signal.aborted || revision !== listRevision.current) return
      // Reading an unread item or closing the last item can shrink the current page.
      const lastPage = Math.max(1, Math.ceil(data.total / data.limit))
      if (page > lastPage) { setPage(lastPage); return }
      setList(data); setLoaded(true)
    }).catch(error => { if (!controller.signal.aborted && !isDiscardedAdminRequest(error)) setListError(error.message) })
      .finally(() => { if (!controller.signal.aborted && revision === listRevision.current) setListLoading(false) })
    return () => controller.abort()
  }, [api, view, category, query, page, refresh])
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailLoading(false); setDetailError(''); return }
    const controller = new AbortController()
    setDetail(null); setDetailLoading(true); setDetailError(''); setNotice('')
    api(`feedback/${selectedId}`, 'GET', undefined, controller.signal).then(data => {
      if (!controller.signal.aborted && activeId.current === selectedId) { setDetail(data); setRefresh(value => value + 1) }
    }).catch(error => { if (!controller.signal.aborted && !isDiscardedAdminRequest(error)) setDetailError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [api, selectedId, detailRefresh])

  function resetSelection() { setSelectedId(null); setNotice(''); setDetailError('') }
  function chooseView(value: View) { setView(value); setPage(1); resetSelection() }
  const time = (value: string) => {
    const date = new Date(value)
    return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) : '—'
  }
  const categoryName = (value: string) => { const [zh, en] = CATEGORY[value as keyof typeof CATEGORY] || CATEGORY.bug; return t(zh, en) }
  const labelName = (value: string) => { const label = LABELS.find(([zh]) => zh === value); return label ? t(label[0], label[1]) : value }
  const statusName = (value: string) => value === 'closed' ? t('已关闭', 'Closed') : t('未关闭', 'Open')
  async function mutate(path: string, method: string, body: unknown, success: string, sentDraft?: string) {
    if (!detail || mutation.current) return
    const id = detail.id
    mutation.current = true; setBusy(true); setDetailError(''); setNotice('')
    try {
      const next = await api(path, method, body)
      if (!mounted.current) return
      if (sentDraft !== undefined) setDrafts(previous => previous[id] === sentDraft ? { ...previous, [id]: '' } : previous)
      if (activeId.current === id) { setDetail(next); setNotice(success) }
      setRefresh(value => value + 1)
    } catch (error: any) { if (mounted.current && activeId.current === id && !isDiscardedAdminRequest(error)) setDetailError(error.message) }
    finally { mutation.current = false; if (mounted.current) setBusy(false) }
  }
  const reply = selectedId ? drafts[selectedId] || '' : ''
  const stats = list.stats
  const views = [
    { id: 'open' as const, label: t('未关闭', 'Open'), count: stats.open, Icon: Tray },
    { id: 'unread' as const, label: t('未读消息', 'Unread'), count: stats.unread, Icon: EnvelopeSimple },
    { id: 'closed' as const, label: t('已关闭', 'Closed'), count: stats.closed, Icon: CheckCircle },
    { id: 'all' as const, label: t('全部反馈', 'All feedback'), count: stats.open + stats.closed, Icon: ChatCircleText },
  ]
  const hasFilter = Boolean(search || category)
  const hasFeedback = loaded && stats.open + stats.closed > 0
  const contextFields = detail ? [
    [t('客户端版本', 'App version'), detail.context?.appVersion], [t('系统', 'System'), detail.context?.os || detail.context?.platform],
    [t('语言', 'Language'), detail.context?.locale], [t('项目', 'Project'), detail.context?.project], [t('画布', 'Canvas'), detail.context?.canvas],
  ].filter(([, value]) => value) : []

  return <div className="feedback-desk" data-has-selection={Boolean(selectedId)}>
    <nav className="feedback-views" aria-label={t('反馈分类', 'Feedback views')}>
      {views.map(({ id, label, count, Icon }) => <button key={id} type="button" className="feedback-view" aria-current={view === id ? 'page' : undefined} disabled={busy} onClick={() => chooseView(id)}>
        <span className="feedback-view-icon"><Icon size={23} /></span><span><span className="feedback-view-label">{label}</span><strong>{loaded ? count.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN') : '—'}</strong></span>
      </button>)}
    </nav>
    <div className="feedback-toolbar">
      <label className="feedback-search"><MagnifyingGlass size={20} /><input type="search" aria-label={t('搜索反馈', 'Search feedback')} placeholder={t('搜索标题、内容、用户或 #编号', 'Search title, message, user or #number')} value={search} disabled={busy} onChange={event => { setSearch(event.target.value); setPage(1); resetSelection() }} /></label>
      <select aria-label={t('反馈类型', 'Feedback type')} value={category} disabled={busy} onChange={event => { setCategory(event.target.value); setPage(1); resetSelection() }}><option value="">{t('全部类型', 'All types')}</option>{Object.entries(CATEGORY).map(([key, [zh, en]]) => <option key={key} value={key}>{t(zh, en)}</option>)}</select>
      {hasFilter && <button type="button" disabled={busy} onClick={() => { setSearch(''); setQuery(''); setCategory(''); setPage(1); resetSelection() }}>{t('清除筛选', 'Clear filters')}</button>}
      <button type="button" disabled={busy || listLoading} onClick={() => setRefresh(value => value + 1)}><ArrowClockwise size={18} />{t('刷新列表', 'Refresh list')}</button>
    </div>
    {listError && <div className="feedback-error" role="alert">{listError}<button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></div>}
    <div className="feedback-workspace">
      <section className="feedback-queue" aria-label={t('反馈列表', 'Feedback list')} aria-busy={listLoading}>
        <header className="feedback-queue-header"><div><h2>{t('反馈列表', 'Feedback list')}<span>{loaded ? list.total.toLocaleString() : '—'}</span></h2><p>{t('未读优先 · 最近更新', 'Unread first · Recently updated')}</p></div></header>
        {listLoading ? <div className="feedback-queue-empty" role="status">{t('正在加载反馈…', 'Loading feedback…')}</div> : listError ? <div className="feedback-queue-empty">{t('列表加载失败，请重试。', 'Could not load the list. Try again.')}</div> : !list.items.length ? <div className="feedback-queue-empty"><Tray size={36} /><h3>{hasFilter ? t('没有匹配的反馈', 'No matching feedback') : view === 'unread' ? t('未读反馈已处理完', 'No unread feedback') : view === 'closed' ? t('暂无已关闭反馈', 'No closed feedback') : view === 'all' ? t('暂无反馈', 'No feedback yet') : t('暂无未关闭反馈', 'No open feedback')}</h3><p>{hasFilter ? t('换个关键词，或清除筛选。', 'Try a different search or clear the filters.') : t('用户提交的问题和建议会在这里汇总。', 'Questions and ideas from users appear here.')}</p></div> : <ul className="feedback-items">{list.items.map(item => <li key={item.id}>
          <button type="button" className="feedback-item" aria-current={selectedId === item.id ? 'true' : undefined} disabled={busy} onClick={() => { if (selectedId === item.id) setDetailRefresh(value => value + 1); else setSelectedId(item.id) }}>
            <span className="feedback-item-top"><span className={`feedback-type ${item.category}`}>{categoryName(item.category)}</span><span className="feedback-number">#{item.number}</span><span className="feedback-item-unread">{item.unread && <><i />{t('未读', 'Unread')}</>}</span></span>
            <strong className="feedback-item-title">{item.title}</strong>
            <span className="feedback-item-user"><UserCircle size={17} /><span>{item.user?.name || item.user?.email || t('用户', 'User')}</span><span className={`feedback-status ${item.status}`}>{statusName(item.status)}</span></span>
            <span className="feedback-item-bottom"><time dateTime={item.updatedAt}>{time(item.updatedAt)}</time><span>{item.attachments > 0 && <span><Paperclip size={14} />{item.attachments}</span>}{item.comments > 0 && <span><ChatCircleText size={14} />{item.comments}</span>}</span></span>
          </button>
        </li>)}</ul>}
        <footer className="feedback-pagination"><span>{loaded ? `${page} / ${Math.max(1, Math.ceil(list.total / list.limit))}` : '—'}</span><div><button type="button" aria-label={t('上一页反馈', 'Previous feedback page')} disabled={busy || listLoading || page <= 1} onClick={() => { setPage(value => value - 1); resetSelection() }}>{t('上一页', 'Previous')}</button><button type="button" aria-label={t('下一页反馈', 'Next feedback page')} disabled={busy || listLoading || page * list.limit >= list.total} onClick={() => { setPage(value => value + 1); resetSelection() }}>{t('下一页', 'Next')}</button></div></footer>
      </section>
      <section className="feedback-case" aria-label={t('反馈详情', 'Feedback details')} aria-busy={detailLoading}>
        <button type="button" className="feedback-back" disabled={busy} onClick={resetSelection}><ArrowLeft size={18} />{t('返回反馈列表', 'Back to feedback list')}</button>
        {detailLoading ? <div className="feedback-case-empty" role="status"><ChatCircleText size={42} /><h2>{t('正在打开反馈…', 'Opening feedback…')}</h2></div> : !detail ? <div className="feedback-case-empty"><span className="feedback-empty-icon"><ChatCircleText size={42} /></span><h2>{detailError ? t('未能打开这条反馈', 'Could not open this feedback') : hasFeedback ? t('选择一条反馈，开始处理', 'Select feedback to get started') : t('用户反馈处理台', 'Your feedback workspace')}</h2><p>{detailError || t('问题描述、截图、用户环境和回复记录，集中在这里查看。', 'Read the issue, screenshots, user context and conversation in one place.')}</p>{detailError ? <button type="button" onClick={() => setDetailRefresh(value => value + 1)}>{t('重试', 'Retry')}</button> : <div className="feedback-empty-steps"><span><b>01</b>{t('查看问题', 'Read the issue')}</span><span><b>02</b>{t('核对上下文', 'Check the context')}</span><span><b>03</b>{t('回复并跟进', 'Reply and follow up')}</span></div>}</div> : <>
          <header className="feedback-case-header"><div><div className="feedback-case-kicker"><span>#{detail.number}</span><span className={`feedback-type ${detail.category}`}>{categoryName(detail.category)}</span><span className={`feedback-status ${detail.status}`}>{statusName(detail.status)}</span></div><h2>{detail.title}</h2><p>{t('最后更新', 'Last updated')} <time dateTime={detail.updatedAt}>{time(detail.updatedAt)}</time></p></div><button type="button" className="feedback-status-action" disabled={busy} onClick={() => void mutate(`feedback/${detail.id}`, 'PATCH', { status: detail.status === 'open' ? 'closed' : 'open' }, t('处理状态已更新', 'Status updated'))}><CheckCircle size={18} />{detail.status === 'open' ? t('关闭反馈', 'Close feedback') : t('重新打开', 'Reopen feedback')}</button></header>
          <div className="feedback-case-context"><dl><div><dt>{t('提交用户', 'Submitted by')}</dt><dd>{detail.user?.name || t('用户', 'User')}<span>{detail.user?.email}</span></dd></div><div><dt>{t('提交时间', 'Submitted')}</dt><dd><time dateTime={detail.createdAt}>{time(detail.createdAt)}</time></dd></div></dl>{contextFields.length > 0 && <details className="feedback-environment"><summary>{t('用户环境', 'User environment')}<span>{[detail.context?.appVersion, detail.context?.os || detail.context?.platform].filter(Boolean).join(' · ')}</span></summary><dl>{contextFields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details>}<div className="feedback-labels"><span><Tag size={16} />{t('处理标签', 'Labels')}</span><div>{LABELS.map(([label]) => <button key={label} type="button" aria-pressed={detail.labels.includes(label)} disabled={busy} onClick={() => void mutate(`feedback/${detail.id}`, 'PATCH', { labels: detail.labels.includes(label) ? detail.labels.filter(value => value !== label) : [...detail.labels, label] }, t('标签已更新', 'Labels updated'))}>{labelName(label)}</button>)}</div></div></div>
          <div className="feedback-conversation"><h3>{t('问题与回复', 'Conversation')}<span>{detail.thread.length + 1}</span></h3><article className="feedback-message"><header><span className="feedback-avatar"><UserCircle size={21} /></span><div><strong>{detail.user?.name || t('用户', 'User')}<span>{t('原始反馈', 'Original report')}</span></strong><time dateTime={detail.createdAt}>{time(detail.createdAt)}</time></div></header><div className="feedback-message-content"><p>{detail.body}</p>{detail.files.length > 0 && <div className="feedback-attachments">{detail.files.map(file => { const src = `${ADMIN_API_BASE}/feedback/${detail.id}/attachments/${file.id}`; return <a key={file.id} href={src} target="_blank" rel="noreferrer" aria-label={`${t('查看截图', 'View screenshot')} · ${file.name}`}><img src={src} alt={file.name} loading="lazy" /><span><Paperclip size={14} />{file.name}</span></a> })}</div>}</div></article>
            {detail.thread.map(comment => <article key={comment.id} className={`feedback-message ${comment.author === 'admin' ? 'team' : ''}`}><header><span className="feedback-avatar">{comment.author === 'admin' ? <ChatCircleText size={20} /> : <UserCircle size={21} />}</span><div><strong>{comment.author === 'admin' ? t('管理员', 'Admin') : detail.user?.name || t('用户', 'User')}<span>{comment.author === 'admin' ? t('官方回复', 'Team reply') : t('用户补充', 'User follow-up')}</span></strong><time dateTime={comment.createdAt}>{time(comment.createdAt)}</time></div></header><div className="feedback-message-content"><p>{comment.body}</p></div></article>)}
          </div>
          <form className="feedback-composer" onSubmit={event => { event.preventDefault(); if (reply.trim() && !busy) void mutate(`feedback/${detail.id}/comments`, 'POST', { body: reply }, t('回复已发送', 'Reply sent'), reply) }}><label htmlFor="feedback-reply">{t('回复用户', 'Reply to user')}</label><textarea id="feedback-reply" rows={4} value={reply} maxLength={4000} disabled={busy} onChange={event => setDrafts(previous => ({ ...previous, [detail.id]: event.target.value }))} placeholder={t('输入回复内容…', 'Write your reply…')} /><footer><p>{t('发送后，用户可在客户端查看回复。', 'The user can read your reply in the app.')}<span>{reply.length.toLocaleString()} / 4,000</span></p><button className="primary" disabled={busy || !reply.trim()}><PaperPlaneTilt size={18} />{busy ? t('正在保存…', 'Saving…') : t('发送回复', 'Send reply')}</button></footer></form>
        </>}
        {detailError && detail && <div className="feedback-error" role="alert">{detailError}</div>}{notice && <div className="feedback-notice" role="status"><CheckCircle size={18} />{notice}</div>}
      </section>
    </div>
  </div>
}
