<template>
  <teleport to="body">
    <aside
      v-show="visible"
      id="agentPanel"
      class="floatingAgent"
      :class="{ docked, dragging: interaction?.mode === 'move' && interaction.active }"
      :style="panelStyle"
      :aria-label="translate('AI 对话')"
      @pointerdown.capture="startPanelMove"
      @click.capture="suppressMoveClick"
      @lostpointercapture="stopInteraction">
      <div
        v-for="handle in resizeHandles"
        :key="handle.edge"
        class="resizeHandle"
        :class="handle.edge"
        role="separator"
        :aria-label="handle.label"
        :aria-orientation="handle.edge === 'bottom' ? 'horizontal' : handle.edge === 'corner' ? undefined : 'vertical'"
        :aria-valuemin="handle.edge === 'bottom' ? Math.min(240, resizeLimit(handle.edge)) : handle.edge === 'corner' ? undefined : Math.min(320, resizeLimit(handle.edge))"
        :aria-valuemax="resizeLimit(handle.edge)"
        :aria-valuenow="handle.edge === 'bottom' ? height : handle.edge === 'corner' ? undefined : width"
        tabindex="0"
        @pointerdown.stop="startInteraction($event, handle.edge)"
        @keydown="resizeWithKeyboard($event, handle.edge)" />
      <agent v-model="visible">
        <template #menuActions>
          <el-button
            text
            circle
            :aria-label="docked ? translate('切换为悬浮') : translate('停靠到右侧')"
            :title="docked ? translate('切换为悬浮') : translate('停靠到右侧')"
            @click="docked = !docked">
            <icon-app-window-bottom-right v-if="docked" :size="17" aria-hidden="true" />
            <icon-layout-sidebar-right v-else :size="17" aria-hidden="true" />
          </el-button>
        </template>
      </agent>
    </aside>
  </teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { IconLayoutSidebarRight, IconAppWindowBottomRight } from "@tabler/icons-vue";
import agent from "./agent/index.vue";
import { translate } from "@miaoimg/i18n/vue";

const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ resize: [width: number] }>();
const docked = ref(false);
function workspaceBounds() {
  const top = Math.max(0, document.querySelector(".workspacePage")?.getBoundingClientRect().top ?? 0);
  return { width: window.innerWidth, height: Math.max(0, window.innerHeight - top), top };
}
const viewport = reactive(workspaceBounds());
const gap = computed(() => Math.min(15, viewport.width / 2, viewport.height / 2));
const maxWidth = computed(() => Math.max(0, viewport.width - (docked.value ? 0 : gap.value * 2)));
const preferredWidth = ref(400);
const width = computed(() => Math.min(preferredWidth.value, maxWidth.value));
const preferredHeight = ref<number>(640);
const height = computed(() =>
  docked.value ? viewport.height : Math.min(preferredHeight.value ?? Math.max(0, viewport.height - 96), viewport.height - gap.value * 2)
);
const resizeHandles = computed(
  () =>
    [
      { edge: "left", label: translate("从左侧调整对话宽度") },
      ...(docked.value
        ? []
        : [
            { edge: "right", label: translate("从右侧调整对话宽度") },
            { edge: "bottom", label: translate("从下方调整对话高度") },
            { edge: "corner", label: translate("从右下角调整对话大小") },
          ]),
    ] as { edge: ResizeEdge; label: string }[]
);
const left = ref(viewport.width - width.value - gap.value);
const top = ref(viewport.top + gap.value);
const panelStyle = computed(() => ({
  left: `${docked.value ? viewport.width - width.value : left.value}px`,
  top: `${docked.value ? viewport.top : top.value}px`,
  width: `${width.value}px`,
  height: `${height.value}px`,
}));
const interaction = shallowRef<{
  mode: "move" | ResizeEdge;
  pointerId: number;
  element: HTMLElement;
  x: number;
  y: number;
  left: number;
  top: number;
  right: number;
  width: number;
  height: number;
  active: boolean;
}>();
let moveClick: { pointerId: number; until: number } | undefined;
type ResizeEdge = "left" | "right" | "bottom" | "corner";

function movePanel(x: number, y: number) {
  left.value = Math.max(gap.value, Math.min(x, viewport.width - gap.value - width.value));
  top.value = Math.max(viewport.top + gap.value, Math.min(y, viewport.top + viewport.height - gap.value - height.value));
}

