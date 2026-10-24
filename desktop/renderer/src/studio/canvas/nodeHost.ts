// MiaoImg 节点插件（UMD bundle）通过 window.miaoimgNodeHost 拿到宿主运行时：
// 插件构建时把 vue / @vue-flow/core / element-plus 外置到这些全局上。
// 这里在画布启动时把它们挂出去，插件脚本才能加载。
// Three/Pi are prepared before a remote plug-in executes, without loading them
// just to open an empty canvas containing only built-in nodes.
import * as vue from 'vue'
import * as vueFlow from '@vue-flow/core'
import * as elementPlus from 'element-plus'

declare global {
  interface Window {
    miaoimgNodeHost?: Record<string, unknown>
    miaoimgNodes?: Record<string, unknown>
  }
}

let installed = false
let extendedHost: Promise<void> | undefined

export function installNodeHost() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.miaoimgNodeHost = { ...(window.miaoimgNodeHost || {}), vue, vueFlow, elementPlus }
  window.miaoimgNodes = window.miaoimgNodes || {}
}

export function installExtendedNodeHost(): Promise<void> {
  installNodeHost()
  return extendedHost ??= import('./nodeExtraHost').then(module => module.installNodeExtraHost()).catch(error => {
    extendedHost = undefined
    throw error
  })
}
