<template>
  <div
    ref="canvasElement"
    class="canvas"
    :class="{ edgesHidden: !showEdges, handMode, compositingEnabled: generalSettings.canvasCompositingEnabled }"
    :style="{ '--canvasEdgeColor': generalSettings.canvasEdgeColorMode === 'custom' ? generalSettings.canvasEdgeColor : 'var(--el-color-primary)' }"
    @dblclick="openNodeMenu"
    @wheel.capture="zoomCanvas"
    @gesturestart.capture="zoomCanvas"
    @gesturechange.capture="zoomCanvas"
    @gestureend.capture="zoomCanvas"
    @pointermove="pointerPosition = { x: $event.clientX, y: $event.clientY }"
    @pointerleave="pointerPosition = undefined"
    @dragover="dragFilesOver"
    @drop="dropFiles">
    <vue-flow
      :id="runtimeKey"
      :only-render-visible-elements="false"
      :nodes-draggable="true"
      :node-types="nodeTypes"
      :snap-to-grid="snapEnabled"
      :snap-grid="[16, 16]"
      :min-zoom="0.2"
      :max-zoom="8"
      :nodes-connectable="true"
      :connection-mode="ConnectionMode.Strict"
      :nodes-focusable="false"
      :edges-focusable="false"
      :edges-updatable="false"
      :elevate-nodes-on-select="true"
      :elevate-edges-on-select="false"
      :disable-keyboard-a11y="true"
      :selectNodesOnDrag="false"
      :auto-pan-on-node-drag="false"
      :auto-pan-on-connect="false"
      :zoom-on-double-click="false"
      :zoomOnScroll="false"
      :zoomOnPinch="active && !settingsVisible"
      :panOnScroll="active && !settingsVisible"
      :panOnScrollSpeed="1"
      :panOnDrag="handMode ? true : [1]"
      :panOnScrollMode="PanOnScrollMode.Free"
      :delete-key-code="null"
      :selectionKeyCode="!handMode"
      :selectionMode="SelectionMode.Partial"
      :multi-selection-key-code="null"
      :zoomActivationKeyCode="zoomKeyPressed ? true : null"
      :pan-activation-key-code="null"
      v-model="flowData"
      @connect="addEdges"
      @edgeClick="showEdgeDisconnect"
      @paneClick="edgeDisconnect = undefined"
      @moveStart="edgeDisconnect = undefined"
      :default-edge-options="defaultEdgeOptions">
      <template v-for="type in remoteNodeTypes" :key="type" #[`node-${type}`]="nodeProps">
        <remoteNode
          v-bind="nodeProps"
          :component="nodeTypes[type]"
          :error="nodeErrors[type]"
          :loading="nodeLoads.has(type) || (nodeListLoading && !nodeTypes[type] && !nodeErrors[type])" />
      </template>
      <background variant="dots" :gap="22" :size="1.1" pattern-color="var(--miaoimg-canvas-grid)" />
      <canvasMenu ref="canvasMenuRef" v-model:canvasId="canvasId" :directory="project?.directory" :initialCanvasId="initialCanvasId" :activateCanvas="activateCanvas" :flushSave="flushCanvases ?? flushCanvasSave" @loaded="bindCanvasSnapshot">
        <assetLibrary ref="assetLibraryRef" v-model="assetsVisible" :directory="project?.directory" :active="props.active" :flowId="runtimeKey" />
      </canvasMenu>
      <canvasControls
        ref="canvasControlsRef"
        v-model:assetsVisible="assetsVisible"
        v-model:snapEnabled="snapEnabled"
        v-model:showEdges="showEdges"
        :canvasId="canvasId"
        :directory="project?.directory"
        :batchHistory="canvasHistory.batch"
        :handMode="selectedTool === 'hand'"
        :canUndo="canUndo"
        :canRedo="canRedo"
        @addNode="addNodeFromToolbar"
        @tool="selectedTool = $event"
        @undo="changeHistory('undo')"
        @redo="changeHistory('redo')"
        @update:showEdges="edgeDisconnect = undefined" />
      <nodeMenu
        :key="JSON.stringify(['menu', project?.directory, canvasId])"
        ref="nodeMenuRef"
        :remoteNodes="availableNodes"
        :pasteNode="pasteClipboardNode"
        :uploadFiles="canvasId && project?.directory ? selectFiles : undefined"
        :canUndo="canUndo"
        :canRedo="canRedo"
        :selectionBusy="selectionToolbarRef?.busy"
        :batchHistory="canvasHistory.batch"
        @duplicateSelection="selectionToolbarRef?.operate('duplicate')"
        @history="canvasHistory.commit"
        @undo="changeHistory('undo')"
        @redo="changeHistory('redo')" />
      <selectionToolbar
        :key="JSON.stringify(['selection', project?.directory, canvasId])"
        ref="selectionToolbarRef"
        :batchHistory="canvasHistory.batch"
        :getSignal="() => canvasController.signal"
        :disabled="!canvasId || !project?.directory" />
      <nodeSearch ref="nodeSearchRef" :disabled="!active || settingsVisible || !canvasId || !project?.directory" />
    </vue-flow>
    <div v-if="canvasSaveError" class="canvasSaveNotice" role="alert">
      <span>{{ canvasSaveError }}</span>
      <button type="button" :disabled="copyingConflict" @click="saveConflictCopy">{{ copyingConflict ? '正在刷新…' : '刷新画布' }}</button>
    </div>
    <teleport to="body">
      <el-button
        v-if="edgeDisconnect && findEdge(edgeDisconnect.id)"
        class="edgeDisconnect"
        type="danger"
        circle
        :aria-label="translate('断开连接')"
        :title="translate('断开连接')"
        :style="{ left: `${edgeDisconnect.x}px`, top: `${edgeDisconnect.y}px` }"
        @click.stop="
          removeEdges(edgeDisconnect.id);
          edgeDisconnect = undefined;
        "
        @mouseleave="edgeDisconnect = undefined">
        <icon-unlink :size="16" />
      </el-button>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { hasCanvasMarker, normalizeCanvasDocument } from '../../../../../server/canvas-document.ts';
