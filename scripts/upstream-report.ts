#!/usr/bin/env node
import { ManagementStore } from '../server/management-store.ts'

const hoursArg = process.argv.find(arg => arg.startsWith('--hours='))
const hours = Math.max(0.01, Number(hoursArg?.split('=')[1] || 24))
const provider = String(process.argv.find(arg => arg.startsWith('--provider='))?.split('=').slice(1).join('=') || 'metaso').trim()
const since = new Date(Date.now() - hours * 3_600_000).toISOString()
const store = (await ManagementStore.open())
try {
  const rows = (await store.all('SELECT * FROM upstream_reconciliations WHERE provider=? AND to_at>=? ORDER BY to_at ASC', provider, since))
  const snapshots = (await store.all('SELECT * FROM upstream_balance_snapshots WHERE provider=? AND observed_at>=? ORDER BY observed_at DESC', provider, since))
  const known = rows.filter(row => row.delta != null)
  const actual = known.reduce((sum, row) => sum + Number(row.delta || 0), 0)
  const attributable = known.reduce((sum, row) => sum + Number(row.successful_estimated_credits || 0), 0)
  const unexplained = known.reduce((sum, row) => sum + Math.max(0, Number(row.unexplained_credits || 0)), 0)
  const latest = snapshots[0] || null
  console.log(JSON.stringify({
    provider,
    since,
    until: new Date().toISOString(),
    latestBalance: latest?.balance ?? null,
    latestBalanceAt: latest?.observed_at ?? null,
    actualDeducted: known.length ? Math.round(actual * 10000) / 10000 : null,
    attributableToSuccessfulCalls: known.length ? Math.round(attributable * 10000) / 10000 : null,
    unexplainedDeducted: known.length ? Math.round(unexplained * 10000) / 10000 : null,
    reconciliationIntervals: rows.length,
    callsInIntervals: rows.reduce((sum, row) => sum + Number(row.calls || 0), 0),
    failedCallsInIntervals: rows.reduce((sum, row) => sum + Number(row.failed_calls || 0), 0),
    status: known.length ? 'ok' : 'unknown',
  }, null, 2))
} finally {
  await store.close()
}
