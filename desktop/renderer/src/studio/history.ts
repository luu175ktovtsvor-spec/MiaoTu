import { studioText } from './studioText'
import { isLocalPlatformWaiting, type createProgressTracker, type ProgressPhase } from './generationProgressCore'
import type { HistoryItem, HistoryProgress, LedgerEntry, Summary } from './studioState'

export const STATUS_LABEL = { submitting: '正在提交…', confirming: '提交结果待确认', waiting: '等待平台处理', queued: '排队中', saving: '正在保存…', succeeded: '已完成', failed: '失败', running: '生成中', cancelled: '已取消', expired: '已过期' }
export const ACTIVE_STATUSES = new Set(['submitting', 'confirming', 'queued', 'running', 'saving'])
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'expired'])
export const HISTORY_PHASES: Record<string, ProgressPhase> = { submitting: 'submitting', confirming: 'confirming', waiting: 'confirming', queued: 'queued', running: 'running', saving: 'saving', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled', expired: 'failed' }

export function historyProgress(item: HistoryItem, tracker: ReturnType<typeof createProgressTracker>, now: number): HistoryProgress {
  const status = item.submissionUncertain && ACTIVE_STATUSES.has(item.status) ? 'confirming' : isLocalPlatformWaiting(item.model || '', item.status, item.error) ? 'waiting' : String(item.status || '')
  const value = item.progress
  const realPercent = (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null
  const startedAt = new Date(item.startedAt || item.started_at || '').getTime()
  return { ...tracker.view({
    phase: HISTORY_PHASES[status] || 'running',
    realPercent,
    elapsedSeconds: Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 1000) : 0,
    modelId: item.model || '',
    kind: item.kind === 'video' || item.video ? 'video' : 'image',
    durationSeconds: Number(item.duration) > 0 ? Number(item.duration) : null,
  }), status }
}

// ── 历史面板用的小件 ─────────────────────────────────────────────────────────

// 状态：色块分三档（进行中 / 出错 / 其它），不再是一行纯文字。
export const STATUS_TONE = { submitting: 'is-active', confirming: 'is-active', queued: 'is-active', running: 'is-active', saving: 'is-active', failed: 'is-error' }

// 流水行的分类与文案。服务端给的是中文原文，词典查不到就原样显示（服务端原文不改）。
export function ledgerRow(row: LedgerEntry, lang: string) {
  const raw = String(row.reason || '')
  const delta = Number(row.delta) || 0
  const recharge = raw.match(/充值到账\s*(\S+)/)
  // 订单号优先用接口给的 paymentOrderId；旧数据没有这个字段时再从 reason 里兜底抠出来。
  if (recharge) return { kind: 'recharge', text: studioText('充值到账', lang), sub: studioText('已到账', lang), order: String(row.paymentOrderId || recharge[1] || ''), delta }
  const grant = raw.match(/^(.*?)\s*注册初始额度$/)
  if (grant) return { kind: 'grant', text: grant[1] ? studioText('{provider} 注册初始额度', lang, { provider: grant[1] }) : studioText('注册初始额度', lang), sub: '', order: '', delta }
  if (/退还|退回/.test(raw)) return { kind: 'refund', text: studioText(raw, lang), sub: '', order: '', delta }
  if (raw === '生成预扣') return { kind: 'spend', text: studioText('生成预扣', lang), sub: '', order: '', delta }
  return { kind: delta > 0 ? 'refund' : 'spend', text: studioText(raw, lang), sub: '', order: '', delta }
}

export const LEDGER_BADGE = { recharge: '充值', grant: '赠送', spend: '消耗', refund: '退回' }
// 生成记录的类型筛选：值和取词都走词典。
export const HISTORY_KINDS = [['all', '全部'], ['image', '图片'], ['video', '视频']]

// 相对时间：一眼能读；绝对时间放 title 和下面那行小字。
export function relativeTime(value: string, lang: string, now = Date.now()) {
  const time = new Date(value || '').getTime()
  if (!Number.isFinite(time)) return '—'
  const minutes = Math.floor((now - time) / 60000)
  if (minutes < 1) return studioText('刚刚', lang)
  if (minutes < 60) return studioText('{n} 分钟前', lang, { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return studioText('{n} 小时前', lang, { n: hours })
  const days = Math.floor(hours / 24)
  if (days === 1) return studioText('昨天', lang)
  if (days < 7) return studioText('{n} 天前', lang, { n: days })
  return new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(new Date(time))
}

// 等待时长：秒→分钟→小时换着说，别在列表里甩一个 197401 秒出来。
export function waitingText(seconds: number, lang: string) {
  if (!Number.isFinite(seconds) || seconds < 60) return studioText('已等待 {n} 秒', lang, { n: Math.max(0, Math.round(seconds || 0)) })
  if (seconds < 3600) return studioText('已等待 {n} 分钟', lang, { n: Math.floor(seconds / 60) })
  return studioText('已等待 {n} 小时', lang, { n: Math.floor(seconds / 3600) })
}

export function historyTime(item: HistoryItem, locale: string, lang: string) {
  const date = new Date(item.created_at || '')
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = new Intl.DateTimeFormat(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(date)
  return `${day} ${time}`
}

// 当月小结的区间：用用户本地的月初/月末，服务端不猜时区；
// 服务端按**全量行**算（不受分页和 200 条上限影响），所以数字不会偏小。
export function currentMonthRange(now = new Date()) {
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  }
}

// 服务端小结的字段：历史是 runs，流水是 spent / gained（都按全量行算）。
export function summaryNumber(raw: Summary | null | undefined, key: keyof Summary) {
  const value = Number(raw?.[key])
  return Number.isFinite(value) ? value : null
}
