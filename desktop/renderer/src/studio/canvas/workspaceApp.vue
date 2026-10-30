<template>
  <main class="workspacePage" :class="{ settingsOpen: settingsVisible }" :style="{ '--agentWidth': `${agentVisible ? agentWidth : 0}px` }">
    <canvasHost
      :key="workspaceStore.project?.directory"
      ref="canvasPanelRef"
      class="canvasPanel"
      :class="{ backgroundPanel: activePanel !== 'canvas' }"
      :inert="activePanel !== 'canvas'"
      :aria-hidden="activePanel !== 'canvas'"
      :active="activePanel === 'canvas'"
      :settingsVisible="settingsVisible" />
    <keep-alive :max="1">
      <documentPanel
        v-if="activePanel === 'document'"
        :key="workspaceStore.project?.directory"
        ref="documentPanelRef"
        :readNode="readDocumentNode"
        :reloadNode="reloadDocumentNode"
        :saveNode="saveDocumentNode"
        :deleteNode="canvasPanelRef?.deleteDocumentNode"
        :mutateFiles="mutateCanvasFiles"
        :copyFiles="copyCanvasFiles"
        :mountNode="canvasPanelRef?.mountDocumentNode"
        :observeNode="canvasPanelRef?.observeDocumentNode" />
    </keep-alive>
    <el-segmented :modelValue="activePanel" class="panelSwitcher" :class="{ docked: !!panelSwitcherPosition }" :style="panelSwitcherStyle" :options="panelOptions" size="small" :aria-label="translate('切换面板')" @change="switchPanel">
      <template #default="{ item }">
        <span class="panelOption" :title="item.label">
          <component :is="item.icon" :size="16" aria-hidden="true" />
          <span class="panelOptionLabel">{{ item.label }}</span>
        </span>
      </template>
    </el-segmented>
    <span ref="agentButtonAnchor" class="agentButtonAnchor" :style="agentButtonStyle">
      <el-tooltip v-if="!agentVisible" :content="translate('妙图 Agent · 可拖动')" placement="left" :showArrow="false" :hideAfter="0">
        <el-button
          class="agentButton"
          :class="{ active: agentVisible, dragging: agentButtonDragging }"
          :aria-expanded="agentVisible"
          :aria-label="translate('妙图 Agent，可拖动')"
          aria-controls="agentPanel"
          @pointerdown="startAgentButtonDrag"
          @pointermove="moveAgentButton"
          @pointerup="stopAgentButtonDrag"
          @pointercancel="stopAgentButtonDrag"
          @lostpointercapture="stopAgentButtonDrag"
          @click="toggleAgent"></el-button>
      </el-tooltip>
    </span>
    <floatingAgent v-if="agentReady" v-model="agentVisible" @resize="agentWidth = $event" />
  </main>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, onScopeDispose, provide, ref, watch } from "vue";
import axios from "axios";
import { IconLayoutDashboard, IconFileText } from "@tabler/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { useWorkspaceStore } from "@/stores/workspace";
import { useAgentCanvasControl } from "@/lib/agentControl";
import { registerWorkspaceControl, useMcpControl, waitForControlValue } from "@/lib/mcpControl";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import anonymousData from "@/lib/anonymousData";
import canvasHost from "./canvasHost.vue";
import { translate } from "@miaoimg/i18n/vue";
import type { CanvasContext } from "@miaoimg/tool-canvas/runtime";
import type { WorkspaceFileMutator, WorkspaceFileCoordinator } from "@/pages/workspace/canvasFiles";
import { captureWorkspaceSourceEntries, type WorkspaceSourceEntry } from '@/lib/workspaceFileSelection';
import { canvasSchemas, PANEL_TOOLS } from "../../../../../server/canvas-tools";
import { assertCanvasControlTarget } from "../../../../../server/canvas-control-target";

const documentPanel = defineAsyncComponent(() => import("./panels/document/index.vue"));
const floatingAgent = defineAsyncComponent(() => import("./components/floatingAgent.vue"));

