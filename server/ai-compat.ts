import { mapAsync } from './async-collections.ts'
import { createTextMeter } from './text-metering.ts'
import { isWorkspaceRequest } from './canvas-document.ts'
// MiaoImg 节点脚手架的 AI 兼容层。
// 用上游脚手架构建的第三方节点会调用 /api/ai/models、/api/ai/media/models、
// /api/ai/generate、/api/ai/media/generate 四个接口（见
// 插件能装上、能显示，一生成就崩。这里把它们接回妙图已有的模型目录、
// 文本通道与生成/扣点链路，不新开任何绕过积分与计费的通道。
import { randomUUID } from 'node:crypto'
import { failure } from './management-store.ts'
import { publicTextCatalog, textChannelReady, textModelById } from './text-models.ts'
import { listPublicProviderModels, providerById } from './text-providers.ts'
import { activeModelForSettings, publicModelCatalog, publicVideoCatalog } from './image-models.ts'
import { imageCreditsBySize, imageCreditsPerImage } from './generation-cost.ts'
import { createReferenceToken } from './reference-assets.ts'
import { newRequestId } from './generation-contract.ts'
import { textSettings } from './text-models.ts'
import { createAgentModel } from './agent-runtime.ts'
import { customTextModel } from './text-model-registry.ts'
import { createVideo } from './video-api.ts'
import { assertTextAccess, assertTextIdentity } from './text-access.ts'
import { readModelJson } from './model-transport.ts'
import { TextOperations } from './text-lifetime.ts'
import { refreshSuiheModels } from './suihe.ts'

// 单个媒体任务（含排队）的等待上限，与画布节点的等待节奏保持一致。
const POLL_INTERVAL_MS = 1000
const MAX_BODY_BYTES = 8 * 1024 * 1024

const IMAGE_MIME_EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
const MEDIA_MIME_EXTENSION = { ...IMAGE_MIME_EXTENSION, 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }

function sleep(ms) {
  return new Promise <void>((resolve) => setTimeout(resolve, ms))
}

function extensionFor(mime, fallback) {
  return MEDIA_MIME_EXTENSION[String(mime || '').split(';')[0].trim().toLowerCase()] || fallback
}

// 插件传来的目录可能来自 Electron 版工作区（绝对路径）；妙图的工作区路径必须是
// 相对路径且不含空段与 ..，这里统一收敛，非法时退回默认目录。
function safeDirectory(value, fallback) {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!raw) return fallback
  const segments = raw.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..') || raw.length > 400) return fallback
  return raw
}

function pickSize(model, size, ratio) {
  const sizes = Array.isArray(model?.sizes) ? model.sizes : []
  const exact = sizes.find((item) => item.value === size)
  if (exact) return exact.value
  if (size && model?.customSize && /^\d{2,5}x\d{2,5}$/.test(size)) return size
  if (size) throw failure('当前模型不支持这个生成尺寸', 422)
  const byRatio = ratio ? sizes.find((item) => item.ratio === ratio) : undefined
  if (byRatio) return byRatio.value
  return sizes.find((item) => item.ratio === '1:1')?.value || sizes[0]?.value || ''
}

// 第三方节点只发模型 ID 与提示词，这里按妙图公开目录再确认一次权限与状态。
function publicModelIdOf(catalog, modelId) {
  const target = String(modelId || '').trim()
  return catalog.find((model) => model.id === target) || null
}