import { isProtectedWorkspacePath } from '../../../../../server/workspace-path';
import { computed, defineAsyncComponent, defineComponent, h, inject, markRaw, nextTick, onBeforeUnmount, onMounted, onScopeDispose, provide, ref, shallowReactive, shallowRef, watch } from "vue";
import axios from "axios";
import { mergeCanvasState, validCanvas, persistentCanvas } from "../../../../../server/canvas-state.ts";
import { usePendingInsert } from './usePendingInsert';
import { debounce } from "lodash-es";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import { IconUnlink } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import type { NodeDocumentContext, NodeDocumentState } from "@miaoimg/nodes-scaffold/nodeDocument";
import "element-plus/dist/index.css";
import {
  VueFlow,
  PanOnScrollMode,
  ConnectionMode,
  SelectionMode,
  useVueFlow,
  wheelDelta,
  isNode,
  type Node,
  type Edge,
  type GraphEdge,
  type EdgeMouseEvent,
  type NodeTypesObject,
  type XYPosition,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { useCanvasTools } from "./useCanvasTools";
import type { CanvasContext } from "@miaoimg/tool-canvas/runtime";
import { loadNodeComponent, loadNodeCatalog } from "./loadNodeComponent";
import { useCanvasHistory } from "./useCanvasHistory";
import { reloadCanvasNodeText } from "./canvasDocumentReload";
import { onBeforeCanvasNodeDeletion } from "./canvasNodeDeletion";
import { copyNodeToClipboard, copyCanvasNodes, cloneCanvasSnapshot, pasteCanvasNodes, nodeClipboardCommand, readClipboardNodes } from "./nodeClipboard";
import { readClipboardText, readClipboardFiles } from "@/lib/clipboard";
import nodeMenu from "./components/nodeMenu.vue";
import remoteNode from "./components/remoteNode.vue";
import canvasMenu from "./components/canvasMenu.vue";
import canvasControls from "./components/canvasControls.vue";
import assetLibrary from "./components/assetLibrary.vue";
import groupNode from "./components/groupNode.vue";
import selectionToolbar from "./components/selectionToolbar.vue";
import nodeSearch from "./components/nodeSearch.vue";
import { finishGroupDrag, getSelectionTree } from "./selectionNodes";
import type { NodeOutput } from "@miaoimg/nodes-scaffold/values";
import type { NodeConnectionFeedback, NodeHandle } from "@miaoimg/nodes-scaffold/connection";
import { useNodeEvent } from "@miaoimg/nodes-scaffold/nodeEvent";
import { useNodeToolsContext } from "@miaoimg/nodes-scaffold/nodeTools";
import { useWorkspaceStore } from "@/stores/workspace";
import { generalSettings, nodeSettings } from "@/stores/settings";
import { getShortcutBindings, shortcutLabel, shortcutMatches, shortcutPressed } from "@/lib/canvasShortcuts";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { createFileRevisionOwner, type WorkspaceSourceEntry } from "@/lib/workspaceFileSelection";
import anonymousData from "@/lib/anonymousData";
import { dropCanvasFiles, importCanvasFiles, importReferenceFiles, isCanvasFileDrag, getClipboardMediaFiles } from "./canvasDrop";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";
import textNode from "./nodes/textNode.vue";
import imageNode from "./nodes/imageNode.vue";
import imageGenerationNode from "./nodes/imageGenerationNode.vue";
import videoGenerationNode from "./nodes/videoGenerationNode.vue";
import videoNode from "./nodes/videoNode.vue";
import audioNode from "./nodes/audioNode.vue";
import { migrateNodeTypes } from "./nodes/migrateNodeTypes";
import { IconCube3dSphere } from "@tabler/icons-vue";

// 3D 导演台带 three.js（约 1.8MB），按需加载，避免拖慢落地页与档案库首屏。
const directorPlaceholder = defineComponent({
  render: () => h("div", { class: "nodeSkeleton", style: "width:320px;min-height:160px", role: "status", "aria-label": "节点加载中" }),
});
const director3dNode = markRaw(Object.assign(defineAsyncComponent({
  loader: () => import("./nodes/director3dNode/index.vue"),
  loadingComponent: directorPlaceholder,
  delay: 120,
}), {
  icon: IconCube3dSphere,
  handles: [{ id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO"], label: "文本、图片、视频输入" }],
}));

const props = withDefaults(defineProps<{
  active?: boolean;
  settingsVisible?: boolean;
  runtimeKey?: string;
  initialCanvasId?: string;
  activateCanvas?: (canvasId: string, signal?: AbortSignal) => Promise<void>;
  workspaceSignal?: AbortSignal;
  resolveCanvasContext?: (canvasId: string) => CanvasContext | undefined;
  flushCanvases?: (action?: () => Promise<void>) => Promise<void>;
}>(), { active: true, settingsVisible: false });
const { project } = storeToRefs(useWorkspaceStore());
const workspaceStore = useWorkspaceStore();

const canvasElement = ref<HTMLElement>();
const flowData = ref<(Node | Edge)[]>([]);
const canvasId = ref("");
const nodeMenuRef = ref<InstanceType<typeof nodeMenu>>();
const canvasMenuRef = ref<InstanceType<typeof canvasMenu>>();
const canvasControlsRef = ref<InstanceType<typeof canvasControls>>();
const selectionToolbarRef = ref<InstanceType<typeof selectionToolbar>>();
const nodeSearchRef = ref<InstanceType<typeof nodeSearch>>();
const modelNodes = {
  "remote-textNode": markRaw(textNode),
  "remote-imageNode": markRaw(imageNode),
  "remote-imageGenerationNode": markRaw(imageGenerationNode),
  "remote-videoGenerationNode": markRaw(videoGenerationNode),
  "remote-videoNode": markRaw(videoNode),
  "remote-audioNode": markRaw(audioNode),
  "remote-director3dNode": markRaw(director3dNode),
};
const builtinNodeTypes = new Set(Object.keys(modelNodes));
const nodeTypes = shallowRef<NodeTypesObject>({ canvasGroup: markRaw(groupNode), ...modelNodes });
const nodeConfigs = shallowRef<Record<string, Record<string, unknown>>>({});
const nodeOptions = ref<{ type: string; label: string }[]>([
  { type: "remote-textNode", label: "文本" },
  { type: "remote-imageNode", label: "图片" },
  { type: "remote-imageGenerationNode", label: "图片生成" },
  { type: "remote-videoGenerationNode", label: "视频生成" },
  { type: "remote-videoNode", label: "视频" },
  { type: "remote-audioNode", label: "音频" },
  { type: "remote-director3dNode", label: "3D导演台" },
]);
const nodeLoads = shallowReactive(new Map<string, Promise<void>>());
const nodeReloads = new Set<string>();
const nodeErrors = ref<Record<string, string>>({});
const canvasDirty = ref(false);
const canvasSaveError = ref("");
const availableNodes = computed(() => {
  // 设置面板里关掉的节点不进"添加节点"菜单；画布上已有的节点不受影响。
  const disabled = new Set(nodeSettings.value.disabledNodeTypes);
  return nodeOptions.value.filter(node => nodeTypes.value[node.type] && !nodeErrors.value[node.type] && !disabled.has(node.type));
});
const nodeListLoading = ref(false);
const remoteNodeTypes = computed(() => [
  ...new Set((flowData.value as { type?: string }[]).map((item) => item.type).filter((type): type is string => !!type?.startsWith("remote-"))),
]);
// 画布里有当前没装插件的节点类型时给出明确入口：上游这部分靠在线插件市场，我们只支持本地安装。
const warnedMissingNodes = new Set<string>();
watch([remoteNodeTypes, () => nodeListLoading.value, canvasId], ([types, loading, id]) => {
  if (loading || !id || !types.length) return;
  const missing = types.filter((type) => !nodeOptions.value.some((item) => item.type === type));
  if (!missing.length || warnedMissingNodes.has(`${id}:${missing.join(",")}`)) return;
  warnedMissingNodes.add(`${id}:${missing.join(",")}`);
  ElMessage.warning({
    message: translate("画布里的 {0} 需要先安装插件才能显示和编辑：设置 → 节点与工具 → 安装插件，选对应的 .umd.js。", { 0: missing.join(translate("、")) }),
    grouping: true,
  });
}, { flush: "post" });
let loadRequest = 0;
const snapEnabled = ref(false);
const zoomKeyPressed = ref(false);
const panKeyPressed = ref(false);
const selectedTool = ref<"move" | "hand">("move");
const handMode = computed(() => props.active && !props.settingsVisible && (selectedTool.value === "hand" || panKeyPressed.value));
let pointerPosition: XYPosition | undefined;
const pressedCodes = new Set<string>();
let gestureScale: number | undefined;
const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
let copyingNodes = false;
const showEdges = ref(true);
const assetsVisible = ref(false);
const assetLibraryRef = ref<InstanceType<typeof assetLibrary>>();
const edgeDisconnect = ref<{ id: string; x: number; y: number }>();
const flow = useVueFlow(props.runtimeKey);
onScopeDispose(anonymousData.observeCanvas(() => props.active && canvasId.value
  ? { nodes: flow.nodes.value, edgeCount: flow.edges.value.length }
  : undefined));
let dragCopy: ReturnType<InstanceType<typeof selectionToolbar>["startDragCopy"]>;
function finishDragCopy() {
  const copy = dragCopy;
  dragCopy = undefined;
  copy?.finish();
  return copy;
}
onScopeDispose(finishDragCopy);
flow.onNodeDragStart(({ event, nodes }) => {
  finishDragCopy();
  if (!props.active || props.settingsVisible) return;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const withEdges = shortcutPressed(event, shortcuts.duplicateOnDrag, pressedCodes);
  if (withEdges || shortcutPressed(event, shortcuts.copyOnDrag, pressedCodes)) {
    dragCopy = selectionToolbarRef.value?.startDragCopy(nodes, withEdges);
  }
});
flow.onNodeDrag(() => dragCopy?.update());
flow.onNodeDragStop(({ nodes }) => {
  if (!finishDragCopy()) finishGroupDrag(flow.getNodes.value, nodes);
});
const canvasHistory = useCanvasHistory(flow, () =>
  project.value?.directory && canvasId.value ? JSON.stringify([project.value.directory, canvasId.value]) : ""
);
const { canUndo, canRedo } = canvasHistory;
provide("batchCanvasHistory", canvasHistory.batch);
const getNodeTools = useNodeToolsContext();
const { addNodes, addEdges, removeEdges, findEdge, findNode, toObject, viewport, setViewport, screenToFlowCoordinate } = flow;
provide("copyNodeToClipboard", (node: Parameters<typeof copyNodeToClipboard>[0], signal?: AbortSignal) =>
  copyNodeToClipboard(node, project.value?.directory ?? "", signal ? AbortSignal.any([signal, canvasController.value.signal]) : canvasController.value.signal));
provide("retainNodeFiles", true);
provide("canvasUiActive", computed(() => props.active && !props.settingsVisible));
provide("selectionConnection", shallowRef<NodeConnectionFeedback>());
provide("saveNodeToAssets", (label: string, outputs: import('./saveCanvasAsset').AssetOutput[]) => assetLibraryRef.value?.openSave(label, outputs));
const canvasController = shallowRef(new AbortController());
provide("canvasOperationSignal", () => canvasController.value.signal);
provide("persistCanvasTaskBinding", async () => {
  const id = canvasId.value, directory = project.value?.directory, signal = canvasController.value.signal;
  if (!id || !directory) throw new Error(translate("画布尚未就绪"));
  await flushCanvasSave();
  signal.throwIfAborted();
  if (canvasId.value !== id || project.value?.directory !== directory) throw new Error(translate("工作目录或画布已切换，请重新操作"));
});
const flushNodeDocuments = inject<((directory: string, canvasPath: string, nodeIds: readonly string[], signal?: AbortSignal) => Promise<void>) | undefined>("flushCanvasNodeDocuments", undefined);
onScopeDispose(onBeforeCanvasNodeDeletion(flow, async (nodeIds, signal) => {
  if (!flushNodeDocuments) return;
  const directory = project.value?.directory, id = canvasId.value;
  if (!directory || !id) throw new Error(translate("画布尚未就绪"));
  const lifetime = canvasController.value.signal;
  const callSignal = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  await flushNodeDocuments(directory, id, nodeIds, callSignal);
  callSignal.throwIfAborted();
  if (project.value?.directory !== directory || canvasId.value !== id) throw new Error(translate("工作目录或画布已切换，请重新操作"));
}));
let workspaceController = new AbortController();

const acknowledgeInsert = inject<(id: string, kind: import('@/stores/workspace').PendingCanvasInsert['kind']) => void>('pendingCanvasInsertAck', undefined);
usePendingInsert({
  pending: () => workspaceStore.pendingInsert,
  take: () => workspaceStore.takeInsert(),
  ready: () => !!(props.active && canvasId.value && project.value?.directory),
  binding: () => JSON.stringify([project.value?.directory, canvasId.value]),
  signal: () => canvasController.value.signal,
  nodes: () => flow.getNodes.value,
  save: () => flushCanvasSave(),
  acknowledge: insert => acknowledgeInsert?.(insert.id, insert.kind),
  onInsertError: error => ElMessage.error(translate(error instanceof Error ? error.message : '画布尚未就绪')),
  insert(insert) {
    const rect = canvasElement.value?.getBoundingClientRect();
    const position = rect
      ? screenToFlowCoordinate({ x: rect.left + rect.width / 2 - 160, y: rect.top + Math.min(rect.height / 2, 280) })
      : { x: 0, y: 0 };
    const id = crypto.randomUUID();
    if (insert.kind === "text") {
      addNodes({
        id,
        type: "remote-textNode",
        position,
        data: { label: insert.label || "案例提示词", text: insert.text, outputs: { text: { dataType: "STRING", value: insert.text } } },
      });
    } else {
      addNodes({
        id,
        type: "remote-imageNode",
        position,
        data: {
          label: insert.label || "案例参考图",
          outputs: { image: { dataType: "IMAGE", value: { url: insert.path, mimeType: insert.mimeType || "image/jpeg" } } },
        },
      });
    }
    const inserted = findNode(id);
    if (inserted) flow.addSelectedNodes([inserted]);
    return inserted;
  },
});

const copyWorkspaceFiles = inject<import("@/pages/workspace/canvasFiles").WorkspaceFileCopier>("copyWorkspaceFiles");
const createCanvasContext = useCanvasTools({
  async copyCanvasFiles(directory, path, target, signal) {
    if (!copyWorkspaceFiles) throw new Error(translate("工作区尚未就绪，无法复制画布"));
    await copyWorkspaceFiles(directory, path, target, signal);
  },
  availableNodes,
  flushSave: flushCanvasSave,
  directory: () => { if (!project.value?.directory) throw new Error('请先打开项目'); return project.value.directory; },
  history: canvasHistory,
  interactionBusy: () => !!selectionToolbarRef.value?.busy || flow.getNodes.value.some(node => node.dragging || node.resizing),
  view: () => ({ snapToGrid: snapEnabled.value, showEdges: showEdges.value, showMap: !!canvasControlsRef.value?.showMap, showAssets: assetsVisible.value, handMode: selectedTool.value === 'hand' }),
  setView(args) {
    if (typeof args.snapToGrid === 'boolean') snapEnabled.value = args.snapToGrid;
    if (typeof args.showEdges === 'boolean') { showEdges.value = args.showEdges; edgeDisconnect.value = undefined; }
    if (typeof args.showMap === 'boolean' && canvasControlsRef.value) canvasControlsRef.value.showMap = args.showMap;
    if (typeof args.showAssets === 'boolean') assetsVisible.value = args.showAssets;
    if (typeof args.handMode === 'boolean') selectedTool.value = args.handMode ? 'hand' : 'move';
  },
  menu() {
    if (!canvasMenuRef.value) throw new Error(translate("画布菜单尚未就绪"));
    return canvasMenuRef.value;
  },
  getCanvasBinding: () => ({ id: canvasId.value, signal: canvasController.value.signal }),
  resolveCanvasContext: id => props.resolveCanvasContext?.(id),
});
function getCanvasContext() {
  // 画布删除会卸载单个实例，工作区仍存活；跨画布调用使用宿主的工作区生命周期。
  return canvasId.value ? createCanvasContext(canvasId.value, canvasController.value.signal, props.workspaceSignal ?? workspaceController.signal) : undefined;
}
const canvasReady = computed(() => !!canvasId.value && !nodeListLoading.value && nodeLoads.size === 0);
provide("canvas", getCanvasContext);
defineExpose({ canvasId, canvasReady, getCanvasContext, readDocumentNode, reloadDocumentNode, saveDocumentNode, mountDocumentNode, observeDocumentNode, adoptMutationEntries,
  async createCanvasCopy(signal: AbortSignal) {
    const id = canvasId.value, revision = canvasBaseRevision;
    if (!id || !revision) throw new Error(translate("画布尚未保存，无法复制"));
    const canvas = await cloneCanvasSnapshot(flow, signal);
    signal.throwIfAborted();
    if (canvasId.value !== id || canvasBaseRevision !== revision) throw new Error(translate("画布已变化，请重新复制"));
    return { path: id, revision, canvas: { ...cloneCanvas(canvasBase), ...canvas } };
  },
  refreshCanvases: () => canvasMenuRef.value?.refreshCanvases(),
  mutateWorkspaceFiles: (...args: Parameters<InstanceType<typeof canvasMenu>["mutateWorkspaceFiles"]>) => {
    if (!canvasMenuRef.value) throw new Error(translate("画布菜单尚未就绪"));
    return canvasMenuRef.value.mutateWorkspaceFiles(...args);
  }, flushSave: flushCanvasSave, cancelSave: cancelCanvasSave,
  getMentionNodes: () => flow.nodes.value, findMentionNode: flow.findNode,
  getRetainedNodes: canvasHistory.getRetainedNodes,
  get saveBusy() { return savePaused; }, get loadError() { return canvasMenuRef.value?.loadError ?? ""; },
});

type DocumentNodeData = { label?: string; handles?: NodeHandle[]; outputs?: Record<string, NodeOutput | undefined>; textPath?: string };

function checkDocumentDirectory(directory: string) {
  if (!directory || directory !== project.value?.directory) throw new Error(translate("工作目录已切换，请重新打开节点"));
}

function documentHandles(node: Node<DocumentNodeData>) {
  const handles = node.data?.handles;
  if (Array.isArray(handles) && handles.length) {
    return handles.filter(
      (handle) =>
        handle &&
        typeof handle.id === "string" &&
        handle.type === "source" &&
        (Array.isArray(handle.dataType) ? handle.dataType.includes("STRING") : handle.dataType === "STRING")
    );
  }
  return Object.entries(node.data?.outputs ?? {}).flatMap(([id, output]) => (output?.dataType === "STRING" ? [{ id, label: id }] : []));
}

async function readDocumentCanvas(directory: string, canvasPath: string, nodeId: string) {
  checkDocumentDirectory(directory);
  const files = useWorkspaceFiles(directory);
  const snapshot = await files.readSnapshot<{ miaoimgCanvas?: boolean; nodes?: Node<DocumentNodeData>[] }>(canvasPath);
  if (!snapshot) throw new Error(translate("节点已删除，请刷新文件树"));
  const { canvas } = snapshot;
  checkDocumentDirectory(directory);
  if (!hasCanvasMarker(canvas) || !Array.isArray(canvas.nodes)) throw new Error(translate("文件不是有效画布"));
  const node = canvas.nodes.find((item) => item && item.id === nodeId);
  if (!node) throw new Error(translate("节点已删除，请刷新文件树"));
  if (node.data !== undefined && (!node.data || typeof node.data !== "object" || Array.isArray(node.data))) throw new Error(translate("节点数据无效"));
  const liveNode = canvasId.value === canvasPath ? findNode(nodeId) : undefined;
  if (canvasId.value === canvasPath && !liveNode) throw new Error(translate("节点已删除，请刷新文件树"));
  const textPath = node.data?.textPath;
  if (isProtectedWorkspacePath(textPath)) throw new Error(translate("节点不能读取或修改供应商配置"));
  if (node.type === 'remote-textNode' && textPath !== undefined && textPath !== `assets/${node.id}/content.md`) {
    throw new Error(translate("文本文件路径无效"));
  }
  if (
    textPath !== undefined &&
    (typeof textPath !== "string" ||
      !textPath.trim() ||
      /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(textPath) ||
      textPath.includes("\0") ||
      textPath.split(/[\\/]/).includes(".."))
  )
    throw new Error(translate("文本文件路径必须位于工作区内"));
  return { files, canvas, node, liveNode, textPath, revision: snapshot.revision };
}

async function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  checkDocumentDirectory(directory);
  await flushCanvasSave();
  const { files, node, liveNode, textPath } = await readDocumentCanvas(directory, canvasPath, nodeId);
  const source = liveNode ?? node;
  const handles = documentHandles(source);
  if (!handles.length) throw new Error(translate("节点没有文本输出，请刷新文件树"));
  const storedText = textPath === undefined ? undefined : await files.readText(textPath);
  checkDocumentDirectory(directory);
  return documentTextSnapshot(source, textPath, storedText);
}

function documentTextSnapshot(source: Node<DocumentNodeData>, textPath?: string, storedText?: string) {
  const handles = documentHandles(source);
  if (!handles.length) throw new Error(translate("节点没有文本输出，请刷新文件树"));
  return {
    label: typeof source.data?.label === "string" ? source.data.label : source.id,
    outputs: handles.map((handle) => {
      const output = source.data?.outputs?.[handle.id];
      return {
        id: handle.id,
        label: handle.label || handle.id,
        text: output?.dataType === "STRING" && typeof output.value === "string" ? output.value : storedText ?? "",
        ...(textPath !== undefined ? { path: textPath } : {}),
      };
    }),
  };
}

async function reloadDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, savedText: string, draftText: string, signal?: AbortSignal) {
  checkDocumentDirectory(directory);
  if (canvasId.value !== canvasPath) throw new Error(translate("工作目录或画布已切换，请重新操作"));
  const lifetime = canvasController.value.signal;
  const callSignal = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
  const original = findNode(nodeId);
  callSignal.throwIfAborted();
  const { liveNode } = await readDocumentCanvas(directory, canvasPath, nodeId);
  callSignal.throwIfAborted();
  if (!original || liveNode !== original) throw new Error(translate("节点已变化，请重新操作"));
  const node = await reloadCanvasNodeText(flow, getNodeTools(), nodeId, handleId, savedText, draftText, () => nodeDocument.states.get(nodeId), callSignal);
  checkDocumentDirectory(directory);
  callSignal.throwIfAborted();
  return documentTextSnapshot(node, node.data.textPath);
}

async function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string) {
  checkDocumentDirectory(directory);
  await flushCanvasSave(async () => {
    const originalLive = canvasId.value === canvasPath ? findNode(nodeId) : undefined;
    const liveBase = originalLive ? cloneCanvas(canvasBase) : undefined;
    const { files, canvas, node, liveNode, textPath, revision } = await readDocumentCanvas(directory, canvasPath, nodeId);
    if (originalLive && liveNode !== originalLive) throw new Error(translate("节点已变化，请重新操作"));
    if (!documentHandles(liveNode ?? node).some((handle) => handle.id === handleId)) throw new Error(translate("文本输出已删除，请重新打开节点"));
    const storedBody = textPath !== undefined && liveNode?.type !== "remote-textNode"
      ? await files.readTextSnapshot(textPath) : undefined;
    checkDocumentDirectory(directory);
    if (expectedText !== undefined) {
      const output = (liveNode ?? node).data?.outputs?.[handleId];
      const currentText = output?.dataType === "STRING" && typeof output.value === "string" ? output.value
        : textPath === undefined ? "" : storedBody?.text ?? await files.readText(textPath);
      if (currentText !== expectedText && currentText !== text) {
        throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
      }
      // The current window can still show the old output before its remote
      // refresh. Check the saved output too, before adopting its new revision.
      if (textPath === undefined) {
        const storedOutput = node.data?.outputs?.[handleId];
        const storedText = storedOutput?.dataType === "STRING" && typeof storedOutput.value === "string" ? storedOutput.value : "";
        if (storedText !== expectedText && storedText !== text) {
          throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
        }
      }
      if (storedBody && storedBody.text !== expectedText && storedBody.text !== text) {
        throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
      }
    }
    const delegatedText = liveNode?.type === "remote-textNode";
    const liveOutputBeforeSave = liveNode?.data.outputs?.[handleId];
    const liveTextBeforeSave = liveOutputBeforeSave?.dataType === "STRING" ? liveOutputBeforeSave.value : undefined;
    const liveTextPathBeforeSave = liveNode?.data.textPath;
    if (liveNode && !delegatedText && textPath !== undefined && liveTextPathBeforeSave !== textPath) {
      throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
    }
    if (delegatedText) {
      await getNodeTools().call({ nodeId, name: "node:setText", args: { text, ...(expectedText !== undefined ? { expectedText } : {}) } }, canvasController.value.signal);
      checkDocumentDirectory(directory);
    }
    if (textPath !== undefined) {
      if (storedBody) await files.writeText(textPath, text, storedBody.revision);
    } else {
      const base = cloneCanvas(canvas);
      const data = (node.data ??= {});
      const output = data.outputs?.[handleId];
      if (output?.dataType === "STRING") output.value = text;
      else (data.outputs ??= {})[handleId] = { dataType: "STRING", value: text };
      const saved = await files.saveCanvas(canvasPath, canvas, base, revision);
      checkDocumentDirectory(directory);
      if (liveNode && liveNode === originalLive && liveBase && canvasId.value === canvasPath && findNode(nodeId) === liveNode) {
        await acceptCanvasSnapshot(saved, liveBase, revision);
      }
    }
    checkDocumentDirectory(directory);
    if (liveNode && canvasId.value === canvasPath) {
      if (findNode(nodeId) !== liveNode) throw new Error(translate("节点已变化，请重新操作"));
      const output = liveNode.data.outputs?.[handleId];
      const currentText = output?.dataType === "STRING" ? output.value : undefined;
      // setText and the inline canvas merge already publish their own result.
      // A later edit must not be overwritten again after their awaited save.
      if (delegatedText || textPath === undefined) {
        if (currentText !== text || delegatedText && liveNode.data.textPath !== `assets/${nodeId}/content.md`) {
          throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
        }
      } else {
        if (liveNode.data.textPath !== liveTextPathBeforeSave || currentText !== liveTextBeforeSave && currentText !== text) {
          throw Object.assign(new Error(translate("文档内容已变化，请重新读取后编辑")), { response: { status: 409 } });
        }
        if (output?.dataType === "STRING") output.value = text;
      }
    }
    canvasMenuRef.value?.syncDocumentNode(canvasPath, nodeId, handleId, text, textPath === undefined);
  });
}

