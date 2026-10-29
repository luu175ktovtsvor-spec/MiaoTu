import { canvasFileReferences } from './canvas-file-references.ts'
import { isMarkdownFile, markdownFileReferences } from './markdown-file-references.ts'
import { isWorkspacePath, workspaceFileReference, type WorkspaceReferenceScope } from './workspace-path.ts'
import { hasCanvasHeader, hasCanvasMarker } from './canvas-document.ts'

type Node = { id: string; data?: unknown }
type Canvas = { path: string; nodes: readonly Node[] }
type File = { path: string; mime?: string }
const denied = (message: string) => Object.assign(new Error(message), { status: 409 })

export function canvasCleanupDocument(bytes: Uint8Array, path: string): Canvas | undefined {
  // Ordinary JSON assets may be malformed or use a legacy encoding. Identify
  // the canvas first; only a real canvas must decode losslessly for ownership.
  const text = new TextDecoder('utf-8').decode(bytes)
  let canvas
  try { canvas = JSON.parse(text) }
  catch {
    if (hasCanvasHeader(text)) throw denied(`无法确认画布 ${path} 的文件引用，画布与素材均未删除`)
    return
  }
  if (!hasCanvasMarker(canvas)) return
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw denied(`无法确认画布 ${path} 的字符编码，画布与素材均未删除`) }
  if (!Array.isArray(canvas.nodes) || canvas.nodes.some(node => !node || typeof node.id !== 'string' || !node.id)
    || new Set(canvas.nodes.map(node => node.id)).size !== canvas.nodes.length) {
    throw denied(`无法确认画布 ${path} 的节点归属，画布与素材均未删除`)
  }
  return { path, nodes: canvas.nodes }
}

// Validate only the requested cleanup subset. Ownership comes from the actual
// canvases being removed; references never grant ownership of another directory.
export async function assertCanvasCleanupSafe({ directories, removedFiles, canvases, files, scope, readText, activePaths = [] }: {
  directories: readonly string[]; removedFiles: ReadonlySet<string>; canvases: readonly Canvas[];
  files: readonly File[]; scope: WorkspaceReferenceScope; readText(path: string): string | Promise<string>; activePaths?: readonly string[];
}) {
  if (!directories.length) return
  const candidates = new Map(directories.map(path => [path.toLowerCase(), path]))
  const removed = canvases.filter(canvas => removedFiles.has(canvas.path))
  const retained = canvases.filter(canvas => !removedFiles.has(canvas.path))
  const owned = new Set(removed.flatMap(canvas => canvas.nodes.map(node => `assets/${node.id}`)))
  for (const directory of directories) {
    if (!/^assets\/[^/]+$/.test(directory) || !isWorkspacePath(directory) || !owned.has(directory)) {
      throw denied(`素材目录 ${directory} 不属于本次删除的画布，画布与素材均未删除`)
    }
  }
  const protect = (path: string, source: string) => {
    const lower = path.toLowerCase()
    const directory = lower === 'assets' ? candidates.values().next().value : candidates.get(lower.split('/').slice(0, 2).join('/'))
    if (directory) throw denied(`素材目录 ${directory} 仍被${source}使用，画布与素材均未删除`)
  }
  for (const path of activePaths) {
    if (!isWorkspacePath(path)) throw denied('无法确认活跃任务的素材目录，画布与素材均未删除')
    protect(path, '活跃任务')
  }
  const indexed = new Map(files.map(file => [file.path.toLowerCase(), file]))
  const queued = new Set<string>(), pending: string[] = []
  const insideCandidate = (path: string) => candidates.has(path.toLowerCase().split('/').slice(0, 2).join('/'))
  const queue = (path: string) => {
    const file = indexed.get(path.toLowerCase())
    const actual = file?.path || path
    if (!queued.has(actual)) { queued.add(actual); pending.push(actual) }
  }
  const inspectReference = (path: string, source: string) => {
    protect(path, source)
    const file = indexed.get(path.toLowerCase())
    if (file && isMarkdownFile(file.path, file.mime) && !removedFiles.has(file.path)) queue(file.path)
  }
  for (const canvas of retained) {
    for (const node of canvas.nodes) protect(`assets/${node.id}`, `保留画布 ${canvas.path} 的节点`)
    for (const reference of canvasFileReferences(canvas.nodes, scope)) {
      inspectReference(reference.path, `保留画布 ${canvas.path}`)
      // A text node's body is Markdown even when a legacy path has no .md suffix.
      if (reference.kind === 'text' && !removedFiles.has(reference.path)) queue(reference.path)
    }
    // Preserve legacy/custom node declarations as well as the standard fields
    // above. A nested source path must not disappear just because its MIME or
    // output metadata is incomplete.
    const pendingData: unknown[] = canvas.nodes.map(node => node.data), visited = new WeakSet<object>()
    while (pendingData.length) {
      const value = pendingData.pop()
      if (typeof value === 'string') {
        const reference = workspaceFileReference(value, scope)
        if (reference?.sameScope) inspectReference(reference.path, `保留画布 ${canvas.path}`)
      } else if (value && typeof value === 'object' && !visited.has(value)) {
        visited.add(value)
        pendingData.push(...Object.values(value))
      }
    }
  }
  // Files removed with the selected canvas/folder and candidate bodies are not
  // surviving owners. All other Markdown files can retain those originals.
  for (const file of files) if (file.mime !== 'inode/directory' && isMarkdownFile(file.path, file.mime)
    && !removedFiles.has(file.path) && !insideCandidate(file.path)) queue(file.path)
  for (let index = 0; index < pending.length; index++) {
    const path = pending[index]!
    let references
    try { references = markdownFileReferences((await readText(path)), path, scope) }
    catch { throw denied(`无法确认文档 ${path} 的素材引用，画布与素材均未删除`) }
    for (const reference of references) inspectReference(reference.path, `文档 ${path}`)
  }
}
