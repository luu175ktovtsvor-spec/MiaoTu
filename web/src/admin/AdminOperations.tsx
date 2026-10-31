import { CheckCircle, Clock, CloudCheck, HardDrives, Images, WarningCircle } from '@phosphor-icons/react'
import './operations.css'

type Props = { data: Record<string, any> | null; lang: string; version: string }

export default function AdminOperations({ data, lang, version }: Props) {
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  const numeric = (value: unknown) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value)
  const number = (value: unknown) => { const n = numeric(value); return n == null ? '—' : n.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN') }
  const bytes = (value: unknown) => {
    const n = numeric(value)
    if (n == null || n < 0) return '—'
    const unit = n >= 1e12 ? 1e12 : n >= 1e9 ? 1e9 : n >= 1e6 ? 1e6 : n >= 1000 ? 1000 : 1
    return `${(n / unit).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: unit === 1 ? 0 : 1 })} ${unit === 1e12 ? 'TB' : unit === 1e9 ? 'GB' : unit === 1e6 ? 'MB' : unit === 1000 ? 'KB' : 'B'}`
  }
  const date = (value: unknown) => {
    const timestamp = value ? new Date(String(value)) : null
    return timestamp && Number.isFinite(timestamp.getTime()) ? new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(timestamp) : t('暂未确认', 'Not confirmed')
  }
  if (!data) return <div className="system-loading" role="status"><Clock size={24} />{t('正在检查系统状态…', 'Checking system status…')}</div>
  const disk = data.storage?.disk || {}, dataset = data.dataset || {}, sync = dataset.syncStatus || {}, files = data.migration || {}
  const usage = numeric(disk.usagePercent)
  const checkedAt = data.runtime?.observedAt
  const syncState = sync.expired || sync.status === 'stale' ? 'stale' : sync.status
  const syncLabel = syncState === 'success' ? t('已完成', 'Completed') : syncState === 'running' ? t('更新中', 'Updating') : syncState === 'failed' ? t('未完成', 'Incomplete') : t('需要确认', 'Needs checking')
  const libraryReady = dataset.present === true && dataset.datasetReady !== false
  const missingCounts = [numeric(files.workspaceMissingBlobs), numeric(files.workspaceRowsAtNeither)]
  const missing = missingCounts.every(value => value != null) ? Math.max(...missingCounts as number[]) : null
  const issues: { title: string; body: string; critical?: boolean }[] = []
  if (usage == null) issues.push({ title: t('磁盘空间暂时无法确认', 'Disk space could not be checked'), body: t('请稍后刷新，确认服务器还有足够的空间。', 'Refresh shortly to check available space.') })
  else if (usage >= 85) issues.push({ title: usage >= 95 ? t('磁盘空间即将用尽', 'Disk space is almost full') : t('磁盘剩余空间较少', 'Disk space is running low'), body: t('请安排清理或扩容，避免影响文件上传和生成结果保存。', 'Arrange a storage review or expansion to keep uploads and result delivery working.'), critical: usage >= 95 })
  if (!libraryReady) issues.push({ title: t('素材库暂时无法确认', 'The library could not be checked'), body: t('请稍后刷新，确认图片和视频素材能正常读取。', 'Refresh shortly to check image and video availability.') })
  if (syncState === 'failed') issues.push({ title: t('最近一次素材更新未完成', 'The latest library update did not finish'), body: t('当前已有内容仍可使用，请安排检查更新情况。', 'Existing content may still be available. Arrange a review of the update.') })
  else if (syncState === 'stale') issues.push({ title: t('素材更新记录较旧', 'The library update record is old'), body: t('最近的更新结果还不能确认，请安排检查。', 'The latest update result cannot yet be confirmed. Arrange a review.') })
  else if (!['success', 'running'].includes(syncState)) issues.push({ title: t('素材更新状态待确认', 'Library update status needs checking'), body: t('当前没有近期更新结果，请稍后复查。', 'A recent update result is unavailable. Check again shortly.') })
  if (missing == null) issues.push({ title: t('暂存文件状态待确认', 'Temporary file status needs checking'), body: t('暂时无法确认服务器暂存文件的读取情况，请稍后复查。', 'Temporary file access could not be confirmed. Check again shortly.') })
  if (missing != null && missing > 0) issues.push({ title: t('发现无法读取的暂存文件', 'Some temporary files could not be read'), body: t(`有 ${number(missing)} 条文件记录需要检查，请先核对原文件。`, `${number(missing)} file records need review. Check the original files first.`), critical: true })
  const counts = dataset.databaseCounts || dataset
  const cards = [
    { label: t('可用磁盘空间', 'Available disk space'), value: bytes(disk.freeBytes), detail: `${t('总容量', 'Total')} ${bytes(disk.totalBytes)}`, Icon: HardDrives },
    { label: t('素材库', 'Content library'), value: libraryReady ? t('可读取', 'Available') : t('待确认', 'Unconfirmed'), detail: `${t('最近检查', 'Last checked')} ${date(dataset.observedAt)}`, Icon: Images },
    { label: t('最近素材更新', 'Latest library update'), value: syncLabel, detail: date(sync.updatedAt), Icon: CloudCheck },
    { label: t('需要处理', 'Needs attention'), value: String(issues.length), detail: issues.length ? t('查看下方提示', 'Review the items below') : t('本页检查项未发现异常', 'No issues found in these checks'), Icon: issues.length ? WarningCircle : CheckCircle },
  ]
  return <div className="system-status-page">
    <div className={`system-verdict ${issues.length ? 'attention' : ''}`} role="status"><span className="system-verdict-icon">{issues.length ? <WarningCircle size={25} /> : <CheckCircle size={25} />}</span><div><strong>{issues.length ? t('有事项需要留意', 'Some items need attention') : t('本次检查未发现异常', 'No issues found in this check')}</strong><p>{t('检查范围：服务器空间、素材库与文件读取。', 'Checks cover disk space, the content library and file access.')}</p></div><time>{t('更新于', 'Updated')} {date(checkedAt)}</time></div>
    <section className="system-summary" aria-label={t('系统状态概况', 'System status summary')}>{cards.map(({ label, value, detail, Icon }) => <div className="system-metric" key={label}><span className="system-metric-icon"><Icon size={22} /></span><div><h2>{label}</h2><strong>{value}</strong><p>{detail}</p></div></div>)}</section>
    {issues.length > 0 && <section className="system-card system-attention"><header><h2>{t('需要处理的事项', 'Items to review')}</h2></header><ul>{issues.map(issue => <li key={issue.title} className={issue.critical ? 'critical' : ''}><WarningCircle size={20} /><div><strong>{issue.title}</strong><p>{issue.body}</p></div></li>)}</ul></section>}
    <div className="system-grid">
      <section className="system-card"><header><span><HardDrives size={21} /><h2>{t('服务器空间', 'Server storage')}</h2></span><span className={`system-pill ${usage == null ? 'neutral' : usage >= 85 ? 'warning' : 'ok'}`}>{usage == null ? t('待确认', 'Unconfirmed') : usage >= 85 ? t('需要留意', 'Needs attention') : t('空间充足', 'Space available')}</span></header><div className="system-storage"><div className="system-storage-heading"><strong>{usage == null ? '—' : `${number(usage)}%`}</strong><span>{t('已使用', 'Used')}</span><p>{bytes(disk.usedBytes)} / {bytes(disk.totalBytes)}</p></div>{usage != null && <progress max={100} value={Math.min(100, Math.max(0, usage))} aria-label={t('磁盘使用比例', 'Disk usage')} className={usage >= 85 ? 'warning' : ''} />}<dl><div><dt>{t('剩余空间', 'Free space')}</dt><dd>{bytes(disk.freeBytes)}</dd></div><div><dt>{t('检查时间', 'Checked')}</dt><dd>{date(disk.observedAt)}</dd></div></dl></div></section>
      <section className="system-card"><header><span><CloudCheck size={21} /><h2>{t('素材更新', 'Library updates')}</h2></span><span className={`system-pill ${syncState === 'success' ? 'ok' : syncState === 'running' ? 'neutral' : 'warning'}`}>{syncLabel}</span></header><div className="system-card-body"><dl><div><dt>{t('最近开始', 'Last started')}</dt><dd>{date(sync.startedAt)}</dd></div><div><dt>{t('最近完成', 'Last completed')}</dt><dd>{syncState === 'success' ? date(sync.updatedAt) : '—'}</dd></div><div><dt>{t('当前内容', 'Current content')}</dt><dd>{dataset.countsMatch === true ? t('与最近更新记录一致', 'Matches the latest update') : dataset.countsMatch === false ? t('与最近更新记录不同', 'Differs from the latest update') : t('暂无法比较', 'Not yet comparable')}</dd></div></dl>{syncState === 'running' && <p className="system-note">{t('素材正在更新，已有内容可继续浏览。', 'The library is updating. Existing content may still be browsed.')}</p>}</div></section>
    </div>
    <section className="system-card"><header><span><Images size={21} /><h2>{t('素材库内容', 'Library content')}</h2></span><span className="system-observed">{t('读取于', 'Read at')} {date(dataset.observedAt)}</span></header><dl className="system-library-counts">{[[t('创意提示词', 'Creative prompts'), counts.prompts], [t('图片素材', 'Images'), counts.images], [t('视频素材', 'Videos'), counts.videos], [t('预览图', 'Previews'), counts.previews]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{number(value)}</dd></div>)}</dl></section>
    <section className="system-card"><header><h2>{t('后台信息', 'Admin information')}</h2><span className="system-pill ok">{t('已连接', 'Connected')}</span></header><div className="system-card-body"><dl className="system-info"><div><dt>{t('后台版本', 'Admin version')}</dt><dd>{version}</dd></div><div><dt>{t('最近读取状态', 'Last status check')}</dt><dd>{date(checkedAt)}</dd></div><div><dt>{t('缺失的暂存文件', 'Missing temporary files')}</dt><dd>{missing == null ? t('暂未确认', 'Not confirmed') : number(missing)}</dd></div></dl></div></section>
  </div>
}