function resizeAnchor(edge: ResizeEdge) {
  if (docked.value) return viewport.width;
  return edge === "left" ? left.value + width.value : edge === "right" ? left.value : top.value;
}

function resizeLimit(edge: ResizeEdge, anchor = resizeAnchor(edge)) {
  if (edge === "left") return Math.min(maxWidth.value, anchor - (docked.value ? 0 : gap.value));
  if (edge === "corner") return Math.max(0, viewport.width - gap.value - left.value);
  return Math.max(0, (edge === "right" ? viewport.width : viewport.top + viewport.height) - gap.value - anchor);
}

function resizePanel(edge: ResizeEdge, value: number, anchor = resizeAnchor(edge)) {
  const limit = resizeLimit(edge, anchor);
  const minimum = edge === "bottom" ? 240 : 320;
  const size = Math.min(limit, Math.max(Math.min(minimum, limit), value));
  if (edge === "bottom") preferredHeight.value = size;
  else preferredWidth.value = size;
  if (!docked.value && edge === "left") movePanel(anchor - width.value, top.value);
}

function resizeWithKeyboard(event: KeyboardEvent, edge: ResizeEdge) {
  const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
  if (edge === "bottom" && !vertical) return;
  if ((edge === "left" || edge === "right") && !horizontal) return;
  if (edge === "corner" && !horizontal && !vertical) return;
  event.preventDefault();
  if (vertical) {
    resizePanel("bottom", height.value + (event.key === "ArrowUp" ? -16 : 16));
    return;
  }
  const delta = (event.key === "ArrowLeft" ? -16 : 16) * (edge === "left" ? -1 : 1);
  resizePanel(edge === "corner" ? "right" : edge, width.value + delta);
}

function startPanelMove(event: PointerEvent) {
  moveClick = undefined;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || docked.value) return;
  // The title can be clicked for history or dragged. Other controls and message
  // text retain their normal click, editing, scrolling and selection gestures.
  const title = target.closest(".agentMenu .conversationHistoryTrigger, .agentMenu .conversationTitle");
  if (!title && target.closest("button, input, textarea, select, a, [contenteditable], .el-input, .resizeHandle, .senderResizeHandle, .composerScroll, .el-scrollbar__bar, .el-scrollbar__thumb, .el-popper, .skillPopup, .mentionPopup, .messageMarkdown, .messageReasoning, .messageBubble:not(.agentEmptyState), .senderEditor, p, h1, h2, h3, h4, h5, h6, pre, code, [role='separator'], [role='slider'], [role='menu'], [role='listbox'], [role='dialog']")) return;
  event.stopPropagation();
  startInteraction(event, "move");
}

