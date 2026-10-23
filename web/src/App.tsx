import { AnimatePresence, motion } from 'framer-motion'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ArchiveHeader from './components/ArchiveHeader'
import FilterBar from './components/FilterBar'
import GallerySessionPanel from './components/GallerySessionPanel'
import PromptDialog from './components/PromptDialog'
import PromptGallery from './components/PromptGallery'
import { usePromptArchiveApi } from './hooks/usePromptArchiveApi'
import { useLang } from './i18n'
import LandingFallback from './landing/LandingFallback'
import { isAdminHost } from './siteOrigins'
const AdminPage = lazy(() => import('./admin/AdminPage'))
const ChangelogPage = lazy(() => import('./landing/ChangelogPage'))
const LandingPage = lazy(() => import('./landing/LandingPage'))

function ArchiveSelectionBanner({ mode }) {
  const [clearing, setClearing] = useState(false)
  const { t } = useLang()

  async function leaveSelection(destination) {
    setClearing(true)
    try {
      window.sessionStorage.removeItem('miao-library-handoff')
    } catch {
      // The destination is still safe to open; a selection was never made.
    }
    window.location.href = destination
  }

  if (!mode) return null
  const isPrompt = mode === 'prompt'
  return (
    <div className="library-selection-bar" role="status">
      <div>
        <strong>{t(isPrompt ? 'selection.prompt.title' : 'selection.reference.title')}</strong>
        <span>{t(isPrompt ? 'selection.prompt.hint' : 'selection.reference.hint')}</span>
      </div>
      <div className="library-selection-bar__actions">
        <button type="button" disabled={clearing} onClick={() => leaveSelection('/?library=1')}>{t('selection.cancel')}</button>
        <button type="button" disabled={clearing} onClick={() => leaveSelection('/')}>{t('selection.backToStudio')}</button>
      </div>
    </div>
  )
}

