import { createHash } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, LiveDoc, InboxDoc } from '@earendil-works/pi-durable'
import { readAgentActivity } from './agent-subagents.ts'

const Archive = defineDoc({ kind: 'miaoimg.archive', version: 1, scope: 'conversation', history: 'latest', fork: 'initial', initial: () => ({ tail: 0, header: '' }) })
export const agentArchiveHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// The private Pi database remains authoritative. This completed-state mirror is
// an ordinary workspace file, so existing project backup/sync keeps working.
// Mirrors never submit input, resume a model, or restore an in-flight operation.
export function createAgentArchive({ host, metadataDoc, snapshot, read, revision, write, remove, cleanupSource, writeScope }: Record<string, any>) {
  const dirty = new Set()
  let timer, pending = Promise.resolve(), stopped = false, retryDelay = 300
  function schedule() {
    if (stopped || timer) return
    timer = setTimeout(() => { timer = undefined; void flush().catch(error => { console.warn('[agent-archive]', String(error.message).slice(0, 200)); retryDelay = Math.min(60000, Math.max(5000, retryDelay * 2)); schedule() }) }, retryDelay)
    timer.unref()
  }
  const unsubscribe = host.harness.subscribeCommits(publication => {
    for (const change of publication.changes) {
      if (change.type === 'entry') dirty.add(change.value.conversationId)
      if (change.type === 'task' && change.value.state.status === 'terminal') dirty.add(change.value.conversationId)
      if (change.type === 'document' && change.conversationId && change.record.kind !== Archive.definition.kind && (change.record.kind === metadataDoc.definition.kind || change.record.kind === LiveDoc.definition.kind)) dirty.add(change.conversationId)
    }
    if (dirty.size) schedule()
  })
  async function save(id) {
    const metadata = await host.harness.snapshot(metadataDoc, id, context)
    if (!metadata?.file) return
    if (metadata.parentId) dirty.add(metadata.parentId)
    if (metadata.deleted) {
      await writeScope(async () => { await remove(metadata.file); cleanupSource?.(metadata.sourceSessionFile) })
      return
    }
    const live = await host.harness.snapshot(LiveDoc, id, context), inbox = await host.harness.snapshot(InboxDoc, id, context)
    if (live?.run || live?.compactions?.length || inbox?.items.some(item => 'content' in item)) return
    const conversation = await host.conversation(id)
    const tail = (await conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id || 0
    const full = await snapshot(id, metadata)
    const activity = await readAgentActivity(host.harness, id, metadata, live, context)
    // A background child may still be preparing while LiveDoc has no run yet.
    // Preserve that observation too; import must not infer completion from an
    // idle transcript or restart the queued operation on another installation.
    full.lastFailure = activity.failure
    const savedActivity = { status: activity.status, result: String(activity.result || '').slice(0, 4000) }
    const header = agentArchiveHash([metadata.name,metadata.providerId,metadata.modelId,metadata.thinkingLevel,metadata.parentFile,metadata.presentationRevision,metadata.memoryEnabled,full.lastFailure,full.subAgents,savedActivity])
    const previous = await host.harness.snapshot(Archive, id, context)
    const currentRevision = revision ? await writeScope(() => revision(metadata.file)) : undefined
    if (previous?.tail === tail && previous.header === header && (!revision || previous.revision === currentRevision)) return
    const native = await conversation.context(context)
    const messages = full.messages
    const restoredMetadata = Object.fromEntries(['canvasId','locale','teamName','teamMember','delegationDepth','lastUserAnswer','memoryEnabled'].filter(key => metadata[key] !== undefined).map(key => [key,metadata[key]]))
    const checkpoint = { version: 1, timelineId: metadata.timelineId || '', uiHash: agentArchiveHash(messages), metadata: restoredMetadata, activity: savedActivity, context: native.messages.filter(message => ['user','assistant','toolResult'].includes(message.role)) }
    // Snapshot and context are separate native reads. Do not publish a mixed
    // checkpoint if another admission or deletion landed between them.
    const currentMetadata = await host.harness.snapshot(metadataDoc, id, context)
    const currentLive = await host.harness.snapshot(LiveDoc, id, context), currentInbox = await host.harness.snapshot(InboxDoc, id, context)
    const currentTail = (await conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id || 0
    const currentActivity = await readAgentActivity(host.harness, id, currentMetadata, currentLive, context)
    if (currentMetadata.deleted || currentLive?.run || currentLive?.compactions?.length || currentInbox?.items.length || currentTail !== tail || JSON.stringify(currentMetadata) !== JSON.stringify(metadata) || JSON.stringify(currentActivity) !== JSON.stringify(activity)) { dirty.add(id); return }
    const saved = await writeScope(async () => {
      const current = await read(metadata.file)
      if (current?.messages) {
        const hash = agentArchiveHash(current.messages)
        const own = current.nativeCheckpoint?.timelineId === (metadata.timelineId || '') && current.nativeCheckpoint?.uiHash === hash
        const imported = metadata.sourceUiHash === hash
        if (!own && !imported) {
          // Preserve concurrent changes from another installation before
          // replacing our generated projection. Recovery copies are idempotent.
          const recoveredPath = `agent/recovered-${agentArchiveHash([metadata.file,current]).slice(0,32)}.json`
          if (!(await read(recoveredPath))) {
            const recovered = { ...current, name: `${current.name || metadata.name}（同步记录）`, parentFile: '', recoveredFrom: metadata.file }
            delete recovered.agentSessionFile; delete recovered.agentSessionSeeded
            if (recovered.nativeCheckpoint?.uiHash !== hash) delete recovered.nativeCheckpoint
            await write(recoveredPath, recovered)
          }
        }
      }
      const archive = { ...(current || {}), ...full, task: metadata.task || '', createdAt: metadata.createdAt, updatedAt: metadata.updatedAt || metadata.createdAt, messages, running: false, pendingInputs: [], nativeCheckpoint: checkpoint }
      delete archive.nativeId; delete archive.historyCursor; delete archive.agentSessionFile; delete archive.agentSessionSeeded
      await write(metadata.file, archive)
      return { revision: await revision?.(metadata.file) }
    })
    if (saved) await host.harness.commit(async tx => { const state = await tx.doc(Archive, id); state.tail = tail; state.header = header; if (revision) state.revision = saved.revision }, context)
  }
  async function flush() {
    const next = pending.catch(() => {}).then(async () => {
      const processed = new Set()
      let failure
      // Include newly dirtied ancestors in this flush, including app shutdown.
      // Concurrent changes to an already processed item belong to the next one.
      for (;;) {
        const batch = [...dirty].filter(id => !processed.has(id))
        if (!batch.length) break
        for (const id of batch) { dirty.delete(id); processed.add(id); try { await save(id) } catch (error) { dirty.add(id); failure = error } }
      }
      if (failure) throw failure
      retryDelay = 300
      if (dirty.size) schedule()
    })
    pending = next
    return next
  }
  return {
    mark(ids) { for (const id of ids) dirty.add(id); schedule() },
    flush,
    async close() { stopped = true; clearTimeout(timer); unsubscribe(); await pending.catch(() => {}); await flush().catch(error => console.warn('[agent-archive] 退出时保留待备份记录', String(error.message).slice(0,200))) },
  }
}
