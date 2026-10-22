import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const defaultPath = () => process.env.OIP_USAGE_LOG || join(process.env.OIP_DATA_DIR || join(process.cwd(), 'data'), 'generation-usage.ndjson')

export async function recordGeneration(entry, env = process.env) {
  const path = env.OIP_USAGE_LOG || defaultPath()
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify({ ...entry, at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function readUsageSummary(env = process.env) {
  const path = env.OIP_USAGE_LOG || defaultPath()
  try {
    const text = await readFile(path, 'utf8')
    const rows = text.split('\n').filter(Boolean).slice(-500).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
    return {
      recent: rows.slice(-50).reverse(),
      totalRequests: rows.length,
      totalPoints: rows.reduce((sum, row) => sum + Number(row.points || 0), 0),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { recent: [], totalRequests: 0, totalPoints: 0 }
    throw error
  }
}
