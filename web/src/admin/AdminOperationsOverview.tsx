import { useEffect, useState } from 'react'
import { ArrowClockwise, ArrowRight } from '@phosphor-icons/react'
import { isDiscardedAdminRequest } from './useAdminSession'
import AdminOperationsTrend, { type OperationsSeries } from './AdminOperationsTrend'
import type { AnalyticsDrilldown, OperationsAnalytics } from './operationsTypes'
import './admin-analytics.css'

type Range = { from: string; to: string; timeZone: 'Asia/Shanghai' | 'UTC' }
type Props = { api(path: string, method?: string, body?: unknown, signal?: AbortSignal): Promise<any>; lang: string; refreshToken?: number; onNavigate(target: AnalyticsDrilldown): void }
export function operationsDate(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const part = (type: string) => parts.find(value => value.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function shiftOperationsDate(value: string, days: number) { const date = new Date(value + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
function initialRange(): Range { const to = operationsDate(new Date(), 'Asia/Shanghai'); return { from: shiftOperationsDate(to, -6), to, timeZone: 'Asia/Shanghai' } }

export default function AdminOperationsOverview({ api, lang, refreshToken = 0, onNavigate }: Props) {
  const t = (zh: string, en: string) => lang === 'en' ? en : zh
  const n = (value: number | null | undefined, digits = 4) => value == null ? '—' : value.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: digits })
  const seconds = (value: number | null | undefined) => value == null ? '—' : n(value / 1000, 2)
  const percent = (value: number | null | undefined) => value == null ? '—' : n(value * 100, 1) + '%'
  const [range, setRange] = useState<Range>(initialRange), [draft, setDraft] = useState<Range>(() => range)
  const [preset, setPreset] = useState('7'), [data, setData] = useState<OperationsAnalytics | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const [trend, setTrend] = useState('calls'), [userRanking, setUserRanking] = useState('calls'), [modelKind, setModelKind] = useState('all')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null)
    const query = new URLSearchParams({ ...range, limit: '10' })
    api('analytics?' + query, 'GET', undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return
      if (value?.schemaVersion !== 1 || !value.range || !value.summary?.media || !value.summary?.text || !value.pending || !value.finance?.ledger || !value.evidence || !value.drilldown?.mediaQuery || !value.drilldown?.textQuery || !['UTC', 'Asia/Shanghai'].includes(value.range.timeZone) || !Array.isArray(value.summary.mediaByKind) || !Array.isArray(value.daily) || !Array.isArray(value.rankings?.usersByCalls) || !Array.isArray(value.rankings?.usersByChargedPoints) || !Array.isArray(value.rankings?.models)) throw new Error('Invalid analytics response')
      setData(value)
    }).catch(reason => { if (!controller.signal.aborted && !isDiscardedAdminRequest(reason)) setError(t('暂时无法读取运营汇总，请重试。', 'The operations summary is unavailable. Please retry.')) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [api, range, refresh, refreshToken])
  function choosePeriod(key: string, timeZone = draft.timeZone) {
    const to = operationsDate(new Date(), timeZone), next = { from: shiftOperationsDate(to, -(Number(key) - 1)), to, timeZone }
    setPreset(key); setDraft(next); setRange(next)
  }
  function apply(event: React.FormEvent) {
    event.preventDefault()
    const days = (Date.parse(draft.to) - Date.parse(draft.from)) / 86400000 + 1
    if (!Number.isFinite(days) || days < 1 || days > 93) { setError(t('请选择不超过 93 天的有效日期范围。', 'Choose a valid date range of up to 93 days.')); return }
    setRange({ ...draft }); setPreset('custom')
  }
  const zoneLabel = (zone: string) => zone === 'Asia/Shanghai' ? t('北京时间', 'Beijing time') : 'UTC'
  const kindLabel = (kind: string) => ({ image: t('图片', 'Images'), video: t('视频', 'Video'), text: t('文本', 'Text'), unknown: t('历史类型未留存', 'Type unavailable') })[kind] || kind
  const drill = (section: 'generations' | 'text', extra: Partial<AnalyticsDrilldown> = {}) => {
    if (!data) return
    const query = section === 'text' ? data.drilldown.textQuery : data.drilldown.mediaQuery
    onNavigate({ section, ...query, timeZone: data.range.timeZone, ...extra })
  }
  const period = data ? `${data.range.fromDate} — ${data.range.toDateInclusive} · ${zoneLabel(data.range.timeZone)}` : `${range.from} — ${range.to} · ${zoneLabel(range.timeZone)}`
  const summaries = data ? [
    { label: t('调用用户', 'Calling users'), value: data.summary.callingUsers, unit: t('人', 'users'), detail: `${t('新增注册', 'New registrations')} ${n(data.summary.newUsers, 0)}` },
    { label: t('媒体调用', 'Media requests'), value: data.summary.media.calls, unit: t('次', 'calls'), detail: `${t('成功', 'Succeeded')} ${n(data.summary.media.succeeded, 0)} · ${t('失败', 'Failed')} ${n(data.summary.media.failed, 0)}` },
    { label: t('文本调用', 'Text requests'), value: data.summary.text.calls, unit: t('次', 'calls'), detail: `${t('用量已知', 'Known usage')} ${n(data.summary.text.knownUsageCalls, 0)} · ${t('未取得用量', 'Unknown usage')} ${n(data.summary.text.unknownUsageCalls, 0)}` },
    { label: t('已知文本用量', 'Known text usage'), value: data.summary.text.inputTokens + data.summary.text.outputTokens, unit: 'Token', detail: t('输入 + 输出；缓存不重复相加', 'Input + output; cache is not added again') },
    { label: t('已记实扣', 'Recorded charges'), value: data.summary.media.chargedPoints + data.summary.text.chargedPoints, unit: t('积分', 'credits'), detail: t('所选期间创建的请求', 'Requests created in this period') },
    { label: t('到账充值', 'Paid top-ups'), value: data.finance.paidAmountCents / 100, unit: t('元', 'CNY'), detail: `${n(data.finance.paidOrders, 0)} ${t('笔已支付订单', 'paid orders')}` },
  ] : []
  const series: OperationsSeries[] = data ? (trend === 'tokens' ? [
    { key: 'inputTokens', label: t('输入 Token', 'Input tokens'), color: 'var(--a-brand)' },
    { key: 'outputTokens', label: t('输出 Token', 'Output tokens'), color: 'var(--a-chart-secondary)' },
  ] : trend === 'results' ? [
    { key: 'mediaSucceeded', label: t('媒体成功', 'Media succeeded'), color: 'var(--a-brand)' },
    { key: 'textSucceeded', label: t('文本成功', 'Text succeeded'), color: 'var(--a-chart-secondary)' },
    { key: 'mediaFailed', label: t('媒体失败', 'Media failed'), color: 'var(--a-bad)' },
    { key: 'mediaExpired', label: t('媒体过期', 'Media expired'), color: 'var(--a-chart-secondary)' },
    { key: 'textFailed', label: t('文本失败', 'Text failed'), color: 'var(--a-chart-tertiary)' },
  ] : [
    { key: 'mediaCalls', label: t('媒体调用', 'Media requests'), color: 'var(--a-brand)' },
    { key: 'textCalls', label: t('文本调用', 'Text requests'), color: 'var(--a-chart-secondary)' },
  ]).map(item => ({ ...item, points: data.daily.map(day => ({ day: day.date, value: day[item.key] ?? null })) })) : []
  const pending = data ? [
    { label: t('未读反馈', 'Unread feedback'), count: data.pending.unreadFeedback, detail: `${t('未关闭反馈', 'Open feedback')} ${n(data.pending.openFeedback, 0)}`, action: () => onNavigate({ section: 'feedback' }) },
    { label: t('提交结果待确认', 'Submission awaiting confirmation'), count: data.pending.submissionUnknownMedia, detail: t('保留原请求，进入任务记录核对', 'Review existing task records'), action: () => onNavigate({ section: 'generations' }) },
    { label: t('文本用量待核对', 'Text usage awaiting review'), count: data.pending.reviewTextCalls, detail: `${n(data.pending.reviewTextPoints)} ${t('预扣积分', 'held credits')}`, action: () => onNavigate({ section: 'text', billing: 'billing_review' }) },
    { label: t('余额与账本不一致', 'Balance / ledger mismatches'), count: data.pending.balanceMismatchUsers, detail: t('进入用户列表核对积分流水', 'Review user credit ledgers'), action: () => onNavigate({ section: 'users' }) },
    { label: t('排队任务', 'Queued tasks'), count: data.pending.queuedMedia, detail: t('当前状态，不回放历史队列', 'Current queue, not a historical snapshot'), action: () => onNavigate({ section: 'generations', status: 'queued' }) },
    { label: t('生成中的任务', 'Running tasks'), count: data.pending.runningMedia, detail: `${t('结果待取回', 'Results awaiting delivery')} ${n(data.pending.resultPendingMedia, 0)}`, action: () => onNavigate({ section: 'generations', status: 'running' }) },
  ].sort((a, b) => Number(b.count > 0) - Number(a.count > 0)) : []
  const rankedModels = data ? data.rankings.models.filter(row => modelKind === 'all' || row.kind === modelKind).sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model)).slice(0, 10) : []
  const users = data ? userRanking === 'calls' ? data.rankings.usersByCalls : data.rankings.usersByChargedPoints : []
  const failures = data ? [...data.summary.mediaByKind.map(row => ({ kind: row.kind, count: row.failed + row.expired })), { kind: 'text', count: data.summary.text.failed }] : []
  const maxFailures = Math.max(1, ...failures.map(row => row.count))
  return <div className="admin-analytics">
    <form className="admin-analytics-toolbar" onSubmit={apply}>
      <div className="admin-analytics-period" aria-label={t('运营统计范围', 'Analytics date range')}>
        <div className="admin-analytics-toggle">{[['1', t('今天', 'Today')], ['7', t('近 7 天', '7 days')], ['30', t('近 30 天', '30 days')]].map(([key, label]) => <button key={key} type="button" aria-pressed={preset === key} onClick={() => choosePeriod(key)}>{label}</button>)}</div>
        <label>{t('时区', 'Time zone')}<select value={draft.timeZone} onChange={event => { const zone = event.target.value as Range['timeZone']; if (preset !== 'custom') choosePeriod(preset, zone); else setDraft(value => ({ ...value, timeZone: zone })) }}><option value="Asia/Shanghai">{t('北京时间', 'Beijing time')}</option><option value="UTC">UTC</option></select></label>
        <label>{t('从', 'From')}<input type="date" required value={draft.from} max={draft.to || undefined} onChange={event => { setPreset('custom'); setDraft(value => ({ ...value, from: event.target.value })) }}/></label>
        <label>{t('至', 'To')}<input type="date" required value={draft.to} min={draft.from || undefined} onChange={event => { setPreset('custom'); setDraft(value => ({ ...value, to: event.target.value })) }}/></label>
        <button type="submit">{t('应用', 'Apply')}</button>
      </div>
      <button type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}><ArrowClockwise size={15}/>{t('刷新数据', 'Refresh data')}</button>
    </form>
    {loading && <p className="admin-analytics-loading" role="status">{t('正在读取所选期间的运营数据…', 'Loading operations data for this period…')}</p>}
    {error && <div className="admin-error" role="alert">{error}<button type="button" onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</button></div>}
    {data && <>
      <section className="admin-analytics-section admin-work-queue">
        <header><div><h2>{t('待查看事项', 'Items to review')}</h2><p>{t('当前全量状态，不随所选历史日期回放', 'Current state across all dates, not a historical snapshot')}</p></div><span className="admin-analytics-updated">{t('更新于', 'Updated')} {new Date(data.generatedAt).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { timeZone: data.range.timeZone, hour12: false })}</span></header>
        <ul>{pending.map(item => <li key={item.label}><button type="button" onClick={item.action}><span><strong>{item.label}</strong><small>{item.detail}</small></span><b>{n(item.count, 0)}</b><ArrowRight size={15}/></button></li>)}</ul>
        <p className="admin-analytics-note">{t('文本预扣待结算', 'Text calls awaiting settlement')} {n(data.pending.reservedTextCalls, 0)} {t('笔', 'calls')} · {n(data.pending.reservedTextPoints)} {t('预扣积分', 'held credits')} <button type="button" onClick={() => onNavigate({ section: 'text', billing: 'reserved' })}>{t('查看明细', 'View records')}</button></p>
      </section>
      <dl className="admin-analytics-summary">{summaries.map(item => <div key={item.label}><dt>{item.label}</dt><dd><strong>{n(item.value)}</strong><span>{item.unit}</span></dd><small>{item.detail}</small></div>)}</dl>
      <section className="admin-analytics-section">
        <header><div><h2>{t('业务趋势', 'Activity trends')}</h2><p>{period}</p></div><div className="admin-analytics-toggle">{[['calls', t('调用量', 'Calls')], ['tokens', 'Token'], ['results', t('成功与失败', 'Outcomes')], ['latency', t('耗时', 'Latency')]].map(([key, label]) => <button key={key} type="button" aria-pressed={trend === key} onClick={() => setTrend(key)}>{label}</button>)}</div></header>
        {trend === 'latency' ? <div className="admin-analytics-latency"><table><thead><tr><th>{t('耗时口径', 'Measurement')}</th><th>{t('平均秒数', 'Average seconds')}</th><th>{t('有效样本', 'Measured samples')}</th></tr></thead><tbody>
          {data.summary.mediaByKind.map(row => <tr key={row.kind}><td>{kindLabel(row.kind)} · {t('创建至完成（含排队）', 'Created to completed, including queue')}</td><td>{seconds(row.averageDurationMs)}</td><td>{n(row.durationSamples, 0)}</td></tr>)}
          <tr><td>{t('文本 · 留存调用耗时', 'Text · recorded request duration')}</td><td>{seconds(data.summary.text.averageDurationMs)}</td><td>{n(data.summary.text.durationSamples, 0)}</td></tr><tr><td>{t('文本 · 首 Token', 'Text · first token')}</td><td>{seconds(data.summary.text.averageFirstTokenMs)}</td><td>{n(data.summary.text.firstTokenSamples, 0)}</td></tr>
        </tbody></table><p className="admin-analytics-note">{t('没有有效样本时留空；不将不同耗时口径合成一条曲线。', 'Missing measurements stay blank. Different latency definitions are not combined into one trend.')}</p></div> : <AdminOperationsTrend series={series} lang={lang} timeZone={data.range.timeZone} label={`${t('业务趋势', 'Activity trends')} · ${period}`}/>}
        {trend === 'tokens' && <p className="admin-analytics-note">{t('只累计取得用量回执的文本请求；缓存 Token 已含在输入中。', 'Only requests with usage receipts are counted. Cache tokens are already part of input.')}</p>}
      </section>
      <section className="admin-analytics-section">
        <header><div><h2>{t('用户使用排行', 'User activity ranking')}</h2><p>{period} · {t('分别按完整用户集合排序', 'Each ranking uses the full user set')}</p></div><div className="admin-analytics-toggle"><button type="button" aria-pressed={userRanking === 'calls'} onClick={() => setUserRanking('calls')}>{t('调用量', 'Calls')}</button><button type="button" aria-pressed={userRanking === 'charged'} onClick={() => setUserRanking('charged')}>{t('积分消耗', 'Charged credits')}</button></div></header>
        {users.length ? <div className="admin-table-wrap"><table className="admin-analytics-users"><thead><tr><th>{t('用户', 'User')}</th><th>{t('总调用', 'Calls')}</th><th>{t('媒体 / 文本', 'Media / text')}</th><th>{t('已记实扣（积分）', 'Recorded charge (credits)')}</th><th>{t('进入明细', 'Request details')}</th></tr></thead><tbody>{users.map((row, index) => <tr key={row.userId || index}><td><span className="admin-ranking-number">{index + 1}</span>{row.name || t('用户名称未留存', 'Name unavailable')}</td><td>{n(row.calls, 0)}</td><td>{n(row.mediaCalls, 0)} / {n(row.textCalls, 0)}</td><td>{n(row.chargedPoints)}</td><td><div className="table-actions"><button type="button" disabled={!row.userId || !row.mediaCalls} onClick={() => drill('generations', { userId: row.userId, label: row.name || t('所选用户', 'Selected user') })}>{t('媒体明细', 'Media records')}</button><button type="button" disabled={!row.userId || !row.textCalls} onClick={() => drill('text', { userId: row.userId, label: row.name || t('所选用户', 'Selected user') })}>{t('文本明细', 'Text records')}</button></div></td></tr>)}</tbody></table></div> : <p className="admin-analytics-empty">{t('所选期间没有符合此排序条件的用户', 'No users match this ranking in the selected period')}</p>}
        {!!data.summary.unattributedMediaCalls && <p className="admin-analytics-note">{n(data.summary.unattributedMediaCalls, 0)} {t('笔媒体调用未留存用户归属，未伪造为用户排行。', 'media requests lack user attribution and are not presented as user activity.')}</p>}
      </section>
      <div className="admin-analytics-two-column">
        <section className="admin-analytics-section"><header><div><h2>{t('充值与积分', 'Payments and credits')}</h2><p>{t('到账按支付完成时间；流水按发生时间', 'Payments use completion time; ledger uses entry time')}</p></div><button type="button" onClick={() => onNavigate({ section: 'payments', status: 'paid' })}>{t('查看全部已支付订单', 'All paid orders')}</button></header>
          <dl className="admin-finance-lines">{[
            [t('到账充值', 'Paid top-ups'), n(data.finance.paidAmountCents / 100), t('元', 'CNY')],
            [t('充值入账', 'Top-up credits'), n(data.finance.ledger.paymentPoints), t('积分', 'credits')],
            [t('媒体扣减 / 退还', 'Media debits / refunds'), `${n(data.finance.ledger.mediaDebitedPoints)} / ${n(data.finance.ledger.mediaRefundedPoints)}`, t('积分', 'credits')],
            [t('文本扣减 / 退还', 'Text debits / refunds'), `${n(data.finance.ledger.textDebitedPoints)} / ${n(data.finance.ledger.textRefundedPoints)}`, t('积分', 'credits')],
            [t('赠送入账', 'Gifted credits'), n(data.finance.ledger.giftedPoints), t('积分', 'credits')],
            [t('其他入账 / 扣减', 'Other credits / debits'), `${n(data.finance.ledger.otherCreditedPoints)} / ${n(data.finance.ledger.otherDebitedPoints)}`, t('积分', 'credits')],
          ].map(([label, value, unit]) => <div key={label}><dt>{label}</dt><dd><strong>{value}</strong><span>{unit}</span></dd></div>)}</dl>
          <p className="admin-analytics-note">{t('没有已核验的供应商逐单账单，成本与利润待确认；不把积分兑换成现金收入。', 'Supplier invoices have not been verified. Cost and profit remain unconfirmed; credits are not cash revenue.')} {n(data.evidence.mediaMissingCostRows, 0)} {t('笔媒体请求尚缺成本留档。', 'media requests lack cost records.')}</p>
        </section>
        <section className="admin-analytics-section"><header><div><h2>{t('失败记录分布', 'Failure breakdown')}</h2><p>{t('媒体为失败 + 过期；文本为调用失败', 'Media: failed + expired. Text: invocation failures.')}</p></div></header><div className="admin-failure-breakdown">{failures.map(row => <div key={row.kind}><span>{kindLabel(row.kind)}</span><div><i style={{ width: row.count / maxFailures * 100 + '%' }}/></div><strong>{n(row.count, 0)}</strong></div>)}</div><p className="admin-analytics-note">{t('已记录失败不等于尚未处理事故；进入明细核对具体请求。', 'Recorded failures are not an incident count. Review individual requests for context.')}</p></section>
      </div>
      <section className="admin-analytics-section"><header><div><h2>{t('模型表现', 'Model performance')}</h2><p>{period} · {t('各类型按调用量取前 10 项', 'Top 10 by calls within each type')}</p></div><div className="admin-analytics-toggle">{[['all', t('全部', 'All')], ['image', t('图片', 'Images')], ['video', t('视频', 'Video')], ['text', t('文本', 'Text')]].map(([key, label]) => <button type="button" key={key} aria-pressed={modelKind === key} onClick={() => setModelKind(key)}>{label}</button>)}</div></header>
        {rankedModels.length ? <div className="admin-table-wrap"><table className="admin-analytics-models"><thead><tr>{[t('模型', 'Model'), t('类型', 'Type'), t('调用', 'Calls'), t('成功', 'Success'), t('失败 / 过期', 'Failed / expired'), t('成功率', 'Success rate'), t('平均耗时（秒）', 'Average seconds'), t('实扣积分', 'Charged credits'), t('明细', 'Details')].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{rankedModels.map(row => <tr key={row.kind + ':' + row.model}><td>{row.model}</td><td>{kindLabel(row.kind)}</td><td>{n(row.calls, 0)}</td><td>{n(row.succeeded, 0)}</td><td>{n(row.failed, 0)} / {row.kind === 'text' ? '—' : n(row.expired, 0)}</td><td title={`${t('有效结果', 'Result samples')}: ${n(row.successRateBase, 0)}`}>{percent(row.successRate)}</td><td>{seconds(row.averageDurationMs)}<small>{n(row.durationSamples, 0)} {t('个样本', 'samples')}</small></td><td>{n(row.chargedPoints)}</td><td><button type="button" onClick={() => drill(row.kind === 'text' ? 'text' : 'generations', { model: row.model, ...(row.kind === 'image' || row.kind === 'video' ? { kind: row.kind } : {}), label: row.model })}>{t('查看', 'View')}</button></td></tr>)}</tbody></table></div> : <p className="admin-analytics-empty">{t('所选期间没有模型调用记录', 'No model requests were recorded in this period')}</p>}
      </section>
      <details className="admin-analytics-evidence"><summary>{t('统计口径与对账依据', 'Measurement and reconciliation notes')}</summary><p>{t('调用、排行与日趋势按请求创建时间归属；充值按支付完成时间；积分流水按发生时间。当前待查看事项不随历史日期回放。', 'Requests, rankings and trends use request creation time. Payments use completion time and ledger entries use entry time. Pending items describe the current state.')}</p><p>{t('媒体成功率以成功、失败、过期为分母，排除处理中和主动取消。文本成功率仅按调用成功与失败计算，不从结算状态推断。', 'Media success rate includes succeeded, failed and expired requests, excluding pending and cancelled ones. Text success rate uses invocation outcomes, not settlement status.')}</p><p>{t('供应商参考成本不等于核验账单；其他积分变动不能可靠拆成管理员调整，现金退款尚无独立凭证。', 'Reference supplier costs are not verified invoices. Other credit movements cannot be reliably labeled manual adjustments; cash refunds lack separate evidence.')}</p><details className="admin-technical-details"><summary>{t('原始统计字段', 'Raw measurement fields')}</summary><pre tabIndex={0}>{JSON.stringify({ range: data.range, evidence: data.evidence, finance: data.finance, pending: data.pending }, null, 2)}</pre></details></details>
    </>}
  </div>
}
