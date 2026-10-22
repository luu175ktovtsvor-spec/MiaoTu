import { isWorkspaceRequest } from './canvas-document.ts'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { convertToLlm, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { awaitWithContext, BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context'
import { diffRevisions } from '@earendil-works/chord/delta'
import { AgentDoc, LiveDoc, configure } from '@earendil-works/pi-durable'
import { DurableAgentRuntime, AgentMetadata } from './agent-durable-runtime.ts'
import { projectAgentView } from './agent-durable-view.ts'
import { readAgentActivity } from './agent-subagents.ts'
import { createAgentArchive, agentArchiveHash } from './agent-archive.ts'
import { createAgentCanvasControl } from './agent-canvas-control.ts'
import { withWorkspaceProject, currentProject } from './workspace-scope.ts'
import { runWithLocale, resolveRequestLocale } from './i18n.ts'
import { createAgentModel, isSafeAgentSessionFile, AGENT_TOOL_USAGE } from './agent-runtime.ts'
import { VIDEO_REVIEW_CONTENT } from './video-review.ts'

const clean = value => JSON.parse(JSON.stringify(value))
const visibleMessageLimit = 100
function recentConversation(conversation) {
  const start = Math.max(0, conversation.messages.length - visibleMessageLimit)
  return { ...conversation, messageCount: conversation.messages.length, historyCursor: start ? conversation.messages[start].id : null, messages: conversation.messages.slice(start) }
}
const safeReads = new Set(['listWorkspaceFiles','readWorkspaceFile','listWorkspaceProjects','listProjectCanvases','readProjectCanvas','listSkills','readSkill','webFetch','webSearch','probeMedia','ffprobe','inspectVideo','read','ls','find','grep','localToolInfo','getCanvas','findCanvasNodes','getCanvasNodes','getCanvasEdges','getNodeTools','getCanvasSchema','listCanvases','listNodeTypes','getNodeInfo','teamResources'])
const idOf = value => { const id = Number(value); if (!Number.isSafeInteger(id) || id <= 0) throw Object.assign(new Error('编号无效'), { status: 422 }); return id }
const failure = (message, status = 422) => Object.assign(new Error(message), { status })

function closeError(errors: unknown[]) {
  return errors.length === 1 ? errors[0] : new AggregateError(errors, 'Agent 运行时关闭未完成', { cause: errors[0] })
}
async function joinClosures(work: Iterable<Promise<unknown>>, failures: Iterable<unknown> = []) {
  const results = await Promise.allSettled(work)
  const errors = [...new Set([...failures, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])])]
  if (errors.length) throw closeError(errors)
}


