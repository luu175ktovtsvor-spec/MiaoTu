import { isSeedance25 } from './seedance25.ts'
import { recordDesktopMediaOutput } from './desktop-media.ts'
import { fetchVideoContent } from './video-content-fetch.ts'
import { isCostPlusVideo, videoPricingSnapshot } from './video-pricing.ts'
import { normalizeReferenceHistory } from './user-prompts.ts'
import { currentProject, DEFAULT_PROJECT_ID } from './workspace-scope.ts'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { withNormalizedVideoFile } from './video-normalize.ts'
import { withStreamedMedia, mediaPermissions } from './media-files.ts'
import { WORKSPACE_FILE_MAX_BYTES } from './workspace-files.ts'
import { assertReferenceInput, referenceInputPolicy } from './reference-input-contract.ts'
import { activeModelForSettings, modelById, modelForGeneration, publicVideoCatalog } from './image-models.ts'
import { estimateGenerationCost, estimateUpstreamCostRmb, VIDEO_INPUT_PRICING } from './generation-cost.ts'
import { failure } from './management-store.ts'
import { assertModelAccess } from './model-access.ts'
import { GENERATION_STATES, generationReceipt, newRequestId, validIdempotencyKey, validRequestId } from './generation-contract.ts'
import { arkVideoReady, createArkVideoTask, pollArkVideoTask, arkVideoSettings } from './ark-video.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed, isMockProviderMode, mockProviderAudit } from './provider-safety.ts'
import { createMediaProviderFetch, ProviderRedirectError } from './provider-fetch.ts'
import { createMetasoVideoTask, metasoCreditsBalance, metasoVideoSettings, pollMetasoVideoTask } from './metaso-video.ts'
import { createMediaProbe, REFERENCE_RETRY_DELAYS_MS, redactReferencePayload, summarizeReferenceValue } from './reference-assets.ts'
import { acceptedVideoSubmissionError } from './video-submission.ts'
import { createSuiheTask, pollSuiheTask, suiheSettings, estimateSuiheVideo } from './suihe.ts'
import { suihePricingSnapshot } from './suihe-pricing.ts'

const probeVideoFile = createMediaProbe()

/** First video contract. Upstream calls only happen inside createVideo/pollVideo. */
export const VIDEO_LIMITS = Object.freeze({ minDuration: 1, maxDuration: 30 })
export const VIDEO_API_PATHS = Object.freeze({ create: '/api/imagine/video', poll: '/api/imagine/video/:requestId' })

export function videoSettings(env = process.env, model) {
  if (model?.provider === 'suihe') return suiheSettings(env)
  const grok = model?.provider === 'grok' || String(model?.id || '').startsWith('grok-imagine-video')
  const configuredBase = grok
    ? (isMockProviderMode(env) ? env.GROK_BASE_URL : (env.GROK_BASE_URL || env.YUNSHU_BASE_URL || env.SUB2API_BASE_URL || 'http://127.0.0.1:3000'))
    : (isMockProviderMode(env) ? env.SUB2API_BASE_URL : (env.SUB2API_BASE_URL || 'http://127.0.0.1:3000'))
  // Yunshu 的图片兼容地址通常包含 /v1，而 Yunshu 上的媒体兼容路由使用
  // /v1/videos/generations；去掉结尾 /v1 后再拼接，避免出现 /v1/v1/videos。
  const baseUrl = String(configuredBase).replace(/\/$/, '').replace(grok ? /\/v1$/ : /$^/, '')
  assertProviderRequestAllowed(grok ? 'grok' : 'sub2api', baseUrl, env)
  return {
    baseUrl,
    apiKey: String(grok
      ? (isMockProviderMode(env) ? runtimeSecret('GROK_API_KEY', env) : (runtimeSecret('GROK_API_KEY', env) || runtimeSecret('YUNSHU_API_KEY', env)))
      : (isMockProviderMode(env) ? runtimeSecret('SUB2API_API_KEY', env) : (runtimeSecret('SUB2API_API_KEY', env) || runtimeSecret('GROK_API_KEY', env) || runtimeSecret('YUNSHU_API_KEY', env)))),
    enabled: env.ENABLE_MODEL_CALLS === 'true',
  }
}

export function videoModelCatalog(env = process.env) {
  // 每个视频模型按自己的通道判断可用性：Seedance 用 ARK Key，Grok 走 Yunshu 媒体兼容接口。
  return publicVideoCatalog(env)
}

export function estimateVideoCost(model, generation: Record<string, any> = {}) {
  return estimateGenerationCost({ model: { video: true, publicId: model?.publicId || model?.id, provider: model?.provider }, generation })
}

function uniqueUrls(values) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

function isSuiheLibraryReference(value) {
  return /^(?:asset|whitelist):\/\/[^\s]+$/i.test(String(value || '').trim())
}

function modelModes(model) {
  return Array.isArray(model?.modes) ? model.modes : []
}

function supportsMixedReferenceMode(model) {
  return modelModes(model).some((mode) => Array.isArray(mode))
}

function supportsMode(model, mode) {
  // 旧版妙图画布曾把秘塔的单图入口保存成 singleImage；秘塔协议实际
  // 把它当作 reference_image。继续接受这个历史值，避免已保存画布失效，
  // 但新目录只展示官方的首帧/尾帧/混合参考模式。
  if (mode === 'singleImage' && model?.provider === 'metaso') {
    return modelModes(model).includes('startFrameOptional') || modelModes(model).includes('endFrameOptional')
  }
  return mode === 'image'
    ? supportsMixedReferenceMode(model) || model?.id === 'grok-imagine-video-1.5'
    : modelModes(model).includes(mode)
}

function isSeedance20(model) {
  return model?.id === 'seedance-2.0' || model?.id === 'seedance-2.0-mini' || model?.publicId === 'seedance-2.0-fast'
}

function isFrameMode(mode) {
  return ['startEndRequired', 'endFrameOptional', 'startFrameOptional'].includes(mode)
}

// 画布节点的输出目录（服务端把成片直接写进去）。只接受安全的相对路径。
export function safeOutputDirectory(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '')
  if (!text || text.length > 300) return ''
  const segments = text.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return ''
  return segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)) ? text : ''
}

export function parseVideoFrames(value) {
  return value === undefined || value === '' ? undefined : Number(value)
}

