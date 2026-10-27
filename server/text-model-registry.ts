// 这里只登记妙图实际暴露的文本模型；不复制 SDK / 上游的全厂商目录。
export const PROVIDER_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages'])
export const PROTOCOL_FIELDS = Object.freeze({
  'openai-completions': Object.freeze({ endpoint: '/chat/completions', input: 'messages', system: 'messages[role=system]', output: 'max_completion_tokens', reasoning: 'reasoning_effort', tools: 'tools[].function', result: 'messages[role=tool].tool_call_id', events: ['chat.completion.chunk', '[DONE]'] }),
  'openai-responses': Object.freeze({ endpoint: '/responses', input: 'input', system: 'instructions', output: 'max_output_tokens', reasoning: 'reasoning.effort', tools: 'tools[type=function]', result: 'input[type=function_call_output]', previousResponse: 'previous_response_id', parallelToolCalls: 'parallel_tool_calls', toolChoice: 'tool_choice', maxTools: 350, events: ['response.created', 'response.output_item.added', 'response.output_item.done', 'response.output_text.delta', 'response.completed', 'response.incomplete', 'response.failed', 'error'], functionCallStreaming: '整块 response.output_item.done，不跨 chunk 拼接' }),
  'anthropic-messages': Object.freeze({ endpoint: '/messages', input: 'messages', system: 'system', output: 'max_tokens', reasoning: 'thinking', tools: 'tools[].input_schema', result: 'messages[role=user].content[type=tool_result]', events: ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'error'], headers: { 'anthropic-version': '2023-06-01', authentication: 'x-api-key' } }),
})
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768
// GPT-6.1 Sol 官方公共 API 模型卡：1.05M 上下文、128K 输出，作为妙图客户端预算。
// 不代表当前 Yunshu/Codex OAuth 通道已实测同一容量；网关的 OAuth 路径会删除
// max_output_tokens，因此客户端发出该值也不等于上游已执行相同输出上限。
// 未知自定义供应商仍沿用安全兜底值；依据与验收范围见 docs/模型参数对照.md。
export const OPENAI_GPT_CONTEXT_WINDOW = 1_050_000
export const OPENAI_GPT_MAX_OUTPUT_TOKENS = 128_000
const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh'])
const COMPLETIONS_COMPAT = Object.freeze({ maxTokensField: 'max_completion_tokens', supportsDeveloperRole: false, supportsReasoningEffort: true, supportsUsageInStreaming: true, supportsStore: false, supportsStrictMode: false })

