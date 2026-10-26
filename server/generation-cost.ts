import { costPlusVideoCost, costPlusVideoEstimate, isCostPlusVideo, adminVideoPricing, videoExpenses } from './video-pricing.ts'
import { modelCatalog } from './image-models.ts'
import { suiheCost, SUIHE_CUSTOMER_MARKUP } from './suihe-pricing.ts'
export { SUIHE_CUSTOMER_MARKUP } from './suihe-pricing.ts'

const POLICY_VERSION = '2026-10-08.2'

/**
 * 积分定价：图片按模型定档（GPT 0.2、Grok 0.1、豆包 = 官方原价 + 0.15，按尺寸分档）；
 * 视频在任务创建前用能力参数做安全预扣，
 * 任务成功后优先按上游返回的实际 usage 对账。这样火山 Seedance 这类按
 * token 结算、且会随声音/参考视频/分辨率变化的接口不会被错误地当成纯秒价。
 */
export const IMAGE_CREDITS = 0.5
// Customer-facing surcharge for the current Suihe procurement channel. The
// legacy provider prices remain unchanged; this is applied only while the
// current model snapshot has provider === 'suihe'.

// 图片积分口径（用户 2026-10-06 定）：GPT 图片 0.2、Grok 图片 0.1、豆包 = 官方原价 + 0.15。
// 成本参考：云枢实测 GPT Image 2 ≈ $0.180/张、2.5 ≈ $0.201/张；豆包 Seedream
// 5.0 Flash ¥0.12、4.0 ¥0.20；Seedream 5.0 Pro 大尺寸官方 0.60 元/张是唯一
// 单张可能倒挂的配置（0.10 元），靠其他模型的单张利润覆盖，整体不亏。
// 如果以后要严格逐单不亏，把 Seedream 5.0 Pro 的尺寸限制在 ≤261 万像素即可。
// 详细推导与来源见 docs/模型成本与积分.md。
export const IMAGE_CREDIT_OVERRIDES = Object.freeze({})

// 用户 2026-10-06 定的图片积分口径：
//   GPT 图片（云枢）：0.2 积分/张；Grok 图片：0.1 积分/张；
//   豆包 Seedream：官方原价 + 0.15 积分，5.0 Pro 按像素分两档（≤261 万 / >261 万）。
// 成本参考见 UPSTREAM_COST_POLICY 里的 ARK_IMAGE_RMB 与 YUNSHU_IMAGE_USD。
const IMAGE_CREDIT_RULES = Object.freeze({
  // 用户 2026-10-06 最终定价：GPT 图片与 Grok 图片都固定 0.1 元/张。
  'gpt-image-2': 0.1,
  'gpt-image-2.5-sunburst': 0.1,
  'gpt-image-2.5-flare': 0.1,
  'grok-imagine-image': 0.1,
  'grok-imagine-image-2.0': 0.1,
})
// 豆包图片：官方原价 + 0.1（每张只赚一毛）。
export const ARK_IMAGE_CREDIT_MARKUP = 0.1

// 后台可改的价格覆盖（settings.prices）。管理端保存后由 management-store 调
// setPricingOverrides() 刷新；同一进程内所有计价函数立刻生效，改价不用重新发版。
// 形状：{ [模型ID]: { image?: 数值 或 {尺寸: 数值, default?: 数值}, video?: {分辨率: 数值} } }
let PRICING_OVERRIDES = Object.freeze({})
export function setPricingOverrides(map) {
  PRICING_OVERRIDES = map && typeof map === 'object' && !Array.isArray(map) ? map : Object.freeze({})
}
function overrideImage(id, size) {
  const entry = PRICING_OVERRIDES[id]
  if (!entry) return undefined
  const image = entry.image
  if (typeof image === 'number') return image
  if (image && typeof image === 'object') {
    if (size && image[size] !== undefined) return Number(image[size])
    if (image.default !== undefined) return Number(image.default)
  }
  return undefined
}
function overrideVideo(id, resolution) {
  const entry = PRICING_OVERRIDES[id]
  const table = entry?.video
  if (!table || typeof table !== 'object') return undefined
  const wanted = String(resolution || '').trim()
  if (table[wanted] !== undefined) return Number(table[wanted])
  const lower = wanted.toLowerCase()
  for (const [key, value] of Object.entries(table)) if (key.toLowerCase() === lower) return Number(value)
  return table.default === undefined ? undefined : Number(table.default)
}

export function imageCreditsPerImage(model, { size, pricing, layer = false }: Record<string, any> = {}) {
  const id = String(model?.publicId || model?.id || '')
  const isSuihe = model?.provider === 'suihe'
  const precision = isSuihe ? 10000 : 100
  const withSuiheMarkup = (value) => Math.round((Number(value) + (isSuihe ? SUIHE_CUSTOMER_MARKUP : 0)) * precision) / precision
  const policyPrice = (size ? pricing?.creditsPerImageBySize?.[size] : undefined)
    ?? pricing?.creditsPerImageBySize?.default
    ?? (!model?.customSize ? pricing?.creditsPerImage : undefined)
  if (policyPrice !== undefined && Number.isFinite(Number(policyPrice)) && Number(policyPrice) > 0) {
    // An administrator-entered price is already the customer-facing value.
    return Math.round(Number(policyPrice) * precision) / precision
  }
  const override = overrideImage(id, size)
  if (override !== undefined && Number.isFinite(override)) return Math.round(Number(override) * precision) / precision
  const fixed = IMAGE_CREDIT_RULES[id]
  if (fixed !== undefined) return withSuiheMarkup(fixed)
  if (isSuihe) {
    const cost=suiheCost(model,{size:size || model.sizes?.[0]?.value})
    if (cost) return withSuiheMarkup(cost.rmb)
    // A historical Suihe snapshot can outlive its current procurement table.
    // Keep its legacy model price as a last-resort quote for already admitted
    // records, while new unpriced tiers are rejected by the request validator.
    if (model.legacyProvider && model.legacyProvider !== 'suihe') {
      return withSuiheMarkup(imageCreditsPerImage({ ...model, provider: model.legacyProvider }, { size, layer }))
    }
    throw Error('该图片尺寸采购价尚未配置')
  }
  const ark = ARK_IMAGE_RMB[id]
  if (ark) return Math.round((arkUnitRmb(ark, size, layer) + ARK_IMAGE_CREDIT_MARKUP) * 100) / 100
  return IMAGE_CREDIT_OVERRIDES[id] ?? IMAGE_CREDITS
}

