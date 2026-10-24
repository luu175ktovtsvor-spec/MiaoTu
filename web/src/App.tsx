import { lazy, Suspense } from 'react'
import LandingFallback from './landing/LandingFallback'
import { isAdminHost } from './siteOrigins'
const AdminPage = lazy(() => import('./admin/AdminPage'))
const ChangelogPage = lazy(() => import('./landing/ChangelogPage'))
const LandingPage = lazy(() => import('./landing/LandingPage'))

// 网页只剩官网、更新日志和管理后台。原来的网页版灵感库与画布已下线，代码备份在仓库外的「网页端老旧代码」。
function App() {
  if (isAdminHost() || window.location.pathname.startsWith('/manage')) return <Suspense fallback={null}><AdminPage /></Suspense>
  if (/^\/changelog\/?$/.test(window.location.pathname)) return <Suspense fallback={<LandingFallback />}><ChangelogPage /></Suspense>
  return <Suspense fallback={<LandingFallback />}><LandingPage /></Suspense>
}

export default App