export function createAiCompat({ management, workspaceFiles, generate, probeReferenceMedia, customProviderFetch }: Record<string, any>) {
  const textOperations = new TextOperations()
  async function userModels(session) {
    const user = session?.role === 'user' && session.userId ? (await management.user(session.userId)) : null
    return Array.isArray(user?.models) ? user.models : []
  }

  // 管理员暂停的模型不进入插件目录：插件节点选择列表与画布上的其它节点看到同一份。
  function available(id, paused, allowed) {
    return paused[id] !== false && (!allowed.length || allowed.includes(id))
  }

  // GET /api/ai/models：语言模型目录。形状对齐上游 nodeAi 的 NodeAiModel。
  async function listLanguageModels(session) {
    const catalog = await publicTextCatalog()
    const operating = (await management.settings())
    const allowed = (await userModels(session))
    return [
      ...catalog.filter((model) => operating.models?.[model.id] !== false && (!allowed.length || allowed.includes(model.id))).map((model) => ({
        providerId: 'miaoimg',
        providerLabel: '妙图',
        modelId: model.id,
        label: model.label,
        protocol: model.protocol || 'openai-completions',
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        configured: textChannelReady(process.env, model.id),
      })),
      ...(await listPublicProviderModels(workspaceFiles, session.userId)),
    ]
  }

  // GET /api/ai/media/models：媒体模型目录，复用 /api/imagine/config 的同一份来源与积分规则。
  async function listMediaModels(session) {
    await refreshSuiheModels({env: process.env}).catch(() => [])
    const operating = (await management.settings())
    const allowed = (await userModels(session))
    const paused = operating.models || {}
    const costPolicy = (await management.costPolicy())
    const images = publicModelCatalog(process.env, operating)
      .filter((model) => model.configured && available(model.id, paused, allowed))
      .map((model) => {
        const pricingModel = activeModelForSettings(model.id, operating, process.env) || model
        return ({
        providerId: 'miaoimg',
        providerLabel: '妙图',
        modelId: model.id,
        label: model.label,
        type: 'image',
        imageSizes: (model.sizes || []).map((item) => item.value),
        imageRatios: model.ratios?.length ? model.ratios : [...new Set((model.sizes || []).map((item) => item.ratio).filter(Boolean))],
        formats: model.formats || [],
        quality: model.quality || [],
        inputFidelity: model.inputFidelity || [],
        maxCount: model.maxCount ?? 1,
        maxReferences: model.maxReferences,
        maxCombinedImages: model.maxCombinedImages,
        customSize: Boolean(model.customSize),
        sizeRule: model.sizeRule || null,
        creditsPerImage: imageCreditsPerImage(pricingModel),
        // 以下是内置节点界面要用的字段（积分预估、区域编辑入口、图层分解等）：
        // 上游契约没声明它们，但上游那份 nodeAi 是原样透传，多出来的字段不会被丢掉。
        // 尺寸表带上 value/ratio 对照，节点侧按比例挑尺寸要用（pickSize）。
        sizes: model.sizes || [],
        creditsPerImageBySize: imageCreditsBySize(pricingModel),
        supportsTransparent: Boolean(model.supportsTransparent),
        supportsLayerDecomposition: Boolean(model.supportsLayerDecomposition),
        regionEdit: model.regionEdit ?? null,
        optimizePromptModes: model.optimizePromptModes || [],
        layerSizes: model.layerSizes || [],
        controls: model.controls || [],
        referenceInputs: model.referenceInputs || {},
        })
      })
    const videos = publicVideoCatalog(process.env, operating)
      .filter((model) => model.configured && available(model.id, paused, allowed))
      .map((model) => ({
        providerId: 'miaoimg',
        providerLabel: '妙图',
        modelId: model.id,
        label: model.label,
        type: 'video',
        mode: model.modes || [],
        sizes: model.sizes || [],
        durations: model.durations || [],
        defaultDuration: model.defaultDuration,
        defaultResolution: model.defaultResolution,
        ratios: model.ratios || [],
        durationResolutionMap: (() => {
          const resolutions = [...new Set<string>((model.sizes || []).map((item) => String(item.value)))]
          const limits = (model.maxDurationByResolution || {}) as Record<string, number>
          return resolutions.some(resolution => limits[resolution])
            ? resolutions.map(resolution => ({ duration: (model.durations || []).filter(duration => !limits[resolution] || duration < 0 || duration <= limits[resolution]), resolution: [resolution] }))
            : [{ duration: model.durations || [], resolution: resolutions }]
        })(),
        formats: model.formats || [],
        audio: model.audio ?? false,
        keyframes: model.keyframes || 0,
        referenceLimits: model.referenceLimits || { image: model.maxReferences || 1, video: 0, audio: 0, frames: 0 },
        referenceInputs: model.referenceInputs || {},
        maxDurationByMode: model.maxDurationByMode || {},
        parameterRules: model.parameterRules || {},
        controls: model.controls || [],
        maxCount: model.maxCount ?? 1,
        creditsPerSecond: costPolicy.models?.[model.id]?.creditsPerSecond || { default: 0.5 },
        minimumCredits: costPolicy.models?.[model.id]?.minimumCredits ?? 1,
        billingMode: costPolicy.models?.[model.id]?.billingMode || 'parameter_estimate',
        pricingNotice: costPolicy.models?.[model.id]?.pricingNotice || '',
        inputPricing: costPolicy.models?.[model.id]?.inputPricing || null,
      }))
    return [...images, ...videos]
  }

  // 节点引用里的文本素材并进系统提示：妙图的文本通道是纯文本的，
  // 图片/视频引用不塞进来（插件自己的提示词仍然照常生效）。
  function referenceBlock(references) {
    const texts = (Array.isArray(references) ? references : [])
      .filter((item) => item?.dataType === 'STRING')
      .map((item) => String(item.value || '').trim())
      .filter(Boolean)
    if (!texts.length) return ''
    return ['【引用素材】', ...texts].join('\n')
  }

  // 上游 requestModel 只消费 SSE：text/reasoning 增量 + 一条 done（完整 AssistantMessage）。
  async function streamText(request, response, session, { payload: suppliedPayload, signal }: Record<string, any> = {}) {
    if (response.destroyed || response.writableEnded) return
    const operation = textOperations.begin(() => {
      // A host shutdown must also release a client still uploading JSON. This
      // is this request's preparation, before any provider call or reservation.
      if (!operation.dispatched && !request.complete && !request.destroyed) request.destroy()
    })
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const disconnected = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      operation.disconnect()
    }
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    response.once('error', disconnected)
    signal?.addEventListener('abort', disconnected, { once: true })
    if (request.aborted || response.destroyed || signal?.aborted) disconnected()
    const connected = () => operation.connected && !response.destroyed && !response.writableEnded
    const write = (value: string) => {
      if (!connected()) return
      try { response.write(value) } catch { disconnected() }
    }
    const sendEvent = event => write(`data: ${JSON.stringify(event)}\n\n`)
    const openResponse = () => {
      if (!connected() || response.headersSent) return
      try {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        heartbeat = setInterval(() => write(': heartbeat\n\n'), 15_000)
        heartbeat.unref?.()
      } catch { disconnected() }
    }
    try {
      if (session?.role !== 'user' || !session.userId) throw failure('请先登录后使用文本模型', 401)
      if (management) await assertTextIdentity({ management, session })
      operation.signal.throwIfAborted()
      const payload = suppliedPayload ?? await readModelJson(request, undefined, operation.signal)
      operation.signal.throwIfAborted()
      if (response.destroyed || response.writableEnded) return
      const providerId = String(payload?.providerId || '').trim()
      const builtin = !providerId || providerId === 'miaoimg'
      operation.continueAfterDisconnect(builtin)
      if (builtin) await assertTextAccess({ management, session })
      else if (management) await assertTextIdentity({ management, session })
      const modelId = String(payload?.modelId || '').trim()
      const context = payload?.context || {}
      const toolDefinitions = (Array.isArray(context.tools) ? context.tools : []).map((tool) => ({
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.parameters || { type: 'object', properties: {} },
      }))
      // Preserve pi's transcript, including system/tool declarations and native
      // reasoning signatures. Cross-model conversion belongs to its adapter.
      const messages = Array.isArray(context.messages) ? context.messages : []
      const sdkContext = { ...context, messages, systemPrompt: [context.systemPrompt, referenceBlock(payload?.references)].filter(Boolean).join('\n\n'), ...(Array.isArray(context.tools) ? { tools: toolDefinitions } : {}) }
      if (!messages.some((message) => message.role === 'user')) throw failure('缺少用户消息', 422)
      // 渠道解析放在写响应头之前：鉴权、协议、模型错误用普通 JSON 报错更清楚。
      let config
      let upstreamModel
      if (builtin) {
        const settings = textSettings(process.env, modelId)
        if (!settings.enabled) throw failure('模型调用暂不可用，请稍后再试', 503)
        if (!settings.apiKey) throw failure('模型服务暂时不可用，请稍后再试', 503)
        const model = await operation.wait(textModelById(modelId))
        if (!model) throw failure('不支持的文本模型', 422)
        const operating = (await management.settings())
        if (operating.models?.[modelId] === false) throw failure('这个文本模型已暂停', 403)
        const allowed = (await userModels(session))
        if (allowed.length && !allowed.includes(modelId)) throw failure('这个文本模型未对你的账号开放', 403)
        config = { ...settings, baseUrl: settings.baseUrl, apiKey: settings.apiKey, previousResponseId: String(context.previousResponseId || payload?.previousResponseId || '') }
        config.toolChoice = ['auto', 'required', 'none'].includes(context.toolChoice) ? context.toolChoice : 'auto'
        config.parallelToolCalls = context.parallelToolCalls !== false
        upstreamModel = model.id
      } else {
        const provider = (await providerById(workspaceFiles, session.userId, providerId))
        if (!provider) throw failure('供应商不存在，请在设置 → 文本模型里重新添加', 422)
        const model = (provider.models || []).find((item) => item.id === modelId)
        if (!model) throw failure('所选模型不在该供应商的模型列表里，请重新选择', 422)
        config = {
          protocol: provider.protocol || 'openai-completions',
          baseUrl: String(provider.apiUrl || '').replace(/\/$/, ''),
          apiKey: provider.apiKey,
          providerId, modelEntry: customTextModel(provider, model),
          maxOutputTokens: model.maxOutputTokens,
          previousResponseId: String(context.previousResponseId || payload?.previousResponseId || ''),
          toolChoice: ['auto', 'required', 'none'].includes(context.toolChoice) ? context.toolChoice : 'auto',
          parallelToolCalls: context.parallelToolCalls !== false,
          ...(customProviderFetch ? { fetchImpl: customProviderFetch } : {}),
          ...(model.reasoning ? { reasoningEffort: 'medium' } : {}),
        }
        upstreamModel = model.id
      }
      const meter = builtin ? createTextMeter({ management,session,source:'compat_text' }) : null
      const { runtime,model } = await operation.wait(createAgentModel({ ...config,providerId:providerId || 'miaoimg',modelId:upstreamModel,
        ...(management && !builtin ? { beforeDispatch:async ()=>(await assertTextIdentity({ management,session })) } : {}),
        ...(builtin ? { fetchImpl:async (input,init) => {
          if (request.aborted || response.destroyed || signal?.aborted) disconnected()
          await operation.dispatch(async ()=>(await assertTextIdentity({ management,session })))
          openResponse()
          return meter.fetch(input,init)
        } } : {}),
      }))
      // Setup can outlive the caller. Do not reserve credits or start inference
      // after a close event that happened before the streaming listener existed.
      if (response.destroyed || response.writableEnded) return
      operation.signal.throwIfAborted()
      if (builtin) await assertTextAccess({ management, session })
      else if (management) await assertTextIdentity({ management, session })
      if (!builtin) openResponse()
      try {
        const stream = runtime.streamSimple(model, sdkContext, {
          signal: operation.signal, maxTokens: model.maxTokens, maxRetries: 0,
          ...(config.reasoningEffort ? { reasoning: config.reasoningEffort } : {}),
          toolChoice: config.toolChoice,
        })
        for await (const event of stream) {
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            sendEvent({ type: event.type === 'text_delta' ? 'text' : 'reasoning', delta: event.delta })
          }
        }
        const message = await stream.result()
        if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage || '文本生成中断')
        const billing = (await meter?.summary())
        const chargedText = billing?.status === 'settled' ? Number(billing.chargedPoints) : builtin ? null : 0
        const sdkUsage = message.usage
        sendEvent({ type: 'done', ...(builtin ? { billing } : {}), message: { ...message, usage: { ...sdkUsage, cost: { ...sdkUsage.cost, total: chargedText } } } })
      } catch (error) {
        if (!response.headersSent && connected()) throw error
        sendEvent({ type: 'error', message: error?.message || '文本生成失败', ...(builtin ? { billing:(await meter?.summary()) } : {}) })
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      request.off('aborted', disconnected)
      response.off('close', disconnected)
      response.off('error', disconnected)
      signal?.removeEventListener('abort', disconnected)
      try { if (!response.destroyed && !response.writableEnded && response.headersSent) response.end() }
      catch { disconnected() }
      finally { operation.finish() }
    }
  }

  // 视频插件引用同一账号工作区的原始素材。
  async function referenceUrl(request, session, path) {
    const file = (await workspaceFiles.read(session.userId, String(path || '').trim()))
    const origin = String(process.env.OIP_PUBLIC_ORIGIN || '').replace(/\/$/, '') || `http://${request.headers.host}`
    const token = createReferenceToken((await management.referenceSecret()), { userId: session.userId, path: file.path, revision: file.revision })
    return `${origin}/api/imagine/reference?t=${encodeURIComponent(token)}`
  }

  async function pollGeneration(session, requestId) {
    let current = (await management.generationForViewer(requestId, session))
    while (current && ['queued', 'running'].includes(current.status)) {
      await sleep(POLL_INTERVAL_MS)
      current = (await management.generationForViewer(requestId, session))
    }
    if (!current) throw failure('生成记录不存在', 404)
    if (current.status !== 'succeeded') throw failure(current.error || (current.status === 'cancelled' ? '生成已取消' : '生成失败'), 502)
    return current
  }

  async function saveToWorkspace(userId, directory, mime, bytes, fallbackExtension) {
    const path = `${directory}/${randomUUID()}.${extensionFor(mime, fallbackExtension)}`
    await workspaceFiles.upsert(userId, path, String(mime || '').split(';')[0].trim() || 'application/octet-stream', bytes)
    return path
  }

  async function generateImage(session, payload) {
    const catalog = publicModelCatalog(process.env, (await management.settings()))
    const model = publicModelIdOf(catalog, payload.modelId)
    if (!model) throw failure('不支持的图片模型', 422)
    const outputDirectory = safeDirectory(payload.outputDirectory, safeDirectory(payload.directory ? `${payload.directory}/assets` : '', 'assets'))
    const images = payload.images === undefined ? [] : payload.images
    if (!Array.isArray(images)) throw failure('参考素材参数无效', 422)
    const referenceFiles = images.map(item => ({ path: String(item?.path || '').trim(), ...(item?.revision ? { revision: item.revision } : {}) }))
    const requestId = newRequestId()
    // 走妙图既有的 /api/imagine/generate 内部链路：预扣、排队、上游调用、结算一体，
    // 与画布节点用的是同一套积分逻辑。
    await generate({
      model: model.id,
      prompt: String(payload.prompt || ''),
      size: pickSize(model, String(payload.size || '').trim(), String(payload.ratio || '').trim()) || undefined,
      ratio: payload.ratio,
      format: payload.format,
      quality: payload.quality,
      background: payload.background,
      inputFidelity: payload.inputFidelity,
      count: payload.count ?? 1,
      layerDecomposition: payload.layerDecomposition,
      optimizePrompt: payload.optimizePrompt,
      parameters: payload.parameters || payload.controls,
      referenceFiles,
      referenceRoles: [],
      requestId,
      idempotencyKey: requestId,
      async: true,
    }, session)
    const current = await pollGeneration(session, requestId)
    const files = []
    for (const image of current.images || []) {
      const artifact = (await management.artifact(String(image.id || ''), session))
      if (!artifact) continue
      const path = await saveToWorkspace(session.userId, outputDirectory, artifact.mime, artifact.bytes, 'png')
      files.push({ path, mimeType: artifact.mime, mediaType: 'image' })
    }
    if (!files.length) throw failure('生成服务没有返回图片', 502)
    return files
  }

  // 视频字节沿用画布自己的同源代理（/api/imagine/video-content）：各上游的签名与
  // 取 Key 规则只在那里维护一份。这里连的是本进程自己的监听地址。
  function selfOrigin() {
    const host = String(process.env.OIP_IMAGE_API_HOST || '127.0.0.1')
    const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
    return `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${Number(process.env.OIP_IMAGE_API_PORT || 8788)}`
  }

  async function fetchVideoBytes(request, requestId) {
    const response = await fetch(`${selfOrigin()}/api/imagine/video-content?requestId=${encodeURIComponent(requestId)}`, {
      headers: { cookie: String(request.headers.cookie || ''), host: String(request.headers.host || '') },
    })
    if (!response.ok) throw failure('视频内容读取失败', 502)
    return { bytes: Buffer.from(await response.arrayBuffer()), mime: String(response.headers.get('content-type') || 'video/mp4').split(';')[0].trim() }
  }

  async function generateVideo(request, session, payload) {
    const catalog = publicVideoCatalog(process.env, (await management.settings()))
    const model = publicModelIdOf(catalog, payload.modelId)
    if (!model) throw failure('不支持的视频模型', 422)
    const requestId = newRequestId()
    const created = await createVideoCompat(request, session, payload, model, requestId)
    const current = await pollGeneration(session, created.requestId || requestId)
    if (!current.video) throw failure('生成服务没有返回视频', 502)
    const outputDirectory = safeDirectory(payload.outputDirectory, safeDirectory(payload.directory ? `${payload.directory}/assets` : '', 'assets'))
    const content = await fetchVideoBytes(request, current.requestId)
    const path = await saveToWorkspace(session.userId, outputDirectory, content.mime || current.video.mime, content.bytes, 'mp4')
    return [{ path, mimeType: content.mime || current.video.mime || 'video/mp4', mediaType: 'video' }]
  }

  async function createVideoCompat(request, session, payload, model, requestId) {
    const toReference = async (item) => (await referenceUrl(request, session, item?.path))
    const images = (await mapAsync((Array.isArray(payload.images) ? payload.images : []), toReference))
    const videos = (await mapAsync((Array.isArray(payload.videos) ? payload.videos : []), toReference))
    const audios = (await mapAsync((Array.isArray(payload.audios) ? payload.audios : []), toReference))
    const firstFrame = payload.firstFrame?.path ? (await referenceUrl(request, session, payload.firstFrame.path)) : ''
    const lastFrame = payload.lastFrame?.path ? (await referenceUrl(request, session, payload.lastFrame.path)) : ''
    const mode = Array.isArray(payload.mode) ? 'image' : String(payload.mode || 'text')
    return createVideo({
      model: model.id,
      prompt: String(payload.prompt || ''),
      mode,
      ratio: String(payload.ratio || '').trim() || undefined,
      resolution: String(payload.resolution || payload.size || '').trim() || undefined,
      duration: Number(payload.duration) || undefined,
      generateAudio: payload.generateAudio,
      creativeMode: payload.creativeMode ?? payload.parameters?.creativeMode,
      cameraFixed: payload.cameraFixed ?? payload.parameters?.cameraFixed,
      returnLastFrame: payload.returnLastFrame ?? payload.parameters?.returnLastFrame,
      webSearch: payload.webSearch ?? payload.parameters?.webSearch,
      frames: payload.frames,
      seed: payload.seed,
      contextIr: payload.contextIr,
      referenceVoices: payload.referenceVoices,
      firstFrame: firstFrame || undefined,
      lastFrame: lastFrame || undefined,
      image: firstFrame || (mode === 'singleImage' ? images[0] : undefined) || undefined,
      images: images.length ? images : undefined,
      videos: videos.length ? videos : undefined,
      audios: audios.length ? audios : undefined,
      requestId,
      idempotencyKey: requestId,
    }, session, { management, env: process.env, probeReferenceMedia })
  }

  async function handle(request, response, session, url, helpers) {
    const { json, readJson, sameOrigin } = helpers
    const mutate = () => {
      sameOrigin(request)
      if (!isWorkspaceRequest(request.headers)) throw failure('请求被拒绝，请刷新页面后重试', 403)
    }
    try {
      if (url.pathname === '/api/ai/models' && request.method === 'GET') {
        json(response, 200, { code: 200, message: 'ok', data: await listLanguageModels(session) })
        return true
      }
      if (url.pathname === '/api/ai/media/models' && request.method === 'GET') {
        json(response, 200, { code: 200, message: 'ok', data: await listMediaModels(session) })
        return true
      }
      if (url.pathname === '/api/ai/generate' && request.method === 'POST') {
        mutate()
        await streamText(request, response, session)
        return true
      }
      if (url.pathname === '/api/ai/media/generate' && request.method === 'POST') {
        mutate()
        const payload = await readJson(request, MAX_BODY_BYTES)
        const data = payload?.mediaType === 'video'
          ? await generateVideo(request, session, payload)
          : await generateImage(session, payload)
        json(response, 200, { code: 200, message: 'ok', data })
        return true
      }
      return false
    } catch (error) {
      if (response.headersSent) throw error
      json(response, error.status || 500, { code: error.status || 500, message: error.message || 'AI 请求失败' })
      return true
    }
  }

  return { handle, streamText, stop: () => textOperations.stop() }
}
