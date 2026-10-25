<template>
  <el-config-provider :locale="elementLocale" :message="{ offset: 64 }">
    <div class="miaoimgApp" :style="uiStyle">
      <workspaceApp />
    </div>
  </el-config-provider>
</template>

<script setup lang="ts">
import { onMounted, onScopeDispose, shallowRef, watch, watchEffect } from 'vue'
import { ElConfigProvider } from 'element-plus'
import { locale } from '@miaoimg/i18n/vue'
import { canvasTheme as uiStyle } from './canvasTheme'
import { defaultElementLocale, loadElementLocale } from './i18n/elementPlus'
import workspaceApp from './workspaceApp.vue'

// Element Plus 内置文案（分页、日期、确认框按钮等）跟着画布语言走。
// 语言包按语言异步加载，加载期间先用默认包顶着。
const elementLocale = shallowRef(defaultElementLocale)
watch(locale, async (value) => {
  const pack = await loadElementLocale(value)
  if (locale.value === value) elementLocale.value = pack
}, { immediate: true })

// Teleported panels share the same tokens; remove them when leaving the canvas.
const previous = new Map<string, { value: string; priority: string }>();
let stopTheme: (() => void) | undefined;
onMounted(() => {
  document.body.setAttribute("data-miaoimg-canvas-ui", "2");
  stopTheme = watchEffect(() => {
    for (const [name, value] of Object.entries(uiStyle.value)) {
      if (!name.startsWith("--")) continue;
      if (!previous.has(name)) previous.set(name, { value: document.body.style.getPropertyValue(name), priority: document.body.style.getPropertyPriority(name) });
      document.body.style.setProperty(name, value);
    }
  });
});
onScopeDispose(() => {
  stopTheme?.();
  document.body.removeAttribute("data-miaoimg-canvas-ui");
  for (const [name, old] of previous) {
    if (old.value) document.body.style.setProperty(name, old.value, old.priority);
    else document.body.style.removeProperty(name);
  }
});
</script>

<style>
@import 'element-plus/dist/index.css';
@import '@vue-flow/core/dist/style.css';
@import '@vue-flow/core/dist/theme-default.css';

.miaoimgApp { width: 100%; height: 100%; min-height: 0; overflow: hidden; }
.miaoimgApp .canvas { width: 100%; height: 100%; }
.miaoimgApp .vue-flow { background: transparent; }
.miaoimgApp .vue-flow__background { background: transparent; }
@media (max-width: 700px) {
  .miaoimgApp { min-height: 100%; }
  .miaoimgApp .vue-flow__panel.top.left { margin: 10px; }
  .miaoimgApp .vue-flow__panel.bottom.left { right: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); left: 10px; overflow-x: auto; }
  .miaoimgApp .canvasMenu { max-width: calc(100vw - 24px); }
  .miaoimgApp .canvasMenu .menuContent { max-width: calc(100vw - 40px); }
  .miaoimgApp .canvasMenu .workspaceNameInput { display: none; }
  .miaoimgApp .canvasMenu .libraryLink .libraryLinkText { display: none; }
  .miaoimgApp .canvasControls { max-width: calc(100vw - 20px); overflow-x: auto; }
  .miaoimgApp .canvasControls .toolButton { width: 36px; height: 36px; }
  .miaoimgApp .vue-flow__minimap { display: none; }
  .miaoimgApp .nodeMenu { max-width: calc(100vw - 24px); }
  /* 手机端：节点卡片与上下浮层按屏幕宽度收拢，生成卡片改为竖排工具条。 */
  .miaoimgApp .nodeSkeleton { max-width: calc(100vw - 24px); }
  .miaoimgApp .nodeSkeleton .floatingSlot .promptCard .promptFooter { flex-wrap: wrap; row-gap: 8px; }
  .miaoimgApp .nodeSkeleton .floatingSlot .promptCard .promptFooter .modelSelect { width: 100%; }
  .miaoimgApp .nodeSkeleton .floatingSlot .promptCard .promptFooter .sendButton { margin-left: 0; }
  .miaoimgApp .nodeSkeleton .imagePreview,
  .miaoimgApp .nodeSkeleton video { max-height: 46vh; }
  .miaoimgApp .mediaHistory .historyContent { grid-template-columns: 1fr; }
  .miaoimgApp .vue-flow__controls { display: none; }
}

/* 手机端生成卡片由节点内部传送到 body，固定贴底显示。 */
.floatingSlot.mobileSheet {
  position: fixed;
  top: auto;
  right: 12px;
  bottom: calc(84px + env(safe-area-inset-bottom, 0px));
  left: 12px;
  z-index: 1000;
  width: auto !important;
  max-height: calc(100dvh - 180px);
  overflow: auto;
  transform: none;
}
</style>

<style>
/* Teleported Vue dialogs remain usable on narrow and short screens. */
body:has(.studio-app) .el-dialog {
  max-width: calc(100vw - 24px);
  max-height: calc(100dvh - 24px);
  display: flex;
  flex-direction: column;
  overflow: hidden !important;
}
body:has(.studio-app) .el-dialog:not(.is-fullscreen):not(.is-align-center) { margin-block: 12px; }
body:has(.studio-app) .el-dialog.is-align-center:not(.is-fullscreen) { margin-block: auto; align-self: center; }
body:has(.studio-app) .el-dialog.is-fullscreen { max-width: 100vw; max-height: 100dvh; }
body:has(.studio-app) .el-dialog__header,
body:has(.studio-app) .el-dialog__footer { flex: none; }
body:has(.studio-app) .el-dialog__header { padding-right: 36px; overflow-wrap: anywhere; }
body:has(.studio-app) .el-dialog__body { min-height: 0; overflow: auto; }
body:has(.studio-app) .el-dialog__footer { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
body:has(.studio-app) .el-dialog__footer .el-button + .el-button { margin-left: 0; }
body:has(.studio-app) .el-message-box { max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow: auto; }
body:has(.studio-app) .el-popper { max-width: calc(100vw - 24px); box-sizing: border-box; }
body:has(.studio-app) .el-popover { max-height: calc(100dvh - 24px); overflow-y: auto; }
body:has(.studio-app) .el-dropdown__list { max-height: calc(100dvh - 48px); overflow-y: auto; }
</style>

<style>
.floatingSlot.mobileToolbar {
  overflow: auto;
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: auto;
  width: auto !important;
  z-index: 1000;
  transform: none;
}
.floatingSlot.mobileToolbar .mediaToolbar {
  background: var(--miaoimg-glass-panel);
  border: 1px solid var(--miaoimg-glass-line);
  box-shadow: none;
  backdrop-filter: blur(12px);
}
.floatingSlot.mobileToolbar .mediaToolbar .el-card__body { display: flex; flex-wrap: wrap; gap: 0; }
body:has(.studio-app) .mediaToolbar .el-button { width: 32px; height: 32px; margin: 0; padding: 0; flex-shrink: 0; }
body:has(.studio-app) .mediaToolbar .el-button > span { display: none; }
</style>

<style>
.floatingSlot.mobileToolbar .paintToolbar { flex-wrap: wrap; white-space: normal; }
.floatingSlot.mobileToolbar .paintToolbar > * { flex-shrink: 0; }
</style>

<style src="./canvas-look.css"></style>
