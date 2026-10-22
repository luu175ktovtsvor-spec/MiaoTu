// 灵感库检索工具：Agent 与 MCP 共用同一份定义与执行体。
// 检索走档案服务的只读 HTTP 接口；可选的参考图落盘复用 workspaceFiles.writeBytes，
// 画布节点仍由浏览器侧已有 canvas/nodeTools 工具创建和设置。
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { failure } from './management-store.ts'
import { createWebTools } from './web/tools.ts'

const MAX_LIMIT = 12
const MAX_SAVED_REFERENCES = 6
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024

function archiveBaseUrl(env = process.env) {
  const configured = String(env.OIP_ARCHIVE_API_URL || '').trim().replace(/\/$/, '')
  if (configured) return configured
  throw failure('灵感库服务暂时不可用', 503)
}

function safeExtension(value, mime = '') {
  const candidate = extname(String(value || '')).toLowerCase().replace(/[^a-z0-9.]/g, '')
  if (/^\.[a-z0-9]{1,8}$/.test(candidate)) return candidate
  const subtype = String(mime).split('/')[1]?.split(';')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '')
  return subtype ? `.${subtype}` : '.bin'
}

function normalizeItem(item) {
  return {
    id: String(item?.tweet_id || ''),
    author: String(item?.author || ''),
    tool: String(item?.tool || ''),
    prompt: String(item?.prompt_text || ''),
    translations: item?.translations && typeof item.translations === 'object' ? item.translations : {},
    sourceUrl: String(item?.tweet_url || ''),
    createdAt: item?.created_at || null,
    tags: item?.tags && typeof item.tags === 'object' ? item.tags : {},
    images: Array.isArray(item?.images) ? item.images.slice(0, 12).map(image => ({
      id: String(image?.id || ''), index: Number(image?.index || 0), url: String(image?.url || ''),
      local: image?.local ? String(image.local) : null,
    })) : [],
    videos: Array.isArray(item?.videos) ? item.videos.slice(0, 8).map(video => ({
      id: String(video?.id || ''), index: Number(video?.index || 0), url: String(video?.url || ''),
      local: video?.local ? String(video.local) : null, poster: video?.poster ? String(video.poster) : null,
    })) : [],
  }
}

async function readResponse(response) {
  const bytes = await createWebTools().readResponseBytes(response, MAX_RESPONSE_BYTES, '灵感库响应过大')
  return JSON.parse(bytes.toString('utf8'))
}

async function fetchLibrary(fetchImpl, env, args, signal) {
  const url = new URL(`${archiveBaseUrl(env)}/api/prompts`)
  const query = String(args.query || args.q || '').trim().slice(0, 200)
  const tag = String(args.tag || '').trim().slice(0, 160)
  const tool = String(args.tool || args.model || '').trim().slice(0, 120)
  if (query) url.searchParams.set('q', query)
  if (tag) url.searchParams.set('tag', tag)
  if (tool) url.searchParams.set('tool', tool)
  url.searchParams.set('limit', String(Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 5))))
  if (Number(args.offset) > 0) url.searchParams.set('offset', String(Math.min(100_000, Math.floor(Number(args.offset)))))
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000), headers: { accept: 'application/json', 'user-agent': 'MiaoImgAgent/1.0' } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw failure(`灵感库查询失败（HTTP ${response.status}）`, 502)
  }
  const data = await readResponse(response)
  const datasetVersion = String(data?.dataset_version || '').trim()
  const datasetReady = data?.dataset_ready === true && data?.dataset_manifest_match === true
  if (!datasetVersion || !datasetReady) {
    throw failure(
      datasetVersion
        ? '档案库与数据清单的版本口径尚未对齐；当前请求不能把检索结果交付为档案原文，也不能保存参考图。'
        : '档案检索的版本口径尚未确认；当前请求不能把检索结果交付为档案原文，也不能保存参考图。',
      409,
    )
  }
  return {
    datasetVersion,
    datasetReady: true,
    total: Number(data?.total || 0),
    offset: Number(data?.offset || 0),
    limit: Number(data?.limit || 0),
    items: Array.isArray(data?.items) ? data.items.map(normalizeItem) : [],
  }
}

function localArchivePath(env, local) {
  const source = String(local || '').replace(/^\/+/, '')
  if (!source || (!source.startsWith('images/') && !source.startsWith('previews/'))) return null
  const root = resolve(String(env.OIP_ARCHIVE_ROOT || env.OIP_REPO_ROOT || process.cwd()))
  const target = resolve(root, source)
  const path = relative(root, target)
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return null
  return target
}

