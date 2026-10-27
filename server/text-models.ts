import { failure } from './management-store.ts'
import { runtimeSecretSource } from './runtime-secrets.ts'
import { assertProviderRequestAllowed, isMockProviderMode } from './provider-safety.ts'
import { DEFAULT_CONTEXT_WINDOW, RESPONSES_FALLBACK_INSTRUCTIONS, assertOwnTextModelRegistry, ownTextModelById, ownTextModelIds, textChannelOf } from './text-model-registry.ts'
import { assertCompletionTerminal, completionText } from './text-response.ts'
import { createCustomProviderFetch } from './provider-fetch.ts'
import { readLimitedResponseText } from './network/read-text.ts'

/**
 * 每个文本模型走自己的直连通道（见 text-model-registry.ts 的 TEXT_CHANNELS）：Key 从服务器密钥目录按名字读，
 * 地址写在通道定义里。资格与计费由调用入口负责，此模块只处理模型协议与参数。
 */
// 模型能力、协议与字段差异统一取自我们自己的注册表。
export const DEFAULT_TEXT_MODEL = 'gpt-6.1-sol'
export const TEXT_MODEL_IDS = Object.freeze(ownTextModelIds())
assertOwnTextModelRegistry()
export const TEXT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW
// 只保留传输超时。提示词长度和输出 token 不再另设产品上限。
export const TEXT_LIMITS = Object.freeze({ timeoutMs: 600_000, contextWindow: TEXT_CONTEXT_WINDOW })
// Match the existing non-streaming provider reader's decoded-text budget.
// This bounds transport buffering; it does not alter model/token admission.
const MAX_RESPONSE_CHARACTERS = 5 * 1024 * 1024
export function textModelEntry(id, note = '文本生成与解释', env = process.env) {
  const model = ownTextModelById(id, env)
  return model ? { ...model, providerLabel: '妙图', note } : null
}

export async function textModelById(id, env = process.env) {
  const value = String(id || '').trim()
  return textModelEntry(value, '文本生成与解释', env)
}

export async function publicTextCatalog(env = process.env) {
  return ownTextModelIds(env).map((id) => {
    const model = textModelEntry(id, id === DEFAULT_TEXT_MODEL ? '默认文本模型' : '文本生成与解释', env)
    return { id: model.id, label: model.label, note: model.note, protocol: model.protocol, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, ...(model.reasoning ? { reasoning: true, reasoningEffort: model.reasoningEffort, reasoningEfforts: model.reasoningEfforts } : {}) }
  })
}

export function textSettings(env = process.env, modelId = DEFAULT_TEXT_MODEL) {
  const id = String(modelId || DEFAULT_TEXT_MODEL).trim()
  const model = ownTextModelById(id, env)
  const channel = textChannelOf(model)
  const mock = isMockProviderMode(env)
  // Key 走服务器密钥目录的直连文件；只有云枢 Grok 通道在非 mock 下不接受环境变量回退。
  const secret = runtimeSecretSource(channel.secretName, env, { allowEnv: mock || channel.envFallback })
  const base = (mock && channel.mockBaseUrlEnv ? env[channel.mockBaseUrlEnv] : '') || (channel.baseUrlEnv ? env[channel.baseUrlEnv] : '') || channel.baseUrl
  return {
    apiKey: secret.value,
    keyFile: secret.path,
    baseUrl: String(base || '').replace(/\/$/, ''),
    enabled: env.ENABLE_MODEL_CALLS === 'true',
    providerId: model?.provider || 'miaoimg',
    modelEntry: model,
    protocol: model?.protocol,
    contextWindow: model?.contextWindow,
    maxOutputTokens: model?.maxOutputTokens,
    modelId: id,
    ...(model?.reasoningEffort ? { reasoningEffort: model.reasoningEffort, reasoningEfforts: model.reasoningEfforts } : {}),
  }
}

export function textChannelReady(env = process.env, modelId = DEFAULT_TEXT_MODEL) {
  const config = textSettings(env, modelId)
  return Boolean(config.enabled && config.apiKey)
}

