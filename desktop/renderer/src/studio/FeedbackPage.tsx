import FeedbackNotice from '../components/FeedbackNotice'
import { ArrowLeft, ChatCircleText, CheckCircle, ImageSquare, PaperPlaneTilt, Plus, Trash, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'

// 反馈：用户在这里提交问题和建议，管理后台回复后显示在同一条反馈下面，形式类似 issue。
type Category = 'bug' | 'feature' | 'question'
type Summary = { id: string; number: number; title: string; category: Category; status: 'open' | 'closed'; labels: string[]; comments: number; attachments: number; unread: boolean; createdAt: string; updatedAt: string }
type Detail = Summary & { body: string; context: Record<string, string>; thread: { id: string; author: 'user' | 'admin'; body: string; createdAt: string }[]; files: { id: string; name: string; mime: string; size: number }[] }
type Draft = { name: string; mime: string; data: string; preview: string; size: number }

const CATEGORY: Record<Category, { zh: string; en: string; hint: string }> = {
  bug: { zh: '问题', en: 'Bug', hint: '在哪一步、怎么操作的、看到了什么，原本希望是什么样。有截图更快定位。' },
  feature: { zh: '建议', en: 'Idea', hint: '想做什么、现在卡在哪里，最好举一个具体的使用场景。' },
  question: { zh: '咨询', en: 'Question', hint: '想了解的功能、计费或账号问题，写清楚具体情况。' },
}
const MAX_FILES = 4
const MAX_FILE_BYTES = 4 * 1024 * 1024

function when(value: string, lang: 'zh' | 'en') {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date)
}
function systemName(platform = '') {
  return platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform || navigator.platform
}
export function desktopAppVersion() {
  // 安装版的应用名是「妙图」，开发版是 miaoimg-desktop-dev，两种都认。
  return navigator.userAgent.match(/(?:妙图|miaoimg-desktop(?:-dev)?)\/(\d+\.\d+\.\d+)/)?.[1] || ''
}

type FeedbackPageProps = { csrf?: string; signedIn: boolean; lang: 'zh' | 'en'; onLogin(): void; onBack(): void; onUnread?(count: number): void }

function DeleteFeedbackDialog({ item, busy, error, lang, onCancel, onDelete }: { item: Summary; busy: boolean; error: string; lang: 'zh' | 'en'; onCancel(): void; onDelete(): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close() }, [])
  return <dialog ref={dialog} className="feedback-delete-dialog" aria-labelledby="feedback-delete-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel() }}>
    <h2 id="feedback-delete-title">{t('删除反馈', 'Delete feedback')}</h2>
    <p>{item.title}</p>
    <p>{t('这条反馈及其回复和截图将被删除，无法恢复。', 'This feedback, its replies and screenshots will be permanently deleted.')}</p>
    {error && <FeedbackNotice message={error} />}
    <div className="feedback-actions">
      <button type="button" className="feedback-secondary" autoFocus disabled={busy} onClick={onCancel}>{t('取消', 'Cancel')}</button>
      <button type="button" className="feedback-danger" disabled={busy} onClick={onDelete}>{busy ? t('删除中…', 'Deleting…') : t('确认删除', 'Delete')}</button>
    </div>
  </dialog>
}

