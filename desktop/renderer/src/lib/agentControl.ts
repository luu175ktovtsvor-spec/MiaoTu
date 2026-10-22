import { onScopeDispose, shallowReactive, watch } from 'vue'
import { assertWorkspaceScope, captureWorkspaceScope, workspaceDirectory } from './workspaceRemote'
import { readWorkspaceControl, waitForControlValue } from './mcpControl'
import type { CanvasContext } from '@miaoimg/tool-canvas/runtime'
import { PANEL_TOOLS } from '../../../../server/canvas-tools'

// Keep one page identity across project/component reconnects. Execution IDs
// survive a component's disposal until its actual canvas save has settled.
const viewId = crypto.randomUUID()
const workspaceExecutions = new Map<string, Set<string>>()

// Workspace lifetime, not conversation lifetime. Disabled external MCP does not
// disable the internal canvas tools. A task keeps one canvas per run, while a
// new user message may deliberately follow the currently active canvas.
export function useAgentCanvasControl() {
  if (!(window as any).miaoDesktop) return
  const binding = captureWorkspaceScope(), lifetime = new AbortController()
  const contexts = new Map<string, { canvasId: string; promise: Promise<CanvasContext> }>(), calls = new Map<string, AbortController>()
  const executions = new Map<string, Promise<void>>()
  const scopeKey = JSON.stringify([binding.owner, binding.project])
  if (!workspaceExecutions.has(scopeKey)) workspaceExecutions.set(scopeKey, shallowReactive(new Set<string>()))
  const executingCalls = workspaceExecutions.get(scopeKey)!
  onScopeDispose(() => { lifetime.abort(); for (const call of calls.values()) call.abort(); contexts.clear() })
  let reconnect: ReturnType<typeof setTimeout> | undefined
  onScopeDispose(() => clearTimeout(reconnect))
  async function serial(file: string, operation: () => Promise<void>) {
    const pending = (executions.get(file) || Promise.resolve()).then(operation)
    const settled = pending.then(() => {}, () => {})
    executions.set(file, settled)
    try { await pending } finally { if (executions.get(file) === settled) executions.delete(file) }
  }
  async function connect() {
    const connection = new AbortController(), signal = AbortSignal.any([lifetime.signal, connection.signal])
    const connectionId = crypto.randomUUID()
    let revision = 0, stopWatching: (() => void) | undefined
    const getState = () => {
      const control = readWorkspaceControl(), state = control?.getState()
      const ready = state?.directory === workspaceDirectory(binding.owner, binding.project)
      return { ready, canvasId: ready ? state?.canvasId ?? null : null, document: ready ? state?.document : undefined,
        retainedPaths: ready ? state?.retainedPaths : undefined, executingCalls: [...executingCalls] }
    }
    async function postState() {
      assertWorkspaceScope(binding)
      const response = await fetch('/api/agent/control/state', { method: 'POST', headers: { 'content-type': 'application/json', 'x-miaoimg-workspace': '1' },
        body: JSON.stringify({ connectionId, viewId, revision: ++revision, state: getState() }), signal })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`画布状态同步失败（${response.status}）`)
    }
    async function execute(request: { callId: string; file: string; canvasId: string; name: string; args: Record<string, unknown> }) {
      const controller = new AbortController()
      calls.set(request.callId, controller)
      const callSignal = AbortSignal.any([signal, controller.signal])
      return serial(request.file, async () => {
        let result: unknown, error: string | undefined, canvasId = request.canvasId
        executingCalls.add(request.callId)
        try {
          assertWorkspaceScope(binding)
          const control = await waitForControlValue(readWorkspaceControl, callSignal)
          callSignal.throwIfAborted()
          assertWorkspaceScope(binding)
          if (PANEL_TOOLS.some(tool => tool.name === request.name)) {
            // Document and panel tools belong to the workspace. A deleted or
            // renamed conversation canvas must not block unrelated documents,
            // or silently move this conversation to the foreground canvas.
            result = await control.call({ type: 'call', callId: request.callId, name: request.name, args: request.args }, callSignal)
          } else {
            const switching = request.name === 'switchCanvas'
            if (switching && (typeof request.args.canvasId !== 'string' || !request.args.canvasId.trim())) throw new Error('请选择要切换的画布')
            const requestingCanvasId = switching ? request.args.canvasId as string : request.canvasId
            // Resolve an explicit switch through the workspace host. The previous
            // canvas may already have been deleted and its component unmounted.
            const cached = contexts.get(request.file)
            if (cached && cached.canvasId !== request.canvasId) contexts.delete(request.file)
            let pendingContext = switching
              ? control.agentCanvas?.(request.args.canvasId as string, callSignal)
              : contexts.get(request.file)?.promise
            if (!pendingContext) {
              if (!control.agentCanvas) throw new Error('画布控制尚未就绪')
              // Calls for this run share one binding. A cancelled or failed
              // initialization is discarded before the next call starts.
              pendingContext = control.agentCanvas(requestingCanvasId, callSignal)
              const entry = { canvasId: requestingCanvasId, promise: pendingContext }
              contexts.set(request.file, entry)
              void pendingContext.catch(() => { if (contexts.get(request.file) === entry) contexts.delete(request.file) })
            }
            const context = await pendingContext
            callSignal.throwIfAborted()
            result = await context.call({ name: request.name, args: request.args } as Parameters<CanvasContext['call']>[0], callSignal)
            canvasId = context.id
            if (switching || cached?.canvasId !== context.id) contexts.set(request.file, { canvasId: context.id, promise: Promise.resolve(context) })
          }
          callSignal.throwIfAborted()
        } catch (reason) { error = reason instanceof Error ? reason.message : String(reason) }
        finally { executingCalls.delete(request.callId) }
        try {
          assertWorkspaceScope(binding)
          if (signal.aborted) return
          const response = await fetch('/api/agent/control/result', { method: 'POST', headers: { 'content-type': 'application/json', 'x-miaoimg-workspace': '1' }, body: JSON.stringify({ callId: request.callId, canvasId, connectionId, viewId, revision: ++revision, state: getState(), ...(error ? { error } : { result: result ?? null }) }), signal })
          if (!response.ok && response.status !== 404) throw new Error(`画布回执失败（${response.status}）`)
        } finally { calls.delete(request.callId) }
      })
    }
    try {
      assertWorkspaceScope(binding)
      const response = await fetch(`/api/agent/control/events?connectionId=${encodeURIComponent(connectionId)}&viewId=${encodeURIComponent(viewId)}`, { headers: { 'x-miaoimg-workspace': '1' }, signal })
      if (!response.ok || !response.body) throw new Error(`画布连接失败（${response.status}）`)
      stopWatching = watch(getState, () => { void postState().catch(error => { if (!signal.aborted) connection.abort(error) }) }, { deep: true, immediate: true })
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      try {
        let pending = ''
        while (true) {
          const { value, done } = await reader.read(); if (done) break
          signal.throwIfAborted(); pending += value
          const lines = pending.split('\n'); pending = lines.pop() || ''
          for (const line of lines) if (line.trim()) {
            const event = JSON.parse(line)
            if (event.type === 'cancel') calls.get(event.callId)?.abort(new Error('画布操作已停止'))
            else if (event.type === 'call' && !calls.has(event.callId)) void execute(event).catch(error => { if (!signal.aborted) connection.abort(error) })
          }
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    } catch (error) { if (!signal.aborted) console.warn('Agent 画布连接正在恢复', error) }
    finally {
      stopWatching?.()
      connection.abort()
      if (!lifetime.signal.aborted) reconnect = setTimeout(() => void connect(), 1500)
    }
  }
  void connect()
}
