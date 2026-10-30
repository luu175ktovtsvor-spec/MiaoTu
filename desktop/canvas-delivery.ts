import { canvasNodePosition, type CanvasDocument, type CanvasNode } from '../server/canvas-document.ts'
import { validCanvas } from '../server/canvas-state.ts'
import { isWorkspacePath } from '../server/workspace-path.ts'

type CanvasMedia = { path: string; mime: string; downloadSource?: 'platform-player' | 'platform-download' }
type CanvasMediaNode = { id: string; type?: string; position: { x: number; y: number }; parentNode?: unknown; data?: Record<string, unknown> }
export type CanvasMediaDelivery = { nodeId: string; requestId: string; kind: 'image' | 'video'; items: readonly CanvasMedia[]; directory?: string }
export type CanvasMediaTarget = { nodeId: string; segment?: { runId: string; partId: string } }
type MediaValue = ReturnType<typeof mediaValue>
export type CanvasMediaPlan = { owned: boolean; additions: CanvasNode[]; output?: { dataType: 'IMAGE' | 'VIDEO'; value: MediaValue }; segment?: { runId: string; partId: string; output: MediaValue } }
export type CanvasMediaTask = { taskRequestId?: string; taskOutputPath?: string; taskExtraNodeIds?: string[] }
type CanvasFiles = { list(): readonly { path: string }[] | Promise<readonly { path: string }[]>; read(path: string): string | Promise<string>; write(path: string, text: string): void | Promise<void> }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const mediaValue = (item: CanvasMedia) => ({ url: item.path, mimeType: item.mime,
  ...(['platform-player', 'platform-download'].includes(item.downloadSource || '') ? { downloadSource: item.downloadSource } : {}) })

export function canvasMediaTarget(directory: string): CanvasMediaTarget | undefined {
  if (!isWorkspacePath(directory)) return
  // Imported canvases can contain valid Unicode IDs as well as generated UUIDs.
  const node = /^assets\/([^/]+)$/.exec(directory)
  if (node) return { nodeId: node[1] }
  const segment = /^assets\/([^/]+)\/segment-remake\/([^/]+)\/([^/]+)$/.exec(directory)
  if (segment) return { nodeId: segment[1], segment: { runId: segment[2], partId: segment[3] } }
}

export function canvasMediaNodeId(directory: string) { return canvasMediaTarget(directory)?.nodeId }

export function canvasMediaPath(outputs: unknown, kind: 'image' | 'video') {
  const output = record(outputs) && record(outputs[kind]) ? outputs[kind] : undefined
  return output && record(output.value) && typeof output.value.url === 'string' ? output.value.url : ''
}

export function clearCanvasMediaTask(data: CanvasMediaTask, requestId: string) {
  if (data.taskRequestId !== requestId) return
  delete data.taskRequestId
  delete data.taskOutputPath
  delete data.taskExtraNodeIds
}

