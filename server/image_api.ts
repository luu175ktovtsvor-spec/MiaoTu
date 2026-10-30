import { candidateMode, candidateRequestAllowed } from './candidate-safety.ts'
import { redisRuntime } from './redis-runtime.ts'
import { forEachAsync, mapAsync } from './async-collections.ts'
import { hasImageLayerPricing, imageLayerDimensions, hasPngAlphaChannel } from './image-layer-pricing.ts'
import { localizeErrorResponse } from './i18n.ts'
import { cloudWorkspaceStorageEnabled } from './cloud-storage-policy.ts'
import { createDesktopMedia } from './desktop-media.ts'
import { ShowcaseContent } from './showcase-content.ts'
import { proxyVideoContent } from './video-content-proxy.ts'
import { IMAGE_PROXY_MAX_BYTES, isAllowedImageProxyUrl, proxyImage } from './image-content-proxy.ts'
import { isWorkspaceRequest } from './canvas-document.ts'
import { desktopModel } from './desktop-model.ts'
import { desktopWeb } from './desktop-web.ts'
import { normalizeReferenceHistory } from './user-prompts.ts'
import { userFacingError, explainUserError } from './user-errors.ts'
import { createErrorExplanations } from './error-explanation.ts'
import { syncCanvasGeneration } from './canvas-generation.ts'
import { WorkspaceFiles } from './workspace-files.ts'
import { assertReferenceInput, referenceInputPolicy, unsupportedReferenceFormat } from './reference-input-contract.ts'
import { DEFAULT_PROJECT_ID, projectId } from './projects.ts'
import { IMAGE_RECEIPT_DIRECTORY, mediaRoot } from './media-files.ts'
import { withRequestProject, withWorkspaceProject, currentProject } from './workspace-scope.ts'
import { createMcpApi } from './mcp-api.ts'
import { createAiCompat } from './ai-compat.ts'
import { createServer } from 'node:http'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import {
  defaultModel,
  defaultsFor,
  activeModelForSettings,
  modelById,
  modelForGeneration,
  modelCatalog,
  normalizeGeneration,
  providerConfigured,
  publicModelCatalog,
  publicVideoCatalog,
} from './image-models.ts'
import { estimateGenerationCost, estimateUpstreamCostRmb, imageCreditsBySize, imageCreditsPerImage, imagePricingSnapshot, imageLayerPricingSnapshot } from './generation-cost.ts'
import { editPrompt, validateEdit } from './image-edit-contract.ts'
import { supportedImageMime } from './result-cache.ts'
import { collectImageArtifacts, ImageResultError, readImageArtifact, type ImageResultMetadata } from './image-artifacts.ts'
import { ImageReceiptFiles, imageReceiptBinding, type StoredImageReceipt } from './image-receipt-files.ts'
import { ImageReceiptRecovery } from './image-recovery.ts'
import { ManagementStore, failure } from './management-store.ts'
import { bodyJson, cookieToken, sessionCookie, mutation, sameOrigin, loginRate } from './http-auth.ts'
import { buildArkBody, buildYunshuRequest } from './image-transport.ts'
import { requestImageUpstream } from './image-upstream.ts'
import { readJsonRequest } from './model-transport.ts'
import { HttpIncomingRequests } from './http-request-lifetime.ts'
import { fileContentHeaders } from './file-content-policy.ts'
import { filePreconditionStatus, serveFileContent } from './file-response.ts'
import { DESKTOP_MEDIA_CAPABILITIES, GENERATION_LIMITS, GENERATION_STATES, generationReceipt, newRequestId, validIdempotencyKey, validRequestId, submissionUncertain } from './generation-contract.ts'
import { compileReferencePrompt, REFERENCE_ROLES } from './creative-contract.ts'
import { createVideo, estimateVideoCredits, pollVideo, restoreVideoResult, safeOutputDirectory, submitQueuedVideo, videoSettings } from './video-api.ts'
import { arkVideoSettings } from './ark-video.ts'
import { metasoVideoSettings, reconcileMetasoBalance } from './metaso-video.ts'
import { createSuiheTask, receiveSuiheImages, refreshSuiheModels, suiheSettings } from './suihe.ts'
import { suihePricingSnapshot } from './suihe-pricing.ts'
import { acceptedVideoSubmissionError } from './video-submission.ts'
import { paymentConfig, publicPaymentConfig } from './payment-contract.ts'
import { createPaymentService, paymentOrderPayload, paymentReturnPage } from './payments/payment-service.ts'
import { publicTextCatalog, textChannelReady } from './text-models.ts'
import { createShortTextApi } from './short-text-api.ts'
import { createReferenceMaterializer, createReferenceMediaProbe, createMediaBufferProbe, createReferenceToken, isReferenceMediaMime, referenceUrlShape, summarizeReferenceValue, verifyReferenceToken } from './reference-assets.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { createFeedbackStore } from './feedback-store.ts'
import { createEmailOtp } from './email-otp.ts'
import { assertMockProviderConfiguration, assertProviderRequestAllowed, isMockProviderMode, mockProviderAudit } from './provider-safety.ts'
import { assertTextAccess } from './text-access.ts'
import { assertModelAccess } from './model-access.ts'
import { enforceRequestLimit, requestOperation } from './request-guard.ts'


const HOST = process.env.OIP_IMAGE_API_HOST || '127.0.0.1'
const PORT = Number(process.env.OIP_IMAGE_API_PORT || 8788)
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_YUNSHU_BASE_URL = 'https://api.zzyppz.cn/v1'
const MAX_BODY_BYTES = 200 * 1024 * 1024
const SMALL_BODY_BYTES = 256 * 1024
const showcasePublicOrigin = String(
  process.env.OIP_PUBLIC_ORIGIN
    || String(process.env.OIP_PUBLIC_ORIGINS || '').split(',')[0]
    || `http://127.0.0.1:${process.env.OIP_WEB_PORT || '4173'}`
    || '',
).trim().replace(/\/$/, '')
const showcaseContent = new ShowcaseContent({
  directory: join(process.env.OIP_DATA_DIR || '.oip/runtime-data', 'catalog', 'showcase'),
  fetchFile: (path, signal) => fetch(new URL(path, showcasePublicOrigin), { signal, redirect: 'error' }),
})
const showcaseRoot = (metadataOnly = false) => metadataOnly ? showcaseContent.catalog() : showcaseContent.searchCatalog()
const archiveTranslations = () => showcaseContent.archiveTranslations()
const showcaseAssetFetch = async (path, signal) => {
  if (!showcasePublicOrigin) throw Object.assign(new Error('精选媒体地址未配置'), { status: 503 })
  return fetch(new URL(String(path || '/'), showcasePublicOrigin), {
    signal,
    redirect: 'error',
    headers: { accept: 'image/*' },
  })
}
assertMockProviderConfiguration(process.env)
const management = (await ManagementStore.open())
const imageReceipts = new ImageReceiptFiles(join(mediaRoot(), IMAGE_RECEIPT_DIRECTORY), IMAGE_PROXY_MAX_BYTES)
const errorExplanations = createErrorExplanations({ management })
const emailOtp = createEmailOtp({ management })
const feedback = (await createFeedbackStore(management))
// 密码登录按邮箱计失败次数：15 分钟内连错 5 次就暂停密码登录，只能用验证码。
const PASSWORD_FAILURE_LIMIT = 5
const PASSWORD_FAILURE_WINDOW_MS = 15 * 60_000
const passwordFailures = new Map<string, { count: number; until: number }>()
const { createPaymentOrder, handlePaymentNotify, paymentQrImage } = createPaymentService({ management })
// 生成结果的字节也从库里搬到磁盘（和 workspace_files 同一套做法）：
// 启动时跑一次，幂等可续跑，失败的行留在库里下次重试。
await (await management.artifactFiles()).migrateToDisk()
const workspaceFiles = (await WorkspaceFiles.open(management))
workspaceFiles.referenceOwner = async userId => (await management.publicUser(userId)).workspaceKey
const desktopMedia = (await createDesktopMedia({ management, workspaceFiles, publicOrigin: process.env.OIP_PUBLIC_ORIGIN }))
workspaceFiles.userMutationGuard = desktopMedia.assertWorkspaceMutation
workspaceFiles.userListFilter = desktopMedia.filterWorkspaceEntries
const probeReferenceMedia = createReferenceMediaProbe({ workspaceFiles, secret: async () => (await management.referenceSecret()), publicOrigin: process.env.OIP_PUBLIC_ORIGIN })
const materializeReference = createReferenceMaterializer({ workspaceFiles, secret: async () => (await management.referenceSecret()), publicOrigin: process.env.OIP_PUBLIC_ORIGIN })
const mcpApi = createMcpApi({ management, workspaceFiles, showcaseRoot, archiveTranslations, showcaseAssetFetch })
const aiCompat = createAiCompat({ management, workspaceFiles })
const shortTextApi = createShortTextApi({ management, workspaceFiles })

// 工作台只认普通用户会话：管理员在 /manage 登录拿到的是独立的 miao_admin cookie。
// 如果把管理员会话也当成"已登录用户"返回，画布会以为自己登录了，但每个用户接口都 401，
// 结果就是输入框被禁用、画布打不开（线上 2026-10-06 复现过）。
// 生成结束后前端要能立刻把顶部的积分数字刷新掉。轮询接口顺带把「扣完之后的余额」
// 带回去，客户端就不用再单独拉一次会话：少一次往返，退款/取消导致的变化也一起覆盖了。
async function viewerBalance(session) {
  if (session?.role !== 'user') return null
  const user = (await management.user(session.userId))
  return user ? Number(user.points) : null
}

function viewerSession(session) {
  return session?.role === 'user' ? session : null
}

async function publicSession(session) {
  return session
    ? { role: session.role, csrf: session.csrf, user: session.userId ? (await management.publicUser(session.userId)) : null }
    : null
}

