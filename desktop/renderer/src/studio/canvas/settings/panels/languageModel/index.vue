<template>
  <div class="textModelPanel">
    <settings-section
      :title="translate('文本模型')"
      :description="translate('选择 Agent 和文本节点使用的模型；模型由妙图统一提供。')">
      <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
      <el-form v-else labelPosition="top">
        <el-form-item :label="translate('模型')">
          <el-select
            v-model="selectedModel"
            filterable
            :loading="loading"
            :disabled="loading || !modelOptions.length"
            :placeholder="translate('选择模型')"
            :aria-label="translate('选择模型')"
            @change="saveModel">
            <el-option v-for="model in modelOptions" :key="model.value" :label="model.label" :value="model.value">
              <div class="modelOption">
                <modelIcon :model="model.modelId" :size="18" />
                <span class="modelLabel">{{ model.label }}</span>
                <el-tag v-if="model.reasoning" size="small" effect="plain">{{ translate('支持推理') }}</el-tag>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="selectedModelInfo" class="modelInfo" aria-live="polite">
        <strong>{{ selectedModelInfo.label }}</strong>

        <el-tag v-if="selectedModelInfo.reasoning" size="small" effect="plain">{{ translate('支持推理') }}</el-tag>
      </div>
    </settings-section>
    <settings-section v-if="isDesktop" :title="translate('豆包与 Dola 文本模型')" :description="translate('在设置 → 豆包与 Dola 中连接账户后，可在文本节点选择对应来源。')">
      <p class="localTextHint">{{ translate('使用豆包或 Dola 账号自带的权益，提供普通文本回复，暂不支持 Agent 和导演台的工具调用。') }}</p>
    </settings-section>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import modelIcon from "@/studio/canvas/components/modelIcon.vue";
import settingsSection from "../../components/settingsSection.vue";
import { loadServerModelChoices, modelChoices, textModelSettings, updateTextModelSettings } from "@/stores/settings";

const loading = ref(false);
const error = ref("");
const isDesktop = Boolean(window.miaoDesktop);
const selectedModel = ref("");

const modelOptions = computed(() => modelChoices.value.map(model => ({
  value: model.value,
  modelId: model.modelId,
  label: model.label || translate("选择模型"),
  reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
  note: (model as { note?: string }).note || "",
})));
const selectedModelInfo = computed(() => modelOptions.value.find(model => model.value === selectedModel.value));

function syncSelection() {
  const saved = textModelSettings.value;
  selectedModel.value = modelOptions.value.some(model => model.value === saved) ? saved : modelOptions.value[0]?.value || "";
}

function saveModel(value: string) {
  if (!value) return;
  updateTextModelSettings(value);
  ElMessage.success(translate("已保存"));
}

watch(modelOptions, syncSelection, { immediate: true });

onMounted(async () => {
  loading.value = true;
  error.value = "";
  try {
    await loadServerModelChoices(true);
    syncSelection();
  } catch (loadError) {
    error.value = translate("模型列表暂时无法加载，请稍后重新打开设置。");
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped src="../../providerList.scss"></style>
<style lang="scss" scoped>
.textModelPanel {
  display:flex; flex-direction:column; gap:var(--settings-gap-section);
  .localTextHint { margin:0; font-size:13px; line-height:1.7; color:var(--el-text-color-secondary); }
  :deep(.el-alert) { margin-bottom: var(--settings-gap-tight); }

  // Element Plus 的顶部标签自带 8px，太贴下拉框；这里改成本对话框统一的 block 档。
  :deep(.el-form-item--label-top .el-form-item__label) { margin-bottom: var(--settings-gap-block); }

  // 表单是这个分区里唯一的内容，去掉表单项自带的 18px 底边距，
  // 免得卡片底部多出一段没有内容的空白。
  :deep(.el-form-item) { margin-bottom: 0; }

  .el-select { width: min(100%, 420px); }

  .modelOption {
    display: flex;
    align-items: center;
    gap: 8px;

    .modelLabel { flex: 1; min-width: 0; }
  }

  .modelInfo {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    // 下拉框到下面模型信息：控件 → 辅助信息
    margin-top: var(--settings-gap-tight);
    color: var(--el-text-color-secondary);
    font-size: 12px;

    strong { color: var(--el-text-color-primary); font-size: 13px; }
  }
}
</style>