export function validateVideoRequest(payload: Record<string, any> = {}, env = process.env): Record<string, any> {
  const prompt = String(payload.prompt || '').trim()
  const modelId = String(payload.model || '').trim()
  const model = modelForGeneration(modelId, payload, payload.__provider || payload.upstreamProvider) || modelById(modelId)
  if (!model?.video) throw failure('不支持的视频模型', 422)
  // xAI 的 Grok 1.5 在首尾帧、关键帧或参考图/预设声音模式下允许省略
  // prompt；文生视频仍必须有描述。其它上游都要求文本内容。
  const hasNonEmptyReference = (values) => Array.isArray(values)
    && values.some((value) => {
      const item = value && typeof value === 'object'
        ? value.url || value.voice_id || value.voiceId || value.image?.url
        : value
      return Boolean(String(item || '').trim())
    })
  const grokFramePromptOptional = model.id === 'grok-imagine-video-1.5'
    && (String(payload.image || '').trim()
      || String(payload.firstFrame || '').trim()
      || String(payload.lastFrame || '').trim()
      || hasNonEmptyReference(payload.images)
      || hasNonEmptyReference(payload.keyframes)
      || hasNonEmptyReference(payload.referenceVoices)
      || hasNonEmptyReference(payload.voiceIds))
  if (model.provider === 'suihe' && [...prompt].length > 4000) throw failure('视频描述不能超过 4000 个字符', 422)
  if (prompt.length < (model.provider === 'suihe' ? 1 : 2) && !grokFramePromptOptional) throw failure('请先输入视频描述', 422)
  const config = videoSettings(env, model)
  if (!config.enabled) throw failure('模型调用暂不可用，请稍后再试', 503)
  if (model.provider === 'ark') {
    const ark = arkVideoSettings(env)
    if (!ark.apiKey) throw failure('视频服务暂时不可用，请稍后再试', 503)
  } else if (model.provider === 'metaso') {
    const metaso = metasoVideoSettings(env)
    if (!metaso.apiKey) throw failure('视频服务暂时不可用，请稍后再试', 503)
  } else if (model.provider === 'suihe') {
    if (!suiheSettings(env).apiKey) throw failure('视频服务暂时不可用，请稍后再试', 503)
  } else if (!config.apiKey) {
    throw failure('视频服务暂时不可用，请稍后再试', 503)
  }
  // 视频参数按模型能力校验：时长（秒）、分辨率、比例、生成模式与参考素材上限
  // 全部来自模型目录，前端控件与这里保持同一份数据。
  const rawFrames = parseVideoFrames(payload.frames)
  // 方舟 API Explorer 明确标注 Seedance 2.0 / 2.0 fast 暂不支持 frames；
  // 这些模型只能传 duration。不要因为旧画布保存过 frames 就把无效字段发给上游。
  const framesSupported = model.provider === 'ark' && !isSeedance20(model) && !isSeedance25(model)
  if (rawFrames !== undefined && !framesSupported) throw failure('当前模型不支持 frames 参数，请使用整数 duration', 422)
  if (rawFrames !== undefined && (!Number.isInteger(rawFrames) || rawFrames <= 0 || rawFrames > 24 * VIDEO_LIMITS.maxDuration)) throw failure('帧数无效', 422)
  // 只有支持 frames 的方舟模型才允许使用 duration 的官方替代字段；
  // 计费使用真实 frames/24 秒数，不能先 ceil 后再算，否则会多扣输入输出秒数。
  const hasFrames = rawFrames !== undefined
  const frameDuration = hasFrames ? rawFrames / 24 : undefined
  const mode = Array.isArray(payload.mode) ? 'image' : String(payload.mode || 'text').trim() || 'text'
  if (!supportsMode(model, mode)) throw failure(`当前模型不支持生成模式 ${mode}`, 422)
  const suppliedDuration = payload.duration === undefined || payload.duration === '' ? undefined : Number(payload.duration)
  // 没选时长时不补 5 秒。编辑会沿用成片时长：Seedance 2.5 官方用 -1，Grok 编辑不传 duration。
  const inheritsDuration = mode === 'edit' && (model.provider === 'grok' || isSeedance25(model))
  if (!hasFrames && suppliedDuration === undefined && !inheritsDuration) throw failure('请选择视频时长', 422)
  const rawDuration = frameDuration ?? suppliedDuration ?? (isSeedance25(model) && mode === 'edit' ? -1 : undefined)
  const allowedDurations = Array.isArray(model.durations) && model.durations.length ? model.durations : null
  // 火山方舟用 -1 表示由模型自己选时长。只在该型号目录写了 -1 时放行。
  const automaticDuration = !hasFrames && rawDuration === -1 && Boolean(allowedDurations?.includes(-1) || (isSeedance25(model) && mode === 'edit'))
  const durationOmitted = rawDuration === undefined
  if (!durationOmitted && !automaticDuration && (!Number.isFinite(rawDuration) || rawDuration <= 0)) throw failure('视频时长必须是正数', 422)
  if (!durationOmitted && !automaticDuration && !hasFrames && !Number.isInteger(rawDuration)) throw failure('视频时长必须是整数秒；需要小数秒时请使用 frames', 422)
  const duration = durationOmitted ? undefined : automaticDuration ? -1 : Math.floor(rawDuration)
  if (allowedDurations) {
    const positiveDurations = allowedDurations.filter((item) => item > 0)
    const minDuration = Math.min(...positiveDurations)
    const maxDuration = Math.max(...positiveDurations)
    if (!durationOmitted && (hasFrames ? (rawDuration < minDuration || rawDuration > maxDuration) : !allowedDurations.includes(duration))) {
      throw failure(`当前模型只支持 ${minDuration}–${maxDuration} 秒`, 422)
    }
  }
  const resolution = String(payload.resolution || '').trim()
  const allowedSizes = (model.sizes || []).map((size) => size.value)
  const inheritsResolution = model.provider === 'grok' && (mode === 'edit' || mode === 'extend')
  if (!resolution && allowedSizes.length && !inheritsResolution) throw failure('请选择分辨率', 422)
  if (resolution && allowedSizes.length && !allowedSizes.includes(resolution)) {
    throw failure(`当前模型不支持分辨率 ${resolution}，可选：${allowedSizes.join('、')}`, 422)
  }
  const modeResolutions = model.parameterRules?.resolutionsByMode?.[mode]
  if (resolution && Array.isArray(modeResolutions) && !modeResolutions.includes(resolution)) throw failure('当前模式不支持这个分辨率', 422)
  const creativeModes = Array.isArray(model.creativeModes) ? model.creativeModes : []
  const requestedCreativeMode = payload.creativeMode === undefined || payload.creativeMode === '' ? undefined : String(payload.creativeMode).trim()
  const creativeMode = model.provider === 'suihe' && creativeModes.length
    ? (requestedCreativeMode || model.defaultCreativeMode || creativeModes[0])
    : requestedCreativeMode
  if (creativeMode && creativeModes.length && !creativeModes.includes(creativeMode)) throw failure(`当前模型不支持创作档 ${creativeMode}`, 422)
  if (model.provider === 'suihe' && creativeMode && resolution) {
    const allowedCreativeResolutions = model.resolutionsByCreativeMode?.[creativeMode]
    if (Array.isArray(allowedCreativeResolutions) && !allowedCreativeResolutions.map(String).map(value => value.toLowerCase()).includes(resolution.toLowerCase())) {
      throw failure(`${creativeMode} 创作档不支持 ${resolution}`, 422)
    }
  }
  const resolutionDurationCap = model.maxDurationByResolution?.[resolution]
  if (resolutionDurationCap && duration !== undefined && duration > resolutionDurationCap) {
    throw failure(`${resolution} 最长 ${resolutionDurationCap} 秒`, 422)
  }
  // 部分模型的时长上限按模式不同（例如经典 Grok 的参考图生视频官方只到 10 秒，
  // 而文生/单图仍是 1–15 秒），所以上限放在模式确定之后再校验一次。
  const modeDurationCap = model.maxDurationByMode?.[mode]
  if (modeDurationCap && duration !== undefined && duration > modeDurationCap) throw failure(`当前模式最长 ${modeDurationCap} 秒`, 422)
  const durationRule = model.parameterRules?.durationByMode?.[mode]
  if (durationRule && duration !== undefined && duration > 0) {
    if (durationRule.min != null && duration < durationRule.min) throw failure(`当前模式最短 ${durationRule.min} 秒`, 422)
    if (durationRule.max != null && duration > durationRule.max) throw failure(`当前模式最长 ${durationRule.max} 秒`, 422)
  }
  const limits = model.referenceLimits || { image: model.maxReferences || 1, video: 0, audio: 0, frames: 0 }
  const image = String(payload.image || '').trim()
  const requestedImages = uniqueUrls(payload.images)
  const requestedVideos = uniqueUrls(payload.videos)
  const requestedAudios = uniqueUrls(payload.audios)
  const rawVoices = Array.isArray(payload.referenceVoices) ? payload.referenceVoices : Array.isArray(payload.voiceIds) ? payload.voiceIds : []
  if (rawVoices.length > 3) throw failure('预设声音最多支持 3 个', 422)
  const referenceVoices = rawVoices.map((value) => {
    const voiceId = typeof value === 'object' ? value?.voice_id ?? value?.voiceId : value
    const normalized = String(voiceId || '').trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(normalized)) throw failure('预设声音标识无效', 422)
    return normalized
  })
  if (referenceVoices.length && model.id !== 'grok-imagine-video-1.5') throw failure('当前模型不支持预设声音', 422)
  const firstFrame = String(payload.firstFrame || '').trim()
  const lastFrame = String(payload.lastFrame || '').trim()
  const keyframesPayload = payload.keyframes === undefined ? [] : payload.keyframes
  if (!Array.isArray(keyframesPayload)) throw failure('keyframes 必须是数组', 422)
  if (keyframesPayload.length && model.id !== 'grok-imagine-video-1.5') throw failure('当前模型不支持 keyframes', 422)
  if (keyframesPayload.length > 4) throw failure('keyframes 最多支持 4 个', 422)
  const keyframes = keyframesPayload.map((item) => {
    const source = item && typeof item === 'object' ? item : {}
    const imageValue = source.image && typeof source.image === 'object' ? source.image.url : source.image
    const url = String(imageValue || source.url || '').trim()
    const timestamp = Number(source.timestamp_s ?? source.timestamp)
    if (!url || url.length > 20_000) throw failure('keyframe 图片地址无效', 422)
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp >= rawDuration || Math.abs(timestamp * 3 - Math.round(timestamp * 3)) > 1e-6) {
      throw failure('keyframe 时间必须在视频内部并对齐 1/3 秒网格', 422)
    }
    return { image: { url }, timestamp_s: Math.round(timestamp * 1000) / 1000 }
  })
  const keyframeSlots = new Set(keyframes.map((item) => Math.round(item.timestamp_s * 3)))
  if (keyframeSlots.size !== keyframes.length) throw failure('keyframe 时间不能重复', 422)
  const frameEntries = [firstFrame, lastFrame].filter(Boolean)
  const frameSet = new Set(frameEntries)
  // image 是单图模式的别名，也可能由画布在混合参考模式下带上。去掉它与
  // 首尾帧/ images 的重复项，避免重复发给上游和重复计入素材数量。
  const genericImages = uniqueUrls([image, ...requestedImages]).filter((url) => !frameSet.has(url))
  const images = genericImages
  const videos = uniqueUrls([payload.video, ...requestedVideos])
  const audios = requestedAudios
  const libraryReferences = [...images, ...frameEntries].filter(isSuiheLibraryReference)
  if (libraryReferences.length && model.provider !== 'suihe') throw failure('人物白名单或云端素材只能用于穗禾模型', 422)
  if (libraryReferences.length && (mode !== 'image' || frameEntries.some(isSuiheLibraryReference))) throw failure('人物白名单或云端素材请放在全能参考模式中', 422)
  const videoLimit = (mode === 'edit' || mode === 'extend') ? Math.max(1, limits.video ?? 0) : (limits.video ?? 0)
  const video = videos[0] || ''
  const referenceImageCount = frameEntries.length + images.length
  const modeReferences = model.parameterRules?.referencesByMode?.[mode]
  if (modeReferences) {
    for (const [kind, count] of Object.entries({ image: referenceImageCount, video: videos.length, audio: audios.length })) {
      const [min, max] = modeReferences[kind] || [0, 0]
      if (count < min || count > max) throw failure(`当前模式的${{image:'图片',video:'视频',audio:'音频'}[kind]}参考数量需为 ${min}–${max}`, 422)
    }
  }
  if (referenceImageCount && (limits.image ?? 0) <= 0) throw failure('当前模型不支持图片参考', 422)
  if (referenceImageCount > (limits.image ?? 0)) throw failure(`当前模型最多支持 ${limits.image} 张图片参考（含首尾帧）`, 422)
  if (videos.length && videoLimit <= 0) throw failure('当前模型不支持视频参考', 422)
  if (videos.length > videoLimit) throw failure(`当前模式最多支持 ${videoLimit} 个视频参考`, 422)
  if (audios.length && (limits.audio ?? 0) <= 0) throw failure('当前模型不支持音频参考', 422)
  if (audios.length > (limits.audio ?? 0)) throw failure(`当前模型最多支持 ${limits.audio} 个音频参考`, 422)
  if (frameEntries.length > (limits.frames ?? 0)) throw failure(`当前模型最多支持 ${limits.frames} 个首尾帧`, 422)
  if (image && image.length > 20_000) throw failure('参考图地址过长', 422)
  if (images.some((item) => item.length > 20_000) || video.length > 20_000 || videos.some((item) => item.length > 20_000) || audios.some((item) => item.length > 20_000)) throw failure('参考素材地址过长', 422)
  if (mode === 'text' && (referenceImageCount || videos.length || audios.length || referenceVoices.length || (keyframes.length && model.id !== 'grok-imagine-video-1.5'))) throw failure('文生视频模式不能带参考素材', 422)
  if (mode === 'singleImage' && (referenceImageCount !== 1 || videos.length || audios.length || frameEntries.length || keyframes.length)) throw failure('单图生视频需要且只能输入一张图片', 422)
  if (isFrameMode(mode) && (!referenceImageCount || videos.length || audios.length)) throw failure('首尾帧模式需要图片且不能混入视频或音频', 422)
  // 方舟官方把「图生视频-首帧」「图生视频-首尾帧」「全模态参考生视频」定义为三种互斥场景，明确不可混用：
  // 首尾帧不能再带额外参考图，参考模式里也不能再出现首尾帧字段。官方给的替代做法是
  // 在参考模式的描述里点名哪张参考图当首帧，所以这里直接拦住而不是悄悄丢掉素材。
  if (model.provider === 'ark' || model.provider === 'suihe') {
    if ((model.provider === 'suihe' || isSeedance25(model)) && lastFrame && !firstFrame) throw failure('首尾帧模式需要首帧，请补充首帧图片', 422)
    if (isFrameMode(mode) && images.length) throw failure('首尾帧模式不能同时带参考图；要用参考图请换成混合参考模式，并在描述里指定首帧', 422)
    if (mode === 'image' && frameEntries.length) throw failure('混合参考模式不能再指定首尾帧，请在描述里说明哪张参考图当首帧', 422)
  }
  // 秘塔自己的产品把这条规则分开：**只有 MiniMax H3 支持「首尾帧 + 参考图」混合**
  // （它有一个专门的 mixed-reference 模式，请求体同时带 first_frame、last_frame 和 reference_image），
  // Seedance 两个模型会直接报「当前模型不支持首尾帧与参考图混用，请切换 MiniMax H3」。
  // 另外 H3 的混用只允许参考**图片**：带参考视频或音频时官方要求先移除。
  if (model.provider === 'metaso') {
    const mixingFramesAndImages = (isFrameMode(mode) && images.length) || (mode === 'image' && frameEntries.length)
    if (isSeedance20(model) && mixingFramesAndImages) throw failure('首尾帧与参考图只能二选一：Seedance 不支持混用，请切换到 MiniMax H3，或去掉其中一种', 422)
    if (!isSeedance20(model) && frameEntries.length && (videos.length || audios.length)) {
      throw failure('H3 的首尾帧只能与参考图片混用，请先移除参考视频和音频', 422)
    }
  }
  // 多模态参考模式允许图片、视频、音频组合；Seedance 2.0 系列不支持单独音频。
  if (mode === 'image' && !(referenceImageCount || videos.length || audios.length || referenceVoices.length || keyframes.length)) throw failure('混合参考模式至少需要一个参考素材', 422)
  if (mode === 'image' && model.parameterRules?.requireVisualInMixed && !referenceImageCount && !videos.length) throw failure('当前模型不能只输入音频参考，请添加图片或视频', 422)
  if (mode === 'image' && isSeedance20(model) && !referenceImageCount && !videos.length) throw failure('Seedance 2.0 系列不能只输入音频参考', 422)
  if ((mode === 'edit' || mode === 'extend') && !video) throw failure('视频编辑或扩展需要输入视频地址', 422)
  if ((mode === 'edit' || mode === 'extend') && keyframes.length) throw failure('视频编辑或延长不能混用 keyframes', 422)
  if ((mode === 'edit' || mode === 'extend') && model.provider === 'grok' && (referenceImageCount || audios.length)) throw failure('Grok 编辑或延长只接受视频输入', 422)
  // xAI 编辑会继承输入视频的时长（上限 8.7 秒）；延长的 duration
  // 只代表新增片段，原视频必须在 2–15 秒内。不能用普通生成秒数
  // 代替输入视频真实时长，否则会少扣上游实际成本。
  if (mode === 'extend' && model.provider === 'grok' && (duration === undefined || duration < 2 || duration > 10)) throw failure('Grok 视频延长只支持 2–10 秒', 422)
  let ratio = String(payload.ratio || '').trim()
  const allowedRatios = Array.isArray(model.ratios) ? model.ratios : []
  if (ratio && allowedRatios.length && !allowedRatios.includes(ratio)) {
    throw failure(`当前模型不支持比例 ${ratio}，可选：${allowedRatios.join('、')}`, 422)
  }
  // 秘塔自家前端（metaso.cn/minimax-h3）的规则：纯文生视频选「自适应」时改发 16:9；
  // Seedance 带首尾帧固定 adaptive；H3 带首尾帧照用所选比例；参考模式原样保留。
  // 按同样的规则纠正而不是拒绝，旧版客户端存下的参数也照常能用。
  if (model.provider === 'metaso') {
    const framed = isFrameMode(mode) || mode === 'singleImage' || frameEntries.length > 0
    if (mode === 'text' && (!ratio || ratio === 'adaptive')) ratio = '16:9'
    else if (framed && isSeedance20(model)) ratio = 'adaptive'
    else if (!ratio) ratio = 'adaptive'
  }
  const modeRatios = model.parameterRules?.ratiosByMode?.[mode]
  if (Array.isArray(modeRatios) && modeRatios.length && ratio && !modeRatios.includes(ratio)) {
    throw failure(`当前模式不支持比例 ${ratio}，可选：${modeRatios.join('、')}`, 422)
  }
  // Seedance 2.5 的首帧、首尾帧、单图、编辑和延长只接受 adaptive。
  // 用户选了别的比例就停下，不改成 adaptive。没填时才补上这一个合法值。
  if (isSeedance25(model) && (isFrameMode(mode) || mode === 'singleImage' || mode === 'edit' || mode === 'extend') && (referenceImageCount || videos.length)) {
    if (ratio && ratio !== 'adaptive') throw failure('当前模式只接受自适应比例', 422)
    ratio = 'adaptive'
  }
  if (isSeedance20(model) && videos.length && Number(payload.videoSeconds) > 15) throw failure('Seedance 2.0 系列参考视频总时长不能超过 15 秒', 422)
  if (isSeedance25(model) && videos.length && Number(payload.videoSeconds) > 30) throw failure('Seedance 2.5 参考视频总时长不能超过 30 秒', 422)
  if (isSeedance25(model) && audios.length && Number(payload.audioSeconds) > 30) throw failure('Seedance 2.5 参考音频总时长不能超过 30 秒', 422)
  // 方舟 2.0 fast 带参考时没有 1080p。Grok 1.5 的单图生视频可以 1080p；
  // 参考图、尾帧或关键帧属于参考生视频，官方最高 720p。
  const grokReferenceCapped = model.id === 'grok-imagine-video-1.5' && (mode === 'image' || keyframes.length > 0 || Boolean(lastFrame))
  if (resolution === '1080p' && ((model.provider === 'ark' && !isSeedance25(model) && (referenceImageCount || keyframes.length)) || grokReferenceCapped)) {
    throw failure('带参考图、尾帧或关键帧时最高支持 720p', 422)
  }
  if ((firstFrame || lastFrame) && (limits.frames ?? 0) <= 0) throw failure('当前模型不支持首尾帧', 422)
  let generateAudio = payload.generateAudio === undefined || payload.generateAudio === '' ? undefined : Boolean(payload.generateAudio)
  if (generateAudio === true && !(model.audio === 'optional' || model.audio === true)) throw failure('当前模型不支持生成声音', 422)
  if (generateAudio === false && model.audio === true) throw failure('当前模型不能关闭声音', 422)
  if (generateAudio !== undefined && model.audio !== 'optional' && model.audio !== true) generateAudio = undefined
  // 火山方舟和穗禾兼容通道都使用这组 Seedance 参数：seed、camera_fixed、
  // return_last_frame、tools(web_search)。Seedance 2.0 / fast 不接受 frames，
  // 已在上方按实际模型能力拦截。
  const volcCompatibleProvider = model.provider === 'ark' || model.provider === 'suihe'
  const seed = payload.seed === undefined || payload.seed === '' ? undefined : Math.floor(Number(payload.seed))
  if (seed !== undefined && (!Number.isInteger(seed) || seed < -1 || seed > 2147483647)) throw failure('随机种子无效', 422)
  const cameraFixed = payload.cameraFixed === undefined ? undefined : Boolean(payload.cameraFixed)
  const returnLastFrame = payload.returnLastFrame === undefined ? undefined : Boolean(payload.returnLastFrame)
  if (seed !== undefined || cameraFixed !== undefined) {
    if (!volcCompatibleProvider) throw failure('当前模型不支持 seed 或 camera_fixed 参数', 422)
    // 火山原生接口的旧限制继续保留；穗禾指南明确将这些字段作为
    // 兼容参数接收，不能沿用旧 provider 的本地拒绝规则。
    if (model.provider === 'ark' && (isSeedance20(model) || isSeedance25(model))) throw failure('当前模型不支持 seed 或 camera_fixed 参数', 422)
  }
  if (model.provider === 'suihe' && cameraFixed === true && model.publicId !== 'seedance-2.0-mini' && model.id !== 'seedance-2.0-mini') throw failure('当前模型不支持固定镜头', 422)
  if (returnLastFrame !== undefined && !volcCompatibleProvider) throw failure('当前模型不支持 return_last_frame 参数', 422)
  const webSearch = payload.webSearch === true || (Array.isArray(payload.tools) && payload.tools.some((tool) => String(tool?.type || '') === 'web_search'))
  if (webSearch) {
    if (model.provider !== 'ark') throw failure('当前模型不支持联网搜索', 422)
    if (image || images.length || videos.length || audios.length || firstFrame || lastFrame || keyframes.length) throw failure('联网搜索只支持纯文本输入', 422)
  }
  // 秘塔 H3 的提示词优化（Context IR）默认开启、按次计费；「原样使用提示词」时关闭。
  // 其他模型没有这一项，收到也忽略。
  // 排队任务会用存下的 parameters（contextIr:false）重新校验一次，两种写法都认。
  const contextIr = model.id === 'MiniMax-H3' ? !(payload.rawPrompt === true || payload.contextIr === false) : undefined
  const arkOptions = volcCompatibleProvider ? {
    ...(isSeedance25(model) && ['image','edit','extend'].includes(mode) ? { omni_reference_task_type: mode === 'image' ? 'reference' : mode } : {}),
    ...(isSeedance25(model) && mode === 'edit' ? { duration:-1 } : {}),
    ...(rawFrames !== undefined ? { frames: rawFrames } : {}),
    ...(seed !== undefined ? { seed } : {}),
    ...(cameraFixed !== undefined ? { camera_fixed: cameraFixed } : {}),
    ...(returnLastFrame !== undefined ? { return_last_frame: returnLastFrame } : {}),
    ...(webSearch ? { tools: [{ type: 'web_search' }] } : {}),
  } : {}
  // 参考视频按上游实际输入时长计费：客户端在浏览器里测量并上报，缺失时拒绝计费请求，
  // 避免把视频参考错误当成免费素材；数值上限 1 小时，避免异常输入放大预扣。
  const rawVideoSeconds = Number(payload.videoSeconds)
  const videoSeconds = Number.isFinite(rawVideoSeconds) && rawVideoSeconds > 0 ? Math.min(3_600, Math.round(rawVideoSeconds * 1000) / 1000) : 0
  const pricing = VIDEO_INPUT_PRICING[model.publicId || model.id] || {}
  if (videos.length && pricing.billReferenceVideoSeconds && videoSeconds <= 0) throw failure('参考视频需要提供实际时长（秒）', 422)
  if (model.provider === 'grok' && mode === 'edit' && videoSeconds > 8.7) throw failure('Grok 视频编辑输入最长 8.7 秒', 422)
  if (model.provider === 'grok' && mode === 'extend' && (videoSeconds < 2 || videoSeconds > 15)) throw failure('Grok 视频延长输入必须为 2–15 秒', 422)
  // 编辑输出继承输入视频时长；续写只按新增片段计输出，输入视频
  // 另按真实秒数计入成本。官方编辑/续写输出最高 720p。
  const longestDuration = allowedDurations ? Math.max(...allowedDurations.filter((item) => item > 0)) : duration
  // -1 的成片秒数要等生成结束才知道。预扣按该型号最长秒数，结算再按实际用量退差。
  const billableDuration = isSeedance25(model) && mode === 'edit'
    ? Number(payload.editVideoSeconds || videoSeconds)
    : model.provider === 'grok' && mode === 'edit'
    ? videoSeconds
    : hasFrames ? frameDuration : duration === -1 ? longestDuration : duration
  const billingResolution = model.provider === 'grok' && (mode === 'edit' || mode === 'extend')
    ? '720p'
    : resolution
  const billableReferenceImages = referenceImageCount + keyframes.length
  const videoPricing = isCostPlusVideo(model.publicId || model.id) ? videoPricingSnapshot() : undefined
  const cost = estimateVideoCost(model, { duration, billableDuration, resolution: billingResolution, ratio, videoSeconds, audioSeconds: Number(payload.audioSeconds)||0, generateAudio, referenceImages: billableReferenceImages, contextIr, videoPricing })
  return {
    model, prompt, mode, duration, billableDuration, resolution, ratio, image, images, videos, video, audios, referenceVoices, firstFrame, lastFrame, keyframes, generateAudio, creativeMode, contextIr, cost, arkOptions,
    // 服务端落盘要用这次请求的节点目录；只保留安全的相对路径。
    parameters: { ...(videoPricing ? {videoPricing} : {}), upstreamProvider:model.provider, ...(model.provider==='suihe'?{suiheCost:suihePricingSnapshot(model,{resolution,creativeMode})}:{}), referenceHistory: normalizeReferenceHistory(payload.referenceHistory), outputDirectory: safeOutputDirectory(payload.outputDirectory), mode, duration, billableDuration, resolution, ratio: ratio || null, image: image || null, images, videos, video: video || null, audios, referenceVoices, firstFrame: firstFrame || null, lastFrame: lastFrame || null, keyframes, generateAudio, creativeMode: creativeMode || null, videoSeconds, audioSeconds:Number(payload.audioSeconds)||0, referenceImages: billableReferenceImages, frames: rawFrames ?? null, seed: seed ?? null, cameraFixed: cameraFixed ?? null, returnLastFrame: returnLastFrame ?? null, webSearch, ...(contextIr === false ? { contextIr } : {}) },
  }
}

