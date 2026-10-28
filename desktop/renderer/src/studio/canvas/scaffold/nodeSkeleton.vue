<template>
  <div v-if="documentTarget" class="nodeDocumentPlaceholder" :style="canvasSize" aria-hidden="true" />
  <teleport :to="documentTarget ?? 'body'" :disabled="!documentTarget">
  <div ref="skeletonElement" v-bind="$attrs" class="nodeSkeleton" :class="{ documentNode: documentTarget }" @wheel.capture="zoomCanvas" @dblclick.stop="focusNode" @contextmenu="documentTarget && openMenu($event)">
    <el-dropdown
      ref="menu"
      :persistent="false"
      trigger="contextmenu"
      virtualTriggering
      :virtualRef="menuAnchor"
      placement="bottom-start"
      :showArrow="false"
      :showTimeout="0"
      :hideTimeout="0"
      @command="handleCommand">
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-if="assetOutputs.length && saveNodeToAssets" command="saveAsset" :icon="IconFolderPlus">{{ translate('保存到素材库') }}</el-dropdown-item>
          <el-dropdown-item v-if="downloadUrl" command="download" :icon="IconDownload">{{ translate('下载') }}</el-dropdown-item>
          <el-dropdown-item :divided="!!((assetOutputs.length && saveNodeToAssets) || downloadUrl)" command="clipboard" :icon="IconClipboardCopy" :disabled="!copyNodeToClipboard || copyingToClipboard">
            {{ translate('复制到剪贴板') }}<span v-if="shortcutHint('copy')" class="shortcutHint">{{ shortcutHint('copy') }}</span>
          </el-dropdown-item>
          <el-dropdown-item command="copy" :icon="IconCopy">{{ translate('创建副本') }}</el-dropdown-item>
          <el-dropdown-item command="duplicate" :icon="IconCopyPlus">{{ translate('创建副本（保留输入连线）') }}</el-dropdown-item>
          <el-dropdown-item divided command="delete" :icon="IconTrash">{{ translate('删除') }}<span v-if="shortcutHint('delete')" class="shortcutHint">{{ shortcutHint('delete') }}</span></el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <teleport to="body" :disabled="!mobileSheet || !!documentTarget">
    <div
      v-if="documentTarget || (topVisible && slotsVisible)"
      class="floatingSlot topSlot nodrag nopan nowheel"
      :class="{ mobileToolbar: mobileSheet && !documentTarget }"
      :style="{ width: typeof topWidth === 'number' ? `${topWidth}px` : topWidth, ...(mobileSheet && !documentTarget ? { top: `${mobileToolbarTop}px`, maxHeight: `${mobileToolbarHeight}px` } : {}) }"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @keydown="event => event.key !== 'Escape' && event.stopPropagation()"
      @contextmenu.stop>
      <slot name="top">
        <el-card class="mediaToolbar" shadow="never" :bodyStyle="{ padding: '6px' }">
          <el-button
            :icon="IconFolderPlus"
            :disabled="!assetOutputs.length || !saveNodeToAssets"
            text
            :title="translate('添加到素材库')"
            :aria-label="translate('添加到素材库')"
            @click.stop="handleCommand('saveAsset')" />
          <slot name="topActions" />
          <el-button
            :tag="downloadUrl ? 'a' : 'button'"
            :href="downloadUrl || undefined"
            :download="downloadName"
            :icon="IconDownload"
            :disabled="!downloadUrl"
            :loading="downloading"
            :aria-busy="downloading"
            text
            :title="downloading ? translate('正在保存…') : translate('下载')"
            :aria-label="translate('下载')"
            @downloadstate="downloading = $event.detail"
            @click.stop />
          <el-button
            :icon="IconMaximize"
            :disabled="fullscreenDisabled ?? !downloadUrl"
            text
            :title="translate('全屏')"
            :aria-label="translate('全屏')"
            @click.stop="emit('fullscreen')" />
        </el-card>
      </slot>
    </div>
    </teleport>
    <teleport to="body" :disabled="!mobileSheet || !!documentTarget">
      <div
        v-if="$slots.bottom && (documentTarget || (bottomVisible && slotsVisible))"
        ref="bottomSlotElement"
        class="floatingSlot bottomSlot nodrag nopan nowheel"
        :class="{ mobileSheet, desktopEditor: !mobileSheet && !documentTarget }"
        :style="{ width: typeof bottomWidth === 'number' ? `${bottomWidth}px` : bottomWidth, ...(mobileSheet && !documentTarget ? { maxHeight: `${mobileSheetHeight}px` } : {}) }"
        @pointerdown.stop
        @mousedown.stop
        @dblclick.stop
        @keydown.stop
        @contextmenu.stop>
        <slot name="bottom" />
      </div>
    </teleport>
    <div v-show="!documentTarget" class="titleBar">
      <component :is="icon ?? IconBox" class="titleIcon" :size="16" aria-hidden="true" />
      <input
        v-if="editingLabel"
        ref="labelInput"
        v-model="labelDraft"
        class="labelInput nodrag nopan"
        :aria-label="translate('节点名称')"
        @pointerdown.stop
        @mousedown.stop
        @dblclick.stop
        @keydown.stop
        @keydown.enter="confirmLabel"
        @keydown.esc.prevent="editingLabel = false"
        @blur="saveLabel" />
      <span
        v-else
        class="labelText"
        tabindex="0"
        :title="translate('{0}（双击编辑名称）', { 0: nodeLabel })"
        @dblclick.stop="editLabel"
        @keydown.enter.stop.prevent="editLabel">
        {{ nodeLabel }}
      </span>
      <span v-if="modelLabel" class="modelLabel" :title="`${translate('生成模型')}：${modelLabel}`">{{ modelLabel }}</span>
      <span v-if="mediaMeta" class="mediaMeta" :title="mediaMetaTitle">{{ mediaMeta }}</span>
      <span v-if="playerDownload" class="playerDownload" :title="translate('已保存平台播放器文件，未确认去水印。')">{{ translate('水印未确认') }}</span>
      <div class="nodeActions nodrag nopan" @pointerdown.stop @mousedown.stop @dblclick.stop>
        <el-button
          :icon="IconRefresh"
          :loading="loading || reloading"
          :disabled="loading || !reloadRemoteNode"
          text
          :title="translate('刷新节点')"
          :aria-label="translate('刷新节点')"
          @click.stop="reloadNode" />
        <el-button :icon="IconX" text :title="translate('移除节点')" :aria-label="translate('移除节点')" @click.stop="deleteNode" :loading="deleting" />
      </div>
    </div>
    <div class="cardContainer">
      <el-card
        class="contentCard"
        :class="{ selected: node.selected }"
        shadow="never"
        :bodyStyle="{ padding: '8px' }"
        :style="{ minHeight: `${cardHeight}px` }">
        <div v-if="loading" class="loadingContent" role="status" :aria-label="translate('节点加载中')">
          <icon-loader2 class="loadingIcon" :size="24" aria-hidden="true" />
          <span>{{ translate('加载中...') }}</span>
        </div>
        <slot v-else-if="previewReady || documentTarget" />
      </el-card>
      <template v-for="group in handleGroups" :key="group.type">
        <handle
          v-for="(item, index) in group.items"
          :id="item.id"
          :key="item.id"
          v-show="!documentTarget"
          class="nodeHandle"
          :class="{
            connected: isHandleConnected(item),
            linking: localStartHandle?.id === item.id && localStartHandle.type === group.type,
          }"
          :type="group.type"
          :connectable="!loading"
          :position="group.position"
          :isValidConnection="validateConnection"
          :data-connection-status="getHandleStatus(item)"
          :style="{ top: `${((index + 1) / (group.items.length + 1)) * 100}%` }"
          :title="handleTitle(item)"
          :aria-label="handleTitle(item)"
          @pointermove="moveHandle"
          @pointerleave="resetHandle"
          @pointercancel="resetHandle">
          <component :is="isHandleConnected(item) ? IconCircleDot : IconCircleDashed" class="handleIcon" :size="18" aria-hidden="true" />
        </handle>
      </template>
    </div>
  </div>
  </teleport>
