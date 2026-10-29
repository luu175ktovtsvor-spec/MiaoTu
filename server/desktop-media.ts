import { forEachAsync } from './async-collections.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { createReferenceUrl, isReferenceMediaMime, REFERENCE_TTL_MS, verifyReferenceToken } from './reference-assets.ts'
import { validRequestId } from './generation-contract.ts'
import { DEFAULT_PROJECT_ID } from './workspace-scope.ts'
import { mediaPermissions, withStreamedMedia } from './media-files.ts'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-files.ts'
import { releasedDesktopImageInputs, RELEASED_DESKTOP_IMAGE_INPUTS_SQL } from './desktop-input-retention.ts'

const prefix = 'desktop-transfers/'
const failure = (message, status = 422) => Object.assign(new Error(message), { status })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receiptHash = items => hash(JSON.stringify([...items].sort((a, b) => a.id.localeCompare(b.id))))

async function ensureOutputSchema(store) {
  await store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_media_outputs(user_id TEXT NOT NULL,request_id TEXT NOT NULL,path TEXT NOT NULL,revision TEXT NOT NULL,blob TEXT,PRIMARY KEY(user_id,path));
    CREATE INDEX IF NOT EXISTS desktop_media_output_request ON desktop_media_outputs(user_id,request_id);`)
}

// The file index and this ownership receipt must commit together. A directory
// name or an unrelated file beneath it is never evidence of protocol ownership.
export async function recordDesktopMediaOutput(store, userId, requestId, file, project = DEFAULT_PROJECT_ID) {
  if (!store.db?.isTransaction) throw failure('桌面暂存文件须与归属一起保存', 409)
  if (project !== DEFAULT_PROJECT_ID || !validRequestId(requestId) || typeof file?.revision !== 'string' || !file.revision
    || typeof file?.path !== 'string' || !file.path.startsWith(`desktop-delivery/${requestId}/`)) throw failure('桌面暂存文件归属无效', 409)
  const row = (await store.get('SELECT parameters FROM generations WHERE user_id=? AND request_id=?', userId, requestId))
  const parameters = JSON.parse(row?.parameters || '{}')
  if (parameters.desktopDelivery !== 1 || parameters.desktopDeliveredAt || parameters.desktopMediaExpiredAt) throw failure('桌面暂存任务已结束', 409)
  await ensureOutputSchema(store)
  await store.run('INSERT INTO desktop_media_outputs(user_id,request_id,path,revision,blob) VALUES(?,?,?,?,?) ON CONFLICT(user_id,path) DO UPDATE SET request_id=excluded.request_id,revision=excluded.revision,blob=excluded.blob', userId, requestId, file.path, file.revision, file.blob || null)
}

// Only this versioned desktop protocol owns these temporary files. Website
// projects and files created by older clients are never inferred to be disposable.
export async function createDesktopMedia({ management: store, workspaceFiles: files, publicOrigin }: Record<string, any>) {
  await ensureOutputSchema(store)
  await store.db.exec(`CREATE TABLE IF NOT EXISTS desktop_media_references(user_id TEXT NOT NULL,path TEXT NOT NULL,revision TEXT NOT NULL,expires_at TEXT NOT NULL,PRIMARY KEY(user_id,path));
    CREATE TABLE IF NOT EXISTS desktop_media_gc(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,entry TEXT NOT NULL,retry_after TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS desktop_media_reference_expiry ON desktop_media_references(expires_at);`)
  if (!(await store.all('PRAGMA table_info(desktop_media_gc)')).some(column => column.name === 'retry_after')) {
    try { await store.db.exec("ALTER TABLE desktop_media_gc ADD COLUMN retry_after TEXT NOT NULL DEFAULT ''") }
    catch (error) { if (!/duplicate column name/i.test(error.message || '')) throw error }
  }
  await store.db.exec('CREATE INDEX IF NOT EXISTS desktop_media_gc_retry ON desktop_media_gc(retry_after)')

  // A server preview can outlive its temporary source. Confirm ownership with
  // protocol metadata; an ordinary website file with a similar path stays usable.
  async function isTemporary(userId, file, project) {
    if (project !== DEFAULT_PROJECT_ID || typeof file?.path !== 'string') return false
    if (file.path.startsWith(prefix)) {
      const lease = (await store.get('SELECT revision FROM desktop_media_references WHERE user_id=? AND path=?', userId, file.path))
      return Boolean(lease && lease.revision === file.revision)
    }
    if (!file.path.startsWith('desktop-delivery/')) return false
    const receipt = (await store.get('SELECT request_id,revision FROM desktop_media_outputs WHERE user_id=? AND path=?', userId, file.path))
    if (!receipt || receipt.revision !== file.revision) return false
    const row = (await store.get('SELECT parameters FROM generations WHERE user_id=? AND request_id=?', userId, receipt.request_id))
    const parameters = JSON.parse(row?.parameters || '{}')
    return parameters.desktopDelivery === 1 && !parameters.desktopDeliveredAt && !parameters.desktopMediaExpiredAt
  }

  async function protectedEntries(userId, project, paths: string[]) {
    if (project !== DEFAULT_PROJECT_ID) return new Set<string>()
    const protectedPaths = new Set<string>()
    const scope = files.scoped ? ' AND f.project_id=?' : ''
    const args = files.scoped ? [userId, project] : [userId]
    if (paths.some(path => path === 'desktop-transfers' || path.startsWith(prefix))) {
      for (const row of (await store.all(`SELECT r.path FROM desktop_media_references r JOIN workspace_files f ON f.user_id=r.user_id AND f.path=r.path AND f.revision=r.revision WHERE r.user_id=?${scope}`, ...args))) protectedPaths.add(row.path)
    }
    if (paths.some(path => path === 'desktop-delivery' || path.startsWith('desktop-delivery/'))) {
      for (const row of (await store.all(`SELECT o.path FROM desktop_media_outputs o JOIN workspace_files f ON f.user_id=o.user_id AND f.path=o.path AND f.revision=o.revision JOIN generations g ON g.user_id=o.user_id AND g.request_id=o.request_id
        WHERE o.user_id=?${scope} AND json_extract(g.parameters,'$.desktopDelivery')=1 AND json_extract(g.parameters,'$.desktopDeliveredAt') IS NULL AND json_extract(g.parameters,'$.desktopMediaExpiredAt') IS NULL`, ...args))) protectedPaths.add(row.path)
    }
    return protectedPaths
  }

  async function filterWorkspaceEntries(userId, project, entries) {
    const protectedPaths = (await protectedEntries(userId, project, entries.map(entry => entry.path)))
    return protectedPaths.size ? entries.filter(entry => !protectedPaths.has(entry.path)) : entries
  }

  async function assertWorkspaceMutation(userId, project, payload) {
    const paths = [payload.path, payload.target].filter((path): path is string => typeof path === 'string')
    for (const protectedPath of (await protectedEntries(userId, project, paths))) {
      if (paths.some(path => path === protectedPath || path.startsWith(protectedPath + '/') || protectedPath.startsWith(path + '/'))) {
        throw failure('桌面传输文件由任务管理，请在桌面端整理已保存的本机文件', 409)
      }
    }
  }

  function referencePath(name) {
    if (!/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(name)) throw failure('参考素材编号无效')
    return prefix + name
  }
  async function stage(userId, name, mime, content?: Buffer | { path: string; size: number; sha256: string }) {
    const path = referencePath(name)
    if (!isReferenceMediaMime(mime)) throw failure('参考素材必须是图片、视频或音频文件')
    if (content && !(Buffer.isBuffer(content) ? content.length && hash(content) === name.split('.')[0] : content.size > 0 && content.sha256 === name.split('.')[0])) throw failure('参考素材内容校验失败')
    return (await store.transaction(async () => {
      await store.db.lock(`media:${userId}`)
      let file
      try { file = (await files.locate(userId, path, DEFAULT_PROJECT_ID)) } catch (error) { if (error.status !== 404) throw error }
      const lease = (await store.get('SELECT revision FROM desktop_media_references WHERE user_id=? AND path=?', userId, path))
      if (file && (!lease || file.revision !== lease.revision || file.mime !== mime)) throw failure('参考素材暂存记录已变化', 409)
      if (!file) {
        if (!content) throw failure('参考素材尚未上传', 404)
        if (Buffer.isBuffer(content)) await files.upsert(userId, path, mime, content, DEFAULT_PROJECT_ID)
        else {
          await files.fileFor(userId, DEFAULT_PROJECT_ID, path)
          await files.assertWriteTarget(userId, DEFAULT_PROJECT_ID, path, mime, null)
          files.blobs.linkFromFile(userId, content.path, content.sha256, { copyFallback: true })
          await files.putIndex(userId, DEFAULT_PROJECT_ID, path, mime, content.size, randomUUID(), content.sha256)
        }
        file = (await files.locate(userId, path, DEFAULT_PROJECT_ID))
      }
      const expiresAt = Date.now() + REFERENCE_TTL_MS
      await store.run('INSERT INTO desktop_media_references VALUES(?,?,?,?) ON CONFLICT(user_id,path) DO UPDATE SET revision=excluded.revision,expires_at=excluded.expires_at', userId, path, file.revision, new Date(expiresAt).toISOString())
      return { path, revision: file.revision, url: createReferenceUrl((await store.referenceSecret()), { userId, path, revision: file.revision, project: DEFAULT_PROJECT_ID, publicOrigin, expiresAt }), expiresIn: REFERENCE_TTL_MS / 1000 }
    }))
  }

  async function stageStream(userId, name, mime, stream) {
    const path = referencePath(name)
    if (!isReferenceMediaMime(mime)) throw failure('参考素材必须是图片、视频或音频文件')
    if (Number(stream.headers?.['content-length']) > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
    const absolute = (await files.fileFor(userId, DEFAULT_PROJECT_ID, path, { create: true }))
    return withStreamedMedia(stream, { path: absolute, maxBytes: WORKSPACE_FILE_MAX_BYTES, mode: mediaPermissions().file }, async content => (await stage(userId, name, mime, content)))
  }

  async function prepare(payload, session) {
    if (session?.role !== 'user') throw failure('请先登录账号', 401)
    if (!validRequestId(payload?.requestId)) throw failure('任务编号无效')
    const paths = new Set<string>()
    if (payload.referenceFiles !== undefined && !Array.isArray(payload.referenceFiles)) throw failure('参考素材参数无效')
    for (const item of payload.referenceFiles || []) {
      if (typeof item?.path !== 'string' || !item.path.startsWith(prefix)) throw failure('桌面参考素材暂存地址无效')
      paths.add(item.path)
    }
    // Video inputs are already signed URLs, including first/last frames and
    // nested keyframes. Verify the signature; never trust a client-supplied list.
    async function visit(value) {
      if (typeof value === 'string' && value.includes('/api/imagine/reference?')) {
        let target
        try { target = new URL(value) } catch { return }
        const ref = verifyReferenceToken((await store.referenceSecret()), target.searchParams.get('t'))
        if (ref?.path.startsWith(prefix)) {
          if (ref.userId !== session.userId || ref.project !== DEFAULT_PROJECT_ID) throw failure('参考素材不属于当前账号', 403)
          paths.add(ref.path)
        }
      } else if (Array.isArray(value)) await forEachAsync(value, visit)
      else if (value && typeof value === 'object') await forEachAsync(Object.values(value), visit)
    }
    for (const field of ['image', 'images', 'video', 'videos', 'audios', 'firstFrame', 'lastFrame', 'keyframes', 'references']) await visit(payload[field])
    const now = new Date().toISOString()
    for (const path of paths) {
      const lease = (await store.get('SELECT * FROM desktop_media_references WHERE user_id=? AND path=?', session.userId, path))
      if (!lease || lease.expires_at <= now || (await files.locate(session.userId, path, DEFAULT_PROJECT_ID)).revision !== lease.revision) throw failure('参考素材暂存已过期，请重新提交素材', 409)
      await store.run('UPDATE desktop_media_references SET expires_at=? WHERE user_id=? AND path=?', new Date(Date.now() + REFERENCE_TTL_MS).toISOString(), session.userId, path)
    }
    return { ...payload, async: true, outputDirectory: `desktop-delivery/${payload.requestId}`, desktopDelivery: 1, desktopReferences: [...paths] }
  }

  async function enqueue(userId, entry) {
    const id = hash(JSON.stringify([userId, entry.kind, entry.blob || entry.id || entry.path]))
    await store.run('INSERT OR IGNORE INTO desktop_media_gc(id,user_id,entry) VALUES(?,?,?)', id, userId, JSON.stringify(entry))
  }
  async function retire(row, field, receipt = '') {
    await store.transaction(async () => {
      await store.db.lockRow('generations','id',row.id)
      await store.db.lock(`media:${row.user_id}`)
      const current = (await store.get('SELECT * FROM generations WHERE id=? AND user_id=?', row.id, row.user_id))
      const state = JSON.parse(current?.parameters || '{}')
      if (!current || state.desktopDelivery !== 1) {
        if (field === 'desktopDeliveredAt') throw failure('桌面任务不存在', 404)
        return
      }
      if (state.desktopDeliveredAt) {
        if (field === 'desktopDeliveredAt' && state.desktopDeliveryReceipt !== receipt) throw failure('保存确认与原记录不一致', 409)
        return
      }
      if (state.desktopMediaExpiredAt) {
        if (field === 'desktopDeliveredAt') throw failure('服务器临时文件已清理', 410)
        return
      }
      if (field === 'desktopDeliveredAt') {
        if (current.status !== 'succeeded') throw failure('生成结果当前无法确认', 409)
      } else if (['queued', 'running'].includes(current.status)
        || (state.desktopExpiresAt ? Date.parse(state.desktopExpiresAt) > Date.now() : Date.parse(current.finished_at) + store.artifactTtlMs() > Date.now())) return
      for (const entry of (await store.all('SELECT id,blob FROM artifacts WHERE request_id=?', row.id))) await enqueue(row.user_id, { ...entry, kind: 'artifact' })
      await store.run('DELETE FROM artifacts WHERE request_id=?', row.id)
      for (const entry of (await store.all('SELECT path,revision,blob FROM desktop_media_outputs WHERE user_id=? AND request_id=?', row.user_id, row.request_id))) {
        const current = (await store.get(`SELECT revision FROM workspace_files WHERE ${files.scopeWhere()} AND path=?`, ...(await files.scopeArgs(row.user_id, DEFAULT_PROJECT_ID)), entry.path))
        if (!current || current.revision === entry.revision || entry.blob) await enqueue(row.user_id, { ...entry, kind: 'workspace' })
        await store.run(`DELETE FROM workspace_files WHERE ${files.scopeWhere()} AND path=? AND revision=?`, ...(await files.scopeArgs(row.user_id, DEFAULT_PROJECT_ID)), entry.path, entry.revision)
      }
      await store.run('DELETE FROM desktop_media_outputs WHERE user_id=? AND request_id=?', row.user_id, row.request_id)
      const video = await store.get('SELECT metadata FROM video_results WHERE generation_id=?',row.id)
      if (video) {
        const metadata = JSON.parse(video.metadata || '{}')
        if (metadata && typeof metadata === 'object') for (const key of ['workspacePath','upstreamUrl','raw']) delete metadata[key]
        await store.run("UPDATE video_results SET video_url='',thumbnail_url='',metadata=? WHERE generation_id=?",JSON.stringify(metadata),row.id)
      }
      await store.run('DELETE FROM generation_inputs WHERE generation_id=?',row.id)
      for (const key of ['image','images','video','videos','audios','firstFrame','lastFrame','keyframes','referenceSources','referenceSourceFiles']) delete state[key]
      state[field] = new Date().toISOString()
      state.desktopDeliveryReceipt = receipt
      await store.run('UPDATE generations SET parameters=? WHERE id=?',JSON.stringify(state),row.id)
    })
  }

  async function digestFile(file) {
    if (file.blob) return file.blob
    if (file.bytes) return hash(file.bytes)
    const digest = createHash('sha256')
    for await (const chunk of createReadStream(file.diskPath)) digest.update(chunk)
    return digest.digest('hex')
  }
  async function delivered(userId, requestId, items) {
    if (!Array.isArray(items) || !items.length || items.length > 32 || items.some(item => typeof item?.id !== 'string' || !item.id || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) || new Set(items.map(item => item.id)).size !== items.length) throw failure('本机保存确认不完整')
    const receipt = receiptHash(items.map(({ id, size, sha256 }) => ({ id, size, sha256 })))
    const get = async () => (await store.get('SELECT * FROM generations WHERE user_id=? AND request_id=?', userId, requestId))
    const row = (await get()), parameters = JSON.parse(row?.parameters || '{}')
    if (!row || parameters.desktopDelivery !== 1) throw failure('桌面任务不存在', 404)
    if (parameters.desktopDeliveredAt) {
      if (parameters.desktopDeliveryReceipt !== receipt) throw failure('保存确认与原记录不一致', 409)
      return { requestId, delivered: true }
    }
    if (parameters.desktopMediaExpiredAt) throw failure('服务器临时文件已清理', 410)
    if (row.status !== 'succeeded') throw failure('生成结果当前无法确认', 409)
    const expected = [], revisions = []
    const video = (await store.videoResult(row.id))
    if (video) {
      if (items.length !== 1 || items[0].id !== video.id) throw failure('本机保存确认不匹配', 409)
      // A provider download can succeed on the desktop after the server's
      // optional cache write failed. There are then no cached bytes to compare.
      if (video.metadata.workspacePath) {
        const file = (await files.locate(userId, video.metadata.workspacePath, DEFAULT_PROJECT_ID))
        const indexed = (await store.get(`SELECT blob FROM workspace_files WHERE ${files.scopeWhere()} AND path=?`, ...(await files.scopeArgs(userId, DEFAULT_PROJECT_ID)), file.path))
        expected.push({ id: video.id, size: file.size, sha256: indexed?.blob || await digestFile(file) })
        revisions.push({ path: file.path, revision: file.revision })
      } else expected.push({ id: video.id, size: items[0].size, sha256: items[0].sha256 })
    } else for (const item of (await store.all('SELECT * FROM artifacts WHERE request_id=? ORDER BY rowid', row.id))) {
      const file = (await (await store.artifactFiles()).locate(item, userId))
      if (!file) throw failure('生成文件暂时不可用', 409)
      expected.push({ id: item.id, size: file.size, sha256: item.blob || await digestFile(file) })
    }
    if (!expected.length || receiptHash(expected) !== receipt) throw failure('本机文件与生成原件不一致，未清理服务器文件', 409)
    const current = (await get()), latest = JSON.parse(current?.parameters || '{}')
    if (latest.desktopMediaExpiredAt || current?.status !== 'succeeded') throw failure('生成结果当前无法确认', 409)
    for (const file of revisions) if ((await files.locate(userId, file.path, DEFAULT_PROJECT_ID)).revision !== file.revision) throw failure('服务器暂存文件已变化，未执行清理', 409)
    await retire(current, 'desktopDeliveredAt', receipt)
    await collectBytes()
    return { requestId, delivered: true }
  }

  async function collectBytes() {
    const now = new Date().toISOString()
    const retryAfter = new Date(Date.now() + 60_000).toISOString()
    for (const row of (await store.all('SELECT * FROM desktop_media_gc WHERE retry_after<=? ORDER BY retry_after,id LIMIT 100', now))) {
      try {
        await store.transaction(async () => {
          await store.db.lock(`media:${row.user_id}`)
          // A fresh/in-use file or a filesystem error must not keep the first
          // batch at the head of the queue and starve unrelated expired files.
          await store.run('UPDATE desktop_media_gc SET retry_after=? WHERE id=?', retryAfter, row.id)
          const entry = JSON.parse(row.entry)
          if (entry.blob) {
            // Keep the existing grace period for a concurrent writer preparing
            // this same blob. Persist the retry so a restart cannot leak bytes.
            if (!(await files.blobs.liveCount(entry.blob, row.user_id))) {
              await files.blobs.release(row.user_id, entry.blob)
              if ((await files.blobs.stat(row.user_id, entry.blob))) return
            }
          } else if (entry.kind === 'artifact') {
            if (!(await (await store.artifactFiles()).release(entry, row.user_id))) return
          }
          else if (!(await store.get(`SELECT path FROM workspace_files WHERE ${files.scopeWhere()} AND path=?`, ...(await files.scopeArgs(row.user_id, DEFAULT_PROJECT_ID)), entry.path))) {
            await files.dropBytes(row.user_id, DEFAULT_PROJECT_ID, [entry])
            if (existsSync((await files.fileFor(row.user_id, DEFAULT_PROJECT_ID, entry.path)))) return
          }
          await store.run('DELETE FROM desktop_media_gc WHERE id=?', row.id)
        })
      } catch (error) {
        await store.run('UPDATE desktop_media_gc SET retry_after=? WHERE id=?', retryAfter, row.id)
        console.warn('[desktop-media] 临时文件回收待重试', error.code || error.status || 'unknown')
      }
    }
  }
  async function sweep() {
    const now = new Date().toISOString()
    for (const ref of (await store.all(`SELECT ref.* FROM desktop_media_references ref WHERE ref.expires_at<=? AND NOT EXISTS (SELECT 1 FROM generations g,json_each(g.parameters,'$.desktopReferences') r WHERE g.user_id=ref.user_id AND g.status IN ('queued','running') AND r.value=ref.path AND NOT ${RELEASED_DESKTOP_IMAGE_INPUTS_SQL}) ORDER BY ref.expires_at,ref.user_id,ref.path LIMIT 100`, now, now))) {
      await store.transaction(async () => {
        await store.db.lock(`media:${ref.user_id}`)
        const lease = (await store.get('SELECT * FROM desktop_media_references WHERE user_id=? AND path=?', ref.user_id, ref.path))
        if (!lease || lease.revision !== ref.revision || lease.expires_at > now) return
        const claimants = (await store.all("SELECT g.status,g.parameters,g.lease_id,g.lease_at FROM generations g,json_each(g.parameters,'$.desktopReferences') r WHERE g.user_id=? AND g.status IN ('queued','running') AND r.value=?", ref.user_id, ref.path))
        if (claimants.some(state => !releasedDesktopImageInputs(state, Date.parse(now)))) return
        const current = (await store.get(`SELECT path,blob,revision FROM workspace_files WHERE ${files.scopeWhere()} AND path=?`, ...(await files.scopeArgs(ref.user_id, DEFAULT_PROJECT_ID)), ref.path))
        if (current?.revision === ref.revision) {
          await enqueue(ref.user_id, { ...current, kind: 'workspace' })
          await store.run(`DELETE FROM workspace_files WHERE ${files.scopeWhere()} AND path=? AND revision=?`, ...(await files.scopeArgs(ref.user_id, DEFAULT_PROJECT_ID)), ref.path, ref.revision)
        }
        await store.run('DELETE FROM desktop_media_references WHERE user_id=? AND path=?', ref.user_id, ref.path)
      })
    }
    const cutoff = new Date(Date.now() - store.artifactTtlMs()).toISOString()
    for (const row of (await store.all("SELECT * FROM generations WHERE json_extract(parameters,'$.desktopDelivery')=1 AND json_extract(parameters,'$.desktopDeliveredAt') IS NULL AND json_extract(parameters,'$.desktopMediaExpiredAt') IS NULL AND status NOT IN ('queued','running') AND (json_extract(parameters,'$.desktopExpiresAt')<=? OR (json_extract(parameters,'$.desktopExpiresAt') IS NULL AND finished_at<=?)) LIMIT 100", now, cutoff))) await retire(row, 'desktopMediaExpiredAt')
    await collectBytes()
  }
  return { stage, stageStream, prepare, delivered, sweep, isTemporary, filterWorkspaceEntries, assertWorkspaceMutation }
}
