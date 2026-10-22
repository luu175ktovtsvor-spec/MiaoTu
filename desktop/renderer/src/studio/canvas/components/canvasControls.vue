<template>
  <mini-map
    v-if="showMap"
    position="bottom-left"
    :style="{ bottom: '64px' }"
    :pannable="true"
    :zoomable="true"
    node-color="rgba(244, 243, 238, .5)"
    mask-color="rgba(11, 12, 14, .72)"
    mask-stroke-color="var(--el-color-primary)"
    :mask-stroke-width="2" />
  <!-- 左下是视图组（素材、整理、地图、连线、吸附、缩放），正下方是创作工具组；Agent 圆球贴在工具组右侧。 -->
  <panel position="bottom-left" class="canvasViewPanel">
    <elCard class="canvasViewCard" shadow="never" :body-style="{ padding: '4px' }">
      <div class="canvasControls">
        <el-tooltip :showArrow="false" :content="assetsVisible ? translate('关闭素材库') : translate('打开素材库')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton labelButton"
            text
            :type="assetsVisible ? 'primary' : 'default'"
            :aria-pressed="assetsVisible"
            :aria-label="translate('素材库')"
            @click="assetsVisible = !assetsVisible">
            <icon-folders :size="16" />
            <span class="toolLabel">{{ translate('素材库') }}</span>
          </el-button>
        </el-tooltip>
        <!-- trigger 用 contextmenu 是为了让整理按钮只由 arrangeNodes 控制显隐，同时仍保留点击外部自动关闭 -->
        <el-tooltip :showArrow="false" :content="translate('整理画布')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="undoPopoverVisible">
          <span class="toolTrigger">
            <el-popover trigger="contextmenu" placement="top-start" :width="180" v-model:visible="undoPopoverVisible">
              <template #reference>
                <el-button class="toolButton" text :disabled="!canArrange" :aria-label="translate('整理画布')" @click="arrangeNodes">
                  <icon-sitemap :size="17" />
                </el-button>
              </template>
              <div class="zoomMenu">
                <el-button class="zoomAction" style="width: 100%" text @click="undoArrange">{{ translate('撤销整理') }}</el-button>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showMap ? translate('隐藏地图') : translate('显示地图')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showMap ? 'primary' : 'default'"
            :aria-pressed="showMap"
            :aria-label="translate('显示或隐藏地图')"
            @click="showMap = !showMap">
            <icon-map :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="showEdges ? translate('隐藏连线') : translate('显示连线')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="showEdges ? 'primary' : 'default'"
            :aria-pressed="showEdges"
            :aria-label="translate('显示或隐藏连线')"
            @click="showEdges = !showEdges">
            <icon-arrow-guide :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="snapEnabled ? translate('关闭网格吸附') : translate('开启网格吸附')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button
            class="toolButton"
            text
            :type="snapEnabled ? 'primary' : 'default'"
            :aria-pressed="snapEnabled"
            :aria-label="translate('网格吸附')"
            @click="snapEnabled = !snapEnabled">
            <icon-magnet :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false"
          :content="translate('缩放菜单（滚轮调整缩放）')"
          placement="top"
          :hideAfter="0"
          :enterable="false"
          :triggerKeys="[]"
          :disabled="zoomMenuVisible">
          <span class="toolTrigger">
            <el-popover v-model:visible="zoomMenuVisible" trigger="click" placement="top-start" :width="216">
              <template #reference>
                <el-button
                  class="toolButton"
                  text
                  :aria-label="translate('缩放菜单')"
                  @wheel.stop.prevent="$event.deltaY && applyZoom(Math.min(800, Math.max(20, zoomPercent - Math.sign($event.deltaY))))">
                  {{ zoomPercent }}%
                </el-button>
              </template>
              <div class="zoomMenu">
                <el-input-number
                  class="zoomInput"
                  :model-value="zoomPercent"
                  :min="20"
                  :max="800"
                  :controls="false"
                  :aria-label="translate('缩放百分比')"
                  @change="applyZoom">
                  <template #suffix>%</template>
                </el-input-number>
                <el-button class="zoomAction" text @click="zoomIn()">
                  <span>{{ translate('放大') }}</span>
                  <kbd v-if="zoomInShortcut">{{ zoomInShortcut }}</kbd>
                </el-button>
                <el-button class="zoomAction" text @click="zoomOut()">
                  <span>{{ translate('缩小') }}</span>
                  <kbd v-if="zoomOutShortcut">{{ zoomOutShortcut }}</kbd>
                </el-button>
                <el-button class="zoomAction" text @click="fitView({ padding: 0.25, maxZoom: 1 })">
                  <span>{{ translate('适合屏幕') }}</span>
                  <kbd v-if="fitViewShortcut">{{ fitViewShortcut }}</kbd>
                </el-button>
                <div class="zoomPresets" role="group" :aria-label="translate('缩放预设')">
                  <el-button text :aria-label="translate('缩放至50%')" @click="applyZoom(50)">50%</el-button>
                  <el-button text :aria-label="translate('缩放至100%')" @click="applyZoom(100)">100%</el-button>
                  <el-button text :aria-label="translate('缩放至800%')" @click="applyZoom(800)">800%</el-button>
                </div>
              </div>
            </el-popover>
          </span>
        </el-tooltip>
      </div>
    </elCard>
  </panel>
  <panel position="bottom-center">
    <elCard class="canvasControlsCard" shadow="never" :body-style="{ padding: '6px' }">
      <div class="canvasControls">
        <el-tooltip :showArrow="false" :content="translate('添加节点')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton addNodeButton" :aria-label="translate('添加节点')" @click="emit('addNode', $event)">
            <icon-plus :size="18" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="translate('选择')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :type="handMode ? 'default' : 'primary'" :aria-pressed="!handMode" :aria-label="translate('选择')" @click="emit('tool', 'move')">
            <icon-pointer :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="translate('抓手')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :type="handMode ? 'primary' : 'default'" :aria-pressed="handMode" :aria-label="translate('抓手')" @click="emit('tool', 'hand')">
            <icon-hand-stop :size="17" />
          </el-button>
        </el-tooltip>
        <span class="toolDivider" aria-hidden="true" />
        <el-tooltip :showArrow="false" :content="translate('撤销')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :disabled="!canUndo" :aria-label="translate('撤销')" @click="emit('undo')">
            <icon-arrow-back-up :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="translate('重做')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :disabled="!canRedo" :aria-label="translate('重做')" @click="emit('redo')">
            <icon-arrow-forward-up :size="17" />
          </el-button>
        </el-tooltip>
        <el-tooltip :showArrow="false" :content="translate('适应视图')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :aria-label="translate('适应视图')" @click="fitView({ padding: 0.25, maxZoom: 1 })">
            <icon-focus-centered :size="17" />
          </el-button>
        </el-tooltip>
        <span class="toolDivider" aria-hidden="true" />
        <el-tooltip v-if="settingsAvailable" :showArrow="false" :content="translate('设置')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]">
          <el-button class="toolButton" text :aria-label="translate('设置')" @click="openDesktopSettings">
            <icon-settings :size="17" />
          </el-button>
        </el-tooltip>
      </div>
    </elCard>
  </panel>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { Panel, useVueFlow, type GraphNode, type XYPosition } from "@vue-flow/core";
