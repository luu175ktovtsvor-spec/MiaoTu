<template>
  <el-popover v-if="items.length" v-model:visible="open" :persistent="false" trigger="click" placement="top-start" :width="200" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '8px' }">
    <template #reference>
      <el-button class="modeButton" text size="small" :disabled="disabled" :aria-label="translate('视频生成模式')">
        <component :is="current?.icon || IconTypography" :size="15" aria-hidden="true" />
        <span>{{ current?.label || translate('选择模式') }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="modeMenu nodrag nopan nowheel" role="menu" :aria-label="translate('视频生成模式')" @pointerdown.stop @mousedown.stop @wheel.stop>
      <div class="modeMenuTitle">{{ translate('视频生成模式') }}</div>
      <button
        v-for="item in items"
        :key="item.value"
        type="button"
        role="menuitemradio"
        class="modeItem"
        :aria-checked="item.value === mode"
        :disabled="!item.available"
        :title="item.available ? item.description : translate('连入对应素材后可用')"
        @click="choose(item.value)">
        <component :is="item.icon" :size="15" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </button>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElPopover } from "element-plus";
import { IconArrowAutofitRight, IconAtom2, IconChevronUp, IconLayersIntersect, IconPencil, IconPhoto, IconPhotoPlus, IconTypography } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import type { NodeMediaModel } from "@miaoimg/nodes-scaffold/runtime";
import { videoModeDescription, videoModeLabel, videoReferenceTypes } from "./videoModeText";

// 生成模式单独放在模型旁边（LibTV 同款）：顺序固定为文生视频、全能参考、图生视频、首尾帧、图片参考，
// 当前连入的素材用不了的模式置灰；节点仍按素材自动切到可用模式，保存值保持原样。
const props = defineProps<{ model?: NodeMediaModel; available: string[]; disabled?: boolean }>();
const mode = defineModel<string>({ required: true });
const open = ref(false);

type Mode = NonNullable<NodeMediaModel["mode"]>[number];
function rank(item: Mode) {
  if (Array.isArray(item)) return videoReferenceTypes(item, props.model).some(type => type !== "image") ? 1 : 4;
  return ({ text: 0, singleImage: 2, startEndRequired: 3, endFrameOptional: 3, startFrameOptional: 3, edit: 5, extend: 6 } as Record<string, number>)[item] ?? 7;
}
function icon(item: Mode) {
  if (Array.isArray(item)) return rank(item) === 1 ? IconAtom2 : IconPhotoPlus;
  return ({ text: IconTypography, singleImage: IconPhoto, edit: IconPencil, extend: IconArrowAutofitRight } as Record<string, typeof IconPhoto>)[item] ?? IconLayersIntersect;
}
const items = computed(() => (props.model?.mode ?? [])
  .map((item, index) => ({ item, index }))
  .sort((left, right) => rank(left.item) - rank(right.item) || left.index - right.index)
  .map(({ item }) => {
    const value = JSON.stringify(item);
    return { value, label: videoModeLabel(item, props.model), description: videoModeDescription(item, props.model), icon: icon(item), available: props.available.includes(value) };
  }));
const current = computed(() => items.value.find(item => item.value === mode.value));

function choose(value: string) {
  mode.value = value;
  open.value = false;
}
</script>

<style scoped lang="scss">
.modeButton {
  flex-shrink: 0;
  border-radius: 8px;
  :deep(> span) { gap: 6px; }
}

.modeMenu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modeMenuTitle {
  padding: 4px 8px 8px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.modeItem {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled),
  &[aria-checked="true"] { background: var(--el-fill-color); }

  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }

  &:disabled {
    color: var(--el-text-color-placeholder);
    cursor: not-allowed;
  }
}
</style>
