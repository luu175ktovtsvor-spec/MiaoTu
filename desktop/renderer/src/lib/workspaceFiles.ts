import { DEFAULT_PROJECT, workspaceHeaders, workspaceOwner, workspaceProject } from './workspaceRemote'
import { shellT } from '../shellText'
import { desktopDocumentEpoch } from './desktopDocument'
import { acquireImage } from './imageResource'
import { MEDIA_INPUT_VERSION } from '../../../../server/media-input.ts'
import { validCanvas } from '../../../../server/canvas-state.ts'
import type { CanvasCopySnapshot } from '../../../../server/canvas-state.ts'
import { captureWorkspaceSourceEntries, workspaceSourceRevision, type WorkspaceSourceEntry } from './workspaceFileSelection'
import { workspaceFileReference, isMarkdownFile, isProtectedWorkspacePath, isProtectedWorkspaceTree } from '../../../../server/workspace-path.ts'

// 工作区文件只走服务端：按登录账号隔离，本地不再有 localStorage / IndexedDB 副本。

type Entry = { name: string; path: string; type: 'file' | 'directory'; mime?: string; revision?: string; updatedAt?: string; children?: Entry[] }
const revisions = new Map<string, string | null>()
const revisionListeners = new Map<string, Set<() => void>>()
const queues = new Map<string, Promise<unknown>>()
const endpoint = './api/imagine/workspace/files'
function fileError(message: string, status = 404) {
  // Retain the upstream canvas menu's ENOENT/EEXIST recovery contract.
  return Object.assign(new Error(message), { isAxiosError: true, response: { status, data: { message, data: { code: status === 404 ? 'ENOENT' : status === 409 ? 'EEXIST' : 'EIO' } } } })
}
const plain = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validRevision = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
const incompleteReceipt = () => fileError(shellT('文件操作结果尚未确认'), 502)
function requireRevision(value: unknown) {
  if (!validRevision(value)) throw incompleteReceipt()
  return value
}
function readReceipt(text: string, ok: boolean, status: number) {
  let data: unknown
  try { data = JSON.parse(text) } catch { if (ok) throw incompleteReceipt() }
  if (!ok) throw fileError(shellT(plain(data) && typeof data.error === 'string' && data.error.trim() ? data.error : '文件操作失败'), status)
  if (!plain(data)) throw incompleteReceipt()
  return data
}
function receiptEntries(value: unknown) {
  if (!Array.isArray(value)) throw incompleteReceipt()
  const paths = new Set<string>()
  for (const entry of value) {
    if (!plain(entry) || typeof entry.path !== 'string' || !entry.path || paths.has(entry.path) || !validRevision(entry.revision)) throw incompleteReceipt()
    paths.add(entry.path)
  }
  return value as Array<Record<string, any> & WorkspaceSourceEntry>
}
async function responseRevision(response: Response) {
  const revision = response.headers.get('x-workspace-revision')
  if (!validRevision(revision)) {
    await response.body?.cancel().catch(() => {})
    throw incompleteReceipt()
  }
  return revision
}
// fetch 拿不到「上传进度」（只有下载侧有 ReadableStream），所以只有在调用方明确要进度时
// 才走 XHR。其余所有调用继续走原来的 fetch 路径，行为逐字节不变。
async function putWithProgress(url: string, headers: Record<string, string>, body: Blob, signal: AbortSignal | undefined, onProgress: (percent: number) => void) {
  const epoch = await desktopDocumentEpoch()
  return new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => { request.abort(); finish(Object.assign(new Error('aborted'), { name: 'AbortError' })) }
    let settled = false
    function finish(error?: unknown, value?: { ok: boolean; status: number; text: string }) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(value!)
    }
    request.open('PUT', url, true)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    if (epoch) request.setRequestHeader('x-miaoimg-document', epoch)
    request.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) onProgress(Math.round(event.loaded / event.total * 100)) }
    request.onload = () => finish(undefined, { ok: request.status >= 200 && request.status < 300, status: request.status, text: request.responseText })
    request.onerror = () => finish(new Error(shellT('上传连接中断，请重试')))
    request.onabort = () => finish(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    request.send(body)
  })
}

