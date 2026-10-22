// 内置扩展只提供组件：显示名、后缀、图标、配置规则由服务端的 /api/ext/list 下发，
// 两边不重复声明，这里只把扩展 ID 映射到妙图已经编译进包里的组件。
//
// 标记/画布文本仍复用文档面板里那一份编辑器（editorView.vue），不再做第二套；
// 面板如果换了编辑器实现，只需要改下面两行的指向。
import type { Component } from "vue";

export const builtinComponents: Record<string, () => Promise<{ default: Component }>> = {
  "ext-md": () => import("../../panels/document/components/editorView.vue"),
  "ext-canvasNode": () => import("../../panels/document/components/editorView.vue"),
  "ext-txt": () => import("./textView.vue"),
  "ext-image": () => import("./imageView.vue"),
  "ext-media": () => import("./mediaView.vue"),
};
