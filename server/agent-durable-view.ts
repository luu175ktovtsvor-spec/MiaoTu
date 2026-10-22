// Presentation only. Pi owns context, tools, inbox, compaction and execution.
// Never send model image payloads or provider credentials to the chat observer.
const textOf = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n\n')
const summary = message => typeof message.details?.publicSummary === 'string' ? message.details.publicSummary : textOf(message.content).slice(0, 8000)
function projectHistory(metadata, entries, running, retrying) {
  const entryKey = id => metadata.timelineId ? `e:${metadata.timelineId}:${id}` : `e:${id}`
  const messages = [], toolParts = new Map()
  const hidden = new Set(entries.filter(entry => entry.kind === 'miaoimg.edit').flatMap(entry => entry.data.hidden || []))
  const visible = entries.filter(entry => !hidden.has(entry.id) && !['miaoimg.edit','miaoimg.child-context','miaoimg.import','pi.compaction','pi.reset','pi.system'].includes(entry.kind))
  const activeAssistant = running ? visible.findLast(entry => entry.model?.some(message => message.role === 'assistant'))?.id : undefined
  const retryAttempts = new WeakSet()
  let followingRole = retrying ? 'assistant' : undefined
  for (const entry of [...visible].reverse()) for (const message of [...(entry.model || [])].reverse()) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    if (message.role === 'assistant' && message.stopReason === 'error' && followingRole === 'assistant') retryAttempts.add(message)
    followingRole = message.role
  }
  // Stable native entry IDs survive reconnect, model switch and compaction.
  for (const entry of visible) {
    if (entry.kind === 'miaoimg.history-reset') { messages.length = 0; toolParts.clear(); messages.push(...(entry.data.messages || [])); continue }
    if (entry.kind === 'miaoimg.import-ui') { messages.push(...(entry.data.messages || [])); continue }
    if (entry.kind === 'miaoimg.report') {
      const id = entryKey(entry.id)
      messages.push({ id, role: 'assistant', content: entry.data.content, parts: [{ id, type: 'text', content: entry.data.content }], report: { file: entry.data.file, name: entry.data.name } })
      continue
    }
    for (const [index, message] of (entry.model || []).entries()) {
      const id = `${entryKey(entry.id)}:${index}`
      if (message.role === 'user') {
        const data = entry.kind === 'miaoimg.user' ? entry.data || {} : {}
        messages.push({ id: data.id || id, entryId: id, role: 'user', content: data.content ?? textOf(message.content), mentions: data.mentions || [], attachments: data.attachments || [] })
      } else if (message.role === 'assistant') {
        const retry = retryAttempts.has(message)
        const item = assistant(retry ? { ...message, stopReason: 'stop' } : message, id, false, toolParts, entry.id === activeAssistant)
        if (retry && !item.parts.some(part => part.type === 'tool' || part.content.trim())) continue
        item.entryId = id
        messages.push(item)
      } else if (message.role === 'toolResult') {
        const part = toolParts.get(message.toolCallId)
        // Pi distinguishes an uncertain interrupted side effect from a confirmed
        // tool failure. Keep that distinction without interpreting error prose.
        const outcomeUnknown = message.isError && entry.kind === 'pi.tool-result'
          && entry.data?.diagnostics?.some(diagnostic => diagnostic.severity === 'error' && diagnostic.code === 'interrupted')
        if (part) Object.assign(part.tool, { status: outcomeUnknown ? 'interrupted' : message.isError ? 'error' : 'success', result: summary(message), ...(outcomeUnknown ? { outcomeUnknown: true } : {}) })
      }
    }
  }
  const children = new Map()
  for (const part of toolParts.values()) collectChildren(children, part)
  for (const entry of visible) if (entry.kind === 'miaoimg.report' && children.has(entry.data.file)) {
    const child = children.get(entry.data.file)
    children.set(entry.data.file, { ...child, status: entry.data.status || child.status, result: entry.data.content })
  }
  const edited = entries.findLast(entry => ['miaoimg.edit','miaoimg.history-reset'].includes(entry.kind))
  const compacted = entries.findLast(entry => entry.kind === 'pi.compaction' && (!edited || entry.id > edited.id))
  const head = entries.findLast(entry => entry.head !== undefined)
  const lastEntry = visible.findLast(entry => entry.model?.some(message => message.role === 'assistant' && message.usage))
  const last = !head || lastEntry?.id > head.id ? lastEntry?.model?.find(message => message.role === 'assistant' && message.usage) : undefined
  const contextTokens = last ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + Number(last.usage[key] || 0), 0) : null
  return { entries, timelineId: metadata.timelineId, running, retrying, messages, children, compacted, contextTokens, historyRevision: edited?.id || metadata.presentationRevision || 0 }
}

function collectChildren(children, part) {
  if (!['subAgent','delegate'].includes(part.tool.name)) return
  try { for (const child of JSON.parse(part.tool.result || '{}').tasks || []) if (child.file) children.set(child.file, { ...child, task: child.task || '' }) } catch {}
}

