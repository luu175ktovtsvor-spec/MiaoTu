import FeedbackNotice from '../components/FeedbackNotice'
import { useEffect, useRef, useState } from 'react'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { useLang } from '../i18n'
import { useWorkspaceStore, type PendingCanvasInsert } from '../stores/workspace'
import { hasStoredCanvasLanguage, loadSettings, uiSettings, updateUiSettings } from '../stores/settings'
import { claimDocumentLanguage, releaseDocumentLanguage, subscribeCanvasLanguage } from '../shellLanguage'
import { installNodeHost } from './canvas/nodeHost'
import { normalizeLocale } from './canvas/i18n'
import { registerLanguage } from './canvas/i18n/apply'
import useWorkspaceFiles from '../lib/workspaceFiles'
import { DEFAULT_PROJECT, workspaceDirectory } from '../lib/workspaceRemote'
import { reloadWorkspace } from '../desktop/navigation'
import miaoimgApp from './canvas/miaoimgApp.vue'

export default function MiaoCanvasMount({ owner = '', csrf = '', project = DEFAULT_PROJECT, onSwitchProject, pending = null, onInserted }: { owner?: string; csrf?: string; project?: string; onSwitchProject?: (id: string) => void; pending?: PendingCanvasInsert | null; onInserted?: (id: string, kind: PendingCanvasInsert['kind'], owner: string, project: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<ReturnType<typeof useWorkspaceStore> | null>(null)
  const insertAckRef = useRef(onInserted)
  insertAckRef.current = onInserted
  const [error, setError] = useState('')
  // 画布是独立的 Vue 应用，语言由画布设置（ui.language）决定；React 顶栏的中/EN 是它的
  // 默认值——用户没在画布设置里挑过语言时跟着顶栏走，挑过之后画布自己说了算，刷新也保持。
  const { lang, t } = useLang()
  const shellLocale = normalizeLocale(lang) ?? 'zh-CN'
  const shellLocaleRef = useRef(shellLocale)
  useEffect(() => {
    shellLocaleRef.current = shellLocale
    if (!hasStoredCanvasLanguage()) updateUiSettings({ language: shellLocale })
  }, [shellLocale])
  // 顶栏的中/EN 是外壳语言，用户点它会写回画布语言并通知到这里：画布正开着就当场换，
  // 不用刷新。画布设置里自己挑的语言（21 种）不走这条通道，所以不会被覆盖。
  useEffect(() => subscribeCanvasLanguage((value) => {
    const locale = normalizeLocale(value)
    if (locale && locale !== uiSettings.value.language) updateUiSettings({ language: locale })
  }), [])
  // 交接可能发生在画布挂载之后（用户在灵感库选完再回来），所以单独监听。
  useEffect(() => {
    workspaceRef.current?.queueInsert(pending)
  }, [pending])
  useEffect(() => {
    let cancelled = false
    let mounted = false
    // 画布在的时候 <html lang/dir> 归画布语言所有，外壳让位（见 shellLanguage.ts）。
    claimDocumentLanguage()
    installNodeHost()
    const app = createApp(miaoimgApp)
    const pinia = createPinia()
    const directory = workspaceDirectory(owner, project)
    app.use(pinia)
    app.provide('miaoModelCsrf', csrf)
    app.provide('workspaceDirectory', directory)
    app.provide('pendingCanvasInsertAck', (id: string, kind: PendingCanvasInsert['kind']) => insertAckRef.current?.(id, kind, owner, project))
    // 项目菜单用：当前项目 + 切换回调（切换由 React 侧改状态，这里整个重新挂载）。
    app.provide('workspaceProjectControl', { current: project, switch: (id: string) => onSwitchProject?.(id) })
    const workspace = useWorkspaceStore(pinia)
    workspaceRef.current = workspace
    if (pending) workspace.queueInsert(pending)
    void loadSettings().then(() => {
      if (cancelled || !host.current) return
      // 设置读完才动手：挂载前语言、<html dir> 都已经就位，不会先闪一帧中文。
      if (!hasStoredCanvasLanguage()) updateUiSettings({ language: shellLocaleRef.current })
      registerLanguage()
      workspace.setProject({ directory, name: t('studio.workspaceName') })
      app.mount(host.current)
      mounted = true
    }).catch(error => { if (!cancelled) setError(error.message) })
    return () => {
      cancelled = true
      workspaceRef.current = null
      // _instance 只在开发/生产 devtools 构建中赋值，不能用它判断生产应用是否挂载。
      // 必须卸载真实 Vue 应用，才能移除 body 上的 Agent、停止流和旧账号的轮询。
      if (mounted) { app.unmount(); mounted = false }
      releaseDocumentLanguage()
    }
  }, [owner, csrf, project])
  return <>{error && <FeedbackNotice message={error} action="重新加载" onAction={() => { void reloadWorkspace().catch(cause => setError(cause.message)) }} onClose={() => setError('')} />}<div ref={host} className="studio-miaoimg-mount" /></>
}