</template>

<script setup lang="ts">
import { nodeTools, z } from './nodeTools';
import { useNodeFiles } from './workspaceFiles';
import { saveCanvasAsset, type AssetOutput } from '../saveCanvasAsset';
import { computed, inject, nextTick, onScopeDispose, onMounted, ref, shallowRef, watch, watchEffect, type Component, type Ref, type ShallowRef } from "vue";
import { Handle, Position, getTransformForBounds, pointToRendererPoint, useNode, useVueFlow, wheelDelta, type Node } from "@vue-flow/core";
import { deleteCanvasNodes } from "../canvasNodeDeletion";
import { captureCanvasCopyScope, cloneNodeGraph, remapCopiedNodeReferences } from "../nodeCopy";
import {
  IconRefresh,
  IconX,
  IconTrash,
  IconCopy,
  IconCopyPlus,
  IconClipboardCopy,
  IconFolderPlus,
  IconDownload,
  IconMaximize,
  IconBox,
  IconCircleDashed,
  IconCircleDot,
  IconLoader2,
} from "@tabler/icons-vue";
import { ElCard, ElButton, ElDropdown, ElDropdownMenu, ElDropdownItem, ElMessage } from "element-plus";
import type { DropdownInstance } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import type { NodeDocumentContext } from "./nodeDocument";
import { validateConnection } from "./connection";
import { generalSettings } from "@/stores/settings";
import { getShortcutBindings, shortcutLabel, type CanvasShortcutAction } from "@/lib/canvasShortcuts";
import { useNodeEvent } from "./nodeEvent";
import type { NodeConnectionFeedback, NodeData, NodeHandle } from "./connection";
import { isNodeOutput } from "./values";

// 节点属性在本地声明，避免编译期跨文件解析类型。
type SkeletonHandle = { id: string; type: "source" | "target"; dataType: string | string[]; label?: string };
type SkeletonOutput = { dataType: string; value?: unknown };
type SkeletonProps = {
  label?: string;
  modelLabel?: string;
  mediaMeta?: string;
  mediaMetaTitle?: string;
  handles?: SkeletonHandle[];
  outputs?: Record<string, SkeletonOutput | undefined>;
  icon?: Component;
  loading?: boolean;
  previewReady?: boolean;
  topWidth?: string | number;
  bottomWidth?: string | number;
  downloadUrl?: string;
  downloadName?: string;
  fullscreenDisabled?: boolean;
};

