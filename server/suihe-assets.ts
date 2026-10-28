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
