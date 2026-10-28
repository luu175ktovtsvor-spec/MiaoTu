import { createHash } from 'node:crypto'
import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { createMediaProviderFetch } from './provider-fetch.ts'
import { fetchVideoContent } from './video-content-fetch.ts'
import { setSuiheModels, suiheModelId } from './suihe-catalog.ts'
import { arkVideoContent } from './ark-video.ts'

const fail = (message, extra = {}) => Object.assign(new Error(message), {status:502,...extra})
const isLibraryReference = value => /^(?:asset|whitelist):\/\/[^\s]+$/i.test(String(value || '').trim())
export function suiheSettings(env = process.env) {
  const baseUrl = String(env.SUIHE_BASE_URL || 'https://api.suihemedia.cloud').replace(/\/+$/, '').replace(/\/v1$/, '')
  assertProviderRequestAllowed('suihe',baseUrl,env)
  return {baseUrl,apiKey:runtimeSecret('SUIHE_API_KEY',env),enabled:env.ENABLE_MODEL_CALLS === 'true'}
}
async function json(response: Response, submitting=false) {
  try { return await response.json() as Record<string,any> }
  catch { throw fail('穗禾响应格式异常',{upstreamStatus:response.status,...(submitting?{submissionUncertain:true}:{})}) }
}
function responseError(response: Response, data, submitting=false) {
  const detail = typeof data?.detail === 'string' ? data.detail
    : Array.isArray(data?.detail) ? data.detail.map(item => item?.msg || item?.message || '').filter(Boolean).join('；')
    : data?.detail?.message
  const message = String(data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || data?.error_detail?.message || data?.fail_reason || data?.message || detail || `穗禾请求失败（${response.status}）`).slice(0,500)
  return fail(message, {
    upstreamStatus:response.status,upstreamRequestId:response.headers.get('x-request-id') || '',
    upstreamMessage:message,upstreamCode:String(data?.error?.code || data?.error_detail?.code || data?.code || '').slice(0,100),
    status:response.status>=500?502:response.status,transient:response.status>=500||response.status===429,
    ...(submitting&&response.status>=500?{submissionUncertain:true}:{})})
}
// Per-origin/account discovery; no credential or mock catalog can be reused by
// a different configuration. Only the process's own catalog feeds its UI.
let discovery: {key:string;at:number;rows:any[];pending?:Promise<any[]>} | undefined
export async function refreshSuiheModels({env=process.env,fetchImpl=fetch,force=false}: Record<string,any> = {}): Promise<any[]> {
  const config=suiheSettings(env)
  if (!config.apiKey) {
    if (env === process.env) setSuiheModels([])
    return []
  }
  const key=createHash('sha256').update(config.baseUrl+'\0'+config.apiKey).digest('hex')
  if(discovery?.key!==key) {
    discovery={key,at:0,rows:[]}
    // Never expose the previous key's live catalog to a newly configured key.
    if (env === process.env) setSuiheModels([])
  }
  const cache=discovery
  if (!force&&Date.now()-cache.at<60_000) return cache.rows
  if(cache.pending) return cache.pending
  cache.pending=(async()=>{
    const response=await createMediaProviderFetch({env,fetchImpl})(`${config.baseUrl}/v1/models`,{headers:{authorization:`Bearer ${config.apiKey}`},signal:AbortSignal.timeout(20_000)})
    const data=await json(response)
    if(!response.ok) throw responseError(response,data)
    if(!Array.isArray(data.data)) throw fail('穗禾模型目录格式异常')
    cache.rows=data.data;cache.at=Date.now()
    if(env===process.env) setSuiheModels(data.data)
    return cache.rows
  })().catch(error => {
    // Preserve the last successful catalog on a transient upstream failure.
    // Clearing it would make the overlay fall back to static defaults and can
    // expose modes the current key has not actually advertised.
    throw error
  }).finally(()=>{cache.pending=undefined})
  return cache.pending
}