const activePanel = ref<"canvas" | "document">("canvas");
const agentReady = ref(false);
onMounted(() => {
  anonymousData.track("workspace.canvas");
  // 默认显示的 Agent 立即加载，不额外等待空闲回调的 1.5–3.5 秒。
  if (agentVisible.value) { agentReady.value = true; return; }
  const host = window as Window & { requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number };
  if (host.requestIdleCallback) host.requestIdleCallback(() => (agentReady.value = true), { timeout: 3500 });
  else window.setTimeout(() => (agentReady.value = true), 1500);
});
const workspaceStore = useWorkspaceStore();
// 面板标签要跟着语言切，所以是 computed；模块级数组只会在 import 时求值一次。
const panelOptions = computed(() => [
  { label: translate("画布"), value: "canvas", icon: IconLayoutDashboard },
  { label: translate("文档"), value: "document", icon: IconFileText },
]);
const agentVisible = ref(false);
const agentWidth = ref(0);
const agentButtonAnchor = ref<HTMLElement>();
const agentButtonPosition = ref<{ left: number; top: number } | null>(null);
const agentButtonDragging = ref(false);
let agentButtonInteraction: {
  pointerId: number;
  element: HTMLElement;
  host: DOMRect;
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  moved: boolean;
} | null = null;
let suppressAgentButtonClick = false;
const settingsVisible = ref(false);
// Canvases stay mounted in the background; only measure the canvas on screen.
function visibleCanvasElement(host: HTMLElement | null | undefined, selector: string) {
  return [...(host?.querySelectorAll<HTMLElement>(selector) || [])].find(item => item.getClientRects().length && item.offsetParent
    && !item.closest("[inert], [aria-hidden='true'], .backgroundPanel") && getComputedStyle(item).visibility === "visible");
}
// Until the user drags it, the orb docks to the right of the bottom tool group.
const agentDockPosition = ref<{ left: number; top: number } | null>(null);
const agentButtonStyle = computed(() => {
  const position = agentButtonPosition.value ?? agentDockPosition.value;
  return position ? { left: `${position.left}px`, top: `${position.top}px`, right: "auto", bottom: "auto" } : undefined;
});
// The canvas/document switcher sits right after the top-left canvas menu.
const panelSwitcherPosition = ref<{ left: number; top: number } | null>(null);
const panelSwitcherStyle = computed(() => panelSwitcherPosition.value
  ? { left: `${panelSwitcherPosition.value.left}px`, top: `${panelSwitcherPosition.value.top}px`, transform: "none" }
  : undefined);