function upstreamError(response, data) {
  const raw = String(data?.error?.message || data?.error || data?.message || `视频上游请求失败（${response.status}）`).slice(0, 500)
  const upstreamCode = String(data?.error?.code || data?.error?.type || data?.code || '').slice(0, 100)
  // 没有符合资格的媒体账号可能是路由或资格过滤，不能据此断言额度用尽。
  const message = upstreamCode === 'grok_media_no_eligible_account' || /No eligible Grok media accounts/i.test(raw)
    ? 'Grok 视频通道暂无可用账号，请稍后重试或联系妙图团队'
    : raw
  return Object.assign(new Error(message), { status: response.ok ? 502 : response.status >= 500 ? 502 : 422, upstreamStatus: response.status, upstreamCode, upstreamMessage: raw, upstreamRequestId: String(data?.request_id || data?.requestId || response.headers.get('x-request-id') || '') })
}

async function responseData(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : {} } catch { return { raw: text.slice(0, 1000) } }
}

function progressValue(data) {
  const raw = data?.progress ?? data?.percent ?? data?.percentage ?? data?.video?.progress
  if (raw === null || raw === undefined || !['number', 'string'].includes(typeof raw) || !String(raw).replace('%', '').trim()) return null
  const value = Number(String(raw).replace('%', ''))
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}

