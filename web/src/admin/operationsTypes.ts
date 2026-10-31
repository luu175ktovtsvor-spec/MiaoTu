export type MediaMetrics = {
  calls: number; succeeded: number; failed: number; cancelled: number; expired: number;
  queued: number; running: number; chargedPoints: number; successRate: number | null;
  successRateBase: number; averageDurationMs: number | null; durationSamples: number;
}
export type TextMetrics = {
  calls: number; succeeded: number; failed: number; cancelled: number; running: number; unknown: number;
  settledCalls: number; billingReviewCalls: number; zeroChargedCalls: number;
  knownUsageCalls: number; unknownUsageCalls: number; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number; chargedPoints: number;
  successRate: number | null; successRateBase: number; averageDurationMs: number | null;
  durationSamples: number; averageFirstTokenMs: number | null; firstTokenSamples: number;
}
export type UserRank = { userId: string; name: string | null; mediaCalls: number; textCalls: number; calls: number; inputTokens: number; outputTokens: number; chargedPoints: number }
export type ModelRank = ({ kind: 'image' | 'video' | 'unknown'; model: string } & MediaMetrics) | ({ kind: 'text'; model: string } & TextMetrics)
export type OperationsAnalytics = {
  schemaVersion: 1; generatedAt: string;
  range: { fromDate: string; toDateInclusive: string; fromInclusive: string; toExclusive: string; timeZone: 'UTC' | 'Asia/Shanghai'; days: number };
  summary: { callingUsers: number; registeredUsers: number; newUsers: number; unattributedMediaCalls: number; media: MediaMetrics; mediaByKind: Array<MediaMetrics & { kind: 'image' | 'video' | 'unknown' }>; text: TextMetrics };
  daily: Array<{ date: string; callingUsers: number; mediaCalls: number; imageCalls: number; videoCalls: number; mediaSucceeded: number; mediaFailed: number; mediaExpired: number; textCalls: number; textSucceeded: number; textFailed: number; inputTokens: number; outputTokens: number; mediaChargedPoints: number; textChargedPoints: number; paidOrders: number; paidAmountCents: number; refundedPoints: number }>;
  rankings: { usersByCalls: UserRank[]; usersByChargedPoints: UserRank[]; models: ModelRank[] };
  finance: { paidOrders: number; paidAmountCents: number; paidCreditedPoints: number; ledger: { paymentPoints: number; mediaDebitedPoints: number; mediaRefundedPoints: number; textDebitedPoints: number; textRefundedPoints: number; giftedPoints: number; otherCreditedPoints: number; otherDebitedPoints: number }; manualAdjustmentPoints: null; cashRefundCents: null; costRmb: null; profitRmb: null; evidenceStatus: string };
  pending: { scope: 'current_state_all_dates'; queuedMedia: number; runningMedia: number; submissionUnknownMedia: number; resultPendingMedia: number; reservedTextCalls: number; reviewTextCalls: number; reservedTextPoints: number; reviewTextPoints: number; openFeedback: number; unreadFeedback: number; balanceMismatchUsers: number; balanceTolerancePoints: number };
  evidence: { mediaReferenceCostRmb: number | null; mediaReferenceCostRows: number; mediaMissingCostRows: number; textCostRmb: null; invoiceVerified: false; periodBasis: string; textScope: string; manualAdjustmentStatus: string };
  drilldown: { mediaQuery: { from: string; to: string; userId?: string }; textQuery: { from: string; to: string; userId?: string } };
}
export type AnalyticsDrilldown = { section: 'generations' | 'text' | 'users' | 'payments' | 'feedback' | 'upstream'; userId?: string; model?: string; kind?: string; status?: string; billing?: string; from?: string; to?: string; label?: string; timeZone?: string }

export function analyticsScopeLabel(scope: Pick<AnalyticsDrilldown, 'from' | 'to' | 'timeZone'>, lang: string) {
  if (!scope.from || !scope.to) return lang === 'en' ? 'All dates' : '全部日期'
  const zone = scope.timeZone || 'UTC'
  const format = (value: number) => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
    const get = (type: string) => parts.find(part => part.type === type)?.value || ''
    return `${get('year')}-${get('month')}-${get('day')}`
  }
  return `${format(Date.parse(scope.from))} — ${format(Date.parse(scope.to) - 1)} · ${zone === 'Asia/Shanghai' ? lang === 'en' ? 'Beijing time' : '北京时间' : 'UTC'}`
}