export default function FeedbackPage({ csrf, signedIn, lang, onLogin, onBack, onUnread }: FeedbackPageProps) {
  const t = (zh: string, en: string) => (lang === 'en' ? en : zh)
  const [tab, setTab] = useState<'open' | 'closed'>('open')
  const [items, setItems] = useState<Summary[]>([])
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [view, setView] = useState<'list' | 'new' | 'detail'>('list')
  const [detail, setDetail] = useState<Detail | null>(null)
  const [deleting, setDeleting] = useState<Summary | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [reply, setReply] = useState('')
  const [category, setCategory] = useState<Category>('bug'), [title, setTitle] = useState(''), [body, setBody] = useState(''), [files, setFiles] = useState<Draft[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const headers = useCallback(() => ({ 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) }), [csrf])

  const load = useCallback(async () => {
    if (!signedIn) return
    setLoading(true); setError('')
    try {
      const response = await fetch('/api/imagine/feedback?status=all', { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('反馈读取失败，请重试', 'Could not load feedback. Try again.'))
      setItems(result.items || [])
      onUnread?.(Number(result.unread) || 0)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [signedIn, onUnread])
  useEffect(() => { void load() }, [load])

  async function send(path: string, payload: unknown) {
    setBusy(true); setError('')
    try {
      const response = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(payload) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('提交失败，请重试', 'Could not submit. Try again.'))
      return result as Detail
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); return null }
    finally { setBusy(false) }
  }
  async function open(id: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/imagine/feedback/${id}`, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || t('反馈读取失败，请重试', 'Could not load feedback. Try again.'))
      setDetail(result); setReply(''); setView('detail')
      setItems(list => list.map(item => item.id === id ? { ...item, unread: false } : item))
      void load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function removeFeedback() {
    if (!deleting || busy) return
    const id = deleting.id
    setBusy(true); setDeleteError('')
    try {
      const response = await fetch(`/api/imagine/feedback/${encodeURIComponent(id)}`, { method: 'DELETE', headers: headers() })
      const result = await response.json()
      if (!response.ok || result.ok !== true) throw new Error(result.error || t('删除失败，请重试', 'Could not delete feedback. Try again.'))
      setItems(list => list.filter(item => item.id !== id))
      if (detail?.id === id) { setDetail(null); setReply(''); setView('list') }
      setDeleting(null)
      await load()
    } catch (e) { setDeleteError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  function requestDelete(item: Summary) { setDeleteError(''); setDeleting(item) }
  async function addFiles(list: FileList | File[]) {
    const accepted: Draft[] = []
    for (const file of Array.from(list)) {
      if (files.length + accepted.length >= MAX_FILES) { setError(t(`最多附带 ${MAX_FILES} 张截图`, `Up to ${MAX_FILES} screenshots`)); break }
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { setError(t('截图只支持 PNG、JPEG、WebP 或 GIF', 'Screenshots must be PNG, JPEG, WebP or GIF')); continue }
      if (file.size > MAX_FILE_BYTES) { setError(t('单张截图不能超过 4MB', 'Each screenshot must be under 4 MB')); continue }
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
      accepted.push({ name: file.name || t('截图', 'Screenshot'), mime: file.type, data: dataUrl.split(',')[1] || '', preview: dataUrl, size: file.size })
    }
    if (accepted.length) setFiles(current => [...current, ...accepted].slice(0, MAX_FILES))
  }
  function pasteImages(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'))
    if (images.length) { event.preventDefault(); void addFiles(images) }
  }
  async function submit() {
    if (!title.trim() || !body.trim()) { setError(t('请填写标题和描述', 'Add a title and a description')); return }
    const created = await send('/api/imagine/feedback', {
      title, body, category,
      context: { appVersion: desktopAppVersion(), platform: window.miaoDesktop?.platform || '', os: systemName(window.miaoDesktop?.platform), locale: navigator.language },
      attachments: files.map(({ name, mime, data }) => ({ name, mime, data })),
    })
    if (!created) return
    setTitle(''); setBody(''); setFiles([]); setCategory('bug')
    setDetail(created); setView('detail'); setTab('open'); void load()
  }

  if (!signedIn) return (
    <main className="studio-record feedback-page">
      <button type="button" className="make-back" onClick={onBack}>{t('返回', 'Back')}</button>
      <h1>{t('反馈', 'Feedback')}</h1>
      <div className="feedback-empty">
        <ChatCircleText size={36} aria-hidden="true" />
        <p>{t('登录后可以提交问题和建议，团队的回复也会显示在这里。', 'Sign in to send bugs and ideas. Replies from the team appear here.')}</p>
        <button type="button" className="feedback-primary" onClick={onLogin}>{t('登录', 'Sign in')}</button>
      </div>
    </main>
  )

  const counts = { open: items.filter(item => item.status === 'open').length, closed: items.filter(item => item.status === 'closed').length }
  const visible = items.filter(item => item.status === tab)
  const categoryLabel = (value: Category) => t(CATEGORY[value].zh, CATEGORY[value].en)

  return (
    <main className="studio-record feedback-page" onPaste={view === 'new' ? pasteImages : undefined}>
      {deleting && <DeleteFeedbackDialog item={deleting} busy={busy} error={deleteError} lang={lang} onCancel={() => { setDeleting(null); setDeleteError('') }} onDelete={() => void removeFeedback()} />}
      {view === 'list' ? <>
        <div className="feedback-heading">
          <div>
            <h1>{t('反馈', 'Feedback')}</h1>
            <p>{t('遇到问题或有想法就告诉我们。每条反馈都有人看，回复会出现在这里。', 'Tell us about bugs or ideas. Every report is read, and replies show up here.')}</p>
          </div>
          <button type="button" className="feedback-primary" onClick={() => { setView('new'); setError('') }}><Plus size={16} aria-hidden="true" />{t('新建反馈', 'New feedback')}</button>
        </div>
        <div className="feedback-tabs" role="tablist">
          {(['open', 'closed'] as const).map(value => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {value === 'open' ? t('处理中', 'Open') : t('已关闭', 'Closed')}<span>{counts[value]}</span>
            </button>
          ))}
        </div>
        {error && <FeedbackNotice message={error} onClose={() => setError('')} />}
        {loading && !items.length ? <p className="feedback-muted">{t('正在读取…', 'Loading…')}</p>
          : !visible.length ? <div className="feedback-empty"><ChatCircleText size={32} aria-hidden="true" /><p>{tab === 'open' ? t('还没有处理中的反馈。', 'No open feedback yet.') : t('还没有已关闭的反馈。', 'No closed feedback yet.')}</p></div>
          : <ul className="feedback-list">
            {visible.map(item => (
              <li key={item.id}>
                <button type="button" className="feedback-open" onClick={() => open(item.id)} disabled={busy}>
                  {item.status === 'open' ? <span className="feedback-state open" aria-hidden="true" /> : <CheckCircle size={16} className="feedback-state closed" aria-hidden="true" />}
                  <span className="feedback-row-main">
                    <span className="feedback-row-title">{item.unread && <i className="feedback-unread" aria-label={t('有新回复', 'New reply')} />}{item.title}</span>
                    <span className="feedback-row-meta">#{item.number} · {categoryLabel(item.category)} · {t('更新于', 'Updated')} {when(item.updatedAt, lang)}</span>
                  </span>
                  {item.labels.map(label => <span key={label} className="feedback-label">{label}</span>)}
                  {item.comments > 0 && <span className="feedback-count"><ChatCircleText size={14} aria-hidden="true" />{item.comments}</span>}
                </button>
                <button type="button" className="feedback-delete" aria-label={t(`删除反馈：${item.title}`, `Delete feedback: ${item.title}`)} title={t('删除反馈', 'Delete feedback')} disabled={busy} onClick={() => requestDelete(item)}><Trash size={16} aria-hidden="true" /></button>
              </li>
            ))}
          </ul>}
        <aside className="feedback-contact">
          <img src="/wechat-qrcode.png" alt="" width="72" height="72" />
          <p><strong>{t('着急的话，微信扫码联系负责人', 'In a hurry? Scan with WeChat to reach the person in charge')}</strong>{t('反馈照样会在这里留档和回复。', 'Your feedback is still kept and answered here.')}</p>
        </aside>
      </> : view === 'new' ? <>
        <button type="button" className="feedback-back" onClick={() => { setView('list'); setError('') }}><ArrowLeft size={15} aria-hidden="true" />{t('返回列表', 'Back to list')}</button>
        <h1>{t('新建反馈', 'New feedback')}</h1>
        <div className="feedback-form">
          <div className="feedback-tabs feedback-tabs--choice" role="radiogroup" aria-label={t('反馈类型', 'Type')}>
            {(Object.keys(CATEGORY) as Category[]).map(value => <button key={value} type="button" role="radio" aria-checked={category === value} onClick={() => setCategory(value)}>{categoryLabel(value)}</button>)}
          </div>
          <label>{t('标题', 'Title')}<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder={t('一句话说明，例如「视频节点导入后没有声音」', 'One line, e.g. “No sound after importing a video”')} /></label>
          <label>{t('描述', 'Description')}<textarea value={body} maxLength={8000} rows={8} onChange={event => setBody(event.target.value)} placeholder={CATEGORY[category].hint} /></label>
          <div className="feedback-files">
            {files.map((file, index) => (
              <figure key={index}><img src={file.preview} alt={file.name} /><button type="button" aria-label={t('移除截图', 'Remove screenshot')} onClick={() => setFiles(current => current.filter((_, i) => i !== index))}><X size={13} /></button></figure>
            ))}
            {files.length < MAX_FILES && <button type="button" className="feedback-add-file" onClick={() => fileInput.current?.click()}><ImageSquare size={20} aria-hidden="true" /><span>{t('添加截图', 'Add screenshot')}</span><small>{t('也可以直接粘贴', 'or paste')}</small></button>}
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
          </div>
          <p className="feedback-muted">{t('会自动附上：', 'Attached automatically: ')}{t('妙图', 'MiaoImg')} {desktopAppVersion() || '—'} · {systemName(window.miaoDesktop?.platform)}</p>
          {error && <FeedbackNotice message={error} onClose={() => setError('')} />}
          <div className="feedback-actions">
            <button type="button" className="feedback-secondary" disabled={busy} onClick={() => setView('list')}>{t('取消', 'Cancel')}</button>
            <button type="button" className="feedback-primary" disabled={busy || !title.trim() || !body.trim()} onClick={submit}><PaperPlaneTilt size={16} aria-hidden="true" />{busy ? t('提交中…', 'Sending…') : t('提交反馈', 'Send feedback')}</button>
          </div>
        </div>
      </> : detail && <>
        <button type="button" className="feedback-back" onClick={() => { setView('list'); setError(''); void load() }}><ArrowLeft size={15} aria-hidden="true" />{t('返回列表', 'Back to list')}</button>
        <div className="feedback-detail-head">
          <h1>{detail.title} <span>#{detail.number}</span></h1>
          <button type="button" className="feedback-secondary" disabled={busy} onClick={() => requestDelete(detail)}><Trash size={16} aria-hidden="true" />{t('删除反馈', 'Delete feedback')}</button>
          <div className="feedback-row-meta">
            <span className={`feedback-pill ${detail.status}`}>{detail.status === 'open' ? t('处理中', 'Open') : t('已关闭', 'Closed')}</span>
            {categoryLabel(detail.category)} · {t('提交于', 'Opened')} {when(detail.createdAt, lang)}
            {detail.labels.map(label => <span key={label} className="feedback-label">{label}</span>)}
          </div>
        </div>
        <article className="feedback-post">
          <header>{t('我', 'You')} · {when(detail.createdAt, lang)}</header>
          <p>{detail.body}</p>
          {detail.files.length > 0 && <div className="feedback-files feedback-files--view">{detail.files.map(file => <a key={file.id} href={`/api/imagine/feedback/${detail.id}/attachments/${file.id}`} target="_blank" rel="noreferrer"><img src={`/api/imagine/feedback/${detail.id}/attachments/${file.id}`} alt={file.name} /></a>)}</div>}
          {(detail.context.appVersion || detail.context.os) && <footer>{t('妙图', 'MiaoImg')} {detail.context.appVersion} · {detail.context.os}</footer>}
        </article>
        {detail.thread.map(comment => (
          <article key={comment.id} className={`feedback-post ${comment.author === 'admin' ? 'is-team' : ''}`}>
            <header>{comment.author === 'admin' ? t('妙图团队', 'MiaoImg team') : t('我', 'You')} · {when(comment.createdAt, lang)}</header>
            <p>{comment.body}</p>
          </article>
        ))}
        {error && <FeedbackNotice message={error} onClose={() => setError('')} />}
        <div className="feedback-reply">
          <textarea value={reply} rows={3} maxLength={4000} onChange={event => setReply(event.target.value)} placeholder={detail.status === 'closed' ? t('补充说明会重新打开这条反馈', 'Replying reopens this feedback') : t('补充信息或回复团队', 'Add details or reply to the team')} />
          <div className="feedback-actions">
            <button type="button" className="feedback-secondary" disabled={busy} onClick={async () => { const next = await send(`/api/imagine/feedback/${detail.id}/status`, { status: detail.status === 'open' ? 'closed' : 'open' }); if (next) { setDetail(next); void load() } }}>{detail.status === 'open' ? t('问题已解决，关闭', 'Close as resolved') : t('重新打开', 'Reopen')}</button>
            <button type="button" className="feedback-primary" disabled={busy || !reply.trim()} onClick={async () => {
              let next = await send(`/api/imagine/feedback/${detail.id}/comments`, { body: reply })
              if (next && next.status === 'closed') next = await send(`/api/imagine/feedback/${detail.id}/status`, { status: 'open' })
              if (next) { setDetail(next); setReply(''); void load() }
            }}><PaperPlaneTilt size={16} aria-hidden="true" />{t('回复', 'Reply')}</button>
          </div>
        </div>
      </>}
    </main>
  )
}
