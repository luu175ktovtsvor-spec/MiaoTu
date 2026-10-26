// Customer-facing SD routes. Original provider definitions remain in image-models.
// Snapshot verified against authenticated GET /v1/models on 2026-10-25.
const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4']
const imageRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
export const SUIHE_MODEL_IDS = ['seedance-2.5', 'seedance-2.0', 'seedance-2.0-fast', 'seedance-2.0-mini', 'seedream-5.0-pro', 'seedream-5.0-lite', 'seedream-4.5', 'seedream-4.0']
export function suiheModelId(model): string {
  const id = String(model?.publicId || model?.id || model || '')
  return ({ 'doubao-seedream-5-0-pro': 'seedream-5.0-pro', 'doubao-seedream-4-0': 'seedream-4.0' })[id] || id
}
let liveModels = new Map<string, any>()
export function setSuiheModels(rows: any[]) { liveModels = new Map(rows.filter(row => SUIHE_MODEL_IDS.includes(row.id)).map(row => [row.id, row])) }
export function suiheCapability(model) { return liveModels.get(suiheModelId(model)) }
export function suiheModelOverlay(model): Record<string, any> {
  const id = suiheModelId(model)
  if (!SUIHE_MODEL_IDS.includes(id)) return { ...model, ...(String(model.publicId || model.id).includes('seedream-5-0-flash') ? { internalOnly: true } : {}) }
  const remote = liveModels.get(id)
  const cap = remote?.capabilities || {}
  const common = { ...model, provider: 'suihe', legacyProvider:model.provider, upstreamModelId: remote?.request_model || id, channelCategory: model.video ? 'sd-video' : 'sd-image', deprecated:false, sunsetAt:'', replacement:'' }
  if (model.video) {
    const is25 = id === 'seedance-2.5'
    // 2.0, Fast and Mini reject first_frame uploads as video editing;
    // their dual-frame submissions return 500 without a task ID. Keep these
    // modes closed until the supplier resolves the recorded requests.
    const functionModes = Array.isArray(cap.function_modes) ? cap.function_modes : []
    const framesAvailable = is25 && functionModes.includes('first_last_frames')
    const mixedAvailable = functionModes.includes('omni_reference')
    const editAvailable = is25 && functionModes.includes('video_edit')
    const listedResolutions = cap.resolutions || (id === 'seedance-2.0' ? ['480p','720p','1080p','4k'] : is25 ? ['480p','720p','1080p'] : ['480p','720p'])
    const configuredDefault = String(cap.default_resolution || '').trim().toLowerCase()
    const defaultResolution = configuredDefault || (listedResolutions.includes('720p') ? '720p' : listedResolutions[0])
    const resolutions = defaultResolution && listedResolutions.includes(defaultResolution)
      ? [defaultResolution, ...listedResolutions.filter(value => value !== defaultResolution)]
      : listedResolutions
    const creativeModes = cap.creative_modes || ['native', 'super_economy']
    const defaultCreativeMode = cap.default_creative_mode || (creativeModes.includes('super_economy') ? 'super_economy' : creativeModes[0] || 'native')
    const advertisedCreativeResolutions = cap.resolutions_by_creative_mode || {
      native: listedResolutions.filter(value => is25 || id === 'seedance-2.0' || value === '480p' || value === '720p'),
      super_economy: listedResolutions.filter(value => value === '720p' || (is25 && value === '1080p') || (id === 'seedance-2.0' && value === '1080p')),
    }
    // The catalog also lists per-resolution restrictions; apply both lists.
    const resolutionsByCreativeMode = Object.fromEntries(Object.entries(advertisedCreativeResolutions).map(([mode, values]) => [mode,
      (values as string[]).filter(value => !Array.isArray(cap.creative_mode_rules?.[value]) || cap.creative_mode_rules[value].includes(mode)),
    ]))
    const minDuration = cap.duration?.min || 4
    const maxDuration = cap.duration?.max || (is25 ? 30 : 15)
    const durations = Array.from({length:maxDuration - minDuration + 1}, (_, n) => n + minDuration)
    const defaultDuration = Number(cap.default_duration) || (durations.includes(10) ? 10 : durations[0])
    return { ...common, note: `${is25 ? '4–30' : '4–15'} 秒 · ${resolutions.join('/')}`, sizes: resolutions.map(value => ({value,label:value,ratio:'16:9'})), ratios: [...(cap.ratios || ratios), 'adaptive'], durations,
      modes: ['text',...(framesAvailable ? ['singleImage','endFrameOptional'] : []), ...(editAvailable ? ['edit'] : []), ...(is25 && mixedAvailable ? ['extend'] : []), ...(mixedAvailable ? [[`imageReference:${cap.reference_limits?.image ?? (is25 ? 30 : 9)}`, `videoReference:${cap.reference_limits?.video ?? (is25 ? 10 : 3)}`, `audioReference:${cap.reference_limits?.audio ?? (is25 ? 10 : 3)}`]] : [])],
      referenceLimits: { image:cap.reference_limits?.image ?? (is25 ? 30 : 9), video:cap.reference_limits?.video ?? (is25 ? 10 : 3), audio:cap.reference_limits?.audio ?? (is25 ? 10 : 3), frames:framesAvailable?2:0 }, audio:'optional', supportsEdit:is25,
      creativeModes, defaultCreativeMode, defaultResolution: resolutions[0] || '', defaultDuration, resolutionsByCreativeMode,
      controls:[{key:'creativeMode',label:'创作档',type:'select',options:creativeModes,default:defaultCreativeMode},{key:'cameraFixed',label:'固定镜头',type:'boolean'},{key:'returnLastFrame',label:'返回尾帧',type:'boolean'}],
      maxDurationByResolution:{}, maxDurationByMode:{},
      parameterRules: { requireVisualInMixed:true, resolutionsByControl:{creativeMode:resolutionsByCreativeMode}, ratiosByMode:{text:cap.ratios || ratios,image:cap.ratios || ratios,singleImage:['adaptive'],endFrameOptional:['adaptive'], ...(is25 ? {edit:['adaptive'],extend:['adaptive']} : {})}, inheritByMode:{singleImage:['ratio'],endFrameOptional:['ratio'],...(is25 ? {edit:['duration','ratio'],extend:['ratio']} : {})}, ...(is25 ? {referenceInputsByMode:{edit:{video:{minDuration:4,maxDuration:30}}},hintsByMode:{edit:'编辑保持原视频时长与比例，参考视频需为 4–30 秒'}} : {}) },
    }
  }
  const tiers = cap.resolutions || ({'seedream-5.0-pro':['1k','1.5k','2k'],'seedream-5.0-lite':['2k','3k'],'seedream-4.5':['2k','4k'],'seedream-4.0':['1k','2k','4k']})[id]
  // 4K exists upstream but has no owner-approved procurement price yet.
  const pricedTiers=tiers.filter(value=>!(['seedream-4.0','seedream-4.5'].includes(id) && value==='4k'))
  // Only Lite advertises selectable encoding. The other image models returned
  // JPEG even when PNG was requested, so do not advertise an unsupported choice.
  const formats = cap.output_formats || (id === 'seedream-5.0-lite' ? ['jpeg','png'] : ['jpeg'])
  return { ...common, note:pricedTiers.join('/'), unpricedSizes:tiers.filter(value=>!pricedTiers.includes(value)), sizes:pricedTiers.map(value => ({value:value.toUpperCase(),label:value.toUpperCase(),ratio:''})), ratios:cap.ratios || imageRatios, customSize:false, quality:[], formats, maxCount:1, maxCombinedImages:undefined, maxReferences:cap.max_reference_images || (id==='seedream-5.0-pro'?10:16), supportsEdit:true, regionEdit:null, supportsTransparent:false, supportsLayerDecomposition:false, optimizePromptModes:[], layerSizes:[], controls:cap.web_search === true ? [{key:'webSearch',label:'联网搜索',type:'boolean'}] : [] }
}
