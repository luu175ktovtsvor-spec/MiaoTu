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
    if (data.panorama && typeof data.panorama === 'object') add(node.id, Reflect.get(data.panorama, 'url'), 'media')
    if (data.preparedOutpaint && typeof data.preparedOutpaint === 'object' && Reflect.get(data.preparedOutpaint, 'version') === 1) {
      for (const field of ['imagePath', 'maskPath', 'sourcePath']) add(node.id, Reflect.get(data.preparedOutpaint, field), 'media')
    }
    const media = (value: unknown) => {
      if (value && typeof value === 'object') add(node.id, Reflect.get(value, 'url'), 'media')
    }
    const sourceMedia = (value: unknown) => {
      if (value && typeof value === 'object') media(Reflect.get(value, 'file'))
    }
    if (data.segmentRemakeDraft && typeof data.segmentRemakeDraft === 'object') sourceMedia(Reflect.get(data.segmentRemakeDraft, 'source'))
    const runMedia = (value: unknown) => {
      if (!value || typeof value !== 'object') return
      const run = value as Record<string, unknown>
      sourceMedia(run.source); media(run.result)
      if (Array.isArray(run.parts)) for (const part of run.parts) {
        if (!part || typeof part !== 'object') continue
        media(Reflect.get(part, 'input')); media(Reflect.get(part, 'output'))
      }
      if (run.references && typeof run.references === 'object') for (const kind of ['images', 'audios']) {
        const references = Reflect.get(run.references, kind)
        if (Array.isArray(references)) references.forEach(media)
      }
    }
    runMedia(data.segmentRemakeRun)
    if (Array.isArray(data.segmentRemakeHistory)) data.segmentRemakeHistory.forEach(runMedia)
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
