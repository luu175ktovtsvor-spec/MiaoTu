import { mapAsync } from './async-collections.ts'
import { createHash } from 'node:crypto'
import { createMediaProviderFetch } from './provider-fetch.ts'
import { runtimeSecret } from './runtime-secrets.ts'
import { assertProviderRequestAllowed } from './provider-safety.ts'

const MAX_ASSET_BYTES = 30 * 1024 * 1024

function settings(env = process.env) {
  const baseUrl = String(env.SUIHE_BASE_URL || 'https://api.suihemedia.cloud').replace(/\/+$/, '').replace(/\/v1$/, '')
  assertProviderRequestAllowed('suihe', baseUrl, env)
  return { baseUrl, apiKey: runtimeSecret('SUIHE_API_KEY', env) }
}

function subKey(userId) {
  // The stable namespace is derived server-side; the browser never chooses it.
  return `miaoimg-user-${String(userId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 96)}`
}

async function readJson(response) {
  let data: Record<string, any> = {}
  try { data = await response.json() } catch { throw Object.assign(new Error('穗禾素材库响应格式异常'), { status: 502 }) }
  if (!response.ok || data?.error) {
    const message = String(data?.error?.message || data?.message || `穗禾素材库请求失败（${response.status}）`).slice(0, 500)
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : 422, upstreamStatus: response.status })
  }
  return data
}

export function suiheAssetSubKey(userId) { return subKey(userId) }

export async function uploadSuiheAsset({ userId, bytes, mime, name, library = 'whitelist', env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = settings(env)
  if (!config.apiKey) throw Object.assign(new Error('穗禾素材库尚未配置'), { status: 503 })
  if (!['whitelist', 'cloud'].includes(library)) throw Object.assign(new Error('穗禾素材库类型无效'), { status: 422 })
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_ASSET_BYTES) throw Object.assign(new Error('素材必须为不超过 30MB 的非空文件'), { status: 422 })
  if (library === 'whitelist' && !String(mime || '').toLowerCase().startsWith('image/')) throw Object.assign(new Error('人物白名单只支持图片'), { status: 422 })
  if (library === 'cloud' && !/^(image|audio)\//i.test(String(mime || ''))) throw Object.assign(new Error('穗禾云端素材库只支持图片或音频'), { status: 422 })
  const form = new FormData()
  form.append('library', library)
  form.append('name', String(name || '妙图素材').slice(0, 120))
  form.append('file', new Blob([new Uint8Array(bytes)], { type: String(mime || 'application/octet-stream') }), String(name || 'reference.bin').replace(/[\\/]/g, '_'))
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/asset-library/assets`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'x-integrator-sub-key': subKey(userId) }, body: form, signal,
  })
  return readJson(response)
}

export async function listSuiheAssets({ userId, library = 'whitelist', page = 1, pageSize = 100, env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = settings(env)
  if (!config.apiKey) throw Object.assign(new Error('穗禾素材库尚未配置'), { status: 503 })
  if (!['whitelist', 'cloud'].includes(library)) throw Object.assign(new Error('穗禾素材库类型无效'), { status: 422 })
  const endpoint = library === 'whitelist' ? 'whitelist' : 'assets'
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/asset-library/${endpoint}/list`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'x-integrator-sub-key': subKey(userId), 'content-type': 'application/json' },
    body: JSON.stringify({ page_number: Math.max(1, Math.floor(Number(page) || 1)), page_size: Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 100))) }), signal,
  })
  return readJson(response)
}

