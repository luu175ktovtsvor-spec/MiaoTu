// 秘塔（metaso.cn）视频通道：H3 与 Seedance 2.0 / Mini 全部走 MiniMax 兼容协议
// （与秘塔官方前端生成的 cURL 示例一致）：
//   POST /api/minimax/v2/video_generation        提交任务
//   GET  /api/minimax/v2/query/video_generation/{id}  查询任务
// 两个模型族的参数不同：
//   - H3：resolution 480p/768P/1080p/2K，ratio 支持 adaptive/21:9/16:9/4:3/1:1/3:4/9:16；
//   - Seedance：resolution 480p/720p（标准版另有 1080p/4K），ratio 六档，
//     必须显式传 context_ir_enabled:false，duration 恒为 4–15 整数秒；
//   - H3 的 Context IR（提示词优化）默认开启、按次计费，context_ir_enabled 优先于控制台开关。
// 声音：H3/Seedance 由模型原生输出，协议没有开关字段；火山方舟的 generate_audio 只走 ark 通道。
import { failure } from './management-store.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { createMediaProviderFetch, ProviderRedirectError } from './provider-fetch.ts'

export const METASO_BASE_URL = 'https://metaso.cn'

export function metasoVideoSettings(env = process.env) {
  const baseUrl = String(env.METASO_BASE_URL || METASO_BASE_URL).replace(/\/$/, '')
  assertProviderRequestAllowed('metaso', baseUrl, env)
  return {
    baseUrl,
    apiKey: runtimeSecret('METASO_API_KEY', env),
    enabled: env.ENABLE_MODEL_CALLS === 'true',
  }
}

function upstreamError(status, data) {
  const message = String(data?.error?.message || data?.message || `秘塔视频请求失败（${status}）`).slice(0, 500)
  const httpCode = Number(data?.error?.http_code || status)
  const upstreamRequestId = String(data?.request_id || data?.requestId || data?.error?.request_id || data?.error?.requestId || '').trim()
  return Object.assign(new Error(upstreamRequestId && !message.includes(upstreamRequestId) ? `${message}（上游 Request id: ${upstreamRequestId}）` : message), {
    status: httpCode >= 500 ? 502 : httpCode >= 400 ? httpCode : 502,
    upstreamStatus: status,
    upstreamRequestId,
    transient: httpCode >= 500,
  })
}

async function responseData(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : {} } catch { return { raw: text.slice(0, 1000) } }
}