const topVisible = defineModel<boolean>("topVisible", { default: false });
const bottomVisible = defineModel<boolean>("bottomVisible", { default: false });
const emit = defineEmits<{ fullscreen: [] }>();
const downloading = ref(false);
const props = withDefaults(defineProps<SkeletonProps>(), {
    handles: () => [],
    outputs: () => ({}),
    previewReady: true,
    fullscreenDisabled: undefined,
    topWidth: "20vw",
    bottomWidth: "20vw",
  }
);
// 节点名是画布数据：展示时按当前语言兜底，写入画布（副本命名）仍用中文原文。
const nodeLabel = computed(() => props.label || translate("未命名节点"));
const playerDownload = computed(() => {
  const value = props.outputs.video?.value;
  return !!value && typeof value === 'object' && value !== null && 'downloadSource' in value && value.downloadSource === 'platform-player';
});
const handleGroups = computed(() => [
  { type: "target" as const, position: Position.Left, items: props.handles.filter((item) => item.type === "target") },
  { type: "source" as const, position: Position.Right, items: props.handles.filter((item) => item.type === "source") },
]);
const cardHeight = computed(() => Math.max(100, ...handleGroups.value.map((group) => (group.items.length + 1) * 44)));
const { id: nodeId, node } = useNode();
const documentContext = inject<NodeDocumentContext | undefined>("nodeDocument", undefined);
const documentTarget = computed(() => documentContext?.targets.get(nodeId));
const skeletonElement = ref<HTMLElement>();
const bottomSlotElement = ref<HTMLElement>();
const canvasSize = shallowRef<{ width: string; height: string }>();
let documentLease: symbol | undefined;
function mountDocument(target: HTMLElement) {
  const element = skeletonElement.value;
  if (!documentContext || !element || !target.isConnected) throw new Error(translate("节点视图尚未就绪"));
  if (!documentTarget.value) canvasSize.value = {
    width: `${element.offsetWidth || node.dimensions.width || 220}px`,
    height: `${element.offsetHeight || node.dimensions.height || 128}px`,
  };
  const lease = Symbol();
  documentLease = lease;
  // ACT: 只移动原节点的界面，保留画布中的运行实例和尺寸；同一节点仅允许一个文档显示位置。
  documentContext.targets.set(nodeId, target);
  return () => {
    if (documentLease !== lease) return;
    documentLease = undefined;
    documentContext.targets.delete(nodeId);
    void nextTick(() => {
      if (!documentTarget.value) updateNodeInternals([nodeId]);
    });
  };
}
watch(() => props.loading, loading => {
  if (loading) {
    if (documentContext?.mounts.get(nodeId) === mountDocument) documentContext.mounts.delete(nodeId);
  } else documentContext?.mounts.set(nodeId, mountDocument);
}, { immediate: true });
onScopeDispose(() => {
  documentLease = undefined;
  if (documentContext?.mounts.get(nodeId) !== mountDocument) return;
  documentContext.mounts.delete(nodeId);
  documentContext.targets.delete(nodeId);
});
const selectionConnection = inject<ShallowRef<NodeConnectionFeedback | undefined>>("selectionConnection");
const nodeEvent = useNodeEvent();
node.isValidTargetPos = (...args) => nodeEvent.emit("canConnect", ...args);
const flow = useVueFlow();
const {
  d3Zoom,
  d3Selection,
  zoomActivationKeyCode,
  zoomOnPinch,
  setViewport,
  minZoom,
  maxZoom,
  viewport,
  vueFlowRef,
  addNodes,
  addEdges,
  toObject,
  getNodes,
  getSelectedNodes,
  findNode,
  addSelectedNodes,
  removeSelectedElements,
  nodesSelectionActive,
  removeEdges,
  updateNodeInternals,
  connectionLookup,
  connectionStartHandle,
  connectionEndHandle,
  connectionStatus,
  onPaneClick,
  onPaneContextMenu,
  onSelectionContextMenu,
  onConnectStart,
  onMoveStart,
  onNodeContextMenu,
  onNodeDragStart,
  onNodeDragStop,
  onSelectionEnd,
  onNodeClick,
  onSelectionStart,
} = flow;
const localStartHandle = computed(() => (connectionStartHandle.value?.nodeId === nodeId ? connectionStartHandle.value : undefined));
const localEndHandle = computed(() => (connectionEndHandle.value?.nodeId === nodeId ? connectionEndHandle.value : undefined));
const localSelectionConnection = computed(() => (selectionConnection?.value?.nodeId === nodeId ? selectionConnection.value : undefined));
const connectedHandles = computed<Set<string>>((previous) => {
  const connected = new Set(
    props.handles.filter((item) => connectionLookup.value.get(`${nodeId}-${item.type}-${item.id}`)?.size).map((item) => `${item.type}-${item.id}`)
  );
  return previous?.size === connected.size && [...connected].every((key) => previous.has(key)) ? previous : connected;
});

