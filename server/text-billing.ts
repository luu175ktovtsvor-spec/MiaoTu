import { someAsync } from './async-collections.ts'
import { randomUUID } from 'node:crypto'
import { ownTextModelById, ownTextModelIds, textChannelOf } from './text-model-registry.ts'
import { assertTextModelPolicy } from './text-model-policy.ts'
import { requireModelUser } from './model-access.ts'
import { normalizeTextPrices, textCreditsForUsage, textSettlementAmounts } from './text-pricing.ts'

const fail = (message: string, status = 400) => Object.assign(new Error(message), { status })
const parse = (value, fallback: any = {}) => { try { return JSON.parse(value) ?? fallback } catch { return fallback } }
const round = value => Math.round(Number(value || 0) * 10000) / 10000
const count = value => Number.isSafeInteger(value) && value >= 0

export function normalizeTextBilling(raw: any = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['agentEnabled','reserveOutputTokens','version'].includes(k))) throw fail('文本计费设置无效')
  if (raw.agentEnabled !== undefined && typeof raw.agentEnabled !== 'boolean') throw fail('文本计费开关无效')
  const reserve = raw.reserveOutputTokens ?? 4096
  if (!Number.isSafeInteger(reserve) || reserve < 1 || reserve > 1_000_000) throw fail('预扣输出用量必须是 1 到 1000000 的整数')
  return { agentEnabled: raw.agentEnabled === true, reserveOutputTokens: reserve, version: typeof raw.version === 'string' ? raw.version : 'initial' }
}

export function normalizeTextUserPolicy(raw: any = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['mode','multiplier','expiresAt','freeCalls','models','note'].includes(k))) throw fail('用户文本计费规则无效')
  const mode = raw.mode || 'inherit', multiplier = Number(raw.multiplier ?? 1)
  if (!['inherit','free','paid'].includes(mode) || !Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) throw fail('用户计费模式或倍率无效')
  const expiresAt = raw.expiresAt ? new Date(raw.expiresAt) : null
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw fail('有效期无效')
  const freeCalls = raw.freeCalls === null || raw.freeCalls === undefined || raw.freeCalls === '' ? null : Number(raw.freeCalls)
  if (freeCalls !== null && (!Number.isSafeInteger(freeCalls) || freeCalls < 1 || freeCalls > 1_000_000)) throw fail('赠送调用次数必须是 1 到 1000000 的整数')
  const models = raw.models || []
  if (!Array.isArray(models) || models.some(id => !ownTextModelById(id))) throw fail('赠送模型无效')
  return { mode, multiplier: round(multiplier), expiresAt: expiresAt?.toISOString() || null, freeCalls, models: [...new Set(models)], note: String(raw.note || '').trim().slice(0, 200) }
}