export async function createMetasoVideoTask(request, { env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = metasoVideoSettings(env)
  if (!config.enabled) throw failure('模型调用暂不可用，请稍后再试', 503)
  if (!config.apiKey) throw failure('视频服务暂时不可用，请稍后再试', 503)
  return createDirectTask(request, config, createMediaProviderFetch({ env, fetchImpl }), signal)
}

function isSeedanceModel(modelId) {
  return String(modelId || '').startsWith('seedance-')
}

function requestRatio(request) {
  return String(request.ratio || '').trim()
}

async function createDirectTask(request, config, fetchImpl, signal) {
  assertProviderRequestAllowed('metaso', config.baseUrl, process.env)
  const seedance = isSeedanceModel(request.model.id)
  const content: Array<Record<string, any>> = [{ type: 'text', text: request.prompt }]
  // 秘塔的 MiniMax 兼容协议把普通图片输入标成 reference_image；只有
  // 首尾帧模式才使用 first_frame / last_frame。把 singleImage 误标成
  // first_frame 会让 Seedance Mini/H3 的请求进入错误的上游分支。
  const mode = String(request.mode || 'text')
  const frameMode = ['startEndRequired', 'endFrameOptional', 'startFrameOptional'].includes(mode)
  const firstFrame = String(request.firstFrame || '').trim()
  const lastFrame = String(request.lastFrame || '').trim()
  const imageReferences = [...new Set([request.image, ...(request.images || [])].map((url) => String(url || '').trim()).filter(Boolean))]
  const frameUrls = new Set([firstFrame, lastFrame].filter(Boolean))
  if (frameMode) {
    if (firstFrame) content.push({ type: 'image_url', image_url: { url: firstFrame }, role: 'first_frame' })
    if (lastFrame) content.push({ type: 'image_url', image_url: { url: lastFrame }, role: 'last_frame' })
    // 兼容旧客户端：如果它只传 images，按 MiaoImg 的帧顺序补成首帧/尾帧。
    if (!firstFrame && !lastFrame && imageReferences.length) {
      content.push({ type: 'image_url', image_url: { url: imageReferences[0] }, role: 'first_frame' })
      frameUrls.add(imageReferences[0])
      if (imageReferences[1]) {
        content.push({ type: 'image_url', image_url: { url: imageReferences[1] }, role: 'last_frame' })
        frameUrls.add(imageReferences[1])
      }
    }
  }
  // 秘塔规定「首尾帧 + 参考图混合」只有 H3 支持（Seedance 由 video-api 的校验拦住），
  // 所以这里把不作为首尾帧的图片一律作为 reference_image 发出去。
  // 以前这个分支只在非首尾帧模式执行，多出来的参考图会被静默丢弃、钱却照收。
  for (const url of imageReferences) {
    if (frameUrls.has(url)) continue
    content.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  }
  const videos = [...new Set([request.video, ...(request.videos || [])].filter(Boolean))]
  for (const url of videos) content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  for (const url of (request.audios || []).filter(Boolean)) content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  // 秘塔官方模型目录里 Seedance 的分辨率写作小写 `4k`（H3 是 `768P` / `2K`），
  // 分辨率枚举大小写不匹配时上游会直接拒绝，所以这里按官方枚举归一化。
  const requestedResolution = String(request.resolution || '').trim()
  const resolution = seedance ? requestedResolution.replace(/^4K$/i, '4k') : requestedResolution
  const body: Record<string, any> = {
    model: request.model.id,
    content,
    duration: request.duration,
    resolution,
    ratio: requestRatio(request),
  }
  // 秘塔官方调用示例：Seedance 固定关闭 H3 Context IR（该字段只属于 H3 链路）。
  // H3 每次都显式传：不传时按秘塔控制台的全局开关走，计费就和我们的预估对不上。
  body.context_ir_enabled = seedance ? false : request.contextIr !== false
  let response
  try {
    response = await fetchImpl(`${config.baseUrl}/api/minimax/v2/video_generation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (error instanceof ProviderRedirectError || error?.submissionNotStarted === true) throw error
    const code = error?.cause?.code || error?.code || ''
    throw Object.assign(new Error(`秘塔视频创建请求失败：${error?.cause?.message || error?.message || '网络请求失败'}`, { cause: error }), {
      status: 502, transient: true,
      // This catch ends before any HTTP response/body handling. Preserve only
      // the existing contract's definite DNS/connect evidence through wrapping.
      ...(['UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? { code } : {}),
    })
  }
  const data = await responseData(response)
  if (!response.ok || data?.type === 'error') {
    const error = upstreamError(response.status, data)
    error.upstreamRequestId ||= String(response.headers.get('x-request-id') || response.headers.get('request-id') || '').trim()
    throw error
  }
  // 秘塔不同入口的响应包裹层不完全一致：官方前端使用 body.task，
  // 旧版网关则可能把 task_id 放在 data 或 data.task。统一从这些层取，
  // 否则任务已经创建但浏览器拿不到 task id，只会显示失败/处理中。
  const envelopes = [data, data?.body, data?.data].filter((item) => item && typeof item === 'object')
  const task = envelopes.map((item) => item.task).find((item) => item && typeof item === 'object') || null
  const id = String(
    data?.task_id
      || data?.taskId
      || data?.id
      || task?.id
      || task?.task_id
      || data?.body?.task_id
      || data?.body?.taskId
      || data?.data?.task_id
      || data?.data?.taskId
      || '',
  ).trim()
  if (!id) throw Object.assign(new Error('秘塔没有返回任务 ID'), { status: 502, upstreamStatus: response.status, submissionUncertain: true })
  return { id, status: 'queued', upstreamModel: String(data.model || request.model.id), upstreamRequestId: String(data.request_id || id), upstreamStatus: response.status, raw: data, sentPath: '/api/minimax/v2/video_generation', sentBody: body }
}

function progressValue(item) {
  const raw = item?.progress ?? item?.percent ?? item?.percentage
  if (raw === null || raw === undefined || !['number', 'string'].includes(typeof raw) || !String(raw).replace('%', '').trim()) return null
  const value = Number(String(raw).replace('%', ''))
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}

const METASO_STATUS = {
  succeeded: 'succeeded', success: 'succeeded', completed: 'succeeded', complete: 'succeeded',
  failed: 'failed', failure: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'failed',
  not_start: 'queued', submitted: 'queued', queued: 'queued',
}

export async function pollMetasoVideoTask(taskIdValue, { env = process.env, fetchImpl = fetch, signal, model }: Record<string, any> = {}) {
  const id = String(taskIdValue || '').trim()
  if (!id || id.length > 200) throw failure('视频任务标识无效', 422)
  const config = metasoVideoSettings(env)
  return pollDirectTask(id, config, createMediaProviderFetch({ env, fetchImpl }), signal)
}

async function pollDirectTask(id, config, fetchImpl, signal) {
  // 秘塔官方插件 query 路径：/minimax/v2/query/video_generation/{task_id}（task id 是路径段）。
  let response
  try {
    response = await fetchImpl(`${config.baseUrl}/api/minimax/v2/query/video_generation/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      signal,
    })
  } catch (error) {
    if (error instanceof ProviderRedirectError) throw error
    throw Object.assign(new Error(`秘塔视频查询请求失败：${error?.cause?.message || error?.message || '网络请求失败'}`), { status: 502, transient: true })
  }
  const data = await responseData(response)
  if (!response.ok || data?.type === 'error') throw upstreamError(response.status, data)
  // 官方插件解析：优先 body.task，其次顶层 task，再兼容历史 items 数组，
  // 最后才把包裹层本身当任务对象。提交接口和查询接口都可能带 body/data 包裹。
  const envelopes = [data?.body, data?.data, data].filter((entry) => entry && typeof entry === 'object')
  const task = envelopes.map((entry) => entry.task).find((entry) => entry && typeof entry === 'object')
  const items = envelopes.flatMap((entry) => Array.isArray(entry.items) ? entry.items : [])
  const item = task
    || (items.length ? (items.find((entry) => String(entry?.id || entry?.task_id) === id) || items[0]) : null)
    || data?.body
    || data?.data
    || data
    || {}
  const status = String(item?.status || '').toLowerCase()
  const normalized = METASO_STATUS[status] || (['preparing', 'processing', 'running', 'in_progress'].includes(status) ? 'running' : status || 'running')
  const url = String(item?.content?.url || item?.content?.video_url || item?.video_url || item?.url || '').trim()
  const usage = item?.usage || null
  return {
    id,
    status: normalized === 'succeeded' && !url ? 'running' : normalized,
    url,
    mime: 'video/mp4',
    duration: item?.duration ?? usage?.output_seconds ?? null,
    progress: progressValue(item),
    width: null,
    height: null,
    thumbnailUrl: String(item?.cover?.url || item?.cover_url || ''),
    usage,
    error: normalized === 'failed' ? String(item?.error?.message || item?.error || item?.message || '视频生成失败') : '',
    upstreamModel: String(item?.model || ''),
    upstreamRequestId: id,
    upstreamStatus: response.status,
    metadata: { status, resolution: item?.resolution || null, ratio: item?.ratio || null, raw: item },
  }
}

