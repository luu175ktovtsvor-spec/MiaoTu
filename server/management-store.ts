import { forEachAsync, mapAsync } from './async-collections.ts'
import { CloudDatabase } from './cloud-database.ts'
import { redisRuntime } from './redis-runtime.ts'
import { TextBilling, normalizeTextBilling } from './text-billing.ts'
import { finiteCost, costEvidence } from './cost-evidence.ts'
import { mergeOperatingSettings } from './operating-settings.ts'
import { setVideoPricing, normalizeVideoPricing, isCostPlusVideo, VIDEO_PRICING_VERSION } from './video-pricing.ts'
import { userFacingError, explainUserError } from './user-errors.ts'
import { historyPrompt } from './user-prompts.ts'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { estimateGenerationCost, estimateUpstreamCostRmb, publicCostPolicy, setPricingOverrides } from './generation-cost.ts'
import { ArtifactFiles } from './artifact-files.ts'
import { BlobStore, mediaLayout } from './blob-store.ts'
import { activeModelForSettings, modelPriceSizes, modelById, modelForGeneration, defaultModel, modelCatalog, normalizeModelChannelSettings } from './image-models.ts'
import { ownTextModelById, ownTextModelIds } from './text-model-registry.ts'
import { supportedImageMime } from './result-cache.ts'
import { MEDIA_INPUT_VERSION } from './media-input.ts'
import { GENERATION_LIMITS, GENERATION_STATES, assertTransition, newGenerationId, newRequestId, normalizeModelList, ownerForSession, publicModelId, validIdempotencyKey, validRequestId } from './generation-contract.ts'
import { PAYMENT_PROVIDER, PAYMENT_STATES, PAYMENT_TYPE, formatMoney, isPaymentTerminal, newPaymentOrderNo } from './payment-contract.ts'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, cleanProjectName, ensureProjectDimension, layoutAdvice, newProjectId, projectLayoutReport, tableColumns } from './projects.ts'
import { mediaRoot } from './media-files.ts'
import { redactReferencePayload } from './reference-assets.ts'
import { normalizeTextPrices, publicTextCostPolicy, textSettlementAmounts } from './text-pricing.ts'
import { assertTextModelPolicy } from './text-model-policy.ts'
import { MODEL_SESSION_CURRENT, requireModelUser } from './model-access.ts'
import { publicVideoResult } from './public-video.ts'
import { textChargeView } from './text-charge-view.ts'
import { assertReservedDispatch, canRefundMediaCancellation } from './generation-dispatch.ts'
import { acceptedVideoSubmissionRecovery } from './video-submission.ts'

const RETAINED_COST_ROWS = "(SELECT g.*, COALESCE(CASE WHEN json_valid(g.upstream_cost) AND json_type(g.upstream_cost,'$.rmb') IN ('integer','real') THEN json_extract(g.upstream_cost,'$.rmb') END, (SELECT c.cost_rmb FROM upstream_calls c WHERE c.generation_id=g.id AND g.status='succeeded' AND c.status IN ('ok','succeeded') AND c.cost_rmb IS NOT NULL ORDER BY c.created_at DESC,c.id DESC LIMIT 1)) retained_cost FROM generations g)"

// Keep audit JSON parseable even when large binary provider payloads are omitted.
function auditJson(value, limit) {
  const clean = redactReferencePayload(value)
  const serialized = JSON.stringify(clean)
  if (serialized.length <= limit) return serialized
  const bounded = item => typeof item === 'string' ? (item.length > 1000 ? item.slice(0, 1000) + '…[字段过长，已省略]' : item) : Array.isArray(item) ? item.slice(0, 30).map(bounded) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, val]) => [key, bounded(val)])) : item
  const details = JSON.stringify(bounded(clean))
  return details.length <= limit ? details : JSON.stringify({ omitted: true, reason: '留档超出大小限制', originalCharacters: serialized.length })
}

