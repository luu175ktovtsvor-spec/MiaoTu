<template>
  <selectionHandle
    v-if="!singleGroupSelected"
    ref="selectionHandleRef"
    @start="startSelectionConnection"
    @release="(event, nodes) => openMenu(event, true, [], undefined, nodes)" />
  <selectionHandle
    v-for="group in groups"
    :key="group.id"
    ref="groupHandleRefs"
    :nodes="[group]"
    @start="startSelectionConnection"
    @release="(event, nodes) => openMenu(event, true, [], undefined, nodes)" />
  <el-dropdown
    ref="menu"
    trigger="contextmenu"
    virtualTriggering
    :virtualRef="menuAnchor"
    placement="bottom-start"
    :showArrow="false"
    :showTimeout="0"
    :hideTimeout="0"
    :hideOnClick="false"
    @command="handleCommand"
    @visibleChange="(visible: boolean) => !visible && clearConnection()">
    <template #dropdown>
      <el-dropdown-menu
        ref="menuList"
        class="nodeMenu"
        :aria-label="menuLevel === 'selection' ? translate('选区操作') : menuLevel === 'arrange' ? translate('整理选中节点') : menuLevel === 'actions' ? translate('操作菜单') : translate('添加节点')">
        <template v-if="menuLevel === 'selection'">
          <el-dropdown-item command="duplicateSelection" :icon="IconCopyPlus" :disabled="selectionBusy || deleting || !selectedNodes.length">
            {{ translate('创建副本') }}
          </el-dropdown-item>
          <el-dropdown-item command="arrange" :icon="IconLayoutGrid" :disabled="!canArrangeSelection">
            <span>{{ translate('整理选中节点') }}</span>
            <icon-chevron-right class="nextIcon" :size="14" />
          </el-dropdown-item>
          <el-dropdown-item
            command="deleteSelection"
            :icon="IconTrash"
            :disabled="selectionBusy || deleting || !selectedNodes.some((node) => node.deletable !== false)">
            {{ deleting ? translate("删除中…") : translate("删除选中节点（{0}）", { 0: selectedNodes.length }) }}
          </el-dropdown-item>
        </template>
        <template v-else-if="menuLevel === 'arrange'">
          <el-dropdown-item command="selection" :icon="IconChevronLeft">{{ translate('返回选区操作') }}</el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="horizontal" :icon="IconLayoutColumns" :disabled="!canArrangeSelection">{{ translate('水平排列') }}</el-dropdown-item>
          <el-dropdown-item command="vertical" :icon="IconLayoutRows" :disabled="!canArrangeSelection">{{ translate('垂直排列') }}</el-dropdown-item>
          <el-dropdown-item command="grid" :icon="IconLayoutGrid" :disabled="!canArrangeSelection">{{ translate('宫格排列') }}</el-dropdown-item>
        </template>
        <template v-else-if="menuLevel === 'actions'">
          <el-dropdown-item command="upload" :icon="IconUpload" :disabled="!uploadFiles">{{ translate('上传') }}</el-dropdown-item>
          <el-dropdown-item command="nodes" :icon="IconPlus">
            <span>{{ translate('添加节点') }}</span>
            <icon-chevron-right class="nextIcon" :size="14" />
          </el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="undo" :icon="IconArrowBackUp" :disabled="!canUndo">{{ translate('撤销') }}<span v-if="shortcutHint('undo')" class="shortcutHint">{{ shortcutHint('undo') }}</span></el-dropdown-item>
          <el-dropdown-item command="redo" :icon="IconArrowForwardUp" :disabled="!canRedo">{{ translate('重做') }}<span v-if="shortcutHint('redo')" class="shortcutHint">{{ shortcutHint('redo') }}</span></el-dropdown-item>
          <el-divider />
          <el-dropdown-item command="paste" :icon="IconClipboard" :disabled="!pasteNode || pasting">
            {{ pasting ? translate("粘贴中…") : translate("从剪贴板粘贴") }}<span v-if="!pasting && shortcutHint('paste')" class="shortcutHint">{{ shortcutHint('paste') }}</span>
          </el-dropdown-item>
        </template>
        <template v-else>
          <el-dropdown-item v-if="!directNodes" command="actions" :icon="IconChevronLeft">{{ translate('返回操作菜单') }}</el-dropdown-item>
          <el-dropdown-item v-else disabled class="menuSection">{{ translate('添加节点') }}</el-dropdown-item>
          <el-dropdown-item v-for="node in filteredNodes" :key="node.type" :command="node.type" :icon="node.icon">
            {{ translate(node.label) }}
          </el-dropdown-item>
          <el-dropdown-item v-if="(pendingHandle || pendingGroup.length) && !filteredNodes.length" disabled>{{ translate('没有可连接的节点') }}</el-dropdown-item>
          <template v-if="directNodes && !pendingHandle && !pendingGroup.length && uploadFiles">
            <el-dropdown-item divided disabled class="menuSection">{{ translate('添加资源') }}</el-dropdown-item>
            <el-dropdown-item command="upload" :icon="IconUpload">{{ translate('上传') }}</el-dropdown-item>
          </template>
        </template>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, type Component } from "vue";
