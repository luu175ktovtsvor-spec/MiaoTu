import { createHash, randomUUID } from 'node:crypto'
import { chownSync, constants, copyFileSync, createWriteStream, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { IncomingMessage } from 'node:http'
import { finished, Transform, type Readable } from 'node:stream'
import { finished as streamFinished, pipeline } from 'node:stream/promises'
import lockfile from 'proper-lockfile'

// The writer and collector must use the same lease timing. A stalled lease
// aborts the receive; a crashed writer can be reclaimed after it expires.
export const MEDIA_WRITE_LOCK_OPTIONS = Object.freeze({ realpath: false, stale: 5 * 60_000, update: 30_000, retries: 0 })
export const isMediaImport = path => /\.import-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(path)

// One bounded receive/hash path for desktop originals and hosted transit media.
// Publish only after the stream finishes; every normal failure removes its temp.
export async function withStreamedMedia<T>(
  stream: Readable,
  { path, signal, maxBytes = Infinity, mode = 0o600 }: { path: string; signal?: AbortSignal; maxBytes?: number; mode?: number },
  commit: (content: { path: string; size: number; sha256: string }, signal: AbortSignal) => T | Promise<T>,
) {
  const temp = path + '.import-' + randomUUID()
  const lease = new AbortController()
  signal = signal ? AbortSignal.any([signal, lease.signal]) : lease.signal
  let release: (() => void) | undefined
  let size = 0
  try {
    signal?.throwIfAborted()
    release = lockfile.lockSync(temp, { ...MEDIA_WRITE_LOCK_OPTIONS, onCompromised: error => lease.abort(error) })
    const hash = createHash('sha256')
    const digest = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > maxBytes) { done(Object.assign(new Error('单个文件不能超过 200MB'), { status: 413 })); return }
      hash.update(chunk); done(null, chunk)
    } })
    // Do not destroy an HTTP socket on a size/disk error: the handler still
    // needs to return its 413/500 response. The sender can then stop uploading.
    // Own only the hash/disk pipeline; an input iterator can wait for the next
    // request chunk after a disk error and hold the error response open.
    const output = createWriteStream(temp, { flags: 'wx', mode })
    if (stream instanceof IncomingMessage) {
      const receiving = pipeline(digest, output, { signal })
      const cleanup = finished(stream, { readable: true, writable: false }, error => { if (error) digest.destroy(error) })
      try { stream.pipe(digest); await receiving }
      finally { stream.unpipe(digest); cleanup() }
    } else await pipeline(stream, digest, output, { signal })
    signal?.throwIfAborted()
    // Async probes/remuxes still hold this lease. They must receive its abort
    // signal too, so losing the lock cannot publish after the receive finished.
    return await commit({ path: temp, size, sha256: hash.digest('hex') }, signal)
  } catch (error) {
    if (stream instanceof IncomingMessage && !stream.destroyed) stream.resume()
    else if (!(stream instanceof IncomingMessage)) {
      const closed = streamFinished(stream, { cleanup: true }).catch(() => {})
      stream.destroy()
      await closed
    }
    throw error
  } finally {
    try { rmSync(temp, { force: true }) }
    catch (error) { console.warn('[media] 临时文件清理失败', error?.code || 'unknown') }
    try { release?.() }
    catch (error) {
      // proper-lockfile has already retired a compromised lease.
      if (!(lease.signal.aborted && error?.code === 'ERELEASED')) console.warn('[media] 临时写入锁释放失败', error?.code || 'unknown')
    }
  }
}