// 文档面板投射节点界面与订阅节点状态：对应上游 canvas/index.vue 的
// observeDocumentNode / mountDocumentNode，供 ExtContext.mountNode 使用。
function observeDocumentNode(directory: string, canvasPath: string, nodeId: string, onState: (state: NodeDocumentState) => void) {
  checkDocumentDirectory(directory);
  if (canvasId.value !== canvasPath || !findNode(nodeId)) throw new Error(translate("节点不存在，请刷新文件树"));
  const stop = watch((): NodeDocumentState => {
    const node = findNode(nodeId);
    const state = nodeDocument.states.get(nodeId);
    return { dirty: !!node && (canvasDirty.value || !!state?.dirty),
      error: state?.error || canvasSaveError.value || (node && nodeErrors.value[node.type]) || "", deleted: !node };
  }, onState, { immediate: true, flush: "sync" });
  const release = () => { stop(); documentObservers.delete(dispose); };
  const dispose = () => { onState({ dirty: false, error: "", deleted: true }); release(); };
  documentObservers.add(dispose);
  return {
    release,
    async flushSave() {
      checkDocumentDirectory(directory);
      if (!findNode(nodeId)) throw new Error(translate("节点已删除，请刷新文件树"));
      await flushCanvasSave();
    },
  };
}