import { useVueFlow, type ConnectingHandle, type GraphNode, type HandleType } from "@vue-flow/core";
import { isTypeCompatible, validateConnection, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import { ElMessage } from "element-plus";
import type { DropdownInstance } from "element-plus";
import selectionHandle from "./selectionHandle.vue";
import { getSelectionConnections } from "../selectionConnections";
import { getSelectionRoots } from "../selectionNodes";
import { deleteCanvasNodes } from "../canvasNodeDeletion";
import { arrangeSelection } from "../arrangeSelection";
import { defaultNodeLabel, numberedNodeLabel } from "../linkedNode";
import { translate } from "@miaoimg/i18n/vue";
import { generalSettings } from "@/stores/settings";
import { getShortcutBindings, shortcutLabel, type CanvasShortcutAction } from "@/lib/canvasShortcuts";
import {
  IconClipboard,
  IconCopyPlus,
  IconTrash,
  IconBox,
  IconUpload,
  IconPlus,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronLeft,
  IconChevronRight,
  IconLayoutColumns,
  IconLayoutRows,
  IconLayoutGrid,
} from "@tabler/icons-vue";

const { remoteNodes = [], pasteNode, uploadFiles, canUndo = false, canRedo = false, selectionBusy = false, batchHistory } = defineProps<{
  remoteNodes?: { type: string; label: string }[];
  pasteNode?: (position: { x: number; y: number }) => Promise<boolean>;
  uploadFiles?: (position: { x: number; y: number }) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  selectionBusy?: boolean;
  batchHistory?: (action: () => Promise<void>) => Promise<void>;
}>();
const emit = defineEmits<{ history: []; undo: []; redo: []; duplicateSelection: [] }>();
const menu = ref<DropdownInstance>();
const menuList = ref<{ $el: HTMLElement }>();
const menuLevel = ref<"actions" | "nodes" | "selection" | "arrange">("actions");
const selectedNodes = shallowRef<GraphNode[]>([]);
const deleting = ref(false);
const deletionLifetime = new AbortController();
const canvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
onBeforeUnmount(() => deletionLifetime.abort());
const pasting = ref(false);
const directNodes = ref(false);
const menuAnchor = shallowRef({ getBoundingClientRect: () => new DOMRect() });
const flow = useVueFlow();
const { addNodes, screenToFlowCoordinate, onPaneContextMenu, onSelectionContextMenu, onPaneClick, onMoveStart } = flow;
let nodePosition = { x: 0, y: 0 };
type DraggedHandle = { node: GraphNode; id: string; type: HandleType; start: ConnectingHandle };
const pendingHandle = shallowRef<DraggedHandle>();
const pendingGroup = shallowRef<GraphNode[]>([]);
const selectionHandleRef = ref<InstanceType<typeof selectionHandle>>();
const groupHandleRefs = ref<InstanceType<typeof selectionHandle>[]>([]);
const groups = computed(() => flow.getNodes.value.filter(node => node.type === "canvasGroup" && !node.hidden));
const singleGroupSelected = computed(() => flow.getSelectedNodes.value.length === 1 && flow.getSelectedNodes.value[0]?.type === "canvasGroup");
const canArrangeSelection = computed(() => {
  const nodes = getSelectionRoots(selectedNodes.value, flow.getNodes.value);
  return !selectionBusy && !deleting.value && nodes.length > 1
    && nodes.every(node => flow.findNode(node.id) === node && node.draggable !== false
      && Number.isFinite(node.dimensions.width) && node.dimensions.width > 0
      && Number.isFinite(node.dimensions.height) && node.dimensions.height > 0);
});
const nodeOrder: Record<string, number> = { "remote-textNode": 0, "remote-imageNode": 1, "remote-videoNode": 2, "remote-audioNode": 3 };
const filteredNodes = computed(() => {
  const nodes = remoteNodes.map(node => ({
    ...node,
    icon: (flow.nodeTypes?.value?.[node.type] as { icon?: Component } | undefined)?.icon ?? IconBox,
  })).sort((left, right) => (nodeOrder[left.type] ?? 4) - (nodeOrder[right.type] ?? 4));
  if (pendingGroup.value.length) {
    if (!flow.nodesConnectable.value || pendingGroup.value.some(node => flow.findNode(node.id) !== node || node.connectable === false)) return [];
    return nodes.filter(node => {
      const targets = (flow.nodeTypes?.value?.[node.type] as { handles?: NodeHandle[] } | undefined)?.handles?.filter(handle => handle.type === "target") ?? [];
      return pendingGroup.value.every(source => (source.data.handles as NodeHandle[] | undefined)?.some(output =>
        output.type === "source" && targets.some(input => isTypeCompatible(output.dataType, input.dataType))));
    });
  }
  const handle = pendingHandle.value;
  if (!handle) return nodes;
  if (flow.findNode(handle.node.id) !== handle.node || !flow.nodesConnectable.value || handle.node.connectable === false) return [];
  const port = (handle.node.data.handles as NodeHandle[] | undefined)?.find((item) => item.id === handle.id && item.type === handle.type);
  if (!port) return [];
  return nodes.filter((node) => {
    const handles = (flow.nodeTypes?.value?.[node.type] as { handles?: NodeHandle[] } | undefined)?.handles;
    return handles?.some((item) => item.type !== port.type && isTypeCompatible(port.dataType, item.dataType));
  });
});

function clearSelectionHandles() {
  selectionHandleRef.value?.clear();
  groupHandleRefs.value.forEach(handle => handle.clear());
}

function clearConnection() {
  if (pendingHandle.value) {
    pendingHandle.value = undefined;
    flow.endConnection();
  }
  if (pendingGroup.value.length) {
    pendingGroup.value = [];
    clearSelectionHandles();
  }
}

function startSelectionConnection() {
  clearConnection();
  clearSelectionHandles();
  menu.value?.handleClose();
}

onBeforeUnmount(clearConnection);
// 单击节点两侧的「+」（按下和松开几乎在同一点）和拖到空白处一样，弹出可连接的节点菜单，选了就建好并连上。
let connectStartPoint: { x: number; y: number } | undefined;
flow.onConnectStart(({ event }) => {
  const point = event && ("touches" in event ? event.touches[0] : event);
  connectStartPoint = point ? { x: point.clientX, y: point.clientY } : undefined;
  pendingHandle.value = undefined;
  clearConnection();
  menu.value?.handleClose();
});

flow.onConnectEnd((event) => {
  const handle = flow.connectionStartHandle.value;
  if (!handle || flow.connectionStatus.value === "valid" || !event || event.type === "touchcancel") return;
  const node = flow.findNode(handle.nodeId);
  if (!node || handle.id == null) return;
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point) return;
  const target = document.elementFromPoint(point.clientX, point.clientY);
  const clicked = connectStartPoint && Math.hypot(point.clientX - connectStartPoint.x, point.clientY - connectStartPoint.y) < 5
    && target?.closest(".vue-flow__handle")?.closest(".vue-flow__node")?.getAttribute("data-id") === node.id;
  connectStartPoint = undefined;
  if (!clicked && (!target?.classList.contains("vue-flow__pane") || !flow.vueFlowRef.value?.contains(target))) return;
  // 单击「+」时新节点和当前节点上下对齐，隔一段距离放在右边（输入端放左边），不压住原来的节点。
  const width = node.dimensions.width || 600, gap = 120;
  const placement = clicked ? { x: handle.type === "source" ? node.position.x + width + gap : node.position.x - width - gap, y: node.position.y } : undefined;
  void openMenu(event, true, [], { node, id: handle.id, type: handle.type, start: { ...handle } }, [], placement);
});

