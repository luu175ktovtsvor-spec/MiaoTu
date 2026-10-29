// 自定义文本供应商：沿用 MiaoImg「文本模型」面板的 customProviders 结构，
// 但配置按账号保存在服务端工作区（settings/providers.json），API Key 不回传浏览器。
// 文本请求走服务端转发：节点与 Agent 只提交 providerId + modelId。
import { failure } from './management-store.ts'
import { PROVIDER_PROTOCOLS, customTextModel } from './text-model-registry.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { createCustomProviderFetch } from './provider-fetch.ts'
import { readLimitedResponseText } from './network/read-text.ts'
import { assertCompletionTerminal, completionText } from './text-response.ts'

export const PROVIDER_PATH = 'settings/providers.json'
export { PROVIDER_PROTOCOLS }
export const OFFICIAL_PROVIDER_ID = 'miaoimg'

const MAX_PROVIDERS = 12
const MAX_MODELS = 300
const MAX_KEY_LENGTH = 8192
const MAX_LABEL_LENGTH = 60
const MAX_COMPAT_ENTRIES = 40
const MAX_COMPAT_BYTES = 16 * 1024
const FETCH_TIMEOUT_MS = 600_000
const MODEL_FETCH_TIMEOUT_MS = 30000
// Preserve the existing response.text().length boundary, including CJK text;
// this is a decoded string budget, not a new wire-byte or model-token quota.
const MAX_RESPONSE_CHARACTERS = 5 * 1024 * 1024

export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  let url
  try { url = new URL(raw) } catch { throw failure('API 地址无效，请填写 http(s) 基础地址', 422) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw failure('API 地址无效，请填写不含查询参数的 http(s) 基础地址', 422)
  }
  // 本机供应商也共用这个配置格式；云端网络边界在实际请求时校验和固定 DNS。
  if (url.hostname === '169.254.169.254' || url.hostname === 'metadata.google.internal') throw failure('API 地址无效', 422)
  return raw
}

export function normalizeProviderId(value) {
  const id = String(value || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(id)) throw failure('Provider ID 仅支持字母、数字、点、下划线和短横线', 422)
  if (id === OFFICIAL_PROVIDER_ID) throw failure('Provider ID 与官方供应商冲突，请换一个', 422)
  return id
}

function normalizeModel(item) {
  if (!item || typeof item !== 'object') throw failure('模型数据无效', 422)
  const id = String(item.id || '').trim()
  if (!id || id.length > 200) throw failure('模型 ID 不能为空且不能超过 200 字符', 422)
  const model: Record<string, any> = { id, label: String(item.label || '').trim().slice(0, 200) || id }
  const limits = [['contextWindow', 100000000], ['maxOutputTokens', 10000000]]
  for (const pair of limits) {
    const key = pair[0]
    const limit = pair[1]
    const raw = item[key]
    if (raw === undefined || raw === null || raw === '') continue
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > Number(limit)) throw failure('token 限制必须是正整数或留空', 422)
    model[key] = value
  }
  if (typeof item.reasoning === 'boolean') model.reasoning = item.reasoning
  if (item.input !== undefined) {
    if (!Array.isArray(item.input) || !item.input.length || item.input.some(value => !['text', 'image'].includes(value))) throw failure('图片输入能力格式无效', 422)
    model.input = [...new Set(item.input)]
  }
  if (item.maxTokensField !== undefined) {
    if (!['max_tokens', 'max_completion_tokens'].includes(item.maxTokensField)) throw failure('输出字段无效', 422)
    model.maxTokensField = item.maxTokensField
    model.compat = { maxTokensField: item.maxTokensField }
  }
  if (item.compat !== undefined) {
    const compat = normalizeCompat(item.compat)
    model.compat = { ...(model.compat || {}), ...compat }
  }
  if (item.thinkingLevelMap !== undefined) {
    if (!item.thinkingLevelMap || typeof item.thinkingLevelMap !== 'object' || Array.isArray(item.thinkingLevelMap)) throw failure('思考档位格式无效', 422)
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    const entries = Object.entries(item.thinkingLevelMap)
    if (entries.length > levels.length || entries.some(([key, value]) => !levels.includes(key) || value !== null && (typeof value !== 'string' || value.length > 80))) throw failure('思考档位格式无效', 422)
    model.thinkingLevelMap = Object.fromEntries(entries)
  }
  return model
}

function normalizeCompat(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('接口兼容参数必须是对象', 422)
  const entries = Object.entries(value)
  if (entries.length > MAX_COMPAT_ENTRIES || JSON.stringify(value).length > MAX_COMPAT_BYTES) throw failure('接口兼容参数过多', 422)
  const output: Record<string, string | number | boolean> = {}
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw failure('接口兼容参数名称无效', 422)
    if (typeof raw !== 'string' && typeof raw !== 'boolean' && !(typeof raw === 'number' && Number.isFinite(raw))) throw failure('接口兼容参数只支持文字、数字和开关', 422)
    if (typeof raw === 'string' && raw.length > 200) throw failure('接口兼容参数内容过长', 422)
    output[key] = raw
  }
  return output
}

