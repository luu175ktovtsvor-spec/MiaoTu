import { markdownFileReferences, type MarkdownFileReference } from './markdown-file-references.ts'
import { isWorkspacePath, type WorkspaceReferenceScope } from './workspace-path.ts'

type SnapshotData = { textSnapshot?: unknown; textSnapshotPath?: unknown; textSnapshotPaths?: unknown }
type CopyNode = { id: string; type?: string; data?: Record<string, unknown> }
const invalid = () => new Error('文本副本的正文路径映射无效，请重新复制')

export function canonicalNodeTextPath(id: string) {
  const path = `assets/${id}/content.md`
  if (!id || id.includes('/') || !isWorkspacePath(path)) throw invalid()
  return path
}

function canonicalTextPath(path: unknown): path is string {
  return isWorkspacePath(path) && /^assets\/[^/]+\/content\.md$/.test(path)
}

// Only mutable node bodies participate. Media and ordinary documents never
// become aliases merely because their directory contains a copied node ID.
export function canvasTextSnapshotPaths(data: SnapshotData): ReadonlyMap<string, string> {
  const value = data.textSnapshotPaths
  if (value === undefined) return new Map()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const paths = new Map<string, string>()
  for (const [source, target] of Object.entries(value)) {
    if (!canonicalTextPath(source) || !canonicalTextPath(target)) throw invalid()
    paths.set(source, target)
  }
  return paths
}

export function remapCanvasTextSnapshots(copies: readonly CopyNode[], ids: ReadonlyMap<string, string>, scope: WorkspaceReferenceScope) {
  const originals = new Map([...ids].map(([source, target]) => [target, source]))
  const bodies = copies.flatMap(node => {
    if (node.type !== 'remote-textNode') return []
    const original = originals.get(node.id)
    if (!original || !node.data) throw invalid()
    if (node.data.textSnapshot !== undefined && typeof node.data.textSnapshot !== 'string') throw invalid()
    const outputs = node.data.outputs
    const output = outputs && typeof outputs === 'object' && !Array.isArray(outputs)
      ? Reflect.get(outputs, 'text') : undefined
    const inline = output && typeof output === 'object' && !Array.isArray(output)
      && Reflect.get(output, 'dataType') === 'STRING' ? Reflect.get(output, 'value') : undefined
    const text = typeof node.data.textSnapshot === 'string' ? node.data.textSnapshot
      : typeof inline === 'string' ? inline : node.data.textPath === undefined ? '' : undefined
    if (text === undefined) throw new Error('文本节点尚未读取正文，请加载后重新复制')
    const source = node.data.textSnapshotPath ?? canonicalNodeTextPath(original)
    if (!isWorkspacePath(source) || /^[a-z][a-z\d+.-]*:/i.test(source)) throw invalid()
    return [{ data: node.data, text, source, original: canonicalNodeTextPath(original), target: canonicalNodeTextPath(node.id), previous: canvasTextSnapshotPaths(node.data) }]
  })
  const direct = new Map(bodies.map(body => [body.original, body.target]))
  const aliases = new Map<string, Set<string>>()
  for (const body of bodies) if (canonicalTextPath(body.source)) {
    const targets = aliases.get(body.source) ?? new Set<string>()
    targets.add(body.target); aliases.set(body.source, targets)
  }
  const prepared = bodies.map(body => {
    const paths = new Map<string, string>()
    for (const reference of markdownFileReferences(body.text, body.source, scope)) {
      if (reference.kind !== 'link' || !canonicalTextPath(reference.path)) continue
      const previous = body.previous.get(reference.path)
      let target = previous ? direct.get(previous) ?? previous
        : reference.path === body.source ? body.target : direct.get(reference.path)
      if (!target && aliases.has(reference.path)) {
        const targets = aliases.get(reference.path)!
        if (targets.size !== 1) throw new Error('文本副本的正文来源不明确，请等待节点加载后重新复制')
        target = [...targets][0]
      }
      if (target && target !== reference.path) paths.set(reference.path, target)
    }
    return { body, paths: Object.fromEntries(paths) }
  })
  for (const { body, paths } of prepared) {
    body.data.textSnapshot = body.text
    body.data.textSnapshotPath = body.source
    delete body.data.textPath
    const outputs = body.data.outputs
    if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
      const output = Reflect.get(outputs, 'text')
      if (output && typeof output === 'object' && Reflect.get(output, 'dataType') === 'STRING') {
        const remaining = { ...outputs }
        Reflect.deleteProperty(remaining, 'text')
        body.data.outputs = remaining
      }
    }
    if (Object.keys(paths).length) body.data.textSnapshotPaths = paths
    else delete body.data.textSnapshotPaths
  }
}

// Unmounted copies still own the same eventual destinations as loadText.
export function canvasTextSnapshotReferences(data: SnapshotData, targetPath: string, scope?: WorkspaceReferenceScope): MarkdownFileReference[] {
  if (typeof data.textSnapshot !== 'string') return []
  const source = isWorkspacePath(data.textSnapshotPath) ? data.textSnapshotPath : targetPath
  const paths = canvasTextSnapshotPaths(data)
  return markdownFileReferences(data.textSnapshot, source, scope).map(reference => reference.kind === 'link'
    ? { ...reference, path: paths.get(reference.path) ?? (reference.path === source ? targetPath : reference.path) } : reference)
}
