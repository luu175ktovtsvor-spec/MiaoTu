import { filterAsync } from './async-collections.ts'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { BLOB_DIRECTORY, alignMediaOwner, copyFileAtomic, ensureMediaDirectory, isReservedMediaDirectory, mediaRoot, validMediaOwner, writeFileAtomic } from './media-files.ts'

// 内容寻址的字节存储（CAS）。全系统只有这一处放字节：
//
//   <MEDIA_ROOT>/<userId>/_blobs/<sha256>    有账号归属的字节（工作区文件 + 该账号的生成结果）
//   <MEDIA_ROOT>/_blobs/<sha256>             没有账号归属的字节（guest 生成结果）
//
// 工作区索引（workspace_files.path）和生成结果（artifacts.id）都不再各自存一份字节，
// 只存一个 blob 哈希。路径由索引决定，字节由内容决定——同一份图片贴进 10 个节点，
// 盘上就只有一个 2.8MB 的文件、10 行索引。
//
// 为什么按账号分桶、不做跨账号去重：账号目录本来就是权限与归属的边界。跨账号去重会让
// 「这份字节别人是不是也有」变成可探测的（写一次、看盘上多没多就知道了），省下来的那点
// 空间不值得拿这个换。
//
// ---- 删除语义（这一层唯一需要想清楚的事）----
// 引用（索引行）没了不等于字节该删：画布上删掉一个节点，生成历史那条引用还在，
// 用户从历史里还要能找回来。活跃集合不存计数列，每次从两张表现查：
//
//   live(sha) = COUNT(workspace_files WHERE blob=sha) + COUNT(artifacts WHERE blob=sha)
//
// 计数列会漂移，查询不会。闭包性质是整套设计的安全底线：
//   **任何时刻「引用存在 ⇒ 字节存在」。**
// 写入永远先落 blob 再提交引用行；删除永远先删引用行再回收字节。两个方向都不能反。
export const BLOB_GC_GRACE_MS = 300_000

// ---- 布局标记 ----
// 这次迁移和发布是两件事，中间有时间差，这段时间两种布局都可能存在：
//   'path'（默认）—— 普通新建文件沿用 <账号>/<项目>/<路径>，允许个别文件使用 blob 行；
//   'blob'        —— 字节只在 _blobs/ 里，索引里的 path 不再对应磁盘文件。
// 实际读取以每行 blob/storage 为准；技能包、文件更新和桌面流式写入会单独发布 blob 行。
// 迁移脚本的 --apply 最后切换全局标记；回退不支持 blob 行的旧版本前，必须先执行
// --rollback 将所有 blob 行物化回路径树，不能只看全局标记仍为 path 就直接回退。
export const MEDIA_LAYOUT_PATH = 'path'
export const MEDIA_LAYOUT_BLOB = 'blob'

export async function ensureMediaLayout(store) {
  await store.run("CREATE TABLE IF NOT EXISTS media_layout(id INTEGER PRIMARY KEY CHECK(id=1),layout TEXT NOT NULL,updated_at TEXT NOT NULL)")
}

// 只读：只报账的入口（对账脚本、--report）会拿只读连接进来，这里不能建表。
// 表还不存在 = 从来没迁移过 = 路径树布局。
export async function mediaLayout(store) {
  try { return (await store.get('SELECT layout FROM media_layout WHERE id=1'))?.layout || MEDIA_LAYOUT_PATH } catch { return MEDIA_LAYOUT_PATH }
}

export async function setMediaLayout(store, layout) {
  if (![MEDIA_LAYOUT_PATH, MEDIA_LAYOUT_BLOB].includes(layout)) throw new Error(`未知的媒体布局：${layout}`)
  await ensureMediaLayout(store)
  await store.run('INSERT INTO media_layout(id,layout,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET layout=excluded.layout,updated_at=excluded.updated_at', layout, new Date().toISOString())
  return layout
}

export const isBlobHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex')

