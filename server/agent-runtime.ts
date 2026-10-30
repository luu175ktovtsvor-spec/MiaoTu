// 妙图 Agent 运行时：直接嵌入 pi SDK 1.3.0，循环、会话、整理与重试交给 SDK；
// 宿主只负责工具、权限、持久化路径及界面事件映射。
//
// 终止语义完全由 SDK 决定，我们不设任何自创上限：
//   @earendil-works/pi-agent-core/dist/agent-loop.js runLoop()
//   - 助手消息不含 tool call → 正常结束（agent_end）
//   - stopReason === "error" | "aborted" → 立即收尾并返回
//   - stopReason === "length"（输出被截断）→ 该消息里的 tool call 全部判失败、不执行
//   - 上下文超限不是报错，是自动压缩（compaction_start / compaction_end）
//   - 工具返回 terminate:true 且整批如此 → 停止
import { existsSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from 'node:fs'
import { withReplyLanguage } from './reply-language.ts'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { calculateContextTokens, createAgentSession, DefaultResourceLoader, estimateTokens, getLastAssistantUsage, ModelRuntime, SessionManager, SettingsManager, shouldCompact, defineTool } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, lazyStream } from '@earendil-works/pi-ai'
import { VIDEO_REVIEW_CONTENT } from './video-review.ts'
import { DEFAULT_CONTEXT_WINDOW, RESPONSES_FALLBACK_INSTRUCTIONS, ownTextModelById, resolveTextModel, textChannelOf } from './text-model-registry.ts'
import { createCustomProviderFetch } from './provider-fetch.ts'

const PROTOCOL_ADAPTERS = {
  'openai-completions': () => import('@earendil-works/pi-ai/api/openai-completions'),
  'openai-responses': () => import('@earendil-works/pi-ai/api/openai-responses'),
  'anthropic-messages': () => import('@earendil-works/pi-ai/api/anthropic-messages'),
}
// 用 custom entry 把「我们的 entryId ↔ SDK 会话条目」挂上钩（上游用的是 miaoimgUserMessage）。
const USER_MESSAGE_ENTRY = 'miaoimgUserMessage'
export const AGENT_TOOL_USAGE = Symbol('miaoimg.agentToolUsage')

function textContent(content: unknown): string {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : ''
}

// 与注册表同一规则：模型自带 ?? 配置 ?? 1000000；界面分母也用解析后的模型值。
export function resolveContextWindow(raw) {
  return Number(raw) > 0 ? Number(raw) : Number(process.env.OIP_TEXT_CONTEXT_WINDOW) > 0 ? Number(process.env.OIP_TEXT_CONTEXT_WINDOW) : DEFAULT_CONTEXT_WINDOW
}