async function readResponse(response: Response) {
  return readReceipt(await response.text(), response.ok, response.status)
}

export function workspacePlaybackUrl(source: string, forcePreview = false) {
  // 本机原片不经过网络，普通视频直接播放；播放器遇到解码失败/持续丢帧时再降载。
  if (window.miaoDesktop && !forcePreview) return source
  try {
    const url = new URL(source, window.location.origin)
    if (url.origin !== window.location.origin || !['/api/imagine/workspace/files', '/api/imagine/video-content'].includes(url.pathname)) return source
    url.searchParams.set('playback', '1')
    const version = url.searchParams.get('v')
    if (version) url.searchParams.set('v', version + `-playback-v${MEDIA_INPUT_VERSION}`)
    return url.pathname + url.search
  } catch { return source }
}

export function workspacePreviewUrl(source: string, maxDimension = 1024) {
  try {
    const url = new URL(source, window.location.origin)
    if (url.origin !== window.location.origin || url.pathname !== '/api/imagine/workspace/files') return source
    url.searchParams.set('preview', '1')
    const dimension = maxDimension === 320 ? 320 : 1024
    if (dimension === 320) url.searchParams.set('previewSize', '320')
    const version = url.searchParams.get('v')
    if (version) url.searchParams.set('v', version + `-preview-v${MEDIA_INPUT_VERSION}-` + dimension)
    return url.pathname + url.search
  } catch { return source }
}

