<template>
  <el-popover v-model:visible="visible" trigger="click" placement="top" :width="1080" :showArrow="false" :persistent="false" popperClass="canvasShortcutPopper">
    <template #reference>
      <span class="toolTrigger">
        <el-tooltip :showArrow="false" :content="translate('快捷键')" placement="top" :hideAfter="0" :enterable="false" :triggerKeys="[]" :disabled="visible">
          <el-button class="toolButton" text :type="visible ? 'primary' : 'default'" :aria-label="translate('快捷键')" :aria-expanded="visible">
            <icon-keyboard :size="17" />
          </el-button>
        </el-tooltip>
      </span>
    </template>
    <!-- 和 LibTV 的快捷键面板一样分四栏；键位读设置里当前的绑定，用户改过就显示改过的。 -->
    <div class="shortcutPanel" role="dialog" :aria-label="translate('快捷键')" @keydown.esc.stop="visible = false">
      <button type="button" class="closeButton" :aria-label="translate('关闭')" @click="visible = false"><icon-x :size="18" /></button>
      <section v-for="group in groups" :key="group.title">
        <h3>{{ translate(group.title) }}</h3>
        <dl>
          <div v-for="row in group.rows" :key="row.id">
            <dt>{{ translate(row.label) }}</dt>
            <dd>
              <template v-if="row.keys.length">
                <kbd v-for="(key, index) in row.keys" :key="index">{{ key }}</kbd>
                <span v-if="row.gesture" class="gesture">{{ translate(row.gesture) }}</span>
              </template>
              <span v-else class="unset">{{ translate('未设置') }}</span>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { IconKeyboard, IconX } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { canvasShortcutFields, getShortcutBindings, shortcutLabel, type CanvasShortcutAction } from "@/lib/canvasShortcuts";
import { generalSettings } from "@/stores/settings";

const visible = ref(false);
const layout: { title: string; ids: CanvasShortcutAction[] }[] = [
  { title: "创作", ids: ["group", "mergeGroup", "ungroup", "addNode", "copyOnDrag", "duplicateOnDrag"] },
  { title: "缩放", ids: ["zoomIn", "zoomOut", "fitView", "zoom"] },
  { title: "移动画布", ids: ["pan", "moveTool", "handTool", "arrange"] },
  { title: "其他", ids: ["undo", "redo", "search", "delete", "copy", "paste"] },
];
const gestures = { drag: "+ 拖动节点", wheel: "+ 滚轮" } as const;
const groups = computed(() => layout.map(group => ({
  title: group.title,
  rows: group.ids.flatMap(id => {
    const field = canvasShortcutFields.find(item => item.id === id);
    if (!field) return [];
    const first = getShortcutBindings(generalSettings.value.canvasShortcuts[id] || "")[0] ?? "";
    return [{ id, label: field.label, keys: first ? shortcutLabel(first).split(" + ") : [], gesture: field.gesture ? gestures[field.gesture] : field.id === "pan" ? "+ 拖动画布" : "" }];
  }),
})));
</script>

<style lang="scss" scoped>
.toolTrigger { display: inline-flex; }
.toolButton { width: 32px; height: 32px; flex-shrink: 0; margin-left: 0; padding: 0; }
.shortcutPanel {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  padding: 12px 8px 4px;
  section { padding: 0 20px; }
  section + section { border-left: 1px solid var(--canvas-line, var(--el-border-color-lighter)); }
  h3 { margin: 0 0 16px; color: var(--el-color-primary); font-size: 14px; font-weight: 600; }
  dl { display: grid; gap: 14px; margin: 0; }
  dl > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; }
  dt { color: var(--el-text-color-secondary); font-size: 13px; white-space: nowrap; }
  dd { display: flex; align-items: center; gap: 6px; margin: 0; }
  kbd { display: inline-grid; min-width: 28px; height: 28px; padding: 0 8px; place-items: center; border: 1px solid var(--canvas-line, var(--el-border-color)); border-radius: 7px; color: var(--el-text-color-primary); font: 500 13px/1 var(--el-font-family); }
  .gesture { color: var(--el-text-color-primary); font-size: 13px; white-space: nowrap; }
  .unset { color: var(--el-text-color-placeholder); font-size: 12px; }
  .closeButton { position: absolute; top: 4px; right: 4px; display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--el-text-color-secondary); cursor: pointer; }
  .closeButton:hover { background: var(--canvas-hover, var(--el-fill-color-light)); }
}
</style>

<style>
.canvasShortcutPopper.el-popover.el-popper { max-width: calc(100vw - 32px); padding: 16px 12px 20px; border-radius: 14px; }
</style>