// 给画布用的「每个尺寸对应多少积分」映射（豆包两档像素价必须按尺寸显示才不误导）。
export function imageCreditsBySize(model) {
  const id = String(model?.publicId || model?.id || '')
  const ark = ARK_IMAGE_RMB[id]
  const override = PRICING_OVERRIDES[id]?.image
  if (model?.provider!=='suihe' && !ark && (!override || typeof override !== 'object' || !Object.keys(override).length)) return null
  const bySize = Object.fromEntries((model?.sizes || []).map(item => [item.value, imageCreditsPerImage(model, { size: item.value })]))
  const fallback = overrideImage(id, undefined)
  return fallback !== undefined && Number.isFinite(fallback) ? { ...bySize, default: imageCreditsPerImage(model, { size: undefined }) } : bySize
}

// 每秒积分单价 = 上游成本 × 安全上浮后取整到 0.1：
//   秘塔按“最贵可购档位”算成本：1000 积分 10.8 元 → 0.0108 元/积分
//   （比 4399 元 = 500000 积分的 0.0088 高约 23%，覆盖小额档位），再乘 1.34–1.72：
//     H3 480p/768P/1080p/2K = 6.82/10.2/15.91/17 积分/秒；16–30 秒使用官方 2 倍档；
//     Seedance 2.0 Mini 480p 16.20 → 0.175 元/秒 → 0.3；720p 35.09 → 0.379 → 0.6；
//     Seedance 2.0 标准版 480p 50.61 → 0.547 元/秒 → 0.8；720p 108.89 → 1.176 → 1.6；
//     1080p 271.77 → 2.935 元/秒 → 4；4K 553.67 → 5.98 → 8。
//   秘塔积分表中的"带参考视频"单价比不带更低，这里一律按更贵的"无参考视频"列计价。
//   火山方舟 fast 最终按 completion_tokens/total_tokens 计费；这里的秒价只在
//   创建前没有 usage 时做保守预扣，成功后会按实际 token 对账；
//   Grok 成本按用户确认的 1 倍率估算（按 xAI 官方刊例折算，倍率只留在服务端）。
export const VIDEO_CREDIT_RATES = Object.freeze({
  // 用户 2026-10-06 最终口径：视频**每秒赚 0.1 元** → 我们收 = 上游每秒成本 + 0.1。
  // 秘塔 H3 用官方元价；秘塔 Seedance 只有积分/秒，按秘塔页面写的换算基准
  // 4399 元 = 500000 积分（0.0088 元/积分）折成元；火山用官方价格示例表的元/秒。
  // Grok 是用户直接定价（480p 0.2 / 720p 0.4），不走这条规则。
  'seedance-2.0-fast': { '480p': 0.47, '720p': 0.9, default: 0.9 },
  // 兼容历史记录里的旧公开 ID（横线写法）。
  'seedance-2-0-fast': { '480p': 0.47, '720p': 0.9, default: 0.9 },
  'doubao-seedance-2-0-fast': { '480p': 0.47, '720p': 0.9, default: 0.9 },
  'MiniMax-H3': { '480p': 0.19, '768P': 0.19, '1080p': 0.19, '2K': 0.25, default: 0.19 },
  'seedance-2.0-mini': { '480p': 0.24, '720p': 0.41, '1280x720': 0.41, '720x1280': 0.41, default: 0.41 },
  'seedance-2.0': { '480p': 0.55, '720p': 1.06, '1080p': 2.49, '4k': 4.97, '4K': 4.97, '1280x720': 1.06, '720x1280': 1.06, default: 1.06 },
  'grok-imagine-video': { '480p': 0.2, '720p': 0.4, default: 0.4 },
  'grok-imagine-video-1.5': { '480p': 0.2, '720p': 0.4, '1080p': 0.9, default: 0.4 },
})

// 秘塔的输入素材计费（官方价目）：参考视频按输入时长 × 最终生成分辨率单价计费；
// 图片素材前 5 张免费，超出 5.7 积分/张 ≈ 0.062 元/张 → 收 0.1 积分/张（1.6x）。
export const VIDEO_INPUT_PRICING = Object.freeze({
  'seedance-2.5': { billReferenceVideoSeconds:true },
  'MiniMax-H3': { billReferenceVideoSeconds: true, freeReferenceImages: 5, extraImageCredits: 0.15 },
  // 火山官方按输入视频时长另计，且输入视频单价与输出单价不同；两档都按无折扣刊例上浮。
  // 火山「含输入视频」是另一个单价档（官方 22 元/百万 token）：按官方 token 公式
  // 480p ≈ 0.22、720p ≈ 0.48 元/秒，输入秒数与输出秒数同价，都再加 0.1 毛利。
  'seedance-2.0-fast': {
    billReferenceVideoSeconds: true,
    inputCreditsPerSecond: { '480p': 0.32, '720p': 0.58, default: 0.58 },
    outputCreditsPerSecondWithVideo: { '480p': 0.32, '720p': 0.58, default: 0.58 },
  },
  'seedance-2-0-fast': {
    billReferenceVideoSeconds: true,
    inputCreditsPerSecond: { '480p': 0.32, '720p': 0.58, default: 0.58 },
    outputCreditsPerSecondWithVideo: { '480p': 0.32, '720p': 0.58, default: 0.58 },
  },
  'doubao-seedance-2-0-fast': {
    billReferenceVideoSeconds: true,
    inputCreditsPerSecond: { '480p': 0.32, '720p': 0.58, default: 0.58 },
    outputCreditsPerSecondWithVideo: { '480p': 0.32, '720p': 0.58, default: 0.58 },
  },
  // 秘塔公开页面没有给 Seedance 单独列出参考视频折扣，按相同分辨率的
  // 无参考视频最高单价计入输入秒数，宁可高估也不能把参考视频漏算成免费。
  'seedance-2.0-mini': { billReferenceVideoSeconds: true },
  'seedance-2.0': { billReferenceVideoSeconds: true },
  // xAI 官方输入图/视频也按媒体计费。Grok 仍由云枢转发，倍率只留在服务端成本估算。
  // 视频输入的公开刊例没有单独列出分辨率档，按已公布的 $0.01/秒媒体
  // 输入保守折算，并在编辑/续写时强制采集输入视频真实时长，避免漏收。
  'grok-imagine-video': { billReferenceVideoSeconds: true, inputCreditsPerSecond: { default: 0.1 }, freeReferenceImages: 0, extraImageCredits: 0.1 },
  'grok-imagine-video-1.5': { billReferenceVideoSeconds: true, inputCreditsPerSecond: { default: 0.1 }, freeReferenceImages: 0, extraImageCredits: 0.1 },
})