export function normalizeProviderPayload(payload) {
  const id = normalizeProviderId(payload?.id)
  const label = String(payload?.label || '').trim().slice(0, MAX_LABEL_LENGTH)
  if (!label) throw failure('请填写供应商显示名称', 422)
  const apiUrl = normalizeBaseUrl(payload?.apiUrl)
  const protocol = String(payload?.protocol || 'openai-completions')
  if (!PROVIDER_PROTOCOLS.includes(protocol)) throw failure('API 协议不受支持', 422)
  const apiKey = String(payload?.apiKey ?? '').trim()
  if (apiKey.length > MAX_KEY_LENGTH) throw failure('API Key 过长', 422)
  const compat = payload?.compat === undefined ? undefined : normalizeCompat(payload.compat)
  const models = Array.isArray(payload?.models) ? payload.models.map(normalizeModel) : []
  if (models.length > MAX_MODELS) throw failure('单个供应商最多 ' + MAX_MODELS + ' 个模型', 422)
  if (new Set(models.map(model => model.id)).size !== models.length) throw failure('模型 ID 不能重复', 422)
  return { id, label, apiUrl, protocol, apiKey, ...(compat ? { compat } : {}), models }
}

function parseStore(bytes) {
  const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.providers)) throw new Error('Invalid provider settings')
  const ids = new Set<string>()
  for (const provider of data.providers) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider) || typeof provider.id !== 'string'
      || provider.apiKey !== undefined && typeof provider.apiKey !== 'string'
      || provider.models !== undefined && !Array.isArray(provider.models)) throw new Error('Invalid provider settings')
    const normalized = normalizeProviderPayload(provider)
    if (normalized.id !== provider.id || ids.has(normalized.id)) throw new Error('Duplicate or noncanonical provider ID')
    ids.add(normalized.id)
  }
  return data.providers
}

// 3.0.x 按画布项目各存一份；改成应用级后，第一次读取时把各项目里的旧配置合并进来
// （同一 ID 以最近修改的那份为准），旧文件原样保留，读不了的旧文件跳过不影响其他项目。
async function adoptProjectStores(workspaceFiles, userId, project) {
  if (!workspaceFiles.scoped) return []
  const rows = (await workspaceFiles.store.all('SELECT project_id AS project FROM workspace_files WHERE user_id=? AND path=? AND project_id<>? ORDER BY updated_at DESC', userId, PROVIDER_PATH, project))
  const merged = new Map()
  for (const { project: source } of rows) {
    try {
      for (const provider of parseStore((await workspaceFiles.read(userId, PROVIDER_PATH, source)).bytes))
        if (!merged.has(provider.id)) merged.set(provider.id, provider)
    } catch {}
  }
  const providers = [...merged.values()]
  if (providers.length) await writeStore(workspaceFiles, userId, providers)
  return providers
}

async function readStore(workspaceFiles, userId) {
  const project = workspaceFiles.providerProject?.()
  const entry = (await workspaceFiles.list(userId, project)).find(item => item.path === PROVIDER_PATH)
  if (!entry) return project ? (await adoptProjectStores(workspaceFiles, userId, project)) : []
  try {
    return parseStore((await workspaceFiles.read(userId, PROVIDER_PATH, project)).bytes)
  } catch (cause) {
    // A damaged or temporarily unreadable file is not an empty configuration.
    // Reads and edits both stop, preserving every existing provider and key.
    throw Object.assign(failure('供应商设置无法读取，原文件已保留，请修复设置后重试', 409), { cause })
  }
}

async function writeStore(workspaceFiles, userId, providers) {
  await workspaceFiles.upsert(userId, PROVIDER_PATH, 'application/json', Buffer.from(JSON.stringify({ providers }), 'utf8'), workspaceFiles.providerProject?.())
}

function publicProvider(provider) {
  const clone = { id: provider.id, label: provider.label, apiUrl: provider.apiUrl, protocol: provider.protocol, ...(provider.compat ? { compat: provider.compat } : {}), models: provider.models }
  return { ...clone, hasKey: Boolean(provider.apiKey) }
}

export async function listPublicProviders(workspaceFiles, userId) {
  return (await readStore(workspaceFiles, userId)).map(publicProvider)
}

