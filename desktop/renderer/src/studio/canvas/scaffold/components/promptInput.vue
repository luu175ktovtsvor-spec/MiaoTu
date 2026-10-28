<template>
  <div class="promptInputWrap nodrag nopan nowheel">
    <el-button
      v-if="expandable"
      class="expandButton"
      :icon="expanded ? IconMinimize : IconMaximize"
      text
      circle
      :title="translate(expanded ? '收起编辑提示词' : '展开编辑提示词')"
      :aria-label="translate(expanded ? '收起编辑提示词' : '展开编辑提示词')"
      @mousedown.prevent
      @click.stop="toggleExpanded" />
    <template v-if="expandMode === 'dialog'">
      <teleport :to="expandedTarget || 'body'" :disabled="!expanded || !expandedTarget">
        <div ref="senderElement" class="promptInput nodrag nopan nowheel" :class="{ expandedInput: expanded }" @keydown.capture="handleMentionKey" @click.capture="previewReference" />
      </teleport>
    </template>
    <div v-else ref="senderElement" class="promptInput nodrag nopan nowheel" :class="{ expandedInput: expanded }" @keydown.capture="handleMentionKey" @click.capture="previewReference" />
  </div>
  <teleport v-if="mentionTarget" :to="mentionTarget">
    <referenceMenu ref="referenceMenuRef" v-model:query="mentionQuery" :connected="references" :candidates="canvasReferences || []" :available-kinds="referenceKinds" :open="mentionVisible" :assets-available="Boolean(openCanvasAssets && connectReference)" @select="selectMenuReference" @close="closeMentionMenu" @assets="openAssets" />
  </teleport>
  <el-dialog v-if="expandable && expandMode === 'dialog'" v-model="expanded" class="promptEditorDialog" width="min(800px, calc(100vw - 24px))" alignCenter appendToBody :show-close="false" :modal="false" :closeOnClickModal="false" @opened="sender?.focus('mark')" @close="expanded = false" @closed="sender?.focus('mark')" @keydown.esc.prevent="expanded = false">
    <div ref="expandedTarget" class="promptExpandedTarget nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop>
      <el-button class="promptCollapseButton" :icon="IconMinimize" text :title="translate('收起编辑提示词')" :aria-label="translate('收起编辑提示词')" @click="expanded = false" />
    </div>
  </el-dialog>
  <el-image-viewer v-if="previewUrl" :urlList="[previewUrl]" teleported @close="previewReferenceId = undefined" />
</template>

<script setup lang="ts">
import { computed, inject, nextTick, ref, shallowRef, watch } from "vue";
import { ElButton, ElDialog, ElImageViewer, ElMessage, useZIndex } from "element-plus";
import { IconMaximize, IconMinimize } from "@tabler/icons-vue";
import { locale, translate } from "@miaoimg/i18n/vue";
import xSender, { type AnyTagProps, type MentionItem } from "x-sender";
import "x-sender/lib/XSender.css";
import { referenceHtml, normalizePromptModel, getPromptText } from "../promptModel";
import type { ReferenceKind, ReferenceMenuItem } from "../referenceMenu";
import referenceMenu from "./referenceMenu.vue";

const props = defineProps<{
  references: (ReferenceMenuItem & { value: string })[];
  canvasReferences?: ReferenceMenuItem[];
  referenceKinds?: ReferenceKind[];
  connectReference?: (id: string) => MentionItem & { value: string };
  // Source string for translate(); text nodes describe writing, media nodes describe a picture.
  placeholder?: string;
  expandable?: boolean;
  expandMode?: "dialog" | "external";
}>();
const model = defineModel<AnyTagProps[][]>({ required: true });
const text = defineModel<string>("text", { default: "" });
const expanded = defineModel<boolean>("expanded", { default: false });
const senderElement = ref<HTMLElement>();
const expandedTarget = ref<HTMLElement>();
const { nextZIndex } = useZIndex();
const previewReferenceId = ref<string>();
const previewUrl = computed(() => String(props.references.find(item => item.id === previewReferenceId.value)?.avatar ?? ""));
let sender: xSender | undefined;
let resetTask: Promise<void> | undefined;
const mentionTarget = shallowRef<HTMLElement>();
const mentionVisible = ref(false), mentionQuery = ref("");
const referenceMenuRef = ref<InstanceType<typeof referenceMenu>>();
const openCanvasAssets = inject<(() => void) | undefined>("openCanvasAssets", undefined);
const referenceMenuEnabled = computed(() => Boolean(props.connectReference || props.references.length || props.canvasReferences?.length || props.referenceKinds?.length));

