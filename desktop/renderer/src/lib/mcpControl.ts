import { onScopeDispose, shallowReactive, shallowRef, watch } from 'vue'
import { captureWorkspaceScope, assertWorkspaceScope, workspaceHeaders } from './workspaceRemote'
import { parseMcpAccess } from './mcpAccess'
import { assertCanvasControlTarget, type CanvasControlTarget } from '../../../../server/canvas-control-target.ts'

export type ControlCall = { type: 'call'; callId: string; name: string; args: Record<string, unknown> } & CanvasControlTarget
export type WorkspaceControl = {
  getState(): { directory: string | null; canvasId: string | null; panel: string; tools: unknown[]; document?: unknown; retainedPaths?: string[] }
  call(request: ControlCall, signal: AbortSignal): Promise<unknown>
  agentCanvas?(canvasId: string, signal: AbortSignal): Promise<import("@miaoimg/tool-canvas/runtime").CanvasContext>
  flushSave(): Promise<void>
}

const workspaceControl = shallowRef<WorkspaceControl>()
export const mcpConnectionRevision = shallowRef(0)

type SettledCall = { owner: string; projectId: string; viewId: string; callId: string }
const pendingSettlements = new Map<string, SettledCall>()
let sendingSettlements = false
async function flushSettlements() {
  if (sendingSettlements) return
  sendingSettlements = true
  try {
    for (const [key, item] of pendingSettlements) {
      if (captureWorkspaceScope().owner !== item.owner) continue
      try {
        const response = await fetch('/api/mcp/control/settled', {
          method: 'POST', headers: { ...workspaceHeaders(item.owner), 'x-miaoimg-workspace': '1' },
          body: JSON.stringify(item), signal: AbortSignal.timeout(10_000),
        })
        if (response.status === 404) { await response.body?.cancel(); pendingSettlements.delete(key); continue }
        if (!response.ok) { await response.body?.cancel(); continue }
        if ((await response.json())?.ok === true) pendingSettlements.delete(key)
      } catch { /* Retain only completion metadata for the next connection. */ }
    }
  } finally { sendingSettlements = false }
}
function acknowledgeSettledCall(item: SettledCall) {
  pendingSettlements.set(JSON.stringify([item.owner, item.projectId, item.viewId, item.callId]), item)
  void flushSettlements()
}

// 画布向工作台注册控制面（供快捷键、Agent 与外部控制复用同一份状态）。
export function registerWorkspaceControl(control: WorkspaceControl) {
  workspaceControl.value = control
  onScopeDispose(() => { if (workspaceControl.value === control) workspaceControl.value = undefined })
}

export function readWorkspaceControl() {
  return workspaceControl.value
}

export async function waitForControlValue<T>(read: () => T | undefined, signal?: AbortSignal, timeout = 120000): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    signal?.throwIfAborted()
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
  throw new Error('画布初始化超时')
}

// ── MCP 控制通道（MiaoImg 同款协议，妙图改成托管 HTTPS 端点） ──────────────
import { settings, mcpSettings, updateMcpSettings } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'

