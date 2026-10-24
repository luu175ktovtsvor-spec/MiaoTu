import type { BrowserWindow, Session as ElectronSession } from 'electron'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { disconnectedStatus, liveModelId, liveSelection, localModelSelection, localVideoParameters, readQuota, type DoubaoKind, type DoubaoStatus, type LiveMenu, type LocalMediaSite } from './catalog.ts'
import { acceptLiveMenu, creationMenuSource, parseLiveCreationMenu } from './menu.ts'
import { localMediaPage } from './page.ts'
import { generationRouteMismatch, readGenerationRoute, type PlatformExpectedRoute, type PlatformGenerationRoute } from './protocol.ts'
import { platformVideoDownload, replyVideoId } from './resources.ts'
import { platformWatermarkPreference } from './watermark.ts'

export type LocalMediaContext = { revision: number; signal?: AbortSignal; assert: () => void; platformAccountId?: string; platformAccountLabel?: string }
type Observation = { conversationUrl?: string; previousUrl?: string; stable?: { key: string; samples: number }; streams?: Set<number>; expectedRoute?: PlatformExpectedRoute; upstream?: PlatformGenerationRoute; routeVerified?: boolean; confirmationSent?: boolean; rejection?: string; dispatchSignal?: AbortSignal }
type Entry = {
  owner: string; accountId: string; key: string; revision: number; controller: AbortController; session: ElectronSession
  window?: BrowserWindow; children: Set<BrowserWindow>; status: DoubaoStatus; menuBodies: string[]
  tail: Promise<void>; pending: Set<Promise<unknown>>; busy?: string
  observations: Map<string, Observation>; checking?: Promise<DoubaoStatus>
  dispatching?: string; unbound?: string; streams: Map<number, string>
}