export async function listPublicProviderModels(workspaceFiles, userId) {
  return (await listPublicProviders(workspaceFiles, userId)).flatMap(provider => (provider.models || []).map(model => ({
    providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label,
    protocol: provider.protocol || 'openai-completions', configured: Boolean(provider.hasKey),
    ...(model.reasoning ? { reasoning: true } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
    ...(Array.isArray(model.input) ? { input: model.input } : {}),
    ...(model.maxTokensField ? { maxTokensField: model.maxTokensField } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  })))
}

export async function upsertProvider(workspaceFiles, userId, payload) {
  const providers = (await readStore(workspaceFiles, userId))
  const next = normalizeProviderPayload(payload)
  const exists = providers.find(item => item.id === next.id)
  if (!next.apiKey) {
    if (!exists || !exists.apiKey) throw failure('请填写 API Key', 422)
    next.apiKey = exists.apiKey
  }
  if (!exists && providers.length >= MAX_PROVIDERS) throw failure('最多添加 ' + MAX_PROVIDERS + ' 个供应商', 422)
  const merged = exists ? providers.map(item => (item.id === next.id ? next : item)) : [...providers, next]
  await writeStore(workspaceFiles, userId, merged)
  return publicProvider(next)
}

export async function removeProvider(workspaceFiles, userId, id) {
  const target = String(id || '').trim()
  const providers = (await readStore(workspaceFiles, userId))
  const next = providers.filter(item => item.id !== target)
  if (next.length === providers.length) throw failure('供应商不存在', 404)
  await writeStore(workspaceFiles, userId, next)
  return { id: target }
}

export async function providerById(workspaceFiles, userId, id) {
  const target = String(id || '').trim()
  if (!target || target === OFFICIAL_PROVIDER_ID) return null
  return (await readStore(workspaceFiles, userId)).find(item => item.id === target) || null
}

// The legacy short-text endpoint is also hosted by the desktop. Resolve the
// provider from that host's workspace; never send its private settings upstream.
export async function completeProviderText(workspaceFiles, userId, payload, options: Record<string, any> = {}) {
  const providerId = String(payload?.providerId || '').trim()
  const provider = (await providerById(workspaceFiles, userId, providerId))
  if (!provider) throw failure('供应商不存在，请在设置 → 文本模型里重新添加', 422)
  const prompt = String(payload?.prompt || '').trim()
  if (!prompt) throw failure('请先输入内容', 422)
  return createProviderCompletion(provider, {
    modelId: String(payload?.model || payload?.modelId || '').trim(), prompt,
    systemPrompt: String(payload?.systemPrompt || '').trim(),
    maxTokens: payload?.maxTokens ?? payload?.max_tokens,
  }, options)
}

// 与 MiaoImg 的 /api/providers/models 同构：按协议拉取上游模型列表。
export async function fetchProviderModels({ apiUrl, protocol, apiKey }: Record<string, any>, { fetchImpl = fetch, allowPrivate = false, signal, beforeDispatch }: Record<string, any> = {}) {
  signal?.throwIfAborted()
  const base = normalizeBaseUrl(apiUrl)
  assertProviderRequestAllowed('custom-text', base, process.env)
  const mode = PROVIDER_PROTOCOLS.includes(protocol) ? protocol : 'openai-completions'
  const url = new URL(base)
  if (url.pathname === '/') url.pathname = '/v1'
  url.pathname = url.pathname.replace(/\/+$/, '') + '/models'
  const headers: Record<string, any> = { accept: 'application/json' }
  if (mode === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
    headers['x-api-key'] = apiKey
    url.searchParams.set('limit', '1000')
  } else if (apiKey) headers.authorization = 'Bearer ' + apiKey

  const models = new Map()
  const cursors = new Set()
  const timeout = AbortSignal.any([AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])])
  const requestFetch = createCustomProviderFetch({ fetchImpl, allowPrivate, beforeDispatch })
  while (true) {
    timeout.throwIfAborted()
    const response = await requestFetch(url, { headers, signal: timeout })
    const raw = await readLimitedResponseText(response, { maxLength: MAX_RESPONSE_CHARACTERS, signal: timeout,
      tooLarge: () => failure('模型列表响应过大', 422) })
    let data
    try { data = JSON.parse(raw) }
    catch { if (response.ok) throw failure('模型列表返回的不是 JSON', 422) }
    if (!response.ok) {
      throw failure(String(data?.error?.message || '获取模型列表失败（HTTP ' + response.status + '），请检查 API 地址、协议和密钥').slice(0, 500), 422)
    }
    const items = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null
    if (!items) throw failure('模型列表格式不受支持', 422)
    for (const item of items) {
      const id = String(item?.id || item?.name || '').trim()
      if (!id) continue
      const model: Record<string, any> = { id, label: String(item?.display_name || item?.displayName || '').trim() || id }
      if (Number.isSafeInteger(item?.inputTokenLimit) && item.inputTokenLimit > 0) model.contextWindow = item.inputTokenLimit
      if (Number.isSafeInteger(item?.outputTokenLimit) && item.outputTokenLimit > 0) model.maxOutputTokens = item.outputTokenLimit
      models.set(id, model)
      if (models.size > MAX_MODELS) throw failure('模型数量超过 ' + MAX_MODELS, 422)
    }
    if (mode !== 'anthropic-messages' || !data?.has_more) break
    if (data.has_more !== true || typeof data.last_id !== 'string' || !data.last_id.trim()) throw failure('模型列表分页标识无效，尚未读取完整列表', 422)
    const cursor = data.last_id
    if (cursors.has(cursor)) throw failure('模型列表分页游标重复', 422)
    cursors.add(cursor)
    url.searchParams.set('after_id', cursor)
  }
  return [...models.values()]
}