// Watch every canvas menu: switching canvases hides one (size → 0) and shows
// another, and either change re-places the switcher and the docked orb.
const observedCanvasMenus = new WeakSet<HTMLElement>();
const canvasMenuObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => scheduleAgentButtonClamp());
function updatePanelSwitcher() {
  const host = agentButtonAnchor.value?.offsetParent as HTMLElement | null;
  for (const item of host?.querySelectorAll<HTMLElement>(".canvasMenu, .canvasControlsCard") || []) {
    if (!observedCanvasMenus.has(item)) { observedCanvasMenus.add(item); canvasMenuObserver?.observe(item); }
  }
  const element = visibleCanvasElement(host, ".canvasMenu");
  const menu = element?.getBoundingClientRect();
  if (!host || !menu?.width || window.innerWidth <= 700) { panelSwitcherPosition.value = null; return; }
  const hostRect = host.getBoundingClientRect();
  panelSwitcherPosition.value = { left: menu.right - hostRect.left + 8, top: menu.top - hostRect.top + (menu.height - 36) / 2 };
}
function updateAgentDock() {
  updatePanelSwitcher();
  const host = agentButtonAnchor.value?.offsetParent as HTMLElement | null;
  const controls = visibleCanvasElement(host, ".canvasControlsCard")?.getBoundingClientRect();
  if (!host || !controls?.width) { agentDockPosition.value = null; return; }
  const hostRect = host.getBoundingClientRect(), size = 48, gap = 10;
  const left = controls.right - hostRect.left + gap;
  agentDockPosition.value = left + size + 8 <= host.clientWidth
    ? { left, top: controls.top - hostRect.top + (controls.height - size) / 2 }
    : null;
}
const agentButtonStorageKey = computed(() => `miaoimg.agent-button.${workspaceStore.project?.directory || "default"}`);
function clampAgentButtonPosition(left: number, top: number) {
  const host = agentButtonAnchor.value?.offsetParent as HTMLElement | null;
  const width = host?.clientWidth || window.innerWidth;
  const height = host?.clientHeight || window.innerHeight;
  const size = 48, gap = 8;
  let nextLeft = Math.max(gap, Math.min(left, width - size - gap));
  let nextTop = Math.max(gap, Math.min(top, height - size - gap));
  const hostRect = host?.getBoundingClientRect();
  const controls = visibleCanvasElement(host, ".canvasControlsCard")?.getBoundingClientRect();
  if (hostRect && controls) {
    const controlTop = controls.top - hostRect.top;
    const controlLeft = controls.left - hostRect.left;
    const controlRight = controls.right - hostRect.left;
    const controlBottom = controls.bottom - hostRect.top;
    const overlaps = nextLeft + size > controlLeft - gap
      && nextLeft < controlRight + gap
      && nextTop + size > controlTop - gap
      && nextTop < controlBottom + gap;
    if (overlaps) {
      const above = controlTop - size - gap;
      if (above >= gap) nextTop = above;
      else {
        const right = controlRight + gap;
        if (right + size <= width - gap) nextLeft = right;
      }
    }
  }
  return { left: nextLeft, top: nextTop };
}
function restoreAgentButtonPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(agentButtonStorageKey.value) || "null") as { left?: unknown; top?: unknown } | null;
    agentButtonPosition.value = saved && typeof saved.left === "number" && Number.isFinite(saved.left) && typeof saved.top === "number" && Number.isFinite(saved.top)
      ? clampAgentButtonPosition(Number(saved.left), Number(saved.top))
      : null;
  } catch {
    agentButtonPosition.value = null;
  }
}
function startAgentButtonDrag(event: PointerEvent) {
  if (event.button !== 0 || agentButtonInteraction) return;
  const element = event.currentTarget as HTMLElement;
  const anchor = agentButtonAnchor.value;
  const host = anchor?.offsetParent as HTMLElement | null;
  if (!anchor || !host) return;
  const anchorRect = anchor.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  agentButtonInteraction = {
    pointerId: event.pointerId,
    element,
    host: hostRect,
    offsetX: event.clientX - anchorRect.left,
    offsetY: event.clientY - anchorRect.top,
    startX: event.clientX,
    startY: event.clientY,
    moved: false,
  };
  element.setPointerCapture(event.pointerId);
}
function moveAgentButton(event: PointerEvent) {
  const current = agentButtonInteraction;
  if (!current || current.pointerId !== event.pointerId) return;
  if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 4) return;
  current.moved = true;
  agentButtonDragging.value = true;
  event.preventDefault();
  agentButtonPosition.value = clampAgentButtonPosition(
    event.clientX - current.host.left - current.offsetX,
    event.clientY - current.host.top - current.offsetY,
  );
}
function stopAgentButtonDrag(event?: PointerEvent) {
  const current = agentButtonInteraction;
  if (!current || event && current.pointerId !== event.pointerId) return;
  agentButtonInteraction = null;
  agentButtonDragging.value = false;
  if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
  if (!current.moved || !agentButtonPosition.value) return;
  suppressAgentButtonClick = true;
  window.setTimeout(() => { suppressAgentButtonClick = false }, 0);
  try { localStorage.setItem(agentButtonStorageKey.value, JSON.stringify(agentButtonPosition.value)); } catch {}
}
function toggleAgent() {
  if (suppressAgentButtonClick) { suppressAgentButtonClick = false; return; }
  agentVisible.value = !agentVisible.value;
}
function resizeAgentButton() {
  if (agentButtonPosition.value) agentButtonPosition.value = clampAgentButtonPosition(agentButtonPosition.value.left, agentButtonPosition.value.top);
  updateAgentDock();
}
function scheduleAgentButtonClamp() {
  window.requestAnimationFrame(() => resizeAgentButton());
}
watch(agentButtonStorageKey, restoreAgentButtonPosition);
onMounted(() => {
  restoreAgentButtonPosition();
  window.addEventListener("resize", scheduleAgentButtonClamp);
  void nextTick(() => window.setTimeout(scheduleAgentButtonClamp, 600));
  // The canvas toolbar mounts with the canvas; dock again once it has a size.
  for (const delay of [1500, 3000]) window.setTimeout(scheduleAgentButtonClamp, delay);
});
onMounted(() => window.addEventListener("miao-canvas-layout", scheduleAgentButtonClamp));
onBeforeUnmount(() => { window.removeEventListener("resize", scheduleAgentButtonClamp); window.removeEventListener("miao-canvas-layout", scheduleAgentButtonClamp); canvasMenuObserver?.disconnect(); });
const syncSettingsVisible = (event: Event) => { settingsVisible.value = Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open) };
onMounted(() => window.addEventListener("miao-settings-visible", syncSettingsVisible));
onBeforeUnmount(() => window.removeEventListener("miao-settings-visible", syncSettingsVisible));
const canvasPanelRef = ref<InstanceType<typeof canvasHost>>();
useMcpControl();
useAgentCanvasControl();
const documentPanelRef = ref<InstanceType<typeof documentPanel>>();
const mutateCanvasFiles: WorkspaceFileMutator = (directory, change, signal) => {
  if (!canvasPanelRef.value) throw new Error(translate("画布尚未就绪"));
  return canvasPanelRef.value.mutateWorkspaceFiles(directory, change, signal);
};
async function copyCanvasFiles(directory: string, path: string, target: string, signal?: AbortSignal, sourceEntries?: readonly WorkspaceSourceEntry[]) {
  const panel = canvasPanelRef.value;
  if (!panel) throw new Error(translate("画布尚未就绪"));
  const scope = captureWorkspaceScope();
  const assertActive = () => {
    signal?.throwIfAborted();
    assertWorkspaceScope(scope);
    if (workspaceStore.project?.directory !== directory || canvasPanelRef.value !== panel) throw new Error(translate("工作目录已切换"));
  };
  assertActive();
  const selected = sourceEntries?.map(entry => ({ ...entry })) ?? captureWorkspaceSourceEntries((await useWorkspaceFiles(directory).list(undefined, signal)).entries, path);
  assertActive();
  const documents = documentPanelRef.value ?? cachedDocumentPanel;
  await documents?.flushSave();
  assertActive();
  const savedEntries = documents?.adoptMutationEntries(selected) ?? selected;
  return panel.copyWorkspaceFiles(directory, path, target, signal, savedEntries);
}
provide("copyWorkspaceFiles", copyCanvasFiles);
let cachedDocumentPanel: typeof documentPanelRef.value;
watch(documentPanelRef, panel => { if (panel) cachedDocumentPanel = panel; }, { flush: "sync" });
watch(() => workspaceStore.project?.directory, () => { cachedDocumentPanel = undefined; }, { flush: "sync" });
provide("flushCanvasNodeDocuments", async (directory: string, canvasPath: string, nodeIds: readonly string[], signal?: AbortSignal) => {
  const scope = captureWorkspaceScope();
  signal?.throwIfAborted();
  if (workspaceStore.project?.directory !== directory) throw new Error(translate("工作目录已切换"));
  await (documentPanelRef.value ?? cachedDocumentPanel)?.flushNodeDocuments(directory, canvasPath, nodeIds, signal);
  signal?.throwIfAborted();
  assertWorkspaceScope(scope);
  if (workspaceStore.project?.directory !== directory) throw new Error(translate("工作目录已切换"));
});
provide("coordinateWorkspaceFiles", ((directory, change, commit, signal) => {
  const panel = documentPanelRef.value ?? cachedDocumentPanel;
  return panel ? panel.coordinateWorkspaceFiles(directory, change, commit, signal) : commit();
}) satisfies WorkspaceFileCoordinator);
provide("canvas", () => {
  const context = canvasPanelRef.value?.getCanvasContext();
  return context ? agentCanvasContext(context) : undefined;
});
function agentCanvasContext(context: CanvasContext): CanvasContext {
  return {
    get id() { return context.id; },
    get tools() { return context.tools; },
    fork() { return agentCanvasContext(context.fork?.() ?? context); },
    getNodeLabel: context.getNodeLabel?.bind(context),
    async call(request: Parameters<typeof context.call>[0], signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!(await switchPanel("canvas"))) throw new Error(translate("画布面板无法打开"));
      return context.call(request, signal);
    },
  };
}
provide("mentionCanvas", () => canvasPanelRef.value?.mentionSource);
provide("activateCanvasPanel", () => switchPanel("canvas"));

