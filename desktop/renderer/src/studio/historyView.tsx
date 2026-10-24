import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownLeft, FilmStrip, ImageSquare, Sparkle, TrendUp } from '@phosphor-icons/react'
import { studioText, studioPoint } from './studioText'
import { ACTIVE_STATUSES, STATUS_LABEL, STATUS_TONE, LEDGER_BADGE, ledgerRow, relativeTime, historyTime, waitingText } from './history'
import type { HistoryItem, HistoryProgress, LedgerEntry } from './studioState'


// 历史卡片只在真正进入视口时挂载 <img>，避免一进页面就为整页卡片发媒体请求。
export function LazyPreview({ src, alt = '', fallback = null }: { src?: string; alt?: string; fallback?: ReactNode }) {
  const hostRef = useRef<HTMLSpanElement | null>(null)
  const [visible, setVisible] = useState(false)
  // 本机原件被删掉后记录仍在：显示类型图标，不留浏览器的裂图。
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  useEffect(() => {
    if (!src) return undefined
    if (!('IntersectionObserver' in window)) { setVisible(true); return undefined }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '240px 0px' })
    if (hostRef.current) observer.observe(hostRef.current)
    return () => observer.disconnect()
  }, [src])
  return (
    <span ref={hostRef} className="gen-card__preview-slot">
      {failed ? fallback : visible && src ? <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : null}
    </span>
  )
}

