import { HttpIncomingRequests } from './http-request-lifetime.ts'

// Keep MCP admission/response behavior while sharing real handler ownership.
export class McpIncomingRequests extends HttpIncomingRequests {
  constructor() { super('MCP 服务正在关闭，请稍后重试') }
}
