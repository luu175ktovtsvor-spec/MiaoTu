import { ArrowClockwise, Receipt, Wallet } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import { useLang } from '../i18n'
import FeedbackNotice from '../components/FeedbackNotice'
import PaymentPanel from './PaymentPanel'
import { LedgerTable, PanelEmpty } from './historyView'
import { ledgerRow } from './history'
import { studioPoint, studioPointParts, studioText } from './studioText'
import type { LedgerState } from './studioState'

type Props = { payment: unknown; csrf?: string; points?: number; ledger: LedgerState; onRefresh(): void; onPaid(): Promise<void>; signedIn: boolean; onLogin(): void; onCreate(): void }
export default function CreditPage({ payment, csrf, points, ledger, onRefresh, onPaid, signedIn, onLogin, onCreate }: Props) {
  const { lang, locale } = useLang()
  const L = (text: string) => studioText(text, lang)
  const [view, setView] = useState<'recharge' | 'ledger'>('recharge')
  const [kind, setKind] = useState('all')
  const pointPrice = Number((payment as { pointPriceCents?: number } | undefined)?.pointPriceCents)
  const rate = Number.isFinite(pointPrice) && pointPrice > 0 ? studioText('1 积分 = ¥{amount}', lang, { amount: (pointPrice / 100).toLocaleString(locale, { maximumFractionDigits: 4 }) }) : ''
  const rows = useMemo(() => ledger.items.filter(row => kind === 'all' || ledgerRow(row, lang).kind === kind), [kind, lang, ledger.items])
  const summary = (key: 'spent' | 'gained') => {
    const value = ledger.summary?.[key]
    return value != null && Number.isFinite(Number(value)) ? studioPoint(Number(value), lang) : '—'
  }
  if (!signedIn) return <main className="studio-record credit-page"><header className="account-heading"><h1>{L('积分')}</h1></header><div className="account-sign-in"><PanelEmpty icon={Wallet} title={L('请先登录')} note={L('充值积分')} /><button className="account-save" onClick={onLogin}>{L('登录 / 注册')}</button></div></main>
  return <main className="studio-record credit-page" aria-labelledby="credit-page-title">
    <header className="account-heading"><div><h1 id="credit-page-title">{L('积分')}</h1></div>
      <button type="button" className="credit-refresh" onClick={onRefresh} aria-label={L('刷新')}><ArrowClockwise size={16} aria-hidden="true" />{L('刷新')}</button>
    </header>
    <section className="credit-overview" aria-label={L('积分')}>
      <div className="credit-balance"><span>{L('可用积分')}</span><p><strong>{Number.isFinite(points) ? studioPointParts(points!, lang).value : '—'}</strong><span>{L('积分')}</span></p><small>{rate}</small></div>
      <div className="credit-stat"><span>{L('本月消耗')}</span><strong>{summary('spent')}</strong>{ledger.summary?.reserved != null && Number(ledger.summary.reserved) > 0 && <small>{studioText('预扣 {points}', lang, { points: studioPoint(Number(ledger.summary.reserved), lang) })}</small>}</div>
      <div className="credit-stat"><span>{L('本月入账')}</span><strong>{summary('gained')}</strong></div>
    </section>
    <nav className="credit-tabs" role="tablist" aria-label={L('积分')}>
      <button role="tab" aria-selected={view === 'recharge'} aria-controls="credit-recharge" id="credit-recharge-tab" onClick={() => setView('recharge')}>{L('充值积分')}</button>
      <button role="tab" aria-selected={view === 'ledger'} aria-controls="credit-ledger" id="credit-ledger-tab" onClick={() => setView('ledger')}>{L('积分流水')}</button>
    </nav>
    <section id="credit-recharge" role="tabpanel" aria-labelledby="credit-recharge-tab" hidden={view !== 'recharge'} className="credit-panel">
      <PaymentPanel payment={payment} csrf={csrf} onPaid={onPaid} onComplete={onCreate} />
    </section>
    <section id="credit-ledger" role="tabpanel" aria-labelledby="credit-ledger-tab" hidden={view !== 'ledger'} className="credit-panel credit-ledger">
      <header className="credit-ledger__head"><h2>{L('最近记录')}</h2><select aria-label={L('事项')} value={kind} onChange={event => setKind(event.target.value)}>{[['all','全部'],['recharge','充值'],['spend','消耗'],['refund','退回'],['grant','赠送'],['adjustment','调整'],['other','其他']].map(([value,label]) => <option key={value} value={value}>{L(label)}</option>)}</select></header>
      {ledger.status === 'loading' && <p className="credit-reading" role="status">{L('正在读取额度流水…')}</p>}
      {ledger.status === 'error' && <FeedbackNotice message={ledger.error} action={L('重试')} onAction={onRefresh} />}
      {ledger.status === 'ready' && !rows.length && <PanelEmpty icon={Receipt} title={L(ledger.items.length ? '没有符合条件的记录' : '还没有积分变动')} note={ledger.items.length ? '' : L('充值和消耗都会记在这里，方便随时对账。')} />}
      {ledger.status === 'ready' && !rows.length && ledger.items.length > 0 && <button className="credit-reset" onClick={() => setKind('all')}>{L('重置筛选')}</button>}
      {ledger.status === 'ready' && rows.length > 0 && <LedgerTable rows={rows} lang={lang} locale={locale} />}
      {ledger.status === 'ready' && kind === 'all' && ledger.items.length >= 200 && <p className="credit-reading">{studioText('显示最近 {n} 条记录', lang, { n: ledger.items.length })}</p>}
    </section>
  </main>
}