function settings(env = process.env) {
  return {
    ark: {
      apiKey: runtimeSecret('ARK_API_KEY', env),
      baseUrl: (env.ARK_BASE_URL || DEFAULT_ARK_BASE_URL).replace(/\/$/, ''),
      responseFormat: env.ARK_RESPONSE_FORMAT || 'url',
      outputFormat: env.ARK_OUTPUT_FORMAT || 'png',
      watermark: env.ARK_WATERMARK === 'true',
    },
    yunshu: {
      apiKey: runtimeSecret('YUNSHU_API_KEY', env),
      baseUrl: (env.YUNSHU_BASE_URL || DEFAULT_YUNSHU_BASE_URL).replace(/\/$/, ''),
      responseFormat: env.YUNSHU_RESPONSE_FORMAT || 'b64_json',
      outputFormat: env.YUNSHU_OUTPUT_FORMAT || 'png',
      quality: env.YUNSHU_IMAGE_QUALITY || 'auto',
    },
    grok: {
      // Grok 图片/视频统一走 Yunshu 兼容通道；保留专用 GROK_API_KEY，
      // 未单独配置时回退到 Yunshu API Key。
      apiKey: isMockProviderMode(env) ? runtimeSecret('GROK_API_KEY', env) : (runtimeSecret('GROK_API_KEY', env) || runtimeSecret('YUNSHU_API_KEY', env)),
      baseUrl: String(isMockProviderMode(env) ? (env.GROK_BASE_URL || '') : (env.GROK_BASE_URL || env.YUNSHU_BASE_URL || DEFAULT_YUNSHU_BASE_URL)).replace(/\/$/, ''),
      responseFormat: env.GROK_RESPONSE_FORMAT || 'b64_json',
      outputFormat: env.GROK_OUTPUT_FORMAT || 'png',
      quality: env.GROK_IMAGE_QUALITY || 'auto',
    },
    enabled: env.ENABLE_MODEL_CALLS === 'true',
  }
}

async function json(response, status, value, headers: Record<string, any> = {}) {
  value = (await errorExplanations.attach(value, status))
  if (value?.error && (status >= 400 || value.ok === false)) {
    value = { ...value, error: userFacingError(value.error, { status }), errorExplanation: value.errorExplanation || explainUserError(value.error, { status, submissionUncertain: value.submissionUncertain, generationStatus: value.status, chargedPoints: value.chargedPoints, reservedPoints: value.reservedPoints, requestId: value.requestId }) }
  }

  const body = JSON.stringify(localizeErrorResponse(value, status, response.req?.headers?.['accept-language']))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  response.end(body)
}

function readJson(request, maxBytes = MAX_BODY_BYTES, signal?: AbortSignal) {
  return readJsonRequest(request, { maxBytes, objectOnly: false, signal, invalidMessage: '请求格式不是有效 JSON' })
}

function parseImageData(value, model) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ''))
  if (!match) throw Object.assign(new Error('参考图格式不受支持'), { status: 422 })
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw Object.assign(new Error('参考图内容为空'), { status: 422 })
  const limit = referenceInputPolicy(model, 'image')
  if (!limit.mimes.includes(mime)) throw failure(unsupportedReferenceFormat(model, 'image', { mime }), 422)
  if (bytes.length > limit.maxBytes) throw failure('单张参考图不能超过 ' + limit.maxBytes / (1024 * 1024) + 'MB；原素材未被压缩', 422)
  return { value, mime, bytes, extension: mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] }
}