async function mountDocumentNode(directory: string, canvasPath: string, nodeId: string, target: HTMLElement) {
  checkDocumentDirectory(directory);
  if (canvasId.value !== canvasPath) throw new Error(translate("画布已切换，请重新打开节点"));
  await nextTick();
  checkDocumentDirectory(directory);
  const node = findNode(nodeId);
  if (!node) throw new Error(translate("节点已删除，请刷新文件树"));
  if (nodeErrors.value[node.type]) throw new Error(nodeErrors.value[node.type]);
  const mount = nodeDocument.mounts.get(nodeId);
  if (!mount) throw new Error(translate("当前节点未提供文档视图，请确认节点正常加载并更新节点插件"));
  const release = mount(target);
  try {
    await nextTick();
    checkDocumentDirectory(directory);
    if (!target.isConnected || !target.querySelector(".documentNode")) throw new Error(translate("节点文档视图加载失败，请重新打开节点"));
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

function showEdgeDisconnect({ event, edge }: EdgeMouseEvent) {
  if (!(event instanceof MouseEvent)) return;
  event.stopPropagation();
  edgeDisconnect.value = { id: edge.id, x: event.clientX, y: event.clientY };
}

function dragFilesOver(event: DragEvent) {
  if (!props.active || props.settingsVisible || !canvasId.value || !project.value?.directory || !isCanvasFileDrag(event)) return;
  if (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane")) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  return true;
}

async function dropFiles(event: DragEvent) {
  const directory = project.value?.directory;
  if (!directory || !dragFilesOver(event)) return;
  try {
    await canvasHistory.batch(() => dropCanvasFiles(event, { directory, availableNodes: availableNodes.value, signal: canvasController.value.signal, flow }));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("文件导入失败"));
  }
}

function selectFiles(position: { x: number; y: number }) {
  const directory = project.value?.directory;
  if (!props.active || props.settingsVisible || !canvasId.value || !directory) return;
  const context = { directory, availableNodes: availableNodes.value, signal: canvasController.value.signal, flow };
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length || context.signal.aborted) return;
    try {
      await canvasHistory.batch(() => importCanvasFiles(files, position, context));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate("文件导入失败"));
    }
  };
  input.click();
}

// A generation composer asks for references; the canvas owns files and edges.
function addReferenceFiles(event: Event) {
  const { nodeId, accept: wanted } = (event as CustomEvent<{ nodeId?: string; accept?: string[] }>).detail ?? {};
  const directory = project.value?.directory;
  const target = nodeId ? flow.findNode(nodeId) : undefined;
  if (!props.active || props.settingsVisible || !canvasId.value || !directory || !target) return;
  const port = (target.data?.handles as { id: string; type: string; dataType?: string | string[] }[] | undefined)?.find(handle => handle.id === "in" && handle.type === "target");
  const accepts = [port?.dataType ?? []].flat().map(String).filter(type => ["IMAGE", "VIDEO", "AUDIO"].includes(type) && (!wanted?.length || wanted.includes(type)));
  if (!accepts.length) return;
  const context = { directory, availableNodes: availableNodes.value, signal: canvasController.value.signal, flow };
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = accepts.map(type => `${type.toLowerCase()}/*`).join(",");
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length || context.signal.aborted) return;
    try {
      await canvasHistory.batch(() => importReferenceFiles(files, { id: target.id, position: target.position, accepts }, context));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate("文件导入失败"));
    }
  };
  input.click();
}
onMounted(() => window.addEventListener("miao-canvas-add-reference", addReferenceFiles));
onBeforeUnmount(() => window.removeEventListener("miao-canvas-add-reference", addReferenceFiles));

