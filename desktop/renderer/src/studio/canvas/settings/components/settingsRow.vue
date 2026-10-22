<template>
  <div class="settingsRow" :class="{ stacked }" :style="{ '--row-control-width': controlWidth || '200px' }">
    <div class="rowInfo">
      <div class="rowHead">
        <span class="rowLabel"><slot name="label">{{ label }}</slot></span>
        <span v-if="value" class="rowValue">{{ value }}</span>
      </div>
      <p v-if="description" class="rowDescription">{{ description }}</p>
      <slot name="info" />
    </div>
    <div class="rowControl"><slot /></div>
  </div>
</template>

<script setup lang="ts">
// 设置项统一按「左说明 / 右控件」的行来排：开关、下拉右对齐到同一列，滑块独占整行。
defineProps<{
  label?: string;
  description?: string;
  value?: string;
  stacked?: boolean;
  controlWidth?: string;
}>();
</script>

<style lang="scss" scoped>
.settingsRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 12px 0;
  border-top: 0;

  &:first-child {
    padding-top: 0;
    border-top: 0;
  }

  &:last-child { padding-bottom: 0; }

  &.stacked {
    display: block;

    .rowControl {
      width: auto;
      // 说明/标签到下面控件：统一节奏的 block 档（见 settings/index.vue）
      margin-top: var(--settings-gap-block);
      justify-content: flex-start;
    }
  }
}

.rowInfo { min-width: 0; overflow-wrap: anywhere; }

.rowHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.rowLabel {
  color: var(--el-text-color-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.5;
}

.rowValue {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
}

.rowDescription {
  margin: var(--settings-gap-group) 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.rowControl {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-shrink: 0;
  gap: 8px;
  width: var(--row-control-width, 200px);

  &:empty { display: none; }

  :deep(.el-select) { flex: 1; min-width: 0; }
  :deep(.el-button + .el-button) { margin-left: 0; }
}

@media (max-width: 760px) {
  .settingsRow {
    display: block;

    .rowControl {
      width: auto;
      // 窄屏换行后控件同样落在说明下方，用与 stacked 相同的档位，
      // 避免「文字贴着框」在窄屏复现。
      margin-top: var(--settings-gap-block);
      justify-content: flex-start;
    }
  }
}
</style>
