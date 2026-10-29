import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ManagementStore } from '../server/management-store.ts'
import { modelById, modelForGeneration } from '../server/image-models.ts'
import { estimateGenerationCost, setPricingOverrides, imageCreditsPerImage } from '../server/generation-cost.ts'
import { costPlusVideoCost, setVideoPricing, videoPricingSnapshot, videoExpenses, VIDEO_PRICING_VERSION } from '../server/video-pricing.ts'
import { suiheCost, suihePricingSnapshot } from '../server/suihe-pricing.ts'
import { estimateSuiheVideo } from '../server/suihe.ts'
import { prepareVideoRequest } from '../server/video-api.ts'

// Money-path checks use only disposable SQLite and injected, non-network responses.
// Audited supplier examples: 5 s, 16:9, no references, audio enabled.
const fixtures = [
  ['seedance-2.5', '480p', 2746, null],
  ['seedance-2.5', '720p', 6175, 3173],
  ['seedance-2.5', '1080p', 15282, 3473],
  ['seedance-2.0', '480p', 1887, null],
  ['seedance-2.0', '720p', 4058, 2316],
  ['seedance-2.0', '1080p', 10122, 2566],
  ['seedance-2.0', '4k', 20641, null],
  ['seedance-2.0-fast', '480p', 1124, null],
  ['seedance-2.0-fast', '720p', 2418, 1559],
  ['seedance-2.0-mini', '480p', 699, null],
  ['seedance-2.0-mini', '720p', 1503, 1106],
] as const
assert.equal(modelForGeneration('grok-imagine-video',{},'grok').video,true)
assert.equal(modelForGeneration('not-a-model',{},'grok'),null)
const round = value => Math.round(value * 10000) / 10000
const store = (await ManagementStore.open(':memory:'))
const {user} = (await store.createUser({name:'video-pricing-check', email:'video-pricing@example.invalid', password:'isolated-pricing-check', points:10000}, 'verification'))
const session = {role:'user', userId:user.id}
let checked = 0
for (const [id, resolution, native, economy] of fixtures) {
  const model = modelById(id)
  for (const [creativeMode, credits] of [['native', native], ['super_economy', economy]] as const) {
    if (credits === null) continue
    const generationResolution = creativeMode === 'super_economy' ? '480p' : resolution
    const generationSnapshot = suihePricingSnapshot(model, {resolution:generationResolution})
    const preEstimate = {costRmb:credits/1000, tokens:50000, generationResolution,
      generationRates:'rates' in generationSnapshot?generationSnapshot.rates:undefined,
      generationPixels:'pixels' in generationSnapshot?generationSnapshot.pixels:undefined,
      billingMode:creativeMode==='native'?'token':'token_enhance', enhancementRmb:creativeMode==='native'?0:0.5}
    const parameters = {duration:5, resolution, ratio:'16:9', creativeMode, videoPricing:videoPricingSnapshot(),
      suiheCost:{...suihePricingSnapshot(model, {resolution, creativeMode}), preEstimate}}
    const quote = estimateGenerationCost({model, generation:parameters})
    assert.equal(quote.points, round(credits/1000+0.5), `${id}/${resolution}/${creativeMode}`)
    // Unlabelled actual_cost must never be interpreted as RMB.
    assert.equal(suiheCost(model,parameters,{usage:{suihe_actual_cost:999999}}).rmb, credits/1000)
    const before = (await store.user(user.id)).points
    const reserved = (await store.reserve({session,model,points:quote.points,prompt:'pricing only',parameters,status:'running'}))
    assert.equal(round(before-(await store.user(user.id)).points),quote.points)
    const actual = round(credits/1000*0.8)
    await store.completeVideo(reserved.id,{id:'fixture-result',url:'https://example.invalid/not-fetched.mp4',duration:5,
      usage:{suihe_billing:{status:'confirmed',charged_cny:actual}}})
    assert.equal((await store.get('SELECT charged_points FROM generations WHERE id=?',reserved.id)).charged_points,round(actual+0.5))
    assert.equal(round(before-(await store.user(user.id)).points),round(actual+0.5))
    checked++
  }
}

// New defaults ignore stale server budgets and fees when quoting, but retain
// expense records for accounting. Older task snapshots keep their old formula.
setVideoPricing({markupPerSecond:0.1, metasoRmbPerCredit:0.0108, usdToRmb:7.2,
  serverAllocationMode:'all_media_requests',serverMonthlyRmb:999,monthlyMediaRequests:1,otherRmbPerSecond:99,paymentFeePercent:20})
