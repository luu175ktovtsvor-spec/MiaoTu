import { createDesktopMedia } from './desktop-media.ts'
import { proxyVideoContent } from './video-content-proxy.ts'
import { IMAGE_PROXY_MAX_BYTES, isAllowedImageProxyUrl, proxyImage } from './image-content-proxy.ts'
import { isWorkspaceRequest } from './canvas-document.ts'
import { desktopModel } from './desktop-model.ts'
import { desktopWeb } from './desktop-web.ts'
import { normalizeReferenceHistory } from './user-prompts.ts'
import { userFacingError, explainUserError } from './user-errors.ts'
import { createErrorExplanations } from './error-explanation.ts'
import { syncCanvasGeneration } from './canvas-generation.ts'
import { appendUpload, uploadStatus, UPLOAD_CHUNK_BYTES } from './workspace-uploads.ts'
import { videoPlayback, stopVideoPlayback } from './video-playback.ts'
import { WorkspaceFiles, WORKSPACE_FILE_MAX_BYTES } from './workspace-files.ts'
import { normalizeVideoBuffer } from './video-normalize.ts'
import { assertReferenceInput, referenceInputPolicy } from './reference-input-contract.ts'
import { DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME, projectId } from './projects.ts'
import { IMAGE_RECEIPT_DIRECTORY, PREVIEW_DIRECTORY, mediaPermissions, mediaRoot, validMediaOwner, writeFileAtomic } from './media-files.ts'
import { withRequestProject, withWorkspaceProject, currentProject } from './workspace-scope.ts'
import { createAgentApi } from './agent-api.ts'
import { resolveRequestLocale, runWithLocale } from './i18n.ts'
import { createMcpApi, mcpSkillMarkdown } from './mcp-api.ts'
import { createNodePlugins } from './node-plugins.ts'
import { createExtPlugins } from './ext-plugins.ts'
import { createPluginExport } from './plugin-export.ts'
import { createFfmpegExec } from './ffmpeg-exec.ts'
import { createAiCompat } from './ai-compat.ts'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { join } from 'node:path'
import {
  defaultModel,
  defaultsFor,
  modelById,
  modelCatalog,
  modelProvider,
  normalizeGeneration,
  providerConfigured,
  publicModelCatalog,
  publicVideoCatalog,
} from './image-models.ts'
import { estimateGenerationCost, estimateUpstreamCostRmb, imageCreditsBySize, imageCreditsPerImage, imagePricingSnapshot } from './generation-cost.ts'
import { editPrompt, validateEdit } from './image-edit-contract.ts'
import { supportedImageMime } from './result-cache.ts'
import { collectImageArtifacts, ImageResultError, readImageArtifact, type ImageResultMetadata } from './image-artifacts.ts'
import { ImageReceiptFiles, imageReceiptBinding, type StoredImageReceipt } from './image-receipt-files.ts'
import { ImageReceiptRecovery } from './image-recovery.ts'
import { ManagementStore, failure } from './management-store.ts'
import { bodyJson, cookieToken, sessionCookie, mutation, sameOrigin, loginRate } from './http-auth.ts'
import { buildArkBody, buildYunshuRequest } from './image-transport.ts'
import { requestImageUpstream } from './image-upstream.ts'
import { withRequestSignal } from './request-lifetime.ts'
import { readBytesRequest, readJsonRequest } from './model-transport.ts'
import { HttpIncomingRequests } from './http-request-lifetime.ts'
import { fileContentHeaders } from './file-content-policy.ts'
import { filePreconditionStatus, serveFileContent } from './file-response.ts'
import { DESKTOP_MEDIA_CAPABILITIES, GENERATION_LIMITS, GENERATION_STATES, generationReceipt, newRequestId, validIdempotencyKey, validRequestId, submissionUncertain } from './generation-contract.ts'
import { compileReferencePrompt, REFERENCE_ROLES } from './creative-contract.ts'
import { createVideo, estimateVideoCredits, pollVideo, restoreVideoResult, safeOutputDirectory, submitQueuedVideo, videoSettings } from './video-api.ts'
import { arkVideoSettings } from './ark-video.ts'
import { metasoVideoSettings, reconcileMetasoBalance } from './metaso-video.ts'
import { paymentConfig, publicPaymentConfig } from './payment-contract.ts'
import { createPaymentService, paymentOrderPayload, paymentReturnPage } from './payments/payment-service.ts'
import { googleOAuthConfig } from './google-oauth.ts'
import { publicTextCatalog, textChannelReady } from './text-models.ts'
import { createShortTextApi } from './short-text-api.ts'
import { createReferenceMaterializer, createReferenceMediaProbe, createMediaBufferProbe, createReferenceToken, isReferenceMediaMime, REFERENCE_TTL_MS, referenceUrlShape, summarizeReferenceValue, verifyReferenceToken } from './reference-assets.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { createEmailOtp } from './email-otp.ts'
import { createOAuthLogin } from './auth/oauth-login.ts'
import { createMediaPreviews, MEDIA_PREVIEW_MIME, MEDIA_PREVIEW_VERSION } from './media-previews.ts'
import { MEDIA_INPUT_VERSION } from './media-input.ts'
import { assertMockProviderConfiguration, assertProviderRequestAllowed, isMockProviderMode, mockProviderAudit } from './provider-safety.ts'
import { assertTextAccess, assertTextIdentity } from './text-access.ts'
import { assertModelAccess } from './model-access.ts'
import {
  fetchProviderModels as fetchUpstreamProviderModels,
  listPublicProviders,
  providerById,
  removeProvider as removeTextProvider,
  upsertProvider as upsertTextProvider,
} from './text-providers.ts'
import { qqOAuthConfig } from './qq-oauth.ts'
import { dingTalkOAuthConfig, githubOAuthConfig, linuxDoOAuthConfig, oidcOAuthConfig, wechatOAuthConfig } from './oauth-extra.ts'

const HOST = process.env.OIP_IMAGE_API_HOST || '127.0.0.1'
const PORT = Number(process.env.OIP_IMAGE_API_PORT || 8788)
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_YUNSHU_BASE_URL = 'https://api.zzyppz.cn/v1'
const MAX_BODY_BYTES = 200 * 1024 * 1024
const SMALL_BODY_BYTES = 256 * 1024
assertMockProviderConfiguration(process.env)
const management = new ManagementStore()
const imageReceipts = new ImageReceiptFiles(join(mediaRoot(), IMAGE_RECEIPT_DIRECTORY), IMAGE_PROXY_MAX_BYTES)
const errorExplanations = createErrorExplanations({ management })
const emailOtp = createEmailOtp({ management })
const oauthLogin = createOAuthLogin({ management })
const { createPaymentOrder, handlePaymentNotify, paymentQrImage } = createPaymentService({ management })
// 生成结果的字节也从库里搬到磁盘（和 workspace_files 同一套做法）：
// 启动时跑一次，幂等可续跑，失败的行留在库里下次重试。
management.artifactFiles().migrateToDisk()
const workspaceFiles = new WorkspaceFiles(management)
workspaceFiles.referenceOwner = userId => management.publicUser(userId).workspaceKey
const desktopMedia = createDesktopMedia({ management, workspaceFiles, publicOrigin: process.env.OIP_PUBLIC_ORIGIN })
workspaceFiles.userMutationGuard = desktopMedia.assertWorkspaceMutation
workspaceFiles.userListFilter = desktopMedia.filterWorkspaceEntries
const probeReferenceMedia = createReferenceMediaProbe({ workspaceFiles, secret: () => management.referenceSecret(), publicOrigin: process.env.OIP_PUBLIC_ORIGIN })
const materializeReference = createReferenceMaterializer({ workspaceFiles, secret: () => management.referenceSecret(), publicOrigin: process.env.OIP_PUBLIC_ORIGIN })
const agentApi = createAgentApi({ management, workspaceFiles, assertTextAccess: (session, { providerId = 'miaoimg' } = {}) => providerId === 'miaoimg' ? assertTextAccess({ management, session }) : assertTextIdentity({ management, session }) })
const mcpApi = createMcpApi({ management, workspaceFiles })
const nodePlugins = createNodePlugins({ workspaceFiles })
const extPlugins = createExtPlugins({ workspaceFiles })
const pluginExport = createPluginExport({ workspaceFiles })
const ffmpegExec = createFfmpegExec({ workspaceFiles, workspaceKey: (userId) => management.publicUser(userId).workspaceKey })
const aiCompat = createAiCompat({ management, workspaceFiles, generate, probeReferenceMedia })
const shortTextApi = createShortTextApi({ management, workspaceFiles })
// 预览生成只在第一次进入历史视口时发生；同一张媒体的并发请求共用一个 Promise。
const mediaPreviews = createMediaPreviews()

// 工作台只认普通用户会话：管理员在 /manage 登录拿到的是独立的 miao_admin cookie。
// 如果把管理员会话也当成"已登录用户"返回，画布会以为自己登录了，但每个用户接口都 401，
// 结果就是输入框被禁用、画布打不开（线上 2026-10-06 复现过）。
// 生成结束后前端要能立刻把顶部的积分数字刷新掉。轮询接口顺带把「扣完之后的余额」
// 带回去，客户端就不用再单独拉一次会话：少一次往返，退款/取消导致的变化也一起覆盖了。
function viewerBalance(session) {
  if (session?.role !== 'user') return null
  const user = management.user(session.userId)
  return user ? Number(user.points) : null
}

function viewerSession(session) {
  return session?.role === 'user' ? session : null
}

