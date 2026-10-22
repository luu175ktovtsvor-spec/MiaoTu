import axios from 'axios'
import { shellT } from '../shellText'
import { desktopDocumentEpoch } from './desktopDocument'

// 这里只保存当前账号、CSRF 和项目范围。桌面画布、文档和媒体由
// LocalStore/DesktopWorkspaceFiles 在本机读写；服务端负责账号、模型与任务记录。
//
// 工作区命名空间（directory）：`miaoimg:<账号>` 或 `miaoimg:<账号>:<项目>`。
// **默认项目不加后缀**——老用户本地的缓存键（记住的画布、文档面板布局）原样保留，
// 单项目用起来和以前一模一样；只有切到别的项目才会多一段，两个项目的本地缓存天然分开。
export const DEFAULT_PROJECT = 'default'
let session = { owner: '', csrf: '' }
let activeProject = DEFAULT_PROJECT
const scopeListeners = new Set<() => void>()

// Cross-framework caches must retire synchronously with the authoritative scope,
// before the old view has finished unmounting or a new request can be admitted.
export function subscribeWorkspaceScope(listener: () => void) {
  scopeListeners.add(listener)
  return () => { scopeListeners.delete(listener) }
}
function notifyWorkspaceScope() {
  for (const listener of scopeListeners) {
    try { listener() } catch { console.warn('[workspace] 工作区缓存清理失败') }
  }
}

// 账号本身可能带冒号（`user:<id>` 这种兼容键），所以不能靠 split 猜：
// 只有「前缀正好是当前账号 + 冒号」才把后面那段当项目。
function stripNamespace(value = '') {
  return String(value).replace(/^miaoimg:/, '')
}

export function workspaceOwner(value = '') {
  const rest = stripNamespace(value)
  const owner = session.owner
  return owner && rest.startsWith(`${owner}:`) ? owner : rest
}

// 请求里用的当前项目**只看这一个来源**：外壳在 hydrate 和切换时设置的当前项目。
// 不从 directory 字符串里反解——账号本身可能是 `user:<id>`，和「账号:项目」的形式没法可靠区分，
// 反解失败会静默退回默认项目（把项目 B 的文件写进默认项目），代价太大。
export function workspaceProject() { return activeProject }

export function workspaceDirectory(owner = '', project = DEFAULT_PROJECT) {
  const key = stripNamespace(owner)
  const id = String(project || DEFAULT_PROJECT)
  return id === DEFAULT_PROJECT ? `miaoimg:${key}` : `miaoimg:${key}:${id}`
}

// 只刷新会话时**不要动当前项目**：project 不传就保持原值。
// 之前默认值是 DEFAULT_PROJECT，于是「重新拉一次 config」「登出」这类调用会把正在用的项目
// 悄悄打回默认项目（表现是切换后写入落回默认项目，而且只有一部分请求中招，极难查）。
// 想明确表达「用默认项目」的调用点请显式传 DEFAULT_PROJECT。
export function setWorkspaceSession(owner = '', csrf = '', project?: string) {
  const previousOwner = session.owner, previousProject = activeProject
  session = { owner: workspaceOwner(owner), csrf }
  if (project !== undefined) setActiveProject(project)
  // setActiveProject already publishes the combined owner/project change.
  if (previousOwner !== session.owner && previousProject === activeProject) notifyWorkspaceScope()
}

export function workspaceHeaders(owner: string) {
  if (workspaceOwner(owner) !== session.owner) throw new Error(shellT('工作区账号已切换，请刷新页面'))
  return { 'content-type': 'application/json', 'x-workspace-owner': session.owner, 'x-csrf-token': session.csrf }
}

export function captureWorkspaceScope() { return { owner: session.owner, project: activeProject } }
export function assertWorkspaceScope(scope: { owner: string; project: string }) {
  if (session.owner !== scope.owner || activeProject !== scope.project) throw Object.assign(new Error(shellT('工作区已切换，原任务保留在原项目，请返回原项目查看')), { status: 409, scopeChanged: true })
}

// ---- 当前项目 ----
//
// 工作区文件接口走显式的 project 参数（见 lib/workspaceFiles.ts）。
// 节点插件 / Agent / MCP 这些子系统没法逐个加参数，所以这里统一给本站的 /api/ 请求
// 注入 x-workspace-project 头，服务端用请求级上下文接住（server/workspace-scope.ts）。
export function activeWorkspaceProject() { return activeProject }

export function setActiveProject(project = DEFAULT_PROJECT) {
  const next = String(project || DEFAULT_PROJECT) || DEFAULT_PROJECT
  const previous = activeProject
  activeProject = next
  if (previous !== next) notifyWorkspaceScope()
  // 开发期断言：画布都挂载了还有人改当前项目，就带着调用栈喊一声。
  // 「谁把项目改回去了」这类问题盲查过一整轮，留这一行下次直接点名。
  if (import.meta.env?.DEV && previous !== next && typeof document !== 'undefined' && document.querySelector('.studio-miaoimg-mount')) {
    console.warn(`[workspace] 当前项目 ${previous} -> ${next}（画布已挂载）`, new Error('setActiveProject 调用栈').stack)
  }
  installProjectHeader()
}

let headerInstalled = false
function installProjectHeader() {
  if (headerInstalled || typeof window === 'undefined') return
  headerInstalled = true
  const projectHeaderTarget = (url: string) => {
    try {
      const target = new URL(url, window.location.origin)
      // An explicit project query belongs to that project (for example a
      // project-card preview). Do not mix in the currently open project.
      return target.origin === window.location.origin && target.pathname.startsWith('/api/') && !target.searchParams.has('project')
    } catch {
      return false
    }
  }
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!projectHeaderTarget(url)) return originalFetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('x-workspace-project', activeProject)
    if (document.documentElement.lang) headers.set('accept-language', document.documentElement.lang)
    const epoch = await desktopDocumentEpoch()
    if (epoch) headers.set('x-miaoimg-document', epoch)
    // Request 对象自带 headers，必须重建一个才能改；其余情况透传 init 就好。
    return input instanceof Request
      ? originalFetch(new Request(input, { ...init, headers }))
      : originalFetch(input, { ...init, headers })
  }
  axios.interceptors.request.use(async (config) => {
    if (projectHeaderTarget(String(config.url || ''))) {
      config.headers.set('x-workspace-project', activeProject)
      if (document.documentElement.lang) config.headers.set('accept-language', document.documentElement.lang)
      const epoch = await desktopDocumentEpoch()
      if (epoch) config.headers.set('x-miaoimg-document', epoch)
    }
    return config
  })
}

// 老包和单项目部署只认 `miaoimg:<账号>`，解析出来的项目就是默认项目——行为与改动前一致。
if (typeof window !== 'undefined') installProjectHeader()