// Text inference accounting is independent of media and of the UI. Holds,
// receipts, policy snapshots and ledger entries commit under the same write lock.
export class TextBilling {
  declare store: any
  async initialize(store: any, execSchema = async sql => (await store.db.exec(sql))) {
    this.store = store
    await execSchema(`CREATE TABLE IF NOT EXISTS text_user_policies(user_id TEXT PRIMARY KEY,policy TEXT NOT NULL,free_used INTEGER NOT NULL DEFAULT 0,revision TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_grants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,points REAL NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);`)
    const additions = { operation_id:'TEXT', source:'TEXT', channel:'TEXT', invocation_status:'TEXT', pricing_snapshot:'TEXT', list_points:'REAL', discount_points:'REAL', cache_read_tokens:'INTEGER', cache_write_tokens:'INTEGER', reasoning_tokens:'INTEGER', usage_known:'INTEGER', upstream_request_id:'TEXT', response_id:'TEXT', upstream_status:'INTEGER', duration_ms:'INTEGER', first_token_ms:'INTEGER', upstream_cost:'REAL', policy_revision:'TEXT', gifted_call:'INTEGER NOT NULL DEFAULT 0', dispatched_at:'TEXT' }
    const columns = new Set((await store.all('PRAGMA table_info(text_charges)')).map(row => row.name))
    for (const [key,type] of Object.entries(additions)) if (!columns.has(key)) {
      try { await execSchema(`ALTER TABLE text_charges ADD COLUMN ${key} ${type}`) }
      catch (error) { if (!/duplicate column/i.test(error.message)) throw error }
    }
    await execSchema(`CREATE TABLE IF NOT EXISTS text_upstream_usage(id TEXT PRIMARY KEY,model TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,gateway_cost_usd REAL,request_id TEXT,session_id TEXT,upstream_request_id TEXT,account_id INTEGER,channel TEXT NOT NULL,duration_ms INTEGER,first_token_ms INTEGER,created_at TEXT NOT NULL);`)
    await execSchema('CREATE INDEX IF NOT EXISTS text_charges_operation ON text_charges(operation_id); CREATE INDEX IF NOT EXISTS text_charges_time ON text_charges(created_at DESC); CREATE INDEX IF NOT EXISTS text_charges_upstream ON text_charges(upstream_request_id); CREATE INDEX IF NOT EXISTS text_upstream_session ON text_upstream_usage(session_id); CREATE INDEX IF NOT EXISTS text_upstream_request ON text_upstream_usage(request_id);')
  }
  async userPolicy(userId) {
    const row = (await this.store.get('SELECT * FROM text_user_policies WHERE user_id=?', userId))
    return { ...normalizeTextUserPolicy(parse(row?.policy)), freeUsed: Number(row?.free_used || 0), revision: row?.revision || null }
  }
  async saveUserPolicy(userId, raw, actor) {
    const policy = normalizeTextUserPolicy(raw)
    return (await this.store.transaction(async () => {
      await this.store.db.lockRow('users','id',userId)
      if (!(await this.store.user(userId))) throw fail('用户不存在', 404)
      const previous = (await this.userPolicy(userId))
      const renewed = ['mode','expiresAt','freeCalls','models'].some(key=>JSON.stringify(previous[key])!==JSON.stringify(policy[key]))
      const used = renewed ? 0 : previous.freeUsed
      const revision = renewed || !previous.revision ? randomUUID() : previous.revision, now = new Date().toISOString()
      // Saving a policy starts a new explicit grant; old request snapshots retain
      // their original revision and can never consume/refund the new allowance.
      await this.store.run('INSERT INTO text_user_policies VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy,free_used=excluded.free_used,revision=excluded.revision,updated_at=excluded.updated_at', userId, JSON.stringify(policy), used, revision, now)
      await this.store.audit(actor, 'text.policy.update', userId, policy)
      return (await this.userPolicy(userId))
    }))
  }
  async policy(userId, modelId, source = 'agent') {
    const settings = (await this.store.settings()), user = (await this.userPolicy(userId))
    const billing = normalizeTextBilling(settings.textBilling)
    const prices = normalizeTextPrices(settings.textPrices)
    const current = (!user.expiresAt || Date.parse(user.expiresAt) > Date.now()) && (!user.models.length || user.models.includes(modelId))
    const giftAvailable = current && user.mode === 'free' && (user.freeCalls === null || user.freeUsed < user.freeCalls)
    const agent = ['agent','desktop_agent','cloud_agent'].includes(source)
    const enabled = giftAvailable ? false : current && user.mode === 'paid' ? true : agent ? billing.agentEnabled : true
    const multiplier = current && user.mode !== 'free' ? user.multiplier : 1
    const price = prices[modelId]
    const free = !enabled || multiplier === 0 || !price || !Object.values(price).some(Number)
    return { version: billing.version, model: modelId, source, mode: giftAvailable ? 'gift' : !enabled ? 'free' : 'usage', multiplier, price, free, policyRevision: user.revision, giftedCall: giftAvailable, reserveOutputTokens: billing.reserveOutputTokens, capturedAt: new Date().toISOString() }
  }
  async hasFreeAccess(userId, modelId?: string, source = 'agent') {
    return (await someAsync((modelId ? [modelId] : ownTextModelIds()), async id => (await this.policy(userId, id, source)).free))
  }
  async reserve({ session, model, requestId, operationId = requestId, source = 'legacy', inputTokens = 0, outputTokens, points = 0 }: Record<string, any>) {
    return (await this.store.transaction(async () => {
      await this.store.db.lockRow('users','id',session.userId)
      await requireModelUser(session)
      if (![requestId,operationId].every(id=>typeof id==='string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(id))) throw fail('文本请求编号无效')
      if (!Number.isFinite(inputTokens) || inputTokens < 0 || outputTokens !== undefined && (!count(outputTokens) || outputTokens < 1)) throw fail('预扣用量无效')
      const existing = (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', requestId))
      if (existing) {
        if (existing.user_id !== session.userId || existing.model !== model) throw fail('请求编号已使用', 409)
        return existing
      }
      const user = (await this.store.user(session.userId))
      if (!user || user.status !== 'active') throw fail('账号已停用', 403)
      const entry = ownTextModelById(model)
      if (!entry) throw fail('文本模型不可用', 422)
      assertTextModelPolicy((await this.store.settings()), model, user.models || [])
      const snapshot = (await this.policy(user.id, model, source))
      if (!snapshot.free && !(user.points > 0)) throw fail('积分不足，请先充值后使用文本模型', 402)
      const estimate = source === 'legacy' ? Number(points) : textCreditsForUsage(model, { input_tokens: Math.max(0, Math.ceil(inputTokens)), output_tokens: Math.min(outputTokens || snapshot.reserveOutputTokens,snapshot.reserveOutputTokens) }, { [model]: snapshot.price })
      const reserved = snapshot.free ? 0 : round(estimate * snapshot.multiplier)
      if (reserved > 0 && (await this.store.run('UPDATE users SET points=ROUND(points-?,4) WHERE id=? AND points>=?', reserved, user.id, reserved)).changes !== 1) throw fail('积分不足以预扣本次文本用量', 402)
      const now = new Date().toISOString()
      if (snapshot.giftedCall) await this.store.run('UPDATE text_user_policies SET free_used=free_used+1 WHERE user_id=? AND revision=?', user.id, snapshot.policyRevision)
      if (reserved > 0) await this.store.ledger(user.id, -reserved, '文本模型预扣', requestId)
      await this.store.run(`INSERT INTO text_charges(id,user_id,model,status,reserved_points,charged_points,request_id,created_at,operation_id,source,channel,invocation_status,pricing_snapshot,policy_revision,gifted_call)
        VALUES(?,?,?,'reserved',?,0,?,?,?,?,?,'pending',?,?,?)`, randomUUID(), user.id, model, reserved, requestId, now, operationId, source, textChannelOf(entry).id, JSON.stringify(snapshot), snapshot.policyRevision, Number(snapshot.giftedCall))
      return (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', requestId))
    }))
  }
  async dispatched(id) { await this.store.run("UPDATE text_charges SET dispatched_at=?,invocation_status='running' WHERE request_id=? AND status='reserved'", new Date().toISOString(), id) }
  async metadata(id, value) {
    await this.store.run('UPDATE text_charges SET upstream_request_id=?,response_id=?,upstream_status=?,duration_ms=?,first_token_ms=? WHERE request_id=?', value.upstreamRequestId || null, value.responseId || null, value.httpStatus || null, value.durationMs ?? null, value.firstTokenMs ?? null, id)
  }
  async settle(id, { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, reasoningTokens = null, invocationStatus = 'succeeded' }: Record<string, any> = {}) {
    if (![inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens].every(count)) throw fail('文本用量无效')
    return (await this.store.transaction(async () => {
      await this.store.db.lockRow('text_charges','request_id',id)
      const row = (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', id))
      if (!row || row.status !== 'reserved') return row
      const snapshot = parse(row.pricing_snapshot)
      // Older rows without a price snapshot are never retroactively repriced.
      if (!snapshot.price) return (await this.review(id, '旧请求未留存价格快照，需人工核对'))
      const usage = { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens }
      const list = textCreditsForUsage(row.model, usage, { [row.model]: snapshot.price })
      const amount = snapshot.free ? 0 : round(list * snapshot.multiplier)
      const { extra, refund } = textSettlementAmounts(amount, row.reserved_points)
      await this.store.run('UPDATE text_charges SET input_tokens=?,output_tokens=?,cache_read_tokens=?,cache_write_tokens=?,reasoning_tokens=?,usage_known=1,invocation_status=?,list_points=?,discount_points=? WHERE request_id=?', inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, invocationStatus, list, Math.max(0,round(list - amount)), id)
      if (extra > 0 && (await this.store.run('UPDATE users SET points=ROUND(points-?,4) WHERE id=? AND points>=?', extra, row.user_id, extra)).changes !== 1) return (await this.review(id, `实际用量超出预扣，待补扣 ${extra} 积分`))
      if (extra > 0) await this.store.ledger(row.user_id, -extra, '文本模型实际用量补扣', id)
      if (refund > 0) { await this.store.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?', refund, row.user_id); await this.store.ledger(row.user_id, refund, '文本模型未使用额度退还', id) }
      await this.store.run("UPDATE text_charges SET status='settled',charged_points=?,finished_at=? WHERE request_id=?", amount, new Date().toISOString(), id)
      return (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', id))
    }))
  }
  async fail(id, error = '', invocationStatus = 'failed') {
    return (await this.store.transaction(async () => {
      await this.store.db.lockRow('text_charges','request_id',id)
      const row = (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', id))
      if (!row || row.status !== 'reserved') return row
      const reserved = Number(row.reserved_points || 0)
      if (reserved) { await this.store.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?', reserved, row.user_id); await this.store.ledger(row.user_id, reserved, '文本模型失败退还', id) }
      if (row.gifted_call) await this.store.run('UPDATE text_user_policies SET free_used=MAX(0,free_used-1) WHERE user_id=? AND revision=?', row.user_id, row.policy_revision)
      await this.store.run("UPDATE text_charges SET status='failed',invocation_status=?,error=?,finished_at=? WHERE request_id=?", invocationStatus, String(error).slice(0,500), new Date().toISOString(), id)
      return (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', id))
    }))
  }
  async review(id, error = '') {
    return this.store.transaction(async () => {
      await this.store.db.lockRow('text_charges','request_id',id)
      await this.store.run("UPDATE text_charges SET status='billing_review',invocation_status=CASE WHEN invocation_status IN ('pending','running') THEN 'unknown' ELSE invocation_status END,error=?,finished_at=? WHERE request_id=? AND status='reserved'", String(error).slice(0,500), new Date().toISOString(), id)
    return (await this.store.get('SELECT * FROM text_charges WHERE request_id=?', id))
    })
  }
  async gift(userId, { points, reason, requestId }, actor) {
    points = Number(points); reason = String(reason || '').trim()
    if (!Number.isFinite(points) || points <= 0 || points > 1_000_000 || round(points) !== points || !reason || reason.length > 200 || !/^[A-Za-z0-9_-]{12,100}$/.test(requestId || '')) throw fail('请填写有效赠送积分、原因及请求编号')
    return (await this.store.transaction(async () => {
      await this.store.db.lockRow('users','id',userId)
      const existing = (await this.store.get('SELECT * FROM credit_grants WHERE id=?', requestId))
      if (existing) { if (existing.user_id !== userId || existing.points !== points || existing.reason !== reason) throw fail('赠送请求编号已使用',409); return (await this.store.user(userId)) }
      if (!(await this.store.user(userId))) throw fail('用户不存在',404)
      const now = new Date().toISOString()
      await this.store.run('INSERT INTO credit_grants VALUES(?,?,?,?,?,?)', requestId,userId,points,reason,actor,now)
      await this.store.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?', points,userId)
      await this.store.ledger(userId,points,`管理员赠送：${reason}`,requestId)
      await this.store.audit(actor,'points.gift',userId,{ points,reason,requestId })
      return (await this.store.user(userId))
    }))
  }
  async operation(operationId) {
    return (await this.store.get(`SELECT operation_id AS requestId,CASE WHEN SUM(CASE WHEN status='billing_review' THEN 1 ELSE 0 END)>0 THEN 'billing_review' WHEN SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END)>0 THEN 'reserved' WHEN SUM(CASE WHEN status='settled' THEN 1 ELSE 0 END)>0 THEN 'settled' ELSE 'failed' END AS status,SUM(charged_points) AS chargedPoints FROM text_charges WHERE operation_id=? GROUP BY operation_id`, operationId))
  }
  async list({ page = 1, limit = 30, userId = '', model = '', status = '', source = '', billing = '', from = '', to = '', search = '' }: Record<string, any> = {}) {
    page = Math.max(1,Math.min(100000,Number(page)||1)); limit = Math.max(1,Math.min(100,Number(limit)||30))
    page = Math.floor(page); limit = Math.floor(limit)
    const clauses = ['1=1'], args: any[] = []
    for (const [key,value] of [['t.user_id',userId],['t.model',model],['t.invocation_status',status],['t.source',source],['t.status',billing]]) if (value) { clauses.push(`${key}=?`); args.push(String(value)) }
    for (const [op,value] of [['>=',from],['<',to]]) if (value) { const date=new Date(String(value));if(!Number.isFinite(date.getTime()))throw fail('日期范围无效'); clauses.push(`t.created_at${op}?`);args.push(date.toISOString()) }
    if (search) { clauses.push('(u.name LIKE ? OR u.email LIKE ? OR t.request_id LIKE ? OR t.upstream_request_id LIKE ?)'); const term='%'+String(search).slice(0,100)+'%';args.push(term,term,term,term) }
    const history = {
      id:"'gateway:'||g.id",user_id:'NULL',model:'g.model',status:"'upstream_only'",reserved_points:'NULL',charged_points:'NULL',input_tokens:'g.input_tokens',output_tokens:'g.output_tokens',request_id:'g.request_id',created_at:'g.created_at',finished_at:'g.created_at',operation_id:'NULL',source:"'upstream_history'",channel:'g.channel',invocation_status:"'recorded'",pricing_snapshot:'NULL',usage_known:'1',cache_read_tokens:'g.cache_read_tokens',cache_write_tokens:'g.cache_write_tokens',upstream_request_id:'g.upstream_request_id',duration_ms:'g.duration_ms',first_token_ms:'g.first_token_ms',gateway_cost_usd:'g.gateway_cost_usd',
    }
    const columns=(await this.store.all('PRAGMA table_info(text_charges)')).map(row=>row.name)
    const stored=`SELECT ${columns.map(key=>'c.'+key).join(',')},(SELECT g.gateway_cost_usd FROM text_upstream_usage g WHERE g.session_id=c.request_id OR g.request_id='client:'||c.request_id OR (c.upstream_request_id IS NOT NULL AND (g.request_id=c.upstream_request_id OR g.upstream_request_id=c.upstream_request_id)) LIMIT 1) AS gateway_cost_usd FROM text_charges c`
    const imported=`SELECT ${columns.map(key=>history[key]||'NULL').join(',')},g.gateway_cost_usd FROM text_upstream_usage g WHERE NOT EXISTS(SELECT 1 FROM text_charges c WHERE g.session_id=c.request_id OR g.request_id='client:'||c.request_id OR (c.upstream_request_id IS NOT NULL AND (g.request_id=c.upstream_request_id OR g.upstream_request_id=c.upstream_request_id)))`
    const join = `FROM (${stored} UNION ALL ${imported}) t LEFT JOIN users u ON u.id=t.user_id WHERE ${clauses.join(' AND ')}`
    const summary = (await this.store.get(`SELECT COUNT(*) AS calls,SUM(t.input_tokens) AS inputTokens,SUM(t.output_tokens) AS outputTokens,SUM(t.cache_read_tokens) AS cacheReadTokens,SUM(t.charged_points) AS chargedPoints,SUM(CASE WHEN t.status IN ('reserved','billing_review') THEN t.reserved_points ELSE 0 END) AS heldPoints,SUM(t.list_points) AS listPoints,SUM(t.discount_points) AS discountPoints,SUM(CASE WHEN t.status='settled' AND t.charged_points=0 THEN 1 ELSE 0 END) AS freeCalls,SUM(CASE WHEN t.status='billing_review' THEN 1 ELSE 0 END) AS reviewCalls,AVG(t.duration_ms) AS averageDurationMs ${join}`, ...args))
    const trend = (await this.store.all(`SELECT substr(t.created_at,1,10) AS day,COUNT(*) AS calls,SUM(t.input_tokens+t.output_tokens) AS tokens,SUM(t.charged_points) AS points ${join} GROUP BY day ORDER BY day DESC LIMIT 30`,...args)).reverse()
    const items = (await this.store.all(`SELECT t.*,u.name AS user_name,u.email AS user_email ${join} ORDER BY t.created_at DESC,t.id DESC LIMIT ? OFFSET ?`,...args,limit,(page-1)*limit)).map(row=>({ ...row,pricing_snapshot:parse(row.pricing_snapshot,null),usage_known:row.usage_known===null?null:Boolean(row.usage_known) }))
    const models=(await this.store.all('SELECT DISTINCT model FROM text_charges UNION SELECT DISTINCT model FROM text_upstream_usage ORDER BY model')).map(row=>row.model)
    return { items,summary,trend,models,total:Number(summary.calls),page,limit }
  }

  static async open<T extends new (...args: any[]) => any>(this: T, ...args: any[]): Promise<InstanceType<T>> {
    const value = new this()
    try { await value.initialize(...args); return value }
    catch (error) { await value.db?.close?.().catch(() => {}); throw error }
  }
}
