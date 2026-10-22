#!/usr/bin/env node
import { ManagementStore } from '../server/management-store.ts'
import { reconcileMetasoBalance } from '../server/metaso-video.ts'

const provider = String(process.argv.find(arg => arg.startsWith('--provider='))?.split('=').slice(1).join('=') || 'metaso').trim()
if (provider !== 'metaso') {
  console.error(JSON.stringify({ ok: false, error: `unsupported provider: ${provider}` }))
  process.exitCode = 2
} else {
  const management = new ManagementStore()
  try {
    const result = await reconcileMetasoBalance({ management })
    console.log(JSON.stringify({ ok: true, ...result }, null, 2))
    if (result.alarm) process.exitCode = 3
  } finally {
    management.close()
  }
}
