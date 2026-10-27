import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { VIDEO_CONTAINER_FORMATS } from './media-input.ts'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// 上游（秘塔 / 火山）只接受可公开访问的参考素材地址。画布里的图片、视频、音频
// 都存在用户工作区里，不能直接给上游，所以由服务端签发一个短时效的只读链接：
//   https://<域名>/api/imagine/reference?t=<token>
// token 绑定用户、项目、文件路径和过期时间，过期或篡改都会拒绝。
// project 是后加的字段（j）：老的 token 里没有它，回落到默认项目，正在飞的链接不会因为这次升级失效。
export const REFERENCE_TTL_MS = 6 * 60 * 60 * 1000
// This is only a transport-size guard for data: URIs.  It never resizes,
// recompresses, or otherwise changes the source bytes: base64 decoding the
// value produces the exact bytes stored in workspace_files.  Larger images and
// all videos/audio use the same bytes through the signed nginx URL instead.
export const REFERENCE_DATA_URI_MAX_BYTES = 4 * 1024 * 1024
export const REFERENCE_RETRY_DELAYS_MS = Object.freeze([250, 750])

export function isReferenceMediaMime(mime) {
  return /^(image|video|audio)\/[a-z0-9.+-]+$/i.test(String(mime || '').split(';', 1)[0].trim())
}

export function createReferenceToken(secret, { userId, path, revision, project, expiresAt = Date.now() + REFERENCE_TTL_MS }: Record<string, any> = {}) {
  if (!secret || !userId || !path) throw new Error('参考资源签名参数不完整')
  const payload = Buffer.from(JSON.stringify({ u: String(userId), p: String(path), ...(revision ? { r: String(revision) } : {}), ...(project ? { j: String(project) } : {}), e: Number(expiresAt) })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyReferenceToken(secret, token) {
  if (!secret) return null
  const value = String(token || '')
  const split = value.lastIndexOf('.')
  if (split <= 0 || split >= value.length - 1) return null
  const payload = value.slice(0, split)
  const signature = value.slice(split + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('base64url')
  const provided = Buffer.from(signature)
  const wanted = Buffer.from(expected)
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null
  let data
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!data || typeof data.u !== 'string' || typeof data.p !== 'string' || !Number.isFinite(Number(data.e))) return null
  if (Date.now() > Number(data.e)) return null
  return { userId: data.u, path: data.p, revision: typeof data.r === 'string' ? data.r : '', project: typeof data.j === 'string' ? data.j : '', expiresAt: Number(data.e) }
}

export function createReferenceUrl(secret, { userId, path, revision, project, publicOrigin, expiresAt }: Record<string, any> = {}) {
  const origin = String(publicOrigin || '').replace(/\/$/, '')
  if (!origin) throw new Error('参考资源公网地址未配置')
  const token = createReferenceToken(secret, { userId, path, revision, project, expiresAt })
  return `${origin}/api/imagine/reference?t=${encodeURIComponent(token)}`
}

function dataUriInfo(value) {
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ''))
  if (!match) return null
  const mime = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase()
  const bytes = Buffer.from(match[2], 'base64')
  return { mime, bytes, size: bytes.length }
}

export function referenceUrlShape(value) {
  const text = String(value || '')
  const data = dataUriInfo(text)
  if (data) return { kind: 'data-uri', mime: data.mime, bytes: data.size }
  try {
    const url = new URL(text)
    return { kind: 'url', protocol: url.protocol, host: url.host, path: url.pathname, signed: url.pathname === '/api/imagine/reference' && url.searchParams.has('t') }
  } catch {
    return { kind: 'invalid', bytes: Buffer.byteLength(text) }
  }
}

export function redactReferenceUrl(value) {
  const text = String(value || '')
  const data = dataUriInfo(text)
  if (data) return `[data-uri ${data.mime} ${data.size} bytes]`
  try {
    const url = new URL(text)
    // Keep the route and host useful for diagnosis, but never persist a token
    // or arbitrary query string supplied by a user.
    return `${url.origin}${url.pathname}${url.search ? '?[REDACTED_QUERY]' : ''}`
  } catch {
    return text.slice(0, 200)
  }
}

export function summarizeReferenceValue(value, extra: Record<string, any> = {}) {
  return { ...referenceUrlShape(value), ...(extra.mime ? { mime: String(extra.mime) } : {}), ...(extra.bytes !== undefined ? { bytes: Number(extra.bytes) || 0 } : {}), value: redactReferenceUrl(value) }
}

// Recursively redact provider bodies before they enter upstream_calls.  This
// is intentionally generic because Ark, MetaSo and Yunshu use different body
// shapes (image_url, video_url, keyframes, ...).
export function redactReferencePayload(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:') || /^https?:\/\//i.test(value)) return redactReferenceUrl(value)
    return value
  }
  if (Array.isArray(value)) return value.map(redactReferencePayload)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactReferencePayload(item)]))
}