const controlLifetime = new AbortController();
const workspaceBinding = captureWorkspaceScope();
onScopeDispose(() => controlLifetime.abort(new Error(translate("工作区已关闭"))));
registerWorkspaceControl({
  async agentCanvas(canvasId, signal) {
    const panel = await waitForControlValue(() => canvasPanelRef.value, signal);
    return panel.agentCanvas(canvasId, signal);
  },
  getState: () => ({
    directory: workspaceStore.project?.directory ?? null,
    canvasId: canvasPanelRef.value?.canvasId || null,
    panel: activePanel.value,
    tools: canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext()?.tools ?? [] : [],
    document: (documentPanelRef.value ?? cachedDocumentPanel)?.getDocument(false),
    retainedPaths: [...new Set([
      ...(canvasPanelRef.value?.getRetainedPaths() ?? []),
      ...((documentPanelRef.value ?? cachedDocumentPanel)?.getRetainedPaths() ?? []),
    ])],
  }),
  flushSave,
  async call(request, signal) {
    const directory = workspaceStore.project?.directory;
    if (!directory) throw new Error(translate("请先打开工作区"));
    const callSignal = AbortSignal.any([signal, controlLifetime.signal]);
    const checkDirectory = () => {
      callSignal.throwIfAborted();
      if (directory !== workspaceStore.project?.directory) throw new Error(translate("工作区已切换，本次调用已停止"));
    };
    checkDirectory();
    if (request.name === "switchPanel") {
      if (request.args.panel !== "canvas" && request.args.panel !== "document") throw new Error(translate("未知面板"));
      if (!(await switchPanel(request.args.panel))) throw new Error(translate("面板切换失败，请检查文档是否保存成功"));
      checkDirectory();
      return { panel: activePanel.value };
    }
    if (PANEL_TOOLS.some(tool => tool.name === request.name)) {
      const args = canvasSchemas[request.name as keyof typeof canvasSchemas].parse(request.args);
      if (!(await switchPanel("document"))) throw new Error(translate("文档面板无法打开"));
      const panel = await waitForControlValue(() => documentPanelRef.value, callSignal);
      checkDirectory();
      if (request.name === "closeDocument" || request.name === "moveDocument") {
        const result = request.name === "closeDocument" ? await panel.closeDocument(args, callSignal) : await panel.moveDocument(args, callSignal);
        checkDirectory();
        return result;
      }
      if (request.name === "openDocument") await panel.openDocument(args, callSignal);
      if (request.name === "writeDocument") {
        const result = await panel.writeDocument(args, callSignal);
        checkDirectory();
        return result;
      }
      checkDirectory();
      return panel.getDocument();
    }
    if (!(await switchPanel("canvas"))) throw new Error(translate("画布面板无法打开"));
    const context = await waitForControlValue(
      () => (canvasPanelRef.value?.canvasReady ? canvasPanelRef.value.getCanvasContext() : undefined),
      callSignal
    );
    checkDirectory();
    // Panel activation/initialization can yield while the user switches the
    // active canvas. Fence again before handing the call to its context.
    assertCanvasControlTarget(request, { directory, canvasId: context.id });
    return context.call({ name: request.name, args: request.args }, callSignal);
  },
});

