import { useEffect, useRef } from 'react'
import { createPinia } from 'pinia'
import { createApp, defineComponent, h, shallowRef, watch } from 'vue'
import { ElConfigProvider } from 'element-plus'
import 'element-plus/dist/index.css'
import { locale } from '@miaoimg/i18n/vue'
import SettingsDialog from './canvas/settings/index.vue'
import { loadSettings } from '../stores/settings'
import { registerLanguage } from './canvas/i18n/apply'
import { defaultElementLocale, loadElementLocale } from './canvas/i18n/elementPlus'
import { useWorkspaceStore } from '../stores/workspace'
import { DEFAULT_PROJECT, workspaceDirectory } from '../lib/workspaceRemote'

// Desktop settings are a page inside the application shell. Keeping the canvas
// mounted underneath preserves active tasks while the opaque settings surface
// owns focus and pointer input.
export default function MiaoSettingsMount({ owner = '', csrf = '', project = DEFAULT_PROJECT, embedded = false, onClose }: { owner?: string; csrf?: string; project?: string; embedded?: boolean; onClose?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    let app: ReturnType<typeof createApp> | undefined
    const directory = workspaceDirectory(owner, project)
    const Root = defineComponent({
      setup() {
        const elementLocale = shallowRef(defaultElementLocale)
        watch(locale, async value => {
          const pack = await loadElementLocale(value)
          if (locale.value === value) elementLocale.value = pack
        }, { immediate: true })
        return () => h(ElConfigProvider, { locale: elementLocale.value }, () => h(SettingsDialog, {
          modelValue: true,
          embedded,
          'onUpdate:modelValue': (value: boolean) => { if (!value) onClose?.() },
        }))
      },
    })
    void loadSettings().then(() => {
      if (cancelled || !host.current) return
      registerLanguage()
      app = createApp(Root)
      const pinia = createPinia()
      app.use(pinia)
      app.provide('miaoModelCsrf', csrf)
      app.provide('workspaceDirectory', directory)
      useWorkspaceStore(pinia).setProject({ directory, name: '' })
      app.mount(host.current)
    })
    return () => {
      cancelled = true
      app?.unmount()
    }
  }, [owner, csrf, project, embedded])
  return <>
    {!embedded && <div className="miao-settings-backdrop" aria-hidden="true" />}
    <div ref={host} className={embedded ? 'studio-settings-page' : 'miao-settings-mount'} />
  </>
}