function closeMentionMenu() {
  sender?.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  sender?.focus("mark");
}
function selectMenuReference(reference: ReferenceMenuItem) {
  chipTrigger = false;
  void insertReference(reference).catch(error => ElMessage.error(error instanceof Error ? error.message : translate("读取引用文件失败")));
}
function openAssets() {
  closeMentionMenu();
  openCanvasAssets?.();
}

async function toggleExpanded() {
  expanded.value = !expanded.value;
  await nextTick();
  sender?.focus("mark");
}

function previewReference(event: MouseEvent) {
  const tag = event.target instanceof Element ? event.target.closest<HTMLElement>(".imageReference[data-reference-id]") : null;
  const reference = props.references.find(item => item.id === tag?.dataset.referenceId);
  if (!reference?.avatar) return;
  event.preventDefault();
  event.stopPropagation();
  sender?.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  previewReferenceId.value = reference.id;
}


// 沿用编辑器的 @ 检测与光标定位；菜单由 Vue 渲染，空分类也能打开。
// 占位候选只维持库的定位生命周期，绝不插入提示词或用作真实参考。
function mentionConfig() {
  if (!referenceMenuEnabled.value) return { dialogTitle: "", callEvery: false, options: [] };
  return { dialogTitle: "", callEvery: false, asyncMatch: async (query: string) => {
    mentionQuery.value = query;
    return [{ id: "miao-reference-menu-anchor", name: "" }];
  } };
}

const normalizeModel = (value: AnyTagProps[][]) => normalizePromptModel(value, props.references);

function releaseNodeFocus(instance: xSender) {
  // ACT: 1.4.6 的排队输入回调仍会聚焦旧 Write；仅让即将移除的节点失效，库支持取消回调后可移除。
  for (const grid of instance.chatEditor.NODES) {
    for (const node of grid.children) {
      if (node.type === "Write" || node.type === "Input") node.focus = () => {};
    }
  }
}

function syncModel(value = sender?.getModel() ?? model.value) {
  // 输入法组字时只同步文本，等 compositionend 后再替换参考标签，保留正在编辑的 DOM。
  const next = sender?.chatEditor.isComposition ? value : normalizeModel(value);
  if (sender && JSON.stringify(sender.getModel()) !== JSON.stringify(next)) {
    const instance = sender;
    const editor = instance.chatElement.richText;
    const selection = instance.getSelection();
    const focused = document.activeElement === editor;
    const endpoints = focused ? [selection.anchorNode, selection.focusNode].map((node, index) => {
      const gridIndex = instance.chatEditor.NODES.findIndex(grid => grid.$el.contains(node));
      const grid = instance.chatEditor.NODES[gridIndex];
      const childIndex = grid?.children.findIndex(child => child.$el.contains(node)) ?? -1;
      const child = grid?.children[childIndex];
      return {
        gridIndex, childIndex,
        text: child?.type === "Write" || child?.type === "Input" ? child.text : undefined,
        offset: index ? selection.focusOffset : selection.anchorOffset,
      };
    }) : [];
    releaseNodeFocus(instance);
    const task = instance.reset({ chatNode: next, clearHistory: false });
    resetTask = task;
    void task.finally(() => { if (resetTask === task) resetTask = undefined; });
    // ACT: reset 同步重建 DOM，但下一帧会强制移到末尾；在此恢复选区，并在 reset 完成前抑制该次聚焦。
    const last = instance.chatEditor.NODES.at(-1)?.children.at(-1);
    if (last?.type === "Write") {
      Object.assign(instance.getCurrentNode(), { instance: last, node: last.$el.children[0].firstChild, offset: last.text.length || 1 });
    }
    const restored = endpoints.map(endpoint => {
      const target = instance.chatEditor.NODES[endpoint.gridIndex]?.children[endpoint.childIndex];
      if ((target?.type !== "Write" && target?.type !== "Input") || target.text !== endpoint.text) return;
      const node = target.type === "Write" ? target.$el.children[0].firstChild : target.$el.children[0].children[0].firstChild;
      if (node?.nodeType !== Node.TEXT_NODE || endpoint.offset > (node.textContent?.length ?? 0)) return;
      return { target, node, offset: endpoint.offset };
    });
    const [anchor, focus] = restored;
    if (anchor && focus) {
      focus.target.focus(focus.offset);
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    } else if (focused && last?.type === "Write") last.focus(-1);
  }
  model.value = next;
  text.value = getPromptText(next);
}


