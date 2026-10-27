import { isWorkspaceRequest } from './canvas-document.ts'
// External agents call the canvas connected to this runtime. Desktop serves a
// loopback endpoint; hosted deployments serve HTTPS. Both require an MCP token.
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import { createVideoReviewTool, VIDEO_REVIEW_CONTENT } from './video-review.ts'
import { directorPreviewContent } from './node-reference-media.ts'
import { readJsonRequest } from './model-transport.ts'
import { failure } from './management-store.ts'
import { CANVAS_TOOLS } from './agent-api.ts'
import { createMediaTools, mediaToolMetadata } from './media-tools.ts'
import { createLibraryTools, libraryToolMetadata } from './library-tools.ts'
import { createSharedTools, createWorkspaceFilesCore, isProtectedWorkspacePath, sharedToolMetadata } from './agent-tools.ts'
import { createCloudWebTools } from './web/tools.ts'
import { readFileSync } from 'node:fs'
import { currentProject, DEFAULT_PROJECT_ID } from './workspace-scope.ts'
import { isWorkspacePath } from './workspace-path.ts'
import { t } from './i18n.ts'
import { captureCanvasControlTarget } from './canvas-control-target.ts'
import { readWorkspaceRange } from './workspace-read.ts'
import { McpIncomingRequests } from './mcp-request-lifetime.ts'
import { toolWorkspaceFiles, toolWorkspaceStatePaths } from './tool-workspace-files.ts'

const requestProject = () => currentProject() || DEFAULT_PROJECT_ID
const videoReviewDefinition = createVideoReviewTool({})

function writeEvent(response, payload) {
  if (response.writableEnded || response.destroyed) return false
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
  return true
}

// 面板与文档工具：和画布工具一样在打开的页面里执行，走同一条控制通道。
export { PANEL_TOOLS } from './canvas-tools.ts'

// 服务端工具：不依赖浏览器页面，按账号直接读写工作区。
export const SERVER_TOOLS = [
  { name: 'getAppState', description: '列出当前账号已连接的妙图页面（画布、面板、可用画布工具）与工作区状态。连接 ready=false 时等待状态同步后重读。画布、面板与文档工具需要页面保持打开；同时打开多个页面时先关掉多余的。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'workspaceFiles', description: '读写配置项目里的文件。list 列出目录（limit 默认 200、最多 500；hasMore=true 时用 nextOffset 作为 offset 继续）；readText 读文本内容（UTF-8，最多 20 万字符）；writeText 写文本（不超过 200KB）；readBinary/writeBinary 用 base64 传不超过 20MB 的媒体（写入默认不覆盖，exclusive:false 才覆盖）；copy 将单个普通文件另存到 target（不经 base64、不覆盖）；mkdir 建目录、rename 改名、remove 删除（目录按前缀级联）。Markdown 文件改名或复制保留图片、附件链接的目标，不必手工改写正文。assets/ 内部原件可读、可另存副本，仅允许新建，已有文件须用节点工具编辑。画布或 Markdown 正文仍引用的普通文件也保持原位，先另存副本再整理。画布编辑、改名、删除须用画布工具，复制须用 duplicateCanvas；正在打开的文档须用文档工具修改。', parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'readText', 'writeText', 'readBinary', 'writeBinary', 'mkdir', 'copy', 'rename', 'remove'] },
    path: { type: 'string', description: '工作区内相对路径；list 时当目录，readText/writeText/readBinary/writeBinary 时是要读写的文件' },
    target: { type: 'string', description: 'copy/rename 的新路径；copy 不覆盖已有文件' },
    limit: { type: 'number', description: 'list 返回条数，默认 200，最多 500' },
    offset: { type: 'integer', minimum: 0, description: 'list 的条目偏移或 readText 的字节偏移；用上次响应的 nextOffset 继续' },
    maxBytes: { type: 'integer', minimum: 1000, maximum: 200000, description: 'readText 每页原始字节上限' },
    content: { type: 'string', description: 'writeText 的文本内容' },
    mime: { type: 'string', description: 'writeText/writeBinary 的内容类型，默认 text/plain / application/octet-stream' },
    base64: { type: 'string', description: 'writeBinary 的内容（base64）' },
    exclusive: { type: 'boolean', description: 'writeBinary 是否只允许新建，默认 true' },
  }, required: ['action', 'path'], additionalProperties: false,
    allOf: [
      { if: { properties: { action: { const: 'writeText' } } }, then: { required: ['content'] } },
      { if: { properties: { action: { const: 'writeBinary' } } }, then: { required: ['base64'] } },
      { if: { properties: { action: { enum: ['copy', 'rename'] } } }, then: { required: ['target'] } },
      { if: { properties: { action: { not: { const: 'list' } } } }, then: { properties: { path: { minLength: 1 } } } },
    ],
  } },
  // 技能与网页工具与 Agent 侧共用同一份定义（server/agent-tools.ts）：不需要页面，纯服务端执行。
  ...sharedToolMetadata,
  ...libraryToolMetadata,
  // 媒体工具与 Agent 侧共用同一份定义（server/media-tools.ts）：不需要页面，纯服务端执行。
  ...mediaToolMetadata,
  { name: videoReviewDefinition.name, description: videoReviewDefinition.description, parameters: videoReviewDefinition.parameters },
]

