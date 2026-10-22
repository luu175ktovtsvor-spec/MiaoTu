<template>
  <section class="settingsSection">
    <header v-if="title || description || $slots.actions" class="sectionHeader">
      <div class="sectionCopy">
        <h3 v-if="title" class="sectionTitle">{{ title }}</h3>
        <p v-if="description" class="sectionDescription">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="sectionActions"><slot name="actions" /></div>
    </header>
    <div class="sectionBody"><slot /></div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string; description?: string }>();
</script>

<style lang="scss" scoped>
.settingsSection {
  // 画布皮肤会给这一块加卡片底色和圆角（canvas-look.css），但组件自己原本没有内边距，
  // 标题、说明和行内容会顶在卡片左边缘上。这里补上与「外观预览」卡片一致的内边距；
  // 行的上下间距仍由 .settingsRow 负责，别在两边重复叠加。
  // 纵向间距用设置对话框的统一节奏（见 settings/index.vue 的 --settings-gap-*）。
  // 保留卡片边缘的呼吸空间，长标题、数值和滑块刻度不会贴住边框。
  padding: 18px 24px;

  .sectionHeader {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    // 分区说明/标题到下面正文（文本框、开关行……）的呼吸感
    margin-bottom: var(--settings-gap-block);
  }

  .sectionCopy { min-width: 0; overflow-wrap: anywhere; }

  .sectionTitle {
    margin: 0;
    color: var(--el-text-color-primary);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.5;
  }

  .sectionDescription {
    margin: var(--settings-gap-group) 0 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.6;
  }

  .sectionActions {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    gap: 4px;

    :deep(.el-button + .el-button) { margin-left: 0; }
  }
}
</style>