async function flushSave() {
  assertCurrentWorkspace();
  await (documentPanelRef.value ?? cachedDocumentPanel)?.flushSave();
  assertCurrentWorkspace();
  await canvasPanelRef.value?.flushSave();
  assertCurrentWorkspace();
}

// Native reload, logout and close save while the Vue tree and local API live.
const unregisterNativeSave = window.miaoDesktop?.registerSaveHandler?.(flushSave);
onScopeDispose(() => unregisterNativeSave?.());

// 切换项目 = 换一个工作区命名空间重新挂载（由外壳负责）。先把画布和文档刷盘，
// 否则正在编辑的内容会跟着这次重挂载丢掉。
const leavingProject = ref(false);
let discardProject = false;
function assertCurrentWorkspace() {
  controlLifetime.signal.throwIfAborted();
  assertWorkspaceScope(workspaceBinding);
}
function currentWorkspace() {
  try { assertCurrentWorkspace(); return true; }
  catch { return false; }
}
// 画布嵌在妙图的 React 外壳里，离开工作区时先把画布与文档刷盘。
onBeforeUnmount(() => { if (!discardProject) void flushSave().catch(() => {}); });

async function exitProject() {
  if (leavingProject.value || !currentWorkspace()) return;
  if (canvasPanelRef.value?.saveBusy) {
    ElMessage.warning(translate("画布操作尚未完成，请稍后再退出"));
    return;
  }
  leavingProject.value = true;
  try {
    try {
      await flushSave();
    } catch (error) {
      if (!currentWorkspace()) return;
      const message = axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data?.message || error.message
        : error instanceof Error ? error.message : translate("项目保存失败");
      const leave = await ElMessageBox.confirm(translate("无法保存项目：{0}。仍然退出将丢弃尚未保存的修改。", { 0: message }), translate("项目未保存"), {
        type: "warning",
        confirmButtonText: translate("仍然退出"),
        cancelButtonText: translate("留在项目"),
        closeOnClickModal: false,
      }).then(() => true, () => false);
      if (!leave || !currentWorkspace()) return;
      discardProject = true;
      (documentPanelRef.value ?? cachedDocumentPanel)?.cancelSave();
      canvasPanelRef.value?.cancelSave();
    }
    if (currentWorkspace()) window.dispatchEvent(new Event("miao-open-home"));
  } finally { leavingProject.value = false; }
}
provide("exitWorkspace", exitProject);

