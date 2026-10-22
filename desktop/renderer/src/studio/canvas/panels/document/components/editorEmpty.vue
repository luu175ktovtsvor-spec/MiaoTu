<template>
  <div class="editorEmpty" role="status" :aria-label="translate('文档空状态')">
    <icon-file-text class="emptyIcon" :size="48" :strokeWidth="1.2" aria-hidden="true" />
    <p class="emptyTitle">{{ translate("尚未打开文档") }}</p>
    <p class="emptyDescription">{{ translate("从左侧文件树选择文件或画布节点") }}</p>
  </div>
</template>

<script setup lang="ts">
import { IconFileText } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
</script>

<style scoped lang="scss">
.editorEmpty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);

  .emptyIcon { color: var(--docEmptyIcon); }
  .emptyTitle {
    margin: 18px 0 8px;
    color: var(--el-text-color-regular);
    font-size: 16px;
    font-weight: 500;
  }
  .emptyDescription {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
  }
}
</style>
