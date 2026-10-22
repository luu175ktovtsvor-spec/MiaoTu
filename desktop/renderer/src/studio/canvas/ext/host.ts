// 文件扩展的 UMD 脚本在构建时把 vue / element-plus / 语言状态外置到 window.miaoimgExtHost，
// 这里在宿主启动时挂出去；扩展导出写到 window.miaoimgExts[扩展ID]，加载器按 id 取回。
import * as vue from "vue";
import * as elementPlus from "element-plus";
import * as i18n from "@miaoimg/i18n/vue";

declare global {
  interface Window {
    miaoimgExtHost?: Record<string, unknown>;
    miaoimgExts?: Record<string, unknown>;
    miaoimgTiptapHost?: Record<string, unknown>;
  }
}

let installed = false;

export function installExtHost() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.miaoimgExtHost = { ...(window.miaoimgExtHost || {}), vue, elementPlus, i18n };
  window.miaoimgExts = window.miaoimgExts || {};
}
