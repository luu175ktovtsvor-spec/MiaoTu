<template>
  <div class="textModelPanel">
    <settings-section
      :title="translate('文本模型')"
      :description="translate('选择 Agent 和文本节点默认使用的模型：可以用妙图提供的模型，也可以用下面你自己接入的供应商。')">
      <feedbackNotice v-if="error" :message="error"  />
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
            <el-option-group v-for="group in modelGroups" :key="group.label" :label="group.label">
              <el-option v-for="model in group.models" :key="model.value" :label="model.label" :value="model.value">
                <div class="modelOption">
                  <modelIcon :model="model.modelId" :size="18" />
                  <span class="modelLabel">{{ model.label }}</span>
                  <el-tag v-if="model.reasoning" size="small" effect="plain">{{ translate('支持推理') }}</el-tag>
                </div>
              </el-option>
            </el-option-group>
          </el-select>
        </el-form-item>
      </el-form>
      <div v-if="selectedModelInfo" class="modelInfo" aria-live="polite">
        <strong>{{ selectedModelInfo.label }}</strong>

        <el-tag v-if="selectedModelInfo.reasoning" size="small" effect="plain">{{ translate('支持推理') }}</el-tag>
      </div>
    </settings-section>
    <settings-section v-if="isDesktop" :title="translate('我的供应商')" :description="translate('接入你自己的大模型账号（OpenAI、DeepSeek、Kimi、通义、本机 Ollama 等），用你自己的 API Key，不消耗妙图积分。')">
      <template #actions>
        <el-button text size="small" :icon="IconPlus" @click="openEditor(null)">{{ translate('添加供应商') }}</el-button>
      </template>
      <feedbackNotice v-if="providerError" :message="providerError"  />
      <p v-else-if="!providers.length" class="localTextHint">{{ translate('还没有接入自己的供应商。') }}</p>
      <ul v-else class="ownProviders">
        <li v-for="provider in providers" :key="provider.id">
          <span class="providerMark" aria-hidden="true"><modelIcon :model="provider.models?.[0]?.id || ''" :provider="`${provider.label} ${provider.apiUrl || ''}`" :size="20" /></span>
          <div class="providerCopy">
            <strong>{{ provider.label }}</strong>
            <small dir="ltr">{{ protocolLabel(provider.protocol) }} · {{ hostOf(provider.apiUrl) }}</small>
            <small>{{ t`${provider.models.length} 个模型` }}<template v-if="!provider.hasKey"> · {{ translate('未填 API Key') }}</template></small>
          </div>
          <el-tag v-if="usingProvider(provider.id)" size="small" effect="plain" type="success">{{ translate('使用中') }}</el-tag>
          <el-button text size="small" :icon="IconPencil" @click="openEditor(provider)">{{ translate('编辑') }}</el-button>
          <el-button text size="small" :icon="IconTrash" :loading="removing === provider.id" @click="remove(provider)">{{ translate('删除') }}</el-button>
        </li>
      </ul>
    </settings-section>
    <providerEditor :visible="editorVisible" :provider="editingProvider" :existingIds="providers.map(item => item.id)" @close="editorVisible = false" @saved="onSaved" />
    <settings-section v-if="isDesktop" :title="translate('豆包与 Dola 文本模型')" :description="translate('在设置 → 豆包与 Dola 中连接账户后，可在文本节点选择对应来源。')">
      <p class="localTextHint">{{ translate('使用豆包或 Dola 账号自带的权益生成文本回复；Agent 和 3D 导演台请选择上面的妙图模型或你接入的模型。') }}</p>
    </settings-section>
  </div>
</template>

<script setup lang="ts">
import feedbackNotice from '../../../components/feedbackNotice.vue';
import { translate } from "@miaoimg/i18n/vue";
import { computed, onMounted, ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { t } from "@miaoimg/i18n/vue";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-vue";
import providerEditor from "./providerEditor.vue";
import { loadUserProviders, removeUserProvider, userProviders, type UserProvider } from "@/lib/providerModels";
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
  providerId: model.providerId,
  providerLabel: model.providerLabel,
  label: model.label || translate("选择模型"),
  reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
  note: (model as { note?: string }).note || "",
})));
// 下拉按来源分组：妙图提供的模型在前，自己接入的供应商各成一组。
const modelGroups = computed(() => {
  const groups = new Map<string, typeof modelOptions.value>();
  for (const model of modelOptions.value) {
    const label = model.providerId === "miaoimg" ? translate("妙图") : model.providerLabel;
    groups.set(label, [...(groups.get(label) ?? []), model]);
  }
  return [...groups].map(([label, models]) => ({ label, models }));
});
const providers = userProviders();
const providerError = ref("");
const editorVisible = ref(false);
const editingProvider = ref<UserProvider | null>(null);
const removing = ref("");
const PROTOCOL_LABELS: Record<string, string> = { "openai-completions": "OpenAI Chat", "openai-responses": "OpenAI Responses", "anthropic-messages": "Anthropic" };
function protocolLabel(value: string) { return PROTOCOL_LABELS[value] ?? value; }
function hostOf(value: string) { try { return new URL(value).host; } catch { return value; } }
function usingProvider(id: string) { try { return JSON.parse(selectedModel.value)?.[0] === id; } catch { return false; } }
function openEditor(provider: UserProvider | null) { editingProvider.value = provider; editorVisible.value = true; }
async function onSaved() { await loadServerModelChoices(true); syncSelection(); }
async function remove(provider: UserProvider) {
  try {
    await ElMessageBox.confirm(translate("删除「{0}」？用它的对话需要重新选择模型。", { 0: provider.label }), translate("删除供应商"), { type: "warning", confirmButtonText: translate("删除"), cancelButtonText: translate("取消") });
  } catch { return; }
  removing.value = provider.id;
  try { await removeUserProvider(provider.id); await loadServerModelChoices(true); syncSelection(); ElMessage.success(translate("已删除")); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : translate("删除失败")); }
  finally { removing.value = ""; }
}
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
    await Promise.all([loadServerModelChoices(true), loadUserProviders(true).catch(error => { providerError.value = error instanceof Error ? error.message : translate("供应商列表读取失败"); })]);
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

  .ownProviders { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none;
    li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 10px; }
    .providerMark { display: grid; flex: 0 0 36px; height: 36px; place-items: center; border-radius: 9px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font-weight: 600; }
    .providerCopy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px;
      strong { color: var(--el-text-color-primary); font-size: 13px; }
      small { overflow: hidden; color: var(--el-text-color-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; } }
    .el-button + .el-button { margin-left: 0; }
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