const WORKSPACE_REFERENCE_SOURCES = Symbol('workspace-reference-sources')
async function resolveImageReferenceFiles(payload, session, env = process.env) {
  if (payload.referenceFiles === undefined) return payload
  if (session?.role !== 'user') throw failure('请使用自己的工作区参考素材', 403)
  const model = activeModelForSettings(String(payload.model || (await management.settings()).defaultModel || defaultModel(env)).trim(), (await management.settings()), env)
  if (!model || model.video) throw failure('不支持的图片模型', 422)
  if (!Array.isArray(payload.referenceFiles) || (payload.references !== undefined && (!Array.isArray(payload.references) || payload.references.length))) throw failure('参考素材参数无效', 422)
  if (payload.referenceFiles.length > model.maxReferences) throw failure('当前模型最多支持 ' + model.maxReferences + ' 张参考图', 422)
  const project = (await resolveWorkspaceProject(session.userId, currentProject()))
  const limit = referenceInputPolicy(model, 'image')
  const sources = []
  const references = (await mapAsync(payload.referenceFiles, async item => {
    if (!item || typeof item.path !== 'string') throw failure('参考素材路径无效', 422)
    const file = (await workspaceFiles.stat(session.userId, item.path, project))
    const mime = String(file.mime || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg')
    if (!limit.mimes.includes(mime)) throw failure(unsupportedReferenceFormat(model, 'image', { mime }), 422)
    if (file.size > limit.maxBytes) throw failure('单张参考图不能超过 ' + limit.maxBytes / (1024 * 1024) + 'MB；原素材未被压缩', 422)
    if (item.revision && item.revision !== file.revision) throw failure('参考素材已更新，请刷新后重新选择', 409)
    const content = (await workspaceFiles.read(session.userId, item.path, project))
    if (content.revision !== file.revision) throw failure('参考素材已更新，请刷新后重新选择', 409)
    sources.push({ path: file.path, revision: file.revision, project })
    return 'data:' + mime + ';base64,' + content.bytes.toString('base64')
  }))
  return { ...payload, references, [WORKSPACE_REFERENCE_SOURCES]: sources }
}

const probeImageBytes = createMediaBufferProbe()
async function prepareImageRequest(payload, session, env = process.env) {
  const resolved = (await resolveImageReferenceFiles(payload, session, env))
  const request = (await validateRequest(resolved, env))
  // Actual format/dimensions are read from the original bytes. No thumbnail,
  // canvas draw, or encoder participates in this path.
  for (const reference of request.references) {
    if (request.generation.layerDecomposition && !imageLayerDimensions(reference.bytes)) throw failure('当前模型不支持这个参考图片格式，请转换后重新上传', 422)
    const metadata = await probeImageBytes(reference.bytes, 'image')
    const policyModel = request.generation.layerDecomposition ? { ...request.model, parameterRules: { ...request.model.parameterRules, referenceInputsByMode: { layer: { image: { mimes: ['image/png', 'image/jpeg'], minPixels: 262144 } } } } } : request.model
    assertReferenceInput(policyModel, 'image', { ...metadata, mime: reference.mime }, request.generation.layerDecomposition ? 'layer' : '')
    reference.metadata = metadata
  }
  if (request.model.provider === 'ark' && resolved[WORKSPACE_REFERENCE_SOURCES]?.length === request.references.length) {
    request.references.forEach((reference, index) => { reference.workspaceSource = resolved[WORKSPACE_REFERENCE_SOURCES][index] })
  }
  return request
}

async function validateRequest(payload, env = process.env): Promise<Record<string, any>> {
  const prompt = String(payload?.prompt || '').trim()
  const layerDecomposition = payload?.layerDecomposition === true
  // 图层拆分允许不写提示词（官方：不传 prompt 时自动拆分主要元素）。
  if (prompt.length < 2 && !layerDecomposition) throw Object.assign(new Error('请先输入画面描述'), { status: 422 })
  const modelId = String(payload?.model || (await management.settings()).defaultModel || defaultModel(env)).trim()
  const model = activeModelForSettings(modelId, (await management.settings()), env)
  if (!model || model.video || model.internalOnly) throw Object.assign(new Error('不支持的图片模型'), { status: 422 })
  if (!providerConfigured(model.provider, env)) throw Object.assign(new Error(`${model.label} 的服务端 Key 尚未配置`), { status: 503 })
  if (env.ENABLE_MODEL_CALLS !== 'true') throw Object.assign(new Error('模型调用开关未开启'), { status: 503 })
  if (payload.references !== undefined && !Array.isArray(payload.references)) throw failure('参考素材参数无效', 422)
  const references = Array.isArray(payload?.references) ? payload.references : []
  if (references.length > model.maxReferences) throw Object.assign(new Error(`当前模型最多支持 ${model.maxReferences} 张参考图`), { status: 422 })
  const parsedReferences = references.map(value => parseImageData(value, model))
  let generation
  try { generation = normalizeGeneration(model.id, payload, model) } catch (error) { throw Object.assign(error, { status: 422 }) }
  const edit = validateEdit(payload.edit, model, parsedReferences, value => parseImageData(value, model))
  if (edit) generation.count = 1
  // 火山官方图层拆分：仅 5.0 Pro/Flash，单张输入图，size 只支持 1K/1.5K/2K/auto。
  if (layerDecomposition) {
    if (!model.supportsLayerDecomposition) throw Object.assign(new Error('当前模型不支持图层拆分'), { status: 422 })
    if (parsedReferences.length !== 1) throw Object.assign(new Error('图层拆分只支持单张参考图'), { status: 422 })
    if (edit) throw Object.assign(new Error('图层拆分不能和局部重绘一起使用'), { status: 422 })
    if (!['1K', '1.5K', '2K', 'auto'].includes(generation.size)) throw Object.assign(new Error('图层拆分的尺寸只支持 1K / 1.5K / 2K / auto'), { status: 422 })
    // 官方固定输出 1 张底图 + 最多 16 个透明图层：按 17 张预扣，
    // finish() 再按上游实际返回的张数结算并把差额退回。
    generation.count = 17
  }
  const optimizePrompt = String(payload?.optimizePrompt || '').trim()
  if (optimizePrompt && !(model.optimizePromptModes || []).includes(optimizePrompt)) {
    throw Object.assign(new Error('当前模型不支持这个提示词优化模式'), { status: 422 })
  }
  generation.layerDecomposition = layerDecomposition
  generation.optimizePrompt = optimizePrompt
  // Seedance/Seedream 官方组图限制：Seedream 4.0 的参考图数量 + 生成张数 ≤ 15。
  if (model.provider==='ark' && model.maxCombinedImages && parsedReferences.length + generation.count > model.maxCombinedImages) {
    throw Object.assign(new Error(`参考图数量 + 生成张数不能超过 ${model.maxCombinedImages} 张`), { status: 422 })
  }
  // GPT Image 的透明背景文生图、图生图都可以，只要求输出带透明通道的格式。
  if (generation.background === 'transparent' && model.provider !== 'ark' && !['png', 'webp'].includes(generation.format)) {
    throw Object.assign(new Error('透明背景需要输出 png 或 webp 格式'), { status: 422 })
  }
  // 火山官方透明背景限制：仅图生图、单张带透明通道的输入图、输出 png。
  if (generation.background === 'transparent' && model.provider === 'ark') {
    if (parsedReferences.length !== 1) throw Object.assign(new Error('透明背景只支持单张参考图的图生图'), { status: 422 })
    if (generation.format !== 'png') throw Object.assign(new Error('透明背景需要输出 png 格式'), { status: 422 })
    if (edit) throw Object.assign(new Error('透明背景不能和局部重绘一起使用'), { status: 422 })
    const reference = parsedReferences[0]
    if (reference.mime !== 'image/png' || !hasPngAlphaChannel(reference.bytes)) throw Object.assign(new Error('透明背景需要输入带透明通道的 png 图片'), { status: 422 })
  }
  const roles = payload.referenceRoles || []
  if (!Array.isArray(roles) || (roles.length && roles.length !== references.length) || roles.some(role => !REFERENCE_ROLES.some(item => item.value === role))) throw failure('参考图分工无效')
  const pricing = (await management.costPolicy()).models[model.publicId || model.id]
  if (!pricing) throw failure('当前模型定价待确认', 503)
  if (layerDecomposition) {
    generation.imageLayerPricing = imageLayerPricingSnapshot(model, { ...generation, referenceCount: parsedReferences.length })
    if (!generation.imageLayerPricing) throw failure('当前模型定价待确认', 503)
  }
  return { prompt: editPrompt(compileReferencePrompt(prompt, roles), edit), referenceRoles: roles, model, edit, references: parsedReferences, generation, cost: estimateGenerationCost({ model, generation, referenceCount: parsedReferences.length, price: pricing }) }
}

async function submitArk(request, env = process.env, signal, fetchImpl = fetch) {
  const config = settings(env).ark
  assertProviderRequestAllowed('ark', config.baseUrl, env)
  // Sign when the queued job actually submits, not when the user asks for
  // a quote. Keep the captured bytes as a lossless fallback if its original
  // workspace path was replaced/deleted meanwhile.
  const origin = String(env.OIP_PUBLIC_ORIGIN || '').replace(/\/$/, '')
  const references = (await mapAsync(request.references, async reference => {
    if (!origin || !request.userId || !reference.workspaceSource) return reference
    try {
      const source = reference.workspaceSource
      const file = (await workspaceFiles.stat(request.userId, source.path, source.project))
      if (file.revision !== source.revision) return reference
      const token = createReferenceToken((await management.referenceSecret()), { userId: request.userId, path: file.path, revision: file.revision, project: source.project })
      return { ...reference, value: origin + '/api/imagine/reference?t=' + encodeURIComponent(token) }
    } catch { return reference }
  }))
  const body = buildArkBody({ ...request, references }, config)
  return requestImageUpstream(config, { kind: 'json', path: '/images/generations', body }, request.generation, { env, signal, fetchImpl })
}

async function submitYunshu(request, env = process.env, signal, fetchImpl = fetch) {
  const config = request.model.provider === 'grok' ? settings(env).grok : settings(env).yunshu
  assertProviderRequestAllowed(request.model.provider === 'grok' ? 'grok' : 'yunshu', config.baseUrl, env)
  const references = request.model.provider === 'grok' ? (await mapAsync(request.references, async item => ({ ...item, value: (await materializeReference(item.value, request.userId, { kind: 'image', inline: false })).value }))) : request.references
  return requestImageUpstream(config, buildYunshuRequest({ ...request, references }), request.generation, { env, signal, fetchImpl })
}

function storedParameters(request) {
  return {
    ...request.generation,
    upstreamProvider:request.model.provider,
    ...(request.model.provider==='suihe'?{suiheCost:suihePricingSnapshot(request.model,request.generation)}:{}),
    upstreamImagePricing:imagePricingSnapshot(request.model,{...request.generation,referenceCount:request.references.length}),
    // 画布节点目录：图片结果由服务端直接写进去（和视频同一套）。
    outputDirectory: request.outputDirectory || '',
    ...(request.desktopDelivery === 1 ? { desktopDelivery: 1, desktopReferences: request.desktopReferences } : {}),
    workspaceProject: request.workspaceProject || currentProject() || DEFAULT_PROJECT_ID,
    referenceHistory: request.referenceHistory || [],
    referenceCount: request.references.length,
    referenceRoles: request.referenceRoles,
    referenceSources: request.references.map(item => item.value.startsWith('data:') ? null : item.value),
    referenceSourceFiles: request.references.map(item => item.workspaceSource || null),
    referenceMetadata: request.references.map(item => item.metadata || null),
    effectivePrompt: request.prompt,
    editMode: request.edit?.mode || null,
    edit: request.edit ? { ...request.edit, ...(request.edit.mask ? { mask: { stored: true } } : {}) } : null,
  }
}

function requestFromJob(job) {
  const parameters = job.parameters
  const model = modelForGeneration(job.model,parameters,job.provider)
  if (!model) throw failure('生成记录使用了已下线的模型', 422)
  return {
    userId: job.user_id,
    outputDirectory: parameters.outputDirectory || '',
    desktopDelivery: parameters.desktopDelivery, desktopReferences: parameters.desktopReferences,
    workspaceProject: parameters.workspaceProject || DEFAULT_PROJECT_ID,
    model,
    prompt: parameters.effectivePrompt || job.prompt,
    referenceRoles: parameters.referenceRoles || job.references.map((item) => item.role || 'general'),
    references: job.references.map((item, index) => ({ ...item, value: parameters.referenceSources?.[index] || item.value, workspaceSource: parameters.referenceSourceFiles?.[index] || null, metadata: parameters.referenceMetadata?.[index] || null })),
    generation: {
      size: parameters.size,
      ratio: parameters.ratio || '',
      quality: parameters.quality,
      upstreamImagePricing:parameters.upstreamImagePricing,
      imageLayerPricing:parameters.imageLayerPricing,
      suiheCost:parameters.suiheCost,
      upstreamProvider:parameters.upstreamProvider,
      referenceCount:parameters.referenceCount,
      format: parameters.format,
      background: parameters.background,
      inputFidelity: parameters.inputFidelity,
      count: parameters.count,
      seed: parameters.seed,
      responseFormat: parameters.responseFormat,
      // 队列任务重建请求时必须带上这些扩展参数，否则图层拆分/提示词优化会丢。
      layerDecomposition: Boolean(parameters.layerDecomposition),
      optimizePrompt: parameters.optimizePrompt || '',
    },
    edit: job.edit,
  }
}

async function executeGeneration(generationId, request, env, signal: AbortSignal, originalReceipt?: StoredImageReceipt) {
  let result: ImageResultMetadata | null = originalReceipt?.result || null
  let receipt = originalReceipt
  let dispatchStarted = false
  let acceptedTaskId = ''
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const row = (await management.get('SELECT * FROM generations WHERE id=?', generationId))
    if (!row || row.status !== GENERATION_STATES.RUNNING || row.lease_id !== workerId) throw failure('原任务已停止执行', 409)
    // Always check disk before dispatch. A crash after publishing the receipt
    // but before updating the task is recoverable without another model POST.
    receipt = await imageReceipts.load(generationId, imageReceiptBinding(row))
    if (originalReceipt && !receipt) throw Object.assign(failure('原图回执缺失，请保留原任务等待核对', 503), { upstreamAccepted: true })
    if (!receipt) {
      const parameters = JSON.parse(row.parameters || '{}')
      acceptedTaskId=request.model.provider==='suihe'?String(row.upstream_request_id||''):''
      if (!acceptedTaskId && (parameters.imageResultPending || parameters.submissionUncertain || parameters.imageResultExpiredAt)) throw Object.assign(failure('原任务等待核对，不会重新生成', 503), { upstreamAccepted: true })
      signal.throwIfAborted()
      if (!(await management.heartbeat(generationId, workerId))) throw failure('原任务已停止执行', 409)
      const dispatchFetch: typeof fetch = async (input, init) => {
        signal.throwIfAborted()
        await management.assertGenerationDispatch(generationId, workerId, { markStarted: true })
        dispatchStarted = true
        return fetch(input, init)
      }
      let received
      if(request.model.provider==='suihe') {
        if(!acceptedTaskId) {
          const task=await createSuiheTask(request,{env,fetchImpl:dispatchFetch,discoveryFetch:fetch,signal})
          acceptedTaskId=task.id
          try { await management.setUpstreamTask(generationId,{requestId:task.id,model:task.upstreamModel,status:task.upstreamStatus,workerId}) }
          catch(error) {throw acceptedVideoSubmissionError(error,task,'图片')}
          try {await management.recordUpstreamCall({generationId,provider:'suihe',model:request.model.publicId||request.model.id,kind:'image',tier:request.generation.size,request:task.sentBody,response:task.raw,upstreamRequestId:task.id,status:'submitted'})} catch {}
        }
        received=await receiveSuiheImages(request,acceptedTaskId,{env,signal})
      } else received = ['yunshu', 'grok'].includes(request.model.provider)
          ? await submitYunshu(request, env, signal, dispatchFetch)
          : await submitArk(request, env, signal, dispatchFetch)
      result = received
      receipt = await imageReceipts.write(generationId, imageReceiptBinding(row), received, Date.now() + management.artifactTtlMs(), signal)
    }
    result = receipt.result
    await management.noteImageResultPending(generationId, workerId, result)
    const expiry = new AbortController()
    expiryTimer = setTimeout(() => expiry.abort(Object.assign(new Error('原图暂存期已结束'), { code: 'IMAGE_RECEIPT_EXPIRED' })), Math.min(2_147_483_647, Math.max(1, receipt.expiresAt - Date.now())))
    expiryTimer.unref()
    signal = AbortSignal.any([signal, expiry.signal])
    const artifacts = await collectImageArtifacts(receipt.images.map((_, index) => index), (index, receiveSignal) =>
      imageReceipts.artifact(receipt, index, (url, remoteSignal) => readImageArtifact({ url },
        { signal: remoteSignal, allowUrl: isAllowedImageProxyUrl, maxBytes: IMAGE_PROXY_MAX_BYTES, env }), receiveSignal), signal)
    signal.throwIfAborted()
    const finished = (await management.finish(generationId, artifacts, result, workerId))
    try { await imageReceipts.remove(generationId) } catch (error) { console.warn('[image] 已保存原图的临时回执待清理', generationId, error?.code || 'unknown') }
    // 图片结果由服务端直接写进用户工作区（与视频同一套）：客户端拿路径即可，
    // 不必再下载回写，快也不会因为关页面/断线丢图。字节就用刚提交给 finish 的那份。
    try {
      const row = (await management.get('SELECT user_id, parameters FROM generations WHERE id=?', generationId))
      const userId = row?.user_id
      let directory = request.outputDirectory || ''
      if (!directory) { try { directory = JSON.parse(row?.parameters || '{}').outputDirectory || '' } catch { directory = '' } }
      directory = String(directory).replace(/^\/+|\/+$/g, '')
      if (userId && directory && request.desktopDelivery !== 1 && cloudWorkspaceStorageEnabled()) {
        await forEachAsync(finished, async (artifact, index) => {
          const content = artifacts[index]?.bytes
          if (!content?.length) return
          const mime = String(artifact.mime || artifacts[index]?.mime || 'image/png')
          const extension = mime.split('/')[1] || 'png'
          // 文件名固定用 artifact id：这样结果接口能直接推导出路径给客户端，不用额外存映射。
          const path = `${directory}/${artifact.id}.${extension}`
          await workspaceFiles.upsert(userId, path, mime, Buffer.from(content), request.workspaceProject || JSON.parse(row.parameters || '{}').workspaceProject || DEFAULT_PROJECT_ID)
          artifact.path = path
        })
      }
    } catch (error) {
      console.warn('[image] 结果写入工作区失败', generationId, error?.message || error)
    }
    try { await syncCanvasGeneration(generationId, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 图片回写待恢复', error?.message) }
    // 上游留档：发出参数、上游返回摘要、用量与成本，供以后从真实账单反推单价。
    try {
      const cost = hasImageLayerPricing(request.generation?.imageLayerPricing)
        ? (await management.recordedGenerationCost((await management.get('SELECT * FROM generations WHERE id=?', generationId))))
        : estimateUpstreamCostRmb({ model: request.model, count: finished.length, parameters: request.generation || {} })
      await management.recordUpstreamCall({
        generationId,
        provider: request.model.provider,
        model: request.model.publicId || request.model.id,
        kind: 'image',
        tier: String(request.generation?.size || ''),
        request: {
          size: request.generation?.size || '', quality: request.generation?.quality || '',
          count: request.generation?.count || 1,
          references: request.generation?.referenceCount ?? (request.references || []).length,
          referenceShapes: (request.references || []).map((item) => summarizeReferenceValue(item.value, { mime: item.mime, bytes: item.bytes?.length })),
          outputFormat: request.generation?.format || '',
          ...mockProviderAudit(env),
        },
        response: { images: artifacts.length, usage: result.usage || null },
        usage: result.usage || null,
        cost,
        upstreamRequestId: result.upstreamRequestId || '',
        status: 'ok',
      })
    } catch { /* 留档失败不影响出图 */ }
    return { images: finished, result }
  } catch (error) {
    if(acceptedTaskId && !error.suiheTerminal) Object.assign(error,{upstreamAccepted:true,submissionUncertain:true,upstreamRequestId:acceptedTaskId})
    if (result) {
      error = new ImageResultError(error, result)
      // Receiving the original result already fences off another POST. Even
      // a failed checkpoint write must enter recovery, which checks both the
      // final directory and complete private temps before declaring it lost.
      error.imageResultPending = true
    }
    // Keep the provider request id visible to the user and to the durable
    // upstream_calls record.  References are summarized by shape/size only;
    // data URI bytes and signed query tokens never enter the diagnostic.
    const upstreamRequestId = String(error?.upstreamRequestId || '').trim()
    const baseMessage = String(error?.message || '图片生成失败')
    const message = upstreamRequestId && !baseMessage.includes(upstreamRequestId)
      ? `${baseMessage}（上游 Request id: ${upstreamRequestId}）`
      : baseMessage
    if (dispatchStarted || result) try {
      await management.recordUpstreamCall({
        generationId,
        provider: request.model.provider,
        model: request.model.publicId || request.model.id,
        kind: 'image',
        tier: String(request.generation?.size || ''),
        request: { references: (request.references || []).map((item) => summarizeReferenceValue(item.value, { mime: item.mime, bytes: item.bytes?.length })) },
        response: result ? { images: receipt?.images.length ?? null, usage: result.usage || null } : null,
        upstreamRequestId,
        status: receipt ? 'submitted' : submissionUncertain(error) ? 'submission_unknown' : error?.upstreamStatus >= 400 && error?.upstreamStatus < 500 ? 'rejected' : 'failed',
        error: `${message}；参考素材=${JSON.stringify((request.references || []).map((item) => referenceUrlShape(item.value)))}`.slice(0, 500),
      })
    } catch { /* 留档失败不能覆盖真正的上游错误。 */ }
    if (message !== baseMessage) error.message = message
    throw error
  } finally {
    clearTimeout(expiryTimer)
  }
}

function resultPayload(request, reservation, images, result, accessToken = '') {
  const securedImages = images.map((image) => ({ ...image, url: accessToken ? `${image.url}?access=${encodeURIComponent(accessToken)}` : image.url }))
  return {
    requestId: reservation.requestId,
    model: request.model.publicId || request.model.id,
    modelLabel: request.model.label,
    size: request.generation.size,
    quality: request.generation.quality,
    editMode: request.edit?.mode || null,
    images: securedImages,
    usage: result.usage,
    cost: reservation.cost || null,
    createdAt: new Date().toISOString(),
    status: GENERATION_STATES.SUCCEEDED,
  }
}

async function generate(payload, session, env = process.env, preparePayload?: (payload: Record<string, any>) => Record<string, any>): Promise<Record<string, any>> {
  const suppliedRequestId = String(payload?.requestId || '').trim()
  const suppliedIdempotencyKey = String(payload?.idempotencyKey || '').trim()
  if (suppliedRequestId && !validRequestId(suppliedRequestId)) throw failure('请求标识无效')
  if (suppliedIdempotencyKey && !validIdempotencyKey(suppliedIdempotencyKey)) throw failure('请求标识无效')
  const accessToken = String(payload?.accessToken || '').trim()
  const existing = (await management.existingGeneration({ session, requestId: suppliedRequestId, idempotencyKey: suppliedIdempotencyKey || suppliedRequestId, accessToken }))
  if (existing) {
    const current = (await management.generationForViewer(existing.requestId, session, existing.accessToken || accessToken))
    if (!current) throw failure('生成记录不存在', 404)
    return generationReceipt(current, {
      accessToken: existing.accessToken || undefined,
      size: current.parameters.size,
      quality: current.parameters.quality,
      editMode: current.parameters.editMode || null,
    })
  }
  // Desktop input leases belong to new admission, never to a status replay.
  await assertModelAccess({ management, session, service: '图片模型' })
  if (preparePayload) payload = (await preparePayload(payload))
  const request = await prepareImageRequest(payload, session, env)
  if (stopping) throw failure('服务正在关闭，请稍后重试', 503)
  request.userId = session?.userId
  request.referenceHistory = normalizeReferenceHistory(payload.referenceHistory)
  request.desktopDelivery = payload.desktopDelivery
  request.desktopReferences = payload.desktopReferences
  request.outputDirectory = safeOutputDirectory(payload.outputDirectory)
  request.workspaceProject = currentProject() || DEFAULT_PROJECT_ID
  const asyncMode = payload.async === true || payload.mode === 'async'
  const requestId = suppliedRequestId || newRequestId()
  const idempotencyKey = suppliedIdempotencyKey || suppliedRequestId || requestId
  const parameters = storedParameters(request)
  const inputs = {
    references: request.references.map((item, index) => ({ ...item, role: request.referenceRoles[index] || 'general' })),
    edit: request.edit,
  }
  const reservation = (await management.reserve({
    session,
    model: request.model,
    points: request.cost.points,
    prompt: String(payload.prompt),
    parameters,
    requestId,
    idempotencyKey,
    status: asyncMode ? GENERATION_STATES.QUEUED : GENERATION_STATES.RUNNING,
    workerId,
    inputs,
    accessToken,
  }))
  try { await syncCanvasGeneration(reservation.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 图片任务绑定待恢复', error?.message) }
  reservation.cost = request.cost
  if (reservation.duplicate) {
    const current = (await management.generationForViewer(reservation.requestId, session, reservation.accessToken || accessToken))
    if (!current) throw failure('生成记录不存在', 404)
    return generationReceipt(current, {
      accessToken: reservation.accessToken || undefined,
      size: current.parameters.size,
      quality: current.parameters.quality,
      editMode: current.parameters.editMode || null,
    })
  }
  if (reservation.status === GENERATION_STATES.QUEUED) {
    void pumpQueue().catch(() => {})
    return { async: true, requestId: reservation.requestId, status: reservation.status, queuePosition: reservation.position, accessToken: reservation.accessToken || undefined, pollAfterMs: 1000, httpStatus: 202 }
  }
  const controller = new AbortController()
  const heartbeat = setInterval(async () => { if (!(await management.heartbeat(reservation.id, workerId))) controller.abort() }, 5000)
  activeControllers.set(reservation.requestId, controller)
  try {
    const { images, result } = await executeGeneration(reservation.id, request, env, controller.signal)
    return resultPayload(request, { ...reservation, cost: request.cost }, images, result, reservation.accessToken)
  } catch (error) {
    if (submissionUncertain(error)) {
      if (error.imageResultPending) await management.deferImageResult(reservation.id, workerId)
      else await management.markSubmissionUncertain(reservation.id, error.message, error, workerId)
      const current = (await management.generationForViewer(reservation.requestId, session, reservation.accessToken))
      const receipt = generationReceipt(current)
      return { ...receipt, ...(receipt.async ? { pollAfterMs: 5000 } : {}) }
    }
    await management.fail(reservation.id, error.message, error, workerId)
    throw error
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(reservation.requestId)
    try { await management.releaseLease(reservation.id, workerId) } catch (error) { console.warn('[image] 执行租约待回收', reservation.id, error?.code || 'unknown') }
  }
}

const workerId = newRequestId()
const activeJobs = new Map()
const activeControllers = new Map()
let pumping: Promise<void> | undefined
let stopping = false

async function runQueuedJob(job, originalReceipt?: StoredImageReceipt) {
  const controller = new AbortController()
  const heartbeat = setInterval(async () => { if (!(await management.heartbeat(job.id, workerId))) controller.abort() }, 5000)
  activeControllers.set(job.request_id, controller)
  try {
    // Queue claims contain decoded parameters; receipt recovery returns a DB row.
    const parameters = typeof job.parameters === 'string' ? JSON.parse(job.parameters || '{}') : job.parameters || {}
    if (originalReceipt) {
      // Delivery uses the admitted snapshot, even if its model/account has
      // since been disabled. No references, keys or new reservation are read.
      const request = { model: modelForGeneration(job.model,parameters,job.provider) || { id: job.model, publicId: job.model, provider: job.provider || '' },
        generation: parameters, outputDirectory: parameters.outputDirectory || '', desktopDelivery: parameters.desktopDelivery,
        workspaceProject: parameters.workspaceProject || DEFAULT_PROJECT_ID, references: [] }
      await executeGeneration(job.id, request, process.env, controller.signal, originalReceipt)
    } else if (modelForGeneration(job.model, parameters, job.provider)?.video) {
      await submitQueuedVideo(job, { management, signal: controller.signal, materializeReference })
    } else {
      await executeGeneration(job.id, requestFromJob(job), process.env, controller.signal)
    }
  } catch (error) {
    if (originalReceipt && !error?.upstreamAccepted) {
      error = new ImageResultError(error, originalReceipt.result)
      error.imageResultPending = true
    }
    if (error.imageResultPending) await management.deferImageResult(job.id, workerId)
    else if (submissionUncertain(error)) await management.markSubmissionUncertain(job.id, error.message, error, workerId)
    else await management.fail(job.id, error.message, error, workerId)
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(job.request_id)
    activeJobs.delete(job.id)
    try { await management.releaseLease(job.id, workerId) } catch (error) { console.warn('[generation] 执行租约待回收', job.id, error?.code || 'unknown') }
    try { await syncCanvasGeneration(job.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 任务终态回写待恢复', error?.message) }
    void pumpQueue().catch(() => {})
  }
}

function startQueuedJob(job, receipt?: StoredImageReceipt) {
  // Register before execution: a synchronous preparation failure must not
  // leave an already-finished promise occupying the worker map forever.
  const running = Promise.resolve().then(() => runQueuedJob(job, receipt))
    .catch(error => console.warn('[generation] 执行收尾待恢复', job.id, error?.code || 'unknown'))
  activeJobs.set(job.id, running)
}

function pumpQueue(): Promise<void> {
  if (candidateMode) return Promise.resolve()
  if (pumping) return pumping
  if (stopping) return Promise.resolve()
  const pending: Promise<void> = Promise.resolve().then(async () => {
    if (stopping) return
    await management.recoverStale()
    // Accepted asynchronous pictures resume their original task even when
    // model admission is paused. Never send a second creation POST.
    for(const row of (await management.all("SELECT id FROM generations WHERE status='running' AND provider='suihe' AND upstream_request_id IS NOT NULL"))) {
      if(stopping||activeJobs.has(row.id)) continue
      const job=(await management.claimAcceptedImage(row.id,workerId))
      if(job) startQueuedJob(job)
    }
    if (!settings().enabled) return
    while (!stopping) {
      const job = (await management.claimNext(workerId))
      if (!job) break
      startQueuedJob(job)
      // Let accepted jobs start and HTTP/heartbeat/shutdown events progress;
      // this is an event-loop yield, not a running-generation count limit.
      await yieldToEventLoop()
    }
  }).finally(() => { if (pumping === pending) pumping = undefined })
  pumping = pending
  return pending
}

const imageRecovery = new ImageReceiptRecovery({
  files: imageReceipts, management, workerId,
  active: (id, requestId) => activeJobs.has(id) || activeControllers.has(requestId),
  capacity: () => !stopping,
  resume: (job, receipt) => startQueuedJob(job, receipt),
})

// Poll accepted upstream tasks even when the browser is closed. The durable DB
// is the work list, so a restart resumes polling without another paid create call.
let videoCollection: Promise<void> | undefined
const videoRestoreAfter = new Map()
function collectVideoResults(): Promise<void> {
  if (candidateMode) return Promise.resolve()
  if (videoCollection) return videoCollection
  if (stopping) return Promise.resolve()
  // Register before dispatch so shutdown also sees a collector whose first
  // provider read has not started yet. Keep the existing single-flight scan.
  const pending: Promise<void> = Promise.resolve().then(async () => {
    if (stopping) return
    const rows = (await management.all("SELECT request_id,user_id,model FROM generations WHERE user_id IS NOT NULL AND status='running' AND upstream_request_id IS NOT NULL"))
    await Promise.allSettled(rows.filter(row => modelById(row.model)?.video).map(async row => {
      const result = await pollVideo({ requestId: row.request_id }, { role: 'user', userId: row.user_id }, { management, workspaceFiles })
      const stored = (await management.get('SELECT id FROM generations WHERE request_id=?', row.request_id))
      if (stored) await syncCanvasGeneration(stored.id, { management, workspaceFiles })
      return result
    }))
    if (stopping) return
    const missing = (await management.all("SELECT g.request_id,g.user_id FROM generations g JOIN video_results v ON v.generation_id=g.id WHERE g.user_id IS NOT NULL AND g.status='succeeded' AND json_extract(v.metadata,'$.workspacePath') IS NULL AND json_extract(g.parameters,'$.desktopDeliveredAt') IS NULL AND json_extract(g.parameters,'$.desktopMediaExpiredAt') IS NULL AND g.finished_at>=? ORDER BY g.finished_at DESC", new Date(Date.now() - 24 * 60 * 60_000).toISOString()))
    await Promise.allSettled(missing.filter(row => Date.now() >= (videoRestoreAfter.get(row.request_id) || 0)).map(row => {
      videoRestoreAfter.set(row.request_id, Date.now() + 60_000)
      return restoreVideoResult({ requestId: row.request_id }, { role: 'user', userId: row.user_id }, { management, workspaceFiles }).then(async result => {
        const stored = (await management.get('SELECT id FROM generations WHERE request_id=?', row.request_id))
        if (stored) await syncCanvasGeneration(stored.id, { management, workspaceFiles })
        return result
      })
    }))
    for (const [id, after] of videoRestoreAfter) if (Date.now() - after > 24 * 60 * 60_000) videoRestoreAfter.delete(id)
  }).finally(() => { if (videoCollection === pending) videoCollection = undefined })
  videoCollection = pending
  return pending
}
const videoCollectorTimer = setInterval(() => { void collectVideoResults().catch(error => console.warn('[video] 结果取回失败', error?.message)) }, 5000)

const desktopMediaTimer = setInterval(async () => { if (candidateMode) return; try { await desktopMedia.sweep() } catch (error) { console.warn('[desktop-media] 暂存回收待重试', error.code || 'unknown') } }, 60_000)
const queueTimer = setInterval(() => { void pumpQueue().catch(() => {}) }, 1000)
const imageReceiptTimer = setInterval(() => { if (!candidateMode) void imageRecovery.collect().catch(error => console.warn('[image] 原图恢复扫描失败', error?.code || 'unknown')) }, 5000)
if (!candidateMode) void imageRecovery.collect().catch(error => console.warn('[image] 初始原图恢复扫描失败', error?.code || 'unknown'))
// 秘塔余额异步落账，按固定间隔取快照并把区间差额与所有 upstream_calls 对照。
// 没配 Key 时函数只返回 unknown，不会阻塞生成；脚本可随时手工补一次快照。
const upstreamReconciliations = new Set<Promise<unknown>>()
function startUpstreamReconcile(): Promise<unknown> {
  if (candidateMode) return Promise.resolve()
  if (stopping) return Promise.resolve()
  const pending: Promise<unknown> = Promise.resolve().then(() => stopping ? undefined : reconcileMetasoBalance({ management }))
    .finally(() => upstreamReconciliations.delete(pending))
  upstreamReconciliations.add(pending)
  return pending
}
const upstreamReconcileTimer = setInterval(() => { void startUpstreamReconcile().catch(error => console.warn('[upstream-reconcile] 余额对账失败', error?.message || error)) }, 15 * 60 * 1000)
void startUpstreamReconcile().catch(error => console.warn('[upstream-reconcile] 初始余额对账失败', error?.message || error))

// 工作区文件落盘后，线上交给 nginx 用 X-Accel-Redirect 直出（sendfile、Range、断点续传都由
// nginx 处理），本地开发没有 nginx 就走下面的 Node 分片读取。两条路径的响应头与
// 200 / 206 / 416 行为完全一致，前端不需要区分。
// 只有 nginx 显式注入 X-Miaoimg-Media-Accel: 1 时才回直出头，所以 nginx 配置和 Node 谁先上线都行；
// 没配 nginx 时这个头永远不出现，也就永远不会退化成空响应。
const MEDIA_ACCEL_PREFIX = '/__media_internal'

function mediaAccelEnabled(request) {
  const setting = String(process.env.OIP_MEDIA_ACCEL || '').trim()
  if (setting === '0' || setting === 'false') return false
  return setting === '1' || setting === 'true' || String(request.headers['x-miaoimg-media-accel'] || '') === '1'
}

// 逐段编码：文件名可能带中文、空格和 %，# 或换行这类字符绝不能进响应头。
// X-Accel-Redirect 的落点要和磁盘布局一致：<MEDIA_ROOT>/<userId>/<projectId>/<相对路径>。
// nginx 那边是 alias /opt/miaoimg/media/，所以这里多一段项目 id 不需要改 nginx 配置。
// 让 nginx 直发字节时，路径**只能有一个来源**：磁盘上文件真实在哪（file.diskPath），
// 去掉媒体根目录就是直发 URI。不要再按 userId/project/path 自己拼一遍——
// 磁盘布局会随库结构变化（有项目列时是 <media>/<用户>/<项目>/<路径>，老库没有项目层），
// 两处各算一份必然对不上，线上曾因此让所有媒体 404（2026-10-06）。
function mediaAccelLocation(file) {
  const root = mediaRoot().replace(/\/+$/, '')
  const absolute = String(file?.diskPath || '')
  if (!absolute.startsWith(root + '/')) throw failure('媒体路径异常', 500)
  const relative = absolute.slice(root.length + 1)
  return `${MEDIA_ACCEL_PREFIX}/${relative.split('/').map(encodeURIComponent).join('/')}`
}

// 工作区参考素材（询价与桌面提交的 referenceFiles）所属项目：不传一律落到默认项目。
// 传了就必须是这个账号自己的项目：别人的 id 和不存在的 id 一样回 404，不泄露存在性。
async function resolveWorkspaceProject(userId, value) {
  const requested = String(value ?? '').trim()
  // 还没迁移到多项目的库：整个库就是默认项目，行为要和迁移前完全一致。
  if (!management.projectScoped) {
    if (requested && requested !== DEFAULT_PROJECT_ID) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
    return DEFAULT_PROJECT_ID
  }
  if (!requested || requested === DEFAULT_PROJECT_ID) return (await management.ensureDefaultProject(userId)).id
  const project = (await management.projectForUser(userId, projectId(requested)))
  if (!project) throw failure('项目不存在', 404)
  return project.id
}

function contentDisposition(path) {
  const name = String(path).split('/').pop() || 'file'
  // filename 给老客户端留纯 ASCII 回退，filename* 让浏览器拿到真实（可能是中文）的名字。
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

// 媒体缓存策略：assets/ 下的文件都是 uuid 命名、写一次不再变，可以长缓存；
// 画布 JSON / agent 记录这类会改的用 no-cache + ETag，让浏览器每次问一下、没变就 304。
// 之前一律 no-store，导致画布每次重渲染都把整张图/整段视频重新下一次，这是"加载慢"的主因。
// 内容寻址：客户端请求带上 `v=<修订号>`，**只有版本号与当前修订号一致时**才准许长缓存
// ——那时这个 URL 指向的字节永远不会再变，浏览器可以一次都不回服务器问。
// 没带版本号、或版本号已经过期（文件被就地改写：视频转封装、文本节点、文档、画布 JSON、Agent 记录），
// 一律 `no-cache`：语义是「每次都带 ETag 回来问一句」，没变就 304、0 字节，变了就拿到新字节。
// 这样「URL 不变 ⇒ 字节不变」在任何文件类型上都成立，不需要按扩展名逐个维护白名单。2026-10-06 起。
const IMMUTABLE_CACHE = 'private, max-age=31536000, immutable'
const REVALIDATE_CACHE = 'private, no-cache'
function versionedCacheControl(version, revision) {
  const requested = String(version || '')
  return requested && requested === String(revision || '') ? IMMUTABLE_CACHE : REVALIDATE_CACHE
}

// 鉴权与归属校验在调用方完成，这里只负责把已经确认可见的文件发出去。
async function sendWorkspaceFile(request, response, userId, file, { cacheControl = '', version = '', extraHeaders = {} }: Record<string, any> = {}) {
  const policy = cacheControl || versionedCacheControl(version, file.revision)
  const etag = `"${String(file.revision || '').replace(/"/g, '')}"`
  const common = {
    'content-type': file.mime,
    'content-disposition': contentDisposition(file.path),
    'cache-control': policy,
    etag,
    'accept-ranges': 'bytes',
    'x-workspace-revision': file.revision,
    ...extraHeaders,
    ...fileContentHeaders(file.mime),
  }
  // Nginx keeps serving disk bytes directly; only the shared preconditions run
  // here. Its own range filter handles accelerated GET responses.
  if (request.method === 'GET' && file.diskPath && mediaAccelEnabled(request)) {
    const condition = filePreconditionStatus(request, etag)
    response.writeHead(condition || 200, { ...common,
      ...(condition === 304 ? {} : { 'content-length': 0 }),
      ...(!condition ? { 'x-accel-redirect': mediaAccelLocation(file) } : {}),
    })
    response.end()
    return
  }
  const sent = await serveFileContent(request, response, file, { headers: common, etag })
  if (!sent) throw failure('文件不存在', 404)
}

// 包一层：进入处理器之前把当前项目挂到请求的异步上下文上（见 server/workspace-scope.ts）。
// MCP 与生成链路靠这一层拿到同一个「当前项目」，不用各自加参数。
const incomingRequests = new HttpIncomingRequests('服务正在关闭，请稍后重试', true)
const server = createServer(withRequestProject(async (request, response) => {
  let incoming
  try { incoming = incomingRequests.begin(request, response) }
  catch (error) {
    // Admission is sealed before any session/database lookup during shutdown.
    response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    response.end(JSON.stringify({ ok: false, error: error.message }))
    return
  }
  try { await errorExplanations.withViewer(
  (await management.session(cookieToken(request))) || (await management.session(cookieToken(request, 'miao_admin'))),
  (request.url || '').split('?')[0] === '/api/imagine/error-explanation',
  async () => {
 try {
  // Resolve request scope inside the HTTP error boundary, before routing.
  currentProject()
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
  candidateRequestAllowed(request.method || 'GET', url.pathname)
  const session = (await management.session(cookieToken(request))) || (await management.session(cookieToken(request, 'miao_admin')))
  const operation = requestOperation(url.pathname, request.method || 'GET')
  if (operation) await enforceRequestLimit(request, session, operation)
  if (await desktopModel(request, response, session, url, { management, readJson, mutation })) return
  if (await desktopWeb(request, response, session, url, { management, readJson, mutation })) return
  // 参考素材只读链接：上游按签名直接抓取，不要求登录（token 已绑定用户、路径和过期时间）。
  if (url.pathname === '/api/imagine/reference' && request.method === 'GET') {
    const resolved = verifyReferenceToken((await management.referenceSecret()), url.searchParams.get('t'))
    if (!resolved) throw failure('参考资源链接无效或已过期', 410)
    const file = (await workspaceFiles.locate(resolved.userId, resolved.path, resolved.project))
    if (resolved.revision && resolved.revision !== file.revision) throw failure('参考素材已更新，请重新获取链接', 409)
    if (!isReferenceMediaMime(file.mime)) throw failure('参考资源类型不受支持', 415)
    await sendWorkspaceFile(request, response, resolved.userId, file, { cacheControl: 'private, max-age=300' })
    return
  }
   if (url.pathname === '/api/imagine/session' && request.method === 'GET') {
     await json(response,200,{session:(await publicSession(viewerSession(session))),requireLogin:(await management.settings()).requireLogin}); return
   }
  if (url.pathname === '/mcp') {
    if (await mcpApi.handleMcp(request, response, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/mcp/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await mcpApi.handleControl(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/ai/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await aiCompat.handle(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname === '/api/imagine/mcp') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (request.method === 'GET') { await json(response, 200, { ok: true, ...(await management.mcpTokenInfo(session.userId)) }); return }
    if (request.method === 'PUT') {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
      const payload = await readJson(request, SMALL_BODY_BYTES)
      const info = (await management.setMcpEnabled(session.userId, payload.enabled))
      if (!payload.enabled) mcpApi.disconnectUser(session.userId)
      await json(response, 200, { ok: true, ...info }); return
    }
    if (request.method === 'POST') {
      // 画布内发起的同源请求（带自定义头），用同源校验替代 CSRF 令牌。
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
      const token = (await management.rotateMcpToken(session.userId))
      mcpApi.disconnectUser(session.userId)
      await json(response, 200, { ok: true, ...token, ...(await management.mcpTokenInfo(session.userId)) })
      return
    }
  }
  const desktopReference = /^\/api\/imagine\/desktop\/references\/([a-f0-9]{64}\.[a-z0-9]{1,8})$/.exec(url.pathname)
  if (desktopReference && ['POST', 'PUT'].includes(request.method)) {
    if (session?.role !== 'user') throw failure('请先登录账号', 401)
    mutation(request, session)
    const mime = String(request.headers['content-type'] || '').split(';')[0]
    const staged = request.method === 'PUT'
      ? await desktopMedia.stageStream(session.userId, desktopReference[1], mime, request)
      : (await desktopMedia.stage(session.userId, desktopReference[1], mime))
    await json(response, 200, { ok: true, ...staged }); return
  }
  const delivered = /^\/api\/imagine\/desktop\/tasks\/([A-Za-z0-9_-]+)\/delivered$/.exec(url.pathname)
  if (delivered && request.method === 'POST') {
    if (session?.role !== 'user') throw failure('请先登录账号', 401)
    mutation(request, session)
    const payload = await readJson(request, 64 * 1024)
    await json(response, 200, { ok: true, ...await desktopMedia.delivered(session.userId, delivered[1], payload.results) }); return
  }
  if (url.pathname === '/api/imagine/login-password' && request.method === 'POST') {
    sameOrigin(request); await loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const key = String(payload.email || '').trim().toLowerCase()
    // 同一邮箱连续输错密码就暂停密码登录，改用验证码，防止猜密码。
    const failed = passwordFailures.get(key)
    if (failed && failed.count >= PASSWORD_FAILURE_LIMIT && Date.now() < failed.until) throw failure('密码错误次数过多，请用验证码登录，或 15 分钟后再试', 429)
    let next
    try { next = (await management.loginPassword(payload.email, payload.password)) }
    catch (error) {
      if (error?.status === 401 && key) {
        const count = (failed && Date.now() < failed.until ? failed.count : 0) + 1
        passwordFailures.set(key, { count, until: Date.now() + PASSWORD_FAILURE_WINDOW_MS })
        if (passwordFailures.size > 10000) passwordFailures.delete(passwordFailures.keys().next().value)
      }
      throw error
    }
    passwordFailures.delete(key)
    await json(response, 200, { session: (await publicSession(next)) }, { 'set-cookie': sessionCookie(request, next.token) }); return
  }
  if (url.pathname === '/api/imagine/password/reset' && request.method === 'POST') {
    sameOrigin(request); await loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const next = (await emailOtp.resetPassword(payload.email, payload.code, payload.password))
    passwordFailures.delete(String(payload.email || '').trim().toLowerCase())
    await json(response, 200, { session: (await publicSession(next)) }, { 'set-cookie': sessionCookie(request, next.token) }); return
  }
  if (url.pathname === '/api/imagine/email/config' && request.method === 'GET') {
    await json(response, 200, emailOtp.config()); return
  }
  if (url.pathname === '/api/imagine/email/request-code' && request.method === 'POST') {
    sameOrigin(request); await loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const result = await emailOtp.request(payload.email)
    await json(response, 200, { ok: true, cooldown: result.cooldown }); return
  }
  if (url.pathname === '/api/imagine/email/verify-code' && request.method === 'POST') {
    sameOrigin(request); await loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const next = (await emailOtp.verify(payload.email, payload.code, payload.name, payload.password))
    await json(response, 200, { session: (await publicSession(next)) }, { 'set-cookie': sessionCookie(request, next.token) }); return
  }
  if (url.pathname === '/api/imagine/profile' && request.method === 'POST') {
    mutation(request, session)
    if (session.role !== 'user') throw failure('请先登录账号', 403)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    if ((await management.session(cookieToken(request)))?.userId !== session.userId) throw failure('会话失效，请重新登录', 401)
    await management.updateProfile(session.userId, payload?.name)
    await json(response, 200, { session: (await publicSession(session)) })
    return
  }
  if (url.pathname === '/api/imagine/password' && request.method === 'POST') {
    mutation(request,session)
    if (session.role !== 'user') throw failure('只有普通用户可以修改密码', 403)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const next = (await management.changePassword(session.userId, payload.currentPassword, payload.newPassword, (await management.user(session.userId))?.email || 'user'))
    await json(response,200,{session:(await publicSession(next))},{'set-cookie':sessionCookie(request,next.token)})
    return
  }
  if (url.pathname === '/api/imagine/logout' && request.method === 'POST') {
    // Already expired/revoked sessions can still clear their browser cookie.
    // Active sessions keep the original same-origin and CSRF protection.
    if (session) mutation(request, session)
    else sameOrigin(request)
    await management.logout(cookieToken(request))
    await json(response, 200, { ok: true }, { 'set-cookie': sessionCookie(request, '', true) })
    return
  }
  if (url.pathname === '/api/imagine/payment/notify' && request.method === 'GET') {
    await handlePaymentNotify(url, response)
    return
  }
  if (url.pathname === '/api/imagine/payment/return' && request.method === 'GET') {
    const order = (await management.paymentOrderForReturn(url.searchParams.get('out_trade_no') || ''))
    const body = paymentReturnPage(order)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) })
    response.end(body)
    return
  }
  if (url.pathname === '/api/imagine/payment/orders' && request.method === 'POST') {
    mutation(request, session)
    const order = await createPaymentOrder(await readJson(request, SMALL_BODY_BYTES), session, request)
    await json(response, 201, paymentOrderPayload(order))
    return
  }
  const paymentQrMatch = /^\/api\/imagine\/payment\/orders\/([A-Za-z0-9_-]{1,32})\/qrcode$/.exec(url.pathname)
  if (paymentQrMatch && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const order = (await management.paymentOrderForUser(decodeURIComponent(paymentQrMatch[1]), session.userId))
    if (!order) { await json(response, 404, { ok: false, error: '充值订单不存在' }); return }
    if (order.status !== 'created') {
      const expired = order.status === 'expired'
      await json(response, 410, { ok: false, status: order.status, error: expired ? '二维码已过期，请重新发起充值' : '二维码已失效，请重新发起充值' })
      return
    }
    if (!order.img) { await json(response, 404, { ok: false, error: '订单未提供图片二维码' }); return }
    try {
      const image = await paymentQrImage(order)
      const currentOrder = (await management.paymentOrderForUser(order.outTradeNo, session.userId))
      if (!currentOrder || currentOrder.status !== 'created') {
        const expired = currentOrder?.status === 'expired'
        await json(response, 410, { ok: false, status: currentOrder?.status || 'expired', error: expired ? '二维码已过期，请重新发起充值' : '二维码已失效，请重新发起充值' })
        return
      }
      const remaining = Math.max(1, Math.floor((Date.parse(order.expiresAt) - Date.now()) / 1000))
      response.writeHead(200, {
        'content-type': image.mime,
        'cache-control': `private, max-age=${Math.min(60, remaining)}`,
        'content-length': image.bytes.length,
        'content-disposition': 'inline',
        'x-content-type-options': 'nosniff',
      })
      response.end(image.bytes)
    } catch (error) {
      await json(response, error.status || 502, { ok: false, error: error.message || '付款二维码暂时无法读取' })
    }
    return
  }
  const paymentOrderMatch = /^\/api\/imagine\/payment\/orders\/([A-Za-z0-9_-]{1,32})$/.exec(url.pathname)
  if (paymentOrderMatch && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const order = (await management.paymentOrderForUser(decodeURIComponent(paymentOrderMatch[1]), session.userId))
    if (!order) { await json(response, 404, { ok: false, error: '充值订单不存在' }); return }
    await json(response, 200, paymentOrderPayload(order))
    return
  }
  // 视频内容同源代理：上游地址可能要求 Bearer Key、跨域，或只对服务端可读，
  // 浏览器只拿得到自己的账号地址。所有通道统一走这里，画布才能把成片持久化到工作区。
  if (url.pathname === '/api/imagine/video-content' && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const requestId = String(url.searchParams.get('requestId') || '').trim()
    const existing = requestId ? (await management.existingGeneration({ session, requestId })) : null
    const record = existing ? (await management.generationForViewer(requestId, session)) : null
    const video = existing ? (await management.videoResult(existing.id)) : null
    const model = record ? modelForGeneration(record.model,{},existing.provider) : null
    if (!video || !model || !model.video) throw failure('视频内容不存在', 404)
    if (record.parameters?.desktopDeliveredAt || record.parameters?.desktopMediaExpiredAt || record.parameters?.cloudWorkspaceRetiredAt) throw failure('服务器临时文件已清理，请打开本机保存的结果', 410)
    if (video.metadata?.workspacePath) {
      try {
        const project = record.parameters?.workspaceProject || DEFAULT_PROJECT_ID
        const file = (await workspaceFiles.locate(session.userId, video.metadata.workspacePath, project))
        await sendWorkspaceFile(request, response, session.userId, file, { version: url.searchParams.get('v') })
        return
      } catch (error) { if (Number(error?.status) !== 404) throw error }
    }

    let target = String(video.metadata?.upstreamUrl || video.url || '').trim()
    const providerConfig = model.provider === 'suihe'
      ? suiheSettings(process.env)
      : model.provider === 'metaso'
      ? metasoVideoSettings(process.env)
      : model.provider === 'ark'
      ? arkVideoSettings(process.env)
      : videoSettings(process.env, model)
    const configuredBase = String(providerConfig.baseUrl || '').replace(/\/$/, '')
    if (model.provider === 'grok' && target.startsWith('/')) {
      const resolved = new URL(target, configuredBase)
      if (resolved.origin !== new URL(configuredBase).origin || resolved.pathname !== `/v1/videos/${encodeURIComponent(video.id)}/content`) throw failure('视频上游返回了不匹配的成片地址', 502)
      target = resolved.toString()
    }
    if (!/^https?:\/\//.test(target)) throw failure('视频内容地址无效', 502)
    assertProviderRequestAllowed(model.provider, target, process.env)
    await proxyVideoContent(request, response, { target, provider: model.provider, providerConfig, mime: video.mime })
    return
  }
  const videoMatch = /^\/api\/imagine\/video\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (videoMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(videoMatch[1])
    const accessToken = url.searchParams.get('access') || ''
    try {
      const result = await pollVideo({ requestId, accessToken }, session, { management, env: process.env, workspaceFiles })
      const stored = (await management.get("SELECT id FROM generations WHERE request_id=?", requestId))
      if (stored) try { await syncCanvasGeneration(stored.id, { management, workspaceFiles }) } catch (error) { console.warn("[canvas] 视频结果回写待恢复", error?.message) }
      await json(response, result.httpStatus || (result.status === 'succeeded' ? 200 : 202), { ok: true, balance: (await viewerBalance(session)), ...result })
    } catch (error) {
      const code = Number(error.status)
      await json(response, Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, { ok: false, error: error.message || '视频状态读取失败' })
    }
    return
  }
  // 画布在用户点生成之前问「这次会扣多少积分」。这条路径和真正下单共用
  // prepareVideoRequest（含服务端 ffprobe 读参考素材真实时长），所以返回的数字
  // 就是下单时预扣的数字；不占额、不创建生成任务，穗禾会调用无生成报价接口。
  if (url.pathname === '/api/imagine/video/estimate' && request.method === 'POST') {
    if (!session) throw failure('请先登录', 401)
    sameOrigin(request)
    try {
      // 管理端是独立进程：询价前先读生效设置，后台刚改的视频价和下单扣费一致。
      const payload = await bodyJson(request)
      const estimate = await estimateVideoCredits(payload, session, { management, env: process.env, probeReferenceMedia, signal: incoming.signal })
      await json(response, 200, { ok: true, ...estimate, billingSource: estimate.breakdown?.billingSource || 'parameter_reserve', source: 'estimateGenerationCost + prepareVideoRequest' })
    } catch (error) {
      await json(response, Number(error.status) || 502, { ok: false, error: error.message || '积分估算失败' })
    }
    return
  }
  // 图片画布在用户点生成前只询价，不占额、不调用上游。校验和真正下单
  // 共用 validateRequest；计费函数也拿同一份 management.costPolicy，避免
  // 前端目录价或另一套尺寸特判与 reserve() 漂移。
  if (url.pathname === '/api/imagine/estimate' && request.method === 'POST') {
    if (!session) throw failure('请先登录', 401)
    sameOrigin(request)
    try {
      const payload = await readJson(request, MAX_BODY_BYTES)
      const policy = (await management.costPolicy())
      const request_ = await prepareImageRequest(payload, session, process.env)
      const modelId = request_.model.publicId || request_.model.id
      const policyPrice = policy.models?.[modelId]
      const cost: any = estimateGenerationCost({ model: request_.model, generation: request_.generation, referenceCount: request_.references.length, price: policyPrice })
      const perImage = Number(cost.breakdown?.perImage)
      if (!policyPrice || !Number.isFinite(perImage) || perImage <= 0 || !Number.isFinite(Number(cost.points)) || Number(cost.points) <= 0) {
        await json(response, 200, { ok: true, model: modelId, size: request_.generation.size, count: cost.count, points: null, perImage: null, breakdown: cost.breakdown, billingSource: 'parameter_reserve', policyVersion: cost.policyVersion, pricingAvailable: false, source: 'estimateGenerationCost + management.costPolicy' })
      } else {
        await json(response, 200, {
          ok: true,
          model: modelId,
          size: request_.generation.size,
          count: cost.count,
          perImage,
          points: cost.points,
          breakdown: cost.breakdown,
          billingSource: 'parameter_reserve',
          policyVersion: cost.policyVersion,
          pricingAvailable: Boolean(policyPrice),
          source: 'estimateGenerationCost + management.costPolicy',
        })
      }
    } catch (error) {
      await json(response, Number(error.status) || 502, { ok: false, error: error.message || '积分估算失败' })
    }
    return
  }
  if (url.pathname === '/api/imagine/desktop/video' && request.method === 'POST') {
    if (session) mutation(request, session)
    else sameOrigin(request)
    try {
      const body = await bodyJson(request)
      delete body.desktopDelivery; delete body.desktopReferences
      const result = await withWorkspaceProject(DEFAULT_PROJECT_ID, () => createVideo(body, session, { management, env: process.env, probeReferenceMedia, signal: incoming.signal,
        preparePayload: async payload => (await desktopMedia.prepare(payload, session)) }))
      const stored = (await management.get('SELECT id FROM generations WHERE request_id=?', result.requestId))
      if (stored) try { await syncCanvasGeneration(stored.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 视频任务绑定待恢复', error?.message) }

      void pumpQueue().catch(() => {})
      await json(response, result.httpStatus || 202, { ok: true, ...result })
    } catch (error) {
      await json(response, error.status || 502, { ok: false, error: error.message || '视频任务创建失败', ...(error.activeRequestId ? { activeRequestId: error.activeRequestId } : {}) })
    }
    return
  }
  if (url.pathname === '/api/imagine/error-explanation' && request.method === 'POST') {
    await assertTextAccess({ management, session })
    mutation(request, session)
    const payload = await readJson(request, 4096)
    await assertTextAccess({ management, session })
    const explanation = await errorExplanations.explain(payload, session, request.headers['accept-language'])
    if (!explanation) { await json(response, 404, { ok: false, error: '说明暂时无法读取，请查看原任务' }); return }
    await json(response, 200, { ok: true, errorExplanation: explanation })
    return
  }
  if (await shortTextApi.handle(request, response, session, url)) return
  const generationMatch = /^\/api\/imagine\/generation\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (generationMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(generationMatch[1])
    const accessToken = url.searchParams.get('access') || ''
    const generation = (await management.generationForViewer(requestId, session, accessToken))
    if (!generation) { await json(response, 404, { ok: false, error: '生成记录不存在' }); return }
    await json(response, generation.status === GENERATION_STATES.EXPIRED ? 410 : 200, { ok: true, balance: (await viewerBalance(session)), ...generation })
    return
  }
  const cancelMatch = /^\/api\/imagine\/generation\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname)
  if (cancelMatch && request.method === 'POST') {
    const accessToken = url.searchParams.get('access') || ''
    if (session) mutation(request, session)
    else sameOrigin(request)
    const requestId = decodeURIComponent(cancelMatch[1])
    const generation = (await management.cancel(requestId, session, accessToken))
    if (!generation) { await json(response, 404, { ok: false, error: '生成记录不存在' }); return }
    activeControllers.get(requestId)?.abort()
    await json(response, 200, { ok: true, ...generation })
    return
  }
  // 用户反馈：桌面端「反馈」页。只能看和改自己提交的反馈。
  if (url.pathname === '/api/imagine/feedback' || url.pathname.startsWith('/api/imagine/feedback/')) {
    if (!session?.userId) throw failure('请先登录后再提交反馈', 401)
    const [, id, action, attachmentId] = /^\/api\/imagine\/feedback(?:\/([a-f0-9-]{36}))?(?:\/(comments|status|attachments))?(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname) || []
    if (url.pathname !== '/api/imagine/feedback' && !id) throw failure('反馈接口不存在', 404)
    if (!id && request.method === 'GET') { await json(response, 200, (await feedback.listForUser(session.userId, url.searchParams.get('status') || 'all'))); return }
    if (!id && request.method === 'POST') { mutation(request, session); await json(response, 201, (await feedback.create(session.userId, await readJson(request, 24 * 1024 * 1024)))); return }
    if (id && !action && request.method === 'GET') { await json(response, 200, (await feedback.getForUser(session.userId, id))); return }
    if (id && !action && request.method === 'DELETE') { mutation(request, session); await json(response, 200, (await feedback.deleteForUser(session.userId, id))); return }
    if (action === 'comments' && request.method === 'POST') { mutation(request, session); await json(response, 200, (await feedback.commentAsUser(session.userId, id, (await readJson(request, SMALL_BODY_BYTES)).body))); return }
    if (action === 'status' && request.method === 'POST') { mutation(request, session); await json(response, 200, (await feedback.setStatusAsUser(session.userId, id, (await readJson(request, SMALL_BODY_BYTES)).status))); return }
    if (action === 'attachments' && attachmentId && request.method === 'GET') {
      const file = (await feedback.attachment(id, attachmentId, session.userId))
      response.writeHead(200, { 'content-type': file.mime, 'content-length': file.size, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
      response.end(Buffer.from(file.bytes)); return
    }
    throw failure('反馈接口不存在', 404)
  }
  if (url.pathname === '/api/imagine/ledger' && request.method === 'GET') {
    if(!session?.userId)throw failure('请先登录',401)
    {
      // 区间由客户端给（用它本地的月初/月末），服务端不猜时区；subset 小结按全量算，不受 200 条上限影响。
      const ledger = (await management.ledgers(session.userId, { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' }))
      await json(response,200,{
        items: ledger.rows.map((row)=>({delta:row.delta,reason:row.reason,createdAt:row.created_at,paymentOrderId:row.payment_order_id || null})),
        ...(ledger.summary ? { summary: ledger.summary } : {}),
      });return
    }
  }
  if (request.method === 'GET' && url.pathname === '/health') {
      const env = process.env
      const cfg = settings(env)
      const payments = paymentConfig(env)
      await json(response, 200, {
      ok: true,
      defaultModel: modelById(defaultModel(env))?.publicId || defaultModel(env),
       generationEnabled: cfg.enabled,
       videoEnabled: (await management.settings()).videoEnabled,
        configured: Boolean(cfg.enabled),
        payment: publicPaymentConfig(payments),
      })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/imagine/image') {
    await proxyImage(request, response, url.searchParams.get('url') || '', { json })
    return
  }
  if (request.method === 'GET' && url.pathname.startsWith('/api/imagine/result/')) {
    const id = url.pathname.slice('/api/imagine/result/'.length)
    const accessToken = url.searchParams.get('access') || ''
    const entry: any = (await management.artifact(id,session,accessToken))
    if (!entry) { await json(response, 410, { ok: false, error: '图片读取地址已过期，请使用已保存的素材' }); return }
    if (entry.remoteUrl) { await proxyImage(request, response, entry.remoteUrl, { json }); return }
    // 结果字节和工作区媒体走同一套直出/Range/缓存策略。老库仍可能只有
    // DB bytes，sendWorkspaceFile 会自动退回 Node；迁移后的结果由 nginx X-Accel 直发。
    await sendWorkspaceFile(request, response, entry.ownerId || '', {
      path: `result/${id}`,
      mime: entry.mime,
      revision: id,
      size: entry.size,
      diskPath: entry.diskPath || null,
      bytes: entry.bytes || null,
    }, { cacheControl: IMMUTABLE_CACHE })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/imagine/config') {
    const env = process.env
    await refreshSuiheModels({env}).catch(() => [])
    const cfg = settings(env)
    const payments = paymentConfig(env)
    const operating = (await management.settings())
    let publicDefaultModel = operating.defaultModel
    const costPolicy = (await management.costPolicy())
    // 管理员对单个用户勾选的可用模型：空列表 = 全部开放；勾选后目录里其余模型直接不下发，
    // 画布节点与服务端看到的目录保持一致，reserve() 仍会再校验一次。
    const sessionUser = session?.role === 'user' && session.userId ? (await management.user(session.userId)) : null
    const userModels = Array.isArray(sessionUser?.models) ? sessionUser.models : []
    const allowedForUser = (id) => !userModels.length || userModels.includes(id)
    const models = publicModelCatalog(env, operating).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id)).map((model) => {
      // publicModelCatalog deliberately removes the provider marker before it
      // reaches the client. Pricing still needs the internal provider
      // snapshot, otherwise Suihe SD models fall back to their old Ark price
      // in the quote shown by the canvas.
      const pricingModel = activeModelForSettings(model.id, operating, env) || model
      return ({
      ...model,
      current: model.id === publicDefaultModel,
      paused: false,
      configured: model.configured,
      creditsPerImage: imageCreditsPerImage(pricingModel),
      creditsPerImageBySize: imageCreditsBySize(pricingModel),
    })
    })
    // 视频模型带上每个分辨率/秒数的积分规则，画布直接显示“当前参数预计消耗”。
    const videoModels = publicVideoCatalog(env, operating).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id)).map((model) => ({
      ...model,
      paused: false,
      configured: model.configured,
      creditsPerSecond: costPolicy.models?.[model.id]?.creditsPerSecond || { default: 0.5 },
      minimumCredits: costPolicy.models?.[model.id]?.minimumCredits ?? 0.1,
      inputPricing: costPolicy.models?.[model.id]?.inputPricing || null,
      billingMode: costPolicy.models?.[model.id]?.billingMode || 'parameter_estimate',
        pricingNotice: costPolicy.models?.[model.id]?.pricingNotice || '',
    }))
    const textCatalog = (await publicTextCatalog(env)).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id))
    publicDefaultModel = models.find(model => model.id === publicDefaultModel)?.id || models[0]?.id || ''
    for (const model of models) model.current = model.id === publicDefaultModel
    const publicDefaultTextModel = textCatalog.find(model => model.id === operating.defaultTextModel)?.id || textCatalog[0]?.id || ''
    await json(response, 200, {
      defaultModel: publicDefaultModel,
      defaultTextModel: publicDefaultTextModel,
      modelLabel: modelById(publicDefaultModel)?.label || '',
      generationEnabled: cfg.enabled && operating.enabled && models.some((model) => model.configured),
      videoEnabled: operating.videoEnabled,
      videoModels,
      requireLogin: operating.requireLogin,
      desktop: DESKTOP_MEDIA_CAPABILITIES,
      registrationEnabled: operating.registrationEnabled,
      session: (await publicSession(viewerSession(session))),
      models,
      // 供应商和内部通道只留在服务端；公开目录只返回可选模型 ID/名称。
      textModels: textCatalog.map(({ provider: _provider, providerLabel: _providerLabel, ...model }: Record<string, any>) => ({ ...model, configured: textChannelReady(env, model.id) })),
      textEnabled: textCatalog.some((model) => textChannelReady(env, model.id)) && operating.enabled,
      modelDefaults: Object.fromEntries([...models, ...videoModels].map((model) => [model.id, defaultsFor(model.id, activeModelForSettings(model.id, operating, env))])),
      payment: publicPaymentConfig(payments),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/imagine/desktop/generate') {
    try {
      if (session) mutation(request,session)
      else sameOrigin(request)
      const body = await readJson(request)
      delete body.desktopDelivery; delete body.desktopReferences
      const result = await withWorkspaceProject(DEFAULT_PROJECT_ID, () => generate(body, session, process.env, async payload => (await desktopMedia.prepare(payload, session))))
      const { httpStatus = 200, ...payload } = result
      await json(response, httpStatus, { ok: true, ...payload, ...(payload.images?.[0] ? { image: payload.images[0] } : {}) })
    } catch (error) {
      if (!response.headersSent) await json(response, error.status || 500, { ok: false, error: error.message || '生成失败', ...(error.code ? { code: error.code } : {}), ...(error.queue ? { queue: error.queue } : {}), ...(error.activeRequestId ? { activeRequestId: error.activeRequestId } : {}) })
    }
    return
  }
  await json(response, 404, { error: 'not found' })
 } catch(error) { if(!response.headersSent)await json(response,error.status || 500,{ok:false,error:error.status?error.message:'服务暂时不可用，请重试'}); else response.destroy() }
}) } finally { incoming.finish() }
}))

server.listen(PORT, HOST, () => {
  console.log(`Image generation API listening on http://${HOST}:${PORT}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    const aiStopped = Promise.allSettled([aiCompat.stop(), shortTextApi.stop()])
    const mcpStopped = Promise.allSettled([mcpApi.stop()])
    const httpStopped = incomingRequests.stop()
    errorExplanations.stop()
    clearInterval(desktopMediaTimer)
    clearInterval(queueTimer)
    clearInterval(imageReceiptTimer)
    const receiptRecoveryStopped = imageRecovery.stop()
    clearInterval(videoCollectorTimer)
    clearInterval(upstreamReconcileTimer)
    const backgroundStopped = Promise.allSettled([pumping, videoCollection, ...upstreamReconciliations])
    for (const controller of activeControllers.values()) controller.abort()
    server.close(async () => {
      await Promise.allSettled([...activeJobs.values(), receiptRecoveryStopped, aiStopped, mcpStopped, httpStopped, backgroundStopped])
      await redisRuntime.close()
      await management.close()
      process.exit(0)
    })
  })
}
