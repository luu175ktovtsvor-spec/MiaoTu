<template>
  <div class="modelPopover" :title="disabled ? disabledReason : undefined">
    <el-popover
      :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }"
      v-model:visible="visible"
      trigger="click"
      placement="top-start"
      :width="280"
      :offset="10"
      :showArrow="false"
      popperClass="agentModelPopover"
      :popperStyle="{ padding: '6px', maxWidth: 'calc(100vw - 24px)' }">
      <template #reference>
        <el-button class="modelButton" text :disabled="disabled" :aria-label="translate('模型与推理设置')" :aria-description="disabled ? disabledReason : undefined">
          <modelIcon v-if="selectedModelChoice" :model="selectedModelChoice.modelId" :size="14" />
          <span class="modelName">{{ selectedModelChoice?.label || translate('选择模型') }}</span>
          <span v-if="reasoningOptions.length > 1" class="reasoningLabel">· {{ reasoningLabel }}</span>
          <icon-chevron-down :size="12" />
        </el-button>
      </template>
      <div class="modelOptions" role="listbox" :aria-label="translate('选择模型')">
        <p v-if="!modelOptions.length" class="modelEmpty">{{ translate('暂无可用模型，请登录或在设置中添加模型') }}</p>
        <template v-for="group in modelGroups" :key="group.label">
          <div class="modelGroupLabel">{{ group.label }}</div>
          <button v-for="model in group.models" :key="model.value" type="button" role="option" class="modelOption" :aria-selected="model.value === selectedModel" :disabled="disabled" @click="chooseModel(model.value)">
            <modelIcon :model="model.modelId" :size="16" />
            <span class="modelOptionLabel">{{ model.label || translate('选择模型') }}</span>
            <icon-check v-if="model.value === selectedModel" :size="15" class="modelCheck" aria-hidden="true" />
          </button>
        </template>
        <template v-if="reasoningOptions.length > 1">
          <div class="modelGroupLabel">{{ translate('推理等级') }}</div>
          <div class="reasoningOptions" role="radiogroup" :aria-label="translate('推理等级')">
            <button v-for="item in reasoningOptions" :key="item.value" type="button" role="radio" :aria-checked="item.value === reasoningEffort" :disabled="disabled" @click="reasoningEffort = item.value">{{ item.label }}</button>
          </div>
        </template>
      </div>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { IconCheck, IconChevronDown } from "@tabler/icons-vue";
import { modelIcon } from "@miaoimg/model-icons";
import { modelChoices, loadServerModelChoices } from "@/stores/settings";
import { translate } from "@miaoimg/i18n/vue";

const selectedModel = defineModel<string>({ default: "" });
const reasoningEffort = defineModel<string>("reasoningEffort", { default: "" });
const props = withDefaults(defineProps<{ active?: boolean; disabled?: boolean; disabledReason?: string }>(), { active: true, disabled: false, disabledReason: "" });
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
function chooseModel(value: string) {
  if (props.disabled) return;
  if (value !== selectedModel.value) reasoningEffort.value = "";
  selectedModel.value = value;
}
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
    display: flex;
    flex-direction: column;
    max-height: min(60vh, 420px);
    overflow-y: auto;
  }

  .modelGroupLabel {
    padding: 8px 10px 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .modelEmpty {
    margin: 0;
    padding: 10px;
    color: var(--el-text-color-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .modelOption {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--el-text-color-primary);
    font: inherit;
    font-size: 13px;
    justify-content: flex-start;
    width: 100%;
    text-align: left;
    cursor: pointer;

    .modelIcon { flex: 0 0 auto; }
    .modelOptionLabel { flex: 1; min-width: 0; overflow: hidden; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .modelCheck { flex-shrink: 0; color: var(--el-text-color-primary); }
    &:hover:not(:disabled), &[aria-selected="true"] { background: var(--el-fill-color); }
    &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: -2px; }
    &:disabled { cursor: not-allowed; opacity: .5; }
  }

  .reasoningOptions {
    display: flex;
    gap: 4px;
    padding: 2px 6px 6px;

    button {
      flex: 1;
      height: 28px;
      border: 1px solid var(--el-border-color);
      border-radius: 8px;
      background: transparent;
      color: var(--el-text-color-regular);
      font: inherit;
      font-size: 12px;
      cursor: pointer;

      &[aria-checked="true"] { border-color: var(--el-text-color-primary); color: var(--el-text-color-primary); background: var(--el-fill-color); }
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 1px; }
      &:disabled { cursor: not-allowed; opacity: .5; }
    }
  }
}
</style>
