<template>
  <div class="settingOptions" :class="{ ratioGrid: ratio }" :style="{ '--columns': columns }" role="group" :aria-label="label">
    <button
      v-for="item in options"
      :key="String(item.value)"
      type="button"
      class="settingOption"
      :aria-pressed="isActive(item.value)"
      :disabled="disabled || item.disabled"
      :title="item.title"
      @click="model = item.value">
      <span v-if="ratio" class="ratioShape" :style="ratioStyle(String(item.value))" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>

<script setup lang="ts" generic="T extends string | number | boolean">
// 设置弹层里统一的按钮组：比例、清晰度、画质、时长、数量都用同一种平铺按钮，选中项高亮。
const props = withDefaults(defineProps<{
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  label: string;
  columns?: number;
  ratio?: boolean;
  disabled?: boolean;
  activeValues?: T[];
}>(), { columns: 4 });
const model = defineModel<T>({ required: true });

function isActive(value: T) {
  return model.value === value || Boolean(props.activeValues?.includes(value) && props.activeValues.includes(model.value));
}

function ratioStyle(value: string) {
  const [width = 1, height = 1] = value.split(":").map(Number);
  // auto / adaptive 没有固定比例，画成虚线方框。
  if (!(width > 0 && height > 0)) return { width: "14px", height: "11px", borderStyle: "dashed" };
  return { width: `${14 * Math.min(width / height, 1)}px`, height: `${14 * Math.min(height / width, 1)}px` };
}
</script>

<style scoped lang="scss">
.settingOptions {
  display: grid;
  grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
  gap: 8px;
}

.settingOption {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  height: 36px;
  padding: 0 6px;
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--el-text-color-secondary);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color .15s, border-color .15s, color .15s;

  > span:last-child { overflow: hidden; text-overflow: ellipsis; }

  &:hover:not(:disabled) {
    color: var(--el-text-color-primary);
    background: var(--el-fill-color-light);
  }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: 1px;
  }

  &[aria-pressed="true"] {
    color: var(--el-text-color-primary);
    border-color: var(--el-text-color-secondary);
    background: var(--el-fill-color);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: .4;
  }
}

.ratioGrid .settingOption {
  flex-direction: column;
  gap: 6px;
  height: 60px;
  font-size: 12px;
}

.ratioShape {
  display: inline-block;
  flex-shrink: 0;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  box-sizing: border-box;
}
</style>