export class LocalMediaHost {
  private entries = new Map<string, Entry>()
  private tails = new Map<string, Promise<void>>()
  private pending = new Set<Promise<unknown>>()
  private retired = new Map<string, number>()
  private closing = false
  private stopped?: Promise<void>
  private electron: typeof import('electron')
  readonly site: LocalMediaSite
  constructor(electron: typeof import('electron'), site: LocalMediaSite) { this.electron = electron; this.site = site }
  private conversation(value: string) {
    try {
      const url = new URL(value)
      if (url.origin !== new URL(this.site.home).origin) return ''
      // Doubao may keep a freshly-created task on /chat/ while its SPA has
      // already rendered the new user/assistant turns. The DOM prompt match
      // below is the binding proof in that form; the numeric URL is still
      // preferred when the platform provides it.
      return /^\/chat\/(?:\d{8,})\/?$/.test(url.pathname) || this.site.id === 'doubao' && url.pathname === '/chat/' ? url.origin + url.pathname : ''
    } catch { return '' }
  }
  private navigable(value: string) { try { const url = new URL(value); return url.protocol === 'https:' && this.site.hosts.includes(url.hostname) } catch { return false } }
  private mediaUrl(value: string) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !this.site.mediaHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('平台产物地址不在已确认的媒体域名范围')
    return url.href
  }
  private accountId(value?: string) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : 'default'
  }
  private entryKey(owner: string, accountId: string) {
    return owner + '\u0000' + accountId
  }
  private assert(entry: Entry, context: LocalMediaContext, signal?: AbortSignal) {
    context.assert(); context.signal?.throwIfAborted(); signal?.throwIfAborted(); entry.controller.signal.throwIfAborted()
    if (this.closing || this.entries.get(entry.key) !== entry || entry.revision !== context.revision) throw Object.assign(new Error('本机平台会话已退场，请重新读取'), { status: 409 })
  }
  private destroyWindow(entry: Entry) {
    for (const child of entry.children) if (!child.isDestroyed()) child.destroy()
    entry.children.clear()
    const window = entry.window; entry.window = undefined
    if (window && !window.isDestroyed()) {
      try { if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach() } catch { /* the window is already going away */ }
      window.destroy()
    }
  }
  // The page's own client signs get_item_conf. A later fetch from page script
  // is not that request. Keep only the response text long enough to parse models.
  private async observeMenu(entry: Entry, window: BrowserWindow) {
    const dbg = window.webContents.debugger
    try { if (!dbg.isAttached()) dbg.attach('1.3') } catch { return }
    const watched = new Set<string>()
    const take = async (requestId: unknown) => {
      const id = String(requestId || '')
      if (!id || watched.has(id) || window.isDestroyed() || !dbg.isAttached()) return
      watched.add(id)
      let best = ''
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await dbg.sendCommand('Network.getResponseBody', { requestId: id })
          const text = result?.base64Encoded ? Buffer.from(String(result.body || ''), 'base64').toString('utf8') : String(result?.body || '')
          if (text && text.length <= 1_500_000 && text.length >= best.length && /option_key|modelKey|selector_list/.test(text)) {
            const grew = text.length > best.length
            best = text
            if (!grew) break
          } else if (best) break
        } catch { /* the body can still be incomplete when the status arrives */ }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      if (!best) { watched.delete(id); return }
      if (!entry.menuBodies.includes(best)) entry.menuBodies = [...entry.menuBodies, best].slice(-4)
    }
    const enable = () => { if (!window.isDestroyed() && dbg.isAttached()) void dbg.sendCommand('Network.enable').catch(() => {}) }
    dbg.on('message', (_event, method, params) => {
      if (entry.controller.signal.aborted || window.isDestroyed()) return
      const url = String(params?.response?.url || params?.request?.url || '')
      if (!url.includes('/alice/slot/action_bar_v3/get_item_conf')) return
      // The main frame often fails after this response is already complete.
      // Waiting for loadingFinished drops the menu, so read it on both events.
      if (method === 'Network.responseReceived' || method === 'Network.loadingFinished') void take(params.requestId)
    })
    // Enabling the network domain before the renderer exists never settles.
    // Arm it now and again as navigation starts, without blocking the page.
    enable()
    window.webContents.on('did-start-navigation', enable)
  }
  private revoke(entry: Entry) {
    entry.controller.abort(new DOMException('本机平台会话已退场', 'AbortError'))
    this.destroyWindow(entry)
    this.retired.set(entry.key, Math.max(this.retired.get(entry.key) ?? -1, entry.revision))
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
  }
  private entry(owner: string, requestedAccountId: string | undefined, context: LocalMediaContext) {
    context.assert(); context.signal?.throwIfAborted()
    if (this.closing) throw new DOMException('本机平台正在关闭', 'AbortError')
    if (!owner) throw Object.assign(new Error('请先登录妙图账户'), { status: 401 })
    const accountId = this.accountId(requestedAccountId)
    const key = this.entryKey(owner, accountId)
    if (context.revision <= (this.retired.get(key) ?? -1)) throw Object.assign(new Error('本机平台会话已退场，请重新读取'), { status: 409 })
    let entry = this.entries.get(key)
    if (entry && entry.revision !== context.revision) { this.revoke(entry); entry = undefined }
    if (!entry) {
      const partitionIdentity = accountId === 'default' ? owner : this.entryKey(owner, accountId)
      const partitionKey = createHash('sha256').update(partitionIdentity).digest('hex')
      const profile = this.electron.session.fromPartition('persist:miao-' + this.site.id + '-' + partitionKey)
      profile.setPermissionRequestHandler((_web, _permission, callback) => callback(false))
      profile.setPermissionCheckHandler(() => false)
      entry = { owner, accountId, key, revision: context.revision, controller: new AbortController(), session: profile,
        children: new Set(), status: disconnectedStatus(this.site.label), menuBodies: [], tail: this.tails.get(key) || Promise.resolve(), pending: new Set(), observations: new Map(), streams: new Map() }
      {
        // Verify only generation routing fields before dispatch, then observe
        // stream lifetimes. Never retain bodies, credentials or signed URLs.
        const current = entry
        const filter = { urls: [new URL(this.site.home).origin + '/*chat/completion*'] }
        profile.webRequest.onBeforeRequest(filter, async (details, callback) => {
          // The development no-generation switch also covers direct platform
          // window / Worker traffic, not only the local HTTP submission API.
          if (process.env.MIAO_DESKTOP_NO_GENERATION === '1') { callback({ cancel: true }); return }
          const id = current.dispatching, observation = id && current.observations.get(id)
          // The platform can send through its SharedWorker. This account's
          // isolated Session is the ownership boundary; webContentsId may be 0.
          if (observation && details.method === 'POST') {
            if (observation.expectedRoute && new URL(details.url).pathname.endsWith('/chat/completion')) {
              let actual: PlatformGenerationRoute | undefined
              try {
                const data = await Promise.all((details.uploadData || []).map(async part => ({ bytes: part.bytes || (part.blobUUID ? await Promise.race([profile.getBlobData(part.blobUUID), delay(5000, undefined, { signal: current.controller.signal, ref: false })]) : undefined) })))
                actual = readGenerationRoute(data)
              } catch { /* Unreadable routing data must never be sent blind. */ }
              if (current.controller.signal.aborted || observation.dispatchSignal?.aborted || this.closing || this.entries.get(current.key) !== current || current.dispatching !== id) { callback({ cancel: true }); return }
              const mismatch = generationRouteMismatch(actual, observation.expectedRoute, this.site.label)
              if (mismatch) {
                observation.rejection = mismatch
                callback({ cancel: true })
                // Stop the page as well: its own transport retries must not
                // outlive the rejected canvas submission.
                this.destroyWindow(current)
                return
              }
              observation.upstream ??= actual
            }
            ;(observation.streams ??= new Set()).add(details.id); current.streams.set(details.id, id)
          }
          callback({})
        })
        profile.webRequest.onCompleted(filter, details => {
          const id = current.streams.get(details.id), observation = id && current.observations.get(id)
          observation?.streams?.delete(details.id)
          current.streams.delete(details.id)
        })
        profile.webRequest.onErrorOccurred(filter, details => {
          const id = current.streams.get(details.id), observation = id && current.observations.get(id)
          observation?.streams?.delete(details.id); current.streams.delete(details.id)
        })
      }
      this.entries.set(key, entry)
    }
    return entry
  }
  private track<T>(entry: Entry, work: Promise<T>) {
    entry.pending.add(work); this.pending.add(work)
    const finish = () => { entry.pending.delete(work); this.pending.delete(work) }
    void work.then(finish, finish)
    return work
  }
  // Only navigation and DOM access are exclusive; accepted platform jobs run
  // concurrently after their submission releases this short browser lease.
  private queue<T>(entry: Entry, context: LocalMediaContext, name: string, operation: (signal: AbortSignal) => Promise<T>) {
    this.assert(entry, context)
    const signal = AbortSignal.any([entry.controller.signal, ...(context.signal ? [context.signal] : [])])
    const work = entry.tail.then(async () => {
      this.assert(entry, context, signal)
      entry.busy = name
      // Release actual Electron navigation/JS, rather than only rejecting a
      // caller while a late send remains queued in the shared webContents.
      const abort = () => this.destroyWindow(entry)
      signal.addEventListener('abort', abort, { once: true })
      try {
        this.assert(entry, context, signal)
        const result = await operation(signal)
        this.assert(entry, context, signal)
        return result
      } finally { signal.removeEventListener('abort', abort); entry.busy = undefined }
    })
    // A replacement revision reuses this owner's tail too: non-cancellable
    // cookie/storage cleanup must finish before the same partition is reopened.
    const tail = work.then(() => {}, () => {})
    entry.tail = tail; this.tails.set(entry.key, tail)
    void tail.then(() => { if (this.tails.get(entry.key) === tail) this.tails.delete(entry.key) })
    return this.track(entry, work)
  }
  private async window(entry: Entry, context: LocalMediaContext, signal: AbortSignal, show = false) {
    this.assert(entry, context, signal)
    if (!entry.window || entry.window.isDestroyed()) {
      const window = new this.electron.BrowserWindow({ width: 1100, height: 820, show,
        title: `${this.site.label} · 妙图`, autoHideMenuBar: true,
        webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
      })
      entry.window = window
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (entry.controller.signal.aborted || this.closing || !this.navigable(url) || entry.busy && entry.busy !== 'login') return { action: 'deny' }
        return { action: 'allow', overrideBrowserWindowOptions: { parent: window, width: 600, height: 760,
          webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true, sandbox: true } } }
      })
      window.webContents.on('did-create-window', child => {
        if (entry.controller.signal.aborted || this.closing) { child.destroy(); return }
        entry.children.add(child); child.on('closed', () => entry.children.delete(child))
        child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        child.webContents.on('will-navigate', (event, url) => { if (!this.navigable(url)) event.preventDefault() })
        child.webContents.on('will-redirect', (event, url) => { if (!this.navigable(url)) event.preventDefault() })
      })
      window.webContents.on('will-navigate', (event, url) => { if (!this.navigable(url)) event.preventDefault() })
      window.webContents.on('will-redirect', (event, url) => { if (!this.navigable(url)) event.preventDefault() })
      let loadFailed = false
      window.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => { if (isMainFrame) loadFailed = true })
      window.webContents.on('did-finish-load', () => { loadFailed = false })
      window.on('close', event => { if (entry.busy || entry.observations.size) { event.preventDefault(); window.hide() } })
      await this.observeMenu(entry, window)
      const loadHome = () => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${this.site.label}页面加载超时`)), 20_000)
        window.loadURL(this.site.home).then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
      })
      const pageOpen = () => {
        if (window.isDestroyed()) return false
        const current = window.webContents.getURL()
        return !loadFailed && this.navigable(current) && !current.startsWith('chrome-error:')
      }
      await loadHome().catch(async error => {
        if (window.isDestroyed()) throw error
        if (pageOpen()) return
        await delay(600, undefined, { signal })
        this.assert(entry, context, signal)
        if (window.isDestroyed() || pageOpen()) return
        await loadHome().catch(retryError => {
          if (window.isDestroyed() || !pageOpen()) throw retryError
        })
      })
      this.assert(entry, context, signal)
    }
    if (show) { entry.window.show(); entry.window.focus() }
    return entry.window
  }
  private async navigate(entry: Entry, context: LocalMediaContext, signal: AbortSignal, location: string) {
    const window = await this.window(entry, context, signal)
    this.assert(entry, context, signal)
    if (this.conversation(window.webContents.getURL()) !== location) {
      await window.loadURL(location)
      this.assert(entry, context, signal)
    }
  }
  private async run(entry: Entry, context: LocalMediaContext, signal: AbortSignal, action: string, payload: Record<string, any> = {}) {
    this.assert(entry, context, signal)
    if (!entry.window || entry.window.isDestroyed() || new URL(entry.window.webContents.getURL()).origin !== new URL(this.site.home).origin) throw new Error(`${this.site.label}窗口不可用，请重新连接`)
    const result = await entry.window.webContents.executeJavaScript(`(${localMediaPage.toString()})(${JSON.stringify(action)},${JSON.stringify({ ...payload, platform: this.site.id })})`, true)
    this.assert(entry, context, signal)
    return result
  }
  private async click(entry: Entry, context: LocalMediaContext, signal: AbortSignal, target: any) {
    this.assert(entry, context, signal)
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error(`${this.site.label}页面控件不可用，本次尚未发送`)
    const position = { x: target.x, y: target.y, button: 'left', clickCount: 1 }
    // sendInputEvent requires a focused BrowserWindow. CDP input targets this
    // sandboxed page directly, so background generation never steals focus.
    await this.input(entry, context, signal, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...position })
    await this.input(entry, context, signal, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...position })
    this.assert(entry, context, signal)
  }
  private async input(entry: Entry, context: LocalMediaContext, signal: AbortSignal, method: string, parameters: Record<string, any>) {
    this.assert(entry, context, signal)
    const debuggerApi = entry.window!.webContents.debugger
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
    await debuggerApi.sendCommand(method, parameters)
    this.assert(entry, context, signal)
  }
  private async key(entry: Entry, context: LocalMediaContext, signal: AbortSignal, key: 'Home' | 'ArrowRight' | 'Escape') {
    const code = { Home: 36, ArrowRight: 39, Escape: 27 }[key]
    await this.input(entry, context, signal, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code })
    await this.input(entry, context, signal, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
  }
  private async ready(entry: Entry, context: LocalMediaContext, action: string, accept: (value: any) => boolean, signal: AbortSignal, stage = '页面准备', payload: Record<string, any> = {}) {
    for (let attempt = 0; attempt < (action === 'uploads' ? 720 : 120); attempt++) {
      const value = await this.run(entry, context, signal, action, payload)
      if (accept(value)) return value
      await delay(250, undefined, { signal })
    }
    throw new Error(`${this.site.label}${stage}尚未完成，本次尚未发送`)
  }
  view(owner: string, accountId: string | undefined, revision: number): DoubaoStatus {
    const entry = this.entries.get(this.entryKey(owner, this.accountId(accountId)))
    return entry?.revision === revision && !entry.controller.signal.aborted && !this.closing ? entry.status : disconnectedStatus(this.site.label)
  }
  async hasSavedLogin(owner: string, accountId: string | undefined, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    const cookies = await entry.session.cookies.get({ url: this.site.home })
    return cookies.some(cookie => /^(sessionid|sessionid_ss|sid_tt)$/.test(cookie.name) && !!cookie.value)
  }
  private async refreshEntry(entry: Entry, context: LocalMediaContext, signal: AbortSignal) {
    try {
      const window = await this.window(entry, context, signal)
      // A changed network/region must be re-evaluated by the platform, rather
      // than remaining stuck on the previous access-error document forever.
      if (/\/security\/region-restricted|doubao-region-ban/.test(new URL(window.webContents.getURL()).pathname)) {
        await window.loadURL(this.site.home)
        this.assert(entry, context, signal)
      }
      let page = await this.run(entry, context, signal, 'snapshot')
      // The signed menu response often arrives before the composer is visible.
      // Keep that body, and do not discard a later refresh when the hidden
      // window has not drawn the input yet.
      if (!page.hasEditor && !page.login && !page.challenge && !page.regionBlocked && !page.networkError) {
        const deadline = Date.now() + 8_000
        const completeMenu = () => {
          const models = acceptLiveMenu(entry.menuBodies.flatMap(text => { try { return parseLiveCreationMenu(JSON.parse(text)) } catch { return [] } }))
          return models.length > 0 && !models.some(item => item.kind === 'image' && !item.ratios.length || item.kind === 'video' && !item.durations.length)
        }
        while (Date.now() < deadline && !page.hasEditor && !page.login && !page.challenge && !page.regionBlocked && !page.networkError && !completeMenu()) {
          await delay(250, undefined, { signal })
          this.assert(entry, context, signal)
          page = await this.run(entry, context, signal, 'snapshot')
        }
      }
      const cookies = await entry.session.cookies.get({ url: this.site.home })
      this.assert(entry, context, signal)
      const authenticated = cookies.some(cookie => /^(sessionid|sessionid_ss|sid_tt)$/.test(cookie.name) && !!cookie.value)
      const connected = authenticated && page.hasEditor && !page.login && !page.challenge && !page.regionBlocked
      const state = page.networkError ? 'unavailable' : page.challenge ? 'verification-required' : page.regionBlocked ? 'region-restricted' : connected ? 'connected' : 'login-required'
      const checkedAt = new Date().toISOString()
      const currentModel = /^(?:Dreamina\s+)?Seedance\b/.test(page.model || '') ? page.model : page.controls.find((value: string) => /^(?:Dreamina\s+)?Seedance\b/i.test(value))
      const previousMenu = entry.status.menu
      let menu: LiveMenu | undefined = previousMenu
      if (authenticated && !(previousMenu?.loaded && previousMenu.checkedAt && Date.now() - Date.parse(previousMenu.checkedAt) < 30_000)) {
        try {
          const live = await window.webContents.executeJavaScript(creationMenuSource(this.site.id, !previousMenu?.loaded || !window.isVisible()), true)
          this.assert(entry, context, signal)
          const capturedModels = () => entry.menuBodies.flatMap(text => { try { return parseLiveCreationMenu(JSON.parse(text)) } catch { return [] } })
          let models = acceptLiveMenu([...(Array.isArray(live?.models) ? live.models : []), ...capturedModels()])
          const deadline = Date.now() + 4_000
          let unchanged = 0
          let seen = entry.menuBodies.length
          const thinMenu = (items: { kind: string; ratios: string[]; durations: number[] }[]) => items.some(item => item.kind === 'image' && !item.ratios.length || item.kind === 'video' && !item.durations.length)
          while (Date.now() < deadline) {
            if (models.length && !thinMenu(models) && entry.menuBodies.length === seen) {
              unchanged += 1
              if (unchanged >= 4) break
            } else unchanged = 0
            seen = entry.menuBodies.length
            await delay(200, undefined, { signal })
            this.assert(entry, context, signal)
            models = acceptLiveMenu([...(Array.isArray(live?.models) ? live.models : []), ...capturedModels()])
          }
          if (models.length) entry.menuBodies = []
          menu = models.length ? { checkedAt, loaded: true, models } : previousMenu?.loaded ? { ...previousMenu, checkedAt } : { checkedAt, loaded: false, models: [] }
        } catch {
          this.assert(entry, context, signal)
          menu = previousMenu?.loaded ? { ...previousMenu, checkedAt } : { checkedAt, loaded: false, models: [] }
        }
      }
      entry.status = { connected, state, name: connected ? page.name || `已登录${this.site.label}账户` : '', checkedAt, ...(menu ? { menu } : {}),
        message: state === 'unavailable' ? `${this.site.label}页面暂不可用，请检查网络后重试` : state === 'verification-required' ? `请在${this.site.label}窗口完成验证` : state === 'region-restricted' ? this.site.id === 'doubao' ? '豆包提示受区域限制，请在豆包窗口登录后重试' : 'Dola 提示当前地区无法使用，请检查账户可用地区及网络后重试' : connected ? (menu?.loaded ? `已连接。图片和视频型号以这个${this.site.label}账号当前菜单为准` : `已连接。创作菜单尚未读到，图片和视频会在读到当前账号菜单后再发送`) : authenticated && menu?.loaded ? `已读到这个${this.site.label}账号的图片和视频菜单。发送时需要窗口里的输入框` : `请在${this.site.label}窗口完成登录`,
        image: connected ? readQuota(page.quotaTexts, 'image', checkedAt) : disconnectedStatus(this.site.label).image,
        video: connected ? readQuota(page.quotaTexts, 'video', checkedAt) : disconnectedStatus(this.site.label).video,
        text: connected ? readQuota(page.quotaTexts, 'text', checkedAt) : disconnectedStatus(this.site.label).text,
        ...(currentModel ? { videoModel: currentModel } : {}),
      }
    } catch {
      this.assert(entry, context, signal)
      const previous = entry.status
      const checkedAt = new Date().toISOString()
      if (previous.menu?.loaded && previous.menu.models.length) {
        entry.status = { ...previous, checkedAt, menu: { ...previous.menu, checkedAt },
          message: `页面暂时打不开。图片和视频仍用这个${this.site.label}账号已读到的菜单` }
      } else entry.status = { ...disconnectedStatus(this.site.label), state: 'unavailable', message: `${this.site.label}页面暂不可用，请打开窗口检查网络或重新登录`, checkedAt }
    }
    return entry.status
  }
  login(owner: string, accountId: string | undefined, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    return this.queue(entry, context, 'login', async signal => {
      await this.window(entry, context, signal, true)
      const login = await this.run(entry, context, signal, 'login').catch(() => { this.assert(entry, context, signal) })
      if (login) await this.click(entry, context, signal, login)
      return this.refreshEntry(entry, context, signal)
    })
  }
  refresh(owner: string, accountId: string | undefined, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    if (!entry.checking) {
      const work = this.queue(entry, context, 'refresh', signal => this.refreshEntry(entry, context, signal))
      entry.checking = work
      const finish = () => { if (entry.checking === work) entry.checking = undefined }
      void work.then(finish, finish)
    }
    return entry.checking
  }
  disconnect(owner: string, accountId: string | undefined, context: LocalMediaContext, assertIdle: () => void) {
    const entry = this.entry(owner, accountId, context)
    return this.queue(entry, context, 'disconnect', async signal => {
      assertIdle(); this.assert(entry, context, signal)
      this.destroyWindow(entry)
      await entry.session.clearStorageData(); this.assert(entry, context, signal)
      await entry.session.clearCache(); this.assert(entry, context, signal)
      entry.observations.clear(); entry.status = disconnectedStatus(this.site.label)
      return entry.status
    })
  }
  submit(owner: string, accountId: string | undefined, id: string, kind: DoubaoKind, body: Record<string, any>, checkpoint: (state: Record<string, any>) => void, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    return this.queue(entry, context, 'submit', async signal => {
      if (process.env.MIAO_DESKTOP_NO_GENERATION === '1') throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
      let dispatched = false
      const observation: Observation = { dispatchSignal: signal }
      try {
        if (entry.unbound && entry.unbound !== id) throw Object.assign(new Error(`${this.site.label}原请求仍在取得对话编号，请先继续取回原任务`), { status: 409 })
        const status = await this.refreshEntry(entry, context, signal)
        if (!status.connected) throw Object.assign(new Error(status.message), { status: 409 })
        const promotion = await this.run(entry, context, signal, 'dismissPromotion')
        if (promotion) await this.click(entry, context, signal, promotion)
        const previous = this.conversation(entry.window!.webContents.getURL())
        observation.previousUrl = previous
        let sendTarget: any
        const selection = liveSelection(body.model, status.menu) || localModelSelection(body.model)
        if ((kind === 'image' || kind === 'video') && !status.menu?.loaded) throw Object.assign(new Error(`${this.site.label}还没有读到当前账号的图片和视频菜单，尚未提交。请打开${this.site.label}窗口，等型号出现后再发送`), { status: 409 })
        if ((kind === 'image' || kind === 'video') && !status.menu.models.some(item => liveModelId(this.site, item) === body.model)) throw Object.assign(new Error(`${this.site.label}当前账号的创作菜单里没有这个型号，尚未提交`), { status: 422 })
        if (kind === 'text') observation.expectedRoute = {
          ...(selection && 'modeKey' in selection ? { modeKey: selection.modeKey } : {}),
          ...(selection && 'upstreamKey' in selection && typeof selection.upstreamKey === 'string' ? { modeKey: selection.upstreamKey } : {}),
        }
        if (kind === 'image' || kind === 'video') observation.expectedRoute = {
          abilityType: kind === 'video' ? 17 : 3,
          ...(selection && 'upstreamKey' in selection ? { modelKey: selection.upstreamKey } : {}),
          ...(kind === 'image' && body.ratio ? { ratio: body.ratio } : {}),
          ...(kind === 'video' ? { duration: body.duration, ratio: body.ratio, resolution: body.resolution, ...(this.site.id === 'doubao' ? { implicitResolution: '720p' } : {}) } : {}),
        }
        const modelChoice = selection ? { label: selection.label, ...('labels' in selection ? { labels: selection.labels } : {}) } : {}
        {
          // Navigating to the canonical blank chat avoids every project-level
          // "新对话" shortcut and starts without another conversation's files.
          await entry.window!.loadURL(this.site.home)
          await this.ready(entry, context, 'snapshot', value => value.hasEditor && !value.dialog && !value.login && !value.challenge, signal, '新对话加载')
          if (kind !== 'text') {
            try {
              const watermark = await entry.window!.webContents.executeJavaScript(`(${platformWatermarkPreference.toString()})(${JSON.stringify(this.site.id)},true)`)
              this.assert(entry, context, signal)
              if (watermark?.confirmed !== true) throw new Error('设置未确认')
              if (watermark.changed) {
                // A direct settings save must also refresh the native page's
                // cached creation configuration before it builds the request.
                await entry.window!.loadURL(this.site.home)
                await this.ready(entry, context, 'snapshot', value => value.hasEditor && !value.dialog && !value.login && !value.challenge, signal, '水印设置刷新')
              }
            } catch {
              this.assert(entry, context, signal)
              throw Object.assign(new Error(`${this.site.label}去 AI 明水印设置未确认，本次尚未发送；请打开平台的水印管理，确认图片、视频去除选项及账户权限后重试`), { status: 422 })
            }
            checkpoint({ phase: 'preparing', kind, watermarkPreference: { aiRemovalEnabled: true } })
          }
          const capability = await this.ready(entry, context, 'capability', value => !!value, signal, '生成入口加载', { kind })
          if (!capability?.selected) await this.click(entry, context, signal, capability)
          await this.ready(entry, context, 'snapshot', value => (value.kind === kind || this.site.id === 'dola' && kind !== 'text' && !value.kind) && value.hasEditor && !value.dialog, signal, '生成模式切换')
          if (selection) {
            const control = await this.ready(entry, context, 'modelOpen', value => !!value, signal, '模型控件加载', modelChoice)
            if (!control?.selected) {
              await this.click(entry, context, signal, control)
              await this.ready(entry, context, 'modelOptions', values => values.length > 0, signal, '模型菜单加载')
              await this.click(entry, context, signal, await this.run(entry, context, signal, 'modelSelect', modelChoice))
            }
            await this.ready(entry, context, 'modelMatches', value => value === true, signal, '所选模型回读', modelChoice)
          }
          const listedRatio = body.ratio && (body.ratio !== 'auto' || !!status.menu?.models.some(item => liveModelId(this.site, item) === body.model && item.ratios.includes('auto')))
          if ((kind === 'video' || kind === 'image') && listedRatio && (this.site.id === 'dola' || kind === 'image')) {
            const target = await this.ready(entry, context, 'dolaRatioOpen', value => !!value, signal, '比例控件加载', { ratio: body.ratio })
            if (!target.selected) {
              await this.click(entry, context, signal, target)
              await this.click(entry, context, signal, await this.ready(entry, context, 'dolaParameterSelect', value => !!value, signal, '比例选项加载', { value: body.ratio }))
            }
            await this.ready(entry, context, 'parameters', value => value?.ratio === body.ratio, signal, '比例回读')
            if (kind === 'image') await this.key(entry, context, signal, 'Escape')
          }
          if (kind === 'video' && this.site.id === 'dola') {
            if (body.duration !== undefined) {
              const target = await this.ready(entry, context, 'dolaDurationOpen', value => !!value, signal, '时长控件加载', { duration: body.duration })
              if (!target.selected) {
                await this.click(entry, context, signal, target)
                await this.click(entry, context, signal, await this.ready(entry, context, 'dolaParameterSelect', value => !!value, signal, '时长选项加载', { value: body.duration + 's' }))
              }
              await this.ready(entry, context, 'parameters', value => value?.duration === body.duration, signal, '时长回读')
            }
            await this.key(entry, context, signal, 'Escape')
          }
          if (kind === 'video' && this.site.id === 'doubao' && (body.duration !== undefined || body.ratio || body.resolution)) {
            const openParameters = async () => {
              const control = await this.ready(entry, context, 'parametersOpen', value => !!value, signal, '视频参数控件加载')
              if (!control?.selected) await this.click(entry, context, signal, control)
            }
            if (body.ratio) {
              await openParameters()
              const target = await this.ready(entry, context, 'parameterRatio', value => !!value, signal, '比例菜单加载', { ratio: body.ratio })
              await this.click(entry, context, signal, target)
              await this.ready(entry, context, 'parameters', value => value?.ratio === body.ratio, signal, '视频比例回读')
            }
            if (body.duration !== undefined) {
              await openParameters()
              const target = await this.ready(entry, context, 'durationTarget', value => !!value, signal, '时长控件加载', { duration: body.duration })
              await this.click(entry, context, signal, target)
              await this.key(entry, context, signal, 'Home')
              for (let index = 0; index < body.duration - 4; index++) await this.key(entry, context, signal, 'ArrowRight')
              await this.ready(entry, context, 'parameters', value => value?.duration === body.duration && (!body.ratio || value.ratio === body.ratio), signal, '视频时长回读')
            }
            if (body.resolution && (localVideoParameters(body.model, entry.status.menu)?.resolutions.length || 0) > 1) {
              await openParameters()
              await this.click(entry, context, signal, await this.ready(entry, context, 'parameterResolution', value => !!value, signal, '清晰度选项加载', { resolution: body.resolution }))
              await this.ready(entry, context, 'parameters', value => value?.resolution === body.resolution, signal, '清晰度回读')
            }
            await this.key(entry, context, signal, 'Escape')
          }
          if (body.localReferences?.length) {
            const baseline = await this.run(entry, context, signal, 'uploads')
            await this.run(entry, context, signal, 'upload', { files: body.localReferences })
            let stable = 0
            await this.ready(entry, context, 'uploads', value => {
              stable = value.count === baseline.count + body.localReferences.length && !value.pending ? stable + 1 : 0
              return stable >= 3
            }, signal, '参考图片上传')
          }
          await this.run(entry, context, signal, 'focus')
          await this.input(entry, context, signal, 'Input.insertText', { text: body.prompt })
          const requested = { prompt: body.prompt, kind, ...modelChoice, ...(kind === 'video' ? { duration: body.duration, ratio: body.ratio, resolution: body.resolution } : {}), ...(kind === 'image' && body.ratio && body.ratio !== 'auto' ? { ratio: body.ratio } : {}) }
          await this.ready(entry, context, 'prepared', value => value === true, signal, '提示词与模型回读', requested)
          await this.ready(entry, context, 'snapshot', value => value.canSend && !value.dialog && !value.login && !value.challenge, signal, '发送按钮就绪')
          sendTarget = await this.run(entry, context, signal, 'sendTarget', requested)
        }
        this.assert(entry, context, signal)
        // Durable intent precedes the only send. Uncertain outcomes retain
        // this original request; another browser lease must never resend it.
        checkpoint({ phase: 'dispatching', conversationUrl: '', kind, ...(selection ? { modelLabel: selection.label } : {}) })
        dispatched = true; entry.observations.set(id, observation)
        entry.dispatching = id; entry.unbound = id
        await this.click(entry, context, signal, sendTarget)
        for (let attempt = 0; attempt < 120; attempt++) {
          await delay(250, undefined, { signal }); this.assert(entry, context, signal)
          if (observation.rejection) {
            throw new Error(observation.rejection)
          }
          const url = this.conversation(entry.window!.webContents.getURL())
          if (url) {
            const page = await this.run(entry, context, signal, 'result', { prompt: body.prompt, kind, duration: observation.upstream?.duration, ratio: observation.upstream?.ratio, resolution: observation.upstream?.resolution })
            const sameTask = page.userPrompt?.trim() === body.prompt.trim() && (this.conversation(page.url) === url || page.turns >= 2)
            if (!sameTask) continue
            observation.conversationUrl = url
            observation.routeVerified = Boolean(observation.upstream)
            if (entry.unbound === id) entry.unbound = undefined
            checkpoint({ phase: 'accepted', conversationUrl: url, kind, ...(selection ? { modelLabel: selection.label } : {}), ...(observation.upstream ? { upstream: observation.upstream } : {}), routeVerified: observation.routeVerified })
            return { ok: true, requestId: id, status: 'running' }
          }
        }
      } catch (error) {
        if (observation.rejection && !observation.upstream) {
          checkpoint({ phase: 'not-sent', conversationUrl: '', kind })
          dispatched = false; entry.observations.delete(id)
          if (entry.unbound === id) entry.unbound = undefined
          throw new Error(observation.rejection)
        }
        if (!dispatched) { entry.observations.delete(id); throw error }
        this.assert(entry, context, signal)
      } finally {
        if (entry.dispatching === id && (!dispatched || !observation.expectedRoute || observation.upstream || observation.conversationUrl)) entry.dispatching = undefined
      }
      return { ok: true, requestId: id, status: 'running', submissionUncertain: true, error: `提交结果待确认，请打开${this.site.label}窗口核对原任务` }
    })
  }
  poll(owner: string, accountId: string | undefined, id: string, kind: DoubaoKind, state: Record<string, any>, checkpoint: (state: Record<string, any>) => void, expectedPrompt: string, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    return this.queue(entry, context, 'poll', async signal => {
      const observation = entry.observations.get(id) || {}
      entry.observations.set(id, observation)
      if (observation.rejection && !observation.upstream) {
        checkpoint({ phase: 'not-sent', conversationUrl: '', kind })
        entry.observations.delete(id)
        if (entry.unbound === id) entry.unbound = undefined
        if (entry.dispatching === id) entry.dispatching = undefined
        return { ok: false, requestId: id, status: 'failed', error: observation.rejection }
      }
      let location = this.conversation(state.conversationUrl || observation.conversationUrl || '')
      if (!location && entry.window && !entry.window.isDestroyed()) {
        const candidate = this.conversation(entry.window?.webContents.getURL() || '')
        if (candidate) {
          const page = await this.run(entry, context, signal, 'result', { prompt: expectedPrompt, kind })
          if (page.userPrompt?.trim() === expectedPrompt.trim() && page.turns >= 2) {
            location = candidate; observation.conversationUrl = candidate; entry.unbound = undefined
            observation.routeVerified = Boolean(observation.upstream)
            state = { ...state, phase: 'accepted', conversationUrl: candidate, routeVerified: observation.routeVerified, ...(observation.upstream ? { upstream: observation.upstream } : {}) }; checkpoint(state)
            if (entry.dispatching === id) entry.dispatching = undefined
          }
        }
      }
      if (!location) return { ok: true, requestId: id, status: 'running', submissionUncertain: true, error: `尚未取得原${this.site.label}对话编号，请打开${this.site.label}窗口核对；不会自动重发` }
      if (entry.unbound && entry.unbound !== id) return { ok: true, requestId: id, status: 'running', error: `正在确认另一条原${this.site.label}请求，稍后继续取回本任务` }
      observation.conversationUrl = location
      if (!state.conversationUrl) { checkpoint({ ...state, phase: 'accepted', conversationUrl: location }); state = { ...state, conversationUrl: location } }
      if (observation.upstream && !state.upstream) { state = { ...state, upstream: observation.upstream }; checkpoint(state) }
      if (entry.window?.isVisible() && this.conversation(entry.window.webContents.getURL()) !== location) return { ok: true, requestId: id, status: 'running', error: `${this.site.label}窗口正在手动核对其他对话，关闭窗口后会继续取回原任务` }
      await this.navigate(entry, context, signal, location)
      const page = await this.run(entry, context, signal, 'snapshot')
      if (page.login || page.challenge || page.regionBlocked || page.dialog) return { ok: true, requestId: id, status: 'running', error: `原任务等待${this.site.label}页面处理，请打开${this.site.label}窗口继续` }
      const requested = { prompt: expectedPrompt, kind, label: state.modelLabel, duration: state.upstream?.duration, ratio: state.upstream?.ratio, resolution: state.upstream?.resolution }
      const readResult = () => this.run(entry, context, signal, 'result', requested)
      let result = await readResult()
      // A loaded document is not a loaded conversation. Keep the browser
      // lease until its original messages hydrate, or parallel pollers can
      // repeatedly navigate away before either result becomes readable.
      for (let attempt = 0; attempt < 120 && this.conversation(result.url) === location && (result.turns < 2 || result.userPrompt?.trim() !== expectedPrompt.trim()); attempt++) {
        await delay(250, undefined, { signal }); result = await readResult()
      }
      if (this.conversation(result.url) !== location) throw new Error(`${this.site.label}当前对话与原任务不一致`)
      if (result.userPrompt?.trim() !== expectedPrompt.trim()) return { ok: true, requestId: id, status: 'running', error: `${this.site.label}当前消息与原任务无法核对，请打开原对话检查；不会提取其他消息的产物` }
      for (let sample = 0; sample < 4; sample++) {
        const items = result.items.filter((item: any) => item.kind === kind).map((item: any) => ({ ...item, url: this.mediaUrl(item.url) }))
        if (kind !== 'text' && result.confirmationReady && !result.hasVideoCard && !result.running && !observation.confirmationSent) {
          await this.run(entry, context, signal, 'focus')
          await this.input(entry, context, signal, 'Input.insertText', { text: '确定' })
          const target = await this.run(entry, context, signal, 'confirmationTarget', requested)
          if (!target) return { ok: true, requestId: id, status: 'running', error: `${this.site.label}要求确认的模型或参数与原任务不一致，请打开原对话检查；不会自动确认` }
          await this.click(entry, context, signal, target)
          observation.confirmationSent = true
          checkpoint({ ...state, phase: 'accepted', ...(state.modelLabel ? { modelLabel: state.modelLabel } : {}), autoConfirmation: 'sent' })
          await delay(750, undefined, { signal })
          result = await readResult()
          if (this.conversation(result.url) !== location || result.userPrompt?.trim() !== expectedPrompt.trim()) break
          continue
        }
        // Completed media is stronger evidence than incidental words in the
        // assistant's explanation. Do not strand an original behind a broad
        // "please confirm" / "cannot generate" text match.
        if (kind !== 'text' && !items.length && !result.hasVideoCard && !result.running) {
          if (result.failed) { entry.observations.delete(id); return { ok: false, requestId: id, status: 'failed', error: `${this.site.label}页面报告生成失败，请查看原对话` } }
          if (result.needsConfirmation) return { ok: true, requestId: id, status: 'running', error: `${this.site.label}要求确认生成参数，请打开${this.site.label}窗口确认原任务` }
        }
        if (kind === 'video' && !items.length) {
          const play = await this.run(entry, context, signal, 'activateVideo', { prompt: expectedPrompt, kind })
          if (play) {
            await this.click(entry, context, signal, play)
            // Playback is local result retrieval, never another generation.
            // Read it before releasing this page; another poller may navigate
            // away, in which case the next lease must activate the card again.
            await delay(500, undefined, { signal }); result = await readResult()
            if (this.conversation(result.url) !== location || result.userPrompt?.trim() !== expectedPrompt.trim()) break
            continue
          }
        }
        const key = kind === 'text' ? result.text : JSON.stringify(items)
        const samples = observation.stable?.key === key ? observation.stable.samples + 1 : 1
        observation.stable = { key, samples }
        const completedText = (observation.streams?.size || 0) === 0 && result.complete === true
        if ((kind === 'text' ? !!result.text?.trim() && completedText : items.length) && !result.running && samples >= 3) {
          let downloadSource: 'platform-download' | 'platform-player' | undefined
          if (kind === 'video') {
            const window = entry.window!
            let download: { url: string } | undefined
            try {
              const payload = { platform: this.site.id, conversationUrl: location, replyId: result.replyId }
              download = await window.webContents.executeJavaScript(`(${platformVideoDownload.toString()})(${JSON.stringify(payload)},${replyVideoId.toString()})`)
              this.assert(entry, context, signal)
              if (download) download.url = this.mediaUrl(download.url)
            } catch { download = undefined; this.assert(entry, context, signal) }
            // The player file is a separate, watermarked rendition. The account
            // switch is already confirmed before sending; the canvas may store
            // only the download the platform itself marks without_watermark.
            const after = await readResult()
            if (entry.window !== window || this.conversation(after.url) !== location || after.userPrompt?.trim() !== expectedPrompt.trim() || after.replyId !== result.replyId || after.running) return { ok: true, requestId: id, status: 'running' }
            if (!download?.url) {
              // A platform player can already contain the completed video even
              // when its optional no-watermark download endpoint is absent or
              // blocked in the current account/region. Preserve the result so
              // the task cannot remain pending forever, and label the source
              // honestly instead of claiming a watermark-free original.
              items[0] = { ...items[0], watermark: { status: 'platform-player', source: 'platform-player', noWatermarkConfirmed: false } }
              downloadSource = 'platform-player'
            } else {
              items[0] = { ...items[0], url: download.url, watermark: { status: 'platform-confirmed', source: 'platform-download', noWatermarkConfirmed: true } }
              downloadSource = 'platform-download'
            }
          }
          checkpoint({ ...state, phase: 'completed', ...(observation.upstream ? { upstream: observation.upstream } : {}), ...(downloadSource ? { downloadSource } : {}) })
          entry.observations.delete(id)
          return { ok: true, requestId: id, status: 'succeeded', ...(kind === 'text' ? { text: result.text } : kind === 'image' ? { images: items } : { video: items[0] }) }
        }
        if (result.running || (kind === 'text' ? !result.text?.trim() || !completedText : !items.length)) break
        if (sample < 3) {
          await delay(500, undefined, { signal }); result = await readResult()
          if (this.conversation(result.url) !== location || result.userPrompt?.trim() !== expectedPrompt.trim()) break
        }
      }
      return { ok: true, requestId: id, status: 'running' }
    })
  }
  bindCurrent(owner: string, accountId: string | undefined, id: string, prompt: string, kind: DoubaoKind, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    // Capture the page the user chose before joining the DOM queue. A queued
    // observer must not silently replace that choice with another conversation.
    const window = entry.window
    if (!window || window.isDestroyed()) throw new Error('请先打开平台窗口，定位原任务对话')
    const url = this.conversation(window.webContents.getURL())
    if (!url) throw new Error('请先在平台窗口打开原任务对话')
    return this.queue(entry, context, 'bind', async signal => {
      if (entry.window !== window || window.isDestroyed() || this.conversation(window.webContents.getURL()) !== url) throw new Error('当前平台对话已变化，请重新定位原任务后关联')
      const result = await this.run(entry, context, signal, 'result', { prompt, kind })
      if (this.conversation(result.url) !== url || result.userPrompt?.trim() !== prompt.trim()) throw new Error('当前对话的提示词与原任务不一致，无法关联')
      const observation = entry.observations.get(id) || {}
      observation.conversationUrl = url
      entry.observations.set(id, observation)
      if (entry.unbound === id) entry.unbound = undefined
      if (entry.dispatching === id) entry.dispatching = undefined
      return url
    })
  }
  cancel(owner: string, accountId: string | undefined, id: string, state: Record<string, any>, expectedPrompt: string, context: LocalMediaContext) {
    const entry = this.entry(owner, accountId, context)
    return this.queue(entry, context, 'cancel', async signal => {
      const location = this.conversation(state.conversationUrl || entry.observations.get(id)?.conversationUrl || '')
      if (!location) throw new Error(`请先取回原${this.site.label}对话，再确认是否停止生成`)
      await this.navigate(entry, context, signal, location)
      await this.window(entry, context, signal, true)
      const result = await this.run(entry, context, signal, 'result', { prompt: expectedPrompt, kind: state.kind })
      if (this.conversation(result.url) !== location || result.userPrompt?.trim() !== expectedPrompt.trim()) throw new Error('当前对话与原任务不一致，无法请求停止')
      const target = await this.run(entry, context, signal, 'cancel', { conversationUrl: location, prompt: expectedPrompt, kind: state.kind })
      const clicked = !!target && await this.click(entry, context, signal, target).then(() => true)
      // Clicking is not evidence of remote cancellation. Missing controls
      // remain retryable, rather than latching cancellationAttempted forever.
      return { ok: true, requestId: id, status: 'running', cancellationRequested: true, cancellationAttempted: clicked,
        error: clicked ? `已请求停止原${this.site.label}任务，请核对停止状态；妙图会继续取回原结果` : `尚未找到原${this.site.label}任务的停止按钮，请稍后重试或在平台窗口处理；原任务仍保留` }
    })
  }
  download(owner: string, accountId: string | undefined, value: string, context: LocalMediaContext): Promise<Response> {
    const entry = this.entry(owner, accountId, context)
    const signal = AbortSignal.any([entry.controller.signal, ...(context.signal ? [context.signal] : [])])
    return this.track(entry, (async () => {
      let url = this.mediaUrl(value)
      for (let attempt = 0; attempt < 5; attempt++) {
        this.assert(entry, context, signal)
        // Chromium validates Referer against its cross-origin policy. Send
        // only the platform origin, as the actual page does for CDN media.
        const response = await entry.session.fetch(url, { signal, redirect: 'manual', referrerPolicy: 'strict-origin-when-cross-origin', headers: { referer: new URL(this.site.home).origin + '/' } })
        try { this.assert(entry, context, signal) } catch (error) { await response.body?.cancel().catch(() => {}); throw error }
        if (![301, 302, 303, 307, 308].includes(response.status)) return response
        const next = response.headers.get('location'); await response.body?.cancel()
        if (!next) throw new Error(`${this.site.label}原件下载跳转无效`)
        url = this.mediaUrl(new URL(next, url).href)
      }
      throw new Error(`${this.site.label}原件下载跳转次数过多`)
    })())
  }
  retire(owner: string) {
    const entries = [...this.entries.values()].filter(entry => entry.owner === owner)
    if (!entries.length) return Promise.resolve()
    for (const entry of entries) this.revoke(entry)
    return Promise.allSettled(entries.flatMap(entry => [...entry.pending])).then(() => {})
  }
  stop() {
    if (!this.stopped) {
      this.closing = true
      for (const entry of [...this.entries.values()]) this.revoke(entry)
      this.stopped = Promise.allSettled([...this.pending]).then(() => {})
    }
    return this.stopped
  }
}