function taskId(data) { return String(data?.id || data?.request_id || data?.requestId || data?.task_id || data?.taskId || data?.video?.id || '').trim() }
function taskStatus(data) { return String(data?.status || data?.state || '').toLowerCase() }
function videoUrl(data) { return String(data?.video_url || data?.videoUrl || data?.url || data?.video?.url || data?.output?.url || data?.data?.video?.url || '').trim() }

function referenceProviderRequest(request, userId, materializeReference, { inlineArkImages = false }: Record<string, any> = {}) {
  if (!materializeReference) return Promise.resolve(request)
  // Ark prefers the existing signed asset URL: multi-megabyte Base64 bodies
  // can stall the task-create upload. Inline only after an explicit reference
  // fetch rejection; keep MetaSo's inline delivery and Grok's URL contract.
  // Suihe accepts multipart references, so inline small workspace images and
  // let createSuiheTask decode the original bytes instead of making the
  // provider depend on a public callback URL.
  const inlineImages = request.model.provider === 'metaso' || request.model.provider === 'suihe' || (request.model.provider === 'ark' && inlineArkImages)
  const delivery = new Map()
  const converted = new Map()
  const convert = (value, kind, inline = inlineImages) => {
    if (!value) return Promise.resolve(value)
    const key = JSON.stringify([value, kind, inline])
    if (converted.has(key)) return converted.get(key)
    const promise = Promise.resolve(materializeReference(value, userId, { kind, inline })).then((item) => {
      // Keep byte metadata in memory for diagnostics only.  The Map is never
      // serialized into the provider body or upstream_calls.
      if (item?.value) delivery.set(item.value, { mime: item.mime, bytes: item.bytes, source: item.source, inline: item.inline })
      return item.value
    })
    converted.set(key, promise)
    return promise
  }
  return Promise.all([
    convert(request.image, 'image'),
    Promise.all((request.images || []).map((value) => convert(value, 'image'))),
    Promise.all((request.videos || []).map((value) => convert(value, 'video'))),
    Promise.all((request.audios || []).map((value) => convert(value, 'audio'))),
    convert(request.video, 'video'),
    convert(request.firstFrame, 'image'),
    convert(request.lastFrame, 'image'),
    Promise.all((request.keyframes || []).map(async (item) => ({ ...item, image: { ...(item.image || {}), url: await convert(item.image?.url || item.url, 'image') } }))),
  ]).then(([image, images, videos, audios, video, firstFrame, lastFrame, keyframes]) => ({ ...request, image, images, videos, audios, video, firstFrame, lastFrame, keyframes, _referenceDelivery: delivery }))
}

function referenceDiagnostics(request) {
  const imageValues = [request.image, ...(request.images || []), request.firstFrame, request.lastFrame, ...(request.keyframes || []).map((item) => item.image?.url || item.url)].filter(Boolean)
  const delivery = request?._referenceDelivery instanceof Map ? request._referenceDelivery : null
  const summarize = (value) => summarizeReferenceValue(value, delivery?.get(value) || {})
  return {
    images: imageValues.map(summarize),
    videos: [request.video, ...(request.videos || [])].filter(Boolean).map(summarize),
    audios: (request.audios || []).filter(Boolean).map(summarize),
  }
}

