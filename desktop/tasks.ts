import { assertDesktopMediaProtocol, validRequestId } from '../server/generation-contract.ts'
import { isReferenceMediaMime } from '../server/reference-assets.ts'
import { WORKSPACE_FILE_MAX_BYTES } from '../server/workspace-files.ts'
import { applyImageOrientation, imageOrientation } from '../server/image-orientation.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, openAsBlob } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { localMediaCapabilities, localMediaSite } from './local-media/catalog.ts'
import { localMediaResponse } from './local-media/resources.ts'
import type { LocalMediaRouter } from './local-media/router.ts'
import { canvasMediaNodeId, patchCanvasMediaFiles } from './canvas-delivery.ts'
import { localTaskMedia, localTaskRecovery, localSubmissionFailureStatus, publicTaskResult, savedTaskFile, taskDownloadPath, taskItemKey, taskMediaExtension as extension, taskResultItems, type TaskDownload, type TaskDownloadFile } from './task-download.ts'
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired'])
const localTaskParameters = body => ({ duration: body.duration ?? null, ratio: body.ratio || null, resolution: body.resolution || null })
const sameLocalTaskParameters = (left, right) => {
  const a = localTaskParameters(left), b = localTaskParameters(right)
  return a.duration === b.duration && a.ratio === b.ratio && a.resolution === b.resolution
}
function requireTaskReceipt(id, data) {
  if (data?.requestId !== id || !['queued','running',...terminal].includes(data?.status)) throw Object.assign(new Error('任务查询回执不完整，将继续查询原任务'), { status: 502 })
}
// Snapshots saved before 0.2.20 rewrote `url` to the local original but kept
// the cloud preview link, which 404s once the transit copy expires. A saved
// local original always previews from this computer.
function localThumbnails(result: Record<string, any>): Record<string, any> {
  const local = (item: any) => typeof item?.url === 'string' && item.url.startsWith('/api/imagine/workspace/files?')
    && !String(item.thumbnailUrl || '').startsWith('/api/imagine/workspace/files?')
    ? { ...item, thumbnailUrl: item.url + '&preview=1&previewSize=320' } : item
  return {
    ...result,
    ...(Array.isArray(result.images) ? { images: result.images.map(local) } : {}),
    ...(result.video ? { video: local(result.video) } : {}),
  }
}

export class LocalTasks {
  declare store: import('./store.ts').LocalStore
  declare files: import('./workspace-files.ts').DesktopWorkspaceFiles
  declare cloud: import('./cloud.ts').CloudGateway
  declare localRoutes: Map<string, LocalMediaRouter>
  declare ensureTools: () => Promise<unknown>
  declare changed: any
  declare inflight: Map<any, any>
  declare saving: Map<any, any>
  declare staging: Map<any, any>
  submitting = new Map<string, { project: string; kind: string; directory: string; account: string; authRevision: number; model: string; route: string; parameters: ReturnType<typeof localTaskParameters>; promise: Promise<any> }>()
  cancelling = new Map<string, Promise<any>>()
  deliveries = new Map<string, Promise<void>>()
  deliveryAfter = new Map<string, number>()
  // Keep the latest saving state readable if the task database itself cannot
  // write (for example, a full disk). Normal operation uses only persisted state.
  saveSnapshots = new Map<string, Record<string, any>>()
  declare controller: AbortController
  declare timer: any
  accountController = new AbortController()
  mediaProtocol?: { revision: number; origin: string; promise: Promise<void> }