// 每个文本通道一份直连配置：Key 从服务器密钥目录按名字取，地址写死在这里，
// 不走环境变量中转，排查时看到的就是实际请求的那个地址。
//
// responsesStateless：这条通道的 Responses 能不能用 previous_response_id 续接。三条都不行，而且
// 失败方式还不一样——云枢（GPT/Grok）直接 400「requires an OpenAI API-key account」并把 store
// 强制回 false；DeepSeek 收下参数但丢上下文（追问上一轮记的数字，它答 0）。所以 Responses 一律
// 每轮重放完整历史。将来哪条通道真支持了，把这里的 true 去掉即可。
export const TEXT_CHANNELS = Object.freeze({
  yunshu: Object.freeze({ id: 'yunshu', secretName: 'YUNSHU_API_KEY', baseUrl: 'https://api.zzyppz.cn/v1', baseUrlEnv: 'YUNSHU_BASE_URL', safetyChannel: 'yunshu', envFallback: true, responsesStateless: true }),
  'yunshu-grok': Object.freeze({ id: 'yunshu-grok', secretName: 'GROK_API_KEY', baseUrl: 'https://api.zzyppz.cn/v1', baseUrlEnv: 'YUNSHU_BASE_URL', mockBaseUrlEnv: 'GROK_BASE_URL', safetyChannel: 'grok', envFallback: false, responsesStateless: true }),
  deepseek: Object.freeze({ id: 'deepseek', secretName: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', safetyChannel: 'deepseek', envFallback: true, responsesStateless: true }),
})

// Responses 通道不给 instructions 时，云枢会自己塞一段「You are Codex, an agent based on GPT-6…」
// 的系统提示（实测：带上我们自己的 instructions 时以我们的为准）。所以这条路径上永远要带一句话，
// 哪怕调用方没有系统提示——否则用户会撞见一个自称 Codex 的助手。
export const RESPONSES_FALLBACK_INSTRUCTIONS = '你是妙图（MiaoImg）的助手，用简体中文回答用户。'
export function textChannelOf(model) {
  return TEXT_CHANNELS[String(model?.channel || '').trim()] || TEXT_CHANNELS.yunshu
}

function builtin(id, label, contextWindow, reasoning = false, contextSource = '', protocol = 'openai-completions', extra: Record<string, any> = {}) {
  const base = { id, label, provider: 'miaoimg', channel: id.startsWith('grok-') ? 'yunshu-grok' : 'yunshu', protocol, contextWindow, maxOutputTokens: undefined,
    contextSource, maxOutputSource: '', fields: PROTOCOL_FIELDS[protocol], ...(protocol === 'openai-completions' ? { compat: COMPLETIONS_COMPAT } : {}),
    reasoning, ...(reasoning ? { reasoningEffort: 'medium', reasoningEfforts: EFFORTS, thinkingLevelMap: { off: null } } : {}), input: ['text', 'image'] }
  return Object.freeze({ ...base, ...extra, fields: extra.fields || base.fields, compat: extra.compat || base.compat })
}
// 注册表中的运行预算不等于实际网关通道的容量实测结果。
export const OWN_TEXT_MODELS = Object.freeze([
  // 云枢的 GPT 通道只有走 Responses 才真的思考：同一通道走 Chat Completions 时 reasoning_effort
  // 会被收下但什么都不发生（返回里既没有推理块、也没有 reasoning_tokens，实测同题还会答错）。
  // 档位清单是拿一个非法值去问上游、由它的报错列出来的。
  builtin('gpt-6.1-sol', 'GPT 6.1 Sol', OPENAI_GPT_CONTEXT_WINDOW, true, 'GPT-6.1 Sol 公共 API 模型卡（客户端预算，网关通道未实测）', 'openai-responses', {
    maxOutputTokens: OPENAI_GPT_MAX_OUTPUT_TOKENS,
    maxOutputSource: 'GPT-6.1 Sol 公共 API 模型卡（客户端预算，网关通道未实测）',
    reasoningEffort: 'high',
    reasoningEfforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  }),
  builtin('grok-4.5', 'Grok 4.5', 500_000, true, 'xAI 模型卡：上下文 500000；推理档 low/medium/high/xhigh，默认 high', 'openai-responses', {
    reasoningEffort: 'high',
  }),
  // 容量与档位取 DeepSeek /models 的实际返回：1M 上下文、393216 输出上限、effort 只有 low/high/max（默认 high）。
  // 它也支持 Responses（实测有 reasoning 块、function_call 与 function_call_output 都能用），
  // 换过来是为了三条通道共用同一条代码路径，不是为了修什么——它在 Chat Completions 上本来就会思考。
  builtin('deepseek-flash', 'DeepSeek Flash', 1_048_576, true, 'DeepSeek /models 返回', 'openai-responses', {
    channel: 'deepseek',
    maxOutputTokens: 393_216,
    maxOutputSource: 'DeepSeek /models 返回',
    reasoningEffort: 'high',
    reasoningEfforts: Object.freeze(['low', 'high', 'max']),
  }),
])

function positive(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 必须是正整数`)
  return number
}
export function resolveTextModel(entry, config: Record<string, any> = {}) {
  if (!entry?.id || !entry?.provider || !PROVIDER_PROTOCOLS.includes(entry.protocol)) throw new Error('模型注册信息或协议无效')
  const ownContext = positive(entry.contextWindow, 'contextWindow')
  const ownOutput = positive(entry.maxOutputTokens, 'maxOutputTokens')
  const configuredContext = positive(config.contextWindow, 'contextWindow')
  const configuredOutput = positive(config.maxOutputTokens, 'maxOutputTokens')
  return { ...entry, label: entry.label || entry.id,
    contextWindow: ownContext ?? configuredContext ?? DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: ownOutput ?? configuredOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
    sources: { protocol: entry.protocolSource || '模型注册表', contextWindow: ownContext !== undefined ? entry.sources?.contextWindow || entry.contextSource || '模型自带' : configuredContext !== undefined ? config.contextSource || '配置' : '妙图默认上下文预算 1000000（上游容量未实测）', maxOutputTokens: ownOutput !== undefined ? entry.sources?.maxOutputTokens || entry.maxOutputSource || '模型自带' : configuredOutput !== undefined ? config.maxOutputSource || '配置' : '兜底 32768' },
    fields: { ...PROTOCOL_FIELDS[entry.protocol], ...(entry.fields || {}), ...(entry.protocol === 'openai-completions' ? { output: entry.maxTokensField || entry.compat?.maxTokensField || 'max_completion_tokens' } : {}) },
    compat: entry.protocol === 'openai-completions' ? { ...COMPLETIONS_COMPAT, ...(entry.compat || {}), ...(entry.maxTokensField ? { maxTokensField: entry.maxTokensField } : {}) } : entry.compat,
  }
}
export function ownTextModelIds(env = process.env) {
  return OWN_TEXT_MODELS.map(model => model.id)
}
export function ownTextModelById(id, env = process.env) {
  const entry = OWN_TEXT_MODELS.find(model => model.id === id)
  if (!entry) return null
  return resolveTextModel(entry, { contextWindow: env.OIP_TEXT_CONTEXT_WINDOW, maxOutputTokens: env.OIP_TEXT_MAX_OUTPUT_TOKENS, contextSource: 'OIP_TEXT_CONTEXT_WINDOW', maxOutputSource: 'OIP_TEXT_MAX_OUTPUT_TOKENS' })
}
export function customTextModel(provider, model, config: Record<string, any> = {}) {
  return resolveTextModel({
    ...model,
    provider: provider.id,
    protocol: provider.protocol,
    protocolSource: '账号供应商配置',
    compat: { ...(provider.compat || {}), ...(model.compat || {}) },
    fields: PROTOCOL_FIELDS[provider.protocol],
  }, config)
}
export function protocolUsage(models) {
  return PROVIDER_PROTOCOLS.map(protocol => ({ protocol, models: models.filter(model => model.protocol === protocol).map(model => model.id), status: models.some(model => model.protocol === protocol) ? '有模型使用' : '暂无模型使用' }))
}

export function assertOwnTextModelRegistry(env = process.env) {
  const models = ownTextModelIds(env).map(id => ownTextModelById(id, env))
  for (const model of models) {
    if (model.protocol !== 'openai-responses') throw new Error(`内置模型 ${model.id} 必须使用 openai-responses`)
    console.log(`[registry] model=${model.id} protocol=${model.protocol} contextWindow=${model.contextWindow} maxOutputTokens=${model.maxOutputTokens} sources=${JSON.stringify(model.sources)}`)
  }
  for (const item of protocolUsage(models)) {
    console.log(`[registry] protocol=${item.protocol} status=${item.status} models=${item.models.join(',') || '—'}`)
  }
  return models
}