import { MiniMap } from "@vue-flow/minimap";
import { IconMap, IconMagnet, IconFocusCentered, IconSettings, IconPlus, IconPointer, IconHandStop, IconArrowBackUp, IconArrowForwardUp } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import { arrangeCanvas } from "../arrangeCanvas";
import { getShortcutBindings, shortcutLabel } from "@/lib/canvasShortcuts";
import { generalSettings } from "@/stores/settings";
import { translate } from "@miaoimg/i18n/vue";

const props = defineProps<{
  canvasId: string;
  directory: string | undefined;
  batchHistory: (action: () => Promise<void>) => Promise<void>;
  handMode?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
}>();
const emit = defineEmits<{ addNode: [event: MouseEvent]; tool: [tool: "move" | "hand"]; undo: []; redo: [] }>();
const snapEnabled = defineModel<boolean>("snapEnabled", { required: true });
const showEdges = defineModel<boolean>("showEdges", { required: true });
const assetsVisible = defineModel<boolean>("assetsVisible", { default: false });
const showMap = ref(false);
const zoomMenuVisible = ref(false);
const settingsAvailable = "miaoDesktop" in window;
function openDesktopSettings() {
  window.dispatchEvent(new Event("miao-desktop-settings"));
}
const flow = useVueFlow();
const { viewport, zoomTo, zoomIn, zoomOut, fitView, getNodes, updateNode } = flow;
const zoomPercent = computed(() => Math.round(viewport.value.zoom * 100));
const firstShortcutLabel = (binding: string) => shortcutLabel(getShortcutBindings(binding)[0] ?? "");
const zoomInShortcut = computed(() => firstShortcutLabel(generalSettings.value.canvasShortcuts.zoomIn));
const zoomOutShortcut = computed(() => firstShortcutLabel(generalSettings.value.canvasShortcuts.zoomOut));
const fitViewShortcut = computed(() => firstShortcutLabel(generalSettings.value.canvasShortcuts.fitView));
type LayoutSnapshot = { node: GraphNode; parentNode: string | undefined; position: XYPosition; arrangedPosition: XYPosition };
const layoutSnapshot = shallowRef<LayoutSnapshot[]>();
const undoPopoverVisible = ref(false);
const arranging = ref(false);
let arrangeController: AbortController | undefined;
const canArrange = computed(() => {
  const nodes = getNodes.value.filter((node) => !node.parentNode);
  return (
    !!props.canvasId &&
    !!props.directory &&
    !arranging.value &&
    nodes.length > 0 &&
    nodes.every((node) => node.dimensions.width > 0 && node.dimensions.height > 0)
  );
});
defineExpose({ arrangeNodes, showMap });

