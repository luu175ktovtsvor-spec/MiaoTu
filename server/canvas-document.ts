import legacy from '../docs/compatibility/canvas-v1.json' with { type: 'json' }

export type CanvasPosition = { x: number; y: number }
export type CanvasViewport = CanvasPosition & { zoom: number }
export type CanvasElement = { id: string; [field: string]: unknown }
export type CanvasNode = CanvasElement & { position: CanvasPosition; type?: string; data?: Record<string, unknown> }
export type CanvasEdge = CanvasElement & { source: string; target: string }
export type CanvasDocument = {
  miaoimgCanvas: true
  schemaVersion?: 1
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: CanvasViewport
  [field: string]: unknown
}

// Persisted positions are relative to the parent group. New root-level result
// nodes need canvas coordinates, including every ancestor of nested groups.
export function canvasNodePosition(node: { id: string; position?: CanvasPosition; parentNode?: unknown }, nodes: readonly { id: string; position?: CanvasPosition; parentNode?: unknown }[]): CanvasPosition {
  const byId = new Map(nodes.map(item => [item.id, item]))
  const visited = new Set<string>()
  const position = { x: 0, y: 0 }
  let current: typeof node | undefined = node
  while (current && !visited.has(current.id)) {
    visited.add(current.id)
    position.x += Number.isFinite(current.position?.x) ? current.position!.x : 0
    position.y += Number.isFinite(current.position?.y) ? current.position!.y : 0
    current = typeof current.parentNode === 'string' ? byId.get(current.parentNode) : undefined
  }
  return position
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const canvasMarkerKeys = ['miaoimgCanvas', ...legacy.canvasMarkers]
export function hasCanvasMarker(value: unknown): value is Record<string, unknown> {
  return record(value) && canvasMarkerKeys.some(key => value[key] === true)
}

// File lists inspect a short header rather than loading every large canvas.
const markerPattern = new RegExp(`"(?:${canvasMarkerKeys.join('|')})"\\s*:\\s*true\\s*[,}]`)
export function hasCanvasHeader(header: string): boolean {
  return /^\s*\{/.test(header) && markerPattern.test(header)
}

export function normalizeCanvasDocument(value: unknown): CanvasDocument {
  if (!hasCanvasMarker(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)
    || !record(value.viewport) || !['x', 'y', 'zoom'].every(key => Number.isFinite(value.viewport[key]))
    || Number(value.viewport.zoom) <= 0 || value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('画布文件格式无效或版本不受支持')
  for (const collection of [value.nodes, value.edges]) {
    if (!collection.every(item => record(item) && typeof item.id === 'string' && item.id.length > 0)
      || new Set(collection.map(item => item.id)).size !== collection.length) throw new Error('画布元素编号无效或重复')
  }
  if (!value.nodes.every(node => record(node.position) && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
    || !value.edges.every(edge => typeof edge.source === 'string' && typeof edge.target === 'string')) throw new Error('画布位置或连线格式无效')
  const result = { ...Object.fromEntries(legacy.canvasMarkers.map(key => [key, true])), miaoimgCanvas: true, schemaVersion: 1, ...value } as CanvasDocument
  result.miaoimgCanvas = true
  result.schemaVersion = 1
  // Existing website and installed readers still inspect their historical flag.
  // Keep that compatibility flag alongside the current schema until they migrate.
  for (const key of legacy.canvasMarkers) result[key] = true
  return result
}

export function workspaceRequestHeaders(): Record<string, string> {
  return Object.fromEntries(['x-miaoimg-workspace', ...legacy.workspaceHeaders].map(name => [name, '1']))
}

export function isWorkspaceRequest(headers: Record<string, string | string[] | undefined>): boolean {
  return ['x-miaoimg-workspace', ...legacy.workspaceHeaders].some(name => headers[name] === '1')
}

export function pluginExportNames(kind: 'node' | 'extension'): string[] {
  const current = kind === 'node' ? 'miaoimgNodes' : 'miaoimgExts'
  return [current, ...Object.entries(legacy.globals).filter(([, value]) => value === current).map(([key]) => key)]
}

export function inspectPluginExports(source: string, kind: 'node' | 'extension'): string[] {
  return pluginExportNames(kind).flatMap(name => [
    ...[...source.matchAll(new RegExp(`${name}\\s*\\.\\s*([A-Za-z][A-Za-z0-9]*)`, 'g'))].map(match => match[1]),
    ...[...source.matchAll(new RegExp(`${name}\\s*\\[\\s*["']([A-Za-z][A-Za-z0-9]*)["']\\s*\\]`, 'g'))].map(match => match[1]),
  ])
}

export function usesCanvasHost(source: string, current: string): boolean {
  return [current, ...Object.entries(legacy.globals).filter(([, name]) => name === current).map(([name]) => name)].some(name => source.includes(name))
}

export function readPluginMetadata(source: string, kind: 'node' | 'extension'): unknown {
  const names = kind === 'node' ? ['miaoimgNode', ...legacy.nodeMarkers] : ['miaoimgExt', ...legacy.extensionMarkers]
  const match = new RegExp(`^/\\*! (?:${names.join('|')}):([^\\r\\n]*?) \\*/(?:\\r?\\n|$)`).exec(source)
  return match ? JSON.parse(match[1]) : null
}

export const legacyHostGlobals: Readonly<Record<string, string>> = legacy.globals
export const legacyCanvasEvents: Readonly<Record<string, string>> = legacy.events
export const legacyCanvasStorage: Readonly<Record<string, string>> = legacy.storage
export function canvasInjectionKey(name: string): symbol {
  return Symbol.for(legacy.symbols[name] || name)
}
