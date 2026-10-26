import { failure } from './management-store.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'
import { createMediaProviderFetch, ProviderRedirectError } from './provider-fetch.ts'

/**
 * 火山方舟 Seedance 视频任务：与豆包生图共用 ARK_API_KEY。
 * 创建 POST /api/v3/contents/generations/tasks，查询 GET /api/v3/contents/generations/tasks/{id}。
 * 文本与图片参考都放在 content 数组里，方舟侧负责分辨率、时长与宽高比的最终校验。
 */
export const ARK_VIDEO_PATHS = Object.freeze({
  create: '/contents/generations/tasks',
  poll: (id) => `/contents/generations/tasks/${encodeURIComponent(id)}`,
})

export function arkVideoSettings(env = process.env) {
  const baseUrl = String(env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '')
  assertProviderRequestAllowed('ark', baseUrl, env)
  return {
    apiKey: runtimeSecret('ARK_API_KEY', env),
    baseUrl,
    enabled: env.ENABLE_MODEL_CALLS === 'true',
  }
}

export function arkVideoReady(env = process.env) {
  const config = arkVideoSettings(env)
  return Boolean(config.enabled && config.apiKey)
}

export function arkVideoContent(request) {
  const parts: Array<Record<string, any>> = [{ type: 'text', text: request.prompt }]
  // Preserve the role supplied by the canvas. A lone last_frame is valid for
  // the optional-tail-frame mode and must not be re-labelled first_frame.
  if (request.firstFrame) {
    parts.push({ type: 'image_url', image_url: { url: request.firstFrame }, role: 'first_frame' })
  }
  if (request.lastFrame) {
    parts.push({ type: 'image_url', image_url: { url: request.lastFrame }, role: 'last_frame' })
  }
  if (!request.firstFrame && !request.lastFrame && request.mode === 'singleImage' && (request.image || request.images?.[0])) {
    // 单图生视频按官方示例用首帧角色。
    parts.push({ type: 'image_url', image_url: { url: request.image || request.images?.[0] }, role: 'first_frame' })
  }
  // 全模态参考：图片 / 视频 / 音频可以组合传入（数量按模型目录校验），首尾帧与参考图互不重复。
  const frameUrls = new Set([request.firstFrame, request.lastFrame].filter(Boolean).concat(request.mode === 'singleImage' ? [request.image, request.images?.[0]].filter(Boolean) : []))
  for (const url of new Set([request.image, ...(request.images || [])].filter(Boolean))) {
    if (frameUrls.has(url)) continue
    parts.push({ type: 'image_url', image_url: { url }, role: 'reference_image' })
  }
  for (const url of request.videos || []) parts.push({ type: 'video_url', video_url: { url }, role: 'reference_video' })
  for (const url of request.audios || []) parts.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' })
  return parts
}

function upstreamMessage(response, data) {
  return String(data?.error?.message || data?.error || data?.message || `方舟视频请求失败（${response.status}）`).slice(0, 500)
}

async function readData(response) {
  const text = await response.text()
  try { return text ? JSON.parse(text) : {} } catch { return { raw: text.slice(0, 1_000) } }
}

// 网络层错误在 undici 里只有 "fetch failed"，把底层原因带出来便于定位。
function networkFailure(action, error) {
  if (error instanceof ProviderRedirectError || error?.submissionNotStarted === true) return error
  const cause = error?.cause?.message || error?.cause?.code || ''
  return Object.assign(new Error(`${action}：${cause || error?.message || '网络请求失败'}`), { status: 502, code: error?.cause?.code || '', name: error?.name || 'Error' })
}

function progressValue(data) {
  const raw = data?.progress ?? data?.percent ?? data?.percentage ?? data?.data?.progress
  if (raw === null || raw === undefined || !['number', 'string'].includes(typeof raw) || !String(raw).replace('%', '').trim()) return null
  const value = Number(String(raw).replace('%', ''))
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
}

