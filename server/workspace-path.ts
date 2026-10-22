// 工作区路径在原生文件层与页面控制状态中使用同一条规则。
export const isInternalAssetPath = (path: string) => /^assets(?:\/|$)/i.test(path)
export const isMarkdownFile = (path: string, mime = '') => /\.(md|markdown)$/i.test(path) || /^text\/markdown(?:;|$)/i.test(mime)

// Provider credentials belong to the host. Agent-facing file and media tools
// share the same path rule while normal settings code can still read them.
const protectedPaths = new Set(['settings/providers.json'])
export const isProtectedWorkspacePath = (path: unknown) => protectedPaths.has(String(path || '').toLowerCase())
export function isProtectedWorkspaceTree(path: unknown) {
  const value = String(path || '').toLowerCase()
  return !!value && [...protectedPaths].some(protectedPath => protectedPath === value
    || protectedPath.startsWith(value + '/') || value.startsWith(protectedPath + '/'))
}

export function isWorkspacePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 500
    && !/[\\\0]/.test(value) && !value.startsWith('/')
    && !value.split('/').some(part => !part || part === '.' || part === '..')
    // 首段保留给 _artifacts / _blobs / .agent-sessions 等内部目录。
    && !/^[_.]/.test(value)
}

export type WorkspaceReferenceScope = {
  owner: string; project: string; defaultProject: string; origin?: string
  // Desktop GETs address the local project's files across login changes. Only
  // that host may ignore a stale owner query, and it must supply its real origin.
  ownerMode?: 'account' | 'local'
}

export function workspaceFileReference(value: unknown, scope?: WorkspaceReferenceScope): { path: string; sameScope: boolean } | undefined {
  if (typeof value !== 'string' || !value.trim()) return
  if (isWorkspacePath(value) && !/^[a-z][a-z\d+.-]*:/i.test(value)) return { path: value, sameScope: true }
  try {
    const url = new URL(value, scope?.origin || 'http://workspace.invalid')
    if (url.pathname !== '/api/imagine/workspace/files') return
    const path = url.searchParams.get('path')
    if (!isWorkspacePath(path)) return
    return { path, sameScope: !scope || (scope.origin ? url.origin === scope.origin : scope.ownerMode !== 'local')
      && (scope.ownerMode === 'local' || !url.searchParams.has('owner') || url.searchParams.get('owner') === scope.owner)
      && (url.searchParams.get('project') || scope.defaultProject) === scope.project }
  } catch { return }
}