export const MCP_TOOLS = [...CANVAS_TOOLS, ...SERVER_TOOLS].map(tool => ({
  ...tool,
  description: tool.description.replaceAll('readWorkspaceFile', 'workspaceFiles（action: readText）'),
}))
const MCP_BODY_BYTES = 32 * 1024 * 1024
const MEDIA_LIMIT_BYTES = 20 * 1024 * 1024
const RECONNECT_PROTECTION_MS = 30_000

// 供设置 → MCP 的「妙图 Skill」查看 / 复制 / 导出（SKILL.md）。
export function mcpSkillMarkdown() {
  return readFileSync(new URL('./mcp-skill.md', import.meta.url), 'utf8')
}

function toolResult(value) {
  if (value?.[VIDEO_REVIEW_CONTENT]) return { content: value[VIDEO_REVIEW_CONTENT] }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  // readBinary 的合法结果可达 20MiB；不能切掉 JSON/base64 尾部。
  return { content: [{ type: 'text', text }] }
}

export function createMcpApi({ management, workspaceFiles, showcaseRoot = '', showcaseAssetFetch, webTools, webToolsForUser, ensureMediaTools, additionalTools,
  assertProjectAccess = (userId, project) => workspaceFiles.projectRoot(userId, project),
}: Record<string, any>) {
  const activeCalls = new Set<any>()
  type RequestAccess = { userId: string; projectId: string; revoked?: Error; abort(reason: Error): void }
  const activeRequests = new Set<RequestAccess>()
  const incomingRequests = new McpIncomingRequests()
  let stopping = false, stopped: Promise<void> | undefined
  const assertRunning = () => { if (stopping) throw failure('MCP 服务正在关闭，请稍后重试', 503) }
  const removingProjects = new Set<string>()
  const projectKey = (userId, projectId) => JSON.stringify([userId, projectId])
  function assertProjectAvailable(userId, projectId) {
    assertProjectAccess(userId, projectId)
    if (removingProjects.has(projectKey(userId, projectId))) throw failure('项目正在关闭，请稍后重试', 409)
  }
  const connections = new Map()
  // A transport disconnect is not an editor close. Keep path metadata for the
  // normal reconnect window and unresolved execution IDs until confirmation.
  const disconnectedViews = new Map<string, any>()
  const workspaceScope = (userId, projectId = requestProject()) => JSON.stringify([userId, projectId, workspaceFiles.referenceOwner?.(userId) || String(userId)])
  function forgetDisconnectedView(key) {
    const view = disconnectedViews.get(key)
    clearTimeout(view?.timer)
    disconnectedViews.delete(key)
  }
  function expireDisconnectedView(key, view) {
    clearTimeout(view.timer)
    view.expires = Date.now() + RECONNECT_PROTECTION_MS
    view.timer = setTimeout(() => { if (disconnectedViews.get(key) === view) forgetDisconnectedView(key) }, RECONNECT_PROTECTION_MS)
    view.timer.unref?.()
  }
  function reconnectingViews(userId, projectId = requestProject()) {
    const scope = workspaceScope(userId, projectId)
    const views: any[] = []
    for (const [key, view] of disconnectedViews) {
      if (view.expires <= Date.now()) forgetDisconnectedView(key)
      else if (view.scope === scope) views.push(view)
    }
    return views
  }
  const unconfirmedWork = (userId, projectId = requestProject()) => reconnectingViews(userId, projectId).some(view => view.executingCalls.length)
  function connectionReady(connection) {
    return Boolean(connection.state) && !connection.state.executingCalls?.some(id => id !== connection.pending?.callId)
      && !unconfirmedWork(connection.userId, connection.projectId)
  }
  const connectionForUser = userId => [...connections.values()].filter(item => item.userId === userId && !item.closed)
  const projectConnections = userId => {
    const scope = workspaceScope(userId)
    return connectionForUser(userId).filter(item => item.scope === scope)
  }
  const enabled = userId => { const info = management.mcpTokenInfo(userId); return info.enabled ?? info.hasToken }

  // Serialize UI operations. A cancelled call keeps its lease until the page
  // acknowledges completion, so the next write cannot race a late save.
  function callCanvas(userId, name, args, signal) {
    const matches = projectConnections(userId)
    if (!matches.length) throw failure(connectionForUser(userId).length
      ? '当前打开的项目与 MCP 配置不一致，请打开配置对应的项目，或重新复制 MCP 配置'
      : '请先打开妙图画布并在设置中开启 MCP，保持应用运行', 409)
    if (matches.length > 1) throw failure('检测到多个画布页面，请只保留一个再试', 409)
    const connection = matches[0]
    if (!connectionReady(connection)) throw failure('画布正在同步状态或等待旧操作结束，请稍后重新读取应用状态', 409)
    if (connection.queue.length >= 32) throw failure('画布待处理命令较多，请等待当前操作完成', 429)
    const notDispatched = t`操作尚未下发到画布，未执行`
    const unconfirmed = t`已下发操作的结果待确认，可能已经保存；请先读取画布、节点或任务状态，不要直接重复执行`
    return new Promise<any>((resolve, reject) => {
      // Capture the target when admitted, before another queued operation or
      // a manual navigation can change the page's active canvas.
      const item: Record<string, any> = { callId: crypto.randomUUID(), name, args,
        ...captureCanvasControlTarget(connection.state),
        settled: false, cancelled: false, dispatched: false }
      item.interrupt = reason => item.settle({ error: `${reason}；${item.dispatched ? unconfirmed : notDispatched}` })
      item.settle = payload => {
        if (item.settled) return
        item.settled = true
        signal?.removeEventListener('abort', cancel)
        if (payload?.error !== undefined) reject(new Error(String(payload.error || '画布操作失败')))
        else resolve(payload?.result ?? null)
      }
      const cancel = () => {
        item.cancelled = true
        item.interrupt(signal?.reason?.message || t`画布调用已停止等待`)
        if (connection.pending === item) writeEvent(connection.response, { type: 'cancel', callId: item.callId })
        else connection.queue = connection.queue.filter(job => job !== item)
      }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      connection.queue.push(item)
      pump(connection)
    })
  }
  function pump(connection) {
    if (connection.closed || connection.pending || removingProjects.has(projectKey(connection.userId, connection.projectId))) return
    const item = connection.queue.shift()
    if (!item) return
    if (item.cancelled) { pump(connection); return }
    connection.pending = item
    item.finish = payload => {
      if (connection.pending !== item) return
      connection.pending = undefined
      item.settle(payload)
      for (const waiter of connection.idleWaiters) waiter.resolve()
      connection.idleWaiters.clear()
      pump(connection)
    }
    item.dispatched = writeEvent(connection.response, { type: 'call', callId: item.callId, name: item.name, args: item.args, directory: item.directory, expectedCanvasId: item.expectedCanvasId })
    if (!item.dispatched) closeConnection(connection)
  }
  function closeConnection(connection, message = t`画布连接已断开`) {
    if (connection.closed) return
    const previous = disconnectedViews.get(connection.viewKey)
    forgetDisconnectedView(connection.viewKey)
    const executingCalls = [...new Set([
      ...(previous?.executingCalls ?? []), ...(connection.state?.executingCalls ?? []),
      ...(connection.pending?.dispatched ? [connection.pending.callId] : []),
    ])].filter(id => !connection.settledCalls.has(id))
    const view = { scope: connection.scope, documentId: connection.documentId, paths: [...new Set([...statePaths(connection.state), ...(previous?.paths ?? [])])], executingCalls,
      uncertain: !connection.state || Boolean(executingCalls.length), expires: executingCalls.length ? Infinity : Date.now() + RECONNECT_PROTECTION_MS, timer: undefined }
    disconnectedViews.set(connection.viewKey, view)
    // Unconfirmed business work has no timeout-based release. A same-page
    // snapshot must confirm that its execution IDs have actually settled.
    if (!executingCalls.length) {
      expireDisconnectedView(connection.viewKey, view)
    }
    connection.closed = true
    clearInterval(connection.timer)
    connections.delete(`${connection.userId}:${connection.projectId}:${connection.id}`)
    connection.pending?.interrupt(message)
    connection.pending = undefined
    for (const item of connection.queue.splice(0)) item.interrupt(message)
    for (const waiter of connection.idleWaiters) waiter.reject(failure('画布连接已断开，无法确认操作已停止；项目尚未删除，请稍后重试', 409))
    connection.idleWaiters.clear()
    connection.response.end()
  }
  function authorize(request) {
    const header = String(request.headers.authorization || '')
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const userId = token ? management.userByMcpToken(token) : null
    if (!userId || !enabled(userId)) throw failure('MCP 访问令牌无效，请在设置 → MCP 里重新生成', 401)
    return userId
  }

  // 打开中的画布/文档：外部 Agent 不能直接改这些文件，必须走画布或文档工具。
  const statePaths = toolWorkspaceStatePaths

  function updateConnectionState(connection, payload) {
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) throw failure('控制状态格式无效', 422)
    if (payload.state.retainedPaths !== undefined && (!Array.isArray(payload.state.retainedPaths) || !payload.state.retainedPaths.every(isWorkspacePath))) throw failure('控制状态中的文件路径无效', 422)
    const executing = payload.state.executingCalls
    if (executing !== undefined && (!Array.isArray(executing) || executing.length > 64 || !executing.every(id => typeof id === 'string' && id.length > 0 && id.length <= 64))) throw failure('控制状态中的操作标识无效', 422)
    if (payload.revision > connection.revision) {
      connection.revision = payload.revision
      connection.state = payload.state
      const previous = disconnectedViews.get(connection.viewKey)
      // Legacy snapshots cannot confirm completion of a detached operation.
      if (!previous?.executingCalls.length || (executing !== undefined && !previous.executingCalls.some(id => executing.includes(id)))) forgetDisconnectedView(connection.viewKey)
    }
  }

  const fileGuard = toolWorkspaceFiles(workspaceFiles)
  const guardedFiles = fileGuard.files
  const isCanvasFile = (userId, entry) => fileGuard.isCanvasFile(userId, entry)
  fileGuard.addViews((userId, project) => {
    const scope = workspaceScope(userId, project)
    return [
      ...connectionForUser(userId).filter(connection => connection.scope === scope).map(connection => ({
        paths: statePaths(connection.state), uncertain: !connection.state,
        busy: Boolean(connection.pending || connection.state?.executingCalls?.length),
      })),
      ...reconnectingViews(userId, project).map(view => ({ paths: view.paths, uncertain: view.uncertain })),
    ]
  })

  // 媒体、技能与网页工具都与 Agent 共用实现，userId 每次调用时按令牌解出来的账号传入。
  const mediaTools = createMediaTools({ workspaceFiles: guardedFiles })
  const workspaceFileTools = createWorkspaceFilesCore({ workspaceFiles: guardedFiles })
  const sharedTools = createSharedTools({ workspaceFiles: guardedFiles, webTools,
    webToolsForUser: webToolsForUser || (management ? userId => createCloudWebTools({ management, userId }) : undefined) })
  // 工具实例跨请求复用，但账号不能闭包固定；每次执行都从已验过的 MCP token 传入 userId。
  const libraryTools = createLibraryTools({ workspaceFiles: guardedFiles, showcaseRoot, showcaseAssetFetch, userId: call => call.userId })

  function serverTool(name) {
    if (name === 'getAppState') return (_args, userId) => {
      const pages = projectConnections(userId)
      const canvasFiles = []
      for (const entry of guardedFiles.list(userId)) {
        try {
          // 与前端canvasFile.ts一致：靠文件头标记，不按画布中文名或JSON后缀猜测。
          if (isCanvasFile(userId, entry)) canvasFiles.push(entry.path)
          if (canvasFiles.length >= 50) break
        } catch (error) {
          if (![400, 404].includes(error?.status) && error?.code !== 'ENOENT') throw error
        }
      }
      return {
        connections: pages.map(connection => ({
          id: connection.id,
          projectId: connection.projectId,
          ready: connectionReady(connection),
          directory: connection.state?.directory ?? null,
          canvasId: connection.state?.canvasId ?? null,
          panel: connection.state?.panel ?? 'canvas',
          busy: Boolean(connection.pending || connection.state?.executingCalls?.length || unconfirmedWork(connection.userId, connection.projectId)), queued: connection.queue.length,
          tools: (Array.isArray(connection.state?.tools) && connection.state.tools.length
            ? connection.state.tools
            : connection.state?.canvasId ? CANVAS_TOOLS : []).map(tool => (tool && typeof tool === 'object' && 'name' in tool ? tool.name : String(tool))),
        })),
        canvasFiles,
        hint: pages.length ? undefined : '现在没有连接的妙图画布：请打开目标画布，在设置中开启 MCP，并保持应用运行。',
      }
    }
    if (name === 'inspectVideo') return async (args, userId, signal) => { signal?.throwIfAborted(); await ensureMediaTools?.(); return createVideoReviewTool({ workspaceFiles: guardedFiles, userId, signal }).execute(args) }
    const media = mediaTools.find(tool => tool.name === name)
    if (media) return async (args, userId, signal) => { signal?.throwIfAborted(); await ensureMediaTools?.(); signal?.throwIfAborted(); return media.execute(args, { userId, signal }) }
    const shared = sharedTools.find(tool => tool.name === name)
    if (shared) return (args, userId, signal) => shared.execute(args, { userId, signal })
    const library = libraryTools.find(tool => tool.name === name)
    if (library) return (args, userId, signal) => library.execute(args, { userId, signal })
    if (name !== 'workspaceFiles') return null
    return (args, userId) => {
      const action = String(args.action || '')
      const rawPath = String(args.path || '')
      const path = action === 'list' && !rawPath ? '' : workspaceFiles.path(rawPath)
      if (path && isProtectedWorkspacePath(path) && ['readText', 'readBinary', 'writeText', 'writeBinary', 'copy', 'rename', 'remove'].includes(action)) {
        throw failure('该文件包含供应商密钥，MCP 不能读取或修改', 403)
      }
      if (action === 'list') {
        const page = workspaceFileTools.list(userId, { pathPrefix: path ? path + '/' : '', limit: args.limit, offset: args.offset })
        return {
          ...page,
          entries: page.entries
            .map(entry => ({ path: entry.path, type: entry.mime === 'inode/directory' ? 'directory' : 'file', size: entry.size, revision: entry.revision })),
        }
      }
      // readText / writeText 与 Agent 的 readWorkspaceFile / writeWorkspaceFile 是同一份实现。
      if (action === 'readText') {
        const result = workspaceFileTools.read(userId, args)
        if (result.encoding !== 'utf8') throw failure('这个文件需要二进制读取，请使用 readBinary', 422)
        return result
      }
      if (action === 'writeText') return workspaceFileTools.write(userId, { path, content: args.content, mime: args.mime })
      if (action === 'readBinary') {
        const file = guardedFiles.locate(userId, path)
        let bytes: Buffer
        try { bytes = readWorkspaceRange(file, { limit: MEDIA_LIMIT_BYTES, maxSize: MEDIA_LIMIT_BYTES }).bytes }
        catch (error) { if (error.status === 413) throw failure('文件超过 20MB，无法通过 MCP 传输', 413); throw error }
        return { path: file.path, mime: file.mime, size: bytes.length, base64: bytes.toString('base64') }
      }
      if (action === 'writeBinary') {
        const encoded = String(args.base64 || '')
        if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw failure('二进制内容须为完整的标准 base64', 422)
        const bytes = Buffer.from(encoded, 'base64')
        if (bytes.toString('base64') !== encoded) throw failure('base64 内容不完整或格式无效', 422)
        if (!bytes.length) throw failure('写入二进制需要 base64 内容', 422)
        if (bytes.length > MEDIA_LIMIT_BYTES) throw failure('文件不能超过 20MB', 413)
        const current = workspaceFiles.list(userId).find(entry => entry.path === path)
        const mime = typeof args.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(args.mime) ? args.mime : 'application/octet-stream'
        guardedFiles.writeBytes(userId, { path, mime, bytes, revision: args.exclusive === false && current ? current.revision : null })
        return { path, bytes: bytes.length }
      }
      if (action === 'mkdir') {
        if (workspaceFiles.list(userId).some(entry => entry.path === path)) throw failure('目标已存在', 409)
        guardedFiles.upsert(userId, path, 'inode/directory', Buffer.alloc(0))
        return { path, created: true }
      }
      if (action === 'copy' || action === 'rename' || action === 'remove') {
        const entries = workspaceFiles.list(userId)
        const current = entries.find(entry => entry.path === path)
        if (action === 'copy') {
          if (!current || current.mime === 'inode/directory') throw failure('copy 只支持单个文件；画布请使用 duplicateCanvas', 422)
          if (isCanvasFile(userId, current)) throw failure('画布副本必须独立，请使用 duplicateCanvas', 409)
        }
        // 目录可以只有后代文件而没有目录行；共用原生树操作判断是否存在。
        // This tool call begins the operation. Preserve its one synchronous
        // inventory through the atomic commit rather than re-reading later.
        const sourceEntries = entries.filter(entry => entry.path === path || entry.path.startsWith(path + '/'))
          .map(({ path, revision }) => ({ path, revision }))
        guardedFiles.mutate(userId, { operation: action, path, target: args.target, revision: current?.revision ?? null, sourceEntries })
        return action === 'remove' ? { path, removed: true } : { path, target: String(args.target || '') }
      }
      throw failure('不支持的文件操作', 422)
    }
  }

  // 浏览器侧控制通道：会话鉴权 + 同源。
  async function handleControl(request, response, session, url, helpers) {
    assertRunning()
    const { json, readJson, sameOrigin } = helpers
    const incoming = incomingRequests.begin(request, response)
    try {
    if (url.pathname !== '/api/mcp/control/settled') assertProjectAccess(session.userId, requestProject())
    if (url.pathname === '/api/mcp/status' && request.method === 'GET') {
      json(response, 200, {
        ok: true,
        enabled: management.mcpTokenInfo(session.userId).enabled ?? management.mcpTokenInfo(session.userId).hasToken,
        connections: projectConnections(session.userId).map(item => ({
          id: item.id,
          ready: connectionReady(item),
          directory: item.state?.directory ?? null,
          canvasId: item.state?.canvasId ?? null, panel: item.state?.panel ?? 'canvas', projectId: item.projectId,
          busy: Boolean(item.pending || item.state?.executingCalls?.length || unconfirmedWork(item.userId, item.projectId)), queued: item.queue.length,
        })),
      })
      return true
    }
    const mutate = () => {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)
    }
    if (url.pathname === '/api/mcp/control/settled' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request, 4096, incoming.signal)
      assertRunning()
      const { viewId, callId, projectId, owner } = payload
      if (![viewId, callId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 64)
        || typeof projectId !== 'string' || !projectId || projectId.length > 256) throw failure('操作完成标识无效', 422)
      const currentOwner = workspaceFiles.referenceOwner?.(session.userId) || management.publicUser?.(session.userId)?.workspaceKey || String(session.userId)
      if (owner !== currentOwner) throw failure('工作区账号已切换，原操作状态未修改', 409)
      try { assertProjectAccess(session.userId, projectId) }
      catch (error) { if (error.status !== 404) throw error; json(response, 200, { ok: true }); return true }
      const scope = workspaceScope(session.userId, projectId), key = JSON.stringify([scope, viewId])
      // Completion can arrive before the stream's close event. Remember it on
      // that connection too, so close cannot resurrect an already settled ID.
      for (const connection of connectionForUser(session.userId)) if (connection.viewKey === key
        && (connection.pending?.callId === callId || connection.state?.executingCalls?.includes(callId))) connection.settledCalls.add(callId)
      const view = disconnectedViews.get(key)
      if (view?.executingCalls.includes(callId)) {
        view.executingCalls = view.executingCalls.filter(id => id !== callId)
        if (!view.executingCalls.length) { view.uncertain = false; expireDisconnectedView(key, view) }
      }
      json(response, 200, { ok: true })
      return true
    }
    if (url.pathname === '/api/mcp/control/events' && request.method === 'GET') {
      if (response.destroyed || response.writableEnded) return true
      // Opening this stream registers a controller; it is not a passive read.
      // Ordinary same-origin fetch GETs can omit Origin, so require the app's
      // non-simple header and validate Origin whenever the browser sends it.
      if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)
      if (request.headers.origin) sameOrigin(request)
      assertProjectAvailable(session.userId, requestProject())
      if (!enabled(session.userId)) throw failure('MCP 已关闭，请在设置中开启', 403)
      const connectionId = String(url.searchParams.get('connectionId') || '').slice(0, 64)
      if (!connectionId) throw failure('缺少连接标识', 422)
      const connectionKey = `${session.userId}:${requestProject()}:${connectionId}`
      if (connections.has(connectionKey)) throw failure('控制连接已存在，请使用新的连接标识', 409)
      const scope = workspaceScope(session.userId)
      const viewId = String(url.searchParams.get('viewId') || connectionId).slice(0, 64)
      const documentId = String(request.headers['x-miaoimg-document'] || '')
      if (documentId.length > 64) throw failure('页面标识无效', 422)
      const viewKey = JSON.stringify([scope, viewId])
      if ([...connections.values()].some(item => item.viewKey === viewKey)) throw failure('页面控制连接已存在，请等待原连接关闭', 409)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      const connection = { id: connectionId, viewKey, scope, documentId, userId: session.userId, projectId: requestProject(), response, revision: 0, state: null, pending: undefined, timer: undefined, queue: [], closed: false, idleWaiters: new Set<any>(), settledCalls: new Set<string>() }
      connections.set(connectionKey, connection)
      writeEvent(response, { type: 'ready' })
      connection.timer = setInterval(() => { if (!response.writableEnded) response.write(': keepalive\n\n') }, 20_000)
      const close = () => closeConnection(connection)
      response.once('close', close)
      // IncomingMessage.close also fires when the GET request has finished being
      // read. The SSE response remains open; only its close ends this connection.
      return true
    }
    if (url.pathname === '/api/mcp/control/state' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request, undefined, incoming.signal)
      assertRunning()
      assertProjectAccess(session.userId, requestProject())
      const connection = connections.get(`${session.userId}:${requestProject()}:${String(payload.connectionId || '')}`)
      if (!enabled(session.userId)) throw failure('MCP 已关闭，请在设置中开启', 403)
      if (!connection || connection.userId !== session.userId) throw failure('控制连接不存在', 404)
      if (connection.projectId !== requestProject()) throw failure('控制连接所属项目已切换，请重新连接', 409)
      updateConnectionState(connection, payload)
      json(response, 200, { ok: true })
      return true
    }
    if (url.pathname === '/api/mcp/control/result' && request.method === 'POST') {
      mutate()
      const payload = await readJson(request, undefined, incoming.signal)
      assertRunning()
      assertProjectAccess(session.userId, requestProject())
      const connection = connections.get(`${session.userId}:${requestProject()}:${String(payload.connectionId || '')}`)
      if (!enabled(session.userId)) throw failure('MCP 已关闭，请在设置中开启', 403)
      if (!connection || connection.userId !== session.userId) throw failure('控制连接不存在', 404)
      if (connection.projectId !== requestProject()) throw failure('控制连接所属项目已切换，请重新连接', 409)
      if (connection.pending?.callId !== payload.callId) throw failure('控制命令已取消或不存在', 404)
      // Publish the operation's retained paths before releasing its caller or
      // dispatching another operation. Separate watcher posts can arrive late.
      if (payload.state !== undefined || payload.revision !== undefined) updateConnectionState(connection, payload)
      connection.pending.finish(payload)
      json(response, 200, { ok: true })
      return true
    }
    throw failure('MCP 控制接口不存在', 404)
    } catch (error) {
      if (!incoming.signal.aborted) throw error
      if (!response.destroyed && !response.writableEnded) json(response, 503, { error: 'MCP 服务已停止' })
      return true
    } finally { incoming.finish() }
  }

  // The official SDK owns both current per-request MCP and legacy initialize,
  // JSON-RPC validation, JSON Schema validation, streaming and discovery.
  const definitions = MCP_TOOLS.map(tool => ({ ...tool, schema: fromJsonSchema(tool.parameters) }))
  const sdkHandler = createMcpHandler(({ authInfo, requestInfo }: Record<string, any>) => {
    const assertAuthorized = authInfo.extra.assertAuthorized
    assertAuthorized()
    const userId = authInfo.clientId
    // Resolve host capabilities per authenticated request and again at execution,
    // so a desktop permission revocation cannot leave a callable cached tool.
    const hostTools = additionalTools?.(userId, { catalogOnly: true }) || []
    const names = new Set(definitions.map(tool => tool.name))
    const hostDefinitions = hostTools.map(tool => {
      if (names.has(tool.name)) throw new Error(`重复的 MCP 工具：${tool.name}`)
      names.add(tool.name)
      return { ...tool, description: tool.description.replaceAll('本次对话所属', 'MCP 配置所属'), schema: fromJsonSchema(tool.parameters) }
    })
    const hostNames = new Set(hostDefinitions.map(tool => tool.name))
    const server = new McpServer({ name: 'miaoimg-canvas', version: '1.1.0' }, { instructions: '妙图画布工具。先 getAppState 确认项目与连接，再 getCanvas 读取真实节点类型。节点能力先 getNodeTools 再 nodeTools；文件用 workspaceFiles，视频画面用 inspectVideo。连接中断或取消调用不会撤销已经保存的操作；结果待确认时先回读画布、节点或任务状态，不直接重复执行。只有用户明确要求时才执行模型生成。' })
    for (const tool of [...definitions, ...hostDefinitions]) server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args, context) => {
      const controller = new AbortController()
      const completed = Promise.withResolvers<void>()
      const signal = AbortSignal.any([controller.signal, context.mcpReq.signal, requestInfo.signal])
      const pending = { userId, projectId: requestProject(), controller, done: completed.promise }
      activeCalls.add(pending)
      try {
        signal.throwIfAborted()
        assertAuthorized()
        const handler = serverTool(tool.name)
        const hostTool = hostNames.has(tool.name) ? additionalTools?.(userId, { signal })?.find(entry => entry.name === tool.name) : null
        if (hostNames.has(tool.name) && !hostTool) throw failure('本机操作尚未开启或授权已撤销，请在设置中开启后重试', 403)
        let result = await fileGuard.run(() => hostTool ? hostTool.execute(args, { signal, toolCallId: String(context.mcpReq.id) })
          : handler ? handler(args, userId, signal) : callCanvas(userId, tool.name, args, signal))
        signal.throwIfAborted()
        assertAuthorized()
        if (tool.name === 'inspectDocument' || (tool.name === 'nodeTools' && args.name === 'node:inspectScene')) result = directorPreviewContent(result)
        return toolResult(result)
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : '工具执行失败' }], isError: true }
      } finally { activeCalls.delete(pending); completed.resolve() }
    })
    return server
  }, { legacy: 'stateless', responseMode: 'sse', maxRequestBodySize: MCP_BODY_BYTES })

  async function handleMcp(request, response, url, helpers) {
    if (url.pathname !== '/mcp') return false
    const rejectAccess = error => {
      if (response.destroyed || response.writableEnded) return
      const status = error.status || 401
      response.writeHead(status, { 'content-type': 'application/json', ...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}) })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: error.message } }))
    }
    let userId
    try {
      assertRunning()
      if (request.headers.origin) helpers.sameOrigin(request)
      userId = authorize(request)
      assertProjectAvailable(userId, requestProject())
    } catch (error) {
      rejectAccess(error)
      return true
    }
    // Track admission before reading the body. Revocation remains final for this
    // request even when the same account/token is enabled again while it waits.
    const incoming = incomingRequests.begin(request, response)
    const access: RequestAccess = { userId, projectId: requestProject(), abort: incoming.abort }
    activeRequests.add(access)
    const assertAuthorized = () => {
      assertRunning()
      if (access.revoked) throw access.revoked
      if (authorize(request) !== userId) throw failure('MCP 授权已关闭或更新，请重新连接', 401)
      assertProjectAvailable(userId, access.projectId)
    }
    try {
      let payload
      if (request.method === 'POST') {
        try { payload = await readJsonRequest(request, { maxBytes: MCP_BODY_BYTES, objectOnly: false, signal: incoming.signal }) }
        catch (error) {
          if (incoming.signal.aborted) rejectAccess(incoming.signal.reason)
          else if (!response.destroyed && !response.writableEnded) helpers.json(response, error.status || 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error.status === 413 ? 'MCP 请求过大' : 'Parse error' } })
          return true
        }
      }
      try { assertAuthorized() } catch (error) { rejectAccess(error); return true }
      // The SDK owns protocol cancellation. Stateless HTTP request IDs cannot
      // identify another exchange, even when only one matching call is active.
      const handler = toNodeHandler({ fetch: (req, options) => sdkHandler.fetch(req, { ...options, authInfo: { clientId: userId, token: '', scopes: [], extra: { assertAuthorized } } }) }, { maxRequestBodySize: MCP_BODY_BYTES })
      await handler(request, response, payload)
    } finally { activeRequests.delete(access); incoming.finish() }
    return true
  }

  function disconnectUser(userId) {
    for (const request of activeRequests) if (request.userId === userId) {
      request.revoked ??= failure('MCP 授权已关闭或更新，请重新连接', 401)
      request.abort(request.revoked)
    }
    for (const call of activeCalls) if (call.userId === userId) call.controller.abort(new Error('MCP 授权已关闭或更新，请重新连接'))
    for (const connection of connectionForUser(userId)) closeConnection(connection, 'MCP 授权已关闭或更新，请重新连接')
  }
  async function withProjectRemoval(userId, projectId, remove) {
    assertProjectAvailable(userId, projectId)
    const assertNoDetachedWork = () => {
      if (unconfirmedWork(userId, projectId) || connectionForUser(userId).some(page => page.scope === workspaceScope(userId, projectId)
        && page.state?.executingCalls?.some(id => id !== page.pending?.callId))) {
        throw failure('项目仍有断线前的操作待确认，项目未删除；请等待原页面操作结束并重新连接后再试', 409)
      }
    }
    assertNoDetachedWork()
    const key = projectKey(userId, projectId)
    removingProjects.add(key)
    const calls = [...activeCalls].filter(call => call.userId === userId && call.projectId === projectId)
    const pages = connectionForUser(userId).filter(page => page.scope === workspaceScope(userId, projectId))
    const waiters = pages.filter(page => page.pending).map(page => {
      const waiter = Promise.withResolvers<void>()
      page.idleWaiters.add(waiter)
      return { page, waiter }
    })
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      for (const request of activeRequests) if (request.userId === userId && request.projectId === projectId) {
        request.revoked ??= failure('项目正在删除，本次调用已取消，请重新发起', 409)
        request.abort(request.revoked)
      }
      for (const call of calls) call.controller.abort(new Error('项目正在删除，操作已取消'))
      // A canvas call can reject before the page has finished its late save.
      // Keep the result channel open until that page acknowledges completion.
      await Promise.race([
        Promise.all([...calls.map(call => call.done), ...waiters.map(({ waiter }) => waiter.promise)]),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(failure('项目操作尚未停止，项目未删除，请稍后重试', 409)), 30_000) }),
      ])
      clearTimeout(timeout)
      timeout = undefined
      assertProjectAccess(userId, projectId)
      assertNoDetachedWork()
      for (const page of pages) closeConnection(page, '项目正在删除，画布连接已关闭')
      const result = await remove()
      const scope = workspaceScope(userId, projectId)
      for (const [key, view] of disconnectedViews) if (view.scope === scope) forgetDisconnectedView(key)
      return result
    } finally {
      clearTimeout(timeout)
      for (const { page, waiter } of waiters) page.idleWaiters.delete(waiter)
      removingProjects.delete(key)
    }
  }
  // Native lifecycle only: a committed navigation/crash fences the old epoch;
  // its HTTP handlers must drain before the host calls finishDocument.
  function retireDocument(documentId) {
    for (const connection of [...connections.values()]) if (documentId && connection.documentId === documentId) closeConnection(connection, '工作区页面已更新')
  }
  function finishDocument(documentId) {
    for (const [key, view] of disconnectedViews) if (documentId && view.documentId === documentId) forgetDisconnectedView(key)
  }
  function stop() {
    if (stopped) return stopped
    stopping = true
    const completion = Promise.withResolvers<void>()
    stopped = completion.promise
    void (async () => {
      const calls = [...activeCalls]
      for (const request of activeRequests) {
        request.revoked ??= failure('MCP 服务已停止', 503)
        request.abort(request.revoked)
      }
      for (const connection of [...connections.values()]) closeConnection(connection, 'MCP 服务已停止')
      for (const key of disconnectedViews.keys()) forgetDisconnectedView(key)
      for (const call of calls) call.controller.abort(new Error('MCP 服务已停止'))
      // SDK transport closure aborts the protocol wait; tool cleanup may finish
      // later. Join those accepted operations before the host closes its store.
      const results = await Promise.allSettled([incomingRequests.stop(), sdkHandler.close(), ...calls.map(call => call.done)])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    })().then(completion.resolve, completion.reject)
    return stopped
  }
  return { handleControl, handleMcp, disconnectUser, withProjectRemoval, retireDocument, finishDocument, stop }
}
