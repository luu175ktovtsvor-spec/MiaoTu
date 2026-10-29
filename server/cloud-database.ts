import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import { POSTGRES_COMPAT_SCHEMA } from './postgres-compat.ts'

type Context = { owner: CloudDatabase; client: any; active: boolean; depth: number; committed: boolean; afterCommit: Array<() => unknown> }
const transactions = new AsyncLocalStorage<Context>()
const safeInteger = (value: string) => {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) throw new RangeError('Database integer exceeds JavaScript safe range')
  return number
}

/** Server queries are asynchronous. The local adapter retains SQLite on disk. */
export class CloudDatabase {
  readonly dialect: 'postgres' | 'sqlite'
  private sqlite?: DatabaseSync
  private pool: any
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(dialect: 'postgres' | 'sqlite') { this.dialect = dialect }

  static async open(path: string, connectionString = process.env.MIAO_DATABASE_URL || '', requirePostgres = false, { initializeCompatibility = true } = {}) {
    if (!connectionString && requirePostgres) throw new Error('Production requires an explicit MIAO_DATABASE_URL; SQLite fallback is disabled')
    if (!connectionString) {
      const database = new CloudDatabase('sqlite')
      database.sqlite = new DatabaseSync(path)
      return database
    }
    let url: URL
    try { url = new URL(connectionString) } catch { throw new Error('Invalid private PostgreSQL connection configuration') }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('MIAO_DATABASE_URL must use PostgreSQL')
    const pg = await import('pg')
    const database = new CloudDatabase('postgres')
    const max = Number(process.env.MIAO_DB_POOL_MAX || 10)
    if (!Number.isSafeInteger(max) || max < 1 || max > 50) throw new Error('MIAO_DB_POOL_MAX must be between 1 and 50')
    // Per-pool parsers avoid changing unrelated libraries or local stores.
    const parsers = { getTypeParser(oid: number, format?: any) {
      if (format !== 'binary' && oid === 20) return safeInteger
      if (format !== 'binary' && oid === 1700) return (value: string) => {
        const number = Number(value)
        if (!Number.isFinite(number)) throw new RangeError('Non-finite database number')
        return number
      }
      return pg.types.getTypeParser(oid, format)
    } }
    database.pool = new pg.Pool({ connectionString, max, types: parsers,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, options: '-c search_path=public',
      statement_timeout: 15000, lock_timeout: 5000,
      application_name: `miaoimg-${process.env.MIAO_EDITION || 'cn'}` })
    database.pool.on('error', () => console.error('[database] idle PostgreSQL connection failed'))
    try {
      const collation = await database.pool.query('SELECT datcollate FROM pg_database WHERE datname=current_database()')
      if (!['C','POSIX'].includes(collation.rows[0]?.datcollate)) throw Object.assign(new Error('Cloud database requires bytewise C collation'), {code:'MIAO_DB_COLLATION'})
      const schema = await database.pool.query('SELECT current_schema() AS name')
      if (schema.rows[0]?.name !== 'public') throw new Error('The cloud database must use its public schema')
      if (initializeCompatibility) await database.installCompatibility()
      else await database.pool.query('SELECT 1')
    } catch (error) {
      await database.pool.end()
      throw new Error(`PostgreSQL connection/schema initialization failed (${error?.code || 'unavailable'}); check the private database configuration`)
    }
    return database
  }

  async installCompatibility() {
    if (this.dialect !== 'postgres') return
    await this.transaction(async () => {
      await this.lock('miaoimg:schema:json-compat-v1')
      await this.context()!.client.query(POSTGRES_COMPAT_SCHEMA)
    })
  }

  private context() {
    const context = transactions.getStore()
    if (context?.owner !== this) return null
    if (!context.active) throw new Error('Database operation escaped its completed transaction')
    return context
  }

  get isTransaction() { return Boolean(this.context()) }

  afterCommit(operation: () => unknown) {
    const context = this.context()
    if (!context) throw new Error('Commit hooks require a transaction')
    context.afterCommit.push(operation)
  }