function openNodeMenu(event: MouseEvent) {
  if (event.target instanceof Element && event.target.classList.contains("vue-flow__pane")) nodeMenuRef.value?.openMenu(event, true);
}

function addNodeAtPointer() {
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const position = pointerPosition ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  void nodeMenuRef.value?.openMenu(new MouseEvent("contextmenu", { clientX: position.x, clientY: position.y }), true);
}

// The toolbar's add button opens the same node menu as a double click, just
// above the button so the new node lands near the visible center.
function addNodeFromToolbar(event: MouseEvent) {
  const button = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const x = button ? button.left + button.width / 2 : rect.left + rect.width / 2;
  const y = button ? button.top - 12 : rect.top + rect.height / 2;
  void nodeMenuRef.value?.openMenu(new MouseEvent("contextmenu", { clientX: x, clientY: y }), true);
}

async function changeHistory(direction: "undo" | "redo") {
  try {
    await canvasHistory[direction]();
    edgeDisconnect.value = undefined;
  } catch (error) {
    ElMessage.error(
      axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data.message || translate("恢复画布失败")
        : error instanceof Error
        ? error.message
        : translate("恢复画布失败")
    );
  }
}

let saving = Promise.resolve();
let flushing = Promise.resolve();
let saveError: unknown;
let savePaused = false;
let saveCancelled = false;
let changedWhilePaused = false;
let saveRevision = 0;
let canvasBase: any;
let canvasBaseRevision: string | null = null;
const canvasRevisionOwner = createFileRevisionOwner();
let applyingRemote = false;
let syncingRemote = false;
const copyingConflict = ref(false);
let syncTimer: number | undefined;
let syncController: AbortController | undefined;
let lastCanvasListSync = 0;
const canvasSnapshot = () => persistentCanvas({ miaoimgCanvas: true, ...toObject() });
const cloneCanvas = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function canvasContentChanged(current = canvasSnapshot()) {
  return !!canvasBase && JSON.stringify([current.nodes, current.edges]) !== JSON.stringify([canvasBase.nodes, canvasBase.edges]);
}
function reconcileCanvasSave() {
  if (saveCancelled || applyingRemote || !canvasBase) return;
  canvasDirty.value = canvasContentChanged();
  // Node results can arrive before applyRemoteCanvas's nextTick completes.
  // Its suppressed watchers must not make those later edits look saved.
  if (canvasDirty.value) scheduleCanvasSave();
  else changedWhilePaused = false;
}
function bindCanvasSnapshot(snapshot: { canvas: any; revision: string | null }) {
  canvasBase = cloneCanvas(persistentCanvas(snapshot.canvas));
  canvasBaseRevision = snapshot.revision;
  canvasRevisionOwner.reset(snapshot.revision || undefined);
  saveError = undefined;
  canvasSaveError.value = "";
}
function savedViewportKey() { return `miaoimg.viewport.${project.value?.directory}:${canvasId.value}`; }
function rememberViewport() {
  if (!canvasId.value || applyingRemote) return;
  try { localStorage.setItem(savedViewportKey(), JSON.stringify(viewport.value)); } catch {}
}
async function applyRemoteCanvas(canvas: any) {
  applyingRemote = true;
  try {
    const applyFields = (current: any, incoming: any, runtime: Set<string>) => {
      if (JSON.stringify(current.data) !== JSON.stringify(incoming.data)) {
        const data = cloneCanvas(incoming.data ?? {});
        const outputs = current.data?.outputs;
        // External text is omitted from saved canvas JSON. A metadata update
        // must retain its loaded body and serialization hook on the live node.
        if (current.type === "remote-textNode" && incoming.type === current.type
          && typeof current.data?.textPath === "string" && current.data.textPath === data.textPath
          && outputs?.text?.dataType === "STRING" && typeof outputs.text.value === "string"
          && Object.hasOwn(outputs, "toJSON") && !Object.hasOwn(data.outputs ?? {}, "text")) data.outputs = outputs;
        current.data = data;
      }
      for (const key of Object.keys(current)) if (!runtime.has(key) && !Object.hasOwn(incoming, key)) delete current[key];
      for (const [key, value] of Object.entries(incoming)) {
        if (key !== "data" && !runtime.has(key) && JSON.stringify(current[key]) !== JSON.stringify(value)) current[key] = cloneCanvas(value);
      }
      return current;
    };
    flow.setNodes(canvas.nodes.map((node: any) => {
      const existing = flow.findNode(node.id);
      return existing ? applyFields(existing, node, nodeRuntimeFields) : node;
    }));
    flow.setEdges(canvas.edges.map((edge: any) => {
      const existing = flow.findEdge(edge.id);
      return existing ? applyFields(existing, edge, edgeRuntimeFields) : edge;
    }));
    await nextTick();
    canvasHistory.adoptRemote();
  } finally { applyingRemote = false; }
}
async function acceptCanvasSnapshot(snapshot: { canvas: any; revision: string | null; merged?: unknown }, base: any, ownRevision?: string | null) {
  snapshot = { ...snapshot, canvas: persistentCanvas(snapshot.canvas) };
  const current = canvasSnapshot();
  const merged = mergeCanvasState(base, current, snapshot.canvas);
  if (merged.conflicts.length) throw new Error("画布已在其他页面更新，请刷新页面后继续");
  const contentChanged = JSON.stringify([current.nodes, current.edges]) !== JSON.stringify([merged.canvas.nodes, merged.canvas.edges]);
  canvasBase = cloneCanvas(persistentCanvas(snapshot.canvas));
  canvasBaseRevision = snapshot.revision;
  if (ownRevision && snapshot.revision && snapshot.merged === false) canvasRevisionOwner.written(ownRevision, snapshot.revision);
  else canvasRevisionOwner.reset(snapshot.revision || undefined);
  if (contentChanged) await applyRemoteCanvas(merged.canvas);
  saveError = undefined;
  canvasSaveError.value = "";
  reconcileCanvasSave();
}
function adoptMutationEntries(entries: readonly WorkspaceSourceEntry[]): WorkspaceSourceEntry[] {
  return entries.map(entry => {
    if (saveCancelled || entry.path !== canvasId.value) return { ...entry };
    const revision = canvasRevisionOwner.resolve(entry.revision);
    return revision ? { ...entry, revision } : { ...entry };
  });
}
function showSaveError(err: unknown, toast = false) {
  saveError = err;
  // Retain the original error for recovery; show actionable copy rather than transport internals.
  const status = axios.isAxiosError(err) ? err.response?.status
    : (err && typeof err === "object" && "status" in err ? Number(err.status) : undefined);
  canvasSaveError.value = status === 409
    ? translate("画布已在其他页面更新，请刷新页面后继续")
    : status === 401
      ? translate("登录已失效，请重新登录后继续")
      : translate("画布同步暂未完成，本页改动已保留，请刷新后重试");
  if (toast) ElMessage.error(canvasSaveError.value);
}
const saveCanvas = debounce((directory: string, fileName: string) => {
  saving = saving.then(async () => {
    if (saveCancelled || project.value?.directory !== directory || canvasId.value !== fileName || !canvasBase) return;
    try {
      const submitted = canvasSnapshot();
      // A flush can drain a debounce already satisfied by the previous receipt.
      if (!saveError && !canvasContentChanged(submitted)) return;
      const ownRevision = canvasBaseRevision;
      const result = await useWorkspaceFiles(directory).saveCanvas(fileName, submitted, canvasBase, ownRevision);
      if (saveCancelled || project.value?.directory !== directory || canvasId.value !== fileName) return;
      await acceptCanvasSnapshot(result, submitted, ownRevision);
    } catch (err) { showSaveError(err, !canvasSaveError.value); }
  });
}, 500);

async function syncRemoteCanvas(force = false) {
  // Desktop canvas state is owned by this renderer and written to the local
  // workspace by the autosave queue. Background model tasks patch the same
  // local state and update the mounted generation node directly. Polling and
  // merging the whole JSON every five seconds only creates stale-read churn.
  if (window.miaoDesktop && !force) return;
  if (flow.nodes.value.some(node => node.dragging || node.resizing)) return;
  if (syncingRemote || savePaused || saveCancelled || !props.active || document.hidden || !canvasBase || !canvasId.value) return;
  syncingRemote = true;
  const directory = project.value?.directory;
  const fileName = canvasId.value;
  if (!directory) { syncingRemote = false; return; }
  const pending = saving.then(async () => {
    if (saveCancelled || savePaused || directory !== project.value?.directory || fileName !== canvasId.value) return;
    const controller = new AbortController();
    syncController = controller;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
      const snapshot = await useWorkspaceFiles(directory).readSnapshot(fileName, canvasBaseRevision || undefined, signal);
      if (saveCancelled || directory !== project.value?.directory || fileName !== canvasId.value) return;
      if (snapshot) await acceptCanvasSnapshot(snapshot, canvasBase);
      if (Date.now() - lastCanvasListSync >= 30000) {
        await canvasMenuRef.value?.refreshCanvases();
        lastCanvasListSync = Date.now();
      }
    } catch (err) { if (!controller.signal.aborted) showSaveError(err); }
    finally { syncController = undefined; }
  });
  saving = pending.catch(() => {});
  try { await pending; } finally { syncingRemote = false; }
}
const resumeCanvasSync = () => { if (!window.miaoDesktop && !document.hidden) void syncRemoteCanvas(); };
onMounted(() => {
  if (!window.miaoDesktop) syncTimer = window.setInterval(() => { void syncRemoteCanvas(); }, 5000);
  window.addEventListener("focus", resumeCanvasSync);
  document.addEventListener("visibilitychange", resumeCanvasSync);
});
onScopeDispose(() => {
  if (syncTimer !== undefined) window.clearInterval(syncTimer);
  syncController?.abort();
  window.removeEventListener("focus", resumeCanvasSync);
  document.removeEventListener("visibilitychange", resumeCanvasSync);
});
watch(() => props.active, active => { if (active && !window.miaoDesktop) void syncRemoteCanvas(); });
watch(canvasId, async id => {
  if (!id) return;
  try {
    const saved = JSON.parse(localStorage.getItem(savedViewportKey()) || "null");
    if (saved && [saved.x, saved.y, saved.zoom].every(Number.isFinite) && saved.zoom > 0) await setViewport(saved);
  } catch {}
});

