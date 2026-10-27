import { createTextMeter } from './text-metering.ts'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { textSettings } from './text-models.ts'
import { ownTextModelById, textChannelOf } from './text-model-registry.ts'
import { failure } from './management-store.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { assertTextAccess, assertTextModelAccess } from './text-access.ts'
import { isTransientModelFailure, modelResponseHeaders, readModelJson } from './model-transport.ts'
import { createCustomProviderFetch } from './provider-fetch.ts'

// Older installed clients still use Chat for these models. Keep that existing
// route available while newer clients use their registered Responses protocol.
const LEGACY_COMPLETIONS_MODELS = new Set(['gpt-6.1-sol', 'deepseek-flash'])
// The installed app is not a trust boundary: a signed-in caller can construct
// this request directly. This route is local-history text inference, not access
// to the provider account's paid tools, stored files or shared conversations.
function desktopPayload(body, model, endpoint) {
  const responses = endpoint === 'openai-responses'
  const outputField = responses ? 'max_output_tokens' : 'max_completion_tokens'
  const raw = body[outputField] ?? (!responses ? body.max_tokens : undefined)
  const omitted = raw === undefined || raw === null || raw === ''
  const outputTokens = omitted ? undefined : Number(raw)
  const ceiling = model.sources?.maxOutputTokens && !String(model.sources.maxOutputTokens).startsWith('兜底') ? model.maxOutputTokens : undefined
  if (!omitted && (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || (ceiling && outputTokens > ceiling))) throw failure('模型输出长度无效', 422)
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw failure('文本 Agent 每次请求只允许一个回复', 422)
  if (body.best_of !== undefined && body.best_of !== 1) throw failure('文本 Agent 不支持多份候选生成', 422)
  if (body.background !== undefined && body.background !== false) throw failure('文本 Agent 不支持上游后台执行', 422)
  if (body.previous_response_id || body.conversation || (responses && body.prompt)) throw failure('文本 Agent 只能使用本机对话历史', 422)
  if (body.audio != null || (body.modalities !== undefined && (!Array.isArray(body.modalities) || body.modalities.some(value => value !== 'text')))) throw failure('文本 Agent 不支持音频生成', 422)
  if (body.web_search_options != null) throw failure('请使用妙图已授权的联网工具', 422)
  if (body.service_tier != null && !['auto', 'default'].includes(body.service_tier)) throw failure('文本服务等级由服务器配置', 422)
  const localTool = tool => tool && typeof tool === 'object' && ['function', 'custom'].includes(tool.type)
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 350 || !body.tools.every(localTool))) throw failure('文本 Agent 只允许在本机执行的工具', 422)
  if (body.tool_choice != null) {
    const choice = body.tool_choice
    const allowed = typeof choice === 'string' ? ['auto', 'none', 'required'].includes(choice)
      : localTool(choice) || (choice?.type === 'allowed_tools' && Array.isArray(choice.tools) && choice.tools.every(localTool))
    if (!allowed) throw failure('文本 Agent 的工具选择无效', 422)
  }
  for (const item of (Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [])) {
    if (item?.type === 'item_reference' || item?.file_id || item?.file?.file_id) throw failure('文本 Agent 不能引用上游存储内容', 422)
    for (const part of (Array.isArray(item?.content) ? item.content : [])) {
      if (part?.file_id || part?.file?.file_id) throw failure('请从本机传入参考素材，不使用上游文件编号', 422)
    }
  }
  const { previous_response_id: _previous, conversation: _conversation,
    max_tokens: _legacyOutput, max_completion_tokens: _chatOutput, max_output_tokens: _responseOutput, ...payload } = body
  return { ...payload, ...(outputTokens ? { [outputField]: outputTokens } : {}), store: false, ...(!responses ? { n: 1 } : {}) }
}

// 桌面 Agent 的循环与工具在本机。这里只转发已登记模型的推理协议，绝不下发上游密钥。
export async function desktopModel(request, response, session, url, { management, mutation, env = process.env, fetchImpl = fetch }: Record<string, any>) {
  const endpoint = { '/api/imagine/desktop/model/chat/completions': 'openai-completions', '/api/imagine/desktop/model/responses': 'openai-responses' }[url.pathname]
  if (!endpoint || request.method !== 'POST') return false
  if (response.destroyed || response.writableEnded) return true
  assertTextAccess({ management, session })
  mutation(request, session)
  const body = await readModelJson(request)
  // The account may have been disabled or lost its balance while uploading.
  if (response.destroyed || response.writableEnded) return true
  const user = assertTextAccess({ management, session })
  const model = ownTextModelById(body.model, env)
  const operating = management.settings()
  const legacyEndpoint = endpoint === 'openai-completions' && Boolean(model) && LEGACY_COMPLETIONS_MODELS.has(model.id)
  if (!model || (model.protocol !== endpoint && !legacyEndpoint) || !operating.enabled || operating.models[model.id] === false || user.models?.length && !user.models.includes(model.id)) throw failure('该模型当前不可用', 422)
  const config = textSettings(env, model.id)
  if (!config.enabled || !config.apiKey) throw failure('文本模型尚未配置', 503)
  assertProviderRequestAllowed(textChannelOf(model).safetyChannel, config.baseUrl, env)
  const payload = desktopPayload(body, model, endpoint)
  const meter = createTextMeter({ management,session,source:'desktop_agent',fetchImpl })
  const controller = new AbortController()
  const close = () => { if (!response.writableEnded) controller.abort() }
  response.on('close', close)
  try {
    // The server owns this origin; reuse the no-redirect provider transport so
    // an upstream Location cannot replay private conversation bytes elsewhere.
    const upstream = await createCustomProviderFetch({ allowPrivate: true, env, fetchImpl: meter.fetch,
      beforeDispatch: () => assertTextModelAccess({ management, session, modelId: model.id }),
      redirectMessage: '模型服务地址已变化，请联系妙图团队' })(config.baseUrl + (endpoint === 'openai-responses' ? '/responses' : '/chat/completions'), {
      method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      // 取消模型供应商的持久存储；本机 SDK 自己保留上下文。
      body: JSON.stringify(payload), signal: controller.signal,
    })
    response.writeHead(upstream.status, modelResponseHeaders(upstream))
    if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), response)
    else response.end()
  } catch (error) {
    if (!controller.signal.aborted && !response.headersSent && isTransientModelFailure(error)) {
      throw Object.assign(new Error('文本服务连接暂时中断，请稍后继续'), { status: 502, cause: error })
    }
    throw error
  } finally { response.off('close', close) }
  return true
}