async function openMenu(event: MouseEvent | TouchEvent, nodesOnly = false, selection: GraphNode[] = [], handle?: DraggedHandle, group: GraphNode[] = [], placement?: { x: number; y: number }) {
  event.preventDefault();
  event.stopPropagation();
  emit("history");
  menu.value?.handleClose();
  clearConnection();
  await nextTick();
  if (!menu.value || (handle && flow.findNode(handle.node.id) !== handle.node)) return;
  pendingHandle.value = handle;
  pendingGroup.value = group;
  directNodes.value = nodesOnly;
  selectedNodes.value = [...selection];
  menuLevel.value = selection.length ? "selection" : nodesOnly ? "nodes" : "actions";
  const point = "changedTouches" in event ? event.changedTouches[0] : event;
  if (!point) return;
  const { clientX, clientY } = point;
  nodePosition = placement ? { ...placement } : screenToFlowCoordinate({ x: clientX, y: clientY });
  menuAnchor.value = { getBoundingClientRect: () => new DOMRect(clientX, clientY, 0, 0) };
  if (handle) {
    const bounds = flow.vueFlowRef.value!.getBoundingClientRect();
    // ACT: VueFlow 在释放后清空拖线；菜单期间复用其预览，避免创建临时节点或边。
    flow.startConnection(handle.start, { x: clientX - bounds.left, y: clientY - bounds.top });
  }
  await nextTick();
  menu.value?.handleOpen();
}

