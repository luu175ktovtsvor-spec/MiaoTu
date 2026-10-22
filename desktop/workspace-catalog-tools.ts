import type { LocalStore } from './store.ts'
import type { DesktopWorkspaceFiles } from './workspace-files.ts'

const MAX_PROJECTS = 100
const MAX_CANVASES = 200
const MAX_CANVAS_BYTES = 8 * 1024 * 1024
const MAX_NODES = 160
const MAX_DATA_CHARS = 24_000

function canvasEntries(files: DesktopWorkspaceFiles, project: string) {
  return files.list('local', project)
    .filter(entry => entry.mime !== 'inode/directory' && /\.json$/i.test(entry.path) && !/^(agent|assets|skills|settings)\//i.test(entry.path))
    .filter(entry => {
      try { return files.isCanvasFile('local', entry.path, project) } catch { return false }
    })
}

function canvasSummary(files: DesktopWorkspaceFiles, project: string, entry: { path: string; revision?: string; updatedAt?: string; size?: number }) {
  const bytes = files.read('local', entry.path, project).bytes
  const canvas = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) throw new Error(`画布文件无效：${entry.path}`)
  return {
    id: entry.path,
    name: String(canvas.name || entry.path.replace(/\.json$/i, '')),
    revision: entry.revision || null,
    updatedAt: entry.updatedAt || null,
    size: Number(entry.size) || bytes.length,
    nodeCount: canvas.nodes.length,
    edgeCount: canvas.edges.length,
  }
}

function trimValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > MAX_DATA_CHARS ? `${value.slice(0, MAX_DATA_CHARS)}\n…[已截断]` : value
  if (Array.isArray(value)) return value.slice(0, 200).map(trimValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 160).map(([key, item]) => [key, trimValue(item)]))
}

export function createWorkspaceCatalogTools({ store, files }: { store: LocalStore; files: DesktopWorkspaceFiles }) {
  return [
    {
      name: 'listWorkspaceProjects',
      description: '只读列出本机当前妙图账号的全部项目及每个项目里的画布数量。用于同一 Agent 会话查看其他项目，不需要切换当前项目；写操作仍只能作用于当前项目。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          includeCanvases: { type: 'boolean', description: '是否同时列出每个项目的画布名称和路径；默认 false。' },
        },
      },
      async execute(args: Record<string, unknown> = {}) {
        const projects = store.projects().slice(0, MAX_PROJECTS).map(project => {
          const canvases = canvasEntries(files, project.id).slice(0, MAX_CANVASES)
          return {
            id: project.id,
            name: project.name,
            source: project.source,
            createdAt: project.createdAt,
            lastOpenedAt: project.lastOpenedAt,
            canvasCount: canvases.length,
            ...(args.includeCanvases === true ? { canvases: canvases.map(entry => canvasSummary(files, project.id, entry)) } : {}),
          }
        })
        return { projects, truncated: store.projects().length > MAX_PROJECTS }
      },
    },
    {
      name: 'listProjectCanvases',
      description: '只读列出一个已存在项目里的画布，返回画布路径、名称、节点数、连线数和修订号。可读取其他项目，不会切换当前画布；修改画布仍须先打开对应项目和画布。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', minLength: 1, maxLength: 128, description: 'listWorkspaceProjects 返回的项目 id。' },
        },
      },
      async execute(args: Record<string, unknown>) {
        const project = store.project(String(args.projectId || ''))
        const canvases = canvasEntries(files, project.id)
        return { project, canvases: canvases.slice(0, MAX_CANVASES).map(entry => canvasSummary(files, project.id, entry)), truncated: canvases.length > MAX_CANVASES }
      },
    },
    {
      name: 'readProjectCanvas',
      description: '只读读取任意本机项目中的一张画布结构和节点内容，用于同一会话理解其他画布或项目。只接受该项目内已识别为画布的 JSON；不会切换、保存或修改画布。默认最多返回 160 个节点，较多时用 nodeIds 精确读取。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['projectId', 'canvasId'],
        properties: {
          projectId: { type: 'string', minLength: 1, maxLength: 128 },
          canvasId: { type: 'string', minLength: 1, maxLength: 500, description: 'listProjectCanvases 返回的画布路径。' },
          nodeIds: { type: 'array', maxItems: 160, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 256 } },
          includeNodeData: { type: 'boolean', description: '是否包含节点的提示词、模型、参数和输出引用；默认 true。' },
        },
      },
      async execute(args: Record<string, unknown>) {
        const project = store.project(String(args.projectId || ''))
        const canvasId = String(args.canvasId || '')
        if (!/\.json$/i.test(canvasId) || !files.isCanvasFile('local', canvasId, project.id)) throw new Error('指定路径不是当前项目中的画布')
        const file = files.read('local', canvasId, project.id)
        if (!file.bytes || file.bytes.length > MAX_CANVAS_BYTES) throw new Error('画布文件过大，已拒绝一次读取；请先用 listProjectCanvases 确认目标')
        const canvas = JSON.parse(file.bytes.toString('utf8'))
        if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) throw new Error('画布文件结构无效')
        const wanted = Array.isArray(args.nodeIds) ? new Set(args.nodeIds.map(String)) : undefined
        const nodes = canvas.nodes
          .filter((node: any) => !wanted || wanted.has(String(node?.id || '')))
          .slice(0, MAX_NODES)
          .map((node: any) => ({
            id: String(node?.id || ''),
            type: String(node?.type || ''),
            label: String(node?.data?.label || node?.label || ''),
            position: node?.position || null,
            ...(args.includeNodeData === false ? {} : { data: trimValue(node?.data || {}) }),
          }))
        return {
          project,
          canvas: { id: canvasId, name: String(canvas.name || canvasId.replace(/\.json$/i, '')), revision: file.revision },
          nodes,
          edges: canvas.edges.slice(0, 400),
          viewport: canvas.viewport || null,
          nodeCount: canvas.nodes.length,
          edgeCount: canvas.edges.length,
          truncated: canvas.nodes.length > nodes.length,
        }
      },
    },
  ]
}
