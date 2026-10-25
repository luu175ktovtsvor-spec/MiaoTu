import { ownTextModelById, ownTextModelIds } from './text-model-registry.ts'

const MAX_CREDITS = 1_000_000
const TEXT_PRICE_KEYS = Object.freeze(['inputCreditsPerMillionTokens', 'outputCreditsPerMillionTokens', 'cacheReadCreditsPerMillionTokens', 'cacheWriteCreditsPerMillionTokens', 'minimumCredits'])

export const DEFAULT_TEXT_PRICES = Object.freeze(Object.fromEntries(
  ownTextModelIds().map((id) => [id, Object.freeze({
    inputCreditsPerMillionTokens: 0,
    outputCreditsPerMillionTokens: 0,
    cacheReadCreditsPerMillionTokens: 0,
    cacheWriteCreditsPerMillionTokens: 0,
    minimumCredits: 0,
  })]),
))

function number(value, name) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_CREDITS) throw new Error(`${name}必须是 0 到 ${MAX_CREDITS} 之间的数字`)
  return Math.round(parsed * 10000) / 10000
}

export function normalizeTextPrices(value, message = '文本模型计费设置无效') {
  if (value === undefined || value === null) return { ...DEFAULT_TEXT_PRICES }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message)
  const result = {}
  for (const [id, raw] of Object.entries(value)) {
    const model = ownTextModelById(id)
    if (!model || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(message)
    for (const key of Object.keys(raw)) if (!TEXT_PRICE_KEYS.includes(key)) throw new Error(message)
    const defaults = DEFAULT_TEXT_PRICES[id]
    result[id] = { ...defaults }
    for (const key of TEXT_PRICE_KEYS) if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '') result[id][key] = number(raw[key], key)
    for (const key of ['cacheReadCreditsPerMillionTokens','cacheWriteCreditsPerMillionTokens']) if (raw[key] === undefined) result[id][key] = result[id].inputCreditsPerMillionTokens
  }
  for (const id of ownTextModelIds()) if (!result[id]) result[id] = { ...DEFAULT_TEXT_PRICES[id] }
  return result
}

export function publicTextCostPolicy(textPrices) {
  const prices = normalizeTextPrices(textPrices)
  return Object.fromEntries(ownTextModelIds().map((id) => {
    const model = ownTextModelById(id)
    const price = prices[id]
    return [id, {
      label: model.label,
      inputCreditsPerMillionTokens: price.inputCreditsPerMillionTokens,
      outputCreditsPerMillionTokens: price.outputCreditsPerMillionTokens,
      cacheReadCreditsPerMillionTokens: price.cacheReadCreditsPerMillionTokens,
      cacheWriteCreditsPerMillionTokens: price.cacheWriteCreditsPerMillionTokens,
      minimumCredits: price.minimumCredits,
      billingMode: 'usage_based',
      currentlyCharging: Object.values(price).some(Number),
    }]
  }))
}

function usageTokens(usage: Record<string, any> = {}) {
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? 0)
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? 0)
  return {
    input: Number.isFinite(input) && input > 0 ? Math.floor(input) : 0,
    output: Number.isFinite(output) && output > 0 ? Math.floor(output) : 0,
  }
}

export function textCreditsForUsage(modelId, usage: Record<string, any> = {}, textPrices) {
  const id = String(modelId || '').trim()
  const price = normalizeTextPrices(textPrices)[id]
  if (!price) return 0
  const tokens = usageTokens(usage)
  if (!tokens.input && !tokens.output) return 0
  const cached = Math.min(tokens.input, Math.max(0, Number(usage.cache_read_tokens || 0)))
  const written = Math.min(tokens.input - cached, Math.max(0, Number(usage.cache_write_tokens || 0)))
  const raw = ((tokens.input - cached - written) * price.inputCreditsPerMillionTokens
    + cached * price.cacheReadCreditsPerMillionTokens + written * price.cacheWriteCreditsPerMillionTokens) / 1_000_000
    + tokens.output * price.outputCreditsPerMillionTokens / 1_000_000
  const credits = Math.max(raw, Number(price.minimumCredits) || 0)
  return Math.round(credits * 10000) / 10000
}

export function textCreditsReserve(modelId, inputTokens, outputTokens, textPrices) {
  return textCreditsForUsage(modelId, { input_tokens: inputTokens, output_tokens: outputTokens }, textPrices)
}

// The hold is an estimate, not a cap on authoritative usage. Keep the exact
// four-decimal difference so settlement can distinguish a top-up from a refund.
export function textSettlementAmounts(points: unknown, reservedPoints: unknown) {
  const required = Math.max(0, Math.round(Number(points || 0) * 10000) / 10000)
  const reserved = Math.max(0, Math.round(Number(reservedPoints || 0) * 10000) / 10000)
  return { required, reserved,
    extra: Math.max(0, Math.round((required - reserved) * 10000) / 10000),
    refund: Math.max(0, Math.round((reserved - required) * 10000) / 10000),
  }
}