async function switchPanel(value: string | number | boolean) {
  if (value !== "canvas" && value !== "document") return false;
  try {
    const changed = activePanel.value !== value;
    const previousDocument = changed && activePanel.value === "document" ? documentPanelRef.value ?? cachedDocumentPanel : undefined;
    const currentDirectory = workspaceStore.project?.directory;
    activePanel.value = value;
    await nextTick();
    // KeepAlive retains the draft. Panel navigation can continue while its
    // save settles; leaving the workspace still awaits the full save barrier.
    if (previousDocument) void previousDocument.flushSave().catch(error => {
      if (workspaceStore.project?.directory === currentDirectory) ElMessage.error(error instanceof Error ? error.message : translate("文本保存失败"));
    });
    if (changed) anonymousData.track(value === "canvas" ? "workspace.canvas" : "workspace.document");
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("文本保存失败"));
    return false;
  }
}

function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  if (!canvasPanelRef.value) throw new Error(translate("画布尚未就绪"));
  return canvasPanelRef.value.readDocumentNode(directory, canvasPath, nodeId);
}

function reloadDocumentNode(...args: Parameters<InstanceType<typeof canvasHost>["reloadDocumentNode"]>) {
  if (!canvasPanelRef.value) throw new Error(translate("画布尚未就绪"));
  return canvasPanelRef.value.reloadDocumentNode(...args);
}

function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) {
  if (!canvasPanelRef.value) throw new Error(translate("画布尚未就绪"));
  return canvasPanelRef.value.saveDocumentNode(directory, canvasPath, nodeId, handleId, text, expectedText);
}
</script>