function publicSession(session) {
  return session
    ? { role: session.role, csrf: session.csrf, user: session.userId ? management.publicUser(session.userId) : null }
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

function json(response, status, value, headers: Record<string, any> = {}) {
  value = errorExplanations.attach(value, status)
  if (value?.error && (status >= 400 || value.ok === false)) {
    value = { ...value, error: userFacingError(value.error, { status }), errorExplanation: value.errorExplanation || explainUserError(value.error, { status, submissionUncertain: value.submissionUncertain, generationStatus: value.status, chargedPoints: value.chargedPoints, reservedPoints: value.reservedPoints, requestId: value.requestId }) }
  }

  const body = JSON.stringify(value)
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

function readBytes(request, maxBytes = WORKSPACE_FILE_MAX_BYTES) {
  return readBytesRequest(request, { maxBytes, tooLargeMessage: '单个文件不能超过 200MB' })
}

function parseImageData(value, model) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ''))
  if (!match) throw Object.assign(new Error('参考图格式不受支持'), { status: 422 })
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const bytes = Buffer.from(match[2], 'base64')
  if (!bytes.length) throw Object.assign(new Error('参考图内容为空'), { status: 422 })
  const limit = referenceInputPolicy(model, 'image')
  if (!limit.mimes.includes(mime)) throw failure('当前模型不支持这个参考图片格式', 422)
  if (bytes.length > limit.maxBytes) throw failure('单张参考图不能超过 ' + limit.maxBytes / (1024 * 1024) + 'MB；原素材未被压缩', 422)
  return { value, mime, bytes, extension: mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] }
}

