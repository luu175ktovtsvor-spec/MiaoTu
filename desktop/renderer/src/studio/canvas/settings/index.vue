<template>
  <component :is="embedded ? 'section' : ElDialog" :class="['settingsDialog', { embeddedSettings: embedded }]"
    :style="dialogTheme" :model-value="embedded ? undefined : visible" @update:model-value="visible = $event"
    :title="embedded ? undefined : translate('设置')" :width="embedded ? undefined : 'min(980px, calc(100vw - 32px))'"
    :modal="embedded ? undefined : false" :lock-scroll="!embedded" :closeOnClickModal="false"
    :append-to-body="!embedded" :alignCenter="!embedded" :role="embedded ? 'dialog' : undefined"
    :aria-modal="embedded ? 'false' : undefined" :aria-labelledby="embedded ? 'settings-page-title' : undefined">
    <header v-if="embedded" class="el-dialog__header settingsEmbeddedHeader">
      <h1 id="settings-page-title" class="el-dialog__title">{{ translate('设置') }}</h1>
      <button class="el-dialog__headerbtn" type="button" :aria-label="translate('关闭设置')" @click="visible = false">
        <IconX class="el-dialog__close" :size="18" aria-hidden="true" />
      </button>
    </header>
    <div class="settings">
      <aside class="sidebar" :aria-label="translate('设置分类')">
        <template v-for="group in groups" :key="group.id">
          <span class="navGroup">{{ group.label }}</span>
          <button v-for="item in group.items" :key="item.id" class="navItem" type="button"
            :aria-label="item.label" :aria-pressed="active.id === item.id" @click="active = item">
            <component :is="item.icon" :size="17" aria-hidden="true" /><span>{{ item.label }}</span>
          </button>
        </template>
      </aside>
      <section class="content" :aria-label="active.label">
        <header class="contentHeader"><h2>{{ active.label }}</h2><p>{{ active.description }}</p></header>
        <div class="contentBody">
          <transition name="el-fade-in" mode="out-in"><keep-alive include="personalization"><component :is="active.component" /></keep-alive></transition>
        </div>
        <div class="contentFooterBar"><div id="settings-footer" class="contentFooter"></div></div>
      </section>
    </div>
  </component>