onPaneContextMenu(openMenu);
onSelectionContextMenu(({ event, nodes }) => openMenu(event, false, nodes));
onPaneClick(() => menu.value?.handleClose());
onMoveStart(() => menu.value?.handleClose());
flow.onNodeContextMenu(() => {
  clearConnection();
  menu.value?.handleClose();
});
// 右键菜单像 LibTV 一样在右侧写出快捷键，用的是设置里当前的键位。
function shortcutHint(action: CanvasShortcutAction) {
  const first = getShortcutBindings(generalSettings.value.canvasShortcuts[action] || "")[0];
  return first ? shortcutLabel(first) : "";
}

// 空画布上的快捷按钮：不弹菜单，直接在指定位置建一个节点并选中。
async function createNode(type: string, client: { x: number; y: number }) {
  emit("history");
  menu.value?.handleClose();
  clearConnection();
  pendingHandle.value = undefined;
  pendingGroup.value = [];
  nodePosition = screenToFlowCoordinate(client);
  await handleCommand(type);
}
defineExpose({ openMenu, deleteSelection, createNode });

async function handleCommand(command: unknown) {
  if (command === "nodes" || command === "actions" || command === "selection" || command === "arrange") {
    if (command === "arrange" && !canArrangeSelection.value) return;
    menuLevel.value = command;
    await nextTick();
    menuList.value?.$el.focus();
    return;
  }
  if (command === "duplicateSelection") {
    if (selectionBusy || deleting.value || !selectedNodes.value.length) return;
    menu.value?.handleClose();
    emit("duplicateSelection");
    return;
  }
  if (command === "upload") {
    menu.value?.handleClose();
    uploadFiles?.({ ...nodePosition });
    return;
  }
  if (command === "undo" || command === "redo") {
    if (command === "undo" ? !canUndo : !canRedo) return;
    menu.value?.handleClose();
    if (command === "undo") emit("undo");
    else emit("redo");
    return;
  }
  if (batchHistory) {
    try {
      await batchHistory(() => runCommand(command));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : translate("画布操作失败"));
    }
    return;
  }
  await runCommand(command);
}