export async function validateTextRequest(payload: Record<string, any> = {}, env = process.env) {
  const requested = String(payload.model || '').trim() || DEFAULT_TEXT_MODEL
  const model = await textModelById(requested, env)
  if (!model) throw failure('不支持的文本模型', 422)
  const prompt = String(payload.prompt || '').trim()
  if (!prompt) throw failure('请先输入内容', 422)
  const systemPrompt = String(payload.systemPrompt || '').trim()
  const omitted = payload.maxTokens === undefined || payload.maxTokens === null || payload.maxTokens === ''
  const rawTokens = omitted ? undefined : Number(payload.maxTokens)
  if (rawTokens !== undefined && (!Number.isFinite(rawTokens) || rawTokens <= 0)) throw failure('输出长度必须是正数', 422)
  const requestedTokens = rawTokens === undefined ? undefined : Math.floor(rawTokens)
  const publishedOutput = model.sources?.maxOutputTokens && !String(model.sources.maxOutputTokens).startsWith('兜底')
  if (requestedTokens !== undefined && publishedOutput && requestedTokens > model.maxOutputTokens) {
    throw failure(`当前模型输出上限是 ${model.maxOutputTokens}`, 422)
  }
  const maxTokens = requestedTokens
  const config = textSettings(env, requested)
  if (!config.enabled) throw failure('模型调用暂不可用，请稍后再试', 503)
  if (!config.apiKey) throw failure('模型服务暂时不可用，请稍后再试', 503)
  return { model, prompt, systemPrompt, maxTokens, config }
}

export async function createTextCompletion(request, { fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const { model, prompt, systemPrompt, maxTokens, config } = request
  const timeout = AbortSignal.timeout(TEXT_LIMITS.timeoutMs)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
  assertProviderRequestAllowed(model.provider === 'miaoimg' ? textChannelOf(model).safetyChannel : 'yunshu', config.baseUrl, process.env)
  const responses = model.protocol === 'openai-responses'
  const body = responses
    ? {
        model: model.id,
        input: [{ role: 'user', content: prompt }],
        ...(Number.isInteger(maxTokens) ? { max_output_tokens: maxTokens } : {}),
        // A one-shot node completion never resumes provider-stored history.
        store: false,
        // 永远带 instructions：空着的话云枢会注入它自己的 Codex 系统提示。
        instructions: systemPrompt || RESPONSES_FALLBACK_INSTRUCTIONS,
        ...(model.reasoningEffort ? { reasoning: { effort: model.reasoningEffort } } : {}),
      }
    : {
        model: model.id,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt },
        ],
        ...(Number.isInteger(maxTokens) ? { [model.fields.output]: maxTokens } : {}),
        ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}),
      }
  const response = await createCustomProviderFetch({ allowPrivate: true, fetchImpl, redirectMessage: '模型服务地址已变化，请联系妙图团队' })(`${config.baseUrl}${responses ? '/responses' : '/chat/completions'}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: abort,
  })
  const raw = await readLimitedResponseText(response, { maxLength: MAX_RESPONSE_CHARACTERS, signal: abort,
    tooLarge: () => Object.assign(failure('文本模型响应过大，未接收完整结果', 502), { upstreamStatus: response.status }) })
  let data: Record<string, any> = {}
  try { data = raw ? JSON.parse(raw) : {} } catch { data = { raw: raw.slice(0, 1_000) } }
  if (!response.ok) {
    const message = String(data?.error?.message || data?.message || `文本上游请求失败（${response.status}）`).slice(0, 500)
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : 422, upstreamStatus: response.status, usage: data?.usage || null })
  }
  assertCompletionTerminal(data, model.protocol, response.status)
  const text = completionText(data, model.protocol)
  // Even an empty answer can carry billed reasoning/input usage. Its caller
  // still needs the provider's counters before reporting the content failure.
  if (!text) throw Object.assign(failure('文本模型没有返回内容', 502), { usage: data?.usage || null })
  return { text, model: model.id, usage: data?.usage || null }
}
