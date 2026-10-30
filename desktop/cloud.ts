import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { SessionStorage } from './session-storage.ts'
type CredentialSaveResult = 'saved' | 'superseded' | 'stopped'
export class CloudGateway {
  declare origin: any
  declare fetch: any
  declare onSessionChange: any
  declare changeSession: (commit: () => void) => Promise<void>
  declare onSessionRetiring: () => void
  declare authenticationExpired: boolean
  private sessionChanges = 0
  // 界面语言：渲染进程每个请求都带 Accept-Language（= 当前界面语言），本机运行时记下来，转发云端时原样带上，
  // 云端的用户可见文案才会跟界面语言一致，而不是跟系统语言走。
  private language = ''
  declare storage: SessionStorage
  declare file: any
  declare cookie: string
  declare session: any
  declare status: string
  declare authRevision: number
  declare persistRevision: number
  declare persistQueue: Promise<CredentialSaveResult>
  private persistenceStopped = false
  private stopRequest: Promise<void> | undefined
  declare lastSaved: any
  declare lifetime: AbortController
  declare videoRecords: Map<any, any>
  declare refreshRequest: { revision: number, controller: AbortController, waiters: number, promise: Promise<any> } | undefined

  constructor({ directory, getSafeStorage, credentialProtection, origin = 'https://miaoimg.cn', requestFetch = fetch, onSessionChange = () => {}, onSessionRetiring = () => {}, changeSession = async commit => commit() }: Record<string, any>) {
    const url = new URL(origin)
    // The packaged app remains HTTPS-only. A loopback HTTP origin is available
    // only for an explicitly opted-in local development tunnel, so the
    // developer can exercise a candidate backend without changing public DNS
    // or putting an insecure origin in a release build.
    const localDevHttp = process.env.MIAO_ALLOW_INSECURE_CLOUD_ORIGIN === '1'
      && url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase())
    if ((url.protocol !== 'https:' && !localDevHttp) || url.username || url.password) throw new Error('服务地址不安全，已阻止连接')
    this.origin = url.origin
    this.fetch = requestFetch; this.onSessionChange = onSessionChange
    this.changeSession = changeSession
    this.onSessionRetiring = onSessionRetiring; this.authenticationExpired = false
    this.storage = new SessionStorage({ directory, protection: credentialProtection, getSafeStorage })
    this.file = join(directory, 'cloud-session.enc')
    this.cookie = ''; this.session = null; this.status = 'offline'
    this.authRevision = 0
    this.persistRevision = 0; this.persistQueue = Promise.resolve('saved'); this.lastSaved = ''
    this.lifetime = new AbortController()
  }
  async restore() {
    if (!existsSync(this.file)) return false
    const revision = this.authRevision
    try {
      const encrypted = readFileSync(this.file)
      const decoded = await this.storage.decrypt(encrypted)
      if (!decoded) return false
      const value = JSON.parse(decoded.result)
      if (revision !== this.authRevision || this.lifetime.signal.aborted) return false
      if (value.origin === this.origin) {
        this.cookie = value.cookie || ''; this.session = value.session || null
        this.lastSaved = decoded.result
        if (decoded.shouldReEncrypt) { this.lastSaved = ''; void this.persist() }
        return Boolean(this.cookie)
      }
    } catch { /* 失效或未授权的凭据保留，用户可重新登录。 */ }
    return false
  }
  persist({ required = false }: { required?: boolean } = {}) {
    if (this.persistenceStopped) return Promise.resolve<CredentialSaveResult>('stopped')
    const revision = ++this.persistRevision
    const authRevision = this.authRevision
    const cookie = this.cookie
    const temp = this.file + '.tmp'
    // Network cancellation must not discard a save already accepted locally.
    // Only a newer save or identity may supersede this credential snapshot.
    // An awaited login/password commit must survive same-cookie balance or
    // catalog refreshes. Its own bounded operation is sufficient; do not chase
    // an indefinitely changing background queue to acknowledge credentials.
    const current = () => authRevision === this.authRevision && cookie === this.cookie
      && (required || revision === this.persistRevision)
    let removalError: unknown
    if (!this.cookie) {
      // 退出登录不访问钥匙串；正在等待授权的旧保存也不能恢复登录文件。
      this.lastSaved = ''
      for (const path of [this.file, temp]) { try { rmSync(path, { force: true }) } catch (error) { removalError ??= error } }
      try { this.storage.clear() } catch (error) { removalError ??= error }
    }
    const value = this.cookie ? JSON.stringify({ origin: this.origin, cookie: this.cookie, session: this.session }) : ''
    const pending = this.persistQueue.catch(() => 'superseded' as const).then(async (): Promise<CredentialSaveResult> => {
      if (!current()) return 'superseded'
      if (!value) {
        if (removalError) throw removalError
        return 'saved'
      }
      if (value === this.lastSaved && existsSync(this.file)) return 'saved'
      const encrypted = await this.storage.encrypt(value)
      if (!current()) return 'superseded'
      // 加密结束后只同步提交凭证文件，和退出/切账号的失效检查保持原子性。
      writeFileSync(temp, encrypted, { mode: 0o600 }); renameSync(temp, this.file)
      this.storage.committed()
      this.lastSaved = value
      return 'saved'
    }).catch(error => {
      if (!current()) return 'superseded' as const
      try { rmSync(temp, { force: true }) } catch {}
      throw Object.assign(new Error('登录状态未能保存到本机，请检查可用空间和凭据保护后重试', { cause: error }), { code: 'CREDENTIAL_PERSIST_FAILED' })
    })
    this.persistQueue = pending
    // Background refreshes have no renderer awaiting this result. Observe their
    // failure without exposing credentials, and retain rejection for stop/login.
    void pending.catch(() => console.warn('[cloud-session] CREDENTIAL_PERSIST_FAILED'))
    return pending
  }
  get account() { return this.session?.user?.workspaceKey || this.session?.user?.id || '' }
  get sessionChanging() { return this.sessionChanges > 0 }
  private assertAuthRevision(revision) {
    this.lifetime.signal.throwIfAborted()
    if (revision !== this.authRevision) throw new Error('账号已切换，这次结果已忽略')
  }
  private nextAuthRevision() {
    const revision = ++this.authRevision
    this.refreshRequest?.controller.abort(new Error('账号已切换，这次结果已忽略'))
    return revision
  }
  private async confirmPersistence(persistence: Promise<CredentialSaveResult> | undefined, revision: number) {
    let result: CredentialSaveResult | undefined
    try { result = await persistence }
    catch (error) { this.assertAuthRevision(revision); throw error }
    this.assertAuthRevision(revision)
    if (result !== 'saved') throw Object.assign(new Error('登录状态已变化，这次本机保存未提交，请重新登录'), { status: 409 })
  }
  private async publishSession(session, cookie: string, revision: number) {
    let persistence: Promise<CredentialSaveResult> | undefined
    this.sessionChanges++
    try {
      this.onSessionRetiring()
      await this.changeSession(() => {
        this.assertAuthRevision(revision)
        this.cookie = cookie; this.session = session
        this.authenticationExpired = !session
        this.status = session ? 'online' : 'login-required'
        this.onSessionChange()
        persistence = this.persist({ required: true })
      })
    } finally { this.sessionChanges-- }
    // Commit persistence even if a later renderer navigation retires the view.
    await this.confirmPersistence(persistence, revision)
  }
  updateSession(session, revision: number, credentialsChanged = false) {
    this.assertAuthRevision(revision)
    const account = session?.user?.workspaceKey || session?.user?.id || ''
    if (!session || account !== this.account) throw new Error('账号已切换，这次结果已忽略')
    this.session = session
    if (credentialsChanged) this.nextAuthRevision()
    const persistence = this.persist({ required: credentialsChanged })
    if (!credentialsChanged) return persistence
    const nextRevision = this.authRevision
    return this.confirmPersistence(persistence, nextRevision)
  }
  setLanguage(value: unknown) {
    const tag = String(Array.isArray(value) ? value[0] : value ?? '').split(',')[0].split(';')[0].trim()
    if (/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) this.language = tag
  }
  async request(path, { method = 'GET', body, rawBody, headers = {}, signal, anonymous = false, updateCookie = true }: Record<string, any> = {}) {
    const url = new URL(path, this.origin)
    if (url.origin !== this.origin || !url.pathname.startsWith('/api/')) throw new Error('请求地址无效，请重新打开妙图')
    if (process.env.MIAO_DESKTOP_NO_MEDIA_GENERATION === '1' && method === 'POST' && ['/api/imagine/generate', '/api/imagine/video', '/api/imagine/desktop/generate', '/api/imagine/desktop/video', '/api/ai/media/generate'].includes(url.pathname)) throw Object.assign(new Error('本次剪辑验收禁止图片和视频模型请求'), { status: 403 })
    if (process.env.MIAO_DESKTOP_NO_GENERATION === '1' && method === 'POST' && ['/api/imagine/generate', '/api/imagine/video', '/api/imagine/desktop/generate', '/api/imagine/desktop/video', '/api/imagine/text', '/api/ai/generate', '/api/ai/media/generate', '/api/imagine/desktop/model/chat/completions', '/api/imagine/desktop/model/responses'].includes(url.pathname)) throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
    if (!anonymous && (!this.cookie || this.authenticationExpired)) throw Object.assign(new Error('请先登录账号'), { status: 401 })
    if (!anonymous && this.sessionChanging) throw Object.assign(new Error('账号正在切换，请稍后重试'), { status: 409 })
    const authRevision = this.authRevision
    const sentCookie = this.cookie
    const response = await this.fetch(url, { method, redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, signal || AbortSignal.timeout(/^\/api\/imagine\/(login-password|email\/|password\/reset)/.test(url.pathname) ? 20000 : 120000)]),
      headers: { origin: this.origin, ...(this.language ? { 'accept-language': this.language } : {}), ...(sentCookie ? { cookie: sentCookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.session?.csrf ? { 'x-csrf-token': this.session.csrf } : {}), ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) })
    try { this.assertAuthRevision(authRevision) } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    if (response.status === 401 && !anonymous) {
      await response.body?.cancel().catch(() => {})
      // A password response can rotate the same account's cookie while this
      // older response body is being cancelled. Do not revoke the newer token.
      if (this.cookie === sentCookie) await this.clearSession(authRevision)
      throw Object.assign(new Error('登录已过期，请重新登录'), { status: 401 })
    }
    if (updateCookie && this.cookie === sentCookie) for (const cookie of response.headers.getSetCookie()) if (cookie.startsWith('miao_session=')) this.cookie = cookie.split(';')[0]
    this.status = this.authenticationExpired ? 'login-required' : 'online'
    return response
  }
  private async responseJson(response, revision) {
    // Read with Fetch so cancellation/network errors keep their original cause.
    // A proxy's HTML or empty error body must not erase its HTTP status.
    const text = await response.text()
    this.assertAuthRevision(revision)
    let value
    try { value = JSON.parse(text) }
    catch { throw Object.assign(new Error('云端返回了无法识别的响应，请稍后重试'), { status: response.ok ? 502 : response.status }) }
    if (!response.ok) {
      const error = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      const message = [error.error, error.message].find(value => typeof value === 'string' && value.trim()) || '请求失败，请稍后重试'
      throw Object.assign(new Error(message), { status: response.status, ...(error.errorExplanation ? { errorExplanation: error.errorExplanation } : {}), ...('activeRequestId' in error ? { activeRequestId: error.activeRequestId } : {}) })
    }
    return value
  }
  async json(path, options: Record<string, any> = {}) {
    const revision = this.authRevision
    return this.responseJson(await this.request(path, options), revision)
  }
  private async authenticate(path, payload) {
    const revision = this.nextAuthRevision()
    const response = await this.request(path, { method: 'POST', body: payload, anonymous: true, updateCookie: false })
    const value = await this.responseJson(response, revision)
    this.assertAuthRevision(revision)
    const cookie = response.headers.getSetCookie().findLast(cookie => cookie.startsWith('miao_session='))?.split(';')[0]
    if (!value.session || !cookie || cookie === 'miao_session=') throw new Error('登录响应不完整，请重试。')
    // The native editor saves under its old local project ownership first.
    // Publish cookie and identity together only while that revision is current.
    await this.publishSession(value.session, cookie, revision)
    return this.session
  }
  login(payload) { return this.authenticate('/api/imagine/login-password', payload) }
  loginWithEmailCode(payload) { return this.authenticate('/api/imagine/email/verify-code', payload) }
  resetPassword(payload) { return this.authenticate('/api/imagine/password/reset', payload) }
  async refresh({ signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted()
    if (!this.cookie) return null
    let pending = this.refreshRequest
    if (!pending || pending.revision !== this.authRevision || pending.controller.signal.aborted) {
      const request = { revision: this.authRevision, controller: new AbortController(), waiters: 0, promise: undefined as Promise<any> | undefined }
      const previousAccount = this.account
      request.promise = (async () => {
        const value = await this.json('/api/imagine/session', { signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(20_000)]) })
        this.assertAuthRevision(request.revision)
        request.controller.signal.throwIfAborted()
        if (!value.session) { await this.clearSession(request.revision); return null }
        const nextAccount = value.session.user?.workspaceKey || value.session.user?.id || ''
        if (nextAccount !== previousAccount) await this.publishSession(value.session, this.cookie, this.nextAuthRevision())
        else this.updateSession(value.session, request.revision)
        return this.session
      })().finally(() => { if (this.refreshRequest === request) this.refreshRequest = undefined })
      pending = request as NonNullable<typeof pending>
      this.refreshRequest = pending
    }
    // Pi/Chord cancels only this waiter. A shared refresh continues for other
    // conversations, and its network request ends when the last waiter leaves.
    pending.waiters++
    try { return await awaitWithContext(pending.promise, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT) }
    finally { if (--pending.waiters === 0) pending.controller.abort() }
  }
  async publicFile(path, { method = 'GET', headers = {}, signal }: Record<string, any> = {}) {
    const url = new URL(path, this.origin)
    const archiveMedia = /^\/(images|previews|thumbs|_oip\/sessions|showcase)\//.test(url.pathname)
    const showcasePoster = /^\/landing\/film-[\w-]+\.webp$/.test(url.pathname)
    if (url.origin !== this.origin || !['GET','HEAD'].includes(method) || !(archiveMedia || showcasePoster)) throw new Error('灵感库文件地址无效')
    return this.fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, signal || AbortSignal.timeout(/^\/api\/imagine\/(login-password|email\/|password\/reset)/.test(url.pathname) ? 20000 : 120000)]) })
  }
  async archiveVideo(tweetId, index, { method = 'GET', range, signal }: Record<string, any> = {}) {
    if (!/^\d{10,24}$/.test(tweetId) || !Number.isInteger(index) || index < 1 || index > 20 || !['GET', 'HEAD'].includes(method)) throw Object.assign(new Error('视频地址无效'), { status: 400 })
    this.videoRecords ||= new Map()
    let record = this.videoRecords.get(tweetId)
    if (!record || Date.now() - record.time > 120000) {
      const payload = await this.json('/api/prompts?' + new URLSearchParams({ ids: tweetId, limit: '1' }), { anonymous: true, signal })
      record = { time: Date.now(), videos: payload.items?.find(item => String(item.tweet_id) === tweetId)?.videos || [] }
      if (this.videoRecords.size >= 32) this.videoRecords.delete(this.videoRecords.keys().next().value)
      this.videoRecords.set(tweetId, record)
    }
    const video = record.videos.find(video => video.index === index)
    if (!video) throw Object.assign(new Error('视频尚未收录'), { status: 404 })
    const headers = range ? { range } : {}
    const isVideo = response => response.ok && /^video\//i.test(response.headers.get('content-type') || '')
    // Archive packs contain posters; try the site's clip only when it really is a video file.
    if (new RegExp(`^images/${tweetId}/video_${index}\\.(mp4|webm|mov)$`, 'i').test(video.local || '')) {
      const local = await this.publicFile('/' + video.local, { method, headers, signal })
      if (isVideo(local) || local.status === 416) return local
      await local.body?.cancel()
    }
    const source = new URL(video.url || '', this.origin)
    // A row id, rather than a caller-supplied URL, selects the public source. No cookies or credentials leave the site.
    if (source.protocol !== 'https:' || source.hostname !== 'video.twimg.com' || source.port || source.username || source.password || !/\.mp4$/i.test(source.pathname)) throw Object.assign(new Error('原片暂时不可用，请查看原作来源'), { status: 404 })
    const remote = await this.fetch(source, { method, headers, redirect: 'error', signal: AbortSignal.any([this.lifetime.signal, signal || AbortSignal.timeout(30000)]) })
    if (!isVideo(remote) && remote.status !== 416) { await remote.body?.cancel(); throw Object.assign(new Error('原片暂时无法播放，请查看原作来源'), { status: 502 }) }
    return remote
  }
  async clearSession(revision = this.authRevision) {
    this.assertAuthRevision(revision)
    // Revoke remote access immediately. Retain only local project ownership
    // until the old editor has saved; a failed disk save cannot revive access.
    this.authenticationExpired = true; this.cookie = ''; this.status = 'login-required'
    void this.persist()
    await this.publishSession(null, '', this.nextAuthRevision())
  }
  async logout() {
    const revision = this.nextAuthRevision()
    if (this.cookie) {
      try { await this.json('/api/imagine/logout', { method: 'POST', body: {} }) }
      catch (error) {
        if (error.status !== 401) throw error
        // request() already cleared this expired session. A newer login must
        // not receive a successful acknowledgement for the older logout.
        this.assertAuthRevision(revision + 1)
        return
      }
    }
    this.assertAuthRevision(revision)
    await this.clearSession(revision)
  }
  view() { return { origin: this.origin, account: this.session?.user || null, state: this.status } }
  stop() {
    if (this.stopRequest) return this.stopRequest
    this.persistenceStopped = true
    this.lifetime.abort()
    // No new save can enter after this point. The queue includes superseded
    // encryption work too, so this is a finite join without retries.
    this.stopRequest = this.persistQueue.then(() => {})
    return this.stopRequest
  }
}
