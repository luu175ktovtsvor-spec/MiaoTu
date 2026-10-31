// SELECT-only operational aggregates. Never call overview/recovery, providers,
// settings normalization, payment expiry, or feedback detail from this reader.
type Reader = {
  all(sql: string, ...args: any[]): Promise<any[]>;
  get(sql: string, ...args: any[]): Promise<any>;
  db?: { dialect: 'postgres' | 'sqlite' };
};
type CatalogItem = { id: string; publicId?: string; label?: string; video?: boolean };
const DAY = 86_400_000;
const number = (value: unknown) => Number(value || 0);
const round = (value: number) => Math.round(value * 10_000) / 10_000;
const fail = (message: string) => Object.assign(new Error(message), { status: 400 });
const mediaCounts = ['succeeded', 'failed', 'cancelled', 'expired', 'queued', 'running'];
const textCounts = ['succeeded', 'failed', 'cancelled', 'running', 'unknown', 'settledCalls', 'billingReviewCalls', 'zeroChargedCalls', 'knownUsageCalls', 'unknownUsageCalls'];
const mediaNumbers = ['calls', ...mediaCounts, 'chargedPoints', 'durationTotal', 'durationSamples', 'referenceCostTotal', 'referenceCostRows', 'missingCostRows'];
const textNumbers = ['calls', ...textCounts, 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'chargedPoints', 'durationTotal', 'durationSamples', 'firstTokenTotal', 'firstTokenSamples'];
const empty = (keys: string[]) => Object.fromEntries(keys.map(key => [key, 0]));
const add = (target: Record<string, number>, row: any, keys: string[]) => { for (const key of keys) target[key] += number(row[key]); };
const count = (condition: string, alias: string) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END) AS ${alias}`;

export function analyticsRange(query: Record<string, any> = {}, now = new Date()) {
  const timeZone = query.timeZone || 'Asia/Shanghai';
  if (!['UTC', 'Asia/Shanghai'].includes(timeZone)) throw fail('统计时区仅支持 UTC 或 Asia/Shanghai');
  const offset = timeZone === 'Asia/Shanghai' ? 8 * 3_600_000 : 0;
  const today = new Date(now.getTime() + offset).toISOString().slice(0, 10);
  const fromDate = String(query.from || new Date(Date.parse(today) - 6 * DAY).toISOString().slice(0, 10));
  const toDateInclusive = String(query.to || today);
  for (const day of [fromDate, toDateInclusive]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw fail('统计日期必须是有效的 YYYY-MM-DD');
  }
  const from = Date.parse(fromDate) - offset, to = Date.parse(toDateInclusive) - offset + DAY;
  const days = (to - from) / DAY;
  if (days < 1 || days > 93) throw fail('统计日期范围应为 1 至 93 天');
  const limit = query.limit === undefined ? 10 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('排行数量应为 1 至 50');
  const userId = query.userId ? String(query.userId) : '';
  if (userId && !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw fail('用户筛选无效');
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: new Date(from + offset + index * DAY).toISOString().slice(0, 10),
    from: new Date(from + index * DAY).toISOString(), to: new Date(from + (index + 1) * DAY).toISOString(),
  }));
  return { range: { fromDate, toDateInclusive, fromInclusive: new Date(from).toISOString(), toExclusive: new Date(to).toISOString(), timeZone, days }, buckets, limit, userId };
}

function mediaMetrics(raw: Record<string, number>) {
  const successRateBase = raw.succeeded + raw.failed + raw.expired;
  return { calls: raw.calls, ...Object.fromEntries(mediaCounts.map(key => [key, raw[key]])), chargedPoints: round(raw.chargedPoints),
    successRate: successRateBase ? raw.succeeded / successRateBase : null, successRateBase,
    averageDurationMs: raw.durationSamples ? round(raw.durationTotal / raw.durationSamples) : null,
    durationSamples: raw.durationSamples, p50DurationMs: null, p95DurationMs: null };
}
function textMetrics(raw: Record<string, number>) {
  const successRateBase = raw.succeeded + raw.failed;
  return { calls: raw.calls, ...Object.fromEntries(textCounts.map(key => [key, raw[key]])),
    inputTokens: raw.inputTokens, outputTokens: raw.outputTokens, cacheReadTokens: raw.cacheReadTokens, cacheWriteTokens: raw.cacheWriteTokens,
    chargedPoints: round(raw.chargedPoints), successRate: successRateBase ? raw.succeeded / successRateBase : null, successRateBase,
    averageDurationMs: raw.durationSamples ? round(raw.durationTotal / raw.durationSamples) : null, durationSamples: raw.durationSamples,
    averageFirstTokenMs: raw.firstTokenSamples ? round(raw.firstTokenTotal / raw.firstTokenSamples) : null, firstTokenSamples: raw.firstTokenSamples,
    p50DurationMs: null, p95DurationMs: null };
}

// Admin list filters must include historical/paused IDs without refreshing a
// supplier catalogue. Keep stored IDs distinct even when display names match.
export async function adminMediaModelOptions(store: Reader, catalog: CatalogItem[] = []) {
  const metadata = new Map<string, CatalogItem>();
  for (const model of catalog) for (const id of [model.id, model.publicId]) if (id) metadata.set(id, model);
  const rows = await store.all(`SELECT g.model,MAX(CASE WHEN v.generation_id IS NOT NULL THEN 1 ELSE 0 END) AS hasVideo
    FROM generations g LEFT JOIN video_results v ON v.generation_id=g.id GROUP BY g.model ORDER BY g.model`);
  return rows.filter(row => typeof row.model === 'string' && row.model.length > 0).map(row => {
    const model = metadata.get(row.model);
    return { id: row.model, label: model?.label || row.model,
      kind: number(row.hasVideo) || model?.video ? 'video' : model ? 'image' : 'unknown' };
  });
}

export async function adminAnalytics(store: Reader, query: Record<string, any> = {}, { catalog = [] as CatalogItem[], now = new Date() } = {}) {
  const { range, buckets, limit, userId } = analyticsRange(query, now);
  const bucketSql = `buckets(day,from_at,to_at) AS (VALUES ${buckets.map(() => '(?,?,?)').join(',')})`;
  const bucketArgs = buckets.flatMap(bucket => [bucket.date, bucket.from, bucket.to]);
  const filter = (alias: string) => `${alias}.created_at>=? AND ${alias}.created_at<?${userId ? ` AND ${alias}.user_id=?` : ''}`;
  const args = [range.fromInclusive, range.toExclusive, ...(userId ? [userId] : [])];
  const scopedUser = (alias: string) => userId ? ` WHERE ${alias}.user_id=?` : '';
  const currentArgs = userId ? [userId] : [];
  const ids = (video: boolean) => [...new Set(catalog.filter(model => Boolean(model.video) === video).flatMap(model => [model.id, model.publicId].filter((value): value is string => typeof value === 'string' && value.length > 0)))];
  const videos = ids(true), images = ids(false);
  const inList = (values: string[]) => values.length ? values.map(() => '?').join(',') : 'NULL';
  const kindSql = `CASE WHEN g.model IN (${inList(videos)}) OR EXISTS(SELECT 1 FROM video_results v WHERE v.generation_id=g.id) THEN 'video' WHEN g.model IN (${inList(images)}) THEN 'image' ELSE 'unknown' END`;
  const elapsed = store.db?.dialect === 'postgres'
    ? 'EXTRACT(EPOCH FROM (CAST(g.finished_at AS timestamptz)-CAST(g.created_at AS timestamptz)))*1000'
    : '(julianday(g.finished_at)-julianday(g.created_at))*86400000';
  const retainedCost = `COALESCE(CASE WHEN json_valid(g.upstream_cost) AND json_type(g.upstream_cost,'$.rmb') IN ('integer','real') THEN CAST(json_extract(g.upstream_cost,'$.rmb') AS REAL) END,
    (SELECT c.cost_rmb FROM upstream_calls c WHERE c.generation_id=g.id AND g.status='succeeded' AND c.status IN ('ok','succeeded') AND c.cost_rmb IS NOT NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1))`;
  const mediaSql = `WITH ${bucketSql}, scoped AS (
    SELECT g.user_id,g.model,g.status,g.created_at,g.charged_points,${kindSql} AS kind,
      CASE WHEN g.status='succeeded' AND g.finished_at>=g.created_at THEN ${elapsed} ELSE NULL END AS duration_ms,
      ${retainedCost} AS reference_cost FROM generations g WHERE ${filter('g')}
    ) SELECT b.day,s.user_id,s.model,s.kind,COUNT(*) AS calls,
    ${mediaCounts.map(status => count(`s.status='${status}'`, status)).join(',')},
    COALESCE(SUM(s.charged_points),0) AS chargedPoints,COALESCE(SUM(s.duration_ms),0) AS durationTotal,COUNT(s.duration_ms) AS durationSamples,
    COALESCE(SUM(CASE WHEN (s.status='succeeded' OR s.charged_points>0) AND s.reference_cost>=0 THEN s.reference_cost ELSE 0 END),0) AS referenceCostTotal,
    ${count("(s.status='succeeded' OR s.charged_points>0) AND s.reference_cost>=0", 'referenceCostRows')},
    ${count("(s.status='succeeded' OR s.charged_points>0) AND (s.reference_cost IS NULL OR s.reference_cost<0)", 'missingCostRows')}
    FROM buckets b JOIN scoped s ON s.created_at>=b.from_at AND s.created_at<b.to_at GROUP BY b.day,s.user_id,s.model,s.kind`;
  const textConditions = {
    succeeded: "t.invocation_status='succeeded'", failed: "t.invocation_status='failed'",
    cancelled: "t.invocation_status IN ('cancelled','aborted','disconnected')", running: "t.invocation_status IN ('pending','running')",
    unknown: "t.invocation_status IS NULL OR t.invocation_status NOT IN ('succeeded','failed','cancelled','aborted','disconnected','pending','running')",
    settledCalls: "t.status='settled'", billingReviewCalls: "t.status='billing_review'", zeroChargedCalls: "t.status='settled' AND t.charged_points=0",
    knownUsageCalls: 't.usage_known=1', unknownUsageCalls: 't.usage_known IS NULL OR t.usage_known<>1',
  };
  const textSql = `WITH ${bucketSql} SELECT b.day,t.user_id,t.model,COUNT(*) AS calls,
    ${Object.entries(textConditions).map(([name, condition]) => count(condition, name)).join(',')},
    ${['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].map((column, index) => `COALESCE(SUM(CASE WHEN t.usage_known=1 THEN t.${column} ELSE 0 END),0) AS ${['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'][index]}`).join(',')},
    COALESCE(SUM(t.charged_points),0) AS chargedPoints,
    COALESCE(SUM(CASE WHEN t.duration_ms>=0 THEN t.duration_ms ELSE 0 END),0) AS durationTotal,${count('t.duration_ms>=0', 'durationSamples')},
    COALESCE(SUM(CASE WHEN t.first_token_ms>=0 THEN t.first_token_ms ELSE 0 END),0) AS firstTokenTotal,${count('t.first_token_ms>=0', 'firstTokenSamples')}
    FROM buckets b JOIN text_charges t ON t.created_at>=b.from_at AND t.created_at<b.to_at
    WHERE ${filter('t')} GROUP BY b.day,t.user_id,t.model`;
  const ledgerSql = `WITH ${bucketSql}, classified AS (
    SELECT l.created_at,l.delta,CASE
      WHEN p.id IS NOT NULL AND p.status='paid' AND l.delta>0 THEN 'paymentPoints'
      WHEN g.id IS NOT NULL AND t.id IS NULL AND c.id IS NULL THEN CASE WHEN l.delta<0 THEN 'mediaDebitedPoints' ELSE 'mediaRefundedPoints' END
      WHEN t.id IS NOT NULL AND g.id IS NULL AND c.id IS NULL THEN CASE WHEN l.delta<0 THEN 'textDebitedPoints' ELSE 'textRefundedPoints' END
      WHEN c.id IS NOT NULL AND g.id IS NULL AND t.id IS NULL AND l.delta>0 THEN 'giftedPoints'
      ELSE CASE WHEN l.delta<0 THEN 'otherDebitedPoints' ELSE 'otherCreditedPoints' END END AS category
    FROM ledger l LEFT JOIN payment_orders p ON p.id=l.payment_order_id AND p.user_id=l.user_id
      LEFT JOIN generations g ON g.id=l.request_id AND g.user_id=l.user_id
      LEFT JOIN text_charges t ON t.request_id=l.request_id AND t.user_id=l.user_id
      LEFT JOIN credit_grants c ON c.id=l.request_id AND c.user_id=l.user_id WHERE ${filter('l')}
    ) SELECT b.day,l.category,SUM(ABS(l.delta)) AS points FROM buckets b JOIN classified l ON l.created_at>=b.from_at AND l.created_at<b.to_at GROUP BY b.day,l.category`;
  const paymentSql = `WITH ${bucketSql} SELECT b.day,COUNT(*) AS orders,SUM(p.amount_cents) AS cents,
      SUM(COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.payment_order_id=p.id AND l.user_id=p.user_id),0)) AS credited
    FROM buckets b JOIN payment_orders p ON p.completed_at>=b.from_at AND p.completed_at<b.to_at
    WHERE p.status='paid' AND p.completed_at>=? AND p.completed_at<?${userId ? ' AND p.user_id=?' : ''} GROUP BY b.day`;
  const pendingSql = `SELECT ${count("g.status='queued'", 'queuedMedia')},${count("g.status='running'", 'runningMedia')},
    ${count("g.status='running' AND CASE WHEN json_valid(g.parameters) THEN json_extract(g.parameters,'$.submissionUncertain') ELSE 0 END=1", 'submissionUnknownMedia')},
    ${count("g.status='running' AND CASE WHEN json_valid(g.parameters) THEN json_extract(g.parameters,'$.imageResultPending') ELSE 0 END=1", 'resultPendingMedia')}
    FROM generations g${scopedUser('g')}`;
  const textPendingSql = `SELECT ${count("t.status='reserved'", 'reservedTextCalls')},${count("t.status='billing_review'", 'reviewTextCalls')},
    COALESCE(SUM(CASE WHEN t.status='reserved' THEN t.reserved_points ELSE 0 END),0) AS reservedTextPoints,
    COALESCE(SUM(CASE WHEN t.status='billing_review' THEN t.reserved_points ELSE 0 END),0) AS reviewTextPoints FROM text_charges t${scopedUser('t')}`;
  const balanceSql = `SELECT ${count('ABS(ROUND(u.points-COALESCE(l.points,0),4))>0.0001', 'balanceMismatchUsers')}
    FROM users u LEFT JOIN(SELECT user_id,SUM(delta) AS points FROM ledger GROUP BY user_id) l ON l.user_id=u.id${userId ? ' WHERE u.id=?' : ''}`;
  const [mediaRows, textRows, ledgerRows, paymentRows, users, pendingMedia, pendingText, pendingFeedback, balance] = await Promise.all([
    store.all(mediaSql, ...bucketArgs, ...videos, ...images, ...args), store.all(textSql, ...bucketArgs, ...args),
    store.all(ledgerSql, ...bucketArgs, ...args), store.all(paymentSql, ...bucketArgs, ...args),
    store.all('SELECT id,name,created_at FROM users' + (userId ? ' WHERE id=?' : ''), ...currentArgs),
    store.get(pendingSql, ...currentArgs), store.get(textPendingSql, ...currentArgs),
    store.get(`SELECT ${count("i.status='open'", 'openFeedback')},${count('i.admin_unread>0', 'unreadFeedback')} FROM feedback_issues i${scopedUser('i')}`, ...currentArgs),
    store.get(balanceSql, ...currentArgs),
  ]);
  const media = empty(mediaNumbers), text = empty(textNumbers);
  const kinds = Object.fromEntries(['image', 'video', 'unknown'].map(kind => [kind, empty(mediaNumbers)]));
  const callers = new Set<string>(), userRows = new Map<string, any>(), models = new Map<string, any>();
  const names = new Map(users.map(row => [row.id, row.name]));
  const daily = buckets.map(bucket => ({ date: bucket.date, callingUsers: 0, mediaCalls: 0, imageCalls: 0, videoCalls: 0,
    mediaSucceeded: 0, mediaFailed: 0, mediaExpired: 0, textCalls: 0, textSucceeded: 0, textFailed: 0, inputTokens: 0, outputTokens: 0,
    mediaChargedPoints: 0, textChargedPoints: 0, paidOrders: 0, paidAmountCents: 0, refundedPoints: 0 }));
  const byDay = new Map(daily.map(row => [row.date, row]));
  const dayUsers = new Map(buckets.map(bucket => [bucket.date, new Set<string>()]));
  const dayLatency = new Map(buckets.map(bucket => [bucket.date, Object.fromEntries(['image', 'video', 'unknown', 'text'].map(kind => [kind, empty(['durationTotal', 'durationSamples', 'firstTokenTotal', 'firstTokenSamples'])]))]));
  let unattributedMediaCalls = 0;
  const rank = (row: any, type: 'media' | 'text') => {
    const key = type === 'text' ? 'text' : row.kind;
    const modelKey = JSON.stringify([key, row.model]);
    if (!models.has(modelKey)) models.set(modelKey, { kind: key, model: row.model, raw: empty(type === 'text' ? textNumbers : mediaNumbers) });
    add(models.get(modelKey).raw, row, type === 'text' ? textNumbers : mediaNumbers);
    if (!row.user_id) { if (type === 'media') unattributedMediaCalls += number(row.calls); return; }
    callers.add(row.user_id); dayUsers.get(row.day)!.add(row.user_id);
    if (!userRows.has(row.user_id)) userRows.set(row.user_id, { userId: row.user_id, name: names.get(row.user_id) || null, calls: 0, mediaCalls: 0, textCalls: 0, inputTokens: 0, outputTokens: 0, chargedPoints: 0 });
    const user = userRows.get(row.user_id); user.calls += number(row.calls); user[type === 'text' ? 'textCalls' : 'mediaCalls'] += number(row.calls);
    user.chargedPoints += number(row.chargedPoints);
    if (type === 'text') { user.inputTokens += number(row.inputTokens); user.outputTokens += number(row.outputTokens); }
  };
  for (const row of mediaRows) {
    add(media, row, mediaNumbers); add(kinds[row.kind], row, mediaNumbers); rank(row, 'media');
    const day = byDay.get(row.day)!; day.mediaCalls += number(row.calls);
    add(dayLatency.get(row.day)![row.kind], row, ['durationTotal', 'durationSamples']);
    if (row.kind === 'image') day.imageCalls += number(row.calls);
    if (row.kind === 'video') day.videoCalls += number(row.calls);
    day.mediaSucceeded += number(row.succeeded); day.mediaFailed += number(row.failed); day.mediaExpired += number(row.expired);
    day.mediaChargedPoints += number(row.chargedPoints);
  }
  for (const row of textRows) {
    add(text, row, textNumbers); rank(row, 'text'); const day = byDay.get(row.day)!;
    add(dayLatency.get(row.day)!.text, row, ['durationTotal', 'durationSamples', 'firstTokenTotal', 'firstTokenSamples']);
    day.textCalls += number(row.calls); day.textSucceeded += number(row.succeeded); day.textFailed += number(row.failed);
    day.inputTokens += number(row.inputTokens); day.outputTokens += number(row.outputTokens); day.textChargedPoints += number(row.chargedPoints);
  }
  const ledger = empty(['paymentPoints', 'mediaDebitedPoints', 'mediaRefundedPoints', 'textDebitedPoints', 'textRefundedPoints', 'giftedPoints', 'otherCreditedPoints', 'otherDebitedPoints']);
  for (const row of ledgerRows) {
    ledger[row.category] += number(row.points);
    if (['mediaRefundedPoints', 'textRefundedPoints'].includes(row.category)) byDay.get(row.day)!.refundedPoints += number(row.points);
  }
  let paidOrders = 0, paidAmountCents = 0, paidCreditedPoints = 0;
  for (const row of paymentRows) {
    const day = byDay.get(row.day)!; day.paidOrders = number(row.orders); day.paidAmountCents = number(row.cents);
    paidOrders += number(row.orders); paidAmountCents += number(row.cents); paidCreditedPoints += number(row.credited);
  }
  for (const day of daily) {
    day.callingUsers = dayUsers.get(day.date)!.size;
    day.mediaChargedPoints = round(day.mediaChargedPoints); day.textChargedPoints = round(day.textChargedPoints); day.refundedPoints = round(day.refundedPoints);
  }
  const pending: Record<string, any> = { scope: 'current_state_all_dates', ...Object.fromEntries(Object.entries({ ...pendingMedia, ...pendingText, ...pendingFeedback, ...balance }).map(([key, value]) => [key, round(number(value))])), balanceTolerancePoints: 0.0001 };
  const attention = [
    { code: 'media_submission_unknown', count: number(pending.submissionUnknownMedia), scope: 'current_state_all_dates', level: 'review', target: 'generation' },
    { code: 'media_result_pending', count: number(pending.resultPendingMedia), scope: 'current_state_all_dates', level: 'review', target: 'generation' },
    { code: 'text_billing_review', count: number(pending.reviewTextCalls), scope: 'current_state_all_dates', level: 'review', target: 'text' },
    { code: 'unread_feedback', count: number(pending.unreadFeedback), scope: 'current_state_all_dates', level: 'review', target: 'feedback' },
    { code: 'balance_mismatch', count: number(pending.balanceMismatchUsers), scope: 'current_state_all_dates', level: 'review', target: 'users' },
    { code: 'media_failed_in_range', count: media.failed + media.expired, scope: 'selected_range', level: 'info', target: 'generation' },
    { code: 'text_failed_in_range', count: text.failed, scope: 'selected_range', level: 'info', target: 'text' },
    { code: 'media_missing_cost_reference', count: media.missingCostRows, scope: 'selected_range', level: 'info', target: 'generation' },
  ].filter(item => item.count > 0);
  const rankedUsers = [...userRows.values()].map(row => ({ ...row, chargedPoints: round(row.chargedPoints) }));
  const tie = (a: any, b: any) => String(a.userId).localeCompare(String(b.userId));
  const commonQuery = { from: range.fromInclusive, to: range.toExclusive, ...(userId ? { userId } : {}) };
  const modelCounts = new Map<string, number>();
  const rankedModels = [...models.values()].map(row => ({ kind: row.kind, model: row.model, ...(row.kind === 'text' ? textMetrics(row.raw) : mediaMetrics(row.raw)) }))
    .sort((a, b) => b.calls - a.calls || String(a.model).localeCompare(String(b.model)))
    .filter(row => { const used = modelCounts.get(row.kind) || 0; modelCounts.set(row.kind, used + 1); return used < limit; });
  return { schemaVersion: 1, generatedAt: now.toISOString(), range,
    summary: { callingUsers: callers.size, registeredUsers: users.length, newUsers: users.filter(row => row.created_at >= range.fromInclusive && row.created_at < range.toExclusive).length,
      unattributedMediaCalls, media: mediaMetrics(media), mediaByKind: Object.entries(kinds).map(([kind, raw]) => ({ kind, ...mediaMetrics(raw) })), text: textMetrics(text) },
    daily: daily.map(day => ({ ...day, latency: Object.fromEntries(Object.entries(dayLatency.get(day.date)!).map(([kind, raw]) => [kind, {
      averageDurationMs: raw.durationSamples ? round(raw.durationTotal / raw.durationSamples) : null, durationSamples: raw.durationSamples,
      ...(kind === 'text' ? { averageFirstTokenMs: raw.firstTokenSamples ? round(raw.firstTokenTotal / raw.firstTokenSamples) : null, firstTokenSamples: raw.firstTokenSamples } : {}),
    }])) })), rankings: {
      usersByCalls: [...rankedUsers].sort((a, b) => b.calls - a.calls || tie(a, b)).slice(0, limit),
      usersByChargedPoints: rankedUsers.filter(row => row.chargedPoints > 0).sort((a, b) => b.chargedPoints - a.chargedPoints || tie(a, b)).slice(0, limit),
      models: rankedModels,
    }, finance: { paidOrders, paidAmountCents, paidCreditedPoints: round(paidCreditedPoints), ledger: Object.fromEntries(Object.entries(ledger).map(([key, value]) => [key, round(value)])),
      manualAdjustmentPoints: null, cashRefundCents: null, costRmb: null, profitRmb: null, evidenceStatus: 'ledger_linked_classification_no_invoice_profit' },
    pending, attention, evidence: { mediaReferenceCostRmb: media.referenceCostRows ? round(media.referenceCostTotal) : null, mediaReferenceCostRows: media.referenceCostRows,
      mediaMissingCostRows: media.missingCostRows, textCostRmb: null, invoiceVerified: false,
      periodBasis: 'requests_created_at_payments_completed_at_ledger_created_at', textScope: 'platform_text_charges_only', manualAdjustmentStatus: 'not_separately_identifiable' },
    drilldown: { mediaQuery: commonQuery, textQuery: commonQuery },
  };
}