// HTTP admits native submissions and observes committed state. It never owns a
// generation promise or implements an agent loop. Realms bind account AND project.
export function createDurableAgentApi({ directory, identity, createTools, canvasTools, instructions, resolveModel, beforeModelRequest, validateQuestion, legacy, sessionDirectory, contextualText, delegation, restoreConversation, assertProject = () => {}, executionScope = operation => operation(), conversationDefaults, workspaceFiles }: Record<string, any>) {
  const realms = new Map(), opening = new Map(), openingProjects = new Map(), closingRealms = new Map(), removingProjects = new Set(), control = createAgentCanvasControl({ workspaceFiles })
  // Failed closes remain visible even after their pending entry is released.
  // Key by the exact state, never the reusable account/project realm key.
  const closeFailures = new Map<any, unknown>()
  let closed: Promise<void> | undefined
  let closing = false, accountRevision = 0
  async function closeResources(state) {
    const errors = []
    try { await state.archive?.close() } catch (error) { errors.push(error) }
    try { state.unsubscribeIndex?.() } catch (error) { errors.push(error) }
    try { await state.host.close() } catch (error) { errors.push(error) }
    if (errors.length) {
      const error = closeError(errors)
      closeFailures.set(state, error)
      throw error
    }
  }
  const priorCloseFailures = (matches = (_state: any) => true) => [...closeFailures].filter(([state]) => matches(state)).map(([,error]) => error)
  function assertRealmClosed(key) {
    const errors = priorCloseFailures(state => state.key === key)
    if (errors.length) throw Object.assign(failure('原对话运行环境未能完成关闭，请重新打开软件后重试', 503), { cause: closeError(errors) })
  }
  const realmKey = (userId, account, project) => createHash('sha256').update(JSON.stringify([userId, account, project])).digest('hex')
  async function realm(userId, expected?: { account: any; revision: number; project: string }) {
    const account = expected ? expected.account : identity(), revision = expected ? expected.revision : accountRevision
    const project = expected ? expected.project : currentProject() || 'default'
    if (expected && (identity() !== account || accountRevision !== revision || (currentProject() || 'default') !== project)) throw failure('会话已切换，请重试', 409)
    if (!account) throw failure('请先登录', 401)
    const key = realmKey(userId, account, project)
    if (removingProjects.has(JSON.stringify([userId,project]))) throw failure('项目正在关闭', 409)
    if (closing) throw failure('应用正在退出', 503)
    assertRealmClosed(key)
    const previousClose = [...closingRealms].find(([state]) => state.key === key)?.[1]
    if (realms.has(key)) return realms.get(key)
    if (opening.has(key)) return opening.get(key)
    const pending = (async () => {
      // Waiting for an older host is initialization too. Register its whole
      // promise in opening so a background wake remains covered by close().
      if (previousClose) {
        try { await previousClose } catch (error) { assertRealmClosed(key); throw error }
        assertRealmClosed(key)
        if (closing || identity() !== account || accountRevision !== revision) throw failure('会话已切换，请重试', 409)
      }
      const scope = (operation, metadata?: any) => {
        if (closing || identity() !== account || accountRevision !== revision) throw failure('账号已切换，原任务已停止', 403)
        if (removingProjects.has(JSON.stringify([userId,project]))) throw failure('项目正在关闭', 409)
        assertProject(project)
        return withWorkspaceProject(project, () => runWithLocale(metadata?.locale || 'zh-CN', () => executionScope(operation, metadata)))
      }
      const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
      const catalog: any = scope(() => createTools(userId, { catalogOnly: true }))
      const definitions = [...canvasTools, ...catalog].map(tool => ({ ...tool, ...(safeReads.has(tool.name) ? { replay: 'safe' } : {}) }))
      let host, state
      host = await DurableAgentRuntime.open({
        path: join(directory, key + '.sqlite'), models, tools: definitions, scope, validateQuestion,
        instructions: (metadata, input) => instructions(userId, metadata, {
          tools: input.agent.tools.map(tool => definitions.find(definition => definition.name === tool.name) || tool),
        }),
        prepareConversation: async (metadata, id, taskContext = context) => {
          const agent = await host.harness.snapshot(AgentDoc, id, taskContext)
          return scope(async () => {
            const registered = await model(state, metadata, { userId }, agent?.model?.provider)
            // An archived child has history but no native model configuration.
            // Bind only a still-empty slot: a concurrent direct user submission
            // may already have selected a different model for this conversation.
            if (!agent?.model) await host.harness.commit(async tx => {
              const latest = await tx.doc(AgentMetadata, id)
              if (latest.deleted) throw failure('对话已删除', 404)
              if (!(await tx.doc(AgentDoc, id)).model) {
                await configure(tx, id, { model: registered.ref, thinkingLevel: latest.thinkingLevel || 'off' })
                latest.contextWindow = registered.contextWindow
              }
            }, taskContext)
            return registered
          }, metadata)
        },
        resolveChildren: (parentId, files, taskContext) => scope(() => resolveChildren(state, parentId, files, taskContext)),
        delegation: delegation ? (task, metadata, ctx) => scope(() => delegation(task, metadata, host, ctx), metadata) : undefined,
        normalizeResult: value => ({ output: value?.[VIDEO_REVIEW_CONTENT] || [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }], ...(value?.[AGENT_TOOL_USAGE] ? { usage: value[AGENT_TOOL_USAGE] } : {}), ...(value?.summary ? { details: { publicSummary: typeof value.summary === 'string' ? value.summary : JSON.stringify(value.summary) } } : {}) }),
        executeTool: async (name, args, execution) => {
          if (canvasTools.some(tool => tool.name === name)) {
            const value = await control.call(key, { name, args, metadata: execution.metadata, generation: revision, signal: execution.signal, progress: details => execution.api.details(details, execution.context) })
            if (value.canvasId && value.canvasId !== execution.metadata.canvasId) await host.configure(execution.api.conversationId, {}, { canvasId: value.canvasId })
            return value.result
          }
          const tool = createTools(userId, { signal: execution.signal, sessionId: execution.metadata.file, metadata: execution.metadata }).find(tool => tool.name === name)
          if (!tool) throw failure('当前工具未获授权或已关闭，请检查本机操作设置', 403)
          return tool.execute(args, { signal: execution.signal, toolCallId: execution.api.callId, emit: partial => { void execution.api.details({ publicSummary: typeof partial.result === 'string' ? partial.result : JSON.stringify(partial) }, execution.context).catch(() => {}) } })
        },
        onReport: report => console.warn('[agent-native]', String(report.message || report.error?.message || '运行时通知').slice(0, 300)),
      })
      try { writeFileSync(join(directory, key + '.scope.json'), JSON.stringify({ userId, project }), { mode: 0o600 }) }
      catch (error) {
        try { await closeResources({ key, userId, project, account, revision, host }) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent 初始化清理未完成', { cause: error }) }
        throw error
      }
      state = { key, account, revision, project, userId, host, models, scope, files: new Map(), filesById: new Map(), pendingMetadata: new Map(), locks: new Map() }
      try {
        // The scheduler is still paused and this realm is not published. Seed
        // once, then follow Pi's committed revisions instead of rescanning every
        // conversation for each get, submit, skill lookup and control request.
        await loadIndex(state)
        state.unsubscribeIndex = host.harness.subscribeCommits(publication => {
          for (const change of publication.changes) {
            if (!['document', 'document.copy'].includes(change.type) || change.record.kind !== AgentMetadata.definition.kind) continue
            if (change.type === 'document.copy') state.pendingMetadata.set(change.conversationId, publication.seq)
            else { state.pendingMetadata.delete(change.conversationId); indexMetadata(state, change.conversationId, change.value) }
          }
        })
        if (conversationDefaults) {
          // Older local databases have no working directory. Bind it once before
          // resuming any task; children inherit their parent's saved directory.
          const byId = state.filesById, bound = new Set()
          const bindDefaults = async (item, ancestors = new Set()) => {
            if (bound.has(item.id) || item.metadata.deleted) return
            if (ancestors.has(item.id)) throw failure('原对话父子关系存在循环，请保留记录并另建对话', 409)
            const parent = byId.get(item.metadata.parentId)
            if (parent) await bindDefaults(parent, new Set([...ancestors, item.id]))
            const defaults = scope(() => conversationDefaults(parent?.metadata))
            const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => item.metadata[key] === undefined))
            if (Object.keys(missing).length) {
              await host.configure(item.id, {}, missing)
              Object.assign(item.metadata, missing)
            }
            bound.add(item.id)
          }
          for (const item of state.files.values()) await bindDefaults(item)
        }
        const startup = await host.harness.inspect(context)
        const deleted = new Set([...state.files.values()].filter(item => item.metadata.deleted).map(item => item.id))
        // A crash may land after the deletion tombstone but before cancellation.
        // Mark all such work while the scheduler is still paused. In particular,
        // a recovered compaction can already be past its preparation hooks.
        for (const task of startup.tasks) if (deleted.has(task.record.conversationId) || deleted.has(task.record.input?.childId)) await host.harness.abortTask(task.record.id, context)
        for (const submission of startup.submissions) if (deleted.has(submission.conversationId) && submission.status === 'queued') await host.harness.abortSubmission(submission.id, context, submission.conversationId)
        // Register every unfinished conversation's model before waking the native
        // scheduler. Credentials are re-resolved, never stored in SQLite metadata.
        const unfinished = new Set(startup.tasks.map(task => task.record.conversationId))
        for (const [file, item] of state.files) if (unfinished.has(item.id) && item.metadata.modelId && !item.metadata.deleted) {
          try { await scope(async () => { const agent = await host.harness.snapshot(AgentDoc, item.id, context); await model(state, item.metadata, { userId }, agent?.model?.provider) }, item.metadata) }
          catch (error) { console.warn('[agent-native] 模型尚不可用', file, String(error.message).slice(0, 120)) }
        }
        if (closing || identity() !== account || accountRevision !== revision || removingProjects.has(JSON.stringify([userId,project]))) throw failure('账号已切换', 403)
        state.archive = createAgentArchive({ host, metadataDoc: AgentMetadata,
          snapshot: async (id, metadata) => snapshot(state, { id, metadata: { ...metadata, nativeId: id } }, false),
          read: file => { try { return withWorkspaceProject(project, () => legacy.read(userId, file)) } catch (error) { if (error.status === 404) return null; throw error } },
          revision: legacy.revision ? file => { try { return legacy.revision(userId, file) } catch (error) { if (error.status === 404) return null; throw error } } : undefined,
          write: (file, data) => legacy.write(userId, file, data),
          remove: file => { try { legacy.remove(userId, file) } catch (error) { if (error.status !== 404) throw error } },
          cleanupSource: file => file && legacy.cleanupSource?.(userId, file),
          writeScope: operation => { if (identity() !== account) return false; return withWorkspaceProject(project, operation) },
        })
        state.archive.mark([...state.files.values()].map(item => item.id))
        realms.set(key, state)
        host.resume()
        return state
      } catch (error) {
        if (realms.get(key) === state) realms.delete(key)
        try { await closeResources(state) }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent 初始化清理未完成', { cause: error }) }
        throw error
      }
    })()
    opening.set(key, pending); openingProjects.set(key, { userId, project })
    try { return await pending } finally {
      if (opening.get(key) === pending) { opening.delete(key); openingProjects.delete(key) }
    }
  }
  function indexMetadata(state, id, metadata) {
    const previous = state.filesById.get(id)
    if (previous && previous.metadata.file !== metadata?.file) state.files.delete(previous.metadata.file)
    if (!metadata?.file) { state.filesById.delete(id); return }
    const item = { id, metadata: { ...metadata, nativeId: id } }
    state.files.set(metadata.file, item); state.filesById.set(id, item)
  }
  async function loadIndex(state) {
    let cursor
    do {
      const page = await state.host.harness.commit(tx => tx.scanConversations({}, 200, cursor), context)
      for (const record of page.items) {
        const metadata = await state.host.harness.snapshot(AgentMetadata, record.id, context)
        indexMetadata(state, record.id, metadata)
      }
      cursor = page.next
    } while (cursor)
  }
  async function refresh(state) {
    // A definition-free native copy has no value in its publication. Hydrate
    // just those IDs outside the synchronous commit listener; a later revision
    // wins if it arrives while the snapshot is being read.
    while (state.pendingMetadata.size) for (const [id, revision] of [...state.pendingMetadata]) {
      const metadata = await state.host.harness.snapshot(AgentMetadata, id, context)
      if (state.pendingMetadata.get(id) !== revision) continue
      state.pendingMetadata.delete(id); indexMetadata(state, id, metadata)
    }
  }
  async function model(state, payload, session, registeredNamespace?: any) {
    const config = await resolveModel(payload, session)
    const namespace = registeredNamespace || `miao-${createHash('sha256').update(JSON.stringify([payload.providerId || 'miaoimg',payload.modelId,config.baseUrl])).digest('hex').slice(0, 20)}`
    const signature = createHash('sha256').update(JSON.stringify(config)).digest('hex')
    state.modelCache ||= new Map()
    const cached = state.modelCache.get(namespace)
    if (cached?.signature === signature) return cached.result
    const registered = await createAgentModel({ ...config, providerId: payload.providerId || 'miaoimg', modelId: payload.modelId, modelRuntime: state.models, runtimeProviderId: namespace, beforeRequest: async signal => {
      state.scope(() => {}, payload)
      await beforeModelRequest?.(payload, session, signal)
      signal?.throwIfAborted()
      state.scope(() => {}, payload)
    } })
    const result = { config, ref: { provider: namespace, modelId: registered.model.id }, contextWindow: registered.model.contextWindow }
    state.modelCache.set(namespace, { signature, result })
    return result
  }
  async function locate(state, file, create = false, lineage = new Set(), expectedParentId?: number) {
    if (lineage.has(file)) throw failure('原对话父子关系存在循环，请保留记录并另建对话', 409)
    await refresh(state)
    const item = state.files.get(file)
    if (item?.metadata.deleted) throw failure('对话已删除', 404)
    if (item && expectedParentId && item.metadata.parentId !== expectedParentId) throw failure('子任务不属于当前对话', 403)
    if (item) return item
    if (!create) return null
    const previous = legacy.read(state.userId, file), history = [], restoredMetadata: Record<string, any> = {}
    if (expectedParentId) {
      const parent = state.filesById.get(expectedParentId)
      if (!parent || parent.metadata.deleted) throw failure('父对话已删除', 404)
      // Validate the saved lineage before importing any history. A filename in
      // an old tool result is not permission to restore another parent's child.
      if (previous.parentFile !== parent.metadata.file) throw failure('子任务不属于当前对话', 403)
    }
    if (typeof previous.lastFailure?.message === 'string') restoredMetadata.importedFailure = { taskId: 0, message: previous.lastFailure.message.slice(0, 1000) }
    const checkpoint = previous.nativeCheckpoint?.version === 1 && Array.isArray(previous.nativeCheckpoint.context) && previous.nativeCheckpoint.uiHash === agentArchiveHash(previous.messages || []) ? previous.nativeCheckpoint : null
    if (checkpoint) {
      for (const key of ['canvasId','locale','teamName','teamMember','delegationDepth','lastUserAnswer','memoryEnabled']) if (checkpoint.metadata?.[key] !== undefined) restoredMetadata[key] = checkpoint.metadata[key]
      for (const message of checkpoint.context) if (['user','assistant','toolResult'].includes(message.role)) history.push({ kind: 'miaoimg.import', data: { source: 'pi-durable-archive' }, model: [message] })
    } else if (previous.agentSessionFile) {
      if (!isSafeAgentSessionFile(sessionDirectory(state.userId), previous.agentSessionFile)) throw failure('原会话路径无效', 422)
      const native = SessionManager.open(previous.agentSessionFile).buildSessionContext()
      // Use Pi's own converter, including compaction and branch summaries,
      // custom reports and excluded shell messages. Keep the original SDK file.
      for (const message of convertToLlm(native.messages)) history.push({ kind: 'miaoimg.import', data: { source: 'pi-sdk' }, model: [message] })
    } else if (previous.messages?.length) {
      // Legacy transcripts without native state retain tool-call/result pairs.
      for (const message of legacy.modelHistory(previous)) history.push({ kind: 'miaoimg.import', data: { source: 'legacy' }, model: [message] })
    }
    if (previous.messages?.length) history.push({ kind: 'miaoimg.import-ui', data: { messages: legacy.get(state.userId, file).messages } })
    let parent
    if (previous.parentFile) {
      const parents = new Set(lineage); parents.add(file)
      if (parents.has(previous.parentFile)) throw failure('原对话父子关系存在循环', 409)
      parent = await locked(state, previous.parentFile, () => locate(state, previous.parentFile, true, parents))
    }
    // Restore the observed outcome, never a task ID or live execution. Older
    // archives kept child status only in their parent's summary. Unfinished
    // observations become an explicit interruption requiring new user input.
    const savedActivity = checkpoint?.activity || parent?.metadata.legacySubAgents?.find(child => child.file === file)
    const modelMessages = history.flatMap(entry => entry.model || [])
    const lastMessage = modelMessages.at(-1), lastAssistant = modelMessages.findLast(message => message.role === 'assistant')
    const unfinished = Boolean(['running','queued','inputRequired'].includes(savedActivity?.status) || previous.running || previous.pendingInputs?.length || !savedActivity && (lastMessage?.role === 'toolResult' || lastMessage?.role === 'assistant' && lastMessage.stopReason === 'toolUse' || previous.messages?.at(-1)?.role === 'user'))
    const status = unfinished ? 'error' : savedActivity?.status || (lastAssistant?.stopReason === 'aborted' ? 'cancelled' : lastAssistant?.stopReason === 'error' ? 'error' : lastAssistant?.stopReason === 'length' ? 'limited' : 'completed')
    if (['completed','limited','cancelled','error'].includes(status)) restoredMetadata.status = status
    restoredMetadata.result = String(savedActivity?.result || (lastAssistant?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n\n')).slice(0, 4000)
    if ((unfinished || status === 'error') && !restoredMetadata.importedFailure) restoredMetadata.importedFailure = { taskId: 0, message: unfinished ? '历史任务尚未完成，原执行状态未恢复。已有内容已保留，请明确追加要求后继续。' : '历史任务未完成，已有内容已保留，可以继续。' }
    const defaults = state.scope(() => conversationDefaults?.(parent?.metadata) || {})
    if (typeof restoredMetadata.memoryEnabled !== 'boolean') {
      const memoryEnabled = previous.memoryEnabled ?? parent?.metadata.memoryEnabled
      if (typeof memoryEnabled === 'boolean') restoredMetadata.memoryEnabled = memoryEnabled
    }
    const metadata = clean({ ...defaults, ...restoredMetadata, ...(parent ? { parentId: parent.id } : {}), sourceUiHash: agentArchiveHash(previous.messages || []), ...(previous.agentSessionFile ? { sourceSessionFile: previous.agentSessionFile } : {}), legacySubAgents: previous.subAgents || [], file, name: previous.name || '新对话', parentFile: previous.parentFile || '', task: previous.task || '', providerId: previous.providerId || '', modelId: previous.modelId || '', thinkingLevel: previous.thinkingLevel || 'off', createdAt: previous.createdAt || new Date().toISOString() })
    const plan = restoreConversation ? await state.scope(() => restoreConversation(metadata,state.host), metadata) : {}
    const conversation = await state.host.create({ ...plan, metadata, history })
    const itemCreated = { id: conversation.id, metadata: { ...metadata, nativeId: conversation.id } }
    indexMetadata(state, itemCreated.id, itemCreated.metadata)
    return itemCreated
  }
  async function resolveChildren(state, parentId, files, taskContext) {
    taskContext.abortSignal?.throwIfAborted()
    await refresh(state)
    const parent = state.filesById.get(parentId)
    if (!parent || parent.metadata.deleted) throw failure('父对话已删除', 404)
    const candidates = files || [...new Set([
      ...[...state.files.values()].filter(item => item.metadata.parentId === parentId && !item.metadata.deleted).map(item => item.metadata.file),
      ...(parent.metadata.legacySubAgents || []).map(child => child.file),
    ])]
    const children = []
    for (const candidate of candidates) {
      taskContext.abortSignal?.throwIfAborted()
      try {
        const file = legacy.path(candidate)
        const child = await locked(state, file, () => state.scope(() => {
          taskContext.abortSignal?.throwIfAborted()
          return locate(state, file, true, new Set(), parentId)
        }))
        children.push(child)
      } catch (error) {
        // Old parent summaries can retain removed or moved children. Explicit
        // requests still fail, while listing skips only invalid stale links.
        if (files || ![403, 404, 422].includes(error.status)) throw error
      }
      if (!files && children.length >= 100) break
    }
    taskContext.abortSignal?.throwIfAborted()
    state.scope(() => {})
    return children
  }
  async function entries(conversation, taskContext = context, minEntryId?: number) {
    const items = []; let cursor
    const query = { order: 'ascending', ...(minEntryId === undefined ? {} : { minEntryId }) }
    do { const page = await conversation.entries(query, 500, cursor, taskContext); items.push(...page.items); cursor = page.next } while (cursor)
    return items
  }
  async function childPresentations(state, item, childIds = new Set(), taskContext = context) {
    const children = new Map((item.metadata.legacySubAgents || []).map(child => [child.file, child]))
    // Imported children can be ownerless in Pi but retain their file lineage.
    const records = new Set([...state.files.values()].filter(child => child.metadata.parentId === item.id).map(child => child.id))
    let cursor
    do {
      const page = await state.host.harness.commit(tx => tx.scanConversations({ ownerConversationId: item.id }, 200, cursor), taskContext)
      for (const record of page.items) records.add(record.id)
      cursor = page.next
    } while (cursor)
    for (const id of records) {
      const metadata = await state.host.harness.snapshot(AgentMetadata, id, taskContext)
      if (!metadata?.file) continue
      childIds.add(id)
      if (metadata.deleted) { children.delete(metadata.file); continue }
      const live = await state.host.harness.snapshot(LiveDoc, id, taskContext)
      const activity = await readAgentActivity(state.host.harness, id, metadata, live, taskContext)
      children.set(metadata.file, { file: metadata.file, parentFile: item.metadata.file, name: metadata.name, task: metadata.task || '', status: activity.status, result: activity.result, providerId: metadata.providerId, modelId: metadata.modelId, thinkingLevel: metadata.thinkingLevel || 'off' })
    }
    return [...children.values()]
  }
  async function snapshot(state, item, recent = true) {
    const conversation = await state.host.conversation(item.id)
    item = { ...item, metadata: { ...await state.host.harness.snapshot(AgentMetadata, item.id, context), nativeId: item.id } }
    const view = await conversation.viewState(context)
    try { const activity = await readAgentActivity(state.host.harness, item.id, item.metadata, view.value.docs['pi.live'], context); const full = { ...projectAgentView(item.metadata, await entries(conversation), view.value.docs), lastFailure: activity.failure, subAgents: await childPresentations(state, item) }; return recent ? recentConversation(full) : full } finally { view.dispose() }
  }
  async function locked(state, file, operation) {
    const previous = state.locks.get(file) || Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    state.locks.set(file, next)
    try { return await next } finally { if (state.locks.get(file) === next) state.locks.delete(file) }
  }
  async function edit(state, item, entryId, requestId, truncate = false) {
    const conversation = await state.host.conversation(item.id)
    const prior = await state.host.harness.commit(tx => tx.submissionByRequest(item.id, `edit:${requestId}`), context)
    if (prior?.status === 'done') { item.metadata = { ...await state.host.harness.snapshot(AgentMetadata, item.id, context), nativeId: item.id }; return }
    const view = await conversation.viewState(context)
    try { if (view.value.docs['pi.live']?.run || view.value.docs['pi.live']?.compactions?.length || view.value.docs['pi.inbox']?.items.length) throw failure('当前任务仍在执行，请先停止再编辑历史', 409) } finally { view.dispose() }
    const history = await entries(conversation)
    const historyTaskId = (await state.host.harness.commit(tx => tx.scanTasks({ conversationId: item.id, order: 'descending' }, 1), context)).items[0]?.id || 0
    const match = /^e:(?:([0-9a-f-]{36}):)?(\d+):\d+$/.exec(String(entryId || ''))
    const reset = history.findLastIndex(entry => ['miaoimg.history-reset', 'pi.reset'].includes(entry.kind))
    const index = match ? history.findIndex(entry => entry.id === Number(match[2])) : -1
    if (!match || (match[1] && match[1] !== item.metadata.timelineId) || index <= reset) {
      const full = await snapshot(state, item, false)
      const index = full.messages.findIndex(message => message.id === entryId || message.entryId === entryId)
      if (index < 0) throw failure('消息不存在', 404)
      let end = full.messages.length
      if (!truncate) for (let next = index + 1; next < full.messages.length; next++) if (full.messages[next].role === 'user' || full.messages[index].role !== 'user') { end = next; break }
      const kept = truncate ? full.messages.slice(0, index) : [...full.messages.slice(0, index), ...full.messages.slice(end)]
      await state.host.write(item.id, { expectedTail: history.at(-1)?.id || 0, requestId: `edit:${requestId}`, entry: { kind: 'miaoimg.history-reset', head: 'self', data: { messages: kept }, model: legacy.modelHistory({ ...full, messages: kept }) } })
      await state.host.harness.commit(async tx => { const metadata = await tx.doc(AgentMetadata, item.id); metadata.presentationRevision = Number(metadata.presentationRevision || 0) + 1; metadata.historyTaskId = historyTaskId; metadata.importedFailure = null }, context)
      item.metadata = { ...await state.host.harness.snapshot(AgentMetadata, item.id, context), nativeId: item.id }
      return
    }
    if (index < 0) throw failure('消息不存在', 404)
    const omitted = new Set(history.filter(entry => entry.kind === 'miaoimg.edit').flatMap(entry => entry.data.hidden || []))
    if (omitted.has(history[index].id)) throw failure('消息不存在', 404)
    let end = history.length
    if (!truncate) {
      for (let next = index + 1; next < history.length; next++) {
        const entry = history[next]
        if (omitted.has(entry.id) || ['miaoimg.edit', 'miaoimg.child-context', 'pi.compaction', 'pi.system'].includes(entry.kind)) continue
        if (entry.model?.some(message => message.role === 'user' || history[index].model?.[0]?.role !== 'user' && message.role === 'assistant')) { end = next; break }
      }
    }
    const hidden = history.slice(index, end).filter(entry => entry.kind !== 'miaoimg.edit').map(entry => entry.id)
    for (const id of hidden) omitted.add(id)
    // A summary can still contain a removed message, even when its source is
    // omitted. Rebuild from retained native messages and replace the context
    // head atomically; keep full tool results and attachments, not UI previews.
    const model = history.slice(Math.max(0, reset)).filter(entry => !omitted.has(entry.id) && !['miaoimg.edit', 'pi.compaction', 'pi.system'].includes(entry.kind)).flatMap(entry => entry.model || []).filter(message => ['user', 'assistant', 'toolResult'].includes(message.role) && !(message.role === 'assistant' && ['error', 'aborted', 'deferred'].includes(message.stopReason)))
    await state.host.write(item.id, { expectedTail: history.at(-1)?.id || 0, requestId: `edit:${requestId}`, entry: { kind: 'miaoimg.edit', head: 'self', data: { hidden }, model } })
    await state.host.harness.commit(async tx => { const metadata = await tx.doc(AgentMetadata, item.id); metadata.presentationRevision = Number(metadata.presentationRevision || 0) + 1; metadata.historyTaskId = historyTaskId; metadata.importedFailure = null }, context)
    item.metadata = { ...await state.host.harness.snapshot(AgentMetadata, item.id, context), nativeId: item.id }
  }
  async function observe(state, item, response) {
    if (response.destroyed || response.writableEnded) return
    const lifetime = new AbortController(), ctx = withAbortSignal(lifetime.signal, context)
    const close = () => lifetime.abort()
    let heartbeat, watch, unsubscribe, pending
    try {
      response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }); response.flushHeaders()
      response.once('close', close)
      heartbeat = setInterval(() => { if (!response.destroyed) response.write('{"type":"heartbeat"}\n') }, 15000); heartbeat.unref()
      const conversation = await state.host.conversation(item.id)
      watch = await conversation.watch(ctx)
      const childIds = new Set()
      const projection = { cache: {}, limit: visibleMessageLimit }
      let previous, committed, observedEntries, childSignature = '', children = [], childRevision = 0, activityRevision = 0, activitySignature = '', activity
      async function emit(value) {
        if (lifetime.signal.aborted || identity() !== state.account) return
        if (!committed || value.entries !== observedEntries) {
          // Pi entries are immutable, including edits and context-head markers.
          // Keep display history across compaction; fetch only later records.
          // Document-only streaming frames retain the native entries reference.
          const tail = committed?.at(-1)?.id
          const added = await entries(conversation, ctx, tail === undefined ? undefined : tail + 1)
          committed = added.length ? [...(committed || []), ...added] : committed || []
          observedEntries = value.entries
        }
        const metadata = await state.host.harness.snapshot(AgentMetadata, item.id, ctx)
        const projected = projectAgentView({ ...metadata, nativeId: item.id }, committed, value.docs, projection)
        const signature = `${childRevision}:${metadata.stoppedAt || ''}`
        if (signature !== childSignature) { children = await childPresentations(state, item, childIds, ctx); childSignature = signature }
        const live = value.docs['pi.live']
        const nextActivity = JSON.stringify([activityRevision, live?.run?.taskId, live?.tools?.filter(tool => tool.name === 'askUser').map(tool => tool.status), metadata.jobTaskId, metadata.historyTaskId])
        if (nextActivity !== activitySignature) { activity = await readAgentActivity(state.host.harness, item.id, metadata, live, ctx); activitySignature = nextActivity }
        const next = { ...projected, lastFailure: activity.failure, subAgents: children }
        const frame = previous ? { type: 'patch', ops: diffRevisions(previous, next) } : { type: 'snapshot', conversation: next }
        previous = next
        if (lifetime.signal.aborted || response.destroyed || response.writableEnded) return
        if (frame.type === 'patch' && !frame.ops.length) return
        if (!response.write(JSON.stringify(frame) + '\n')) {
          let finish
          const drained = new Promise<void>(resolve => { finish = resolve; response.once('drain', finish); response.once('close', finish) })
          try { await awaitWithContext(drained, ctx) }
          finally { response.off('drain', finish); response.off('close', finish) }
        }
      }
      // Native conversation watches exclude application metadata and child task
      // receipts. Include those commits so a detached child's failure/completion
      // reaches the open parent even when the parent itself is idle.
      let dirty = false
      function schedule() {
        dirty = true
        if (!pending) pending = (async () => { while (dirty && !lifetime.signal.aborted) { dirty = false; await emit(watch.value) } })().catch(error => lifetime.abort(error)).finally(() => { pending = undefined; if (dirty && !lifetime.signal.aborted) void schedule() })
        return pending
      }
      unsubscribe = state.host.harness.subscribeCommits(publication => {
        let changed = false
        for (const change of publication.changes) {
          const id = change.type === 'document' ? change.conversationId : change.value?.conversationId
          const metadata = change.type === 'document' && change.record.kind === AgentMetadata.definition.kind
          if (metadata && change.value?.parentId === item.id) childIds.add(id)
          if (id === item.id && (metadata || change.type === 'task' && ['pi.generation', 'miaoimg.child-job'].includes(change.value.kind))) { activityRevision++; changed = true }
          if (childIds.has(id) && (metadata || change.type === 'task')) { childRevision++; changed = true }
        }
        if (changed) void schedule()
      })
      // Observe closure even while the first projection waits for a slow client.
      // The finalizer cancels that wait through the same native context.
      void schedule()
      if (!lifetime.signal.aborted) watch.start(() => schedule())
      await watch.closed
    } finally {
      unsubscribe?.(); clearInterval(heartbeat); response.off('close', close); lifetime.abort()
      try { await watch?.stop() } finally { await pending; response.end() }
    }
  }
  async function handle(request, response, session, url, helpers) {
    if (!identity()) return false
    const path = url.pathname, method = request.method
    const recognized = ['/api/agent/list','/api/agent/get','/api/agent/history','/api/agent/create','/api/agent/rename','/api/agent/delete','/api/agent/message','/api/agent/submit','/api/agent/observe','/api/agent/native/stop','/api/agent/native/answer','/api/agent/native/input','/api/agent/control/events','/api/agent/control/state','/api/agent/control/result']
    if (!recognized.includes(path)) return false
    const { json, readJson, sameOrigin } = helpers
    if (method !== 'GET') { sameOrigin(request); if (!isWorkspaceRequest(request.headers)) throw failure('会话已刷新，请重试', 403) }
    else if (path === '/api/agent/control/events') {
      // This GET registers an executor and can replace a live controller.
      // Same-origin fetch may omit Origin, but always carries the app header.
      if (!isWorkspaceRequest(request.headers)) throw failure('会话已刷新，请重试', 403)
      if (request.headers.origin) sameOrigin(request)
    }
    if (path.startsWith('/api/agent/control/')) {
      const account = identity(), generation = accountRevision, project = currentProject() || 'default'
      const owner = workspaceFiles?.referenceOwner?.(session.userId) || String(session.userId)
      const key = realmKey(session.userId, account, project)
      const assertCurrent = () => {
        if (closing) throw failure('应用正在退出', 503)
        if (!account || identity() !== account || accountRevision !== generation) throw failure('账号已切换，原任务已停止', 403)
        if ((currentProject() || 'default') !== project || (workspaceFiles?.referenceOwner?.(session.userId) || String(session.userId)) !== owner) throw failure('工作区已切换，请重新连接', 409)
        if (removingProjects.has(JSON.stringify([session.userId, project]))) throw failure('项目正在关闭', 409)
        assertProject(project)
      }
      assertCurrent()
      if (path.endsWith('/events') && method === 'GET') {
        const connectionId = url.searchParams.get('connectionId') || randomUUID(), viewId = url.searchParams.get('viewId') || connectionId
        const documentId = String(request.headers['x-miaoimg-document'] || '')
        if ([connectionId, viewId, documentId].some(value => value.length > 64)) throw failure('画布连接标识无效')
        // Editor protection belongs to the page, not Pi initialization. Admit
        // its unknown connection before any await and accept snapshots even if
        // opening the conversation database is slow or fails.
        control.connect(key, response, { userId: session.userId, project, generation, owner, connectionId, viewId, documentId })
        // Opening a workspace still wakes its recovered Agent work. The
        // registered opening promise owns startup/shutdown; the editor stream
        // and its readonly snapshots do not wait for that initialization.
        if (!response.destroyed && !response.writableEnded) void realm(session.userId, { account, revision: generation, project }).catch(error => console.warn('[agent-native] 后台恢复尚未就绪', error?.code || error?.status || 'unknown'))
        return true
      }
      if (['/api/agent/control/state','/api/agent/control/result'].includes(path) && method === 'POST') {
        const payload = await readJson(request)
        assertCurrent()
        if (path.endsWith('/state')) control.updateState(key, payload, generation)
        else control.result(key, payload, generation)
        json(response, 200, { ok: true }); return true
      }
      return false
    }
    const answerScope = path === '/api/agent/native/answer' && method === 'POST' ? {
      account: identity(), revision: accountRevision, project: currentProject() || 'default',
      owner: workspaceFiles?.referenceOwner?.(session.userId) || String(session.userId),
    } : undefined
    const assertAnswerScope = (state?: { account: unknown; revision: number; project: string }) => {
      if (!answerScope) return
      if (closing) throw failure('应用正在退出', 503)
      if (!answerScope.account || identity() !== answerScope.account || accountRevision !== answerScope.revision) throw failure('账号已切换，原任务已停止', 403)
      if (request.headers['x-workspace-owner'] !== answerScope.owner) throw failure('工作区账号已切换，请刷新页面', 403)
      if ((currentProject() || 'default') !== answerScope.project || (workspaceFiles?.referenceOwner?.(session.userId) || String(session.userId)) !== answerScope.owner) throw failure('工作区已切换，请重试', 409)
      if (state && (state.account !== answerScope.account || state.revision !== answerScope.revision || state.project !== answerScope.project)) throw failure('会话已切换，请重试', 409)
      if (removingProjects.has(JSON.stringify([session.userId, answerScope.project]))) throw failure('项目正在关闭', 409)
      assertProject(answerScope.project)
    }
    assertAnswerScope()
    const state = await realm(session.userId, answerScope)
    assertAnswerScope(state)
    await refresh(state)
    assertAnswerScope(state)
    if (path === '/api/agent/list' && method === 'GET') {
      const history = legacy.list(session.userId, new Set(state.files.keys())).filter(item => !state.files.has(item.file))
      for (const [file, item] of state.files) if (!item.metadata.parentFile && !item.metadata.deleted) history.push({ file, name: item.metadata.name, modified: item.metadata.updatedAt || item.metadata.createdAt, messageCount: 0 })
      history.sort((left, right) => String(right.modified).localeCompare(String(left.modified)))
      let latest = null
      if (url.searchParams.get('includeLatest') === '1' && history[0]) { const item = state.files.get(history[0].file); latest = item ? await snapshot(state, item) : recentConversation({ ...legacy.get(session.userId, history[0].file), engine: 'pi-durable', historyRevision: 0 }) }
      json(response, 200, { code: 200, data: history, session: latest, engine: 'pi-durable' }); return true
    }
    if (path === '/api/agent/create' && method === 'POST') {
      await readJson(request)
      const conversation = await state.scope(() => state.host.create({ metadata: { ...conversationDefaults?.(), name: '新对话' } })); await refresh(state)
      json(response, 200, { code: 200, data: await snapshot(state, state.filesById.get(conversation.id)) }); return true
    }
    if (path === '/api/agent/get' && method === 'GET') {
      const file = legacy.path(url.searchParams.get('sessionFile')), item = await locate(state, file)
      json(response, 200, { code: 200, data: item ? await snapshot(state, item) : recentConversation({ ...legacy.get(session.userId, file), engine: 'pi-durable', historyRevision: 0 }) }); return true
    }
    if (path === '/api/agent/history' && method === 'GET') {
      const file = legacy.path(url.searchParams.get('sessionFile')), item = await locate(state, file)
      const full = item ? await snapshot(state, item, false) : { ...legacy.get(session.userId, file), historyRevision: 0 }
      const end = full.messages.findIndex(message => message.id === url.searchParams.get('before'))
      if (end < 0) throw failure('这段历史已变动，请重新打开对话后查看', 409)
      const start = Math.max(0, end - visibleMessageLimit)
      json(response, 200, { code: 200, data: { messages: full.messages.slice(start, end), historyCursor: start ? full.messages[start].id : null, historyRevision: full.historyRevision || 0 } }); return true
    }
    if (path === '/api/agent/observe' && method === 'GET') {
      const file = legacy.path(url.searchParams.get('sessionFile')), item = await locate(state, file)
      if (!item) throw failure('对话尚未迁移', 404)
      await observe(state, item, response); return true
    }
    if (path === '/api/agent/native/input' && method === 'GET') {
      const inputId = String(url.searchParams.get('inputId') || '')
      const submissionId = url.searchParams.has('submissionId') ? idOf(url.searchParams.get('submissionId')) : undefined
      if (submissionId === undefined && !/^[0-9a-f-]{36}$/i.test(inputId)) throw failure('消息编号无效')
      const file = legacy.path(url.searchParams.get('sessionFile')), item = await locate(state, file)
      if (!item) throw failure('对话不存在', 404)
      const receipt = await state.host.inputReceipt(item.id, inputId, submissionId)
      json(response, 200, { code: 200, data: { file, ...(submissionId === undefined ? { inputId } : { submissionId }), ...receipt } }); return true
    }
    const payload = await readJson(request, 4 * 1024 * 1024)
    assertAnswerScope(state)
    const file = payload.sessionFile ? legacy.path(payload.sessionFile) : ''
    if (path === '/api/agent/submit' && method === 'POST') {
      if (payload.memoryEnabled !== undefined && typeof payload.memoryEnabled !== 'boolean') throw failure('记忆开关必须为布尔值')
      payload.providerId = String(payload.providerId || 'miaoimg').trim() || 'miaoimg'
      payload.modelId = String(payload.modelId || '').trim()
      const requestId = String(payload.inputId || '')
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw failure('消息编号无效')
      if (!file) throw failure('请先创建对话')
      const prompt = String(payload.prompt || '').trim()
      if (payload.action !== 'compact' && !prompt && !payload.attachments?.length && !payload.mentions?.length) throw failure('请先输入内容')
      const admitted = await locked(state, file, async () => {
        const item = await locate(state, file, true)
        const activeCanvasId = payload.action !== 'compact' && typeof payload.canvas?.id === 'string' && payload.canvas.id.trim()
          ? payload.canvas.id.trim()
          : ''
        const previous = await state.host.harness.commit(tx => tx.submissionByRequest(item.id, requestId), context)
        if (previous) return { submissionId: previous.id, file, ...await state.host.inputReceipt(item.id, requestId) }
        const compactInstructions = `Follow the default context summarization rules. Internal operation receipt: ${requestId}. Do not include this receipt in the summary.`
        if (payload.action === 'compact') {
          // Manual compaction has no native submission requestId. Reacquire its
          // official task receipt after an acknowledgement loss or host restart.
          let cursor
          do {
            const page = await state.host.harness.commit(tx => tx.scanTasks({ conversationId: item.id, kind: 'pi.compaction', order: 'descending' }, 100, cursor), context)
            const existing = page.items.find(task => task.input.instructions === compactInstructions)
            if (existing) return { taskId: existing.id, file }
            cursor = page.next
          } while (cursor)
        }
        const registered = await model(state, payload, session)
        item.metadata = { ...await state.host.harness.snapshot(AgentMetadata, item.id, context), nativeId: item.id }
        const available = state.scope(() => createTools(session.userId, {}).map(tool => tool.name), item.metadata)
        const selected = item.metadata.teamName ? (await (await state.host.conversation(item.id)).agent(context)).tools.map(tool => tool.name) : [...available, 'subAgent', 'messageSubAgent', 'waitSubAgents', 'stopSubAgent', 'getSubAgents', ...(item.metadata.parentId ? ['report'] : []), ...(payload.canvas?.id || item.metadata.canvasId ? canvasTools.map(tool => tool.name) : [])]
        if (payload.resendFrom) await edit(state, item, payload.resendFrom, requestId, true)
        // Background jobs and canvas tools can commit while model preparation
        // awaits. Patch only this request's fields against the current document;
        // copying its earlier snapshot would roll those native commits back.
        await state.host.configure(item.id, { model: registered.ref, thinkingLevel: payload.thinkingLevel || 'off', tools: state.host.tools.filter(tool => selected.includes(tool.name)) }, current => clean({
          providerId: payload.providerId || 'miaoimg', modelId: payload.modelId, thinkingLevel: payload.thinkingLevel || 'off', contextWindow: registered.contextWindow, locale: resolveRequestLocale(request.headers['accept-language']) || 'zh-CN',
          ...(payload.memoryEnabled !== undefined ? { memoryEnabled: payload.memoryEnabled } : {}),
          ...(activeCanvasId ? { canvasId: activeCanvasId } : {}),
          ...(current.name === '新对话' ? { name: prompt.slice(0, 80) || '新对话' } : {}),
          // A direct user follow-up owns its new native submission; admission
          // pointers still belong to the background jobs that maintain them.
          ...(current.parentId && payload.action !== 'compact' ? { jobTaskId: null } : {}),
          updatedAt: new Date().toISOString(),
        }))
        const metadata = await state.host.harness.snapshot(AgentMetadata, item.id, context)
        if (payload.action === 'compact') { const taskId = await state.host.compact(item.id, compactInstructions); return { taskId, file } }
        const data = { id: requestId, content: prompt, mentions: Array.isArray(payload.mentions) ? payload.mentions : [], attachments: Array.isArray(payload.attachments) ? payload.attachments : [] }
        const content = state.scope(() => contextualText(data, state.userId), metadata)
        const submission = await state.host.submit(item.id, { requestId, content, data })
        return { submissionId: submission.id, file, ...await state.host.inputReceipt(item.id, requestId) }
      })
      json(response, 200, { code: 200, data: admitted }); return true
    }
    const questionId = /^q:(\d+):(\d+)$/.exec(String(payload.callId || ''))
    const item = file ? await locked(state, file, () => locate(state, file, true)) : questionId ? state.filesById.get(Number(questionId[1])) : null
    assertAnswerScope(state)
    if (item?.metadata.deleted) throw failure('对话已删除', 404)
    if (!item) return false // legacy mutation keeps its original semantics
    if (path === '/api/agent/native/input' && method === 'POST') {
      const submissionId = payload.submissionId === undefined ? undefined : idOf(payload.submissionId)
      if (submissionId === undefined && !/^[0-9a-f-]{36}$/i.test(String(payload.inputId || ''))) throw failure('消息编号无效')
      const data = await locked(state, file, () => state.host.updateInput(item.id, payload.inputId, payload.action, submissionId))
      json(response, 200, { code: 200, data }); return true
    }
    if (path === '/api/agent/native/stop' && method === 'POST') { await locked(state, file, () => state.host.stop(item.id)); json(response, 200, { code: 200, data: { stopped: true } }); return true }
    if (path === '/api/agent/native/answer' && method === 'POST') {
      const match = /^q:(\d+):(\d+)$/.exec(String(payload.callId || ''))
      if (!match || idOf(match[1]) !== item.id) throw failure('提问不属于当前对话', 403)
      const answer = payload.skipped || payload.cancelled ? { skipped: true } : payload.values && typeof payload.values === 'object' ? { values: payload.values } : { answer: String(payload.answer || '') }
      const data = await state.scope(() => {
        assertAnswerScope(state)
        return state.host.answer(idOf(match[2]), answer, item.id)
      }, item.metadata)
      json(response, 200, { code: 200, data }); return true
    }
    if (path === '/api/agent/rename' && method === 'PATCH') {
      const name = String(payload.name || '').trim().slice(0, 80); if (!name) throw failure('名称不能为空')
      await state.host.configure(item.id, {}, { name }); item.metadata.name = name; json(response, 200, { code: 200, data: { name } }); return true
    }
    if (path === '/api/agent/delete' && method === 'DELETE') {
      const removed = await locked(state, file, () => state.host.remove(item.id))
      for (const target of removed) { const cached = state.files.get(target.file); if (cached) cached.metadata.deleted = true }
      await state.archive.flush()
      json(response, 200, { code: 200, data: { file, files: removed.map(target => target.file), removed: removed.length } }); return true
    }
    if (path === '/api/agent/message' && method === 'DELETE') {
      await locked(state, file, async () => { for (const entryId of payload.entryIds || [payload.replyTo]) await edit(state, item, entryId, randomUUID(), Boolean(payload.replyTo)) })
      json(response, 200, { code: 200, data: await snapshot(state, item) }); return true
    }
    return false
  }
  function closeRealm(state, stop) {
    if (closingRealms.has(state)) return closingRealms.get(state)
    if (realms.get(state.key) === state) realms.delete(state.key)
    // Register before any shutdown callback or asynchronous cleanup can run.
    const completed = Promise.withResolvers<void>(), pending = completed.promise
    closingRealms.set(state, pending)
    void (async () => {
      const errors = []
      try {
        control.disconnect(state.key, undefined, state.revision)
        if (stop) {
          await refresh(state)
          const active = new Set((await state.host.harness.inspect(context)).tasks.map(task => task.record.conversationId))
          const byId = state.filesById
          const roots = new Set()
          for (let id of active) { const visited = new Set(); while (byId.get(id)?.metadata.parentId && !visited.has(id)) { visited.add(id); id = byId.get(id).metadata.parentId } if (byId.has(id)) roots.add(id) }
          await joinClosures([...roots].map(id => Promise.resolve().then(() => state.host.stop(id))))
        }
      } catch (error) { errors.push(error) }
      // Detached editor views retire through a same-page snapshot/document
      // drain. Closing a reusable realm key must not release a newer view.
      try { await closeResources(state) } catch (error) { errors.push(error) }
      if (errors.length) throw closeError(errors)
    })().then(completed.resolve, error => {
      // Record before deleting the in-flight entry: global/project shutdown
      // may take its snapshot immediately after this finalizer finishes.
      closeFailures.set(state, error)
      completed.reject(error)
    }).finally(() => {
      if (closingRealms.get(state) === pending) closingRealms.delete(state)
    })
    return pending
  }

  function close(): Promise<void> {
    if (closed) return closed
    closing = true
    const completed = Promise.withResolvers<void>()
    closed = completed.promise
    const errors = []
    try { control.close() } catch (error) { errors.push(error) }
    const preparing = [...opening.values()]
    void (async () => {
      // Opening rejection can be an expected account/service cancellation.
      // Its real archive/host cleanup failures are separately retained above.
      await Promise.allSettled(preparing)
      const work = new Set([...closingRealms.values()])
      for (const state of [...realms.values()]) work.add(closeRealm(state, false))
      try { await joinClosures(work) } catch (error) { errors.push(error) }
      // Release only after every started realm close has actually settled.
      try { control.releaseFileViews() } catch (error) { errors.push(error) }
      const failures = [...new Set([...errors, ...priorCloseFailures()])]
      if (failures.length) throw closeError(failures)
    })().then(completed.resolve, completed.reject)
    return closed
  }

  return {
    handle,
    retireDocument: id => control.retireDocument(id),
    finishDocument: id => control.finishDocument(id),
    async withConversationScope(userId, file, operation) {
      const state = await realm(userId), item = await locate(state, legacy.path(file))
      return state.scope(operation, item?.metadata)
    },
    async accountChanged() {
      accountRevision++
      // Every opening already registered here belongs to an older revision.
      // A new account may open while these settle; the filter below preserves it.
      await Promise.allSettled([...opening.values()])
      const matches = state => state.account !== identity() || state.revision !== accountRevision
      const work = new Set([...closingRealms].filter(([state]) => matches(state)).map(([,promise]) => promise))
      for (const state of [...realms.values()].filter(matches)) work.add(closeRealm(state, true))
      await joinClosures(work, priorCloseFailures(matches))
      const failures = priorCloseFailures(matches)
      if (failures.length) throw closeError(failures)
    },
    async prepareProjectRemoval(userId, project) {
      removingProjects.add(JSON.stringify([userId,project]))
      const preparing = [...opening].filter(([key]) => { const owner = openingProjects.get(key); return owner?.userId === userId && owner.project === project }).map(([,promise]) => promise)
      await Promise.allSettled(preparing)
      const matches = state => state.userId === userId && state.project === project
      const work = new Set([...closingRealms].filter(([state]) => matches(state)).map(([,promise]) => promise))
      for (const state of [...realms.values()].filter(matches)) work.add(closeRealm(state, true))
      await joinClosures(work, priorCloseFailures(matches))
      const failures = priorCloseFailures(matches)
      if (failures.length) throw closeError(failures)
    },
    cancelProjectRemoval(userId, project) { removingProjects.delete(JSON.stringify([userId,project])) },
    finishProjectRemoval(userId, project) {
      let names = []
      try { names = readdirSync(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
      for (const name of names) {
        const match = /^([0-9a-f]{64})\.scope\.json$/.exec(name)
        if (!match) continue
        let owner; try { owner = JSON.parse(readFileSync(join(directory,name),'utf8')) } catch { continue }
        if (owner.userId !== userId || owner.project !== project) continue
        for (const suffix of ['.sqlite','.sqlite-wal','.sqlite-shm','.scope.json']) rmSync(join(directory,match[1]+suffix),{force:true})
      }
      removingProjects.delete(JSON.stringify([userId,project]))
    },
    close,
  }
}
