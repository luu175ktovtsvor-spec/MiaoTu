// These routes recover the account/project selection itself. Requiring the
// previous project first can trap a new account behind an inaccessible project
// or prevent selection after the active project has been removed.
const projectIndependent = new Set([
  '/api/desktop/status', '/api/desktop/login', '/api/desktop/register', '/api/desktop/logout', '/api/desktop/doubao', '/api/desktop/dola',
  '/api/imagine/session', '/api/imagine/logout', '/api/imagine/config',
  '/api/imagine/email/config', '/api/imagine/email/request-code', '/api/imagine/email/verify-code', '/api/imagine/password/reset',
  '/api/imagine/workspace/projects', '/api/imagine/workspace/projects/open',
  '/api/imagine/workspace/projects/rename', '/api/imagine/workspace/projects/remove',
  '/health',
  '/api/desktop/local-text/models',
])

// 账号层面的数据（积分流水、反馈、充值订单、改密码、报错说明）只在云端，与当前打开哪个项目无关；
// 当前项目刚被删除时，这些页面也必须照常打开。
const accountRoutes = ['/api/imagine/ledger', '/api/imagine/feedback', '/api/imagine/payment/orders', '/api/imagine/password', '/api/imagine/error-explanation']

export function requiresDesktopProject(pathname: string) {
  if (projectIndependent.has(pathname)) return false
  return !accountRoutes.some(route => pathname === route || pathname.startsWith(route + '/'))
}