export function createReferenceMaterializer({ workspaceFiles, secret, publicOrigin, inlineMaxBytes = REFERENCE_DATA_URI_MAX_BYTES }: Record<string, any> = {}) {
  if (!workspaceFiles) throw new Error('参考资源物化器缺少工作区')
  return function materializeReference(value, userId, { kind = 'image', inline = false }: Record<string, any> = {}) {
    const original = String(value || '').trim()
    const parsedData = dataUriInfo(original)
    if (parsedData) return { value: original, mime: parsedData.mime, bytes: parsedData.size, inline: true, source: 'data-uri' }
    let target
    try { target = new URL(original) } catch { return { value: original, inline: false, source: 'external-url' } }
    const origin = String(publicOrigin || '').replace(/\/$/, '')
    if (!origin || target.origin !== origin || target.pathname !== '/api/imagine/reference') return { value: original, inline: false, source: 'external-url' }
    const token = verifyReferenceToken(typeof secret === 'function' ? secret() : secret, target.searchParams.get('t'))
    if (!token || token.userId !== String(userId || '')) throw Object.assign(new Error('参考素材不属于当前账号，或链接已过期，请重新连接参考图后重试'), { status: 403 })
    const file = workspaceFiles.locate(token.userId, token.path, token.project)
    if (token.revision && token.revision !== file.revision) throw Object.assign(new Error('参考素材已更新，请重新获取链接'), { status: 409 })
    if (!isReferenceMediaMime(file.mime) || !String(file.mime).startsWith(`${kind}/`)) throw Object.assign(new Error('参考素材类型不受支持'), { status: 422 })
    const freshUrl = createReferenceUrl(typeof secret === 'function' ? secret() : secret, { userId: token.userId, path: file.path, revision: file.revision, project: file.project || token.project, publicOrigin })
    const indexedSize = Number(file.size) || 0
    if (inline && kind === 'image' && indexedSize <= inlineMaxBytes) {
      const content = workspaceFiles.read(token.userId, token.path, token.project)
      const bytes = Buffer.from(content.bytes || [])
      if (bytes.length > inlineMaxBytes) return { value: freshUrl, mime: file.mime, bytes: bytes.length, inline: false, source: 'workspace' }
      return { value: `data:${file.mime};base64,${bytes.toString('base64')}`, mime: file.mime, bytes: bytes.length, inline: true, source: 'workspace' }
    }
    return { value: freshUrl, mime: file.mime, bytes: indexedSize, inline: false, source: 'workspace' }
  }
}

// Probe unchanged bytes, sharing metadata across quotes and submissions.
// Only metadata is cached; source buffers and temporary copies are not retained.
export function createMediaProbe({ execImpl = execFileAsync }: Record<string, any> = {}) {
  const cache = new Map()
  const pending = new Map()
  let active = 0
  const waiting: { resolve: () => void; signal?: AbortSignal; abort: () => void }[] = []
  async function enter(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (active < 2) { active += 1; return }
    if (waiting.length >= 8) throw Object.assign(new Error('参考素材正在处理中，请稍后重试'), { status: 503 })
    await new Promise<void>((resolve, reject) => {
      const ticket = { resolve, signal, abort: () => {
        const index = waiting.indexOf(ticket)
        if (index >= 0) waiting.splice(index, 1)
        signal?.removeEventListener('abort', ticket.abort)
        reject(signal?.reason)
      } }
      waiting.push(ticket)
      signal?.addEventListener('abort', ticket.abort, { once: true })
    })
  }
  function leave() {
    const next = waiting.shift()
    if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve() }
    else active -= 1
  }
  return async function probeMedia(input, kind, { signal, requireDuration = true }: { signal?: AbortSignal; requireDuration?: boolean } = {}) {
    signal?.throwIfAborted()
    // Stream receivers own an immutable, closed file and its digest. Reuse it
    // directly; neither the probe nor its metadata cache retains video bytes.
    const file = typeof input?.diskPath === 'string' ? input : null
    const content = file ? null : Buffer.from(input || [])
    const digest = file ? file.sha256 : createHash('sha256').update(content).digest('hex')
    const key = digest ? kind + ':' + (requireDuration ? 'duration:' : 'packets:') + digest : null
    if (cache.has(key)) return cache.get(key)
    // An aborted caller must not cancel another caller's shared child process.
    if (!signal && key && pending.has(key)) return pending.get(key)
    const work = (async () => {
      await enter(signal)
      let directory
      try {
        signal?.throwIfAborted()
        let path = file?.diskPath
        if (!file) {
          directory = await mkdtemp(join(tmpdir(), 'miao-reference-'))
          path = join(directory, 'media')
          await writeFile(path, content, { signal })
        }
        const { stdout } = await execImpl('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
          ...(kind === 'video' ? ['-format_whitelist', VIDEO_CONTAINER_FORMATS] : []),
          ...(!requireDuration && kind === 'video' ? ['-count_packets'] : []),
          '-show_format', '-show_streams', '-of', 'json', path], { timeout: 15000, maxBuffer: 1024 * 1024, signal })
        signal?.throwIfAborted()
        const data = JSON.parse(stdout)
        const stream = (data.streams || []).find(item => item.codec_type === (kind === 'image' ? 'video' : kind) && (kind !== 'video' || !item.disposition?.attached_pic))
        const duration = Number(data.format?.duration || stream?.duration)
        if (!stream || (kind !== 'audio' && !(stream.width > 0 && stream.height > 0)) ||
          (kind !== 'image' && requireDuration && (!Number.isFinite(duration) || duration <= 0)) ||
          (kind === 'video' && !requireDuration && !(Number(stream.nb_read_packets) > 0))) throw new Error('媒体元信息无效')
        const [numerator, denominator = 1] = String(stream.avg_frame_rate || stream.r_frame_rate || '0/1').split('/').map(Number)
        const metadata = {
          sizeBytes: file ? file.size : content.length,
          duration: kind === 'image' || !Number.isFinite(duration) ? 0 : Math.round(duration * 1000) / 1000,
          width: Number(stream.width) || 0, height: Number(stream.height) || 0,
          codec: String(stream.codec_name || ''), format: String(data.format?.format_name || ''),
          fps: denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : 0,
        }
        if (key) {
          cache.set(key, metadata)
          if (cache.size > 200) cache.delete(cache.keys().next().value)
        }
        return metadata
      } catch {
        signal?.throwIfAborted()
        throw Object.assign(new Error('服务端无法读取参考素材，请确认文件完整且可以播放'), { status: 422 })
      } finally {
        try { if (directory) await rm(directory, { recursive: true, force: true }) }
        finally { leave() }
      }
    })()
    if (!signal && key) pending.set(key, work)
    try { return await work }
    finally { if (pending.get(key) === work) pending.delete(key) }
  }
}

