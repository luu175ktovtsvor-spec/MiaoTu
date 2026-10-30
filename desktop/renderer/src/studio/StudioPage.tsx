import FeedbackNotice from '../components/FeedbackNotice'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { imageSources } from '../media'
import { clearLibraryHandoff, readLibraryHandoff, LIBRARY_TEXT_LIMIT } from '../libraryHandoff'
import { DEFAULT_PROJECT, setActiveProject, setWorkspaceSession, subscribeWorkspaceScope, workspaceDirectory } from '../lib/workspaceRemote'
import useWorkspaceFiles from '../lib/workspaceFiles'
import { dictText, useLang } from '../i18n'
// 进度计算全仓只有一份：与框架无关的核心，画布 composable 和历史面板共用（见 generationProgressCore.ts）
import { createProgressTracker } from './generationProgressCore'
import LanguageControl from '../LanguageControl'
import StudioHome from './StudioHome'
import AccountPage from './AccountPage'
import CreditPage from './CreditPage'
import GenerationHistoryPage from './GenerationHistoryPage'
import FeedbackPage from './FeedbackPage'
import PersonalAssetLibrary from './PersonalAssetLibrary'
import { reloadWorkspace } from '../desktop/navigation'
import DesktopRail from '../desktop/DesktopRail'
import { studioPoint, studioText } from './studioText'
import './studio.css'
import './account.css'
import { ACTIVE_STATUSES, historyProgress, currentMonthRange } from './history'
import { emptyHistory, emptyLedger, type BoundCanvasInsert, type HistoryItem, type HistoryState, type LedgerState, type StudioConfig, type StudioSession, type HistoryProgress, type LibrarySelection } from './studioState'
import type { PendingCanvasInsert } from '../stores/workspace'
import { importLibraryReference } from './libraryReference'

// Resolve the session before loading the canvas runtime. The existing app
// Suspense boundary also handles the first canvas mount.
const MiaoCanvasMount = lazy(() => import('./MiaoCanvasMount'))
const MiaoSettingsMount = lazy(() => import('./MiaoSettingsMount'))

// 桌面外壳负责账号与导航；画布、项目和结果由本机工作区保存。

const PLAY_PROMPTS = {
  wardrobe: '保持人物脸部身份和体态，把人物照片里的穿搭换成连接的服装参考。真实商业摄影，服装结构清楚，手部自然，无文字。',
  scene: '以连接的图片为起点做下一版：保留人物、构图和光线，只调整背景环境，让画面真实自然，无文字。',
  space: '从连接的图片生成一段视频：镜头缓慢推进，光线自然变化，动作轻微，画面稳定，无文字。',
}
const SESSION_CHANGE_KEY = 'miaoimg.session-change'

// 上次打开的项目，按账号存：换账号换键，两个账号不会互相影响。
function projectStorageKey(owner) { return `miaoimg.project.${owner}` }
function readRememberedProject(owner) {
  if (!owner) return DEFAULT_PROJECT
  try { return localStorage.getItem(projectStorageKey(owner)) || DEFAULT_PROJECT } catch { return DEFAULT_PROJECT }
}
function rememberProject(owner, project) {
  if (!owner) return
  try { localStorage.setItem(projectStorageKey(owner), project) } catch { /* 隐私模式下忽略存储失败 */ }
}

function workspaceOwnerKey(session) {
  if (session?.user?.workspaceKey) return session.user.workspaceKey
  // Keep old sessions and pre-upgrade responses readable while the server
  // rolls out the public workspace key.
  if (session?.user?.id) return `user:${session.user.id}`
  if (session?.role === 'admin') return 'admin'
  return ''
}

