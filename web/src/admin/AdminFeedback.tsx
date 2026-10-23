import { useCallback, useEffect, useState } from 'react'
import { ChatCircleText, CheckCircle, MagnifyingGlass, PaperPlaneTilt } from '@phosphor-icons/react'
import { ADMIN_API_BASE } from './api-base'
import { isDiscardedAdminRequest } from './useAdminSession'

// 用户反馈：桌面端「反馈」页提交的问题和建议。管理员在这里回复、改状态和标签，
// 回复会出现在用户那条反馈下面，并在用户的左侧导航上显示红点。
type Api = (path: string, method?: string, body?: unknown, signal?: AbortSignal) => Promise<any>
const CATEGORY = { bug: ['问题', 'Bug'], feature: ['建议', 'Idea'], question: ['咨询', 'Question'] } as const
const LABELS = ['已确认', '处理中', '已修复', '下个版本', '无法复现', '重复']

export default function AdminFeedback({ api, lang }: { api: Api; lang: string }) {
  const t = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const [status, setStatus] = useState('open'), [category, setCategory] = useState(''), [search, setSearch] = useState(''), [unreadOnly, setUnreadOnly] = useState(false), [page, setPage] = useState(1)
  const [list, setList] = useState<any>({ items: [], total: 0, page: 1, limit: 30, stats: {} })
  const [detail, setDetail] = useState<any>(null), [reply, setReply] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const time = (value: string) => value ? new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : ''

  const load = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ page: String(page), search, status, category, ...(unreadOnly ? { unread: '1' } : {}) })
    try { const data = await api(`feedback?${params}`, 'GET', undefined, signal); if (!signal?.aborted) setList(data) }
    catch (e: any) { if (!signal?.aborted && !isDiscardedAdminRequest(e)) setError(e.message) }
  }, [api, page, search, status, category, unreadOnly])
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load])

  async function run(fn: () => Promise<any>) {
    setBusy(true); setError('')
    try { const next = await fn(); if (next?.id) setDetail(next); await load() }
    catch (e: any) { if (!isDiscardedAdminRequest(e)) setError(e.message) }
    finally { setBusy(false) }
  }
  const open = (id: string) => run(() => api(`feedback/${id}`))
  const toggleLabel = (label: string) => run(() => api(`feedback/${detail.id}`, 'PATCH', { labels: detail.labels.includes(label) ? detail.labels.filter((x: string) => x !== label) : [...detail.labels, label] }))
  const stats = list.stats || {}
  const categoryName = (value: string) => { const [zh, en] = CATEGORY[value as keyof typeof CATEGORY] || CATEGORY.bug; return t(zh, en) }

  return <div className="admin-feedback">
    <section className="admin-panel admin-feedback-list">
      <header className="admin-filter-header">
        <div className="admin-feedback-tabs" role="tablist">
          {[['open', t('处理中', 'Open'), stats.open], ['closed', t('已关闭', 'Closed'), stats.closed], ['', t('全部', 'All'), (stats.open || 0) + (stats.closed || 0)]].map(([value, label, count]) =>
            <button key={value || 'all'} role="tab" aria-selected={status === value} onClick={() => { setStatus(value); setPage(1) }}>{label}<span>{count || 0}</span></button>)}
        </div>
        <label className="admin-search"><MagnifyingGlass size={17} /><input aria-label={t('搜索反馈', 'Search feedback')} placeholder={t('标题、内容、邮箱或 #编号', 'Title, text, email or #number')} value={search} onChange={e => { setSearch(e.target.value); setPage(1) }} /></label>
        <select aria-label={t('类型', 'Type')} value={category} onChange={e => { setCategory(e.target.value); setPage(1) }}>
          <option value="">{t('全部类型', 'All types')}</option>
          {Object.entries(CATEGORY).map(([key, [zh, en]]) => <option key={key} value={key}>{t(zh, en)}</option>)}
        </select>
        <label className="admin-feedback-check"><input type="checkbox" checked={unreadOnly} onChange={e => { setUnreadOnly(e.target.checked); setPage(1) }} />{t('只看未读', 'Unread only')}{stats.unread ? ` (${stats.unread})` : ''}</label>
      </header>
      {error && <div role="alert" className="admin-message error">{error}</div>}
      {!list.items.length ? <div className="admin-empty">{t('暂无反馈', 'No feedback')}</div> : <ul>
        {list.items.map((item: any) => <li key={item.id}><button className={detail?.id === item.id ? 'active' : ''} onClick={() => open(item.id)} disabled={busy}>
          {item.status === 'open' ? <span className="admin-feedback-dot open" /> : <CheckCircle size={15} className="admin-feedback-dot" />}
          <span className="admin-feedback-main"><strong>{item.unread && <i className="admin-feedback-unread" />}{item.title}</strong>
            <small>#{item.number} · {categoryName(item.category)} · {item.user?.name || item.user?.email} · {time(item.updatedAt)}</small></span>
          {item.comments > 0 && <span className="admin-feedback-count"><ChatCircleText size={13} />{item.comments}</span>}
        </button></li>)}
      </ul>}
      {list.total > list.limit && <footer className="admin-feedback-pages"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>{t('上一页', 'Previous')}</button><span>{page} / {Math.ceil(list.total / list.limit)}</span><button disabled={page * list.limit >= list.total} onClick={() => setPage(page + 1)}>{t('下一页', 'Next')}</button></footer>}
    </section>
    <section className="admin-panel admin-feedback-detail">
      {!detail ? <div className="admin-empty">{t('选择左侧一条反馈查看详情', 'Pick a feedback item to see details')}</div> : <>
        <header><div><h2>{detail.title} <span className="admin-muted">#{detail.number}</span></h2>
          <small className="admin-muted">{categoryName(detail.category)} · {detail.user?.name} {detail.user?.email} · {t('提交于', 'Opened')} {time(detail.createdAt)}</small></div>
          <button disabled={busy} onClick={() => run(() => api(`feedback/${detail.id}`, 'PATCH', { status: detail.status === 'open' ? 'closed' : 'open' }))}>{detail.status === 'open' ? t('关闭', 'Close') : t('重新打开', 'Reopen')}</button>
        </header>
        <div className="admin-feedback-labels">{LABELS.map(label => <button key={label} className={detail.labels.includes(label) ? 'on' : ''} disabled={busy} onClick={() => toggleLabel(label)}>{label}</button>)}</div>
        <div className="admin-feedback-thread">
          <article><header>{t('用户', 'User')} · {time(detail.createdAt)}</header><p>{detail.body}</p>
            {detail.files.length > 0 && <div className="admin-feedback-files">{detail.files.map((file: any) => { const src = `${ADMIN_API_BASE}/feedback/${detail.id}/attachments/${file.id}`; return <a key={file.id} href={src} target="_blank" rel="noreferrer"><img src={src} alt={file.name} /></a> })}</div>}
            <footer>{[detail.context?.appVersion && `${t('妙图', 'MiaoImg')} ${detail.context.appVersion}`, detail.context?.os, detail.context?.locale].filter(Boolean).join(' · ')}</footer>
          </article>
          {detail.thread.map((comment: any) => <article key={comment.id} className={comment.author === 'admin' ? 'team' : ''}><header>{comment.author === 'admin' ? t('管理员', 'Admin') : t('用户', 'User')} · {time(comment.createdAt)}</header><p>{comment.body}</p></article>)}
        </div>
        <form className="admin-feedback-reply" onSubmit={e => { e.preventDefault(); if (!reply.trim()) return; void run(async () => { const next = await api(`feedback/${detail.id}/comments`, 'POST', { body: reply }); setReply(''); return next }) }}>
          <textarea rows={4} value={reply} maxLength={4000} onChange={e => setReply(e.target.value)} placeholder={t('回复会显示在用户的这条反馈下面', 'Your reply appears under this feedback for the user')} />
          <button className="primary" disabled={busy || !reply.trim()}><PaperPlaneTilt size={16} />{t('回复', 'Reply')}</button>
        </form>
      </>}
    </section>
  </div>
}