export async function createArkVideoTask(request, { env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = arkVideoSettings(env)
  assertProviderRequestAllowed('ark', config.baseUrl, env)
  const body: Record<string, any> = {
    model: request.model.id,
    content: arkVideoContent(request),
    watermark: false,
  }
  const options = request.arkOptions && typeof request.arkOptions === 'object' ? request.arkOptions : {}
  // frames 是 duration 的替代字段（官方两者二选一），给了 frames 就不再传 duration。
  if (options.frames !== undefined) body.frames = options.frames
  else body.duration = options.duration ?? request.duration
  if (request.resolution) body.resolution = request.resolution
  if (request.ratio) body.ratio = request.ratio
  // 只在用户明确开关声音时传 generate_audio。没传就留给方舟自己的默认值。
  if (typeof request.generateAudio === 'boolean') body.generate_audio = request.generateAudio
  for (const key of ['seed', 'camera_fixed', 'return_last_frame', 'output_format', 'tools', 'omni_reference_task_type']) {
    if (options[key] !== undefined) body[key] = options[key]
  }
  let response
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}${ARK_VIDEO_PATHS.create}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })
      break
    } catch (error) {
      // Only a failed connection can be retried safely: no HTTP request was
      // sent. Never resubmit after a header/read timeout or an ambiguous abort.
      if (error?.cause?.code !== 'UND_ERR_CONNECT_TIMEOUT' || signal?.aborted || attempt === 2) throw networkFailure('方舟视频创建请求失败', error)
      await new Promise <void>(resolve => setTimeout(resolve, 1000))
      signal?.throwIfAborted()
    }
  }
  const data = await readData(response)
  if (!response.ok || data?.error) throw Object.assign(new Error(upstreamMessage(response, data)), { status: response.status >= 500 ? 502 : 422, upstreamStatus: response.status })
  const id = String(data?.id || data?.task_id || data?.data?.id || '').trim()
  if (!id) throw Object.assign(new Error('方舟没有返回视频任务 ID'), { status: 502, upstreamStatus: response.status, submissionUncertain: true })
  return { id, status: String(data?.status || 'queued'), upstreamModel: String(data?.model || request.model.id), upstreamRequestId: id, upstreamStatus: response.status, raw: data, sentPath: ARK_VIDEO_PATHS.create, sentBody: body }
}

export async function pollArkVideoTask(taskId, { env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = arkVideoSettings(env)
  const id = String(taskId || '').trim()
  if (!id) throw failure('视频任务标识无效', 422)
  let response
  try {
    response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}${ARK_VIDEO_PATHS.poll(id)}`, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal,
    })
  } catch (error) {
    throw networkFailure('方舟视频查询请求失败', error)
  }
  const data = await readData(response)
  if (!response.ok) throw Object.assign(new Error(upstreamMessage(response, data)), { status: response.status >= 500 ? 502 : 422, upstreamStatus: response.status })
  const rawStatus = String(data?.status || data?.state || '').toLowerCase()
  const url = String(data?.content?.video_url || data?.video_url || data?.data?.video_url || data?.data?.content?.video_url || '').trim()
  const failed = ['failed', 'error', 'cancelled', 'canceled', 'expired'].includes(rawStatus)
  const succeeded = rawStatus === 'succeeded' || (!rawStatus && Boolean(url)) || (rawStatus === 'success')
  return {
    id,
    status: failed ? 'failed' : succeeded ? 'succeeded' : rawStatus || 'running',
    url,
    mime: String(data?.content?.video_mime || data?.mime || 'video/mp4'),
    duration: data?.duration ?? data?.content?.duration ?? null,
    progress: progressValue(data),
    width: data?.width ?? data?.content?.width ?? null,
    height: data?.height ?? data?.content?.height ?? null,
    thumbnailUrl: String(data?.content?.last_frame_url || data?.thumbnail_url || data?.data?.content?.last_frame_url || ''),
    usage: data?.usage || data?.data?.usage || null,
    error: data?.error?.message || data?.error || '',
    upstreamModel: String(data?.model || ''),
    upstreamRequestId: id,
    upstreamStatus: response.status,
    metadata: { status: rawStatus, raw: data },
  }
}