assert.equal(videoExpenses().rmbPerRequest,0)
assert.equal(videoExpenses().rmbPerOutputSecond,0)
for (const [id, resolutions] of [['MiniMax-H3',['480p','768P','1080p','2K']],
  ['grok-imagine-video',['480p','720p']],['grok-imagine-video-1.5',['480p','720p','1080p']],
  ['seedance-2.0-fast',['480p','720p']],['seedance-2.5',['480p','720p','1080p']]] as const) {
  const provider = id==='MiniMax-H3'?'metaso':id.startsWith('grok')?'grok':'ark'
  const model = modelForGeneration(id,{},provider)
  for (const resolution of resolutions) for (const videoSeconds of [0,3]) {
    const parameters = {duration:5,resolution,ratio:'16:9',videoSeconds,referenceImages:7,videoPricing:videoPricingSnapshot()}
    const cost = costPlusVideoCost({model,parameters})
    const quote = estimateGenerationCost({model,generation:parameters})
    assert.equal(quote.points,round(cost.rawRmb+0.5))
    checked++
  }
}
const h3=modelForGeneration('MiniMax-H3',{},'metaso')
for (const duration of [15,16,30]) {
  const parameters={duration,resolution:'1080p',videoSeconds:2,referenceImages:7,videoPricing:videoPricingSnapshot()}
  const factor=duration>15?2:1
  assert.equal(costPlusVideoCost({model:h3,parameters}).rmb,round(((duration+2)*15.91*factor+2*5.7*factor+5.7)*0.0108))
}
const legacy={version:'video-cost-plus-2026-10-22',markupPerSecond:0.1,metasoRmbPerCredit:0.0108,
  paymentFeePercent:1.6,serverAllocationMode:'all_media_requests',serverMonthlyRmb:27,monthlyMediaRequests:60,otherRmbPerSecond:0}
const oldQuote=estimateGenerationCost({model:h3,generation:{duration:5,resolution:'768P',submissionState:'started',videoPricing:legacy}})
assert.equal(oldQuote.points,1.59)

// Migration preserves manual prices; later edits remain authoritative on restart.
await store.saveSettings({prices:{'grok-imagine-video-1.5':{video:{'1080p':0.66}}}},'verification')
await store.run('DELETE FROM settings WHERE key=?','video-pricing-rules-20261026-simple')
await store.migrateVideoPricingRules()
assert.equal((await store.settings()).prices['grok-imagine-video-1.5'].video['1080p'],0.66)
await store.saveSettings({prices:{'grok-imagine-video-1.5':{video:{'1080p':1.17}}}},'verification')
await store.migrateVideoPricingRules()
assert.equal((await store.settings()).prices['grok-imagine-video-1.5'].video['1080p'],1.17)
assert.equal(estimateGenerationCost({model:modelById('grok-imagine-video-1.5'),generation:{duration:5,resolution:'1080p'}}).points,5.85)
setPricingOverrides({})
await store.saveSettings({prices:{}},'verification')
const grok=modelById('grok-imagine-video')
const grokParameters={duration:5,resolution:'720p',videoPricing:videoPricingSnapshot()}
const grokQuote=estimateGenerationCost({model:grok,generation:grokParameters})
assert.equal(grokQuote.points,1.76)
const grokReservation=store.reserve({session,model:grok,points:grokQuote.points,prompt:'pricing only',parameters:grokParameters,status:'running'})
store.completeVideo(grokReservation.id,{id:'duration-only',url:'https://example.invalid/not-fetched.mp4',duration:4})
assert.equal(store.get('SELECT charged_points FROM generations WHERE id=?',grokReservation.id).charged_points,1.408)
const grokRecordedCost=JSON.parse(store.get('SELECT upstream_cost FROM generations WHERE id=?',grokReservation.id).upstream_cost)
assert.equal(grokRecordedCost.rmb,1.008)
const changedQuote=estimateGenerationCost({model:grok,generation:grokParameters})
await store.saveSettings({prices:{'grok-imagine-video':{video:{'720p':0.9}}}},'verification')
const balanceBeforeRejected=(await store.user(user.id)).points
await assert.rejects(async ()=>(await store.reserve({session,model:grok,points:changedQuote.points,prompt:'changed price',parameters:grokParameters,status:'running'})),/价格刚刚发生变化/)
assert.equal((await store.user(user.id)).points,balanceBeforeRejected)
await store.saveSettings({prices:{}},'verification')
const ark=modelForGeneration('seedance-2.0-fast',{},'ark')
const arkManual={duration:5,resolution:'720p',ratio:'16:9',videoSeconds:3,submissionState:'started',manualVideoCreditsPerSecond:1.2,videoPricing:videoPricingSnapshot()}
const arkReferenceCost=costPlusVideoCost({model:ark,parameters:arkManual}).detail.referenceCostRmb
assert.ok(arkReferenceCost>0)
assert.equal(estimateGenerationCost({model:ark,generation:arkManual}).points,round(6+arkReferenceCost))
const suihe=modelById('seedance-2.0-fast')
const manualParameters={duration:5,resolution:'720p',ratio:'16:9',videoSeconds:3,manualVideoCreditsPerSecond:1.2,
  submissionState:'started',videoPricing:videoPricingSnapshot(),suiheCost:suihePricingSnapshot(suihe,{resolution:'720p'})}
const manualCost=suiheCost(suihe,manualParameters)
const manualQuote=estimateGenerationCost({model:suihe,generation:manualParameters})
assert.equal(manualQuote.points,round(6+manualCost.detail.referenceCostRmb))
assert.equal(estimateGenerationCost({model:suihe,generation:{...manualParameters,usage:{suihe_billing:{status:'confirmed',charged_cny:3}}}}).points,manualQuote.points)

