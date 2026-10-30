import { contextBridge, ipcRenderer } from 'electron'
let sessionTransition: string | undefined
ipcRenderer.on('desktop:session-restored', (_event, id) => {
  sessionTransition = typeof id === 'string' ? id : undefined
  window.dispatchEvent(new Event('miao-desktop-session'))
})
// 更新状态由主进程推给页面；页面只在设置里读取，不参与更新判断。
const updateListeners = new Set<(status: unknown) => void>()
ipcRenderer.on('desktop:update-status', (_event, status) => { for (const callback of updateListeners) { try { callback(status) } catch {} } })
const saveHandlers = new Set<() => Promise<void>>()
let saving: Promise<void> | undefined
function flushSave(): Promise<void> {
  if (saving) return saving
  const work = Promise.resolve().then(async () => {
    // Notify the focused editor before collecting the Vue save barriers.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const results = await Promise.allSettled([...saveHandlers].map(callback => Promise.resolve().then(callback)))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw new Error(String(failed.reason?.message || failed.reason || '工作区尚未保存'))
  }).finally(() => { if (saving === work) saving = undefined })
  saving = work
  return work
}
ipcRenderer.on('desktop:save-before-close', async (_event, id) => {
  let error: string | undefined
  try { await flushSave() } catch (cause) { error = String(cause?.message || cause || '工作区尚未保存') }
  await ipcRenderer.invoke('desktop:save-complete', id, error === undefined, error).catch(() => {})
})
contextBridge.exposeInMainWorld('miaoDesktop', {
  platform: process.platform,
  getDocumentEpoch: () => ipcRenderer.invoke('desktop:document-epoch'),
  flushSave,
  getSessionTransition: () => sessionTransition,
  completeSessionChange: async (id: string) => {
    const accepted = await ipcRenderer.invoke('desktop:session-complete', id)
    if (accepted && sessionTransition === id) sessionTransition = undefined
    return accepted
  },
  reload: () => ipcRenderer.invoke('desktop:reload'),
  registerSaveHandler: (callback: () => Promise<void>) => {
    if (typeof callback !== 'function') throw new Error('保存回调无效')
    saveHandlers.add(callback)
    return () => { saveHandlers.delete(callback) }
  },
  readClipboardText: () => ipcRenderer.invoke('desktop:clipboard-text'),
  writeClipboardText: text => ipcRenderer.invoke('desktop:clipboard-write-text', text),
  readClipboardMedia: () => ipcRenderer.invoke('desktop:clipboard-media'),
  computerStatus: () => ipcRenderer.invoke('desktop:computer-status'),
  openComputerPermissions: () => ipcRenderer.invoke('desktop:computer-permissions'),
  enableComputer: () => ipcRenderer.invoke('desktop:computer-enable'),
  disableComputer: () => ipcRenderer.invoke('desktop:computer-disable'),
  chooseComputerDirectory: () => ipcRenderer.invoke('desktop:computer-directory'),
  minimize: () => ipcRenderer.invoke('desktop:minimize'),
  maximize: () => ipcRenderer.invoke('desktop:maximize'),
  close: () => ipcRenderer.invoke('desktop:close'),
  openData: () => ipcRenderer.invoke('desktop:open-data'),
  updateStatus: () => ipcRenderer.invoke('desktop:update-status'),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:update-download'),
  quitAndInstall: () => ipcRenderer.invoke('desktop:update-install'),
  openUpdatePage: () => ipcRenderer.invoke('desktop:update-page'),
  onUpdateStatus: callback => {
    if (typeof callback !== 'function') return () => {}
    updateListeners.add(callback)
    return () => { updateListeners.delete(callback) }
  },
})
// Register after exposing the bridge. The host never waits for a save message
// in an initial/new document which has not installed its preload listener yet.
const saveReady = () => { void ipcRenderer.invoke('desktop:save-ready').catch(() => {}) }
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', saveReady, { once: true })
else saveReady()

// 原生菜单和弹框跟随工作台的界面语言。只发送代码，正文由主进程自己的词典决定。
const publishLanguage = () => { void ipcRenderer.invoke('desktop:language', document.documentElement.lang).catch(() => {}) }
const observeLanguage = () => {
  publishLanguage()
  new MutationObserver(publishLanguage).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', observeLanguage, { once: true })
else observeLanguage()