export async function getSuiheCloudAsset({ userId, id, env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = settings(env)
  if (!config.apiKey) throw Object.assign(new Error('穗禾素材库尚未配置'), { status: 503 })
  const safeId = encodeURIComponent(String(id || '').trim())
  if (!safeId) throw Object.assign(new Error('穗禾素材 ID 无效'), { status: 422 })
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/asset-library/assets/${safeId}`, {
    headers: { authorization: `Bearer ${config.apiKey}`, 'x-integrator-sub-key': subKey(userId) }, signal,
  })
  return readJson(response)
}

// Users may only cite library items that exist in their own sub-key
// namespace. Suihe does not authorize end users for the integrator, so the
// lookup under the caller's namespace is the ownership check; whitelist
// items must also be Active before a paid generation may reference them.
export async function assertSuiheLibraryReferences({ userId, references = [], env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  if (!userId) throw Object.assign(new Error('请先登录后使用素材库'), { status: 401 })
  for (const reference of new Set<string>(references.map(value => String(value || '').trim()))) {
    const match = /^(asset|whitelist):\/\/(.+)$/i.exec(reference)
    if (!match) throw Object.assign(new Error('素材库引用格式无效'), { status: 422 })
    const whitelist = match[1].toLowerCase() === 'whitelist'
    let item
    try {
      item = whitelist
        ? await getSuiheWhitelistAsset({ userId, id: match[2], env, fetchImpl, signal })
        : await getSuiheCloudAsset({ userId, id: match[2], env, fetchImpl, signal })
    } catch (error) {
      if (error?.status === 422) throw Object.assign(new Error(whitelist ? '人物白名单中找不到这个角色，请重新选择' : '云端素材库中找不到这个素材，请重新选择'), { status: 422 })
      throw error
    }
    if (whitelist) {
      const status = String(item?.status || item?.data?.status || '').trim().toLowerCase()
      if (status === 'processing') throw Object.assign(new Error('人物仍在入库处理中，请稍后再生成'), { status: 422 })
      if (status !== 'active') throw Object.assign(new Error('人物入库未完成或失败，不能用于生成'), { status: 422 })
    }
  }
}

export async function getSuiheWhitelistAsset({ userId, id, env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = settings(env)
  if (!config.apiKey) throw Object.assign(new Error('穗禾素材库尚未配置'), { status: 503 })
  const safeId = encodeURIComponent(String(id || '').trim())
  if (!safeId) throw Object.assign(new Error('穗禾素材 ID 无效'), { status: 422 })
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/asset-library/whitelist/${safeId}`, {
    headers: { authorization: `Bearer ${config.apiKey}`, 'x-integrator-sub-key': subKey(userId) }, signal,
  })
  return readJson(response)
}

const WHITELIST_READY_TIMEOUT_MS = 120_000
const WHITELIST_POLL_MS = 2_000
const isLibraryReference = value => /^(?:asset|whitelist):\/\/\S+$/i.test(String(value || '').trim())
const sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

// Suihe rejects omni-reference images that may show a person unless they are
// cited from the caller's whitelist library. Users never manage that library:
// each reference image is uploaded once per account (keyed by its bytes),
// awaited until Active and cited as whitelist://id. Uploads are free and work
// for non-person images too; any image that cannot be prepared keeps the
// ordinary multipart upload so a library hiccup never blocks other content.
export async function whitelistReferenceImages(request, { userId, store, readBytes, env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  if (!userId || !store || !readBytes) return request
  const prepared = new Map<string, Promise<string>>()
  const prepare = async (value) => {
    if (!value || isLibraryReference(value)) return Promise.resolve(value)
    if (!prepared.has(value)) prepared.set(value, ((async () => {
      try {
        const blob = await readBytes(value)
        const bytes = Buffer.from(await blob.arrayBuffer())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const cached = (await store.suiheLibraryAsset(userId, 'whitelist', sha256))
        if (cached?.status === 'active') {
          try {
            const item = await getSuiheWhitelistAsset({ userId, id: cached.referenceId, env, fetchImpl, signal })
            if (String(item?.status || '').toLowerCase() === 'active') return `whitelist://${cached.referenceId}`
          } catch (error) { if (signal?.aborted) throw error }
          await store.forgetSuiheLibraryAsset(userId, 'whitelist', sha256)
        }
        const uploaded = await uploadSuiheAsset({ userId, bytes, mime: blob.type, name: `妙图参考-${sha256.slice(0, 12)}`, library: 'whitelist', env, fetchImpl, signal })
        const id = String(uploaded?.id || uploaded?.reference_id || '').trim()
        if (!id) return value
        let status = String(uploaded?.status || '').toLowerCase()
        const deadline = Date.now() + WHITELIST_READY_TIMEOUT_MS
        while (status !== 'active' && status !== 'failed' && Date.now() < deadline) {
          await sleep(WHITELIST_POLL_MS, signal)
          status = String((await getSuiheWhitelistAsset({ userId, id, env, fetchImpl, signal }))?.status || '').toLowerCase()
        }
        if (status !== 'active') return value
        await store.saveSuiheLibraryAsset(userId, 'whitelist', sha256, id, 'active')
        return `whitelist://${id}`
      } catch (error) {
        if (signal?.aborted) throw error
        console.warn('[suihe] reference whitelist preparation failed; using direct upload', String(error?.message || error).slice(0, 200))
        return value
      }
    })()))
    return prepared.get(value)
  }
  const [image, images] = await Promise.all([(await prepare(request.image)), Promise.all((await mapAsync((request.images || []), prepare)))])
  return { ...request, image, images }
}