// 火山方舟 Seedance 2.0 fast 的官方按量刊例以 token 计费，查询任务会返回
// usage.completion_tokens（视频接口的 total_tokens 等于它）。以无输入视频的最高刊例 37 元/百万 token、带输入视频的
// 22 元/百万 token 作为最终对账价；限时折扣、资源包和节省计划不写入产品成本，
// 避免活动结束后倒挂。Seedance 2.0 mini 的价格一并记录，方便以后启用该通道。
// 这些内部价格不会通过公开配置接口返回。
export const VIDEO_TOKEN_PRICING = Object.freeze({
  'seedance-2.0-fast': { provider: 'ark', noInputRmbPerMillion: 37, inputVideoRmbPerMillion: 22 },
  'doubao-seedance-2-0-fast-260128': { provider: 'ark', noInputRmbPerMillion: 37, inputVideoRmbPerMillion: 22 },
  'seedance-2.0-mini': { provider: 'ark', noInputRmbPerMillion: 23, inputVideoRmbPerMillion: 14 },
})

// 火山官方《Seedance 2.0 系列最低 token 用量表格（估算值）》：480p / 16:9（864×496），
// 输出 4–15 秒。官方只给了 16:9/9:16 与 4:3/3:4 两组像素边数，且 4:3 的官方值
// （4 秒 69,090）与按像素等比换算的结果一致，说明该表就是按像素等比生成的，
// 所以其余分辨率/画幅用像素等比推算。含输入视频时上游按下限收费。
const ARK_MIN_TOKENS_480P_16_9 = Object.freeze({
  4: 70308, 5: 90396, 6: 100440, 7: 120528, 8: 140616, 9: 150660,
  10: 170748, 11: 190836, 12: 200880, 13: 220968, 14: 241056, 15: 251100,
})
const ARK_PIXEL_SIZES = Object.freeze({
  '480p:16:9': 864 * 496, '480p:9:16': 864 * 496, '480p:4:3': 752 * 560, '480p:3:4': 752 * 560,
  // adaptive 表示跟随输入素材画幅；按官方最常见画幅 16:9 估下限，不能放行成 0 下限。
  '480p:adaptive': 864 * 496,
  '720p:16:9': 1280 * 720, '720p:9:16': 1280 * 720, '720p:4:3': 1112 * 834, '720p:3:4': 1112 * 834,
  '720p:adaptive': 1280 * 720,
})

export function arkMinimumTokens({ resolution, ratio, duration }: Record<string, any> = {}) {
  const seconds = Math.round(Number(duration) || 0)
  const base = ARK_MIN_TOKENS_480P_16_9[seconds]
  if (!base) return 0
  const key = `${String(resolution || '').trim().toLowerCase()}:${String(ratio || '16:9').trim().toLowerCase()}`
  const pixels = ARK_PIXEL_SIZES[key]
  if (!pixels) return 0
  return Math.round(base * pixels / (864 * 496))
}