async function saveConflictCopy() {
  if (copyingConflict.value || !project.value?.directory || !canvasId.value) return;
  copyingConflict.value = true;
  savePaused = true;
  saveCanvas.cancel();
  const directory = project.value.directory;
  const original = canvasId.value;
  const signal = canvasController.value.signal;
  try {
    await saving;
    const content = canvasSnapshot();
    const snapshot = await cloneCanvasSnapshot(flow, signal);
    signal.throwIfAborted();
    if (directory !== project.value?.directory || original !== canvasId.value) throw new Error(translate("工作目录或画布已切换，请重新操作"));
    if (JSON.stringify(content) !== JSON.stringify(canvasSnapshot())) throw new Error(translate("画布已变化，请重新复制"));
    const copyPath = `${original.slice(0, -5)}-本页保留-${Date.now()}-${crypto.randomUUID().slice(0, 4)}.json`;
    const files = useWorkspaceFiles(directory);
    await files.writeJson(copyPath, { ...cloneCanvas(canvasBase), ...snapshot }, true);
    const latest = await files.readSnapshot(original);
    if (directory !== project.value?.directory || original !== canvasId.value) return;
    if (JSON.stringify(content) !== JSON.stringify(canvasSnapshot())) throw new Error("当前改动已保留，但又有新的编辑，请再次刷新画布");
    if (!latest || !validCanvas(latest.canvas)) throw new Error("当前改动已保留，原画布暂时无法读取，请从画布列表打开保留的版本");
    bindCanvasSnapshot(latest);
    await applyRemoteCanvas(latest.canvas);
    reconcileCanvasSave();
    await canvasMenuRef.value?.refreshCanvases();
    ElMessage.success("画布已刷新，刷新前的改动已保留在画布列表");
  } catch (err) { showSaveError(err, true); }
  finally {
    copyingConflict.value = false;
    savePaused = false;
    if (changedWhilePaused && project.value?.directory && canvasId.value) saveCanvas(project.value.directory, canvasId.value);
    changedWhilePaused = false;
  }
}

function scheduleCanvasSave() {
  if (saveCancelled || applyingRemote) return;
  canvasDirty.value = true;
  saveRevision++;
  if (savePaused) {
    changedWhilePaused = true;
    return;
  }
  const directory = project.value?.directory;
  if (directory && canvasId.value) saveCanvas(directory, canvasId.value);
}

function scheduleCanvasChange() {
  if (applyingRemote) return;
  scheduleCanvasSave();
  canvasHistory.record();
}