async function fetchImageReference({ fetchImpl, env, item, image, signal }: Record<string, any>) {
  if (!image) throw failure('检索结果没有可用的参考图', 404)
  const localPath = localArchivePath(env, image.local)
  if (localPath && existsSync(localPath)) {
    const root = await realpath(resolve(String(env.OIP_ARCHIVE_ROOT || env.OIP_REPO_ROOT || process.cwd())))
    const actual = await realpath(localPath)
    const mediaRoots = await Promise.all(['images', 'previews'].map(async name => {
      const lexical = resolve(root, name)
      try { const canonical = await realpath(lexical); return canonical === lexical ? canonical : null } catch { return null }
    }))
    if (!mediaRoots.some(directory => directory && actual.startsWith(directory + sep))) throw failure('灵感库参考图路径越界', 403)
    signal?.throwIfAborted()
    const handle = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw failure('灵感库参考图必须是普通文件', 422)
      if (!info.size || info.size > MAX_REFERENCE_BYTES) throw failure('参考图为空或超过 20MB', 413)
      const bytes = Buffer.alloc(info.size + 1)
      let bytesRead = 0
      while (bytesRead < bytes.length) {
        signal?.throwIfAborted()
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead)
        if (!chunk.bytesRead) break
        bytesRead += chunk.bytesRead
      }
      const after = await handle.stat()
      signal?.throwIfAborted()
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
        throw failure('灵感库参考图读取期间发生变化', 409)
      }
      const extension = safeExtension(actual).slice(1)
      return { bytes: bytes.subarray(0, bytesRead), mime: 'image/' + ({ jpg: 'jpeg' }[extension] || extension || 'jpeg'), source: image.local }
    } finally { await handle.close() }
  }
  const cachedSource = env.OIP_ARCHIVE_ASSET_BASE_URL && /^(images|previews)\//.test(String(image.local || '').replace(/^\/+/, ''))
    ? new URL(String(image.local).replace(/^\/+/, ''), String(env.OIP_ARCHIVE_ASSET_BASE_URL).replace(/\/$/, '') + '/').href : ''
  if (!image.url && !cachedSource) throw failure('参考图文件不在当前服务的媒体目录，且没有远程地址', 404)
  const web = createWebTools({ fetchImpl })
  const { response } = await web.fetchPublicResponse(cachedSource || image.url, { signal, headers: { accept: 'image/*' } })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw failure(`参考图读取失败（HTTP ${response.status}）`, 502)
  }
  const bytes = await web.readResponseBytes(response, MAX_REFERENCE_BYTES, '参考图超过 20MB')
  if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw failure('参考图为空或超过 20MB', 413)
  const mime = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0]
  if (!/^image\//.test(mime)) throw failure('灵感库参考地址没有返回图片', 415)
  return { bytes, mime, source: image.url }
}

function imageCandidates(items) {
  return items.flatMap((item, itemIndex) => item.images
    .filter(image => image.local || image.url)
    .map(image => ({ item, image, itemIndex })))
}

async function saveOneReference({ workspaceFiles, userId, candidate, fetchImpl, env, signal, selectionIndex, directory }: Record<string, any>) {
  if (!workspaceFiles || !userId) throw failure('当前没有可写的用户工作区', 409)
  const reference = await fetchImageReference({ fetchImpl, env, item: candidate.item, image: candidate.image, signal })
  const digest = createHash('sha256')
    .update(`${reference.source}\n${candidate.item.id}\n${candidate.image.id}\n${candidate.image.index}`)
    .digest('hex').slice(0, 12)
  const path = `${directory}/reference-${digest}-${randomUUID()}${safeExtension('', reference.mime)}`
  signal?.throwIfAborted()
  const { revision } = workspaceFiles.writeBytes(userId, { path, mime: reference.mime, bytes: reference.bytes, revision: null })
  return {
    index: selectionIndex,
    itemId: candidate.item.id,
    imageId: candidate.image.id,
    imageIndex: candidate.image.index,
    path, mime: reference.mime, bytes: reference.bytes.length, revision, source: reference.source,
  }
}

function requestedReferenceIndexes(args, candidateCount) {
  if (Array.isArray(args.saveReferences)) {
    if (args.saveReference !== undefined && args.saveReference !== false && args.saveReference !== null) throw failure('saveReference 与 saveReferences 不能同时传入', 422)
    const indexes = args.saveReferences.map(value => Number(value))
    if (!indexes.length) throw failure('saveReferences 至少要包含一个图片索引', 422)
    if (indexes.some(index => !Number.isInteger(index) || index < 0 || index >= candidateCount)) {
      throw failure(`saveReferences 的索引必须落在 0–${Math.max(0, candidateCount - 1)} 范围内`, 422)
    }
    if (new Set(indexes).size !== indexes.length) throw failure('saveReferences 不能包含重复索引', 422)
    if (indexes.length > MAX_SAVED_REFERENCES) throw failure(`一次最多保存 ${MAX_SAVED_REFERENCES} 张参考图，请分批选择`, 422)
    return indexes
  }
  if (args.saveReference === true) {
    if (!candidateCount) throw failure('本次检索没有可保存的参考图', 404)
    return [0]
  }
  if (args.saveReference !== undefined && args.saveReference !== false && args.saveReference !== null) {
    const count = Number(args.saveReference)
    if (!Number.isInteger(count) || count < 1) throw failure(`saveReference 必须是 true 或 1–${MAX_SAVED_REFERENCES} 的整数`, 422)
    if (count > MAX_SAVED_REFERENCES) throw failure(`一次最多保存 ${MAX_SAVED_REFERENCES} 张参考图，请分批选择`, 422)
    if (count > candidateCount) throw failure(`本次检索只有 ${candidateCount} 张可用图片，无法保存请求的 ${count} 张`, 404)
    return Array.from({ length: count }, (_, index) => index)
  }
  return []
}