const WORKSPACE_REFERENCE_SOURCES = Symbol('workspace-reference-sources')
function resolveImageReferenceFiles(payload, session, env = process.env) {
  if (payload.referenceFiles === undefined) return payload
  if (session?.role !== 'user') throw failure('请使用自己的工作区参考素材', 403)
  const model = modelById(String(payload.model || management.settings().defaultModel || defaultModel(env)).trim())
  if (!model || model.video) throw failure('不支持的图片模型', 422)
  if (!Array.isArray(payload.referenceFiles) || (payload.references !== undefined && (!Array.isArray(payload.references) || payload.references.length))) throw failure('参考素材参数无效', 422)
  if (payload.referenceFiles.length > model.maxReferences) throw failure('当前模型最多支持 ' + model.maxReferences + ' 张参考图', 422)
  const project = resolveWorkspaceProject(session.userId, currentProject())
  const limit = referenceInputPolicy(model, 'image')
  const sources = []
  const references = payload.referenceFiles.map(item => {
    if (!item || typeof item.path !== 'string') throw failure('参考素材路径无效', 422)
    const file = workspaceFiles.stat(session.userId, item.path, project)
    const mime = String(file.mime || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg')
    if (!limit.mimes.includes(mime)) throw failure('当前模型不支持这个参考图片格式', 422)
    if (file.size > limit.maxBytes) throw failure('单张参考图不能超过 ' + limit.maxBytes / (1024 * 1024) + 'MB；原素材未被压缩', 422)
    if (item.revision && item.revision !== file.revision) throw failure('参考素材已更新，请刷新后重新选择', 409)
    const content = workspaceFiles.read(session.userId, item.path, project)
    if (content.revision !== file.revision) throw failure('参考素材已更新，请刷新后重新选择', 409)
    sources.push({ path: file.path, revision: file.revision, project })
    return 'data:' + mime + ';base64,' + content.bytes.toString('base64')
  })
  return { ...payload, references, [WORKSPACE_REFERENCE_SOURCES]: sources }
}

const probeImageBytes = createMediaBufferProbe()
async function prepareImageRequest(payload, session, env = process.env) {
  const resolved = resolveImageReferenceFiles(payload, session, env)
  const request = validateRequest(resolved, env)
  // Actual format/dimensions are read from the original bytes. No thumbnail,
  // canvas draw, or encoder participates in this path.
  for (const reference of request.references) {
    const metadata = await probeImageBytes(reference.bytes, 'image')
    assertReferenceInput(request.model, 'image', { ...metadata, mime: reference.mime })
    reference.metadata = metadata
  }
  if (request.model.provider === 'ark' && resolved[WORKSPACE_REFERENCE_SOURCES]?.length === request.references.length) {
    request.references.forEach((reference, index) => { reference.workspaceSource = resolved[WORKSPACE_REFERENCE_SOURCES][index] })
  }
  return request
}

function validateRequest(payload, env = process.env): Record<string, any> {
  const prompt = String(payload?.prompt || '').trim()
  const layerDecomposition = payload?.layerDecomposition === true
  // 图层拆分允许不写提示词（官方：不传 prompt 时自动拆分主要元素）。
  if (prompt.length < 2 && !layerDecomposition) throw Object.assign(new Error('请先输入画面描述'), { status: 422 })
  const modelId = String(payload?.model || management.settings().defaultModel || defaultModel(env)).trim()
  const model = modelById(modelId)
  if (!model || model.video) throw Object.assign(new Error('不支持的图片模型'), { status: 422 })
  if (!providerConfigured(model.provider, env)) throw Object.assign(new Error(`${model.label} 的服务端 Key 尚未配置`), { status: 503 })
  if (env.ENABLE_MODEL_CALLS !== 'true') throw Object.assign(new Error('模型调用开关未开启'), { status: 503 })
  if (payload.references !== undefined && !Array.isArray(payload.references)) throw failure('参考素材参数无效', 422)
  const references = Array.isArray(payload?.references) ? payload.references : []
  if (references.length > model.maxReferences) throw Object.assign(new Error(`当前模型最多支持 ${model.maxReferences} 张参考图`), { status: 422 })
  const parsedReferences = references.map(value => parseImageData(value, model))
  let generation
  try { generation = normalizeGeneration(model.id, payload) } catch (error) { throw Object.assign(error, { status: 422 }) }
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
  if ((model.publicId || model.id) === 'doubao-seedream-4-0' && parsedReferences.length + generation.count > 15) {
    throw Object.assign(new Error('参考图数量 + 生成张数不能超过 15 张'), { status: 422 })
  }
  // 火山官方透明背景限制：仅图生图、单张带透明通道的输入图、输出 png。
  if (generation.background === 'transparent') {
    if (parsedReferences.length !== 1) throw Object.assign(new Error('透明背景只支持单张参考图的图生图'), { status: 422 })
    if (generation.format !== 'png') throw Object.assign(new Error('透明背景需要输出 png 格式'), { status: 422 })
    if (edit) throw Object.assign(new Error('透明背景不能和局部重绘一起使用'), { status: 422 })
    const reference = parsedReferences[0]
    if (reference.mime === 'image/png') {
      const colorType = reference.bytes[25]
      if (colorType !== 4 && colorType !== 6) throw Object.assign(new Error('透明背景需要输入带透明通道的 png 图片'), { status: 422 })
    }
  }
  const roles = payload.referenceRoles || []
  if (!Array.isArray(roles) || (roles.length && roles.length !== references.length) || roles.some(role => !REFERENCE_ROLES.some(item => item.value === role))) throw failure('参考图分工无效')
  const pricing = management.costPolicy().models[model.publicId || model.id]
  if (!pricing) throw failure('当前模型定价待确认', 503)
  return { prompt: editPrompt(compileReferencePrompt(prompt, roles), edit), referenceRoles: roles, model, edit, references: parsedReferences, generation, cost: estimateGenerationCost({ model, generation, referenceCount: parsedReferences.length, price: pricing }) }
}

async function submitArk(request, env = process.env, signal, fetchImpl = fetch) {
  const config = settings(env).ark
  assertProviderRequestAllowed('ark', config.baseUrl, env)
  // Sign when the queued job actually submits, not when the user asks for
  // a quote. Keep the captured bytes as a lossless fallback if its original
  // workspace path was replaced/deleted meanwhile.
  const origin = String(env.OIP_PUBLIC_ORIGIN || '').replace(/\/$/, '')
  const references = request.references.map(reference => {
    if (!origin || !request.userId || !reference.workspaceSource) return reference
    try {
      const source = reference.workspaceSource
      const file = workspaceFiles.stat(request.userId, source.path, source.project)
      if (file.revision !== source.revision) return reference
      const token = createReferenceToken(management.referenceSecret(), { userId: request.userId, path: file.path, revision: file.revision, project: source.project })
      return { ...reference, value: origin + '/api/imagine/reference?t=' + encodeURIComponent(token) }
    } catch { return reference }
  })
  const body = buildArkBody({ ...request, references }, config)
  return requestImageUpstream(config, { kind: 'json', path: '/images/generations', body }, request.generation, { env, signal, fetchImpl })
}

async function submitYunshu(request, env = process.env, signal, fetchImpl = fetch) {
  const config = request.model.provider === 'grok' ? settings(env).grok : settings(env).yunshu
  assertProviderRequestAllowed(request.model.provider === 'grok' ? 'grok' : 'yunshu', config.baseUrl, env)
  const references = request.model.provider === 'grok' ? request.references.map(item => ({ ...item, value: materializeReference(item.value, request.userId, { kind: 'image', inline: false }).value })) : request.references
  return requestImageUpstream(config, buildYunshuRequest({ ...request, references }), request.generation, { env, signal, fetchImpl })
}

function storedParameters(request) {
  return {
    ...request.generation,
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
  const model = modelById(job.upstream_model || job.model)
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
      referenceCount:parameters.referenceCount,
      format: parameters.format,
      background: parameters.background,
      inputFidelity: parameters.inputFidelity,
      count: parameters.count,
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
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  try {
    signal.throwIfAborted()
    const row = management.get('SELECT * FROM generations WHERE id=?', generationId)
    if (!row || row.status !== GENERATION_STATES.RUNNING || row.lease_id !== workerId) throw failure('原任务已停止执行', 409)
    // Always check disk before dispatch. A crash after publishing the receipt
    // but before updating the task is recoverable without another model POST.
    receipt = await imageReceipts.load(generationId, imageReceiptBinding(row))
    if (originalReceipt && !receipt) throw Object.assign(failure('原图回执缺失，请保留原任务等待核对', 503), { upstreamAccepted: true })
    if (!receipt) {
      const parameters = JSON.parse(row.parameters || '{}')
      if (parameters.imageResultPending || parameters.submissionUncertain || parameters.imageResultExpiredAt) throw Object.assign(failure('原任务等待核对，不会重新生成', 503), { upstreamAccepted: true })
      signal.throwIfAborted()
      if (!management.heartbeat(generationId, workerId)) throw failure('原任务已停止执行', 409)
      const dispatchFetch: typeof fetch = (input, init) => {
        signal.throwIfAborted()
        management.assertGenerationDispatch(generationId, workerId, { markStarted: true })
        dispatchStarted = true
        return fetch(input, init)
      }
      const received = ['yunshu', 'grok'].includes(modelProvider(request.model.id))
        ? await submitYunshu(request, env, signal, dispatchFetch)
        : await submitArk(request, env, signal, dispatchFetch)
      result = received
      receipt = await imageReceipts.write(generationId, imageReceiptBinding(row), received, Date.now() + management.artifactTtlMs(), signal)
    }
    result = receipt.result
    management.noteImageResultPending(generationId, workerId, result)
    const expiry = new AbortController()
    expiryTimer = setTimeout(() => expiry.abort(Object.assign(new Error('原图暂存期已结束'), { code: 'IMAGE_RECEIPT_EXPIRED' })), Math.min(2_147_483_647, Math.max(1, receipt.expiresAt - Date.now())))
    expiryTimer.unref()
    signal = AbortSignal.any([signal, expiry.signal])
    const artifacts = await collectImageArtifacts(receipt.images.map((_, index) => index), (index, receiveSignal) =>
      imageReceipts.artifact(receipt, index, (url, remoteSignal) => readImageArtifact({ url },
        { signal: remoteSignal, allowUrl: isAllowedImageProxyUrl, maxBytes: IMAGE_PROXY_MAX_BYTES, env }), receiveSignal), signal)
    signal.throwIfAborted()
    const finished = management.finish(generationId, artifacts, result, workerId)
    try { await imageReceipts.remove(generationId) } catch (error) { console.warn('[image] 已保存原图的临时回执待清理', generationId, error?.code || 'unknown') }
    // 图片结果由服务端直接写进用户工作区（与视频同一套）：客户端拿路径即可，
    // 不必再下载回写，快也不会因为关页面/断线丢图。字节就用刚提交给 finish 的那份。
    try {
      const row = management.get('SELECT user_id, parameters FROM generations WHERE id=?', generationId)
      const userId = row?.user_id
      let directory = request.outputDirectory || ''
      if (!directory) { try { directory = JSON.parse(row?.parameters || '{}').outputDirectory || '' } catch { directory = '' } }
      directory = String(directory).replace(/^\/+|\/+$/g, '')
      if (userId && directory && request.desktopDelivery !== 1) {
        finished.forEach((artifact, index) => {
          const content = artifacts[index]?.bytes
          if (!content?.length) return
          const mime = String(artifact.mime || artifacts[index]?.mime || 'image/png')
          const extension = mime.split('/')[1] || 'png'
          // 文件名固定用 artifact id：这样结果接口能直接推导出路径给客户端，不用额外存映射。
          const path = `${directory}/${artifact.id}.${extension}`
          workspaceFiles.upsert(userId, path, mime, Buffer.from(content), request.workspaceProject || JSON.parse(row.parameters || '{}').workspaceProject || DEFAULT_PROJECT_ID)
          artifact.path = path
        })
      }
    } catch (error) {
      console.warn('[image] 结果写入工作区失败', generationId, error?.message || error)
    }
    try { syncCanvasGeneration(generationId, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 图片回写待恢复', error?.message) }
    // 上游留档：发出参数、上游返回摘要、用量与成本，供以后从真实账单反推单价。
    try {
      const cost = estimateUpstreamCostRmb({ model: request.model, count: finished.length, parameters: request.generation || {} })
      management.recordUpstreamCall({
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
      management.recordUpstreamCall({
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
  const existing = management.existingGeneration({ session, requestId: suppliedRequestId, idempotencyKey: suppliedIdempotencyKey || suppliedRequestId, accessToken })
  if (existing) {
    const current = management.generationForViewer(existing.requestId, session, existing.accessToken || accessToken)
    if (!current) throw failure('生成记录不存在', 404)
    return generationReceipt(current, {
      accessToken: existing.accessToken || undefined,
      size: current.parameters.size,
      quality: current.parameters.quality,
      editMode: current.parameters.editMode || null,
    })
  }
  // Desktop input leases belong to new admission, never to a status replay.
  assertModelAccess({ management, session, service: '图片模型' })
  if (preparePayload) payload = preparePayload(payload)
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
  const reservation = management.reserve({
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
  })
  try { syncCanvasGeneration(reservation.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 图片任务绑定待恢复', error?.message) }
  reservation.cost = request.cost
  if (reservation.duplicate) {
    const current = management.generationForViewer(reservation.requestId, session, reservation.accessToken || accessToken)
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
  const heartbeat = setInterval(() => { if (!management.heartbeat(reservation.id, workerId)) controller.abort() }, 5000)
  activeControllers.set(reservation.requestId, controller)
  try {
    const { images, result } = await executeGeneration(reservation.id, request, env, controller.signal)
    return resultPayload(request, { ...reservation, cost: request.cost }, images, result, reservation.accessToken)
  } catch (error) {
    if (submissionUncertain(error)) {
      if (error.imageResultPending) management.deferImageResult(reservation.id, workerId)
      else management.markSubmissionUncertain(reservation.id, error.message, error, workerId)
      const current = management.generationForViewer(reservation.requestId, session, reservation.accessToken)
      const receipt = generationReceipt(current)
      return { ...receipt, ...(receipt.async ? { pollAfterMs: 5000 } : {}) }
    }
    management.fail(reservation.id, error.message, error, workerId)
    throw error
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(reservation.requestId)
    try { management.releaseLease(reservation.id, workerId) } catch (error) { console.warn('[image] 执行租约待回收', reservation.id, error?.code || 'unknown') }
  }
}

const workerId = newRequestId()
const activeJobs = new Map()
const activeControllers = new Map()
let pumping: Promise<void> | undefined
let stopping = false

async function runQueuedJob(job, originalReceipt?: StoredImageReceipt) {
  const controller = new AbortController()
  const heartbeat = setInterval(() => { if (!management.heartbeat(job.id, workerId)) controller.abort() }, 5000)
  activeControllers.set(job.request_id, controller)
  try {
    if (originalReceipt) {
      const parameters = JSON.parse(job.parameters || '{}')
      // Delivery uses the admitted snapshot, even if its model/account has
      // since been disabled. No references, keys or new reservation are read.
      const request = { model: modelById(job.model) || { id: job.model, publicId: job.model, provider: job.provider || '' },
        generation: parameters, outputDirectory: parameters.outputDirectory || '', desktopDelivery: parameters.desktopDelivery,
        workspaceProject: parameters.workspaceProject || DEFAULT_PROJECT_ID, references: [] }
      await executeGeneration(job.id, request, process.env, controller.signal, originalReceipt)
    } else if (modelById(job.model)?.video) {
      await submitQueuedVideo(job, { management, signal: controller.signal, materializeReference })
    } else {
      await executeGeneration(job.id, requestFromJob(job), process.env, controller.signal)
    }
  } catch (error) {
    if (originalReceipt && !error?.upstreamAccepted) {
      error = new ImageResultError(error, originalReceipt.result)
      error.imageResultPending = true
    }
    if (error.imageResultPending) management.deferImageResult(job.id, workerId)
    else if (submissionUncertain(error)) management.markSubmissionUncertain(job.id, error.message, error, workerId)
    else management.fail(job.id, error.message, error, workerId)
  } finally {
    clearInterval(heartbeat)
    activeControllers.delete(job.request_id)
    activeJobs.delete(job.id)
    try { management.releaseLease(job.id, workerId) } catch (error) { console.warn('[generation] 执行租约待回收', job.id, error?.code || 'unknown') }
    try { syncCanvasGeneration(job.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 任务终态回写待恢复', error?.message) }
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
  if (pumping) return pumping
  if (stopping) return Promise.resolve()
  const pending: Promise<void> = Promise.resolve().then(async () => {
    if (stopping) return
    management.recoverStale()
    if (!settings().enabled) return
    while (!stopping) {
      const job = management.claimNext(workerId)
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
  if (videoCollection) return videoCollection
  if (stopping) return Promise.resolve()
  // Register before dispatch so shutdown also sees a collector whose first
  // provider read has not started yet. Keep the existing single-flight scan.
  const pending: Promise<void> = Promise.resolve().then(async () => {
    if (stopping) return
    const rows = management.all("SELECT request_id,user_id,model FROM generations WHERE user_id IS NOT NULL AND status='running' AND upstream_request_id IS NOT NULL")
    await Promise.allSettled(rows.filter(row => modelById(row.model)?.video).map(async row => {
      const result = await pollVideo({ requestId: row.request_id }, { role: 'user', userId: row.user_id }, { management, workspaceFiles })
      const stored = management.get('SELECT id FROM generations WHERE request_id=?', row.request_id)
      if (stored) syncCanvasGeneration(stored.id, { management, workspaceFiles })
      return result
    }))
    if (stopping) return
    const missing = management.all("SELECT g.request_id,g.user_id FROM generations g JOIN video_results v ON v.generation_id=g.id WHERE g.user_id IS NOT NULL AND g.status='succeeded' AND json_extract(v.metadata,'$.workspacePath') IS NULL AND json_extract(g.parameters,'$.desktopDeliveredAt') IS NULL AND json_extract(g.parameters,'$.desktopMediaExpiredAt') IS NULL AND g.finished_at>=? ORDER BY g.finished_at DESC", new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    await Promise.allSettled(missing.filter(row => Date.now() >= (videoRestoreAfter.get(row.request_id) || 0)).map(row => {
      videoRestoreAfter.set(row.request_id, Date.now() + 60_000)
      return restoreVideoResult({ requestId: row.request_id }, { role: 'user', userId: row.user_id }, { management, workspaceFiles }).then(result => {
        const stored = management.get('SELECT id FROM generations WHERE request_id=?', row.request_id)
        if (stored) syncCanvasGeneration(stored.id, { management, workspaceFiles })
        return result
      })
    }))
    for (const [id, after] of videoRestoreAfter) if (Date.now() - after > 24 * 60 * 60_000) videoRestoreAfter.delete(id)
  }).finally(() => { if (videoCollection === pending) videoCollection = undefined })
  videoCollection = pending
  return pending
}
const videoCollectorTimer = setInterval(() => { void collectVideoResults().catch(error => console.warn('[video] 结果取回失败', error?.message)) }, 5000)

const desktopMediaTimer = setInterval(() => { try { desktopMedia.sweep() } catch (error) { console.warn('[desktop-media] 暂存回收待重试', error.code || 'unknown') } }, 60_000)
const queueTimer = setInterval(() => { void pumpQueue().catch(() => {}) }, 1000)
const imageReceiptTimer = setInterval(() => { void imageRecovery.collect().catch(error => console.warn('[image] 原图恢复扫描失败', error?.code || 'unknown')) }, 5000)
void imageRecovery.collect().catch(error => console.warn('[image] 初始原图恢复扫描失败', error?.code || 'unknown'))
// 秘塔余额异步落账，按固定间隔取快照并把区间差额与所有 upstream_calls 对照。
// 没配 Key 时函数只返回 unknown，不会阻塞生成；脚本可随时手工补一次快照。
const upstreamReconciliations = new Set<Promise<unknown>>()
function startUpstreamReconcile(): Promise<unknown> {
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

function previewKey(value) {
  const key = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(key)) throw failure('预览地址无效', 400)
  return key
}

function previewPath(ownerId, key) {
  const owner = String(ownerId || '')
  const root = owner && validMediaOwner(owner) ? join(mediaRoot(), owner) : mediaRoot()
  const directory = join(root, PREVIEW_DIRECTORY)
  mkdirSync(directory, { recursive: true, mode: mediaPermissions().directory })
  return join(directory, `v${MEDIA_INPUT_VERSION}-p${MEDIA_PREVIEW_VERSION}-${previewKey(key)}.jpg`)
}

async function cachedPreview(path, source, options: { video?: boolean; maxDimension?: number; beforeCommit?: () => void } = {}, signal?: AbortSignal) {
  try { return await mediaPreviews.read(path, source, options, signal) }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError' || [403,409,410].includes(Number(error?.status))) throw error
    console.warn('[preview] 预览暂不可用', error?.message || error); return null
  }
}

function previewFile(path) {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size <= 0) return null
    return { path, size: info.size, revision: `${Math.round(info.mtimeMs)}-${info.size}` }
  } catch { return null }
}

async function imagePreview(id, session, accessToken, signal?: AbortSignal) {
  const entry = management.artifact(id, session, accessToken)
  if (!entry) return null
  if (management.get("SELECT 1 FROM artifacts a JOIN generations g ON g.id=a.request_id WHERE a.id=? AND json_extract(g.parameters,'$.desktopDelivery')=1", id)) return null
  const path = previewPath(entry.ownerId, id)
  const existing = previewFile(path)
  if (existing) return existing
  const source = entry.bytes || entry.diskPath
  if (!source) return null
  const cached = await cachedPreview(path, source, {}, signal)
  return cached ? previewFile(cached) : null
}

async function videoPreview(requestId, session, accessToken, signal?: AbortSignal) {
  const existing = management.existingGeneration({ session, requestId, accessToken })
  if (!existing) return null
  const record = management.generationForViewer(requestId, session, accessToken)
  if (record?.parameters?.desktopDelivery === 1) return null
  const workspacePath = String(record?.video?.metadata?.workspacePath || '').trim()
  const ownerId = management.get('SELECT user_id FROM generations WHERE id=?', existing.id)?.user_id || ''
  if (!workspacePath || !ownerId) return null
  let source
  try {
    // History can contain results from another project: use the task's immutable project.
    source = workspaceFiles.locate(ownerId, workspacePath, record.parameters?.workspaceProject || DEFAULT_PROJECT_ID)
  } catch { return null }
  const path = previewPath(ownerId, requestId)
  const ready = previewFile(path)
  if (ready) return ready
  const cached = await cachedPreview(path, source.bytes || source.diskPath, { video: true }, signal)
  return cached ? previewFile(cached) : null
}

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

// 工作区接口的项目参数：不传一律落到默认项目——线上可能还有缓存住的旧前端包，
// 它们不带项目参数，不能让它们因为这次改动读不到文件。
// 传了就必须是这个账号自己的项目：别人的 id 和不存在的 id 一样回 404，不泄露存在性。
function resolveWorkspaceProject(userId, value) {
  const requested = String(value ?? '').trim()
  // 还没迁移到多项目的库：整个库就是默认项目，行为要和迁移前完全一致。
  if (!management.projectScoped) {
    if (requested && requested !== DEFAULT_PROJECT_ID) throw failure('工作区还没有迁移到多项目，请先运行 node scripts/migrate-projects.ts --apply', 409)
    return DEFAULT_PROJECT_ID
  }
  if (!requested || requested === DEFAULT_PROJECT_ID) return management.ensureDefaultProject(userId).id
  const project = management.projectForUser(userId, projectId(requested))
  if (!project) throw failure('项目不存在', 404)
  return project.id
}

// 老库没有 projects 表，列表里只有一个默认项目；前端不用为「这个部署还没迁移」写分支。
const defaultProjectView = () => ({ id: DEFAULT_PROJECT_ID, name: DEFAULT_PROJECT_NAME, createdAt: null, lastOpenedAt: null, fileCount: 0 })

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
// 工作区接口自己解析并校验项目归属；节点插件 / Agent / MCP / ffmpeg 这些子系统靠这一层
// 拿到同一个「当前项目」，不用各自加参数（那些模块里有五六十处调用点）。
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
  management.session(cookieToken(request)) || management.session(cookieToken(request, 'miao_admin')),
  (request.url || '').split('?')[0] === '/api/imagine/error-explanation',
  async () => {
 try {
  // Resolve request scope inside the HTTP error boundary, before routing.
  currentProject()
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
  const session = management.session(cookieToken(request)) || management.session(cookieToken(request, 'miao_admin'))
  if (await desktopModel(request, response, session, url, { management, readJson, mutation })) return
  if (await desktopWeb(request, response, session, url, { management, readJson, mutation })) return
  // 参考素材只读链接：上游按签名直接抓取，不要求登录（token 已绑定用户、路径和过期时间）。
  if (url.pathname === '/api/imagine/reference' && request.method === 'GET') {
    const resolved = verifyReferenceToken(management.referenceSecret(), url.searchParams.get('t'))
    if (!resolved) throw failure('参考资源链接无效或已过期', 410)
    const file = workspaceFiles.locate(resolved.userId, resolved.path, resolved.project)
    if (resolved.revision && resolved.revision !== file.revision) throw failure('参考素材已更新，请重新获取链接', 409)
    if (!isReferenceMediaMime(file.mime)) throw failure('参考资源类型不受支持', 415)
    await sendWorkspaceFile(request, response, resolved.userId, file, { cacheControl: 'private, max-age=300' })
    return
  }
   if (url.pathname === '/api/imagine/session' && request.method === 'GET') {
     json(response,200,{session:publicSession(viewerSession(session)),requireLogin:management.settings().requireLogin}); return
   }
  if (url.pathname.startsWith('/api/agent')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    // Agent 的文案在服务端就翻好（对齐上游 lib/i18n.ts 的请求级语言）。
    if (await runWithLocale(resolveRequestLocale(request.headers['accept-language']), () => agentApi.handle(request, response, session, url, { json, readJson, sameOrigin }))) return
  }
  if (url.pathname === '/mcp') {
    if (await mcpApi.handleMcp(request, response, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/mcp/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await mcpApi.handleControl(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/nodes/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await nodePlugins.handle(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/ext/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await extPlugins.handle(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  // 插件导出（节点 / 文件扩展 / 技能）：按账号工作区取文件，见 server/plugin-export.ts。
  if (url.pathname === '/api/plugins/export' && await pluginExport(request, response, session, url)) return
  if (url.pathname === '/api/ffmpeg/execute') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await ffmpegExec.handle(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname.startsWith('/api/ai/')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (await aiCompat.handle(request, response, session, url, { json, readJson, sameOrigin })) return
  }
  if (url.pathname === '/api/imagine/mcp-skill' && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    json(response, 200, { ok: true, name: 'SKILL.md', content: mcpSkillMarkdown() })
    return
  }
  if (url.pathname === '/api/imagine/mcp') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (request.method === 'GET') { json(response, 200, { ok: true, ...management.mcpTokenInfo(session.userId) }); return }
    if (request.method === 'PUT') {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
      const payload = await readJson(request, SMALL_BODY_BYTES)
      const info = management.setMcpEnabled(session.userId, payload.enabled)
      if (!payload.enabled) mcpApi.disconnectUser(session.userId)
      json(response, 200, { ok: true, ...info }); return
    }
    if (request.method === 'POST') {
      // 画布内发起的同源请求（带自定义头），用同源校验替代 CSRF 令牌。
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
      const token = management.rotateMcpToken(session.userId)
      mcpApi.disconnectUser(session.userId)
      json(response, 200, { ok: true, ...token, ...management.mcpTokenInfo(session.userId) })
      return
    }
  }
  if ((url.pathname === '/api/imagine/providers' || url.pathname === '/api/imagine/providers/models')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (url.pathname === '/api/imagine/providers' && request.method === 'GET') {
      json(response, 200, { ok: true, providers: listPublicProviders(workspaceFiles, session.userId) })
      return
    }
    // 画布内发起的同源请求（带自定义头），用同源校验替代 CSRF 令牌。
    sameOrigin(request)
    if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
    if (url.pathname === '/api/imagine/providers/models' && request.method === 'POST') {
      await withRequestSignal(request, response, undefined, async signal => {
        const payload = await readJson(request, SMALL_BODY_BYTES)
        signal.throwIfAborted()
        const stored = payload?.id ? providerById(workspaceFiles, session.userId, payload.id) : null
        if (payload?.id && !stored) throw failure('供应商不存在', 404)
        const models = await fetchUpstreamProviderModels({
          apiUrl: payload?.apiUrl || stored?.apiUrl,
          protocol: payload?.protocol || stored?.protocol,
          apiKey: String(payload?.apiKey ?? '').trim() || stored?.apiKey || '',
        }, { signal, beforeDispatch: () => assertTextIdentity({ management, session }) })
        signal.throwIfAborted()
        json(response, 200, { ok: true, models })
      })
      return
    }
    if (url.pathname === '/api/imagine/providers' && request.method === 'POST') {
      const payload = await readJson(request, SMALL_BODY_BYTES)
      if (payload?.operation === 'remove') {
        json(response, 200, { ok: true, ...removeTextProvider(workspaceFiles, session.userId, payload.id) })
        return
      }
      json(response, 200, { ok: true, provider: upsertTextProvider(workspaceFiles, session.userId, payload) })
      return
    }
    throw failure('供应商接口不存在', 404)
  }
  if (url.pathname === '/api/imagine/personalization') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    if (request.method === 'GET') {
      const requested = url.searchParams.get('document')
      const name = requested === 'memory' ? 'memory' : requested === 'system' ? 'system' : 'agents'
      json(response, 200, { ok: true, ...agentApi.readPersonalization(session.userId, name) })
      return
    }
    if (request.method === 'POST') {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求来源无效', 403)
      const payload = await readJson(request, 1024 * 1024)
      const name = payload.document === 'memory' ? 'memory' : payload.document === 'system' ? 'system' : 'agents'
      json(response, 200, { ok: true, ...agentApi.writePersonalization(session.userId, name, payload.content, payload.revision ?? null) })
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
      : desktopMedia.stage(session.userId, desktopReference[1], mime)
    json(response, 200, { ok: true, ...staged }); return
  }
  const delivered = /^\/api\/imagine\/desktop\/tasks\/([A-Za-z0-9_-]+)\/delivered$/.exec(url.pathname)
  if (delivered && request.method === 'POST') {
    if (session?.role !== 'user') throw failure('请先登录账号', 401)
    mutation(request, session)
    const payload = await readJson(request, 64 * 1024)
    json(response, 200, { ok: true, ...await desktopMedia.delivered(session.userId, delivered[1], payload.results) }); return
  }
  // 画布把本地参考素材换成上游可抓取的签发地址：只允许签发自己工作区里存在的文件。
  if (url.pathname === '/api/imagine/reference-url' && request.method === 'POST') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    mutation(request, session)
    const payload = await readJson(request, 4096)
    const project = resolveWorkspaceProject(session.userId, payload?.project ?? url.searchParams.get('project'))
    const path = workspaceFiles.path(String(payload?.path || '').trim())
    const file = workspaceFiles.locate(session.userId, path, project)
    if (!isReferenceMediaMime(file.mime)) throw failure('参考素材必须是图片、视频或音频文件', 422)
    const origin = String(process.env.OIP_PUBLIC_ORIGIN || '').replace(/\/$/, '') || `http://${request.headers.host}`
    const token = createReferenceToken(management.referenceSecret(), { userId: session.userId, path, revision: file.revision, project })
    json(response, 200, { ok: true, url: `${origin}/api/imagine/reference?t=${encodeURIComponent(token)}`, expiresIn: Math.floor(REFERENCE_TTL_MS / 1000) })
    return
  }
  if (url.pathname.startsWith('/api/imagine/workspace')) {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const expectedOwner = request.headers['x-workspace-owner'] || url.searchParams.get('owner')
    if (expectedOwner && expectedOwner !== management.publicUser(session.userId).workspaceKey) throw failure('登录账号已变化，请刷新工作区', 409)
    // 项目列表/新建/改名/删除/打开。全部按 (账号, 项目 id) 查，别人的 id 和不存在的 id 一样是 404。
    if (url.pathname === '/api/imagine/workspace/projects') {
      const counts = workspaceFiles.fileCounts(session.userId)
      const withCounts = list => list.map(project => ({ ...project, fileCount: counts.get(project.id) || 0 }))
      if (request.method === 'GET') {
        // 老库没有 projects 表：只报一个默认项目，读接口和老版本完全一致。
        const projects = management.projectScoped
          ? withCounts(management.projectsForUser(session.userId))
          : [{ ...defaultProjectView(), fileCount: counts.get(DEFAULT_PROJECT_ID) || 0 }]
        // scoped 明确告诉前端「这个库支不支持多项目」：没迁移的库是 false，前端据此不渲染
        // 新建/重命名/删除/切换那些入口（点了必然 409），而不是让前端去猜 409 的含义。
        // 迁移完这个值自动变 true，前端不用再改一次。
        json(response, 200, { projects, scoped: Boolean(management.projectScoped) })
        return
      }
      if (request.method === 'POST') {
        mutation(request, session)
        const payload = await readJson(request, SMALL_BODY_BYTES)
        json(response, 200, { project: { ...management.createProject(session.userId, payload?.name), fileCount: 0 } })
        return
      }
    }
    if (url.pathname === '/api/imagine/workspace/projects/rename' && request.method === 'POST') {
      mutation(request, session)
      const payload = await readJson(request, SMALL_BODY_BYTES)
      const project = management.renameProject(session.userId, payload?.id, payload?.name)
      json(response, 200, { project: { ...project, fileCount: workspaceFiles.fileCounts(session.userId).get(project.id) || 0 } })
      return
    }
    if (url.pathname === '/api/imagine/workspace/projects/open' && request.method === 'POST') {
      mutation(request, session)
      const payload = await readJson(request, SMALL_BODY_BYTES)
      const id = resolveWorkspaceProject(session.userId, payload?.id)
      json(response, 200, { project: management.touchProject(session.userId, id) || defaultProjectView() })
      return
    }
    if (url.pathname === '/api/imagine/workspace/projects/remove' && request.method === 'POST') {
      mutation(request, session)
      const payload = await readJson(request, SMALL_BODY_BYTES)
      if (typeof payload?.id !== 'string' || !payload.id.trim()) throw failure('缺少项目编号', 422)
      const id = resolveWorkspaceProject(session.userId, payload?.id)
      if (id === DEFAULT_PROJECT_ID) throw failure('默认项目不能删除')
      // 字节和索引一起删（默认项目拒绝删除），顺序见 WorkspaceFiles.removeProject。
      await mcpApi.withProjectRemoval(session.userId, id, async () => {
        json(response, 200, { ok: true, ...workspaceFiles.removeProject(session.userId, id) })
      })
      return
    }
    const project = resolveWorkspaceProject(session.userId, url.searchParams.get('project'))
    if (url.pathname === '/api/imagine/workspace/files') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const path = url.searchParams.get('path')
        if (url.searchParams.has('upload')) { json(response, 200, uploadStatus(session.userId, project, url.searchParams.get('upload'))); return }
        if (!path) { json(response, 200, { ...workspaceFiles.listSnapshot(session.userId, project), capabilities: { nonRecursiveRemove: true, copyFiles: true, copyFilesBatch: true, copyCanvasSnapshots: true, guardedCanvasRemove: true, markdownFileLinks: true, treeSourceEntries: true } }); return }
        const file: any = workspaceFiles.locate(session.userId, path, project)
        if (url.searchParams.get('playback') === '1') {
          const playback = desktopMedia.isTemporary(session.userId, file, project) ? null : await withRequestSignal(request, response, undefined, signal => videoPlayback(session.userId, file, { signal,
            beforeCommit: () => { if (workspaceFiles.stat(session.userId, path, project).revision !== file.revision) throw failure('媒体已更新，请重新读取', 409) } }))
          await sendWorkspaceFile(request, response, session.userId, playback || file, { version: url.searchParams.get('v') })
          return
        }
        if (url.searchParams.get('preview') === '1') {
          if (!/^(image|video)\//.test(file.mime)) throw failure('该文件没有图片预览', 415)
          if (desktopMedia.isTemporary(session.userId, file, project)) throw failure('请在桌面端预览本机文件', 404)
          // 缓存来自同账号已鉴权的原件，修订号变化时生成新预览；不改原文件和索引。
          const dimension = url.searchParams.get('previewSize') === '320' ? 320 : 1024
          const key = 'workspace-' + createHash('sha256').update(file.blob ? file.blob + ':' + dimension : path + ':' + file.revision + ':' + dimension).digest('hex')
          const cached = await withRequestSignal(request, response, undefined, signal => cachedPreview(previewPath(session.userId, key), file.bytes || file.diskPath, {
            video: file.mime.startsWith('video/'), maxDimension: dimension,
            beforeCommit: () => { if (workspaceFiles.stat(session.userId, path, project).revision !== file.revision) throw failure('媒体已更新，请重新读取', 409) },
          }, signal))
          const info = cached && previewFile(cached)
          if (!info) throw failure('预览暂不可用，请读取原文件', 404)
          await sendWorkspaceFile(request, response, session.userId, {
            ...file, mime: MEDIA_PREVIEW_MIME, bytes: null, diskPath: info.path,
            size: info.size, revision: file.revision + `-preview-v${MEDIA_INPUT_VERSION}-p${MEDIA_PREVIEW_VERSION}-` + dimension,
          }, { version: url.searchParams.get('v') })
          return
        }
        await sendWorkspaceFile(request, response, session.userId, file, { version: url.searchParams.get('v') })
        return
      }
      if (request.method === 'PUT') {
        mutation(request, session)
        const path = workspaceFiles.path(String(url.searchParams.get('path') || ''))
        desktopMedia.assertWorkspaceMutation(session.userId, project, { operation: 'write', path })
        const exclusive = url.searchParams.get('exclusive') === '1'
        const revision = exclusive ? null : String(url.searchParams.get('revision') || request.headers['x-workspace-revision'] || '') || null
        const mime = String(request.headers['content-type'] || '').split(';', 1)[0].trim()
        if (url.searchParams.has('upload')) {
          const bytes = await readBytes(request, UPLOAD_CHUNK_BYTES)
          const result = await appendUpload({ owner: session.userId, project, id: url.searchParams.get('upload'), path, mime, revision,
            total: Number(url.searchParams.get('total')), offset: Number(url.searchParams.get('offset')), bytes, maximum: WORKSPACE_FILE_MAX_BYTES,
            commit: async content => {
              const video = await normalizeVideoBuffer(content, { path, mime })
              const saved = workspaceFiles.writeBytes(session.userId, { path, project, mime, bytes: video.bytes, revision })
              if (mime.startsWith('video/')) void videoPlayback(session.userId, workspaceFiles.locate(session.userId, path, project)).catch(() => {})
              return saved
            },
          })
          json(response, 200, result); return
        }
        const bytes = await readBytes(request, WORKSPACE_FILE_MAX_BYTES)
        // 视频先做一次无损转封装再落盘：moov 在文件末尾的排版会让浏览器「播不了」（见模块注释）。
        const video = await normalizeVideoBuffer(bytes, { path, mime })
        json(response, 200, workspaceFiles.writeBytes(session.userId, {
          path,
          project,
          mime,
          bytes: video.bytes,
          revision,
        }))
        return
      }
      if (request.method === 'POST') {
        mutation(request, session)
        const payload = await readJson(request, 42 * 1024 * 1024)
        // 项目归属在这里重新认一次：mutate 的项目是放在请求体里的（不像 GET/PUT 走查询参数），
        // 只看查询参数会把客户端传的项目覆盖成默认项目——写入就落到默认项目去了。
        // 认完仍然用服务端确认过的 id 覆盖客户端字段。
        const scoped = resolveWorkspaceProject(session.userId, payload?.project ?? url.searchParams.get('project'))
        json(response, 200, workspaceFiles.mutate(session.userId, { ...payload, project: scoped })); return
      }
    }
    if (url.pathname === '/api/imagine/workspace' && request.method === 'GET') {
      json(response, 200, management.workspaceForUser(session.userId, project)); return
    }
    if (url.pathname === '/api/imagine/workspace' && request.method === 'POST') {
      mutation(request, session)
      const payload = await readJson(request, MAX_BODY_BYTES)
      const scoped = resolveWorkspaceProject(session.userId, payload?.project ?? url.searchParams.get('project'))
      const current = management.workspaceForUser(session.userId, scoped)
      const has = key => Object.hasOwn(payload, key)
      if (has('canvasFiles') || has('assets')) throw failure('请刷新工作区后使用逐项保存接口', 409)
      if (has('workspace')) {
        if (!payload.workspace || typeof payload.workspace !== 'object' || Array.isArray(payload.workspace)) throw failure('工作区数据无效')
        if (payload.workspaceRevision !== current.workspaceRevision) throw failure('草稿已在其他页面更新，请刷新后再编辑', 409)
      }
      let assets = current.assets
      if (payload.assetOperation === 'save') {
        if (!payload.asset || typeof payload.asset.id !== 'string' || !payload.asset.id) throw failure('素材数据无效')
        assets = [...assets.filter(item => item.id !== payload.asset.id), payload.asset]
        if (assets.length > 200) throw failure('素材数量不能超过 200')
      } else if (payload.assetOperation === 'remove') {
        if (typeof payload.assetId !== 'string') throw failure('素材数据无效')
        assets = assets.filter(item => item.id !== payload.assetId)
      } else if (has('assetOperation')) throw failure('素材操作无效')
      json(response, 200, management.saveWorkspaceForUser(session.userId, { workspace: has('workspace') ? payload.workspace : current.workspace, assets, project: scoped })); return
    }
    throw failure('工作区接口不存在', 404)
  }
  if (url.pathname === '/api/imagine/login' && request.method === 'POST') {
    sameOrigin(request); loginRate(request)
    const payload=await readJson(request, SMALL_BODY_BYTES), next=management.loginUser(payload.code)
    json(response,200,{session:publicSession(next)},{'set-cookie':sessionCookie(request,next.token)});return
  }
  if (url.pathname === '/api/imagine/register' && request.method === 'POST') {
    sameOrigin(request); loginRate(request)
    throw failure('请先获取邮箱验证码，并和密码一起提交', 422)
  }
  if (url.pathname === '/api/imagine/login-password' && request.method === 'POST') {
    sameOrigin(request); loginRate(request)
    throw failure('请使用邮箱验证码登录', 422)
  }
  if (url.pathname === '/api/imagine/email/config' && request.method === 'GET') {
    json(response, 200, emailOtp.config()); return
  }
  if (url.pathname === '/api/imagine/email/request-code' && request.method === 'POST') {
    sameOrigin(request); loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const result = await emailOtp.request(payload.email)
    json(response, 200, { ok: true, cooldown: result.cooldown }); return
  }
  if (url.pathname === '/api/imagine/email/verify-code' && request.method === 'POST') {
    sameOrigin(request); loginRate(request)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const next = emailOtp.verify(payload.email, payload.code, payload.name, payload.password)
    json(response, 200, { session: publicSession(next) }, { 'set-cookie': sessionCookie(request, next.token) }); return
  }
  if (url.pathname.startsWith('/api/imagine/oauth/') && await oauthLogin.handle(request, response, url)) return
  if (url.pathname === '/api/imagine/password' && request.method === 'POST') {
    mutation(request,session)
    if (session.role !== 'user') throw failure('只有普通用户可以修改密码', 403)
    const payload = await readJson(request, SMALL_BODY_BYTES)
    const next = management.changePassword(session.userId, payload.currentPassword, payload.newPassword, management.user(session.userId)?.email || 'user')
    json(response,200,{session:publicSession(next)},{'set-cookie':sessionCookie(request,next.token)})
    return
  }
  if (url.pathname === '/api/imagine/logout' && request.method === 'POST') {
    // Already expired/revoked sessions can still clear their browser cookie.
    // Active sessions keep the original same-origin and CSRF protection.
    if (session) mutation(request, session)
    else sameOrigin(request)
    management.logout(cookieToken(request))
    json(response, 200, { ok: true }, { 'set-cookie': sessionCookie(request, '', true) })
    return
  }
  if (url.pathname === '/api/imagine/payment/notify' && request.method === 'GET') {
    handlePaymentNotify(url, response)
    return
  }
  if (url.pathname === '/api/imagine/payment/return' && request.method === 'GET') {
    const order = management.paymentOrderForReturn(url.searchParams.get('out_trade_no') || '')
    const body = paymentReturnPage(order)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': Buffer.byteLength(body) })
    response.end(body)
    return
  }
  if (url.pathname === '/api/imagine/payment/orders' && request.method === 'POST') {
    mutation(request, session)
    const order = await createPaymentOrder(await readJson(request, SMALL_BODY_BYTES), session, request)
    json(response, 201, paymentOrderPayload(order))
    return
  }
  const paymentQrMatch = /^\/api\/imagine\/payment\/orders\/([A-Za-z0-9_-]{1,32})\/qrcode$/.exec(url.pathname)
  if (paymentQrMatch && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const order = management.paymentOrderForUser(decodeURIComponent(paymentQrMatch[1]), session.userId)
    if (!order) { json(response, 404, { ok: false, error: '充值订单不存在' }); return }
    if (order.status !== 'created') {
      const expired = order.status === 'expired'
      json(response, 410, { ok: false, status: order.status, error: expired ? '二维码已过期，请重新发起充值' : '二维码已失效，请重新发起充值' })
      return
    }
    if (!order.img) { json(response, 404, { ok: false, error: '订单未提供图片二维码' }); return }
    try {
      const image = await paymentQrImage(order)
      const currentOrder = management.paymentOrderForUser(order.outTradeNo, session.userId)
      if (!currentOrder || currentOrder.status !== 'created') {
        const expired = currentOrder?.status === 'expired'
        json(response, 410, { ok: false, status: currentOrder?.status || 'expired', error: expired ? '二维码已过期，请重新发起充值' : '二维码已失效，请重新发起充值' })
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
      json(response, error.status || 502, { ok: false, error: error.message || '付款二维码暂时无法读取' })
    }
    return
  }
  const paymentOrderMatch = /^\/api\/imagine\/payment\/orders\/([A-Za-z0-9_-]{1,32})$/.exec(url.pathname)
  if (paymentOrderMatch && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const order = management.paymentOrderForUser(decodeURIComponent(paymentOrderMatch[1]), session.userId)
    if (!order) { json(response, 404, { ok: false, error: '充值订单不存在' }); return }
    json(response, 200, paymentOrderPayload(order))
    return
  }
  if (url.pathname === '/api/imagine/history' && request.method === 'GET') {
    if(!session)throw failure('请先登录',401)
    json(response,200,management.records({...Object.fromEntries(url.searchParams),userId:session.role==='admin'?undefined:session.userId},false));return
  }
  const previewMatch = /^\/api\/imagine\/preview\/(image|video)\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname)
  if (previewMatch && request.method === 'GET') {
    const accessToken = url.searchParams.get('access') || ''
    if (!session && !accessToken) throw failure('请先登录', 401)
    const preview = await withRequestSignal(request, response, undefined, signal => previewMatch[1] === 'image'
      ? imagePreview(previewMatch[2], session, accessToken, signal)
      : videoPreview(previewMatch[2], session, accessToken, signal))
    if (!preview) { response.writeHead(404, { 'cache-control': 'private, no-store' }); response.end(); return }
    await sendWorkspaceFile(request, response, session?.userId || '', {
      path: `_previews/${previewMatch[2]}.jpg`,
      mime: MEDIA_PREVIEW_MIME,
      revision: preview.revision,
      size: preview.size,
      diskPath: preview.path,
      bytes: null,
    }, { cacheControl: IMMUTABLE_CACHE })
    return
  }
  // 视频内容同源代理：上游地址可能要求 Bearer Key、跨域，或只对服务端可读，
  // 浏览器只拿得到自己的账号地址。所有通道统一走这里，画布才能把成片持久化到工作区。
  if (url.pathname === '/api/imagine/video-content' && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const requestId = String(url.searchParams.get('requestId') || '').trim()
    const existing = requestId ? management.existingGeneration({ session, requestId }) : null
    const record = existing ? management.generationForViewer(requestId, session) : null
    const video = existing ? management.videoResult(existing.id) : null
    const model = record ? modelById(record.model) : null
    if (!video || !model || !model.video) throw failure('视频内容不存在', 404)
    if (record.parameters?.desktopDeliveredAt || record.parameters?.desktopMediaExpiredAt) throw failure('服务器临时文件已清理，请打开本机保存的结果', 410)
    if (video.metadata?.workspacePath) {
      try {
        const project = record.parameters?.workspaceProject || DEFAULT_PROJECT_ID
        const file = workspaceFiles.locate(session.userId, video.metadata.workspacePath, project)
        const playback = url.searchParams.get('playback') === '1' && !desktopMedia.isTemporary(session.userId, file, project) ? await withRequestSignal(request, response, undefined, signal => videoPlayback(session.userId, file, { signal,
          beforeCommit: () => { if (workspaceFiles.stat(session.userId, video.metadata.workspacePath, project).revision !== file.revision) throw failure('媒体已更新，请重新读取', 409) } })) : null
        await sendWorkspaceFile(request, response, session.userId, playback || file, { version: url.searchParams.get('v') })
        return
      } catch (error) { if (Number(error?.status) !== 404) throw error }
    }

    let target = String(video.metadata?.upstreamUrl || video.url || '').trim()
    const providerConfig = model.provider === 'metaso'
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
  // 结果取回：生成成功但没落进工作区时（例如浏览器断线）用它补回来，不用重新生成。
  const restoreMatch = /^\/api\/imagine\/generation\/([A-Za-z0-9_-]+)\/restore$/.exec(url.pathname)
  if (restoreMatch && request.method === 'POST') {
    if (session) mutation(request, session)
    else sameOrigin(request)
    try {
      const restored = await restoreVideoResult({ requestId: decodeURIComponent(restoreMatch[1]) }, session, { management, workspaceFiles, env: process.env })
      const stored = management.get('SELECT id FROM generations WHERE request_id=?', decodeURIComponent(restoreMatch[1]))
      if (stored) syncCanvasGeneration(stored.id, { management, workspaceFiles })
      json(response, 200, { ok: true, ...restored })
    } catch (error) {
      json(response, Number(error.status) || 502, { ok: false, error: error.message || '结果取回失败' })
    }
    return
  }
  // Exact node directory + authenticated owner; never match another user's node.
  if (['/api/imagine/video/node','/api/imagine/generation/node'].includes(url.pathname) && request.method === 'GET') {
    if (session?.role !== 'user') throw failure('请先登录', 401)
    const directory = safeOutputDirectory(url.searchParams.get('outputDirectory'))
    if (!directory || !/^assets\/[A-Za-z0-9_-]+$/.test(directory)) throw failure('节点目录无效', 422)
    const row = management.get("SELECT request_id,status,model FROM generations WHERE user_id=? AND json_extract(parameters,'$.outputDirectory')=? AND COALESCE(json_extract(parameters,'$.workspaceProject'),?)=? ORDER BY created_at DESC,id DESC LIMIT 1", session.userId, directory, DEFAULT_PROJECT_ID, currentProject() || DEFAULT_PROJECT_ID)
    if (row) {
      const stored = management.get('SELECT id FROM generations WHERE request_id=?', row.request_id)
      if (stored) syncCanvasGeneration(stored.id, { management, workspaceFiles })
    }
    const task = row && Boolean(modelById(row.model)?.video) === (url.pathname === '/api/imagine/video/node') && ['queued','running','succeeded'].includes(row.status)
      ? { requestId: row.request_id, status: row.status } : null
    json(response, 200, { ok: true, task })
    return
  }
  const videoMatch = /^\/api\/imagine\/video\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (videoMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(videoMatch[1])
    const accessToken = url.searchParams.get('access') || ''
    try {
      const result = await pollVideo({ requestId, accessToken }, session, { management, env: process.env, workspaceFiles })
      const stored = management.get("SELECT id FROM generations WHERE request_id=?", requestId)
      if (stored) try { syncCanvasGeneration(stored.id, { management, workspaceFiles }) } catch (error) { console.warn("[canvas] 视频结果回写待恢复", error?.message) }
      json(response, result.httpStatus || (result.status === 'succeeded' ? 200 : 202), { ok: true, balance: viewerBalance(session), ...result })
    } catch (error) {
      const code = Number(error.status)
      json(response, Number.isInteger(code) && code >= 400 && code < 600 ? code : 502, { ok: false, error: error.message || '视频状态读取失败' })
    }
    return
  }
  // 画布在用户点生成之前问「这次会扣多少积分」。这条路径和真正下单共用
  // prepareVideoRequest（含服务端 ffprobe 读参考素材真实时长），所以返回的数字
  // 就是下单时预扣的数字；只读、不占额、不调用上游。
  if (url.pathname === '/api/imagine/video/estimate' && request.method === 'POST') {
    if (!session) throw failure('请先登录', 401)
    sameOrigin(request)
    try {
      // 管理端是独立进程：询价前先读生效设置，后台刚改的视频价和下单扣费一致。
      management.settings()
      const estimate = await estimateVideoCredits(await bodyJson(request), session, { env: process.env, probeReferenceMedia })
      json(response, 200, { ok: true, ...estimate, billingSource: estimate.breakdown?.billingSource || 'parameter_reserve', source: 'estimateGenerationCost + prepareVideoRequest' })
    } catch (error) {
      json(response, Number(error.status) || 502, { ok: false, error: error.message || '积分估算失败' })
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
      const policy = management.costPolicy()
      const request_ = await prepareImageRequest(payload, session, process.env)
      const modelId = request_.model.publicId || request_.model.id
      const policyPrice = policy.models?.[modelId]
      const cost: any = estimateGenerationCost({ model: request_.model, generation: request_.generation, referenceCount: request_.references.length, price: policyPrice })
      const perImage = Number(cost.breakdown?.perImage)
      if (!policyPrice || !Number.isFinite(perImage) || perImage <= 0 || !Number.isFinite(Number(cost.points)) || Number(cost.points) <= 0) {
        json(response, 200, { ok: true, model: modelId, size: request_.generation.size, count: cost.count, points: null, perImage: null, breakdown: cost.breakdown, billingSource: 'parameter_reserve', policyVersion: cost.policyVersion, pricingAvailable: false, source: 'estimateGenerationCost + management.costPolicy' })
      } else {
        json(response, 200, {
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
      json(response, Number(error.status) || 502, { ok: false, error: error.message || '积分估算失败' })
    }
    return
  }
  if (['/api/imagine/video', '/api/imagine/desktop/video'].includes(url.pathname) && request.method === 'POST') {
    if (session) mutation(request, session)
    else sameOrigin(request)
    try {
      const body = await bodyJson(request)
      delete body.desktopDelivery; delete body.desktopReferences
      const desktop = url.pathname === '/api/imagine/desktop/video'
      const result = await withWorkspaceProject(desktop ? DEFAULT_PROJECT_ID : currentProject(), () => createVideo(body, session, { management, env: process.env, probeReferenceMedia,
        ...(desktop ? { preparePayload: payload => desktopMedia.prepare(payload, session) } : {}) }))
      const stored = management.get('SELECT id FROM generations WHERE request_id=?', result.requestId)
      if (stored) try { syncCanvasGeneration(stored.id, { management, workspaceFiles }) } catch (error) { console.warn('[canvas] 视频任务绑定待恢复', error?.message) }

      void pumpQueue().catch(() => {})
      json(response, result.httpStatus || 202, { ok: true, ...result })
    } catch (error) {
      json(response, error.status || 502, { ok: false, error: error.message || '视频任务创建失败', ...(error.activeRequestId ? { activeRequestId: error.activeRequestId } : {}) })
    }
    return
  }
  if (url.pathname === '/api/imagine/error-explanation' && request.method === 'POST') {
    assertTextAccess({ management, session })
    mutation(request, session)
    const payload = await readJson(request, 4096)
    assertTextAccess({ management, session })
    const explanation = await errorExplanations.explain(payload, session, request.headers['accept-language'])
    if (!explanation) { json(response, 404, { ok: false, error: '说明暂时无法读取，请查看原任务' }); return }
    json(response, 200, { ok: true, errorExplanation: explanation })
    return
  }
  if (await shortTextApi.handle(request, response, session, url)) return
  const generationMatch = /^\/api\/imagine\/generation\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (generationMatch && request.method === 'GET') {
    const requestId = decodeURIComponent(generationMatch[1])
    const accessToken = url.searchParams.get('access') || ''
    const generation = management.generationForViewer(requestId, session, accessToken)
    if (!generation) { json(response, 404, { ok: false, error: '生成记录不存在' }); return }
    json(response, generation.status === GENERATION_STATES.EXPIRED ? 410 : 200, { ok: true, balance: viewerBalance(session), ...generation })
    return
  }
  const cancelMatch = /^\/api\/imagine\/generation\/([A-Za-z0-9_-]+)\/cancel$/.exec(url.pathname)
  if (cancelMatch && request.method === 'POST') {
    const accessToken = url.searchParams.get('access') || ''
    if (session) mutation(request, session)
    else sameOrigin(request)
    const requestId = decodeURIComponent(cancelMatch[1])
    const generation = management.cancel(requestId, session, accessToken)
    if (!generation) { json(response, 404, { ok: false, error: '生成记录不存在' }); return }
    activeControllers.get(requestId)?.abort()
    json(response, 200, { ok: true, ...generation })
    return
  }
  if (url.pathname === '/api/imagine/ledger' && request.method === 'GET') {
    if(!session?.userId)throw failure('请先登录',401)
    {
      // 区间由客户端给（用它本地的月初/月末），服务端不猜时区；subset 小结按全量算，不受 200 条上限影响。
      const ledger = management.ledgers(session.userId, { from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' })
      json(response,200,{
        items: ledger.rows.map((row)=>({delta:row.delta,reason:row.reason,createdAt:row.created_at,paymentOrderId:row.payment_order_id || null})),
        ...(ledger.summary ? { summary: ledger.summary } : {}),
      });return
    }
  }
  if (request.method === 'GET' && url.pathname === '/health') {
      const env = process.env
      const cfg = settings(env)
      const payments = paymentConfig(env)
      const google = googleOAuthConfig(env)
      const qq = qqOAuthConfig(env)
      const github = githubOAuthConfig(env)
      const wechat = wechatOAuthConfig(env)
      const dingtalk = dingTalkOAuthConfig(env)
      const linuxdo = linuxDoOAuthConfig(env)
      const oidc = oidcOAuthConfig(env)
      json(response, 200, {
      ok: true,
      defaultModel: modelById(defaultModel(env))?.publicId || defaultModel(env),
       generationEnabled: cfg.enabled,
       videoEnabled: management.settings().videoEnabled,
        configured: Boolean(cfg.enabled),
        payment: publicPaymentConfig(payments),
        googleLogin: { enabled: google.enabled },
        qqLogin: { enabled: qq.enabled },
        githubLogin: { enabled: github.enabled },
        wechatLogin: { enabled: wechat.enabled },
        dingtalkLogin: { enabled: dingtalk.enabled },
        linuxdoLogin: { enabled: linuxdo.enabled },
        oidcLogin: { enabled: oidc.enabled, providerName: oidc.providerName },
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
    const entry: any = management.artifact(id,session,accessToken)
    if (!entry) { json(response, 410, { ok: false, error: '图片读取地址已过期，请使用已保存的素材' }); return }
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
    const cfg = settings(env)
    const payments = paymentConfig(env)
    const google = googleOAuthConfig(env)
    const qq = qqOAuthConfig(env)
    const github = githubOAuthConfig(env)
    const wechat = wechatOAuthConfig(env)
    const dingtalk = dingTalkOAuthConfig(env)
    const linuxdo = linuxDoOAuthConfig(env)
    const oidc = oidcOAuthConfig(env)
    const operating = management.settings()
    let publicDefaultModel = operating.defaultModel
    const costPolicy = management.costPolicy()
    // 管理员对单个用户勾选的可用模型：空列表 = 全部开放；勾选后目录里其余模型直接不下发，
    // 画布节点与服务端看到的目录保持一致，reserve() 仍会再校验一次。
    const sessionUser = session?.role === 'user' && session.userId ? management.user(session.userId) : null
    const userModels = Array.isArray(sessionUser?.models) ? sessionUser.models : []
    const allowedForUser = (id) => !userModels.length || userModels.includes(id)
    const models = publicModelCatalog(env).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id)).map((model) => ({
      ...model,
      current: model.id === publicDefaultModel,
      paused: false,
      configured: model.configured,
      creditsPerImage: imageCreditsPerImage(model),
      creditsPerImageBySize: imageCreditsBySize(model),
    }))
    // 视频模型带上每个分辨率/秒数的积分规则，画布直接显示“当前参数预计消耗”。
    const videoModels = publicVideoCatalog(env).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id)).map((model) => ({
      ...model,
      paused: false,
      configured: model.configured,
      creditsPerSecond: costPolicy.models?.[model.id]?.creditsPerSecond || { default: 0.5 },
      minimumCredits: costPolicy.models?.[model.id]?.minimumCredits ?? 0.1,
      inputPricing: costPolicy.models?.[model.id]?.inputPricing || null,
      billingMode: costPolicy.models?.[model.id]?.billingMode || 'parameter_estimate',
    }))
    const textCatalog = (await publicTextCatalog(env)).filter((model) => operating.models[model.id] !== false && allowedForUser(model.id))
    publicDefaultModel = models.find(model => model.id === publicDefaultModel)?.id || models[0]?.id || ''
    for (const model of models) model.current = model.id === publicDefaultModel
    const publicDefaultTextModel = textCatalog.find(model => model.id === operating.defaultTextModel)?.id || textCatalog[0]?.id || ''
    json(response, 200, {
      defaultModel: publicDefaultModel,
      defaultTextModel: publicDefaultTextModel,
      modelLabel: modelById(publicDefaultModel)?.label || '',
      generationEnabled: cfg.enabled && operating.enabled && models.some((model) => model.configured),
      videoEnabled: operating.videoEnabled,
      videoModels,
      requireLogin: operating.requireLogin,
      desktop: DESKTOP_MEDIA_CAPABILITIES,
      registrationEnabled: operating.registrationEnabled,
      googleLogin: { enabled: google.enabled },
      qqLogin: { enabled: qq.enabled },
      githubLogin: { enabled: github.enabled },
      wechatLogin: { enabled: wechat.enabled },
      dingtalkLogin: { enabled: dingtalk.enabled },
      linuxdoLogin: { enabled: linuxdo.enabled },
      oidcLogin: { enabled: oidc.enabled, providerName: oidc.providerName },
      session: publicSession(viewerSession(session)),
      models,
      // 供应商和内部通道只留在服务端；公开目录只返回可选模型 ID/名称。
      textModels: textCatalog.map(({ provider: _provider, providerLabel: _providerLabel, ...model }: Record<string, any>) => ({ ...model, configured: textChannelReady(env, model.id) })),
      textEnabled: textCatalog.some((model) => textChannelReady(env, model.id)) && operating.enabled,
      modelDefaults: Object.fromEntries(modelCatalog().map((model) => [model.publicId || model.id, defaultsFor(model.id)])),
      payment: publicPaymentConfig(payments),
    })
    return
  }
  if (request.method === 'POST' && ['/api/imagine/generate', '/api/imagine/desktop/generate'].includes(url.pathname)) {
    try {
      if (session) mutation(request,session)
      else sameOrigin(request)
      const body = await readJson(request)
      delete body.desktopDelivery; delete body.desktopReferences
      const desktop = url.pathname === '/api/imagine/desktop/generate'
      const result = await withWorkspaceProject(desktop ? DEFAULT_PROJECT_ID : currentProject(), () => generate(body, session, process.env, desktop ? payload => desktopMedia.prepare(payload, session) : undefined))
      const { httpStatus = 200, ...payload } = result
      json(response, httpStatus, { ok: true, ...payload, ...(payload.images?.[0] ? { image: payload.images[0] } : {}) })
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { ok: false, error: error.message || '生成失败', ...(error.code ? { code: error.code } : {}), ...(error.queue ? { queue: error.queue } : {}), ...(error.activeRequestId ? { activeRequestId: error.activeRequestId } : {}) })
    }
    return
  }
  json(response, 404, { error: 'not found' })
 } catch(error) { if(!response.headersSent)json(response,error.status || 500,{ok:false,error:error.status?error.message:'服务暂时不可用，请重试'}); else response.destroy() }
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
    const agentStopped = agentApi.close()
    const httpStopped = incomingRequests.stop()
    errorExplanations.stop()
    clearInterval(desktopMediaTimer)
    clearInterval(queueTimer)
    clearInterval(imageReceiptTimer)
    const receiptRecoveryStopped = imageRecovery.stop()
    const mediaStopped = Promise.allSettled([mediaPreviews.stop(), stopVideoPlayback()])
    clearInterval(videoCollectorTimer)
    clearInterval(upstreamReconcileTimer)
    const backgroundStopped = Promise.allSettled([pumping, videoCollection, ...upstreamReconciliations])
    for (const controller of activeControllers.values()) controller.abort()
    server.close(async () => {
      await Promise.allSettled([...activeJobs.values(), receiptRecoveryStopped, mediaStopped, aiStopped, mcpStopped, agentStopped, httpStopped, backgroundStopped])
      management.close()
      process.exit(0)
    })
  })
}