export async function createAgentModel({ providerId = 'miaoimg', baseUrl, apiKey, modelId, modelEntry, contextWindow, maxOutputTokens, thinking = false, parallelToolCalls, modelRuntime, runtimeProviderId, beforeRequest, beforeDispatch, fetchImpl }: Record<string, any>) {
  const entry = modelEntry || (providerId === 'miaoimg' ? ownTextModelById(modelId) : null)
  if (!entry || entry.id !== modelId || entry.provider !== providerId) throw new Error('模型未登记或供应商不匹配')
  const registered = resolveTextModel(entry, { contextWindow, maxOutputTokens })
  const runtimeBaseUrl = registered.protocol === 'anthropic-messages'
    ? String(baseUrl || '').replace(/\/v1\/?$/, '')
    : baseUrl
  const runtime = modelRuntime || await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const runtimeProvider = runtimeProviderId || providerId
  // Built-in origins are selected by the host, including its local relay.
  // Custom cloud providers retain public-DNS pinning. Both reject redirects.
  const providerFetch = providerId === 'miaoimg'
    ? createCustomProviderFetch({ allowPrivate: true, beforeDispatch, redirectMessage: '模型服务地址已变化，请联系妙图团队', ...(fetchImpl ? { fetchImpl } : {}) })
    : fetchImpl || createCustomProviderFetch({ beforeDispatch })
  runtime.registerProvider(runtimeProvider, {
    // ModelRuntime 的原生 adapter 会按这个 api 生成请求体、工具块、工具结果、SSE 事件和错误文本。
    // 这里故意不把 OpenAI Chat 的形状手工套到 Responses/Anthropic 上。
    api: registered.protocol,
    baseUrl: runtimeBaseUrl,
    // Responses 的系统提示使用顶层 instructions；其余形状交给对应 SDK adapter。
    streamSimple: (model, context, options) => lazyStream(model, async () => {
      options?.signal?.throwIfAborted()
      await beforeRequest?.(options?.signal)
      options?.signal?.throwIfAborted()
      const adapter = await PROTOCOL_ADAPTERS[registered.protocol]()
      return adapter.streamSimple(model, context, {
        ...options,
        ...(providerFetch ? { fetch: providerFetch } : {}),
        onPayload: async (payload) => {
          // 未声明上游上限的自定义模型不强行发送 SDK 兜底值；内置模型按注册表的明确规格发送。
          const publishedOutput = registered.sources?.maxOutputTokens && !String(registered.sources.maxOutputTokens).startsWith('兜底')
          if (!publishedOutput && registered.protocol !== 'anthropic-messages') {
            delete payload.max_output_tokens
            delete payload.max_completion_tokens
            delete payload.max_tokens
          }
          if (registered.protocol !== 'openai-responses') return registered.protocol === 'openai-completions' && parallelToolCalls !== undefined && payload.tools?.length ? { ...payload, parallel_tool_calls: parallelToolCalls } : payload
          const tools = Array.isArray(payload.tools) ? payload.tools : []
          if (tools.length > 350) throw new Error('Responses 协议最多支持 350 个工具')
          // pi 1.x normalizes the system prompt into transcript messages before
          // invoking a provider. Read the SDK's serialized prompt rather than
          // replacing the Agent/compaction instructions with a generic fallback.
          const instructions = Array.isArray(payload.input) ? payload.input
            .filter(item => item.role === 'system' || item.role === 'developer')
            .map(item => typeof item.content === 'string' ? item.content : (item.content || []).map(part => part.text || '').join('\n'))
            .filter(Boolean).join('\n\n') : ''
          const input = Array.isArray(payload.input)
            ? payload.input.filter(item => item.role !== 'system' && item.role !== 'developer')
            : payload.input
          // 每轮重放 SDK 转换后的完整历史（含 function_call 和输出），保持 Responses 语义。
          // 为什么是"一律"而不是按通道判断：见 TEXT_CHANNELS 里 responsesStateless 的说明。
          const stateless = textChannelOf(registered).responsesStateless === true
          const previous = !stateless && [...(context.messages || [])].reverse().find(message =>
            message?.role === 'assistant' && (message.responseId || message.response_id))
          const previousResponseId = previous?.responseId || previous?.response_id
          const continuation = previousResponseId && Array.isArray(input)
            ? (() => {
                const outputs = input.filter(item => item.type === 'function_call_output')
                return outputs.length ? outputs : input.filter(item => item.role === 'user').slice(-1)
              })()
            : input
          const { previous_response_id: _previous, ...requestPayload } = payload
          return {
            ...requestPayload,
            // Responses may normalize omitted strict into strict mode, making optional
            // node selectors mandatory. Preserve the tool's declared JSON Schema;
            // browser-side validation still checks every operation before applying it.
            ...(tools.length ? { tools: tools.map(tool => tool.type === 'function' && tool.strict === undefined ? { ...tool, strict: false } : tool) } : {}),
            input: continuation,
            // 永远带 instructions：空着的话云枢会注入它自己的 Codex 系统提示。
            instructions: instructions || context.systemPrompt || RESPONSES_FALLBACK_INSTRUCTIONS,
            ...(tools.length ? { parallel_tool_calls: parallelToolCalls !== false, tool_choice: payload.tool_choice || 'auto' } : {}),
            ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            store: !stateless,
          }
        },
      })
    }),
    models: [{
      id: modelId, name: registered.label,
      reasoning: Boolean(registered.reasoning || thinking),
      input: registered.input || ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: registered.contextWindow,
      maxTokens: registered.maxOutputTokens,
      ...(registered.compat ? { compat: registered.compat } : {}),
      ...(registered.thinkingLevelMap ? { thinkingLevelMap: registered.thinkingLevelMap } : {}),
    }],
  })
  await runtime.setRuntimeApiKey(runtimeProvider, apiKey)
  console.log(`[agent:model] ${modelId} protocol=${registered.protocol} contextWindow=${registered.contextWindow} maxOutputTokens=${registered.maxOutputTokens} sources=${JSON.stringify(registered.sources)}`)
  return { runtime, model: runtime.getModel(runtimeProvider, modelId), registered }
}