export default function useWorkspaceFiles(source: string | (() => string | undefined)) {
  const directory = typeof source === 'function' ? source() || '' : source
  const owner = workspaceOwner(directory)
  // 文件实例固定账号和项目；排队的旧页面操作在执行时再次核对归属。
  // 切换后拒绝旧实例，不能把原页面的内容写进新项目。
  const boundProject = workspaceProject()
  const normalizeSource = (path: string) => {
    const reference = workspaceFileReference(path, { owner, project: boundProject, defaultProject: DEFAULT_PROJECT, origin: window.location.origin })
    if (reference && !reference.sameScope) throw fileError(shellT('节点不能读取其他账号或项目的文件'), 409)
    return reference?.path ?? path
  }
  let copyAvailable: boolean | undefined
  let markdownFileLinks: boolean | undefined
  let treeSourceEntries: boolean | undefined
  const project = () => boundProject
  const headersForScope = () => {
    if (workspaceProject() !== boundProject) throw new Error(shellT('工作区项目已切换，请刷新页面'))
    return workspaceHeaders(owner)
  }
  const withProject = (params: URLSearchParams) => {
    const id = project()
    if (id && id !== DEFAULT_PROJECT) params.set('project', id)
    return params
  }
  const projectQuery = (prefix: string) => {
    const id = project()
    return id && id !== DEFAULT_PROJECT ? `${prefix}project=${encodeURIComponent(id)}` : ''
  }
  const revisionKey = (path: string) => `${directory}\0${path}`
  function remember(path: string, revision: string | null) {
    const key = revisionKey(path)
    if (revisions.has(key) && revisions.get(key) === revision) return
    revisions.set(key, revision)
    revisionListeners.get(key)?.forEach(changed => changed())
  }
  function enqueue<T>(path: string, task: () => Promise<T>) {
    const pending = queues.get(directory) || Promise.resolve()
    const result = pending.catch(() => {}).then(task)
    queues.set(directory, result)
    return result
  }
  async function readList(signal?: AbortSignal) {
    const data = await readResponse(await fetch(`${endpoint}?${withProject(new URLSearchParams())}`, { headers: headersForScope(), cache: 'no-store', signal }))
    const rows = receiptEntries(data.entries)
    if (rows.some(item => typeof item.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(item.mime) || !Number.isSafeInteger(item.size) || item.size < 0)) throw incompleteReceipt()
    copyAvailable = data.capabilities?.copyFiles === true
    markdownFileLinks = data.capabilities?.markdownFileLinks === true
    treeSourceEntries = data.capabilities?.treeSourceEntries === true
    const guardedCanvasRemove = data.capabilities?.guardedCanvasRemove === true
    if (guardedCanvasRemove && (typeof data.filesRevision !== 'string' || !/^[a-f0-9]{64}$/.test(data.filesRevision))) throw incompleteReceipt()
    return { rows, filesRevision: guardedCanvasRemove ? data.filesRevision as string : undefined, guardedCanvasRemove, copyFilesBatch: data.capabilities?.copyFilesBatch === true, nonRecursiveRemove: data.capabilities?.nonRecursiveRemove === true, copyFiles: copyAvailable, copyCanvasSnapshots: data.capabilities?.copyCanvasSnapshots === true }
  }
  async function requireMarkdownRelocation(paths: string[], signal?: AbortSignal) {
    if (markdownFileLinks) return
    const { rows } = await readList(signal)
    if (!markdownFileLinks && rows.some(row => row.mime !== 'inode/directory' && isMarkdownFile(row.path, row.mime)
      && paths.some(path => row.path === path || row.path.startsWith(path + '/')))) {
      throw fileError(shellT('当前服务无法保留 Markdown 文件链接，操作已停止，请更新后重试'), 501)
    }
  }
  async function requireSourceEntries(entries: readonly WorkspaceSourceEntry[] | undefined, signal?: AbortSignal) {
    if (!entries) return
    if (treeSourceEntries === undefined) await readList(signal)
    if (!treeSourceEntries) throw fileError(shellT('当前服务无法核对选中的文件版本，请更新后重试'), 501)
  }
  async function mutationSourceEntries(path: string, selected: readonly WorkspaceSourceEntry[] | undefined, signal?: AbortSignal) {
    // Keep the caller's already-observed version, including an absent
    // implicit directory row, before capability discovery can yield.
    const cachedRevision = revisions.get(revisionKey(path))
    if (selected) {
      const entries = selected.map(entry => ({ ...entry }))
      const revision = workspaceSourceRevision(entries, path)
      await requireSourceEntries(entries, signal)
      return { sourceEntries: entries, revision }
    }
    // Non-explorer callers (including file extensions) have no earlier tree
    // selection. Capture once at operation entry, never after a save barrier.
    const { rows } = await readList(signal)
    const root = rows.find(entry => entry.path === path)
    const hasChildren = rows.some(entry => entry.path.startsWith(path + '/'))
    if (!root && !hasChildren) throw fileError(shellT('文件不存在'))
    const revision = cachedRevision !== undefined ? cachedRevision : root?.revision ?? null
    if (root?.mime !== 'inode/directory' && root) return { sourceEntries: undefined, revision }
    const entries = captureWorkspaceSourceEntries(rows, path)
    await requireSourceEntries(entries, signal)
    return { sourceEntries: entries, revision }
  }
  async function mutate(payload: Record<string, unknown>, expectedRevision?: string | null, signal?: AbortSignal, allowLegacyCopy = false) {
    const path = String(payload.path)
    return enqueue(path, async () => {
      signal?.throwIfAborted()
      const headers = headersForScope()
      const revision = payload.exclusive ? null : expectedRevision !== undefined ? expectedRevision : revisions.get(revisionKey(path)) ?? null
      const id = project()
      const body = id && id !== DEFAULT_PROJECT ? { ...payload, revision, project: id } : { ...payload, revision }
      const data = await readResponse(await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal }))
      if (payload.operation === 'rename' || payload.operation === 'copy') {
        // The document explorer already supported older copy hosts whose
        // receipt was only { revision: null }. Confirm destination revisions
        // with their existing listing, inside this same scope and write queue.
        if (allowLegacyCopy && payload.operation === 'copy' && data.revision === null && data.entries === undefined) {
          const { rows } = await readList(signal)
          data.entries = rows.filter(entry => entry.path === payload.target || entry.path.startsWith(`${payload.target}/`))
        }
        const entries = receiptEntries(data.entries)
        const copies = Array.isArray(payload.copies) ? payload.copies as { target: string }[] : undefined
        const expected = copies ? new Set(copies.map(item => item.target)) : undefined
        if (data.revision !== null || !entries.length || (copies ? entries.length !== expected!.size || entries.some(entry => !expected!.has(entry.path)) : entries.some(entry => entry.path !== payload.target && !entry.path.startsWith(`${payload.target}/`)))) throw incompleteReceipt()
        // Publish destination revisions before releasing the queue. A copy
        // retains the source revision; only a rename invalidates old paths.
        if (payload.operation === 'rename') for (const key of revisions.keys()) {
          if (key === revisionKey(path) || key.startsWith(`${revisionKey(path)}/`)) revisions.delete(key)
        }
        for (const entry of entries) remember(entry.path, entry.revision)
      } else {
        if (payload.operation === 'remove') { if (data.revision !== null) throw incompleteReceipt() }
        else requireRevision(data.revision)
        remember(path, data.revision)
      }
      return data
    })
  }
  const files = {
    watchUrl(path: string, changed: () => void) {
      const key = revisionKey(path)
      let listeners = revisionListeners.get(key)
      if (!listeners) revisionListeners.set(key, listeners = new Set())
      listeners.add(changed)
      return () => { listeners.delete(changed); if (!listeners.size) revisionListeners.delete(key) }
    },
    url(path: string) {
      path = normalizeSource(path)
      if (/^(data:|blob:|https?:|\/api\/imagine\/)/i.test(path)) return path
      // 带上已知的修订号：服务端见到「版本号 == 当前修订号」才准许长缓存，
      // 于是这份字节一次都不用再回服务器问；文件被就地改写后修订号变了，URL 跟着变。
      const revision = revisions.get(revisionKey(path))
      const version = revision ? `&v=${encodeURIComponent(revision)}` : ''
      return `/api/imagine/workspace/files?owner=${encodeURIComponent(owner)}${projectQuery('&')}&path=${encodeURIComponent(path)}${version}`
    },
    // 节点骨架优先用带账号校验的文件 URL 播放远端媒体，避免把大文件读进浏览器内存。
    acquireUrl(path: string) {
      return { url: Promise.resolve(files.url(path)), release() {} }
    },
    acquirePreviewUrl(path: string, _mimeType?: string, maxDimension = 1024) {
      return { url: Promise.resolve(workspacePreviewUrl(files.url(path), maxDimension)), release() {} }
    },
    async list(_path?: string, signal?: AbortSignal) {
      const { rows, filesRevision, guardedCanvasRemove } = await readList(signal)
      signal?.throwIfAborted()
      // 列表顺带把每一行的修订号记下来，后面拼 URL 就能直接带上版本号（省掉一次往返）。
      for (const item of rows) remember(item.path, item.revision)
      const entries: Entry[] = rows.map(item => ({ ...item, path: item.path, name: item.path.split('/').pop(), type: item.mime === 'inode/directory' ? 'directory' : 'file' }))
      return { directory, entries, filesRevision, guardedCanvasRemove }
    },
    async stat(path: string, signal?: AbortSignal) {
      const response = await fetch(`${endpoint}?${withProject(new URLSearchParams({ path }))}`, { method: 'HEAD', headers: headersForScope(), cache: 'no-store', signal })
      if (!response.ok) throw fileError(`${shellT('素材不可读取')}：${path}`, response.status)
      const revision = await responseRevision(response), size = Number(response.headers.get('content-length'))
      if (!Number.isSafeInteger(size) || size < 0) throw incompleteReceipt()
      signal?.throwIfAborted()
      remember(path, revision)
      return { path, revision, size, mime: (response.headers.get('content-type') || '').split(';')[0]!.trim() }
    },
    async read(path: string, signal?: AbortSignal): Promise<Blob> {
      signal?.throwIfAborted()
      path = normalizeSource(path)
      if (/^(data:|blob:|https?:|\/api\/imagine\/)/i.test(path)) {
        const response = await fetch(path, { signal })
        if (!response.ok) throw new Error(shellT('素材读取失败'))
        return response.blob()
      }
      const response = await fetch(files.url(path), { headers: headersForScope(), cache: 'no-store', signal })
      if (!response.ok) { await readResponse(response); throw new Error(shellT('读取失败')) }
      const revision = await responseRevision(response)
      const blob = await response.blob()
      signal?.throwIfAborted()
      remember(path, revision)
      return blob
    },
    async readImageSize(path: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
      signal?.throwIfAborted()
      headersForScope()
      const source = files.url(path)
      // Use the same orientation and intrinsic sizing as the canvas image,
      // including PNG/WebP metadata that a header-only size omits. The browser
      // reuses its media cache; no full-file Blob or pixel buffer is created here.
      const resource = await acquireImage(source, signal).catch(() => {
        signal?.throwIfAborted()
        throw fileError(shellT('无法读取原图片尺寸'), 422)
      })
      try {
        signal?.throwIfAborted()
        headersForScope()
        if (files.url(path) !== source) throw fileError(shellT('原图片已更新，请重新操作'), 409)
        return { width: resource.image.naturalWidth, height: resource.image.naturalHeight }
      } finally { resource.release() }
    },
    // 与上游一致：传入 maxBytes 时通过 HTTP Range 只读文件头，避免为大画布把整个文件读进内存。
    async readText(path: string, maxBytes?: number, signal?: AbortSignal) {
      if (!maxBytes) return (await files.read(path, signal)).text()
      const response = await fetch(files.url(path), { headers: { ...headersForScope(), range: `bytes=0-${maxBytes - 1}` }, cache: 'no-store', signal })
      if (!response.ok) { await readResponse(response); throw new Error(shellT('读取失败')) }
      const revision = await responseRevision(response)
      const text = new TextDecoder().decode((await response.arrayBuffer()).slice(0, maxBytes))
      signal?.throwIfAborted()
      remember(path, revision)
      return text
    },
    // Editors retain the revision of their own text, independently of preview
    // and file-tree refreshes that advance the shared URL revision cache.
    async readTextSnapshot(path: string, signal?: AbortSignal) {
      const response = await fetch(files.url(path), { headers: headersForScope(), cache: 'no-store', signal })
      if (!response.ok) await readResponse(response)
      const revision = await responseRevision(response)
      const text = await response.text()
      signal?.throwIfAborted()
      remember(path, revision)
      return { text, revision }
    },
    async writeText(path: string, content: string, revision: string | null) {
      const data = await mutate({ operation: 'write', path, content, encoding: 'text', mime: path.endsWith('.json') ? 'application/json' : 'text/plain' }, revision === null ? null : requireRevision(revision))
      return requireRevision(data.revision)
    },
    async readSnapshot<T = unknown>(path: string, revision?: string, signal?: AbortSignal) {
      const headers: Record<string, string> = headersForScope()
      if (revision) headers['if-none-match'] = `"${revision}"`
      const params = withProject(new URLSearchParams({ path }))
      const response = await fetch(`${endpoint}?${params}`, { headers, cache: 'no-store', signal })
      if (response.status === 304) { if (!revision) throw incompleteReceipt(); return null }
      if (!response.ok) await readResponse(response)
      const nextRevision = await responseRevision(response)
      const text = await response.text()
      let canvas: unknown
      try { canvas = JSON.parse(text) } catch { throw incompleteReceipt() }
      if (!validCanvas(canvas)) throw incompleteReceipt()
      remember(path, nextRevision)
      return { canvas: canvas as T, revision: nextRevision }
    },
    async saveCanvas(path: string, canvas: unknown, base: unknown, revision: string | null) {
      return enqueue(path, async () => {
        const data = await readResponse(await fetch(endpoint, {
          method: 'POST', headers: headersForScope(),
          body: JSON.stringify({ operation: 'saveCanvas', path, canvas, base, revision, project: project() }),
        }))
        const savedRevision = requireRevision(data.revision)
        if (!validCanvas(data.canvas)) throw incompleteReceipt()
        remember(path, savedRevision)
        return { ...data, canvas: data.canvas, revision: savedRevision }
      })
    },
    async readJson<T = unknown>(path: string, signal?: AbortSignal) { return JSON.parse(await files.readText(path, undefined, signal)) as T },
    async write(path: string, content: Blob | ArrayBuffer | string, exclusive = false, signal?: AbortSignal, onProgress?: (percent: number) => void): Promise<any> {
      const blob = content instanceof Blob ? content : new Blob([content])
      const text = typeof content === 'string'
      if (text) return mutate({ operation: 'write', path, exclusive, content, encoding: 'text', mime: path.endsWith('.json') ? 'application/json' : 'text/plain' }, undefined, signal)
      return enqueue(path, async () => {
        const headers = { ...headersForScope(), 'content-type': blob.type || 'application/octet-stream' }
        const revision = exclusive ? null : revisions.get(revisionKey(path)) ?? null
        const params = withProject(new URLSearchParams({ path, exclusive: exclusive ? '1' : '0' }))
        if (revision) params.set('revision', revision)
        const url = `${endpoint}?${params}`
        const result = onProgress ? await putWithProgress(url, headers, blob, signal, percent => onProgress(Math.min(99, percent))) : null
        const response = result ? new Response(result.text, { status: result.status, headers: { 'content-type': 'application/json' } }) : await fetch(url, { method: 'PUT', headers, body: blob, signal })
        const data = await readResponse(response)
        requireRevision(data.revision)
        remember(path, data.revision)
        onProgress?.(100)
        return data
      })
    },
    async writeJson(path: string, value: unknown, exclusive = false) { return files.write(path, JSON.stringify(value), exclusive) },
    async rename(path: string, target: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) {
      signal?.throwIfAborted()
      const selected = await mutationSourceEntries(path, sourceEntries, signal)
      sourceEntries = selected.sourceEntries
      await requireMarkdownRelocation([path], signal)
      await mutate({ operation: 'rename', path, target, ...(sourceEntries ? { sourceEntries } : {}) }, selected.revision, signal)
    },
    async copy(path: string, target: string, signal?: AbortSignal, { allowLegacy = false, canvasCopies, sourceEntries, revision: expectedRevision }: { allowLegacy?: boolean; canvasCopies?: CanvasCopySnapshot[]; sourceEntries?: readonly WorkspaceSourceEntry[]; revision?: string } = {}) {
      signal?.throwIfAborted()
      // Media retention already carries the exact single-file revision. Do
      // not turn that proof into a fresh tree selection (or list every copy).
      // The server still rejects an actual directory without its full proof.
      let revision: string | null
      if (sourceEntries || expectedRevision === undefined) {
        const selected = await mutationSourceEntries(path, sourceEntries, signal)
        sourceEntries = selected.sourceEntries
        revision = selected.revision
      } else revision = expectedRevision
      if (canvasCopies && !(await readList(signal)).copyCanvasSnapshots) throw fileError(shellT('当前服务尚不支持独立复制画布，复制已停止'), 501)
      if (copyAvailable === undefined) {
        const list = await readList(signal)
        if (list.copyFiles || allowLegacy) {
          const entry = list.rows.find(item => item.path === path)
          if (!entry && !list.rows.some(item => item.path.startsWith(`${path}/`))) throw fileError(shellT('文件不存在'))
        }
      }
      signal?.throwIfAborted()
      headersForScope()
      await requireMarkdownRelocation([path], signal)
      if (!copyAvailable && !allowLegacy) return false
      await mutate({ operation: 'copy', path, target, ...(canvasCopies ? { canvasCopies } : {}), ...(sourceEntries ? { sourceEntries } : {}) }, revision, signal, !copyAvailable && allowLegacy)
      return true
    },
    async copyBatch(copies: { path: string; target: string; revision: string }[], signal?: AbortSignal) {
      if (!copies.length) return
      if (!(await readList(signal)).copyFilesBatch) throw fileError(shellT('当前服务尚不支持批量素材复制，请更新后重试'), 501)
      await requireMarkdownRelocation(copies.map(copy => copy.path), signal)
      const first = copies[0]!
      await mutate({ operation: 'copy', path: first.path, target: first.target, copies }, first.revision, signal)
    },
    // Explicit false requires the server's atomic empty-directory check.
    // Omitted/true keeps existing canvas and asset-directory cleanup behavior.
    // trash: 用户亲手删的放进系统废纸篓；程序清理临时素材不带它，直接删。
    async remove(path: string, recursive?: boolean, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[], { trash = false }: { trash?: boolean } = {}) {
      signal?.throwIfAborted()
      if (recursive !== undefined && typeof recursive !== 'boolean') throw fileError(shellT('删除选项无效'), 422)
      const selected = await mutationSourceEntries(path, sourceEntries, signal)
      sourceEntries = selected.sourceEntries
      if (recursive === false) {
        const list = await readList(signal)
        if (!list.nonRecursiveRemove) throw fileError(shellT('当前服务无法保证保留目录内容，删除已停止'), 501)
      }
      await mutate({ operation: 'remove', path, recursive, ...(trash ? { trash } : {}), ...(sourceEntries ? { sourceEntries } : {}) }, selected.revision, signal)
    },
    async removeCanvas(path: string, { directories, filesRevision, revision, recursive, sourceEntries }: { directories: string[]; filesRevision: string; revision: string | null; recursive?: boolean; sourceEntries?: readonly WorkspaceSourceEntry[] }, signal?: AbortSignal) {
      if (!/^[a-f0-9]{64}$/.test(filesRevision)) throw incompleteReceipt()
      sourceEntries = sourceEntries?.map(entry => ({ ...entry }))
      const expectedRevision = sourceEntries ? workspaceSourceRevision(sourceEntries, path) : revision
      await requireSourceEntries(sourceEntries, signal)
      await mutate({ operation: 'remove', path, recursive, trash: true, canvasCleanup: { directories, filesRevision }, ...(sourceEntries ? { sourceEntries } : {}) }, expectedRevision, signal)
    },
    async mkdir(path: string, signal?: AbortSignal) { await mutate({ operation: 'write', path, exclusive: true, content: '', encoding: 'text', mime: 'inode/directory' }, undefined, signal) },
  }
  return files
}