watch(model, (value) => {
  if (sender && JSON.stringify(value) !== JSON.stringify(sender.getModel())) syncModel(value);
}, { deep: true });
watch(referenceMenuEnabled, () => {
  sender?.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  sender?.updateConfig({ mentionConfig: mentionConfig() });
});

watch(() => props.references, async () => {
  const instance = sender;
  if (!instance) return;
  // 等库将本帧的输入 DOM 写回模型后再更新参考，避免用旧文本重建输入框。
  await instance.nextTick();
  if (sender === instance) syncModel();
}, { deep: true });

watch(senderElement, (element, _previous, onCleanup) => {
  if (!element) return;
  const popup = document.createElement("div");
  popup.className = "textNodeMentions nodrag nopan nowheel";
  popup.style.zIndex = String(nextZIndex());
  document.body.appendChild(popup);
  const initialModel: AnyTagProps[][] = model.value.length ? model.value : text.value.split("\n").map(text => [{ type: "Write", text }]);
  const instance = new xSender(element, {
    autoFocus: false,
    placeholder: translate(props.placeholder ?? "描述你想要生成的画面内容，@引用素材"),
    chatStyle: { minHeight: "70px", maxHeight: "180px", fontSize: "14px", lineHeight: "1.6" },
    getPopupContainer: () => popup,
    mentionConfig: mentionConfig(),
    keyboardSendFun: () => false,
    keyboardWrapFun: event => event.key === "Enter" && !event.isComposing,
  });
  sender = instance;
  const mentionDialog = instance.chatElement.dialogRoot.querySelector<HTMLElement>(".chat-mention-dialog-wrap")!;
  mentionDialog.classList.add("hasReferenceMenu");
  const customMenu = document.createElement("div");
  customMenu.className = "referenceMenuHost";
  mentionDialog.appendChild(customMenu);
  mentionTarget.value = customMenu;
  const menuObserver = new MutationObserver(() => { mentionVisible.value = mentionDialog.getClientRects().length > 0; });
  menuObserver.observe(mentionDialog, { attributes: true, attributeFilter: ["class", "style"] });
  // ACT: 弹窗只移动现有编辑器，保留参考标签、光标与撤销记录。
  const syncExpandedEditor = async (visible: boolean) => {
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    instance.updateConfig({ chatStyle: { minHeight: visible ? "100%" : "70px", maxHeight: visible ? "100%" : "180px" } });
    if (!visible) return;
    await nextTick();
    if (sender !== instance || !expanded.value) return;
    instance.focus("mark");
    popup.style.zIndex = String(visible ? Math.max(nextZIndex(), 8100) : nextZIndex());
  };
  const stopExpandedWatch = props.expandMode === "external"
    ? watch(expanded, visible => { void syncExpandedEditor(visible); })
    : watch([expanded, expandedTarget], ([visible]) => { void syncExpandedEditor(visible); });
  const editor = instance.chatElement.richText;
  // ACT: 1.4.6 未检查卸载节点和空 Range 矩形；只适配当前实例，升级到库内修复后可移除。
  const chatEditor = instance.chatEditor as typeof instance.chatEditor & {
    focusFirst(): void;
    focusLast(): void;
    focusMark(): void;
    cursorView(): void;
    insertNodes(nodes: AnyTagProps[][]): Promise<void>;
  };
  for (const method of ["focusFirst", "focusLast", "focusMark"] as const) {
    const focus = chatEditor[method].bind(chatEditor);
    chatEditor[method] = () => {
      if (sender !== instance || !editor.isConnected || !editor.getClientRects().length) return;
      if (method === "focusLast" && resetTask) return;
      if (method === "focusMark" && !editor.contains(instance.getCurrentNode().node)) return chatEditor.focusLast();
      focus();
    };
  }
  const cursorView = chatEditor.cursorView.bind(chatEditor);
  chatEditor.cursorView = () => {
    const selection = instance.getSelection();
    if (sender !== instance || !editor.isConnected || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer) || !range.getClientRects().length || !editor.parentElement?.getClientRects().length) return;
    cursorView();
  };
  const insertNodes = chatEditor.insertNodes.bind(chatEditor);
  chatEditor.insertNodes = async nodes => {
    // 选区粘贴会先异步删除，再插入；关闭输入框后不再创建并聚焦新节点。
    if (sender === instance && editor.isConnected) await insertNodes(nodes);
  };
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", translate("生成提示词"));
  editor.setAttribute("aria-multiline", "true");
  // 切换语言不会重建 x-sender 实例，这里手动把随语言变化的文案同步过去。
  const stopLocaleWatch = watch(locale, () => {
    if (sender !== instance) return;
    instance.updateConfig({
      placeholder: translate(props.placeholder ?? "描述你想要生成的画面内容，@引用素材"),
      mentionConfig: mentionConfig(),
    });
    editor.setAttribute("aria-label", translate("生成提示词"));
  });
  instance.bus.on("textPrompt", xSender.EventSet.EVENT_COMMON_CHANGE, () => syncModel());
  syncModel(initialModel);
  // ACT: XSender 1.4.6 默认复制标签名称；复用库截取的选区模型，仅覆盖纯文本，保留富文本粘贴。
  const copyText = (event: ClipboardEvent) => {
    const copied = event.clipboardData?.getData("application/chat-nodes");
    if (copied) event.clipboardData?.setData("text/plain", getPromptText(JSON.parse(copied)));
  };
  editor.addEventListener("copy", copyText);
  editor.addEventListener("cut", copyText);
  const closeOutside = (event: PointerEvent) => {
    if (!element.contains(event.target as Node) && !popup.contains(event.target as Node)) {
      instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    }
  };
  document.addEventListener("pointerdown", closeOutside, true);
  onCleanup(() => {
    stopExpandedWatch();
    stopLocaleWatch();
    model.value = instance.getModel();
    releaseNodeFocus(instance);
    sender = undefined;
    menuObserver.disconnect();
    mentionVisible.value = false;
    mentionTarget.value = undefined;
    editor.removeEventListener("copy", copyText);
    editor.removeEventListener("cut", copyText);
    document.removeEventListener("pointerdown", closeOutside, true);
    // ACT: 1.4.6 的 destroy 会删除排队回调仍需用到的字段；先走公开清理事件，库修复后可直接 destroy。
    instance.bus.offKeyEvent("textPrompt");
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
    // 清空 asyncMatch，让库中尚未执行的防抖回调只能关闭旧菜单。
    instance.updateConfig({ mentionConfig: { dialogTitle: "", callEvery: false, options: [] } });
    instance.bus.emit(xSender.EventSet.EVENT_COMMON_DESTROY);
    popup.remove();
  });
});