export const createMediaBufferProbe = createMediaProbe

// All ownership, project and revision checks happen before probing/cache lookup.
export function createReferenceMediaProbe({ workspaceFiles, secret, publicOrigin, execImpl = execFileAsync }: Record<string, any> = {}) {
  const probeBytes = createMediaBufferProbe({ execImpl })
  const cache = new Map()
  const pendingProbes = new Map()
  return async function probeReference(url, userId, kind, { signal }: { signal?: AbortSignal } = {}) {
    signal?.throwIfAborted()
    if (!userId) throw Object.assign(new Error('请先登录后使用参考素材'), { status: 401 })
    let target
    try { target = new URL(String(url)) } catch { throw Object.assign(new Error('参考素材地址无效'), { status: 422 }) }
    const origin = String(publicOrigin || '').replace(/\/$/, '')
    if (!origin || target.origin !== origin || target.pathname !== '/api/imagine/reference') {
      throw Object.assign(new Error('请先将参考图片、视频或音频上传到画布，再连接到生成节点'), { status: 422 })
    }
    const token = verifyReferenceToken(typeof secret === 'function' ? secret() : secret, target.searchParams.get('t'))
    if (!token || token.userId !== userId) throw Object.assign(new Error('参考素材不属于当前账号，或链接已过期'), { status: 403 })
    const file = workspaceFiles.stat(userId, token.path, token.project)
    if (token.revision && token.revision !== file.revision) throw Object.assign(new Error('参考素材已更新，请重新连接后生成'), { status: 409 })
    if (!String(file.mime || '').startsWith(kind + '/')) throw Object.assign(new Error('参考素材类型不匹配'), { status: 422 })
    const key = JSON.stringify([userId, token.project || '', file.path, file.revision, kind])
    if (cache.has(key)) return cache.get(key)
    // Completed metadata is reusable. A cancellable caller owns its own probe
    // lifetime instead of aborting another request's shared child process.
    if (!signal && pendingProbes.has(key)) return pendingProbes.get(key)
    const pending = (async () => {
      const content = workspaceFiles.read(userId, token.path, token.project)
      if (content.revision !== file.revision) throw Object.assign(new Error('参考素材已更新，请重新连接后生成'), { status: 409 })
      const metadata = { ...await probeBytes(content.bytes, kind, { signal }), mime: file.mime }
      signal?.throwIfAborted()
      return metadata
    })()
    if (!signal) pendingProbes.set(key, pending)
    try {
      const result = await pending
      cache.set(key, result)
      if (cache.size > 200) cache.delete(cache.keys().next().value)
      return result
    } finally { if (pendingProbes.get(key) === pending) pendingProbes.delete(key) }
  }
}
