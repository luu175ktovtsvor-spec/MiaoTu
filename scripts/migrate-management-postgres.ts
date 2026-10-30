import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CloudDatabase } from '../server/cloud-database.ts'

const identifier = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unexpected source database identifier')
  return `"${name}"`
}
const hashFile = async (path: string) => {
  const hash = createHash('sha256')
  for await (const part of createReadStream(path)) hash.update(part)
  return hash.digest('hex')
}
function rowHash(row: Record<string, any>, columns: string[]) {
  const canonical = columns.map(column => {
    const value = row[column]
    if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')]
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite source number requires manual review')
    return [typeof value, value]
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
const aggregateHash = (rows: string[]) => createHash('sha256').update(rows.sort().join('\n')).digest('hex')

/** One atomic import into an empty target. Never modifies the SQLite source. */
export async function migrateManagementPostgres({ source, connectionString, apply = false, reportPath = '' }: {
  source: string; connectionString: string; apply?: boolean; reportPath?: string;
}) {
  source = resolve(source)
  if (!connectionString) throw new Error('MIAO_DATABASE_URL is required; credentials must stay in the private environment')
  if (!existsSync(source)) throw new Error('The source SQLite snapshot does not exist')
  if (reportPath && existsSync(reportPath)) throw new Error('Report already exists; choose a new report path')
  const sourceHash = await hashFile(source)
  const sqlite = new DatabaseSync(source, { readOnly: true })
  let target: CloudDatabase | undefined
  try {
    target = await CloudDatabase.open(':memory:', connectionString, false, { initializeCompatibility: false })
    sqlite.exec('BEGIN')
    if (sqlite.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok')) throw new Error('Source SQLite integrity check failed')
    if (sqlite.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Source contains foreign-key violations; preserve it for manual review')
    const schema = sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>
    const ordered: typeof schema = []
    const pending = [...schema]
    while (pending.length) {
      const names = new Set(pending.map(table => table.name))
      const index = pending.findIndex(table => (sqlite.prepare(`PRAGMA foreign_key_list(${identifier(table.name)})`).all() as any[])
        .every(fk => fk.table === table.name || !names.has(fk.table)))
      if (index < 0) throw new Error('Source contains cyclic foreign keys; an explicit migration is required')
      ordered.push(pending.splice(index, 1)[0])
    }
    const tables: Array<{ table: string; rows: number; sha256: string }> = []
    const columnAdjustments: Array<{ table: string; column: string; from: string; to: string }> = []
    const result = { mode: apply ? 'applied' : 'dry-run', sourceSha256: sourceHash, tables, columnAdjustments, verified: false, observedAt: new Date().toISOString() }
    await target.transaction(async () => {
      await target.lock('miaoimg:management-import:v1')
      const existing = await target.all("SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','p')")
      if (existing.length) throw new Error('Target database is not empty; import refuses to overwrite existing data')
      await target.installCompatibility()
      for (const table of ordered) {
        await target.exec(table.sql)
        const metadata = sqlite.prepare(`PRAGMA table_info(${identifier(table.name)})`).all() as any[]
        const columns = metadata.map(column => String(column.name))
        for (const column of metadata) {
          if (!/INT/i.test(column.type)) continue
          const fractional = Boolean(sqlite.prepare(`SELECT 1 FROM ${identifier(table.name)} WHERE typeof(${identifier(column.name)})='real' LIMIT 1`).get())
          const money = (['users','generations','text_charges','credit_grants'].includes(table.name) && /(^points$|_points$)/.test(column.name))
            || table.name === 'ledger' && column.name === 'delta' || /_(rmb|usd|cny)$/.test(column.name)
          if (fractional || money) {
            await target.exec(`ALTER TABLE ${identifier(table.name)} ALTER COLUMN ${identifier(column.name)} TYPE NUMERIC`)
            columnAdjustments.push({ table: table.name, column: column.name, from: column.type, to: 'NUMERIC' })
          }
        }
        const sourceRows = sqlite.prepare(`SELECT ${columns.map(identifier).join(',')}${table.name === 'artifacts' ? ',rowid AS miao_row_order' : ''} FROM ${identifier(table.name)}`).iterate()
        const expected: string[] = []
        let batch: any[][] = [], bytes = 0
        const insertColumns = table.name === 'artifacts' ? [...columns, 'miao_row_order'] : columns
        const flush = async () => {
          if (!batch.length) return
          const placeholders = batch.map(() => `(${insertColumns.map(() => '?').join(',')})`).join(',')
          await target.run(`INSERT INTO ${identifier(table.name)}(${insertColumns.map(identifier).join(',')}) VALUES ${placeholders}`, ...batch.flat())
          batch = []; bytes = 0
        }
        for (const row of sourceRows) {
          expected.push(rowHash(row, columns))
          const values = insertColumns.map(column => row[column])
          batch.push(values)
          bytes += values.reduce<number>((size, value) => size + (typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8), 0)
          if (batch.length >= 100 || bytes >= 4 * 1024 * 1024) await flush()
        }
        await flush()
        const actualRows = await target.all(`SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table.name)}`)
        const expectedHash = aggregateHash(expected)
        if (actualRows.length !== expected.length || aggregateHash(actualRows.map(row => rowHash(row, columns))) !== expectedHash) throw new Error(`Data verification failed for ${table.name}`)
        tables.push({ table: table.name, rows: expected.length, sha256: expectedHash })
      }
      const indexes = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
      for (const index of indexes) await target.exec(String(index.sql))
      if (schema.some(table => table.name === 'artifacts')) await target.get("SELECT setval(pg_get_serial_sequence('artifacts','miao_row_order'),COALESCE((SELECT MAX(miao_row_order) FROM artifacts),0)+1,false)")
      await target.exec('CREATE TABLE miao_database_migrations(id TEXT PRIMARY KEY,source_sha256 TEXT NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL)')
      await target.run('INSERT INTO miao_database_migrations VALUES(?,?,?,?)', 'sqlite-to-postgres-v1', sourceHash, JSON.stringify(tables), new Date().toISOString())
      result.verified = true
      if (!apply) throw Object.assign(new Error('dry-run rollback'), { dryRun: true })
    }).catch(error => { if (!error?.dryRun) throw error })
    sqlite.exec('ROLLBACK')
    if (await hashFile(source) !== sourceHash) throw new Error('Source snapshot changed during migration; retain the target for review')
    if (reportPath) {
      mkdirSync(dirname(resolve(reportPath)), { recursive: true })
      writeFileSync(reportPath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    }
    return result
  } finally {
    try { sqlite.close() } finally { await target?.close() }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { source: { type: 'string' }, report: { type: 'string' }, apply: { type: 'boolean', default: false } } })
  if (!values.source || !values.report) throw new Error('Usage: node scripts/migrate-management-postgres.ts --source /private/snapshot.sqlite --report /private/report.json [--apply]')
  try {
    const result = await migrateManagementPostgres({ source: values.source, connectionString: process.env.MIAO_DATABASE_URL || '', apply: values.apply, reportPath: values.report })
    console.log(JSON.stringify({ mode: result.mode, verified: result.verified, tables: result.tables.length, rows: result.tables.reduce((sum, table) => sum + table.rows, 0), report: resolve(values.report) }))
  } catch (error) {
    // Driver messages can embed business values. Keep terminal output bounded.
    console.error('[migration] failed:', /^[0-9A-Z]{5}$/.test(error?.code || '') ? error.code : 'See private migration configuration and source validation')
    process.exitCode = 1
  }
}