async function insertReference(reference: MentionItem) {
  const instance = sender;
  if (!instance) return;
  const cursor = instance.getCurrentNode();
  const before = cursor.node.textContent?.slice(0, cursor.offset) ?? "";
  const start = before.lastIndexOf("@");
  if (start < 0) return;
  instance.bus.emit(xSender.EventSet.EVENT_COMMON_DIALOG_CLOSE);
  const resolved = props.connectReference?.(reference.id) || props.references.find(item => item.id === reference.id);
  if (!resolved) return;
  // 新连线先更新父组件的参考列表，标签再使用真实的序号；不把画布候选当已连接参考。
  await nextTick();
  if (sender !== instance) return;
  await instance.backspace(start - before.length);
  const current = props.references.find(item => item.id === reference.id);
  if (sender === instance && current) await instance.setHtml(referenceHtml(current));
}

function handleMentionKey(event: KeyboardEvent) {
  if (mentionVisible.value) referenceMenuRef.value?.handleKey(event);
}

// 「画布参考」按钮：在光标处插入 @，复用编辑器自身的 @ 检测打开引用菜单，选中后照常补连线。
// 没选素材就关闭时，删掉按钮插入的 @，不在提示词里留下多余字符。
let chipTrigger = false;
async function openReferenceMenu() {
  const instance = sender;
  if (!instance || !referenceMenuEnabled.value) return;
  instance.focus("mark");
  await instance.setText("@");
  chipTrigger = true;
}
watch(mentionVisible, async visible => {
  if (visible || !chipTrigger) return;
  chipTrigger = false;
  const instance = sender;
  const cursor = instance?.getCurrentNode();
  if (instance && cursor?.node.textContent?.slice(0, cursor.offset).endsWith("@")) await instance.backspace(-1);
});
defineExpose({ openReferenceMenu });
</script>