// 环形进度：和画布上 `el-progress type="circle"`（nodes/videoNode.vue:25，width 64 / strokeWidth 3）
// 同一套观感——细环 + 中间数字。Element Plus 是 Vue 组件，React 外壳这边用 SVG 复刻。
// 失败/取消不表达数字比例；圆环留空、中心无数字、aria 只读状态词。其它阶段沿用核心的真值/≈估算规则。
export function ProgressRing({ percent, estimated = false, showPercent = true, indeterminate, tone, label, approx, statusText }: { percent: number; estimated?: boolean; showPercent?: boolean; indeterminate: boolean; tone?: string; label: string; approx: string; statusText: string }) {
  const size = 56
  const stroke = 3
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const shown = Math.max(0, Math.min(100, Math.round(percent || 0)))
  // 估算出来的数字带 ≈ 前缀，真实测量不带——界面上必须有数字，但不冒充精确测量。
  const text = `${estimated ? approx : ''}${shown}%`
  return (
    <svg
      className={`gen-ring${tone ? ` is-${tone}` : ''}${indeterminate ? ' is-spinning' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuemin={showPercent ? 0 : undefined}
      aria-valuemax={showPercent ? 100 : undefined}
      aria-valuenow={indeterminate || !showPercent ? undefined : shown}
      aria-valuetext={indeterminate ? undefined : showPercent ? text : statusText}
      aria-label={label}>
      <circle className="gen-ring__track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
      <circle
        className="gen-ring__fill"
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={indeterminate ? `${circumference * 0.22} ${circumference}` : `${(showPercent ? shown : 0) / 100 * circumference} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      {!indeterminate && showPercent && <text className="gen-ring__text" x="50%" y="50%" textAnchor="middle" dominantBaseline="central">{text}</text>}
    </svg>
  )
}

export function HistoryCard({ item, lang, locale, onOpen, progress, now }: { item: HistoryItem; lang: string; locale: string; onOpen(item: HistoryItem): void; progress: Record<string, HistoryProgress>; now: number }) {
  const recovery = item.localRecovery
  const recovered = recovery?.items?.[0]
  const video = item.video || (recovered?.mime?.startsWith('video/') ? recovered : null)
  const isVideo = item.kind === 'video' || Boolean(video)
  const image = item.images?.[0] || (recovered?.mime?.startsWith('image/') ? recovered : null)
  const previewUrl = video?.thumbnailUrl || image?.thumbnailUrl || ''
  const delivery = item.delivery?.target === 'desktop' ? item.delivery : null
  const deliveryLabel = delivery?.status === 'saved'
    ? (typeof window !== 'undefined' && window.miaoDesktop ? '已保存到这台电脑' : '已交付桌面')
    : delivery?.status === 'expired' ? '服务器暂存已过期' : delivery && item.status === 'succeeded' ? '等待桌面保存' : ''
  // 提交/生成仍用预扣额度；保存中的生成已经结算，显示实扣。
  const inFlight = ACTIVE_STATUSES.has(item.status)
  const rowView = progress?.[item.requestId]
  const statusLabel = recovery?.saved > 0 ? recovery.saved < recovery.total ? '部分已保存' : '文件已在这台电脑上'
    : item.status === 'saving' && item.error ? '保存暂未完成' : STATUS_LABEL[rowView?.status || item.status] || item.status
  const unsettled = inFlight && item.status !== 'saving'
  // 本机视频任务快照只在 cost 里带积分；都没有就不显示，不能拼出 undefined。
  const rawPoints = unsettled
    ? (item.reservedPoints ?? item.cost?.reservedPoints ?? item.points)
    : (item.chargedPoints ?? item.cost?.points ?? item.points)
  const points = rawPoints == null || !Number.isFinite(Number(rawPoints)) ? null : Number(rawPoints)
  // 真进度从进度表里拿（服务端只在视频通道回这个字段）；拿不到就是不确定态。
  const realPercent = rowView?.percent ?? null
  const estimated = Boolean(rowView?.estimated)
  // 界面上的「已等待」= 从下单那一刻算起（含排队），用户关心的是这个；
  // 估算百分比用的是"真正在生成"的那段（核心入参），两者不是一回事，别混。
  const placedAt = new Date(item.created_at || '').getTime()
  const elapsed = Number.isFinite(placedAt) && Number.isFinite(now) ? Math.max(0, Math.floor((now - placedAt) / 1000)) : 0
  return (
    <button type="button" className="gen-card" onClick={() => onOpen(item)}>
      <div className={`gen-card__media${previewUrl ? '' : ' is-empty'}`}>
        {previewUrl
          ? <LazyPreview src={previewUrl} alt="" fallback={<span className="gen-card__preview-missing">{isVideo ? <FilmStrip size={22} aria-hidden="true" /> : <ImageSquare size={22} aria-hidden="true" />}</span>} />
          : video
            ? <FilmStrip size={22} aria-hidden="true" />
            : image
              ? <ImageSquare size={22} aria-hidden="true" />
              : <ImageSquare size={22} aria-hidden="true" />}
        {/* 进行中：环盖在媒体上（有缩略图/回放帧的也要盖得住），不是替掉空态 */
        inFlight && (
          <span className="gen-card__progress">
            <ProgressRing
              percent={realPercent ?? 0}
              estimated={estimated}
              showPercent={rowView?.showPercent ?? true}
              // 还没有第一份服务端回应之前才转圈；失败/取消收到终态后按核心规则隐藏数字。
              indeterminate={!rowView || rowView.status === 'submitting' || rowView.status === 'confirming'}
              tone={item.status === 'queued' ? 'waiting' : 'active'}
              label={studioText('生成进度', lang)}
              approx={studioText('≈', lang)}
              statusText={studioText(STATUS_LABEL[rowView?.status || item.status] || rowView?.status || item.status, lang)} />
          </span>
        )}
        <span className={`gen-card__status${STATUS_TONE[item.status] ? ` ${STATUS_TONE[item.status]}` : ''}`}>{studioText(statusLabel, lang)}</span>
        <span className="gen-card__kind">
          {isVideo ? <FilmStrip size={11} aria-hidden="true" /> : <ImageSquare size={11} aria-hidden="true" />}
          {studioText(isVideo ? '视频' : '图片', lang)}
        </span>
      </div>
      <p className="gen-card__prompt">{item.prompt || ''}</p>
      {item.error ? <p className="gen-card__error" title={studioText(item.error, lang)}>{studioText(item.error, lang)}</p> : null}
      {deliveryLabel ? <p className="gen-card__when">{studioText(deliveryLabel, lang)}</p> : null}
      <div className="gen-card__meta">
        <span title={item.modelLabel || item.model}>{item.modelLabel || item.model}</span>
        {points != null && <span className="gen-card__points">{studioText(unsettled ? '预扣 {points}' : '消耗 {points}', lang, { points: studioPoint(points, lang) })}</span>}
      </div>
      <div className="gen-card__when">{historyTime(item, locale, lang)}{inFlight ? ` · ${waitingText(elapsed, lang)}` : ''}</div>
    </button>
  )
}

export function LedgerTable({ rows, lang, locale }: { rows: LedgerEntry[]; lang: string; locale: string }) {
  return (
    <div className="ledger-wrap">
      <table className="ledger-table">
        <thead>
          <tr>
            <th>{studioText('时间', lang)}</th>
            <th>{studioText('事项', lang)}</th>
            <th>{studioText('积分', lang)}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const entry = ledgerRow(row, lang)
            const credit = entry.delta > 0
            return (
              <tr key={`${row.createdAt}-${index}`}>
                <td>
                  <span className="ledger-time" title={new Date(row.createdAt).toLocaleString(locale, { hour12: false })}>{relativeTime(row.createdAt, lang)}</span>
                </td>
                <td>
                  <span className={`ledger-badge${entry.kind === 'recharge' || entry.kind === 'refund' ? ' is-credit' : ''}`}>{studioText(LEDGER_BADGE[entry.kind], lang)}</span>
                  <div className="ledger-sub" title={entry.order ? `${studioText('订单号', lang)} ${entry.order}` : undefined}>{entry.sub || entry.text}</div>
                </td>
                <td>
                  <span className={`ledger-amount${credit ? ' is-credit' : entry.delta === 0 ? ' is-zero' : ''}`}>
                    {credit ? <TrendUp size={12} aria-hidden="true" /> : entry.delta < 0 ? <ArrowDownLeft size={12} aria-hidden="true" /> : null}
                    {credit ? `+${studioPoint(entry.delta, lang)}` : studioPoint(entry.delta, lang)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export function PanelEmpty({ icon: Icon, title, note, action }: { icon: typeof Sparkle; title: string; note: string; action?: string }) {
  return (
    <div className="panel-empty">
      <Icon className="panel-empty__icon" size={28} aria-hidden="true" />
      <p className="panel-empty__title">{title}</p>
      <p className="panel-empty__note">{note}</p>
      {action ? <a className="panel-empty__action" href="/">{action}</a> : null}
    </div>
  )
}