export default function StudioPage() {
  const { lang, locale } = useLang()
  const pageLifetimeRef = useRef(new AbortController())
  useEffect(() => {
    if (pageLifetimeRef.current.signal.aborted) pageLifetimeRef.current = new AbortController()
    const lifetime = pageLifetimeRef.current
    return () => lifetime.abort()
  }, [])
  const [config, setConfig] = useState<StudioConfig | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 4000)
    return () => window.clearTimeout(timer)
  }, [notice])
  const [workspaceReady, setWorkspaceReady] = useState(false)
  const [workspaceOwner, setWorkspaceOwner] = useState('')
  const workspaceOwnerRef = useRef('')
  // 当前项目：按账号存在浏览器里，下次进来回到上次那个项目；换账号自然换键，不会串。
  const [project, setProject] = useState(DEFAULT_PROJECT)
  const projectRef = useRef(DEFAULT_PROJECT)
  const [pendingLibraryHandoff, setPendingLibraryHandoff] = useState<LibrarySelection | null>(null)
  const pendingHandoffRef = useRef(pendingLibraryHandoff)
  pendingHandoffRef.current = pendingLibraryHandoff
  const [pendingInserts, setPendingInserts] = useState<BoundCanvasInsert[]>([])
  const pendingInsert = pendingInserts.find(value => value.owner === workspaceOwner && value.project === project)?.insert ?? null
  const setPendingInsert = useCallback((insert: PendingCanvasInsert | null, target?: { owner: string; project: string }) => {
    if (!insert) { setPendingInserts(current => current.length ? [] : current); return }
    const { owner, project } = target ?? { owner: workspaceOwnerRef.current, project: projectRef.current }
    setPendingInserts(current => current.some(value => value.owner === owner && value.project === project && value.insert.id === insert.id)
      ? current : [...current, { owner, project, insert }])
  }, [])
  const [libraryHandoffError, setLibraryHandoffError] = useState('')
  const handoffAttemptRef = useRef('')
  const playAttemptRef = useRef('')
  const libraryControllerRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const cancel = () => { libraryControllerRef.current?.abort() }
    const unsubscribe = subscribeWorkspaceScope(cancel)
    return () => { unsubscribe(); cancel() }
  }, [])
  const [surface, setSurfaceState] = useState('home')
  const surfaceRequestRef = useRef(0)
  const setSurface = useCallback((value: string) => { surfaceRequestRef.current++; setSurfaceState(value) }, [])
  useEffect(() => {
    const openHome = () => { void window.miaoDesktop?.flushSave?.().finally(() => setSurface('home')) }
    const openCanvas = () => { void Promise.resolve(window.miaoDesktop?.flushSave?.()).finally(() => setSurface('look')) }
    window.addEventListener('miao-open-home', openHome)
    window.addEventListener('miao-open-canvas', openCanvas)
    return () => { window.removeEventListener('miao-open-home', openHome); window.removeEventListener('miao-open-canvas', openCanvas) }
  }, [setSurface])
  const [historyData, setHistoryState] = useState<HistoryState>(emptyHistory)
  const [historyPage, setHistoryPage] = useState(1)
  const [historyModel, setHistoryModel] = useState('')
  const [historyKind, setHistoryKind] = useState('all')       // all | image | video
  // 桌面读取本机任务快照；网站沿用画布的查询接口。共用同一份进度计算。
  const [rowProgress, setRowProgress] = useState<Record<string, HistoryProgress>>({})
  // 每条生成一个 tracker（核心自己记真值峰值，消费者不写 Math.max）
  const trackersRef = useRef(new Map<string, ReturnType<typeof createProgressTracker>>())
  const [clock, setClock] = useState(() => Date.now())
  const [historyRefresh, setHistoryRefresh] = useState(0)
  const [ledgerData, setLedgerState] = useState<LedgerState>(emptyLedger)
  const [ledgerRefresh, setLedgerRefresh] = useState(0)
  const sessionRefreshRef = useRef<AbortController | null>(null)
  const authEpochRef = useRef(0)
  const logoutPendingRef = useRef(false)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [userSession, setUserSession] = useState<StudioSession | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [homeSection, setHomeSection] = useState<'home' | 'projects' | 'cases'>('home')
  const [homeSectionRequest, setHomeSectionRequest] = useState(0)
  const historyOwner = workspaceOwnerKey(userSession)
  const signedIn = Boolean(userSession?.user?.email)
  const historyState: HistoryState = historyData.owner === historyOwner && historyData.project === project ? historyData : { ...emptyHistory(), status: 'loading', page: historyPage }
  const ledgerState: LedgerState = ledgerData.owner === historyOwner ? ledgerData : { ...emptyLedger(), status: 'loading' }
  const historyCacheRef = useRef(new Map<string, HistoryState>())

  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' })
  const [passwordBusy, setPasswordBusy] = useState(false)
  const passwordPendingRef = useRef(false)
  const [profileName, setProfileName] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const profilePendingRef = useRef(false)
  useEffect(() => { setProfileName(userSession?.user?.name || '') }, [historyOwner, userSession?.user?.name])
  // 用验证码或第三方登录建的账号没有密码，那种情况下不摆「原密码」，直接设一个。
  const hasPassword = userSession?.user?.hasPassword !== false

  const acknowledgePendingInsert = useCallback((id: string, kind: PendingCanvasInsert['kind'], owner: string, targetProject: string) => {
    setPendingInserts(current => {
      const next = current.filter(value => value.owner !== owner || value.project !== targetProject || value.insert.id !== id)
      return next.length === current.length ? current : next
    })
    const handoff = pendingHandoffRef.current
    if (!handoff || id !== `${handoff.handoffId}-${kind}`) return
    const visible = workspaceOwnerRef.current === owner && projectRef.current === targetProject
    try { clearLibraryHandoff(handoff.handoffId) }
    catch { if (visible) setLibraryHandoffError(studioText('选择已带入，但交接记录未清理', lang)) }
    setPendingLibraryHandoff(current => current?.handoffId === handoff.handoffId ? null : current)
    if (visible) setNotice(studioText(kind === 'text' ? '已带入提示词' : '已带入参考图', lang))
  }, [lang])

  const hydrateWorkspace = useCallback(async (_data: StudioConfig | null, session: StudioSession | null, initial = false) => {
    const owner = workspaceOwnerKey(session)
    // 只有首次 hydrate 才去读「上次的项目」；之后的 hydrate（刷新会话、登出等）沿用当前正在用的那个，
    // 免得拿到不认识的 owner 时把用户正在看的项目改掉（登出那条路径传的就是 null session）。
    const nextProject = initial ? readRememberedProject(owner) : (projectRef.current || DEFAULT_PROJECT)
    setWorkspaceSession(owner, session?.csrf || '', nextProject)
    workspaceOwnerRef.current = owner
    projectRef.current = nextProject
    setProject(nextProject)
    setWorkspaceOwner(owner)
    if (initial) setPendingLibraryHandoff(readLibraryHandoff())
    setLibraryHandoffError('')
    handoffAttemptRef.current = ''
    setWorkspaceReady(true)
    // 记住的项目可能已经被删（例如在别的账号或登出时删掉）。不存在就回到默认项目，
    // 否则之后每个请求都带着一个不存在的项目，页面会一直报「项目不存在」。
    if (initial && nextProject !== DEFAULT_PROJECT) {
      void fetch('/api/imagine/workspace/projects', { cache: 'no-store' })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (!Array.isArray(data?.projects) || data.projects.some((item: { id?: string }) => item.id === nextProject)) return
          if (workspaceOwnerRef.current !== owner || projectRef.current !== nextProject) return
          rememberProject(owner, DEFAULT_PROJECT)
          projectRef.current = DEFAULT_PROJECT
          setActiveProject(DEFAULT_PROJECT)
          setProject(DEFAULT_PROJECT)
        })
        .catch(() => {})
    }
  }, [])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    window.dispatchEvent(new CustomEvent('miao-settings-visible', { detail: { open: true } }))
  }, [])

  useEffect(() => {
    const open = () => openSettings()
    window.addEventListener('miao-desktop-settings', open)
    return () => window.removeEventListener('miao-desktop-settings', open)
  }, [openSettings])

  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    window.dispatchEvent(new CustomEvent('miao-settings-visible', { detail: { open: false } }))
  }, [])

  useEffect(() => {
    if (!settingsOpen) return undefined
    document.body.setAttribute('data-miaoimg-settings-ui', '1')
    // Esc 先交给设置里打开的下拉和弹层，没有浮层时才退出设置页。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.el-popper[aria-hidden="false"], .el-overlay:not([style*="display: none"])')) return
      closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.removeAttribute('data-miaoimg-settings-ui')
    }
  }, [closeSettings, settingsOpen])

  const clearUserSession = useCallback(() => {
    authEpochRef.current += 1
    sessionRefreshRef.current?.abort()
    setWorkspaceSession('', '', DEFAULT_PROJECT)
    workspaceOwnerRef.current = ''
    projectRef.current = DEFAULT_PROJECT
    setUserSession(null)
    setConfig(current => current ? { ...current, session: null } : current)
    setWorkspaceOwner('')
    setProject(DEFAULT_PROJECT)
    setSurface('look')
    setPendingInsert(null)
    setPendingLibraryHandoff(null)
    setLibraryHandoffError('')
    handoffAttemptRef.current = ''
    playAttemptRef.current = ''
    setPasswordForm({ currentPassword: '', newPassword: '' })
    historyCacheRef.current.clear()
    trackersRef.current.clear()
    setRowProgress({})
    setHistoryState(emptyHistory())
    setLedgerState(emptyLedger())
    setError('')
    setNotice('')
  }, [])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const authEpoch = authEpochRef.current
    fetch('./api/imagine/config', { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(studioText('模型加载失败，请刷新重试', lang))))
      .then(async (data) => {
        if (cancelled || authEpochRef.current !== authEpoch) return
        setConfig(data)
        setUserSession(data.session || null)
        await hydrateWorkspace(data, data.session || null, Boolean(data.session))
      })
      .catch((loadError) => { if (!cancelled && authEpochRef.current === authEpoch) setError(loadError.message) })
    return () => { cancelled = true; controller.abort() }
  }, [hydrateWorkspace, lang])

  // 切换项目：记住选择 + 通知全局请求头，画布由 MiaoCanvasMount 用新的命名空间重新挂载，
  // 画布列表、文档面板、素材库都会按新项目重新 hydrate。
  const switchProject = useCallback((id: string) => {
    const next = String(id || DEFAULT_PROJECT) || DEFAULT_PROJECT
    rememberProject(workspaceOwnerRef.current, next)
    projectRef.current = next
    setActiveProject(next)
    setProject(next)
    setHistoryPage(1)
  }, [])
  const openProject = useCallback((id: string) => {
    switchProject(id)
    setSurface('look')
    const headers = { 'content-type': 'application/json', ...(userSession?.csrf ? { 'x-csrf-token': userSession.csrf } : {}) }
    void fetch('/api/imagine/workspace/projects/open', { method: 'POST', headers, body: JSON.stringify({ id }) }).catch(() => {})
  }, [switchProject, userSession?.csrf])

  async function queueLibraryReference(item: LibrarySelection): Promise<
    { ok: true; id: string } | { ok: false; cancelled: true } | { ok: false; cancelled: false; message: string }> {
    libraryControllerRef.current?.abort()
    const controller = new AbortController()
    libraryControllerRef.current = controller
    const owner = workspaceOwnerRef.current, targetProject = projectRef.current, authEpoch = authEpochRef.current
    const surfaceRequest = surfaceRequestRef.current
    const sameIdentity = () => workspaceOwnerRef.current === owner && authEpochRef.current === authEpoch
    const assertCurrent = () => {
      controller.signal.throwIfAborted()
      if (!sameIdentity() || projectRef.current !== targetProject) throw new DOMException('工作区已切换', 'AbortError')
    }
    try {
      const files = useWorkspaceFiles(workspaceDirectory(owner, targetProject))
      const sources = imageSources(item.images?.[0]).filter(Boolean)
      const local = sources.find((source) => !/^https?:/.test(source))
      const remote = sources.find((source) => /^https?:/.test(source))
      const address = local || (remote ? `/api/imagine/image?url=${encodeURIComponent(remote)}` : '')
      if (!address) throw new Error(studioText('没有可用的图像地址', lang))
      const proxied = remote ? `/api/imagine/image?url=${encodeURIComponent(remote)}` : ''
      const { path, mimeType } = await importLibraryReference([address, proxied, remote].filter(Boolean), files, controller.signal, assertCurrent)
      assertCurrent()
      setPendingInsert({
        id: `${item.handoffId || path}-image`,
        kind: 'image',
        path,
        mimeType,
        // 只写我们自己的说法：作者信息不外露（灵感库界面上已经清掉了，这条交接路径也不能带）。
        label: studioText('案例参考图', lang),
      }, { owner, project: targetProject })
      if (surfaceRequestRef.current === surfaceRequest) setSurface('look')
      return { ok: true, id: path }
    } catch (loadError) {
      const cancelled = controller.signal.aborted || !sameIdentity() || projectRef.current !== targetProject
      if (cancelled) {
        if (libraryControllerRef.current === controller && sameIdentity() && projectRef.current !== targetProject) {
          setLibraryHandoffError(studioText('工作区已切换，请重新从案例选择参考图', lang))
        }
        return { ok: false, cancelled: true }
      }
      return { ok: false, cancelled: false, message: studioText(loadError.message || '参考图无法读取，请重试', lang) }
    } finally { if (libraryControllerRef.current === controller) libraryControllerRef.current = null }
  }

  const applyLibraryHandoff = useCallback(async () => {
    const handoff = pendingLibraryHandoff
    if (!workspaceReady || !handoff || handoffAttemptRef.current === handoff.handoffId) return
    handoffAttemptRef.current = handoff.handoffId
    setLibraryHandoffError('')

    if (handoff.type === 'prompt') {
      const nextPrompt = String(handoff.text || '').slice(0, LIBRARY_TEXT_LIMIT)
      setSurface('look')
      setPendingInsert({ id: `${handoff.handoffId}-text`, kind: 'text', text: nextPrompt, label: studioText('案例提示词', lang) })
      return
    }

    const result = await queueLibraryReference(handoff)
    if (result.ok === false) {
      if (result.cancelled === true) return
      handoffAttemptRef.current = ''
      setLibraryHandoffError(result.message)
      return
    }
  }, [lang, pendingLibraryHandoff, workspaceReady])

  useEffect(() => {
    void applyLibraryHandoff()
  }, [applyLibraryHandoff])

  // 落地页的“起点”链接：打开画布后直接把起步提示词放成一个文本节点。
  useEffect(() => {
    if (!workspaceReady || !userSession) return
    const play = new URLSearchParams(window.location.search).get('play')
    const starter = play ? PLAY_PROMPTS[play] : ''
    if (!starter || playAttemptRef.current === play) return
    playAttemptRef.current = play
    setPendingInsert({ id: `play-${play}-${Date.now()}`, kind: 'text', text: starter, label: studioText('画布起点', lang) })
    setSurface('look')
    setNotice(studioText('已放入画布起点，接着加参考图就行', lang))
    const url = new URL(window.location.href)
    url.searchParams.delete('play')
    window.history.replaceState({}, '', url.toString())
  }, [lang, userSession, workspaceReady])

  useEffect(() => {
    const page = !userSession ? studioText('登录', lang) : surface === 'history' ? studioText('生成历史', lang) : surface === 'assets' ? studioText('资产', lang) : surface === 'billing' ? studioText('积分', lang) : surface === 'account' ? studioText('账号', lang) : ''
    // 品牌按语言取（中文「妙图」／英文 MiaoImg），后面挂当前面板名。
    const brand = dictText(lang, 'app.title')
    document.title = page ? `${brand} · ${page}` : brand
  }, [lang, surface, historyOwner])

  useEffect(() => {
    if (surface !== 'history' || !signedIn || !historyOwner) return undefined
    const controller = new AbortController()
    const params = new URLSearchParams({ limit: '20', page: String(historyPage), view: 'list' })
    if (historyModel) params.set('model', historyModel)
    if (historyKind !== 'all') params.set('kind', historyKind)
    const month = currentMonthRange()
    params.set('summaryFrom', month.from)
    params.set('summaryTo', month.to)
    const cacheKey = `${historyOwner}:${project}:${params}`
    const cached = historyCacheRef.current.get(cacheKey)
    setHistoryState(current => {
      const visible = cached || (current.owner === historyOwner && current.cacheKey === cacheKey ? current : null)
      return { ...(visible || { ...emptyHistory(), page: historyPage }), owner: historyOwner, project, cacheKey,
        status: visible ? 'ready' : 'loading', refreshing: Boolean(visible), error: '' }
    })
    let timer
    let refreshDesktop = true
    // Desktop tasks advance in the local runtime. Read snapshots without
    // waiting for each task's download or issuing another cloud poll.
    const loadHistory = () => fetch(`./api/imagine/history?${params}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || studioText('历史记录读取失败', lang))
        if (controller.signal.aborted) return
        const next: HistoryState = { status: 'ready', refreshing: false, owner: historyOwner, project, cacheKey, items: data.items || [], error: '',
          page: data.page || historyPage, total: data.total || 0, limit: data.limit || 20, summary: data.summary ?? null }
        historyCacheRef.current.set(cacheKey, next)
        if (historyCacheRef.current.size > 12) historyCacheRef.current.delete(historyCacheRef.current.keys().next().value)
        setHistoryState(next)
        refreshDesktop = next.items.some(item => ACTIVE_STATUSES.has(item.status))
      })
      .catch(loadError => {
        if (!controller.signal.aborted) setHistoryState(current => ({ ...current, status: current.items.length ? 'ready' : 'error',
          refreshing: false, error: loadError.message, owner: historyOwner, project, cacheKey }))
      })
      .finally(() => { if (!controller.signal.aborted && refreshDesktop) timer = window.setTimeout(loadHistory, 2000) })
    void loadHistory()
    return () => { controller.abort(); window.clearTimeout(timer) }
  }, [historyKind, historyModel, historyPage, historyRefresh, lang, signedIn, surface, historyOwner, project])

  useEffect(() => {
    historyCacheRef.current.clear()
    setHistoryPage(1)
    setRowProgress({})
    trackersRef.current.clear()
  }, [historyOwner, project])

  useEffect(() => {
    const refresh = () => { if (!document.hidden && surface === 'history' && signedIn) setHistoryRefresh(value => value + 1) }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [signedIn, surface])

  useEffect(() => {
    if (surface !== 'billing' || !signedIn) return undefined
    const controller = new AbortController()
    setLedgerState({ owner: historyOwner, status: 'loading', items: [], error: '', summary: null })
    const month = currentMonthRange()
    fetch(`./api/imagine/ledger?from=${encodeURIComponent(month.from)}&to=${encodeURIComponent(month.to)}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || studioText('额度流水读取失败', lang))
        return data
      })
      .then((data) => { if (!controller.signal.aborted) setLedgerState({ owner: historyOwner, status: 'ready', items: data.items || [], error: '', summary: data.summary ?? null }) })
      .catch((loadError) => {
        if (loadError.name !== 'AbortError') setLedgerState({ ...emptyLedger(), owner: historyOwner, status: 'error', error: loadError.message })
      })
    return () => controller.abort()
  }, [lang, signedIn, surface, historyOwner, ledgerRefresh])

  // Server balance is authoritative. A delayed response must never replace
  // another account's session or overwrite a newer refresh.
  const refreshSession = useCallback(async () => {
    if (profilePendingRef.current) return
    sessionRefreshRef.current?.abort()
    const controller = new AbortController()
    sessionRefreshRef.current = controller
    try {
      const response = await fetch('./api/imagine/session', { cache: 'no-store', signal: controller.signal })
      const data = await response.json()
      if (controller.signal.aborted) return
      // 桌面启动后异步恢复云端账号，本机画布身份与 CSRF 没有变化。
      // 更新账号及积分即可；清空会话会卸载画布并取消正在进行的本地上传。
      if (response.ok && data.session?.user?.id === 'local') {
        setUserSession(data.session)
        return
      }
      if (response.status === 401 || (response.ok && (!data.session || workspaceOwnerKey(data.session) !== historyOwner))) {
        if (workspaceOwnerRef.current === historyOwner) clearUserSession()
        return
      }
      if (response.ok && data.session) {
        setUserSession(current => current && workspaceOwnerKey(current) === historyOwner
          && workspaceOwnerKey(data.session) === historyOwner ? data.session : current)
      }
    } catch { /* Keep the visible session on transient read failures. */ }
    finally { if (sessionRefreshRef.current === controller) sessionRefreshRef.current = null }
  }, [historyOwner, clearUserSession])

  useEffect(() => {
    if (!userSession?.user) return undefined
    const refresh = () => { if (!document.hidden) void refreshSession() }
    const onPoints = (event) => {
      const points = event.detail?.points
      if (points != null && Number.isFinite(Number(points)) && Number(points) !== Number(userSession.user.points)) refresh()
    }
    // Tabs share this browser's cookie. Treat notifications only as a cue to
    // re-read the server session, never as an account identity or credential.
    const onSessionChange = event => { if (event.key === SESSION_CHANGE_KEY) void refreshSession() }
    window.addEventListener('storage', onSessionChange)
    window.addEventListener('miaoimg:points', onPoints)
    window.addEventListener('miao-desktop-session', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    // Other browsers have no shared event channel; only visible pages poll.
    const timer = window.setInterval(refresh, 60000)
    refresh()
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('storage', onSessionChange)
      window.removeEventListener('miaoimg:points', onPoints)
      window.removeEventListener('miao-desktop-session', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      sessionRefreshRef.current?.abort()
    }
  }, [historyOwner, refreshSession, userSession?.user?.points])

  useEffect(() => {
    if (!userSession?.user) return
    setLedgerRefresh(value => value + 1)
    setHistoryRefresh(value => value + 1)
  }, [historyOwner, userSession?.user?.points])

  // 网站通过原任务查询进度；桌面从后台运行时已保存的任务快照读取。
  // 这里复用与画布相同的框架无关进度核心；两侧的真值、≈估算和终态语义保持一致。
  // 等待秒数每秒走一格，和轮询节奏分开（轮询可以几秒一次，秒表不能卡）。
  useEffect(() => {
    if (surface !== 'history' || !historyState.items.some((item) => ACTIVE_STATUSES.has(item.status))) return undefined
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [historyState.items, surface])

  useEffect(() => {
    if (surface !== 'history' || !historyState.items.length) return
    const updates: Record<string, HistoryProgress> = {}
    for (const item of historyState.items) {
      if (!ACTIVE_STATUSES.has(item.status)) continue
      let tracker = trackersRef.current.get(item.requestId)
      if (!tracker) { tracker = createProgressTracker(); trackersRef.current.set(item.requestId, tracker) }
      updates[item.requestId] = historyProgress(item, tracker, clock)
    }
    setRowProgress(updates)
  }, [historyState.items, surface, clock])



  const refreshAccount = useCallback(async () => {
    const authEpoch = authEpochRef.current
    await refreshSession()
    if (authEpochRef.current !== authEpoch || workspaceOwnerRef.current !== historyOwner) return
    try {
      const month = currentMonthRange()
      const response = await fetch(`./api/imagine/ledger?from=${encodeURIComponent(month.from)}&to=${encodeURIComponent(month.to)}`)
      const data = await response.json()
      if (authEpochRef.current !== authEpoch || workspaceOwnerRef.current !== historyOwner) return
      if (!response.ok) throw new Error(data.error || studioText('额度流水读取失败', lang))
      setLedgerState({ owner: historyOwner, status: 'ready', items: data.items || [], error: '', summary: data.summary ?? null })
    } catch (loadError) {
      if (authEpochRef.current !== authEpoch || workspaceOwnerRef.current !== historyOwner) return
      setLedgerState({ ...emptyLedger(), owner: historyOwner, status: 'error', error: loadError.message })
    }
  }, [lang, refreshSession, historyOwner])

  function beginSurfaceAction() {
    const request = ++surfaceRequestRef.current
    const authEpoch = authEpochRef.current, owner = workspaceOwnerRef.current, currentProject = projectRef.current
    return () => request === surfaceRequestRef.current && authEpoch === authEpochRef.current
      && owner === workspaceOwnerRef.current && currentProject === projectRef.current
  }

  async function changeSurface(next: string) {
    const current = beginSurfaceAction()
    try {
      // These shell pages replace the Vue tree; its async unmount hook cannot
      // finish saving after the tree has already been disposed.
      if (surface === 'look' && next !== surface) await window.miaoDesktop?.flushSave?.()
      if (current()) setSurface(next)
    } catch {
      if (current()) setError(studioText('草稿保存失败，仍留在工作台，请重试', lang))
    }
  }

  function openHomeSection(section: 'home' | 'projects' | 'cases') {
    setHomeSection(section)
    setHomeSectionRequest(value => value + 1)
    void changeSurface('home')
  }

  async function logoutUser() {
    if (logoutPendingRef.current || profilePendingRef.current) return
    logoutPendingRef.current = true
    setLogoutBusy(true)
    setError('')
    const lifetime = pageLifetimeRef.current
    const authEpoch = authEpochRef.current, owner = workspaceOwnerRef.current
    const current = () => !lifetime.signal.aborted && authEpoch === authEpochRef.current && owner === workspaceOwnerRef.current
    try {
      await window.miaoDesktop?.flushSave?.()
      if (!current()) return
      const response = await fetch('./api/imagine/logout', { method: 'POST', signal: lifetime.signal, headers: userSession?.csrf ? { 'x-csrf-token': userSession.csrf } : {} })
      if (!current()) return
      if (!response.ok && response.status !== 401) throw new Error()
      clearUserSession()
      try { localStorage.setItem(SESSION_CHANGE_KEY, String(Date.now()) + ':' + Math.random()) } catch { /* Focus/visible-page session reads still reconcile restricted storage. */ }
      setNotice(studioText('已退出登录', lang))
    } catch { if (current()) setError(studioText('退出登录失败，请重试', lang)) }
    finally { logoutPendingRef.current = false; setLogoutBusy(false) }
  }

  async function saveProfile() {
    if (logoutPendingRef.current || passwordPendingRef.current || profilePendingRef.current) return
    const name = profileName.trim()
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) { setError(studioText('请输入 1–60 字的昵称，不能包含换行或控制字符', lang)); return }
    profilePendingRef.current = true
    sessionRefreshRef.current?.abort()
    setProfileBusy(true); setError(''); setNotice('')
    const lifetime = pageLifetimeRef.current
    const authEpoch = authEpochRef.current, owner = workspaceOwnerRef.current
    const current = () => !lifetime.signal.aborted && authEpoch === authEpochRef.current && owner === workspaceOwnerRef.current
    try {
      const response = await fetch('./api/imagine/profile', { method: 'POST', signal: lifetime.signal, headers: { 'content-type': 'application/json', 'x-csrf-token': userSession?.csrf || '' }, body: JSON.stringify({ name }) })
      const data = await response.json()
      if (!current()) return
      if (!response.ok) throw new Error(data.error || studioText('昵称保存失败，请重试', lang))
      if (!data.session?.user || workspaceOwnerKey(data.session) !== owner) throw new Error(studioText('昵称保存失败，请重试', lang))
      setUserSession(data.session)
      setConfig(value => value ? { ...value, session: data.session } : value)
      setProfileName(data.session.user.name)
      setNotice(studioText('昵称已更新', lang))
      try { localStorage.setItem(SESSION_CHANGE_KEY, String(Date.now()) + ':' + Math.random()) } catch { /* Focus refresh reconciles other views. */ }
    } catch (profileError) { if (current()) setError(profileError.message) }
    finally { profilePendingRef.current = false; setProfileBusy(false) }
  }

  async function changePassword() {
    if (logoutPendingRef.current || passwordPendingRef.current || profilePendingRef.current) return
    if (passwordForm.newPassword.length < 8) { setError(studioText('新密码至少需要 8 位', lang)); return }
    passwordPendingRef.current = true
    setPasswordBusy(true); setError('')
    const lifetime = pageLifetimeRef.current
    const authEpoch = authEpochRef.current, owner = workspaceOwnerRef.current
    const current = () => !lifetime.signal.aborted && authEpoch === authEpochRef.current && owner === workspaceOwnerRef.current
    try {
      const response = await fetch('./api/imagine/password', { method: 'POST', signal: lifetime.signal, headers: { 'content-type': 'application/json', 'x-csrf-token': userSession?.csrf || '' }, body: JSON.stringify(passwordForm) })
      const data = await response.json()
      if (!current()) return
      if (!response.ok) throw new Error(data.error || studioText(hasPassword ? '密码修改失败' : '密码设置失败', lang))
      setUserSession(data.session)
      setWorkspaceSession(workspaceOwnerRef.current, data.session?.csrf || '', projectRef.current)
      setPasswordForm({ currentPassword: '', newPassword: '' })
      setNotice(studioText(hasPassword ? '密码已修改，其他登录会话已退出' : '密码已设置，其他登录会话已退出', lang))
    } catch (passwordError) { if (current()) setError(passwordError.message) }
    finally { passwordPendingRef.current = false; setPasswordBusy(false) }
  }

  // 生成历史只有图片和视频：按类型分组、显示模型名和官方标识；文本模型不会出现在这里。
  const historyModels = [
    ...(historyKind === 'video' ? [] : (config?.models || []).map((model) => ({ ...model, group: studioText('图片模型', lang) }))),
    ...(historyKind === 'image' ? [] : (config?.videoModels || []).map((model) => ({ ...model, group: studioText('视频模型', lang) }))),
  ].filter((model, index, models) => models.findIndex((item) => item.id === model.id) === index)

  // 反馈有新回复时在左侧「反馈」上显示红点：打开时、回到窗口时和每两分钟读一次。
  const [feedbackUnread, setFeedbackUnread] = useState(0)
  useEffect(() => {
    if (!signedIn) { setFeedbackUnread(0); return }
    let cancelled = false
    const read = () => { if (!document.hidden) fetch('/api/imagine/feedback?status=open', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(d => { if (!cancelled && d) setFeedbackUnread(Number(d.unread) || 0) }).catch(() => {}) }
    read()
    const timer = window.setInterval(read, 120_000)
    window.addEventListener('focus', read)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', read) }
  }, [signedIn])
  useEffect(() => {
    const open = () => { closeSettings(); void changeSurface('account') }
    const billing = () => { closeSettings(); void changeSurface('billing') }
    window.addEventListener('miao-open-account-surface', open)
    window.addEventListener('miao-open-billing-surface', billing)
    return () => { window.removeEventListener('miao-open-account-surface', open); window.removeEventListener('miao-open-billing-surface', billing) }
  })

  if (!workspaceReady && !error) {
    return (
      <div className="studio-login" aria-busy="true">
      <main><p>{studioText('打开…', lang)}</p></main>
      </div>
    )
  }

  const balance = userSession?.user?.points
  const statusMessage = error || libraryHandoffError || notice
  const openAccountSurface = () => {
    closeSettings()
    if (!signedIn) window.dispatchEvent(new Event('miao-desktop-account'))
    else void changeSurface('account')
  }
  // 桌面端已登录进入完整账号页；未登录交给原生账号弹窗。
  const openBillingPage = () => { closeSettings(); void changeSurface('billing') }

  return (
    <div className="studio-shell studio-app">
      {(surface !== 'look' || settingsOpen) && <DesktopRail
        active={settingsOpen ? 'settings' : surface === 'history' ? 'history' : surface === 'assets' ? 'assets' : surface === 'billing' ? 'billing' : surface === 'account' ? 'account' : surface === 'feedback' ? 'feedback' : surface === 'look' ? 'canvas' : homeSection}
        feedbackUnread={feedbackUnread}
        onFeedback={() => { closeSettings(); void changeSurface('feedback') }}
        onHome={() => { closeSettings(); openHomeSection('home') }}
        onProjects={() => { closeSettings(); openHomeSection('projects') }}
        onCases={() => { closeSettings(); openHomeSection('cases') }}
        onAssets={() => {
          closeSettings()
          void changeSurface('assets')
        }}
        onHistory={() => { closeSettings(); void changeSurface('history') }}
        onBilling={openBillingPage}
        onSettings={openSettings}
        onAccount={openAccountSurface}
      />}
      <div className="studio-app__body">
      <div className="grain-overlay" aria-hidden="true" />
      {/* 桌面画布全屏铺开：顶栏缩成右上角的悬浮胶囊，语言在设置里切换。 */}
      <header className={`studio-top${surface === 'look' && !settingsOpen ? ' studio-top--canvas' : ''}`}>
        <a className="studio-top__brand" href="/" onClick={event => {
          if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          closeSettings()
          void changeSurface('home')
        }}><img src="/miaoimg-logo.png" alt="" width="28" height="28" />{dictText(lang, 'app.title')}</a>
        <span className="studio-top__gap" />
        {Number.isFinite(balance) && Boolean(userSession?.user?.email) && <button type="button" aria-current={surface === 'billing' ? 'page' : undefined} onClick={openBillingPage}>{studioPoint(balance, lang)}</button>}
        <button type="button" aria-current={surface === 'account' ? 'page' : undefined} onClick={openAccountSurface}>{!userSession?.user?.email ? studioText('登录 / 注册', lang) : studioText('账号', lang)}</button>
        {!(surface === 'look' && !settingsOpen) && <LanguageControl compact />}
      </header>
      {statusMessage && <FeedbackNotice message={statusMessage} error={Boolean(error || libraryHandoffError)} onClose={() => { setError(''); setLibraryHandoffError(''); setNotice('') }} />}
      {surface === 'history' ? (
        <GenerationHistoryPage lang={lang} locale={locale} owner={historyOwner} project={project} state={historyState} progress={rowProgress} now={clock}
          kind={historyKind} model={historyModel} models={historyModels} signedIn={signedIn} onLogin={openAccountSurface}
          onKind={value => { setHistoryKind(value); setHistoryModel(''); setHistoryPage(1) }} onModel={value => { setHistoryModel(value); setHistoryPage(1) }}
          onPage={setHistoryPage} onProject={switchProject} onRefresh={() => setHistoryRefresh(value => value + 1)} onCreate={() => void changeSurface('look')} />
      ) : surface === 'assets' ? (
        <main className="studio-record asset-page personal-assets-page" aria-labelledby="personal-assets-title">
          <PersonalAssetLibrary csrf={userSession?.csrf} owner={workspaceOwner} lang={lang} project={project} onOpenProject={openProject} />
        </main>
      ) : surface === 'billing' ? (
        <CreditPage key={historyOwner} payment={config?.payment} csrf={userSession?.csrf} points={balance} ledger={ledgerState} signedIn={signedIn} onLogin={openAccountSurface}
          onRefresh={() => void refreshAccount()} onPaid={refreshAccount} onCreate={() => void changeSurface('look')} />
      ) : surface === 'feedback' ? (
        <FeedbackPage csrf={userSession?.csrf} signedIn={signedIn} lang={lang} onLogin={() => window.dispatchEvent(new Event('miao-desktop-account'))} onBack={() => openHomeSection('home')} onUnread={setFeedbackUnread} />
      ) : surface === 'account' ? (
        <AccountPage lang={lang} user={userSession?.user} name={profileName} onName={setProfileName} profileBusy={profileBusy} passwordBusy={passwordBusy} logoutBusy={logoutBusy} hasPassword={hasPassword}
          password={passwordForm} onPassword={(field,value) => setPasswordForm(current => ({ ...current, [field]: value }))} onSave={() => void saveProfile()} onChangePassword={() => void changePassword()} onLogout={() => void logoutUser()} />
      ) : surface === 'home' ? (
      <StudioHome
        csrf={userSession?.csrf}
        owner={workspaceOwner}
        initialSection={homeSection}
        sectionRequest={homeSectionRequest}
        onOpen={openProject}
        onRemoved={id => { if (id === project) switchProject(DEFAULT_PROJECT) }}
      />
      ) : (
      <main className="studio-main">
        <MiaoCanvasMount key={`${workspaceOwner}:${project}`} owner={workspaceOwner} csrf={userSession?.csrf || ''} project={project} onSwitchProject={switchProject} pending={pendingInsert} onInserted={acknowledgePendingInsert} />
      </main>
      )}
      {settingsOpen && <Suspense fallback={null}><MiaoSettingsMount owner={workspaceOwner} csrf={userSession?.csrf || ''} project={project} embedded onClose={closeSettings} /></Suspense>}
      </div>
    </div>
  )
}