async function focusNode(event?: MouseEvent, duration = 300) {
  if (documentTarget.value) return;
  const element = (event?.currentTarget as HTMLElement | undefined) ?? skeletonElement.value;
  if (!element) return;
  await nextTick();
  const flowElement = vueFlowRef.value;
  if (!flowElement || !element.isConnected) return;
  const flowRect = flowElement.getBoundingClientRect();
  const agentWidth = Math.max(0, parseFloat(getComputedStyle(flowElement).getPropertyValue("--agentWidth")) || 0);
  const availableWidth = flowRect.width - agentWidth;
  if (availableWidth <= 0 || flowRect.height <= 0) return;
  const rects = [element, ...element.querySelectorAll<HTMLElement>(":scope > .floatingSlot")]
    .filter((item) => item.getClientRects().length)
    .map((item) => item.getBoundingClientRect());
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const origin = pointToRendererPoint({ x: left - flowRect.left, y: top - flowRect.top }, viewport.value);
  // Keep the selected node and its toolbar below workspace navigation and above canvas controls.
  const workspace = flowElement.closest(".workspacePage");
  const navigationBottom = Math.max(flowRect.top, ...Array.from(workspace?.querySelectorAll<HTMLElement>(".workspaceMenu, .canvasMenuPanel, .panelSwitcher") ?? [])
    .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== "hidden")
    .map(item => item.getBoundingClientRect().bottom));
  const topInset = Math.max(12, navigationBottom - flowRect.top + 12);
  const bottomInset = 80;
  const targetViewport = getTransformForBounds(
    {
      ...origin,
      width: (Math.max(...rects.map((rect) => rect.right)) - left) / viewport.value.zoom,
      height: (Math.max(...rects.map((rect) => rect.bottom)) - top) / viewport.value.zoom,
    },
    // 首帧尚未加载时节点仍是占位尺寸，不按占位框放大到数倍。
    Math.max(100, availableWidth - 24), Math.max(100, flowRect.height - topInset - bottomInset), minZoom.value, Math.max(minZoom.value, Math.min(1, maxZoom.value)), 0.2
  );
  targetViewport.x += 12;
  targetViewport.y += topInset;
  await setViewport(targetViewport, { duration });
}

nodeTools.register({
  name: 'focusNode', description: '聚焦此节点及其编辑工具栏，与双击节点相同，视口会给工作区导航、Agent 面板和底部工具栏让出空间；不改节点内容。',
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    if (documentTarget.value || !skeletonElement.value) throw new Error('请先切回画布并等待节点显示');
    removeSelectedElements(); addSelectedNodes([node]);
    nodesSelectionActive.value = false;
    await focusNode(undefined, 0); signal?.throwIfAborted();
    return { nodeId, viewport: { ...viewport.value } };
  },
});

function zoomCanvas(event: WheelEvent) {
  if (documentTarget.value) return;
  if (document.fullscreenElement) return;
  if (!(zoomActivationKeyCode.value === true || (event.ctrlKey && zoomOnPinch.value)) || !d3Zoom.value || !d3Selection.value) return;
  const bounds = d3Selection.value.node()?.getBoundingClientRect();
  if (!bounds) return;
  event.preventDefault();
  event.stopPropagation();
  d3Zoom.value.scaleBy(d3Selection.value, 2 ** wheelDelta(event), [event.clientX - bounds.left, event.clientY - bounds.top]);
}

const canvasUiActive = inject<Readonly<Ref<boolean>>>("canvasUiActive", ref(true));
const slotsHiddenByInteraction = ref(false);
// ACT: 多选只操作节点；未选中的节点仍可通过 v-model 主动打开槽位。
const slotsVisible = computed(() => (documentTarget.value || canvasUiActive.value) && !slotsHiddenByInteraction.value && (!node.selected || getSelectedNodes.value.length <= 1));
onSelectionStart(() => {
  slotsHiddenByInteraction.value = true;
});
onSelectionEnd(() => { slotsHiddenByInteraction.value = false; });
onNodeDragStop(({ nodes }) => {
  if (nodes.some((item) => item.id === nodeId)) slotsHiddenByInteraction.value = false;
});
onNodeDragStart(({ nodes }) => {
  if (nodes.some((item) => item.id === nodeId)) slotsHiddenByInteraction.value = true;
});
onNodeClick(({ node: clickedNode }) => {
  if (clickedNode.id === nodeId) {
    slotsHiddenByInteraction.value = false;
    if (mobileSheet.value) void focusNode();
  }
});
const editingLabel = ref(false);
// 手机端把生成卡片移到屏幕底部，避免被画布视口裁切。
const mobileSheet = ref(false);
const mobileToolbarTop = ref(0);
const mobileToolbarHeight = ref(200);
const mobileSheetHeight = ref(240);
let workspaceObserver: ResizeObserver | undefined;
function syncDesktopEditor() {
  const element = bottomSlotElement.value;
  if (!element || mobileSheet.value || documentTarget.value || !canvasUiActive.value) {
    for (const property of ["--editor-max-width", "--editor-max-height"]) element?.style.removeProperty(property);
    return;
  }
  const zoom = viewport.value.zoom || 1;
  // Size the editor contents, but never change its node-relative position.
  element.style.setProperty("--editor-max-width", `${Math.max(1, window.innerWidth - 24) / zoom}px`);
  // Reserve room for the fixed toolbar without changing the editor position.
  const toolbar = document.querySelector<HTMLElement>(".vue-flow__panel.bottom.center:has(.canvasControls)");
  const toolbarTop = toolbar?.getBoundingClientRect().top;
  const safeBottom = Math.min(window.innerHeight - 12, Number.isFinite(toolbarTop) ? toolbarTop! - 12 : window.innerHeight - 12);
  // Keep a usable minimum; the editor stays anchored to the node and the
  // fixed toolbar remains available to pan or zoom an off-screen card.
  const top = element.getBoundingClientRect().top;
  const naturalHeight = element.scrollHeight * zoom;
  // The floor scales with zoom so the footer plus a few prompt lines survive
  // at any zoom. Past the window edge the card keeps its shape and the user
  // pans to it, like any other node, instead of a crushed, clipped box.
  const minimumHeight = Math.min(naturalHeight, Math.max(220, 170 * zoom));
  const availableHeight = Math.max(minimumHeight, safeBottom - top);
  element.style.setProperty("--editor-max-height", `${availableHeight / zoom}px`);
}
function syncFloatingEditors() {
  syncMobileToolbar();
  syncDesktopEditor();
}