export function useMcpControl() {
  const binding = captureWorkspaceScope()
  void flushSettlements()
  // Keep the page identity across transport reconnects, but use a fresh
  // connection ID/revision epoch so late posts cannot enter the new stream.
  const viewId = crypto.randomUUID()
  const setupLifetime = new AbortController()
  onScopeDispose(() => setupLifetime.abort())
  async function refreshAccess(signal: AbortSignal) {
    // MCP updates replace this object. Other preferences may change without
    // invalidating the read; a newer MCP update must always win over it.
    const previous = settings.value.mcp
    const response = await fetch('/api/imagine/mcp', { signal })
    let enabled: boolean
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {})
      enabled = false
    } else {
      if (!response.ok) { await response.body?.cancel().catch(() => {}); return }
      const access = parseMcpAccess(await response.json())
      if (!access) throw new Error('MCP 状态响应无效')
      enabled = access.enabled
    }
    signal.throwIfAborted()
    assertWorkspaceScope(binding)
    if (settings.value.mcp !== previous) return
    updateMcpSettings({ enabled })
  }
  void refreshAccess(setupLifetime.signal).catch(() => {})
  const workspaceStore = useWorkspaceStore()
  const calls = new Map<string, AbortController>()
  // Aborting a transport/controller does not mean an accepted save has ended.
  // Keep execution identity until the business promise actually settles.
  const executingCalls = shallowReactive(new Set<string>())

  const getState = () => {
    const control = workspaceControl.value
    const state = control?.getState()
    return {
      directory: state?.directory ?? workspaceStore.project?.directory ?? null,
      canvasId: state?.canvasId ?? null,
      panel: state?.panel ?? 'canvas',
      tools: state?.tools ?? [],
      document: state?.document,
      retainedPaths: state?.retainedPaths,
      executingCalls: [...executingCalls],
    }
  }

  watch(() => mcpSettings.value.enabled, (enabled, _previous, onCleanup) => {
    if (!enabled) return
    const lifetime = new AbortController()
    let reconnect: ReturnType<typeof setTimeout> | undefined
    onCleanup(() => {
      lifetime.abort()
      clearTimeout(reconnect)
      for (const controller of calls.values()) controller.abort(new Error('MCP 连接已关闭'))
      calls.clear()
    })

    async function refreshAuthorization(response: Response) {
      if (![401, 403].includes(response.status) || lifetime.signal.aborted) return
      await refreshAccess(lifetime.signal)
    }

    async function connect() {
      if (lifetime.signal.aborted || !mcpSettings.value.enabled) return
      void flushSettlements()
      const connectionId = crypto.randomUUID()
      const connection = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, connection.signal])
      const headers = { 'x-miaoimg-workspace': '1' }
      const connectionCalls = new Map<string, AbortController>()
      let revision = 0
      let announced = false
      async function post(path: 'state' | 'result', body: object, callSignal?: AbortSignal) {
        assertWorkspaceScope(binding)
        const response = await fetch(`/api/mcp/control/${path}`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ connectionId, revision: ++revision, ...body, ...(path === 'result' ? { state: getState() } : {}) }),
          signal,
        })
        if (path === 'result' && response.status === 404 && callSignal?.aborted) return false
        if (!response.ok) { await refreshAuthorization(response); throw new Error(`MCP ${path} 请求失败（${response.status}）`) }
        const acknowledgement = await response.json()
        signal.throwIfAborted()
        assertWorkspaceScope(binding)
        if (!acknowledgement || acknowledgement.ok !== true) throw new Error(`MCP ${path} 响应无效`)
        return true
      }
      async function execute(request: ControlCall) {
        const controller = new AbortController()
        calls.set(request.callId, controller)
        connectionCalls.set(request.callId, controller)
        const callSignal = AbortSignal.any([signal, controller.signal])
        executingCalls.add(request.callId)
        let result: unknown
        let error: string | undefined
        try {
          assertWorkspaceScope(binding)
          const control = workspaceControl.value
          if (!control) throw new Error('请先打开工作区')
          assertCanvasControlTarget(request, control.getState())
          result = await control.call(request, callSignal)
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason)
        } finally {
          executingCalls.delete(request.callId)
        }
        let reported = false
        try {
          if (!signal.aborted) {
            reported = await post('result', { callId: request.callId, ...(error ? { error } : { result: result ?? null }) }, callSignal)
          }
        } finally {
          calls.delete(request.callId)
          connectionCalls.delete(request.callId)
          // Only the settled business promise reaches here. This acknowledgement
          // outlives a disposed component/transport; it never replays the call.
          if (!reported) acknowledgeSettledCall({ owner: binding.owner, projectId: binding.project, viewId, callId: request.callId })
        }
      }
      try {
        assertWorkspaceScope(binding)
        const response = await fetch(`/api/mcp/control/events?connectionId=${encodeURIComponent(connectionId)}&viewId=${encodeURIComponent(viewId)}`, { headers, signal })
        if (!response.ok || !response.body) { await refreshAuthorization(response); throw new Error(`MCP 连接失败（${response.status}）`) }
        const stopState = watch(() => JSON.stringify(getState()), state => {
          void post('state', { state: JSON.parse(state) }).then(() => { if (!announced && !signal.aborted) { announced = true; mcpConnectionRevision.value++ } }).catch(error => { if (!signal.aborted) connection.abort(error) })
        }, { immediate: true, flush: 'post' })
        try {
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          let pending = ''
          let data: string[] = []
          while (true) {
            const { value, done } = await reader.read()
            signal.throwIfAborted()
            if (done) break
            pending += value
            const lines = pending.split('\n')
            pending = lines.pop() ?? ''
            for (const rawLine of lines) {
              const line = rawLine.replace(/\r$/, '')
              if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
              if (line || !data.length) continue
              const event = JSON.parse(data.join('\n')) as ControlCall | { type: 'cancel'; callId: string }
              data = []
              if (event.type === 'cancel') calls.get(event.callId)?.abort(new Error('MCP 调用已取消'))
              else if (event.type === 'call') void execute(event).catch(error => { if (!signal.aborted) connection.abort(error) })
            }
          }
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        } finally { stopState() }
      } catch (error) {
        if (!signal.aborted) console.warn('MCP 控制连接已中断', error)
      } finally {
        connection.abort()
        for (const controller of connectionCalls.values()) controller.abort(new Error('MCP 连接已关闭'))
        for (const id of connectionCalls.keys()) calls.delete(id)
        connectionCalls.clear()
        if (announced) mcpConnectionRevision.value++
        if (!lifetime.signal.aborted && mcpSettings.value.enabled) reconnect = setTimeout(() => void connect(), 3000)
      }
    }
    void connect()
  }, { immediate: true })
}
