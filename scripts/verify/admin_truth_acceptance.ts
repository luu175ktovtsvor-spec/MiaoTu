#!/usr/bin/env node
/*
 * Production /manage truth collector.  This intentionally uses one-shot
 * docker exec over stdin: no script, credential, or database copy is written
 * to the production host.  The database is opened read-only.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const out = resolve(process.env.OIP_VERIFY_OUT || '/Users/cch/.oip-verify/admin-20261007/truth.json')
mkdirSync(dirname(out), { recursive: true })

const remote = `
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

const dbPath = '/app/data/management.sqlite'
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const sql = {}
const add = (name, query, ...args) => { sql[name] = { query, rows: rows(query, ...args) } }

add('overview', \`SELECT
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM users WHERE status='active') AS activeUsers,
  (SELECT COUNT(*) FROM users WHERE status='disabled') AS disabledUsers,
  (SELECT COUNT(*) FROM users WHERE email_verified=1) AS emailVerifiedUsers,
  COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) AS succeeded,
  COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
  COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) AS queued,
  COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) AS running,
  COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
  COALESCE(SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END),0) AS expired,
  COALESCE(SUM(charged_points),0) AS chargedPoints,
  COALESCE(SUM(CASE WHEN upstream_cost IS NOT NULL THEN json_extract(upstream_cost,'$.rmb') ELSE 0 END),0) AS upstreamCostRmb,
  COALESCE(SUM(CASE WHEN upstream_cost IS NULL AND status='succeeded' THEN 1 ELSE 0 END),0) AS missingCostRows,
  COALESCE(SUM(charged_points),0) - COALESCE(SUM(CASE WHEN upstream_cost IS NOT NULL THEN json_extract(upstream_cost,'$.rmb') ELSE 0 END),0) AS marginRmb
  FROM generations\`)
add('balance_rows', \`SELECT u.id,u.name,u.status,u.email_verified,u.points AS stored_points,
  COALESCE(SUM(l.delta),0) AS ledger_points,
  ROUND(u.points-COALESCE(SUM(l.delta),0),4) AS difference
  FROM users u LEFT JOIN ledger l ON l.user_id=u.id
  GROUP BY u.id,u.name,u.status,u.email_verified,u.points ORDER BY u.created_at,u.id\`)
add('users', \`SELECT id,name,email,status,points,email_verified,created_at FROM users ORDER BY created_at DESC,id\`)
add('generations_summary', \`SELECT status,COUNT(*) AS rows,COALESCE(SUM(reserved_points),0) AS reserved_points,
  COALESCE(SUM(charged_points),0) AS charged_points,
  COALESCE(SUM(CASE WHEN upstream_cost IS NOT NULL THEN json_extract(upstream_cost,'$.rmb') ELSE 0 END),0) AS cost_rmb,
  COALESCE(SUM(CASE WHEN upstream_cost IS NULL THEN 1 ELSE 0 END),0) AS missing_cost_rows
  FROM generations GROUP BY status ORDER BY status\`)
add('generations', \`SELECT id,user_id,actor,model,provider,upstream_model,status,points,reserved_points,charged_points,
  upstream_request_id,usage,upstream_cost,created_at,started_at,finished_at FROM generations ORDER BY created_at DESC,id DESC\`)
add('payment_summary', \`SELECT COUNT(*) AS orders,
  COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS paid,
  COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) AS paid_cents,
  COALESCE(SUM(CASE WHEN status='paid' THEN points ELSE 0 END),0) AS paid_points
  FROM payment_orders\`)
add('payment_orders', \`SELECT id,out_trade_no,user_id,package_name,points,amount_cents,status,provider,payment_type,upstream_trade_no,created_at,completed_at FROM payment_orders ORDER BY created_at DESC,id DESC\`)
add('upstream_summary', \`SELECT provider,model,kind,tier,COUNT(*) AS calls,
  SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls,
  SUM(CASE WHEN usage IS NOT NULL THEN 1 ELSE 0 END) AS usage_rows,
  SUM(CASE WHEN credits_delta IS NOT NULL THEN 1 ELSE 0 END) AS credit_delta_rows,
  COALESCE(SUM(cost_rmb),0) AS cost_rmb,
  COALESCE(SUM(credits_delta),0) AS credits_delta,
  COALESCE(SUM(seconds),0) AS seconds FROM upstream_calls GROUP BY provider,model,kind,tier ORDER BY provider,model,kind,tier\`)
add('upstream_calls', \`SELECT id,generation_id,provider,model,kind,tier,seconds,has_input_video,usage,cost_rmb,cost_basis,credits_before,credits_after,credits_delta,status,created_at FROM upstream_calls ORDER BY created_at DESC,id DESC\`)
add('derived_prices', \`SELECT provider,model,tier,COUNT(*) AS calls,
  SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls,
  SUM(CASE WHEN credits_delta IS NOT NULL THEN 1 ELSE 0 END) AS samples_with_credits,
  SUM(CASE WHEN usage IS NOT NULL THEN 1 ELSE 0 END) AS samples_with_usage,
  COALESCE(SUM(credits_delta),0) AS credits_total,COALESCE(SUM(seconds),0) AS seconds_total,
  COALESCE(AVG(cost_rmb),0) AS avg_cost,MAX(created_at) AS last_seen
  FROM upstream_calls GROUP BY provider,model,tier ORDER BY provider,model,tier\`)
add('ledger_summary', \`SELECT COUNT(*) AS rows,COALESCE(SUM(delta),0) AS delta,
  COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) AS gained,
  COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) AS spent FROM ledger\`)
add('schema', \`SELECT name,type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type,name\`)
add('migration_layout', \`SELECT
  (SELECT COUNT(*) FROM workspace_files) AS workspace_rows,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects') AS projects_table,
  (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='media_layout') AS media_layout_table\`)
add('storage_distribution', \`SELECT COALESCE(storage,'unknown') AS storage,COUNT(*) AS rows,
  COALESCE(SUM(COALESCE(size,length(bytes))),0) AS bytes FROM workspace_files GROUP BY storage ORDER BY storage\`)
add('reconciliation', \`SELECT COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN provider IS NOT NULL AND provider<>'' THEN 1 ELSE 0 END),0) AS provider_rows,
  COALESCE(SUM(CASE WHEN upstream_request_id IS NOT NULL AND upstream_request_id<>'' THEN 1 ELSE 0 END),0) AS linked_rows,
  COALESCE(SUM(CASE WHEN usage IS NOT NULL AND usage<>'' THEN 1 ELSE 0 END),0) AS usage_rows,
  COALESCE(SUM(CASE WHEN status='succeeded' THEN charged_points ELSE 0 END),0) AS charged_points,
  COALESCE(SUM(CASE WHEN upstream_cost IS NOT NULL THEN json_extract(upstream_cost,'$.rmb') ELSE 0 END),0) AS upstream_cost_rmb,
  COALESCE(SUM(CASE WHEN upstream_cost IS NULL THEN 1 ELSE 0 END),0) AS missing_cost_rows
  FROM generations\`)

const datasetPath = '/app/.oip/runtime/prompts.db'
const datasetDb = new DatabaseSync(datasetPath, { readOnly: true })
const datasetSql = {
  prompts: { query: 'SELECT COUNT(*) AS n FROM prompts', rows: datasetDb.prepare('SELECT COUNT(*) AS n FROM prompts').all() },
  images: { query: 'SELECT COUNT(*) AS n FROM images', rows: datasetDb.prepare('SELECT COUNT(*) AS n FROM images').all() },
  videos: { query: 'SELECT COUNT(*) AS n FROM videos', rows: datasetDb.prepare('SELECT COUNT(*) AS n FROM videos').all() },
}
datasetDb.close()

const env = {
  textContextWindow: process.env.OIP_TEXT_CONTEXT_WINDOW || '',
  mediaMode: process.env.OIP_MEDIA_MODE || '',
  mediaRoot: process.env.OIP_MEDIA_ROOT || '',
  dbPath,
}
const email = readFileSync('/app/secrets/admin-email','utf8').trim()
const password = readFileSync('/app/secrets/admin-password','utf8').trim()
const base = 'http://127.0.0.1:4184'
const loginResponse = await fetch(base + '/api/admin/login', {
  method: 'POST', headers: { origin: 'https://miaoimg.cn', 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const loginBody = await loginResponse.json()
const cookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0]
const csrf = loginBody.csrf || ''
const api = {}
async function get(path) {
  const response = await fetch(base + path, { headers: { cookie, 'x-csrf-token': csrf, accept: 'application/json' } })
  let body = null
  try { body = await response.json() } catch { body = { text: await response.text() } }
  // Keep the local evidence useful without copying prompts, signed media URLs,
  // payment QR URLs, or other request/response payloads into the report bundle.
  if (path.includes('/upstream-calls')) body = { ...body, items: (body.items || []).map(({ request, response: upstreamResponse, ...item }) => item) }
  if (path.includes('/generations') || path.includes('/reconciliation')) body = { ...body, items: (body.items || []).map(({ prompt, parameters, video, ...item }) => item) }
  if (path.includes('/payment-orders')) body = { ...body, items: (body.items || []).map(({ payurl, payurl2, qrcode, img, ...item }) => item) }
  api[path] = { status: response.status, body }
}
for (const path of [
  '/api/admin/session', '/api/admin/overview', '/api/admin/operations',
  '/api/admin/users?limit=100&page=1', '/api/admin/generations?limit=100&page=1',
  '/api/admin/payment-orders?limit=100&page=1', '/api/admin/upstream-calls?limit=200&page=1',
  '/api/admin/derived-prices', '/api/admin/reconciliation', '/api/admin/audit',
]) await get(path)
const logoutResponse = await fetch(base + '/api/admin/logout', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: 'https://miaoimg.cn', 'content-type': 'application/json' }, body: '{}' })
api.logout = { status: logoutResponse.status }
db.close()
console.log(JSON.stringify({ collectedAt: new Date().toISOString(), loginStatus: loginResponse.status, sql, datasetSql, api, env }, null, 2))
`

// Docker-era collector: it targets a `miaoimg` container, which the native
// mainland host does not have. Refuse an implicit host instead of probing the
// retired US server.
const remoteHost = process.env.MIAO_REMOTE_HOST || ''
if (!remoteHost) throw new Error('旧 Docker 采集脚本：请显式设置 MIAO_REMOTE_HOST，并确认目标机仍运行 miaoimg 容器')
const child = spawn('ssh', [remoteHost, 'docker', 'exec', '-i', 'miaoimg', 'node', '--input-type=module'], { stdio: ['pipe', 'pipe', 'pipe'] })
let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })
child.stdin.end(remote)
const code = await new Promise<number>(resolveExit => child.on('close', resolveExit))
if (code !== 0) throw new Error(`production collector failed (${code}): ${stderr.trim()}`)
let data
try { data = JSON.parse(stdout) } catch (error) { throw new Error(`collector returned invalid JSON: ${error.message}`) }
writeFileSync(out, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
console.log(`wrote ${out}`)