function syncMobileToolbar() {
  const workspace = skeletonElement.value?.closest(".workspacePage");
  if (!workspace || !mobileSheet.value) return;
  const menuBottom = Math.max(workspace.getBoundingClientRect().top, ...Array.from(workspace.querySelectorAll<HTMLElement>(".workspaceMenu, .canvasMenu, .panelSwitcher"))
    .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== "hidden")
    .map(item => item.getBoundingClientRect().bottom));
  mobileToolbarTop.value = menuBottom + 12;
  // Reserve a full action row above a tall reference/prompt card.
  mobileSheetHeight.value = Math.max(48, workspace.getBoundingClientRect().bottom - 84 - mobileToolbarTop.value - 56);
  const bottom = bottomSlotElement.value?.getBoundingClientRect().top ?? workspace.getBoundingClientRect().bottom - 84;
  mobileToolbarHeight.value = Math.max(44, bottom - mobileToolbarTop.value - 12);
}
watch(bottomSlotElement, (element, previous) => {
  if (previous) workspaceObserver?.unobserve(previous);
  if (element) workspaceObserver?.observe(element);
  void nextTick(syncFloatingEditors);
});
// 浮层避让同时跟随窗口、缩放、画布平移和节点拖动。
let editorSyncFrame: number | undefined;
function scheduleFloatingEditorSync() {
  if (editorSyncFrame !== undefined) return;
  // 没有展开输入框的节点平移时无事可做。
  if (!bottomSlotElement.value && !mobileSheet.value) return;
  editorSyncFrame = window.requestAnimationFrame(() => {
    editorSyncFrame = undefined;
    void nextTick(syncFloatingEditors);
  });
}
watch([
  mobileSheet, topVisible, bottomVisible, canvasUiActive, documentTarget,
  () => viewport.value.x, () => viewport.value.y, () => viewport.value.zoom,
  () => node.position.x, () => node.position.y, () => node.selected,
], scheduleFloatingEditorSync, { immediate: true });
onMounted(() => {
  workspaceObserver = new ResizeObserver(syncFloatingEditors);
  const workspace = skeletonElement.value?.closest(".workspacePage");
  if (workspace) workspaceObserver.observe(workspace);
  if (bottomSlotElement.value) workspaceObserver.observe(bottomSlotElement.value);
  window.addEventListener("resize", syncFloatingEditors);
  syncFloatingEditors();
});
onScopeDispose(() => {
  workspaceObserver?.disconnect();
  if (editorSyncFrame !== undefined) cancelAnimationFrame(editorSyncFrame);
  window.removeEventListener("resize", syncFloatingEditors);
});
const mobileQuery = typeof window === "undefined" ? undefined : window.matchMedia("(max-width: 700px)");
function syncMobileSheet() { mobileSheet.value = mobileQuery?.matches === true; }
syncMobileSheet();
mobileQuery?.addEventListener("change", syncMobileSheet);
onScopeDispose(() => mobileQuery?.removeEventListener("change", syncMobileSheet));
const labelDraft = ref("");
const labelInput = ref<HTMLInputElement>();

const reloadRemoteNode = inject<((type: string) => Promise<void>) | undefined>("reloadRemoteNode", undefined);
const reloading = ref(false);
const deleting = ref(false);
const menu = ref<DropdownInstance>();
const menuAnchor = shallowRef({ getBoundingClientRect: () => new DOMRect() });
onPaneClick(() => menu.value?.handleClose());
onPaneContextMenu(() => menu.value?.handleClose());
onSelectionContextMenu(() => menu.value?.handleClose());
onConnectStart(() => menu.value?.handleClose());
onMoveStart(() => menu.value?.handleClose());
onNodeContextMenu(({ event, node }) => {
  if (node.id === nodeId) void openMenu(event);
  else menu.value?.handleClose();
});

