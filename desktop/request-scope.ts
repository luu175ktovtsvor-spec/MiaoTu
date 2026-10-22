// These routes recover the account/project selection itself. Requiring the
// previous project first can trap a new account behind an inaccessible project
// or prevent selection after the active project has been removed.
const projectIndependent = new Set([
  '/api/desktop/status', '/api/desktop/login', '/api/desktop/register', '/api/desktop/logout', '/api/desktop/doubao', '/api/desktop/dola',
  '/api/imagine/session', '/api/imagine/logout', '/api/imagine/config',
  '/api/imagine/email/config', '/api/imagine/email/request-code', '/api/imagine/email/verify-code',
  '/api/imagine/workspace/projects', '/api/imagine/workspace/projects/open',
  '/api/imagine/workspace/projects/rename', '/api/imagine/workspace/projects/remove',
  '/health',
  '/api/desktop/local-text/models',
])

export function requiresDesktopProject(pathname: string) {
  return !projectIndependent.has(pathname)
}
