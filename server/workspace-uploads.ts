import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failure } from './management-store.ts'

export const UPLOAD_CHUNK_BYTES = 1024 * 1024
const records = new Map()
const TTL = 60 * 60 * 1000
const keyFor = (owner, project, id) => JSON.stringify([owner, project, id])
function uploadId(value) {
  if (!/^[a-f0-9-]{36}$/i.test(String(value || ''))) throw failure('上传标识无效', 400)
  return value
}
export function uploadStatus(owner, project, id) {
  const entry = records.get(keyFor(owner, project, uploadId(id)))
  if (!entry) return { offset: 0 }
  entry.touched = Date.now()
  return { offset: entry.offset, total: entry.total, ...(entry.result ? { result: entry.result } : {}) }
}
// 临时分块只在当前服务实例里保存一小时；成功落盘立即删除，原件仍由 CAS 保存一份。
const cleanup = setInterval(() => {
  for (const [key, entry] of records) if (!entry.busy && Date.now() - entry.touched > TTL) {
    records.delete(key)
    void rm(entry.directory, { recursive: true, force: true }).catch(() => {})
  }
}, 60000)
cleanup.unref()
// API 子进程重启后的旧暂存也会回收，避免遗留没有内存索引的分块。
async function sweepOrphans() {
  const active = new Set([...records.values()].map(entry => entry.directory))
  for (const name of await readdir(tmpdir())) {
    if (!/^miaoimg-upload-[A-Za-z0-9]+$/.test(name)) continue
    const directory = join(tmpdir(), name)
    if (active.has(directory)) continue
    const info = await stat(directory).catch(() => null)
    if (info?.isDirectory() && Date.now() - info.mtimeMs > TTL) await rm(directory, { recursive: true, force: true })
  }
}
void sweepOrphans().catch(() => {})
const orphanSweep = setInterval(() => { void sweepOrphans().catch(() => {}) }, TTL)
orphanSweep.unref()

export async function appendUpload({ owner, project, id, path, mime, total, offset, bytes, revision, maximum, commit }: Record<string, any>) {
  uploadId(id)
  if (!Number.isSafeInteger(total) || total < 1 || total > maximum) throw failure('文件不能为空且不能超过 100 MB', 413)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > total || !bytes.length || bytes.length > UPLOAD_CHUNK_BYTES) throw failure('上传分块无效', 400)
  const key = keyFor(owner, project, id)
  let entry = records.get(key)
  if (!entry) {
    if (offset !== 0) throw failure('上传暂存已过期，请重试', 409)
    const active = [...records.values()].filter(item => !item.result)
    if (active.length >= 16 || active.filter(item => item.owner === owner).length >= 4) throw failure('请等待当前素材上传完成后再上传', 429)
    entry = { owner, project, path, mime, total, revision, offset: 0, touched: Date.now(), busy: true }
    records.set(key, entry)
    try { entry.directory = await mkdtemp(join(tmpdir(), 'miaoimg-upload-')); entry.file = join(entry.directory, randomUUID()) }
    catch (error) { records.delete(key); throw error }
    entry.busy = false
  }
  if (entry.path !== path || entry.mime !== mime || entry.total !== total || entry.revision !== revision) throw failure('上传文件信息已变化，请重新选择文件', 409)
  if (entry.result) return { offset: total, result: entry.result }
  if (entry.busy) throw failure('正在保存当前分块，请稍后重试', 429)
  entry.busy = true; entry.touched = Date.now()
  try {
    if (offset > entry.offset) throw failure('上传进度不一致，请重试', 409)
    const handle = await open(entry.file, entry.offset ? 'r+' : 'w+')
    try {
      if (offset < entry.offset) {
        if (offset + bytes.length > entry.offset) throw failure('上传进度不一致，请重试', 409)
        const previous = Buffer.alloc(bytes.length)
        const { bytesRead } = await handle.read(previous, 0, previous.length, offset)
        if (bytesRead !== bytes.length || !previous.equals(bytes)) throw failure('分块内容不一致，请重新选择文件', 409)
      } else {
        let written = 0
        while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, offset + written)).bytesWritten
        entry.offset += written
      }
    } finally { await handle.close() }
    if (entry.offset === total) {
      entry.result = await commit(await readFile(entry.file))
      await rm(entry.directory, { recursive: true, force: true }).catch(() => {})
    }
    return { offset: entry.offset, ...(entry.result ? { result: entry.result } : {}) }
  } finally { entry.busy = false; entry.touched = Date.now() }
}
