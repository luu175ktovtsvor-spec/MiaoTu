export const DOUBAO_PROVIDER = 'doubao-local'
export type LocalMediaSite = { id: 'doubao' | 'dola'; label: string; provider: string; home: string; hosts: string[]; mediaHosts: string[] }
const mediaHosts = ['doubaocdn.com', 'byteimg.com', 'ibyteimg.com', 'pstatp.com', 'volces.com', 'bytecdn.cn', 'dolacdn.com', 'ciciai.com', 'byteoversea.com', 'ibytedtos.com']
export const LOCAL_MEDIA_SITES: LocalMediaSite[] = [
  { id: 'doubao', label: '豆包', provider: DOUBAO_PROVIDER, home: 'https://www.doubao.com/chat/', hosts: ['www.doubao.com', 'doubao.com', 'sso.doubao.com', 'passport.bytedance.com'], mediaHosts: [...mediaHosts, 'doubao.com'] },
  { id: 'dola', label: 'Dola', provider: 'dola-local', home: 'https://www.dola.com/chat/', hosts: ['www.dola.com', 'dola.com', 'accounts.google.com', 'www.facebook.com', 'www.apple.com', 'appleid.apple.com'], mediaHosts },
]
// These are adapter IDs, mapped to exact, visible Doubao model labels. They
// are deliberately separate from any public API's model identifiers.
export const DOUBAO_MODELS = [
  { id: 'doubao-local-text-fast', kind: 'text', label: '豆包 快速', modeKey: '0' },
  { id: 'doubao-local-text-expert', kind: 'text', label: '豆包 专家', modeKey: '3' },
  { id: 'doubao-local-image-seedream-5.0-flash', kind: 'image', label: 'Seedream 5.0 Flash', upstreamKey: 'Seedream 5.0 Flash' },
  { id: 'doubao-local-image-seedream-5.0-pro', kind: 'image', label: 'Seedream 5.0 Pro', upstreamKey: 'Seedream 5.0 Pro' },
  { id: 'doubao-local-image-seedream-4.5', kind: 'image', label: 'Seedream 4.5', upstreamKey: 'Seedream 4.5' },
  { id: 'doubao-local-image-seedream-4.0', kind: 'image', label: 'Seedream 4.0', upstreamKey: 'Seedream 4.0' },
  { id: 'doubao-local-video-seedance-2.5', kind: 'video', label: 'Seedance 2.5', upstreamKey: 'seedance_v2.5' },
  { id: 'doubao-local-video-seedance-2.0', kind: 'video', label: 'Seedance 2.0', upstreamKey: 'seedance_v2.0_std' },
  { id: 'doubao-local-video-seedance-2.0-fast', kind: 'video', label: 'Seedance 2.0 Fast', upstreamKey: 'seedance_v2.0' },
  { id: 'doubao-local-video-seedance-2.0-mini', kind: 'video', label: 'Seedance 2.0 Mini', upstreamKey: 'seedance_v2.0_mini' },
] as const
// Labels come from the signed-in Dola get_item_conf checked on 2026-10-24.
// Closed controls may show the short selected caption, so both forms are accepted.
// Ordinary 2.0 is never an alias for Fast. This account did not list 2.5.
export const DOLA_MODELS = [
  { id: 'dola-local-text-fast', kind: 'text', label: 'Fast', modeKey: '0', labels: ['Fast', '快速'] },
  { id: 'dola-local-text-pro', kind: 'text', label: 'Pro', modeKey: '4', labels: ['Pro', '专家模式'] },
  { id: 'dola-local-image-seedream-5.0-pro', kind: 'image', label: 'Seedream 5.0 Pro', upstreamKey: 'Seedream 5.0 Pro', labels: ['Seedream 5.0 Pro'] },
  { id: 'dola-local-image-seedream-4.5', kind: 'image', label: 'Seedream 4.5', upstreamKey: 'Seedream 4.5', labels: ['Seedream 4.5'] },
  { id: 'dola-local-video-seedance-2.0-fast', kind: 'video', label: 'Dreamina Seedance 2.0 Fast', upstreamKey: 'seedance_v2.0', labels: ['Dreamina Seedance 2.0 Fast', '2.0 Fast'] },
  { id: 'dola-local-video-seedance-1.0', kind: 'video', label: 'Dreamina Seedance 1.0', upstreamKey: 'ic_mini', labels: ['Dreamina Seedance 1.0', '1.0'] },
] as const
const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, index) => min + index)
const DOUBAO_VIDEO_RATIOS = ['auto', '3:4', '4:3', '9:16', '16:9', '1:1', '21:9']
const DOLA_VIDEO_RATIOS = ['auto', '3:4', '4:3', '9:16', '16:9', '1:1', '21:9']
const DOUBAO_IMAGE_RATIOS = ['auto', '9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9']
const DOLA_IMAGE_RATIOS = ['auto', '9:16', '2:3', '3:4', '1:1', '4:3', '3:2', '16:9']
export type LocalMediaParameterPreset = {
  durations?: number[]
  defaultDuration?: number
  resolutions?: string[]
  ratios?: string[]
  imageSizeTiers?: string[]
}
// Last verified consumer-page capabilities. They make the node usable before
// the asynchronous account menu arrives. A loaded live menu always replaces
// these values, and submission still requires that live menu.
export const LOCAL_MEDIA_PARAMETER_PRESETS: Readonly<Record<string, LocalMediaParameterPreset>> = Object.freeze({
  'doubao-local-image-seedream-5.0-flash': { ratios: DOUBAO_IMAGE_RATIOS, imageSizeTiers: ['1K', '1.5K', '2K'] },
  'doubao-local-image-seedream-5.0-pro': { ratios: DOUBAO_IMAGE_RATIOS, imageSizeTiers: ['1K', '1.5K', '2K'] },
  'doubao-local-image-seedream-4.5': { ratios: DOUBAO_IMAGE_RATIOS, imageSizeTiers: ['2K', '4K'] },
  'doubao-local-image-seedream-4.0': { ratios: DOUBAO_IMAGE_RATIOS, imageSizeTiers: ['1K', '2K', '4K'] },
  'doubao-local-video-seedance-2.5': {
    durations: range(4, 30), defaultDuration: 10, resolutions: ['720p', '1080p'], ratios: DOUBAO_VIDEO_RATIOS,
  },
  'doubao-local-video-seedance-2.0': {
    durations: range(4, 15), defaultDuration: 10, resolutions: [], ratios: DOUBAO_VIDEO_RATIOS,
  },
  'doubao-local-video-seedance-2.0-fast': {
    durations: range(4, 15), defaultDuration: 10, resolutions: [], ratios: DOUBAO_VIDEO_RATIOS,
  },
  'doubao-local-video-seedance-2.0-mini': {
    durations: range(4, 15), defaultDuration: 10, resolutions: [], ratios: DOUBAO_VIDEO_RATIOS,
  },
  'dola-local-image-seedream-5.0-pro': { ratios: DOLA_IMAGE_RATIOS },
  'dola-local-image-seedream-4.5': { ratios: DOLA_IMAGE_RATIOS },
  'dola-local-video-seedance-2.0-fast': {
    durations: range(4, 10), defaultDuration: 10, resolutions: [], ratios: DOLA_VIDEO_RATIOS,
  },
  'dola-local-video-seedance-1.0': {
    durations: range(4, 10), defaultDuration: 10, resolutions: [], ratios: DOLA_VIDEO_RATIOS,
  },
})
export function localModelSelection(model: unknown) { return [...DOUBAO_MODELS, ...DOLA_MODELS].find(item => item.id === model) }
const LOCAL_MEDIA_ID = /^(doubao-local|dola-local)-(image|video|text)(?:-[a-z0-9.-]{1,64})?$/
export function localMediaSite(model: unknown, provider?: unknown) {
  const known = typeof model === 'string' && localModelSelection(model)
  const match = typeof model === 'string' ? LOCAL_MEDIA_ID.exec(model) : undefined
  const selected = LOCAL_MEDIA_SITES.find(site => known && String(model).startsWith(site.provider + '-') || match?.[1] === site.provider)
  const declared = LOCAL_MEDIA_SITES.find(site => provider === site.provider)
  if (selected && provider && provider !== selected.provider || declared && declared !== selected) {
    throw Object.assign(new Error('本机路由与所选模型来源不一致，请重新选择模型'), { status: 422 })
  }
  return selected
}
export function localMediaKind(model: unknown): DoubaoKind | undefined {
  return localModelSelection(model)?.kind || (typeof model === 'string' ? LOCAL_MEDIA_ID.exec(model)?.[2] as DoubaoKind : undefined)
}
// The closed selector and canvas title must identify the same provider/model
// pair as dispatch. Read the fixed catalog even before account/catalog loading.
export function localModelCaption(model: unknown, provider: unknown) {
  const site = localMediaSite(model, provider)
  if (!site) return ''
  const selection = localModelSelection(model)
  // 界面显示官方名称；内部 ID 只用于保存和路由。
  if (selection) return selection.label.includes(site.label) ? selection.label : `${site.label} ${selection.label}`
  return typeof model === 'string' ? model : ''
}
export function localVideoParameters(model: unknown, menu?: LiveMenu) {
  const site = localMediaSite(model)
  if (!site || localMediaKind(model) !== 'video') return
  if (menu?.loaded) {
    const live = menu.models.find(item => item.kind === 'video' && liveModelId(site, item) === model)
    if (!live) return { durations: [] as number[], resolutions: [] as string[], ratios: [] as string[], source: 'account' as const }
    return { durations: live.durations, defaultDuration: live.defaultDuration, resolutions: live.resolutions, ratios: live.ratios, source: 'account' as const }
  }
  const preset = typeof model === 'string' ? LOCAL_MEDIA_PARAMETER_PRESETS[model] : undefined
  return {
    durations: preset?.durations || [], ...(preset?.defaultDuration ? { defaultDuration: preset.defaultDuration } : {}),
    resolutions: preset?.resolutions || [], ratios: preset?.ratios || [], source: 'preset' as const,
  }
}
// The desktop adapter's accepted inputs/outputs, not an assertion that every
// upstream account exposes every creation feature. UI and admission share it.
export function localImageParameters(model: unknown, menu?: LiveMenu) {
  const site = localMediaSite(model)
  if (!site || localMediaKind(model) !== 'image') return
  if (menu?.loaded) {
    const live = menu.models.find(item => item.kind === 'image' && liveModelId(site, item) === model)
    if (!live) return { ratios: [] as string[], source: 'account' as const }
    return { ratios: live.ratios, source: 'account' as const }
  }
  const preset = typeof model === 'string' ? LOCAL_MEDIA_PARAMETER_PRESETS[model] : undefined
  return { ratios: preset?.ratios || [], source: 'preset' as const }
}
export function localMediaCapabilities(model: unknown, provider?: unknown) {
  const site = localMediaSite(model, provider), kind = localMediaKind(model)
  if (!site || !kind || kind === 'text') return
  // Dola 网页脚本 videoUploadPipelineConfig / imageUploadPipelineConfig：
  // 只收图片，maxCount 10。聊天上传配置 maxImageSize 为 0x1400000（20MB），
  // 扩展名 png/jpeg/jpg/webp。没有合计体积上限，也不在客户端写死视频秒数。
  const imageReferences = site.id === 'doubao' || site.id === 'dola'
  return {
    platform: site.id, kind,
    references: { maxImages: imageReferences ? 10 : 0,
      imageMimeTypes: imageReferences ? ['image/png', 'image/jpeg', 'image/webp'] : [],
      maxImageBytes: imageReferences ? 20 * 1024 * 1024 : 0,
      maxTotalBytes: 0,
      video: false, audio: false, keyframes: false },
    outputMimeTypes: kind === 'video' ? ['video/mp4', 'video/webm'] : ['image/png', 'image/jpeg', 'image/webp'],
    watermark: { aiRemovalDefault: true, preferPlatformOriginal: true, brandRemovalGuaranteed: false },
  }
}
export function localReferenceRejection(model: unknown, provider: unknown, counts: { image?: number; video?: number; audio?: number }) {
  const capabilities = localMediaCapabilities(model, provider)
  if (!capabilities) return ''
  const image = counts.image || 0, video = counts.video || 0, audio = counts.audio || 0
  const label = capabilities.platform === 'dola' ? 'Dola' : '豆包'
  if (video && !capabilities.references.video || audio && !capabilities.references.audio) return `${label}当前不支持视频或音频参考，请断开这类连线`
  if (image > capabilities.references.maxImages) return capabilities.references.maxImages
    ? `${label}当前型号最多接入 ${capabilities.references.maxImages} 张参考图`
    : `${label}当前只接受文字提示词，请断开图片连线`
  return ''
}
export type DoubaoKind = 'image' | 'video' | 'text'
export type DoubaoQuota = { remaining: number | null; unit: string; source: 'platform' | 'unknown'; checkedAt: string | null }
export type LiveMenuModel = {
  kind: 'image' | 'video' | 'text'; key: string; label: string; labels: string[]
  durations: number[]; defaultDuration?: number; ratios: string[]; resolutions: string[]
}
export type LiveMenu = { checkedAt: string; loaded: boolean; models: LiveMenuModel[] }
export type DoubaoStatus = {
  connected: boolean; state: string; name: string; message: string; checkedAt: string | null
  image: DoubaoQuota; video: DoubaoQuota; text: DoubaoQuota; imageModel?: string; videoModel?: string
  menu?: LiveMenu
}
export function liveModelId(site: LocalMediaSite, model: { kind: string; key: string }) {
  const known = (site.id === 'doubao' ? DOUBAO_MODELS : DOLA_MODELS).find(item => item.kind === model.kind
    && ('upstreamKey' in item && item.upstreamKey === model.key || 'modeKey' in item && item.modeKey === model.key))
  if (known) return known.id
  const slug = model.key.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `${site.provider}-${model.kind}-${slug || 'item'}`
}
export function liveSelection(model: unknown, menu?: LiveMenu) {
  const site = typeof model === 'string' ? localMediaSite(model) : undefined
  const item = site && menu?.loaded ? menu.models.find(entry => liveModelId(site, entry) === model) : undefined
  if (!item || !site) return localModelSelection(model)
  const known = localModelSelection(liveModelId(site, item))
  const labels = [...new Set([item.label, ...item.labels, ...(known && 'labels' in known ? known.labels : []), known?.label].filter((value): value is string => !!value))]
  return { id: liveModelId(site, item), kind: item.kind, label: labels[0] || item.key, labels, upstreamKey: item.key }
}
export const emptyQuota = (): DoubaoQuota => ({ remaining: null, unit: '次', source: 'unknown', checkedAt: null })
export const disconnectedStatus = (label = '豆包'): DoubaoStatus => ({ connected: false, state: 'disconnected', name: '', message: '请在妙图中登录' + label, checkedAt: null, image: emptyQuota(), video: emptyQuota(), text: emptyQuota() })
// These IDs identify the local route. The actual engine and available rights
// belong to the signed-in Doubao page; do not advertise an invented API model.
function presentLocalModel(site: LocalMediaSite, id: string, kind: 'image' | 'video', label: string, menu: LiveMenu | undefined, connected: boolean, note: string) {
  const parameters = kind === 'video' ? localVideoParameters(id, menu) : undefined
  const imageParameters = kind === 'image' ? localImageParameters(id, menu) : undefined
  const capabilities = localMediaCapabilities(id, site.provider)!
  const parameterPreset = LOCAL_MEDIA_PARAMETER_PRESETS[id]
  const known = localModelSelection(id)
  return {
    providerId: site.provider, providerLabel: site.label,
    modelId: id, label,
    ...(known && 'upstreamKey' in known ? { upstreamModelId: known.upstreamKey } : {}),
    type: kind, mode: capabilities.references.maxImages ? ['text', ['imageReference:' + capabilities.references.maxImages]] : ['text'], maxReferences: capabilities.references.maxImages, maxCount: 1,
    sizes: [],
    imageSizes: [], imageRatios: imageParameters?.ratios || [],
    ratios: parameters?.ratios || imageParameters?.ratios || [],
    durations: parameters?.durations || [],
    resolutions: parameters?.resolutions || [],
    ...(parameters?.defaultDuration ? { defaultDuration: parameters.defaultDuration } : {}),
    durationResolutionMap: parameters ? [{ duration: parameters.durations, resolution: parameters.resolutions }] : [],
    parameterSource: parameters?.source || imageParameters?.source || 'preset',
    ...(parameterPreset ? { parameterPreset } : {}),
    billingSource: site.provider,
    localCapabilities: capabilities,
    note, connected,
  }
}
export function localMediaModels(site: LocalMediaSite, status: DoubaoStatus) {
  // Same rule as text: the platform's models only appear while its account is
  // signed in. A menu read earlier can outlive a sign-out done inside the page.
  if (!status.connected) return []
  if (status.menu?.loaded && status.menu.models.length) {
    return status.menu.models.filter((item): item is LiveMenuModel & { kind: 'image' | 'video' } => item.kind === 'image' || item.kind === 'video').map(item => {
      const id = liveModelId(site, item)
      const known = localModelSelection(id)
      const label = item.label !== item.key ? item.label : known?.label || item.label
      return presentLocalModel(site, id, item.kind, label, status.menu, status.connected, `来自当前${site.label}账号的创作菜单`)
    })
  }
  // An empty loaded menu is an authoritative account result, not a loading
  // state. Do not fall back to presets in that case.
  if (status.menu?.loaded) return []
  if (status.connected) {
    return (site.id === 'doubao' ? DOUBAO_MODELS : DOLA_MODELS)
      .filter((item): item is (typeof item) & { kind: 'image' | 'video' } => item.kind === 'image' || item.kind === 'video')
      .map(item => presentLocalModel(site, item.id, item.kind, item.label, undefined, true, `已连接${site.label}；先显示预置参数，读取当前账号菜单后自动校正`))
  }
  return []
}
export function localTextModels(site: LocalMediaSite, status?: DoubaoStatus) {
  // Text routes belong to the signed-in platform page just like image/video
  // routes. Returning presets while disconnected makes an unauthenticated
  // desktop show selectable 豆包/Dola models and lets the text node silently
  // choose one as its default. Keep them out until the platform session is
  // actually connected.
  if (!status?.connected) return []
  const base = localTextModel(site)
  const live = status?.menu?.loaded ? status.menu.models.filter(item => item.kind === 'text') : []
  if (live.length) return live.map(item => {
    const id = liveModelId(site, item)
    const known = localModelSelection(id)
    return { ...base, modelId: id, label: item.label || (known && 'label' in known ? known.label : item.key) }
  })
  // A successfully loaded account menu is authoritative, including an empty
  // text section. Presets are only a bridge while the menu is still loading.
  if (status.menu?.loaded) return []
  return (site.id === 'doubao' ? DOUBAO_MODELS : DOLA_MODELS).filter(item => item.kind === 'text').map(item => ({ ...base, modelId: item.id, label: item.label }))
}
export function localTextModel(site: LocalMediaSite) {
  return { providerId: site.provider, providerLabel: site.label, modelId: site.provider + '-text',
    label: site.label + '文本对话', protocol: 'local-web', supportsTools: false,
    note: `使用已连接的${site.label}账号生成文本；不提供 Agent 工具调用` }
}

// Only explicit remaining counts are authoritative. Missing values stay null;
// neither a successful job nor a local counter can prove platform balance.
export function readQuota(texts: string[], kind: DoubaoKind, at: string): DoubaoQuota {
  const capability = kind === 'image' ? /图像|图片|生图|image/i : kind === 'video' ? /视频|生视频|video/i : /文本|对话|text|chat/i
  const categories = [/图像|图片|生图|image/i, /视频|生视频|video/i, /文本|对话|text|chat/i]
  const candidates = [...new Set(texts)].filter(text => text.length <= 180 && capability.test(text) && categories.filter(pattern => pattern.test(text)).length === 1)
    .flatMap(text => {
      const match = text.match(/(?:剩余|还可(?:生成)?|可用)(?:次数|额度)?[：:\s]*(\d+)\s*(次|张|秒|积分)/) || text.match(/(?:remaining|available)\s*[:：]?\s*(\d+)\s*(credits?|images?|videos?|seconds?)/i)
      return match ? [{ remaining: Number(match[1]), unit: match[2], source: 'platform' as const, checkedAt: at }] : []
    })
  return candidates.length === 1 ? candidates[0] : emptyQuota()
}