function upstreamRequestIdFromError(error) {
  return String(error?.upstreamRequestId || '').trim()
    || (/(?:request[ _-]*id|请求\s*id)\s*[:：=]\s*([A-Za-z0-9_-]+)/i.exec(String(error?.message || ''))?.[1] || '')
}

function isReferenceFetchFailure(error) {
  return /timeout\s+while\s+fetching\s+resource|timed?\s*out.*(?:fetch|resource)|(?:fetch|retrieve|download).*reference|reference.*(?:url|resource).*invalid|invalid\s+url\s+specified/i.test(String(error?.message || ''))
}

function errorWithUpstreamId(error, request, attempts = 1) {
  const id = upstreamRequestIdFromError(error)
  const base = String(error?.message || '视频上游请求失败')
  const retryHint = isReferenceFetchFailure(error) && attempts > 1 ? `参考素材读取失败，已自动重试 ${attempts - 1} 次（共 ${attempts} 次尝试），请点击重试` : ''
  const withHint = retryHint ? `${retryHint}：${base}` : base
  const message = id && !withHint.includes(id) ? `${withHint}（上游 Request id: ${id}）` : withHint
  const diagnostic = `参考素材=${JSON.stringify(referenceDiagnostics(request))}`
  return { id, message, diagnostic, errorText: `${message}；${diagnostic}`.slice(0, 500) }
}

function storedReferenceDiagnostics(management, generationId) {
  try {
    const stored = management.loadGeneration(generationId)
    const parameters = stored?.parameters || {}
    return referenceDiagnostics(parameters)
  } catch {
    return { images: [], videos: [], audios: [] }
  }
}

