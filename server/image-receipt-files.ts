import { mkdir, chmod, lstat, readFile, readdir, rename, rm, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { alignMediaOwner } from './media-files.ts'
import { readImageArtifact, type ImageResultMetadata } from './image-artifacts.ts'

type Binding = { owner: string; model: string }
export const imageReceiptBinding = (row: { owner_scope?: string; user_id?: string; model: string }): Binding => ({ owner: String(row.owner_scope || row.user_id || ''), model: row.model })
type Artifact = { bytes: Buffer; mime: string }
type ImageSource = { kind: 'inline'; revisedPrompt: string } | { kind: 'remote'; url: string; revisedPrompt: string }
export type StoredImageReceipt = {
  version: 1; generationId: string; binding: Binding; createdAt: number; expiresAt: number;
  result: ImageResultMetadata; images: ImageSource[];
}
type ProviderReceipt = ImageResultMetadata & { images: { url: string; revisedPrompt?: string }[] }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)
const temporaryId = (name: string) => /^\.([A-Za-z0-9][A-Za-z0-9_-]{0,99})\.tmp-[a-f0-9-]{36}$/.exec(name)?.[1]
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const problem = (message: string, code = 'IMAGE_RECEIPT_INVALID') => Object.assign(new Error(message), { status: 503, code, upstreamAccepted: true, submissionUncertain: true })
const expired = () => problem('原图暂存期已结束，请联系管理员核对原任务，避免重复生成', 'IMAGE_RECEIPT_EXPIRED')

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw problem('原图暂存目录无效')
  await chmod(path, 0o700)
  alignMediaOwner(path)
}
async function syncDirectory(path: string) {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try { handle = await open(path, 'r'); await handle.sync() }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error }
  finally { await handle?.close() }
}
async function writePrivate(path: string, bytes: string | Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const handle = await open(path, 'wx', 0o600)
  try { await handle.writeFile(bytes, { signal }); await handle.sync(); signal?.throwIfAborted() }
  finally { await handle.close() }
  alignMediaOwner(path)
}
async function regular(path: string) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw problem('原图暂存文件无效')
  return info
}

