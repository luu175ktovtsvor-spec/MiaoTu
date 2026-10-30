// 灵感库检索工具：Agent 与 MCP 共用同一份定义与执行体。
// 检索走档案服务的只读 HTTP 接口；可选的参考图落盘复用 workspaceFiles.writeBytes，
// 画布节点仍由浏览器侧已有 canvas/nodeTools 工具创建和设置。
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { open, readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { failure } from './management-store.ts'
import { createWebTools } from './web/tools.ts'

const MAX_LIMIT = 12
const MAX_SAVED_REFERENCES = 6
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const SHOWCASE_MANIFEST = 'showcase-agent.json'
const SHOWCASE_PROMPT_PREFIX = 'inspiration/prompts/'
const MAX_SHOWCASE_ROOTS = 8
const MAX_SHOWCASE_SHARDS = 512

type PromptShard = Record<string, string>
type TranslationShard = Record<string, { sourceSha256?: string; 'zh-Hans'?: string; en?: string }>
type ShardCache<T> = Map<string, { signature: string; value: Promise<T | null> }>
type ShardReads<T> = Map<string, Promise<T | null>>
type ShowcaseManifest = {
  signature: string; value: any
  prompts: ShardCache<PromptShard>; translations: ShardCache<TranslationShard>
}
const showcaseManifestCache = new Map<string, ShowcaseManifest>()

function showcaseFileSignature(fileStat) {
  return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`
}

// Cache ownership follows a manifest generation. An older in-flight search can
// finish its own reads, but cannot repopulate a newer generation with old data.
// Re-stat each distinct shard once per search as shards may also change without
// a manifest update; the per-search memo joins duplicate film/shard reads.
function readShowcaseShard<T>(path: string, cache: ShardCache<T>, reads: ShardReads<T>, normalize: (value: Record<string, any>) => T) {
  let pending = reads.get(path)
  if (pending) return pending
  pending = (async () => {
    let fileStat
    try { fileStat = await stat(path) } catch { cache.delete(path); return null }
    if (!fileStat.isFile()) { cache.delete(path); return null }
    const signature = showcaseFileSignature(fileStat)
    const cached = cache.get(path)
    if (cached?.signature === signature) {
      cache.delete(path); cache.set(path, cached)
      return cached.value
    }
    const value = (async () => {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return normalize(parsed)
      } catch { return null }
    })()
    cache.delete(path); cache.set(path, { signature, value })
    while (cache.size > MAX_SHOWCASE_SHARDS) cache.delete(cache.keys().next().value!)
    const data = await value
    if (data === null && cache.get(path)?.value === value) cache.delete(path)
    return data
  })()
  reads.set(path, pending)
  return pending
}

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
    source: 'archive',
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

function normalizedSearchText(value) {
  return String(value || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function queryTerms(value) {
  return normalizedSearchText(value).split(' ').filter(Boolean).slice(0, 24)
}

function requestLimit(value) {
  const number = Number(value)
  const fallback = Number.isFinite(number) && number > 0 ? number : 5
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(fallback)))
}

function requestOffset(value) {
  const number = Number(value)
  return Math.min(100_000, Math.max(0, Math.floor(Number.isFinite(number) ? number : 0)))
}

function showcaseManifestPath(root) {
  const base = String(root || '').trim()
  return base ? resolve(base, SHOWCASE_MANIFEST) : ''
}

async function readShowcaseManifest(root) {
  const path = showcaseManifestPath(root)
  if (!path) return null
  let fileStat
  try { fileStat = await stat(path) } catch { showcaseManifestCache.delete(path); return null }
  const signature = showcaseFileSignature(fileStat)
  const cached = showcaseManifestCache.get(path)
  if (cached?.signature === signature) {
    showcaseManifestCache.delete(path); showcaseManifestCache.set(path, cached)
    return cached
  }
  let value
  try { value = JSON.parse((await readFile(path, 'utf8'))) } catch { return null }
  if (!value || typeof value !== 'object' || !Array.isArray(value.films)) return null
  const entry: ShowcaseManifest = { signature, value, prompts: new Map(), translations: new Map() }
  showcaseManifestCache.delete(path); showcaseManifestCache.set(path, entry)
  while (showcaseManifestCache.size > MAX_SHOWCASE_ROOTS) showcaseManifestCache.delete(showcaseManifestCache.keys().next().value!)
  return entry
}

function safeShowcasePromptPath(root, promptFile) {
  const relativePath = String(promptFile || '').replace(/^\/+/, '')
  if (!relativePath.startsWith(SHOWCASE_PROMPT_PREFIX)) return ''
  const configuredRoot = String(root || '').trim()
  if (!configuredRoot) return ''
  const base = resolve(configuredRoot)
  const target = resolve(base, relativePath)
  const withinRoot = relative(base, target)
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) || isAbsolute(withinRoot)) return ''
  return target
}

async function readShowcasePrompt(root, promptFile, id, cache: ShardCache<PromptShard>, reads: ShardReads<PromptShard>) {
  const path = safeShowcasePromptPath(root, promptFile)
  if (!path) return ''
  const data = await readShowcaseShard(path, cache, reads, parsed => Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => typeof value === 'string').map(([key, value]) => [key, String(value)]),
  ))
  return String(data?.[id] || '').trim()
}

function safeShowcaseTranslationPath(root, translationFile) {
  const relativePath = String(translationFile || '').replace(/^\/+/, '')
  if (!relativePath.startsWith('inspiration/translations/')) return ''
  const configuredRoot = String(root || '').trim()
  if (!configuredRoot) return ''
  const base = resolve(configuredRoot)
  const target = resolve(base, relativePath)
  const withinRoot = relative(base, target)
  if (!withinRoot || withinRoot === '..' || withinRoot.startsWith('..' + sep) || isAbsolute(withinRoot)) return ''
  return target
}

async function readShowcaseTranslation(root, translationFile, id, cache: ShardCache<TranslationShard>, reads: ShardReads<TranslationShard>) {
  const path = safeShowcaseTranslationPath(root, translationFile)
  if (!path) return {}
  const data = await readShowcaseShard(path, cache, reads, parsed => Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => [key, value]),
  ) as TranslationShard)
  const value = data?.[id]
  return value && typeof value === 'object' ? {
    zhHans: String(value['zh-Hans'] || '').trim(),
    en: String(value.en || '').trim(),
  } : {}
}

function showcaseFilmText(film) {
  return [
    ...(Array.isArray(film?.title) ? film.title : [film?.title]),
    ...(Array.isArray(film?.category) ? film.category : [film?.category]),
    ...(Array.isArray(film?.summary) ? film.summary : [film?.summary]),
    film?.theme, film?.model, film?.creator, film?.sourceId, film?.caseUrl,
  ].filter(Boolean).map(normalizedSearchText).join(' ')
}

function showcaseTagMatch(film, tag) {
  const value = normalizedSearchText(tag)
  if (!value) return true
  const [dimension, label] = value.includes(':') ? value.split(':', 2) : ['', value]
  if (dimension && dimension !== 'theme' && dimension !== 'category' && dimension !== 'model') return false
  if (dimension === 'theme') return normalizedSearchText(film?.theme) === label
  if (dimension === 'model') return normalizedSearchText(film?.model).includes(label)
  const categories = Array.isArray(film?.category) ? film.category : [film?.category]
  return [film?.theme, ...categories].filter(Boolean).some(item => normalizedSearchText(item).includes(label))
}

async function searchShowcase({ root, args: inputArgs = {} }: { root: string; args?: Record<string, any> }) {
  const args = inputArgs || {}
  const cachedManifest = await readShowcaseManifest(root)
  if (!cachedManifest) return { available: false, total: 0, offset: 0, limit: 0, items: [] }
  const manifest = cachedManifest.value
  const promptReads: ShardReads<PromptShard> = new Map()
  const translationReads: ShardReads<TranslationShard> = new Map()
  const terms = queryTerms(args.query || args.q)
  const tool = normalizedSearchText(args.tool || args.model)
  const tag = args.tag
  // Load the prompt shards before filtering so a query can match the full
  // original prompt, not only the film title and summary shown in the card.
  const candidates = await Promise.all(manifest.films.map(async film => ({
    film,
    prompt: film.hasPrompt ? await readShowcasePrompt(root, film.promptFile, film.id, cachedManifest.prompts, promptReads) : '',
    translation: film.translationFile ? await readShowcaseTranslation(root, film.translationFile, film.id, cachedManifest.translations, translationReads) : {},
  })))
  const matched = candidates.filter(({ film, prompt, translation }) => {
    const text = `${showcaseFilmText(film)} ${normalizedSearchText(prompt)} ${normalizedSearchText(translation.zhHans)} ${normalizedSearchText(translation.en)}`
    return terms.every(term => text.includes(term))
      && (!tool || normalizedSearchText(film?.model).includes(tool))
      && showcaseTagMatch(film, tag)
  })
  const offset = requestOffset(args.offset)
  const limit = requestLimit(args.limit)
  const page = matched.slice(offset, offset + limit)
  const items = []
  for (const { film, prompt, translation } of page) {
    const poster = String(film.poster || '').replace(/^\/+/, '').split('?')[0]
    const video = String(film.video || '').replace(/^\/+/, '').split('?')[0]
    items.push({
      id: `showcase:${String(film.id || '')}`,
      source: 'showcase',
      title: Array.isArray(film.title) ? film.title : [String(film.title || '')],
      category: Array.isArray(film.category) ? film.category : [String(film.category || '')],
      theme: String(film.theme || ''),
      author: String(film.creator || ''),
      tool: String(film.model || ''),
      prompt,
      promptAvailable: Boolean(prompt),
      ...(translation.zhHans || translation.en ? { translations: { ...(translation.zhHans ? { 'zh-Hans': translation.zhHans } : {}), ...(translation.en ? { en: translation.en } : {}) } } : {}),
      summary: Array.isArray(film.summary) ? film.summary : [String(film.summary || '')],
      sourceUrl: String(film.sourceUrl || ''),
      caseUrl: String(film.caseUrl || ''),
      sourceId: String(film.sourceId || film.id || ''),
      images: poster ? [{ id: `showcase:${film.id}:poster`, index: 0, url: '', local: poster }] : [],
      videos: video ? [{ id: `showcase:${film.id}:video`, index: 0, url: '', local: video, poster: poster || null }] : [],
    })
  }
  return { available: true, datasetReady: true, datasetVersion: String(manifest.sourceRevision || manifest.reviewedAt || ''), total: matched.length, offset, limit, items }
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
  url.searchParams.set('limit', String(requestLimit(args.limit)))
  const offset = requestOffset(args.offset)
  if (offset > 0) url.searchParams.set('offset', String(offset))
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

function localShowcasePath(root, local) {
  const source = String(local || '').replace(/^\/+/, '').split('?')[0]
  if (!source || (!source.startsWith('showcase/') && !source.startsWith('landing/'))) return null
  const configuredRoot = String(root || '').trim()
  if (!configuredRoot) return null
  const base = resolve(configuredRoot)
  const target = resolve(base, source)
  const path = relative(base, target)
  if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) return null
  return target
}

async function fetchImageReference({ fetchImpl, env, showcaseRoot, showcaseAssetFetch, item, image, signal }: Record<string, any>) {
  if (!image) throw failure('检索结果没有可用的参考图', 404)
  const localPath = localArchivePath(env, image.local) || localShowcasePath(showcaseRoot, image.local)
  if (localPath && existsSync(localPath)) {
    const isShowcase = Boolean(localShowcasePath(showcaseRoot, image.local))
    const root = await realpath(resolve(isShowcase ? showcaseRoot : String(env.OIP_ARCHIVE_ROOT || env.OIP_REPO_ROOT || process.cwd())))
    const actual = await realpath(localPath)
    const mediaRoots = await Promise.all((isShowcase ? ['showcase', 'landing'] : ['images', 'previews']).map(async name => {
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
  const showcaseSource = String(image.local || '').replace(/^\/+/, '').split('?')[0]
  if ((!localPath || !existsSync(localPath)) && /^(showcase|landing)\//.test(showcaseSource) && typeof showcaseAssetFetch === 'function') {
    const response = await showcaseAssetFetch('/' + showcaseSource, signal)
    if (!response?.ok) {
      await response?.body?.cancel().catch(() => {})
      throw failure(`参考图读取失败（HTTP ${response?.status || 502}）`, 502)
    }
    const bytes = await createWebTools().readResponseBytes(response, MAX_REFERENCE_BYTES, '参考图超过 20MB')
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES) throw failure('参考图为空或超过 20MB', 413)
    const mime = String(response.headers.get('content-type') || 'image/jpeg').split(';')[0]
    if (!/^image\//.test(mime)) throw failure('精选参考地址没有返回图片', 415)
    signal?.throwIfAborted()
    return { bytes, mime, source: image.local }
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

async function saveOneReference({ workspaceFiles, userId, candidate, fetchImpl, env, showcaseRoot, showcaseAssetFetch, signal, selectionIndex, directory }: Record<string, any>) {
  if (!workspaceFiles || !userId) throw failure('当前没有可写的用户工作区', 409)
  const reference = await fetchImageReference({ fetchImpl, env, showcaseRoot, showcaseAssetFetch, item: candidate.item, image: candidate.image, signal })
  const digest = createHash('sha256')
    .update(`${reference.source}\n${candidate.item.id}\n${candidate.image.id}\n${candidate.image.index}`)
    .digest('hex').slice(0, 12)
  const path = `${directory}/reference-${digest}-${randomUUID()}${safeExtension('', reference.mime)}`
  signal?.throwIfAborted()
  const { revision } = (await workspaceFiles.writeBytes(userId, { path, mime: reference.mime, bytes: reference.bytes, revision: null }))
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
  description: `只读检索当前创作精选，默认搜索全部可用来源；可用 source 指定来源。按关键词、标签、工具/模型筛选，返回有限条提示词及图片/视频地址；source=all 可能返回 partial:true 与来源错误字段，必须说明结果范围。可用 saveReference:true 保存第一张图，或 saveReference:数字 / saveReferences:[索引] 一次保存最多 ${MAX_SAVED_REFERENCES} 张图。不会调用生图模型。`,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: '关键词或画面描述' },
      tag: { type: 'string', description: '受控标签，格式 dimension:value' },
      tool: { type: 'string', description: '工具/模型字段筛选' },
      model: { type: 'string', description: 'tool 的别名，兼容模型筛选说法' },
      source: { type: 'string', enum: ['all', 'archive', 'showcase'], description: '检索来源；默认 all，检索全部可用来源' },
      limit: { type: 'number', description: '返回条数，最多 12，默认 5' },
      offset: { type: 'number', description: '分页偏移' },
      outputDirectory: { type: 'string', description: '参考图保存到当前账号工作区中的相对目录；默认每次创建独立目录，不覆盖已有文件' },
      saveReference: { description: `true 保存第一张图；传 1–${MAX_SAVED_REFERENCES} 的整数时保存扁平图片候选中的前 N 张。超出上限会报错。`, oneOf: [{ type: 'boolean' }, { type: 'integer', minimum: 1, maximum: MAX_SAVED_REFERENCES }] },
      saveReferences: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: MAX_SAVED_REFERENCES, description: `按检索结果中扁平图片候选的 0 起始索引选择图片，最多 ${MAX_SAVED_REFERENCES} 张；超限或索引无效会报错。` },
    },
  },
  async run({ fetchImpl, env, showcaseRoot, showcaseAssetFetch, workspaceFiles, userId, signal }: Record<string, any>, args: Record<string, any> = {}) {
    const source = ['archive', 'showcase'].includes(String(args.source || '')) ? String(args.source) : 'all'
    let result: any
    if (source === 'archive') {
      result = await fetchLibrary(fetchImpl, env, args, signal)
    } else if (source === 'showcase') {
      result = await searchShowcase({ root: showcaseRoot, args })
      if (!result.available) throw failure('精选目录暂时不可用', 503)
    } else {
      const limit = requestLimit(args.limit)
      const offset = requestOffset(args.offset)
      let archiveResult = null
      let archiveError = null
      try {
        archiveResult = await fetchLibrary(fetchImpl, env, { ...args, limit, offset }, signal)
      } catch (error) {
        if (signal?.aborted) throw error
        archiveError = error
      }
      const archiveTotal = Math.max(0, Number(archiveResult?.total || 0))
      const showcaseOffset = archiveResult ? Math.max(0, offset - archiveTotal) : offset
      let showcaseResult = null
      let showcaseError = null
      try {
        const value = await searchShowcase({ root: showcaseRoot, args: { ...args, limit, offset: showcaseOffset } })
        if (value?.available) showcaseResult = value
        else showcaseError = failure('精选目录暂时不可用', 503)
      } catch (error) {
        if (signal?.aborted) throw error
        showcaseError = error
      }
      if (!archiveResult && !showcaseResult) throw archiveError || showcaseError || failure('创作精选暂时不可用', 503)
      const archiveItems = archiveResult?.items || []
      const archiveItemsInPage = archiveResult ? Math.max(0, Math.min(limit, archiveTotal - offset)) : 0
      const showcaseItemsInPage = archiveResult ? Math.max(0, limit - archiveItemsInPage) : limit
      result = {
        source: 'all',
        datasetReady: archiveResult?.datasetReady === true && showcaseResult?.datasetReady === true,
        datasetVersion: archiveResult?.datasetVersion && showcaseResult?.datasetVersion
          ? `${archiveResult.datasetVersion}+${showcaseResult.datasetVersion}`
          : archiveResult?.datasetVersion || showcaseResult?.datasetVersion || null,
        archiveDatasetReady: archiveResult?.datasetReady === true,
        showcaseDatasetReady: showcaseResult?.datasetReady === true,
        total: archiveTotal + Number(showcaseResult?.total || 0),
        offset,
        limit,
        archiveError: archiveResult ? null : String(archiveError?.message || '档案库暂时不可用'),
        showcaseError: showcaseResult ? null : String(showcaseError?.message || '精选目录暂时不可用'),
        showcaseAvailable: Boolean(showcaseResult),
        partial: Boolean(archiveError || showcaseError),
        items: [
          ...archiveItems.slice(0, archiveItemsInPage),
          ...(showcaseResult?.items || []).slice(0, showcaseItemsInPage),
        ],
      }
    }
    const candidates = imageCandidates(result.items)
    const indexes = requestedReferenceIndexes(args, candidates.length)
    if (indexes.length) {
      if (!workspaceFiles || !userId) throw failure('当前没有可写的用户工作区', 409)
      const directory = workspaceFiles.path(String(args.outputDirectory || `assets/library-reference-${randomUUID()}`))
      const saved = []
      try {
        for (const index of indexes) {
          signal?.throwIfAborted()
          saved.push(await saveOneReference({ workspaceFiles, userId, candidate: candidates[index], fetchImpl, env, showcaseRoot, showcaseAssetFetch, signal, selectionIndex: index, directory }))
        }
        signal?.throwIfAborted()
      } catch (error) {
        const remaining = []
        for (const reference of saved.reverse()) {
          try {
            // 精确删除本次新文件；revision 冲突时保留之后发生的用户修改。
            await workspaceFiles.mutate(userId, { path: reference.path, revision: reference.revision, operation: 'remove', discard: true })
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

export function createLibraryTools({ workspaceFiles, fetchImpl = fetch, env = () => process.env, showcaseRoot = '', showcaseAssetFetch, userId = '', signal }: Record<string, any> = {}) {
  const runtimeEnv = typeof env === 'function' ? env() : env
  const resolveUserId = typeof userId === 'function' ? userId : () => userId
  return LIBRARY_TOOLS.map(({ name, description, parameters, run }: Record<string, any>) => ({
    name, description, parameters,
    execute: (args: Record<string, any> = {}, call: Record<string, any> = {}) => run({ fetchImpl, env: runtimeEnv, showcaseRoot, showcaseAssetFetch, workspaceFiles, userId: call.userId || resolveUserId(call), signal: call.signal || signal }, args),
  }))
}