// 把妙图的工具（画布工具在浏览器执行、服务端工具本地执行）按上游的注册方式接进去：
// defineTool + tools 白名单 + customTools，三者缺一不可。
export function toSdkTools(definitions, run) {
  return definitions.map(definition => defineTool({
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    async execute(toolCallId, params, signal, onUpdate) {
      const text = await run(definition, params || {}, { toolCallId, signal, onUpdate })
      return { content: text?.[VIDEO_REVIEW_CONTENT] || [{ type: 'text' as const, text: typeof text === 'string' ? text : JSON.stringify(text ?? null) }], ...(text?.[AGENT_TOOL_USAGE] ? { usage: text[AGENT_TOOL_USAGE] } : {}), details: text?.summary ? { publicSummary: typeof text.summary === 'string' ? text.summary : JSON.stringify(text.summary) } : {} }
    },
  }))
}

// 删除消息后让模型记忆与界面严格一致：直接丢弃 SDK 会话，下一轮按修正后的历史重新播种。
//
// 为什么不是 branch()：会话是追加式树，branch(id) 的语义是「叶子挪到 id，此后新内容另起分支」，
// 也就是被删位置之后的内容只能一起丢——做不到「删中间一条、保留后面」。而界面是照常保留后面的，
// 那就会出现「界面上还有、模型却不记得」的不一致（看起来像 bug）。
// 重建的代价是历史段的工具调用细节变粗（只剩文本），这与旧对话播种的代价是同一个，已接受。
export function isSafeAgentSessionFile(sessionDir, sessionFile) {
  const raw = String(sessionFile || '')
  // SDK 返回绝对文件名；只接受用户目录内的普通文件，不解码用户 JSON 里的路径。
  if (!String(sessionDir || '').trim() || !raw || !isAbsolute(raw) || raw.includes('\0') || raw.includes('%')) return false
  const root = resolve(String(sessionDir || ''))
  const target = resolve(raw)
  const within = relative(root, target)
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return false
  try {
    if (lstatSync(root).isSymbolicLink()) return false
    let current = root
    for (const part of within.split(sep)) {
      current = join(current, part)
      if (lstatSync(current).isSymbolicLink()) return false
    }
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    const realRelative = relative(realRoot, realTarget)
    if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return false
    const stat = lstatSync(target)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function resetAgentSession(sessionFile, sessionDir = '') {
  const target = String(sessionFile || '')
  if (!isSafeAgentSessionFile(sessionDir, target) || !existsSync(target)) return false
  try { unlinkSync(target); return true } catch { return false }
}

// 一个回合：建/复用 SDK 会话，订阅事件并映射成妙图的 NDJSON 协议（对照上游 runtime/index.ts:270-340）。
export async function runAgentTurn({
  runtime, model, cwd, sessionDir, sessionFile, systemPrompt, tools, prompt, images, signal, send, thinkingLevel,
  userEntryId, userMessage, resendFrom, history, persistSession = true, onSessionFile, completionCheck, onReady, onSteeringApplied, customMessages = [], compactOnly = false,
}: Record<string, any>) {
  // 已有会话文件就续用（跨轮记忆），否则新建；cwd 用独立目录，避免把仓库的 AGENTS.md 扫进模型上下文。
  if (sessionDir) mkdirSync(sessionDir, { recursive: true })
  const hasSession = isSafeAgentSessionFile(sessionDir, sessionFile)
  const sessionManager = !persistSession ? SessionManager.inMemory(cwd) : hasSession
    ? SessionManager.open(sessionFile, undefined, cwd)
    : SessionManager.create(cwd, sessionDir)
  if (persistSession && onSessionFile) {
    try { await onSessionFile(sessionManager.getSessionFile()) }
    catch (error) { if (!hasSession) resetAgentSession(sessionManager.getSessionFile(), sessionDir); throw error }
  }
  // 旧对话播种：线上已有对话没有会话文件，不播种的话模型会突然不记得这段对话（用户可见回归）。
  // 只在「本次真的新建了会话文件」时做一次，播完由调用方落一个标记，重复进入不会播两遍。
  let seeded = false
  if (!hasSession && Array.isArray(history) && history.length) {
    // 形状按 SDK 类型定义：UserMessage.timestamp 必填；AssistantMessage 另需 api/provider/model。
    const now = Date.now()
    for (const [index, item] of history.entries()) {
      const text = String(item?.content || '').trim()
      if (!text || (item.role !== 'user' && item.role !== 'assistant')) continue
      const stamp = now - (history.length - index) * 1000
      sessionManager.appendMessage(item.role === 'user'
        ? { role: 'user', content: [{ type: 'text', text }], timestamp: stamp }
        : { role: 'assistant', content: [{ type: 'text', text }], api: model?.api, provider: model?.provider, model: model?.id, stopReason: 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: stamp })
    }
    seeded = true
  }
  // 重发：把会话叶子挪到「被重发的那条用户消息」之前，之后新消息自然成为新分支，旧分支保留。
  // 对齐上游 runtime/index.ts:364 `history.branch(resendEntry.parentId)`；我们的 entryId 靠
  // miaoimgUserMessage 这条 custom entry 反查（照上游 miaoimgUserMessage 的做法）。
  if (resendFrom) {
    const marker = sessionManager.getBranch().find((item: any) =>
      item.type === 'custom' && item.customType === USER_MESSAGE_ENTRY && item.data?.messageId === resendFrom)
    if (!marker) throw Object.assign(new Error('重发消息不在当前对话中，请重新打开对话'), { status: 400 })
    sessionManager.branch(marker.parentId ?? marker.id)
  }
  // 记下本轮的我们的 entryId（含用户原文与引用），供之后重发/删除反查。
  if (userEntryId) {
    sessionManager.appendCustomEntry(USER_MESSAGE_ENTRY, {
      messageId: userEntryId,
      content: userMessage?.content ?? '',
      mentions: userMessage?.mentions ?? [],
      attachments: userMessage?.attachments ?? [],
    })
  }
  // 系统提示词按上游方式注入（runtime/resources.ts）：走 ResourceLoader，其余自动载入全部关闭。
  // 保留 SDK 默认 enabled=true / reserveTokens=16384 / keepRecentTokens=20000。
  const contextWindow = Number(model?.contextWindow) || 0
  const settingsManager = SettingsManager.inMemory()
  const compaction = settingsManager.getCompactionSettings()
  console.log(`[agent] 上下文窗口=${contextWindow} 压缩预算 reserve=${compaction.reserveTokens} keepRecent=${compaction.keepRecentTokens} 阈值=${contextWindow - compaction.reserveTokens}`)
  const agentDir = join(cwd, '.agent')
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: '',
    systemPromptOverride: () => withReplyLanguage(systemPrompt),
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    modelRuntime: runtime,
    model,
    sessionManager,
    noTools: 'all',
    tools: tools.map(tool => tool.name),
    customTools: tools,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  })
  // 安全自检：这是个 coding-agent SDK，自带 bash / 读写文件等工具，托管产品绝不能把这些交给模型。
  // 断言会话里可用的工具 == 我们注册的白名单，不多不少；不一致直接失败，不放行。
  const expected = tools.map(tool => tool.name).slice().sort()
  const actual = [...(session.getActiveToolNames() || [])].slice().sort()
  const selfCheck = { expected, actual, ok: JSON.stringify(expected) === JSON.stringify(actual) }
  console.log(`[agent] 工具白名单自检 ${selfCheck.ok ? 'PASS' : 'FAIL'} 期望=${expected.join(',')} 实际=${actual.join(',')}`)
  if (!selfCheck.ok) {
    session.dispose?.()
    throw Object.assign(new Error(`工具白名单自检失败：期望 ${expected.join(', ')}，实际 ${actual.join(', ')}`), { status: 500 })
  }

  // 诊断：压缩闸门实际看到的数字。用 SDK 自己导出的 estimateTokens / calculateContextTokens /
  // shouldCompact 复算，不改 SDK 任何东西——目的是分清「消息是空的」还是「每条都估算成 0」。
  const probeCompaction = label => {
    if (process.env.OIP_AGENT_PROBE_COMPACTION !== '1') return
    const settings = settingsManager.getCompactionSettings()
    const state = session.agent?.state?.messages || []
    const window = Number(session.model?.contextWindow) || 0
    const charSum = state.reduce((sum, message) => sum + estimateTokens(message), 0)
    const usage = getLastAssistantUsage(sessionManager.getBranch())
    const usageTokens = usage ? calculateContextTokens(usage) : 0
    console.log(`[probe:${label}] messages=${state.length} 字符估算=${charSum} 最近usage=${usageTokens} contextWindow=${window} 阈值=${window - Number(settings.reserveTokens || 0)} shouldCompact(字符)=${shouldCompact(charSum, window, settings)} shouldCompact(usage)=${shouldCompact(usageTokens, window, settings)}`)
    console.log(`[probe:${label}] 形状 ${JSON.stringify(state.map((message: any) => [message.role, typeof message.content, Array.isArray(message.content), message.usage ? calculateContextTokens(message.usage) : null]))}`)
    console.log(`[probe:${label}] 逐条估算 ${JSON.stringify(state.map(message => estimateTokens(message)))}`)
  }
  if (process.env.OIP_AGENT_PROBE_COMPACTION === '1') {
    const usage = session.getContextUsage?.()
    console.log(`[probe] 建会话后 autoCompactionEnabled=${session.autoCompactionEnabled} settings=${JSON.stringify(settingsManager.getCompactionSettings?.())} usage=${JSON.stringify(usage)}`)
    console.log(`[probe] 压缩挂载点 agent.prepareNextTurnWithContext=${typeof session.agent?.prepareNextTurnWithContext} agent.prepareNextTurn=${typeof session.agent?.prepareNextTurn} session.model.contextWindow=${session.model?.contextWindow}`)
    probeCompaction('建会话')
  }

  const abort = () => { console.log('[agent] abort → session.abort()'); Promise.resolve(session.abort()).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })

  const stats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let messageIndex = 0
  let assistantText = ''
  const toolBlocks = new Map()
  let reason = 'done'
  let failureMessage = ''
  let lastCompaction
  const steering = []
  let started = false

  const unsubscribe = session.subscribe((event: any) => {
    if (event.type === 'message_start' && event.message?.role === 'user') {
      const text = textContent(event.message.content)
      const index = steering.findIndex(item => item.text === text)
      if (index >= 0) {
        const [input] = steering.splice(index, 1)
        sessionManager.appendCustomEntry(USER_MESSAGE_ENTRY, { messageId: input.message.entryId, content: input.message.content, mentions: input.message.mentions, attachments: input.message.attachments })
        onSteeringApplied?.(input.message, assistantText)
      }
    }
    if (event.type === 'agent_end' || event.type === 'turn_end') probeCompaction(event.type)
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      const active = event.type === 'compaction_start'
      if (!active) {
        const usage = event.result?.usage
        if (usage) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) stats[key] += Number(usage[key] || 0)
        lastCompaction = {
          status: event.result ? 'completed' : /Already compacted|Nothing to compact/i.test(event.errorMessage || '') ? 'skipped' : event.aborted ? 'stopped' : 'failed', reason: event.reason,
          tokensBefore: event.result?.tokensBefore, tokensAfter: event.result?.estimatedTokensAfter,
          createdAt: new Date().toISOString(),
        }
        if (event.errorMessage && lastCompaction.status !== 'skipped') console.warn(`[agent] 上下文压缩失败: ${event.errorMessage.slice(0, 500)}`)
      }
      send({ type: 'compaction', active, reason: event.reason, ...(!active ? { ...lastCompaction, willRetry: event.willRetry, contextUsage: session.getContextUsage?.() } : {}) })
      return
    }
    if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') {
      send({ type: 'retry', active: true, source: event.type === 'auto_retry_start' ? 'model' : 'compaction', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs })
      return
    }
    if (event.type === 'auto_retry_end' || event.type === 'summarization_retry_finished') {
      send({ type: 'retry', active: false, source: event.type === 'auto_retry_end' ? 'model' : 'compaction' })
      return
    }
    if (event.type === 'message_start' && event.message?.role === 'assistant') { messageIndex += 1; return }
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent
      if (!update || !('contentIndex' in update)) return
      const blockId = `${messageIndex}:${update.contentIndex}`
      if (update.type === 'text_start' || update.type === 'thinking_start') {
        const part = update.partial?.content?.[update.contentIndex]
        send({ type: update.type === 'text_start' ? 'text' : 'thinking', blockId, content: part?.type === 'thinking' && part.redacted ? part.thinking : '' })
      }
      if (update.type === 'text_delta' || update.type === 'thinking_delta') {
        send({ type: update.type === 'text_delta' ? 'text' : 'thinking', blockId, delta: update.delta })
      }
      if (update.type === 'text_end' || update.type === 'thinking_end') {
        send({ type: update.type === 'text_end' ? 'text' : 'thinking', blockId, content: update.content, done: true })
      }
      if (update.type === 'toolcall_start' || update.type === 'toolcall_end') {
        const part = update.type === 'toolcall_end' ? update.toolCall : update.partial?.content?.[update.contentIndex]
        if (part?.type === 'toolCall') {
          toolBlocks.set(part.id, blockId)
          send({ type: 'tool', blockId, tool: { id: part.id, name: part.name, args: part.arguments, status: 'running' } })
        }
      }
      return
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      const blockId = toolBlocks.get(event.toolCallId) ?? event.toolCallId
      send({
        type: 'tool',
        blockId,
        tool: event.type === 'tool_execution_start'
          ? { id: event.toolCallId, name: event.toolName, args: event.args, status: 'running' }
          : { id: event.toolCallId, name: event.toolName, status: event.isError ? 'error' : 'success', result: toolResultText(event.result) },
      })
      return
    }
    if (event.type === 'tool_execution_update') {
      send({ type: 'tool', blockId: toolBlocks.get(event.toolCallId) ?? event.toolCallId, tool: { id: event.toolCallId, name: event.toolName, status: 'running', result: toolResultText(event.partialResult) } })
      return
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const usage = event.message.usage
      if (usage) {
        stats.input += Number(usage.input || 0)
        stats.output += Number(usage.output || 0)
        stats.cacheRead += Number(usage.cacheRead || 0)
        stats.cacheWrite += Number(usage.cacheWrite || 0)
      }
      for (const [index, part] of (event.message.content || []).entries()) {
        const blockId = `${messageIndex}:${index}`
        if (part.type === 'text') { assistantText += part.text || ''; send({ type: 'text', blockId, content: part.text, done: true }) }
        else if (part.type === 'thinking') send({ type: 'thinking', blockId, content: part.thinking, done: true })
      }
      // SDK 自动压缩/重试后会产生新的助手消息；最终状态以最后一次响应为准。
      reason = event.message.stopReason === 'aborted' && !signal?.aborted ? 'error'
        : ['aborted', 'error', 'length'].includes(event.message.stopReason) ? event.message.stopReason : 'done'
      // 模型调用静默失败时，没有这行就完全看不到原因（只有 reason=error）——纯 observable，不改语义。
      if (reason === 'error' || reason === 'aborted') {
        const detail = event.message.errorMessage ?? event.message.error ?? event.error ?? ''
        failureMessage = typeof detail === 'string' ? detail.slice(0, 500) : ''
        console.warn(`[agent] 模型调用失败: ${typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500)}`)
      }
    }
    if (event.type === 'message_end' && event.message?.role === 'toolResult' && event.message.usage) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) stats[key] += Number(event.message.usage[key] || 0)
    }
  })

  let contextUsage
  const deliveredUpdates = new Set(sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'miaoimgSubAgentUpdate').map((entry: any) => entry.details?.id))
  const notify = async update => {
    if (!update?.id || deliveredUpdates.has(update.id)) return
    deliveredUpdates.add(update.id)
    try {
      await session.sendCustomMessage({ customType: 'miaoimgSubAgentUpdate', content: update.content, display: true, details: { id: update.id, file: update.file } }, { triggerTurn: false })
    } catch (error) { deliveredUpdates.delete(update.id); throw error }
  }
  try {
    if (signal?.aborted) throw Object.assign(new Error('已停止生成'), { name: 'AbortError' })
    for (const update of customMessages) await notify(update)
    await onReady?.({
      notify,
      async steer(message, text) {
        if (signal?.aborted || started && session.isIdle) throw Object.assign(new Error('当前任务已结束，补充尚未发送'), { status: 409 })
        const input = { message, text }
        steering.push(input)
        try { await session.steer(text) }
        catch (error) { const index = steering.indexOf(input); if (index >= 0) steering.splice(index, 1); throw error }
      },
    })
    started = true
    if (compactOnly) await session.compact(prompt || undefined)
    else await session.prompt(prompt, { ...(images?.length ? { images } : {}) })
    // A private editor can request one explicit correction in the same context.
    // Never retry failed/truncated/aborted transport or start a second paid job.
    if (!compactOnly && reason === 'done' && completionCheck) {
      const correction = completionCheck();
      if (correction) {
        signal?.throwIfAborted();
        send({ type: 'status', message: '正在检查修改结果并补全草稿…' });
        await session.prompt(correction);
      }
    }
    // 与自动压缩共用 SDK 上下文口径：包含工具结果、图片及实际 usage。
    // 刚压缩且没有新响应时 SDK 返回 null，不能拿压缩前用量冒充当前值。
    contextUsage = session.getContextUsage?.()
  } finally {
    onReady?.(null)
    signal?.removeEventListener('abort', abort)
    unsubscribe?.()
    // 持久化由 SessionManager 的文件完成；下一轮会重新 open，
    // 不需要留下本轮 SDK 的订阅、资源和会话对象。
    session.dispose?.()
  }
  if (process.env.OIP_AGENT_PROBE_COMPACTION === '1') {
    console.log(`[probe] 回合结束后 usage=${JSON.stringify(session.getContextUsage?.())} reason=${reason}`)
  }
  stats.total = stats.input + stats.output + stats.cacheRead + stats.cacheWrite
  // 仅开发期：把模型实际会拿到的上下文摘要打进日志，用于验收（正常路径不打全量内容）。
  if (process.env.OIP_AGENT_DUMP_CONTEXT === '1') {
    try {
      const context = sessionManager.buildSessionContext()
      const summary = (context.messages || []).map((m: any) => `${m.role}:${String(typeof m.content === 'string' ? m.content : (m.content || []).map(p => p.text || '').join('')).slice(0, 30)}`)
      console.log(`[agent] 上下文(${summary.length} 条): ${JSON.stringify(summary)}`)
    } catch (error) { console.log('[agent] 上下文 dump 失败:', error?.message) }
  }
  return { text: assistantText, stats, reason, failureMessage, seeded, contextUsage, lastCompaction, sessionFile: session.sessionFile }
}

function toolResultText(result) {
  if (typeof result?.details?.publicSummary === 'string') return result.details.publicSummary.slice(0, 4000)
  const content = result?.content
  if (!Array.isArray(content)) return typeof result === 'string' ? result : ''
  return content.map(part => part?.type === 'text' ? part.text : '').filter(Boolean).join('\n').slice(0, 4000)
}