// Native saving and the live observer share the same ownership decision.
// Detached receipts only confirm originals already present in this canvas.
export function planCanvasMedia(nodes: readonly CanvasMediaNode[], { nodeId, requestId, kind, items, directory }: CanvasMediaDelivery): CanvasMediaPlan | undefined {
  if (!items.length || !requestId) return undefined
  const node = nodes.find(item => item.id === nodeId)
  const data = node && record(node.data) ? node.data : undefined
  const target = directory === undefined ? undefined : canvasMediaTarget(directory)
  if (directory !== undefined && (!target || target.nodeId !== nodeId)) return
  if (target?.segment) {
    if (kind !== 'video' || items.length !== 1 || !['remote-videoNode', 'remote-videoGenerationNode'].includes(node?.type || '')
      || !items.every(item => isWorkspacePath(item.path) && item.path.startsWith(directory! + '/') && /^video\//i.test(item.mime))) return
    const run = data?.segmentRemakeRun
    if (!record(run) || run.id !== target.segment.runId || !Array.isArray(run.parts)) return
    const matches = run.parts.filter(part => record(part) && part.id === target.segment!.partId)
    if (matches.length !== 1) return
    const part = matches[0]
    // Native delivery and a live observer may finish the same task in either
    // order. A completed receipt acknowledges its own output without reviving
    // the old task or clearing a newer attempt's receipt.
    if (part.completedRequestId === requestId && record(part.output) && part.output.url === items[0].path
      && part.output.mimeType === items[0].mime && part.taskRequestId !== requestId) return { owned: false, additions: [] }
    if (part.taskRequestId !== requestId) return
    return { owned: true, additions: [], segment: { ...target.segment, output: mediaValue(items[0]) } }
  }
  const present = (path: string) => nodes.some(item => canvasMediaPath(item.data?.outputs, kind) === path)
  const owned = !!data && data.taskRequestId === requestId
    && (node.type === `remote-${kind}GenerationNode` || kind === 'image' && node.type === 'remote-imageNode')
  if (!owned) return items.every(item => present(item.path)) ? { owned: false, additions: [] as CanvasNode[] } : undefined
  if (data.outputs !== undefined && !record(data.outputs)) return undefined
  const current = canvasMediaPath(data.outputs, kind)
  const replace = current === items[0]!.path || (typeof data.taskOutputPath === 'string' ? current === data.taskOutputPath : !current)
  const additions: CanvasNode[] = []
  const origin = canvasNodePosition(node, nodes)
  const reserved = Array.isArray(data.taskExtraNodeIds) ? data.taskExtraNodeIds : []
  items.forEach((item, ordinal) => {
    if (ordinal === 0 && replace || present(item.path) || additions.some(value => canvasMediaPath(value.data?.outputs, kind) === item.path)) return
    const preferred = ordinal > 0 && typeof reserved[ordinal - 1] === 'string' && reserved[ordinal - 1]
      ? reserved[ordinal - 1] as string : `${requestId}-result-${ordinal + 1}`
    let id = preferred, suffix = 1
    while (nodes.some(value => value.id === id) || additions.some(value => value.id === id)) id = `${preferred}-${++suffix}`
    const index = additions.length
    additions.push({ id, type: `remote-${kind}Node`,
      position: { x: origin.x + 380 + index % 2 * 300, y: origin.y + Math.floor(index / 2) * 260 },
      data: { label: kind === 'video' ? '生成视频' : data.layerDecomposition && ordinal > 0 ? `图层 ${ordinal}` : `图片 ${ordinal + 1}`,
        outputs: { [kind]: { dataType: kind === 'video' ? 'VIDEO' : 'IMAGE', value: mediaValue(item) } } } })
  })
  return { owned: true, output: replace ? { dataType: kind === 'video' ? 'VIDEO' as const : 'IMAGE' as const,
    value: mediaValue(items[0]!) } : undefined, additions }
}

// The task owner runs this transactionally after saving every original.
export function applyCanvasMedia(canvas: unknown, delivery: CanvasMediaDelivery) {
  if (!validCanvas(canvas)) return false
  const document = canvas as CanvasDocument
  const plan = planCanvasMedia(document.nodes, delivery)
  if (!plan) return false
  if (plan.owned) {
    const data = document.nodes.find(item => item.id === delivery.nodeId)!.data!
    if (plan.segment) {
      const run = data.segmentRemakeRun as Record<string, any>
      const part = run.parts.find(item => item.id === plan.segment!.partId)
      part.output = plan.segment.output
      part.completedRequestId = delivery.requestId
      part.state = 'complete'
      delete part.taskRequestId
      delete part.error
      return true
    }
    if (plan.output) (data.outputs ??= {})[delivery.kind] = plan.output
    document.nodes.push(...plan.additions)
    clearCanvasMediaTask(data, delivery.requestId)
  }
  return true
}

export async function patchCanvasMediaFiles(files: CanvasFiles, delivery: CanvasMediaDelivery) {
  let saved = false
  // Match the canvas picker and path validator, including a .JSON suffix.
  for (const entry of (await files.list()).filter(item => /\.json$/i.test(item.path) && !/^(assets|agent|providers)\//i.test(item.path))) {
    let canvas: unknown
    try { canvas = JSON.parse((await files.read(entry.path))) } catch { continue }
    const before = JSON.stringify(canvas)
    if (!applyCanvasMedia(canvas, delivery)) continue
    if (JSON.stringify(canvas) !== before) await files.write(entry.path, JSON.stringify(canvas))
    saved = true
  }
  return saved
}
