import { constants, chmodSync, closeSync, copyFileSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'

const validId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
const problem = (code: string) => Object.assign(new Error('回收站备份已变化或暂时不可用，原文件已保留'), { code, status: 503 })
type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
type DirectoryIdentity = Pick<Identity, 'dev' | 'ino'>
type Marker = { version: 1; id: string } & (
  { kind: 'directory'; directory: DirectoryIdentity; file?: Identity } | { kind: 'legacy'; file: Identity }
)
type Descriptor = { id: string; kind: Marker['kind']; backup: string; marker: string; directory?: string }
type Snapshot = { root: Stats; marker: Stats; bytes: string; file?: Stats; directory?: Stats }
export type TrashBackupSource = Uint8Array | { diskPath?: string | null; bytes?: Uint8Array | null }
export type TrashCleanupResult = { removed: number; pending: number; failed: number }
const identity = (info: Stats): Identity => ({ dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs })
const sameDirectory = (a: DirectoryIdentity, b: DirectoryIdentity) => a.dev === b.dev && a.ino === b.ino
const sameFile = (a: Identity, b: Identity) => sameDirectory(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
const validIdentity = (value: unknown, directory = false): value is Identity => Boolean(value && typeof value === 'object'
  && (directory ? ['dev', 'ino'] : ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']).every(key => Number.isFinite(value[key])))
const stat = (path: string) => { try { return lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return; throw error } }

function sync(path: string, directory = false) {
  let fd: number | undefined, failed = false
  try { fd = openSync(path, directory ? 'r' : 'r+'); fsyncSync(fd) }
  catch (error) {
    // Directory flushing is unsupported on some Windows/filesystem versions.
    // A marker file's own fsync is mandatory and never takes this exception.
    if (!directory || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) { failed = true; throw error }
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch (error) { if (!failed) throw error } }
  }
}

// Only an explicitly created marker grants cleanup authority. Unmarked legacy
// files may be the sole surviving original after an old failure; leave them.
export class TrashBackups {
  readonly root: string
  private readers = new Map<string, number>()
  constructor(directory: string) { this.root = join(resolve(directory), 'trash') }
  path(id: string) { return this.descriptor(id, 'directory').backup }
  private descriptor(id: string, kind: Marker['kind']): Descriptor {
    if (!validId(id)) throw problem('TRASH_BACKUP_ID_INVALID')
    return kind === 'directory'
      ? { id, kind, backup: join(this.root, id, 'content'), marker: join(this.root, id, 'cleanup.json'), directory: join(this.root, id) }
      : { id, kind, backup: join(this.root, id), marker: join(this.root, `.${id}.cleanup.json`) }
  }
  private fromPath(path: string): Descriptor {
    for (const part of path.split(/[\\/]/)) if (validId(part)) {
      for (const kind of ['directory', 'legacy'] as const) {
        const entry = this.descriptor(part, kind)
        if (entry.backup === path) return entry
      }
    }
    throw problem('TRASH_BACKUP_PATH_INVALID')
  }
  private rootInfo(create = false) {
    if (create) mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const info = stat(this.root)
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw problem('TRASH_BACKUP_ROOT_INVALID')
    return info
  }
  private writeMarker(path: string, value: Marker, previous?: Stats, created?: () => void) {
    const fd = openSync(path, previous ? constants.O_RDWR | (constants.O_NOFOLLOW || 0) : 'wx', 0o600)
    if (!previous) created?.()
    let failed = false
    try {
      const current = fstatSync(fd)
      if (!current.isFile() || previous && !sameFile(previous, current)) throw problem('TRASH_BACKUP_MARKER_CHANGED')
      const bytes = Buffer.from(JSON.stringify(value))
      writeFileSync(fd, bytes); ftruncateSync(fd, bytes.length); fsyncSync(fd)
    }
    catch (error) { failed = true; throw error }
    finally { try { closeSync(fd) } catch (error) { if (!failed) throw error } }
  }
  create(id: string, source: TrashBackupSource) {
    this.rootInfo(true)
    const entry = this.descriptor(id, 'directory')
    // A fresh exclusive directory makes even an interrupted partial copy ours;
    // an unrelated existing UUID path can never acquire a cleanup marker here.
    mkdirSync(entry.directory!, { mode: 0o700 })
    const directory = lstatSync(entry.directory!)
    const marker: Marker = { version: 1, id, kind: 'directory', directory: { dev: directory.dev, ino: directory.ino } }
    let markerOwned = false
    try {
      this.writeMarker(entry.marker, marker, undefined, () => { markerOwned = true })
      sync(entry.directory!, true); sync(this.root, true)
    } catch (error) {
      // No copy was started. Remove only the exact files in our fresh directory;
      // a cleanup error must neither recurse into unknown content nor mask it.
      if (markerOwned) { try { unlinkSync(entry.marker) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.warn('[desktop-trash] MARKER_PREPARE_CLEANUP_FAILED', cleanupError.code || 'UNKNOWN') } }
      try { rmdirSync(entry.directory!) } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.warn('[desktop-trash] EMPTY_DIRECTORY_CLEANUP_FAILED', cleanupError.code || 'UNKNOWN') }
      throw error
    }
    const preparedMarker = lstatSync(entry.marker)
    if (!(source instanceof Uint8Array) && source.diskPath) copyFileSync(source.diskPath, entry.backup, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
    else writeFileSync(entry.backup, source instanceof Uint8Array ? source : source.bytes!, { flag: 'wx', mode: 0o600 })
    chmodSync(entry.backup, 0o600)
    sync(entry.backup)
    const file = lstatSync(entry.backup)
    if (!file.isFile() || file.isSymbolicLink()) throw problem('TRASH_BACKUP_FILE_INVALID')
    // Until this durable identity is complete, a surviving file is preserved.
    // Directory ownership alone cannot authorize deleting a later replacement.
    this.writeMarker(entry.marker, { ...marker, file: identity(file) }, preparedMarker)
    sync(entry.directory!, true)
    return entry.backup
  }
  retain(id: string, path: string) {
    const entry = this.fromPath(path)
    if (entry.id !== id) throw problem('TRASH_BACKUP_ID_INVALID')
    this.rootInfo()
    if (entry.kind === 'legacy' && !stat(entry.marker)) {
      const file = lstatSync(entry.backup)
      if (!file.isFile() || file.isSymbolicLink()) throw problem('TRASH_BACKUP_FILE_INVALID')
      this.writeMarker(entry.marker, { version: 1, id, kind: 'legacy', file: identity(file) })
      sync(this.root, true)
    }
    const current = this.inspect(entry)
    if (!current?.file) throw problem('TRASH_BACKUP_FILE_MISSING')
    // Registration and reader retention are synchronous, before opening the
    // source stream or awaiting a restore. Parallel restores retain separately.
    this.readers.set(path, (this.readers.get(path) || 0) + 1)
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      const remaining = (this.readers.get(path) || 1) - 1
      if (remaining) this.readers.set(path, remaining); else this.readers.delete(path)
    }
  }
  private inspect(entry: Descriptor): Snapshot | undefined {
    const root = this.rootInfo()
    if (!root) return
    let directory: Stats | undefined
    if (entry.directory) {
      directory = stat(entry.directory)
      if (!directory) return
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw problem('TRASH_BACKUP_DIRECTORY_INVALID')
    }
    const marker = stat(entry.marker)
    if (!marker) return
    if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 4096) throw problem('TRASH_BACKUP_MARKER_INVALID')
    const fd = openSync(entry.marker, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    let bytes: string
    try {
      if (!sameFile(marker, fstatSync(fd))) throw problem('TRASH_BACKUP_MARKER_CHANGED')
      bytes = readFileSync(fd, 'utf8')
    } finally { closeSync(fd) }
    const value = JSON.parse(bytes) as Marker
    if (value?.version !== 1 || value.id !== entry.id || value.kind !== entry.kind
      || value.kind === 'directory' && (!validIdentity(value.directory, true) || !sameDirectory(value.directory, directory!))
      || value.kind === 'legacy' && !validIdentity(value.file)) throw problem('TRASH_BACKUP_MARKER_INVALID')
    if (entry.directory && readdirSync(entry.directory).some(name => !['content', 'cleanup.json'].includes(name))) throw problem('TRASH_BACKUP_UNKNOWN_CONTENT')
    const file = stat(entry.backup)
    if (file && (!file.isFile() || file.isSymbolicLink())) throw problem('TRASH_BACKUP_FILE_INVALID')
    if (file && (!validIdentity(value.file) || !sameFile(value.file, file))) throw problem('TRASH_BACKUP_CHANGED')
    return { root, directory, marker, bytes, file }
  }
  private entries(paths?: readonly string[]) {
    if (paths) return [...new Map(paths.map(path => { const entry = this.fromPath(path); return [entry.marker, entry] as const })).values()]
    if (!this.rootInfo()) return []
    return readdirSync(this.root, { withFileTypes: true }).flatMap(entry => {
      const name = entry.name
      if (validId(name) && entry.isDirectory() && !entry.isSymbolicLink()) return [this.descriptor(name, 'directory')]
      const id = /^\.([a-f0-9-]+)\.cleanup\.json$/.exec(name)?.[1]
      return id && validId(id) ? [this.descriptor(id, 'legacy')] : []
    })
  }
  sweep({ referenced, locked }: { referenced(path: string): boolean; locked<T>(operation: () => T): T }, paths?: readonly string[]): TrashCleanupResult {
    const result = { removed: 0, pending: 0, failed: 0 }
    const failed = (error: unknown) => {
      result.failed++
      const code = typeof error?.['code'] === 'string' && /^[A-Z0-9_]+$/.test(error['code']) ? error['code'] : 'UNKNOWN'
      console.warn('[desktop-trash] BACKUP_CLEANUP_PENDING', code)
    }
    let entries: Descriptor[]
    try { entries = this.entries(paths) } catch (error) { failed(error); return result }
    for (const entry of entries) {
      try {
        const before = this.inspect(entry)
        if (!before) continue
        const removed = locked(() => {
          if (this.readers.has(entry.backup) || referenced(entry.backup)) return false
          const current = this.inspect(entry)
          if (!current) return true
          if (!sameDirectory(before.root, current.root) || before.bytes !== current.bytes || !sameFile(before.marker, current.marker)
            || Boolean(before.file) !== Boolean(current.file) || before.file && !sameFile(before.file, current.file!)
            || before.directory && (!current.directory || !sameDirectory(before.directory, current.directory))) throw problem('TRASH_BACKUP_CHANGED')
          if (current.file) unlinkSync(entry.backup)
          if (stat(entry.backup)) throw problem('TRASH_BACKUP_CHANGED')
          unlinkSync(entry.marker)
          if (entry.directory) rmdirSync(entry.directory)
          return true
        })
        if (removed) result.removed++; else result.pending++
      } catch (error) { failed(error) }
    }
    return result
  }
}