// Non-generating supplier estimate. No prompt, files, keys or URLs enter the cache.
// Live v1.1 ignores reference_video_duration/materials here; quote the generation
// and enhancement baseline, then apply the verified input-token formula locally.
const videoEstimates = new Map<string, {at:number;value:any;pending?:Promise<any>}>()
export async function estimateSuiheVideo(request, {env=process.env,fetchImpl=fetch}:Record<string,any>={}) {
  const config=suiheSettings(env)
  if(!config.apiKey) throw fail('视频报价服务尚未配置',{status:503,submissionNotStarted:true})
  const p=request.parameters || {}
  const duration=Number(request.billableDuration ?? request.duration)
  const resolution=String(request.resolution).toLowerCase()
  const creativeMode=String(request.creativeMode || p.creativeMode || 'super_economy')
  // Keep the quote contract aligned with the paid submission contract. The
  // supplier requires prompt and uses function_mode to distinguish text/frame,
  // omni reference and video edit pricing rules.
  const functionMode=request.mode==='edit' ? 'video_edit' : request.mode==='image' || request.mode==='extend' ? 'omni_reference' : 'first_last_frames'
  const body={model:request.model.upstreamModelId || suiheModelId(request.model),prompt:String(request.prompt || ''),function_mode:functionMode,duration,
    ratio:request.ratio || 'adaptive',video_resolution:resolution,creative_mode:creativeMode,generate_audio:request.generateAudio!==false}
  const key=createHash('sha256').update(config.baseUrl+'\0'+config.apiKey+'\0'+JSON.stringify(body)).digest('hex')
  let entry=videoEstimates.get(key)
  if(entry?.value && Date.now()-entry.at<30_000) return entry.value
  if(entry?.pending) return entry.pending
  if(videoEstimates.size>=256) for(const [id,item] of videoEstimates) if(!item.pending) videoEstimates.delete(id)
  if(!entry){entry={at:0,value:null};videoEstimates.set(key,entry)}
  const current=entry
  current.pending=(async()=>{
    const response=await createMediaProviderFetch({env,fetchImpl})(`${config.baseUrl}/v1/billing/video-pre-estimate`,{
      method:'POST',headers:{authorization:`Bearer ${config.apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20_000)})
    const data=await json(response)
    if(!response.ok || data.error) throw responseError(response,data)
    const cost=Number(data.credits),tokens=Number(data.estimated_completion_tokens)
    const generationResolution=String(data.generation_resolution || '').toLowerCase()
    const enhanced=creativeMode==='super_economy' && resolution!=='480p'
    if(data.credits==null || data.credits==='' || !Number.isFinite(cost) || cost<0 || !(tokens>0) || !Number.isFinite(tokens)
      || !Number.isFinite(Number(data.duration)) || Math.abs(Number(data.duration)-duration)>0.001 || String(data.video_resolution).toLowerCase()!==resolution
      || !generationResolution || (enhanced && (data.billing_mode!=='token_enhance' || generationResolution!=='480p' || data.enhancement_estimated_cny==null || !Number.isFinite(Number(data.enhancement_estimated_cny)) || Number(data.enhancement_estimated_cny)<0))
      || (!enhanced && (data.billing_mode!=='token' || generationResolution!==resolution))) {
      throw fail('视频报价与所选参数不一致，请稍后重试',{status:503,submissionNotStarted:true})
    }
    const value={version:'suihe-video-estimate-v1',duration,ratio:body.ratio,resolution,creativeMode,generationResolution,
      costRmb:cost/1000,tokens,billingMode:data.billing_mode,enhancementRmb:enhanced?Number(data.enhancement_estimated_cny):0,
      source:'supplier_non_generating_estimate',referenceBaselineOnly:true}
    current.value=value;current.at=Date.now();return value
  })().finally(()=>{current.pending=undefined})
  return current.pending
}

export async function referenceBlob(source:string,kind:string,{fetchImpl,signal,bytes:providedBytes,mime:providedMime}: Record<string,any> = {}) {
  const max=({image:30,video:200,audio:15})[kind]*1024*1024
  const data=/^data:([^;,]+);base64,([\s\S]+)$/.exec(source)
  let mime:string,bytes:Buffer
  if (providedBytes) { mime=String(providedMime || 'application/octet-stream').split(';',1)[0]; bytes=Buffer.from(providedBytes) }
  else if(data) {mime=data[1];bytes=Buffer.from(data[2],'base64')}
  else {
    // External and signed workspace references use the normal public-address
    // guard. Supplier credentials are never sent while reading user assets.
    const response=await fetchVideoContent(source,{provider:'',providerConfig:{},fetchImpl,signal})
    if(!response.ok||!response.body) throw fail('无法读取参考素材',{submissionNotStarted:true})
    mime=response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream'
    const chunks=[];let size=0
    for await(const chunk of response.body as any) {
      size+=chunk.length
      if(size >= max) throw fail('参考素材超过穗禾上传上限',{status:422,submissionNotStarted:true})
      chunks.push(chunk)
    }
    bytes=Buffer.concat(chunks)
  }
  if(!bytes.length || bytes.length >= max) throw fail('参考素材为空或超过上传上限',{status:422,submissionNotStarted:true})
  return new Blob([new Uint8Array(bytes)],{type:mime})
}

export async function createSuiheTask(request, {env=process.env,fetchImpl=fetch,discoveryFetch=fetchImpl,signal,subKey=''}: Record<string,any> = {}) {
  const config=suiheSettings(env)
  if(!config.enabled||!config.apiKey) throw fail('穗禾通道尚未配置',{status:503,submissionNotStarted:true})
  const rows=await refreshSuiheModels({env,fetchImpl:discoveryFetch})
  const model=rows.find(row=>row.id===suiheModelId(request.model))
  if(!model?.request_model) throw fail('穗禾当前未开放这个模型',{status:422,submissionNotStarted:true})
  const video=Boolean(request.model.video)
  const path=video?'/v1/videos/generations':'/v1/images/generations'
  const parameters=request.parameters || request.generation || {}
  const body:Record<string,any>={model:model.request_model,prompt:request.prompt}
  const files:Array<{field:string;value:string;kind:string;bytes?:BlobPart;mime?:string}>=[]
  let firstFrame = ''
  let lastFrame = ''
  if(video) {
    // Use the official content roles, then adapt only the supplier transport.
    const content = arkVideoContent(request)
    firstFrame = content.find(part => part.role === 'first_frame')?.image_url?.url || ''
    lastFrame = content.find(part => part.role === 'last_frame')?.image_url?.url || ''
    const options=request.arkOptions && typeof request.arkOptions==='object' ? request.arkOptions : {}
    const capability=model.capabilities || {}
    const creativeMode=String(request.creativeMode || parameters.creativeMode || capability.default_creative_mode || 'super_economy')
    // v1.1 uses video_resolution as the canonical field. The generation
    // endpoint still accepts the legacy resolution alias; send the same value
    // for compatibility with older supplier gateways, never two values.
    const videoResolution=String(request.resolution).toLowerCase()
    Object.assign(body,{video_resolution:videoResolution,resolution:videoResolution,ratio:request.ratio || '16:9',duration:request.mode==='edit'?Math.round(request.billableDuration):request.duration,creative_mode:creativeMode,generate_audio:request.generateAudio!==false})
    for(const [key,value] of Object.entries({
      frames:options.frames ?? parameters.frames,
      seed:options.seed ?? parameters.seed,
      camera_fixed:suiheModelId(request.model)==='seedance-2.0-mini' ? (options.camera_fixed ?? parameters.cameraFixed) : undefined,
      return_last_frame:options.return_last_frame ?? parameters.returnLastFrame,
      tools:options.tools,
      omni_reference_task_type:request.mode==='image'||request.mode==='extend' ? options.omni_reference_task_type : undefined,
      service_tier:suiheModelId(request.model)==='seedance-2.0-mini' ? parameters.serviceTier : undefined,
      execution_expires_after:parameters.executionExpiresAfter,
      output_format:suiheModelId(request.model)==='seedance-2.5' ? parameters.outputFormat : undefined,
      draft:suiheModelId(request.model)==='seedance-2.5' ? parameters.draft : undefined,
    })) if(value!==undefined&&value!==null&&value!=='') body[key]=value
    if(request.mode==='edit') body.function_mode='video_edit'
    else if(request.mode==='extend') body.function_mode='omni_reference'
    else if(request.mode==='image') body.function_mode='omni_reference'
    else body.function_mode='first_last_frames'
    // v1.1 uses one mode for text, first frame and first+last frames.
    const functionModes = capability.function_modes
    if (Array.isArray(functionModes) && body.function_mode) {
      if (!functionModes.includes(body.function_mode)) throw fail('当前模型不支持这个视频参考模式',{status:422,submissionNotStarted:true})
    }
    if(firstFrame) files.push({field:'first_frame',value:firstFrame,kind:'image'})
    if(lastFrame) files.push({field:'end_frame',value:lastFrame,kind:'image'})
    const imageReferences = [...new Set<string>([request.image,...request.images||[]].filter(Boolean))]
    const libraryMaterials = body.function_mode === 'omni_reference' ? imageReferences.filter(isLibraryReference) : []
    if (libraryMaterials.length) body.materials = libraryMaterials.map(url => ({type:'image',url}))
    if(body.function_mode==='omni_reference') imageReferences.filter(value => !isLibraryReference(value)).forEach((value,index)=>files.push({field:`image_file_${index+1}`,value,kind:'image'}))
    for(const [index,value] of (request.videos||[]).entries()) files.push({field:`video_file_${index+1}`,value,kind:'video'})
    for(const [index,value] of (request.audios||[]).entries()) files.push({field:`audio_file_${index+1}`,value,kind:'audio'})
    if(Number(parameters.videoSeconds)>0) body.reference_video_duration=request.mode==='edit'?Math.round(request.billableDuration):parameters.videoSeconds
    if(parameters.returnLastFrame!==undefined&&parameters.returnLastFrame!==null) body.return_last_frame=parameters.returnLastFrame
  } else {
    const generation=request.generation || {}
    Object.assign(body,{ratio:generation.ratio||'1:1',resolution:String(generation.size || '').toLowerCase(),n:generation.count,output_format:generation.format})
    for(const [key,value] of Object.entries({
      quality:generation.quality,
      background:generation.background,
      seed:generation.seed,
      web_search:generation.controls?.webSearch,
      ...(generation.responseFormat ? {response_format:generation.responseFormat} : {}),
    })) if(value!==undefined&&value!==null&&value!=='') body[key]=value
    for(const item of request.references||[]) files.push({field:'images',value:item.value,kind:'image',bytes:item.bytes,mime:item.mime})
  }
  // Keep the transport honest: every admitted reference must become exactly
  // one multipart file, and no file may be silently dropped or invented while
  // adapting the canvas request to Suihe's field names.
  const expectedFirstFrame = video ? (request.firstFrame || (request.mode === 'singleImage' ? request.image || request.images?.[0] : '')) : ''
  const expectedImageFiles = video && body.function_mode === 'omni_reference'
    ? [...new Set<string>([request.image, ...(request.images || [])].filter(Boolean))].filter(value => !isLibraryReference(value)).length : 0
  const expectedFileCount = (expectedFirstFrame ? 1 : 0) + (video && lastFrame ? 1 : 0) + expectedImageFiles
    + (video ? (request.videos || []).length + (request.audios || []).length : (request.references || []).length)
  if (files.length !== expectedFileCount || files.some(file => !String(file.value || '').trim())) {
    throw fail('参考素材没有完整进入穗禾上传队列，请重新连接素材后重试',{status:422,submissionNotStarted:true})
  }
  let payload:BodyInit,headers:Record<string,string>={authorization:`Bearer ${config.apiKey}`}
  // Library materials live in the uploader's sub-key namespace; resolve
  // them, and the resulting task, in that same namespace.
  if(body.materials && subKey) headers['x-integrator-sub-key']=String(subKey)
  let sentFields = body
  const sentFiles:Array<Record<string,any>>=[]
  if(files.length) {
    const form=new FormData()
    const fields={...body}
    sentFields=fields
    for(const [key,value] of Object.entries(fields)) form.append(key,typeof value === 'object' ? JSON.stringify(value) : String(value))
    for(const file of files) {
      const blob=await referenceBlob(file.value,file.kind,{fetchImpl:discoveryFetch,signal,bytes:file.bytes,mime:file.mime})
      if (!(blob.size > 0)) throw fail('参考素材读取为空，穗禾任务未提交',{status:422,submissionNotStarted:true})
      form.append(file.field,blob,`${file.field}.${({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/quicktime':'mov','audio/mpeg':'mp3','audio/wav':'wav'})[blob.type]||'bin'}`)
      sentFiles.push({field:file.field,kind:file.kind,mime:blob.type,bytes:blob.size})
    }
    if (sentFiles.length !== files.length || sentFiles.some(file => !(file.bytes > 0))) {
      throw fail('参考素材未完整上传，穗禾任务未提交',{status:422,submissionNotStarted:true})
    }
    payload=form
  } else {headers['content-type']='application/json';payload=JSON.stringify(body)}
  // No automatic POST retry. A transport/5xx failure may have been accepted.
  let response:Response
  try {response=await createMediaProviderFetch({env,fetchImpl})(config.baseUrl+path,{method:'POST',headers,body:payload,signal})}
  catch(error){throw Object.assign(error,{submissionUncertain:!error.submissionNotStarted})}
  const data=await json(response,true)
  if(!response.ok||data.error) throw Object.assign(responseError(response,data,true), {sentRequest:{path,body:{...sentFields,files:sentFiles}}})
  const id=String(data.task_id||'').trim()
  if(!id||id.length>200||/\s/.test(id)) throw fail('穗禾未返回可查询的 task_id，请核对原请求',{submissionUncertain:true,upstreamStatus:response.status})
  return {id,status:'queued',upstreamModel:model.request_model,upstreamRequestId:id,upstreamStatus:response.status,raw:data,sentPath:path,sentBody:{...sentFields,files:sentFiles}}
}

export async function pollSuiheTask(id,{env=process.env,fetchImpl=fetch,signal}:Record<string,any>={}) {
  const config=suiheSettings(env)
  const response=await createMediaProviderFetch({env,fetchImpl})(`${config.baseUrl}/v1/tasks/${encodeURIComponent(id)}`,{headers:{authorization:`Bearer ${config.apiKey}`},signal})
  const data=await json(response)
  if(!response.ok) throw responseError(response,data)
  const urls=(Array.isArray(data.result_urls)?data.result_urls:[]).map(url=>new URL(String(url),config.baseUrl).href)
  const status=String(data.status||'').trim().toLowerCase()
  // Current task responses expose an explicit CNY settlement. Keep that
  // separate from the supplier's raw credit amounts; never guess their unit.
  const billing=data.billing && typeof data.billing==='object' ? data.billing : null
  // `expired` is a terminal supplier state. The local generation lifecycle
  // settles terminal upstream failures through its failed/refund path, so do
  // not leave an expired supplier task polling forever as `running`.
  const terminalSuccess = ['success', 'succeeded', 'completed', 'complete', 'done'].includes(status)
  const terminalFailure = ['failed', 'failure', 'cancelled', 'canceled', 'expired', 'error'].includes(status)
  return {id,status:terminalSuccess?'succeeded':terminalFailure?'failed':'running',urls,url:urls[0]||'',duration:data.duration??null,width:data.width??null,height:data.height??null,mime:'video/mp4',progress:data.progress_pct??null,error:data.fail_reason || (status === 'expired' ? '穗禾任务已过期' : ''),upstreamModel:data.model||'',upstreamRequestId:id,upstreamStatus:response.status,usage:{...(data.usage||{}),suihe_billing:billing,suihe_actual_cost:data.actual_cost??null,suihe_estimated_cost:data.estimated_cost??null,suihe_cost_unit:'unconfirmed'},metadata:{raw:data,status}}
}
export async function receiveSuiheImages(request,id,{env=process.env,fetchImpl=fetch,signal}:Record<string,any>={}) {
  const config=suiheSettings(env)
  let delay=2000
  for(;;) {
    signal?.throwIfAborted()
    try {
      const result=await pollSuiheTask(id,{env,fetchImpl,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)})
      if(result.status==='failed') throw fail(result.error||'穗禾图片任务失败',{upstreamStatus:200,upstreamRequestId:id,suiheTerminal:true})
      if(result.status==='succeeded') {
        if(!result.urls.length) throw fail('穗禾已完成但尚未返回图片地址')
        const images=[]
        for(const url of result.urls.slice(0,request.generation.count||1)) {
          const lifetime=signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(60_000)
          const response=await fetchVideoContent(url,{provider:'suihe',providerConfig:config,fetchImpl,signal:lifetime})
          if(!response.ok||!response.body) throw fail('穗禾图片暂时无法取回')
          const mime=response.headers.get('content-type')?.split(';')[0].toLowerCase()||''
          if(!/^image\/(png|jpeg|webp|gif)$/.test(mime)) throw fail('穗禾图片响应类型异常')
          const chunks=[];let size=0
          for await(const chunk of response.body as any){size+=chunk.length;if(size>64*1024*1024)throw fail('穗禾图片超过接收上限');chunks.push(chunk)}
          if(!size) throw fail('穗禾图片内容为空')
          images.push({url:`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`,revisedPrompt:''})
        }
        return {images,usage:result.usage,upstreamModel:result.upstreamModel,upstreamRequestId:id,upstreamStatus:result.upstreamStatus}
      }
      delay=3000
    } catch(error) {
      if(error.suiheTerminal||signal?.aborted) throw error
      // Keep querying this accepted task, including after auth/download outages.
      delay=Math.min(delay*2,30_000)
    }
    await pause(delay,signal)
  }
}
async function pause(ms,signal?:AbortSignal){
  signal?.throwIfAborted()
  await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);signal?.addEventListener('abort',abort,{once:true})})
}
