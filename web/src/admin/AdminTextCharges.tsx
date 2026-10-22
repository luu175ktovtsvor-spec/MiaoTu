import { adminText, number, time } from './i18n'

type Summary = { reservedRequests: number; reservedPoints: number; reviewRequests: number; reviewPoints: number }
type PendingTextCharges = { items: { id: string; requestId: string; model: string; statusLabel: string; reservedPoints: number; createdAt: string; reviewAt: string | null; reason: string }[]; total: number; page: number; limit: number; summary: Summary }

export function TextChargeSummary({ summary, lang }: { summary?: Summary; lang: string }) {
  if (!summary) return null
  return <span>{adminText('文本预扣待结算', lang)}：{number(summary.reservedRequests, lang)} {adminText('笔', lang)} / {number(summary.reservedPoints, lang)} {adminText('积分', lang)} · {adminText('文本用量待核对', lang)}：{number(summary.reviewRequests, lang)} {adminText('笔', lang)} / {number(summary.reviewPoints, lang)} {adminText('预扣积分', lang)}</span>
}

// The existing user ledger dialog owns this collapsed view. These are actual
// text_charge records, deliberately separate from its immutable ledger rows.
export default function AdminTextCharges({ data, lang, busy, onPage }: { data?: PendingTextCharges; lang: string; busy: boolean; onPage(page: number): void }) {
  if (!data) return null
  return <details className="admin-explainer">
    <summary>{adminText('文本预扣待结算 / 用量待核对', lang)} · {number(data.total, lang)}</summary>
    <p className="admin-footnote"><TextChargeSummary summary={data.summary} lang={lang}/><br/>{adminText('以下为文本预扣记录，包含零积分请求；预扣仍保留，未计入已结算消费或收入。待结算请求可能仍在执行，也可能需要恢复核对。', lang)}</p>
    <div className="admin-table-wrap"><table><thead><tr>
      <th>{adminText('时间 / 模型', lang)}</th><th>{adminText('状态', lang)}</th><th>{adminText('预扣积分', lang)}</th><th>{adminText('妙图请求 ID', lang)}</th><th>{adminText('核对原因 / 时间', lang)}</th>
    </tr></thead><tbody>{data.items.map(row => <tr key={row.id}>
      <td>{time(row.createdAt, lang)}<small>{row.model}</small></td><td>{adminText(row.statusLabel, lang)}</td><td>{number(row.reservedPoints, lang)}</td><td className="id-cell">{row.requestId}</td><td>{row.reason || '—'}<small>{time(row.reviewAt, lang)}</small></td>
    </tr>)}</tbody></table></div>
    {!data.items.length && <p className="admin-muted">{adminText('没有待结算或待核对的文本预扣记录。', lang)}</p>}
    <footer className="admin-pagination"><span>{adminText('共 {n} 条 · 第 {page} 页', lang, { n: data.total, page: data.page })}</span><button disabled={busy || data.page === 1} onClick={() => onPage(data.page - 1)}>{adminText('上一页', lang)}</button><button disabled={busy || data.page * data.limit >= data.total} onClick={() => onPage(data.page + 1)}>{adminText('下一页', lang)}</button></footer>
  </details>
}