async function runCommand(command: unknown) {
  if (command === "horizontal" || command === "vertical" || command === "grid") {
    if (!canArrangeSelection.value) return;
    arrangeSelection(flow, selectedNodes.value, command);
    menu.value?.handleClose();
    return;
  }
  if (command === "paste") {
    if (!pasteNode || pasting.value) return;
    pasting.value = true;
    try {
      if (await pasteNode({ ...nodePosition })) menu.value?.handleClose();
    } finally {
      pasting.value = false;
    }
    return;
  }
  if (command === "deleteSelection") {
    await deleteSelection();
    return;
  }
  const node = filteredNodes.value.find((option) => option.type === command);
  if (!node) return;
  const handle = pendingHandle.value;
  const group = pendingGroup.value;
  if (handle && flow.findNode(handle.node.id) !== handle.node) return;
  if (group.some(source => flow.findNode(source.id) !== source)) return;
  const id = crypto.randomUUID();
  addNodes({ id, type: node.type, position: { ...nodePosition }, data: { label: numberedNodeLabel(flow.getNodes.value, defaultNodeLabel(node.type, node.label)) } });
  if (!handle && !group.length) {
    flow.removeSelectedElements();
    flow.nodesSelectionActive.value = false;
    const created = flow.findNode(id);
    if (created) flow.addSelectedNodes([created]);
    return menu.value?.handleClose();
  }
  // ACT: 远端节点挂载后才注册端口，沿用画布工具的 nextTick 等待方式。
  await nextTick();
  const created = flow.findNode(id);
  if (group.length) {
    if (!created) return;
    const connections = flow.nodesConnectable.value
      ? getSelectionConnections(group, created, flow.getNodes.value, flow.getEdges.value)
      : undefined;
    if (connections) {
      flow.addEdges(connections);
      flow.removeSelectedElements();
      flow.nodesSelectionActive.value = false;
      clearConnection();
      menu.value?.handleClose();
    } else {
      flow.removeNodes(id, true);
      flow.removeSelectedElements();
      flow.addSelectedNodes(group);
      flow.nodesSelectionActive.value = true;
      ElMessage.warning(translate("该节点的接收规则不允许整组选中节点连接"));
    }
    return;
  }
  if (!handle) return;
  if (!created || flow.findNode(handle.node.id) !== handle.node) {
    clearConnection();
    return menu.value?.handleClose();
  }
  const sourceNode = handle.type === "source" ? handle.node : created;
  const targetNode = handle.type === "target" ? handle.node : created;
  const connection = (created.data.handles as NodeHandle[] | undefined)
    ?.filter((item) => item.type !== handle.type)
    .map((item) => ({
      source: sourceNode.id,
      target: targetNode.id,
      sourceHandle: handle.type === "source" ? handle.id : item.id,
      targetHandle: handle.type === "target" ? handle.id : item.id,
    }))
    .find(
      (item) =>
        flow.nodesConnectable.value &&
        sourceNode.connectable !== false &&
        targetNode.connectable !== false &&
        validateConnection(item, { sourceNode, targetNode, nodes: flow.getNodes.value, edges: flow.getEdges.value })
    );
  if (connection) flow.addEdges(connection);
  else ElMessage.warning(translate("节点已创建，但没有兼容的端口可连接"));
  clearConnection();
  menu.value?.handleClose();
}

async function deleteSelection(selection = selectedNodes.value) {
  if (selectionBusy || deleting.value) return;
  const signal = canvasSignal ? AbortSignal.any([deletionLifetime.signal, canvasSignal()]) : deletionLifetime.signal;
  deleting.value = true;
  try {
    await deleteCanvasNodes(flow, selection.filter(node => node.deletable !== false), signal);
    menu.value?.handleClose();
  } catch (error) {
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    if (!signal.aborted) ElMessage.error(message || (error instanceof Error ? error.message : translate("删除选中节点失败")));
  } finally {
    selectedNodes.value = selectedNodes.value.filter((node) => flow.findNode(node.id) === node);
    deleting.value = false;
  }
}
</script>

<style lang="scss" scoped>
.shortcutHint { margin-left: auto; padding-left: 24px; color: var(--el-text-color-placeholder); font-size: 12px; }
.nodeMenu {
  min-width: 180px;

  :deep(.el-divider--horizontal) {
    margin: 4px 0;
  }

  .nextIcon {
    margin-left: auto;
  }
}
</style>

<style lang="scss">
// 分组小标题（添加节点 / 添加资源），和 LibTV 菜单里的灰色小字一样。下拉项渲染在弹层里拿不到 scoped 属性，所以单独放全局样式。
.el-dropdown-menu__item.menuSection.is-disabled { min-height: 0; padding-top: 6px; padding-bottom: 2px; color: var(--el-text-color-placeholder); font-size: 12px; cursor: default; }
</style>
