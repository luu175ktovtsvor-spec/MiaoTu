import { createReadStream, type BigIntStats } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

const unsupportedLink = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'])

// The completed temp is already beside destination. Prefer atomic publication;
// filesystems without hard links still get an exclusive, cancellable copy.
export async function publishExportFile(temp: string, destination: string, signal: AbortSignal) {
  signal.throwIfAborted()
  try { await link(temp, destination); return }
  catch (error) { if (!unsupportedLink.has(error.code)) throw error }
  signal.throwIfAborted()
  const output = await open(destination, 'wx', 0o600)
  let identity: BigIntStats | undefined
  try {
    identity = await output.stat({ bigint: true })
    signal.throwIfAborted()
    await pipeline(createReadStream(temp), output.createWriteStream(), { signal })
  } catch (error) {
    await output.close().catch(() => {})
    try {
      const current = await lstat(destination, { bigint: true })
      // Preserve a replacement if this path no longer refers to our copy.
      if (!identity || !identity.ino) throw new Error('Export file identity unavailable')
      if (current.dev === identity.dev && current.ino === identity.ino) await unlink(destination)
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw Object.assign(new Error(`导出未完成，部分副本未能清理，请检查：${destination}`, { cause: error }), {
          name: error?.name || 'Error', cleanupCode: cleanupError.code || 'unknown',
        })
      }
    }
    throw error
  } finally { await output.close().catch(() => {}) }
}
