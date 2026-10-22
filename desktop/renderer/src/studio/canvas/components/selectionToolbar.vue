<template>
  <el-card
    v-if="visible"
    class="selectionToolbar nodrag nopan nowheel"
    shadow="never"
    :bodyStyle="{ padding: '4px' }"
    :style="toolbarStyle"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @dblclick.stop
    @contextmenu.stop
    @keydown.stop>
    <div class="toolbarActions">
      <el-button text :icon="IconCopyPlus" :disabled="busy || disabled" @click="operate('duplicate')">{{ translate('创建副本') }}</el-button>
      <el-button text :icon="IconBoxMultiple" :disabled="busy || disabled" @click="operate('group')">{{ translate('打组') }}</el-button>
      <el-button text :icon="IconDeselect" :disabled="busy || disabled || !hasGroup" @click="operate('ungroup')">{{ translate('解组') }}</el-button>
    </div>
  </el-card>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { getRectOfNodes, useVueFlow, type GraphNode } from "@vue-flow/core";
import { ElButton, ElCard, ElMessage } from "element-plus";
import { IconCopyPlus, IconBoxMultiple, IconDeselect } from "@tabler/icons-vue";
import { createCanvasSelectionOperations } from "../canvasSelectionOperations";
import { finishGroupDrag, getSelectionRoots, getSelectionTree } from "../selectionNodes";
import { translate } from "@miaoimg/i18n/vue";

const props = defineProps<{
  batchHistory: (action: () => Promise<void>) => Promise<void>;
  getSignal: () => AbortSignal;
  disabled?: boolean;
}>();
const flow = useVueFlow();
const { duplicateNodes, groupNodes, ungroupNodes, mergeGroups, selectNodes } = createCanvasSelectionOperations(flow);
const busy = ref(false);
const hasGroup = computed(() => flow.getSelectedNodes.value.some(node => node.type === "canvasGroup"));
const visible = computed(() => !props.disabled && !flow.userSelectionActive.value && flow.getSelectedNodes.value.length > 0
  && (flow.nodesSelectionActive.value || hasGroup.value));
const toolbarStyle = computed(() => {
  const bounds = getRectOfNodes(flow.getSelectedNodes.value);
  const { x, y, zoom } = flow.viewport.value;
  const element = flow.vueFlowRef.value;
  const flowTop = element?.getBoundingClientRect().top ?? 0;
  const workspace = element?.closest(".workspacePage");
  const menuBottom = Math.max(flowTop, ...Array.from(workspace?.querySelectorAll<HTMLElement>(".workspaceMenu, .canvasMenu, .panelSwitcher") ?? [])
    .filter(item => item.getClientRects().length && getComputedStyle(item).visibility !== "hidden")
    .map(item => item.getBoundingClientRect().bottom));
  return {
    left: `clamp(148px, ${x + (bounds.x + bounds.width / 2) * zoom}px, calc(100% - 148px))`,
    top: `clamp(${menuBottom - flowTop + 12}px, ${y + bounds.y * zoom - 54 - (hasGroup.value ? 30 * zoom : 0)}px, calc(100% - 184px))`,
  };
});

function startDragCopy(selection: GraphNode[], withEdges: boolean) {
  const nodes = getSelectionTree(selection, flow.getNodes.value);
  if (busy.value || props.disabled || !nodes.length) return;
  const roots = getSelectionRoots(nodes, flow.getNodes.value);
  const startPositions = new Map(nodes.map(node => [node.id, { ...node.position }]));
  const positions = new Map(startPositions);
  const signal = props.getSignal();
  const ended = Promise.withResolvers<void>();
  const finish = () => ended.resolve();
  let copies: Map<string, string> | undefined;
  let started = false;

  function moveCopies() {
    for (const node of roots) {
      const copy = flow.findNode(copies?.get(node.id));
      if (copy) {
        copy.position = { ...positions.get(node.id)! };
        copy.dragging = true;
      }
    }
  }

  async function createCopies() {
    busy.value = true;
    signal.addEventListener("abort", finish, { once: true });
    try {
      await props.batchHistory(async () => {
        signal.throwIfAborted();
        const result = await duplicateNodes(selection, signal, withEdges, positions);
        copies = result.ids;
        moveCopies();
        await ended.promise;
        signal.throwIfAborted();
        const created = result.rootIds.flatMap(id => flow.findNode(id) ?? []);
        created.forEach(node => { node.dragging = false; });
        await nextTick();
        signal.throwIfAborted();
        finishGroupDrag(flow.getNodes.value, created);
      });
    } catch (error) {
      if (!signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("拖动复制失败"));
    } finally {
      signal.removeEventListener("abort", finish);
      busy.value = false;
    }
  }

  return {
    update() {
      if (signal.aborted) return;
      // ACT: Vue Flow 固定拖动原节点 ID；同一帧还原原位置，只让副本跟随，松手后统一提交历史。
      for (const node of roots) {
        if (flow.findNode(node.id) !== node) continue;
        positions.set(node.id, { ...node.position });
        node.position = { ...startPositions.get(node.id)! };
        node.dragging = false;
      }
      moveCopies();
      if (!started) {
        started = true;
        void createCopies();
      }
    },
    finish,
  };
}

async function operate(command: "duplicate" | "group" | "ungroup" | "mergeGroup") {
  if (busy.value || props.disabled) return;
  const selection = [...flow.getSelectedNodes.value];
  if (!selection.length) return;
  const signal = props.getSignal();
  busy.value = true;
  try {
    await props.batchHistory(async () => {
      signal.throwIfAborted();
      const ids = command === "duplicate" ? (await duplicateNodes(selection, signal)).rootIds
        : command === "group" ? groupNodes(selection)
        : command === "mergeGroup" ? mergeGroups(selection) : ungroupNodes(selection);
      await selectNodes(ids, signal);
    });
  } catch (error) {
    if (!signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("选区操作失败"));
  } finally {
    busy.value = false;
  }
}

defineExpose({ operate, startDragCopy, busy });
</script>

<style scoped lang="scss">
.selectionToolbar {
  position: absolute;
  z-index: 6;
  width: max-content;
  max-width: calc(100% - 24px);
  transform: translateX(-50%);

  .toolbarActions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;

    .el-button {
      height: 28px;
      margin: 0;
      padding: 0 8px;
    }
  }
}
</style>