const elementSaveWatchers = new Map<Node | Edge, () => void>();
const nodeRuntimeFields = new Set([
  "data",
  "computedPosition",
  "handleBounds",
  "selected",
  "dimensions",
  "isParent",
  "resizing",
  "dragging",
  "events",
]);
const edgeRuntimeFields = new Set(["data", "selected", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY", "events"]);
// ACT: 仅增删、替换元素时扫描列表；位移与 data 各自监听，单个节点变化不遍历其余节点。
watch(
  () => [...flow.nodes.value, ...flow.edges.value],
  (elements) => {
    const current = new Set<Node | Edge>(elements);
    for (const [element, stop] of elementSaveWatchers) {
      if (!current.has(element)) {
        stop();
        elementSaveWatchers.delete(element);
      }
    }
    for (const element of elements) {
      if (elementSaveWatchers.has(element)) continue;
      // 与 toObject 排除的运行态字段保持一致，其他自定义持久字段仍参与自动保存。
      const runtimeFields = isNode(element) ? nodeRuntimeFields : edgeRuntimeFields;
      const stopFields = watch(
        () =>
          Object.keys(element)
            .filter((key) => !runtimeFields.has(key))
            .map((key) => Reflect.get(element, key)),
        scheduleCanvasChange,
        { deep: true, flush: "post" }
      );
      const stopData = watch(() => element.data, scheduleCanvasSave, { deep: true, flush: "post" });
      const stopName = isNode(element)
        ? watch(
            () => element.data?.label,
            () => { if (!applyingRemote) canvasHistory.record(); },
            { flush: "post" }
          )
        : () => {};
      elementSaveWatchers.set(element, () => {
        stopFields();
        stopData();
        stopName();
      });
    }
    scheduleCanvasChange();
  },
  { immediate: true, flush: "post" }
);
onScopeDispose(() => elementSaveWatchers.forEach((stop) => stop()));
watch(() => [viewport.value.x, viewport.value.y, viewport.value.zoom], rememberViewport, { flush: "post" });

watch(
  [() => project.value?.directory, canvasId],
  ([directory, fileName], [previousDirectory, previousFileName]) => {
    if (directory !== previousDirectory) {
      workspaceController.abort(new Error("工作区已切换，本轮画布操作已停止"));
      workspaceController = new AbortController();
    }
    edgeDisconnect.value = undefined;
    finishDragCopy();
    pointerPosition = undefined;
    resetCanvasKeys();
    // 同一实例只在重新装载画布时失效；重命名仅更新保存路径。
    if (directory !== previousDirectory || !fileName || !previousFileName) {
      canvasController.value.abort(new Error("画布已重新加载，本次画布调用已停止"));
      canvasController.value = new AbortController();
    }
    if (!savePaused) saveCanvas.flush();
  },
  { flush: "sync" }
);

// ACT: 切换显示面板不会卸载画布；仅清理交互，不中断本轮工具调用。
watch(() => props.active, (active) => {
  if (!active) assetsVisible.value = false;
  edgeDisconnect.value = undefined;
  finishDragCopy();
  pointerPosition = undefined;
  resetCanvasKeys();
}, { flush: "sync" });

function flushCanvasSave(action?: () => Promise<void>): Promise<void> {
  // ACT: 完整保存及其文件操作串行执行，重命名暂停期间的显式保存也必须等待。
  const next = flushing.then(() => saveCanvasState(action));
  flushing = next.catch(() => {});
  return next;
}

async function saveCanvasState(action?: () => Promise<void>) {
  if (saveCancelled) throw new Error(translate("画布保存已取消"));
  await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
  await nextTick();
  if (saveCancelled) throw new Error(translate("画布保存已取消"));
  reconcileCanvasSave();
  if (saveError && project.value?.directory && canvasId.value) saveCanvas(project.value.directory, canvasId.value);
  if (action) savePaused = true;
  try {
    let revision: number;
    do {
      if (saveCancelled) throw new Error(translate("画布保存已取消"));
      revision = saveRevision;
      if (changedWhilePaused && project.value?.directory && canvasId.value) {
        saveCanvas(project.value.directory, canvasId.value);
        changedWhilePaused = false;
      }
      saveCanvas.flush();
      await saving;
      if (saveError) throw saveError;
      // 画布写入期间节点可能完成生成，等新增落盘后重新保存变化。
      await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
      await nextTick();
      reconcileCanvasSave();
    } while (revision !== saveRevision);
    if (saveCancelled) throw new Error(translate("画布保存已取消"));
    await action?.();
  } finally {
    if (action && !saveCancelled) {
      savePaused = false;
      if (changedWhilePaused && project.value?.directory && canvasId.value) saveCanvas(project.value.directory, canvasId.value);
      changedWhilePaused = false;
    }
  }
}

function cancelCanvasSave() {
  saveCancelled = true;
  savePaused = true;
  changedWhilePaused = false;
  saveCanvas.cancel();
}
function canUseCanvasClipboard(event: Event) {
  const target = event.target;
  return props.active && !event.defaultPrevented && !props.settingsVisible && !!canvasId.value && !!project.value?.directory
    && target instanceof Element
    && !target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider'], [role='dialog'], #agentPanel")
    && (target === document.body || target === document.documentElement || canvasElement.value?.contains(target));
}

function beforeClipboard(event: Event) {
  if (!canUseCanvasClipboard(event)) return;
  if (event.type === "beforecopy" && (!flow.getSelectedNodes.value.length || window.getSelection()?.toString())) return;
  // ACT: WKWebView 通过 beforecopy/beforepaste 判定非输入区能否使用原生编辑菜单。
  event.preventDefault();
}

function copyNode(event: ClipboardEvent) {
  if (!canUseCanvasClipboard(event) || !flow.getSelectedNodes.value.length || window.getSelection()?.toString()) return;
  event.preventDefault();
  void copySelectedNodes();
}

async function copySelectedNodes() {
  if (copyingNodes || !project.value?.directory) return;
  const nodes = getSelectionTree(flow.getSelectedNodes.value, flow.getNodes.value);
  if (!nodes.length) return;
  const directory = project.value.directory;
  const signal = canvasController.value.signal;
  copyingNodes = true;
  try {
    await copyCanvasNodes(flow, nodes, directory, signal);
  } catch (error) {
    if (!signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("节点复制失败"));
  } finally {
    copyingNodes = false;
  }
}

async function pasteNode(event: ClipboardEvent) {
  if (!canUseCanvasClipboard(event)) return;
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (nodeClipboardCommand.test(text)) { event.preventDefault(); await pasteNodeAtCenter(text); return; }
  const files = getClipboardMediaFiles(event);
  if (!files.length && text.trim()) files.push(new File([text], translate("粘贴文本") + ".txt", { type: "text/plain" }));
  if (!files.length) return;
  event.preventDefault();
  const position = pastePosition();
  if (position) await importClipboardContent(files, position);
}

function pastePosition() {
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const point = pointerPosition && pointerPosition.x >= rect.left && pointerPosition.x <= rect.right && pointerPosition.y >= rect.top && pointerPosition.y <= rect.bottom ? pointerPosition : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  return screenToFlowCoordinate(point);
}
async function pasteNodeAtCenter(command?: string) { const position = pastePosition(); if (position) await pasteClipboardNode(position, command); }
async function importClipboardContent(files: File[], position: { x: number; y: number }) {
  const directory = project.value?.directory;
  if (!directory) return false;
  await canvasHistory.batch(() => importCanvasFiles(files, position, { directory, availableNodes: availableNodes.value, signal: canvasController.value.signal, flow }));
  return true;
}

async function pasteClipboardNode(position: { x: number; y: number }, command?: string) {
  if (!props.active || !canvasId.value || !project.value?.directory) return false;
  const canvasSignal = canvasController.value.signal;
  try {
    const directory = project.value.directory;
    const text = command ?? (await readClipboardText());
    const snapshot = await readClipboardNodes(text, directory, canvasSignal);
    if (canvasSignal.aborted) return false;
    if (!snapshot) {
      const files = await readClipboardFiles().catch((error): File[] => { if (text.trim()) return []; throw error; });
      if (canvasSignal.aborted) return false;
      if (!files.length && text.trim()) files.push(new File([text], translate("粘贴文本") + ".txt", { type: "text/plain" }));
      if (!files.length) throw new Error(translate("剪贴板中没有可粘贴的内容"));
      return importClipboardContent(files, position);
    }
    await canvasHistory.batch(async () => { await pasteCanvasNodes(flow, directory, text, position, availableNodes.value, canvasSignal); });
    return true;
  } catch (error) {
    const pasteShortcut = generalSettings.value.canvasShortcuts.paste;
    const clipboardMessage = getShortcutBindings(pasteShortcut).some(binding => /^(Ctrl|Meta)\+KeyV$/.test(binding))
      ? translate("无法读取剪贴板，请在画布上按 {0} 粘贴", { 0: shortcutLabel(pasteShortcut) })
      : translate("无法读取剪贴板，请允许浏览器访问剪贴板");
    if (!canvasSignal.aborted)
      ElMessage.error(
        error instanceof DOMException && error.name === "NotAllowedError" ? clipboardMessage : error instanceof Error ? error.message : translate("节点粘贴失败")
      );
    return false;
  }
}

function zoomCanvas(event: WheelEvent | (Event & { scale: number })) {
  if (event.type === "gestureend") gestureScale = undefined;
  if (!props.active || props.settingsVisible || document.fullscreenElement || flow.userSelectionActive.value) return;
  if (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane, .vue-flow__node, .vue-flow__edge, .vue-flow__nodesselection")) return;
  let factor: number;
  let point = pointerPosition;
  if ("scale" in event) {
    if (!Number.isFinite(event.scale) || event.scale <= 0) return;
    factor = event.type === "gesturechange" && gestureScale !== undefined ? event.scale / gestureScale : 1;
    gestureScale = event.type === "gestureend" ? undefined : event.scale;
  } else {
    // ACT: Chromium 捏合发送 Ctrl+wheel，但不发送 Control 按键；WebKit 使用上方原生 gesture 事件。
    const pinching = event.ctrlKey && !pressedCodes.has("ControlLeft") && !pressedCodes.has("ControlRight");
    if (!pinching && !shortcutPressed(event, generalSettings.value.canvasShortcuts.zoom, pressedCodes)) {
      if (!event.ctrlKey) return;
      // 实体 Ctrl 未绑定缩放时，阻止 Vue Flow 和节点骨架将它误判为捏合。
      factor = 1;
    } else {
      factor = pinching && gestureScale !== undefined ? 1 : 2 ** (pinching ? -event.deltaY * 0.02 : wheelDelta(event));
    }
    point = { x: event.clientX, y: event.clientY };
  }
  const zoom = flow.d3Zoom.value;
  const selection = flow.d3Selection.value;
  if (!zoom || !selection) return;
  event.preventDefault();
  event.stopPropagation();
  if (factor === 1) return;
  const bounds = selection.node()?.getBoundingClientRect();
  if (!bounds) return;
  point ??= { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  selection.call<[number, [number, number], Event]>(zoom.scaleBy, factor, [point.x - bounds.left, point.y - bounds.top], event);
}

function updateCanvasKeys(event: KeyboardEvent) {
  if (event.type === "keydown") {
    pressedCodes.add(event.code);
  } else pressedCodes.delete(event.code);
  if (!props.active || props.settingsVisible) return resetCanvasKeys();
  const target = event.target;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const editingTarget = target instanceof Element && !!target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']");
  if (editingTarget || event.isComposing) {
    zoomKeyPressed.value = false;
    panKeyPressed.value = false;
    return;
  }
  const inCanvas =
    target instanceof Element &&
    !target.closest("[role='dialog'], #agentPanel") &&
    (target === document.body || target === document.documentElement || canvasElement.value?.contains(target));
  zoomKeyPressed.value = shortcutPressed(event, shortcuts.zoom, pressedCodes);
  const editing =
    !(target instanceof Element) ||
    !!target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']");
  panKeyPressed.value = !!inCanvas && !editing && shortcutPressed(event, shortcuts.pan, pressedCodes);
  if (event.type === "keyup" || event.defaultPrevented || !inCanvas || editing) return;
  const action = ([
    "group", "mergeGroup", "ungroup", "addNode", "moveTool", "handTool", "arrange", "search",
    "delete", "copy", "paste", "undo", "redo", "zoomIn", "zoomOut", "fitView",
  ] as const).find((action) =>
    shortcutMatches(event, shortcuts[action])
  );
  if (!action) {
    const nativeClipboardKey = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
      && (event.code === "KeyV" || event.code === "KeyC" && flow.getSelectedNodes.value.length && !window.getSelection()?.toString());
    if (panKeyPressed.value || nativeClipboardKey) event.preventDefault();
    return;
  }
  if (!canvasId.value || !project.value?.directory) return;
  if (action === "copy" && (!flow.getSelectedNodes.value.length || window.getSelection()?.toString())) return;
  // 桌面快捷键直接复用原生剪贴板桥接；浏览器 Ctrl/Cmd+V 保留原生事件，避免额外读取权限。
  if (!isDesktop && action === "paste" && event.code === "KeyV" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) return;
  event.preventDefault();
  if (event.repeat) return;
  if (action === "delete") {
    const nodes = [...flow.getSelectedNodes.value];
    const menu = nodeMenuRef.value;
    if (!menu || !nodes.some((node) => node.deletable !== false)) return;
    void canvasHistory
      .batch(() => menu.deleteSelection(nodes))
      .catch((error) => {
        ElMessage.error(error instanceof Error ? error.message : translate("节点删除失败"));
      });
    return;
  }
  if (action === "copy") void copySelectedNodes();
  else if (action === "paste") void pasteNodeAtCenter();
  else if (action === "undo" || action === "redo") void changeHistory(action);
  else if (action === "group" || action === "mergeGroup" || action === "ungroup") {
    void selectionToolbarRef.value?.operate(action);
  } else if (action === "addNode") addNodeAtPointer();
  else if (action === "moveTool" || action === "handTool") selectedTool.value = action === "handTool" ? "hand" : "move";
  else if (action === "arrange") void canvasControlsRef.value?.arrangeNodes();
  else if (action === "search") nodeSearchRef.value?.open();
  else if (action === "fitView") void flow.fitView({ padding: 0.25, maxZoom: 1 });
  else void flow[action]();
}

function resetCanvasKeys() {
  pressedCodes.clear();
  gestureScale = undefined;
  zoomKeyPressed.value = false;
  panKeyPressed.value = false;
}

let canvasKeyboardAttached = false;
function attachCanvasKeyboard() {
  if (canvasKeyboardAttached) return;
  canvasKeyboardAttached = true;
  window.addEventListener("keydown", updateCanvasKeys, true);
  window.addEventListener("keyup", updateCanvasKeys, true);
}
function detachCanvasKeyboard() {
  if (!canvasKeyboardAttached) return;
  canvasKeyboardAttached = false;
  window.removeEventListener("keydown", updateCanvasKeys, true);
  window.removeEventListener("keyup", updateCanvasKeys, true);
  resetCanvasKeys();
}

watch([() => props.settingsVisible, () => generalSettings.value.canvasShortcuts], resetCanvasKeys, { deep: true, flush: "sync" });
watch(() => props.active, (active) => {
  if (active) attachCanvasKeyboard();
  else detachCanvasKeyboard();
}, { flush: "sync" });

function refreshInstalled(event: CustomEvent<{ kind?: string; type?: string; name?: string }>) {
  if (event.detail.type === "node") void loadRemoteNodes(event.detail.name);
}

const refreshNodeConfig = () => { void loadRemoteNodes(undefined, true); };

onMounted(() => {
  // 仅在画布处于活动状态时监听全局快捷键，避免后台页面收到画布按键。
  if (props.active) attachCanvasKeyboard();
  window.addEventListener("blur", resetCanvasKeys);
  window.addEventListener("miaoimg:plugin-installed", refreshInstalled);
  window.addEventListener("miaoimg:node-config-updated", refreshNodeConfig);
  document.addEventListener("paste", pasteNode);
  document.addEventListener("copy", copyNode);
  document.addEventListener("beforecopy", beforeClipboard);
  document.addEventListener("beforepaste", beforeClipboard);
  // 内置节点随工作台发布；这里再拉一次服务端节点列表，把用户安装的插件节点载入。
  void loadRemoteNodes();
});
onBeforeUnmount(() => {
  detachCanvasKeyboard();
  window.removeEventListener("blur", resetCanvasKeys);
  window.removeEventListener("miaoimg:plugin-installed", refreshInstalled);
  window.removeEventListener("miaoimg:node-config-updated", refreshNodeConfig);
  document.removeEventListener("paste", pasteNode);
  document.removeEventListener("copy", copyNode);
  document.removeEventListener("beforecopy", beforeClipboard);
  document.removeEventListener("beforepaste", beforeClipboard);
  workspaceController.abort(new Error("工作区已关闭"));
  canvasController.value.abort(new Error("画布已关闭"));
  saveCanvas.flush();
  loadRequest++;
});

const nodeDocument: NodeDocumentContext = { targets: shallowReactive(new Map()), mounts: new Map(), states: shallowReactive(new Map()) };
const documentObservers = new Set<() => void>();
onScopeDispose(() => { for (const release of documentObservers) release(); });
provide("nodeDocument", nodeDocument);
provide("nodeConfig", (nodeType: string) => nodeConfigs.value[nodeType] ?? {});
provide("workspaceFiles", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error(translate("请先选择工作目录"));
  return useWorkspaceFiles(directory);
});
provide("workspaceDirectory", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error(translate("请先选择工作目录"));
  return directory;
});
provide("reloadRemoteNode", (type: string) => {
  // 内置节点随工作台一起发布，没有单独的插件脚本可重载。
  if (!type.startsWith("remote-") || builtinNodeTypes.has(type)) return Promise.resolve();
  const name = type.replace(/^remote-/, "");
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error(translate("节点类型无效"));
  return loadNode(name, `/api/nodes/files?name=${name}`, true);
});

async function loadNode(name: string, url: string, force = false): Promise<void> {
  const nodeType = `remote-${name}`;
  const signal = canvasController.value.signal;
  const pending = nodeLoads.get(nodeType);
  if (pending) {
    if (!force) return pending;
    await pending.catch(() => {});
  }
  signal.throwIfAborted();
  if (!force && nodeTypes.value[nodeType] && !nodeErrors.value[nodeType]) return;
  if (force) {
    signal.throwIfAborted();
    // ACT: 复用画布修订号收敛等待期间的编辑；持续修改画布时延后刷新，不额外维护节点修订状态。
    let revision: number;
    do {
      revision = saveRevision;
      await Promise.all(flow.getNodes.value.filter(node => node.type === nodeType).map(node => useNodeEvent(node.id, flow).emit("save", "reload")));
      await nextTick();
      signal.throwIfAborted();
    } while (revision !== saveRevision);
    const loading = nodeLoads.get(nodeType);
    if (loading) return loading;
  }
  delete nodeErrors.value[nodeType];
  const nodeLoad = loadNodeComponent(name, url, force)
    .then((remoteNode) => {
      signal.throwIfAborted();
      // 同类型节点共享组件，运行错误由每个节点自己的边界显示。
      nodeTypes.value = { ...nodeTypes.value, [nodeType]: markRaw(remoteNode) };
    })
    .catch((error) => {
      if (!signal.aborted) nodeErrors.value[nodeType] = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => { if (nodeLoads.get(nodeType) === nodeLoad) nodeLoads.delete(nodeType); });
  nodeLoads.set(nodeType, nodeLoad);
  return nodeLoad;
}

async function loadRemoteNodes(reloadName?: string, refresh = false) {
  if (reloadName) nodeReloads.add(reloadName);
  const requestId = ++loadRequest;
  const signal = canvasController.value.signal;
  nodeListLoading.value = true;
  try {
    const data = await loadNodeCatalog(refresh || !!reloadName);
    signal.throwIfAborted();
    if (requestId !== loadRequest) return;
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(translate("节点列表格式错误"));
    const nodes = data.data.filter(node => {
      if (!node || typeof node.name !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(node.name) || node.url !== `/api/nodes/files?name=${node.name}`) {
        console.error("节点地址无效", node);
        return false;
      }
      return true;
    });
    nodeConfigs.value = Object.fromEntries(nodes.map(node => [`remote-${node.name}`, node.config ?? {}]));
    const enabledNodes = nodes.filter(node => node.enabled !== false);
    // 节点各自加载完成后即可出现在菜单中，不等待其他节点的脚本。
    nodeOptions.value = enabledNodes.map(node => ({ type: `remote-${node.name}`, label: node.displayName }))
      .sort((left, right) => left.type.localeCompare(right.type));
    // ACT: 安装事件合并到最新列表请求，避免连续更新不同节点时丢失较早的刷新名称。
    const reloadNames = new Set(nodeReloads);
    nodeReloads.clear();
    await Promise.all(
      enabledNodes.map(async (node) => {
        const nodeType = `remote-${node.name}`;
        try {
          if (nodeTypes.value[nodeType] && !nodeErrors.value[nodeType] && !reloadNames.has(node.name)) return;
          await loadNode(node.name, node.url, reloadNames.has(node.name));
        } catch (error) {
          console.error("加载远端节点失败", node, error);
          // 保存拒绝时旧组件仍可用，不从节点菜单中移除；脚本加载错误仍排除。
          if (nodeTypes.value[nodeType] && !nodeErrors.value[nodeType]) {
            if (reloadNames.has(node.name) && !signal.aborted) ElMessage.warning({
              message: translate("{0}已安装，但当前节点无法刷新。请等待任务结束后，点击节点右上角的刷新按钮。", { 0: node.displayName }),
              grouping: true,
            });
          }
        }
      })
    );
  } catch (error) {
    if (requestId === loadRequest) console.error("获取远端节点列表失败", error);
  } finally {
    if (requestId === loadRequest) nodeListLoading.value = false;
  }
}

const defaultEdgeOptions = markRaw({
  type: "simple-bezier",
  animated: false,
  class: ({ sourceNode, targetNode }: GraphEdge) => {
    if (!sourceNode.selected && !sourceNode.dragging && !targetNode.selected && !targetNode.dragging) return "";
    return [generalSettings.value.canvasEdgeColorMode !== "none" && "edgeActive", generalSettings.value.canvasEdgeAnimationEnabled && "animated"].filter(Boolean).join(" ");
  },
  focusable: false,
  selectable: false,
  updatable: false,
  interactionWidth: 40,
});
</script>

<style lang="scss" scoped>
.canvas {
  width: 100%;
  height: 100%;

  // 画布由 transform 平移。原生自动滚动会把固定工具栏一起推离窗口。
  :deep(.vue-flow) { overflow: clip; }

  &.compositingEnabled :deep(.vue-flow__transformationpane) {
    will-change: transform;
  }

  &.handMode :deep(.vue-flow__transformationpane),
  &.handMode :deep(.vue-flow__transformationpane *) {
    pointer-events: none !important;
  }

  &.handMode :deep(.vue-flow__pane) {
    cursor: grab;
  }

  &.edgesHidden :deep(.vue-flow__edges) {
    display: none;
  }
  &.edgesHidden :deep(.vue-flow__handle) {
    display: none !important;
  }

  :deep(.vue-flow__edge.edgeActive .vue-flow__edge-path) {
    stroke: var(--canvasEdgeColor);
  }

  &:has(.selectionConnection) :deep(.vue-flow__node:not(.selected) .nodeHandle.target .handleIcon) {
    opacity: 1;
  }

  :deep(.vue-flow__nodesselection-rect) {
    box-sizing: content-box;
    padding: 8px;
    margin: -8px;
    border-radius: 4px;
  }
}
.edgeDisconnect {
  position: fixed;
  z-index: 1000;
  width: 32px;
  height: 32px;
  padding: 0;
  transform: translate(-50%, -50%);
}
</style>

<style scoped>
.canvasSaveNotice { position: absolute; top: 64px; left: 12px; right: 12px; z-index: 100; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid #df9d3c; border-radius: 8px; background: var(--miaoimg-glass-panel); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); color: var(--el-text-color-primary); font-size: 13px; }
.canvasSaveNotice button { flex-shrink: 0; cursor: pointer; padding: 6px 10px; }
</style>