export const digest = value => createHash('sha256').update(String(value)).digest('hex')
export function secretMatches(a, b) { return Boolean(a && b) && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b))) }
function hashMatches(secret, encodedHash) { return Boolean(secret && /^[a-f0-9]{64}$/.test(encodedHash || '')) && timingSafeEqual(Buffer.from(digest(secret)), Buffer.from(encodedHash)) }
function guestScope(accessToken) { return `guest:${digest(accessToken)}` }
function isGuestScope(scope) { return scope === 'guest' || String(scope || '').startsWith('guest:') }
export function normalizeEmail(value) { return String(value || '').trim().toLowerCase() }
export function validEmail(value) { const email = normalizeEmail(value); return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email) }
export function validPassword(value) { return typeof value === 'string' && value.length >= 8 && value.length <= 128 }
function passwordHash(password) { const salt=randomBytes(16); const derived=scryptSync(password,salt,64,{N:16384,r:8,p:1}); return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}` }
function passwordMatches(password, encoded) { const match=/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([^$]+)\$([^$]+)$/.exec(String(encoded||'')); if(!match)return false; try { const [,n,r,p,salt,expectedText]=match; const expected=Buffer.from(expectedText,'base64url'); const actual=scryptSync(password,Buffer.from(salt,'base64url'),expected.length,{N:Number(n),r:Number(r),p:Number(p)}); return actual.length===expected.length && timingSafeEqual(actual,expected) } catch { return false } }
function googleNameSeed(name, email) {
  const candidate = String(name || '').trim() || normalizeEmail(email).split('@')[0] || 'Google 用户'
  return candidate.slice(0, 60)
}
async function uniqueGoogleName(store, name, email, subject) {
  const base = googleNameSeed(name, email)
  if (!(await store.get('SELECT id FROM users WHERE name=?', base))) return base
  const suffix = `-${String(subject).replace(/[^A-Za-z0-9]/g, '').slice(-8) || randomBytes(4).toString('hex')}`
  const truncated = base.slice(0, Math.max(1, 60 - suffix.length))
  let candidate = `${truncated}${suffix}`
  let index = 2
  while ((await store.get('SELECT id FROM users WHERE name=?', candidate))) {
    const extra = `-${index++}`
    candidate = `${base.slice(0, Math.max(1, 60 - suffix.length - extra.length))}${suffix}${extra}`
  }
  return candidate
}
function qqNameSeed(name) {
  return String(name || '').trim().slice(0, 60) || 'QQ 用户'
}
async function uniqueQQName(store, name, subject) {
  const base = qqNameSeed(name)
  if (!(await store.get('SELECT id FROM users WHERE name=?', base))) return base
  const suffix = `-${digest(subject).slice(0, 8)}`
  let candidate = `${base.slice(0, Math.max(1, 60 - suffix.length))}${suffix}`
  let index = 2
  while ((await store.get('SELECT id FROM users WHERE name=?', candidate))) {
    const extra = `-${index++}`
    candidate = `${base.slice(0, Math.max(1, 60 - suffix.length - extra.length))}${suffix}${extra}`
  }
  return candidate
}
function externalNameSeed(name, label) {
  return String(name || '').trim().slice(0, 60) || `${String(label || 'OAuth').trim().slice(0, 52)} 用户`
}
async function uniqueExternalName(store, name, subject, label) {
  const base = externalNameSeed(name, label)
  if (!(await store.get('SELECT id FROM users WHERE name=?', base))) return base
  const suffix = `-${digest(subject).slice(0, 8)}`
  let candidate = `${base.slice(0, Math.max(1, 60 - suffix.length))}${suffix}`
  let index = 2
  while ((await store.get('SELECT id FROM users WHERE name=?', candidate))) {
    const extra = `-${index++}`
    candidate = `${base.slice(0, Math.max(1, 60 - suffix.length - extra.length))}${suffix}${extra}`
  }
  return candidate
}
function normalizeModelSettings(value: Record<string, any> = {}) {
  const result = {}
  for (const [id, setting] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
    const publicId = publicModelId(id)
    if (publicId) result[publicId] = setting
  }
  return result
}
function normalizeModelSettingsStrict(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(message)
  const result = {}
  for (const [id, setting] of Object.entries(value)) {
    const publicId = publicModelId(id)
    if (!publicId || (Object.prototype.hasOwnProperty.call(result, publicId) && JSON.stringify(result[publicId]) !== JSON.stringify(setting))) throw failure(message)
    result[publicId] = setting
  }
  return result
}
export function failure(message, status = 422) { return Object.assign(new Error(message), { status }) }
const integer = (value, min = 0, max = 1000000) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw failure('积分必须是有效整数'); return n }
// 积分保留两位小数（豆包图片是「官方原价 + 0.15」，一位小数会把加价变成 0.2）；
// 视频先按参数预扣，成功后按上游 usage 对账。
const credits = (value, min = 0, max = 1000000, precision = 100) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw failure('积分必须是有效数字')
  // 保留两位小数：豆包图片是「官方原价 + 0.15」，一位小数会把加价变成 0.2。
  return Math.round(n * precision) / precision
}
const parse = value => JSON.parse(value)

function countFilesUnder(root) {
  let bytes = 0
  let files = 0
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries = []
    try { entries = readdirSync(current, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try { bytes += statSync(full).size; files += 1 } catch { /* concurrently removed */ }
      }
    }
  }
  return { files, bytes }
}

function isoStartOfDay(offsetDays = 0) {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() - offsetDays)
  return date.toISOString()
}

async function readDatasetStatsUncached({ signal }: { signal?: AbortSignal } = {}) {
  const path = resolve(process.env.OIP_DB_PATH || join(process.cwd(), '.oip', 'runtime', 'prompts.db'))
  const previewRoot = process.env.OIP_PREVIEWS_ROOT ? resolve(process.env.OIP_PREVIEWS_ROOT) : null
  const previews = previewRoot && existsSync(previewRoot) ? countFilesUnder(previewRoot).files : null
  const empty = { path, present: existsSync(path), prompts: null, images: null, videos: null, previews, latestAt: null }
  const archiveOrigin = String(process.env.OIP_ARCHIVE_API_URL || '').trim().replace(/\/$/, '')
  if (archiveOrigin) {
    // A standalone admin service does not own the archive API's hydrated DB.
    // Use its existing read-only catalog, never hydrate another copy or substitute
    // the previous sync snapshot (which describes a different observation).
    let error = '档案服务统计读取失败'
    try {
      const url = new URL(`${archiveOrigin}/api/catalog`)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(error)
      const timeout = AbortSignal.timeout(8000)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await fetch(url, { headers: { accept: 'application/json' }, signal: requestSignal, cache: 'no-store', redirect: 'error' })
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw new Error(error) }
      error = '档案服务统计响应无效'
      const reader = response.body.getReader()
      const chunks = []; let size = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 8 * 1024 * 1024) throw new Error(error)
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
      requestSignal.throwIfAborted()
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const counts = data?.stats
      const valid = value => Number.isSafeInteger(value) && value >= 0
      if (!counts || !valid(counts.prompts) || !valid(counts.images) || (counts.videos != null && !valid(counts.videos))) throw new Error(error)
      return { ...empty, countSource: 'archive-api', observedAt: new Date().toISOString(), prompts: counts.prompts, images: counts.images, videos: counts.videos ?? null,
        datasetVersion: typeof data.dataset_version === 'string' ? data.dataset_version : null,
        datasetReady: typeof data.dataset_ready === 'boolean' ? data.dataset_ready : null,
        manifestMatch: typeof data.dataset_manifest_match === 'boolean' ? data.dataset_manifest_match : null }
    } catch {
      return { ...empty, countSource: 'archive-api', observedAt: null, error }
    }
  }
  const local = { ...empty, countSource: 'local-database', observedAt: null }
  if (!empty.present) return local
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const table = async name => Boolean((await (await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")).get(name)))
    const prompts = (await table('prompts')) ? (await (await db.prepare('SELECT COUNT(*) AS n FROM prompts')).get()).n : null
    const images = (await table('images')) ? (await (await db.prepare('SELECT COUNT(*) AS n FROM images')).get()).n : null
    const videos = (await table('videos')) ? (await (await db.prepare('SELECT COUNT(*) AS n FROM videos')).get()).n : null
    const latestValues = []
    for (const tableName of ['prompts', 'images']) {
      if (!(await table(tableName))) continue
      const columns = new Set((await (await db.prepare(`PRAGMA table_info(${tableName})`)).all()).map(column => column.name))
      const timestampColumn = ['updated_at', 'collected_at', 'created_at'].find(column => columns.has(column))
      if (timestampColumn) latestValues.push((await (await db.prepare(`SELECT MAX(${timestampColumn}) AS value FROM ${tableName}`)).get()).value)
    }
    const latestAt = latestValues.filter(Boolean).sort().at(-1) || null
    return { ...local, observedAt: new Date().toISOString(), prompts: prompts == null ? null : Number(prompts), images: images == null ? null : Number(images), videos: videos == null ? null : Number(videos), latestAt }
  } catch (error) {
    return { ...local, error: '数据集数据库读取失败' }
  } finally { try { await db?.close() } catch {} }
}

async function readDatasetStats(options: { signal?: AbortSignal } = {}) {
  const key = `dataset-stats:${process.env.OIP_ARCHIVE_API_URL || process.env.OIP_DB_PATH || 'local'}`
  return redisRuntime.cacheJson(key, 5, () => readDatasetStatsUncached(options))
}

function safeJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function opsStatusDirectory() {
  return resolve(process.env.OIP_OPS_STATUS_DIR || join(process.env.OIP_DATA_DIR || '.oip/runtime-data', 'ops-status'))
}

function readOpsStatus(name) {
  const path = join(opsStatusDirectory(), name)
  const value = safeJsonFile(path)
  return value && typeof value === 'object' ? { path, value } : { path, value: null }
}

function statusUpdatedAt(value) {
  const raw = value?.finishedAt || value?.updatedAt || value?.updated_at || value?.startedAt
  const timestamp = raw ? Date.parse(raw) : NaN
  return Number.isFinite(timestamp) ? timestamp : null
}

function statusExpired(value, maxAgeMs) {
  const timestamp = statusUpdatedAt(value)
  return timestamp == null || Date.now() - timestamp > maxAgeMs
}

// SQLite DDL can briefly contend at startup; retry without blocking the HTTP
// event loop. PostgreSQL schema changes use a transaction advisory lock.
async function execRetry(db, sql, attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await db.exec(sql); return } catch (error) {
      const message = String(error?.message || '')
      if (!/locked|busy/i.test(message) || attempt === attempts - 1) throw error
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)))
    }
  }
}

export class ManagementStore {
  declare db: any
  declare projectScoped: any
  declare stateScoped: any
  declare _artifactFiles: any
  declare _blobStore: any
  declare textBilling: TextBilling

  async initialize(path = process.env.OIP_MANAGEMENT_DB || join(process.env.OIP_DATA_DIR || 'data', 'management.sqlite')) {
    if (process.env.NODE_ENV === 'production' && process.env.MIAO_DATABASE_URL && !redisRuntime.configured) throw new Error('Cloud production requires an independent MIAO_REDIS_URL')
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = await CloudDatabase.open(path, process.env.MIAO_DATABASE_URL || '', process.env.NODE_ENV === 'production')
    const initializeSchema = async () => {
    await execRetry(this.db, `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,email TEXT UNIQUE,password_hash TEXT,secret_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',points REAL NOT NULL CHECK(points>=0),models TEXT NOT NULL DEFAULT '[]',email_verified INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,role TEXT NOT NULL,user_id TEXT,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_identities(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL,subject TEXT NOT NULL,email TEXT,created_at TEXT NOT NULL,UNIQUE(provider,subject),UNIQUE(user_id,provider));
      CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY,provider TEXT NOT NULL,nonce_hash TEXT NOT NULL,redirect_uri TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT);
       CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generations(id TEXT PRIMARY KEY,user_id TEXT,actor TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,points REAL NOT NULL,reserved_points REAL NOT NULL DEFAULT 0,charged_points REAL NOT NULL DEFAULT 0,prompt TEXT NOT NULL,parameters TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT,request_id TEXT,idempotency_key TEXT,owner_scope TEXT NOT NULL DEFAULT 'guest',viewer_token_hash TEXT,provider TEXT,upstream_model TEXT,upstream_request_id TEXT,usage TEXT,started_at TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,lease_id TEXT,lease_at TEXT,upstream_status INTEGER,expires_at TEXT);
       CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES generations(id),mime TEXT NOT NULL,bytes BLOB,storage TEXT NOT NULL DEFAULT 'disk',size INTEGER NOT NULL DEFAULT 0);
       CREATE TABLE IF NOT EXISTS artifact_expiry(artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS video_results(generation_id TEXT PRIMARY KEY REFERENCES generations(id) ON DELETE CASCADE,video_id TEXT NOT NULL,video_url TEXT NOT NULL,mime TEXT NOT NULL DEFAULT 'video/mp4',duration REAL,width INTEGER,height INTEGER,thumbnail_url TEXT,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS generation_inputs(generation_id TEXT NOT NULL REFERENCES generations(id) ON DELETE CASCADE,position INTEGER NOT NULL,kind TEXT NOT NULL,role TEXT,mime TEXT NOT NULL,extension TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(generation_id,position,kind));
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,delta REAL NOT NULL,reason TEXT NOT NULL,request_id TEXT,created_at TEXT NOT NULL,payment_order_id TEXT REFERENCES payment_orders(id));
      CREATE TABLE IF NOT EXISTS text_charges(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,reserved_points REAL NOT NULL DEFAULT 0,charged_points REAL NOT NULL DEFAULT 0,input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,request_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,finished_at TEXT,error TEXT);
      CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_orders(id TEXT PRIMARY KEY,out_trade_no TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES users(id),package_id TEXT NOT NULL,package_name TEXT NOT NULL,points INTEGER NOT NULL CHECK(points>0),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),currency TEXT NOT NULL DEFAULT 'CNY',status TEXT NOT NULL,payment_type TEXT NOT NULL DEFAULT 'alipay',provider TEXT NOT NULL DEFAULT 'zpay',payurl TEXT,payurl2 TEXT,qrcode TEXT,img TEXT,upstream_trade_no TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,completed_at TEXT,updated_at TEXT NOT NULL,failure_reason TEXT,idempotency_key TEXT,owner_scope TEXT,merchant_pid TEXT,gateway_order_id TEXT);
      CREATE TABLE IF NOT EXISTS payment_qr_cache(out_trade_no TEXT PRIMARY KEY REFERENCES payment_orders(out_trade_no) ON DELETE CASCADE,mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts(scope TEXT PRIMARY KEY,count INTEGER NOT NULL,first_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_otps(id TEXT PRIMARY KEY,email_hash TEXT NOT NULL,code_hash TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS upstream_calls(
        id TEXT PRIMARY KEY,
        generation_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        kind TEXT NOT NULL,
        tier TEXT,
        seconds REAL,
        has_input_video INTEGER NOT NULL DEFAULT 0,
        request TEXT NOT NULL,
        response TEXT,
        usage TEXT,
        cost_rmb REAL,
        cost_basis TEXT,
        credits_before REAL,
        credits_after REAL,
        credits_delta REAL,
        estimated_credits REAL,
        upstream_request_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS upstream_balance_snapshots(
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        balance REAL NOT NULL,
        consumed REAL,
        total REAL,
        observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS upstream_reconciliations(
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        from_at TEXT,
        to_at TEXT NOT NULL,
        previous_balance REAL,
        current_balance REAL NOT NULL,
        delta REAL,
        successful_estimated_credits REAL,
        unexplained_credits REAL,
        calls INTEGER NOT NULL DEFAULT 0,
        successful_calls INTEGER NOT NULL DEFAULT 0,
        failed_calls INTEGER NOT NULL DEFAULT 0,
        conclusion TEXT NOT NULL,
        alarm INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS upstream_calls_time ON upstream_calls(created_at DESC);
      CREATE INDEX IF NOT EXISTS upstream_calls_model ON upstream_calls(provider,model,tier);
      CREATE INDEX IF NOT EXISTS upstream_calls_generation ON upstream_calls(generation_id);
      CREATE INDEX IF NOT EXISTS upstream_balance_time ON upstream_balance_snapshots(provider,observed_at DESC);
      CREATE INDEX IF NOT EXISTS upstream_reconciliation_time ON upstream_reconciliations(provider,to_at DESC);
      -- Supplier library items the server created for a user's reference
      -- image, keyed by content so each image is uploaded once and reused.
      CREATE TABLE IF NOT EXISTS suihe_library_assets(
        user_id TEXT NOT NULL,
        library TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,library,sha256));
      CREATE INDEX IF NOT EXISTS gen_time ON generations(created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_time ON audit(created_at DESC);`)
    for (const statement of [
      'ALTER TABLE payment_orders ADD COLUMN idempotency_key TEXT',
      'ALTER TABLE payment_orders ADD COLUMN owner_scope TEXT',
      'ALTER TABLE payment_orders ADD COLUMN merchant_pid TEXT',
      'ALTER TABLE payment_orders ADD COLUMN gateway_order_id TEXT',
      'ALTER TABLE payment_orders ADD COLUMN payurl2 TEXT',
      'ALTER TABLE ledger ADD COLUMN payment_order_id TEXT REFERENCES payment_orders(id)',
      'ALTER TABLE users ADD COLUMN email TEXT',
      'ALTER TABLE users ADD COLUMN password_hash TEXT',
      'ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN mcp_token_hash TEXT',
      'ALTER TABLE users ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 1',
      'ALTER TABLE generations ADD COLUMN request_id TEXT',
      'ALTER TABLE generations ADD COLUMN idempotency_key TEXT',
      "ALTER TABLE generations ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'guest'",
      'ALTER TABLE generations ADD COLUMN viewer_token_hash TEXT',
      'ALTER TABLE generations ADD COLUMN reserved_points INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE generations ADD COLUMN charged_points INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE generations ADD COLUMN provider TEXT',
      'ALTER TABLE generations ADD COLUMN upstream_model TEXT',
      'ALTER TABLE generations ADD COLUMN upstream_request_id TEXT',
      'ALTER TABLE generations ADD COLUMN usage TEXT',
      'ALTER TABLE generations ADD COLUMN started_at TEXT',
      'ALTER TABLE generations ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE generations ADD COLUMN lease_id TEXT',
      'ALTER TABLE generations ADD COLUMN lease_at TEXT',
      'ALTER TABLE generations ADD COLUMN upstream_status INTEGER',
      'ALTER TABLE generations ADD COLUMN expires_at TEXT',
      'ALTER TABLE generations ADD COLUMN upstream_cost TEXT',
      'ALTER TABLE upstream_calls ADD COLUMN estimated_credits REAL',
      'ALTER TABLE upstream_calls ADD COLUMN upstream_request_id TEXT',
      'ALTER TABLE upstream_calls ADD COLUMN cost_detail TEXT',
      'ALTER TABLE upstream_calls ADD COLUMN updated_at TEXT',
      'ALTER TABLE upstream_reconciliations ADD COLUMN details TEXT',
    ]) { try { await this.db.exec(statement) } catch {} }
    // 多项目维度的结构：能自己修的（workspace_state 的形状）在这里修完，修不了的（字节布局、
    // 半迁移结构）留给 scripts/migrate-projects.ts 显式执行。老库一列都不动，按单项目语义照常跑。
    // 发布代码和跑迁移是两件事，中间可能有时间差，这段时间服务必须照常工作。
    const dimension: any = (await ensureProjectDimension(this))
    this.projectScoped = dimension.filesScoped
    this.stateScoped = dimension.stateScoped
    if (dimension.stateUpgraded) console.log(`[workspace] workspace_state 表已升级到项目维度：${dimension.stateRows ?? 0} 行原样保留、全部归入默认项目（只改结构，字节一个没动）`)
    else if (dimension.stateCreated) console.log('[workspace] workspace_state 表缺失，已按项目维度建好（只改结构，字节一个没动）')
    // 提醒文案和 scripts/migrate-projects.ts --report 的「判断」是同一个函数，两边不会打架。
    try {
      const advice = layoutAdvice((await projectLayoutReport(this)))
      if (advice) console.warn(`[workspace] ${advice}`)
    } catch (error) {
      console.warn(`[workspace] 检查工作区布局失败：${error?.message || error}`)
    }
    await execRetry(this.db, 'CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS auth_identity_user ON auth_identities(user_id,provider)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS oauth_state_expiry ON oauth_states(expires_at)')
    if (process.env.MIAO_CANDIDATE_MODE !== 'true') await this.normalizeStoredModelPermissions()
    if (process.env.MIAO_CANDIDATE_MODE !== 'true') await this.migrateGenerationIdentity()
    if (process.env.MIAO_CANDIDATE_MODE !== 'true') await this.migrateGenerationAccounting()
    await execRetry(this.db, 'CREATE UNIQUE INDEX IF NOT EXISTS generation_request_unique ON generations(request_id) WHERE request_id IS NOT NULL')
    await execRetry(this.db, 'CREATE UNIQUE INDEX IF NOT EXISTS generation_idempotency_unique ON generations(owner_scope,idempotency_key) WHERE idempotency_key IS NOT NULL')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS generation_queue ON generations(status,created_at)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS generation_user_time ON generations(user_id,created_at DESC,id DESC)')
    await execRetry(this.db, "CREATE INDEX IF NOT EXISTS generation_user_active ON generations(user_id,status) WHERE status IN ('queued','running')")
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS artifact_request ON artifacts(request_id)')
    await execRetry(this.db, "CREATE INDEX IF NOT EXISTS generation_node_scope ON generations(user_id,json_extract(parameters,'$.outputDirectory'),COALESCE(json_extract(parameters,'$.workspaceProject'),'default'),created_at DESC,id DESC)")

    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS payment_order_user_time ON payment_orders(user_id,created_at DESC)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS payment_order_status_time ON payment_orders(status,created_at DESC)')
    await execRetry(this.db, 'CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency_unique ON payment_orders(owner_scope,idempotency_key) WHERE idempotency_key IS NOT NULL')
    await execRetry(this.db, 'CREATE UNIQUE INDEX IF NOT EXISTS ledger_payment_unique ON ledger(payment_order_id) WHERE payment_order_id IS NOT NULL')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS ledger_user_created ON ledger(user_id,created_at)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS ledger_user_request ON ledger(user_id,request_id)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS text_charges_user_time ON text_charges(user_id,created_at DESC)')
    await execRetry(this.db, "CREATE UNIQUE INDEX IF NOT EXISTS payment_paid_trade_unique ON payment_orders(provider,merchant_pid,upstream_trade_no) WHERE status='paid' AND upstream_trade_no IS NOT NULL")
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS payment_qr_cache_expiry ON payment_qr_cache(expires_at)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS artifact_expiry_time ON artifact_expiry(expires_at)')
    await execRetry(this.db, 'CREATE INDEX IF NOT EXISTS email_otp_lookup ON email_otps(email_hash,created_at DESC)')
    // 生成结果的字节也落磁盘。这里只保证表结构（老库要改成 bytes 可空 + storage/size），
    // 真正搬字节的迁移由 image API 启动时显式调用 migrateToDisk()，不让每个进程都跑一遍。
    this.textBilling = (await TextBilling.open(this, async sql => (await execRetry(this.db, sql))))
    await this.artifactFiles()
    }
    if (this.db.dialect === 'postgres') await this.db.transaction(async () => {
      await this.db.lock('miaoimg:schema:management-v1')
      await initializeSchema()
    })
    else await initializeSchema()
    if (process.env.MIAO_CANDIDATE_MODE !== 'true') await this.migrateVideoPricingRules()
    if (process.env.MIAO_CANDIDATE_MODE !== 'true') await this.recoverStale()
    // 启动时先读一次后台调价，避免开局几笔请求按内置价预扣。
    try { setPricingOverrides((await this.settings()).prices) } catch { /* 首次建库时忽略 */ }
  }
  // Apply the new default formula without overwriting administrator prices.
  // One transaction and a separate marker preserve later administrator edits.
  // Old task snapshots and historical ledger rows are never rewritten.
  async migrateVideoPricingRules() {
    await this.transaction(async () => {
      await this.db.lock('settings:operating')
      const marker='video-pricing-rules-20261026-simple'
      if((await this.get('SELECT value FROM settings WHERE key=?',marker))) return
      const row=(await this.get("SELECT value FROM settings WHERE key='operating'"))
      const previous=row ? parse(row.value) : {}
      const next=structuredClone(previous)
      next.prices ||= {}
      // Keep procurement/expense records readable; only the new default formula changes.
      // Existing manual prices remain authoritative, as do accepted task snapshots.
      next.videoPricing={...normalizeVideoPricing(previous.videoPricing),markupPerSecond:0.1,
        serverAllocationMode:'none'}
      await this.run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)','video-pricing-before-20261026-simple',JSON.stringify(previous))
      await this.run("INSERT INTO settings(key,value) VALUES('operating',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(next))
      await this.run('INSERT INTO settings(key,value) VALUES(?,?)',marker,JSON.stringify({version:VIDEO_PRICING_VERSION,preservedManualPrices:true}))
      await this.audit('system','pricing.rules.migrate','video',{version:VIDEO_PRICING_VERSION,preservedManualPrices:true})
    })
  }
  // 懒建、全局一份：过期清理和结果回读都要用它删/读磁盘文件，
  // admin 进程（overview → recoverStale）也会走到，所以不能只在 image API 里建。
  async artifactFiles() {
    if (!this._artifactFiles) this._artifactFiles = (await ArtifactFiles.open(this))
    return this._artifactFiles
  }
  // 内容寻址的字节存储，同样是懒建、全局一份：工作区、生成结果、对账三处共用一个实例，
  // 「谁在引用这份字节」的判定只有一份实现（blob-store 的 liveCount）。
  blobStore() {
    if (!this._blobStore) this._blobStore = new BlobStore(this)
    return this._blobStore
  }
  async all(sql, ...args): Promise<any[]> { return (await this.db.all(sql, ...args)) }
  async get(sql, ...args) { return (await this.db.get(sql, ...args)) }
  async run(sql, ...args) { return (await this.db.run(sql, ...args)) }
  async transaction(fn) { return (await this.db.transaction(fn)) }
  async close() { await this.db.close() }
  async workspaceForUser(userId, project = DEFAULT_PROJECT_ID) {
    // 老库的 workspace_state 还是 user_id 单键，整个库就是默认项目。
    const row = this.stateScoped
      ? (await this.get('SELECT workspace,assets,canvas_files,updated_at FROM workspace_state WHERE user_id=? AND project_id=?', userId, project))
      : (await this.get('SELECT workspace,assets,canvas_files,updated_at FROM workspace_state WHERE user_id=?', userId))
    if (!row) return { workspace: null, assets: [], canvasFiles: {}, updatedAt: null, workspaceRevision: digest('null') }
    let workspace = null
    let assets = []
    let canvasFiles = {}
    try { workspace = parse(row.workspace) } catch {}
    try { assets = parse(row.assets) } catch {}
    try { canvasFiles = parse(row.canvas_files) } catch {}
    return { workspace, workspaceRevision: digest(JSON.stringify(workspace)), assets: Array.isArray(assets) ? assets : [], canvasFiles: canvasFiles && typeof canvasFiles === 'object' && !Array.isArray(canvasFiles) ? canvasFiles : {}, updatedAt: row.updated_at }
  }
  async saveWorkspaceForUser(userId, { workspace, assets, canvasFiles, project = DEFAULT_PROJECT_ID }: Record<string, any> = {}) {
    const current = (await this.workspaceForUser(userId, project))
    const nextWorkspace = workspace === undefined ? current.workspace : workspace
    const nextAssets = assets === undefined ? current.assets : assets
    const nextCanvasFiles = canvasFiles === undefined ? current.canvasFiles : canvasFiles
    const updatedAt = new Date().toISOString()
    if (this.stateScoped) {
      await this.run(`INSERT INTO workspace_state(user_id,project_id,workspace,assets,canvas_files,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(user_id,project_id) DO UPDATE SET workspace=excluded.workspace,assets=excluded.assets,canvas_files=excluded.canvas_files,updated_at=excluded.updated_at`, userId, project, JSON.stringify(nextWorkspace ?? {}), JSON.stringify(Array.isArray(nextAssets) ? nextAssets : []), JSON.stringify(nextCanvasFiles && typeof nextCanvasFiles === 'object' && !Array.isArray(nextCanvasFiles) ? nextCanvasFiles : {}), updatedAt)
    } else {
      await this.run(`INSERT INTO workspace_state(user_id,workspace,assets,canvas_files,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET workspace=excluded.workspace,assets=excluded.assets,canvas_files=excluded.canvas_files,updated_at=excluded.updated_at`, userId, JSON.stringify(nextWorkspace ?? {}), JSON.stringify(Array.isArray(nextAssets) ? nextAssets : []), JSON.stringify(nextCanvasFiles && typeof nextCanvasFiles === 'object' && !Array.isArray(nextCanvasFiles) ? nextCanvasFiles : {}), updatedAt)
    }
    return { workspace: nextWorkspace, workspaceRevision: digest(JSON.stringify(nextWorkspace ?? {})), assets: nextAssets, canvasFiles: nextCanvasFiles, updatedAt }
  }
  // ---- 项目（一个账号下的多个工作区）----
  // 项目的字节和文件索引在 workspace-files.ts，这里只管 projects 这张表本身。
  // 老库没有这张表：这些方法只应该在 projectScoped 为 true 时被调用，HTTP 层会先判断。
  projectRow(row) { return row ? { id: row.id, name: row.name, createdAt: row.created_at, lastOpenedAt: row.last_opened_at } : null }
  async projectForUser(userId, id) {
    if (!this.projectScoped) return null
    return this.projectRow((await this.get('SELECT id,name,created_at,last_opened_at FROM projects WHERE user_id=? AND id=?', userId, String(id || ''))))
  }
  // 每个账号都有默认项目：老账号由迁移脚本建好，新账号第一次打开工作区时在这里补上。
  // 老库（还没迁移到多项目）没有 projects 表，返回 null，调用方按单项目语义处理。
  async ensureDefaultProject(userId) {
    if (!this.projectScoped) return null
    const existing = (await this.projectForUser(userId, DEFAULT_PROJECT_ID))
    if (existing) return existing
    await this.run('INSERT OR IGNORE INTO projects(id,user_id,name,created_at,last_opened_at) VALUES(?,?,?,?,NULL)', DEFAULT_PROJECT_ID, userId, DEFAULT_PROJECT_NAME, new Date().toISOString())
    return (await this.projectForUser(userId, DEFAULT_PROJECT_ID))
  }
  async projectsForUser(userId) {
    if (!this.projectScoped) return []
    await this.ensureDefaultProject(userId)
    return (await this.all('SELECT id,name,created_at,last_opened_at FROM projects WHERE user_id=? ORDER BY created_at, id', userId)).map(row => this.projectRow(row))
  }
  async createProject(userId, rawName) {
    if (!this.projectScoped) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
    const name = cleanProjectName(rawName)
    await this.ensureDefaultProject(userId)
    if ((await this.get('SELECT id FROM projects WHERE user_id=? AND name=?', userId, name))) throw failure('已有同名项目')
    const id = newProjectId()
    try {
      await this.run('INSERT INTO projects(id,user_id,name,created_at,last_opened_at) VALUES(?,?,?,?,NULL)', id, userId, name, new Date().toISOString())
    } catch (error) {
      // 并发下同名项目可能同时插入，UNIQUE(user_id,name) 会拦住后到的那一个。
      if (String(error?.message || '').includes('UNIQUE')) throw failure('已有同名项目')
      throw error
    }
    return (await this.projectForUser(userId, id))
  }
  async renameProject(userId, rawId, rawName) {
    if (!this.projectScoped) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
    const id = String(rawId || '').trim()
    const name = cleanProjectName(rawName)
    if (!(await this.projectForUser(userId, id))) throw failure('项目不存在', 404)
    if ((await this.get('SELECT id FROM projects WHERE user_id=? AND name=? AND id<>?', userId, name, id))) throw failure('已有同名项目')
    await this.run('UPDATE projects SET name=? WHERE user_id=? AND id=?', name, userId, id)
    return (await this.projectForUser(userId, id))
  }
  // 打开项目时刷新 last_opened_at，列表按它做「最近打开」。
  async touchProject(userId, rawId) {
    if (!this.projectScoped) return null
    const id = String(rawId || '').trim()
    if (!(await this.projectForUser(userId, id))) throw failure('项目不存在', 404)
    await this.run('UPDATE projects SET last_opened_at=? WHERE user_id=? AND id=?', new Date().toISOString(), userId, id)
    return (await this.projectForUser(userId, id))
  }
  async audit(actor, action, target, details: Record<string, any> = {}) { await this.run('INSERT INTO audit VALUES(?,?,?,?,?,?)', randomUUID(), actor, action, target, JSON.stringify(details), new Date().toISOString()) }
  async settings() {
    const defaults = { enabled: true, videoEnabled: true, requireLogin: true, registrationEnabled: true, defaultModel: modelById(defaultModel())?.publicId || defaultModel(), defaultTextModel: ownTextModelById('gpt-6.1-sol')?.id || 'gpt-6.1-sol', models: {}, modelChannels: {}, prices: {}, textPrices: {} }
    const row = (await this.get("SELECT value FROM settings WHERE key='operating'"))
    const stored = row ? parse(row.value) : {}
    const merged = { ...defaults, ...stored }
    const prices = normalizeModelSettings(merged.prices)
    const textPrices = normalizeTextPrices(merged.textPrices)
    // 管理端保存的调价立刻对当前进程的所有计价生效（两个进程各自读库刷新）。
    setPricingOverrides(prices)
    setVideoPricing(merged.videoPricing)
    return {
      ...merged,
      // 网页端只有服务端账号模式：登录是硬性条件，不能再切回访客模式。
      requireLogin: true,
      // Retain the response field for older admin clients. Historical numeric
      // settings no longer impose generation-count admission or queue limits.
      maxConcurrent: null,
      defaultModel: publicModelId(merged.defaultModel) || defaults.defaultModel,
      defaultTextModel: ownTextModelById(merged.defaultTextModel)?.id || defaults.defaultTextModel,
      models: normalizeModelSettings(merged.models),
      modelChannels: normalizeModelChannelSettings(merged.modelChannels),
      prices,
      textPrices,
      textBilling: normalizeTextBilling(merged.textBilling),
      videoPricing: normalizeVideoPricing(merged.videoPricing),
    }
  }
  // 参考素材签名密钥：首次使用时生成并写进设置表，持久化在数据卷里，重启不丢。
  async referenceSecret() {
    const existing = (await this.get("SELECT value FROM settings WHERE key='referenceSecret'"))
    if (existing?.value) return String(existing.value)
    const secret = randomBytes(32).toString('hex')
    await this.run("INSERT INTO settings(key,value) VALUES('referenceSecret',?) ON CONFLICT(key) DO NOTHING", secret)
    const row = (await this.get("SELECT value FROM settings WHERE key='referenceSecret'"))
    if (!row?.value) throw failure('参考素材签名密钥初始化失败', 500)
    return String(row.value)
  }
  async saveSettings(patch, actor) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('设置字段无效')
    return (await this.transaction(async () => {
      await this.db.lock('settings:operating')
      const current = (await this.settings())
      for (const key of Object.keys(patch)) if (!['enabled','videoEnabled','requireLogin','registrationEnabled','defaultModel','defaultTextModel','maxConcurrent','models','modelChannels','prices','videoPricing','textPrices','textBilling'].includes(key)) throw failure('设置字段无效')
      // Normalize aliases before merging so a legacy model id updates the
      // existing public id instead of becoming a conflicting second entry.
      const normalizedPatch = { ...patch }
      if (Object.prototype.hasOwnProperty.call(patch, 'models')) normalizedPatch.models = normalizeModelSettingsStrict(patch.models, '模型设置无效')
      if (Object.prototype.hasOwnProperty.call(patch, 'modelChannels')) normalizedPatch.modelChannels = normalizeModelChannelSettings(patch.modelChannels)
      if (Object.prototype.hasOwnProperty.call(patch, 'prices')) normalizedPatch.prices = normalizeModelSettingsStrict(patch.prices, '计费设置无效')
      let next
      try { next = mergeOperatingSettings(current, normalizedPatch) } catch (error) { throw failure(error.message) }
      next.requireLogin = true
      next.defaultModel = publicModelId(next.defaultModel)
      next.defaultTextModel = ownTextModelById(next.defaultTextModel)?.id
      if (typeof next.enabled !== 'boolean' || typeof next.videoEnabled !== 'boolean' || typeof next.requireLogin !== 'boolean' || typeof next.registrationEnabled !== 'boolean' || !next.defaultModel || !next.defaultTextModel) throw failure('设置无效')
      // Accept the legacy field from older admin pages, without restoring the
      // retired account limit or changing any other operating preference.
      next.maxConcurrent = null
      next.models = normalizeModelSettingsStrict(next.models, '模型设置无效')
      next.modelChannels = normalizeModelChannelSettings(next.modelChannels)
      for (const enabled of Object.values(next.models)) if (typeof enabled !== 'boolean') throw failure('模型设置无效')
      // Defaults are preferences, never an exemption from an administrator's switch.
      // When an entire type is paused, retain its preference for later reopening.
      if (next.models[next.defaultModel] === false) {
        const available = modelCatalog().find((model: any) => !model.video && next.models[model.publicId || model.id] !== false)
        next.defaultModel = available?.publicId || available?.id || next.defaultModel
      }
      if (next.models[next.defaultTextModel] === false) {
        next.defaultTextModel = ownTextModelIds().find(id => next.models[id] !== false) || next.defaultTextModel
      }
      // 后台调价：{ [模型ID]: { image?: 数值 | {尺寸: 数值, default?: 数值}, video?: {分辨率: 数值} } }
      // 档位必须属于该模型，数值保留两位小数；保存后立即生效（不用重新发版）。
      try { next.videoPricing = normalizeVideoPricing(next.videoPricing) } catch (error) { throw failure(error.message) }
      next.prices = normalizeModelSettingsStrict(next.prices, '计费设置无效')
      try { next.textPrices = normalizeTextPrices(next.textPrices, '文本模型计费设置无效') } catch (error) { throw failure(error.message) }
      next.textBilling = normalizeTextBilling(next.textBilling)
      if ('textBilling' in patch || 'textPrices' in patch) next.textBilling.version = randomUUID()
      for (const [id, price] of Object.entries(next.prices as Record<string, Record<string, any>>)) {
        const model = modelById(id)
        if (!model || !price || typeof price !== 'object') throw failure('计费设置无效')
        if (price.image !== undefined) {
          if (typeof price.image === 'number') price.image = credits(price.image, 0.01, 10000)
          else if (price.image && typeof price.image === 'object' && !Array.isArray(price.image)) {
            for (const [size, value] of Object.entries(price.image)) {
              if (size !== 'default' && !modelPriceSizes(id).includes(size)) throw failure(`图片尺寸 ${size} 不属于该模型`)
              price.image[size] = credits(value, 0.01, 10000)
            }
          } else throw failure('图片计费无效')
        }
        if (price.video !== undefined) {
          if (!price.video || typeof price.video !== 'object' || Array.isArray(price.video)) throw failure('视频计费无效')
          for (const [resolution, value] of Object.entries(price.video)) {
            if (!modelPriceSizes(id).some(value => value.toLowerCase() === resolution.toLowerCase())) throw failure(`分辨率 ${resolution} 不属于该模型`)
            price.video[resolution] = credits(value, 0.01, 10000)
          }
        }
      }
      await this.run("INSERT INTO settings VALUES('operating',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(next))
      // 保存后立刻在当前进程生效；其它进程下次读 settings() 时刷新。
      setPricingOverrides(next.prices)
      setVideoPricing(next.videoPricing)
      await this.audit(actor,'settings.update','operating',patch)
      return next
    }))
  }
  async costPolicy() {
    // 管理端与图片服务是独立进程；询价时读生效设置，不能等队列轮询刷新价格。
    const settings = (await this.settings())
    const catalog = modelCatalog().map(model => activeModelForSettings(model.publicId || model.id, settings)).filter(Boolean)
    return { ...publicCostPolicy(catalog), textModels: publicTextCostPolicy(settings.textPrices) }
  }
  async normalizeStoredModelPermissions() {
    for (const row of (await this.all('SELECT id,models FROM users'))) {
      let models = []
      try { models = normalizeModelList(parse(row.models)) } catch { models = [] }
      if (JSON.stringify(models) !== row.models) await this.run('UPDATE users SET models=? WHERE id=?', JSON.stringify(models), row.id)
    }
  }
  async migrateGenerationIdentity() {
    await this.transaction(async () => {
      const rows = (await this.all("SELECT id,user_id,actor FROM generations WHERE request_id IS NULL OR request_id='' ORDER BY created_at,id"))
      for (const row of rows) {
        const scope = row.user_id ? `user:${row.user_id}` : row.actor === '管理员' ? 'admin' : 'guest'
        const legacyKey = row.id.includes(':') ? row.id.slice(row.id.indexOf(':') + 1) : ''
        const publicId = validRequestId(legacyKey) && !(await this.get('SELECT id FROM generations WHERE request_id=?', legacyKey)) ? legacyKey : newRequestId()
        await this.run('UPDATE generations SET request_id=?,idempotency_key=?,owner_scope=? WHERE id=?', publicId, validIdempotencyKey(legacyKey) ? legacyKey : null, scope, row.id)
      }
    })
  }
  async migrateGenerationAccounting() {
    await this.run("UPDATE generations SET reserved_points=CASE WHEN reserved_points=0 THEN points ELSE reserved_points END,charged_points=CASE WHEN charged_points=0 AND status='succeeded' THEN points ELSE charged_points END WHERE reserved_points=0 OR (status='succeeded' AND charged_points=0)")
  }
  async users({ search = '', page = 1, limit = 20 }: Record<string, any> = {}) {
    page = integer(page, 1, 100000); limit = integer(limit, 1, 100)
    const term = String(search || '').trim().slice(0, 100)
    const clauses = ['1=1']; const args = []
    if (term) { clauses.push('(name LIKE ? OR email LIKE ?)'); args.push(`%${term}%`, `%${term}%`) }
    const where = clauses.join(' AND ')
    const total = (await this.get(`SELECT COUNT(*) n FROM users WHERE ${where}`, ...args)).n
    const filesTable = (await tableColumns(this, 'workspace_files'))
    const hasFiles = filesTable.length > 0
    const projectTable = Boolean((await this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'")))
    const items = (await mapAsync((await this.all(`SELECT u.id,u.name,u.email,u.status,u.points AS stored_points,u.models,u.email_verified,u.created_at,
      COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.user_id=u.id),0) AS ledger_points,
      (SELECT COUNT(*) FROM text_charges t WHERE t.user_id=u.id AND t.status='billing_review') AS text_review_requests,
      (SELECT COUNT(*) FROM text_charges t WHERE t.user_id=u.id AND t.status='reserved') AS text_reserved_requests
      FROM users u WHERE ${where.replaceAll('name','u.name').replaceAll('email','u.email')} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)), async (u) => {
      const fileWhere = hasFiles ? ` AND mime<>'inode/directory'` : ''
      const files = hasFiles ? (await this.get(`SELECT COUNT(*) AS n FROM workspace_files WHERE user_id=?${fileWhere}`, u.id))?.n || 0 : 0
      const canvases = hasFiles ? (await this.get(`SELECT COUNT(*) AS n FROM workspace_files WHERE user_id=? AND mime<>'inode/directory' AND lower(path) LIKE '%.json' AND path NOT LIKE 'agent/%' AND path NOT LIKE 'nodes/%'`, u.id))?.n || 0 : 0
      const projects = projectTable ? (await this.get('SELECT COUNT(*) AS n FROM projects WHERE user_id=?', u.id))?.n || 0 : (files ? 1 : 0)
      const mcpIssued = Boolean((await this.get('SELECT mcp_token_hash FROM users WHERE id=?', u.id))?.mcp_token_hash)
      const storedPoints = Math.round(Number(u.stored_points || 0) * 10000) / 10000
      const ledgerPoints = Math.round(Number(u.ledger_points || 0) * 10000) / 10000
      return { id: u.id, name: u.name, email: u.email, status: u.status, points: ledgerPoints, storedPoints, ledgerPoints, balanceDifference: Math.round((storedPoints - ledgerPoints) * 10000) / 10000, balanceMismatch: Math.abs(storedPoints - ledgerPoints) > 0.0001, emailVerified: Boolean(u.email_verified), models: normalizeModelList(parse(u.models)), created_at: u.created_at, canvasCount: Number(canvases), fileCount: Number(files), projectCount: Number(projects), mcpIssued, textReviewRequests: Number(u.text_review_requests), textReservedRequests: Number(u.text_reserved_requests) }
    }))
    return { items, total, page, limit }
  }
  async balanceAudit() {
    const rows = (await this.all(`SELECT u.id,u.name,u.points AS stored_points,COALESCE(SUM(l.delta),0) AS ledger_points
      FROM users u LEFT JOIN ledger l ON l.user_id=u.id GROUP BY u.id,u.name,u.points ORDER BY u.created_at,u.id`))
    const mismatches = rows.map(row => ({ id: row.id, name: row.name, storedPoints: Number(row.stored_points || 0), ledgerPoints: Number(row.ledger_points || 0), difference: Math.round((Number(row.stored_points || 0) - Number(row.ledger_points || 0)) * 10000) / 10000 })).filter(row => Math.abs(row.difference) > 0.0001)
    const storedTotal = rows.reduce((sum, row) => sum + Number(row.stored_points || 0), 0)
    const ledgerTotal = rows.reduce((sum, row) => sum + Number(row.ledger_points || 0), 0)
    return { checked: rows.length, matching: rows.length - mismatches.length, mismatches, storedTotal: Math.round(storedTotal * 100) / 100, ledgerTotal: Math.round(ledgerTotal * 100) / 100 }
  }
  async user(id) {
    const row = (await this.get("SELECT id,name,email,status,points,models,email_verified,created_at,CASE WHEN password_hash IS NOT NULL AND password_hash<>'' THEN 1 ELSE 0 END AS has_password FROM users WHERE id=?", id))
    if (!row) return null
    const { has_password, ...user } = row
    return { ...user, hasPassword: Boolean(has_password), emailVerified: Boolean(user.email_verified), models: normalizeModelList(parse(user.models)) }
  }
  async publicUser(id) {
    const user = (await this.user(id))
    if (!user) return null
    const { id: _internalId, ...safe } = user
    // The browser only needs a stable namespace for its local workspace. Keep
    // the database user primary key on the server and expose a non-reversible
    // value for IndexedDB partitioning instead.
    return { ...safe, workspaceKey: `user:${digest(`workspace:${_internalId}`).slice(0, 32)}` }
  }
  async createUser({ name, email = '', password = '', points = 0, models = [] }: Record<string, any>, actor) {
    email = normalizeEmail(email)
    name = String(name || '').trim()
    if (!name && validEmail(email)) name = email.split('@')[0].slice(0, 60)
    if (!name || name.length > 60) throw failure('请输入 1–60 字的用户名')
    if (email && !validEmail(email)) throw failure('请输入有效的邮箱地址')
    if (email && !validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    if (!Array.isArray(models) || models.some((id) => !publicModelId(id))) throw failure('模型权限无效')
    models = normalizeModelList(models)
    points = credits(points)
    return (await this.transaction(async () => {
      await this.db.lock('auth:account-registration')
      if ((await this.get('SELECT id FROM users WHERE name=?',name))) throw failure('用户名已存在',409)
      if (email && (await this.get('SELECT id FROM users WHERE lower(email)=?',email))) throw failure('这个邮箱已经注册，请直接登录',409)
      const id = randomUUID(), code = randomBytes(24).toString('base64url')
      await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,name,email || null,email ? passwordHash(password) : null,digest(code),'active',points,JSON.stringify(models),0,new Date().toISOString())
      if (points) await this.ledger(id,points,'初始额度')
      await this.audit(actor,'user.create',id,{ name, points, models })
      return email ? { user: (await this.user(id)) } : { user: (await this.user(id)), accessCode: code }
    }))
  }
  async registerUser({ email, password, name = '' }: Record<string, any>) {
    email=normalizeEmail(email); name=String(name||'').trim()
    if(!validEmail(email)) throw failure('请输入有效的邮箱地址')
    if(!validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    if(name.length>60) throw failure('昵称不能超过 60 个字')
    if (!(await this.settings()).registrationEnabled) throw failure('当前暂未开放注册', 403)
    return (await this.transaction(async () => {
      await this.db.lock('auth:account-registration')
      if((await this.get('SELECT id FROM users WHERE lower(email)=?',email))) throw failure('这个邮箱已经注册，请直接登录',409)
      const id=randomUUID(), display=name || email.split('@')[0].slice(0,60)
      if ((await this.get('SELECT id FROM users WHERE name=?', display))) throw failure('这个昵称已经被使用，请换一个',409)
      const registrationPoints = 0
      const registrationModels = []
      await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,display,email,passwordHash(password),digest(randomBytes(32).toString('hex')),'active',registrationPoints,JSON.stringify(registrationModels),0,new Date().toISOString())
      await this.ledger(id,registrationPoints,'注册初始额度')
      await this.audit(email,'user.register',id,{email,points:registrationPoints,models:registrationModels})
      return (await this.createSession('user',id))
    }))
  }
  async loginPassword(email,password) {
    email=normalizeEmail(email)
    return (await this.transaction(async () => {
      const row=await this.get('SELECT id,password_hash,status FROM users WHERE lower(email)=?'+(this.db.dialect==='postgres'?' FOR UPDATE':''),email)
      if(!row || row.status!=='active' || !passwordMatches(password,row.password_hash)) throw failure('邮箱或密码不正确',401)
      await this.audit(email,'user.login',row.id,{email})
      return (await this.createSession('user',row.id))
    }))
  }
  async issueEmailOtp({ email, codeHash, now = Date.now(), expiresAt, cooldownMs = 60000 }: Record<string, any>) {
    const emailHash = digest(normalizeEmail(email))
    await this.run('DELETE FROM email_otps WHERE expires_at<?',now)
    return (await this.transaction(async () => {
      await this.db.lock(`email-otp:${emailHash}`)
      const latest = (await this.get('SELECT created_at FROM email_otps WHERE email_hash=? ORDER BY created_at DESC LIMIT 1', emailHash))
      if (latest && now - Number(latest.created_at) < cooldownMs) throw failure('验证码发送过于频繁，请稍后再试', 429)
      await this.run('DELETE FROM email_otps WHERE email_hash=?', emailHash)
      await this.run('INSERT INTO email_otps(id,email_hash,code_hash,created_at,expires_at,attempts,consumed_at) VALUES(?,?,?,?,?,0,NULL)', randomUUID(), emailHash, codeHash, now, expiresAt)
      return { nextAllowedAt: now + cooldownMs }
    }))
  }
  async consumeEmailOtp({ email, codeHash, now = Date.now(), maxAttempts = 5 }: Record<string, any>) {
    const emailHash = digest(normalizeEmail(email))
    let result = false
    let rejected: Error | undefined
    await this.transaction(async () => {
      await this.db.lock(`email-otp:${emailHash}`)
      const row = (await this.get('SELECT id,code_hash,expires_at,attempts,consumed_at FROM email_otps WHERE email_hash=? ORDER BY created_at DESC LIMIT 1', emailHash))
      if (!row || row.consumed_at || Number(row.expires_at) <= now) throw failure('验证码错误或已过期', 401)
      if (Number(row.attempts) >= maxAttempts) throw failure('验证码尝试次数过多，请重新获取', 429)
      if (!secretMatches(codeHash, row.code_hash)) {
        await this.run('UPDATE email_otps SET attempts=attempts+1 WHERE id=?', row.id)
        rejected = failure('验证码错误或已过期',401)
        return
      }
      await this.run('UPDATE email_otps SET consumed_at=? WHERE id=? AND consumed_at IS NULL', now, row.id)
      result = true
    })
    if (rejected) throw rejected
    return result
  }
  async assertEmailPassword(email, password) {
    email = normalizeEmail(email)
    if (!validEmail(email)) throw failure('请输入有效的邮箱地址')
    if (!validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    const row = (await this.get('SELECT password_hash,status FROM users WHERE lower(email)=?', email))
    if (row && row.status !== 'active') throw failure('账号已停用', 403)
    if (row?.password_hash && !passwordMatches(password, row.password_hash)) throw failure('邮箱或密码不正确', 401)
    if (!row && !(await this.settings()).registrationEnabled) throw failure('当前暂未开放注册', 403)
  }
  // 验证码本身就证明了邮箱归属：只填验证码即可登录或注册。旧客户端会连同密码一起提交，
  // 这时仍按原规则校验密码，新账号把它设为登录密码。
  async loginEmailOtp(email, name = '', password = '') {
    email = normalizeEmail(email)
    if (!validEmail(email)) throw failure('请输入有效的邮箱地址')
    const withPassword = Boolean(password)
    if (withPassword && !validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    return (await this.transaction(async () => {
      await this.db.lock('auth:account-registration')
      const existing = (await this.get('SELECT id,password_hash,status FROM users WHERE lower(email)=?', email))
      if (existing && existing.status !== 'active') throw failure('账号已停用', 403)
      if (withPassword && existing?.password_hash && !passwordMatches(password, existing.password_hash)) throw failure('邮箱或密码不正确', 401)
      let user = existing ? (await this.user(existing.id)) : null
      if (!user) {
        if (!(await this.settings()).registrationEnabled) throw failure('当前暂未开放注册', 403)
        const id = randomUUID()
        const display = (await uniqueExternalName(this, String(name || '').trim() || email.split('@')[0], email, '邮箱'))
        // 只用验证码注册时先放一个谁也不知道的随机密码，用户之后可在「忘记密码」里设置。
        await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, display, email, passwordHash(withPassword ? password : randomBytes(32).toString('base64url')), digest(randomBytes(32).toString('base64url')), 'active', 0, '[]', 1, new Date().toISOString())
        await this.ledger(id, 0, '邮箱验证码注册初始额度')
        await this.audit(email, 'user.email_otp.create', id, { email })
        user = (await this.user(id))
      } else {
        if (!existing.password_hash && withPassword) await this.run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', passwordHash(password), user.id)
        else await this.run('UPDATE users SET email_verified=1 WHERE id=?', user.id)
        await this.audit(email, 'user.email_otp.login', user.id, { email })
      }
      return (await this.createSession('user', user.id))
    }))
  }
  // 忘记密码：验证码已在调用前核销，这里只换密码并登录。
  async resetPasswordWithEmailOtp(email, password) {
    email = normalizeEmail(email)
    if (!validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    return (await this.transaction(async () => {
      const row = (await this.get('SELECT id,status FROM users WHERE lower(email)=?', email))
      if (!row) throw failure('这个邮箱还没有注册，请用验证码登录', 404)
      if (row.status !== 'active') throw failure('账号已停用', 403)
      await this.run('UPDATE users SET password_hash=?, email_verified=1 WHERE id=?', passwordHash(password), row.id)
      // A password reset is also a credential-recovery event. Revoke every
      // older session before issuing the one returned to the user, otherwise a
      // previously copied desktop cookie would remain usable after the reset.
      const revoked = (await this.run('DELETE FROM sessions WHERE user_id=?', row.id)).changes
      await this.audit(email, 'user.password.reset', row.id, { email, revokeOtherSessions: true, revokedSessions: revoked })
      return (await this.createSession('user', row.id))
    }))
  }
  async saveOAuthState({ provider, state, nonce, redirectUri, expiresAt }: Record<string, any>) {
    if (!provider || !state || !nonce || !redirectUri || !expiresAt || Date.parse(expiresAt) <= Date.now()) throw failure('OAuth 状态无效', 500)
    return (await this.transaction(async () => {
      await this.run('DELETE FROM oauth_states WHERE expires_at<? OR used_at IS NOT NULL', new Date().toISOString())
      await this.run('INSERT INTO oauth_states(state_hash,provider,nonce_hash,redirect_uri,created_at,expires_at,used_at) VALUES(?,?,?,?,?,?,NULL)', digest(state), String(provider), digest(nonce), String(redirectUri), new Date().toISOString(), String(expiresAt))
      return true
    }))
  }
  async consumeOAuthState({ provider, state, stateCookie }: Record<string, any>) {
    return (await this.transaction(async () => {
      const stateHash = digest(state)
      const row = (await this.get('SELECT state_hash,nonce_hash,redirect_uri,expires_at,used_at FROM oauth_states WHERE state_hash=? AND provider=?', stateHash, String(provider)))
      if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now() || digest(stateCookie) !== row.state_hash) return null
      const changed = (await this.run('UPDATE oauth_states SET used_at=? WHERE state_hash=? AND used_at IS NULL', new Date().toISOString(), row.state_hash)).changes
      return changed === 1 ? { nonceHash: row.nonce_hash, redirectUri: row.redirect_uri } : null
    }))
  }
  async loginExternal({ provider, subject, name = '', email = '', emailVerified = false, label = provider, appId = '' }: Record<string, any>) {
    provider = String(provider || '').trim().toLowerCase()
    subject = String(subject || '').trim()
    email = normalizeEmail(email)
    appId = String(appId || '').trim()
    if (!provider || !/^[a-z0-9:_-]{2,64}$/.test(provider) || !subject || subject.length > 255) throw failure('第三方账号信息无效', 422)
    if (email && (!validEmail(email) || !emailVerified)) throw failure('第三方邮箱尚未验证', 422)
    return (await this.transaction(async () => {
      const identity = (await this.get('SELECT i.user_id,u.status FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?', provider, subject))
      const emailUser = identity || !email ? null : (await this.get('SELECT id FROM users WHERE lower(email)=?', email))
      let user = identity ? (await this.user(identity.user_id)) : emailUser ? (await this.user(emailUser.id)) : null
      if (user && user.status !== 'active') throw failure('账号已停用', 403)
      if (identity && !user) throw failure('第三方账号绑定已失效', 409)
      const actor = email || `${provider}:${appId || subject}`
      if (user) {
        const linked = (await this.get('SELECT subject FROM auth_identities WHERE user_id=? AND provider=?', user.id, provider))
        if (linked && linked.subject !== subject) throw failure('这个账号已绑定其他同类第三方账号', 409)
        if (!linked) {
          await this.run('INSERT INTO auth_identities(id,user_id,provider,subject,email,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), user.id, provider, subject, email || null, new Date().toISOString())
          if (emailVerified) await this.run('UPDATE users SET email_verified=1 WHERE id=?', user.id)
          await this.audit(actor, 'user.oauth.link', user.id, { provider, ...(appId ? { appId } : {}) })
        } else if (email) {
          await this.run('UPDATE auth_identities SET email=? WHERE user_id=? AND provider=?', email, user.id, provider)
        }
      } else {
        const id = randomUUID()
        const display = (await uniqueExternalName(this, name, subject, label))
        await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, display, email || null, null, digest(randomBytes(32).toString('base64url')), 'active', 0, '[]', emailVerified ? 1 : 0, new Date().toISOString())
        await this.run('INSERT INTO auth_identities(id,user_id,provider,subject,email,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), id, provider, subject, email || null, new Date().toISOString())
        await this.ledger(id, 0, `${label} 注册初始额度`)
        await this.audit(actor, 'user.oauth.create', id, { provider, ...(appId ? { appId } : {}) })
        user = (await this.user(id))
      }
      await this.audit(actor, `user.login.${provider}`, user.id, { provider, ...(appId ? { appId } : {}) })
      return (await this.createSession('user', user.id))
    }))
  }
  async loginGitHub(payload) { return (await this.loginExternal({ ...payload, provider: 'github', label: 'GitHub' })) }
  async loginWeChat(payload) { return (await this.loginExternal({ ...payload, provider: 'wechat', label: '微信' })) }
  async loginDingTalk(payload) { return (await this.loginExternal({ ...payload, provider: 'dingtalk', label: '钉钉' })) }
  async loginLinuxDo(payload) { return (await this.loginExternal({ ...payload, provider: 'linuxdo', label: 'Linux.do' })) }
  async loginOIDC(payload) { return (await this.loginExternal({ ...payload, provider: 'oidc', label: payload.label || 'OIDC' })) }
  async loginGoogle({ subject, email, name = '' }: Record<string, any>) {
    subject = String(subject || '').trim()
    email = normalizeEmail(email)
    if (!subject || subject.length > 255 || !validEmail(email)) throw failure('Google 账号信息无效', 422)
    return (await this.transaction(async () => {
      const identity = (await this.get('SELECT i.user_id,u.status FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?', 'google', subject))
      const emailUser = identity ? null : (await this.get('SELECT id FROM users WHERE lower(email)=?', email))
      let user = identity ? (await this.user(identity.user_id)) : emailUser ? (await this.user(emailUser.id)) : null
      if (user && user.status !== 'active') throw failure('账号已停用', 403)
      if (identity && !user) throw failure('Google 账号绑定已失效', 409)
      if (user) {
        const linked = (await this.get('SELECT subject FROM auth_identities WHERE user_id=? AND provider=?', user.id, 'google'))
        if (linked && linked.subject !== subject) throw failure('这个账号已绑定其他 Google 账号', 409)
        if (!linked) {
          await this.run('INSERT INTO auth_identities(id,user_id,provider,subject,email,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), user.id, 'google', subject, email, new Date().toISOString())
          await this.run('UPDATE users SET email_verified=1 WHERE id=?', user.id)
          await this.audit(email, 'user.oauth.link', user.id, { provider: 'google' })
        } else {
          await this.run('UPDATE auth_identities SET email=? WHERE user_id=? AND provider=?', email, user.id, 'google')
        }
      } else {
        const id = randomUUID()
        const display = (await uniqueGoogleName(this, name, email, subject))
        await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, display, email, null, digest(randomBytes(32).toString('base64url')), 'active', 0, '[]', 1, new Date().toISOString())
        await this.run('INSERT INTO auth_identities(id,user_id,provider,subject,email,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), id, 'google', subject, email, new Date().toISOString())
        await this.ledger(id, 0, 'Google 注册初始额度')
        await this.audit(email, 'user.oauth.create', id, { provider: 'google', email })
        user = (await this.user(id))
      }
      await this.audit(email, 'user.login.google', user.id, { provider: 'google', subject })
      return (await this.createSession('user', user.id))
    }))
  }
  async loginQQ({ subject, name = '', appId = '' }: Record<string, any>) {
    subject = String(subject || '').trim()
    appId = String(appId || '').trim()
    if (!subject || subject.length > 255 || !appId || appId.length > 128) throw failure('QQ 账号信息无效', 422)
    return (await this.transaction(async () => {
      const identity = (await this.get('SELECT i.user_id,u.status FROM auth_identities i JOIN users u ON u.id=i.user_id WHERE i.provider=? AND i.subject=?', 'qq', subject))
      let user = identity ? (await this.user(identity.user_id)) : null
      if (user && user.status !== 'active') throw failure('账号已停用', 403)
      if (identity && !user) throw failure('QQ 账号绑定已失效', 409)
      if (!user) {
        const id = randomUUID()
        const display = (await uniqueQQName(this, name, subject))
        await this.run('INSERT INTO users(id,name,email,password_hash,secret_hash,status,points,models,email_verified,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, display, null, null, digest(randomBytes(32).toString('base64url')), 'active', 0, '[]', 0, new Date().toISOString())
        await this.run('INSERT INTO auth_identities(id,user_id,provider,subject,email,created_at) VALUES(?,?,?,?,?,?)', randomUUID(), id, 'qq', subject, null, new Date().toISOString())
        await this.ledger(id, 0, 'QQ 注册初始额度')
        await this.audit(`qq:${appId}`, 'user.oauth.create', id, { provider: 'qq', appId })
        user = (await this.user(id))
      }
      await this.audit(`qq:${appId}`, 'user.login.qq', user.id, { provider: 'qq', appId })
      return (await this.createSession('user', user.id))
    }))
  }
  async passwordAttemptGate(scope) {
    const row = (await this.get('SELECT count,first_at FROM auth_attempts WHERE scope=?', scope))
    if (!row) return
    if (Date.now() - row.first_at >= 15 * 60 * 1000) { await this.run('DELETE FROM auth_attempts WHERE scope=?', scope); return }
    if (row.count >= 5) throw failure('修改密码尝试过多，请 15 分钟后重试', 429)
  }
  async notePasswordAttempt(scope) {
    const now = Date.now(); const row = (await this.get('SELECT count,first_at FROM auth_attempts WHERE scope=?', scope))
    if (!row || now - row.first_at >= 15 * 60 * 1000) await this.run('INSERT INTO auth_attempts(scope,count,first_at) VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET count=excluded.count,first_at=excluded.first_at', scope, 1, now)
    else await this.run('UPDATE auth_attempts SET count=count+1 WHERE scope=?', scope)
  }
  async clearPasswordAttempts(scope) { await this.run('DELETE FROM auth_attempts WHERE scope=?', scope) }
  async changePassword(id, currentPassword, nextPassword, actor) {
    if (!validPassword(nextPassword)) throw failure('密码长度需要为 8 到 128 位')
    const scope = `password:${id}`
    let invalid = false
    let next
    await this.transaction(async () => {
      await this.db.lockRow('users','id',id)
      await this.passwordAttemptGate(scope)
      const row = (await this.get('SELECT id,password_hash,status,email FROM users WHERE id=?', id))
      if (!row || row.status !== 'active' || !passwordMatches(currentPassword, row.password_hash)) {
        await this.notePasswordAttempt(scope)
        invalid = true
        return
      }
      await this.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(nextPassword), id)
      await this.run('DELETE FROM sessions WHERE user_id=?', id)
      const session = (await this.createSession('user', id))
      await this.audit(actor, 'user.password.change', id, { email: row.email, revokeOtherSessions: true })
      await this.clearPasswordAttempts(scope)
      next = session
    })
    if (invalid) throw failure('原密码不正确', 401)
    return next
  }
  async resetPassword(id, password, actor) {
    if (!validPassword(password)) throw failure('密码长度需要为 8 到 128 位')
    return (await this.transaction(async () => {
      await this.db.lockRow('users','id',id)
      const user = (await this.user(id)); if (!user) throw failure('用户不存在',404)
      await this.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(password), id)
      await this.run('DELETE FROM sessions WHERE user_id=?', id)
      await this.audit(actor,'user.password.reset',id,{email:user.email})
      return (await this.user(id))
    }))
  }
  async updateProfile(id, name) {
    if (typeof name !== 'string') throw failure('请输入 1–60 字的昵称')
    name = name.trim()
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) throw failure('请输入 1–60 字的昵称，不能包含换行或控制字符')
    return (await this.transaction(async () => {
      await this.db.lock('auth:account-registration')
      await this.db.lockRow('users','id',id)
      const user = (await this.user(id))
      if (!user || user.status !== 'active') throw failure('会话失效，请重新登录', 401)
      if (user.name === name) return (await this.publicUser(id))
      if ((await this.get('SELECT id FROM users WHERE name=? AND id<>?', name, id))) throw failure('这个昵称已经被使用，请换一个', 409)
      await this.run('UPDATE users SET name=? WHERE id=?', name, id)
      await this.audit(user.email || id, 'user.profile.update', id, { previousName: user.name, name })
      return (await this.publicUser(id))
    }))
  }
  async updateUser(id, patch, actor) {
    return (await this.transaction(async () => {
      await this.db.lockRow('users','id',id)
      const u = (await this.user(id)); if (!u) throw failure('用户不存在',404)
      const status = patch.status ?? u.status
      const requestedModels = patch.models ?? u.models
      if (!['active','disabled'].includes(status) || !Array.isArray(requestedModels) || requestedModels.some((modelId) => !publicModelId(modelId))) throw failure('用户设置无效')
      const models = normalizeModelList(requestedModels)
      await this.run('UPDATE users SET status=?,models=? WHERE id=?',status,JSON.stringify(models),id)
      if (status === 'disabled') await this.run('DELETE FROM sessions WHERE user_id=?',id)
      await this.audit(actor,'user.update',id,{status,models}); return (await this.user(id))
    }))
  }
  async adjustPoints(id, delta, reason, actor) {
    delta = credits(delta,-1000000,1000000); reason = String(reason || '').trim()
    if (!delta || !reason || reason.length > 200) throw failure('请填写非零积分和调整原因')
    return (await this.transaction(async () => {
      await this.db.lockRow('users','id',id)
      const u = (await this.user(id)); if (!u) throw failure('用户不存在',404)
      if (u.points + delta < 0) throw failure('调整后余额不能为负数')
      await this.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?',delta,id); await this.ledger(id,delta,reason)
      await this.audit(actor,'points.adjust',id,{delta,reason}); return (await this.user(id))
    }))
  }
  async rotateCode(id, actor) {
    return (await this.transaction(async () => {
      if (!(await this.user(id))) throw failure('用户不存在',404)
      const code = randomBytes(24).toString('base64url')
      await this.run('UPDATE users SET secret_hash=? WHERE id=?',digest(code),id); await this.run('DELETE FROM sessions WHERE user_id=?',id)
      await this.audit(actor,'user.code.rotate',id); return { accessCode: code }
    }))
  }
  async ledger(id, delta, reason, requestId = null, paymentOrderId = null) { await this.run('INSERT INTO ledger(id,user_id,delta,reason,request_id,created_at,payment_order_id) VALUES(?,?,?,?,?,?,?)',randomUUID(),id,delta,reason,requestId,new Date().toISOString(),paymentOrderId) }
  async reserveText(options: Record<string, any>) { return (await this.textBilling.reserve(options)) }
  async settleText(requestId, options: Record<string, any> = {}) { return (await this.textBilling.settle(requestId, options)) }
  async failText(requestId, error = '') { return (await this.textBilling.fail(requestId, error)) }
  async reviewTextCharge(requestId, error = '') { return (await this.textBilling.review(requestId, error)) }
  async textChargeSummary({ userId = '' }: Record<string, any> = {}) {
    const row = (await this.get(`SELECT
      COALESCE(SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END),0) reservedRequests,
      COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_points ELSE 0 END),0) reservedPoints,
      COALESCE(SUM(CASE WHEN status='billing_review' THEN 1 ELSE 0 END),0) reviewRequests,
      COALESCE(SUM(CASE WHEN status='billing_review' THEN reserved_points ELSE 0 END),0) reviewPoints
      FROM text_charges${userId ? ' WHERE user_id=?' : ''}`, ...(userId ? [userId] : [])))
    return { reservedRequests: Number(row.reservedRequests), reservedPoints: Math.round(Number(row.reservedPoints) * 10000) / 10000,
      reviewRequests: Number(row.reviewRequests), reviewPoints: Math.round(Number(row.reviewPoints) * 10000) / 10000 }
  }
  async pendingTextCharges(userId, { page = 1, limit = 30 }: Record<string, any> = {}) {
    const current = integer(page, 1, 100000), size = integer(limit, 1, 200)
    const where = "user_id=? AND status IN ('reserved','billing_review')"
    const total = Number((await this.get(`SELECT COUNT(*) n FROM text_charges WHERE ${where}`, userId)).n)
    const rows = (await this.all(`SELECT id,request_id,model,status,reserved_points,error,created_at,finished_at
      FROM text_charges WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, userId, size, (current - 1) * size))
    return { items: rows.map(textChargeView), total, page: current, limit: size, summary: (await this.textChargeSummary({ userId })) }
  }
  paymentOrderPublic(row) {
    if (!row) return null
    return {
      outTradeNo: row.out_trade_no,
      packageId: row.package_id,
      packageName: row.package_name,
      points: Number(row.points),
      amountCents: Number(row.amount_cents),
      amount: formatMoney(Number(row.amount_cents)),
      currency: row.currency,
      status: row.status,
      paymentType: row.payment_type || PAYMENT_TYPE,
      provider: row.provider || PAYMENT_PROVIDER,
      payurl: row.payurl || '',
      payurl2: row.payurl2 || '',
      qrcode: row.qrcode || '',
      img: row.img || '',
      upstreamTradeNo: row.upstream_trade_no || '',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at || null,
      failureReason: row.failure_reason || '',
    }
  }
  async paymentQrCache(outTradeNo) {
    const row = (await this.get('SELECT out_trade_no,mime,bytes,created_at,expires_at FROM payment_qr_cache WHERE out_trade_no=?', String(outTradeNo || '')))
    if (!row) return null
    return {
      outTradeNo: row.out_trade_no,
      mime: row.mime,
      bytes: Buffer.from(row.bytes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }
  }
  async savePaymentQrCache({ outTradeNo, mime, bytes, expiresAt }: Record<string, any>) {
    const value = Buffer.from(bytes || [])
    if (!outTradeNo || !mime || !value.length || !expiresAt) throw failure('付款二维码缓存无效', 500)
    return (await this.transaction(async () => {
      const order = (await this.get('SELECT status,expires_at FROM payment_orders WHERE out_trade_no=?', String(outTradeNo)))
      if (!order || order.status !== PAYMENT_STATES.CREATED || order.expires_at !== String(expiresAt) || Date.parse(order.expires_at) <= Date.now()) return false
      await this.run(`INSERT INTO payment_qr_cache(out_trade_no,mime,bytes,created_at,expires_at)
        VALUES(?,?,?,?,?)
        ON CONFLICT(out_trade_no) DO UPDATE SET mime=excluded.mime,bytes=excluded.bytes,created_at=excluded.created_at,expires_at=excluded.expires_at`,
      String(outTradeNo), String(mime), value, new Date().toISOString(), String(expiresAt))
      return true
    }))
  }
  async deletePaymentQrCache(outTradeNo) {
    await this.run('DELETE FROM payment_qr_cache WHERE out_trade_no=?', String(outTradeNo || ''))
  }
  async createPaymentOrder({ userId, packageId, packageName, points, amountCents, paymentType = PAYMENT_TYPE, expiresAt, merchantPid = '', idempotencyKey = newRequestId(), outTradeNo = newPaymentOrderNo() }: Record<string, any>) {
    return (await this.transaction(async () => {
      await this.db.lockRow('users','id',userId)
      const user = (await this.user(userId))
      if (!user || user.status !== 'active') throw failure('账号已停用', 403)
      const owner = ownerForSession({ role: 'user', userId })
      if (!validIdempotencyKey(idempotencyKey)) throw failure('请求标识无效')
      const existing = (await this.get('SELECT * FROM payment_orders WHERE owner_scope=? AND idempotency_key=?', owner.scope, idempotencyKey))
      if (existing) {
        if (existing.package_id !== packageId || existing.payment_type !== paymentType) throw failure('同一请求标识不能更换充值金额或支付方式', 409)
        return { ...this.paymentOrderPublic(existing), duplicate: true }
      }
      if (!/^[A-Za-z0-9_-]{20,32}$/.test(outTradeNo) || !Number.isSafeInteger(points) || points < 1 || !Number.isSafeInteger(amountCents) || amountCents < 1) throw failure('充值订单参数无效')
      const now = new Date().toISOString()
      const id = randomUUID()
      await this.run(`INSERT INTO payment_orders(id,out_trade_no,user_id,package_id,package_name,points,amount_cents,currency,status,payment_type,provider,payurl,payurl2,qrcode,img,upstream_trade_no,created_at,expires_at,completed_at,updated_at,failure_reason)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, outTradeNo, userId, packageId, packageName, points, amountCents, 'CNY', PAYMENT_STATES.CREATED, paymentType, PAYMENT_PROVIDER, null, null, null, null, null, now, expiresAt, null, now, null)
      await this.run('UPDATE payment_orders SET owner_scope=?,idempotency_key=?,merchant_pid=? WHERE id=?', owner.scope, idempotencyKey, merchantPid, id)
      await this.audit(user.email || user.name, 'payment.order.create', id, { outTradeNo, packageId, points, amountCents, paymentType })
      return this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE id=?', id)))
    }))
  }
  async paymentOrderForIdempotency(userId, idempotencyKey) {
    const row = (await this.get('SELECT * FROM payment_orders WHERE user_id=? AND idempotency_key=?', userId, String(idempotencyKey || '')))
    return this.paymentOrderPublic(row)
  }
  async attachPaymentGateway(outTradeNo, gateway: Record<string, any> = {}) {
    return (await this.transaction(async () => {
      await this.db.lockRow('payment_orders','out_trade_no',String(outTradeNo || ''))
      const row = (await this.get('SELECT * FROM payment_orders WHERE out_trade_no=?', outTradeNo))
      if (!row) throw failure('充值订单不存在', 404)
      const now = new Date().toISOString()
      await this.run(`UPDATE payment_orders SET payurl=?,payurl2=?,qrcode=?,img=?,gateway_order_id=?,upstream_trade_no=COALESCE(upstream_trade_no,?),updated_at=? WHERE id=?`, gateway.payurl || null, gateway.payurl2 || null, gateway.qrcode || null, gateway.img || null, gateway.gatewayOrderId || null, gateway.upstreamTradeNo || null, now, row.id)
      return this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE id=?', row.id)))
    }))
  }
  async failPaymentOrder(outTradeNo, reason) {
    return (await this.transaction(async () => {
      await this.db.lockRow('payment_orders','out_trade_no',String(outTradeNo || ''))
      const row = (await this.get('SELECT * FROM payment_orders WHERE out_trade_no=?', outTradeNo))
      if (!row) return null
      if (isPaymentTerminal(row.status)) return this.paymentOrderPublic(row)
      const now = new Date().toISOString()
      await this.run('UPDATE payment_orders SET status=?,failure_reason=?,updated_at=? WHERE id=? AND status=?', PAYMENT_STATES.FAILED, String(reason || '支付请求失败').slice(0, 300), now, row.id, PAYMENT_STATES.CREATED)
      await this.deletePaymentQrCache(row.out_trade_no)
      await this.audit('系统', 'payment.order.failed', row.id, { outTradeNo, reason: String(reason || '').slice(0, 200) })
      return this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE id=?', row.id)))
    }))
  }
  async expirePaymentOrders(now = new Date()) {
    const timestamp = now.toISOString()
    for (const candidate of await this.all('SELECT id FROM payment_orders WHERE status=? AND expires_at<? ORDER BY id', PAYMENT_STATES.CREATED, timestamp)) {
      await this.transaction(async () => {
        await this.db.lockRow('payment_orders','id',candidate.id)
        const row = await this.get('SELECT * FROM payment_orders WHERE id=? AND status=? AND expires_at<?', candidate.id, PAYMENT_STATES.CREATED, timestamp)
        if (!row) return
        await this.run('UPDATE payment_orders SET status=?,updated_at=?,failure_reason=? WHERE id=? AND status=?', PAYMENT_STATES.EXPIRED, timestamp, '充值订单已过期，请重新发起', row.id, PAYMENT_STATES.CREATED)
        await this.deletePaymentQrCache(row.out_trade_no)
        await this.audit('系统', 'payment.order.expired', row.id, { outTradeNo: row.out_trade_no })
      })
    }
  }
  async paymentOrderForUser(outTradeNo, userId) {
    await this.expirePaymentOrders()
    return (await this.transaction(async () => {
      return this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE out_trade_no=? AND user_id=?', String(outTradeNo || ''), userId)))
    }))
  }
  async paymentOrderForReturn(outTradeNo) {
    await this.expirePaymentOrders()
    return (await this.transaction(async () => {
      return this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE out_trade_no=?', String(outTradeNo || ''))))
    }))
  }
  async completePaymentOrder({ outTradeNo, amountCents, tradeNo = '', tradeStatus, type, merchantPid }: Record<string, any>) {
    await this.expirePaymentOrders()
    return (await this.transaction(async () => {
      await this.db.lockRow('payment_orders','out_trade_no',String(outTradeNo || ''))
      const row = (await this.get('SELECT * FROM payment_orders WHERE out_trade_no=?', String(outTradeNo || '')))
      if (!row) return { kind: 'not_found' }
      const publicOrder = async () => this.paymentOrderPublic((await this.get('SELECT * FROM payment_orders WHERE id=?', row.id)))
      if (type !== row.payment_type || (row.merchant_pid && row.merchant_pid !== merchantPid)) {
        await this.audit('zpay', 'payment.notify.rejected', row.id, { outTradeNo, reason: '支付方式与订单不一致', expectedType: row.payment_type, type })
        return { kind: 'rejected', reason: '支付方式不受支持', order: (await publicOrder()) }
      }
      if (amountCents !== Number(row.amount_cents)) {
        await this.audit('zpay', 'payment.notify.rejected', row.id, { outTradeNo, reason: '金额不一致', expectedCents: Number(row.amount_cents), receivedCents: amountCents })
        return { kind: 'rejected', reason: '支付金额与订单不一致', order: (await publicOrder()) }
      }
      if (tradeStatus === 'TRADE_SUCCESS' && (!tradeNo || tradeNo.length > 200)) return { kind: 'rejected', reason: '上游订单号无效' }
      if (row.status === PAYMENT_STATES.PAID) {
        if (tradeStatus === 'TRADE_SUCCESS' && row.upstream_trade_no !== tradeNo) return { kind: 'rejected', reason: '上游订单号不一致' }
        return { kind: 'duplicate', order: (await publicOrder()) }
      }
      if (tradeStatus !== 'TRADE_SUCCESS') {
        if (isPaymentTerminal(row.status)) return { kind: 'ignored', order: (await publicOrder()) }
        if (!['TRADE_CLOSED', 'TRADE_FAILED', 'TRADE_FAIL'].includes(tradeStatus)) return { kind: 'non_success', order: (await publicOrder()) }
        const next = tradeStatus === 'TRADE_CLOSED' ? PAYMENT_STATES.CLOSED : PAYMENT_STATES.FAILED
        const now = new Date().toISOString()
        await this.run('UPDATE payment_orders SET status=?,upstream_trade_no=?,updated_at=?,failure_reason=? WHERE id=? AND status=?', next, String(tradeNo || '').slice(0, 200) || null, now, `上游状态：${String(tradeStatus || '未知').slice(0, 80)}`, row.id, PAYMENT_STATES.CREATED)
        await this.deletePaymentQrCache(row.out_trade_no)
        await this.audit('zpay', 'payment.notify.non_success', row.id, { outTradeNo, tradeStatus })
        return { kind: 'non_success', order: (await publicOrder()) }
      }
      const user = (await this.user(row.user_id))
      if (!user) return { kind: 'rejected', reason: '用户不存在' }
      const effectiveMerchantPid = merchantPid || row.merchant_pid || ''
      await this.db.lock(`payment-trade:${PAYMENT_PROVIDER}:${tradeNo}`)
      const reused = (await this.get("SELECT id FROM payment_orders WHERE provider=? AND upstream_trade_no=? AND status='paid' AND id<>? AND (merchant_pid=? OR merchant_pid IS NULL OR merchant_pid='')", PAYMENT_PROVIDER, tradeNo, row.id, effectiveMerchantPid))
      if (reused) return { kind: 'rejected', reason: '上游订单已结算' }
      const now = new Date().toISOString()
      // Expiry closes the displayed QR, not funds: verified delayed notifications still settle.
      const changed = (await this.run('UPDATE payment_orders SET status=?,upstream_trade_no=?,completed_at=?,updated_at=?,failure_reason=NULL WHERE id=? AND status<>?', PAYMENT_STATES.PAID, tradeNo, now, now, row.id, PAYMENT_STATES.PAID)).changes
      if (changed !== 1) return { kind: 'duplicate', order: (await publicOrder()) }
      await this.deletePaymentQrCache(row.out_trade_no)
      await this.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?', Number(row.points), row.user_id)
      await this.ledger(row.user_id, Number(row.points), `充值到账 ${row.out_trade_no}`, row.out_trade_no, row.id)
      await this.audit('zpay', 'payment.order.paid', row.id, { outTradeNo, points: Number(row.points), amountCents: Number(row.amount_cents), tradeNo, previousStatus: row.status })
      return { kind: 'paid', order: (await publicOrder()) }
    }))
  }
  async paymentOrders({ search = '', status = '', userId = '', page = 1, limit = 30 }: Record<string, any> = {}) {
    await this.expirePaymentOrders()
    page = integer(page, 1, 100000); limit = integer(limit, 1, 100)
    const clauses = ['1=1']; const args = []
    if (search) {
      const term = `%${String(search).slice(0, 100)}%`
      clauses.push('(p.out_trade_no LIKE ? OR p.package_name LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR p.upstream_trade_no LIKE ?)')
      args.push(term, term, term, term, term)
    }
    if (status) { clauses.push('p.status=?'); args.push(String(status)) }
    if (userId) { clauses.push('p.user_id=?'); args.push(String(userId)) }
    const where = clauses.join(' AND ')
    const total = (await this.get(`SELECT COUNT(*) n FROM payment_orders p JOIN users u ON u.id=p.user_id WHERE ${where}`, ...args)).n
    const items = (await mapAsync((await this.all(`SELECT p.*,u.name AS user_name,u.email AS user_email FROM payment_orders p JOIN users u ON u.id=p.user_id WHERE ${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)), async (row) => ({
      ...this.paymentOrderPublic(row),
      userId: row.user_id,
      userName: row.user_name,
      userEmail: row.user_email || '',
      postedPoints: Number((await this.get('SELECT COALESCE(SUM(delta),0) points FROM ledger WHERE payment_order_id=?',row.id)).points),
      failureReason: row.failure_reason || '',
    })))
    return { items, total, page, limit }
  }
  async paymentSummary() {
    const all = (await this.get(`SELECT COUNT(*) orders,COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) paid,COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) paidCents,COALESCE(SUM(CASE WHEN status='paid' THEN points ELSE 0 END),0) points FROM payment_orders`))
    const today = (await this.get("SELECT COUNT(*) AS orders,COALESCE(SUM(amount_cents),0) AS cents FROM payment_orders WHERE status='paid' AND completed_at>=?", isoStartOfDay()))
    const monthDate = new Date(); monthDate.setUTCDate(1); monthDate.setUTCHours(0, 0, 0, 0)
    const month = (await this.get("SELECT COUNT(*) AS orders,COALESCE(SUM(amount_cents),0) AS cents FROM payment_orders WHERE status='paid' AND completed_at>=?", monthDate.toISOString()))
    return { ...all, todayOrders: Number(today.orders || 0), todayCents: Number(today.cents || 0), monthOrders: Number(month.orders || 0), monthCents: Number(month.cents || 0) }
  }

  // 管理端运维视图只读：这里集中取迁移、磁盘、备份、数据集和运行时状态，
  // 不执行迁移/对账/快照脚本，也不返回任何凭据或令牌原文。
  async operations({ signal }: { signal?: AbortSignal } = {}) {
    const filesColumns = new Set((await tableColumns(this, 'workspace_files')))
    const artifactsColumns = new Set((await tableColumns(this, 'artifacts')))
    const projects = Boolean((await this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'")))
    const layoutReport = (await projectLayoutReport(this))
    const storageDistribution = filesColumns.size
      ? (await this.all('SELECT COALESCE(storage,\'unknown\') AS value,COUNT(*) AS rows,COALESCE(SUM(COALESCE(size,length(bytes))),0) AS bytes FROM workspace_files GROUP BY storage ORDER BY value'))
      : []
    const hasMediaLayout = Boolean((await this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_layout'")))
    const migration = {
      projectLayout: layoutReport.layout,
      projectLayoutLabel: layoutReport.layout === 'scoped' ? '新布局（多项目）' : layoutReport.layout === 'legacy' ? '单项目索引' : layoutReport.layout === 'mixed' ? '半迁移（需处理）' : layoutReport.layout === 'fresh' ? '单项目索引' : '新库（尚无文件）',
      hasProjectsTable: projects,
      hasProjectColumn: filesColumns.has('project_id'),
      workspaceRows: Number(layoutReport.rows || 0),
      workspaceBytesInOldOnly: Number(layoutReport.bytesAtOldOnly || 0),
      workspaceBytesInNewOnly: Number(layoutReport.bytesAtNewOnly || 0),
      workspaceRowsAtOldOnly: Number(layoutReport.atOldOnly || 0),
      workspaceRowsAtNewOnly: Number(layoutReport.atNewOnly || 0),
      workspaceRowsAtBoth: Number(layoutReport.atBoth || 0),
      workspaceRowsAtNeither: Number(layoutReport.atNeither || 0),
      workspaceRowsAtBlob: Number(layoutReport.atBlob || 0),
      workspaceMissingBlobs: Number(layoutReport.missingBlob || 0),
      projectCount: projects ? Number((await this.get('SELECT COUNT(*) AS n FROM projects'))?.n || 0) : 0,
      mediaLayout: (await mediaLayout(this)),
      mediaLayoutUpdatedAt: hasMediaLayout ? (await this.get("SELECT updated_at FROM media_layout WHERE id=1"))?.updated_at || null : null,
      workspaceBlobRows: filesColumns.has('blob') ? Number((await this.get('SELECT COUNT(*) AS n FROM workspace_files WHERE blob IS NOT NULL AND blob<>\'\''))?.n || 0) : 0,
      artifactBlobRows: artifactsColumns.has('blob') ? Number((await this.get('SELECT COUNT(*) AS n FROM artifacts WHERE blob IS NOT NULL AND blob<>\'\''))?.n || 0) : 0,
      workspaceBytesRows: filesColumns.has('bytes') ? Number((await this.get('SELECT COUNT(*) AS n FROM workspace_files WHERE bytes IS NOT NULL'))?.n || 0) : 0,
      artifactBytesRows: artifactsColumns.has('bytes') ? Number((await this.get('SELECT COUNT(*) AS n FROM artifacts WHERE bytes IS NOT NULL'))?.n || 0) : 0,
      storageDistribution,
      artifactStorageDistribution: artifactsColumns.size ? (await this.all('SELECT COALESCE(storage,\'unknown\') AS value,COUNT(*) AS rows,COALESCE(SUM(COALESCE(size,length(bytes))),0) AS bytes FROM artifacts GROUP BY storage ORDER BY value')) : [],
    }

    const root = mediaRoot()
    // 生产容器没有宿主机的 df、systemd 或备份目录权限；这些值必须由宿主定时任务
    // 写入 bind mount 的 JSON，再由这里只读转发。状态文件缺失时明确标成未运行过。
    const snapshotStatus = readOpsStatus('media-snapshot.json')
    const snapshotValue = snapshotStatus.value
    const snapshotItems = Array.isArray(snapshotValue?.snapshots) ? snapshotValue.snapshots.slice(0, 30) : []
    const storage: Record<string, any> = snapshotValue
      ? {
          source: 'host-status-json', mediaRoot: snapshotValue.mediaRoot || root,
          mediaFiles: Number.isFinite(Number(snapshotValue.mediaFiles)) ? Number(snapshotValue.mediaFiles) : null,
          mediaBytes: Number.isFinite(Number(snapshotValue.mediaBytes)) ? Number(snapshotValue.mediaBytes) : null,
          disk: { totalBytes: snapshotValue.disk?.totalBytes ?? null, freeBytes: snapshotValue.disk?.freeBytes ?? null, usedBytes: snapshotValue.disk?.usedBytes ?? null, usagePercent: snapshotValue.disk?.usagePercent ?? null },
          snapshots: { root: snapshotValue.snapshotRoot || null, latestAt: snapshotValue.latestAt || snapshotItems[0]?.updatedAt || null, items: snapshotItems, present: snapshotItems.length > 0, status: statusExpired(snapshotValue, 48 * 3600000) ? 'stale' : (snapshotValue.status || 'unknown'), expired: statusExpired(snapshotValue, 48 * 3600000), finishedAt: snapshotValue.finishedAt || snapshotValue.updatedAt || null },
        }
      : { source: 'host-status-json', mediaRoot: root, mediaFiles: null, mediaBytes: null, disk: { totalBytes: null, freeBytes: null, usedBytes: null, usagePercent: null }, snapshots: { root: null, latestAt: null, items: [], present: false, status: '未运行过', finishedAt: null } }
    storage.capturedAt = snapshotValue?.finishedAt || snapshotValue?.updatedAt || null
    storage.diskSnapshot = storage.disk
    try {
      const disk = statfsSync(root)
      const totalBytes = disk.blocks * disk.bsize, freeBytes = disk.bavail * disk.bsize, usedBytes = (disk.blocks - disk.bfree) * disk.bsize
      storage.disk = { totalBytes, freeBytes, usedBytes, usagePercent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : null, observedAt: new Date().toISOString(), source: 'media-filesystem-statfs' }
    } catch { storage.disk = { totalBytes: null, freeBytes: null, usedBytes: null, usagePercent: null, observedAt: null, source: 'unavailable' } }
    const reconcileCandidates = [
      process.env.OIP_MEDIA_RECONCILE_REPORT,
      join(process.cwd(), 'data', 'media-reconcile.json'),
      join(process.cwd(), 'data', 'media-reconcile.last.txt'),
      join(process.env.OIP_DATA_DIR || '.oip/runtime-data', 'media-reconcile.json'),
    ].filter(Boolean).map(value => resolve(value))
    const reconcilePath = reconcileCandidates.find(path => existsSync(path)) || null
    let reconcile: Record<string, any> = { ran: false, path: null, command: 'node server/media-reconcile.ts --report' }
    if (reconcilePath) {
      try {
        const info = statSync(reconcilePath)
        const raw = readFileSync(reconcilePath, 'utf8')
        let report = null
        try { report = JSON.parse(raw) } catch { /* text conclusion is still useful */ }
        reconcile = report
          ? { ran: true, path: reconcilePath, updatedAt: info.mtime.toISOString(), report }
          : { ran: true, path: reconcilePath, updatedAt: info.mtime.toISOString(), conclusion: raw.slice(-8000) }
      } catch { /* keep no-run state */ }
    }
    const datasetSync = readOpsStatus('dataset-sync.json')
    // The serving archive (or local DB when no service is configured) and
    // dataset-sync.json describe different observations. Keep their source and
    // time separate; an old sync snapshot must not masquerade as current counts.
    const dataset = await readDatasetStats({ signal })
    const databaseCounts = {
      prompts: dataset.prompts,
      images: dataset.images,
      videos: dataset.videos,
      previews: dataset.previews,
    }
    const syncValue = datasetSync.value
    const syncCounts = syncValue
      ? {
          prompts: syncValue.prompts == null ? null : Number(syncValue.prompts),
          images: syncValue.images == null ? null : Number(syncValue.images),
          videos: syncValue.videos == null ? null : Number(syncValue.videos),
          previews: syncValue.previews == null ? null : Number(syncValue.previews),
        }
      : null
    const comparisonKeys = ['prompts', 'images', 'videos'].filter(key => syncCounts?.[key] != null)
    const countsComparable = comparisonKeys.length > 0 && comparisonKeys.every(key =>
      Number.isSafeInteger(syncCounts[key]) && syncCounts[key] >= 0 &&
      Number.isSafeInteger(databaseCounts[key]) && databaseCounts[key] >= 0)
    const syncStatus = syncValue
      ? { path: datasetSync.path, status: statusExpired(syncValue, 24 * 3600000) ? 'stale' : String(syncValue.status || 'unknown'), expired: statusExpired(syncValue, 24 * 3600000), startedAt: syncValue.startedAt || null, updatedAt: syncValue.finishedAt || syncValue.updatedAt || syncValue.updated_at || null, failureReason: syncValue.failureReason || syncValue.error || null, command: syncValue.command || 'systemctl start miaoimg-sync.service', timerPresent: syncValue.timerPresent ?? null }
      : { path: datasetSync.path, status: '未运行过', startedAt: null, updatedAt: null, failureReason: null, command: 'systemctl start miaoimg-sync.service', timerPresent: null }
    // 与文本节点及 Agent 解析同一份注册表；这里展示实际运行配置，不另造兜底。
    const textModels = ownTextModelIds().map(id => {
      const model = ownTextModelById(id)
      return { id: model.id, label: model.label, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, sources: model.sources }
    })
    return {
      migration,
      storage,
      dataset: {
        ...dataset,
        databaseCounts,
        syncCounts,
        countsMatch: countsComparable ? comparisonKeys.every(key => syncCounts[key] === databaseCounts[key]) : null,
        syncCountsSource: syncCounts ? 'dataset-sync.json：上次同步完成时检查的数据库行数' : null,
        syncStatus,
        timerFile: null,
        timerFilePresent: syncStatus.timerPresent,
        timerUnit: 'miaoimg-sync.timer',
        source: `${dataset.countSource === 'archive-api' ? '官网档案服务 /api/catalog' : '当前 dataset.db'}/预览目录 + 宿主 dataset-sync.json`,
      },
      reconcile,
      runtime: { revision: process.env.OIP_RUNTIME_REVISION || null, image: process.env.OIP_RUNTIME_IMAGE || null, observedAt: new Date().toISOString(), textModels, textContextWindow: textModels[0]?.contextWindow ?? null, textContextWindowSource: textModels[0]?.sources.contextWindow ?? null, mediaMode: String(process.env.OIP_MEDIA_MODE || 'owner').trim() || 'owner', mediaRoot: root },
    }
  }
  async loginUser(code) { const row = (await this.get('SELECT id FROM users WHERE secret_hash=? AND status=?',digest(code),'active')); if (!row) throw failure('登录码无效或账号已停用',401); return (await this.createSession('user',row.id)) }

  // MCP 访问令牌：只保存摘要，明文仅在生成/轮换时返回一次。
  async mcpTokenInfo(userId) {
    const row = (await this.get('SELECT mcp_token_hash,mcp_enabled FROM users WHERE id=?', userId))
    return { hasToken: Boolean(row?.mcp_token_hash), enabled: Boolean(row?.mcp_token_hash && row.mcp_enabled) }
  }
  async setMcpEnabled(userId, enabled) {
    if (typeof enabled !== 'boolean') throw failure('缺少 MCP 开关状态', 422)
    if (!(await this.get('SELECT id FROM users WHERE id=?', userId))) throw failure('账号不存在', 404)
    await this.run('UPDATE users SET mcp_enabled=? WHERE id=?', enabled ? 1 : 0, userId)
    await this.audit('用户', 'mcp.enabled', userId, { enabled })
    return (await this.mcpTokenInfo(userId))
  }
  async rotateMcpToken(userId) {
    const user = (await this.get('SELECT id FROM users WHERE id=?', userId))
    if (!user) throw failure('账号不存在', 404)
    const token = `miao_${randomBytes(24).toString('base64url')}`
    await this.run('UPDATE users SET mcp_token_hash=? WHERE id=?', digest(token), userId)
    await this.audit('用户', 'mcp.rotate', userId, {})
    return { token }
  }
  async userByMcpToken(token) {
    const value = String(token || '')
    if (value.length < 20 || value.length > 200) return null
    const row = (await this.get('SELECT id FROM users WHERE mcp_token_hash=? AND status=? AND mcp_enabled=1', digest(value), 'active'))
    return row?.id || null
  }
  async createSession(role, userId = null) {
    await this.run('DELETE FROM sessions WHERE expires<?',Date.now())
    const token = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url')
    await this.run('INSERT INTO sessions VALUES(?,?,?,?,?)',digest(token),role,userId,csrf,Date.now()+12*3600000)
    return { token, csrf, role, userId }
  }
  async session(token) {
    if (!token) return null
    const tokenHash = digest(token)
    const session = (await this.get('SELECT role,user_id AS userId,csrf,expires FROM sessions WHERE hash=? AND expires>?', tokenHash, Date.now()))
    if (!session || (session.userId && (await this.user(session.userId))?.status !== 'active')) return null
    const { role, userId } = session
    // A slow body or an Agent round can outlive logout, password revocation or
    // the twelve-hour deadline. Keep only the digest, and check the live row at
    // a new dispatch; already accepted jobs and settlement own their lifetimes.
    Object.defineProperty(session, MODEL_SESSION_CURRENT, { value: async () => Boolean((await this.get(
      'SELECT 1 FROM sessions WHERE hash=? AND role=? AND user_id IS ? AND expires>?'+(this.db.dialect==='postgres'&&this.db.isTransaction?' FOR SHARE':''), tokenHash, role, userId, Date.now(),
    ))) })
    // 请求级读取生效价；视频询价等直接计价路径也要刷新，不能依赖队列轮询。
    await this.settings()
    return session
  }
  async logout(token) { await this.run('DELETE FROM sessions WHERE hash=?',digest(token)) }
  async begin(args) { return (await this.reserve({ ...args, status: GENERATION_STATES.RUNNING })).id }
  async reserve({ session, model, points, prompt, parameters, idempotencyKey, requestId, status = GENERATION_STATES.QUEUED, inputs = {}, accessToken = '', workerId = '' }: Record<string, any>) {
    return (await this.transaction(async () => {
      const cfg = (await this.settings())
      const publicId = publicModelId(model)
      const owner = ownerForSession(session)
      const userId = owner.id && owner.type === 'user' ? owner.id : null
      if (userId) await this.db.lockRow('users','id',userId)
      const actor = owner.type === 'admin' ? '管理员' : userId ? (await this.user(userId))?.name : '访客'
      const suppliedAccessToken = String(accessToken || '').trim()
      if (owner.type === 'guest' && suppliedAccessToken && !/^[A-Za-z0-9_-]{20,200}$/.test(suppliedAccessToken)) throw failure('访问标识无效')
      const issuedAccessToken = owner.type === 'guest' ? suppliedAccessToken || randomBytes(32).toString('base64url') : ''
      const ownerScope = owner.type === 'guest' ? guestScope(issuedAccessToken) : owner.scope
      const suppliedRequestId = String(requestId || '').trim()
      if (suppliedRequestId && !validRequestId(suppliedRequestId)) throw failure('请求标识无效')
      const candidateRequestId = suppliedRequestId || newRequestId()
      const candidateKey = String(idempotencyKey || suppliedRequestId || candidateRequestId).trim()
      if (!validIdempotencyKey(candidateKey)) throw failure('请求标识无效')
      const byRequest = (await this.get('SELECT * FROM generations WHERE request_id=?', candidateRequestId))
      if (byRequest) {
        if (owner.type === 'guest' ? !isGuestScope(byRequest.owner_scope) : byRequest.owner_scope !== ownerScope) throw failure('请求标识已被其他所有者使用',409)
        return (await this.reservationFromExisting(byRequest, accessToken))
      }
      const byKey = (await this.get('SELECT * FROM generations WHERE owner_scope=? AND idempotency_key=?', ownerScope, candidateKey))
        || (owner.type === 'guest' ? (await this.get('SELECT * FROM generations WHERE owner_scope=? AND idempotency_key=?', 'guest', candidateKey)) : null)
      if (byKey) return (await this.reservationFromExisting(byKey, accessToken))
      // Management credentials can inspect/recover historical tasks, but are
      // not a user balance. Every new media order must belong to a billed user.
      await requireModelUser(session, '图片和视频模型')
      if (userId && /^assets\/[A-Za-z0-9_-]+$/.test(parameters.outputDirectory || '')) {
        const activeNode = (await this.get("SELECT request_id FROM generations WHERE user_id=? AND json_extract(parameters,'$.outputDirectory')=? AND COALESCE(json_extract(parameters,'$.workspaceProject'),'default')=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1",
          userId, parameters.outputDirectory, parameters.workspaceProject || 'default'))
        if (activeNode) throw Object.assign(failure('该节点已在另一页面生成，请取回原任务后再操作，未重复扣费', 409), { activeRequestId: activeNode.request_id })
      }
      if (!cfg.enabled) throw failure('管理员已暂停生成',503)
      if (!publicId) throw failure('不支持的图片模型',422)
      if (cfg.models[publicId] === false) throw failure('这个模型已暂停',403)
      const activeRoute = activeModelForSettings(publicId, cfg)
      if (!activeRoute) throw failure('这个模型暂未配置可用渠道', 503)
      if (model?.provider && activeRoute.channelProvider && model.provider !== activeRoute.channelProvider) {
        throw failure('模型渠道刚刚发生变化，请重新提交', 409)
      }
      // 管理员给用户勾选的可用模型（空数组 = 全部开放）。这里在预扣/调上游之前拦截。
      const allowed = (await this.user(userId))?.models
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(publicId)) throw failure('这个模型未对你的账号开放', 403)
      if (![GENERATION_STATES.QUEUED, GENERATION_STATES.RUNNING].includes(status)) throw failure('生成状态无效',422)
      points = credits(points, 0, 1000000, model.provider === 'suihe' || parameters.videoPricing?.version===VIDEO_PRICING_VERSION ? 10000 : 100)
      // This is a new reservation; never reset the marker on a duplicate above.
      // Preparation can yield before the worker starts the actual transport.
      parameters = { ...parameters, submissionState: 'not_started' }
      // Snapshot a manually configured per-second price with the task so an admin
      // edit cannot change the amount of an already reserved generation.
      if (isCostPlusVideo(publicId)) {
        const requestedResolution = String(parameters?.resolution || '').trim()
        const configuredVideo = cfg.prices?.[publicId]?.video
        const manualRate = configuredVideo && typeof configuredVideo === 'object'
          ? (Object.entries(configuredVideo).find(([key]) => key.toLowerCase() === requestedResolution.toLowerCase())?.[1] ?? configuredVideo.default)
          : undefined
        parameters = { ...parameters, ...(Number.isFinite(Number(manualRate)) ? { manualVideoCreditsPerSecond: Number(manualRate) } : {}) }
      }
      if (model.video && parameters.videoPricing?.version === VIDEO_PRICING_VERSION) {
        const frozenQuote = estimateGenerationCost({model,generation:parameters})
        if (Math.round(frozenQuote.points*10000) !== Math.round(points*10000)) {
          throw failure('模型价格刚刚发生变化，请重新询价后再提交',409)
        }
      }
      const user = (await this.user(userId))
      if (!user || user.status !== 'active') throw failure('账号已停用',403)
      if (!(Number(user.points) > 0)) throw failure('积分不足，请先充值后生成',402)
      if (user.models.length && !user.models.includes(publicId)) throw failure('账号未获准使用这个模型',403)
      const configuredActiveLimit = Number(process.env.MIAO_MAX_ACTIVE_GENERATIONS_PER_USER || 8)
      const activeLimit = Number.isSafeInteger(configuredActiveLimit) && configuredActiveLimit > 0 ? Math.min(configuredActiveLimit, 1000) : 8
      const active = Number((await this.get("SELECT COUNT(*) AS count FROM generations WHERE user_id=? AND status IN ('queued','running')", userId))?.count || 0)
      if (active >= activeLimit) throw failure('当前账号进行中的生成任务过多，请等待已有任务完成后再试', 429)
      if ((await this.run('UPDATE users SET points=ROUND(points-?,4) WHERE id=? AND points>=?',points,userId,points)).changes !== 1) throw failure('积分不足，请联系妙图团队',402)
      const id = newGenerationId()
      const now = new Date().toISOString()
      const expiresAt = status === GENERATION_STATES.QUEUED ? new Date(Date.now() + GENERATION_LIMITS.queueMs).toISOString() : null
      await this.run(`INSERT INTO generations(id,user_id,actor,model,status,points,reserved_points,charged_points,prompt,parameters,error,created_at,finished_at,request_id,idempotency_key,owner_scope,viewer_token_hash,provider,upstream_model,upstream_request_id,usage,started_at,cancel_requested,lease_id,lease_at,upstream_status,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, userId, actor, publicId, status, points, points, 0, prompt, JSON.stringify(parameters), null, now, null, candidateRequestId, candidateKey, ownerScope, issuedAccessToken ? digest(issuedAccessToken) : null, model.provider || null, model.id || publicId, null, null, status === GENERATION_STATES.RUNNING ? now : null, 0, status === GENERATION_STATES.RUNNING ? workerId || null : null, status === GENERATION_STATES.RUNNING ? now : null, null, expiresAt)
      await this.ledger(userId,-points,'生成预扣',id)
      await this.saveGenerationInputs(id, inputs)
      const row = (await this.get('SELECT * FROM generations WHERE id=?', id))
      return { id, requestId: candidateRequestId, idempotencyKey: candidateKey, status, owner, accessToken: issuedAccessToken, position: (await this.queuePosition(row)), duplicate: false }
    }))
  }
  async existingGeneration({ session, requestId = '', idempotencyKey = '', accessToken = '' }: Record<string, any> = {}) {
    const owner = ownerForSession(session)
    const ownerScope = owner.type === 'guest' && accessToken ? guestScope(accessToken) : owner.scope
    const suppliedRequestId = String(requestId || '').trim()
    if (suppliedRequestId) {
      const byRequest = (await this.get('SELECT * FROM generations WHERE request_id=?', suppliedRequestId))
      if (byRequest) {
        if (owner.type === 'guest' ? !isGuestScope(byRequest.owner_scope) : byRequest.owner_scope !== ownerScope) throw failure('请求标识已被其他所有者使用',409)
        return (await this.reservationFromExisting(byRequest, accessToken))
      }
    }
    const suppliedKey = String(idempotencyKey || '').trim()
    if (!suppliedKey) return null
    const byKey = (await this.get('SELECT * FROM generations WHERE owner_scope=? AND idempotency_key=?', ownerScope, suppliedKey))
      || (owner.type === 'guest' ? (await this.get('SELECT * FROM generations WHERE owner_scope=? AND idempotency_key=?', 'guest', suppliedKey)) : null)
    return byKey ? (await this.reservationFromExisting(byKey, accessToken)) : null
  }
  async reservationFromExisting(row, accessToken = '') {
    const guestAccess = isGuestScope(row.owner_scope) && hashMatches(accessToken, row.viewer_token_hash)
    if (isGuestScope(row.owner_scope) && !guestAccess) throw failure('无权使用这次请求',403)
    return {
      id: row.id,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      // model / provider 供视频轮询判断上游通道，缺了会把方舟任务当成 Sub2API 任务查询。
      model: row.model,
      provider: row.provider || '',
      owner: { scope: row.owner_scope },
      accessToken: guestAccess ? accessToken : '',
      upstreamRequestId: row.upstream_request_id || '',
      position: (await this.queuePosition(row)),
      duplicate: true,
    }
  }
  async assertGenerationDispatch(id, workerId, { markStarted = false }: { markStarted?: boolean } = {}) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const row = (await this.get('SELECT status,lease_id,parameters,user_id,owner_scope,model FROM generations WHERE id=?', id))
      const user = row?.user_id ? (await this.user(row.user_id)) : null
      const cfg = (await this.settings()), model = row ? modelById(row.model) : null
      assertReservedDispatch({
        running: row?.status === GENERATION_STATES.RUNNING,
        ownsLease: Boolean(workerId) && row?.lease_id === workerId,
        userOwned: Boolean(row?.user_id) && row.owner_scope === `user:${row.user_id}`,
        active: user?.status === 'active', enabled: cfg.enabled,
        modelKnown: Boolean(model), modelEnabled: cfg.models?.[row?.model] !== false,
        modelAllowed: Boolean(user) && (!user.models.length || user.models.includes(row.model)),
        video: Boolean(model?.video), videoEnabled: cfg.videoEnabled,
      })
      if (markStarted) {
        const parameters = { ...parse(row.parameters), submissionState: 'started', submissionStartedAt: new Date().toISOString() }
        await this.run('UPDATE generations SET parameters=? WHERE id=?', JSON.stringify(parameters), id)
      }
    }))
  }
  async setUpstreamTask(id, { requestId = '', model = '', status = null, workerId = '' }: Record<string, any> = {}) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const row = (await this.get('SELECT * FROM generations WHERE id=?', id))
      // 上游请求可能已接受后，用户才取消本地记录。即使本地已经是 cancelled，
      // 也必须把 upstream_request_id 落下来，供后续对账和人工找回；不能因 409 丢掉它。
      if (!row || ![GENERATION_STATES.RUNNING, GENERATION_STATES.CANCELLED].includes(row.status)) throw failure('生成记录已结算', 409)
      const keepLease=workerId && row.lease_id===workerId && row.status===GENERATION_STATES.RUNNING
      await this.run('UPDATE generations SET upstream_request_id=?,upstream_model=COALESCE(?,upstream_model),upstream_status=?,lease_id=?,lease_at=? WHERE id=?', String(requestId || '').slice(0, 200) || null, String(model || '').slice(0, 200) || null, status == null ? row.upstream_status : Number(status), keepLease?workerId:null,keepLease?row.lease_at:null,id)
      return (await this.get('SELECT * FROM generations WHERE id=?', id))
    }))
  }
  async saveGenerationInputs(id, inputs: Record<string, any> = {}) {
    const references = Array.isArray(inputs.references) ? inputs.references : []
    await forEachAsync(references, async (item, index) => (await this.run('INSERT INTO generation_inputs(generation_id,position,kind,role,mime,extension,bytes) VALUES(?,?,?,?,?,?,?)', id, index, 'reference', item.role || null, item.mime, item.extension, item.bytes)))
    if (inputs.edit?.mask) await this.run('INSERT INTO generation_inputs(generation_id,position,kind,role,mime,extension,bytes) VALUES(?,?,?,?,?,?,?)', id, references.length, 'mask', null, inputs.edit.mask.mime, inputs.edit.mask.extension, inputs.edit.mask.bytes)
  }
  async loadGeneration(id) {
    const row = (await this.get('SELECT * FROM generations WHERE id=?', id))
    if (!row) return null
    const parameters = parse(row.parameters)
    const references = (await this.all('SELECT * FROM generation_inputs WHERE generation_id=? AND kind=? ORDER BY position', id, 'reference')).map((item) => ({ value: `data:${item.mime};base64,${Buffer.from(item.bytes).toString('base64')}`, bytes: Buffer.from(item.bytes), mime: item.mime, extension: item.extension, role: item.role || 'general' }))
    const mask = (await this.get('SELECT * FROM generation_inputs WHERE generation_id=? AND kind=? ORDER BY position LIMIT 1', id, 'mask'))
    const edit = parameters.edit ? { ...parameters.edit, ...(mask ? { mask: { value: `data:${mask.mime};base64,${Buffer.from(mask.bytes).toString('base64')}`, bytes: Buffer.from(mask.bytes), mime: mask.mime, extension: mask.extension } } : {}) } : null
    return { ...row, parameters, references, edit }
  }
  async queuePosition(row) {
    if (!row || row.status !== GENERATION_STATES.QUEUED) return 0
    return Number((await this.get("SELECT COUNT(*) n FROM generations WHERE status='queued' AND (created_at<? OR (created_at=? AND id<=?))", row.created_at, row.created_at, row.id)).n)
  }
  async claimNext(workerId) {
    return (await this.transaction(async () => {
      const cfg = (await this.settings())
      if (!cfg.enabled) return null
      // Maintenance runs once per pump. Claim only the oldest candidate, rather
      // than rescanning every running/queued generation for every dispatch.
      while (true) {
        const candidate = (await this.get("SELECT * FROM generations WHERE status='queued' ORDER BY created_at ASC,id ASC LIMIT 1" + (this.db.dialect === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : '')))
        if (!candidate) return null
        const now = new Date().toISOString()
        if (candidate.expires_at && candidate.expires_at < now) {
          await this.expireQueued(candidate.id, now)
          continue
        }
        const user = candidate.user_id ? (await this.user(candidate.user_id)) : null
        if ((modelById(candidate.model)?.video && !cfg.videoEnabled) || cfg.models[candidate.model] === false || (candidate.user_id && (!user || user.status !== 'active' || (user.models.length && !user.models.includes(candidate.model))))) {
          await this.settleFailure(candidate, '生成权限已变更，预扣积分已退还')
          continue
        }
        const changed = (await this.run("UPDATE generations SET status='running',started_at=?,lease_id=?,lease_at=?,expires_at=NULL WHERE id=? AND status='queued'", now, workerId, now, candidate.id)).changes
        if (changed !== 1) return null
        return (await this.loadGeneration(candidate.id))
      }
    }))
  }
  async suiheLibraryAsset(userId, library, sha256) {
    return (await this.get('SELECT reference_id AS referenceId,status FROM suihe_library_assets WHERE user_id=? AND library=? AND sha256=?', userId, library, sha256)) || null
  }
  async saveSuiheLibraryAsset(userId, library, sha256, referenceId, status) {
    const now = new Date().toISOString()
    await this.run(`INSERT INTO suihe_library_assets(user_id,library,sha256,reference_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,library,sha256) DO UPDATE SET reference_id=excluded.reference_id,status=excluded.status,updated_at=excluded.updated_at`,
    userId, library, sha256, referenceId, status, now, now)
  }
  async forgetSuiheLibraryAsset(userId, library, sha256) {
    await this.run('DELETE FROM suihe_library_assets WHERE user_id=? AND library=? AND sha256=?', userId, library, sha256)
  }
  async heartbeat(id, workerId) {
    return (await this.run("UPDATE generations SET lease_at=? WHERE id=? AND lease_id=? AND status='running'", new Date().toISOString(), id, workerId)).changes === 1
  }
  async releaseLease(id, workerId) { await this.run('UPDATE generations SET lease_id=NULL,lease_at=NULL WHERE id=? AND lease_id=?', id, workerId) }
  async noteImageResultPending(id: string, workerId: string, metadata: Record<string, any>) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
      if (!g || g.status !== GENERATION_STATES.RUNNING || g.lease_id !== workerId) throw failure('原任务已停止保存', 409)
      const parameters = { ...parse(g.parameters), imageResultPending: true }
      delete parameters.submissionUncertain
      delete parameters.submissionDiagnosticId
      await this.run('UPDATE generations SET parameters=?,error=?,usage=?,upstream_model=?,upstream_request_id=?,upstream_status=? WHERE id=?',
        JSON.stringify(parameters), '生成已完成，正在保存原图；不会重新生成', metadata.usage ? JSON.stringify(metadata.usage) : g.usage,
        metadata.upstreamModel || g.upstream_model, metadata.upstreamRequestId || g.upstream_request_id, metadata.upstreamStatus ?? g.upstream_status, id)
    }))
  }
  async deferImageResult(id: string, workerId: string) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
      if (!g || g.status !== GENERATION_STATES.RUNNING || g.lease_id !== workerId) return
      const parameters = { ...parse(g.parameters), imageResultPending: true }
      const attempt = Math.min(1000, Math.max(0, Number(parameters.imageResultRetry?.attempt) || 0)) + 1
      parameters.imageResultRetry = { attempt, at: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(4, attempt - 1)) }
      delete parameters.submissionUncertain
      delete parameters.submissionDiagnosticId
      await this.run('UPDATE generations SET parameters=?,error=?,lease_id=NULL,lease_at=NULL WHERE id=?', JSON.stringify(parameters),
        '生成已完成，原图保存暂未成功，系统将继续取回原图；不会重新生成', id)
    }))
  }
  async claimImageResult(id: string, workerId: string) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
      if (!g || g.status !== GENERATION_STATES.RUNNING) return null
      if (g.lease_id && Date.parse(g.lease_at) > Date.now() - GENERATION_LIMITS.leaseMs) return null
      const parameters = { ...parse(g.parameters), imageResultPending: true }
      if (Number(parameters.imageResultRetry?.at) > Date.now()) return null
      delete parameters.submissionUncertain
      delete parameters.submissionDiagnosticId
      await this.run('UPDATE generations SET parameters=?,lease_id=?,lease_at=? WHERE id=?', JSON.stringify(parameters), workerId, new Date().toISOString(), id)
      return (await this.get('SELECT * FROM generations WHERE id=?', id))
    }))
  }
  async claimAcceptedImage(id: string, workerId: string) {
    return (await this.transaction(async ()=>{
      await this.db.lockRow('generations','id',id)
      const g=(await this.get('SELECT * FROM generations WHERE id=?',id))
      if(!g || g.status!==GENERATION_STATES.RUNNING || g.provider!=='suihe' || !g.upstream_request_id || modelById(g.model)?.video) return null
      if(g.lease_id && Date.parse(g.lease_at)>Date.now()-GENERATION_LIMITS.leaseMs) return null
      const parameters=parse(g.parameters)
      if(parameters.imageResultPending || parameters.imageResultExpiredAt) return null
      await this.run('UPDATE generations SET lease_id=?,lease_at=? WHERE id=?',workerId,new Date().toISOString(),id)
      return (await this.loadGeneration(id))
    }))
  }
  async stopImageResultRecovery(id: string, reason: 'expired' | 'missing') {
    if (!['expired', 'missing'].includes(reason)) throw failure('原图回执恢复停止原因无效', 422)
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
      if (!g || g.status !== GENERATION_STATES.RUNNING) return true
      const leaseAt = Date.parse(g.lease_at)
      if (g.lease_id && (!Number.isFinite(leaseAt) || leaseAt > Date.now() - GENERATION_LIMITS.leaseMs)) return false
      const parameters = { ...parse(g.parameters), submissionUncertain: true }
      if (reason === 'expired') parameters.imageResultExpiredAt = new Date().toISOString()
      delete parameters.imageResultPending
      delete parameters.imageResultRetry
      if (parameters.desktopDelivery === 1) {
        parameters.imageResultRecoveryStopped = { reason, at: new Date().toISOString() }
        // Receipt recovery reads its original result only. This generation's
        // uploaded inputs cannot help after that recovery has explicitly ended.
        await this.run('DELETE FROM generation_inputs WHERE generation_id=?', id)
      }
      await this.run('UPDATE generations SET parameters=?,error=?,lease_id=NULL,lease_at=NULL WHERE id=?', JSON.stringify(parameters),
        reason === 'expired' ? '原图暂存期已结束，请联系妙图团队核对原任务，避免重复生成' : '原图暂存回执缺失，请保留原任务并联系妙图团队核对，避免重复生成', id)
      return true
    }))
  }
  async generationForViewer(requestId, session, accessToken = '') {
    const row = (await this.get('SELECT * FROM generations WHERE request_id=?', requestId))
    if (!row) return null
    if (!this.canView(row, session, accessToken)) throw failure('无权查看这次生成',403)
    return (await this.publicGeneration(row, accessToken))
  }
  canView(row, session, accessToken = '') {
    if (session?.role === 'admin') return true
    if (row.user_id) return session?.userId === row.user_id
    if (row.owner_scope === 'admin') return false
    return hashMatches(accessToken, row.viewer_token_hash)
  }
  async publicGeneration(row, accessToken = '') {
    const parameters = parse(row.parameters)
    delete parameters.videoPricing
    delete parameters.upstreamImagePricing
    delete parameters.suiheCost
    delete parameters.upstreamProvider
    delete parameters.imageResultPending
    delete parameters.imageResultRetry
    delete parameters.imageResultExpiredAt
    delete parameters.imageResultRecoveryStopped
    const delivery = parameters.desktopDelivery === 1 ? { target: 'desktop', status: parameters.desktopDeliveredAt ? 'saved' : parameters.desktopMediaExpiredAt ? 'expired' : 'pending', expiresAt: parameters.desktopExpiresAt || null, savedAt: parameters.desktopDeliveredAt || null } : null
    const outputDirectory = String(parameters.desktopDelivery === 1 ? '' : parameters.outputDirectory || '').replace(/^\/+|\/+$/g, '')
    const accessQuery = isGuestScope(row.owner_scope) && accessToken ? `?access=${encodeURIComponent(accessToken)}` : ''
    const previewQuery = accessQuery + `${accessQuery ? '&' : '?'}v=${MEDIA_INPUT_VERSION}`
    const images = (await this.all('SELECT a.id,a.mime FROM artifacts a LEFT JOIN artifact_expiry e ON e.artifact_id=a.id WHERE a.request_id=? AND (e.expires_at IS NULL OR e.expires_at>?) ORDER BY a.rowid', row.id, new Date().toISOString())).map((item) => ({ id: item.id, url: `/api/imagine/result/${item.id}${accessQuery}`, thumbnailUrl: delivery ? '' : `/api/imagine/preview/image/${item.id}${previewQuery}`, mime: item.mime, format: item.mime.split('/')[1], path: outputDirectory ? `${outputDirectory}/${item.id}.${item.mime.split('/')[1] || 'png'}` : '' }))
    const video = publicVideoResult((await this.videoResult(row.id)), {
      url: delivery && delivery.status !== 'pending' ? '' : `/api/imagine/video-content?requestId=${encodeURIComponent(row.request_id)}`,
      thumbnailUrl: delivery ? '' : `/api/imagine/preview/video/${row.request_id}${previewQuery}`,
    })
    const resultCount = Number.isSafeInteger(parameters.resultCount) ? parameters.resultCount : video ? 1 : images.length || (row.status === GENERATION_STATES.SUCCEEDED ? null : 0)
    const errorExplanation = row.error ? explainUserError(row.error, { generationStatus: row.status, chargedPoints: row.charged_points, reservedPoints: row.reserved_points || row.points, submissionUncertain: Boolean(parameters.submissionUncertain), requestId: row.request_id }) : null
    return { errorExplanation, delivery, resultCount, requestId: row.request_id, status: row.status, model: row.model, modelLabel: modelById(row.model)?.label || row.model, points: row.points, reservedPoints: Number(row.reserved_points || row.points || 0), chargedPoints: Number(row.charged_points || (row.status === GENERATION_STATES.SUCCEEDED ? row.points : 0)), prompt: row.prompt, parameters, size: parameters.size, quality: parameters.quality, format: parameters.format, background: parameters.background, inputFidelity: parameters.inputFidelity, count: parameters.count, duration: parameters.duration, editMode: parameters.editMode || null, usage: row.usage ? parse(row.usage) : null, error: row.error ? userFacingError(row.error, { generationStatus: row.status, chargedPoints: row.charged_points, reservedPoints: row.reserved_points || row.points, submissionUncertain: Boolean(parameters.submissionUncertain) }) : '', createdAt: row.created_at, startedAt: row.started_at || null, finishedAt: row.finished_at || null, submissionUncertain: Boolean(parameters.submissionUncertain), images, video, queuePosition: (await this.queuePosition(row)) }
  }
  async videoResult(generationId) {
    const row = (await this.get('SELECT * FROM video_results WHERE generation_id=?', generationId))
    if (!row) return null
    return { id: row.video_id, url: row.video_url, mime: row.mime, duration: row.duration === null ? null : Number(row.duration), width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height), thumbnailUrl: row.thumbnail_url || '', metadata: parse(row.metadata || '{}'), createdAt: row.created_at }
  }
  // 上游调用留档：每条记录保留「我们发出去什么、上游回了什么、用量多少、花了多少、
  // 秘塔账户余额前后差多少」。用户跑得越多，我们就越能据此推算真实单价——
  // 包括上游没公开价的档位（秘塔 480p/512p、Mini 720p、标准版 4K 等）。
  async recordUpstreamCall({ generationId = null, provider, model, kind, tier = '', seconds = null, hasInputVideo = false, request = {}, response = null, usage = null, cost = null, creditsBefore = null, creditsAfter = null, estimatedCredits = null, upstreamRequestId = '', status = 'ok', error = '' }: Record<string, any> = {}) {
    const existing = generationId ? (await this.get('SELECT id FROM upstream_calls WHERE generation_id=? ORDER BY created_at DESC LIMIT 1', generationId)) : null
    if (existing) {
      await this.finishUpstreamCall(generationId, { response, usage, cost, estimatedCredits, upstreamRequestId, status, error })
      await this.run('UPDATE upstream_calls SET request=? WHERE id=?', auditJson(request ?? {}, 20000), existing.id)
      return null
    }
    const delta = Number.isFinite(creditsBefore) && Number.isFinite(creditsAfter)
      ? Math.round((creditsBefore - creditsAfter) * 100) / 100
      : null
    await this.run(`INSERT INTO upstream_calls(id,generation_id,provider,model,kind,tier,seconds,has_input_video,request,response,usage,cost_rmb,cost_basis,credits_before,credits_after,credits_delta,estimated_credits,upstream_request_id,status,error,created_at,cost_detail,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(), generationId, String(provider || ''), String(model || ''), String(kind || 'video'), String(tier || ''),
    Number.isFinite(seconds) ? Number(seconds) : null, hasInputVideo ? 1 : 0,
    auditJson(request ?? {}, 20000), response == null ? null : auditJson(response, 40000),
    usage == null ? null : auditJson(usage, 4000),
    finiteCost(cost?.rmb), cost?.basis ? String(cost.basis).slice(0, 200) : null,
    Number.isFinite(creditsBefore) ? Number(creditsBefore) : null, Number.isFinite(creditsAfter) ? Number(creditsAfter) : null,
    delta, estimatedCredits != null && Number.isFinite(Number(estimatedCredits)) ? Number(estimatedCredits) : null, String(upstreamRequestId || '').slice(0, 200), String(status || 'ok').slice(0, 40), String(error || '').slice(0, 500), new Date().toISOString(), cost ? auditJson(cost, 12000) : null, new Date().toISOString())
    return delta
  }
  async recordUpstreamBalance({ provider, balance, consumed = null, total = null, observedAt = new Date().toISOString() }: Record<string, any> = {}) {
    if (!provider || balance == null || !Number.isFinite(Number(balance))) return null
    const at = String(observedAt)
    const previous = (await this.get('SELECT * FROM upstream_balance_snapshots WHERE provider=? AND observed_at<? ORDER BY observed_at DESC LIMIT 1', String(provider), at))
    await this.run('INSERT INTO upstream_balance_snapshots(id,provider,balance,consumed,total,observed_at) VALUES(?,?,?,?,?,?)', randomUUID(), String(provider), Number(balance), consumed != null && Number.isFinite(Number(consumed)) ? Number(consumed) : null, total != null && Number.isFinite(Number(total)) ? Number(total) : null, at)
    return previous || null
  }
  async reconcileUpstreamBalance({ provider, balance, consumed = null, total = null, observedAt = new Date().toISOString() }: Record<string, any> = {}) {
    if (!provider || balance == null || !Number.isFinite(Number(balance))) return { provider: String(provider || ''), status: 'unknown', conclusion: '余额未知，未对账', alarm: false }
    const at = String(observedAt)
    const previous = (await this.recordUpstreamBalance({ provider, balance, consumed, total, observedAt: at }))
    const fromAt = previous?.observed_at || null
    const rows = fromAt
      ? (await this.all(`SELECT status, estimated_credits FROM upstream_calls WHERE provider=? AND created_at>? AND created_at<=?`, String(provider), fromAt, at))
      : []
    const delta = previous ? Math.round((Number(previous.balance) - Number(balance)) * 10000) / 10000 : null
    const successful = rows.filter(row => ['ok','succeeded','submitted'].includes(row.status))
    const failed = rows.filter(row => !successful.includes(row))
    const unknownCosts=successful.filter(row=>finiteCost(row.estimated_credits)===null).length
    const expected = successful.reduce((sum,row)=>sum+(finiteCost(row.estimated_credits) ?? 0),0)
    const expectedRounded = Math.round(expected*10000)/10000
    const consumedDelta=previous && finiteCost(consumed)!==null && finiteCost(previous.consumed)!==null && Number(consumed)>=Number(previous.consumed) ? Math.round((Number(consumed)-Number(previous.consumed))*10000)/10000 : null
    const comparisonDelta=consumedDelta ?? delta
    const pending=fromAt ? Number((await this.get("SELECT COUNT(*) n FROM upstream_calls WHERE provider=? AND created_at<=? AND status IN ('submitted','submission_unknown')",String(provider),at)).n) : 0
    const late=fromAt ? Number((await this.get("SELECT COUNT(*) n FROM upstream_calls WHERE provider=? AND created_at<=? AND updated_at>? AND updated_at<=? AND status IN ('ok','succeeded','failed_after_submit','cancelled_after_submit')",String(provider),fromAt,fromAt,at)).n) : 0
    const unexplained=comparisonDelta===null || unknownCosts>0 ? null : Math.round((comparisonDelta-expectedRounded)*10000)/10000
    const tolerance=Math.max(0.5,Math.abs(expectedRounded)*0.2)
    const alarm=unexplained!==null && Math.abs(unexplained)>tolerance
    const details={ version:1, comparisonSource:consumedDelta===null?'balance_change':'consumed_change',comparisonDelta,unknownCosts,pending,late,invoiceVerified:false,expectedSource:'creation_window_estimates' }
    const conclusion=!previous ? '首次快照，等待下一次余额后再对账'
      : '窗口诊断：'+(consumedDelta===null ? '余额变化 '+delta : '累计消耗增加 '+consumedDelta)
        +'，创建窗口预估 '+expectedRounded+'；'+(unknownCosts ? unknownCosts+' 条成本未知，无法计算完整差额'
        : alarm ? '差额 '+unexplained+'，需核对延迟扣费、共享账号调用、充值或退款'
        : '未发现超容差差额')
        +(pending || late ? '；有 '+pending+' 个待确认任务、'+late+' 个跨窗口终态' : '')
        +'；非逐单账单结论'
    const row = { provider: String(provider), fromAt, toAt: at, previousBalance: previous ? Number(previous.balance) : null, currentBalance: Number(balance), delta, successfulEstimatedCredits: previous && unknownCosts===0 ? expectedRounded : null, unexplainedCredits: unexplained, calls: rows.length, successfulCalls: successful.length, failedCalls: failed.length, conclusion, alarm, details }
    await this.run(`INSERT INTO upstream_reconciliations(id,provider,from_at,to_at,previous_balance,current_balance,delta,successful_estimated_credits,unexplained_credits,calls,successful_calls,failed_calls,conclusion,alarm,created_at,details)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, randomUUID(), row.provider, row.fromAt, row.toAt, row.previousBalance, row.currentBalance, row.delta, row.successfulEstimatedCredits, row.unexplainedCredits, row.calls, row.successfulCalls, row.failedCalls, row.conclusion, row.alarm ? 1 : 0, at, JSON.stringify(details))
    return row
  }
  async upstreamReconciliation({ provider = '', limit = 30 }: Record<string, any> = {}) {
    const clauses = ['1=1']; const args = []
    if (provider) { clauses.push('provider=?'); args.push(String(provider).slice(0, 40)) }
    const rows = (await this.all(`SELECT * FROM upstream_reconciliations WHERE ${clauses.join(' AND ')} ORDER BY to_at DESC LIMIT ?`, ...args, integer(limit, 1, 200))).map(row => ({ ...row, alarm: Boolean(row.alarm), details:row.details ? parse(row.details):null }))
    const snapshots = (await this.all(`SELECT * FROM upstream_balance_snapshots WHERE ${clauses.join(' AND ')} ORDER BY observed_at DESC LIMIT ?`, ...args, integer(limit, 1, 200)))
    return { items: rows, snapshots }
  }
  // 终态回来时补全同一条留档：上游原始返回、用量、成本、失败原因。
  async finishUpstreamCall(generationId, { response = null, usage = null, cost = null, estimatedCredits = null, upstreamRequestId = '', status = 'ok', error = '' }: Record<string, any> = {}) {
    const row = (await this.get('SELECT id,status FROM upstream_calls WHERE generation_id=? ORDER BY created_at DESC LIMIT 1', generationId))
    if (row && ['ok','succeeded','failed_after_submit','cancelled_after_submit'].includes(row.status) && ['submitted','submission_unknown'].includes(status)) return row.id
    if (!row) {
      const g = (await this.get('SELECT * FROM generations WHERE id=?', generationId))
      if (!g) return null
      const parameters = parse(g.parameters)
      const model = modelById(g.model)
      await this.recordUpstreamCall({ generationId, provider:g.provider || model?.provider, model:g.model,
        kind:model?.video ? 'video':'image', tier:parameters.resolution || parameters.size || '',
        seconds:model?.video ? parameters.billableDuration ?? parameters.duration : null,
        hasInputVideo:Number(parameters.videoSeconds)>0, request:{ recoveredSummary:true, parameters:redactReferencePayload(parameters) },
        response, usage, cost, estimatedCredits, upstreamRequestId, status, error })
      return (await this.get('SELECT id FROM upstream_calls WHERE generation_id=? ORDER BY created_at DESC LIMIT 1', generationId))?.id || null
    }
    await this.run(`UPDATE upstream_calls SET response=COALESCE(?,response), usage=COALESCE(?,usage),
      cost_rmb=COALESCE(?,cost_rmb), cost_basis=COALESCE(?,cost_basis), cost_detail=COALESCE(?,cost_detail), updated_at=?, estimated_credits=COALESCE(?,estimated_credits), upstream_request_id=COALESCE(NULLIF(?,''),upstream_request_id), status=?, error=? WHERE id=?`,
    response == null ? null : auditJson(response, 40000),
    usage == null ? null : auditJson(usage, 4000),
    finiteCost(cost?.rmb), cost?.basis ? String(cost.basis).slice(0, 200) : null,
    cost ? auditJson(cost, 12000) : null, new Date().toISOString(),
    estimatedCredits != null && Number.isFinite(Number(estimatedCredits)) ? Number(estimatedCredits) : null, String(upstreamRequestId || '').slice(0, 200),
    String(status || 'ok').slice(0, 40), String(error || '').slice(0, 500), row.id)
    return row.id
  }
  async upstreamCalls({ search = '', status = '', provider = '', model = '', tier = '', limit = 50, page = 1 }: Record<string, any> = {}) {
    const clauses = ['1=1']; const args = []
    if(search){clauses.push('(model LIKE ? OR provider LIKE ? OR generation_id LIKE ? OR upstream_request_id LIKE ? OR error LIKE ?)');args.push(...Array(5).fill(`%${String(search).slice(0,100)}%`))}
    if(status){clauses.push('status=?');args.push(String(status).slice(0,40))}
    if (provider) { clauses.push('provider=?'); args.push(String(provider).slice(0, 40)) }
    if (model) { clauses.push('model=?'); args.push(String(model).slice(0, 80)) }
    if (tier) { clauses.push('tier=?'); args.push(String(tier).slice(0, 40)) }
    const where = clauses.join(' AND ')
    const total = Number((await this.get(`SELECT COUNT(*) n FROM upstream_calls WHERE ${where}`, ...args)).n)
    const size = integer(limit, 1, 200), current = integer(page, 1, 100000)
    const items = (await this.all(`SELECT upstream_calls.*, (SELECT request_id FROM generations WHERE id=upstream_calls.generation_id) generationRequestId, (SELECT upstream_cost FROM generations WHERE id=upstream_calls.generation_id) generationCost FROM upstream_calls WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, ...args, size, (current - 1) * size))
      .map(row => {
        const { generationCost, ...item }=row
        const candidate=generationCost ? parse(generationCost) : null
        const cost=row.cost_detail ? parse(row.cost_detail) : candidate?.rmb === row.cost_rmb && candidate?.basis === row.cost_basis ? candidate : row.cost_rmb == null ? null : {rmb:row.cost_rmb,basis:row.cost_basis,detail:null}
        return {...item,cost,costEvidence:costEvidence(cost),request:parse(row.request || '{}'),response:row.response ? parse(row.response):null,usage:row.usage ? parse(row.usage):null}
      })
    return { items, total, page: current, limit: size }
  }
  // 按「上游 × 模型 × 档位」汇总，直接给出可用来定价的推算值。
  async derivedUpstreamPrices({ provider = '', model = '' }: Record<string, any> = {}) {
    const clauses = ['1=1']; const args = []
    if (provider) { clauses.push('provider=?'); args.push(String(provider).slice(0, 40)) }
    if (model) { clauses.push('model=?'); args.push(String(model).slice(0, 80)) }
    const rows = (await this.all(`SELECT provider, model, tier, has_input_video,
        COUNT(*) calls,
        SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) okCalls,
        SUM(CASE WHEN credits_delta>0 AND seconds>0 AND status IN ('ok','succeeded') THEN 1 ELSE 0 END) samplesWithCredits,
        SUM(CASE WHEN usage IS NOT NULL THEN 1 ELSE 0 END) samplesWithUsage,
        COALESCE(SUM(CASE WHEN credits_delta>0 AND seconds>0 AND status IN ('ok','succeeded') THEN credits_delta ELSE 0 END),0) creditsTotal,
        COALESCE(SUM(CASE WHEN credits_delta>0 AND seconds>0 AND status IN ('ok','succeeded') THEN seconds ELSE 0 END),0) secondsTotal,
        COALESCE(SUM(CASE WHEN credits_delta>0 AND seconds>0 AND status IN ('ok','succeeded') THEN credits_delta ELSE 0 END),0) creditsForSeconds,
        SUM(CASE WHEN cost_rmb IS NOT NULL AND status IN ('ok','succeeded') THEN 1 ELSE 0 END) samplesWithCost,
        AVG(CASE WHEN status IN ('ok','succeeded') THEN cost_rmb END) avgCost,
        MAX(created_at) lastSeen
      FROM upstream_calls WHERE ${clauses.join(' AND ')} GROUP BY provider, model, tier, has_input_video ORDER BY provider, model, tier, has_input_video`, ...args))
    return rows.map(row => ({
      ...row,
      // 仅匹配同一次调用的余额差与正时长；共享账户的余额变化仍不是逐单账单。
      derivedCreditsPerSecond: Number(row.samplesWithCredits) > 0 && Number(row.secondsTotal) > 0 && Number(row.creditsTotal) !== 0
        ? Math.round(Number(row.creditsForSeconds) / Number(row.secondsTotal) * 1000) / 1000
        : null,
      note: Number(row.samplesWithCredits) > 0 && Number(row.creditsTotal) === 0
        ? '有余额差样本，但余额差合计为 0，未形成推算单价'
        : Number(row.samplesWithCredits) > 0 && Number(row.secondsTotal) > 0
          ? '按同次调用的余额差和时长推算；共享账户其他调用可能影响余额'
          : Number(row.samplesWithUsage) > 0
            ? '只有上游用量，没有余额差样本'
            : '样本不足',
    }))
  }
  artifactTtlMs() {
    const raw = Number(process.env.OIP_ARTIFACT_TTL_SECONDS || 7 * 24 * 60 * 60)
    return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 7 * 24 * 60 * 60 * 1000
  }
  async finish(id, artifacts, metadata: Record<string, any> = {}, workerId = '') {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g=(await this.get('SELECT * FROM generations WHERE id=?',id))
      if (!g || g.status !== GENERATION_STATES.RUNNING) throw failure('生成记录已结算',409)
      if (workerId && g.lease_id !== workerId) throw failure('原任务保存租约已变更', 409)
      assertTransition(g.status, GENERATION_STATES.SUCCEEDED)
      const count = parse(g.parameters).count || 1
      const savedArtifacts = artifacts.slice(0, count)
      const reserved = Number(g.reserved_points || g.points || 0)
      // 积分保留一位小数：按实际张数结算，少生成才退差，不做整数进位。
      // 图片单价保留两位小数（豆包是原价 + 0.15），少生成时按张数比例退还，不向 0.1 取整。
      const precision = g.provider === 'suihe' ? 10000 : 100
      const charged = savedArtifacts.length >= count ? reserved : Math.max(0.01, Math.round(reserved * savedArtifacts.length / count * precision) / precision)
      const refund = Math.round((reserved - charged) * precision) / precision
      if (g.user_id && refund > 0) {
        await this.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?',refund,g.user_id)
        await this.ledger(g.user_id,refund,'未生成张数退还',id)
      }
      if (!savedArtifacts.length) throw failure('上游没有返回可保存的图片', 502)
      const expiresAt = new Date(Date.now() + this.artifactTtlMs()).toISOString()
      const results = (await mapAsync(savedArtifacts, async a => {
        const artifactId = randomUUID()
        // 先落字节、再写两行索引：整个过程在同一个事务里，索引写失败会整体回滚，
        // 磁盘上最坏多一份没人认领的字节，由 media-reconcile 报告并回收。
        // 内容寻址之后这里通常**一个字节都不写**：同一张图在画布上已经有一份时，
        // 算出来的 sha 一样，直接复用那份字节，只多一行引用。
        const placed = (await (await this.artifactFiles()).put(g.user_id || '', artifactId, a.bytes))
        await this.run('INSERT INTO artifacts(id,request_id,mime,bytes,storage,size,blob) VALUES(?,?,?,NULL,?,?,?)', artifactId, id, a.mime, placed.blob ? 'blob' : 'disk', placed.size, placed.blob)
        if (parse(g.parameters).desktopDelivery !== 1) await this.run('INSERT INTO artifact_expiry(artifact_id,expires_at) VALUES(?,?)', artifactId, expiresAt)
        return { id:artifactId, url:`/api/imagine/result/${artifactId}`, mime:a.mime, format:a.mime.split('/')[1] }
      }))
      const parameters = parse(g.parameters)
      const imageCost = estimateUpstreamCostRmb({ model: modelForGeneration(g.model,parameters,g.provider), count: savedArtifacts.length, parameters })
      await this.run("UPDATE generations SET status='succeeded',error=NULL,points=?,charged_points=?,finished_at=?,usage=?,upstream_cost=?,upstream_model=?,upstream_request_id=?,upstream_status=?,lease_id=NULL,lease_at=NULL,expires_at=NULL WHERE id=?",charged,charged,new Date().toISOString(),metadata.usage ? JSON.stringify(metadata.usage) : g.usage,imageCost ? JSON.stringify(imageCost) : g.upstream_cost || null,metadata.upstreamModel || g.upstream_model,metadata.upstreamRequestId || g.upstream_request_id || null,metadata.upstreamStatus ?? g.upstream_status ?? null,id)
      for (const key of ['imageResultPending','imageResultRetry','imageResultExpiredAt','submissionUncertain','submissionDiagnosticId']) delete parameters[key]
      parameters.resultCount = savedArtifacts.length
      if (parameters.desktopDelivery === 1) parameters.desktopExpiresAt = expiresAt
      await this.run('UPDATE generations SET parameters=? WHERE id=?',JSON.stringify(parameters),id)
      await this.finishUpstreamCall(id, {cost:imageCost,usage:metadata.usage || null,response:{images:savedArtifacts.length},upstreamRequestId:metadata.upstreamRequestId || g.upstream_request_id || '',status:'ok'})
      await this.run('DELETE FROM generation_inputs WHERE generation_id=?', id)
      return results
    }))
  }
  async completeVideo(id, result: Record<string, any> = {}) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
      if (!g || g.status !== GENERATION_STATES.RUNNING) throw failure('生成记录已结算', 409)
      assertTransition(g.status, GENERATION_STATES.SUCCEEDED)
      const url = String(result.url || '').trim()
      const videoId = String(result.id || '').trim()
      if (!url || !videoId) throw failure('上游没有返回可展示的视频', 502)
      const now = new Date().toISOString()
      const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {}
      await this.run('INSERT INTO video_results(generation_id,video_id,video_url,mime,duration,width,height,thumbnail_url,metadata,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, videoId, url, String(result.mime || 'video/mp4').slice(0, 100), result.duration == null ? null : Number(result.duration), result.width == null ? null : Number(result.width), result.height == null ? null : Number(result.height), String(result.thumbnailUrl || '').slice(0, 2000), JSON.stringify(metadata), now)
      const reserved = Number(g.reserved_points || g.points || 0)
      // 火山 Seedance 的真实账单由任务查询返回的 usage.completion_tokens（同值的
      // total_tokens 也保留）决定，
      // 而不是只按秒数估算。创建时已经用参数预扣了安全上限；成功后只把
      // 实际 usage 对应的较低金额退回，避免把上游 token 用量错误地吞掉。
      const parameters = parse(g.parameters)
      const model = modelForGeneration(g.model,parameters,g.provider)
      const hasOutputDuration = Number.isFinite(Number(result.duration)) && Number(result.duration) > 0
      const settleTariffDuration = parameters.videoPricing?.version === VIDEO_PRICING_VERSION
        && model?.provider === 'grok' && hasOutputDuration
      const usageCost = model?.video && (result.usage || (hasOutputDuration && (parameters.manualVideoCreditsPerSecond != null || settleTariffDuration)))
        ? estimateGenerationCost({ model, generation: { ...parameters, ...(isCostPlusVideo(g.model) && result.duration != null ? { billableDuration: Number(result.duration) } : {}), usage: result.usage } })
        : null
      // 预扣是上限。若上游账单意外高于预扣，保留预扣金额并记录原始 usage，
      // 不在任务已经成功后再让用户余额出现负数；下一次预扣仍会按安全参数上限执行。
      const canSettleManualDuration = usageCost && parameters.manualVideoCreditsPerSecond != null && Number(result.duration) > 0
      const charged = usageCost?.usageBased || canSettleManualDuration || (usageCost && settleTariffDuration) ? Math.min(reserved, Number(usageCost.points)) : reserved
      const settlementPrecision=model?.provider==='suihe' || parameters.videoPricing?.version===VIDEO_PRICING_VERSION ? 10000 : 100
      const refund = Math.round((reserved - charged) * settlementPrecision) / settlementPrecision
      if (g.user_id && refund > 0) {
        await this.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?', refund, g.user_id)
        await this.ledger(g.user_id, refund, '视频实际用量对账退还', id)
      }
      const cost = estimateUpstreamCostRmb({ model, parameters, usage: result.usage, seconds: result.duration == null ? parameters.billableDuration ?? parameters.duration : Number(result.duration) })
      if (cost && isCostPlusVideo(g.model)) {
        const precision=model?.provider==='suihe' || parameters.videoPricing?.version===VIDEO_PRICING_VERSION ?10000:100
        cost.detail = { ...cost.detail, pricing: { reservedPoints:reserved, requiredPoints:usageCost?.points ?? reserved, chargedPoints:charged, shortfallPoints:Math.max(0,Math.round(((usageCost?.points??reserved)-charged)*precision)/precision), markupPerSecond:model?.provider==='suihe'?parameters.suiheCost?.customerMarkupRmbPerUnit:parameters.videoPricing?.markupPerSecond ?? (await this.settings()).videoPricing.markupPerSecond, policyVersion:model?.provider==='suihe'?parameters.suiheCost?.version:parameters.videoPricing?.version || null, expenseConfigured:Boolean(cost.detail.expenses?.configured), paymentFeeRmb:charged*(cost.detail.expenses?.paymentFeePercent||0)/100, allocatedExpenseRmb:(cost.detail.expenses?.rmbPerRequest||0)+(cost.detail.outputSeconds||0)*(cost.detail.expenses?.rmbPerOutputSecond||0), estimatedNetRmb:cost.detail.expenses?.configured ? Math.round((charged*(1-cost.detail.expenses.paymentFeePercent/100)-cost.rmb-(cost.detail.expenses.rmbPerRequest||0)-cost.detail.outputSeconds*cost.detail.expenses.rmbPerOutputSecond)*10000)/10000 : null } }
      }
      await this.run("UPDATE generations SET status='succeeded',points=?,charged_points=?,finished_at=?,usage=?,upstream_cost=?,upstream_model=?,upstream_request_id=?,upstream_status=?,lease_id=NULL,lease_at=NULL,expires_at=NULL WHERE id=?", charged, charged, now, result.usage ? JSON.stringify(result.usage) : g.usage, cost ? JSON.stringify(cost) : g.upstream_cost || null, result.upstreamModel || g.upstream_model, result.upstreamRequestId || videoId, result.upstreamStatus ?? g.upstream_status ?? null, id)
      if (parameters.desktopDelivery === 1) {
        parameters.desktopExpiresAt = new Date(Date.now() + this.artifactTtlMs()).toISOString()
        await this.run('UPDATE generations SET parameters=? WHERE id=?',JSON.stringify(parameters),id)
      }
      await this.finishUpstreamCall(id, {cost,usage:result.usage || null,response:result.metadata?.raw || null,estimatedCredits:cost?.detail?.supplierCredits ?? null,upstreamRequestId:result.upstreamRequestId || videoId,status:'ok'})
      await this.run('DELETE FROM generation_inputs WHERE generation_id=?', id)
      return (await this.videoResult(id))
    }))
  }
  async setVideoWorkspacePath(generationId, path) {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',generationId)
      const generation = (await this.get('SELECT parameters FROM generations WHERE id=?', generationId))
      if (!generation) return null
      const delivery = parse(generation?.parameters)
      if (delivery.desktopDeliveredAt || delivery.desktopMediaExpiredAt) throw failure('服务器临时文件已清理，请打开本机保存的结果', 410)
      const row = (await this.get('SELECT metadata FROM video_results WHERE generation_id=?', generationId))
      if (!row) return null
      let metadata: Record<string, any> = {}
      try { metadata = JSON.parse(row.metadata || '{}') } catch { metadata = {} }
      metadata.workspacePath = String(path || '')
      await this.run('UPDATE video_results SET metadata=? WHERE generation_id=?', JSON.stringify(metadata), generationId)
      return metadata
    }))
  }
  async refundGeneration(g, reason) {
    const reserved = Number(g.reserved_points || g.points || 0)
    if (g.user_id && reserved) { await this.run('UPDATE users SET points=ROUND(points+?,4) WHERE id=?',reserved,g.user_id); await this.ledger(g.user_id,reserved,reason,g.id) }
  }
  async markSubmissionUncertain(id, message, metadata: Record<string, any> = {}, workerId = '') {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      if (workerId && (await this.get('SELECT lease_id FROM generations WHERE id=?', id))?.lease_id !== workerId) return
      return (await this.setSubmissionUncertain(id, message, metadata))
    }))
  }
  async setSubmissionUncertain(id, message, metadata: Record<string, any> = {}) {
    const g = (await this.get('SELECT * FROM generations WHERE id=?', id))
    if (!g || g.status !== GENERATION_STATES.RUNNING) return
    const parameters = { ...parse(g.parameters) }
    const accepted = acceptedVideoSubmissionRecovery(metadata, Boolean(modelById(g.model)?.video || g.provider==='suihe'), g.upstream_request_id)
    if (accepted) {
      // The original POST already returned this exact ID. Reattach it in the
      // existing review transaction so the normal collector can only poll it.
      delete parameters.submissionUncertain
      delete parameters.submissionDiagnosticId
      await this.run('UPDATE generations SET parameters=?,error=NULL,upstream_request_id=?,upstream_model=?,upstream_status=?,lease_id=NULL,lease_at=NULL WHERE id=?',
        JSON.stringify(parameters), accepted.requestId, accepted.model || g.upstream_model, accepted.status, id)
      return
    }
    parameters.submissionUncertain = true
    // Diagnostic request IDs are not necessarily pollable task IDs.
    if (metadata.upstreamRequestId) parameters.submissionDiagnosticId = String(metadata.upstreamRequestId).slice(0, 200)
    await this.run("UPDATE generations SET parameters=?,error=?,lease_id=NULL,lease_at=NULL WHERE id=?", JSON.stringify(parameters), `提交结果待确认；不会自动重复生成。${message || ''}`.slice(0, 500), id)
    await this.run("UPDATE upstream_calls SET status='submission_unknown' WHERE generation_id=? AND status IN ('failed','submitted')", id)
  }
  async fail(id, message, metadata: Record<string, any> = {}, workerId = '') {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','id',id)
      const g=(await this.get('SELECT * FROM generations WHERE id=?',id)); if (!g || ![GENERATION_STATES.RUNNING, GENERATION_STATES.QUEUED].includes(g.status)) return
      if (workerId && g.lease_id !== workerId) return
      await this.settleFailure(g, message, metadata)
    }))
  }
  async settleFailure(g, message, metadata: Record<string, any> = {}) {
      const id = g.id
      assertTransition(g.status, GENERATION_STATES.FAILED)
      await this.refundGeneration(g, '生成失败退还')
      await this.run("UPDATE upstream_calls SET status='failed_after_submit', error=COALESCE(NULLIF(error,''),?) WHERE generation_id=? AND status='submitted'", String(message).slice(0, 500), id)
      await this.run("UPDATE generations SET status='failed',error=?,points=0,charged_points=0,finished_at=?,usage=?,upstream_model=?,upstream_request_id=?,upstream_status=?,lease_id=NULL,lease_at=NULL,expires_at=NULL WHERE id=?",String(message).slice(0,500),new Date().toISOString(),metadata.usage ? JSON.stringify(metadata.usage) : g.usage,metadata.upstreamModel || g.upstream_model,metadata.upstreamRequestId || g.upstream_request_id || null,metadata.upstreamStatus ?? g.upstream_status ?? null,id)
      await this.run('DELETE FROM generation_inputs WHERE generation_id=?', id)
  }
  async cancel(requestId, session, accessToken = '') {
    return (await this.transaction(async () => {
      await this.db.lockRow('generations','request_id',requestId)
      const g = (await this.get('SELECT * FROM generations WHERE request_id=?', requestId))
      if (!g) return null
      if (!this.canView(g, session, accessToken)) throw failure('无权取消这次生成',403)
      if (![GENERATION_STATES.QUEUED, GENERATION_STATES.RUNNING].includes(g.status)) return (await this.publicGeneration(g, accessToken))
      assertTransition(g.status, GENERATION_STATES.CANCELLED)
      // 计费规则（用户口径）：请求已经真实发到上游（任务已在跑）后再取消不退积分；
      // 只有还在排队、尚未发出请求的取消才全额退回。
      const refundable = canRefundMediaCancellation(g.status, parse(g.parameters).submissionState, g.upstream_request_id)
      const reserved = Number(g.reserved_points || g.points || 0)
      if (refundable) await this.refundGeneration(g, g.status === GENERATION_STATES.QUEUED ? '排队取消退还' : '生成取消退还')
      if (!refundable) await this.run("UPDATE upstream_calls SET status='cancelled_after_submit', error=COALESCE(NULLIF(error,''),'本地取消；上游任务已提交，可能已产生费用') WHERE generation_id=? AND status='submitted'", g.id)
      const charged = refundable ? 0 : reserved
      await this.run("UPDATE generations SET status='cancelled',cancel_requested=1,points=?,charged_points=?,finished_at=?,expires_at=NULL WHERE id=?",charged,charged,new Date().toISOString(),g.id)
      await this.run('DELETE FROM generation_inputs WHERE generation_id=?', g.id)
      return (await this.publicGeneration((await this.get('SELECT * FROM generations WHERE id=?', g.id)), accessToken))
    }))
  }
  async expireQueued(id?: string, now = new Date().toISOString()) {
    for (const candidate of await this.all(`SELECT id FROM generations WHERE status='queued' AND expires_at IS NOT NULL AND expires_at<?${id ? ' AND id=?' : ''} ORDER BY id`, now, ...(id ? [id] : []))) {
      await this.transaction(async () => {
        await this.db.lockRow('generations','id',candidate.id)
        const g = await this.get("SELECT * FROM generations WHERE id=? AND status='queued' AND expires_at<?", candidate.id, now)
        if (!g) return
        await this.refundGeneration(g, '排队超时退还')
        await this.run("UPDATE generations SET status='expired',error=?,points=0,charged_points=0,finished_at=?,expires_at=NULL WHERE id=? AND status='queued'", '排队等待超时，请重新提交', now, g.id)
        await this.run('DELETE FROM generation_inputs WHERE generation_id=?',g.id)
      })
    }
  }
  async recoverStale() {
    // 过期清理：先删索引行（同一个事务里 artifact_expiry 会级联删掉），**再**处理字节。
    // 字节必须在事务提交之后才动：事务一旦回滚，引用还在、字节没了就是不可恢复的数据丢失。
    const expired = (await this.all(`SELECT a.id AS id,a.blob AS blob,g.user_id AS user_id
      FROM artifact_expiry e JOIN artifacts a ON a.id=e.artifact_id
      LEFT JOIN generations g ON g.id=a.request_id WHERE e.expires_at<=?`, new Date().toISOString()))
    const result = (await this.transaction(async () => {
      if (expired.length) await this.run('DELETE FROM artifacts WHERE id IN (SELECT artifact_id FROM artifact_expiry WHERE expires_at<=?)', new Date().toISOString())
      await this.expireQueued()
      const leaseCutoff = new Date(Date.now() - GENERATION_LIMITS.leaseMs).toISOString()
      for (const candidate of (await this.all("SELECT id FROM generations WHERE status='running' ORDER BY id"))) {
        await this.db.lockRow('generations','id',candidate.id)
        const g = await this.get("SELECT * FROM generations WHERE id=? AND status='running'",candidate.id)
        if (!g) continue
        // A live worker or accepted upstream task has no model wait budget.
        if (g.lease_id && g.lease_at >= leaseCutoff) continue
        if (g.upstream_request_id && (modelById(g.model)?.video || g.provider==='suihe')) continue
        if (parse(g.parameters).submissionUncertain || parse(g.parameters).imageResultPending) continue
        // A worker crash during POST cannot prove the provider rejected it.
        await this.setSubmissionUncertain(g.id, '本地执行连接中断，等待核对原请求')
      }
      await this.run("UPDATE generations SET lease_id=NULL,lease_at=NULL WHERE status NOT IN ('queued','running') AND lease_at<?", leaseCutoff)
    }))
    // 删掉的只是引用。画布上那份素材还引用着同一份字节时，blob-store 不会回收它——
    // 「历史过期了，但画布上那张图还得能用」。最后一个引用也没了才真正回收。
    // 删不掉只记日志，交给 media-reconcile 回收，不阻塞清理。
    for (const row of expired) {
      try { await (await this.artifactFiles()).release(row, row.user_id || '') } catch (error) {
        console.warn(`[artifacts] 回收过期结果的字节失败，留给对账回收：id=${row.id} ${error?.message || error}`)
      }
    }
    return result
  }
  async artifact(id, session, accessToken = '') { const a=(await this.get('SELECT a.id,a.mime,a.bytes,a.storage,a.size,a.blob,e.expires_at,g.user_id,g.actor,g.owner_scope,g.viewer_token_hash FROM artifacts a LEFT JOIN artifact_expiry e ON e.artifact_id=a.id JOIN generations g ON g.id=a.request_id WHERE a.id=?',id)); if (!a) return null; if (a.expires_at && Date.parse(a.expires_at) <= Date.now()) return null; if (!this.canView(a, session, accessToken)) throw failure('无权查看这张图片',403); const mime = supportedImageMime(a.mime); if (!mime) return null; const location = (await (await this.artifactFiles()).locate(a, a.user_id || '')); if (!location) return null; const bytes = location.bytes || null; return { id: a.id, ownerId: a.user_id || '', bytes, diskPath: location.diskPath || '', size: location.size, mime } }
  async records({ requestId = '', search = '', status = '', model = '', provider = '', upstreamRequestId = '', page = 1, userId, limit = 30, active = '', kind = '', from = '', to = '', summaryFrom = '', summaryTo = '', view = '' }: Record<string, any> = {}, admin = true) {
    page=integer(page,1,100000); limit=integer(limit,1,100)
    const clauses=['1=1'],args=[]
    if(search){clauses.push('(g.actor LIKE ? OR g.model LIKE ? OR g.provider LIKE ? OR g.request_id LIKE ? OR g.upstream_request_id LIKE ? OR g.prompt LIKE ?)'); args.push(...Array(6).fill(`%${String(search).slice(0,100)}%`))}
    if(requestId){clauses.push('g.request_id=?');args.push(String(requestId))}
    if(from){clauses.push('g.created_at>=?');args.push(String(from).slice(0,40))}
    if(to){clauses.push('g.created_at<?');args.push(String(to).slice(0,40))}
    if(status){clauses.push('g.status=?');args.push(status)}
    if (active === 'true') clauses.push("g.status IN ('queued','running')")
    if(model){clauses.push('g.model=?');args.push(publicModelId(model) || String(model))}
    if(provider){clauses.push('g.provider=?');args.push(String(provider).slice(0,40))}
    if(upstreamRequestId){clauses.push('g.upstream_request_id=?');args.push(String(upstreamRequestId).slice(0,200))}
    if(userId){clauses.push('g.user_id=?');args.push(userId)}
    const videoModels = modelCatalog().filter((model: any) => model.video).flatMap(model => [model.id, model.publicId].filter(Boolean))
    const videoClause = `(g.model IN (${videoModels.map(() => '?').join(',')}) OR EXISTS (SELECT 1 FROM video_results v WHERE v.generation_id=g.id))`
    if(kind==='video'){clauses.push(videoClause);args.push(...videoModels)}
    else if(kind==='image'){clauses.push(`NOT ${videoClause}`);args.push(...videoModels)}
    const where=clauses.join(' AND ')
    const total=(await this.get(`SELECT COUNT(*) n FROM generations g WHERE ${where}`,...args)).n
    // 区间小结（本月生成次数）。区间由客户端给：月初/月末按用户本地时区算，服务端不猜。
    const rangeClauses=[...clauses], rangeArgs=[...args]
    const summaryStart = summaryFrom
    const summaryEnd = summaryTo
    if(summaryStart){rangeClauses.push('g.created_at>=?');rangeArgs.push(String(summaryStart))}
    if(summaryEnd){rangeClauses.push('g.created_at<?');rangeArgs.push(String(summaryEnd))}
    const summary=summaryStart||summaryEnd?(await this.get(`SELECT COUNT(*) runs FROM generations g WHERE ${rangeClauses.join(' AND ')}`,...rangeArgs)):null
    const items=(await mapAsync((await this.all(`SELECT g.* FROM generations g WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,...args,limit,(page-1)*limit)), async g => {
      const publicRow = (await this.publicGeneration(g))
      // Existing history fields remain as compatibility aliases. New operational
      // fields are projected only by the authenticated admin endpoint.
      const record = { ...publicRow, created_at:g.created_at, finished_at:g.finished_at }
      if (!admin) {
        record.prompt = historyPrompt(record.prompt, record.parameters.referenceHistory)
        const video = record.video ? { ...record.video } : null
        // Use the authenticated media endpoint: it streams the stored original first.
        // Opening workspace files directly would apply the uploaded-document CSP.
        if (video && (!record.delivery || record.delivery.status === 'pending')) video.url = `/api/imagine/video-content?requestId=${encodeURIComponent(record.requestId)}`
        if (view !== 'list') return { ...record, kind: modelById(g.model)?.video || video ? 'video' : 'image', video }
        // The card needs status, price and media links, not signed references or provider metadata.
        return {
          requestId: record.requestId, status: record.status, model: record.model, modelLabel: record.modelLabel, delivery: record.delivery, resultCount: record.resultCount,
          kind: modelById(g.model)?.video || video ? 'video' : 'image',
          points: record.points, reservedPoints: record.reservedPoints, chargedPoints: record.chargedPoints,
          prompt: record.prompt.slice(0, 300), created_at: g.created_at, createdAt: g.created_at,
          startedAt: record.startedAt, finishedAt: record.finishedAt, finished_at: g.finished_at,
          error: record.error, submissionUncertain: record.submissionUncertain,
          images: record.images, video: video ? { url: video.url, thumbnailUrl: video.thumbnailUrl,
            mime: video.mime, duration: video.duration, width: video.width, height: video.height } : null,
        }
      }
      const upstreamCost=(await this.recordedGenerationCost(g))
      const internalVideo = (await this.videoResult(g.id))
      return {
        ...record,
        // The database generation ID and user ID are operational fields. Keep
        // them on the authenticated admin projection only; the user history
        // endpoint must expose the stable public request ID instead.
        id:g.id,
        error:g.error || '',
        parameters:redactReferencePayload(parse(g.parameters)),
        video:internalVideo ? {...internalVideo, url: undefined, thumbnailUrl: undefined, metadata:redactReferencePayload(internalVideo.metadata)} : null,
        user_id:g.user_id,
        actor:g.actor,
        request_id:g.request_id,
        provider:g.provider || '',
        upstreamModel:g.upstream_model || '',
        upstreamRequestId:g.upstream_request_id || '',
        upstream_status:g.upstream_status,
        upstreamCost,costEvidence:costEvidence(upstreamCost),
        // 管理端参考差额：实扣积分按 1:1 折元，减已留档的价目/实测单价推算成本。
        // 不是支付收入或上游账单毛利；赠送积分、缺成本与文本成本会影响解释。
        marginRmb: finiteCost(upstreamCost?.rmb)!==null ? Math.round((Number(g.charged_points || 0)*Number(process.env.ZPAY_POINT_PRICE_CENTS || 100)/100-Number(upstreamCost.rmb))*10000)/10000 : null,
      }
    }))
    return {items,total,page,limit,...(summary?{summary}:{})}
  }
  async recordedGenerationCost(g) {
    const saved=g.upstream_cost ? parse(g.upstream_cost) : null
    if (finiteCost(saved?.rmb)!==null) return saved
    if (g.status!=='succeeded') return null
    const call=(await this.get("SELECT cost_detail,cost_rmb,cost_basis FROM upstream_calls WHERE generation_id=? AND status IN ('ok','succeeded') AND cost_rmb IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1",g.id))
    return call ? call.cost_detail ? parse(call.cost_detail) : {rmb:call.cost_rmb,basis:call.cost_basis,detail:null} : null
  }
  async reconciliation(filters: Record<string, any> = {}) {
    const records = (await this.records(filters, true))
    const summary = (await this.get("SELECT COUNT(*) requests, COALESCE(SUM(CASE WHEN provider IS NOT NULL AND provider<>'' THEN 1 ELSE 0 END),0) providerRows, COALESCE(SUM(CASE WHEN upstream_request_id IS NOT NULL AND upstream_request_id<>'' THEN 1 ELSE 0 END),0) linkedRows, COALESCE(SUM(CASE WHEN usage IS NOT NULL AND usage<>'' THEN 1 ELSE 0 END),0) usageRows, COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_points ELSE 0 END),0) chargedPoints FROM generations"))
    const costRow=(await this.get("SELECT COALESCE(SUM(retained_cost),0) upstreamCostRmb, SUM(CASE WHEN retained_cost IS NULL THEN 1 ELSE 0 END) missingCostRows, COALESCE(SUM(charged_points),0) chargedAllPoints, COALESCE(SUM(CASE WHEN retained_cost IS NOT NULL THEN charged_points ELSE 0 END),0) costMatchedPoints FROM "+RETAINED_COST_ROWS))
    return { ...records, reconciliation: { ...summary, unlinkedRows: Number(summary.providerRows) - Number(summary.linkedRows), upstreamCostRmb: Math.round(Number(costRow.upstreamCostRmb) * 10000) / 10000, missingCostRows: Number(costRow.missingCostRows), chargedAllPoints: Math.round(Number(costRow.chargedAllPoints) * 100) / 100, marginRmb: Math.round((Number(costRow.costMatchedPoints) * Number(process.env.ZPAY_POINT_PRICE_CENTS || 100) / 100 - Number(costRow.upstreamCostRmb)) * 10000) / 10000, scope: '全库关联统计不随列表筛选变化；成功实扣单列统计。成本按价目与实测单价推算；差额仅将有成本留档请求的实扣积分按当前充值兑换价折元减同批推算成本，缺成本及文本成本未纳入，并非支付收入或账单毛利。' } }
  }
  async userStats(userId, { from = '', to = '' }: Record<string, any> = {}) {
    if (!(await this.user(userId))) throw failure('用户不存在', 404)
    const clauses = ['user_id=?']; const args = [userId]
    if (from) { clauses.push('created_at>=?'); args.push(String(from).slice(0, 40)) }
    if (to) { clauses.push('created_at<?'); args.push(String(to).slice(0, 40)) }
    const where = clauses.join(' AND ')
    const row = (await this.get(`SELECT COUNT(*) requests,
      COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) succeeded,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed,
      COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) running,
      COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) queued,
      COALESCE(SUM(CASE WHEN status IN ('cancelled','expired') THEN 1 ELSE 0 END),0) cancelled,
      COALESCE(SUM(charged_points),0) pointsConsumed
      FROM generations WHERE ${where}`, ...args))
    return { userId, from: from || null, to: to || null, ...row, scope: '仅该登录用户；不含管理员和访客请求' }
  }
  async overview() {
    await this.recoverStale()
    const stats = (await this.get("SELECT COUNT(*) requests, COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) succeeded,COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) failed,COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) queued,COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) running,COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) cancelled,COALESCE(SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END),0) expired,COALESCE(SUM(charged_points),0) points,COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_points ELSE 0 END),0) succeededPoints FROM generations"))
    // 成本与毛利：每单成本落在 generations.upstream_cost（图片与视频都写），
    // 参考差额只包含有数值成本的同批请求，按当前充值兑换价折元，并非账单毛利。
    // 缺成本请求单列且不进入差额；文本成本也未纳入。
    const money=(await this.get("SELECT COALESCE(SUM(retained_cost),0) cost, COALESCE(SUM(CASE WHEN retained_cost IS NOT NULL THEN charged_points ELSE 0 END),0) matchedPoints, SUM(CASE WHEN retained_cost IS NOT NULL THEN 1 ELSE 0 END) matchedRows, SUM(CASE WHEN retained_cost IS NULL AND status='succeeded' THEN 1 ELSE 0 END) missing FROM "+RETAINED_COST_ROWS))
    // 成片存储 = 图片 artifact 的实际字节 + 工作区文件（成片/素材现在存在工作区，含磁盘存储的 size）。
    const artifactBytes = Number((await this.get('SELECT COALESCE(SUM(COALESCE(size,length(bytes))),0) n FROM artifacts')).n)
    let fileBytes = 0
    try { fileBytes = Number((await this.get('SELECT COALESCE(SUM(COALESCE(size, length(bytes))),0) n FROM workspace_files')).n) } catch { fileBytes = 0 }
    const cost = Math.round(Number(money.cost) * 10000) / 10000
    const charged = Math.round(Number(stats.points) * 100) / 100
    const balanceAudit = (await this.balanceAudit())
    const holds=(await this.get("SELECT COALESCE(SUM(reserved_points),0) points FROM generations WHERE user_id IS NOT NULL AND status IN ('queued','running')"))
    const shortfalls=(await this.get("SELECT COUNT(*) rows,COALESCE(SUM(json_extract(upstream_cost,'$.detail.pricing.shortfallPoints')),0) points FROM generations WHERE status='succeeded' AND json_valid(upstream_cost) AND json_extract(upstream_cost,'$.detail.pricing.shortfallPoints')>0"))
    return {
      users: (await this.get('SELECT COUNT(*) n FROM users')).n,
      activeUsers: (await this.get("SELECT COUNT(*) n FROM users WHERE status='active'")).n,
      disabledUsers: (await this.get("SELECT COUNT(*) n FROM users WHERE status='disabled'")).n,
      emailVerifiedUsers: (await this.get("SELECT COUNT(*) n FROM users WHERE email_verified=1")).n,
      ...stats,
      upstreamCostRmb: cost,
      ledgerConsumedPoints: (await this.generationCreditSummary()).spent,
      reservedUserPoints: Math.round(Number(holds.points)*100)/100,
      textCharges: (await this.textChargeSummary()),
      shortfallRows: Number(shortfalls.rows),
      shortfallPoints: Math.round(Number(shortfalls.points)*100)/100,
      chargedPointsRmb: charged,
      succeededChargedPointsRmb: Math.round(Number(stats.succeededPoints || 0) * 100) / 100,
      marginRmb: Math.round((Number(money.matchedPoints) * Number(process.env.ZPAY_POINT_PRICE_CENTS || 100) / 100 - cost) * 10000) / 10000,
      costMatchedRows: Number(money.matchedRows),
      costMatchedPoints: Number(money.matchedPoints),
      pointPriceRmb: Number(process.env.ZPAY_POINT_PRICE_CENTS || 100) / 100,
      missingCostRows: Number(money.missing),
      daily: (await this.all("SELECT substr(created_at,1,10) date,COUNT(*) requests,COALESCE(SUM(charged_points),0) points FROM generations WHERE created_at>=? GROUP BY date ORDER BY date", new Date(Date.now() - 7 * 86400000).toISOString())),
      storageBytes: artifactBytes + fileBytes,
      artifactBytes,
      workspaceBytes: fileBytes,
      balanceAudit,
    }
  }
  async audits({ search = '', page = 1, limit = 30 }: Record<string, any> = {}) {
    const where = search ? '(a.actor LIKE ? OR a.action LIKE ? OR a.target LIKE ? OR u.name LIKE ? OR u.email LIKE ?)' : '1=1'
    const args = search ? Array(5).fill(`%${String(search).slice(0,100)}%`) : []
    const total = (await this.get(`SELECT COUNT(*) n FROM audit a LEFT JOIN users u ON u.id=a.target WHERE ${where}`, ...args)).n
    const current=integer(page,1,100000), size=integer(limit,1,200)
    const items=(await this.all(`SELECT a.*,u.name targetName,u.email targetEmail FROM audit a LEFT JOIN users u ON u.id=a.target WHERE ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,...args,size,(current-1)*size)).map(r=>({...r,details:redactReferencePayload(parse(r.details))}))
    return {items,total,page:current,limit:size}
  }
  async generationCreditSummary({ userId = '', from = '', to = '' }: Record<string, any> = {}) {
    const clauses=["reason='生成预扣'",'delta<0','request_id IS NOT NULL'],args=[]
    if (userId) { clauses.push('user_id=?'); args.push(userId) }
    if (from) { clauses.push('created_at>=?'); args.push(String(from)) }
    if (to) { clauses.push('created_at<?'); args.push(String(to)) }
    const row = (await this.get(`WITH reservations AS (
      SELECT user_id,request_id,SUM(-delta) amount FROM ledger
      WHERE ${clauses.join(' AND ')} GROUP BY user_id,request_id
    ), totals AS (
      SELECT r.amount,COALESCE((SELECT SUM(l.delta) FROM ledger l
        WHERE l.user_id=r.user_id AND l.request_id=r.request_id AND l.delta>0
          AND l.payment_order_id IS NULL AND (l.reason LIKE '%退还%' OR l.reason LIKE '%退回%')),0) refund,
        COALESCE((SELECT g.reserved_points FROM generations g
          WHERE g.id=r.request_id AND g.user_id=r.user_id AND g.status IN ('queued','running')),0) held
      FROM reservations r
    ) SELECT COALESCE(SUM(MAX(0,amount-refund-held)),0) spent,
      COALESCE(SUM(held),0) reserved,COALESCE(SUM(refund),0) refunded FROM totals`, ...args))
    return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Math.round(Number(value)*100)/100]))
  }
  async ledgers(userId, { from = '', to = '', page = 1, limit = 200, includeTextCharges = false, textPage = 1 }: Record<string, any> = {}) {
    const current=integer(page,1,100000),size=integer(limit,1,200)
    const total=Number((await this.get('SELECT COUNT(*) n FROM ledger WHERE user_id=?',userId)).n)
    const rows = (await this.all('SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?', userId,size,(current-1)*size))
    const reasonSummary = (await this.all('SELECT reason,COUNT(*) AS rows,COALESCE(SUM(delta),0) AS delta FROM ledger WHERE user_id=? GROUP BY reason ORDER BY rows DESC,reason', userId)).map(row => ({ reason: row.reason, rows: Number(row.rows), delta: Number(row.delta) }))
    // 区间小结按**全量行**算，不受上面 200 条上限影响——客户端拿到的分页数据算出来的数字会偏小，
    // 那种"看起来对其实少了"的数比没有数更糟。
    const clauses = ['user_id=?'], args = [userId]
    if (from) { clauses.push('created_at>=?'); args.push(String(from)) }
    if (to) { clauses.push('created_at<?'); args.push(String(to)) }
    let summary = null
    if (from || to) {
      summary = (await this.get(`SELECT COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) deducted, COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) gained FROM ledger WHERE ${clauses.join(' AND ')}`, ...args))
      // Attribute consumption to reservations made in this period, net of all
      // linked refunds, including later refunds. Keep queued/running holds apart.
      // Read the ledger rather than only generations: old deleted records still
      // have their original debit/refund evidence. Admin adjustments are not usage.
      summary = { ...summary, ...(await this.generationCreditSummary({userId,from,to})), scope: 'period_reservations_net_of_linked_refunds_excluding_active_holds' }
      for (const key of ['spent','reserved','refunded','deducted','gained']) summary[key] = Math.round(Number(summary[key] || 0)*100)/100
    }
    return { rows, summary, reasonSummary, total, page:current, limit:size,
      ...(includeTextCharges ? { textCharges: (await this.pendingTextCharges(userId, { page: textPage, limit: size })) } : {}) }
  }

  static async open<T extends new (...args: any[]) => any>(this: T, ...args: any[]): Promise<InstanceType<T>> {
    const value = new this()
    try { await value.initialize(...args); return value }
    catch (error) { await value.db?.close?.().catch(() => {}); throw error }
  }
}
