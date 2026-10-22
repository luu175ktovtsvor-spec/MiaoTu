import { AsyncLocalStorage } from 'node:async_hooks'
import { DEFAULT_PROJECT_ID } from './projects.ts'

// 请求级的工作区项目上下文。
//
// 为什么用 AsyncLocalStorage 而不是加参数：工作区文件的调用点散在 agent-api / mcp-api /
// node-plugins / ext-plugins / ffmpeg-exec / plugin-install 等七八个模块里（五六十处），
// 每个都加一个 project 参数既容易漏、又会和正在并行改这些文件的其它改动打架。
// HTTP 入口把当前项目挂到请求的异步上下文上，整条调用链（包括我们不打算动的子系统）
// 在 workspace-files.ts 里取到的就是同一个项目。
//
// 在此上下文内创建的异步工作会继续继承项目，包括响应结束后的延续；
// 从上下文外启动的后台任务必须显式绑定其所属项目。
const storage = new AsyncLocalStorage<{ project: string | null; projectError?: unknown; [key: string]: unknown }>()

export function workspaceProjectOf(request) {
  if (!request) return null
  const header = String(request.headers?.['x-workspace-project'] || '').trim()
  let query = ''
  try {
    const url = new URL(request.url || '/', `http://${request.headers?.host || 'localhost'}`)
    query = String(url.searchParams.get('project') || '').trim()
  } catch { /* The HTTP handler owns malformed request URL errors. */ }
  if (header && query && header !== query) throw Object.assign(new Error('请求的工作区项目不一致，请重新读取'), { status: 409 })
  return header || query || null
}

// 包住整个请求处理函数：进入处理器之前把项目挂上，之后整条异步链都能取到。
export function withRequestProject(listener) {
  return (request, response) => {
    let scope: { project: string | null; projectError?: unknown }
    try { scope = { project: workspaceProjectOf(request) } }
    catch (projectError) { scope = { project: null, projectError } }
    // Parsing must not throw outside an HTTP listener's own error/finally path.
    // Its first currentProject() read reports a conflict through that handler.
    return storage.run(scope, () => listener(request, response))
  }
}

// 当前请求的项目；没有（后台任务、脚本、老客户端不带参数）就交给调用方兜底。
export function currentProject() {
  const scope = storage.getStore()
  if (scope?.projectError) throw scope.projectError
  return scope?.project || ''
}

// Durable tools run outside an HTTP request. The host supplies the captured,
// authenticated project explicitly instead of falling back to default data.
export function withWorkspaceProject<T>(project: string, operation: () => T): T {
  return storage.run({ project: String(project || '') }, operation)
}

export { DEFAULT_PROJECT_ID }
