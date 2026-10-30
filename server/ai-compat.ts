import { createTextMeter } from './text-metering.ts'
import { isWorkspaceRequest } from './canvas-document.ts'
// MiaoImg 节点脚手架的 AI 兼容层。
// 节点会调用 /api/ai/models、/api/ai/media/models、/api/ai/generate 三个接口。
// 这里把它们接回妙图已有的模型目录与文本通道，不新开任何绕过积分与计费的通道。
import { failure } from './management-store.ts'
import { withReplyLanguage } from './reply-language.ts'
import { publicTextCatalog, textChannelReady, textModelById } from './text-models.ts'
import { listPublicProviderModels, providerById, providerRequestBaseUrl } from './text-providers.ts'
import { activeModelForSettings, publicModelCatalog, publicVideoCatalog } from './image-models.ts'
import { imageCreditsBySize, imageCreditsPerImage } from './generation-cost.ts'
import { textSettings } from './text-models.ts'
import { createAgentModel } from './agent-runtime.ts'
import { customTextModel } from './text-model-registry.ts'
import { assertTextAccess, assertTextIdentity } from './text-access.ts'
import { readModelJson } from './model-transport.ts'
import { TextOperations } from './text-lifetime.ts'
import { refreshSuiheModels } from './suihe.ts'

export function createAiCompat({ management, workspaceFiles, customProviderFetch }: Record<string, any>) {
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
        supportsEdit: Boolean(model.supportsEdit),
        supportsTransparent: Boolean(model.supportsTransparent),
        transparentInput: model.transparentInput ?? null,
        referenceRoles: model.referenceRoles || [],
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
        ...(model.maxReferenceVoices ? { referenceVoices: model.referenceVoices || [], maxReferenceVoices: model.maxReferenceVoices } : {}),
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
      const sdkContext = { ...context, messages, systemPrompt: withReplyLanguage([context.systemPrompt, referenceBlock(payload?.references)].filter(Boolean).join('\n\n')), ...(Array.isArray(context.tools) ? { tools: toolDefinitions } : {}) }
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
          baseUrl: providerRequestBaseUrl(provider.apiUrl),
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

  async function handle(request, response, session, url, helpers) {
    const { json, sameOrigin } = helpers
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
      return false
    } catch (error) {
      if (response.headersSent) throw error
      json(response, error.status || 500, { code: error.status || 500, message: error.message || 'AI 请求失败' })
      return true
    }
  }

  return { handle, streamText, stop: () => textOperations.stop() }
}
