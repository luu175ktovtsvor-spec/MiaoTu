import { persistentCanvas, validCanvas, type CanvasCopySnapshot } from './canvas-state.ts'

type Source = { path: string; mime: string; revision: string }
type CopyRequest = { canvasCopies?: CanvasCopySnapshot[]; sourceEntries?: { path: string; revision: string }[] }
const failure = (message: string, status = 422) => Object.assign(new Error(message), { status })

// Complete preflight before publishing any target index. A plain file copy of
// a canvas would retain node IDs and silently share mutable node documents.
export function prepareCanvasCopies(sources: readonly Source[], payload: CopyRequest,
  readSource: (path: string) => Buffer, maxBytes: number) {
  if (payload.canvasCopies !== undefined) {
    if (!Array.isArray(payload.canvasCopies) || !payload.canvasCopies.length || !Array.isArray(payload.sourceEntries)) throw failure('画布复制数据无效')
    const expected = new Map(payload.sourceEntries.map(entry => [entry?.path, entry?.revision]))
    if (expected.size !== payload.sourceEntries.length || expected.size !== sources.length
      || sources.some(row => expected.get(row.path) !== row.revision)) throw failure('复制来源已变化，请重新复制', 409)
  }
  const readCanvas = (path: string) => {
    const content = readSource(path)
    try { return JSON.parse(content.toString('utf8')) } catch { return undefined }
  }
  const canvases = new Map<string, any>()
  for (const source of sources) {
    if (source.mime === 'inode/directory' || !/\.json$/i.test(source.path)) continue
    const stored = readCanvas(source.path)
    if (validCanvas(stored)) canvases.set(source.path, stored)
  }
  const byPath = new Map(sources.map(source => [source.path, source]))
  const copies = new Map<string, Buffer>()
  const originalIds = new Set([...canvases.values()].flatMap(canvas => [...canvas.nodes, ...canvas.edges].map(item => item.id)))
  const copiedIds = new Set<string>()
  for (const snapshot of payload.canvasCopies ?? []) {
    const source = byPath.get(snapshot?.path)
    if (!source || source.revision !== snapshot.revision) throw failure('画布已变化，请重新复制', 409)
    if (copies.has(source.path) || source.mime === 'inode/directory' || !validCanvas(snapshot.canvas)) throw failure('画布复制数据无效')
    const stored = canvases.get(source.path) ?? readCanvas(source.path)
    if (!validCanvas(stored)) throw failure('复制来源不是画布')
    for (const item of [...stored.nodes, ...stored.edges]) originalIds.add(item.id)
    for (const item of [...snapshot.canvas.nodes, ...snapshot.canvas.edges]) {
      if (originalIds.has(item.id) || copiedIds.has(item.id)) throw failure('画布副本必须使用独立编号')
      copiedIds.add(item.id)
    }
    const canvas = persistentCanvas(snapshot.canvas)
    // A file-level independent copy must not inherit the original paid task,
    // including callers which did not run the mounted node's copy callback.
    canvas.nodes = canvas.nodes.map(node => {
      if (!['remote-imageGenerationNode', 'remote-videoGenerationNode', 'remote-imageNode', 'remote-textNode'].includes(node.type) || !node.data) return node
      const data = { ...node.data }
      delete data.taskRequestId
      delete data.taskOutputPath
      delete data.taskExtraNodeIds
      delete data.pendingLocalTextTask
      return { ...node, data }
    })
    const content = Buffer.from(JSON.stringify(canvas))
    if (content.length > maxBytes) throw failure('单个文件不能超过 200MB', 413)
    copies.set(source.path, content)
  }
  if ([...copiedIds].some(id => originalIds.has(id))) throw failure('画布副本必须使用独立编号')
  if ([...canvases.keys()].some(path => !copies.has(path))) throw failure('画布副本必须独立，请通过画布复制入口操作', 409)
  return copies
}
