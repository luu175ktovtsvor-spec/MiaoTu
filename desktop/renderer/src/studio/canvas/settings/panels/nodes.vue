<template>
  <settings-section :description="translate('关闭后不再出现在添加菜单中，已有节点和内容会继续保留。')">
    <settings-row v-for="item in nodeCatalog" :key="item.type" :label="translate(item.label)">
      <el-switch :modelValue="!nodeSettings.disabledNodeTypes.includes(item.type)" :aria-label="translate('启用 {0}', { 0: translate(item.label) })" @change="value => setEnabled(item.type, value === true)" />
    </settings-row>
  </settings-section>
</template>
<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import settingsSection from "../components/settingsSection.vue";
import settingsRow from "../components/settingsRow.vue";
import { nodeCatalog, nodeSettings, updateNodeSettings } from "@/stores/settings";
function setEnabled(type: string, enabled: boolean) {
  const disabled = new Set(nodeSettings.value.disabledNodeTypes);
  if (enabled) disabled.delete(type); else disabled.add(type);
  updateNodeSettings({ disabledNodeTypes: [...disabled] });
}
</script>