const contentPathMethods = new Set(['stat', 'read', 'readImageSize', 'readText', 'readTextSnapshot', 'readJson', 'readSnapshot', 'saveCanvas', 'write', 'writeText', 'writeJson', 'remove', 'removeCanvas', 'mkdir', 'url', 'watchUrl', 'acquireUrl', 'acquirePreviewUrl', 'rename', 'copy'])
// Content editors and node/plugin adapters share one boundary. The settings
// host intentionally keeps the unguarded, account-bound file API above.
export function guardWorkspaceFiles<T extends object>(files: T, directory: string): T {
  const scope = { owner: workspaceOwner(directory), project: workspaceProject(), defaultProject: DEFAULT_PROJECT, origin: window.location.origin }
  const checked = (source: unknown, tree = false) => {
    const reference = workspaceFileReference(source, scope)
    if (reference && !reference.sameScope) throw fileError(shellT('不能访问其他账号或项目的文件'), 403)
    const path = reference?.path ?? source
    if ((tree ? isProtectedWorkspaceTree : isProtectedWorkspacePath)(path)) throw fileError(shellT('供应商配置只能在设置中管理'), 403)
    return path
  }
  return new Proxy(files, { get(target, key) {
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    if (key === 'list') return async (...args: unknown[]) => {
      const result = await value.apply(target, args)
      return { ...result, entries: result.entries.filter((entry: { path: string }) => !isProtectedWorkspacePath(entry.path)) }
    }
    if (key === 'copyBatch') return (copies: { path: string; target: string }[], ...args: unknown[]) => value.call(target,
      copies.map(copy => ({ ...copy, path: checked(copy.path, true), target: checked(copy.target, true) })), ...args)
    if (contentPathMethods.has(String(key))) return (path: string, ...args: unknown[]) => {
      const tree = key === 'rename' || key === 'copy' || key === 'remove' || key === 'removeCanvas'
      if (key === 'rename' || key === 'copy') args[0] = checked(args[0], true)
      return value.call(target, checked(path, tree), ...args)
    }
    return value.bind(target)
  } })
}

export function useWorkspaceContentFiles(source: string | (() => string | undefined)) {
  const directory = typeof source === 'function' ? source() || '' : source
  return guardWorkspaceFiles(useWorkspaceFiles(directory), directory)
}