export function projectAgentView(metadata, entries, docs, options: { cache?: any; limit?: number } = {}) {
  const live = docs['pi.live'] || {}, inbox = docs['pi.inbox']?.items || []
  const running = !!live.run, retrying = !!(live.generation?.retry || live.run && live.generation?.attempt > 1)
  let history = options.cache?.history
  if (!history || history.entries !== entries || history.timelineId !== metadata.timelineId || history.running !== running || history.retrying !== retrying) {
    history = projectHistory(metadata, entries, running, retrying)
    if (options.cache) options.cache.history = history
  }
  // Committed history is immutable until an entry changes. Streaming frames
  // copy only the visible window and overlay current tool progress onto it.
  const start = options.limit ? Math.max(0, history.messages.length - options.limit) : 0
  let messages = history.messages.slice(start).map(message => ({ ...message, ...(message.parts ? { parts: message.parts.map(part => part.type === 'tool' ? { ...part, tool: { ...part.tool } } : part) } : {}) }))
  const toolParts = new Map()
  for (const message of messages) for (const part of message.parts || []) if (part.type === 'tool') toolParts.set(part.tool.id, part)
  if (live.generation?.message) {
    const message = live.generation.message
    const id = `live:${live.run?.taskId}:${live.generation.attempt}:${message.timestamp}`
    const retry = message.stopReason === 'error' && live.run
    const item = assistant(retry ? { ...message, stopReason: 'stop' } : message, id, true, toolParts)
    if (!retry || item.parts.some(part => part.type === 'tool' || part.content.trim())) messages.push(item)
  }
  for (const slot of live.tools || []) {
    const part = toolParts.get(slot.callId)
    if (!part) continue
    if (slot.status !== 'done') part.tool.status = 'running'
    if (slot.output) part.tool.result = slot.output.slice(-8000)
    if (slot.details?.kind === 'question' && slot.status !== 'done') part.tool.question = { ...slot.details, callId: `q:${metadata.nativeId}:${slot.taskId}` }
    if (slot.details?.kind === 'subAgents') part.tool.result = JSON.stringify({ tasks: slot.details.tasks })
    if (slot.details?.publicSummary) part.tool.result = slot.details.publicSummary
  }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  for (const group of Object.values(docs['pi.usage'] || {})) for (const usage of Object.values(group)) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) tokens[key] += Number(usage[key] || 0)
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  const { compacted, contextTokens } = history
  const answeredSubmissions = new Set(metadata.answeredSubmissionIds || [])
  const inputs = inbox.filter(item => 'content' in item)
  const answered = item => answeredSubmissions.has(item.id) || metadata.lastUserAnswer?.inputId && item.entry?.data?.id === metadata.lastUserAnswer.inputId
  // A tool can accept an answer before Pi places that input in the transcript.
  // Carry its receipt even when coalescing skipped the brief queued projection.
  const answeredInputIds = inputs.filter(answered).map(item => item.entry?.data?.id || `submission:${item.id}`)
  const pendingInputs = inputs.filter(item => !answered(item)).map(item => ({ id: item.entry?.data?.id || `submission:${item.id}`, entryId: item.entry?.data?.id || `submission:${item.id}`, submissionId: item.id, mode: item.mode, role: 'user', content: item.entry?.data?.content ?? textOf(item.content), mentions: item.entry?.data?.mentions || [], attachments: item.entry?.data?.attachments || [] }))
  const children = new Map<string, any>(history.children)
  for (const slot of live.tools || []) { const part = toolParts.get(slot.callId); if (part) collectChildren(children, part) }
  const messageCount = start + messages.length
  if (options.limit) messages = messages.slice(-options.limit)
  return { engine: 'pi-durable', historyRevision: history.historyRevision, nativeId: metadata.nativeId, file: metadata.file, name: metadata.name, providerId: metadata.providerId, modelId: metadata.modelId, thinkingLevel: metadata.thinkingLevel || 'off', canvasId: metadata.canvasId || '', messages, ...(options.limit ? { messageCount, historyCursor: messageCount > messages.length ? messages[0]?.id : null } : {}), pendingInputs, answeredInputIds, subAgents: [...children.values()].map(child => ({ ...child, parentFile: metadata.file })), ...(metadata.parentFile ? { parentFile: metadata.parentFile } : {}), running: !!live.run, compacting: !!live.compactions?.length, retrying: live.generation?.retry ? { source: 'model', attempt: live.generation.attempt } : null, stats: { tokens }, contextUsage: { tokens: contextTokens, contextWindow: metadata.contextWindow || 1000000, percent: contextTokens === null ? null : contextTokens / (metadata.contextWindow || 1000000) * 100 }, ...(live.compactionFailure ? { lastCompaction: { status: 'failed', reason: live.compactionFailure.reason } } : compacted ? { lastCompaction: { status: 'completed', reason: compacted.data.reason } } : {}) }
}
function assistant(message, id, streaming, tools, active = streaming) {
  const parts = (message.content || []).flatMap((part, index) => {
    const partId = `${id}:${index}`
    if (part.type === 'text') return [{ id: partId, type: 'text', content: part.text || '' }]
    if (part.type === 'thinking') return [{ id: partId, type: 'thinking', content: part.thinking || '', collapsed: true }]
    if (part.type !== 'toolCall') return []
    const item = { id: partId, type: 'tool', tool: { id: part.id, name: part.name, args: part.arguments || {}, status: active ? 'running' : 'interrupted' } }
    tools.set(part.id, item)
    return [item]
  })
  return { entryId: id, id, role: 'assistant', content: parts.filter(part => part.type === 'text').map(part => part.content).join('\n\n'), parts, streaming, ...(['error', 'aborted', 'length'].includes(message.stopReason) ? { error: message.stopReason === 'aborted' ? '本轮已停止，已完成的内容保留。' : message.stopReason === 'length' ? '回复达到模型单次输出上限，已完成的内容保留，可以继续。' : '模型连接中断，已收到的内容保留，可以继续。' } : {}) }
}
