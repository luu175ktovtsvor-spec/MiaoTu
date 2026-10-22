<template>
  <div class="editorHost">
    <dockview-vue
      class="editorDock"
      :theme="theme"
      :disableFloatingGroups="true"
      defaultTabComponent="editorTab"
      defaultRenderer="always"
      watermarkComponent="editorEmpty"
      @ready="emit('ready', $event)" />
  </div>
</template>

<script setup lang="ts">
import { DockviewVue, type DockviewReadyEvent } from "dockview-vue";
import editorTab from "./components/editorTab.vue";
import extView from "./components/extView.vue";
import editorEmpty from "./components/editorEmpty.vue";
import { theme } from "./theme";
// dockview 的样式只在文档面板的按需 chunk 里加载，不影响工作台首屏。
import "dockview-vue/dist/styles/dockview.css";

// dockview 按字符串名找组件，所以 tab/watermark/内容组件都要挂在本组件上。
defineOptions({ components: { editorTab, extView, editorEmpty } });
const emit = defineEmits<{ ready: [event: DockviewReadyEvent] }>();
</script>

<style scoped lang="scss">
// dockview 的根元素拿不到 scoped 属性，尺寸要靠这层自己的 div 撑开，再用 :deep 传给 dockview。
.editorHost {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;

  :deep(.editorDock) {
    width: 100%;
    height: 100%;
  }
}
</style>
