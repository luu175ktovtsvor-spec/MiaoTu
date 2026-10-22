import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

// A renderer preview has no native session, local task store or desktop tools.
// Fail explicitly instead of proxying requests into the old cloud workbench.
function rendererApi(request: IncomingMessage, response: ServerResponse, next: () => void) {
  let path: string
  try { path = new URL(request.url || '/', 'http://localhost').pathname }
  catch { response.writeHead(400).end(); return }
  if (!/^\/(?:api(?:\/|$)|mcp(?:\/|$)|health$)/.test(path)) { next(); return }
  response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ ok: false, error: '桌面界面预览不提供本机服务，请从仓库根目录运行 npm run dev 启动完整桌面。' }))
}

export function rendererOnlyPlugin(): Plugin {
  return {
    name: 'miaoimg-renderer-only',
    configureServer(server) { server.middlewares.use(rendererApi) },
    configurePreviewServer(server) { server.middlewares.use(rendererApi) },
  }
}
