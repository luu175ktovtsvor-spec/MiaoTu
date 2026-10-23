import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { CANVAS_TOOLS } from '../server/canvas-tools.ts'
import { MCP_TOOLS } from '../server/mcp-api.ts'

const fail = (message: string): never => { throw new Error(message) }

const requiredGlobalTools = [
  'getAppState', 'getCanvas', 'findCanvasNodes', 'getCanvasNodes', 'getCanvasEdges', 'getNodeTools', 'nodeTools',
  'addCanvas', 'switchCanvas', 'renameCanvas', 'addNode', 'deleteNodes', 'moveNodes', 'renameNodes',
  'connectNodes', 'deleteEdges', 'selectNodes', 'duplicateCanvas', 'duplicateNodes',
  'groupNodes', 'ungroupNodes', 'mergeGroups', 'reparentNodes', 'resizeGroups', 'arrangeNodes',
  'undoCanvas', 'redoCanvas', 'setCanvasView', 'copyNodes', 'pasteNodes', 'importCanvasAssets',
  'createCanvasFolder', 'createAssetFolder', 'moveCanvas', 'deleteCanvas',
  'switchPanel', 'getDocument', 'openDocument', 'writeDocument', 'closeDocument', 'moveDocument',
  'workspaceFiles', 'listSkills', 'readSkill', 'webFetch', 'webSearch', 'ffprobe', 'ffmpeg', 'inspectVideo',
]

const names = MCP_TOOLS.map(tool => tool.name)
if (new Set(names).size !== names.length) fail('MCP tool names must be unique')
for (const name of requiredGlobalTools) if (!names.includes(name)) fail(`missing MCP tool: ${name}`)
for (const tool of MCP_TOOLS) {
  if (!tool.description?.trim()) fail(`missing description: ${tool.name}`)
  fromJsonSchema(tool.parameters)
}

const canvasRoot = resolve('desktop/renderer/src/studio/canvas')
const registrations = new Map<string, Set<string>>()
const walk = (directory: string) => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) { walk(path); continue }
    if (!/\.(vue|ts)$/.test(name)) continue
    const text = readFileSync(path, 'utf8')
    for (const match of text.matchAll(/nodeTools\.register\s*\(\s*\{[\s\S]*?name\s*:\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
      const file = relative(canvasRoot, path)
      registrations.set(file, new Set([...(registrations.get(file) ?? []), match[1]]))
    }
  }
}
walk(canvasRoot)

const requiredNodeTools: Record<string, string[]> = {
  'nodes/textNode.vue': ['getText', 'setText', 'getConfig', 'setConfig', 'generateText', 'reloadText', 'setTextEditor', 'setTextStyle'],
  'nodes/imageNode.vue': ['setImage', 'generateInpaint', 'cancelInpaint'],
  'nodes/imageGenerationNode.vue': ['getConfig', 'setConfig', 'setPrompt', 'generateImage'],
  'nodes/videoNode.vue': ['setVideo'],
  'nodes/videoGenerationNode.vue': ['getConfig', 'setConfig', 'setPrompt', 'generateVideo'],
  'nodes/audioNode.vue': ['setAudio'],
}
for (const [file, required] of Object.entries(requiredNodeTools)) {
  const available = registrations.get(file) ?? new Set<string>()
  for (const name of required) if (!available.has(name)) fail(`missing node tool: ${file} → node:${name}`)
}

const totalRegistrations = [...registrations.values()].reduce((total, set) => total + set.size, 0)
if (totalRegistrations < 58) fail(`node tool registrations unexpectedly dropped to ${totalRegistrations}`)
console.log(`MCP verification passed: ${CANVAS_TOOLS.length} canvas tools, ${MCP_TOOLS.length} top-level tools, ${totalRegistrations} node tool registrations`)
