// Supplier price sources: Metaso /minimax-h3 (2026-10-08), Ark model-pricing.
// Cost and markup are captured at submission so later admin edits cannot alter a task.
import { isSeedance25, SEEDANCE25_PRICING } from './seedance25.ts'
export const VIDEO_PRICING_VERSION = 'video-cost-plus-2026-10-22'
export const DEFAULT_VIDEO_PRICING = Object.freeze({ metasoRmbPerCredit: 0.0108, markupPerSecond: 0.1, paymentFeePercent:null, serverMonthlyRmb:null, serverAnnualUsd:null, usdToRmb:null, monthlyBillableVideoSeconds:null, otherRmbPerSecond:null, serverAllocationMode:'video_seconds', monthlyMediaRequests:null })
export const METASO_VIDEO_CREDITS = Object.freeze({
  'MiniMax-H3': {
    '480p': { withoutVideo: 6.82, withVideo: 6.82, longOutput: 13.64, longThreshold: 15 },
    '768p': { withoutVideo: 10.2, withVideo: 10.2, longOutput: 20.4, longThreshold: 15 },
    '1080p': { withoutVideo: 15.91, withVideo: 15.91, longOutput: 31.82, longThreshold: 15 },
    // H3 的 2K 目录上限为 15 秒；保留长视频价只用于遇到历史异常参数时保守估价。
    '2k': { withoutVideo: 17, withVideo: 17, longOutput: 34, longThreshold: 15 },
  },
  'seedance-2.0-mini': { '480p': { withoutVideo: 16.20, withVideo: 9.82 }, '720p': { withoutVideo: 35.09, withVideo: 21.23 } },
  'seedance-2.0': { '480p': { withoutVideo: 50.61, withVideo: 30.67 }, '720p': { withoutVideo: 108.89, withVideo: 65.83 }, '1080p': { withoutVideo: 271.77, withVideo: 165.40 }, '4k': { withoutVideo: 553.67, withVideo: 340.73 } },
})
const FAST_IDS = new Set(['seedance-2.0-fast', 'seedance-2-0-fast', 'doubao-seedance-2-0-fast'])
let effectivePolicy: Record<string, any> = { ...DEFAULT_VIDEO_PRICING }
export function setVideoPricing(policy: Record<string, any> = {}) {
  effectivePolicy = { ...DEFAULT_VIDEO_PRICING, ...policy }
}
export function videoPricingSnapshot(): Record<string, any> { return { version: VIDEO_PRICING_VERSION, ...effectivePolicy, supplierPricing: structuredClone({metasoTiers:METASO_VIDEO_CREDITS,arkFast:{noVideoRmbPerMillion:37,withVideoRmbPerMillion:22},ark25:SEEDANCE25_PRICING,h3:{freeImages:5,extraImageCredits:5.7,contextCredits:5.7},pixels:PIXELS,minimumTokens480p:FLOOR_480}) } }
export function videoExpenses(policy=effectivePolicy) {
  const known = key => policy[key] !== null && policy[key] !== undefined && policy[key] !== '' && Number.isFinite(Number(policy[key]))
  const monthlyServerRmb = known('serverMonthlyRmb') ? Number(policy.serverMonthlyRmb) : known('serverAnnualUsd') && known('usdToRmb') && Number(policy.usdToRmb)>0 ? Number(policy.serverAnnualUsd)*Number(policy.usdToRmb)/12 : null
  const feeKnown=known('paymentFeePercent')
  const shared=policy.serverAllocationMode==='all_media_requests'
  const serverAllocationKnown=monthlyServerRmb!==null && (shared ? known('monthlyMediaRequests') && Number(policy.monthlyMediaRequests)>0 : known('monthlyBillableVideoSeconds') && Number(policy.monthlyBillableVideoSeconds)>0)
  const allocationKnown=serverAllocationKnown && known('otherRmbPerSecond')
  const configured=feeKnown && allocationKnown
  // Apply each known expense immediately; unknown amounts remain explicit in admin.
  return {configured,paymentFeeConfigured:feeKnown,allocationConfigured:allocationKnown,monthlyServerRmb,paymentFeePercent:feeKnown?Number(policy.paymentFeePercent):0,serverAllocationMode:shared?'all_media_requests':'video_seconds',monthlyMediaRequests:shared&&known('monthlyMediaRequests')?Number(policy.monthlyMediaRequests):null,rmbPerRequest:shared&&serverAllocationKnown?monthlyServerRmb/Number(policy.monthlyMediaRequests):0,rmbPerOutputSecond:(!shared&&serverAllocationKnown?monthlyServerRmb/Number(policy.monthlyBillableVideoSeconds):0)+(known('otherRmbPerSecond')?Number(policy.otherRmbPerSecond):0)}
}
export function isCostPlusVideo(id) { return Boolean(METASO_VIDEO_CREDITS[id] || FAST_IDS.has(id) || isSeedance25(id)) }
export function normalizeVideoPricing(value: Record<string, any> = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['metasoRmbPerCredit','markupPerSecond','paymentFeePercent','serverMonthlyRmb','serverAnnualUsd','usdToRmb','monthlyBillableVideoSeconds','otherRmbPerSecond','serverAllocationMode','monthlyMediaRequests'].includes(key))) throw Error('视频定价设置无效')
  const next = { ...DEFAULT_VIDEO_PRICING, ...value }
  if (!Number.isFinite(Number(next.metasoRmbPerCredit)) || Number(next.metasoRmbPerCredit) < 0.008798 || Number(next.metasoRmbPerCredit) > 1) throw Error('秘塔积分成本需为 0.008798 至 1 元')
  if (!Number.isFinite(Number(next.markupPerSecond)) || Number(next.markupPerSecond) < 0.1 || Number(next.markupPerSecond) > 100) throw Error('视频每秒净利目标不能低于 0.10 元')
  if (!['video_seconds','all_media_requests'].includes(next.serverAllocationMode)) throw Error('服务器分摊方式无效')
  const result = { serverAllocationMode:next.serverAllocationMode, metasoRmbPerCredit: Math.round(Number(next.metasoRmbPerCredit)*1e6)/1e6, markupPerSecond: Math.round(Number(next.markupPerSecond)*100)/100 }
  for (const [key, max] of Object.entries({paymentFeePercent:50,serverMonthlyRmb:1000000,serverAnnualUsd:1000000,usdToRmb:100,monthlyBillableVideoSeconds:10000000000,otherRmbPerSecond:10000,monthlyMediaRequests:10000000000})) {
    const value=next[key]
    if(value===null || value===undefined || value==='') { result[key]=null;continue }
    const numeric=Number(value)
    if(!Number.isFinite(numeric) || numeric<0 || numeric>max || (['monthlyBillableVideoSeconds','monthlyMediaRequests','usdToRmb'].includes(key) && numeric<=0)) throw Error('净利成本参数无效')
    result[key]=Math.round(numeric*1e6)/1e6
  }
  return result
}
const PIXELS = {
  '480p': { '16:9':864*496, '9:16':864*496, '4:3':752*560, '3:4':752*560, '1:1':640*640, '21:9':992*432 },
  '720p': { '16:9':1280*720, '9:16':1280*720, '4:3':1112*834, '3:4':1112*834, '1:1':960*960, '21:9':1470*630 },
}
const FLOOR_480 = {4:70308,5:90396,6:100440,7:120528,8:140616,9:150660,10:170748,11:190836,12:200880,13:220968,14:241056,15:251100}
const nonnegative = value => Math.max(0, Number(value) || 0)
const present = value => value !== null && value !== undefined && Number.isFinite(Number(value))
export function costPlusVideoCost({ model, parameters = {}, usage, seconds }: Record<string, any> = {}) {
  const id = String(model?.publicId || model?.id || model || '')
  if (!isCostPlusVideo(id)) return null
  const snapshot = [VIDEO_PRICING_VERSION, 'video-cost-plus-2026-10-13', 'video-cost-plus-2026-10-08'].includes(parameters.videoPricing?.version) ? parameters.videoPricing : videoPricingSnapshot()
  const expenses = videoExpenses(snapshot)
  const output = present(usage?.output_seconds) && Number(usage.output_seconds)>0 ? Number(usage.output_seconds) : nonnegative(seconds ?? parameters.billableDuration ?? parameters.duration)
  if (!(output > 0)) throw Error('视频计费时长无效')
  const input = nonnegative(parameters.videoSeconds)
  const resolution = String(parameters.resolution || '').toLowerCase()
  if (METASO_VIDEO_CREDITS[id]) {
    const supplier = snapshot.supplierPricing
    const tier = (supplier?.metasoTiers || METASO_VIDEO_CREDITS)[id]?.[resolution]
    if (!tier) throw Error('该视频分辨率尚无已核准的价格')
    const h3 = id === 'MiniMax-H3'
    // H3 input_seconds may include free reference audio. Never charge audio as video.
    const billedInput = input > 0 && present(usage?.input_seconds) && (!h3 || present(usage?.input_audio_seconds) || !parameters.audioSeconds)
      ? Math.max(0, Number(usage.input_seconds) - nonnegative(usage.input_audio_seconds))
      : usage ? input : Math.ceil(input)
    const images = present(usage?.input_image_count) ? nonnegative(usage.input_image_count) : nonnegative(parameters.referenceImages)
    const unitCredits = input > 0 ? tier.withVideo : tier.withoutVideo
    // The 2x tier follows the requested duration, as Metaso's estimate does
    // (outputVideoSeconds). Measured output can run a little past 15 s.
    const requested = nonnegative(parameters.billableDuration ?? parameters.duration)
    const longOutput = h3 && Number(tier.longThreshold) > 0 && (requested > 0 ? requested : output) > Number(tier.longThreshold)
    // Metaso's estimate (2026-10-22) doubles the whole base fee past 15 s:
    // output, reference-video seconds and chargeable images. Context IR is not.
    const longFactor = longOutput ? Number(tier.longOutput) / Number(tier.withoutVideo) : 1
    const outputCredits = output * (longOutput ? Number(tier.longOutput) : unitCredits)
    const h3Policy = supplier?.h3 || {freeImages:5,extraImageCredits:5.7,contextCredits:5.7}
    const extraImageCredits = h3 ? Math.max(0, images - h3Policy.freeImages) * h3Policy.extraImageCredits * longFactor : 0
    // 秘塔 H3 的 Context IR 默认开启、按次单独计费；请求里关掉（context_ir_enabled:false）就不收。
    const contextCredits = h3 && parameters.contextIr !== false ? h3Policy.contextCredits : 0
    const supplierCredits = outputCredits + billedInput * unitCredits * longFactor + extraImageCredits + contextCredits
    const costRmb = supplierCredits * snapshot.metasoRmbPerCredit
    return {
      rmb: Math.round(costRmb * 10000) / 10000,
      basis: 'metaso_verified_credit_tier',
      detail: { supplierCredits, rmbPerCredit: snapshot.metasoRmbPerCredit, perSecondRmb: (longOutput ? Number(tier.longOutput) : unitCredits) * snapshot.metasoRmbPerCredit, outputSeconds: output, inputSeconds: billedInput, images, imageRmb: extraImageCredits*snapshot.metasoRmbPerCredit, contextIrRmb: contextCredits*snapshot.metasoRmbPerCredit, resolutionUsed: resolution, longOutput, longOutputThreshold: tier.longThreshold || null, hasInputVideo: input>0, source: present(usage?.output_seconds) ? 'upstream_usage' : 'parameter_estimate', pricingPolicy:snapshot, expenses },
      rawRmb: costRmb, outputSeconds: output, markupPerSecond: snapshot.markupPerSecond,
      usageBased: present(usage?.output_seconds),
    }
  }
  const seedance25 = isSeedance25(id)
  const policy25 = snapshot.supplierPricing?.ark25 || SEEDANCE25_PRICING
  const table = (seedance25 ? policy25.pixels : snapshot.supplierPricing?.pixels || PIXELS)[resolution]
  if (!table) throw Error('该视频分辨率尚无已核准的价格')
  const pixels = table[parameters.ratio] || Math.max(...Object.values(table).map(Number))
  const rates = seedance25 ? policy25.rates[resolution] : snapshot.supplierPricing?.arkFast || {noVideoRmbPerMillion:37,withVideoRmbPerMillion:22}
  const rate = input > 0 ? rates.withVideoRmbPerMillion : rates.noVideoRmbPerMillion
  const reported = ['completion_tokens','total_tokens','output_tokens','tokens'].map(key => nonnegative(usage?.[key])).find(value => value > 0) || 0
  // Returned completion_tokens already includes the supplier's minimum; no second floor.
  // Reservation includes probed reference video and one terminal frame, then applies
  // the published minimum. The formula is a forecast, never an actual provider invoice.
  // Published forecast uses input video plus output duration; retain audio
  // duration for diagnostics without treating it as extra video duration.
  const reserveSeconds = output + Math.ceil(input)
  const formula = Math.ceil(pixels * (Math.ceil(reserveSeconds * 24) + 1) / 1024)
  const minimumTokens = snapshot.supplierPricing?.minimumTokens480p || FLOOR_480
  const floor = input > 0 ? seedance25
    ? Math.ceil((output + Math.ceil(output * policy25.minimumInputFraction)) * pixels * policy25.fps / 1024)
    : Math.ceil((minimumTokens[Math.ceil(output)] || minimumTokens[15]) * pixels / (864*496)) : 0
  const tokens = reported || Math.max(formula, floor)
  const costRmb = tokens / 1e6 * rate
  return {
    rmb: Math.round(costRmb*10000)/10000, basis: reported ? 'volcengine_reported_tokens' : 'volcengine_parameter_forecast',
    detail: { tokens, reportedTokens: reported, floorTokens: reported ? 0 : floor, rmbPerMillion: rate, hasInputVideo: input>0, outputSeconds: output, inputSeconds: input, inputAudioSeconds:nonnegative(parameters.audioSeconds), forecastPixels:pixels, forecastRatio:table[parameters.ratio] ? parameters.ratio : 'maximum_supported', source: reported ? 'upstream_usage' : 'parameter_estimate', pricingPolicy:snapshot, expenses },
    rawRmb: costRmb, outputSeconds: output, markupPerSecond: snapshot.markupPerSecond, usageBased: reported>0,
  }
}
export function costPlusVideoEstimate(input) {
  const cost = costPlusVideoCost(input)
  if (!cost) return null
  const manualRate = Number(input?.parameters?.manualVideoCreditsPerSecond)
  if (Number.isFinite(manualRate) && manualRate >= 0.01) {
    const output = Number(cost.outputSeconds || input.parameters?.billableDuration || input.parameters?.duration || 0)
    const inputSeconds = Number(cost.detail?.inputSeconds || input.parameters?.videoSeconds || 0)
    const images = Number(cost.detail?.images || input.parameters?.referenceImages || 0)
    const isH3 = String(input?.model?.publicId || input?.model?.id || input?.model || '') === 'MiniMax-H3'
    const extraImageCredits = isH3 ? Math.max(0, images - 5) * 5.7 : 0
    const points = Math.max(0.01, Math.ceil(((output + inputSeconds) * manualRate + extraImageCredits) * 100 - 1e-8) / 100)
    return {
      points,
      count: 1,
      duration: output,
      usageBased: false,
      policyVersion: 'admin-manual-video-price',
      breakdown: {
        durationSeconds: output,
        resolution: input.parameters?.resolution,
        perSecond: manualRate,
        outputPerSecond: manualRate,
        inputVideoSeconds: inputSeconds,
        inputVideoPerSecond: manualRate,
        inputImageCredits: extraImageCredits,
        billingSource: 'admin_manual_price',
        minimum: 0.01,
      },
    }
  }
  const expenses = cost.detail.expenses
  const requiredRevenue = (cost.rawRmb + expenses.rmbPerRequest + cost.outputSeconds * (cost.markupPerSecond+expenses.rmbPerOutputSecond))/(1-expenses.paymentFeePercent/100)
  const points = Math.max(0.01, Math.ceil(requiredRevenue*100 - 1e-8)/100)
  const inputSeconds = cost.detail.inputSeconds
  const perSecond = cost.detail.perSecondRmb ?? cost.rawRmb / Math.max(1, cost.outputSeconds+inputSeconds)
  return {
    points, count: 1, duration: cost.outputSeconds, usageBased: cost.usageBased, policyVersion: VIDEO_PRICING_VERSION,
    breakdown: { durationSeconds: cost.outputSeconds, resolution: input.parameters?.resolution, perSecond: (perSecond+cost.markupPerSecond+expenses.rmbPerOutputSecond)/(1-expenses.paymentFeePercent/100), outputPerSecond: (perSecond+cost.markupPerSecond+expenses.rmbPerOutputSecond)/(1-expenses.paymentFeePercent/100), inputVideoSeconds: inputSeconds, inputVideoPerSecond: perSecond, inputImageCredits: cost.detail.imageRmb || 0, contextCredits: cost.detail.contextIrRmb || 0, billingSource: cost.usageBased ? 'upstream_usage' : 'parameter_reserve', usageTokens: cost.detail.tokens || 0, minimum: 0.01, rounding: 'ceil-0.01', settlesActualUsage: true },
  }
}
export function adminVideoPricing(): Record<string, any> {
  return { ...videoPricingSnapshot(), expenses:videoExpenses(), supplierSource: 'https://metaso.cn/minimax-h3', arkSource: 'https://docs.volcengine.com/docs/ark/model-pricing', metasoTiers: METASO_VIDEO_CREDITS, arkFast: { noVideoRmbPerMillion:37, withVideoRmbPerMillion:22 }, ark25: structuredClone(SEEDANCE25_PRICING), h3: { freeImages:5, extraImageCredits:5.7, contextCredits:5.7, audioFree:true }, seedance: { imageFree:true, audioFree:true } }
}