// 媒体字节落盘这一层的公共约定，workspace_files / artifacts / blob-store 共用同一份实现，
// 免得出现两套根目录、两套权限、两套原子写。
//
// 磁盘布局（内容寻址之后，2026-10-06 起）：
//   <MEDIA_ROOT>/<userId>/_blobs/<sha256>   唯一的字节落点（工作区文件与生成结果都只引用它）
//   <MEDIA_ROOT>/_blobs/<sha256>            没有账号归属的字节（guest 生成结果）
//   <MEDIA_ROOT>/_artifacts/<artifactId>    迁移前的生成结果字节缓存，迁移后清空（常量留给回滚与对账）
//   <MEDIA_ROOT>/.agent-sessions/<userId>/  Agent SDK 的会话文件，不属于工作区
// 工作区索引里的 path 不再对应磁盘上的文件——盘上只有 blob，路径由索引解析。
//
// 保留目录（下划线/点开头）与 userId（UUID）、projectId（首字符必须是字母数字）都不可能撞名。
// 名单只在这一处定义：对账、路径校验、项目 id 校验全都从这里取，不会再出现「新增一个保留目录、
// 有一处忘了排除」的情况（.agent-sessions 就被对账当成账号目录走过一轮）。
export const ARTIFACT_DIRECTORY = '_artifacts'
export const BLOB_DIRECTORY = '_blobs'
export const PREVIEW_DIRECTORY = '_previews'
export const AGENT_SESSION_DIRECTORY = '.agent-sessions'
export const IMAGE_RECEIPT_DIRECTORY = '.image-receipts'
export const RESERVED_MEDIA_DIRECTORIES = Object.freeze([ARTIFACT_DIRECTORY, BLOB_DIRECTORY, PREVIEW_DIRECTORY, AGENT_SESSION_DIRECTORY, IMAGE_RECEIPT_DIRECTORY])
export const isReservedMediaDirectory = value => RESERVED_MEDIA_DIRECTORIES.includes(String(value || ''))

// MEDIA_ROOT 优先读 OIP_MEDIA_ROOT（兼容 MEDIA_ROOT），否则从 OIP_DATA_DIR 推导。
export function mediaRoot() {
  const explicit = String(process.env.OIP_MEDIA_ROOT || process.env.MEDIA_ROOT || '').trim()
  if (explicit) return resolve(explicit)
  return resolve(process.env.OIP_DATA_DIR ? join(process.env.OIP_DATA_DIR, 'media') : 'data/media')
}

// 账号目录名（也就是 blob 桶名）的校验：它会变成一段路径和一个保留名。
// 空串是合法的「没有账号归属」，由调用方决定落到哪个桶。
export function validMediaOwner(value) {
  const id = String(value || '')
  return Boolean(id) && id.length <= 200 && id !== '.' && id !== '..' && !isReservedMediaDirectory(id) && !/^[.]/.test(id) && !/[\\/\0]/.test(id)
}

// 磁盘权限：默认只给属主（同机其他账号读不到别人的素材）。
// 但 X-Accel-Redirect 是 nginx 的 worker（通常是 www-data）去读文件，它既不是属主也不在属主组里，
// 0700/0600 会让直出变成 403。要让直出可用，在服务端设 OIP_MEDIA_MODE=group：
// 目录放宽到 0750、文件放宽到 0640，再把 nginx 用户加进 node 的组（gid 1000）——
// 只放开同组，不是 0755/0644，别人的素材仍然不对外可读。
export function mediaPermissions() {
  return String(process.env.OIP_MEDIA_MODE || '').trim().toLowerCase() === 'group'
    ? { directory: 0o750, file: 0o640 }
    : { directory: 0o700, file: 0o600 }
}

// 以 root 跑一次性脚本时（docker exec / docker run），新建的文件属主会变成 root:root；
// nginx 的 worker 既不是属主也不在根组里，直出立刻变 403——素材在、打不开，最难查的一类事故。
// 与其让每个脚本自己在写完之后 chown（写过一次就会漏一次），不如让落盘层统一对齐媒体根的属主属组：
// 谁来跑都不会写出「服务端能读、nginx 读不到」的文件。非 root 身份下是空操作。
export function alignMediaOwner(absolute) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return
  try {
    const root = statSync(mediaRoot())
    chownSync(absolute, root.uid, root.gid)
  } catch (error) {
    console.warn(`[media] 对齐属主失败（文件已写好，nginx 可能读不到，交给对账核对）：${absolute} ${error?.message || error}`)
  }
}

