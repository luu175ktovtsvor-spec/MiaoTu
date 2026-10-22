// MiaoImg 工具脚手架的运行时契约（`@miaoimg/tools-scaffold/runtime` 与
// `@miaoimg/tool-canvas/runtime` 两个包的本地等价物，vite 别名都指到这里）。
// 画布、节点和外部插件共用此契约；保留已发布接口的兼容性。
import { z } from 'zod'

export interface NodeToolInfo {
  nodeId: string
  name: `node:${string}`
  nodeLabel?: string
  description: string
  parameters: Record<string, unknown>
}

export interface NodeToolCall {
  nodeId: string
  name: `node:${string}`
  args: Record<string, unknown>
}

export interface NodeToolsContext {
  readonly tools: NodeToolInfo[]
  readonly version: number
  list(nodeIds: string[], names?: string[]): IterableIterator<NodeToolInfo>
  call(request: NodeToolCall, signal?: AbortSignal): Promise<unknown>
}

export interface CanvasToolCall {
  name: string
  args: Record<string, unknown>
}

export interface CanvasInfo {
  id: string
  tools: NodeToolInfo[]
}

export interface CanvasContext extends CanvasInfo {
  getNodeLabel?(nodeId: string): string | undefined
  fork?(): CanvasContext
  call(request: CanvasToolCall, signal?: AbortSignal): Promise<unknown>
}

export interface MediaModel {
  providerId: string
  providerLabel: string
  modelId: string
  label: string
  type: "image" | "video" | "audio"
  mode?: unknown
  imageSizes?: string[]
  imageRatios?: string[]
  durationResolutionMap?: { duration: number[]; resolution: string[] }[]
  audio?: boolean | "optional"
  voices?: { title: string; voice: string }[]
}

export interface QuestionField {
  field: string
  title: string
  type: "input" | "textarea" | "radio" | "checkbox" | "select" | "inputNumber" | "switch"
  required?: boolean
  options?: string[]
  placeholder?: string
}

export interface QuestionRequest {
  title: string
  question: string
  options?: string[]
  fields?: QuestionField[]
}

export interface QuestionAnswer {
  answer: string
  values?: Record<string, string | number | boolean | string[]>
  skipped?: boolean
}

export type ToolCall = {
  id: string
  name: string
  args?: Record<string, unknown>
  status: "running" | "success" | "error" | "interrupted"
  result?: string
  question?: QuestionRequest & { callId: string }
}

export { canvasSchemas, canvasOperations } from '../../../../../server/canvas-tools.ts';
import { canvasSchemas } from '../../../../../server/canvas-tools.ts';
export type CanvasOperationName = keyof typeof canvasSchemas;
export type CanvasRequest = {
  [Name in CanvasOperationName]: { name: Name; args: z.output<(typeof canvasSchemas)[Name]> };
}[CanvasOperationName];