<style scoped lang="scss">
.promptInputWrap {
  position: relative;
  margin: 12px 0 16px;
  box-sizing: border-box;

  .expandButton {
    position: absolute;
    top: 2px;
    right: 10px;
    z-index: 11;
    width: 24px;
    height: 24px;
    padding: 4px;
    color: var(--el-text-color-secondary);
  }

  &:has(.expandButton) .promptInput {
    :deep(.chat-rich-text > [contenteditable]),
    :deep(.chat-placeholder-wrap) { padding-right: 34px; }
  }
}

.promptInput {
  border-radius: inherit;
}

:global(.promptEditorDialog) {
  display: flex;
  flex-direction: column;
  height: min(582px, calc(100dvh - 180px));
  padding: 0;
  overflow: hidden;
  border: .5px solid var(--canvas-node-border);
  border-radius: 16px;
  background: var(--canvas-node);
  box-shadow: var(--canvas-shadow);
}

:global(.promptEditorDialog .el-dialog__header) { display: none; }
:global(.promptEditorDialog .el-dialog__body) { flex: 1; min-height: 0; padding: 0; overflow: hidden; }
.promptExpandedTarget { position: relative; height: 100%; padding: 50px 14px 14px; overflow: hidden; background: var(--canvas-node); }
.promptCollapseButton {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 12;
  width: 32px;
  height: 32px;
  padding: 0;
  color: var(--canvas-muted);
}

.promptInput,
:global(.textNodeMentions) {
  --chat-primary: var(--el-color-primary);
  --chat-text: var(--el-text-color-primary);
  --chat-text-secondary: var(--el-text-color-regular);
  --chat-text-placeholder: var(--el-text-color-placeholder);
  --chat-box: transparent;
  --chat-card: var(--el-fill-color);
  --chat-highlight: var(--el-color-primary-light-3);
  --chat-highlight-card: var(--el-fill-color);
  --chat-box-shadow: none;
  --chat-rect-padding: 0px;
}

:global(.textNodeMentions) {
  // 编辑器可以透明，挂到 body 的候选菜单必须独立使用实色表面。
  // 同时覆盖库本身读取的变量，避免某个状态回落到透明的 --chat-box。
  --chat-box: var(--canvas-surface, #262626);
  --chat-card: var(--el-fill-color, #363636);
  --chat-box-shadow: var(--canvas-shadow, 0 4px 12px rgb(0 0 0 / .28));
  position: fixed;
  inset: 0;
  color: var(--canvas-text, #f7f7f7);
  font: 13px/1.5 "PingFang SC", Inter, sans-serif;
  pointer-events: none;
}

:global(.textNodeMentions .chat-dialog-wrap .chat-mention-dialog-wrap.chat-view-show) {
  animation: none;
}

:global(.textNodeMentions .chat-dialog-wrap .chat-mention-dialog-wrap) {
  min-width: 200px;
  max-width: calc(100vw - 24px);
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 12px;
  background: var(--chat-box);
  opacity: 1;
  backdrop-filter: none;
  box-shadow: var(--chat-box-shadow);
  pointer-events: auto;
}

:global(.textNodeMentions .hasReferenceMenu > :not(.referenceMenuHost)) {
  display: none !important;
}

.promptInput {
  display: block;
  cursor: text;
  font-size: 14px;
  line-height: 1.6;
  -webkit-user-select: text;
  user-select: text;

  // XSender sizes its editable scroller, but leaves the sibling placeholder
  // at a separate default 16px. Both must use the same text metrics.
  &:deep(.chat-area-wrap) { font-size: inherit; line-height: inherit; }

  &.expandedInput {
    position: relative;
    height: 100%;
    margin: 0;
  }

  &:deep(.imageReference) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin: 0 3px;
    padding: 2px 6px 2px 2px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: var(--el-border-radius-base);
    background: var(--el-fill-color-light);
    color: var(--el-text-color-primary);
    font-size: 12px;
    line-height: 18px;
    white-space: nowrap;
    vertical-align: middle;

    &:has(img) {
      cursor: zoom-in;
    }

    img {
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      object-fit: cover;
      border-radius: 3px;
      pointer-events: none;
    }
  }

  &:deep(.chat-placeholder-wrap) {
    font-style: normal;
  }

  // The placeholder overlays the same first line as the editable content.
  // Moving only the placeholder in expanded mode displaced it from the caret.
  &:deep(.chat-placeholder-wrap) { top: 0; left: 0; right: auto; font-size: inherit; line-height: inherit; }
}
</style>