  async lockRow(table: string, column: string, value: unknown) {
    if (!this.context()) throw new Error('Row locks require a transaction')
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error('Invalid database identifier')
    if (this.dialect === 'postgres') await this.get(`SELECT ${column} FROM ${table} WHERE ${column}=? FOR UPDATE`, value)
  }

  private async exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void
    const previous = this.tail
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await fn() } finally { release() }
  }

  private async query(sql: string, args: any[], mode: 'all' | 'get' | 'run') {
    if (this.closed) throw new Error('Database is closed')
    const context = this.context()
    if (args.some(value => typeof value === 'number' && !Number.isFinite(value))) throw new RangeError('Non-finite database parameters are refused')
    if (this.dialect === 'sqlite') {
      const execute = () => this.sqlite!.prepare(sql)[mode](...args)
      return context ? execute() : this.exclusive(execute)
    }
    const text = postgresSql(sql)
    const result = await (context?.client || this.pool).query(text, args.map(value => value === undefined ? null : value))
    if (mode === 'get') return result.rows[0]
    if (mode === 'run') return { changes: result.rowCount || 0, lastInsertRowid: 0 }
    return result.rows
  }

  all(sql: string, ...args: any[]): Promise<any[]> { return this.query(sql, args, 'all') }
  get(sql: string, ...args: any[]): Promise<any> { return this.query(sql, args, 'get') }
  run(sql: string, ...args: any[]): Promise<{ changes: number; lastInsertRowid: number }> { return this.query(sql, args, 'run') }

  async exec(sql: string) {
    if (this.closed) throw new Error('Database is closed')
    const context = this.context()
    if (this.dialect === 'sqlite') {
      const execute = () => this.sqlite!.exec(sql)
      return context ? execute() : this.exclusive(execute)
    }
    for (const statement of orderTables(splitSql(sql))) {
      if (/^PRAGMA\s+(journal_mode|busy_timeout|foreign_keys)\s*=/i.test(statement)) {
        if (/foreign_keys\s*=\s*OFF/i.test(statement)) throw new Error('PostgreSQL foreign keys cannot be disabled by a SQLite migration')
        continue
      }
      await (context?.client || this.pool).query(postgresSql(statement))
    }
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.closed) throw new Error('Database is closed')
    const current = this.context()
    if (current) {
      const name = `miao_nested_${++current.depth}`
      const hooks = current.afterCommit.length
      await this.exec(`SAVEPOINT ${name}`)
      try { const value = await fn(); await this.exec(`RELEASE SAVEPOINT ${name}`); return value }
      catch (error) { current.afterCommit.splice(hooks); await this.exec(`ROLLBACK TO SAVEPOINT ${name}`); await this.exec(`RELEASE SAVEPOINT ${name}`); throw error }
    }
    const perform = async () => {
      const client = this.dialect === 'postgres' ? await this.pool.connect() : null
      const context: Context = { owner: this, client, active: true, depth: 0, committed: false, afterCommit: [] }
      let result: T
      let damaged = false
      try {
        if (client) await client.query('BEGIN')
        else this.sqlite!.exec('BEGIN IMMEDIATE')
        result = await transactions.run(context, async () => {
          try {
            const result = await fn()
            if (client) await client.query('COMMIT')
            else this.sqlite!.exec('COMMIT')
            context.committed = true
            return result
          } catch (error) {
            try {
              if (client) await client.query('ROLLBACK')
              else this.sqlite!.exec('ROLLBACK')
            } catch { damaged = true }
            throw error
          } finally { context.active = false }
        })
      } finally { context.active = false; client?.release(damaged) }
      return { result, hooks: context.afterCommit }
    }
    // Hooks run after releasing the SQLite queue/client and outside the closed
    // transaction context, so deferred cleanup can open a fresh transaction.
    const { result, hooks } = await (this.dialect === 'sqlite' ? this.exclusive(perform) : perform())
    for (const hook of hooks) await hook()
    return result
  }

  /** All actors changing the same business entity acquire this inside a transaction. */
  async lock(scope: string) {
    const context = this.context()
    if (!context) throw new Error('Business locks require a transaction')
    if (this.dialect === 'postgres') await context.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [scope])
  }

  async close() {
    if (this.closed) return
    if (this.context()) throw new Error('Cannot close the database inside a transaction')
    if (this.dialect === 'postgres') await this.pool.end()
    else await this.exclusive(() => this.sqlite!.close())
    this.closed = true
  }
}

