// Vue 侧入口：用 shallowRef 让模板里的 translate() 能跟着语言变化重渲染。
import { computed, shallowRef } from 'vue'
import * as core from './index'

export { supportedLocales, normalizeLocale, detectLocale, isRtlLocale, getLocale, msg, loadCatalog, isCatalogLoaded } from './index'
export type { Locale, LocaleSetting, MessageDescriptor } from './index'

export const locale = shallowRef<core.Locale>(core.getLocale())
// 语言包是异步加载的，locale 没变但包到位时也得再渲染一次，这里累加版本号。
const catalogVersion = shallowRef(0)
export const catalogRevision = computed(() => catalogVersion.value)

core.subscribeLocale(value => { locale.value = value })
core.subscribeCatalog(() => { catalogVersion.value += 1 })

export function setLocale(value: core.LocaleSetting) { core.setLocale(value) }

export function translate(message: string | core.MessageDescriptor, values?: Record<string, unknown>) {
  // 读一次版本号：语言包异步到位后它会变，用到 translate() 的模板和计算属性才会跟着重渲染。
  const revision = catalogRevision.value
  void revision
  return core.translate(message, values, locale.value)
}

export function t(strings: TemplateStringsArray, ...values: unknown[]) {
  return translate(core.msg(strings, ...values))
}