<style scoped lang="scss">
.workspacePage {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: transparent;

  .canvasPanel {
    position: absolute;
    inset: 0;

    &.backgroundPanel {
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
    }
  }

  // 右侧 Agent 在窄屏会占住底部右侧，工具条改靠左，保持缩放和节点整理按钮可点。
  @media (max-width: 1100px) {
    :deep(.vue-flow__panel.bottom.center:has(.canvasControls)) {
      right: auto;
      left: 15px;
      transform: none;
    }
    :deep(.vue-flow__panel.bottom.left.canvasViewPanel) { bottom: 60px; }
    :deep(.vue-flow__minimap) { bottom: 120px !important; }
  }

  @media (max-width: 900px) {
    :deep(.canvasMenuPanel) { top: 50px; }
    :deep(.canvasMenu) { margin-left: 0; max-width: calc(100vw - 30px); }
    .panelSwitcher { left: auto; right: 72px; transform: none; }
  }
  @media (max-width: 480px) {
    .panelSwitcher { right: 68px; font-size: 11px; }
    :deep(.vue-flow__panel.bottom.center:has(.canvasControls)) { left: 12px; right: 12px; }
    :deep(.canvasControls) { justify-content: space-between; gap: 2px; }
    :deep(.canvasControls .toolButton) { width: 32px; height: 36px; }
    :deep(.vue-flow__minimap) { bottom: 66px !important; max-width: calc(100vw - 30px); }
    .agentButtonAnchor.agentButtonAnchor { right: 12px; bottom: 78px; }
  }

  // 设置对话框打开时，顶部浮层自动让位。画布仍保留操作区，关闭设置后恢复原位。
  &.settingsOpen {
    .panelSwitcher,
    :deep(.canvasMenuPanel),
    :deep(.canvasMenu),
    :deep(.floatingAgent) {
      visibility: hidden;
      pointer-events: none;
    }

    .agentButtonAnchor {
      visibility: hidden;
      pointer-events: none;
    }

    .panelSwitcher,
    :deep(.canvasMenuPanel),
    :deep(.floatingAgent) {
      display: none;
    }

    :deep(.canvasMenu) {
      display: none;
    }
  }

  .panelSwitcher.docked {
    --el-border-radius-base: 10px;
    min-height: 36px;
    padding: 3px;
    :deep(.el-segmented__item) { min-width: 32px; padding: 0 6px; }
    .panelOptionLabel { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }

  .panelSwitcher {
    --el-border-radius-base: 999px;
    --el-segmented-bg-color: var(--miaoimg-glass-panel);
    --el-segmented-item-selected-color: var(--el-color-primary);
    --el-segmented-item-selected-bg-color: var(--el-color-primary-light-9);
    position: absolute;
    top: 15px;
    left: 50%;
    z-index: 5;
    min-height: 32px;
    padding: 3px;
    border: 1px solid var(--miaoimg-glass-line);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    box-shadow: none;
    font-size: 12px;
    transform: translateX(-50%);

    .panelOption {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 0 3px;
      line-height: 24px;
    }
  }

  .agentButtonAnchor {
    position: absolute;
    right: 20px;
    bottom: 20px;
    z-index: 6;
    display: inline-flex;
  }

  .agentButton {
    width: 48px;
    height: 48px;
    padding: 0;
    border: 1px solid var(--el-border-color-light);
    border-radius: 50%;
    background: linear-gradient(145deg, var(--el-fill-color-light), var(--el-bg-color-overlay));
    color: #f4fffe;
    cursor: grab;
    overflow: hidden;
    isolation: isolate;
    transition: transform 180ms ease;

    &::before,
    &::after {
      content: "";
      position: absolute;
      inset: 5px;
      border-radius: 50%;
      pointer-events: none;
    }

    &::before {
      z-index: -2;
      background: radial-gradient(ellipse at 22% 15%, #a5fff0, transparent 55%), radial-gradient(ellipse at 85% 85%, #a999ff, transparent 60%),
        radial-gradient(ellipse at 85% 20%, #1dd6cb, transparent 55%), linear-gradient(150deg, #12b8c9, #2765ba 65%, #5a5cc4);
      animation: none;
      filter: saturate(0.85);
      transition: filter 180ms ease;
    }

    &::after {
      z-index: -1;
      background: radial-gradient(ellipse at 30% 12%, #ffffff80, transparent 48%), radial-gradient(ellipse at 65% 95%, #17246070, transparent 65%);
      box-shadow: inset 0 1px 2px #ffffff80, inset 0 -2px 4px #14255460;
    }

    &.active::before,
    &:hover::before {
      filter: saturate(1.15);
    }

    &:hover::before,
    &:focus-visible::before,
    &.dragging::before {
      animation: agentFlow 10s linear infinite;
    }

    &:hover {
      transform: translateY(-1px);
    }

    &.dragging {
      cursor: grabbing;
      transform: scale(.96);
    }

    &:active {
      transform: scale(0.95);
    }

    &:focus-visible {
      outline: 2px solid var(--el-color-primary);
      outline-offset: 3px;
    }

    .agentLogo {
      width: 24px;
      height: 24px;
      flex-shrink: 0;
      background: currentColor;
      mask-size: contain;
      mask-position: center;
      mask-repeat: no-repeat;
    }

    @media (prefers-reduced-motion: reduce) {
      transition: none;

      &::before {
        animation: none;
      }
    }
  }
}

@keyframes agentFlow {
  to {
    transform: rotate(360deg);
  }
}

// Agent 浮层会 teleport 到 body，不能靠 workspacePage 的局部选择器收起；设置对话框存在时让它也让位。
:global(body:has(.workspacePage.settingsOpen) .canvasMenu),
:global(body:has(.workspacePage.settingsOpen) .canvasToolbarCard),
:global(body:has(.workspacePage.settingsOpen) .assetLibraryPanel),
:global(body:has(.workspacePage.settingsOpen) .floatingAgent),
:global(body:has(.workspacePage.settingsOpen) .panelSwitcher) {
  visibility: hidden;
  pointer-events: none;
}

:global(body:has(.workspacePage.settingsOpen) .canvasMenu),
:global(body:has(.workspacePage.settingsOpen) .canvasToolbarCard),
:global(body:has(.workspacePage.settingsOpen) .panelSwitcher),
:global(body:has(.workspacePage.settingsOpen) .assetLibraryPanel),
:global(body:has(.workspacePage.settingsOpen) .floatingAgent) {
  display: none;
}
</style>
