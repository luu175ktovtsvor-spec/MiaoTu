import { createServer } from 'node:http'
import { isWorkspaceRequest, sanitizeCanvasText, workspaceRequestHeaders } from '../server/canvas-document.ts'
import { createReadStream, readFileSync, statSync, existsSync, mkdirSync, rmSync, chmodSync } from 'node:fs'
import { join, resolve, extname, sep } from 'node:path'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { cleanProjectName, DEFAULT_PROJECT_ID } from '../server/projects.ts'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { createLocalComputer } from './local-computer.ts'
import { createLocalSkills } from './local-skills.ts'
import { createPiAgentPrompt } from './pi-agent-prompt.ts'
import { LocalStore } from './store.ts'
import { createSystemTrash } from './system-trash.ts'
import { CloudGateway } from './cloud.ts'
import { LocalTasks } from './tasks.ts'
import { MediaTools } from './media-tools.ts'
import { explainUserError, userFacingError } from '../server/user-errors.ts'
import { DesktopWorkspaceFiles } from './workspace-files.ts'
import { createWorkspaceCatalogTools } from './workspace-catalog-tools.ts'
import { createAgentApi } from '../server/agent-api.ts'
import { createNodePlugins } from '../server/node-plugins.ts'
import { createExtPlugins } from '../server/ext-plugins.ts'
import { createFfmpegExec } from '../server/ffmpeg-exec.ts'
import { createPluginExport } from '../server/plugin-export.ts'
import { createMcpApi, mcpSkillMarkdown } from '../server/mcp-api.ts'
import { ownTextModelById } from '../server/text-model-registry.ts'
import { isTransientModelFailure, modelResponseHeaders, readJsonRequest, readModelJson } from '../server/model-transport.ts'
import { withRequestProject, currentProject } from '../server/workspace-scope.ts'
import { createMediaPreviews, MEDIA_PREVIEW_VERSION } from '../server/media-previews.ts'
import { MEDIA_INPUT_VERSION } from '../server/media-input.ts'
import { createAudioWaveforms } from './audio-waveform.ts'
import { createVideoPlayback } from '../server/video-playback.ts'
import { fetchProviderModels, listPublicProviders, providerById, removeProvider, upsertProvider } from '../server/text-providers.ts'
import { withRequestSignal } from '../server/request-lifetime.ts'
import { createCustomProviderFetch } from '../server/provider-fetch.ts'
import { createDesktopTextApi } from './text-models.ts'
import { json as sendJson } from '../server/http-auth.ts'
import { createRendererLifecycle } from './renderer-lifecycle.ts'
import { requiresDesktopProject } from './request-scope.ts'
import { LocalMediaRouter } from './local-media/router.ts'
import { LOCAL_MEDIA_SITES, localMediaKind, localMediaSite } from './local-media/catalog.ts'
import { fileContentHeaders, forwardedFileHeaders } from '../server/file-content-policy.ts'
import { serveFileContent } from '../server/file-response.ts'
import { HttpIncomingRequests } from '../server/http-request-lifetime.ts'
import { createDesktopEntryHtml } from './entry-html.ts'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
export async function startDesktopRuntime({ directory, getSafeStorage, credentialProtection, webRoot, origin, native, requestFetch, previewArchiveOrigin = '' }: Record<string, any>) {
  const entryHtml = createDesktopEntryHtml(webRoot)
  const store = new LocalStore(directory)
  store.cleanupTrashBackups()
  const systemTrash = createSystemTrash({ directory, trashItem: native?.trash })
  const files = new DesktopWorkspaceFiles(store)
  const sanitizeTrashSource = (source: { diskPath?: string | null; bytes?: Uint8Array | null }, mime: string) => {
    if (mime !== 'application/json') return source
    const bytes = source.bytes || (source.diskPath ? readFileSync(source.diskPath) : null)
    if (!bytes) return source
    const sanitized = sanitizeCanvasText(Buffer.from(bytes).toString('utf8'))
    return sanitized === null ? source : { bytes: Buffer.from(sanitized) }
  }
  const trashSource = (project: string, path: string, mime: string) =>
    sanitizeTrashSource(files.locate('local', path, project), mime)
  // 删除时还在 5 分钟宽限期里的素材字节当时不能回收；桌面版没有后台对账，启动时补收一次。
  try { files.blobs.sweep({ apply: true }) } catch (error) { console.warn('[workspace] BLOB_SWEEP_PENDING', error?.code || 'UNKNOWN') }
  const workspaceCatalogTools = createWorkspaceCatalogTools({ store, files })
  // 只有用户亲手删的（画布、文件面板）才进系统废纸篓；程序清理临时素材直接删，不往废纸篓里塞东西。
  // 删除提交之后才交给系统；提交失败时 rollback 先于 setImmediate 执行，暂存的副本随之丢弃。
  files.beforeRemove = (_userId, project, entries, { trash, path }) => {
    if (!trash || !systemTrash.available) return
    const name = `${store.projectLabel(project)} - ${path.split('/').pop() || '文件'}`
    const staged = systemTrash.stage(name, entries, target => trashSource(project, target, entries.find(entry => entry.path === target)?.mime || ''))
    let cancelled = false
    setImmediate(() => { if (!cancelled) systemTrash.send(staged).catch(error => console.warn('[system-trash] ITEM_PENDING', error?.code || 'UNKNOWN')) })
    return () => { cancelled = true; systemTrash.discard(staged) }
  }
  // 老版本藏在应用目录里的删除备份，以及上次没送进废纸篓的，都在后台交给系统，不拖慢启动。
  void (async () => {
    if (!systemTrash.available) return
    await systemTrash.flush()
    const legacy = store.legacyTrash()
    if (!legacy.length) return
    const staged = systemTrash.stage('妙图旧版删除的文件', legacy.map(row => ({ path: `${row.project_id}/${row.path}`, mime: row.mime })),
      path => {
        const row = legacy.find(item => `${item.project_id}/${item.path}` === path)
        return sanitizeTrashSource(row.disk_path ? { diskPath: row.disk_path } : { bytes: row.bytes }, row.mime)
      })
    await systemTrash.send(staged)
    store.dropLegacyTrash(legacy.map(row => row.id))
  })().catch(error => console.warn('[system-trash] LEGACY_TRASH_PENDING', error?.code || 'UNKNOWN'))
  let mcp, agent, computer, tasks: LocalTasks | undefined
  const localRoutes = new Map<string, LocalMediaRouter>()
  const catalogMemory = new Map<string, { value: any; updatedAt: number }>()
  const catalogRefreshes = new Map<string, Promise<any>>()
  const renderer = createRendererLifecycle({
    detached: id => {
      mcp?.retireDocument(id)
      void agent?.retireDocument?.(id)?.catch(error => console.warn('[agent-native] 原页面保护退场待收尾', error?.code || 'unknown'))
    },
    drained: id => {
      mcp?.finishDocument(id)
      void agent?.finishDocument?.(id)?.catch(error => console.warn('[agent-native] 原页面保护释放待收尾', error?.code || 'unknown'))
    },
  })
  let modelToken = randomBytes(32).toString('hex'), modelSession = new AbortController()
  const cloud = new CloudGateway({ directory, getSafeStorage, credentialProtection, origin, requestFetch, onSessionRetiring: () => {
    for (const route of localRoutes.values()) void Promise.resolve(route.retire(cloud.account)).catch(error => console.warn('[local-media] 账号退场待收尾', error?.code || 'unknown'))
    modelSession.abort(); computer?.cancel(); mcp?.disconnectUser('local')
    tasks?.accountChanged()
    void agent?.accountChanged?.().catch(error => console.warn('[agent-native] 账号切换收尾失败', error.message))
  }, onSessionChange: () => {
    modelSession = new AbortController(); modelToken = randomBytes(32).toString('hex')
    store.activeAccount = cloud.account
    tasks?.accountChanged()
  }, changeSession: commit => native?.changeSession ? native.changeSession(commit) : Promise.resolve().then(commit) })
  await cloud.restore()
  process.env.OIP_ARCHIVE_API_URL = cloud.origin
  process.env.OIP_ARCHIVE_ASSET_BASE_URL = cloud.origin
  const tools = new MediaTools({ directory })
  const previews = createMediaPreviews({ ensureTools: () => tools.ensure(), cacheDirectory: () => join(directory, 'previews') })
  const playback = createVideoPlayback({ root: () => join(directory, 'projects', '_previews', 'playback'), ensureTools: () => tools.ensure() })
  const waveforms = createAudioWaveforms({ ensureTools: () => tools.ensure() })
  store.activeAccount = cloud.account
  files.projectAccess = project => { store.project(project) }
  for (const site of LOCAL_MEDIA_SITES) localRoutes.set(site.provider, new LocalMediaRouter(store, () => cloud.account, native?.localMediaHosts?.[site.id], site,
    () => ({ revision: cloud.authRevision, available: Boolean(cloud.account) && !cloud.sessionChanging && !cloud.authenticationExpired })))
  tasks = new LocalTasks({ store, files, cloud, localRoutes, ensureTools: () => tools.ensure() })
  files.canvasCleanupReferences = (_userId, project) => tasks.canvasCleanupReferences(project)
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex')
  // MCP credentials belong to the signed-in account and survive normal restarts;
  // the window/model session token remains fresh for each launch.
  const mcpAvailable = () => Boolean(cloud.account) && !cloud.authenticationExpired && !cloud.sessionChanging
  const mcpKey = () => 'mcp-access:' + createHash('sha256').update(cloud.account || 'anonymous').digest('hex')
  const mcpAccess = () => {
    try { return JSON.parse(store.get('SELECT value FROM desktop_meta WHERE key=?', mcpKey())?.value || '{}') } catch { return {} }
  }
  const saveMcpAccess = value => {
    for (const name of ['desktop.sqlite', 'desktop.sqlite-wal', 'desktop.sqlite-shm']) if (existsSync(join(directory, name))) chmodSync(join(directory, name), 0o600)
    store.run('INSERT INTO desktop_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', mcpKey(), JSON.stringify(value))
  }
  let address = '', lastConfig = null
  let stopRequest: Promise<void> | undefined
  const json = (response, status, value) => { if (!response.destroyed) sendJson(response, status, value) }
  const readJson = (request, limit = 128 * 1024 * 1024, signal?: AbortSignal) =>
    readJsonRequest(request, { maxBytes: limit, objectOnly: false, signal, tooLargeMessage: '文件过大', invalidMessage: '请求格式不是有效 JSON' })
  const sameOrigin = request => { if (request.headers.origin !== address) throw Object.assign(new Error('请求来源无效，已拒绝'), { status: 403 }) }
  const mutate = request => { sameOrigin(request); if (request.headers['x-csrf-token'] !== csrf) throw Object.assign(new Error('会话已刷新，请重试'), { status: 403 }) }
  const userSession = () => ({ role: 'user', csrf, user: { ...(cloud.session?.user || {}), id: 'local', name: cloud.session?.user?.name || '', email: cloud.session?.user?.email || '', workspaceKey: 'desktop-' + (cloud.account ? createHash('sha256').update(cloud.account).digest('hex').slice(0,16) : 'local'), points: Number(cloud.session?.user?.points || 0) } })
  const session = { role: 'user', userId: 'local', csrf }
  files.referenceOwner = () => userSession().user.workspaceKey
  files.referenceScope = (_userId, project) => ({ owner: userSession().user.workspaceKey, project,
    defaultProject: DEFAULT_PROJECT_ID, origin: address, ownerMode: 'local' })
  const helpers = { json, readJson, sameOrigin }
  computer = createLocalComputer({ directory, account: () => cloud.account, workspaceFiles: files, currentProject })
  const localSkills = createLocalSkills({ status: computer.status, signal: computer.signal })
  // Public web tools use the authenticated cloud route so system proxy fake-IP
  // DNS does not collide with the hosted public-address checks.
  async function requestWeb(tool, args, signal?: AbortSignal) {
    signal?.throwIfAborted()
    // The cloud's 30 s search limit starts only after it receives this request.
    // Bound the desktop connection and response too, even with a task signal.
    const lifetime = AbortSignal.any([AbortSignal.timeout(40_000), ...(signal ? [signal] : [])])
    try { return await cloud.json('/api/imagine/desktop/web', { method: 'POST', body: { tool, args }, signal: lifetime }) }
    catch (error) {
      signal?.throwIfAborted()
      if (lifetime.aborted) throw Object.assign(new Error('联网请求响应超时，请稍后重试'), { status: 504 })
      throw error
    }
  }
  const webTools = {
    fetchPublicText: (url, signal, { offset, limit, contentHash }: Record<string, any> = {}) => requestWeb('webFetch', { url, offset, limit, contentHash }, signal),
    searchWeb: (query, limit, signal) => requestWeb('webSearch', { query, limit }, signal),
  }
  agent = createAgentApi({ customProviderFetch: createCustomProviderFetch({ allowPrivate: true, fetchImpl: requestFetch || fetch }), durableDirectory: join(directory, 'agent-runtime'), durableIdentity: () => cloud.account || 'local', durableProjectAccess: project => store.project(project), nativeAgentScope: computer.scope, nativeConversationDefaults: parent => ({ localDirectory: parent?.localDirectory || computer.status().directory }), webTools, localSkills, additionalTools: (userId, runtime) => [...computer.tools(userId, runtime), ...workspaceCatalogTools], additionalInstructions: computer.instructions, nativeAgentPrompt: createPiAgentPrompt({ directory, status: computer.status }), workspaceFiles: files, ensureMediaTools: () => tools.ensure(), resolveTextSettings: (_env, id = 'gpt-6.1-sol') => {
    const modelEntry = ownTextModelById(id)
    const enabled = Boolean(cloud.account) && !cloud.authenticationExpired && !cloud.sessionChanging
    return { enabled, reason: enabled ? '' : 'login-required', apiKey: modelToken, baseUrl: address + '/v1', providerId: 'miaoimg', modelId: id, modelEntry, protocol: modelEntry?.protocol, contextWindow: modelEntry?.contextWindow, maxOutputTokens: modelEntry?.maxOutputTokens, ...(modelEntry?.reasoningEffort ? { reasoningEffort: modelEntry.reasoningEffort } : {}) }
  }, assertTextAccess: async (_session, { signal, providerId, atRequest = false }: Record<string, any> = {}) => {
    signal?.throwIfAborted()
    // A user's configured provider uses their own credentials and billing.
    if (providerId && providerId !== 'miaoimg') return
    if (!cloud.account || cloud.authenticationExpired) throw Object.assign(new Error('请先登录后使用文本模型'), { status: 401 })
    if (cloud.sessionChanging) throw Object.assign(new Error('账号正在切换，请稍后重试'), { status: 409 })
    // The cloud checks the real account and balance immediately before each
    // built-in model request, including retries and automatic compaction.
    if (atRequest && providerId === 'miaoimg') return
    await cloud.refresh({ signal })
    signal?.throwIfAborted()
    if (!cloud.account || cloud.authenticationExpired) throw Object.assign(new Error('请先登录后使用文本模型'), { status: 401 })
    // Paid/free eligibility is checked by the cloud per request and model.
    // A local balance precheck would incorrectly reject a free account.
  } })
  const nodes = createNodePlugins({ workspaceFiles: files }), exts = createExtPlugins({ workspaceFiles: files })
  const ffmpeg = createFfmpegExec({ workspaceFiles: files, workspaceKey: () => userSession().user.workspaceKey })
  const exportPlugin = createPluginExport({ workspaceFiles: files })
  mcp = createMcpApi({ management: {
    userByMcpToken: value => { const access = mcpAccess(); return mcpAvailable() && access.enabled && access.token === value ? 'local' : null },
    mcpTokenInfo: () => { const access = mcpAccess(), available = mcpAvailable(); return { hasToken: Boolean(available && access.token), enabled: Boolean(available && access.enabled) } },
  }, workspaceFiles: files, webTools, ensureMediaTools: () => tools.ensure(),
    assertProjectAccess: (_userId, project) => store.project(project),
    additionalTools: (userId, options) => computer.tools(userId, options).filter(tool => ['importLocalFile', 'exportWorkspaceFile'].includes(tool.name)),
  })
  function configResponse(catalogValue) {
    const fallback = { models: [], videoModels: [], textModels: [], defaultModel: '', defaultTextModel: '', modelDefaults: {}, generationEnabled: false, textEnabled: false, videoEnabled: false }
    const current = catalogValue || fallback
    lastConfig = current
    const enabled = Boolean(cloud.account) && process.env.MIAO_DESKTOP_NO_GENERATION !== '1'
    const mediaEnabled = enabled && process.env.MIAO_DESKTOP_NO_MEDIA_GENERATION !== '1'
    return { ...current, requireLogin: false, session: userSession(), desktop: true, generationEnabled: mediaEnabled && Boolean(current.generationEnabled), textEnabled: enabled && Boolean(current.textEnabled), videoEnabled: mediaEnabled && Boolean(current.videoEnabled) }
  }
  async function refreshConfigCatalog(account, authRevision, configFile) {
    const pendingKey = configFile
    const existing = catalogRefreshes.get(pendingKey)
    if (existing) return existing
    const pending = cloud.json('/api/imagine/config', { anonymous: true, signal: AbortSignal.timeout(5000) })
      .then(async value => {
        if (cloud.account !== account || cloud.authRevision !== authRevision) throw Object.assign(new Error('账号已切换，请重新读取'), { status: 409 })
        if (value.session) { cloud.updateSession(value.session, authRevision); store.activeAccount = cloud.account }
        const { session: _session, ...current } = value
        catalogMemory.set(pendingKey, { value: current, updatedAt: Date.now() })
        const { writeFileAtomic } = await import('../server/media-files.ts')
        writeFileAtomic(configFile, Buffer.from(JSON.stringify(current)))
        return current
      })
      .finally(() => { if (catalogRefreshes.get(pendingKey) === pending) catalogRefreshes.delete(pendingKey) })
    catalogRefreshes.set(pendingKey, pending)
    return pending
  }
  async function config() {
    const account = cloud.account
    const authRevision = cloud.authRevision
    const configFile = join(directory, 'catalog-' + createHash('sha256').update(account || 'anonymous').digest('hex') + '.json')
    let catalog = catalogMemory.get(configFile)?.value || null
    try { catalog = JSON.parse(readFileSync(configFile, 'utf8')) } catch {}
    // The encrypted account session and last successful catalog are already on
    // disk. Paint from them immediately; cloud reconciliation runs in the
    // background so a slow proxy no longer holds the login, balance or canvas.
    if (catalog) {
      void refreshConfigCatalog(account, authRevision, configFile)
        .then(value => { if (cloud.account === account && cloud.authRevision === authRevision) lastConfig = value })
        .catch(error => {
          if (cloud.account === account && error?.status !== 409) cloud.status = cloud.cookie ? 'offline' : 'disconnected'
        })
      return configResponse(catalog)
    }
    try {
      catalog = await refreshConfigCatalog(account, authRevision, configFile)
    } catch (error) {
      if (cloud.account !== account || error.status === 409) throw error
      cloud.status = cloud.cookie ? 'offline' : 'disconnected'
    }
    // 不用内置全目录补回已关闭的模型；离线仅复用当前账号实际取得的目录。
    return configResponse(catalog)
  }
  async function previewFile(file, project, path, dimension, signal: AbortSignal, beforeCommit: () => void) {
    const key = createHash('sha256').update(JSON.stringify([project, path, file.revision, dimension])).digest('hex')
    const cache = join(directory, 'previews', `v${MEDIA_INPUT_VERSION}-p${MEDIA_PREVIEW_VERSION}-` + key + '.jpg')
    return previews.read(cache, file.bytes || file.diskPath, {
      video: /^video\//i.test(file.mime),
      maxDimension: dimension,
      beforeCommit,
    }, signal)
  }
  async function sendFile(request, response, file) {
    const etag = '"' + file.revision + '"'
    const version = new URL(request.url, address).searchParams.get('v')
    const cacheControl = /^(image|video|audio)\//.test(file.mime) && version === file.revision ? 'private, max-age=31536000, immutable' : 'private, no-cache'
    const sent = await serveFileContent(request, response, file, { etag, headers: { 'cache-control': cacheControl, 'x-workspace-revision': file.revision } })
    if (!sent) throw Object.assign(new Error('文件不存在'), { status: 404 })
  }
  async function proxy(request, response, path, options: Record<string, any> = {}) {
    // Legacy node text streams need the same client-owned lifetime as /v1.
    // Omitting a signal would apply CloudGateway's ordinary 120s I/O deadline.
    const controller = !options.signal && path.split('?')[0] === '/api/ai/generate' ? new AbortController() : null
    const abort = () => { if (!response.writableEnded) controller?.abort() }
    if (controller) { response.once('close', abort); if (response.destroyed) abort() }
    try {
      const headers = { ...options.headers, ...(isWorkspaceRequest(request.headers) ? workspaceRequestHeaders() : {}) }
      const remote = await cloud.request(path, { ...options, headers, ...(controller ? { signal: controller.signal } : {}) })
      if (path.startsWith('/api/imagine/desktop/model/') && remote.status === 400) {
        // Older servers wrapped upstream connection failures in HTTP 400. Restore
        // their retry meaning for Pi, without replaying any product tool call.
        // A broken body is a transport failure, not evidence of bad input.
        // Only malformed JSON may use the generic HTTP 400 explanation.
        const body = await remote.text()
        let error: Record<string, any> = { error: '模型请求未能完成' }
        try {
          const value = JSON.parse(body)
          if (value && typeof value === 'object' && !Array.isArray(value)) error = value
        } catch { /* Older proxies may return an empty or HTML error page. */ }
        json(response, isTransientModelFailure(error.message || error.error) ? 502 : 400, error)
        return
      }
      response.writeHead(remote.status, { ...modelResponseHeaders(remote), ...(path.split('?')[0] === '/api/imagine/image' ? fileContentHeaders(remote.headers.get('content-type')) : {}) })
      if (remote.body) await pipeline(Readable.fromWeb(remote.body), response); else response.end()
    } catch (error) {
      const modelRequest = path.startsWith('/api/imagine/desktop/model/') || path.split('?')[0] === '/api/ai/generate'
      // Preserve retry meaning when the desktop cannot reach the cloud either.
      // Pi owns recovery; this relay never replays a request or a product tool.
      if (modelRequest && !response.headersSent && !response.destroyed && !options.signal?.aborted && !controller?.signal.aborted && !error.status && isTransientModelFailure(error)) {
        throw Object.assign(new Error('文本服务连接暂时中断，请稍后继续'), { status: 502, cause: error })
      }
      throw error
    } finally { if (controller) response.off('close', abort) }
  }
  async function modelCatalog(path) {
    const account = cloud.account
    const authRevision = cloud.authRevision
    const key = (path === '/api/ai/models' ? 'text-catalog:' : 'media-catalog:') + account
    const refresh = () => {
      const pendingKey = 'refresh:' + key
      const existing = catalogRefreshes.get(pendingKey)
      if (existing) return existing
      const pending = cloud.json(path, { signal: AbortSignal.timeout(path === '/api/ai/media/models' ? 25_000 : 5000) }).then(value => {
        if (cloud.account !== account || cloud.authRevision !== authRevision) throw Object.assign(new Error('账号已切换，请重新读取'), { status: 409 })
        if (path === '/api/ai/models') value = { ...value, data: (Array.isArray(value.data) ? value.data : []).filter(model => model.providerId === 'miaoimg') }
        catalogMemory.set(key, { value, updatedAt: Date.now() })
        store.run('INSERT INTO desktop_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value))
        return value
      }).finally(() => { if (catalogRefreshes.get(pendingKey) === pending) catalogRefreshes.delete(pendingKey) })
      catalogRefreshes.set(pendingKey, pending)
      return pending
    }
    // Media options must reflect current channel switches and capabilities.
    // Never serve a persisted menu while its permissions refresh in the background.
    if (path === '/api/ai/media/models') {
      try { return await refresh() }
      catch (error) {
        if (cloud.account !== account || cloud.authRevision !== authRevision || [401, 403, 409].includes(error.status)) throw error
        return { code: 200, data: [] }
      }
    }
    let saved: { value: any; updatedAt: number } | undefined = catalogMemory.get(key)
    if (!saved) {
      const row = store.get('SELECT value FROM desktop_meta WHERE key=?', key)
      if (row) {
        try { saved = { value: JSON.parse(row.value), updatedAt: 0 } } catch {}
      }
    }
    if (saved) {
      if (Date.now() - saved.updatedAt > 30_000) void refresh().catch(() => {})
      return saved.value
    }
    try {
      return await refresh()
    } catch (error) {
      if (cloud.account !== account || cloud.authRevision !== authRevision || [401, 403, 409].includes(error.status)) throw error
      return { code: 200, data: [] }
    }
  }
  const textApi = createDesktopTextApi({ workspaceFiles: files, cloud, proxy, mutate, json, requestFetch, modelSignal: () => modelSession.signal,
    loadOfficialModels: async () => (await modelCatalog('/api/ai/models')).data,
  })
  const incomingRequests = new HttpIncomingRequests('桌面服务正在关闭，请重新打开妙图', true)
  const server = createServer(withRequestProject(async (request, response) => {
    let incoming
    try { incoming = incomingRequests.begin(request, response) }
    catch (error) { json(response, 503, { ok: false, error: error.message }); return }
    try {
      const url = new URL(request.url, address || 'http://127.0.0.1')
      if (request.headers.host !== new URL(address).host) throw Object.assign(new Error('请求地址无效'), { status: 403 })
      const isModel = url.pathname.startsWith('/v1/')
      if (isModel) {
        if (request.headers.authorization !== 'Bearer ' + modelToken || request.method !== 'POST') throw Object.assign(new Error('模型会话无效，请重试'), { status: 403 })
        if (process.env.MIAO_DESKTOP_NO_GENERATION === '1') throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
        if (!['/v1/chat/completions', '/v1/responses'].includes(url.pathname)) throw new Error('模型协议无效')
        const controller = new AbortController(); response.on('close', () => { if (!response.writableEnded) controller.abort() })
        const signal = AbortSignal.any([controller.signal, modelSession.signal])
        const body = await readModelJson(request, undefined, signal)
        signal.throwIfAborted()
        await proxy(request, response, '/api/imagine/desktop/model' + url.pathname.slice(3), { method: 'POST', body, signal }); return
      }
      // MCP 客户端只带 Authorization，不带桌面窗口的 Cookie；必须在普通页面鉴权前处理。
      if (url.pathname === '/mcp' && await mcp.handleMcp(request, response, url, helpers)) return
      if (!String(request.headers.cookie || '').split(/;\s*/).includes('miao_desktop=' + token)) throw Object.assign(new Error('请求无效，请重新打开妙图'), { status: 401 })
      return await renderer.run(request, response, async () => {
      const project = currentProject() || DEFAULT_PROJECT_ID
      if (requiresDesktopProject(url.pathname)) store.project(project)
      if (process.env.MIAO_DESKTOP_NO_GENERATION === '1' && url.pathname === '/api/agent' && request.method === 'POST') throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
      if (url.pathname === '/api/desktop/status') { json(response, 200, { cloud: cloud.view(), sync: { enabled: false, mode: 'local' }, tools: tools.view(), directory, pending: store.all("SELECT request_id,status FROM desktop_tasks WHERE account=? AND status NOT IN ('succeeded','failed','cancelled','expired')", cloud.account) }); return }
      if (['/api/desktop/doubao', '/api/desktop/dola'].includes(url.pathname)) {
        const site = LOCAL_MEDIA_SITES.find(site => url.pathname.endsWith('/' + site.id))!
        const localRoute = localRoutes.get(site.provider)!
        if (request.method === 'GET') { json(response, 200, localRoute.view()); return }
        if (request.method !== 'POST') throw Object.assign(new Error('此操作需要 POST 请求'), { status: 405 })
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, 4096, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，请重新读取本机路由状态'), { status: 409 })
        json(response, 200, await localRoute.action(body.action, body, signal)); return
      }
      if (url.pathname === '/api/desktop/tools/install' && request.method === 'POST') { mutate(request); await tools.ensure(); json(response, 200, { ok: true, tools: tools.view() }); return }
      if (url.pathname === '/api/desktop/local-text/models' && request.method === 'GET') {
        json(response, 200, { code: 200, data: [...localRoutes.values()].flatMap(route => route.textModels()) }); return
      }
      if (url.pathname === '/api/desktop/local-text' && request.method === 'POST') {
        mutate(request)
        if (process.env.MIAO_DESKTOP_NO_GENERATION === '1') throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, 256 * 1024, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，文本任务尚未提交'), { status: 409 })
        if (!localMediaSite(body.model, body.providerId) || localMediaKind(body.model) !== 'text') throw Object.assign(new Error('请选择豆包或 Dola 的文本模型'), { status: 422 })
        json(response, 202, await tasks.submit(project, 'text', body)); return
      }
      if (url.pathname === '/api/desktop/register' && request.method === 'POST') { throw Object.assign(new Error('请使用邮箱验证码注册'), { status: 422 }) }
      if (url.pathname === '/api/desktop/login' && request.method === 'POST') {
        mutate(request); computer.cancel()
        const body = await readJson(request, 64 * 1024)
        await cloud.login({ email: body.email, password: body.password })
        store.activeAccount = cloud.account
        json(response, 200, { session: userSession() }); return
      }
      if (url.pathname === '/api/desktop/logout' && request.method === 'POST') { mutate(request); computer.cancel(); await cloud.logout(); store.activeAccount = cloud.account; json(response, 200, { ok: true }); return }
      if (url.pathname === '/api/desktop/reveal' && request.method === 'POST') { mutate(request); const body = await readJson(request); const file = files.locate('local', body.path, body.project || 'default'); await native.reveal(file.diskPath); json(response, 200, { ok: true }); return }
      if (url.pathname === '/api/desktop/export' && request.method === 'POST') { mutate(request); const body = await readJson(request); const file = files.locate('local', body.path, body.project || 'default'); json(response, 200, { saved: await native.save(file.diskPath, body.path.split('/').pop()) }); return }
      if (url.pathname.startsWith('/api/agent') && await computer.scope(() => agent.handle(request, response, session, url, helpers))) return
      if (url.pathname.startsWith('/api/nodes') || url.pathname.startsWith('/api/ext')) {
        const account = cloud.account, revision = cloud.authRevision
        const pluginSignal = AbortSignal.any([incoming.signal, modelSession.signal])
        const pluginHelpers = { ...helpers, pluginSignal, assertPluginScope: () => {
          pluginSignal.throwIfAborted()
          if (account !== cloud.account || revision !== cloud.authRevision) throw Object.assign(new Error('账号已切换，这次插件安装未提交'), { status: 409 })
        } }
        if (url.pathname.startsWith('/api/nodes') && await nodes.handle(request, response, session, url, pluginHelpers)) return
        if (url.pathname.startsWith('/api/ext') && await exts.handle(request, response, session, url, pluginHelpers)) return
      }
      if (url.pathname === '/api/ffmpeg/execute') { await tools.ensure(); if (await ffmpeg.handle(request, response, session, url, helpers)) return }
      if (url.pathname === '/api/plugins/export' && await exportPlugin(request, response, session, url)) return
      if (url.pathname.startsWith('/api/mcp/') && await mcp.handleControl(request, response, session, url, helpers)) return
      if (['/api/catalog','/api/prompts'].includes(url.pathname) && request.method === 'GET') {
        const controller = new AbortController(); response.on('close', () => controller.abort())
        const remote = previewArchiveOrigin && url.pathname === '/api/prompts' && url.searchParams.has('media')
          ? await fetch(new URL(url.pathname + url.search, previewArchiveOrigin), { signal: controller.signal })
          : await cloud.request(url.pathname + url.search, { anonymous: true, signal: controller.signal })
        response.writeHead(remote.status, { 'content-type': 'application/json', 'cache-control': 'no-cache' })
        if (remote.body) await pipeline(Readable.fromWeb(remote.body), response); else response.end()
        return
      }
      const archiveVideo = url.pathname.match(/^\/api\/library\/videos\/(\d{10,24})\/(\d{1,2})$/)
      if (archiveVideo && ['GET', 'HEAD'].includes(request.method)) {
        const controller = new AbortController(); response.on('close', () => controller.abort())
        const remote = await cloud.archiveVideo(archiveVideo[1], Number(archiveVideo[2]), { method: request.method, range: request.headers.range, signal: controller.signal })
        const headers = forwardedFileHeaders(remote)
        response.writeHead(remote.status, headers)
        if (remote.body) await pipeline(Readable.fromWeb(remote.body), response); else response.end()
        return
      }
      if ((/^\/(images|previews|thumbs|_oip\/sessions|showcase)\//.test(url.pathname) || /^\/landing\/film-[\w-]+\.webp$/.test(url.pathname)) && ['GET','HEAD'].includes(request.method)) {
        const controller = new AbortController(); response.on('close', () => controller.abort())
        const remote = await cloud.publicFile(url.pathname + url.search, { method: request.method, signal: controller.signal, headers: request.headers.range ? { range: request.headers.range } : {} })
        const headers = forwardedFileHeaders(remote)
        response.writeHead(remote.status, headers)
        if (remote.body) await pipeline(Readable.fromWeb(remote.body), response); else response.end()
        return
      }
      if (url.pathname === '/api/imagine/image' && request.method === 'GET') { await proxy(request, response, url.pathname + url.search); return }
      if (url.pathname === '/api/imagine/config') { json(response, 200, await config()); return }
      if (url.pathname === '/api/imagine/personalization') {
        const name = url.searchParams.get('document') || 'agents'
        if (request.method === 'GET') { json(response, 200, { ok: true, ...agent.readPersonalization('local', name) }); return }
        sameOrigin(request); const body = await readJson(request, 1024 * 1024)
        json(response, 200, { ok: true, ...agent.writePersonalization('local', body.document, body.content, body.revision ?? null) }); return
      }
      // The authenticated desktop settings can retrieve the account's MCP token;
      // no credentials are exposed by the unauthenticated MCP endpoint.
      if (url.pathname === '/api/imagine/mcp-skill' && request.method === 'GET') { json(response, 200, { ok: true, name: 'SKILL.md', content: mcpSkillMarkdown() }); return }
      if (url.pathname === '/api/imagine/mcp') {
        if (request.method === 'GET') {
          const access = mcpAccess(), available = mcpAvailable()
          json(response, 200, { ok: true, desktop: true, enabled: Boolean(available && access.enabled), hasToken: Boolean(available && access.token), token: available && access.enabled ? access.token || '' : '' }); return
        }
        if (['POST', 'PUT'].includes(request.method)) {
          sameOrigin(request)
          const account = cloud.account, authRevision = cloud.authRevision
          if (!account || cloud.authenticationExpired) throw Object.assign(new Error('请先登录后开启 MCP'), { status: 401 })
          if (cloud.sessionChanging) throw Object.assign(new Error('账号正在切换，这次 MCP 设置未保存'), { status: 409 })
          const body = await readJson(request, 64000)
          if (account !== cloud.account || authRevision !== cloud.authRevision || !mcpAvailable()) throw Object.assign(new Error('账号已切换，这次 MCP 设置未保存'), { status: 409 })
          if (request.method === 'PUT' && typeof body?.enabled !== 'boolean') throw Object.assign(new Error('缺少 MCP 开关状态'), { status: 422 })
          // Body reading yields to other requests. Read the latest credentials
          // only now, and save synchronously so a toggle cannot undo a rotation.
          const access = mcpAccess()
          const enabled = request.method === 'POST' ? Boolean(access.enabled) : body.enabled
          const next = { enabled, token: request.method === 'POST' || !access.token ? randomBytes(32).toString('hex') : access.token }
          saveMcpAccess(next)
          if (!enabled || request.method === 'POST') mcp.disconnectUser('local')
          json(response, 200, { ok: true, desktop: true, hasToken: true, enabled, token: enabled ? next.token : '' }); return
        }
      }
      if (url.pathname === '/api/imagine/providers' || url.pathname === '/api/imagine/providers/models') {
        if (request.method === 'GET' && url.pathname === '/api/imagine/providers') {
          json(response, 200, { ok: true, providers: listPublicProviders(files, session.userId) }); return
        }
        sameOrigin(request)
        if (request.headers['x-miaoimg-workspace'] !== '1') throw Object.assign(new Error('请求被拒绝，请刷新页面后重试'), { status: 403 })
        // Capture the account lifetime before awaiting the uploaded settings.
        return await withRequestSignal(request, response, modelSession.signal, async signal => {
          const body = await readJson(request, 512 * 1024)
          signal.throwIfAborted()
          if (url.pathname === '/api/imagine/providers/models' && request.method === 'POST') {
            const stored = body?.id ? providerById(files, session.userId, body.id) : null
            if (body?.id && !stored) throw Object.assign(new Error('供应商不存在'), { status: 404 })
            const models = await fetchProviderModels({
              apiUrl: body?.apiUrl || stored?.apiUrl,
              protocol: body?.protocol || stored?.protocol,
              apiKey: String(body?.apiKey ?? '').trim() || stored?.apiKey || '',
            }, { allowPrivate: true, fetchImpl: requestFetch || fetch, signal })
            signal.throwIfAborted()
            json(response, 200, { ok: true, models }); return
          }
          if (url.pathname === '/api/imagine/providers' && request.method === 'POST') {
            const provider = body?.operation === 'remove'
              ? removeProvider(files, session.userId, body.id)
              : upsertProvider(files, session.userId, body)
            json(response, 200, { ok: true, ...(body?.operation === 'remove' ? provider : { provider }) }); return
          }
          throw Object.assign(new Error('供应商接口不存在'), { status: 404 })
        })
      }
      if (url.pathname === '/api/desktop/trash' && request.method === 'GET') { json(response, 200, { items: store.all('SELECT id,project_id,path,mime,deleted_at FROM desktop_trash WHERE account IN (?,?) ORDER BY deleted_at DESC', '', cloud.account) }); return }
      if (url.pathname === '/api/desktop/trash/restore' && request.method === 'POST') {
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const assertCurrent = () => {
          signal.throwIfAborted()
          if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging) throw Object.assign(new Error('账号已切换，回收站恢复已停止'), { status: 409 })
        }
        const body = await readJson(request, undefined, signal)
        assertCurrent()
        const item = store.get('SELECT * FROM desktop_trash WHERE id=? AND account IN (?,?)', body?.id, '', account)
        if (!item) throw new Error('回收站记录不存在')
        store.ensureTrashProject(item.project_id, item.account)
        let path = item.path
        try { files.stat('local', path, item.project_id); const dot = path.lastIndexOf('.'); path = dot > path.lastIndexOf('/') ? path.slice(0,dot) + '-恢复-' + item.id.slice(0,8) + path.slice(dot) : path + '-恢复-' + item.id.slice(0,8) } catch {}
        const release = item.disk_path ? store.retainTrashBackup(item.id, item.disk_path) : () => {}
        let cleanup: ReturnType<typeof store.cleanupTrashBackups> | undefined
        try {
          await files.writeStream('local', { path, project: item.project_id, mime: item.mime,
            stream: item.disk_path ? createReadStream(item.disk_path) : Readable.from([Buffer.from(item.bytes)]),
            revision: null, signal, beforeCommit: assertCurrent })
          store.run('DELETE FROM desktop_trash WHERE id=?', item.id)
        } finally {
          release()
          if (item.disk_path) cleanup = store.cleanupTrashBackups([item.disk_path])
        }
        const cleanupWarning = cleanup && (cleanup.pending || cleanup.failed) ? '文件已恢复，回收站原件暂未清理' : ''
        json(response, 200, { ok: true, path, ...(cleanupWarning ? { cleanupWarning } : {}) }); return
      }
      if (url.pathname === '/api/imagine/session') { cloud.refresh().then(() => { store.activeAccount = cloud.account }).catch(() => {}); json(response, 200, { session: userSession(), requireLogin: false }); return }
      if (url.pathname === '/api/imagine/logout' && request.method === 'POST') { mutate(request); computer.cancel(); await cloud.logout(); store.activeAccount = cloud.account; json(response, 200, { ok: true }); return }
      if (url.pathname.startsWith('/api/imagine/workspace/projects')) {
        if (request.method === 'GET') { json(response, 200, { projects: store.projects().map(item => ({ ...item, fileCount: files.fileCounts('local').get(item.id) || 0 })), scoped: true }); return }
        mutate(request)
        const authRevision = cloud.authRevision
        const account = cloud.account
        const assertCurrent = () => { if (authRevision !== cloud.authRevision || account !== cloud.account) throw Object.assign(new Error('账号已切换，本次项目操作已停止'), { status: 409 }) }
        const body = await readJson(request, 64000)
        assertCurrent()
        if (url.pathname.endsWith('/rename')) {
          const id = typeof body?.id === 'string' ? body.id.trim() : ''
          if (!id) throw Object.assign(new Error('缺少项目编号'), { status: 422 })
          const name = cleanProjectName(body?.name)
          store.project(id)
          store.renameProject(id, name)
          json(response, 200, { project: store.project(id) }); return
        }
        if (url.pathname.endsWith('/open')) { store.project(body.id); store.run("UPDATE projects SET last_opened_at=? WHERE user_id='local' AND id=?", new Date().toISOString(), body.id); json(response, 200, { project: store.project(body.id) }); return }
        if (url.pathname.endsWith('/remove')) {
          if (typeof body?.id !== 'string' || !body.id) throw Object.assign(new Error('缺少项目编号'), { status: 422 })
          store.project(body.id)
          if (store.get("SELECT request_id FROM desktop_tasks WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled','expired')", body.id)) throw new Error('该项目还有待取回的生成任务，请先等待结果或明确取消')
          await mcp.withProjectRemoval('local', body.id, async () => {
            assertCurrent()
            try {
              await agent.prepareProjectRemoval('local', body.id)
              assertCurrent()
              store.project(body.id)
              if (store.get("SELECT request_id FROM desktop_tasks WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled','expired')", body.id)) throw new Error('该项目还有待取回的生成任务，请先等待结果或明确取消')
              // 整个项目先按原目录结构放进系统废纸篓，系统收下了才从妙图里删；放不进去就不删，告诉用户。
              const projectEntries = files.list('local', body.id)
              const staged = systemTrash.stage(store.projectLabel(body.id), projectEntries, path =>
                trashSource(body.id, path, projectEntries.find(entry => entry.path === path)?.mime || ''))
              try { await systemTrash.send(staged) } catch (error) {
                systemTrash.discard(staged)
                throw Object.assign(new Error('没能把项目放进废纸篓，项目未删除'), { status: 500, cause: error })
              }
              assertCurrent()
              const removed = files.removeProject('local', body.id, { preserveDefault: true })
              store.run('DELETE FROM desktop_sync WHERE project_id=? AND account=?', body.id, account)
              await agent.finishProjectRemoval('local', body.id)
              json(response, 200, { ok: true, ...removed })
            } catch (error) { await agent.cancelProjectRemoval('local', body.id); throw error }
          })
          return
        }
        json(response, 200, { project: { ...store.createProject(body.name), fileCount: 0 } }); return
      }
      if (url.pathname === '/api/imagine/workspace/files') {
        store.project(project)
        const path = url.searchParams.get('path')
        if (request.method === 'GET' || request.method === 'HEAD') {
          if (!path) { json(response, 200, { ...files.listSnapshot('local', project), capabilities: { nonRecursiveRemove: true, copyFiles: true, copyFilesBatch: true, copyCanvasSnapshots: true, guardedCanvasRemove: true, markdownFileLinks: true, treeSourceEntries: true } }); return }
          let file = files.locate('local', path, project)
          const waveform = url.searchParams.get('waveform') === '1'
          const preview = url.searchParams.get('preview') === '1' && /^(image|video)\//i.test(file.mime)
          const play = url.searchParams.get('playback') === '1' && /^video\//.test(file.mime)
          if (waveform || preview || play) {
            const account = cloud.account, authRevision = cloud.authRevision, revision = file.revision
            const assertCurrent = () => {
              if (cloud.account !== account || cloud.authRevision !== authRevision) throw Object.assign(new Error('账号已切换，请重新读取'), { status: 409 })
              store.project(project)
              if (files.stat('local', path, project).revision !== revision) throw Object.assign(new Error('媒体已更新，请重新读取'), { status: 409 })
            }
            await withRequestSignal(request, response, modelSession.signal, async signal => {
              if (waveform) {
                const peaks = await waveforms.read(JSON.stringify([account, project]), file, signal, assertCurrent)
                signal.throwIfAborted(); assertCurrent()
                json(response, 200, { peaks, revision }); return
              }
              if (preview) {
                const dimension = url.searchParams.get('previewSize') === '320' ? 320 : 1024
                const cache = await previewFile(file, project, path, dimension, signal, assertCurrent)
                file = { ...file, diskPath: cache, bytes: null, size: statSync(cache).size, mime: 'image/jpeg', revision: revision + `-preview-v${MEDIA_INPUT_VERSION}-p${MEDIA_PREVIEW_VERSION}-` + dimension }
              } else {
                // Playback copies never replace originals or model references.
                const owner = createHash('sha256').update(project).digest('hex')
                file = await playback.playback(owner, file, { signal, beforeCommit: assertCurrent }) || file
              }
              signal.throwIfAborted(); assertCurrent()
              await sendFile(request, response, file)
            })
            return
          }
          await sendFile(request, response, file); return
        }
        mutate(request)
        if (request.method === 'PUT') { json(response, 200, await files.writeStream('local', { path, project, mime: request.headers['content-type'] || 'application/octet-stream', stream: request, revision: url.searchParams.get('revision') || null })); return }
        const body = await readJson(request); const scope = body.project || project; store.project(scope)
        json(response, 200, files.mutate('local', { ...body, project: scope })); return
      }
      if (url.pathname === '/api/imagine/workspace') {
        store.project(project)
        if (request.method === 'GET') { json(response, 200, store.workspaceForUser('local', project)); return }
        mutate(request); const body = await readJson(request); const scope = body.project || project; store.project(scope)
        const current = store.workspaceForUser('local', scope)
        if ('workspace' in body && body.workspaceRevision !== current.workspaceRevision) throw Object.assign(new Error('本地工作区刚更新，请重新读取'), { status: 409 })
        let assets = current.assets
        if (body.assetOperation === 'save') assets = [...assets.filter(item => item.id !== body.asset.id), body.asset]
        if (body.assetOperation === 'remove') assets = assets.filter(item => item.id !== body.assetId)
        json(response, 200, store.saveWorkspaceForUser('local', { workspace: body.workspace, assets, project: scope })); return
      }
      if (url.pathname === '/api/imagine/reference-url' && request.method === 'POST') {
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, undefined, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，参考素材尚未上传'), { status: 409 })
        const value = await tasks.referenceUrl(project, body.path)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，请重新读取参考素材'), { status: 409 })
        json(response, 200, value); return
      }
      if (['/api/imagine/generate', '/api/imagine/video'].includes(url.pathname) && request.method === 'POST') {
        mutate(request)
        if (process.env.MIAO_DESKTOP_NO_GENERATION === '1') throw Object.assign(new Error('本次开发验收禁止真实模型调用'), { status: 403 })
        if (process.env.MIAO_DESKTOP_NO_MEDIA_GENERATION === '1') throw Object.assign(new Error('本次剪辑验收禁止图片和视频模型请求'), { status: 403 })
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, undefined, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，生成任务尚未提交'), { status: 409 })
        json(response, 202, await tasks.submit(project, url.pathname.endsWith('/video') ? 'video' : 'image', body))
        return
      }
      if (['/api/imagine/estimate', '/api/imagine/video/estimate'].includes(url.pathname) && request.method === 'POST') {
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, undefined, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，请重新读取模型价格'), { status: 409 })
        const localSite = localMediaSite(body.model, body.providerId)
        if (localSite) {
          await localRoutes.get(localSite.provider)!.validate(url.pathname.includes('/video/') ? 'video' : 'image', body, true, signal)
          json(response, 200, { ok: true, points: null, pricingAvailable: false, source: localSite.provider, billingSource: localSite.provider, message: '使用' + localSite.label + '账户额度' }); return
        }
        const prepared = await tasks.prepare(project, body)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，请重新读取模型价格'), { status: 409 })
        json(response, 200, await cloud.json(url.pathname, { method: 'POST', body: prepared, headers: { 'x-workspace-project': 'default' }, signal })); return
      }
      if (['/api/imagine/generation/node', '/api/imagine/video/node'].includes(url.pathname)) {
        const kind = url.pathname === '/api/imagine/video/node' ? 'video' : url.searchParams.get('kind') === 'text' ? 'text' : 'image'
        if (kind === 'text' && (!url.searchParams.get('providerId') || !localMediaSite(url.searchParams.get('model'), url.searchParams.get('providerId')) || localMediaKind(url.searchParams.get('model')) !== 'text')) throw Object.assign(new Error('原文本任务来源或模型无效'), { status: 422 })
        const row = kind === 'text'
          ? store.get("SELECT * FROM desktop_tasks WHERE project_id=? AND account=? AND directory=? AND kind='text' AND json_extract(result,'$.route') IN ('doubao-local','dola-local') AND json_extract(result,'$.route')=? AND json_extract(result,'$.model')=? ORDER BY created_at DESC,rowid DESC LIMIT 1", project, cloud.account, url.searchParams.get('outputDirectory'), url.searchParams.get('providerId'), url.searchParams.get('model'))
          : store.get('SELECT * FROM desktop_tasks WHERE project_id=? AND account=? AND directory=? AND kind=? ORDER BY created_at DESC,rowid DESC LIMIT 1', project, cloud.account, url.searchParams.get('outputDirectory'), kind)
        json(response, 200, { ok: true, task: row && row.kind === kind && !['failed','cancelled','expired'].includes(row.status) ? { requestId: row.request_id, status: row.status } : null }); return
      }
      const task = /^\/api\/imagine\/(generation|video)\/([A-Za-z0-9_-]+)(?:\/(restore|cancel))?$/.exec(url.pathname)
      if (task) {
        const row = store.get('SELECT * FROM desktop_tasks WHERE request_id=? AND project_id=?', task[2], project)
        if (!row) throw Object.assign(new Error('本地任务不存在'), { status: 404 })
        if (task[3] === 'cancel') {
          if (request.method !== 'POST') throw Object.assign(new Error('取消任务需要 POST 请求'), { status: 405 })
          mutate(request); json(response, 200, await tasks.cancel(row)); return
        }
        const result = tasks.status(row)
        if (task[3] === 'restore' && ['failed', 'cancelled', 'expired'].includes(result.status)) throw Object.assign(new Error(result.error || '原任务已结束，没有可取回的生成文件'), { status: result.status === 'expired' ? 410 : 422 })
        json(response, 200, task[3] === 'restore' ? { ok: true, path: result.video?.metadata?.workspacePath || result.images?.[0]?.path || '' } : result); return
      }
      if (url.pathname === '/api/imagine/history' && request.method === 'GET') { json(response, 200, await tasks.history(project, Object.fromEntries(url.searchParams))); return }
      if (await textApi.handle(request, response, session, url)) return
      if (url.pathname === '/api/ai/media/models' && request.method === 'GET') {
        // Local platform menus are refreshed by the settings/login flow. They
        // must not hold the whole model picker hostage while two hidden pages
        // timeout. Serve the official catalog and last verified local menus now.
        const catalog = await modelCatalog(url.pathname)
        void Promise.all([...localRoutes.values()].map(route => route.prepareModels(AbortSignal.timeout(30_000)).catch(() => {})))
        json(response, 200, { ...catalog, data: [...(Array.isArray(catalog.data) ? catalog.data : []), ...[...localRoutes.values()].flatMap(route => route.models())] })
        return
      }
      if (url.pathname === '/api/imagine/password' && request.method === 'POST') {
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, 64000, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，密码尚未修改'), { status: 409 })
        const value = await cloud.json(url.pathname, { method: 'POST', body, signal })
        try { await cloud.updateSession(value.session, revision, true) }
        catch (error) {
          if (error.code === 'CREDENTIAL_PERSIST_FAILED') throw Object.assign(new Error('密码已在云端修改成功，但新登录状态未能保存到本机。下次打开请使用新密码登录，并检查本机可用空间和凭据保护。'), { status: 500, code: error.code })
          throw error
        }
        json(response, 200, { session: userSession() }); return
      }
      // 反馈数据只在云端：桌面端原样转发，截图随请求一起上传，所以单独放宽体积上限。
      if (url.pathname === '/api/imagine/feedback' || url.pathname.startsWith('/api/imagine/feedback/')) {
        if (request.method === 'GET') { await proxy(request, response, url.pathname + url.search, { method: 'GET' }); return }
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, 24 * 1024 * 1024, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，这条反馈尚未提交'), { status: 409 })
        await proxy(request, response, url.pathname, { method: request.method, body, signal }); return
      }
      const allowedCloud = ['/api/imagine/error-explanation', '/api/imagine/ledger', '/api/imagine/payment/orders']
      if (allowedCloud.some(path => url.pathname === path || path === '/api/imagine/payment/orders' && url.pathname.startsWith(path + '/'))) {
        if (request.method === 'GET') { await proxy(request, response, url.pathname + url.search, { method: request.method }); return }
        mutate(request)
        const account = cloud.account, revision = cloud.authRevision, signal = AbortSignal.any([incoming.signal, modelSession.signal])
        const body = await readJson(request, undefined, signal)
        signal.throwIfAborted()
        if (account !== cloud.account || revision !== cloud.authRevision || cloud.sessionChanging || cloud.authenticationExpired) throw Object.assign(new Error('账号已切换，这次请求尚未提交'), { status: 409 })
        await proxy(request, response, url.pathname + url.search, { method: request.method, body, signal }); return
      }
      if (url.pathname === '/api/imagine/email/config' && request.method === 'GET') {
        json(response, 200, await cloud.json(url.pathname, { anonymous: true })); return
      }
      if (url.pathname === '/api/imagine/email/request-code' && request.method === 'POST') {
        json(response, 200, await cloud.json(url.pathname, { method: 'POST', body: await readJson(request, 64 * 1024), anonymous: true })); return
      }
      if (url.pathname === '/api/imagine/password/reset' && request.method === 'POST') {
        computer.cancel()
        await cloud.resetPassword(await readJson(request, 64 * 1024))
        store.activeAccount = cloud.account
        json(response, 200, { session: userSession() }); return
      }
      if (url.pathname === '/api/imagine/email/verify-code' && request.method === 'POST') {
        computer.cancel()
        await cloud.loginWithEmailCode(await readJson(request, 64 * 1024))
        store.activeAccount = cloud.account
        json(response, 200, { session: userSession() }); return
      }
      if (url.pathname === '/health') { json(response, 200, { ok: true, desktop: true }); return }
      if (url.pathname.startsWith('/api/')) throw Object.assign(new Error('桌面接口尚未支持此操作'), { status: 404 })
      let target = resolve(webRoot, '.' + decodeURIComponent(url.pathname))
      if (target !== resolve(webRoot) && !target.startsWith(resolve(webRoot) + sep)) throw Object.assign(new Error('资源地址无效'), { status: 403 })
      if (!existsSync(target) || statSync(target).isDirectory()) target = join(webRoot, 'index.html')
      const entry = entryHtml(target)
      if (entry) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': entry.body.length, 'content-security-policy': entry.policy })
        response.end(entry.body)
        return
      }
      response.writeHead(200, { 'content-type': MIME[extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' })
      await pipeline(createReadStream(target), response)
      })
    } catch (error) {
      const url = new URL(request.url, address || 'http://127.0.0.1')
      const accountRequest = /^\/api\/desktop\/(login|register|logout)$/.test(url.pathname) || url.pathname.startsWith('/api/imagine/email/')
      if (accountRequest) {
        const network = !error.status && /fetch|net::|network|timeout|timed out|abort|ECONN|ENOTFOUND|连接/i.test(String(error.message))
        const message = network ? '暂时连接不上妙图，请检查网络或系统代理后重试' : Number(error.status) === 401 ? '邮箱或密码不正确，请重新输入，或使用邮箱验证码登录' : userFacingError(error, { status: error.status })
        console.warn('账号请求失败', url.pathname, Number(error.status) || 0, error.cause?.code || error.code || error.name)
        if (!response.headersSent) json(response, network ? 503 : Number(error.status) || 400, { ok: false, error: message, message })
        else response.destroy()
        return
      }
      if (!response.headersSent) json(response, Number(error.status) || 400, { ok: false, code: Number(error.status) || 400, error: userFacingError(error, { status: Number(error.status) || 400 }), message: userFacingError(error, { status: Number(error.status) || 400 }), errorExplanation: error.errorExplanation || explainUserError(error, { status: Number(error.status) || 400 }), ...(error.activeRequestId ? { activeRequestId: error.activeRequestId } : {}) }); else response.destroy() }
    finally { incoming.finish() }
  }))
  const preferredPort = Number(store.get("SELECT value FROM desktop_meta WHERE key='mcp-port'")?.value || 0)
  const listen = port => new Promise <void>((done, fail) => { const error = reason => { server.removeListener('listening', ready); fail(reason) }; const ready = () => { server.removeListener('error', error); done() }; server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1') })
  try { await listen(Number.isInteger(preferredPort) && preferredPort > 1024 && preferredPort <= 65535 ? preferredPort : 0) }
  catch (error) { if (error.code !== 'EADDRINUSE' || !preferredPort) throw error; await listen(0) }
  store.run("INSERT INTO desktop_meta(key,value) VALUES('mcp-port',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String((server.address() as import('node:net').AddressInfo).port))
  address = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
  return { address, token, csrf, store, files, cloud, tasks, computer, renderer, localRoutes,
    stop() {
      if (stopRequest) return stopRequest
      const completed = Promise.withResolvers<void>()
      stopRequest = completed.promise
      // Seal all HTTP admission before an asynchronous service close. Requests
      // without a renderer epoch and /v1 model relays own real handlers too.
      const httpStopped = incomingRequests.stop()
      const shutdown = async () => {
        const errors: unknown[] = []
        const settle = async (operations: Promise<unknown>[]) => {
          for (const result of await Promise.allSettled(operations)) if (result.status === 'rejected') errors.push(result.reason)
        }
        modelSession.abort(new DOMException('桌面服务正在关闭', 'AbortError'))
        const textStopped = textApi.stop()
        renderer.retire()
        // Agent/MCP tools may themselves be waiting for cloud access or media
        // tool installation. Cancel their dependencies before joining them.
        tasks.stop(); const cloudStopped = cloud.stop(); tools.stop()
        const localStopped = [...localRoutes.values()].map(route => Promise.resolve(route.stop()))
        const agentStopped = agent.close(), mcpStopped = mcp.stop(), computerStopped = computer.stop()
        server.closeAllConnections()
        const serverStopped = new Promise<void>(done => server.close(() => done()))
        await settle([agentStopped, mcpStopped, computerStopped, ...localStopped, previews.stop(), playback.stop(), waveforms.stop(), textStopped, serverStopped, httpStopped, cloudStopped])
        // Aborting work is expected to reject its result. Join that outcome
        // without confusing it with a failure of a service's own close().
        await Promise.allSettled([...tasks.inflight.values(), ...tasks.cancelling.values(), ...tasks.saving.values(), ...tasks.deliveries.values(), ...tasks.staging.values(), ...[...tasks.submitting.values()].map(item => item.promise), ...(tools.pending ? [tools.pending] : [])])
        await settle([renderer.wait()])
        // A rejected service close is not proof that its callbacks stopped.
        // Keep the store open if ownership could not be fully drained.
        if (errors.length) throw errors[0]
        store.cleanupTrashBackups()
        store.close()
      }
      void shutdown().then(completed.resolve, completed.reject)
      return stopRequest
    } }
}