async function reloadNode() {
  if (!reloadRemoteNode || reloading.value) return;
  reloading.value = true;
  try {
    await reloadRemoteNode(node.type);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("节点刷新失败"));
  } finally {
    reloading.value = false;
  }
}

async function openMenu(event: MouseEvent | TouchEvent) {
  event.preventDefault();
  if (documentTarget.value) event.stopPropagation();
  menu.value?.handleClose();
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point) return;
  menuAnchor.value = { getBoundingClientRect: () => new DOMRect(point.clientX, point.clientY, 0, 0) };
  await nextTick();
  menu.value?.handleOpen();
}

const deletionLifetime = new AbortController();
const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
const batchDeletion = inject<((action: () => Promise<void>) => Promise<void>) | undefined>("batchCanvasHistory", undefined);
onScopeDispose(() => deletionLifetime.abort());
async function deleteNode() {
  if (deleting.value) return;
  const signal = canvasSignal ? AbortSignal.any([deletionLifetime.signal, canvasSignal()]) : deletionLifetime.signal;
  deleting.value = true;
  try {
    const remove = async () => { await deleteCanvasNodes(flow, [node], signal); };
    if (batchDeletion) await batchDeletion(remove);
    else await remove();
  } catch (error) {
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    if (!signal.aborted) ElMessage.error(message || (error instanceof Error ? error.message : translate("节点删除失败")));
  } finally {
    deleting.value = false;
  }
}

const copyNodeToClipboard = inject<((node: Node, signal?: AbortSignal) => Promise<unknown>) | undefined>("copyNodeToClipboard", undefined);
const copyLifetime = new AbortController();
onScopeDispose(() => copyLifetime.abort());
const copyingToClipboard = ref(false);
const saveNodeToAssets = inject<((label: string, outputs: AssetOutput[]) => void) | undefined>(
  "saveNodeToAssets",
  undefined
);
const assetOutputs = computed(() =>
  props.handles.flatMap((handle) => {
    const output = props.outputs[handle.id];
    if (handle.type !== "source" || !isNodeOutput(output) || (output.dataType === "STRING" && !output.value.trim())) return [];
    return [{ label: handle.label ?? handle.id, output,
      ...(output.dataType === 'STRING' && node.type === 'remote-textNode' && node.data.textPath === `assets/${nodeId}/content.md` ? { sourcePath: node.data.textPath } : {}),
    }];
  })
);

const assetFiles = useNodeFiles();
nodeTools.register({
  name: 'saveOutputAsAsset', description: '将本节点一个输出另存为项目素材文件，与界面添加到素材库相同。handleId 使用输出端口 ID，path 是项目内相对路径，默认拒绝覆盖已有文件。文本节点另存为 .md/.markdown 时保留图片和附件链接的目标，原正文保持原位。',
  parameters: z.strictObject({ handleId: z.string().min(1), path: z.string().min(1).max(4096) }),
  async execute({ handleId, path }, { signal }) {
    await nodeEvent.emit('save');
    signal?.throwIfAborted();
    const item = assetOutputs.value.find(item => props.outputs[handleId] === item.output);
    if (!item) throw new Error('没有可保存的输出，请先读取节点 outputs/ports');
    return saveCanvasAsset(assetFiles.getWorkspaceFiles(), item.output, path, true, signal, item.sourcePath);
  },
});

async function copySnapshot() {
  copyLifetime.signal.throwIfAborted();
  const patch = await nodeEvent.emit('copy');
  copyLifetime.signal.throwIfAborted();
  if (findNode(nodeId) !== node) throw new Error(translate('节点已切换，请重新操作'));
  const saved = toObject().nodes.find(item => item.id === nodeId);
  if (!saved) throw new Error(translate('节点已切换，请重新操作'));
  return cloneNodeGraph([{ ...saved, data: { ...saved.data, ...patch } }], []).nodes[0]!;
}

// 右键菜单和画布右键一样，在右侧写出设置里当前的快捷键。
function shortcutHint(action: CanvasShortcutAction) {
  const first = getShortcutBindings(generalSettings.value.canvasShortcuts[action] || "")[0];
  return first ? shortcutLabel(first) : "";
}