// Private, bounded-lived receive checkpoints. No account, task or billing DB is
// owned here; the host binds each directory to its existing generation row.
export class ImageReceiptFiles {
  root: string
  maxBytes: number
  private writing = new Set<string>()
  constructor(root: string, maxBytes: number) { this.root = resolve(root); this.maxBytes = maxBytes }
  private path(id: string) {
    if (!validId(id)) throw problem('原图暂存编号无效')
    return join(this.root, id)
  }
  private checkLive(receipt: StoredImageReceipt) { if (receipt.expiresAt <= Date.now()) throw expired() }
  private async checkRoot() {
    try {
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw problem('原图暂存目录无效')
      return true
    } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  }
  async load(id: string, binding?: Binding, allowExpired = false): Promise<StoredImageReceipt | undefined> {
    const path = this.path(id)
    if (!await this.checkRoot()) return
    return this.loadAt(path, id, binding, allowExpired)
  }
  private async loadAt(path: string, id: string, binding?: Binding, allowExpired = false): Promise<StoredImageReceipt | undefined> {
    let info
    try { info = await lstat(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('原图暂存目录无效')
    let receipt: StoredImageReceipt
    try {
      if ((await regular(join(path, 'receipt.json'))).size > 2 * 1024 * 1024) throw problem('原图暂存回执大小无效')
      receipt = JSON.parse(await readFile(join(path, 'receipt.json'), 'utf8'))
    }
    catch (cause) { throw Object.assign(problem('原图暂存回执无法读取，请保留原任务'), { cause }) }
    if (receipt?.version !== 1 || receipt.generationId !== id || !receipt.binding || typeof receipt.binding.owner !== 'string'
      || typeof receipt.binding.model !== 'string' || !receipt.binding.model || !Number.isFinite(receipt.createdAt)
      || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= receipt.createdAt || !receipt.result
      || !Number.isInteger(receipt.result.upstreamStatus) || !Array.isArray(receipt.images) || !receipt.images.length
      || receipt.images.some(image => !image || !['inline', 'remote'].includes(image.kind)
        || typeof image.revisedPrompt !== 'string' || image.kind === 'remote' && (typeof image.url !== 'string' || !/^https?:\/\//i.test(image.url)))) throw problem('原图暂存回执无效')
    if (binding && (binding.owner !== receipt.binding.owner || binding.model !== receipt.binding.model)) throw problem('原图暂存回执与任务归属不一致')
    if (!allowExpired) this.checkLive(receipt)
    return receipt
  }
  isWriting(id: string) {
    this.path(id)
    return [...this.writing].some(path => temporaryId(path.slice(this.root.length + 1)) === id)
  }
  // A completed private checkpoint may survive a crash before its final
  // rename. Publish those original files only; never reconstruct a provider
  // request or replace a readable checkpoint from the same task.
  async recover(id: string, binding: Binding, active: () => boolean): Promise<StoredImageReceipt | undefined> {
    const previous = await this.load(id, binding, true)
    if (previous) return previous
    if (!await this.checkRoot()) return
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    let unreadable: unknown
    for (const entry of entries) {
      if (temporaryId(entry.name) !== id || !entry.isDirectory() || entry.isSymbolicLink()) continue
      const path = join(this.root, entry.name)
      if (this.writing.has(path) || active()) throw problem('原图暂存仍在写入', 'IMAGE_RECEIPT_BUSY')
      try {
        const receipt = await this.loadAt(path, id, binding)
        if (!receipt) continue
        for (const [index, source] of receipt.images.entries()) {
          const artifact = await this.cached(path, index)
          if (source.kind === 'inline' && !artifact) throw problem('暂存原图缺失，请保留原任务等待核对')
        }
        this.checkLive(receipt)
        if (this.writing.has(path) || active()) throw problem('原图暂存仍在写入', 'IMAGE_RECEIPT_BUSY')
        try { await rename(path, this.path(id)); await syncDirectory(this.root) }
        catch (error) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
          const winner = await this.load(id, binding, true)
          if (!winner) throw error
          return winner
        }
        return receipt
      } catch (error) {
        // Another complete private copy may still be readable. If none is,
        // preserve the uncertainty until the existing private-temp TTL; an
        // I/O/validation error is not proof that all original bytes are gone.
        unreadable ??= error
      }
    }
    if (unreadable) throw unreadable
  }
  async write(id: string, binding: Binding, result: ProviderReceipt, expiresAt: number, signal?: AbortSignal) {
    const previous = await this.load(id, binding)
    if (previous) return previous
    const createdAt = Date.now()
    if (!Number.isFinite(expiresAt) || expiresAt <= createdAt) throw expired()
    await directory(this.root)
    await syncDirectory(dirname(this.root))
    const temp = join(this.root, `.${id}.tmp-${randomUUID()}`)
    this.writing.add(temp)
    let preserveTemporary = false
    try {
      await directory(temp)
      const images: ImageSource[] = []
      for (const [index, image] of result.images.entries()) {
        signal?.throwIfAborted()
        if (image.url.startsWith('data:')) {
          const artifact = await readImageArtifact(image, { signal, allowUrl: () => false, maxBytes: this.maxBytes })
          await this.putArtifact(temp, index, artifact, signal)
          images.push({ kind: 'inline', revisedPrompt: String(image.revisedPrompt || '') })
        } else {
          if (!/^https?:\/\//i.test(image.url)) throw problem('上游原图地址无效')
          images.push({ kind: 'remote', url: image.url, revisedPrompt: String(image.revisedPrompt || '') })
        }
      }
      const receipt: StoredImageReceipt = { version: 1, generationId: id, binding, createdAt, expiresAt,
        result: { usage: result.usage, upstreamModel: result.upstreamModel, upstreamRequestId: result.upstreamRequestId, upstreamStatus: result.upstreamStatus }, images }
      if (!images.length) throw problem('上游没有可保存的原图')
      const manifest = JSON.stringify(receipt)
      if (Buffer.byteLength(manifest) > 2 * 1024 * 1024) throw problem('原图暂存回执大小无效')
      // Even a failed file/directory sync can leave a complete readable
      // checkpoint. Recovery validates it before publishing; partial manifests
      // remain private and expire through the existing temporary-file TTL.
      preserveTemporary = true
      await writePrivate(join(temp, 'receipt.json'), manifest, signal)
      await syncDirectory(temp)
      this.checkLive(receipt); signal?.throwIfAborted()
      try { await rename(temp, this.path(id)); preserveTemporary = false; await syncDirectory(this.root) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        const winner = await this.load(id, binding)
        if (!winner) throw error
        preserveTemporary = false
        return winner
      }
      return receipt
    } finally {
      try { if (!preserveTemporary) await rm(temp, { recursive: true, force: true }) }
      finally { this.writing.delete(temp) }
    }
  }
  private async cached(path: string, index: number, signal?: AbortSignal): Promise<Artifact | undefined> {
    try {
      const images = await lstat(join(path, 'images'))
      if (!images.isDirectory() || images.isSymbolicLink()) throw problem('原图暂存目录无效')
    } catch (error) { if (error.code === 'ENOENT') return; throw error }
    const target = join(path, 'images', String(index))
    let info
    try { info = await lstat(target) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink()) throw problem('原图暂存目录无效')
    await regular(join(target, 'metadata.json'))
    const metadata = JSON.parse(await readFile(join(target, 'metadata.json'), 'utf8'))
    const content = join(target, 'content')
    const file = await regular(content)
    if (!Number.isSafeInteger(metadata.size) || metadata.size <= 0 || metadata.size > this.maxBytes || file.size !== metadata.size
      || typeof metadata.mime !== 'string' || !/^image\/(png|jpeg|webp|gif)$/.test(metadata.mime) || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw problem('暂存原图的完整性校验失败')
    const bytes = await readFile(content, { signal })
    if (bytes.length !== metadata.size || hash(bytes) !== metadata.sha256) throw problem('暂存原图的完整性校验失败')
    return { bytes, mime: metadata.mime }
  }
  private async putArtifact(path: string, index: number, artifact: Artifact, signal?: AbortSignal) {
    if (!artifact.bytes.length || artifact.bytes.length > this.maxBytes) throw problem('暂存原图大小无效')
    await directory(join(path, 'images'))
    const temp = join(path, 'images', `.${index}.tmp-${randomUUID()}`)
    await directory(temp)
    try {
      await writePrivate(join(temp, 'content'), artifact.bytes, signal)
      await writePrivate(join(temp, 'metadata.json'), JSON.stringify({ size: artifact.bytes.length, mime: artifact.mime, sha256: hash(artifact.bytes) }), signal)
      await syncDirectory(temp); signal?.throwIfAborted()
      try { await rename(temp, join(path, 'images', String(index))); await syncDirectory(join(path, 'images')) }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        const winner = await this.cached(path, index, signal)
        if (!winner || hash(winner.bytes) !== hash(artifact.bytes) || winner.mime !== artifact.mime) throw problem('暂存原图已变化，未覆盖现有文件')
      }
    } finally { await rm(temp, { recursive: true, force: true }) }
  }
  async artifact(receipt: StoredImageReceipt, index: number, readRemote: (url: string, signal?: AbortSignal) => Promise<Artifact>, signal?: AbortSignal) {
    signal?.throwIfAborted(); this.checkLive(receipt)
    if (!Number.isSafeInteger(index) || index < 0 || index >= receipt.images.length) throw problem('原图暂存序号无效')
    const path = this.path(receipt.generationId)
    const artifact = await this.cached(path, index, signal)
    if (artifact) return artifact
    const source = receipt.images[index]
    if (source.kind !== 'remote') throw problem('暂存原图缺失，请保留原任务等待核对')
    const received = await readRemote(source.url, signal)
    signal?.throwIfAborted(); this.checkLive(receipt)
    await this.putArtifact(path, index, received, signal)
    return received
  }
  async list(includeTemporary = false): Promise<string[]> {
    if (!await this.checkRoot()) return []
    try {
      return [...new Set((await readdir(this.root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
        .map(entry => validId(entry.name) ? entry.name : includeTemporary ? temporaryId(entry.name) : undefined)
        .filter((id): id is string => Boolean(id)))]
    }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  async remove(id: string) { if (await this.checkRoot()) await rm(this.path(id), { recursive: true, force: true }) }
  async expiredInvalid(id: string, ttlMs: number) {
    if (!await this.checkRoot()) return false
    let info
    try { info = await lstat(this.path(id)) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    return info.isDirectory() && !info.isSymbolicLink() && info.mtimeMs + ttlMs <= Date.now()
  }
  async pruneTemporary(ttlMs: number, active: (id: string) => boolean) {
    if (!await this.checkRoot()) return
    let entries
    try { entries = await readdir(this.root, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    const cutoff = Date.now() - Math.max(30_000, ttlMs)
    for (const entry of entries) {
      const id = temporaryId(entry.name)
      const path = join(this.root, entry.name)
      if (!id || !entry.isDirectory() || entry.isSymbolicLink() || this.writing.has(path) || active(id)) continue
      if ((await lstat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
    }
    for (const id of await this.list()) {
      if (active(id)) continue
      const images = join(this.path(id), 'images')
      let children
      try {
        const info = await lstat(images)
        if (!info.isDirectory() || info.isSymbolicLink()) continue
        children = await readdir(images, { withFileTypes: true })
      } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for (const entry of children) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.[0-9]+\.tmp-[a-f0-9-]{36}$/.test(entry.name)) continue
        const path = join(images, entry.name)
        if (!active(id) && (await lstat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true })
      }
    }
  }
}
