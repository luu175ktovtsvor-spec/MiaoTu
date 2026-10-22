import { lstat, readdir } from 'node:fs/promises'
import { lstatSync, unlinkSync, type BigIntStats } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate as yieldToFiles } from 'node:timers/promises'

const COMPLETE = /^(?:v2-)?[a-f0-9]{64}\.jpg$/
const TEMPORARY = /^((?:v2-)?[a-f0-9]{64}\.jpg)\.tmp-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
type Candidate = { path: string; base: string; temporary: boolean; info: BigIntStats }

// Only the desktop's private JPEG cache directory. No recursion, media index,
// account database or original-file paths are involved in this collection.
export async function sweepPreviewFiles(directory: string, {
  maxBytes = 256 * 1024 * 1024, ttlMs = 30 * 24 * 60 * 60_000,
  minAgeMs = 120_000, temporaryAgeMs = 5 * 60_000,
  active = (_path: string) => false, signal,
}: { maxBytes?: number; ttlMs?: number; minAgeMs?: number; temporaryAgeMs?: number; active?: (path: string) => boolean; signal?: AbortSignal } = {}) {
  for (const value of [maxBytes, ttlMs, minAgeMs, temporaryAgeMs]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('预览缓存回收参数无效')
  signal?.throwIfAborted()
  directory = resolve(directory)
  const report = { removed: 0, removedBytes: 0, retainedBytes: 0, temporaryBytes: 0, protected: 0, failed: 0, skippedDirectory: false }
  let root: BigIntStats
  try { root = await lstat(directory, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return report; throw error }
  if (!root.isDirectory() || root.isSymbolicLink() || !root.ino) { report.skippedDirectory = true; return report }
  const candidates: Candidate[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    signal?.throwIfAborted()
    const temporary = TEMPORARY.exec(entry.name)
    if (!entry.isFile() || !COMPLETE.test(entry.name) && !temporary) continue
    const path = join(directory, entry.name)
    try {
      const info = await lstat(path, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink() || !info.ino) continue
      candidates.push({ path, base: temporary ? join(directory, temporary[1]) : path, temporary: Boolean(temporary), info })
    } catch (error) { if (error.code !== 'ENOENT') report.failed++ }
  }
  candidates.sort((a, b) => a.info.mtimeNs < b.info.mtimeNs ? -1 : a.info.mtimeNs > b.info.mtimeNs ? 1 : a.path.localeCompare(b.path))
  let retained = candidates.reduce((sum, item) => sum + (item.temporary ? 0n : item.info.size), 0n)
  let temporaryBytes = candidates.reduce((sum, item) => sum + (item.temporary ? item.info.size : 0n), 0n)
  const now = BigInt(Date.now()) * 1_000_000n
  const old = (time: bigint, age: number) => now - time >= BigInt(age) * 1_000_000n
  for (let index = 0; index < candidates.length; index++) {
    if (index && index % 32 === 0) await yieldToFiles()
    signal?.throwIfAborted()
    const item = candidates[index]
    const eligible = item.temporary ? old(item.info.mtimeNs, temporaryAgeMs)
      : item.info.size === 0n || old(item.info.mtimeNs, ttlMs) || retained > BigInt(maxBytes)
    if (!eligible) continue
    if (active(item.base) || !old(item.info.mtimeNs, minAgeMs) || !old(item.info.ctimeNs, minAgeMs)) { report.protected++; continue }
    try {
      // Final checks and unlink do not yield: in-process atomic publishers and
      // cache touches cannot interleave this deletion. Replaced files stay put.
      const currentRoot = lstatSync(directory, { bigint: true })
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== root.dev || currentRoot.ino !== root.ino) { report.skippedDirectory = true; break }
      const current = lstatSync(item.path, { bigint: true })
      if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, item.info) || active(item.base)
        || !old(current.mtimeNs, minAgeMs) || !old(current.ctimeNs, minAgeMs)) { report.protected++; continue }
      unlinkSync(item.path)
      if (item.temporary) temporaryBytes -= current.size
      else retained -= current.size
      report.removed++; report.removedBytes += Number(current.size)
    } catch (error) { if (error.code !== 'ENOENT') report.failed++ }
  }
  report.retainedBytes = Number(retained)
  report.temporaryBytes = Number(temporaryBytes)
  return report
}
