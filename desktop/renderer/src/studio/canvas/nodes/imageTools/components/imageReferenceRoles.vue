<template>
  <div v-if="model?.referenceRoles?.length && images.length" class="referenceRoles nodrag nopan" @pointerdown.stop @keydown.stop>
    <div class="rolesHeading"><span>{{ translate('参考分工') }}</span><el-tooltip placement="top" :content="translate('参考用途会加入编辑指令，不保证人物或未编辑区域完全不变。')"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip></div>
    <label v-for="(item, index) in images" :key="referenceKey(item)"><span>{{ translate('参考 {0}', { 0: index + 1 }) }}</span><el-select :model-value="selectedRole(item)" size="small" :disabled="disabled" :aria-label="translate('参考 {0}', { 0: index + 1 })" @change="value => saved = { ...saved, [referenceKey(item)]: String(value) }"><el-option v-for="role in model.referenceRoles" :key="role.value" :value="role.value" :label="translate(role.label)" /></el-select></label>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { ElButton, ElOption, ElSelect, ElTooltip } from "element-plus";
import { IconInfoCircle } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import type { NodeMediaModel } from "../../../scaffold/nodeAi";
import type { NodeInputValue } from "../../../scaffold/values";
import { referenceKey } from "../../../scaffold/nodeReferences";
const props = defineProps<{ references: NodeInputValue[]; model?: NodeMediaModel; disabled?: boolean }>();
const saved = defineModel<Record<string, string>>({ required: true });
const images = computed(() => props.references.filter(item => item.dataType === "IMAGE" && item.value));
function selectedRole(item: NodeInputValue) {
  const value = saved.value[referenceKey(item)];
  return props.model?.referenceRoles?.some(role => role.value === value) ? value : "general";
}
</script>

<style scoped>
.referenceRoles { display: grid; gap: 6px; margin-bottom: 10px; }
.rolesHeading, .referenceRoles label { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 12px; }
.referenceRoles label .el-select { width: 160px; }
</style>
