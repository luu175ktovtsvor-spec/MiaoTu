import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

/** Old SQLite metadata must never authorize cleanup of PostgreSQL media. */
export function assertLegacySQLiteMaintenance() {
  let configured = process.env.MIAO_DATABASE_URL || ''
  if (!configured) {
    try { configured = parseEnv(readFileSync('/etc/miaoimg/main.env', 'utf8')).MIAO_DATABASE_URL || '' }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error('Cannot establish the active database backend; no maintenance was performed') }
  }
  if (configured) throw new Error('This historical SQLite layout tool is disabled for the PostgreSQL cloud database; no files were changed')
}