function usageNumber(usage, keys) {
  for (const key of keys) {
    const value = Number(usage?.[key])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/** Return the billable token count exposed by an upstream task result. */
export function videoUsageTokens(usage) {
  return usageNumber(usage, ['completion_tokens', 'total_tokens', 'output_tokens', 'tokens'])
}

function usageBasedVideoCredits({ model, provider, usage, hasInputVideo, resolution, ratio, duration }: Record<string, any>) {
  const id = String(model || '')
  const policy = VIDEO_TOKEN_PRICING[id]
  if (!policy || (provider && policy.provider !== provider)) return null
  const reported = videoUsageTokens(usage)
  if (!reported) return null
  // 含输入视频时上游有最低 token 用量，低于下限按下限收费；这里按官方表夹取，
  // 让「我们的成本」和用户扣分都落在上游真实账单上。
  const floor = hasInputVideo ? arkMinimumTokens({ resolution, ratio, duration }) : 0
  const tokens = Math.max(reported, floor)
  const rate = hasInputVideo ? policy.inputVideoRmbPerMillion : policy.noInputRmbPerMillion
  if (!Number.isFinite(rate) || rate <= 0) return null
  return {
    tokens,
    reportedTokens: reported,
    floorTokens: floor,
    floorApplied: floor > reported,
    rmbPerMillion: rate,
    points: Math.max(0.1, roundUpCredits(tokens / 1_000_000 * rate)),
  }
}

export function videoCreditsPerSecond(model, resolution) {
  const id = String(model?.publicId || model?.id || model || '')
  const isSuihe = model?.provider === 'suihe'
  const withSuiheMarkup = (value) => Math.round((Number(value) + (isSuihe ? SUIHE_CUSTOMER_MARKUP : 0)) * 1000) / 1000
  const override = overrideVideo(id, resolution)
  // An administrator-entered rate is already the customer-facing value.
  if (override !== undefined && Number.isFinite(override)) return Math.round(Number(override) * 1000) / 1000
  if (isSuihe) {
    const cost = suiheCost(model, { duration: 5, billableDuration: 5, resolution, ratio: '16:9' }, { seconds: 5 })
    return cost ? Math.round((cost.rmb / 5 + SUIHE_CUSTOMER_MARKUP) * 1000) / 1000 : null
  }
  if (isCostPlusVideo(id)) {
    const policy = adminVideoPricing(); const tier = policy.metasoTiers[id];
    const selected = resolution || (id === 'MiniMax-H3' ? '768P' : '720p');
    if (tier) { const item = tier[String(selected).toLowerCase()]; if (!item) return null; const expenses=videoExpenses(policy);return withSuiheMarkup(Math.ceil((item.withoutVideo * policy.metasoRmbPerCredit + policy.markupPerSecond+expenses.rmbPerOutputSecond)/(1-expenses.paymentFeePercent/100)*10000)/10000) }
    return withSuiheMarkup(costPlusVideoEstimate({model:id,parameters:{duration:5,resolution:selected,ratio:'16:9'}}).points/5)
  }
  const rates = VIDEO_CREDIT_RATES[id] || { default: 0.5 }
  const wanted = String(resolution || '').trim()
  if (rates[wanted] !== undefined) return withSuiheMarkup(rates[wanted])
  // 档位键必须大小写无关：画布用 `4K`，发送给秘塔的是官方的 `4k`，
  // 查表落空会退回 default（1.6），而 4K 档成本是 5.98 元/秒，会直接亏。
  const lowered = wanted.toLowerCase()
  for (const [key, value] of Object.entries(rates)) {
    if (key !== 'default' && key.toLowerCase() === lowered) return withSuiheMarkup(value)
  }
  return withSuiheMarkup(rates.default ?? 0.5)
}

// 单次视频生成的积分：创建前按模型能力、分辨率、时长和输入媒体做安全预扣；
// 成功后若上游返回可对账 usage（目前为方舟 Seedance token），按实际 usage 结算，
// 否则使用对应供应商的能力参数估算。最终统一向上取到 0.1，最低 1 积分。
export function estimateVideoCredits({ model, provider, duration, billableDuration, resolution, ratio = '', videoSeconds = 0, referenceImages = 0, usage }: Record<string, any> = {}) {
  // duration 用于 UI/上游整数选项；billableDuration 用于 frames/24 这类
  // 仍代表视频秒数但不一定是整数的官方参数。最终积分仍向上取 0.1。
  const rawSeconds = Number(billableDuration ?? duration ?? 5)
  const seconds = Math.max(1, Number.isFinite(rawSeconds) ? rawSeconds : 5)
  const perSecond = videoCreditsPerSecond(model, resolution)
  const rules = VIDEO_INPUT_PRICING[model] || {}
  // 上游按实际输入时长计费；保留毫秒级精度，最终积分仍统一向上取到 0.1。
  const billedVideoSeconds = rules.billReferenceVideoSeconds
    ? Math.max(0, Math.round((Number(videoSeconds) || 0) * 1000) / 1000)
    : 0
  const hasInputVideo = billedVideoSeconds > 0
  const suiheMarkup = model?.provider === 'suihe' ? SUIHE_CUSTOMER_MARKUP : 0
  const outputPerSecond = hasInputVideo
    ? Number(rules.outputCreditsPerSecondWithVideo?.[String(resolution || '').trim()] ?? rules.outputCreditsPerSecondWithVideo?.default ?? perSecond) + suiheMarkup
    : perSecond
  const inputPerSecond = rules.billReferenceVideoSeconds
    ? (rules.inputCreditsPerSecond?.[String(resolution || '').trim()] ?? rules.inputCreditsPerSecond?.default ?? outputPerSecond)
    : 0
  const extraImages = rules.extraImageCredits
    ? Math.max(0, Math.trunc(Number(referenceImages) || 0) - (rules.freeReferenceImages || 0))
    : 0
  const inputCredits = extraImages * (rules.extraImageCredits || 0)
  const usageCost = usageBasedVideoCredits({ model, provider, usage, hasInputVideo, resolution, ratio, duration: seconds })
  // 成功任务有真实 usage 时，它是最终账单依据；创建前没有 usage，继续用
  // 能力参数预扣，保证调用上游前仍然能检查余额。
  if (usageCost) {
    return {
      seconds,
      resolution: String(resolution || ''),
      perSecond,
      billedVideoSeconds,
      inputPerSecond,
      inputCredits,
      outputPerSecond,
      usageBased: true,
      usageTokens: usageCost.tokens,
      reportedTokens: usageCost.reportedTokens,
      floorTokens: usageCost.floorTokens,
      floorApplied: usageCost.floorApplied,
      usageRmbPerMillion: usageCost.rmbPerMillion,
      points: usageCost.points,
    }
  }
  return {
    seconds,
    resolution: String(resolution || ''),
    perSecond,
    billedVideoSeconds,
    inputPerSecond,
    inputCredits,
    outputPerSecond,
    usageBased: false,
    usageTokens: 0,
    usageRmbPerMillion: 0,
    points: Math.max(0.1, roundUpCredits(seconds * outputPerSecond + billedVideoSeconds * inputPerSecond + inputCredits)),
  }
}

function roundUpCredits(value) {
  return Math.max(0.1, Math.ceil(Number(value) * 10 - 1e-9) / 10)
}

export function estimateGenerationCost({ model, generation, referenceCount = 0, price }: Record<string, any> = {}) {
  if (model?.video) {
    if (model.provider === 'suihe') {
      const id = String(model.publicId || model.id || '')
      const manualRate = generation?.submissionState !== undefined
        ? generation.manualVideoCreditsPerSecond
        : overrideVideo(id, generation?.resolution)
      if (manualRate !== undefined && Number.isFinite(Number(manualRate)) && Number(manualRate) >= 0.01) {
        const manual = costPlusVideoEstimate({
          model,
          parameters: { ...generation, manualVideoCreditsPerSecond: Number(manualRate) },
          usage: generation?.usage,
        })
        if (manual) return manual
      }
      const requestedSeconds = Number(generation?.billableDuration ?? generation?.duration)
      if (!(requestedSeconds > 0)) throw Error('穗禾视频计费时长无效')
      const cost = suiheCost(model, generation, { seconds: requestedSeconds, usage: generation?.usage })
      if (!cost) throw Error('该穗禾视频档位采购价尚未配置')
      const outputSeconds = Number(cost.outputSeconds || requestedSeconds)
      // Accepted tasks keep the surcharge frozen at submission. Older tasks
      // without this field used RMB 0.5 and must not be repriced retroactively.
      const markupPerUnit = generation?.suiheCost?.customerMarkupRmbPerUnit
        ?? (generation?.submissionState !== undefined ? 0.5 : SUIHE_CUSTOMER_MARKUP)
      const markup = Math.round(outputSeconds * markupPerUnit * 10000) / 10000
      const points = Math.max(0.0001, Math.round((cost.rmb + markup) * 10000) / 10000)
      return {
        points,
        count: 1,
        duration: outputSeconds,
        usageBased: Boolean(cost.usageBased),
        policyVersion: `${POLICY_VERSION}:${cost.pricingSnapshot?.version || 'suihe'}`,
        breakdown: {
          durationSeconds: outputSeconds,
          resolution: generation?.resolution || 'default',
          perSecond: Math.round((cost.rmb / Math.max(outputSeconds, 1) + markupPerUnit) * 10000) / 10000,
          outputPerSecond: Math.round((cost.rmb / Math.max(outputSeconds, 1) + markupPerUnit) * 10000) / 10000,
          inputVideoSeconds: Number(generation?.videoSeconds) || 0,
          inputVideoPerSecond: 0,
          inputImageCredits: 0,
          billingSource: cost.usageBased ? 'upstream_usage' : 'parameter_reserve',
          usageTokens: cost.detail?.tokens || 0,
          reportedTokens: cost.detail?.reportedTokens || 0,
          usageRmbPerMillion: cost.detail?.rmbPerMillion || 0,
          providerCostRmb: cost.rmb,
          customerMarkupRmb: markup,
          minimum: 0.0001,
        },
      }
    }
    const id = model.publicId || model.id
    // Reserved tasks keep their original pricing mode and manual rate. Only
    // a fresh quote reads current admin overrides.
    const manualVideoCreditsPerSecond = generation?.submissionState !== undefined
      ? generation.manualVideoCreditsPerSecond
      : overrideVideo(id, generation?.resolution)
    const parameters = manualVideoCreditsPerSecond === undefined
      ? generation
      : { ...generation, manualVideoCreditsPerSecond }
    // Suihe reuses a legacy model ID but has its own customer surcharge. Do
    // not let the legacy provider's cost-plus branch bypass that surcharge.
    const costPlus = model.provider === 'suihe' ? null : costPlusVideoEstimate({ model, parameters, usage: generation?.usage })
    if (costPlus) return costPlus
    const estimate = estimateVideoCredits({
      model: model.publicId || model.id,
      provider: model.provider,
      duration: generation?.duration,
      billableDuration: generation?.billableDuration,
      resolution: generation?.resolution,
      ratio: generation?.ratio,
      videoSeconds: generation?.videoSeconds,
      referenceImages: generation?.referenceImages,
      usage: generation?.usage,
    })
    return {
      points: estimate.points,
      count: 1,
      duration: estimate.seconds,
      breakdown: {
        durationSeconds: estimate.seconds,
        resolution: estimate.resolution || 'default',
        perSecond: estimate.outputPerSecond,
        outputPerSecond: estimate.outputPerSecond,
        inputVideoSeconds: estimate.billedVideoSeconds,
        inputVideoPerSecond: estimate.inputPerSecond,
        inputImageCredits: Math.round(estimate.inputCredits * 100) / 100,
        billingSource: estimate.usageBased ? 'upstream_usage' : 'parameter_reserve',
        usageTokens: estimate.usageTokens || 0,
        reportedTokens: estimate.reportedTokens || 0,
        floorTokens: estimate.floorTokens || 0,
        floorApplied: Boolean(estimate.floorApplied),
        usageRmbPerMillion: estimate.usageRmbPerMillion || 0,
        minimum: 0.1,
      },
      policyVersion: POLICY_VERSION,
      usageBased: Boolean(estimate.usageBased),
    }
  }
  const count = Math.max(1, Math.floor(Number(generation?.count) || 1))
  const perImage = imageCreditsPerImage(model, { size: generation?.size, pricing: price, layer: Boolean(generation?.layerDecomposition) })
  // 5.0 Pro 的输入图费按次原价转嫁，不加价；后台手动定价时不另加。
  const modelKey = String(model?.publicId || model?.id || '')
  const referenceCredits = model.provider==='suihe' || PRICING_OVERRIDES[modelKey]?.image !== undefined ? 0 : arkReferenceRmb(ARK_IMAGE_RMB[modelKey], referenceCount)
  return {
    // 图片积分保留两位小数：豆包是「原价 + 0.15」，四舍五入到 0.1 会变成 +0.2。
    points: Math.max(0.01, Math.round((count * perImage + referenceCredits) * (model.provider === 'suihe' ? 10000 : 100)) / (model.provider === 'suihe' ? 10000 : 100)),
    count,
    breakdown: {
      perImage,
      referenceCredits: Math.round(referenceCredits * 100) / 100,
      references: Math.max(0, Math.floor(Number(referenceCount) || 0)),
      size: 0,
      transparentBackground: 0,
    },
    policyVersion: POLICY_VERSION,
  }
}

/**
 * 上游成本口径（内部，只给管理端对账用；不进入公开配置接口）。
 *
 * 规则：能按上游真实账单结算的按真实账单（火山 token、秘塔积分），
 * 秘塔积分按「最贵可购档位」0.0108 元/积分折算（用户要求按最贵的算成本），
 * Grok 按 xAI 官方每秒价 × 渠道倍率 × 结汇价。所有数字都是成本，不是售价。
 */
// 成本口径（2026-10-06 用户确认）：
//   秘塔 / Grok / 豆包：按「实际分辨率（或尺寸）那一档」记账，未知档回退该模型最贵档；
//   火山：token 是上游真实用量（官方说明 completion_tokens 已含最低 token 下限），
//         单价取该模型较高的那一档（37 / 23 元每百万 token）。
export const UPSTREAM_COST_POLICY = Object.freeze({
  rmbPerUsd: 7.2,
  grokMultiplier: 1,
  // 最贵可购档位（1000 积分 = 10.8 元）。实际购买档位是 10000 积分 = 99 元即 0.0099，
  // 官方页面标注的换算基准是 4399 元 = 500000 积分即 0.0088；成本按最贵的算。
  metasoRmbPerCredit: 0.0108,
  // H3：Context IR 0.05 元/次；图片素材超 5 张 0.05 元/张（秘塔控制台原文）。
  metasoContextIrRmb: 0.05,
  metasoImageRmbAfterFive: 0.05,
})

// 秘塔自家积分价目（元/积分 换算见上）。H3 的 480p/768P/1080p/2K 来自官方价目接口；
// 2026-10-06 又从秘塔控制台「API 用量」的逐单扣费明细里核对到：
//   输出 768P 视频 = 10.2 积分/秒；H3 Context-IR 按次 5.7 积分；
//   Seedance 2.0 Mini（480p）= 16.20 积分/秒（扣费原文「输出视频 4 秒 × 16.20 积分/秒 = 64.80 积分」）。
// 标准版 720p 以外、Mini 720p、H3 480p/512p 没有公开价，也没有可用样本，标 _unverified。
// 用户口径（2026-10-06）：成本按「每个模型最贵的那一档」算，不按实际分辨率分档，
// 也不纠结充值档位（99 元档 / 4399 元档）。
//   H3：官方直接给出元价，最贵档是 2K 的 0.15 元/秒；
//   Seedance 没有公开元价，只有积分/秒，取该模型最高档积分 × 最贵可购档 0.0108 元/积分。
const METASO_COST_PER_SECOND = Object.freeze({
  'MiniMax-H3': { rmb: 0.15, source: 'official_price_page_top_tier_2K', creditsPerSecond: 17.0 },
  'seedance-2.0-mini': { rmb: 0.379, source: 'verified_720p_35.09_credits_times_most_expensive_tier', creditsPerSecond: 35.09 },
  'seedance-2.0': { rmb: 5.98, source: 'top_tier_4k_553.67_credits_times_most_expensive_tier', creditsPerSecond: 553.67 },
})

// 火山图片刊例（元/张，无折扣）：5.0 Pro 两档像素价、Flash、4.0。
// 2026-10-22 对照火山「模型价格」页：5.0 Pro 图层拆分按每个图层的像素档另算
// （0.15 / 0.30），输入图首张免费、第 2 张起 0.02 元/张；Flash 与 4.0 输入图免费。
const ARK_IMAGE_RMB = Object.freeze({
  'doubao-seedream-5-0-pro': { small: 0.30, large: 0.60, layerSmall: 0.15, layerLarge: 0.30, freeReferences: 1, extraReferenceRmb: 0.02 },
  'doubao-seedream-5-0-flash': { small: 0.12, large: 0.12 },
  'doubao-seedream-4-0': { small: 0.20, large: 0.20 },
})
// 云枢实测（usage_logs）：gpt-image-2 104 次均值、2.5 两档 22/3 次均值。
const YUNSHU_IMAGE_USD = Object.freeze({
  // 2026-10-06 从云枢 usage_logs 复核：gpt-image-2 最近三笔（含真实用户那笔 183/515 token）
  // 都是固定 $0.201/张、rate_multiplier=1.0，与 token 数无关 → 按张固定价，取 0.201。
  'gpt-image-2': 0.201,
  'gpt-image-2.5-flare': 0.201,
  'gpt-image-2.5-sunburst': 0.201,
})
const GROK_IMAGE_USD = 0.04
const GROK_VIDEO_USD_PER_SECOND = Object.freeze({
  'grok-imagine-video': { '480p': 0.05, '720p': 0.07, default: 0.07 },
  'grok-imagine-video-1.5': { '480p': 0.08, '720p': 0.14, '1080p': 0.25, default: 0.14 },
})

// 火山智能尺寸按边长档位出图：1K≈1024²、1.5K≈1536²、2K≈2048²。auto 只用于图层拆分，
// 跟随输入图，像素未知时按高档计。以前这些档位算成 0 像素，2K 落进了低价档。
const PRESET_PIXELS = Object.freeze({ '1k': 1024 * 1024, '1.5k': 1536 * 1536, '2k': 2048 * 2048, auto: 2048 * 2048 })
function pixelsOf(size) {
  const value = String(size || '').trim()
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(value)
  return match ? Number(match[1]) * Number(match[2]) : PRESET_PIXELS[value.toLowerCase()] || 0
}
function arkUnitRmb(price, size, layer = false) {
  const large = pixelsOf(size) > 2_610_000
  if (layer && price.layerSmall !== undefined) return large ? price.layerLarge : price.layerSmall
  return large ? price.large : price.small
}
function arkReferenceRmb(price, referenceCount) {
  if (!price?.extraReferenceRmb) return 0
  return Math.max(0, Math.floor(Number(referenceCount) || 0) - (price.freeReferences || 0)) * price.extraReferenceRmb
}

/** 单次视频生成的上游成本（元）。返回 basis 说明这条成本是怎么来的。 */
export function upstreamVideoCostRmb({ model, parameters = {}, usage, seconds }: Record<string, any> = {}) {
  // Suihe is a procurement channel over the Volcengine models. Its quoted
  // cost is the native Volcengine token tariff multiplied by the owner
  // discount; keep this branch before the legacy provider-specific policies so
  // completed Suihe tasks are retained in the same reconciliation ledger.
  if (String(model?.provider || '') === 'suihe') {
    return suiheCost(model, parameters, { usage, seconds })
  }
  const costPlus = costPlusVideoCost({ model, parameters, usage, seconds })
  if (costPlus) { const { rawRmb, outputSeconds, markupPerSecond, usageBased, ...cost } = costPlus; return cost }
  const id = String(model?.publicId || model?.id || '')
  const provider = String(model?.provider || '')
  const resolution = String(parameters.resolution || '')
  const duration = Number(seconds ?? parameters.billableDuration ?? parameters.duration ?? 0) || 0
  const inputSeconds = Number(parameters.videoSeconds || 0) || 0
  const referenceImages = Number(parameters.referenceImages || 0) || 0
  const policy = UPSTREAM_COST_POLICY
  if (provider === 'ark') {
    const tokenPolicy = VIDEO_TOKEN_PRICING[id]
    if (!tokenPolicy) return null
    const hasInputVideo = Boolean(inputSeconds > 0 || parameters.video || (Array.isArray(parameters.videos) && parameters.videos.length))
    const floor = hasInputVideo ? arkMinimumTokens({ resolution, ratio: parameters.ratio, duration }) : 0
    const tokens = Math.max(videoUsageTokens(usage), floor)
    if (!tokens) return null
    // 用户口径（2026-10-06 确认）：按「这一次请求的那个档位」取价——档位由本次请求
    // 是否包含输入视频决定：不含输入视频 37、含输入视频 22（mini 是 23 / 14 元每百万 token）。
    // 官方《查询视频生成任务》说明：completion_tokens 触发最低 token 用量时直接返回下限值，
    // 平台按下限计费；所以「返回的 token × 本次档位单价」就是上游那张单子的金额。
    const rate = hasInputVideo ? tokenPolicy.inputVideoRmbPerMillion : tokenPolicy.noInputRmbPerMillion
    return {
      rmb: Math.round(tokens / 1_000_000 * rate * 10000) / 10000,
      basis: hasInputVideo ? 'volcengine_token_list_price_with_input_video' : 'volcengine_token_list_price',
      detail: { tokens, floorTokens: floor, floorApplied: floor > videoUsageTokens(usage), rmbPerMillion: rate, hasInputVideo },
    }
  }
  if (provider === 'metaso') {
    const tier = METASO_COST_PER_SECOND[id]
    if (!tier) return null
    // 用户口径（2026-10-06 确认）：按「实际分辨率那一档」记账；只有该分辨率没有
    // 已知价时才回退到该模型最贵档，保证不会低估成本。
    const tierRmb = metasoResolutionTierRmb(id, resolution)
    const perSecond = tierRmb ?? tier.rmb
    const contextIr = id === 'MiniMax-H3' && parameters.contextIr !== false ? policy.metasoContextIrRmb : 0
    // 秘塔任务查询会回自己的计费用量：output_seconds / total_seconds、input_seconds、
    // input_image_count。有上游实际用量就按它算，没有再退回参数估算。
    const usageOutputSeconds = Number(usage?.output_seconds ?? usage?.total_seconds)
    const usageInputSeconds = Number(usage?.input_seconds)
    const usageImageCount = Number(usage?.input_image_count)
    const billedOutputSeconds = Number.isFinite(usageOutputSeconds) && usageOutputSeconds > 0 ? usageOutputSeconds : duration
    const billedInputSeconds = Number.isFinite(usageInputSeconds) && usageInputSeconds >= 0 ? usageInputSeconds : inputSeconds
    const billedImages = Number.isFinite(usageImageCount) && usageImageCount >= 0 ? usageImageCount : referenceImages
    const imageRmb = Math.max(0, billedImages - 5) * policy.metasoImageRmbAfterFive
    const rmb = Math.round((billedOutputSeconds * perSecond + billedInputSeconds * perSecond + imageRmb + contextIr) * 10000) / 10000
    return {
      rmb,
      basis: tierRmb == null ? `metaso_top_tier_fallback:${tier.source}` : `metaso_resolution_tier:${resolution}`,
      detail: {
        perSecondRmb: perSecond,
        creditsPerSecondAtTopTier: tier.creditsPerSecond,
        outputSeconds: billedOutputSeconds,
        inputSeconds: billedInputSeconds,
        images: billedImages,
        imageRmb,
        contextIrRmb: contextIr,
        source: Number.isFinite(usageOutputSeconds) ? 'upstream_usage' : 'parameter_estimate',
        resolutionUsed: resolution || '',
        topTierRmb: tier.rmb,
        topTierCreditsPerSecond: tier.creditsPerSecond,
      },
    }
  }
  const rates = GROK_VIDEO_USD_PER_SECOND[id]
  if (!rates) return null
  // 按实际分辨率档记账；未知档回退到该模型最贵分辨率。
  const perSecondUsd = rates[resolution] ?? Math.max(...Object.values(rates).map(Number))
  const usd = (duration + inputSeconds) * perSecondUsd * policy.grokMultiplier
  return {
    rmb: Math.round(usd * policy.rmbPerUsd * 10000) / 10000,
    basis: 'xai_usd_per_second_with_channel_multiplier',
    detail: { seconds: duration + inputSeconds, perSecondUsd, multiplier: policy.grokMultiplier, rmbPerUsd: policy.rmbPerUsd },
  }
}

/** 单次图片生成的上游成本（元）。count 是实际保存的张数。 */
export function upstreamImageCostRmb({ model, count = 1, parameters = {} }: Record<string, any> = {}) {
  const id = String(model?.publicId || model?.id || '')
  const provider = String(model?.provider || '')
  const policy = UPSTREAM_COST_POLICY
  const images = Math.max(1, Math.floor(Number(count) || 1))
  if (provider==='suihe') return suiheCost(model,parameters,{count:images})
  const frozen=parameters.upstreamImagePricing
  if (frozen?.version === 'image-cost-snapshot-2026-10-08' && frozen.model === id && Number.isFinite(frozen.unitRmb)) {
    // 参考图费按次收，不随张数翻倍；旧快照没有 referenceRmb，按 0 算。
    const referenceRmb=Number(frozen.referenceRmb)||0
    return {rmb:Math.round((frozen.unitRmb*images+referenceRmb)*10000)/10000,basis:frozen.basis,detail:{...frozen.detail,images,requestedSize:parameters.size||'',requestedQuality:parameters.quality||'',referenceCount:parameters.referenceCount??0,pricingSnapshot:frozen,...(frozen.expenses?{expenses:frozen.expenses,serverAllocatedRmb:frozen.expenses.rmbPerRequest||0}:{})}}
  }
  if (provider === 'ark') {
    const price = ARK_IMAGE_RMB[id]
    if (!price) return null
    const px = pixelsOf(parameters.size)
    const unit = arkUnitRmb(price, parameters.size, Boolean(parameters.layerDecomposition))
    const referenceRmb = arkReferenceRmb(price, parameters.referenceCount)
    return { rmb: Math.round((unit * images + referenceRmb) * 10000) / 10000, basis: 'volcengine_image_list_price', detail: { unit, images, pixels: px, referenceRmb, layerDecomposition: Boolean(parameters.layerDecomposition) } }
  }
  const usd = provider === 'grok' ? GROK_IMAGE_USD : YUNSHU_IMAGE_USD[id]
  if (!usd) return null
  // Grok 走渠道倍率，云枢是实测账单本身，不再乘倍率。
  const billedUsd = usd * (provider === 'grok' ? policy.grokMultiplier : 1)
  return {
    rmb: Math.round(billedUsd * policy.rmbPerUsd * images * 10000) / 10000,
    basis: provider === 'grok' ? 'xai_image_usd_with_channel_multiplier' : 'yunshu_measured_usd_per_image',
    detail: { usdPerImage: billedUsd, usdListPrice: usd, images, rmbPerUsd: policy.rmbPerUsd, ...(provider === 'grok' ? { multiplier: policy.grokMultiplier } : {}) },
  }
}

// 秘塔各分辨率的单秒成本（元）：H3 用官方元价，Seedance 用已核到的积分/秒 × 最贵可购档。
const METASO_RESOLUTION_RMB = Object.freeze({
  'MiniMax-H3': { '480p': 0.073656, '768P': 0.11016, '1080p': 0.171828, '2K': 0.1836 },
  'seedance-2.0-mini': { '480p': 0.175, '720p': 0.379 },
  'seedance-2.0': { '480p': 0.547, '720p': 1.176, '1080p': 2.935, '4k': 5.98 },
})

export function metasoResolutionTierRmb(model, resolution) {
  const table = METASO_RESOLUTION_RMB[String(model || '')]
  if (!table) return null
  const key = String(resolution || '').trim()
  const hit = table[key] ?? table[key.toLowerCase()]
  return hit == null ? null : hit
}

// Created from server-normalized parameters, never accepted from client input.
export function imagePricingSnapshot(model, parameters: Record<string, any> = {}) {
  const cost=upstreamImageCostRmb({model,count:1,parameters:{...parameters,referenceCount:0}})
  const price=model?.provider==='ark'?ARK_IMAGE_RMB[String(model.publicId||model.id||'')]:null
  const referenceRmb=price?arkReferenceRmb(price,parameters.referenceCount):0
  return cost ? {version:'image-cost-snapshot-2026-10-08',model:model.publicId||model.id,unitRmb:cost.rmb,referenceRmb,basis:cost.basis,detail:cost.detail,...(videoExpenses().serverAllocationMode==='all_media_requests'?{expenses:videoExpenses()}: {})} : null
}

export function estimateUpstreamCostRmb(input: Record<string, any> = {}) {
  return input.model?.video
    ? upstreamVideoCostRmb(input)
    : upstreamImageCostRmb(input)
}

export function publicCostPolicy(catalog = modelCatalog()) {
  return {
    version: POLICY_VERSION,
    videoPricing: adminVideoPricing(),
    creditsPerImageRules: IMAGE_CREDIT_RULES,
    arkImageMarkup: ARK_IMAGE_CREDIT_MARKUP,
    rules: [
      '每张生成图片按模型的积分单价计费：GPT 图片 0.1、Grok 图片 0.1、豆包按官方原价 + 0.1（分辨率越高单价越高）',
      '非 Grok 视频：上游成本加生成时长每秒加价，向上取到 0.01 积分；先预扣，成功后按实际用量结算；Grok 原价保持',
      '每个视频模型的秒数、分辨率不同，可选项由模型能力给出（如 4–15 秒、720p）',
      'H3 参考视频按输入时长计费，图片素材前 5 张免费、超出按张计费',
      '用户积分按任务状态结算；上游失败、取消或返回不明是否扣费须凭原请求查账，未知不当零成本',
    ],
    models: Object.fromEntries(catalog.map((model: any) => {
      const id = model.publicId || model.id
      // 一律走「有效价」入口，后台调价后这里立刻反映真实售价。
      if (!model.video) {
        const bySize = imageCreditsBySize(model) ?? Object.fromEntries((model.sizes || []).map((size) => [size.value, imageCreditsPerImage(model, { size: size.value })]))
        const fallback = overrideImage(id, undefined)
        if (fallback !== undefined && Number.isFinite(fallback)) bySize.default = Math.round(fallback * 100) / 100
        return [id, { creditsPerImage: imageCreditsPerImage(model), creditsPerImageBySize: bySize }]
      }
      const perSecond = Object.fromEntries((model.sizes || []).map((size) => [size.value, videoCreditsPerSecond(model, size.value)]))
      if (isCostPlusVideo(id)) return [id, { durations:model.durations, sizes:(model.sizes||[]).map(x=>x.value), creditsPerSecond:perSecond, defaultCreditsPerSecond:videoCreditsPerSecond(model,''), inputPricing:{billReferenceVideoSeconds:true,...(id==='MiniMax-H3'?{freeReferenceImages:5,extraImageCredits:5.7*adminVideoPricing().metasoRmbPerCredit}:{} )}, billingMode:'upstream_usage', minimumCredits:0.01, rounding:'ceil-0.01', pricingMode:'cost_plus', settlesActualUsage:true }]
      return [id, {
        durations: model.durations || [],
        sizes: (model.sizes || []).map((size) => size.value),
        creditsPerSecond: perSecond,
        defaultCreditsPerSecond: videoCreditsPerSecond(model, ''),
        inputPricing: VIDEO_INPUT_PRICING[id] || null,
        billingMode: VIDEO_TOKEN_PRICING[id] ? 'upstream_usage' : 'parameter_estimate',
        minimumCredits: 0.1,
        rounding: 'ceil-0.1',
      }]
    })),
  }
}
