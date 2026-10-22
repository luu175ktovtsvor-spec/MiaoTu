import { isWorkspacePath, workspaceFileReference, type WorkspaceReferenceScope } from './workspace-path.ts'
import { markdownFileReferences, type MarkdownFileReference } from './markdown-file-references.ts'
import { canvasTextSnapshotReferences } from './canvas-text-snapshot.ts'
export { workspaceFileReference, type WorkspaceReferenceScope } from './workspace-path.ts'

export type CanvasFileReference = { nodeId: string; path: string; kind: 'media' | 'text' | 'model' | 'link' }

const inlineReferences = new WeakMap<object, { sources: { path: string; text: string }[]; key: string; references: MarkdownFileReference[] }>()

// Include legacy media declarations even when their MIME metadata is incomplete:
// losing a malformed reference must not turn an original into a disposable file.
export function canvasFileReferences(nodes: readonly { id: string; data?: unknown }[], scope: WorkspaceReferenceScope): CanvasFileReference[] {
  const result: CanvasFileReference[] = []
  const add = (nodeId: string, source: unknown, kind: CanvasFileReference['kind']) => {
    const reference = workspaceFileReference(source, scope)
    if (reference?.sameScope) result.push({ nodeId, path: reference.path, kind })
  }
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.data || typeof node.data !== 'object') continue
    const data = node.data as Record<string, unknown>
    add(node.id, data.textPath, 'text'); add(node.id, data.modelPath, 'model')
    const path = isWorkspacePath(data.textPath) ? data.textPath : `assets/${node.id}/content.md`
    const sources = typeof data.textSnapshot === 'string' ? [{ path: isWorkspacePath(data.textSnapshotPath) ? data.textSnapshotPath : path, text: data.textSnapshot }] : []
    if (data.outputs && typeof data.outputs === 'object') for (const output of Object.values(data.outputs)) {
      if (output?.dataType === 'STRING' && typeof output.value === 'string') sources.push({ path, text: output.value })
    }
    const key = JSON.stringify([scope, data.textSnapshotPaths])
    let inline = inlineReferences.get(data)
    if (!inline || inline.key !== key || inline.sources.length !== sources.length || sources.some((source, index) => source.path !== inline!.sources[index]?.path || source.text !== inline!.sources[index]?.text)) {
      inline = { key, sources, references: sources.flatMap((source, index) => index === 0 && typeof data.textSnapshot === 'string'
        ? canvasTextSnapshotReferences(data, path, scope) : markdownFileReferences(source.text, source.path, scope)) }
      inlineReferences.set(data, inline)
    }
    for (const reference of inline.references) result.push({ nodeId: node.id, ...reference })
    if (!data.outputs || typeof data.outputs !== 'object') continue
    for (const output of Object.values(data.outputs)) {
      if (!output || typeof output !== 'object' || !['IMAGE', 'MASK', 'VIDEO', 'AUDIO'].includes(output.dataType)) continue
      add(node.id, output.value?.url, 'media')
    }
  }
  return result
}