async function handleCommand(command: string) {
  // 素材默认名会存进素材库，保持画布数据的原始节点名，不写翻译结果。
  if (command === "saveAsset") {
    try {
      await nodeEvent.emit('save');
      if (findNode(nodeId) !== node) throw new Error(translate('节点已切换，请重新操作'));
      saveNodeToAssets?.(props.label || "未命名节点", assetOutputs.value);
    } catch (error) { ElMessage.error(error instanceof Error ? error.message : translate('保存素材失败')); }
    return;
  }
  if (command === "clipboard" && copyNodeToClipboard && !copyingToClipboard.value) {
    copyingToClipboard.value = true;
    try {
      const saved = await copySnapshot();
      await copyNodeToClipboard(saved, copyLifetime.signal);
      if (!copyLifetime.signal.aborted) ElMessage.success(translate("已复制，可在其他画布粘贴"));
    } catch (error) {
      if (!copyLifetime.signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("节点复制失败"));
    } finally {
      copyingToClipboard.value = false;
    }
  }
  if (command === "delete") void deleteNode();
  if (command === "download" && props.downloadUrl) {
    const link = Object.assign(document.createElement("a"), { href: props.downloadUrl, download: props.downloadName || "" });
    link.click();
  }
  if (command === "copy" || command === "duplicate") {
    const scope = captureCanvasCopyScope();
    let snapshot: Node;
    try {
      snapshot = await copySnapshot();
    } catch (error) {
      if (!copyLifetime.signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("节点复制失败"));
      return;
    }
    if (findNode(nodeId) !== node) return;
    const id = crypto.randomUUID();
    const incomingEdges = command === "duplicate" ? toObject().edges.filter((edge) => edge.target === nodeId) : [];
    const copyPosition = { x: node.position.x, y: node.position.y + node.dimensions.height + 32 };
    const nearbyNodes = getNodes.value
      .filter(
        (item) =>
          item.parentNode === node.parentNode &&
          item.position.x < copyPosition.x + node.dimensions.width &&
          item.position.x + item.dimensions.width > copyPosition.x
      )
      .sort((a, b) => a.position.y - b.position.y);
    for (const item of nearbyNodes) {
      if (copyPosition.y < item.position.y + item.dimensions.height + 32 && copyPosition.y + node.dimensions.height + 32 > item.position.y)
        copyPosition.y = item.position.y + item.dimensions.height + 32;
    }
    const edges = incomingEdges.map((edge) => ({ ...JSON.parse(JSON.stringify(edge)), id: crypto.randomUUID(), target: id, selected: false }));
    const copy = {
      ...snapshot,
      id,
      position: copyPosition,
      data: { ...snapshot.data, label: `${props.label || "未命名节点"} - 副本` },
      parentNode: node.parentNode,
    };
    try { remapCopiedNodeReferences([copy], edges, new Map([[nodeId, id]]), getNodes.value, scope); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : translate("节点复制失败")); return; }
    removeSelectedElements();
    addNodes(copy);
    addEdges(edges);
    await nextTick();
    const inserted = findNode(id);
    if (!copyLifetime.signal.aborted && inserted) addSelectedNodes([inserted]);
  }
}

async function editLabel() {
  labelDraft.value = props.label ?? "";
  editingLabel.value = true;
  await nextTick();
  labelInput.value?.select();
}

function saveLabel() {
  if (!editingLabel.value) return;
  const label = labelDraft.value.trim();
  if (label) node.data.label = label;
  editingLabel.value = false;
}

function confirmLabel(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  saveLabel();
}

function moveHandle(event: PointerEvent) {
  if (event.pointerType === "touch") return;
  const element = (event?.currentTarget as HTMLElement | undefined) ?? skeletonElement.value;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 以 Handle 中心为原点，按画布缩放还原距离，限制总偏移半径为 6px。
  const x = ((event.clientX - rect.left - rect.width / 2) / rect.width) * 18;
  const y = ((event.clientY - rect.top - rect.height / 2) / rect.height) * 18;
  const strength = Math.min(0.3, 6 / (Math.hypot(x, y) || 1));
  element.style.setProperty("--handleX", `${x * strength}px`);
  element.style.setProperty("--handleY", `${y * strength}px`);
}

function resetHandle(event: PointerEvent) {
  const element = (event?.currentTarget as HTMLElement | undefined) ?? skeletonElement.value;
  if (!element) return;
  element.style.removeProperty("--handleX");
  element.style.removeProperty("--handleY");
}

// 端口名来自节点定义（固定词表）：展示时按当前语言翻译，写进画布数据的仍是中文原文。
function handleTitle(item: NodeHandle) {
  const dataType = Array.isArray(item.dataType) ? item.dataType.join(" / ") : item.dataType;
  return `${translate(item.label ?? item.id)} · ${dataType}`;
}

function isHandleConnected(item: NodeHandle) {
  return connectedHandles.value.has(`${item.type}-${item.id}`);
}

function getHandleStatus(item: NodeHandle) {
  const selection = localSelectionConnection.value;
  if (selection?.handles.some((handle) => handle.id === item.id && handle.type === item.type)) return selection.status;
  const target = localEndHandle.value;
  return target?.id === item.id && target.type === item.type ? connectionStatus.value : null;
}

watchEffect(() => {
  if (props.loading) return;
  // 仅同步端口快照供跨节点校验；端口状态由具体 node 维护。
  if (JSON.stringify(node.data.handles) !== JSON.stringify(props.handles)) node.data.handles = props.handles.map((item) => ({ ...item }));
});
watchEffect(() => {
  if (props.loading) return;
  // 输出由 node 持有，画布仅共享当前值；不使用 JSON 比较或触发端口重测。
  node.data.outputs = props.outputs;
});
// 比较内容，避免内联数组的新引用触发渲染循环。
watch(
  () => JSON.stringify([props.label, props.handles]),
  () => {
    if (props.loading) return;
    removeEdges((edges) =>
      edges.filter(
        (edge) =>
          (edge.source === nodeId && !props.handles.some((item) => item.type === "source" && item.id === edge.sourceHandle)) ||
          (edge.target === nodeId && !props.handles.some((item) => item.type === "target" && item.id === edge.targetHandle))
      )
    );
    updateNodeInternals([nodeId]);
  },
  { flush: "post" }
);
</script>