</template>
<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { defineAsyncComponent, defineComponent, h, shallowRef } from "vue";
import { ElDialog } from "element-plus";
import { IconX } from "@tabler/icons-vue";
import { dialogTheme } from "./dialogTheme";
import { IconPalette, IconKeyboard, IconInfoCircle, IconMessageChatbot, IconPhotoVideo, IconUserCog, IconLanguage, IconComponents, IconSparkles, IconPlugConnected, IconDeviceDesktop, IconWorld } from "@tabler/icons-vue";
const loadingPanel = defineComponent({ setup: () => () => h("div", { class: "settingsLoading", role: "status" }, translate("加载中...")) });
const panels = [
  { id: "ui", get label() { return translate("外观"); }, get description() { return translate("调整颜色、文字大小和圆角，立即生效。"); }, icon: IconPalette, component: defineAsyncComponent({ loader: () => import("./panels/ui.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "language", get label() { return translate("语言"); }, get description() { return translate("选择你熟悉的界面语言。"); }, icon: IconLanguage, component: defineAsyncComponent({ loader: () => import("./panels/language.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "general", get label() { return translate("画布与快捷键"); }, get description() { return translate("调整画布显示、动画和操作习惯。"); }, icon: IconKeyboard, component: defineAsyncComponent({ loader: () => import("./panels/general/index.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "nodes", get label() { return translate("画布节点"); }, get description() { return translate("选择添加节点菜单中显示的创作功能。"); }, icon: IconComponents, component: defineAsyncComponent({ loader: () => import("./panels/nodes.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "skills", get label() { return translate("创作技能"); }, get description() { return translate("选择 Agent 可以使用的创作方法。"); }, icon: IconSparkles, component: defineAsyncComponent({ loader: () => import("./panels/skills.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "languageModel", get label() { return translate("文本模型"); }, get description() { return translate("选择 Agent 和文本节点默认使用的模型。"); }, icon: IconMessageChatbot, component: defineAsyncComponent({ loader: () => import("./panels/languageModel/index.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "mediaModel", get label() { return translate("图片与视频"); }, get description() { return translate("查看模型支持的尺寸、时长、参考素材和积分。"); }, icon: IconPhotoVideo, component: defineAsyncComponent({ loader: () => import("./panels/mediaModel/index.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  ...(window.miaoDesktop ? [{ id: "doubao", get label() { return translate("豆包 与 Dola"); }, get description() { return translate("连接豆包或 Dola 账号，在文本、图片与视频节点中直接使用，并查看用量。"); }, icon: IconWorld, component: defineAsyncComponent({ loader: () => import("./panels/localMedia.vue"), loadingComponent: loadingPanel, delay: 0 }) }] : []),
  { id: "personalization", get label() { return translate("创作偏好"); }, get description() { return translate("告诉 Agent 你的习惯，让后续创作更合心意。"); }, icon: IconUserCog, component: defineAsyncComponent({ loader: () => import("./panels/personalization.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  { id: "mcp", get label() { return "MCP"; }, get description() { return translate("允许外部 Agent 连接妙图，读取和操作当前画布。"); }, icon: IconPlugConnected, component: defineAsyncComponent({ loader: () => import("./panels/mcp/index.vue"), loadingComponent: loadingPanel, delay: 0 }) },
  ...(window.miaoDesktop ? [{ id: "computer", get label() { return translate("本机操作"); }, get description() { return translate("让 Agent 帮你处理电脑上的文件和任务。"); }, icon: IconDeviceDesktop, component: defineAsyncComponent({ loader: () => import("./panels/computer.vue"), loadingComponent: loadingPanel, delay: 0 }) }] : []),
  { id: "about", get label() { return translate("关于妙图"); }, get description() { return translate("应用版本和官网。"); }, icon: IconInfoCircle, component: defineAsyncComponent({ loader: () => import("./panels/about.vue"), loadingComponent: loadingPanel, delay: 0 }) },
];
// 左侧按用途分组，组内顺序与上面的列表一致；只在桌面端出现的面板没有时自动跳过。
const groups = [
  { id: "general", get label() { return translate("通用"); }, ids: ["ui", "language", "general"] },
  { id: "create", get label() { return translate("创作"); }, ids: ["nodes", "skills", "personalization"] },
  { id: "models", get label() { return translate("模型"); }, ids: ["languageModel", "mediaModel", "doubao"] },
  { id: "connect", get label() { return translate("连接"); }, ids: ["mcp", "computer"] },
  { id: "about", get label() { return translate("其他"); }, ids: ["about"] },
].map(group => Object.assign(group, { items: group.ids.map(id => panels.find(panel => panel.id === id)).filter((panel): panel is typeof panels[number] => !!panel) })).filter(group => group.items.length);
defineProps<{ embedded?: boolean }>();
const active = shallowRef(panels[0]!);
const visible = defineModel<boolean>({ default: false });
</script>
<style lang="scss">
.settingsDialog, .settingsSubdialog {
  // 设置界面的统一纵向节奏：整个对话框只有这四个档位，各面板一律引用，
  // 不再自己拍 margin 数字（改间距只改这里）。横向内边距不在这套节奏里。
  //   group   同一组内的标题和它自己的说明（分区标题↔分区说明、行标签↔行说明）
  //   tight   控件和紧随其后的辅助信息（文本框↔字数/按钮、下拉↔模型信息、卡头↔表体）
  //   block   说明/标签 → 下面的控件，也用于分区说明 → 分区正文
  //   section 分区之间、面板内相邻的两张卡片之间
  --settings-gap-group: 6px;
  --settings-gap-tight: 12px;
  --settings-gap-block: 16px;
  --settings-gap-section: 20px;
  --el-dialog-padding-primary: 0;
  --el-fill-color-blank: var(--canvas-soft, rgba(255, 255, 255, .035));
  --el-bg-color-overlay: var(--canvas-surface, #262626);
  --el-border-color: var(--canvas-line, #363636);
  --el-border-color-light: var(--canvas-line, #363636);
  --el-border-color-lighter: color-mix(in srgb, var(--canvas-line, #363636) 82%, transparent);
  --el-text-color-primary: var(--canvas-text, #f7f7f7);
  --el-text-color-regular: var(--canvas-body, #d4d4d4);
  --el-text-color-secondary: var(--canvas-muted, #919191);
  --el-text-color-placeholder: var(--canvas-faint, #737373);
  padding: 0; border: .5px solid var(--canvas-line, #363636); border-radius: 16px;
  background: var(--canvas-surface, #262626);
  backdrop-filter: none; -webkit-backdrop-filter: none;
  box-shadow: var(--canvas-shadow, 0 4px 10px rgba(0, 0, 0, .28)); overflow: hidden;
  .el-dialog__header { margin: 0; padding: 18px 56px 18px 24px; border-bottom: 0; }
  .el-dialog__title { color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; }
  .el-dialog__headerbtn { top: 12px; right: 12px; width: 36px; height: 36px; border-radius: 10px; }
  .el-dialog__headerbtn:hover { background: var(--canvas-hover, rgba(255, 255, 255, .06)); }
  .el-card { --el-card-bg-color: var(--canvas-soft, rgba(255, 255, 255, .035)); --el-card-border-color: transparent; border-radius: 12px; box-shadow: none; }
  .el-input__wrapper, .el-textarea__inner { background: var(--canvas-field, #1f1f1f); }
  .el-button:not(.is-text):not(.is-link):not(.el-button--primary) { --el-button-bg-color: var(--canvas-soft, rgba(255, 255, 255, .035)); }
  .el-button.is-disabled:not(.is-text):not(.is-link) { --el-button-disabled-bg-color: var(--canvas-soft, rgba(255, 255, 255, .035)); --el-button-disabled-text-color: var(--el-text-color-placeholder); --el-button-disabled-border-color: var(--el-border-color-lighter); }
  .el-tag--info { --el-tag-bg-color: var(--canvas-soft, rgba(255, 255, 255, .04)); --el-tag-border-color: transparent; --el-tag-text-color: var(--el-text-color-secondary); }
  .el-alert.is-light { --el-alert-bg-color: var(--canvas-soft, rgba(255, 255, 255, .045)); }
}
.settingsDialog { z-index: 12000 !important; display: flex; flex-direction: column; height: min(720px, calc(100dvh - 64px)); .el-dialog__header { flex-shrink: 0; } .el-dialog__body { flex: 1; min-height: 0; padding: 0; } }
// 嵌在主内容区时只是一个页面，不能沿用弹窗的 12000 层级，否则会盖住账号面板等全局弹层。
.settingsDialog.embeddedSettings { z-index: 1 !important; }
.settingsDialog.embeddedSettings {
  --canvas-bg: var(--color-abyss);
  --canvas-surface: var(--color-surface);
  --canvas-node: var(--color-surface);
  --canvas-field: var(--color-canvas);
  --canvas-line: var(--color-line);
  --canvas-hover-line: var(--color-line-strong);
  --canvas-text: var(--color-ink);
  --canvas-body: var(--color-body);
  --canvas-muted: var(--color-muted);
  --canvas-faint: var(--color-faint);
  --canvas-soft: var(--color-soft, transparent);
  --canvas-hover: var(--color-hover, transparent);
  --el-bg-color: var(--color-abyss);
  --el-bg-color-overlay: var(--color-surface);
  --el-fill-color-blank: var(--color-canvas);
  --el-text-color-primary: var(--color-ink);
  --el-text-color-regular: var(--color-body);
  --el-text-color-secondary: var(--color-muted);
  --el-text-color-placeholder: var(--color-faint);
  --el-border-color: var(--color-line);
  --el-border-color-light: var(--color-line);
  // 从首页打开时不在画布作用域里，Element 的填充色会退回默认浅灰，深色下出现白块。
  --el-fill-color: color-mix(in srgb, var(--color-ink) 8%, var(--color-surface));
  --el-fill-color-light: color-mix(in srgb, var(--color-ink) 5%, var(--color-surface));
  --el-fill-color-lighter: color-mix(in srgb, var(--color-ink) 4%, var(--color-surface));
  --el-fill-color-extra-light: color-mix(in srgb, var(--color-ink) 3%, var(--color-surface));
  --el-fill-color-dark: color-mix(in srgb, var(--color-ink) 12%, var(--color-surface));
  --el-fill-color-darker: color-mix(in srgb, var(--color-ink) 16%, var(--color-surface));
  --el-border-color-lighter: color-mix(in srgb, var(--color-line) 80%, transparent);
  --el-border-color-extra-light: color-mix(in srgb, var(--color-line) 60%, transparent);
  position: absolute;
  inset: 0;
  width: auto;
  height: auto;
  max-width: none;
  max-height: none;
  margin: 0 !important;
  border: 0;
  border-radius: 0;
  background: var(--color-abyss, #141414);
  box-shadow: none !important;
  filter: none !important;
  transform: none !important;
  transition: none !important;
  .el-dialog__header {
    position: relative;
    display: flex;
    height: 54px;
    align-items: center;
    box-sizing: border-box;
    padding: 0 24px;
    border-bottom: .5px solid var(--canvas-line, #363636);
  }
  .el-dialog__title { margin: 0; }
  .el-dialog__headerbtn {
    top: 50%;
    right: 18px;
    transform: translateY(-50%);
  }
  .settings {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    width: 100%;
    height: calc(100% - 54px);
    margin: 0;
  }
  .sidebar {
    gap: 2px;
    padding: 18px 14px 24px;
    border-right: .5px solid var(--canvas-line, #363636);
    background: transparent;
  }
  .navItem { min-height: 36px; padding: 0 12px; border-radius: 9px; }
  .content { align-items: stretch; }
  .contentHeader, .contentBody, .contentFooterBar { width: min(100%, 820px); box-sizing: border-box; margin: 0 auto; }
  .contentHeader { padding: 34px 36px 18px; }
  .contentBody { padding: 4px 36px 40px; }
  .contentFooterBar { padding: 14px 36px 24px; }
}
@media (max-width: 860px) {
  .settingsDialog.embeddedSettings .settings { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .settingsDialog.embeddedSettings .sidebar { flex-direction: row; overflow-x: auto; padding: 10px 14px; border-right: 0; border-bottom: .5px solid var(--canvas-line, #363636); }
  .settingsDialog.embeddedSettings .navGroup { display: none; }
  .settingsDialog.embeddedSettings .navItem { white-space: nowrap; }
}
// 强调色上的文字：设置可以从首页打开，那时画布样式表还没加载，这里自带一份，
// 统一用 --color-accent-ink（浅色强调色配深字，深色强调色配白字）。
.settingsDialog, .settingsSubdialog {
  --settings-accent-ink: var(--canvas-accent-ink, var(--color-accent-ink, #151515));
  .el-button--primary:not(.is-text):not(.is-link) {
    --el-button-bg-color: var(--el-color-primary); --el-button-border-color: var(--el-color-primary); --el-button-text-color: var(--settings-accent-ink);
    --el-button-hover-bg-color: var(--el-color-primary-light-3); --el-button-hover-border-color: var(--el-color-primary-light-3); --el-button-hover-text-color: var(--settings-accent-ink);
    --el-button-active-bg-color: var(--el-color-primary-dark-2); --el-button-active-border-color: var(--el-color-primary-dark-2); --el-button-active-text-color: var(--settings-accent-ink);
    --el-button-disabled-text-color: var(--settings-accent-ink);
  }
  .el-radio-button { --el-radio-button-checked-bg-color: var(--el-color-primary); --el-radio-button-checked-text-color: var(--settings-accent-ink); --el-radio-button-checked-border-color: var(--el-color-primary); }
  .el-segmented { --el-segmented-item-selected-bg-color: var(--el-color-primary); --el-segmented-item-selected-color: var(--settings-accent-ink); }
  .el-switch.is-checked .el-switch__action { background: var(--settings-accent-ink); }
  .el-checkbox__input.is-checked .el-checkbox__inner::after { border-color: var(--settings-accent-ink); }
  .el-tag--primary { --el-tag-text-color: var(--el-text-color-primary); }
  // 辅助文字在浅色和深色下都至少 4.5:1：标签、滑块刻度、info 色文字跟随主题的次要文字色，
  // 不用组件库默认灰或更浅的占位色。
  --el-color-info: var(--el-text-color-secondary);
  .el-tag.el-tag--info { --el-tag-text-color: var(--el-text-color-regular); --el-tag-bg-color: var(--el-fill-color); --el-tag-border-color: var(--el-border-color); }
  .el-tag.el-tag--success { --el-tag-bg-color: color-mix(in srgb, #2fa86b 16%, var(--canvas-surface)); --el-tag-border-color: color-mix(in srgb, #2fa86b 40%, transparent); --el-tag-text-color: color-mix(in srgb, #2fa86b 70%, var(--el-text-color-primary)); }
  .el-slider__marks-text { color: var(--el-text-color-secondary); }
  .el-text--info, .el-text.is-truncated { color: var(--el-text-color-secondary); }
}
// 设置页的卡片和行：每个分区一张卡，行与行之间一条细分隔线，左说明右控件。
.settingsDialog.embeddedSettings {
  .contentHeader h2 { font-size: 22px; letter-spacing: -.01em; }
  .contentBody { display: block; }
  .settingsSection, .preview { margin: 0 0 16px; border: .5px solid var(--canvas-line); border-radius: 14px; background: var(--canvas-surface); box-shadow: none; }
  .settingsSection .sectionHeader { margin-bottom: 14px; }
  .settingsRow { padding: 14px 0; }
  .settingsRow + .settingsRow { border-top: .5px solid var(--canvas-line); }
  .settingsRow:first-child { padding-top: 2px; }
  .settingsRow:last-child { padding-bottom: 2px; }
  .el-radio-group + .settingsSection, .el-segmented + .settingsSection { margin-top: 18px; }
}
body[data-miaoimg-canvas-ui] .settingsDialog.embeddedSettings {
  border: 0 !important;
  border-radius: 0 !important;
  background: var(--color-abyss, #141414) !important;
  box-shadow: none !important;
  filter: none !important;
}
body[data-miaoimg-canvas-ui] .settingsDialog.embeddedSettings .sidebar {
  border-bottom: 0 !important;
  border-right: .5px solid var(--canvas-line, #363636) !important;
}
.settingsSubdialog { .el-dialog__body { padding: 24px 28px; } .el-dialog__footer { padding: 0 28px 24px; } }
body:has(.settingsDialog) .el-modal-dialog:has(.settingsDialog),
body:has(.settingsDialog) .el-overlay-dialog:has(.settingsDialog) { pointer-events: none; }
body:has(.settingsDialog) .settingsDialog { pointer-events: auto; }
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) { .settingsDialog, .settingsSubdialog { background: var(--canvas-surface, #262626); } }
</style>
<style lang="scss" scoped>
.settings { display: grid; grid-template-columns: 184px minmax(0, 1fr); height: 100%; overflow: hidden; }
.sidebar { display: flex; flex-direction: column; gap: 4px; padding: 16px 12px; background: var(--canvas-soft, rgba(255, 255, 255, .035)); overflow-y: auto; }
.navGroup { padding: 14px 12px 6px; color: var(--el-text-color-placeholder); font-size: 11px; font-weight: 600; letter-spacing: .04em; &:first-child { padding-top: 2px; } }
.navItem {
  display: flex; align-items: center; flex-shrink: 0; gap: 10px; min-height: 42px; padding: 0 12px; border: 0; border-radius: 11px;
  background: transparent; color: var(--el-text-color-secondary); font: inherit; font-size: 13px; text-align: start; cursor: pointer;
  &:hover { background: var(--canvas-hover, rgba(255, 255, 255, .06)); color: var(--el-text-color-primary); }
  &[aria-pressed="true"] { background: color-mix(in srgb, var(--el-color-primary) 15%, transparent); color: var(--el-text-color-primary); }
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
  svg { flex-shrink: 0; }
}
.content { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.contentHeader { flex-shrink: 0; padding: 30px 34px 18px; h2 { margin: 0; color: var(--el-text-color-primary); font-size: 20px; font-weight: 600; overflow-wrap: anywhere; } p { max-width: 680px; margin: 8px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; } }
.contentBody { flex: 1; min-width: 0; min-height: 0; padding: 6px 34px 32px; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; :deep(.el-fade-in-enter-active), :deep(.el-fade-in-leave-active) { transition-duration: 100ms; } }
.contentFooterBar { padding: 14px 34px 24px; &:has(> .contentFooter:empty) { display: none; } }
.contentFooter { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 760px) {
  .settings { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .sidebar { flex-direction: row; padding: 10px 12px; overflow-x: auto; }
  .navItem { min-height: 36px; padding: 0 10px; white-space: nowrap; svg { display: none; } }
  .contentHeader { padding: 20px 22px 14px; } .contentBody { padding: 6px 22px 24px; } .contentFooterBar { padding: 10px 22px 18px; }
}
</style>
