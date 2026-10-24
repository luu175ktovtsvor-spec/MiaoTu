import { disconnectedStatus, liveModelId, localImageParameters, localMediaCapabilities, localMediaKind, localMediaModels, localTextModels, localVideoParameters, type DoubaoKind, type LocalMediaSite } from './catalog.ts'
import type { LocalMediaContext, LocalMediaHost } from './host.ts'
import type { LocalStore } from '../store.ts'
import { createHash, randomUUID } from 'node:crypto'

type PlatformAccount = { id: string; label: string; createdAt: string }
type PlatformAccounts = { activeId: string; accounts: PlatformAccount[] }

export class LocalMediaRouter {
  private store: LocalStore
  private account: () => string
  private sessionState: () => { revision: number; available: boolean }
  private lifetime = new AbortController()
  private closing = false
  readonly host: LocalMediaHost | undefined
  readonly site: LocalMediaSite
  constructor(store: LocalStore, account: () => string, host: LocalMediaHost | undefined, site: LocalMediaSite, sessionState = () => ({ revision: 0, available: true })) {
    this.store = store; this.account = account; this.host = host; this.site = site; this.sessionState = sessionState
  }
  private accountKey(owner: string) {
    const identity = createHash('sha256').update('local-media-accounts\u0000' + this.site.id + '\u0000' + owner).digest('hex')
    return 'local-media-accounts:' + identity
  }
  private accountLabel(value: unknown, fallback: string) {
    const label = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 40) : ''
    return label || fallback
  }
  private accountState(owner: string): PlatformAccounts {
    let saved: Partial<PlatformAccounts> = {}
    try { saved = JSON.parse(this.store.get('SELECT value FROM desktop_meta WHERE key=?', this.accountKey(owner))?.value || '{}') } catch {}
    const accounts = (Array.isArray(saved.accounts) ? saved.accounts : [])
      .filter((item): item is PlatformAccount => !!item && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id))
      .map((item, index) => ({ id: item.id, label: this.accountLabel(item.label, this.site.label + ' 账号 ' + (index + 1)), createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString() }))
      .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index)
    if (!accounts.some(item => item.id === 'default')) accounts.unshift({ id: 'default', label: this.site.label + ' 账号 1', createdAt: new Date().toISOString() })
    const activeId = accounts.some(item => item.id === saved.activeId) ? saved.activeId! : accounts[0].id
    return { activeId, accounts }
  }
  private saveAccountState(owner: string, value: PlatformAccounts) {
    this.store.run('INSERT INTO desktop_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', this.accountKey(owner), JSON.stringify(value))
  }
  private activeAccount(owner: string) {
    const state = this.accountState(owner)
    return state.accounts.find(item => item.id === state.activeId) || state.accounts[0]
  }
  private taskAccountId(saved: any) {
    return /^[A-Za-z0-9_-]{1,64}$/.test(String(saved?.routeState?.platformAccountId || '')) ? String(saved.routeState.platformAccountId) : 'default'
  }
  view() {
    const owner = this.account()
    const state = this.sessionState()
    const accounts = this.accountState(owner)
    const active = this.activeAccount(owner)
    const status = state.available ? this.host?.view(owner, active.id, state.revision) || disconnectedStatus(this.site.label) : disconnectedStatus(this.site.label)
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString()
    // Status refreshes must not copy every historic prompt/result into the
    // Electron main process. Aggregate only today's rows in local calendar time.
    const rows = owner ? this.store.all("SELECT kind,status,json_extract(result,'$.routeState.phase') AS phase,COUNT(*) AS total FROM desktop_tasks WHERE account=? AND created_at>=? AND created_at<? AND json_extract(result,'$.route')=? AND COALESCE(json_extract(result,'$.routeState.platformAccountId'),'default')=? GROUP BY kind,status,phase", owner, start, end, this.site.provider, active.id) : []
    const usage = (kind: DoubaoKind) => {
      const selected = rows.filter(row => row.kind === kind)
      const count = (matches: (row: any) => boolean) => selected.reduce((total, row) => total + (matches(row) ? Number(row.total) : 0), 0)
      return { submitted: count(row => ['accepted', 'completed'].includes(row.phase)),
        confirming: count(row => row.phase === 'dispatching'),
        succeeded: count(row => row.status === 'succeeded'),
        pending: count(row => !['succeeded', 'failed', 'cancelled', 'expired'].includes(row.status)) }
    }
    const pending = owner ? this.store.all("SELECT request_id,kind,status,created_at,json_extract(result,'$.routeState.conversationUrl') AS conversation_url,COALESCE(json_extract(result,'$.routeState.platformAccountId'),'default') AS account_id,json_extract(result,'$.routeState.platformAccountLabel') AS account_label FROM desktop_tasks WHERE account=? AND status NOT IN ('succeeded','failed','cancelled','expired') AND json_extract(result,'$.route')=? ORDER BY created_at", owner, this.site.provider)
      .map(row => ({ id: row.request_id, kind: row.kind, status: row.status, createdAt: row.created_at, needsBinding: !row.conversation_url, accountId: row.account_id, accountLabel: row.account_label || accounts.accounts.find(item => item.id === row.account_id)?.label || '默认账号' })) : []
    const upstreamId = (modelId: string) => status.menu?.models.find(item => liveModelId(this.site, item) === modelId)?.key || ''
    const models = state.available ? localMediaModels(this.site, status).map(model => ({ ...model, upstreamModelId: upstreamId(model.modelId) })) : []
    const textModels = state.available ? localTextModels(this.site, status).map(model => ({ ...model, upstreamModelId: upstreamId(model.modelId) })) : []
    return { ok: true, ...status, available: !!this.host, accountId: active.id, accounts: accounts.accounts.map(item => ({ ...item, active: item.id === active.id })), models, textModels, usage: { image: usage('image'), video: usage('video'), text: usage('text') }, pending }
  }
  models() {
    const state = this.sessionState()
    const owner = this.account()
    return localMediaModels(this.site, state.available ? this.host?.view(owner, this.activeAccount(owner).id, state.revision) || disconnectedStatus(this.site.label) : disconnectedStatus(this.site.label))
  }
  async prepareModels(signal?: AbortSignal) {
    if (!this.host) return
    const state = this.sessionState()
    if (!state.available) return
    const scope = this.capture(signal)
    const current = this.host.view(scope.owner, scope.platformAccountId, state.revision)
    if (current.menu?.loaded && Date.now() - Date.parse(current.menu.checkedAt) < 30_000) return
    if (!current.connected && current.menu?.loaded) return
    try {
      if (!current.connected && !current.checkedAt && !await this.host.hasSavedLogin(scope.owner, scope.platformAccountId, scope)) return
      await this.host.refresh(scope.owner, scope.platformAccountId, scope)
    } catch { /* the node keeps the last menu, or stays empty until the page can be read */ }
  }
  textModels() {
    const state = this.sessionState()
    const owner = this.account()
    return localTextModels(this.site, state.available ? this.host?.view(owner, this.activeAccount(owner).id, state.revision) || disconnectedStatus(this.site.label) : disconnectedStatus(this.site.label))
  }
  private capture(signal?: AbortSignal, requestedAccountId?: string): LocalMediaContext & { owner: string } {
    if (!this.host) throw Object.assign(new Error(`请在妙图桌面客户端连接${this.site.label}`), { status: 503 })
    const owner = this.account(), { revision } = this.sessionState()
    if (!owner) throw Object.assign(new Error('请先登录妙图账户'), { status: 401 })
    const lifetime = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])])
    const assert = () => {
      lifetime.throwIfAborted()
      const state = this.sessionState()
      if (this.closing || owner !== this.account() || revision !== state.revision || !state.available) throw Object.assign(new Error('妙图账户正在切换或已失效，请重新读取'), { status: 409 })
    }
    const account = this.accountState(owner)
    const platformAccount = requestedAccountId ? account.accounts.find(item => item.id === requestedAccountId) : this.activeAccount(owner)
    if (!platformAccount) throw Object.assign(new Error(`原${this.site.label}账号已不存在，请重新关联原任务`), { status: 409 })
    assert()
    return { owner, revision, signal: lifetime, assert, platformAccountId: platformAccount.id, platformAccountLabel: platformAccount.label }
  }
  private assertRow(row: any, scope: LocalMediaContext & { owner: string }) {
    scope.assert()
    if (row.account !== scope.owner) throw Object.assign(new Error('请登录提交此任务的账号'), { status: 401 })
    this.store.project(row.project_id)
  }
  async action(action: string, payload: Record<string, any> = {}, signal?: AbortSignal) {
    const scope = this.capture(signal), owner = scope.owner, host = this.host!
    if (['add-account', 'select-account', 'rename-account', 'remove-account'].includes(action)) {
      const state = this.accountState(owner)
      if (action === 'add-account') {
        const id = randomUUID()
        const account = { id, label: this.accountLabel(payload.label, this.site.label + ' 账号 ' + (state.accounts.length + 1)), createdAt: new Date().toISOString() }
        this.saveAccountState(owner, { activeId: id, accounts: [...state.accounts, account] })
        const next = this.capture(signal, id)
        await host.login(owner, id, next)
      } else if (action === 'select-account') {
        const id = String(payload.accountId || '')
        if (!state.accounts.some(item => item.id === id)) throw Object.assign(new Error('要切换的平台账号不存在'), { status: 404 })
        this.saveAccountState(owner, { ...state, activeId: id })
        await host.refresh(owner, id, this.capture(signal, id)).catch(() => {})
      } else if (action === 'rename-account') {
        const id = String(payload.accountId || '')
        const account = state.accounts.find(item => item.id === id)
        if (!account) throw Object.assign(new Error('要重命名的平台账号不存在'), { status: 404 })
        account.label = this.accountLabel(payload.label, account.label)
        this.saveAccountState(owner, state)
      } else if (action === 'remove-account') {
        const id = String(payload.accountId || '')
        if (id === 'default') throw Object.assign(new Error('默认平台账号不能删除，可以清空登录状态或重命名'), { status: 422 })
        if (state.accounts.length <= 1 || !state.accounts.some(item => item.id === id)) throw Object.assign(new Error('要删除的平台账号不存在'), { status: 404 })
        this.assertIdle(owner, '', id)
        await host.disconnect(owner, id, this.capture(signal, id), () => { scope.assert(); this.assertIdle(owner, '', id) })
        const accounts = state.accounts.filter(item => item.id !== id)
        this.saveAccountState(owner, { activeId: state.activeId === id ? accounts[0].id : state.activeId, accounts })
      }
      scope.assert()
      return this.view()
    }
    if (action === 'bind-current') {
      const row = this.store.get("SELECT * FROM desktop_tasks WHERE request_id=? AND account=? AND json_extract(result,'$.route')=?", String(payload.requestId || ''), owner, this.site.provider)
      if (!row || ['succeeded', 'failed', 'cancelled', 'expired'].includes(row.status)) throw Object.assign(new Error('原任务不存在或已结束'), { status: 404 })
      this.assertRow(row, scope)
      const saved = JSON.parse(row.result || '{}')
      if (saved.routeState?.conversationUrl) throw Object.assign(new Error('原任务已有对话编号，将继续取回原对话'), { status: 409 })
      const accountId = this.taskAccountId(saved)
      const registry = this.accountState(owner)
      if (registry.accounts.some(item => item.id === accountId) && registry.activeId !== accountId) this.saveAccountState(owner, { ...registry, activeId: accountId })
      const url = await host.bindCurrent(owner, accountId, row.request_id, saved.prompt || '', row.kind, this.capture(signal, accountId))
      this.checkpoint(row, { phase: 'accepted', conversationUrl: url, kind: row.kind }, scope)
    } else if (action === 'disconnect') {
      this.assertIdle(owner, '', scope.platformAccountId)
      await host.disconnect(owner, scope.platformAccountId, scope, () => { scope.assert(); this.assertIdle(owner, '', scope.platformAccountId) })
    } else if (action === 'login' || action === 'open') await host.login(owner, scope.platformAccountId, scope)
    else if (action === 'refresh') await host.refresh(owner, scope.platformAccountId, scope)
    else throw Object.assign(new Error(`未知${this.site.label}操作`), { status: 422 })
    scope.assert()
    return this.view()
  }
  assertIdle(owner = this.account(), except = '', platformAccountId = '') {
    const active = this.store.get("SELECT request_id FROM desktop_tasks WHERE account=? AND json_extract(result,'$.route')=? AND request_id<>? AND status NOT IN ('succeeded','failed','cancelled','expired') AND (?='' OR COALESCE(json_extract(result,'$.routeState.platformAccountId'),'default')=?) LIMIT 1", owner, this.site.provider, except, platformAccountId, platformAccountId)
    if (active) throw Object.assign(new Error(`${this.site.label}仍有任务待取回，请先处理原任务`), { status: 409 })
  }
  async validate(kind: string, body: Record<string, any>, estimate = false, signal?: AbortSignal) {
    const scope = this.capture(signal)
    if (localMediaKind(body.model) !== kind || body.providerId && body.providerId !== this.site.provider) throw Object.assign(new Error(`${this.site.label}路由与所选模型不匹配`), { status: 422 })
    if (!estimate && (typeof body.prompt !== 'string' || !body.prompt.trim())) throw Object.assign(new Error(`请填写有效的${this.site.label}生成提示词`), { status: 422 })
    const capabilities = localMediaCapabilities(body.model, this.site.provider)
    const maxImages = capabilities?.references.maxImages || 0
    if (body.referenceFiles !== undefined && (!Array.isArray(body.referenceFiles) || body.referenceFiles.length > maxImages || body.referenceFiles.some((file: any) => !file || typeof file.path !== 'string' || !file.path || /^(?:[a-z]+:|[\\/])/i.test(file.path)))) throw Object.assign(new Error(maxImages ? `${this.site.label}参考图必须来自当前本机项目，最多 ${maxImages} 张` : `当前${this.site.label}路由不支持参考图`), { status: 422 })
    if (body.edit || body.layerDecomposition || body.references?.length || body.images?.length || body.videos?.length || body.audios?.length || body.referenceVoices?.length || body.keyframes?.length || body.image || body.firstFrame || body.lastFrame) throw Object.assign(new Error(`当前${this.site.label}路由尚未接入此类参考素材或局部重绘，请移除参考或切换模型`), { status: 422 })
    let status = this.host!.view(scope.owner, scope.platformAccountId, scope.revision)
    if (!status.checkedAt || Date.now() - Date.parse(status.checkedAt) > 30_000 || status.connected && !status.menu?.loaded) status = await this.host!.refresh(scope.owner, scope.platformAccountId, scope)
    scope.assert()
    if (!status.connected) throw Object.assign(new Error(status.message || `请先在设置中登录${this.site.label}`), { status: 409 })
    if ((kind === 'image' || kind === 'video') && !status.menu?.loaded) throw Object.assign(new Error(`${this.site.label}还没有读到当前账号的图片和视频菜单，尚未提交。请打开${this.site.label}窗口，等型号出现后再发送`), { status: 409 })
    if ((kind === 'image' || kind === 'video') && !status.menu.models.some(item => liveModelId(this.site, item) === body.model)) throw Object.assign(new Error(`${this.site.label}当前账号的创作菜单里没有这个型号，尚未提交`), { status: 422 })
    const videoParameters = kind === 'video' ? localVideoParameters(body.model, status.menu) : undefined
    const imageParameters = kind === 'image' ? localImageParameters(body.model, status.menu) : undefined
    if (videoParameters && (body.duration !== undefined && !videoParameters.durations.includes(body.duration) || body.ratio && !videoParameters.ratios.includes(body.ratio) || body.resolution && !videoParameters.resolutions.includes(body.resolution))) throw Object.assign(new Error(`${this.site.label}当前型号不支持所选时长、比例或清晰度，尚未提交；未开放的清晰度跟随平台`), { status: 422 })
    if (imageParameters && body.ratio && !imageParameters.ratios.includes(body.ratio)) throw Object.assign(new Error(`${this.site.label}当前图片型号不支持所选比例，尚未提交`), { status: 422 })
    if (body.generateAudio !== undefined || body.fps !== undefined || body.seed !== undefined || body.format || body.inputFidelity || body.optimizePrompt) throw Object.assign(new Error(`${this.site.label}当前路由尚未接入声音、帧率、种子或输出格式设置，尚未提交；这些选项跟随平台`), { status: 422 })
    if (Number(body.count || 1) !== 1 || body.size && body.size !== 'auto' || !videoParameters && !imageParameters && (body.ratio && body.ratio !== 'auto' || body.duration || body.resolution) || imageParameters && (body.duration || body.resolution) || body.quality || body.background === 'transparent') throw Object.assign(new Error(`当前${this.site.label}路由使用${this.site.label}页面的参数，请在${this.site.label}窗口调整`), { status: 422 })
    scope.assert()
    if (status[kind].remaining === 0 && status[kind].source === 'platform') throw Object.assign(new Error(`${this.site.label}返回的对应生成额度已用完，请刷新额度或切换模型`), { status: 402 })
  }
  checkpoint(row: any, state: Record<string, any>, scope: LocalMediaContext & { owner: string }) {
    this.assertRow(row, scope)
    const latest = this.store.get('SELECT result,status FROM desktop_tasks WHERE request_id=? AND account=? AND project_id=?', row.request_id, row.account, row.project_id)
    if (!latest || ['succeeded', 'failed', 'cancelled', 'expired'].includes(latest.status)) throw new Error(`${this.site.label}任务已结束`)
    const result = JSON.parse(latest.result || '{}')
    const { submissionPhase: _phase, ...previous } = result
    const saved = previous.routeState || {}
    if (saved.conversationUrl && state.conversationUrl && saved.conversationUrl !== state.conversationUrl) throw new Error('原平台对话编号不可更换')
    if (saved.upstream && state.upstream && ['modelKey', 'modeKey', 'abilityType', 'duration', 'ratio', 'resolution'].some(key => saved.upstream[key] !== undefined && state.upstream[key] !== undefined && saved.upstream[key] !== state.upstream[key])) throw new Error('原平台请求的路由回执不一致，已保留原记录')
    const phases = ['preparing', 'dispatching', 'accepted', 'completed']
    if (state.phase === 'not-sent' && phases.indexOf(saved.phase) >= 2) throw new Error('原任务已取得平台回执，不能改为未发送')
    // Pollers can have queued an older snapshot while submission was still
    // obtaining its receipt. They must not erase verified wire parameters.
    const next = { ...saved, ...state,
      ...(phases.indexOf(saved.phase) > phases.indexOf(state.phase) && state.phase !== 'not-sent' ? { phase: saved.phase } : {}),
      ...(saved.conversationUrl ? { conversationUrl: saved.conversationUrl } : {}),
      ...(saved.upstream ? { upstream: { ...state.upstream, ...saved.upstream } } : {}),
    }
    this.store.run('UPDATE desktop_tasks SET result=? WHERE request_id=? AND account=? AND project_id=?', JSON.stringify({ ...previous, route: this.site.provider, routeState: next }), row.request_id, row.account, row.project_id)
  }
  async submit(row: any, body: Record<string, any>, signal: AbortSignal) {
    const scope = this.capture(signal); this.assertRow(row, scope)
    this.checkpoint(row, { phase: 'preparing', kind: row.kind, platformAccountId: scope.platformAccountId, platformAccountLabel: scope.platformAccountLabel }, scope)
    const result = await this.host!.submit(row.account, scope.platformAccountId, row.request_id, row.kind, body, state => this.checkpoint(row, state, scope), scope)
    this.assertRow(row, scope)
    return result
  }
  async poll(row: any, saved: any, signal?: AbortSignal) {
    const accountId = this.taskAccountId(saved)
    const scope = this.capture(signal, accountId); this.assertRow(row, scope)
    try {
      const result = await this.host!.poll(row.account, accountId, row.request_id, row.kind, saved.routeState || {}, state => this.checkpoint(row, state, scope), saved.prompt || '', scope)
      this.assertRow(row, scope)
      return result
    } catch {
      this.assertRow(row, scope)
      return { ok: true, requestId: row.request_id, status: 'running', error: `原${this.site.label}任务暂未能读取，请打开${this.site.label}窗口检查网络或登录状态；不会重发` }
    }
  }
  async cancel(row: any, saved: any, signal?: AbortSignal) {
    const accountId = this.taskAccountId(saved)
    const scope = this.capture(signal, accountId); this.assertRow(row, scope)
    const result = await this.host!.cancel(row.account, accountId, row.request_id, saved.routeState || {}, saved.prompt || '', scope)
    this.assertRow(row, scope)
    return result
  }
  async download(row: any, url: string, signal: AbortSignal) {
    let saved: Record<string, any> = {}
    try { saved = JSON.parse(row.result || '{}') } catch {}
    const accountId = this.taskAccountId(saved)
    const scope = this.capture(signal, accountId); this.assertRow(row, scope)
    const response = await this.host!.download(row.account, accountId, url, scope)
    try { this.assertRow(row, scope) } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    return response
  }
  retire(owner: string) {
    this.lifetime.abort(new DOMException('本机平台账户已退场', 'AbortError')); this.lifetime = new AbortController()
    return this.host?.retire(owner) || Promise.resolve()
  }
  stop() {
    this.closing = true; this.lifetime.abort(new DOMException('本机平台正在关闭', 'AbortError'))
    return this.host?.stop() || Promise.resolve()
  }
}