// 桶目录。userId 为空 = 没有账号归属，落在媒体根下的保留目录里。
export function blobDirectory(userId) {
  const id = String(userId || '')
  if (!id) return join(mediaRoot(), BLOB_DIRECTORY)
  if (!validMediaOwner(id)) throw new Error('账号 id 无效')
  return join(mediaRoot(), id, BLOB_DIRECTORY)
}

export function blobPath(userId, sha) {
  if (!isBlobHash(sha)) throw new Error('blob 哈希无效')
  return join(blobDirectory(userId), sha)
}

const statOrNull = absolute => { try { const info = lstatSync(absolute); return info.isFile() ? info : null } catch { return null } }

export class BlobStore {
  declare store: any

  // store 只需要 get/all/run/transaction（ManagementStore 或迁移脚本里的同形对象）。
  constructor(store) { this.store = store }

  // ---- 引用计数（唯一的权威来源）----

  // 表或列还不存在时按 0 处理：那种库里根本不可能有 blob 引用，删字节也就无从谈起。
  async referenced(table, sha, userId?: string) {
    try {
      if (userId === undefined) return Number((await this.store.get(`SELECT COUNT(*) AS n FROM ${table} WHERE blob=?`, sha))?.n || 0)
      return Number((table === 'workspace_files'
        ? (await this.store.get('SELECT COUNT(*) AS n FROM workspace_files WHERE blob=? AND user_id=?', sha, userId))
        : (await this.store.get("SELECT COUNT(*) AS n FROM artifacts a JOIN generations g ON g.id=a.request_id WHERE a.blob=? AND COALESCE(g.user_id,'')=?", sha, userId)))?.n || 0)
    } catch (error) {
      // An older schema cannot own blob references. A lock/read failure cannot
      // establish that the reference count is zero, so collection must stop.
      if (/no such (table|column)/i.test(error.message || '')) return 0
      throw error
    }
  }

  async liveCount(sha, userId?: string) {
    return (await this.referenced('workspace_files', sha, userId)) + (await this.referenced('artifacts', sha, userId))
  }

  // ---- 写 ----