// Tokenization keeps placeholders and dialect rewrites out of quoted values,
// quoted identifiers, dollar-quoted bodies and SQL comments.
export function sqlTokens(sql: string): string[] {
  const pattern = /(--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\$([A-Za-z_][\w]*|)\$[\s\S]*?\$\2\$|[A-Za-z_][\w]*|\s+|.)/g
  return Array.from(sql.matchAll(pattern), match => match[0])
}

export function splitSql(sql: string) {
  const statements: string[] = []; let current = ''
  for (const token of sqlTokens(sql)) {
    if (token === ';') { if (current.trim()) statements.push(current.trim()); current = '' }
    else current += token
  }
  if (current.trim()) statements.push(current.trim())
  return statements
}

export function postgresSql(sql: string) {
  const pragma = /^\s*PRAGMA\s+table_info\(\s*([A-Za-z_][\w]*)\s*\)\s*;?\s*$/i.exec(sql)
  if (pragma) return `SELECT ordinal_position-1 AS cid,column_name AS name,data_type AS type,
    CASE WHEN is_nullable='NO' THEN 1 ELSE 0 END AS "notnull",column_default AS dflt_value,
    CASE WHEN column_name IN (SELECT k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k USING(constraint_catalog,constraint_schema,constraint_name) WHERE t.table_schema=current_schema() AND t.table_name='${pragma[1]}' AND t.constraint_type='PRIMARY KEY') THEN 1 ELSE 0 END AS pk
    FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='${pragma[1]}' ORDER BY ordinal_position`
  if (/^\s*PRAGMA/i.test(sql)) throw new Error('Unsupported SQLite pragma on PostgreSQL')
  let index = 0
  const lexical = sqlTokens(sql)
  const ddl = /^\s*(CREATE|ALTER)\s/i.test(sql)
  const mapped = lexical.map((token, tokenIndex) => {
    if (token === '?') return `$${++index}`
    if (/^[A-Za-z_][\w]*$/.test(token) && /[a-z][A-Z]/.test(token)) {
      let previous = tokenIndex - 1
      while (/^\s+$/.test(lexical[previous] || '')) previous--
      if (lexical[previous]?.toUpperCase() === 'AS') return `"${token}"`
    }
    if (ddl && /^(REAL|BLOB|INTEGER)$/i.test(token)) {
      let previous = tokenIndex - 1
      while (/^\s+$/.test(lexical[previous] || '')) previous--
      const before = lexical[previous] || ''
      if ((/^[A-Za-z_][\w]*$/.test(before) || before.startsWith('"')) && !/^(TABLE|COLUMN|INDEX|CONSTRAINT|REFERENCES|BY|WHERE|SET|DEFAULT|AS)$/i.test(before)) return ({ REAL: 'NUMERIC', BLOB: 'BYTEA', INTEGER: 'BIGINT' })[token.toUpperCase()]
    }
    if (/^rowid$/i.test(token)) return 'miao_row_order'
    if (/^LIKE$/i.test(token)) return 'ILIKE'
    return token
  })
  for (let i = 0; i < mapped.length; i++) {
    if (mapped[i].toUpperCase() === 'SQLITE_MASTER') mapped[i] = "(SELECT table_name AS name,'table' AS type,'' AS sql FROM information_schema.tables WHERE table_schema=current_schema() AND table_type='BASE TABLE') AS sqlite_master"
    if (mapped[i].toUpperCase() !== 'IS') continue
    let next = i + 1
    while (/^\s+$/.test(mapped[next] || '')) next++
    if (/^\$\d+$/.test(mapped[next] || '')) mapped[i] = 'IS NOT DISTINCT FROM'
    else if (mapped[next]?.toUpperCase() === 'NOT') {
      let after = next + 1
      while (/^\s+$/.test(mapped[after] || '')) after++
      if (/^\$\d+$/.test(mapped[after] || '')) { mapped[i] = 'IS DISTINCT FROM'; mapped[next] = '' }
    }
  }
  let result = rewriteFunctions(mapped)
  if (/^\s*INSERT\s+OR\s+IGNORE\b/i.test(result)) result = result.replace(/INSERT\s+OR\s+IGNORE/i, 'INSERT') .replace(/;?\s*$/, ' ON CONFLICT DO NOTHING')
  result = result.replace(/^(\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN)\s+(?!IF\b)/i, '$1 IF NOT EXISTS ')
  if (/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?artifacts"?\s*\(/i.test(result)) result = result.replace(/\)\s*$/, ',miao_row_order BIGINT GENERATED BY DEFAULT AS IDENTITY)')
  return result
}

function rewriteFunctions(tokens: string[]): string {
  const result: string[] = []
  const numericPaths = new Set(['$.rmb', '$.detail.pricing.shortfallPoints', '$.desktopDelivery', '$.submissionUncertain', '$.imageResultPending', '$.removed'])
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    let next = index + 1
    while (/^\s+$/.test(tokens[next] || '')) next++
    if (/^[A-Za-z_][\w]*$/.test(token) && tokens[next] === '(') {
      let end = next + 1, depth = 1, start = end
      const args: string[] = []
      for (; end < tokens.length; end++) {
        if (tokens[end] === '(') depth++
        if (tokens[end] === ')') depth--
        if (!depth) { args.push(rewriteFunctions(tokens.slice(start, end))); break }
        if (depth === 1 && tokens[end] === ',') { args.push(rewriteFunctions(tokens.slice(start, end))); start = end + 1 }
      }
      if (depth) throw new Error('Unbalanced SQL expression')
      let name = token
      const lower = token.toLowerCase()
      if (lower === 'cast') args[0] = args[0].replace(/\bAS\s+(REAL|BLOB|INTEGER)\s*$/i, (_, type) => `AS ${{REAL:'NUMERIC',BLOB:'BYTEA',INTEGER:'BIGINT'}[type.toUpperCase()]}`)
      if (lower === 'json_extract') name = numericPaths.has(args[1]?.trim().slice(1, -1)) ? 'public.miao_json_number' : 'public.miao_json_extract'
      else if (['json_valid', 'json_type', 'json_each'].includes(lower)) name = `public.miao_${lower}`
      else if (args.length > 1 && ['min', 'max'].includes(lower)) name = lower === 'min' ? 'LEAST' : 'GREATEST'
      else if (lower === 'coalesce' && args.length === 2 && args[1].trim() === '0' && /^\([\s\S]*\)$/.test(args[0].trim()) && !/^\(\s*(SELECT|CASE|WITH)\b/i.test(args[0].trim()) && /\b(AND|OR|IS)\b/i.test(args[0])) args[1] = 'FALSE'
      result.push(name, '(', args.join(','), ')'); index = end
    } else if (token.toUpperCase() === 'GLOB') {
      const pattern = tokens[next]
      if (!/^'(?:''|[^'])*'$/.test(pattern || '') || /[\[\]]/.test(pattern)) throw new Error('Unsupported SQLite glob expression')
      result.push('LIKE', ' ', pattern.replace(/[\%_]/g, '\\$&').replaceAll('*', '%').replaceAll('?', '_'), String.raw` ESCAPE '\'`)
      index = next
    } else result.push(token)
  }
  return result.join('')
}

function orderTables(statements: string[]) {
  const pending = statements.filter(sql => /^CREATE\s+TABLE\s+/i.test(sql))
  if (pending.length < 2) return statements
  const ordered: string[] = []
  const name = (sql: string) => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i.exec(sql)?.[1]
  while (pending.length) {
    const names = new Set(pending.map(name))
    const index = pending.findIndex(sql => [...sql.matchAll(/\bREFERENCES\s+(\w+)/gi)].every(match => match[1] === name(sql) || !names.has(match[1])))
    if (index < 0) throw new Error('Cyclic schema dependencies require an explicit migration')
    ordered.push(pending.splice(index, 1)[0])
  }
  return [...ordered, ...statements.filter(sql => !/^CREATE\s+TABLE\s+/i.test(sql))]
}