/**
 * 读秘塔控制台的账户余额（同一个 API Key，只读、不计费）。
 * 用途：账户级余额观测；共享账号和异步扣费使前后差额不能归属单次请求。
 */
export async function metasoCreditsBalance({ env = process.env, fetchImpl = fetch }: Record<string, any> = {}) {
  const config = metasoVideoSettings(env)
  if (!config.apiKey) return null
  try {
    const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/api/h3/console/credits/balance`, {
      headers: { authorization: `Bearer ${config.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const data = await response.json().catch(() => null)
    const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null
    const balance=numeric(data?.data?.balance)
    return balance === null ? null : {balance,consumed:numeric(data?.data?.consumed),total:numeric(data?.data?.total)}
  } catch {
    // 余额读不到不影响生成，只是这一单没有余额差样本。
    return null
  }
}

// 余额是异步落账的，调用前后读数只能当作诊断样本，不能当作本次调用的账单。
// 这个入口由定时器和 scripts/reconcile-upstream.ts 共用，保证手工核对与后台展示口径一致。
export async function reconcileMetasoBalance({ management, env = process.env, fetchImpl = fetch, observedAt = new Date().toISOString() }: Record<string, any> = {}) {
  const balance = await metasoCreditsBalance({ env, fetchImpl })
  if (!balance) return { provider: 'metaso', status: 'unknown', conclusion: '余额未知，未对账', alarm: false }
  return management.reconcileUpstreamBalance({ provider: 'metaso', balance: balance.balance, consumed: balance.consumed, total: balance.total, observedAt })
}