// 只修本次新建目录的归属，不触碰既有目录；每一层先检查再创建，禁止沿软链写出媒体根。
export function ensureMediaDirectory(absolute) {
  const root = mediaRoot()
  const target = resolve(absolute)
  const within = relative(root, target)
  const invalid = () => Object.assign(new Error('媒体目录路径无效'), { status: 422 })
  if (within === '..' || within.startsWith(`..${sep}`) || resolve(root, within) !== target) throw invalid()
  // 根目录由部署提供属主；全新根不存在时只能保持调用者的属主，不能猜测服务用户。
  mkdirSync(root, { recursive: true, mode: mediaPermissions().directory })
  const check = path => {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid()
  }
  check(root)
  let current = root
  for (const part of within ? within.split(sep) : []) {
    current = join(current, part)
    try { check(current) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      let created = false
      try { mkdirSync(current, { mode: mediaPermissions().directory }); created = true } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError
      }
      check(current)
      if (created) alignMediaOwner(current)
    }
  }
  return target
}

// 先写同目录临时文件再 rename 覆盖：同盘 rename 是原子的，读到的永远是完整文件。
export function writeFileAtomic(absolute, bytes) {
  const temp = `${absolute}.tmp-${randomUUID()}`
  try {
    writeFileSync(temp, bytes, { mode: mediaPermissions().file })
    alignMediaOwner(temp)
    renameSync(temp, absolute)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 残留的临时文件交给 media-reconcile 回收 */ }
    throw error
  }
}

export function copyFileAtomic(source, absolute) {
  const temp = `${absolute}.tmp-${randomUUID()}`
  try {
    copyFileSync(source, temp, constants.COPYFILE_FICLONE)
    // copyFileSync 会照搬源文件权限，这里按当前档位统一一次（源可能是迁移前留下的）。
    chmodSync(temp, mediaPermissions().file)
    alignMediaOwner(temp)
    renameSync(temp, absolute)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* 同上 */ }
    throw error
  }
}

// ---- 生成结果（artifacts）的旧字节缓存 ----
// 迁移到内容寻址之后这里不再写新字节，目录会被清空。这几函数留给两处用：
// 迁移脚本的 --rollback（把字节放回老位置）和对账（识别残留的旧字节）。

export function validArtifactId(value) {
  const id = String(value || '')
  return Boolean(id) && id.length <= 200 && id !== '.' && id !== '..' && !/[\\/\0]/.test(id)
}

export function artifactDirectory() {
  return join(mediaRoot(), ARTIFACT_DIRECTORY)
}

export function artifactPath(id) {
  if (!validArtifactId(id)) throw new Error('生成结果 id 无效')
  return join(artifactDirectory(), String(id))
}

export function writeArtifactFile(id, bytes) {
  ensureMediaDirectory(artifactDirectory())
  writeFileAtomic(artifactPath(id), bytes)
}

// 文件不存在返回 null，调用方按“这张图没了”处理（对外仍是 410，与过期一致）。
export function readArtifactFile(id) {
  try { return readFileSync(artifactPath(id)) } catch { return null }
}

// 尽力而为：删不掉只记日志，交给 media-reconcile 回收，不阻塞调用方。
export function removeArtifactFile(id) {
  try {
    rmSync(artifactPath(id), { force: true })
    return true
  } catch (error) {
    console.warn(`[artifacts] 删除磁盘文件失败，留给对账回收：id=${id} ${error?.message || error}`)
    return false
  }
}

// 给对账脚本用：列出磁盘上所有结果文件（软链不跟随、不统计）。
export function listArtifactFiles() {
  let entries
  try { entries = readdirSync(artifactDirectory(), { withFileTypes: true }) } catch { return [] }
  const found = []
  for (const entry of entries) {
    const full = join(artifactDirectory(), entry.name)
    try {
      const info = lstatSync(full)
      if (info.isSymbolicLink() || !info.isFile()) continue
      found.push({ id: entry.name, full, size: info.size })
    } catch { /* 刚好被删掉，跳过 */ }
  }
  return found
}