function chatUrl(provider, suffix) {
  const url = new URL(provider.apiUrl)
  if (url.pathname === '/') url.pathname = '/v1'
  url.pathname = url.pathname.replace(/\/+$/, '') + suffix
  return url.toString()
}

function upstreamError(data, status) {
  const detail = String(data?.error?.message || data?.message || (typeof data?.error === 'string' ? data.error : '') || data?.raw || '').slice(0, 500)
  return Object.assign(new Error(detail || '上游返回错误（' + status + '）'), { status: status >= 500 ? 502 : 422, upstreamStatus: status })
}

// 服务端转发一次文本补全；支持 OpenAI Chat / OpenAI Responses / Anthropic Messages 三种协议。
export async function createProviderCompletion(provider, { modelId, prompt, systemPrompt, maxTokens }: Record<string, any>, { fetchImpl = fetch, signal, allowPrivate = false, beforeDispatch }: Record<string, any> = {}) {
  const entry = provider.models.find(item => item.id === modelId)
  if (!entry) throw failure('所选模型不在该供应商的模型列表里，请重新选择', 422)
  const model = customTextModel(provider, entry)
  assertProviderRequestAllowed('custom-text', provider.apiUrl, process.env)
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout
  const requested = maxTokens === undefined || maxTokens === null || maxTokens === '' ? undefined : Number(maxTokens)
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw failure('输出长度必须是正数', 422)
  const ceiling = model.sources?.maxOutputTokens && !String(model.sources.maxOutputTokens).startsWith('兜底') ? model.maxOutputTokens : undefined
  if (requested !== undefined && ceiling && Math.floor(requested) > ceiling) throw failure(`当前模型输出上限是 ${ceiling}`, 422)
  // Anthropic 的 max_tokens 是必填。没有上游公布的输出上限时不另写一个小数。
  const limit = requested !== undefined ? Math.floor(requested) : (provider.protocol === 'anthropic-messages' ? model.maxOutputTokens : undefined)
  let url
  let headers
  let body
  if (provider.protocol === 'anthropic-messages') {
    url = chatUrl(provider, '/messages')
    headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': provider.apiKey }
    body = { model: model.id, ...(limit ? { max_tokens: limit } : {}), messages: [{ role: 'user', content: prompt }], ...(systemPrompt ? { system: systemPrompt } : {}) }
  } else if (provider.protocol === 'openai-responses') {
    url = chatUrl(provider, '/responses')
    headers = { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}) }
    body = { model: model.id, input: [{ role: 'user', content: prompt }], ...(limit ? { max_output_tokens: limit } : {}), store: false, ...(systemPrompt ? { instructions: systemPrompt } : {}) }
  } else {
    url = chatUrl(provider, '/chat/completions')
    headers = { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: 'Bearer ' + provider.apiKey } : {}) }
    body = { model: model.id, messages: [...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []), { role: 'user', content: prompt }], ...(limit ? { [model.compat.maxTokensField]: limit } : {}), ...(model.reasoningEffort ? { reasoning_effort: model.reasoningEffort } : {}) }
  }
  const response = await createCustomProviderFetch({ fetchImpl, allowPrivate, beforeDispatch })(url, { method: 'POST', headers, body: JSON.stringify(body), signal: abort })
  const raw = await readLimitedResponseText(response, { maxLength: MAX_RESPONSE_CHARACTERS, signal: abort,
    tooLarge: () => failure('文本模型响应过大，未接收完整结果', response.ok || response.status >= 500 ? 502 : 422) })
  let data: Record<string, any> = {}
  try { data = raw ? JSON.parse(raw) : {} } catch { data = { raw: raw.slice(0, 500) } }
  if (!response.ok) throw upstreamError(data, response.status)
  assertCompletionTerminal(data, provider.protocol, response.status)
  const text = completionText(data, provider.protocol)
  if (!text) throw failure('文本模型没有返回内容', 502)
  return { text, model: model.id, provider: provider.id, usage: data?.usage || null }
}
