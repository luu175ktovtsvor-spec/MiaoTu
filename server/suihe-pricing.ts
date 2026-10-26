// Native Volcengine tariff × owner procurement discount, 2026-10-25.
// Separate per-second examples are not a universal tariff.
import { suiheModelId } from './suihe-catalog.ts'
import { SEEDANCE25_PRICING } from './seedance25.ts'
export const SUIHE_COST_VERSION = 'suihe-native-cost-2026-10-25'
// Owner confirmed 0.5 fen = RMB 0.005 per output second / image.
export const SUIHE_CUSTOMER_MARKUP = 0.005
export const SUIHE_IMAGE_RMB = {
  'seedream-4.0': {'1k':0.40,'2k':0.40},
  'seedream-4.5': {'2k':0.45},
  'seedream-5.0-lite': {'2k':0.42,'3k':0.42},
  'seedream-5.0-pro': {'1k':0.60,'1.5k':0.85,'2k':1.20},
}
const rates = {
  'seedance-2.5': SEEDANCE25_PRICING.rates,
  'seedance-2.0': {
    '480p':{noVideoRmbPerMillion:46,withVideoRmbPerMillion:28},
    '720p':{noVideoRmbPerMillion:46,withVideoRmbPerMillion:28},
    '1080p':{noVideoRmbPerMillion:51,withVideoRmbPerMillion:31},
    '4k':{noVideoRmbPerMillion:26,withVideoRmbPerMillion:16},
  },
  'seedance-2.0-fast':Object.fromEntries(['480p','720p'].map(tier=>[tier,{noVideoRmbPerMillion:37,withVideoRmbPerMillion:22}])),
  'seedance-2.0-mini':Object.fromEntries(['480p','720p'].map(tier=>[tier,{noVideoRmbPerMillion:23,withVideoRmbPerMillion:14}])),
}
const pixels = {
  ...SEEDANCE25_PRICING.pixels,
  '480p':{...SEEDANCE25_PRICING.pixels['480p'],'16:9':864*496,'9:16':864*496},
  '4k':{'16:9':3840*2160,'9:16':3840*2160,'4:3':3326*2494,'3:4':3326*2494,'1:1':2880*2880},
}
const discounts = {'seedance-2.5':0.81,'seedance-2.0':0.81,'seedance-2.0-fast':0.60,'seedance-2.0-mini':0.60}
export function suihePricingSnapshot(model, parameters: Record<string,any> = {}) {
  const id = suiheModelId(model)
  const tier = String(parameters.resolution || parameters.size || '').toLowerCase()
  return {version:SUIHE_COST_VERSION,model:id,tier,creativeMode:String(parameters.creativeMode || 'super_economy'),customerMarkupRmbPerUnit:SUIHE_CUSTOMER_MARKUP,
    ...(model.video ? {discount:discounts[id],rates:rates[id]?.[tier],pixels:(id==='seedance-2.5'?SEEDANCE25_PRICING.pixels:pixels)[tier],fps:24,minimumInputFraction:2/3}
      : {unitRmb:SUIHE_IMAGE_RMB[id]?.[tier]}),source:'owner_procurement_2026-10-25_and_volcengine_lark_formula'}
}
export function suiheCost(model, parameters: Record<string, any> = {}, {seconds, count = 1, usage}: Record<string, any> = {}) {
  const id=suiheModelId(model)
  const frozen=parameters.suiheCost
  const snapshot=frozen?.version===SUIHE_COST_VERSION && frozen.model===id ? frozen : suihePricingSnapshot(model,parameters)
  if (!model.video) {
    if (!(snapshot.unitRmb>0)) return null
    return {rmb:Math.round(snapshot.unitRmb*count*10000)/10000,basis:'suihe_image_procurement_price',detail:{supplier:'suihe',images:count,unitRmb:snapshot.unitRmb,pricingSnapshot:snapshot,source:'procurement_price'}}
  }
  if (!snapshot.rates || !snapshot.pixels || !(snapshot.discount>0)) return null
  const output=Number(seconds ?? usage?.output_seconds ?? parameters.billableDuration ?? parameters.duration)
  if (!(output>0)) return null
  const input=Math.max(0,Number(parameters.videoSeconds)||0)
  const rate=input>0?snapshot.rates.withVideoRmbPerMillion:snapshot.rates.noVideoRmbPerMillion
  const area=snapshot.pixels[parameters.ratio] || Math.max(...Object.values(snapshot.pixels).map(Number))
  const reported=['completion_tokens','total_tokens','output_tokens','tokens'].map(key=>Number(usage?.[key])).find(value=>value>0&&Number.isFinite(value)) || 0
  // Both published series use output + max(input,ceil(2*output/3)). Returned
  // billable tokens already include the minimum; never apply it twice.
  const floor=input>0?Math.ceil(output*snapshot.minimumInputFraction):0
  const tokens=reported || Math.ceil((output+Math.max(input,floor))*area*snapshot.fps/1024)
  const officialRmb=tokens/1e6*rate
  const rawRmb=officialRmb*snapshot.discount
  return {rmb:Math.round(rawRmb*10000)/10000,rawRmb,outputSeconds:output,usageBased:reported>0,
    basis:reported?'suihe_volcengine_reported_tokens_discount':'suihe_volcengine_token_forecast_discount',
    detail:{supplier:'suihe',tokens,reportedTokens:reported,rmbPerMillion:rate,discount:snapshot.discount,officialRmb,outputSeconds:output,inputSeconds:input,inputAudioSeconds:Number(parameters.audioSeconds)||0,minimumInputSeconds:reported?0:floor,forecastPixels:area,forecastRatio:snapshot.pixels[parameters.ratio]?parameters.ratio:'maximum_supported',pricingSnapshot:snapshot,source:reported?'upstream_usage':'parameter_estimate',rawActualCost:usage?.suihe_actual_cost??null,rawEstimatedCost:usage?.suihe_estimated_cost??null,rawCostUnit:'unconfirmed'}}
}
