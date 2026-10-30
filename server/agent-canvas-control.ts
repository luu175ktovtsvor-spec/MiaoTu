import { randomUUID } from 'node:crypto'
import { isWorkspacePath } from './workspace-path.ts'
import { toolWorkspaceFiles, toolWorkspaceStatePaths } from './tool-workspace-files.ts'

// Internal workspace transport. Independent of external MCP credentials and chat
// observers. A delivered mutation whose acknowledgement is lost is never replayed.
export function createAgentCanvasControl({ workspaceFiles }: Record<string, any> = {}) {
  const channels = new Map(), calls = new Map()
  const views = new Map(), retiringDocuments = new Set<string>()
  const viewKey = (key, viewId) => JSON.stringify([key, viewId])
  const fileViews = (userId, project, owner) => [...channels.values(), ...views.values()].filter(view => !view.viewRetired && view.scope?.userId === userId
      && view.scope.project === project && view.scope.owner === owner).map(view => ({
        paths: view.paths || toolWorkspaceStatePaths(view.state),
        uncertain: view.uncertain ?? (!view.state || view.state.ready !== true),
        busy: Boolean(view.state?.executingCalls?.length || (view.id && [...calls.values()]
          .some(call => call.key === view.key && call.connectionId === view.id))),
      }))
  const removeViews = workspaceFiles ? toolWorkspaceFiles(workspaceFiles).addViews(async (userId, project) =>
    fileViews(userId, project, (await workspaceFiles.referenceOwner?.(userId)) || String(userId))) : () => {}
  function disconnect(key, reason = new Error('画布连接已断开；已下发操作的结果待确认，请先读取画布状态'), generation?: number) {
    const channel = channels.get(key)
    if (!channel || generation !== undefined && channel.scope?.generation !== generation) return
    if (channel.scope && !channel.viewRetired) {
      const previous = views.get(viewKey(key, channel.scope.viewId))
      const executingCalls = [...new Set([...(previous?.executingCalls || []), ...(channel.state?.executingCalls || []),
        ...[...calls.values()].filter(call => call.key === key && call.connectionId === channel.id).map(call => call.id)])]
      views.set(viewKey(key, channel.scope.viewId), { key, scope: channel.scope,
        paths: [...new Set([...(previous?.paths || []), ...toolWorkspaceStatePaths(channel.state)])],
        executingCalls, uncertain: true })
    }
    channels.delete(key)
    clearInterval(channel.heartbeat)
    for (const call of [...calls.values()]) if (call.key === key && call.connectionId === channel.id) call.abandon(reason)
    channel.response.end()
  }
  function deliver(call) {
    const channel = channels.get(call.key)
    if (!channel || call.connectionId || channel.response.destroyed || call.generation !== channel.scope?.generation) return
    call.connectionId = channel.id
    channel.response.write(`${JSON.stringify({ type: 'call', callId: call.id, name: call.name, args: call.args, canvasId: call.canvasId, file: call.file })}\n`)
  }
  return {
    fileViews,
    connect(key, response, scope?: Record<string, any>) {
      // Realm initialization may outlive the browser request. A dead late
      // connection must not replace the current executor or reject its calls.
      if (response.destroyed || response.writableEnded) return
      disconnect(key)
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      response.flushHeaders()
      const id = scope?.connectionId || randomUUID(), heartbeat = setInterval(() => { if (!response.destroyed) response.write('{"type":"heartbeat"}\n') }, 15000)
      heartbeat.unref()
      channels.set(key, { key, id, response, heartbeat, scope, state: undefined, revision: 0 })
      response.once('close', () => { if (channels.get(key)?.id === id) disconnect(key) })
      for (const call of calls.values()) if (call.key === key) deliver(call)
    },
    updateState(key, payload, generation?: number) {
      const channel = channels.get(key)
      if (!channel || channel.id !== payload.connectionId || channel.scope?.viewId !== payload.viewId
        || generation !== undefined && channel.scope?.generation !== generation
        || channel.viewRetired || retiringDocuments.has(channel.scope?.documentId)) throw Object.assign(new Error('画布连接已更新，请重新连接'), { status: 409 })
      const state = payload.state
      if (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !state || typeof state !== 'object' || Array.isArray(state)
        || typeof state.ready !== 'boolean' || !Array.isArray(state.executingCalls)
        || !state.executingCalls.every(id => typeof id === 'string' && id.length > 0)
        || state.retainedPaths !== undefined && (!Array.isArray(state.retainedPaths) || !state.retainedPaths.every(isWorkspacePath))) {
        throw Object.assign(new Error('画布状态格式无效'), { status: 422 })
      }
      if (payload.revision <= channel.revision) return
      channel.revision = payload.revision
      channel.state = state
      const previous = views.get(viewKey(key, channel.scope.viewId))
      if (previous && state.ready && !previous.executingCalls.some(id => state.executingCalls.includes(id))) views.delete(viewKey(key, channel.scope.viewId))
    },
    call(key, { name, args, metadata, signal, progress, generation }: Record<string, any>) {
      signal.throwIfAborted()
      return new Promise<any>((resolve, reject) => {
        const id = randomUUID()
        let settled = false
        const settle = (operation, value) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', abort)
          operation(value)
        }
        const finish = (operation, value) => { calls.delete(id); settle(operation, value) }
        const abort = () => {
          const channel = channels.get(key)
          if (channel && call.connectionId === channel.id) channel.response.write(`${JSON.stringify({ type: 'cancel', callId: id })}\n`)
          // Ending the caller's wait does not prove that an accepted browser
          // save has finished. Its delivered identity remains busy until a
          // result, or moves into the detached view on transport loss.
          if (!call.connectionId) calls.delete(id)
          settle(reject, signal.reason || new Error('画布操作已停止'))
        }
        const call: Record<string, any> = { id, key, name, args, generation, canvasId: metadata.canvasId, file: metadata.file,
          resolve: value => finish(resolve, value), reject: error => finish(reject, error), abandon: error => finish(reject, error) }
        calls.set(id, call)
        signal.addEventListener('abort', abort, { once: true })
        if (!channels.has(key) || channels.get(key).scope?.generation !== generation) void Promise.resolve(progress?.({ publicSummary: '等待所属项目的画布连接；打开该项目后继续。' })).catch(() => {})
        deliver(call)
      })
    },
    result(key, payload, generation?: number) {
      // Publish the post-operation editor state before releasing its caller.
      if (payload.state !== undefined) this.updateState(key, payload, generation)
      const call = calls.get(String(payload.callId || ''))
      if (!call || call.key !== key) throw Object.assign(new Error('画布调用不存在或已结束'), { status: 404 })
      if (generation !== undefined && (call.generation !== generation || call.connectionId !== payload.connectionId)) throw Object.assign(new Error('画布连接已更新，请重新连接'), { status: 409 })
      if (payload.error) call.reject(new Error(String(payload.error).slice(0, 8000)))
      else call.resolve({ result: payload.result ?? null, canvasId: typeof payload.canvasId === 'string' ? payload.canvasId : undefined })
    },
    disconnect,
    retireDocument(documentId) { if (documentId) retiringDocuments.add(documentId) },
    finishDocument(documentId) {
      if (!documentId) return
      for (const [key, view] of views) if (view.scope?.documentId === documentId) views.delete(key)
      for (const channel of channels.values()) if (channel.scope?.documentId === documentId) channel.viewRetired = true
      retiringDocuments.delete(documentId)
    },
    close() { for (const key of [...channels.keys()]) disconnect(key, new Error('应用执行器已关闭')); for (const call of [...calls.values()]) call.abandon(new Error('应用执行器已关闭')) },
    releaseFileViews() { views.clear(); retiringDocuments.clear(); removeViews() },
  }
}
