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
  const id = String(userId || '')
  if (!id) throw Object.assign(new Error('请先登录后使用素材库'), { status: 401 })
  const suffix = /^[A-Za-z0-9_-]{1,96}$/.test(id) ? id : 'hash.' + createHash('sha256').update(id).digest('hex')
  return `miaoimg-user-${suffix}`
}

async function readJson(response) {
  let data: Record<string, any> = {}
  try { data = await response.json() } catch { throw Object.assign(new Error('穗禾素材库响应格式异常'), { status: 502 }) }
  if (!response.ok || data?.error) {
    const message = String(data?.error?.message || data?.message || `穗禾素材库请求失败（${response.status}）`).slice(0, 500)
    throw Object.assign(new Error(message), { status: response.status >= 500 ? 502 : 422, upstreamStatus: response.status, upstreamCode: String(data?.code || data?.error_detail?.code || data?.error?.code || '') })
  }
  return data
}

export function suiheAssetSubKey(userId) { return subKey(userId) }

export async function uploadSuiheAsset({ userId, bytes, mime, name, store, library = 'whitelist', env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  subKey(userId)
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
  const result = await readJson(response)
  const id = String(result.reference_id ?? result.id ?? '').trim()
  if (store && id) {
    const sha = createHash('sha256').update(bytes).digest('hex')
    await store.saveSuiheLibraryAsset(userId, library, sha, id, normalizeStatus(result.status || (library === 'cloud' ? 'active' : 'processing')))
    for (const alias of [result.reference_id,result.id].filter(value=>typeof value==='string' && value.trim())) await store.registerSuiheLibraryReference?.(userId,library,String(alias).trim(),sha)
    try { await store.audit?.(userId, 'suihe.asset.upload', library, { sha256: sha, status: normalizeStatus(result.status), chargedCredits: result.charged_credits == null ? null : Number(result.charged_credits), unit: 'supplier_credits' }) } catch { /* A logging failure cannot discard the accepted asset receipt. */ }
  }
  return result
}

export async function listSuiheAssets({ userId, store, library = 'whitelist', page = 1, pageSize = 100, env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  const config = settings(env)
  if (!config.apiKey) throw Object.assign(new Error('穗禾素材库尚未配置'), { status: 503 })
  if (!['whitelist', 'cloud'].includes(library)) throw Object.assign(new Error('穗禾素材库类型无效'), { status: 422 })
  const endpoint = library === 'whitelist' ? 'whitelist' : 'assets'
  const response = await createMediaProviderFetch({ env, fetchImpl })(`${config.baseUrl}/v1/asset-library/${endpoint}/list`, {
    method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'x-integrator-sub-key': subKey(userId), 'content-type': 'application/json' },
    body: JSON.stringify({ page_number: Math.max(1, Math.floor(Number(page) || 1)), page_size: Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 100))) }), signal,
  })
  const data = await readJson(response)
  if (store?.registerSuiheLibraryReference) {
    const rows = [data.items,data.data?.items,data.list,data.data?.list,data.data].find(Array.isArray) || []
    for (const row of rows) {
      if (!row || row.readonly === true) continue
      for (const token of [row.reference_id,row.id].filter(value => typeof value === 'string' && value.trim())) await store.registerSuiheLibraryReference(userId,library,String(token).trim())
    }
  }
  return data
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