function ArchivePage({ selectionMode = null }) {
  // Archive CDNs reject cross-site Referer headers. Scope the policy to the
  // library, including video elements (which have no referrerPolicy attribute).
  useEffect(() => {
    const policy = document.createElement('meta')
    policy.name = 'referrer'
    policy.content = 'no-referrer'
    document.head.appendChild(policy)
    return () => policy.remove()
  }, [])

  const archive = usePromptArchiveApi()
  const { t } = useLang()
  const [selectedId, setSelectedId] = useState(null)
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)
  const searchInputRef = useRef(null)
  const navigationItems = archive.gallerySession ? archive.items : archive.visibleItems
  // 卡片上的标签只显示译名，这里把 value → 展示名 的映射交给卡片层。
  const tagLabels = useMemo(
    () => new Map(archive.tags.map((tag) => [tag.value, tag.label])),
    [archive.tags],
  )

  const selectedIndex = selectedId
    ? navigationItems.findIndex((item) => item.tweet_id === selectedId)
    : -1
  const selectedItem = selectedIndex >= 0 ? navigationItems[selectedIndex] : null

  const notify = useCallback((message) => {
    window.clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400)
  }, [])

  const stepSelection = useCallback(
    (delta) => {
      const items = navigationItems
      if (!items.length) return
      const next = (selectedIndex + delta + items.length) % items.length
      if (!archive.gallerySession && next >= items.length - 4 && archive.hasMore) archive.loadMore()
      setSelectedId(items[next].tweet_id)
    },
    [archive, navigationItems, selectedIndex],
  )

  useEffect(() => {
    if (archive.focusId) setSelectedId(archive.focusId)
  }, [archive.focusId])

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key !== '/' || selectedId) return
      if (event.isComposing) return
      const target = event.target instanceof Element ? event.target : document.activeElement
      if (target?.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="slider"]')) return
      event.preventDefault()
      searchInputRef.current?.focus()
      searchInputRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedId])

  return (
    <div className="library-app text-ink">
      <div className="grain-overlay" aria-hidden="true" />

      <ArchiveHeader
        stats={archive.stats}
        loading={archive.loading}
        query={archive.query}
        queryDirty={archive.queryDirty}
        onQueryChange={archive.setQuery}
        onQuerySubmit={archive.submitQuery}
        onQueryClear={archive.clearQuery}
        searchInputRef={searchInputRef}
        searchDisabled={Boolean(archive.error || archive.gallerySession)}
      />

      <ArchiveSelectionBanner mode={selectionMode} />

      <main className="relative mx-auto w-full max-w-[1760px] pb-24">
        <GallerySessionPanel
          session={archive.gallerySession}
          missingReferences={archive.missingSessionReferences}
          onCopied={notify}
        />

        <FilterBar
          popularTools={archive.popularTools}
          tools={archive.tools}
          selectedTool={archive.selectedTool}
          onToolChange={archive.setSelectedTool}
          popularTags={archive.popularTags}
          tags={archive.tags}
          selectedTag={archive.selectedTag}
          onTagChange={archive.setSelectedTag}
          sortOrder={archive.sortOrder}
          onSortChange={archive.setSortOrder}
          resultCount={archive.filteredCount}
          hasActiveFilters={archive.hasActiveFilters}
          onReset={archive.resetFilters}
          disabled={Boolean(archive.error || archive.gallerySession)}
        />

        <PromptGallery
          items={archive.visibleItems}
          loading={archive.loading}
          error={archive.error}
          hasMore={archive.hasMore}
          onLoadMore={archive.loadMore}
          onRetry={archive.retry}
          onReset={archive.resetFilters}
          onSelect={(item) => setSelectedId(item.tweet_id)}
          onCopied={notify}
          hasActiveFilters={archive.hasActiveFilters}
          tagLabels={tagLabels}
          preserveOrder={Boolean(archive.gallerySession)}
        />
      </main>

      <footer className="lib-footer">
        <div className="lib-footer__inner">
          <span className="lib-footer__brand">妙图 <small>MiaoImg</small></span>
          <span>{t('footer.tagline')}</span>
          <span className="lib-footer__mark">{t('footer.mark')}</span>
        </div>
      </footer>

      <AnimatePresence>
        {selectedItem && (
          <PromptDialog
            item={selectedItem}
            position={selectedIndex + 1}
            total={archive.gallerySession ? navigationItems.length : archive.filteredCount}
            onClose={() => setSelectedId(null)}
            onStep={stepSelection}
            onCopied={notify}
            selectionMode={selectionMode}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2"
            role="status"
          >
            <div className="toast">
              <span className="grid size-5 place-items-center rounded-full bg-brass text-[11px] font-bold text-[#17140f]">✓</span>
              {toast}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function App() {
  const nativeDesktop = Boolean(window.miaoDesktop)
  const admin = isAdminHost() || window.location.pathname.startsWith('/manage')
  const [webEnabled, setWebEnabled] = useState(false)
  useEffect(() => {
    if (nativeDesktop || admin) return
    const controller = new AbortController()
    fetch('/api/imagine/config', { signal: controller.signal, cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(config => setWebEnabled(config?.webAppEnabled === true))
      .catch(() => {})
    return () => controller.abort()
  }, [nativeDesktop, admin])
  if (!nativeDesktop && !admin && /^\/changelog\/?$/.test(window.location.pathname)) return <Suspense fallback={<LandingFallback />}><ChangelogPage /></Suspense>
  if (!nativeDesktop && !admin && !webEnabled) return <Suspense fallback={<LandingFallback />}><LandingPage /></Suspense>
  if (isAdminHost() || window.location.pathname.startsWith('/manage')) return <Suspense fallback={null}><AdminPage /></Suspense>
  const params = new URLSearchParams(window.location.search)
  const pick = params.get('pick')
  if (params.has('library') || params.has('session') || params.has('focus') || params.has('q') || ['prompt', 'reference'].includes(pick)) {
    const selectionMode = ['prompt', 'reference'].includes(pick) ? pick : null
    return <ArchivePage selectionMode={selectionMode} />
  }
  // The public root is the product landing page. Keep the workbench behind an
  // explicit entry so the landing page's calls to `/` do not loop back to itself.
  return <Suspense fallback={<LandingFallback />}><LandingPage /></Suspense>
}

export default App