// No credentials or network access: quote endpoint path, units, cache and strict
// resolution validation are exercised with an injected response.
let calls=0
const env={OIP_MOCK_PROVIDERS:'1',SUIHE_API_KEY:'fake-pricing-only',SUIHE_BASE_URL:'http://127.0.0.1:9'}
const fetchImpl=async(url,init)=>{
  calls++
  const request=url instanceof Request?url:new Request(url,init)
  assert.equal(new URL(request.url).pathname,'/v1/billing/video-pre-estimate')
  const body=await request.json()
  assert.equal(body.prompt,'询价提示词')
  assert.equal(body.function_mode,'omni_reference')
  return Response.json({credits:body.duration===5?1559:1000, estimated_completion_tokens:50000,duration:body.duration,
    video_resolution:body.duration===5?'720p':'1080p', generation_resolution:'480p',billing_mode:'token_enhance',enhancement_estimated_cny:0.435})
}
const request={model:suihe,prompt:'询价提示词',mode:'image',duration:5,resolution:'720p',ratio:'16:9',creativeMode:'super_economy'}
const remoteQuote=await estimateSuiheVideo(request,{env,fetchImpl})
assert.equal(remoteQuote.costRmb,1.559)
assert.equal(remoteQuote.enhancementRmb,0.435)
await estimateSuiheVideo(request,{env,fetchImpl})
assert.equal(calls,1)
await assert.rejects(estimateSuiheVideo({...request,duration:6},{env,fetchImpl}),/报价与所选参数不一致/)
await assert.rejects(estimateSuiheVideo({...request,duration:7},{env,fetchImpl:async()=>Response.json({
  credits:1000,estimated_completion_tokens:50000,video_resolution:'720p',generation_resolution:'480p',billing_mode:'token_enhance',enhancement_estimated_cny:0.4,
})}),/报价与所选参数不一致/)

// Exercise the actual preparation -> supplier quote -> frozen parameters ->
// reservation path through an ephemeral loopback supplier. No real supplier key.
let quoteCalls=0
const supplier=createServer(async(req,res)=>{
  assert.equal(req.url,'/v1/billing/video-pre-estimate')
  quoteCalls++
  let text='';for await(const chunk of req) text+=chunk
  const body=JSON.parse(text)
  const economy=body.creative_mode==='super_economy'
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify({credits:economy?1559:2418,estimated_completion_tokens:50000,duration:5,
    video_resolution:'720p',generation_resolution:economy?'480p':'720p',billing_mode:economy?'token_enhance':'token',enhancement_estimated_cny:economy?0.435:0}))
})
supplier.listen(0,'127.0.0.1');await once(supplier,'listening')
try {
  const mockEnv={...env,ENABLE_MODEL_CALLS:'true',SUIHE_BASE_URL:`http://127.0.0.1:${(supplier.address() as any).port}`}
  for(const [creativeMode,expected] of [['native',2.918],['super_economy',2.059]] as const) {
    const prepared=await prepareVideoRequest({model:'seedance-2.0-fast',prompt:'计价验证',mode:'text',resolution:'720p',ratio:'16:9',duration:5,creativeMode},session,{env:mockEnv})
    assert.equal(prepared.cost.points,expected)
    const held=(await store.reserve({session,model:prepared.model,points:prepared.cost.points,prompt:prepared.prompt,parameters:prepared.parameters}))
    assert.equal((await store.get('SELECT reserved_points FROM generations WHERE id=?',held.id)).reserved_points,expected)
    await store.cancel(held.requestId,session)
  }
  assert.equal(quoteCalls,2)
  await assert.rejects(prepareVideoRequest({model:'seedance-2.0-fast',prompt:'计价验证',mode:'text',resolution:'480p',ratio:'16:9',duration:5,creativeMode:'super_economy'},session,{env:mockEnv}),/不支持/)
  assert.equal(quoteCalls,2,'unsupported combination must fail before contacting supplier')
} finally {
  supplier.closeAllConnections()
  await new Promise<void>(resolve=>supplier.close(()=>resolve()))
}

// Official Seedream routes retain cost + 0.1 per generated image.
for(const [id,size,expected] of [['doubao-seedream-4-0','2048x2048',0.3],['seedream-4.5','2K',0.35],['seedream-5.0-lite','2K',0.32],['doubao-seedream-5-0-flash','1K',0.22],['doubao-seedream-5-0-pro','1K',0.4],['doubao-seedream-5-0-pro','2K',0.7]]) {
  const model=modelForGeneration(id,{},'ark')
  assert.equal(imageCreditsPerImage(model,{size}),expected)
}
assert.equal(round((await store.get('SELECT SUM(delta) AS balance FROM ledger WHERE user_id=?',user.id)).balance),round((await store.user(user.id)).points))
assert.equal(videoPricingSnapshot().version,VIDEO_PRICING_VERSION)
store.db.close()
console.log(`Video pricing verified: ${checked} parameter combinations, holds/refunds, old snapshots, manual prices, migration, quote validation and official images; no real upstream calls.`)
