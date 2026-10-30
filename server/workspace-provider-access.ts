import { AsyncLocalStorage } from 'node:async_hooks'
import { isProtectedWorkspacePath } from './workspace-path.ts'

// Only trusted provider-settings code holds this capability across its async scope. It is
// not a file operation, payload option, or remotely callable workspace method.
type Grant = { files: object; active: boolean }
const providerAccess = new AsyncLocalStorage<readonly Grant[]>()

export async function withProviderStoreAccess<T>(files: object, operation: () => T): Promise<Awaited<T>> {
  const grant: Grant = { files, active: true }
  try { return await providerAccess.run([...(providerAccess.getStore() || []), grant], operation) }
  finally { grant.active = false }
}

export function providerEntryVisible(files: object, path: unknown) {
  return !isProtectedWorkspacePath(path) || Boolean(providerAccess.getStore()?.some(grant => grant.active && grant.files === files))
}

export function assertProviderEntryAccess(files: object, path: unknown) {
  if (!providerEntryVisible(files, path)) throw Object.assign(new Error('供应商密钥请在设置中管理'), { status: 403 })
}
