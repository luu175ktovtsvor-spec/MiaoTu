import { hasCanvasMarker, normalizeCanvasDocument, canvasMarkerKeys } from './canvas-document.ts'
export type CanvasCopySnapshot = { path: string; revision: string; canvas: Record<string, any> }
// Shared by the server's atomic save and the browser's live reconciliation.
const plain = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

// Individually valid edits can form an invalid hierarchy after a three-way
// merge: two readers can move each group into the other, or one can add a child
// while another removes its parent. Keep those edits for conflict recovery;
// never publish the orphan/cycle or silently remove the newly added node.
function hierarchyConflicts(nodes: readonly Record<string, any>[]) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const conflicts = new Set<string>()
  const state = new Map<string, 'visiting' | 'complete'>()
  const parent = (node: Record<string, any>) => {
    const id = node.parentNode
    // Vue Flow treats an omitted/null/empty parent as a root node.
    if (id === undefined || id === null || id === '') return undefined
    if (typeof id !== 'string' || !byId.has(id)) {
      conflicts.add(`nodes.${node.id}.parentNode`)
      return undefined
    }
    return byId.get(id)
  }
  for (const start of nodes) {
    if (state.has(start.id)) continue
    const path: Record<string, any>[] = []
    let current: Record<string, any> | undefined = start
    while (current && !state.has(current.id)) {
      state.set(current.id, 'visiting')
      path.push(current)
      current = parent(current)
    }
    if (current && state.get(current.id) === 'visiting') {
      const first = path.findIndex(node => node.id === current!.id)
      for (const node of path.slice(first)) conflicts.add(`nodes.${node.id}.parentNode`)
    }
    for (const node of path) state.set(node.id, 'complete')
  }
  return [...conflicts]
}

export function validCanvas(value: any) {
  return plain(value) && hasCanvasMarker(value)
    && ['nodes', 'edges'].every(key => Array.isArray(value[key])
      && value[key].every(item => plain(item) && typeof item.id === 'string' && item.id.length > 0)
      && new Set(value[key].map(item => item.id)).size === value[key].length)
    && plain(value.viewport) && ['x', 'y', 'zoom'].every(key => Number.isFinite(value.viewport[key]))
    && value.viewport.zoom > 0
    && hierarchyConflicts(value.nodes as Record<string, any>[]).length === 0
}
// These coordinates are recalculated by Vue Flow for each browser layout.
// They are not graph edits and must never participate in persistence/conflicts.
const edgeDisplayFields = new Set(['sourceX', 'sourceY', 'targetX', 'targetY', 'sourceNode', 'targetNode', 'selected', 'events'])
export function persistentCanvas(value) {
  const canvas: Record<string, any> = { ...normalizeCanvasDocument(value), edges: value.edges.map(edge => Object.fromEntries(
    Object.entries(edge).filter(([key]) => !edgeDisplayFields.has(key))
  )) }
  // Vue Flow also emits deprecated top-level viewport aliases. The canonical
  // viewport remains local to each browser; aliases must not become edits.
  delete canvas.position
  delete canvas.zoom
  return canvas
}
export function mergeCanvasState(base, local, remote) {
  if (![base, local, remote].every(validCanvas)) throw new Error('画布文件格式无效')
  ;[base, local, remote] = [base, local, remote].map(persistentCanvas)
  const conflicts = []
  function merge(b, l, r, path) {
    if (equal(l, r) || equal(b, r)) return copy(l)
    if (equal(b, l)) return copy(r)
    if (plain(b) && plain(l) && plain(r) && !path.endsWith('.position') && path !== 'viewport') {
      const result = {}
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const value = merge(b[key], l[key], r[key], path ? path + '.' + key : key)
        if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true })
      }
      return result
    }
    conflicts.push(path)
    return copy(l)
  }
  function elements(key) {
    const [b, l, r] = [base, local, remote].map(canvas => new Map(canvas[key].map(item => [item.id, item])))
    const order = new Set([...remote[key].map(item => item.id), ...local[key].map(item => item.id)])
    const result = []
    for (const id of order) {
      const item = merge(b.get(id), l.get(id), r.get(id), key + '.' + id)
      if (item !== undefined) result.push(item)
    }
    return result
  }
  const roots = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['nodes', 'edges', 'viewport', 'schemaVersion', ...canvasMarkerKeys].includes(key)))
  const canvas = { ...merge(roots(base), roots(local), roots(remote), 'canvas'), miaoimgCanvas: true, schemaVersion: 1, nodes: elements('nodes'), edges: elements('edges'),
    // Pan/zoom belong to this browser; they must not contend with content changes.
    viewport: copy(local.viewport) }
  const ids = new Set(canvas.nodes.map(node => node.id))
  for (const edge of canvas.edges) if (!ids.has(edge.source) || !ids.has(edge.target)) {
    const existed = [...base.edges, ...local.edges, ...remote.edges].some(item => item.id === edge.id
      && (!new Set([...base.nodes, ...local.nodes, ...remote.nodes].map(node => node.id)).has(item.source)
        || !new Set([...base.nodes, ...local.nodes, ...remote.nodes].map(node => node.id)).has(item.target)))
    if (!existed) conflicts.push('edges.' + edge.id + '.connection')
  }
  conflicts.push(...hierarchyConflicts(canvas.nodes))
  return { canvas: normalizeCanvasDocument(canvas), conflicts: [...new Set(conflicts)] }
}