const LIBRARY_TOOLS = [{
  name: 'searchInspirationLibrary',
  description: `只读检索当前灵感库，按关键词、标签、工具/模型筛选，返回有限条提示词及图片/视频地址；可用 saveReference:true 保存第一张图，或 saveReference:数字 / saveReferences:[索引] 一次保存最多 ${MAX_SAVED_REFERENCES} 张图。不会调用生图模型。`,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: '关键词或画面描述' },
      tag: { type: 'string', description: '受控标签，格式 dimension:value' },
      tool: { type: 'string', description: '工具/模型字段筛选' },
      model: { type: 'string', description: 'tool 的别名，兼容模型筛选说法' },
      limit: { type: 'number', description: '返回条数，最多 12，默认 5' },
      offset: { type: 'number', description: '分页偏移' },
      outputDirectory: { type: 'string', description: '参考图保存到当前账号工作区中的相对目录；默认每次创建独立目录，不覆盖已有文件' },
      saveReference: { description: `true 保存第一张图；传 1–${MAX_SAVED_REFERENCES} 的整数时保存扁平图片候选中的前 N 张。超出上限会报错。`, oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 1, maximum: MAX_SAVED_REFERENCES }] },
      saveReferences: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: MAX_SAVED_REFERENCES, description: `按检索结果中扁平图片候选的 0 起始索引选择图片，最多 ${MAX_SAVED_REFERENCES} 张；超限或索引无效会报错。` },
    },
  },
  async run({ fetchImpl, env, workspaceFiles, userId, signal }: Record<string, any>, args: Record<string, any> = {}) {
    const result: any = await fetchLibrary(fetchImpl, env, args, signal)
    const candidates = imageCandidates(result.items)
    const indexes = requestedReferenceIndexes(args, candidates.length)
    if (indexes.length) {
      if (!workspaceFiles || !userId) throw failure('当前没有可写的用户工作区', 409)
      const directory = workspaceFiles.path(String(args.outputDirectory || `assets/library-reference-${randomUUID()}`))
      const saved = []
      try {
        for (const index of indexes) {
          signal?.throwIfAborted()
          saved.push(await saveOneReference({ workspaceFiles, userId, candidate: candidates[index], fetchImpl, env, signal, selectionIndex: index, directory }))
        }
        signal?.throwIfAborted()
      } catch (error) {
        const remaining = []
        for (const reference of saved.reverse()) {
          try {
            // 精确删除本次新文件；revision 冲突时保留之后发生的用户修改。
            workspaceFiles.mutate(userId, { path: reference.path, revision: reference.revision, operation: 'remove', discard: true })
          } catch (cleanupError) {
            if (cleanupError?.status !== 404) remaining.push(reference.path)
          }
        }
        if (remaining.length) throw failure(`${error?.message || '参考图保存失败'}；以下本次文件未能回滚，请手动清理：${remaining.join('、')}`, error?.status || 500)
        throw error
      }
      // Keep the old singular response for saveReference:true; callers that opt
      // into multi-save get a stable array with path + mime for every image.
      if (args.saveReference === true) result.savedReference = saved[0]
      else result.savedReferences = saved
    }
    return result
  },
}]

export const libraryToolMetadata = LIBRARY_TOOLS.map(({ name, description, parameters }: Record<string, any>) => ({ name, description, parameters }))

export function createLibraryTools({ workspaceFiles, fetchImpl = fetch, env = () => process.env, userId = '', signal }: Record<string, any> = {}) {
  const runtimeEnv = typeof env === 'function' ? env() : env
  const resolveUserId = typeof userId === 'function' ? userId : () => userId
  return LIBRARY_TOOLS.map(({ name, description, parameters, run }: Record<string, any>) => ({
    name, description, parameters,
    execute: (args: Record<string, any> = {}, call: Record<string, any> = {}) => run({ fetchImpl, env: runtimeEnv, workspaceFiles, userId: call.userId || resolveUserId(call), signal: call.signal || signal }, args),
  }))
}