export async function createSub2ApiVideo(request, { env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = videoSettings(env, request.model)
  const editing = request.mode === 'edit'
  const extending = request.mode === 'extend'
  const images = Array.isArray(request.images) ? request.images : []
  const body: Record<string, any> = { model: request.model.id }
  if (request.prompt) body.prompt = request.prompt
  // xAI's edit endpoint inherits duration/aspect ratio/resolution from the
  // input video; extension uses duration only. Generation uses the official
  // aspect_ratio field rather than the old internal `ratio` spelling.
  if (!editing && request.duration !== undefined) body.duration = request.duration
  if (!editing && request.generateAudio !== undefined) body.generate_audio = Boolean(request.generateAudio)
  if (!editing && !extending) {
    if (request.resolution) body.resolution = request.resolution
    if (request.ratio) body.aspect_ratio = request.ratio
  }
  // With several references, xAI expects every image in reference_images and
  // no duplicated pinned image. A single image is the image-to-video input.
  const pinnedImage = request.firstFrame
    || (request.image && request.mode === 'singleImage' ? request.image : '')
    // `mode=image` is the mixed reference mode. Even when it contains one
    // image, keep it in reference_images; only singleImage/frame modes pin it
    // as the opening frame.
    || (request.mode !== 'image' && images.length <= 1 ? images[0] : '')
  if (pinnedImage) body.image = { url: pinnedImage }
  // Signed URLs for image and images[0] may differ despite the same source.
  // Single-image mode must never send a duplicate reference_images field.
  const references = request.mode === 'singleImage' ? [] : images.filter((url) => url && url !== pinnedImage)
  if (references.length) body.reference_images = references.map((url) => ({ url }))
  if (request.lastFrame) body.last_frame = { url: request.lastFrame }
  if (Array.isArray(request.keyframes) && request.keyframes.length) body.keyframes = request.keyframes
  if (Array.isArray(request.referenceVoices) && request.referenceVoices.length) {
    body.reference_audios = request.referenceVoices.map((voice_id) => ({ voice_id }))
  }
  if (request.video) body.video = { url: request.video }
  const path = request.mode === 'edit' ? '/v1/videos/edits' : request.mode === 'extend' ? '/v1/videos/extensions' : '/v1/videos/generations'
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  const data = await responseData(response)
  if (!response.ok || data?.error) throw upstreamError(response, data)
  const id = taskId(data)
  if (!id) throw Object.assign(new Error('视频提交回执不完整，请先核对原任务'), { status: 502, upstreamStatus: response.status, submissionUncertain: true })
  return { id, status: taskStatus(data) || 'queued', upstreamModel: String(data.model || request.model.id), upstreamRequestId: String(data.request_id || data.requestId || id), upstreamStatus: response.status, raw: data, sentPath: path, sentBody: body }
}

export async function pollSub2ApiVideo(taskIdValue, { env = process.env, model, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const id = String(taskIdValue || '').trim()
  if (!id || id.length > 200) throw failure('视频任务标识无效', 422)
  const config = videoSettings(env, model)
  let response
  try {
    response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/videos/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${config.apiKey}` }, signal })
  } catch (error) {
    if (error instanceof ProviderRedirectError) throw error
    throw Object.assign(new Error(`视频状态查询失败：${error?.cause?.message || error?.message || '网络请求失败'}`), { status: 502, transient: true })
  }
  const data = await responseData(response)
  if (!response.ok) throw upstreamError(response, data)
  const status = taskStatus(data)
  const completed = ['succeeded', 'completed', 'complete', 'success', 'done'].includes(status)
  // A completed xAI task can be filtered instead of yielding a usable video.
  // Only an explicit rejection is terminal; missing output alone keeps polling.
  const moderationFailed = completed && data?.video?.respect_moderation === false
  const failed = moderationFailed || ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(status)
  const rawUrl = videoUrl(data)
  let url = moderationFailed ? '' : rawUrl
  if (!moderationFailed && rawUrl.startsWith('/')) {
    const target = new URL(rawUrl, config.baseUrl)
    if (target.origin !== new URL(config.baseUrl).origin || target.pathname !== `/v1/videos/${encodeURIComponent(id)}/content`) throw failure('视频结果校验失败，请重试', 502)
    url = target.toString()
  }
  const succeeded = completed && !failed && Boolean(url)
  return { id, status: failed ? 'failed' : succeeded ? 'succeeded' : completed ? 'running' : status || 'running', progress: progressValue(data), url, mime: String(data.mime || data.content_type || 'video/mp4'), duration: data.video?.duration ?? data.duration ?? data.seconds ?? null, width: data.video?.width ?? data.width ?? null, height: data.video?.height ?? data.height ?? null, thumbnailUrl: data.thumbnail_url || data.thumbnailUrl || '', usage: data.usage || null, error: data.error?.message || data.error || (moderationFailed ? '视频未通过内容审核，请调整内容后重新提交' : data.message || ''), upstreamModel: String(data.model || ''), upstreamRequestId: String(data.request_id || data.requestId || response.headers.get('x-request-id') || id), upstreamStatus: response.status, metadata: { status, raw: data } }
}

function identity(payload: Record<string, any> = {}) {
  const requestId = String(payload.requestId || '').trim()
  const idempotencyKey = String(payload.idempotencyKey || requestId || '').trim()
  if (requestId && !validRequestId(requestId)) throw failure('请求标识无效', 422)
  if (idempotencyKey && !validIdempotencyKey(idempotencyKey)) throw failure('请求标识无效', 422)
  return { requestId: requestId || newRequestId(), idempotencyKey: idempotencyKey || newRequestId() }
}

/**
 * 校验 + 用服务端 ffprobe 读取参考素材真实时长，产出这次请求的最终参数与积分。
 * 预览用（estimateVideoCredits）和真正下单（createVideo）都走这一条，
 * 保证「界面上显示的积分」和「请求时预扣的积分」是同一个数字。
 */
export async function prepareVideoRequest(payload, session, { env = process.env, probeReferenceMedia, signal }: Record<string, any> = {}) {
  signal?.throwIfAborted()
  const modelForProbe = modelById(String(payload.model || '').trim())
  const needsMediaProbe = Boolean(probeReferenceMedia && (payload.video || (Array.isArray(payload.videos) && payload.videos.length) || (Array.isArray(payload.audios) && payload.audios.length)))
  // 先校验模型、模式和其它字段；输入媒体的秒数随后由服务器读取，
  // 因而这里使用只用于通过结构校验的下限占位值，绝不进入 reserve。
  const validationPayload = needsMediaProbe
    ? { ...payload, audioSeconds:0, videoSeconds: String(payload.mode || '') === 'extend' && modelForProbe?.provider === 'grok' ? 2 : 1 }
    : { ...payload, audioSeconds:0 }
  let request = validateVideoRequest(validationPayload, env)
  // 云枢 Classic 的 image 首帧路径实测沿用输入比例；reference_images
  // 可按所选比例生成。保留首帧语义，不静默改参考模式或裁切用户素材。
  if (request.model.id === 'grok-imagine-video' && request.mode === 'singleImage' && request.ratio) {
    if (!probeReferenceMedia) throw failure('参考图比例校验服务不可用，已阻止生成', 503)
    const source = await probeReferenceMedia(request.image || request.images[0], session?.userId, 'image', { signal })
    signal?.throwIfAborted()
    const [width, height] = request.ratio.split(':').map(Number)
    if (!(source?.width > 0 && source?.height > 0)) throw failure('无法读取参考图尺寸，已阻止生成', 422)
    if (Math.abs((source.width / source.height) / (width / height) - 1) > 0.03) {
      throw failure(`当前普通 Grok 单图通道会沿用参考图比例（${source.width}×${source.height}），与所选 ${request.ratio} 不一致；请切换“混合参考”，或使用同比例参考图`, 422)
    }
  }
  const imageUrls = uniqueUrls([request.image, ...request.images, request.firstFrame, request.lastFrame, ...request.keyframes.map(item => item.image.url)]).filter(url => !isSuiheLibraryReference(url))
  const needsImageValidation = Object.keys(referenceInputPolicy(request.model, 'image')).length > 0
  if ((needsImageValidation && imageUrls.length || request.videos.length || request.audios.length) && !probeReferenceMedia) throw failure('参考素材校验服务不可用，已阻止生成', 503)
  // Each probe is cached by the authenticated file revision. Run independent
  // media probes together so mixed-reference estimates do not pay one serial
  // ffprobe round trip per file; the probe pool still caps actual processes.
  const probes = new AbortController()
  const probeSignal = signal ? AbortSignal.any([signal, probes.signal]) : probes.signal
  const probe = async (url, kind) => {
    try {
      probeSignal.throwIfAborted()
      const metadata = await probeReferenceMedia(url, session?.userId, kind, { signal: probeSignal })
      probeSignal.throwIfAborted()
      assertReferenceInput(request.model, kind, metadata, request.mode)
      if (kind === 'video' && isSeedance25(request.model) && request.mode === 'edit' && metadata.duration < 4) throw failure('Seedance 2.5 编辑视频需要 4–30 秒的参考视频', 422)
      return metadata
    } catch (error) { probes.abort(error); throw error }
  }
  const imageJobs = (needsImageValidation ? imageUrls : []).map(url => probe(url, 'image'))
  const videoJobs = request.videos.map(url => probe(url, 'video'))
  const audioJobs = request.audios.map(url => probe(url, 'audio'))
  // Join every admitted probe, including sibling process/temp-file cleanup
  // after a validation failure or caller cancellation. Promise.all on arrays
  // returns unresolved metadata promises and misses their later rejections.
  const settled = await Promise.allSettled([...imageJobs, ...videoJobs, ...audioJobs])
  probeSignal.throwIfAborted()
  const metadata = settled.map(result => {
    if (result.status === 'rejected') throw result.reason
    return result.value
  })
  const imageMetadata = metadata.slice(0, imageJobs.length)
  const videoMetadata = metadata.slice(imageJobs.length, imageJobs.length + videoJobs.length)
  const audioMetadata = metadata.slice(imageJobs.length + videoJobs.length)
  request.parameters.imageMetadata = imageMetadata
  if (request.videos.length || request.audios.length) {
    if (request.model.provider === 'grok' && videoMetadata.some(item => !String(item.format || '').split(',').includes('mp4'))) throw failure('Grok 视频编辑或延长需要 MP4 格式输入', 422)
    const videoSeconds = videoMetadata.reduce((sum, item) => sum + item.duration, 0)
    const audioSeconds = audioMetadata.reduce((sum, item) => sum + item.duration, 0)
    if (isSeedance20(request.model) && audioSeconds > 15) throw failure('Seedance 2.0 系列参考音频总时长不能超过 15 秒', 422)
    // 以服务器工作区里的真实媒体元数据重新校验和计费，忽略客户端上报的秒数。
    // 这一步在 reserve 之前，不扣积分、不调用上游；预览与下单共用同一条路径，
    // 所以画布上显示的积分就是下单时预扣的积分。
    request = validateVideoRequest({ ...payload, videoSeconds, audioSeconds, editVideoSeconds: isSeedance25(request.model) && request.mode === 'edit' ? Math.max(...videoMetadata.map(item => item.duration)) : undefined }, env)
    request.parameters.imageMetadata = imageMetadata
    request.parameters.videoMetadata = videoMetadata
    request.parameters.audioMetadata = audioMetadata
    request.parameters.audioSeconds = audioSeconds
  }
  if(request.model.provider==='suihe') {
    signal?.throwIfAborted()
    const quote=await estimateSuiheVideo(request,{env})
    signal?.throwIfAborted()
    const generationSnapshot=suihePricingSnapshot(request.model,{resolution:quote.generationResolution,creativeMode:quote.creativeMode})
    request.parameters.suiheCost={...request.parameters.suiheCost,preEstimate:{...quote,
      generationRates:'rates' in generationSnapshot?generationSnapshot.rates:undefined,
      generationPixels:'pixels' in generationSnapshot?generationSnapshot.pixels:undefined}}
    request.cost=estimateVideoCost(request.model,request.parameters)
  }
  return request
}

/** 只算积分、不占额不下单：给画布显示「这次请求会扣多少」。 */
function routeNewVideo(payload, management, env) {
  const settings = management.settings()
  const model = activeModelForSettings(payload.model, settings, env)
  if (!model?.video || model.internalOnly || settings.models?.[model.publicId || model.id] === false) throw failure('当前视频模型未开放', 403)
  // The server owns routing. Never trust channel markers from the caller.
  return { ...payload, __provider: model.provider, upstreamProvider: model.provider }
}

export async function estimateVideoCredits(payload, session, { management, env = process.env, probeReferenceMedia, signal }: Record<string, any> = {}) {
  if (!session) throw failure('请先登录再查看积分', 401)
  if (management) payload = routeNewVideo(payload, management, env)
  const request = await prepareVideoRequest(payload, session, { env, probeReferenceMedia, signal })
  return {
    model: request.model.publicId || request.model.id,
    points: request.cost.points,
    breakdown: request.cost.breakdown,
    duration: request.billableDuration ?? request.duration,
    resolution: request.resolution || '',
  }
}

export async function createVideo(payload, session, { management, env = process.env, probeReferenceMedia, preparePayload, signal }: Record<string, any> = {}) {
  if (!management) throw failure('视频处理器缺少 ManagementStore', 500)
  if (!session) throw failure('请先登录再生成', 401)
  const ids = identity(payload)
  const existing = management.existingGeneration({ session, requestId: ids.requestId, idempotencyKey: ids.idempotencyKey, accessToken: payload.accessToken })
  if (existing) {
    const current = management.generationForViewer(existing.requestId, session, existing.accessToken || payload.accessToken)
    if (!current) throw failure('生成记录不存在', 404)
    return generationReceipt(current, { taskId: existing.upstreamRequestId || null, accessToken: existing.accessToken || undefined, duplicate: true })
  }
  // A replay may outlive its input lease, model settings or reference files.
  // Only a genuinely new task prepares inputs and checks new-order policy.
  assertModelAccess({ management, session, service: '视频模型' })
  if (preparePayload) payload = preparePayload(payload)
  if (!management.settings().videoEnabled) throw failure('管理员尚未开启视频生成', 503)
  payload = routeNewVideo(payload, management, env)
  const request = await prepareVideoRequest(payload, session, { env, probeReferenceMedia, signal })
  request.parameters.workspaceProject = currentProject() || DEFAULT_PROJECT_ID
  request.parameters.referenceVideoCount = request.parameters.videos.length
  request.parameters.referenceAudioCount = request.parameters.audios.length
  if (payload.desktopDelivery === 1) Object.assign(request.parameters, { desktopDelivery: 1, desktopReferences: payload.desktopReferences })
  signal?.throwIfAborted()
  const reservation = management.reserve({ session, model: request.model, points: request.cost.points, prompt: request.prompt, parameters: request.parameters, requestId: ids.requestId, idempotencyKey: ids.idempotencyKey, status: GENERATION_STATES.QUEUED, inputs: {}, accessToken: payload.accessToken })
  const current = management.generationForViewer(reservation.requestId, session, reservation.accessToken || payload.accessToken)
  if (!current) throw failure('生成记录不存在', 404)
  return generationReceipt(current, { accessToken: reservation.accessToken || undefined, duplicate: Boolean(reservation.duplicate), ...(!reservation.duplicate ? { cost: request.cost } : {}) })
}

export async function submitQueuedVideo(job, { management, env = process.env, fetchImpl = fetch, signal, materializeReference }: Record<string, any> = {}) {
  // Stored parameters were validated and media durations probed before reserve.
  // Remove absent optional values rather than turning null into seed=0/frames=0.
  const parameters = Object.fromEntries(Object.entries(job.parameters || {}).filter(([, value]) => value !== null))
  const request = validateVideoRequest({ ...parameters, model: job.model, prompt: job.prompt, __provider: job.provider }, env)
  if (parameters.videoPricing && isCostPlusVideo(job.model)) request.parameters.videoPricing = parameters.videoPricing
  signal?.throwIfAborted()
  if (!management.heartbeat(job.id, job.lease_id)) throw failure('生成已取消或已结算', 409)
  // 秘塔余额差只作共享账号窗口观察，不能直接归为本单实扣。
  const balanceBefore = request.model.provider === 'metaso' ? await metasoCreditsBalance({ env, fetchImpl }) : null
  let task
  let lastError
  let lastUpstreamRequest = request
  let attempts = 0
  const dispatchFetch: typeof fetch = (input, init) => {
    signal?.throwIfAborted()
    management.assertGenerationDispatch(job.id, job.lease_id, { markStarted: true })
    return fetchImpl(input, init)
  }
  for (let attempt = 0; attempt <= REFERENCE_RETRY_DELAYS_MS.length; attempt += 1) {
    attempts = attempt + 1
    signal?.throwIfAborted()
    try {
      // Re-read the signed workspace reference on every attempt.  This both
      // refreshes its TTL and ensures a transient provider fetch timeout never
      // reuses the URL that just failed.
      const upstreamRequest = await referenceProviderRequest(request, job.user_id, materializeReference, { inlineArkImages: attempt > 0 })
      lastUpstreamRequest = upstreamRequest
      signal?.throwIfAborted()
      task = request.model.provider === 'suihe'
        ? await createSuiheTask(upstreamRequest, { env, fetchImpl: dispatchFetch, signal })
        : request.model.provider === 'ark'
        ? await createArkVideoTask(upstreamRequest, { env, fetchImpl: dispatchFetch, signal })
        : request.model.provider === 'metaso'
        ? await createMetasoVideoTask(upstreamRequest, { env, fetchImpl: dispatchFetch, signal })
        : await createSub2ApiVideo(upstreamRequest, { env, fetchImpl: dispatchFetch, signal })
      break
    } catch (error) {
      lastError = error
      const canRetry = Boolean(materializeReference) && Number(error?.upstreamStatus) >= 400 && Number(error?.upstreamStatus) < 500 && isReferenceFetchFailure(error) && attempt < REFERENCE_RETRY_DELAYS_MS.length
      if (!canRetry) break
      await new Promise <void>((resolve) => setTimeout(resolve, REFERENCE_RETRY_DELAYS_MS[attempt]))
    }
  }
  if (!task) {
    const details = errorWithUpstreamId(lastError, lastUpstreamRequest, attempts)
    const failed = Object.assign(lastError || new Error(details.message), { message: details.message, upstreamRequestId: details.id || lastError?.upstreamRequestId || '' })
    try {
      management.recordUpstreamCall({
        generationId: job.id,
        provider: request.model.provider,
        model: job.model,
        kind: 'video',
        tier: request.resolution || '',
        seconds: Number(request.billableDuration ?? request.duration) || null,
        hasInputVideo: Boolean(Number(request.parameters?.videoSeconds) > 0 || request.parameters?.video || (request.parameters?.videos || []).length),
        request: { ...(lastError?.sentRequest || {}), references: referenceDiagnostics(lastUpstreamRequest), retries: attempts },
        response: lastError?.upstreamStatus ? { status: lastError.upstreamStatus, error: { code: lastError.upstreamCode || '', message: lastError.upstreamMessage || lastError.message } } : null,
        upstreamRequestId: details.id,
        status: lastError?.upstreamStatus >= 400 && lastError?.upstreamStatus < 500 ? 'rejected' : 'failed',
        error: details.errorText,
      })
    } catch { /* 留档失败不能覆盖真正的上游错误。 */ }
    throw failed
  }
  // Provider acceptance ends the creation/retry phase. Every later error owns
  // this task, including a failure to persist its ID in the local account DB.
  try {
    task.referenceDiagnostics = referenceDiagnostics(lastUpstreamRequest)
    task.sentBody = task.sentBody ? redactReferencePayload(task.sentBody) : task.referenceDiagnostics
    management.setUpstreamTask(job.id, { requestId: task.id, model: task.upstreamModel, status: task.upstreamStatus })
    const balanceAfter = request.model.provider === 'metaso' ? await metasoCreditsBalance({ env, fetchImpl }) : null
    const estimatedCost = request.model.provider === 'metaso'
      ? estimateUpstreamCostRmb({ model: request.model, parameters: request.parameters, seconds: Number(request.billableDuration ?? request.duration) || null })
      : null
    const estimatedCredits = estimatedCost?.detail?.supplierCredits ?? (estimatedCost?.rmb == null ? null : Math.round(Number(estimatedCost.rmb) / 0.0108 * 10000) / 10000)
    try {
      management.recordUpstreamCall({
        generationId: job.id,
        provider: request.model.provider,
        model: job.model,
        kind: 'video',
        tier: request.resolution || '',
        seconds: Number(request.billableDuration ?? request.duration) || null,
        hasInputVideo: Boolean(Number(request.parameters?.videoSeconds) > 0 || request.parameters?.video || (request.parameters?.videos || []).length),
        request: { path: task.sentPath || '', body: task.sentBody || null, referenceDelivery: task.referenceDiagnostics || null, ...mockProviderAudit(env) },
        response: task.raw ?? null,
        cost: estimatedCost,
        estimatedCredits,
        upstreamRequestId: task.upstreamRequestId || task.id,
        status: 'submitted',
        creditsBefore: balanceBefore?.balance ?? null,
        creditsAfter: balanceAfter?.balance ?? null,
      })
    } catch {
      // 留档失败不能影响生成。
    }
    return task
  } catch (error) {
    if (task) throw acceptedVideoSubmissionError(error, task)
    throw error
  }
}

/**
 * 把成片写进用户工作区（服务端完成，不依赖浏览器）。
 * 目标目录优先用这次请求带的 outputDirectory（画布节点目录），否则 assets/。
 */
async function persistVideoIntoWorkspace({ management, workspaceFiles, generationId, video, model, env, fetchImpl }: Record<string, any>) {
  const row = management.get('SELECT user_id, request_id, parameters FROM generations WHERE id=?', generationId)
  const userId = row?.user_id
  if (!userId) return ''
  let parameters: Record<string, any> = {}
  try { parameters = JSON.parse(row.parameters || '{}') } catch { parameters = {} }
  const directory = String(parameters.outputDirectory || 'assets').replace(/^\/+|\/+$/g, '') || 'assets'
  let target = String(video.metadata?.upstreamUrl || video.url || '').trim()
  const config = model.provider === 'metaso'
    ? metasoVideoSettings(env)
    : model.provider === 'ark'
    ? arkVideoSettings(env)
    : videoSettings(env, model)
  if (model.provider === 'grok' && target.startsWith('/')) {
    const resolved = new URL(target, config.baseUrl)
    if (resolved.origin !== new URL(config.baseUrl).origin || resolved.pathname !== `/v1/videos/${encodeURIComponent(video.id)}/content`) throw failure('视频结果校验失败，请重试', 502)
    target = resolved.toString()
  }
  if (!/^https?:\/\//.test(target)) return ''
  assertProviderRequestAllowed(model.provider, target, env)
  const signal = AbortSignal.timeout(600_000)
  const response = await fetchVideoContent(target, { provider: model.provider, providerConfig: config, signal, fetchImpl })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw failure(`成片下载失败（${response.status}）`, 502)
  }
  try {
    if (!response.body) throw failure('成片内容为空', 502)
    const mimeType = String(video.mime || 'video/mp4').split(';')[0].trim()
    const path = `${directory}/${randomUUID()}.${mimeType === 'video/webm' ? 'webm' : 'mp4'}`
    const project = parameters.workspaceProject || DEFAULT_PROJECT_ID
    const absolute = workspaceFiles.fileFor(userId, project, path, { create: true })
    const identity = !response.headers.get('content-encoding') || response.headers.get('content-encoding').split(',').every(value => value.trim().toLowerCase() === 'identity')
    const declaredLength = identity && /^\d+$/.test(response.headers.get('content-length') || '') ? Number(response.headers.get('content-length')) : null
    // This is the existing server workspace cache limit. Larger results remain
    // available through the authenticated streaming proxy for local delivery.
    if (declaredLength !== null && declaredLength > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
    return await withStreamedMedia(Readable.fromWeb(response.body as any), { path: absolute, signal, maxBytes: WORKSPACE_FILE_MAX_BYTES, mode: mediaPermissions().file }, async (received, receiveSignal) => {
      if (!received.size) throw failure('成片内容为空', 502)
      if (declaredLength !== null && declaredLength !== received.size) throw failure('成片下载不完整，请重新取回', 502)
      try { await probeVideoFile({ diskPath: received.path, size: received.size, sha256: received.sha256 }, 'video', { signal: receiveSignal, requireDuration: false }) }
      catch (error) {
        receiveSignal.throwIfAborted()
        if (error?.status === 503) throw error
        throw failure('成片文件无效或不完整，请重新取回', 502)
      }
      const publish = file => {
        receiveSignal.throwIfAborted()
        if (file.size > WORKSPACE_FILE_MAX_BYTES) throw failure('单个文件不能超过 200MB', 413)
        management.transaction(() => {
          const latest = management.get('SELECT status,parameters FROM generations WHERE id=?', generationId)
          const delivery = JSON.parse(latest?.parameters || '{}')
          if (delivery.desktopDeliveredAt || delivery.desktopMediaExpiredAt) throw failure('服务器临时文件已清理，请打开本机保存的结果', 410)
          if (![GENERATION_STATES.RUNNING, GENERATION_STATES.SUCCEEDED].includes(latest?.status)) throw failure('这次生成已取消或结束，未写入成片', 409)
          if (management.get(`SELECT path FROM workspace_files WHERE ${workspaceFiles.scopeWhere()} AND path=?`, ...workspaceFiles.scopeArgs(userId, project), path)) throw failure('暂存文件路径冲突，未覆盖原文件', 409)
          workspaceFiles.assertWriteTarget(userId, project, path, mimeType, null)
          const blob = file.sha256 || workspaceFiles.blobs.putFile(userId, file.path).blob
          if (file.sha256) workspaceFiles.blobs.linkFromFile(userId, file.path, blob, { copyFallback: true })
          const revision = randomUUID()
          workspaceFiles.putIndex(userId, project, path, mimeType, file.size, revision, blob)
          if (parameters.desktopDelivery === 1) recordDesktopMediaOutput(management, userId, row.request_id, { path, revision, blob }, project)
        })
        workspaceFiles.flushBytes()
        return path
      }
      // Preserve the original for desktop digest acknowledgement. Website
      // playback keeps lossless faststart, without loading whole files into JS.
      return parameters.desktopDelivery === 1 ? publish(received) : withNormalizedVideoFile(received, { path, mime: mimeType, signal: receiveSignal }, publish)
    })
  } catch (error) {
    if (signal.aborted) throw failure('成片下载超时，请重新取回', 504)
    if (error instanceof TypeError && error.message === 'terminated') throw failure('成片下载不完整，请重新取回', 502)
    throw error
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {})
  }
}

/**
 * 结果取回：某次视频生成已经成功但没落进工作区时（例如浏览器断了），
 * 用户（或 Agent）可以让服务端重新把成片写进他的工作区，不用重新生成。
 */
const videoRestores = new Map()
export async function restoreVideoResult({ requestId }: Record<string, any>, session, dependencies: Record<string, any> = {}) {
  if (!session) throw failure('请先登录', 401)
  dependencies.management.generationForViewer(requestId, session)
  if (videoRestores.has(requestId)) return videoRestores.get(requestId)
  const promise = restoreVideoResultOnce({ requestId }, session, dependencies).finally(() => videoRestores.delete(requestId))
  videoRestores.set(requestId, promise)
  return promise
}
async function restoreVideoResultOnce({ requestId }: Record<string, any>, session, { management, workspaceFiles, env = process.env, fetchImpl = fetch }: Record<string, any> = {}) {
  if (!session) throw failure('请先登录', 401)
  if (!management || !workspaceFiles) throw failure('结果取回缺少依赖', 500)
  const existing = management.existingGeneration({ session, requestId })
  if (!existing) throw failure('生成记录不存在', 404)
  const record = management.generationForViewer(requestId, session)
  if (record?.parameters?.desktopDeliveredAt || record?.parameters?.desktopMediaExpiredAt) throw failure('服务器临时文件已清理，请打开本机保存的结果', 410)
  if (record?.status !== GENERATION_STATES.SUCCEEDED) throw failure('这次生成还没有成功，无法取回', 409)
  const video = management.videoResult(existing.id)
  if (!video) throw failure('这次生成没有视频结果', 404)
  if (video.metadata?.workspacePath) {
    try { workspaceFiles.locate(session.userId, video.metadata.workspacePath, record.parameters?.workspaceProject || DEFAULT_PROJECT_ID); return { path: video.metadata.workspacePath, already: true } } catch { /* 文件没了就重下 */ }
  }
  const model = modelForGeneration(record.model, record.parameters || {}, existing.provider) || modelById(record.model)
  const path = await persistVideoIntoWorkspace({ management, workspaceFiles, generationId: existing.id, video, model, env, fetchImpl })
  if (!path) throw failure('成片地址不可用，无法取回', 502)
  management.setVideoWorkspacePath(existing.id, path)
  return { path, already: false }
}

const videoPolls = new Map()
export async function pollVideo(payload, session, dependencies: Record<string, any> = {}) {
  // Authorize every caller before sharing an in-flight poll with the background worker.
  dependencies.management.generationForViewer(String(payload?.requestId || ''), session, payload?.accessToken || '')
  const key = String(payload?.requestId || '')
  if (videoPolls.has(key)) return videoPolls.get(key)
  const promise = pollVideoOnce(payload, session, dependencies).finally(() => videoPolls.delete(key))
  videoPolls.set(key, promise)
  return promise
}

async function pollVideoOnce(payload, session, { management, env = process.env, fetchImpl = fetch, workspaceFiles }: Record<string, any> = {}) {
  if (!management) throw failure('视频处理器缺少 ManagementStore', 500)
  const requestId = String(payload?.requestId || '').trim()
  if (!requestId) throw failure('缺少视频请求标识', 422)
  const accessToken = String(payload?.accessToken || '').trim()
  const existing = management.existingGeneration({ session, requestId, accessToken })
  if (!existing) throw failure('视频生成记录不存在', 404)
  const current = management.generationForViewer(requestId, session, accessToken)
  const terminalResponse = record => record && [GENERATION_STATES.SUCCEEDED, GENERATION_STATES.FAILED, GENERATION_STATES.CANCELLED, GENERATION_STATES.EXPIRED].includes(record.status)
    ? { ...record, httpStatus: record.status === GENERATION_STATES.EXPIRED ? 410 : 200 }
    : null
  // 终态直接返回：取消/过期同样要如实回报，避免已退款的任务继续显示 running 并再次轮询上游。
  if (current && [GENERATION_STATES.SUCCEEDED, GENERATION_STATES.FAILED, GENERATION_STATES.CANCELLED, GENERATION_STATES.EXPIRED].includes(current.status)) {
    return { ...current, httpStatus: current.status === GENERATION_STATES.EXPIRED ? 410 : 200 }
  }
  const taskIdValue = String(existing.upstreamRequestId || '').trim()
  if (!taskIdValue) {
    return { requestId, status: current.status, submissionUncertain: current.submissionUncertain, error: current.error, progress: null, pollAfterMs: current.submissionUncertain ? 5000 : 1000, httpStatus: 202 }
  }
  try {
    const provider = modelForGeneration(existing.model, existing.parameters || {}, existing.provider)?.provider || 'grok'
    const model = modelForGeneration(existing.model, existing.parameters || {}, existing.provider) || modelById(existing.model)
    const result: Record<string, any> = provider === 'ark'
      ? await pollArkVideoTask(taskIdValue, { env, fetchImpl, signal: AbortSignal.timeout(30_000) })
      : provider === 'metaso'
      ? await pollMetasoVideoTask(taskIdValue, { env, fetchImpl, model, signal: AbortSignal.timeout(30_000) })
      : provider === 'suihe'
      ? await pollSuiheTask(taskIdValue, { env, fetchImpl, signal: AbortSignal.timeout(30_000) })
      : await pollSub2ApiVideo(taskIdValue, { env, model, fetchImpl, signal: AbortSignal.timeout(30_000) })
    const latestTerminal = terminalResponse(management.generationForViewer(requestId, session, accessToken))
    if (latestTerminal) return latestTerminal
    // 上游视频地址可能要求 Bearer Key、跨域，或只在短时间内对服务端可读；
    // 统一改走同源代理地址，浏览器再从服务端工作区写入账号持久化文件。
    // 原始地址只放在服务端记录的 metadata 中，不能直接交给浏览器。
    if (result.status === 'succeeded' && result.url) {
      result.metadata = { ...(result.metadata || {}), upstreamUrl: result.url, proxied: true }
      result.url = `/api/imagine/video-content?requestId=${encodeURIComponent(requestId)}`
    }
    if (result.status === 'succeeded') {
      // 成片由服务端直接落进用户工作区：浏览器不再需要下载后再回写，
      // 关页面/切网/刷新都不会丢结果。写失败只记录，不影响结算。
      let workspacePath = ''
      if (result.url && workspaceFiles) {
        try {
          workspacePath = await persistVideoIntoWorkspace({ management, workspaceFiles, generationId: existing.id, video: result, model, env, fetchImpl })
          if (workspacePath) result.metadata = { ...(result.metadata || {}), workspacePath }
        } catch (error) {
          console.warn('[video] 成片写入工作区失败', existing.id, error?.message || error)
        }
      }
      management.completeVideo(existing.id, result)
      try {
        const settled = management.get('SELECT parameters, upstream_cost FROM generations WHERE id=?', existing.id)
        management.finishUpstreamCall(existing.id, {
          response: result.metadata?.raw ?? null,
          usage: result.usage ?? null,
          cost: settled?.upstream_cost ? JSON.parse(settled.upstream_cost) : null,
          estimatedCredits: settled?.upstream_cost ? JSON.parse(settled.upstream_cost).detail?.supplierCredits ?? null : null,
          upstreamRequestId: result.upstreamRequestId || taskIdValue,
          status: 'ok',
        })
      } catch { /* 留档失败不影响结果 */ }
      const settled = management.generationForViewer(requestId, session, accessToken)
      return { ...settled, requestId, status: GENERATION_STATES.SUCCEEDED, cost: { points: settled?.chargedPoints ?? current?.reservedPoints ?? 0, reservedPoints: settled?.reservedPoints ?? current?.reservedPoints ?? 0 }, httpStatus: 200 }
    }
    if (result.status === 'failed') {
      const rawResultMessage = result.error || '视频生成失败'
      // 查询接口通常只暴露任务 id，而不是单独的 request_id；保留错误
      // 文本里的 id，否则就用任务 id，确保用户和 upstream_calls 都能定位。
      const resultRequestId = upstreamRequestIdFromError({ message: rawResultMessage }) || String(result.upstreamRequestId || '').trim()
      const resultMessage = resultRequestId && !String(rawResultMessage).includes(resultRequestId)
        ? `${rawResultMessage}（上游 Request id: ${resultRequestId}）`
        : rawResultMessage
      const diagnostic = `参考素材=${JSON.stringify(storedReferenceDiagnostics(management, existing.id))}`
      const failureText = `${resultMessage}；${diagnostic}`.slice(0, 500)
      management.fail(existing.id, failureText, { ...result, upstreamRequestId: resultRequestId || result.upstreamRequestId })
      const afterFailure = terminalResponse(management.generationForViewer(requestId, session, accessToken))
      if (afterFailure && afterFailure.status !== GENERATION_STATES.FAILED) return afterFailure
      try {
        management.finishUpstreamCall(existing.id, { response: result.metadata?.raw ?? null, usage: result.usage ?? null, upstreamRequestId: resultRequestId || result.upstreamRequestId || taskIdValue, status: 'failed_after_submit', error: failureText })
      } catch { /* 留档失败不影响结算 */ }
      // 注意：result.status 是业务状态（failed），不能覆盖 Error 的 HTTP status。
      throw Object.assign(new Error(failureText), { ...result, upstreamRequestId: resultRequestId || result.upstreamRequestId, status: 422 })
    }
    return { requestId, taskId: taskIdValue, status: GENERATION_STATES.RUNNING, progress: result.progress, pollAfterMs: 1500, httpStatus: 202 }
  } catch (error) {
    // Only an explicit upstream terminal task state settles the reservation.
    // HTTP/auth/network errors during a read do not change the task's state.
    const latest = terminalResponse(management.generationForViewer(requestId, session, accessToken))
    if (latest) return latest
    return { requestId, taskId: taskIdValue, status: GENERATION_STATES.RUNNING, progress: null, pollAfterMs: 5_000, httpStatus: 202 }
  }
}
