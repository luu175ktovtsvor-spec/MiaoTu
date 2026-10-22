import { randomUUID } from 'node:crypto'
import { withAbortSignal } from '@earendil-works/chord/context'
import { AssistantEntry, InboxDoc, LiveDoc, configure, defineDoc, defineTask, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'

const Delegation = defineDoc({ kind: 'miaoimg.delegation', version: 1, scope: 'task', initial: () => ({ refs: [] }) })
const MessageJob = defineDoc({ kind: 'miaoimg.child-message', version: 1, scope: 'task', initial: () => ({ id: 0 }) })
const result = value => ({ output: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const text = message => (message?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n\n')

// Native receipts are authoritative even when preparation fails before the
// first model request. Metadata alone can stay "queued" forever in that case.
export async function readAgentActivity(api, id, metadata, live, context) {
  if (live?.run) return { status: live.tools?.some(tool => tool.name === 'askUser' && tool.status !== 'done') ? 'inputRequired' : 'running', result: '', failure: null }
  if (live?.compactions?.some(item => item.blocking || item.reason === 'manual')) return { status: 'running', result: '', failure: null }
  const job = metadata.jobTaskId ? await api.getTask(metadata.jobTaskId, context) : undefined
  const task = job || (await api.commit(tx => tx.scanTasks({ conversationId: id, kind: 'pi.generation', order: 'descending' }, 1), context)).items[0]
  if (task && metadata.historyTaskId && task.id <= metadata.historyTaskId) return { status: 'completed', result: '', failure: null }
  if (job?.state.status === 'terminal' || job?.state.checkpoint?.phase === 'wait' || !job && task?.state.status === 'terminal' && task.state.outcome.status !== 'completed') {
    const inbox = await api.snapshot(InboxDoc, id, context)
    if (inbox?.items.some(item => 'content' in item)) {
      const generation = job ? (await api.commit(tx => tx.scanTasks({ conversationId: id, kind: 'pi.generation', order: 'descending' }, 1), context)).items[0] : task
      if (generation?.state.status === 'terminal' && generation.state.outcome.status !== 'completed') {
        const message = generation.state.outcome.error?.detail?.reason === 'no_model'
          ? '当前模型不可用，后续补充仍保留在队列。修复模型设置后发送新消息即可继续，无需重复发送这些补充。'
          : '上一轮执行中断，后续补充仍保留在队列。处理失败原因后发送新消息即可继续，无需重复发送这些补充。'
        return { status: 'error', result: message, failure: { taskId: generation.id, message }, needsResume: true }
      }
    }
  }
  if (!task) return { status: metadata.importedFailure ? 'error' : metadata.status || 'completed', result: metadata.importedFailure?.message || metadata.result || '', failure: metadata.importedFailure || null }
  if (task.state.status !== 'terminal') return { status: 'queued', result: '', failure: null }
  const outcome = task.state.outcome
  if (outcome.status === 'aborted') return { status: 'cancelled', result: metadata.result || '', failure: null }
  if (outcome.status === 'completed') {
    if (job) return { status: outcome.result.status, result: outcome.result.result, failure: outcome.result.status === 'error' ? { taskId: task.id, message: '子任务未完成，请检查模型配置后重试。' } : null }
    return { status: metadata.status || 'completed', result: metadata.result || '', failure: null, answerEntryId: outcome.result.entryId }
  }
  const reason = outcome.error?.detail?.reason
  const message = job ? '子任务启动失败，请检查模型配置后重试。' : reason === 'no_model' ? '当前模型不可用，请检查模型设置后重新发送。' : reason === 'model_error' ? '模型请求未完成，已收到的内容保留，可以继续。' : '任务执行中断，已完成的内容保留，请重新发送以继续。'
  return { status: 'error', result: message, failure: { taskId: task.id, message } }
}

// Pi's background anchor pattern keeps a child independent of a caller's tool
// invocation. Only observations end when steering returns a waiting tool early.
// Explicit product Stop crosses the native background boundary.
export function createDurableSubagents({ host, metadataDoc, scope, catalog }: Record<string, any>) {
  async function waitForAdmission(runtime, childId, jobId, admitted, context) {
    const observation = new AbortController(), waitContext = withAbortSignal(observation.signal, context)
    const watch = await runtime.watchDoc(metadataDoc, childId, waitContext)
    if (!watch) throw new Error('子任务状态不存在')
    try {
      if (admitted(watch.value)) return
      const previous = await runtime.getTask(jobId, waitContext)
      if (!previous || previous.state.status === 'terminal' || previous.state.checkpoint?.phase === 'wait') return
      const ready = new Promise<void>(resolve => { watch.start(value => { if (admitted(value)) resolve() }) })
      await Promise.race([ready, runtime.waitForTask(jobId, waitContext)])
    } finally {
      // End the losing observation too; it must not retain a completion waiter
      // for the full duration of an already-admitted job or cancel that job.
      observation.abort()
      await watch.stop()
    }
  }
  const Anchor = defineTask({
    name: 'miaoimg.child-anchor', version: 1, initial: () => ({ phase: 'done' }),
    phases: { done: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context) },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })
  const Job = defineTask({
    name: 'miaoimg.child-job', version: 1, initial: () => ({ phase: 'admit' }),
    phases: {
      async admit(task: any, runtime, context) {
        if (task.input.after) {
          const previous = await runtime.getTask(task.input.after, context)
          if (previous && previous.state.status !== 'terminal') {
            await runtime.commit(() => ({ status: 'waiting', checkpoint: { phase: 'admit' }, on: [task.input.after], policy: 'allSettled' }), context)
            return
          }
        }
        if (task.input.afterAdmission) await waitForAdmission(runtime, task.input.childId, task.input.afterAdmission, value => value?.admittedJobId >= task.input.afterAdmission, context)
        let metadata = await runtime.snapshot(metadataDoc, task.input.childId, context)
        if (!task.input.initial && metadata.initialJobId && !metadata.initialAdmitted) {
          await waitForAdmission(runtime, task.input.childId, metadata.initialJobId, value => value?.initialAdmitted, context)
          metadata = await runtime.snapshot(metadataDoc, task.input.childId, context)
          if (!metadata.initialAdmitted) throw new Error('初始子任务未能启动，请查看子任务状态后处理')
        }
        await scope(async () => {
          await host.prepareConversation?.(metadata, task.input.childId, context)
          context.abortSignal?.throwIfAborted()
          const submission = await host.submit(task.input.childId, { requestId: `child-job:${task.id}`, content: task.input.initial ? task.input.message : `父任务补充（仅在原授权内执行）：\n${task.input.message}`, ...(!task.input.initial ? { data: { id: `parent:${task.id}`, content: task.input.message, source: 'parent' } } : {}) }, context)
          await runtime.commit(async tx => {
            const current = await tx.doc(metadataDoc, task.input.childId)
            if (task.input.initial) current.initialAdmitted = true
            const admittedJobId = typeof current.admittedJobId === 'number' ? current.admittedJobId : 0
            current.admittedJobId = Math.max(admittedJobId, task.id)
            return { status: 'running', checkpoint: { phase: 'wait', submissionId: submission.id } }
          }, context)
        }, metadata)
      },
      async wait(task: any, runtime, context) {
        const submission = await host.harness.submission(task.state.checkpoint.submissionId, context)
        if (!submission) throw new Error('子任务提交记录不存在')
        const settled = await submission.wait(context)
        await runtime.commit(async tx => {
          const metadata = await tx.doc(metadataDoc, task.input.childId)
          const answer = settled.status === 'done' ? await tx.entry(AssistantEntry, settled.answer) : undefined
          const message = answer?.model?.find(message => message.role === 'assistant')
          if (settled.status === 'done' && !message) throw new Error('子任务回答记录不存在，请重新读取任务状态')
          const output = { name: metadata.name, file: metadata.file, conversationId: task.input.childId, task: metadata.task || '', status: settled.status === 'done' ? message.stopReason === 'length' ? 'limited' : 'completed' : settled.reason === 'aborted' ? 'cancelled' : 'error', result: message ? text(message).slice(0, 50000) : settled.reason === 'aborted' ? '子任务已停止' : '子任务未完成，请检查模型配置后重试。' }
          return { status: 'terminal', outcome: { status: 'completed', result: output } }
        }, context)
      },
    },
    abort: (_task, runtime, context) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context),
  })

  async function childForFile(file, parentId, api, context) {
    if (host.resolveChildren) {
      const child = (await host.resolveChildren(parentId, [file], context))[0]
      const metadata = child && await api.snapshot(metadataDoc, child.id, context)
      if (metadata?.parentId === parentId && !metadata.deleted) return { id: child.id, metadata }
      throw new Error('子任务不属于当前对话或已删除')
    }
    let cursor
    do {
      const page = await api.commit(tx => tx.scanConversations({}, 200, cursor), context)
      for (const record of page.items) {
        const metadata = await api.snapshot(metadataDoc, record.id, context)
        if (metadata?.file === file && metadata.parentId === parentId && !metadata.deleted) return { id: record.id, metadata }
      }
      cursor = page.next
    } while (cursor)
    throw new Error('子任务不属于当前对话或已删除')
  }

  async function currentResult(ref, api, context) {
    const metadata = await api.snapshot(metadataDoc, ref.childId, context)
    const row = { name: metadata.name || ref.name, file: ref.file, conversationId: ref.childId, task: metadata.task || ref.task || '' }
    if (metadata.deleted) return { ...row, status: 'cancelled', result: '子任务已删除，不再将旧结果用于汇总。' }
    const live = await api.snapshot(LiveDoc, ref.childId, context)
    const activity = await readAgentActivity(api, ref.childId, metadata, live, context)
    let answer = activity.result
    if (['completed', 'limited'].includes(activity.status) && !metadata.jobTaskId) {
      // Pi keeps the yielded answer's immutable entry ID in its generation
      // receipt. Use it even if subsequent compaction removed it from context.
      const message = activity.answerEntryId
        ? (await api.commit(tx => tx.entry(AssistantEntry, activity.answerEntryId), context))?.model?.[0]
        : (await (await api.conversation(ref.childId, context)).context(context)).messages.findLast(message => message.role === 'assistant')
      answer = text(message).slice(0, 50000) || answer
    }
    return { ...row, status: activity.status, result: activity.status === 'cancelled' ? '子任务已停止，已有内容保留在子对话中。' : answer, ...(activity.needsResume ? { needsResume: true } : {}) }
  }

  async function waitForChildren(refs, api, context, interruptible = true) {
    const observation = new AbortController(), waitContext = withAbortSignal(observation.signal, context)
    const rows = refs.map(ref => ({ name: ref.name, file: ref.file, conversationId: ref.childId, task: ref.task, status: 'queued' }))
    const watches = []
    let finished = false
    let finishResume
    const resumeRequired = new Promise(resolve => { finishResume = resolve })
    const progress = async () => { if (!finished) await api.details({ kind: 'subAgents', tasks: rows }, context) }
    await progress()
    const completion = Promise.all(refs.map(async (ref, index) => {
      const checkForResume = async value => {
        if (finished || value?.run) return
        const metadata = await api.snapshot(metadataDoc, ref.childId, waitContext)
        const activity = await readAgentActivity(api, ref.childId, metadata, value, waitContext)
        if (!finished && activity.needsResume) finishResume('needsResume')
      }
      const live = await api.watchDoc(LiveDoc, ref.childId, waitContext)
      if (live) {
        watches.push(live)
        const update = async value => {
          if (finished) return
          const busy = value?.run || value?.compactions?.some(item => item.blocking || item.reason === 'manual')
          const status = busy ? value.tools?.some(tool => tool.name === 'askUser' && tool.status !== 'done') ? 'inputRequired' : 'running' : rows[index].status
          if (status !== rows[index].status) { rows[index].status = status; await progress() }
          await checkForResume(value)
        }
        await update(live.value); live.start(update)
      }
      // Admission can publish its checkpoint after a very fast model failure.
      // Observe that commit too, so an already-idle queued job cannot hang here.
      const metadata = await api.watchDoc(metadataDoc, ref.childId, waitContext)
      if (metadata) { watches.push(metadata); metadata.start(() => checkForResume(live?.value)); await checkForResume(live?.value) }
      if (ref.jobId) await api.waitForTask(ref.jobId, waitContext)
      // A job receipt can finish before a manual compaction or direct follow-up.
      // Pi's ordinary idle boundary includes that work and excludes background
      // maintenance; waiting here never resubmits the prompt or owns the work.
      await (await api.conversation(ref.childId, waitContext)).waitForIdle(waitContext)
      rows[index] = await currentResult(ref, api, waitContext)
      await progress()
    })).then(() => 'completed')
    // Always observe the loser, since ending this tool cancels only its waits.
    void completion.catch(() => {})
    let inbox, finishSteering
    const steering = new Promise <void>(resolve => { finishSteering = resolve })
    try {
      if (interruptible) {
        inbox = await api.watchDoc(InboxDoc, api.conversationId, waitContext)
        if (inbox) {
          const update = value => { if (value?.items.some(item => item.mode === 'steer' && 'content' in item)) finishSteering('steered') }
          update(inbox.value); inbox.start(update)
        }
      }
      const ended = await (interruptible ? Promise.race([completion, resumeRequired, steering]) : completion)
      finished = true
      // A member can receive new work while another member is still being
      // awaited. Re-read every latest receipt before returning the aggregate.
      const latest = await Promise.all(refs.map(ref => currentResult(ref, api, context)))
      const needsResume = latest.some(row => row.needsResume)
      const pending = ended === 'steered' || needsResume || latest.some(row => ['running', 'queued', 'inputRequired'].includes(row.status))
      return result({ tasks: latest, ...(pending ? { pending: true, instruction: ended === 'steered' ? '子任务继续运行。先处理刚收到的用户补充；需要向成员传达要求时用 messageSubAgent，汇总前用 waitSubAgents 等待完整结果。' : needsResume ? '部分子任务上一轮失败，补充仍保留在原队列。先处理失败原因；需要继续时追加新消息即可沿用队列，不要重复发送已排队内容。' : '子任务已有新的工作或待回答内容，尚未全部结束。先处理所需回答，汇总前再用 waitSubAgents 等待。' } : {}) })
    } finally {
      finished = true; observation.abort()
      await Promise.allSettled([...watches, ...(inbox ? [inbox] : [])].map(watch => watch.stop()))
    }
  }

  async function delegate(args, api, context) {
    const parent = await api.snapshot(metadataDoc, api.conversationId, context), parentAgent = await api.agent(context)
    const plans = await Promise.all(args.tasks.map(async (task, index) => {
      if (task.team && !host.delegation) throw new Error('当前运行器未配置此团队')
      return { ...task, index, ...(host.delegation ? await scope(() => host.delegation(task, parent, context), parent) : {}) }
    }))
    const refs = await api.commit(async tx => {
      if ((await tx.doc(metadataDoc, api.conversationId)).deleted) throw new Error('对话已删除')
      const saved = await tx.doc(Delegation, api.taskId)
      if (saved.refs.length) return JSON.parse(JSON.stringify(saved.refs))
      // Keep already-admitted foreground work when upgrading a paused preview.
      const previous = (await tx.scanConversations({ ownerTaskId: api.taskId }, 8)).items
      if (previous.length) {
        const legacy = []
        for (const child of previous) { const metadata = await tx.doc(metadataDoc, child.id); legacy.push({ childId: child.id, name: metadata.name, file: metadata.file, task: metadata.task, index: metadata.delegationIndex || 0, legacy: true }) }
        saved.refs = legacy.sort((left, right) => left.index - right.index)
        return JSON.parse(JSON.stringify(saved.refs))
      }
      const created = []
      for (const plan of plans) {
        const anchorId = await tx.createTask(Anchor, null, { conversationId: api.conversationId, ownership: { kind: 'conversation' }, background: true })
        const child = await tx.createConversation({ ownership: { kind: 'task', taskId: anchorId } })
        const metadata = await tx.doc(metadataDoc, child.id)
        const inherited = Object.fromEntries(['providerId','modelId','thinkingLevel','canvasId','locale','contextWindow','localDirectory','memoryEnabled'].filter(key => parent[key] !== undefined).map(key => [key, parent[key]]))
        Object.assign(metadata, inherited, plan.metadata || {}, { timelineId: randomUUID(), file: `agent/${randomUUID()}.json`, name: plan.name, task: plan.task, parentId: api.conversationId, parentFile: parent.file, delegationIndex: plan.index, status: 'queued', createdAt: new Date().toISOString() })
        const selected = host.tools.filter(tool => (plan.tools || parentAgent.tools.map(tool => tool.name)).includes(tool.name) || tool.name === 'report')
        await configure(tx, child.id, { tools: selected, ...(plan.instructions ? { instructions: plan.instructions } : {}) })
        const jobId = await tx.createTask(Job, { childId: child.id, initial: true, message: plan.task }, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true })
        metadata.jobTaskId = jobId; metadata.initialJobId = jobId; metadata.lastQueuedJobId = jobId
        created.push({ childId: child.id, jobId, file: metadata.file, name: plan.name, task: plan.task })
      }
      saved.refs = created
      return JSON.parse(JSON.stringify(saved.refs))
    }, context)
    if (refs.some(ref => ref.legacy)) {
      // Their original tool still owns them, so do not let it finish early.
      await Promise.all(refs.map(async (ref, index) => {
        const submission = await host.submit(ref.childId, { requestId: `delegate:${api.taskId}:${index}`, content: ref.task })
        await submission.wait(context)
      }))
    }
    return waitForChildren(refs, api, context, !refs.some(ref => ref.legacy))
  }

  const subAgent = defineTool({ name: 'subAgent', description: catalog.find(tool => tool.name === 'subAgent')?.description || '委派独立子任务。等待期间可接收用户补充，子任务由原生持久任务持有。', replay: 'safe', parameters: Type.Object({ tasks: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 80 }), task: Type.String({ minLength: 1, maxLength: 24000 }), team: Type.Optional(Type.String()) }), { minItems: 1, maxItems: 8 }) }), execute: delegate })
  const teamDelegate = defineTool({ name: 'delegate', description: '将工作交给当前团队清单中获准的成员，提供完整背景与已有授权。', replay: 'safe', parameters: Type.Object({ tasks: Type.Array(Type.Object({ member: Type.String(), task: Type.String({ minLength: 1, maxLength: 24000 }) }), { minItems: 1, maxItems: 8 }) }), execute: async (args, api, context) => {
    const metadata = await api.snapshot(metadataDoc, api.conversationId, context)
    if (!metadata?.teamName) throw new Error('当前任务没有团队')
    return delegate({ tasks: args.tasks.map(task => ({ name: task.member, task: task.task, member: task.member, team: metadata.teamName })) }, api, context)
  } })
  const message = defineTool({ name: 'messageSubAgent', description: '按接收顺序向自己的子 Agent 补充要求或回答其问题，尽量不中断当前工作。返回仅确认补充已保存，执行结果用 waitSubAgents 获取。file 使用 subAgent 或 waitSubAgents 返回的完整子对话路径。', replay: 'safe', parameters: Type.Object({ file: Type.String(), prompt: Type.String({ minLength: 1 }) }), execute: async (args, api, context) => {
    const child = await childForFile(args.file, api.conversationId, api, context)
    const id = await api.commit(async tx => {
      const parent = await tx.doc(metadataDoc, api.conversationId)
      if (parent.deleted || (await tx.doc(metadataDoc, child.id)).deleted) throw new Error('对话已删除')
      const state = await tx.doc(MessageJob, api.taskId)
      if (state.id) return state.id
      const metadata = await tx.doc(metadataDoc, child.id)
      metadata.memoryEnabled = parent.memoryEnabled !== false
      const afterAdmission = metadata.lastQueuedJobId || metadata.jobTaskId || metadata.initialJobId
      const id = await tx.createTask(Job, { childId: child.id, message: args.prompt, ...(afterAdmission ? { afterAdmission } : {}) }, { conversationId: child.id, ownership: { kind: 'conversation' }, background: true })
      state.id = id; metadata.jobTaskId = id; metadata.lastQueuedJobId = id; if (!metadata.initialAdmitted) metadata.status = 'queued'
      return id
    }, context)
    return result({ accepted: true, jobId: id, file: child.metadata.file })
  } })
  const wait = defineTool({ name: 'waitSubAgents', description: '等待指定子 Agent 的最新工作并获取结果。新用户补充到达时先返回当前进度，子任务继续执行；继续汇总前再次等待。', replay: 'safe', parameters: Type.Object({ files: Type.Array(Type.String(), { minItems: 1, maxItems: 8, uniqueItems: true }) }), execute: async (args, api, context) => {
    const refs = await Promise.all(args.files.map(async file => {
      const child = await childForFile(file, api.conversationId, api, context)
      const job = child.metadata.jobTaskId ? await api.getTask(child.metadata.jobTaskId, context) : undefined
      return { childId: child.id, jobId: job?.id, file, name: child.metadata.name, task: child.metadata.task }
    }))
    return waitForChildren(refs, api, context)
  } })
  const stop = defineTool({ name: 'stopSubAgent', description: '停止指定的所属子 Agent 及其子任务，保留已有成果。不会停止同级成员。', replay: 'unsafe', executionMode: 'sequential', parameters: Type.Object({ file: Type.String() }), execute: async (args, api, context) => {
    const child = await childForFile(args.file, api.conversationId, api, context)
    await host.stop(child.id)
    return result({ stopped: true, file: child.metadata.file })
  } })
  const status = defineTool({ name: 'getSubAgents', description: '读取所属子任务的当前进度或待回答状态，不等待任务结束。省略 files 返回前 100 个；指定 files 查询所需成员。', replay: 'safe', parameters: Type.Object({ files: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100, uniqueItems: true })) }), execute: async (args, api, context) => {
    const children = []
    if (args.files) for (const file of args.files) children.push(await childForFile(file, api.conversationId, api, context))
    else if (host.resolveChildren) children.push(...await host.resolveChildren(api.conversationId, undefined, context))
    else {
      let cursor
      do { const page = await api.commit(tx => tx.scanConversations({}, 200, cursor), context); for (const record of page.items) { const metadata = await api.snapshot(metadataDoc, record.id, context); if (metadata?.parentId === api.conversationId && !metadata.deleted) children.push({ id: record.id, metadata }); if (children.length >= 100) break } cursor = page.next } while (cursor && children.length < 100)
    }
    const tasks = await Promise.all(children.map(async child => {
      const live = await api.snapshot(LiveDoc, child.id, context)
      const activity = await readAgentActivity(api, child.id, child.metadata, live, context)
      return { name: child.metadata.name, file: child.metadata.file, task: child.metadata.task, status: activity.status, result: activity.result, ...(activity.needsResume ? { needsResume: true } : {}) }
    }))
    return result({ tasks, ...(children.length === 100 && !args.files ? { truncated: true, instruction: '指定所需的子任务 files 继续查询。' } : {}) })
  } })
  return { tools: [subAgent, teamDelegate, message, wait, stop, status], tasks: [Anchor, Job] }
}