  // 落一份字节，返回它的哈希。同内容第二次写**一个字节都不落**：直接复用已有的 blob。
  // 复用时要 touch 一下 mtime——这不是顺手，是并发安全的一部分，见 release()。
  put(userId, bytes) {
    const content = Buffer.from(bytes)
    const sha = hashBytes(content)
    const target = blobPath(userId, sha)
    ensureMediaDirectory(blobDirectory(userId))
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info = statOrNull(target)
      if (!info) { writeFileAtomic(target, content); return sha }
      // 同名不同长度只可能是哈希碰撞或盘上文件坏了。宁可让这次写入失败，也不能把
      // 一份对不上的字节当成「已经存过了」发出去。
      if (info.size !== content.length) throw new Error(`blob 已存在但长度不符（${target}：盘上 ${info.size} 字节 / 本次 ${content.length} 字节），请先跑 node server/media-reconcile.ts --verify-hashes`)
      try { utimesSync(target, new Date(), new Date()) } catch { /* 刚好被回收掉了，下一轮会重新写 */ }
      if (statOrNull(target)) return sha
    }
    throw new Error(`blob 写入反复失败：${target}`)
  }

  // Snapshot a mutable path file before publishing it as immutable content.
  // Native copying can clone filesystem blocks; hashing uses a bounded buffer.
  // Keep the source inode separate: an editor holding it open must not be able
  // to change the new blob after the workspace index commits.
  // The caller holds the database write transaction through index publication.
  putFile(userId, source) {
    const before = lstatSync(source)
    if (!before.isFile()) throw Object.assign(new Error('来源不是普通文件'), { status: 409 })
    const directory = blobDirectory(userId)
    ensureMediaDirectory(directory)
    const temp = join(directory, 'import.tmp-' + randomUUID())
    try {
      copyFileAtomic(source, temp)
      const descriptor = openSync(temp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const hash = createHash('sha256')
      let size
      try {
        size = fstatSync(descriptor).size
        const buffer = Buffer.allocUnsafe(Math.min(size, 1024 * 1024))
        let offset = 0
        while (offset < size) {
          const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset)
          if (!count) throw Object.assign(new Error('来源文件读取不完整'), { status: 409 })
          hash.update(buffer.subarray(0, count)); offset += count
        }
      } finally { closeSync(descriptor) }
      const after = lstatSync(source)
      if (size !== before.size || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw Object.assign(new Error('来源文件已改变，请重新操作'), { status: 409 })
      const blob = hash.digest('hex')
      this.linkFromFile(userId, temp, blob, { copyFallback: true })
      return { blob, size }
    } finally {
      try { rmSync(temp, { force: true }) }
      catch (error) { console.warn('[blob] 临时副本清理失败', error?.code || 'unknown') }
    }
  }

  // 把已经在盘上的字节挂进 blob 桶，来源必须已关闭且不再修改。
  // 默认只硬链接，保留迁移不复制、不额外占空间的约定。
  //   'linked' —— 桶里原来没有，挂了第一个链接进来（源仍然在，等回收阶段再删）
  //   'reused' —— 桶里已经有同一份内容了，源可以直接删（省下来的空间就是这里来的）
  //   'copied' —— 显式允许回退且硬链接不可用，已原子复制，源仍保留
  // 实时写入显式允许在不支持硬链接的文件系统上原子复制。
  linkFromFile(userId, source, sha, { copyFallback = false } = {}) {
    if (!isBlobHash(sha)) throw new Error('blob 哈希无效')
    const target = blobPath(userId, sha)
    ensureMediaDirectory(blobDirectory(userId))
    const info = statOrNull(target)
    if (info) {
      const sourceSize = statSync(source).size
      if (info.size !== sourceSize) throw new Error(`blob 已存在但长度不符（${target}：盘上 ${info.size} / 来源 ${sourceSize}）`)
      return 'reused'
    }
    try { linkSync(source, target) }
    catch (error) {
      if (!copyFallback || !['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(error.code)) throw error
      copyFileAtomic(source, target)
      return 'copied'
    }
    alignMediaOwner(target)
    return 'linked'
  }

  // ---- 读 ----

  stat(userId, sha) {
    if (!isBlobHash(sha)) return null
    const info = statOrNull(blobPath(userId, sha))
    return info ? { size: info.size, mtimeMs: info.mtimeMs, nlink: info.nlink, full: blobPath(userId, sha) } : null
  }

  exists(userId, sha) { return Boolean(this.stat(userId, sha)) }

  // 索引里有、盘上没有 = 数据丢失。调用方按「这张图没了」处理（对外仍是 404 / 410），
  // 真正要人管的是 media-reconcile 报出来的那一类。
  read(userId, sha) {
    const info = this.stat(userId, sha)
    return info ? readFileSync(info.full) : null
  }

  // ---- 删 ----

  // 直接 unlink，不看引用。只给两个调用方用：迁移的回收阶段、对账的 --fix（都已自己确认过）。
  remove(userId, sha) {
    try {
      rmSync(blobPath(userId, sha), { force: true })
      return true
    } catch (error) {
      console.warn(`[blob] 删除失败，留给对账回收：${blobPath(userId, sha)} ${error?.message || error}`)
      return false
    }
  }

  // 删完引用之后调用：活跃集合为空、且不在宽限期内，才真正回收。
  //
  // 宽限期挡的是这个竞态（真出现过，不是设想）：admin 进程的 recoverStale 和 image API
  // 会同时动同一批 blob。写入方的顺序是「落 blob（或发现已存在）→ 提交引用行」，
  // 两步之间引用列的计数还是 0，回收方这时看到的「没人用」是假象。
  //   1. 新落的 blob：mtime 是刚刚 → 宽限期内，不删；
  //   2. 复用已有 blob 的（常见情况！）：写入方在复用时会 touch 一次 mtime（见 put），
  //      所以同样落在宽限期内。少了那个 touch，一个用了三个月的旧 blob 会被误删。
  // 宽限期之外还有对账兜底：先扫盘、后查活跃集合，扫描之后才出现的 blob 根本不在候选集里。
  async release(userId, sha, { graceMs = BLOB_GC_GRACE_MS, force = false }: Record<string, any> = {}) {
    if (!isBlobHash(sha)) return false
    return this.store.transaction(async () => {
      await this.store.db.lock(`media:${userId}`)
      if (await this.liveCount(sha, userId) > 0) return false
      const info = this.stat(userId, sha)
      if (!info || !force && Date.now() - info.mtimeMs < graceMs) return false
      return this.remove(userId, sha)
    })
  }

  // ---- 扫盘（对账与回收用）----

  // 媒体根下的所有桶：每个账号目录下的 _blobs/，加上根级的 _blobs/。
  // 返回 [{ userId, directory }]，userId 为 '' 表示根级桶。
  buckets() {
    const found = []
    const rootBlobs = join(mediaRoot(), BLOB_DIRECTORY)
    if (existsSync(rootBlobs)) found.push({ userId: '', directory: rootBlobs })
    let entries = []
    try { entries = readdirSync(mediaRoot(), { withFileTypes: true }) } catch { return found }
    for (const entry of entries) {
      if (!entry.isDirectory() || isReservedMediaDirectory(entry.name) || entry.name.startsWith('.')) continue
      const directory = join(mediaRoot(), entry.name, BLOB_DIRECTORY)
      if (existsSync(directory)) found.push({ userId: entry.name, directory })
    }
    return found
  }

  // 一个桶里的全部 blob（软链不跟随、不统计：写作从不产生软链，出现了就该人工看）。
  // 名不是 64 位十六进制的普通文件会被单独报出来（tmp 残留、手放进去的东西）。
  list(userId) {
    const directory = blobDirectory(userId)
    let entries = []
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return { blobs: [], strays: [] } }
    const blobs = []
    const strays = []
    for (const entry of entries) {
      const full = join(directory, entry.name)
      let info
      try { info = lstatSync(full) } catch { continue }
      if (info.isSymbolicLink() || !info.isFile()) continue
      if (!isBlobHash(entry.name)) { strays.push({ path: entry.name, full, size: info.size }); continue }
      blobs.push({ sha: entry.name, full, size: info.size, mtimeMs: info.mtimeMs, nlink: info.nlink })
    }
    return { blobs, strays }
  }

  // 对账 --fix 的回收：先扫盘、后查活跃集合（顺序不能反），再逐条按宽限期判断。
  // 持写锁跑，让「查活跃集合 → 删」之间没有其他库写入者插进来。
  async sweep({ graceMs = BLOB_GC_GRACE_MS, apply = false, live }: Record<string, any> = {}) {
    const candidates = []
    for (const bucket of this.buckets()) {
      for (const blob of this.list(bucket.userId).blobs) candidates.push({ userId: bucket.userId, ...blob })
    }
    candidates.sort((a,b) => String(a.userId).localeCompare(String(b.userId)) || a.sha.localeCompare(b.sha))
    const isLive = live || (async sha => (await this.liveCount(sha)) > 0)
    const orphans = (await filterAsync(candidates, async item => !(await isLive(item.sha))))
    const fresh = orphans.filter(item => Date.now() - item.mtimeMs < graceMs)
    const reclaimable = orphans.filter(item => Date.now() - item.mtimeMs >= graceMs)
    if (!apply) return { candidates, orphans, fresh, reclaimable, removed: 0, removedBytes: 0 }
    let removed = 0
    let removedBytes = 0
    await this.store.transaction(async () => {
      for (const item of reclaimable) {
        // 事务里再确认一次：扫盘之后可能有别处刚认领了它。
        await this.store.db.lock(`media:${item.userId}`)
        if ((await this.liveCount(item.sha)) > 0) continue
        // 扫描后、取得写锁前，上传可能复用了旧 blob 并 touch；再次确认宽限期。
        const current = this.stat(item.userId, item.sha)
        if (!current || Date.now() - current.mtimeMs < graceMs) continue
        if (this.remove(item.userId, item.sha)) { removed += 1; removedBytes += item.size }
      }
    })
    return { candidates, orphans, fresh, reclaimable, removed, removedBytes }
  }
}
