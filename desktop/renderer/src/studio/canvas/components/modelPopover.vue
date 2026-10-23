<template>
  <div class="modelPopover">
    <el-popover
      :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }"
      v-model:visible="visible"
      trigger="click"
      placement="top-start"
      :width="340"
      :offset="10"
      :showArrow="false"
      popperClass="agentModelPopover"
      :popperStyle="{ padding: '20px', maxWidth: 'calc(100vw - 24px)' }">
      <template #reference>
        <el-button class="modelButton" text :disabled="disabled" :aria-label="translate('模型与推理设置')">
          <modelIcon v-if="selectedModelChoice" :model="selectedModelChoice.modelId" :size="14" />
          <span class="modelName">{{ selectedModelChoice?.label || translate('选择模型') }}</span>
          ·
          <span class="reasoningLabel">{{ reasoningLabel }}</span>
          <icon-chevron-down :size="12" />
        </el-button>
      </template>
      <el-form class="modelOptions" labelPosition="top">
        <el-form-item :label="translate('模型')">
          <el-select v-model="selectedModel" @change="reasoningEffort = ''" filterable :disabled="disabled" :placeholder="translate('选择模型')" :aria-label="translate('选择模型')" :noDataText="translate('请先在设置中添加模型')">
            <template #prefix><modelIcon v-if="selectedModelChoice" :model="selectedModelChoice.modelId" :size="18" /></template>
            <el-option-group v-for="group in modelGroups" :key="group.label" :label="group.label">
              <el-option v-for="model in group.models" :key="model.value" :label="model.label || translate('选择模型')" :value="model.value">
                <el-space :size="8">
                  <modelIcon :model="model.modelId" :size="16" />
                  <span>{{ model.label || translate('选择模型') }}</span>
                </el-space>
              </el-option>
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item :label="translate('推理等级')">
          <el-segmented v-model="reasoningEffort" :options="reasoningOptions" :disabled="disabled" block :aria-label="translate('推理等级')" />
        </el-form-item>
      </el-form>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IconChevronDown } from "@tabler/icons-vue";
import { modelIcon } from "@miaoimg/model-icons";
import { modelChoices, loadServerModelChoices } from "@/stores/settings";
import { translate } from "@miaoimg/i18n/vue";

const selectedModel = defineModel<string>({ default: "" });
const reasoningEffort = defineModel<string>("reasoningEffort", { default: "" });
const props = withDefaults(defineProps<{ active?: boolean; disabled?: boolean }>(), { active: true, disabled: false });
const visible = ref(false);
// 妙图的模型来自服务端目录；前端不展示供应商和内部标识，只列显示名称。
const modelOptions = computed(() => modelChoices.value);
const modelGroups = computed(() => {
  const groups = new Map<string, typeof modelOptions.value>();
  for (const model of modelOptions.value) {
    const label = model.providerId === "miaoimg" ? translate("妙图") : model.providerLabel || model.providerId;
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  return [...groups].map(([label, models]) => ({ label, models }));
});
const selectedModelChoice = computed(() => modelChoices.value.find(item => item.value === selectedModel.value));
// 推理等级由模型自己决定（例如 DeepSeek 只有 低/高/最高），标签跟着画布语言重渲染。
const EFFORT_LABELS: Record<string, string> = { low: "低", medium: "中", high: "高", xhigh: "极高", max: "最高" };
const reasoningOptions = computed(() => {
  const options = [{ label: translate("默认"), value: "" }];
  const efforts = selectedModelChoice.value?.reasoningEfforts;
  if (!Array.isArray(efforts) || !efforts.length) return options;
  return [...options, ...efforts.map((value: string) => ({ label: translate(EFFORT_LABELS[value] ?? value), value }))];
});
const reasoningLabel = computed(() => reasoningOptions.value.find(item => item.value === reasoningEffort.value)?.label ?? translate("默认"));
watch(visible, open => { if (open) void loadServerModelChoices(true); });
watch(modelChoices, items => {
  // Keep the session choice while the catalog loads; an unavailable model
  // requires an explicit new choice instead of silently changing providers.
  if (!selectedModel.value && items.length) selectedModel.value = items[0]!.value;
}, { immediate: true });
watch(() => !props.active || props.disabled, close => { if (close) visible.value = false; });
</script>

<style lang="scss">
.modelPopover {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;

  .modelButton {
    max-width: 100%;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    color: var(--el-text-color-regular);

    > span {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    svg {
      flex-shrink: 0;
    }

    .reasoningLabel {
      flex-shrink: 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .modelName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
  }
}

.agentModelPopover {
  .modelOptions {
    .el-form-item {
      margin-bottom: 24px;

      &:last-child {
        margin-bottom: 0;
      }
      .el-form-item__label {
        margin-bottom: 10px;
        font-weight: 500;
        color: var(--el-text-color-primary);
      }
      .el-segmented {
        width: 100%;

        @media (max-width: 360px) {
          .el-segmented__item {
            padding-inline: 6px;
          }
        }
      }
    }
  }
}
</style>