<style scoped>
.shortcutHint { margin-left: auto; padding-left: 24px; color: var(--el-text-color-placeholder); font-size: 12px; }
.nodeSkeleton {
  position: relative;
  width: 220px;
  color: var(--el-text-color-primary);
  text-align: left;

  &.documentNode {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100% !important;
    min-width: 0;

    .floatingSlot {
      position: static;
      width: 100% !important;
      transform: none;

      &.topSlot { order: 0; }
      &.bottomSlot { order: 2; }
    }

    .cardContainer {
      order: 1;
      min-width: 0;
    }
  }

  &:hover .cardContainer .nodeHandle .handleIcon {
    opacity: 1;
  }

  &:hover .titleBar .nodeActions {
    visibility: visible;
  }

  &:not(:hover):not(:has(.contentCard.selected)) .titleBar .modelLabel {
    visibility: hidden;
  }

  .floatingSlot {
    position: absolute;
    left: 50%;
    z-index: 2;
    transform: translateX(-50%);

    &.topSlot {
      bottom: calc(100% + 12px);
    }
    &.bottomSlot { top: calc(100% + 12px); }
    &.desktopEditor {
      transform: translateX(-50%);
      max-width: var(--editor-max-width, none);
      max-height: var(--editor-max-height, none);
      overflow: auto;
      border-radius: var(--canvas-card-radius, 16px);
    }

    .mediaToolbar {
      :deep(.el-button) {
        width: 32px;
        height: 32px;
        margin: 0;
        padding: 0;
      }
    }
  }

  .titleBar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px 8px;
    font-size: 14px;
    line-height: 20px;

    .titleIcon {
      flex-shrink: 0;
    }

    .labelText {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: grab;
      user-select: none;

      &:active {
        cursor: grabbing;
      }
    }

    .mediaMeta {
      flex: none;
      margin-left: auto;
      color: var(--el-text-color-secondary);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .labelInput {
      flex: 1;
      min-width: 0;
      width: 100%;
      padding: 0 4px;
      border: 1px solid var(--el-color-primary);
      border-radius: var(--el-border-radius-small);
      outline: none;
      background: var(--el-bg-color);
      color: inherit;
      font: inherit;
      line-height: inherit;
    }

    .modelLabel {
      flex: 0 1 auto;
      min-width: 0;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .nodeActions {
      visibility: hidden;
      display: flex;
      flex-shrink: 0;
      gap: 2px;

      .el-button {
        width: 24px;
        height: 24px;
        margin: 0;
        padding: 0;
      }
    }
  }

  .cardContainer {
    position: relative;

    .contentCard {
      background: var(--miaoimg-glass-node);
      border: 1px solid var(--miaoimg-glass-line);
      border-radius: max(10px, var(--el-border-radius-base));
      box-shadow: none;
      -webkit-backdrop-filter: blur(6px);
      backdrop-filter: blur(6px);
      transition: border-color 120ms ease;
    }

    .contentCard:hover {
      border-color: rgba(244, 243, 238, .25);
    }

    .contentCard.selected {
      border-color: color-mix(in srgb, var(--el-color-primary) 70%, transparent);
    }

    .contentCard .loadingContent {
      display: flex;
      min-height: 84px;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: var(--el-text-color-secondary);
      font-size: 12px;

      .loadingIcon {
        color: var(--el-color-primary);
        animation: nodeLoading 1s linear infinite;
        @media (prefers-reduced-motion: reduce) {
          animation: none;
        }
      }
    }

    .nodeHandle {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: 0;
      background: transparent;
      color: var(--el-text-color-secondary);

      &.vue-flow__handle-left {
        left: -12px;
      }

      &.vue-flow__handle-right {
        right: -12px;
      }

      &::before {
        content: "";
        position: absolute;
        inset: -13px;
        border-radius: 50%;
      }

      .handleIcon {
        pointer-events: none;
        opacity: 0;
        transform: translate(var(--handleX, 0px), var(--handleY, 0px));
        transition: transform 120ms ease-out, opacity 120ms ease-out;
      }

      &.connected .handleIcon,
      &.linking .handleIcon,
      &.connecting .handleIcon,
      &[data-connection-status] .handleIcon {
        opacity: 1;
      }

      &:hover,
      &.linking,
      &.connecting,
      &[data-connection-status="valid"] {
        color: var(--el-color-primary);
      }

      &[data-connection-status="invalid"] {
        color: var(--el-color-danger);
        cursor: not-allowed;
      }

      @media (prefers-reduced-motion: reduce) {
        .handleIcon {
          transform: none;
          transition: none;
        }
      }
    }
  }
}

.playerDownload { flex: none; color: var(--el-color-warning); font-size: 11px; white-space: nowrap; }
@keyframes nodeLoading {
  to {
    transform: rotate(360deg);
  }
}
</style>