watch(
  () => [props.canvasId, props.directory],
  () => {
    arrangeController?.abort();
    layoutSnapshot.value = undefined;
    undoPopoverVisible.value = false;
  },
  { flush: "sync" }
);
onBeforeUnmount(() => arrangeController?.abort());

function applyZoom(value: number | undefined) {
  if (value !== undefined && Number.isFinite(value)) void zoomTo(value / 100);
}

async function arrangeNodes() {
  if (!canArrange.value) return;
  const controller = new AbortController();
  arrangeController = controller;
  arranging.value = true;
  layoutSnapshot.value = undefined;
  undoPopoverVisible.value = false;
  const originalNodes = new Map(getNodes.value.map(node => [node.id, node]));
  try {
    await props.batchHistory(async () => {
      const { snapshot, arrangedNodeIds } = await arrangeCanvas(flow, controller.signal);
      controller.signal.throwIfAborted();
      if (!arrangedNodeIds.length) return;
      const entries = snapshot.map(({ id, position }) => {
        const node = flow.findNode(id);
        if (!node || originalNodes.get(id) !== node || node.parentNode) throw new Error(translate("画布已发生变化，本次整理无法直接撤销"));
        return { node, parentNode: node.parentNode, position, arrangedPosition: { ...node.position } };
      });
      layoutSnapshot.value = entries;
      undoPopoverVisible.value = true;
    });
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("整理画布失败"));
  } finally {
    arrangeController = undefined;
    arranging.value = false;
  }
}

async function undoArrange() {
  const snapshot = layoutSnapshot.value;
  if (!snapshot) return;
  try {
    await props.batchHistory(async () => {
      if (snapshot.some(({ node, parentNode, arrangedPosition }) => flow.findNode(node.id) !== node
        || node.parentNode !== parentNode || node.position.x !== arrangedPosition.x || node.position.y !== arrangedPosition.y
        || node.draggable === false || node.dragging || node.resizing)) {
        layoutSnapshot.value = undefined;
        undoPopoverVisible.value = false;
        throw new Error(translate("节点或分组位置已变化，本次整理无法直接撤销"));
      }
      snapshot.forEach(({ node, position }) => updateNode(node.id, { position: { ...position } }));
      layoutSnapshot.value = undefined;
      undoPopoverVisible.value = false;
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("撤销整理失败"));
  }
}
</script>

<style lang="scss" scoped>
// 小地图自带的是白底（@vue-flow/minimap 里写死 background-color:#fff），深色画布上很刺眼，
// 这里换回画布浮层的底色，并让它和工具条一样有圆角和描边。
// 注意：mini-map 是本组件的根元素之一，作用域属性在它自己身上，所以直接用类名而不是 :deep()。
.vue-flow__minimap {
  background-color: #15161a;
  border: 1px solid rgba(244, 243, 238, .14);
  border-radius: 10px;
  overflow: hidden;
}

.canvasControls {
  display: flex;
  align-items: center;
  gap: 4px;

  .toolTrigger {
    display: inline-flex;
  }

  .toolButton {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    margin-left: 0;
    padding: 0;
  }

  .labelButton {
    width: auto;
    padding: 0 10px 0 8px;
    :deep(> span) { gap: 6px; }
  }

  .toolLabel { font-size: 13px; }

  .addNodeButton {
    border: 0;
    border-radius: 10px;
    background: var(--canvas-text, var(--el-text-color-primary));
    color: var(--canvas-bg, var(--el-bg-color));
    &:hover, &:focus-visible { background: color-mix(in srgb, var(--canvas-text, var(--el-text-color-primary)) 86%, transparent); color: var(--canvas-bg, var(--el-bg-color)); }
  }

  .toolDivider {
    width: 1px;
    height: 18px;
    margin: 0 4px;
    background: var(--canvas-line, var(--el-border-color));
  }

}

.zoomMenu {
  display: flex;
  flex-direction: column;

  .zoomInput {
    width: 100%;
  }

  .zoomAction {
    display: flex;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    margin-left: 0;

    :deep(> span) {
      display: flex;
      align-items: center;
      width: 100%;
    }

    kbd {
      margin-left: auto;
      color: var(--el-text-color-placeholder);
      font: inherit;
      white-space: nowrap;
    }
  }

  .zoomPresets {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 2px;
    margin-top: 4px;
    padding-top: 6px;
    border-top: .5px solid var(--canvas-line);

    :deep(.el-button) {
      width: 100%;
      margin-left: 0;
      padding-inline: 0;
      color: var(--el-text-color-regular);
    }
  }
}

</style>
