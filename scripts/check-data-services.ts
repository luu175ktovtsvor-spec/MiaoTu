import { CloudDatabase } from '../server/cloud-database.ts'
import { redisRuntime } from '../server/redis-runtime.ts'

if (!process.env.MIAO_DATABASE_URL || !redisRuntime.configured) throw new Error('Cloud startup requires PostgreSQL and an independent Redis configuration')
const database = await CloudDatabase.open(':memory:', process.env.MIAO_DATABASE_URL, true, { initializeCompatibility: false })
try {
  if (process.env.MIAO_REQUIRE_IMPORTED_DATABASE === 'true') {
    const marker = await database.get("SELECT source_sha256 FROM miao_database_migrations WHERE id='sqlite-to-postgres-v1'")
    if (!/^[a-f0-9]{64}$/.test(marker?.source_sha256 || '')) throw new Error('The required SQLite import marker is absent')
  }
  if (await redisRuntime.ping() !== 'PONG') throw new Error('Redis readiness check failed')
  console.log('[data] PostgreSQL and Redis ready')
} finally { await redisRuntime.close(); await database.close() }