// Suihe does not authorize end users for the integrator. App-owned
// registration is the user authorization boundary. Supplier detail
// only checks availability; whitelist items must also be Active before use.
export async function assertSuiheLibraryReferences({ userId, store, references = [], env = process.env, fetchImpl = fetch, signal }: Record<string, any> = {}) {
  if (!userId) throw Object.assign(new Error('请先登录后使用素材库'), { status: 401 })
  for (const reference of new Set<string>(references.map(value => String(value || '').trim()))) {
    const match = /^(asset|whitelist):\/\/(.+)$/i.exec(reference)
    if (!match) throw Object.assign(new Error('素材库引用格式无效'), { status: 422 })
    const whitelist = match[1].toLowerCase() === 'whitelist'
    const library = whitelist ? 'whitelist' : 'cloud'
    if (!store?.suiheLibraryReference) throw Object.assign(new Error('参考素材校验服务不可用，已阻止生成'), { status: 503 })
    const registered = (await store.suiheLibraryReference(userId, library, match[2]))
    if (!registered) throw Object.assign(new Error(whitelist ? '人物白名单中找不到这个角色，请重新选择' : '云端素材库中找不到这个素材，请重新选择'), { status: 422 })
    let item
    try {
      item = whitelist
        ? await getSuiheWhitelistAsset({ userId, id: match[2], env, fetchImpl, signal })
        : await getSuiheCloudAsset({ userId, id: match[2], env, fetchImpl, signal })
    } catch (error) {
      if (error?.status === 422) throw Object.assign(new Error(whitelist ? '人物白名单中找不到这个角色，请重新选择' : '云端素材库中找不到这个素材，请重新选择'), { status: 422 })
      throw error
    }
    const details = item?.data && typeof item.data === 'object' ? item.data : item
    // An authenticated detail reply refers to the registered asset even if it
    // rotates the opaque token. Retain both aliases; dedup still uses bytes.
    for (const alias of [details?.reference_id, details?.id].filter(value => typeof value === 'string' && value.trim())) await store.registerSuiheLibraryReference?.(userId, library, String(alias).trim(), registered.sha256 || '')
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

// Only the authenticated backend list is allowed to import ownership aliases.
// A newly issued list token is not a content identity and never drives dedup.
export async function listSuiheWhitelistAssets({userId,store,pageNumber=1,pageSize=100,env=process.env,fetchImpl=fetch,signal}:Record<string,any>={}) {
  if (!store?.registerSuiheLibraryReference) throw Object.assign(new Error('参考素材校验服务不可用，已阻止生成'),{status:503})
  const namespace = subKey(userId), config = settings(env)
  const response = await createMediaProviderFetch({env,fetchImpl})(config.baseUrl+'/v1/asset-library/whitelist/list',{
    method:'POST',headers:{authorization:`Bearer ${config.apiKey}`,'x-integrator-sub-key':namespace,'content-type':'application/json'},
    body:JSON.stringify({page_number:Math.max(1,Math.floor(Number(pageNumber)||1)),page_size:Math.min(100,Math.max(1,Math.floor(Number(pageSize)||100)))}),signal})
  const data = await readJson(response)
  const rows = [data.items,data.data?.items,data.list,data.data?.list,data.data].find(Array.isArray) || []
  for (const row of rows) {
    if (!row || row.readonly === true) continue
    for (const token of [row.reference_id,row.id].filter(value=>typeof value==='string' && value.trim())) await store.registerSuiheLibraryReference(userId,'whitelist',String(token).trim())
  }
  return data
}

const WHITELIST_READY_TIMEOUT_MS = 120_000
const WHITELIST_POLL_MS = 2_000
const pendingWhitelists = new Map<string, Promise<string | null>>()
const isLibraryReference = value => /^(?:asset|whitelist):\/\/\S+$/i.test(String(value || '').trim())
const normalizeStatus = value => /^[a-z_-]{1,60}$/.test(String(value || '').trim().toLowerCase()) ? String(value).trim().toLowerCase() : 'unknown'
const sleep = (ms, signal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return }
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason) }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
  signal?.addEventListener('abort', abort, { once: true })
})