  constructor({ store, files, cloud, changed, localRoutes = new Map(), ensureTools = async () => {} }: Record<string, any>) {
    Object.assign(this, { store, files, cloud, changed, localRoutes, ensureTools })
    this.inflight = new Map(); this.saving = new Map(); this.staging = new Map()
    this.controller = new AbortController()
    this.timer = setInterval(() => this.resume(), 2000); this.timer.unref()
  }
  operationSignal() { return AbortSignal.any([this.controller.signal, this.accountController.signal]) }
  assertOperation(project: string, account: string, authRevision: number, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!account || account !== this.cloud.account || authRevision !== this.cloud.authRevision || this.cloud.sessionChanging) throw Object.assign(new Error('妙图账户已切换，请重新读取原任务'), { status: 409 })
    this.store.project(project)
  }
  canvasCleanupReferences(project: string) {
    const account = this.cloud.account
    const paths = this.store.all("SELECT directory FROM desktop_tasks WHERE account=? AND project_id=? AND status NOT IN ('succeeded','failed','cancelled','expired')", account, project)
      .map(row => row.directory)
    for (const key of this.staging.keys()) {
      const value = JSON.parse(key)
      if (value[0] === 'file' && value[1] === account && value[3] === project) paths.push(value[4])
    }
    return paths
  }
  // Retire local transfers/observers, preserving durable task IDs and receipts.
  // An already dispatched generation keeps its original submission lifetime.
  accountChanged() { this.accountController.abort(); this.accountController = new AbortController(); this.mediaProtocol = undefined }
  ensureMediaProtocol() {
    const revision = this.cloud.authRevision, origin = this.cloud.origin
    if (this.mediaProtocol?.revision === revision && this.mediaProtocol.origin === origin) return this.mediaProtocol.promise
    const signal = this.operationSignal()
    const promise: Promise<void> = (async () => {
      const config = await this.cloud.json('/api/imagine/config', { signal })
      signal.throwIfAborted()
      if (revision !== this.cloud.authRevision || origin !== this.cloud.origin) throw Object.assign(new Error('账号已切换，请重新读取服务状态'), { status: 409 })
      assertDesktopMediaProtocol(config)
    })().catch(error => {
      if (this.mediaProtocol?.promise === promise) this.mediaProtocol = undefined
      throw error
    })
    this.mediaProtocol = { revision, origin, promise }
    return promise
  }
  async stage(project, path, revision?: any) {
    this.store.project(project)
    const account = this.cloud.account, authRevision = this.cloud.authRevision
    const signal = this.operationSignal()
    if (!account) throw Object.assign(new Error('请先登录账号'), { status: 401 })
    signal.throwIfAborted()
    const file = this.files.locate('local', path, project)
    if (revision && revision !== file.revision) throw Object.assign(new Error('参考素材已更新，请重新读取'), { status: 409 })
    if (!file.size || !isReferenceMediaMime(file.mime)) throw Object.assign(new Error('参考素材必须是非空的图片、视频或音频文件'), { status: 422 })
    if (file.size > WORKSPACE_FILE_MAX_BYTES) throw Object.assign(new Error('参考素材不能超过 200MB，请先在本机处理后再提交'), { status: 413 })
    const key = JSON.stringify(['file', account, authRevision, project, file.path, file.revision])
    if (!this.staging.has(key)) this.staging.set(key, (async () => {
      // Keep the source reserved while the first protocol/config request waits.
      // reference-url can stage a file without a durable generation task row.
      await this.ensureMediaProtocol()
      signal.throwIfAborted()
      if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
      // File-backed Blob streams without allocating a whole video and detects
      // changes to the source during reading. Immutable blob indexes already
      // contain the digest; legacy path files are hashed in bounded chunks.
      // 手机照片的方向常只写在 EXIF 里。模型拿到的像素要和画布里看到的一致，
      // 局部重绘的蒙版也是按显示方向画的，所以上传前先把像素转正。
      const oriented = await imageOrientation(file.diskPath || file.bytes, file.mime).catch(() => 1) > 1
        ? (await this.ensureTools(), await applyImageOrientation(file.diskPath || file.bytes, file.mime, { signal }))
        : null
      signal.throwIfAborted()
      const mime = oriented?.mime || file.mime
      const content = oriented ? new Blob([new Uint8Array(oriented.bytes)], { type: mime }) : file.diskPath ? await openAsBlob(file.diskPath, { type: mime }) : new Blob([file.bytes], { type: mime })
      let digest = oriented ? '' : file.blob
      if (!digest) {
        const hash = createHash('sha256')
        for await (const chunk of Readable.fromWeb(content.stream(), { signal })) hash.update(chunk)
        digest = hash.digest('hex')
      }
      signal.throwIfAborted()
      if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
      const name = digest + '.' + extension(mime)
      const contentKey = JSON.stringify(['content', account, authRevision, name, mime])
      if (!this.staging.has(contentKey)) this.staging.set(contentKey, (async () => {
        const url = `/api/imagine/desktop/references/${name}`
        const options = { headers: { 'content-type': mime }, signal }
        let value
        try { value = await this.cloud.json(url, { ...options, method: 'POST' }) }
        catch (error) {
          if (error.status !== 404) throw error
          signal.throwIfAborted()
          if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
          value = await this.cloud.json(url, { ...options, method: 'PUT', rawBody: content })
        }
        const target = new URL(value?.url || '', this.cloud.origin)
        if (value?.path !== `desktop-transfers/${name}` || typeof value.revision !== 'string' || !value.revision || target.origin !== this.cloud.origin || target.pathname !== '/api/imagine/reference' || !target.searchParams.get('t')) throw new Error('参考素材上传回执不完整')
        return value
      })().finally(() => this.staging.delete(contentKey)))
      return this.staging.get(contentKey)
    })().finally(() => this.staging.delete(key)))
    const value = await this.staging.get(key)
    signal.throwIfAborted()
    if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
    this.store.project(project)
    if (this.files.stat('local', file.path, project).revision !== file.revision) throw Object.assign(new Error('参考素材已更新，请重新读取'), { status: 409 })
    return value
  }
  async referenceUrl(project, path) { return this.stage(project, path) }
  async prepare(project, body) {
    const copy = structuredClone(body)
    if (Array.isArray(copy.referenceFiles)) copy.referenceFiles = await Promise.all(copy.referenceFiles.map(async item => {
      const staged = await this.stage(project, item.path, item.revision)
      return { ...item, path: staged.path, revision: staged.revision }
    }))
    return copy
  }
  submit(project, kind, body) {
    const id = body.requestId || randomUUID(), account = this.cloud.account, authRevision = this.cloud.authRevision
    const directory = String(body.outputDirectory || '')
    const route = localMediaSite(body.model, body.providerId)?.provider || ''
    const pending = this.submitting.get(id)
    if (pending) {
      if (pending.project !== project || pending.kind !== kind || pending.directory !== directory || pending.account !== account || pending.authRevision !== authRevision) return Promise.reject(Object.assign(new Error('任务编号已绑定其他项目或账号'), { status: 409 }))
      if ((pending.route || route) && (pending.route !== route || pending.model !== body.model || !sameLocalTaskParameters(pending.parameters, body))) return Promise.reject(Object.assign(new Error('原任务来源、模型或参数不可更换，请继续取回原任务'), { status: 409 }))
      return pending.promise
    }
    const promise = this.submitOnce(project, kind, { ...body, requestId: id }).finally(() => this.submitting.delete(id))
    this.submitting.set(id, { project, kind, directory, account, authRevision, model: body.model, route, parameters: localTaskParameters(body), promise })
    return promise
  }
  async submitOnce(project, kind, body) {
    this.store.project(project)
    const account = this.cloud.account, authRevision = this.cloud.authRevision
    if (!account) throw Object.assign(new Error('请先登录账号'), { status: 401 })
    const id = body.requestId || randomUUID()
    if (!validRequestId(id)) throw new Error('任务编号无效')
    const directory = String(body.outputDirectory || '')
    this.files.path(directory)
    const existing = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', id)
    const localSite = localMediaSite(body.model, body.providerId)
    if (existing) {
      if (existing.account !== account || existing.project_id !== project || existing.directory !== directory || existing.kind !== kind) throw Object.assign(new Error('任务编号已绑定其他项目或账号'), { status: 409 })
      const saved = this.snapshot(existing)
      if ((localMediaSite(saved.model, saved.route) || localSite) && (saved.route !== localSite?.provider || saved.model !== body.model || saved.routeState?.requestedParameters && !sameLocalTaskParameters(saved.routeState.requestedParameters, body))) throw Object.assign(new Error('原任务来源、模型或参数不可更换，请继续取回原任务'), { status: 409 })
      return this.status(existing)
    }
    if (localSite) return this.submitLocal(project, kind, { ...body, requestId: id }, account, authRevision, localSite.provider)
    const details = { requestId: id, model: String(body.model || ''), prompt: String(body.prompt || '') }
    // Admit locally before reference preparation yields, so Stop can prevent
    // submission even while a shared reference upload is still finishing.
    this.store.run('INSERT INTO desktop_tasks VALUES(?,?,?,?,?,?,?,?)', id, project, directory, kind, account, 'submitting', JSON.stringify({ ...details, submissionPhase: 'preparing' }), new Date().toISOString())
    let dispatched = false
    try {
      await this.ensureMediaProtocol()
      this.controller.signal.throwIfAborted()
      if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
      this.store.project(project)
      const admitted = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', id)
      if (!admitted) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
      if (terminal.has(admitted.status)) return this.status(admitted)
      const prepared = await this.prepare(project, body)
      this.controller.signal.throwIfAborted()
      if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw new Error('账号已切换')
      this.store.project(project)
      const current = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', id)
      if (!current) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
      if (terminal.has(current.status)) return this.status(current)
      // Commit dispatch intent before calling the server. After a crash this
      // phase is uncertain and must only query/cancel the original request.
      this.store.run('UPDATE desktop_tasks SET result=? WHERE request_id=?', JSON.stringify(details), id)
      dispatched = true
      // 原节点目录只留本机；云端请求用独立结果目录，不能触发云端画布回写。
      const payload = { ...prepared, requestId: id, idempotencyKey: id, async: true }
      const result = await this.cloud.json(kind === 'video' ? '/api/imagine/desktop/video' : '/api/imagine/desktop/generate', { method: 'POST', body: payload, headers: { 'x-workspace-project': 'default' }, signal: this.controller.signal })
      requireTaskReceipt(id, result)
      const row = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', id)
      const saving = this.accept(row, result)
      if (result.status !== 'succeeded') return saving
      // The accepted request now belongs to the runtime, not the HTTP reader.
      // Return its saving state without holding submission open for a download.
      void saving.catch(() => {})
      return this.status(row)
    } catch (error) {
      const current = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', id)
      if (!current) throw error
      if (terminal.has(current.status) || current.status === 'saving') return this.status(current)
      // 408、网络或 5xx 丢失响应只能查询原编号，不能再次提交收费请求。
      const knownRejected = !dispatched || Number(error.status) >= 400 && Number(error.status) < 500 && Number(error.status) !== 408
      const value = { ...details, ...(this.snapshot(current).cancellationRequested && !knownRejected ? { cancellationRequested: true } : {}), ok: !knownRejected, status: knownRejected ? 'failed' : 'confirming', submissionUncertain: !knownRejected, error: knownRejected ? error.message : '提交结果待确认，正在查询原任务', ...(error.errorExplanation ? { errorExplanation: error.errorExplanation } : {}) }
      this.store.run("UPDATE desktop_tasks SET status=?,result=? WHERE request_id=? AND status NOT IN ('succeeded','failed','cancelled','expired','saving')", knownRejected ? 'failed' : 'confirming', JSON.stringify(value), id)
      if (this.cloud.account !== account || this.cloud.authRevision !== authRevision) throw Object.assign(new Error('账号已切换，原任务仍保留在原账号'), { status: 409 })
      if (knownRejected) throw error
      return value
    }
  }
  async submitLocal(project, kind, body, account, authRevision, provider: string) {
    const localRoute = this.localRoutes.get(provider)
    if (!localRoute) throw Object.assign(new Error('本机平台本机路由不可用'), { status: 503 })
    const signal = this.operationSignal()
    this.assertOperation(project, account, authRevision, signal)
    const id = body.requestId, directory = String(body.outputDirectory || '')
    const details = { requestId: id, model: body.model, prompt: body.prompt, route: provider,
      billingSource: provider, submissionPhase: 'preparing', routeState: { phase: 'preparing', kind, requestedParameters: localTaskParameters(body) } }
    // Reserve ownership before platform refresh or page setup yields. Project
    // removal and local Stop can now see preparation, just like cloud jobs.
    this.store.run('INSERT INTO desktop_tasks VALUES(?,?,?,?,?,?,?,?)', id, project, directory, kind, account, 'submitting', JSON.stringify(details), new Date().toISOString())
    try {
      await localRoute.validate(kind, body, false, signal)
      this.assertOperation(project, account, authRevision, signal)
      const capabilities = localMediaCapabilities(body.model, provider)!
      const localReferences = []
      let referenceBytes = 0
      for (const reference of body.referenceFiles || []) {
        const file = this.files.locate('local', reference.path, project)
        if (!capabilities.references.imageMimeTypes.includes(file.mime) || !file.size || file.size > capabilities.references.maxImageBytes) throw Object.assign(new Error('参考图需为 20MB 以内的 PNG、JPEG 或 WebP 图片'), { status: 422 })
        if (reference.revision && reference.revision !== file.revision) throw Object.assign(new Error('参考图片已变化，请重新读取后提交'), { status: 409 })
        referenceBytes += file.size
        if (capabilities.references.maxTotalBytes && referenceBytes > capabilities.references.maxTotalBytes) throw Object.assign(new Error('参考图片总计不能超过 60MB，请先压缩'), { status: 413 })
        const bytes = file.diskPath ? await readFile(file.diskPath) : Buffer.from(file.bytes)
        this.assertOperation(project, account, authRevision, signal)
        if (bytes.length !== file.size || this.files.locate('local', reference.path, project).revision !== file.revision) throw Object.assign(new Error('参考图片在读取中变化，尚未提交'), { status: 409 })
        localReferences.push({ name: reference.path.split('/').pop(), mime: file.mime, base64: bytes.toString('base64') })
      }
      const row = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=? AND account=?', id, project, account)
      if (!row) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
      if (terminal.has(row.status) || row.status === 'saving') return this.status(row)
      // The router checkpoints dispatch intent immediately before the single
      // send, rechecking this preparing row so a local cancellation wins safely.
      const result = await localRoute.submit(row, { ...body, localReferences }, signal)
      this.assertOperation(project, account, authRevision, signal)
      return await this.accept(row, result)
    } catch (error) {
      const latest = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=? AND account=?', id, project, account)
      if (!latest) throw error
      const snapshot = this.snapshot(latest)
      const status = localSubmissionFailureStatus(snapshot.status, snapshot.routeState?.phase)
      if (!status) {
        this.assertOperation(project, account, authRevision, signal)
        return this.status(latest)
      }
      const uncertain = status === 'running'
      const result = { ...snapshot, ok: uncertain, status, submissionUncertain: uncertain,
        error: uncertain ? '提交结果待确认，请打开本机平台窗口核对原任务' : error.message }
      this.store.run("UPDATE desktop_tasks SET status=?,result=? WHERE request_id=? AND project_id=? AND account=? AND status NOT IN ('succeeded','failed','cancelled','expired','saving')", status, JSON.stringify(result), id, project, account)
      this.assertOperation(project, account, authRevision, signal)
      if (!uncertain) throw error
      return publicTaskResult(result)
    }
  }

  async history(project, { page = 1, limit = 20, model = '', kind = '', from = '', to = '', summaryFrom = '', summaryTo = '' }: Record<string, any> = {}) {
    this.store.project(project)
    const account = this.cloud.account, authRevision = this.cloud.authRevision
    if (!account) throw Object.assign(new Error('请先登录账号'), { status: 401 })
    page = Number(page); limit = Number(limit)
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('历史记录页码或数量无效'), { status: 422 })
    const clauses = ['project_id=?', 'account=?'], args = [project, account]
    if (model) { clauses.push("json_extract(result,'$.model')=?"); args.push(String(model)) }
    if (['image', 'video'].includes(kind)) { clauses.push('kind=?'); args.push(kind) }
    if (from) { clauses.push('created_at>=?'); args.push(String(from)) }
    if (to) { clauses.push('created_at<?'); args.push(String(to)) }
    const where = clauses.join(' AND ')
    const total = this.store.get(`SELECT COUNT(*) n FROM desktop_tasks WHERE ${where}`, ...args).n
    const range = [...clauses], rangeArgs = [...args]
    if (summaryFrom) { range.push('created_at>=?'); rangeArgs.push(String(summaryFrom)) }
    if (summaryTo) { range.push('created_at<?'); rangeArgs.push(String(summaryTo)) }
    const summary = summaryFrom || summaryTo ? this.store.get(`SELECT COUNT(*) runs FROM desktop_tasks WHERE ${range.join(' AND ')}`, ...rangeArgs) : null
    const rows = this.store.all(`SELECT * FROM desktop_tasks WHERE ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)
    // History is a local snapshot: one old failure or a pending media download
    // must not hold the whole page behind a cloud request. Task polling can
    // continue fetching active tasks separately.
    const items = rows.map(row => ({ ...this.view(row), id: row.request_id, requestId: row.request_id, kind: row.kind, created_at: row.created_at, createdAt: row.created_at }))
    if (account !== this.cloud.account || authRevision !== this.cloud.authRevision) throw Object.assign(new Error('账号已切换，请重新读取历史记录'), { status: 409 })
    this.store.project(project)
    return { ok: true, items, page, limit, total, summary }
  }
  status(row): Record<string, any> {
    const current = row && this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=?', row.request_id, row.project_id)
    if (!current) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
    if (current.account !== this.cloud.account) throw Object.assign(new Error('请登录提交此任务的账号'), { status: 401 })
    this.store.project(current.project_id)
    // A reader gets the durable state immediately. Polling and original-file
    // delivery stay deduplicated in the runtime and survive a closed canvas.
    if (!terminal.has(current.status)) void this.poll(current).catch(() => {})
    return { ...this.view(current), ok: true, requestId: current.request_id,
      ...(current.status !== 'succeeded' ? { images: [], video: null } : {}) }
  }
  view(row) {
    const snapshot = this.snapshot(row)
    const result = localThumbnails(publicTaskResult(snapshot))
    if (row.status === 'expired' && snapshot.localDownload) {
      this.store.project(row.project_id)
      const recovery = localTaskRecovery(row, snapshot.localDownload, path => this.files.locate('local', path, row.project_id))
      if (recovery) result.localRecovery = recovery
    }
    return result
  }
  snapshot(row) {
    if (terminal.has(row.status)) this.saveSnapshots.delete(row.request_id)
    return this.saveSnapshots.has(row.request_id)
      ? this.saveSnapshots.get(row.request_id)!
      : { ...JSON.parse(row.result || '{}'), status: row.status }
  }
  async cancel(row) {
    row = row && this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=?', row.request_id, row.project_id)
    if (!row) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
    if (row.account !== this.cloud.account) throw Object.assign(new Error('请登录提交此任务的账号'), { status: 401 })
    this.store.project(row.project_id)
    const current = this.snapshot(row)
    if (terminal.has(current.status) || current.status === 'saving') return this.view(row)
    if (this.localRoutes.has(current.route)) {
      const account = row.account, authRevision = this.cloud.authRevision, signal = this.operationSignal()
      this.assertOperation(row.project_id, account, authRevision, signal)
      // Preparing has no accepted platform generation. Mark it locally before
      // the submitter resumes; its mandatory pre-send checkpoint rejects this row.
      if (current.submissionPhase === 'preparing') {
        const receipt = { ...current, requestId: row.request_id, ok: true, status: 'cancelled', submissionUncertain: false }
        this.store.run("UPDATE desktop_tasks SET status='cancelled',result=? WHERE request_id=? AND project_id=? AND account=? AND status NOT IN ('succeeded','failed','cancelled','expired','saving') AND json_extract(result,'$.submissionPhase')='preparing'", JSON.stringify(receipt), row.request_id, row.project_id, account)
        return this.status(row)
      }
      if (this.cancelling.has(row.request_id)) return this.cancelling.get(row.request_id)
      if (current.cancellationAttempted) return this.view(row)
      const route = this.localRoutes.get(current.route)!
      // Register before the first asynchronous host operation. A second Stop
      // shares this attempt, and service shutdown joins the actual receipt/save.
      const work = Promise.resolve().then(async () => {
        this.assertOperation(row.project_id, account, authRevision, signal)
        const latest = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=? AND account=?', row.request_id, row.project_id, account)
        if (!latest) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
        const saved = this.snapshot(latest)
        if (terminal.has(saved.status) || saved.status === 'saving' || saved.cancellationAttempted) return this.view(latest)
        const receipt = await route.cancel(latest, saved, signal)
        this.assertOperation(row.project_id, account, authRevision, signal)
        requireTaskReceipt(row.request_id, receipt)
        const accepted = this.accept(latest, receipt)
        if (receipt.status !== 'succeeded') return accepted
        void accepted.catch(() => {})
        return this.status(latest)
      }).finally(() => { if (this.cancelling.get(row.request_id) === work) this.cancelling.delete(row.request_id) })
      this.cancelling.set(row.request_id, work)
      return work
    }
    if (current.submissionPhase === 'preparing') {
      const receipt = { requestId: row.request_id, model: current.model, prompt: current.prompt, ok: true, status: 'cancelled' }
      this.store.run("UPDATE desktop_tasks SET status='cancelled',result=? WHERE request_id=?", JSON.stringify(receipt), row.request_id)
      return receipt
    }
    if (!current.cancellationRequested) this.store.run('UPDATE desktop_tasks SET result=? WHERE request_id=?', JSON.stringify({ ...current, cancellationRequested: true }), row.request_id)
    if (this.cancelling.has(row.request_id)) return this.cancelling.get(row.request_id)
    const authRevision = this.cloud.authRevision
    const signal = this.operationSignal()
    const work = (async () => {
      const receipt = await this.cloud.json(`/api/imagine/generation/${encodeURIComponent(row.request_id)}/cancel`, { method: 'POST', body: {}, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) })
      if (row.account !== this.cloud.account || authRevision !== this.cloud.authRevision) throw Object.assign(new Error('账号已切换，请重新读取原任务'), { status: 409 })
      requireTaskReceipt(row.request_id, receipt)
      const accepted = this.accept(row, receipt)
      if (receipt.status !== 'succeeded') return accepted
      // Completion won the race. Keep saving independently of the cancel reader.
      void accepted.catch(() => {})
      return this.status(row)
    })().finally(() => this.cancelling.delete(row.request_id))
    this.cancelling.set(row.request_id, work)
    return work
  }
  poll(row) {
    row = row && this.store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=?', row.request_id, row.project_id)
    if (!row) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
    if (row.account !== this.cloud.account) throw Object.assign(new Error('请登录提交此任务的账号'), { status: 401 })
    if (this.saving.has(row.request_id)) return this.saving.get(row.request_id)
    if (row.status === 'succeeded' && row.result) return Promise.resolve(this.view(row))
    if (['failed', 'cancelled', 'expired'].includes(row.status)) return Promise.resolve(this.view(row))
    const saved = this.snapshot(row)
    if (saved.submissionPhase === 'preparing') {
      if (this.submitting.has(row.request_id)) return Promise.resolve(publicTaskResult(saved))
      // A restart cannot have sent a task still marked as preparing. Do not
      // poll a nonexistent cloud job forever or silently submit it now.
      const interrupted = { ...saved, requestId: row.request_id, model: saved.model, prompt: saved.prompt, ok: false, status: 'failed', error: '准备已中断，尚未提交生成，请重新发起' }
      this.store.run("UPDATE desktop_tasks SET status='failed',result=? WHERE request_id=?", JSON.stringify(interrupted), row.request_id)
      return Promise.resolve(interrupted)
    }
    // Cancellation can race server admission and return 404. Keep the intent
    // across status reads/restarts, while still retrieving a completed result.
    if (saved.cancellationRequested && !this.localRoutes.has(saved.route) && row.status !== 'saving') void this.cancel(row).catch(() => {})
    if (this.inflight.has(row.request_id)) return this.inflight.get(row.request_id)
    if (saved.status === 'saving' && Number(saved.savingRetry?.at) > Date.now()) return Promise.resolve(publicTaskResult(saved))
    if (saved.status === 'saving') {
      try {
        const recovered = this.restoreDownload(row, saved.localDownload)
        if (recovered) return Promise.resolve(recovered)
      } catch (error) { this.saveFailure(row, error); return Promise.reject(error) }
    }
    const authRevision = this.cloud.authRevision
    const lifetime = this.operationSignal()
    const work = (async () => {
      this.assertOperation(row.project_id, row.account, authRevision, lifetime)
      let data
      try {
        const signal = AbortSignal.any([lifetime, AbortSignal.timeout(120000)])
        data = this.localRoutes.has(saved.route)
          ? await this.localRoutes.get(saved.route)!.poll(row, saved, lifetime)
          : await this.cloud.json(`/api/imagine/${row.kind === 'video' ? 'video' : 'generation'}/${encodeURIComponent(row.request_id)}`, { signal })
      } catch (error) {
        if (error.status !== 410) {
          if (row.account === this.cloud.account && authRevision === this.cloud.authRevision) this.saveFailure(row, error)
          throw error
        }
        const saved = this.snapshot(row)
        data = { ...saved, ok: true, requestId: row.request_id, status: 'expired', submissionUncertain: false, images: [], video: null,
          ...(saved.delivery?.target === 'desktop' ? { delivery: { ...saved.delivery, status: 'expired' } } : {}),
          error: error.message, ...(error.errorExplanation ? { errorExplanation: error.errorExplanation } : {}) }
      }
      this.assertOperation(row.project_id, row.account, authRevision, lifetime)
      return this.accept(row, data)
    })().finally(() => this.inflight.delete(row.request_id))
    this.inflight.set(row.request_id, work)
    return work
  }
  accept(row, data) {
    if (!row) return Promise.reject(Object.assign(new Error('本地任务不存在'), { status: 404 }))
    if (row.account !== this.cloud.account) return Promise.reject(Object.assign(new Error('请登录提交此任务的账号'), { status: 401 }))
    try { requireTaskReceipt(row.request_id, data) } catch (error) { return Promise.reject(error) }
    const latest = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', row.request_id)
    if (!latest) return Promise.reject(Object.assign(new Error('本地任务不存在'), { status: 404 }))
    if (terminal.has(latest.status)) return Promise.resolve(this.view(latest))
    if (this.saving.has(row.request_id)) return this.saving.get(row.request_id)
    // A poll/cancel receipt may have been read before the completion receipt.
    // Failed delivery releases its promise but retains the durable saving
    // state; an older running/queued reply must not erase that retry state.
    if (latest.status === 'saving' && ['queued', 'running'].includes(data.status)
      || latest.status === 'running' && data.status === 'queued') return Promise.resolve(publicTaskResult(this.snapshot(latest)))
    // State-only receipts commit synchronously. Sharing their short-lived
    // promise would discard a simultaneous cancellation/completion receipt.
    // Only downloading and saving the original result needs deduplication.
    if (data.status !== 'succeeded') return this.saveResult(latest, data)
    const authRevision = this.cloud.authRevision
    const pending = this.saveResult(row, data).catch(error => {
      if (row.account === this.cloud.account && authRevision === this.cloud.authRevision) this.saveFailure(row, error)
      throw error
    }).finally(() => this.saving.delete(row.request_id))
    this.saving.set(row.request_id, pending)
    return pending
  }
  saveFailure(row, error) {
    if (this.controller.signal.aborted) return
    const latest = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', row.request_id)
    if (!latest || terminal.has(latest.status)) return
    const saved = this.snapshot(latest)
    if (saved.status !== 'saving') return
    // A completed generation stays settled. Retry only delivery, including
    // after restart; never turn a disk/network error into another paid job.
    const attempt = Math.min(20, Math.max(0, Number(saved.savingRetry?.attempt) || 0) + 1)
    const code = error?.code || error?.cause?.code
    const message = ['ENOSPC', 'EDQUOT'].includes(code)
      ? '生成已完成，本机空间不足；请释放空间，应用会自动继续保存，不会重新生成。'
      : ['EACCES', 'EPERM', 'EROFS'].includes(code)
        ? '生成已完成，本机文件无法写入；请检查保存位置的写入权限，应用会自动继续保存。'
        : '生成已完成，文件暂未保存到本机；请检查网络和本机存储，应用会自动取回原任务，不会重新生成。'
    const snapshot = { ...saved, error: message, savingRetry: { attempt, at: Date.now() + Math.min(300_000, 30_000 * 2 ** (attempt - 1)) } }
    this.saveSnapshots.set(row.request_id, snapshot)
    try {
      this.store.run("UPDATE desktop_tasks SET status='saving',result=? WHERE request_id=?", JSON.stringify(snapshot), row.request_id)
      this.saveSnapshots.delete(row.request_id)
    } catch { /* Keep the readable snapshot and retry when storage recovers. */ }
  }
  downloadTargetExists(project: string, path: string) {
    this.files.path(path)
    try { this.files.stat('local', path, project); return true }
    catch (error) { if (error.status !== 404) throw error }
    // An unindexed legacy file still belongs to its existing owner. Do not
    // hide it behind a new blob index merely because its row is absent.
    return existsSync(this.files.fileFor('local', project, path))
  }
  async saveResult(row, data) {
    if (row.account !== this.cloud.account) throw new Error('账号已切换')
    const signal = this.operationSignal()
    signal.throwIfAborted()
    const { accessToken: _accessToken, localDownload: _localDownload, localRecovery: _localRecovery, ...publicData } = data
    const previous = this.snapshot(this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', row.request_id) || row)
    data = { model: previous.model, prompt: previous.prompt, ...publicData,
      ...(this.localRoutes.has(previous.route) ? { route: previous.route, routeState: previous.routeState, billingSource: previous.route } : {}),
      ...(previous.cancellationRequested && !terminal.has(publicData.status) ? { cancellationRequested: true } : {}) }
    if (row.kind === 'text' && this.localRoutes.has(previous.route) && data.status === 'succeeded') {
      if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('平台尚未返回完整文本')
      this.store.run('UPDATE desktop_tasks SET status=?,result=? WHERE request_id=? AND account=?', 'succeeded', JSON.stringify(data), row.request_id, row.account)
      return publicTaskResult(data)
    }
    if (data.status === 'succeeded' && data.parameters?.desktopMediaExpiredAt) data = { ...data, status: 'expired', error: '生成文件暂存期已结束，服务器已清理；已保存的本机文件不受影响' }
    if (data.status !== 'succeeded') {
      // An expired transit response must not discard evidence of originals
      // already committed locally, even when the batch is still incomplete.
      const stored = { ...data, ...(previous.localDownload ? { localDownload: previous.localDownload } : {}) }
      this.store.run('UPDATE desktop_tasks SET status=?,result=? WHERE request_id=?', data.status || 'running', JSON.stringify(stored), row.request_id)
      this.saveSnapshots.delete(row.request_id)
      return this.view({ ...row, status: data.status || 'running', result: JSON.stringify(stored) })
    }
    const items = taskResultItems(row.kind, data)
    // Generation has settled, but these cloud URLs do not exist on this local
    // origin. Publish the latest billing/state now and expose local media only
    // after the original files and canvas have committed.
    let download: TaskDownload = { version: 1, requestId: row.request_id, source: data,
      files: previous.localDownload?.version === 1 && previous.localDownload.requestId === row.request_id && Array.isArray(previous.localDownload.files) ? previous.localDownload.files : [] }
    let snapshot = { ...data, status: 'saving', images: [], video: null, localDownload: download,
      ...(previous.savingRetry ? { savingRetry: previous.savingRetry, error: previous.error } : {}) }
    this.saveSnapshots.set(row.request_id, snapshot)
    this.store.run('UPDATE desktop_tasks SET status=?,result=? WHERE request_id=?', 'saving', JSON.stringify(snapshot), row.request_id)
    this.saveSnapshots.delete(row.request_id)
    if (!Array.isArray(items) || !items.length || items.some(item => !item?.url || data.parameters?.desktopDelivery === 1 && (typeof item.id !== 'string' || !item.id))) throw new Error('生成结果未返回原始文件地址')
    const ready: TaskDownloadFile[] = []
    const authRevision = this.cloud.authRevision
    for (const [index, item] of items.entries()) {
      const existing = savedTaskFile(row, item, index, download, path => this.files.locate('local', path, row.project_id))
      if (existing) { ready.push(existing); continue }
      const target = new URL(item.url, this.cloud.origin)
      // 优先取服务端鉴权原件，避免把缩略图、任意远端地址或错误页面当成成片。
      if (!this.localRoutes.has(data.route) && (target.origin !== this.cloud.origin || !target.pathname.startsWith('/api/imagine/'))) throw new Error('生成结果地址不可信，已拒绝保存')
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(row.kind === 'video' ? 600_000 : 120_000)])
      let response = this.localRoutes.has(data.route)
        ? await this.localRoutes.get(data.route)!.download(row, item.url, downloadSignal)
        : await this.cloud.request(target.pathname + target.search, { signal: downloadSignal })
      if (!response.ok) { await response.body?.cancel(); throw new Error('生成原件下载失败，将继续取回同一任务') }
      if (this.localRoutes.has(data.route)) {
        const capabilities = localMediaCapabilities(data.model, data.route)
        if (!capabilities) { await response.body?.cancel(); throw new Error('本机原任务的模型能力无法确认') }
        response = await localMediaResponse(response, capabilities.outputMimeTypes)
      }
      const mime = (this.localRoutes.has(data.route) ? response.headers.get('content-type') : item.mime || response.headers.get('content-type') || '').split(';')[0]
      if (!response.body || !(row.kind === 'video' ? mime.startsWith('video/') : mime.startsWith('image/')) || !['mp4', 'webm', 'png', 'jpg', 'webp'].includes(extension(mime))) {
        await response.body?.cancel(); throw new Error('生成原件格式无效')
      }
      let path: string
      try {
        path = taskDownloadPath(row.directory, row.request_id, index, mime)
        while (this.downloadTargetExists(row.project_id, path)) path = taskDownloadPath(row.directory, row.request_id, index, mime, randomUUID())
      } catch (error) {
        await response.body.cancel().catch(() => {})
        throw error
      }
      // 边下载边落盘，主进程不再同步复制整段视频；原子提交前再次核对账号和文件完整性。
      const saved = await this.files.writeStream('local', { path, project: row.project_id, mime, stream: Readable.fromWeb(response.body), revision: null, signal, beforeCommit: size => {
        if (row.account !== this.cloud.account || authRevision !== this.cloud.authRevision) throw new Error('账号已切换，原任务仍可取回')
        if (existsSync(this.files.fileFor('local', row.project_id, path))) throw Object.assign(new Error('保存位置出现了已有文件，将另存原任务结果'), { status: 409 })
        if (!size) throw new Error('生成原件为空')
        const length = Number(response.headers.get('content-length'))
        if (length > 0 && !response.headers.get('content-encoding') && size !== length) throw new Error('生成原件尚未完整下载，将继续取回同一任务')
      }, onFileCommit: file => {
        // writeStream invokes this synchronously inside the file-index
        // transaction. Either both references commit, or neither does.
        const nextDownload: TaskDownload = { ...download, files: [...download.files.filter(entry => entry?.index !== index), { index, key: taskItemKey(item), ...file }] }
        const nextSnapshot = { ...snapshot, localDownload: nextDownload }
        const changed = this.store.run("UPDATE desktop_tasks SET result=? WHERE request_id=? AND project_id=? AND account=? AND status='saving'", JSON.stringify(nextSnapshot), row.request_id, row.project_id, row.account)
        if (Number(changed.changes) !== 1) throw Object.assign(new Error('本地任务已变化，文件保存已停止'), { status: 409 })
        download = nextDownload; snapshot = nextSnapshot
      } })
      signal.throwIfAborted()
      ready.push({ index, key: taskItemKey(item), path, mime, ...saved })
    }
    return this.publishSavedResult(row, data, ready, signal, authRevision)
  }
  restoreDownload(row, checkpoint: any) {
    if (checkpoint?.version !== 1 || checkpoint.requestId !== row.request_id || checkpoint.source?.status !== 'succeeded'
      || checkpoint.source.requestId !== row.request_id) return
    const data = checkpoint.source
    const items = taskResultItems(row.kind, data)
    if (!items.length || items.some(item => !item?.url || data.parameters?.desktopDelivery === 1 && (typeof item.id !== 'string' || !item.id))) return
    const files = items.map((item, index) => savedTaskFile(row, item, index, checkpoint, path => this.files.locate('local', path, row.project_id)))
    if (files.some(file => !file)) return
    // Fully saved originals can settle without asking for expired/offline
    // transit media. A partial set still queries only the original task.
    return this.publishSavedResult(row, data, files as TaskDownloadFile[], this.operationSignal(), this.cloud.authRevision)
  }
  publishSavedResult(row, data, files: TaskDownloadFile[], signal: AbortSignal, authRevision: number) {
    signal.throwIfAborted()
    if (row.account !== this.cloud.account || authRevision !== this.cloud.authRevision) throw new Error('账号已切换，原任务仍可取回')
    this.store.project(row.project_id)
    const items = taskResultItems(row.kind, data)
    const checkpoint = { version: 1, requestId: row.request_id, files }
    if (!items.length || items.length !== files.length) throw Object.assign(new Error('本机原件尚未完整保存'), { status: 409 })
    const local = items.map((item, index) => localTaskMedia(row, item, files[index]))
    const receipts = items.map((item, index) => ({ id: item.id, size: files[index].size, sha256: files[index].sha256 }))
    const savedFiles = files.map(({ path, revision, sha256 }) => ({ path, revision, sha256 }))
    const result = publicTaskResult({ ...data, status: 'succeeded', ...(data.delivery?.target === 'desktop' ? { delivery: { ...data.delivery, status: 'saved' } } : {}), ...(row.kind === 'video' ? { video: { ...local[0], metadata: { ...data.video?.metadata, workspacePath: local[0].path } } } : { images: local }) })
    const stored = this.localRoutes.has(data.route) ? { ...result, routeState: data.routeState } : result
    this.store.transaction(() => {
      // Recheck the entire batch while holding the final write transaction;
      // an earlier original may have changed while later files downloaded.
      if (items.some((item, index) => !savedTaskFile(row, item, index, checkpoint, path => this.files.locate('local', path, row.project_id)))) throw Object.assign(new Error('本机原件已变化，将重新读取原任务'), { status: 409 })
      const changed = this.store.run("UPDATE desktop_tasks SET status='succeeded',result=? WHERE request_id=? AND project_id=? AND account=? AND status='saving'", JSON.stringify(stored), row.request_id, row.project_id, row.account)
      if (Number(changed.changes) !== 1) throw Object.assign(new Error('本地任务已变化，结果保存已停止'), { status: 409 })
      const canvasSaved = this.patchCanvas(row, local)
      if (data.parameters?.desktopDelivery === 1) this.store.run('INSERT INTO desktop_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'delivery:' + row.request_id, JSON.stringify({ account: row.account, project: row.project_id, results: receipts, savedFiles, canvasSaved, expiresAt: data.parameters.desktopExpiresAt }))
    })
    this.saveSnapshots.delete(row.request_id)
    this.files.flushBytes()
    this.changed?.(row.project_id)
    void this.deliver(row.request_id)
    return result
  }
  patchCanvas(row, items) {
    const nodeId = canvasMediaNodeId(row.directory)
    if (!nodeId) return true
    const newest = this.store.get('SELECT request_id FROM desktop_tasks WHERE project_id=? AND directory=? ORDER BY created_at DESC,rowid DESC LIMIT 1', row.project_id, row.directory)
    if (newest?.request_id !== row.request_id) return true
    return patchCanvasMediaFiles({
      list: () => this.files.list('local', row.project_id),
      read: path => this.files.read('local', path, row.project_id).bytes.toString('utf8'),
      write: (path, text) => { this.files.upsert('local', path, 'application/json', Buffer.from(text), row.project_id) },
    }, { nodeId, requestId: row.request_id, kind: row.kind, items })
  }
  deliver(requestId) {
    if (this.deliveries.has(requestId)) return this.deliveries.get(requestId)
    if (this.controller.signal.aborted || Date.now() < (this.deliveryAfter.get(requestId) || 0)) return Promise.resolve()
    const key = 'delivery:' + requestId
    const pending = this.store.get('SELECT value FROM desktop_meta WHERE key=?', key)
    if (!pending) return Promise.resolve()
    const receipt = JSON.parse(pending.value)
    if (receipt.account !== this.cloud.account) return Promise.resolve()
    if (Date.parse(receipt.expiresAt) <= Date.now()) { this.store.run('DELETE FROM desktop_meta WHERE key=?', key); this.deliveryAfter.delete(requestId); return Promise.resolve() }
    const authRevision = this.cloud.authRevision
    const signal = this.operationSignal()
    let retry = true
    const work = (async () => {
      try {
        this.store.project(receipt.project)
        for (const file of receipt.savedFiles) {
          const current = this.store.get("SELECT revision,blob FROM workspace_files WHERE user_id='local' AND project_id=? AND path=?", receipt.project, file.path)
          if (current?.revision !== file.revision || current.blob !== file.sha256) return
          this.files.locate('local', file.path, receipt.project)
        }
        if (!receipt.canvasSaved) {
          const row = this.store.get('SELECT * FROM desktop_tasks WHERE request_id=?', requestId)
          if (!row) return
          const result = JSON.parse(row.result)
          receipt.canvasSaved = this.patchCanvas(row, row.kind === 'video' ? [result.video] : result.images)
          if (!receipt.canvasSaved) return
          this.store.run('UPDATE desktop_meta SET value=? WHERE key=?', JSON.stringify(receipt), key)
        }
        const data = await this.cloud.json(`/api/imagine/desktop/tasks/${encodeURIComponent(requestId)}/delivered`, { method: 'POST', body: { results: receipt.results }, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })
        if (receipt.account !== this.cloud.account || authRevision !== this.cloud.authRevision) return
        if (data?.requestId !== requestId || data?.delivered !== true) throw new Error('服务器尚未确认本机保存结果')
        this.store.run('DELETE FROM desktop_meta WHERE key=?', key)
        retry = false
      } catch (error) {
        // Expired transit bytes no longer need a cleanup receipt. The durable
        // local result remains successful even when this acknowledgment fails.
        if (error.status === 410 && receipt.account === this.cloud.account && authRevision === this.cloud.authRevision) { this.store.run('DELETE FROM desktop_meta WHERE key=?', key); retry = false }
      } finally { if (retry) this.deliveryAfter.set(requestId, Date.now() + 30_000); else this.deliveryAfter.delete(requestId) }
    })().finally(() => this.deliveries.delete(requestId))
    this.deliveries.set(requestId, work)
    return work
  }
  resume() {
    if (!this.cloud.account || this.controller.signal.aborted) return
    for (const row of this.store.all("SELECT key FROM desktop_meta WHERE key LIKE 'delivery:%' AND json_extract(value,'$.account')=?", this.cloud.account)) void this.deliver(row.key.slice('delivery:'.length))
    for (const row of this.store.all("SELECT * FROM desktop_tasks WHERE account=? AND status NOT IN ('succeeded','failed','cancelled','expired')", this.cloud.account)) this.poll(row).catch(() => {})
  }
  stop() { clearInterval(this.timer); this.controller.abort(); this.accountController.abort() }
}