function suppressMoveClick(event: MouseEvent) {
  if (!moveClick || performance.now() > moveClick.until || event.detail === 0) return;
  if (event instanceof PointerEvent && event.pointerId !== moveClick.pointerId) return;
  moveClick = undefined;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function startInteraction(event: PointerEvent, mode: "move" | ResizeEdge) {
  if (event.button !== 0 || interaction.value || (docked.value && mode !== "left")) return;
  const element = event.currentTarget as HTMLElement;
  if (mode !== "move") {
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
  }
  interaction.value = {
    mode,
    pointerId: event.pointerId,
    element,
    x: event.clientX,
    y: event.clientY,
    left: left.value,
    top: top.value,
    right: docked.value ? viewport.width : left.value + width.value,
    width: width.value,
    height: height.value,
    active: mode !== "move",
  };
}

function moveInteraction(event: PointerEvent) {
  const current = interaction.value;
  if (!current || current.pointerId !== event.pointerId) return;
  if (current.mode === "move") {
    if (!current.active) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
      current.active = true;
      interaction.value = { ...current };
      current.element.setPointerCapture(current.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
    movePanel(current.left + event.clientX - current.x, current.top + event.clientY - current.y);
  }
  else if (current.mode === "left") resizePanel("left", current.width + current.x - event.clientX, current.right);
  else if (current.mode === "right") resizePanel("right", current.width + event.clientX - current.x, current.left);
  else if (current.mode === "bottom") resizePanel("bottom", current.height + event.clientY - current.y, current.top);
  else {
    resizePanel("right", current.width + event.clientX - current.x, current.left);
    resizePanel("bottom", current.height + event.clientY - current.y, current.top);
  }
}

function stopInteraction(event?: PointerEvent) {
  const current = interaction.value;
  if (event && current?.pointerId !== event.pointerId) return;
  if (event?.type === "pointerup" && current?.mode === "move" && current.active) moveClick = { pointerId: current.pointerId, until: performance.now() + 500 };
  interaction.value = undefined;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  if (current?.element === document.activeElement) current.element.blur();
}

function cancelInteraction() { stopInteraction(); }

function resizeViewport() {
  const rightGap = viewport.width - left.value - width.value;
  stopInteraction();
  Object.assign(viewport, workspaceBounds());
  if (!docked.value) movePanel(viewport.width - width.value - rightGap, top.value);
}

watch([visible, docked], () => stopInteraction());
watch(
  [width, height, () => viewport.width, () => viewport.height, () => viewport.top, docked],
  () => {
    if (!docked.value) movePanel(left.value, top.value);
  },
  { flush: "sync" }
);
watch(
  () => (visible.value && docked.value ? width.value : 0),
  (value) => emit("resize", value),
  { immediate: true }
);
const workspaceObserver = new ResizeObserver(resizeViewport);
onMounted(() => {
  const workspace = document.querySelector(".workspacePage");
  if (workspace) workspaceObserver.observe(workspace);
  resizeViewport();
  window.addEventListener("pointermove", moveInteraction, { capture: true, passive: false });
  window.addEventListener("pointerup", stopInteraction, true);
  window.addEventListener("pointercancel", stopInteraction, true);
  window.addEventListener("blur", cancelInteraction);
});
window.addEventListener("resize", resizeViewport);
onBeforeUnmount(() => {
  stopInteraction();
  window.removeEventListener("resize", resizeViewport);
  workspaceObserver.disconnect();
  window.removeEventListener("pointermove", moveInteraction, true);
  window.removeEventListener("pointerup", stopInteraction, true);
  window.removeEventListener("pointercancel", stopInteraction, true);
  window.removeEventListener("blur", cancelInteraction);
});
</script>

<style scoped lang="scss">
.floatingAgent {
  position: fixed;
  z-index: 1001;
  box-sizing: border-box;
  max-width: 100vw;
  max-height: 100dvh;
  border: 1px solid var(--miaoimg-glass-line);
  border-radius: 28px;
  background: var(--miaoimg-glass-panel);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 10px rgb(0 0 0 / .1);

  &.docked {
    border-width: 0 0 0 1px;
    border-radius: 0;
    background: var(--miaoimg-glass-panel);
    box-shadow: none;
  }

  :deep(.agent) {
    border-radius: inherit;
  }
  &:not(.docked) { cursor: grab; }
  :deep(button), :deep(a) { cursor: pointer; }
  :deep(button:disabled) { cursor: not-allowed; }
  :deep(input), :deep(textarea), :deep([contenteditable]), :deep(.messageBubble:not(.agentEmptyState)) { cursor: text; }
  &:not(.docked) :deep(.agentMenu) {
    cursor: grab;
    touch-action: none;
  }
  &:not(.docked) :deep(.conversationHistoryTrigger), &:not(.docked) :deep(.conversationTitle) { cursor: grab; }

  &.dragging {
    user-select: none;
    :deep(.agentMenu) {
      cursor: grabbing;
    }
  }

  .resizeHandle {
    position: absolute;
    z-index: 1;
    touch-action: none;

    &.left,
    &.right {
      top: 0;
      bottom: 5px;
      width: 5px;
      cursor: ew-resize;
    }

    &.left {
      left: 0;
    }
    &.right {
      right: 0;
    }
    &.bottom {
      right: 0;
      bottom: 0;
      left: 0;
      height: 5px;
      cursor: ns-resize;
    }

    &.corner {
      right: 0;
      bottom: 0;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;

      &::after {
        content: "";
        position: absolute;
        right: 3px;
        bottom: 3px;
        width: 7px;
        height: 7px;
        border-right: 2px solid var(--el-color-primary-light-5);
        border-bottom: 2px solid var(--el-color-primary-light-5);
        opacity: .55;
      }
    }

    &:hover,
    &:focus-visible {
      background: var(--el-color-primary-light-5);
    }
  }
}
</style>