// Prepare all admitted image slots using the original bytes, with no face
// guessing. Dispatch scope is frozen per task; content reuse spans modes.
// The supplier verified zero storage price for the current Key on 2026-10-29;
// this function does not promise that every Key or future upload is free.
export async function whitelistReferenceImages(request, { userId, store, readBytes, env = process.env, fetchImpl = fetch, signal,
  readyTimeoutMs = WHITELIST_READY_TIMEOUT_MS, pollMs = WHITELIST_POLL_MS }: Record<string, any> = {}) {
  if (request.model?.provider && request.model.provider !== 'suihe') return request
  if (!userId || !store || !readBytes) return request
  const existing = [request.image,...(request.images||[]),request.firstFrame,request.lastFrame].filter(isLibraryReference)
  if (existing.length) await assertSuiheLibraryReferences({userId,store,references:existing,env,fetchImpl,signal})
  const config = settings(env)
  const prepared = new Map<string, Promise<string>>()
  const prepare = value => {
    if (!value || isLibraryReference(value)) return Promise.resolve(value)
    if (!prepared.has(value)) prepared.set(value, (async () => {
      try {
        signal?.throwIfAborted()
        const blob = await readBytes(value)
        const bytes = Buffer.from(await blob.arrayBuffer())
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const workKey = createHash('sha256').update(JSON.stringify([config.baseUrl,config.apiKey,userId,sha256])).digest('hex')
        let work = pendingWhitelists.get(workKey)
        if (!work) {
          work = (async () => {
            let cached = (await store.suiheLibraryAsset(userId, 'whitelist', sha256))
            let id = String(cached?.referenceId || '')
            let status = normalizeStatus(cached?.status)
            if (cached && !id) return null // a previous ambiguous upload must not be repeated automatically
            if (id) {
              try {
                const reply = await getSuiheWhitelistAsset({ userId, id, env, fetchImpl, signal })
                const item = reply?.data && typeof reply.data === 'object' ? reply.data : reply
                id = String(item.reference_id ?? item.id ?? id).trim()
                status = normalizeStatus(item.status)
                await store.saveSuiheLibraryAsset(userId, 'whitelist', sha256, id, status)
              } catch (error) {
                if (signal?.aborted) throw error
                // Only an authoritative 404 may discard a missing asset. A
                // transport/unknown status never authorizes another purchase.
                if (error?.upstreamStatus !== 404) return null
                await store.forgetSuiheLibraryAsset(userId, 'whitelist', sha256)
                cached = null; id = ''
              }
            }
            if (!id) {
              await store.saveSuiheLibraryAsset(userId, 'whitelist', sha256, '', 'uploading')
              let uploaded
              try { uploaded = await uploadSuiheAsset({ userId, bytes, mime: blob.type, name: `妙图参考-${sha256.slice(0,12)}`, library:'whitelist', store, env, fetchImpl, signal }) }
              catch (error) {
                // A local alias/log failure after receipt persistence must not
                // replace the known supplier token with an empty marker.
                if (!(await store.suiheLibraryAsset(userId,'whitelist',sha256))?.referenceId) {
                  await store.saveSuiheLibraryAsset(userId,'whitelist',sha256,'','upload_unknown')
                  try { await store.audit?.(userId,'suihe.asset.upload_uncertain','whitelist',{library:'whitelist',sha256,status:'upload_unknown',chargedCredits:null}) } catch { /* Preserve the original storage error. */ }
                }
                throw error
              }
              id = String(uploaded.reference_id ?? uploaded.id ?? '').trim()
              if (!id) { await store.saveSuiheLibraryAsset(userId,'whitelist',sha256,'','upload_unknown'); return null }
              status = normalizeStatus(uploaded.status)
              await store.saveSuiheLibraryAsset(userId,'whitelist',sha256,id,status)
            }
            const deadline = Date.now() + Math.max(0,Number(readyTimeoutMs)||0)
            while (status !== 'active' && status !== 'failed' && Date.now() < deadline) {
              await sleep(Math.max(0,Number(pollMs)||0),signal)
              const reply = await getSuiheWhitelistAsset({userId,id,env,fetchImpl,signal})
              const item = reply?.data && typeof reply.data === 'object' ? reply.data : reply
              id = String(item.reference_id ?? item.id ?? id).trim()
              status = normalizeStatus(item.status)
              await store.saveSuiheLibraryAsset(userId,'whitelist',sha256,id,status)
            }
            if (status === 'active') return `whitelist://${id}`
            if (status === 'failed') return null // no implicit retry/re-purchase of a failed stored asset
            throw Object.assign(new Error('人物仍在入库处理中，请稍后再生成'),{status:422,whitelistProcessing:true})
          })()
          pendingWhitelists.set(workKey,work)
          work.finally(()=>{if(pendingWhitelists.get(workKey)===work)pendingWhitelists.delete(workKey)}).catch(()=>{})
        }
        return (await work) || value
      } catch (error) {
        if (signal?.aborted || error?.whitelistProcessing) throw error
        console.warn('[suihe] whitelist preparation unavailable; direct reference retained', Number(error?.status)||'unknown')
        return value
      }
    })())
    return prepared.get(value)
  }
  const imageSlots = request.images || []
  // Join all admitted storage work before returning an error, so one pending
  // frame cannot abandon another slot's accepted receipt in the background.
  const settled = await Promise.allSettled([prepare(request.image),...imageSlots.map(prepare),prepare(request.firstFrame),prepare(request.lastFrame)])
  const values = settled.map(result=>{if(result.status==='rejected')throw result.reason;return result.value})
  return {...request,image:values[0],images:values.slice(1,1+imageSlots.length),firstFrame:values.at(-2),lastFrame:values.at(-1)}
}
