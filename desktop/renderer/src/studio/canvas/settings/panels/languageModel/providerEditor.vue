<template>
  <!-- 照 CC Switch 的 Pi 供应商表单：选预设或自定义，填地址、协议和 Key，再从接口拉模型或手动添加。 -->
  <el-dialog
    class="settingsSubdialog"
    :style="dialogTheme"
    :modelValue="visible"
    :title="editing ? translate('编辑供应商') : translate('添加供应商')"
    width="min(720px, calc(100vw - 32px))"
    alignCenter
    appendToBody
    :closeOnClickModal="false"
    @update:modelValue="value => !value && close()">
    <div class="providerEditor">
      <el-form labelPosition="top" @submit.prevent>
        <el-form-item v-if="!editing" :label="translate('预设供应商')">
          <el-select v-model="presetId" filterable :placeholder="translate('搜索厂商、套餐或地区')" :aria-label="translate('预设供应商')" @change="choosePreset">
            <el-option-group v-for="group in presetGroups" :key="group.family" :label="group.family">
              <el-option v-for="preset in group.presets" :key="preset.id" :label="`${preset.label} · ${preset.variant}`" :value="preset.id">
                <span class="presetOption"><strong>{{ preset.variant }}</strong><small>{{ protocolLabel(preset.protocol) }}</small></span>
              </el-option>
            </el-option-group>
          </el-select>
        </el-form-item>
        <div class="fieldGrid">
          <el-form-item :label="translate('名称')" required>
            <el-input v-model="form.label" maxlength="60" :placeholder="translate('例如：我的 DeepSeek')" @input="syncId" />
          </el-form-item>
          <el-form-item :label="translate('供应商 ID')" required>
            <el-input v-model="form.id" maxlength="41" dir="ltr" :disabled="editing" :placeholder="'my-provider'" @input="idTouched = true" />
          </el-form-item>
        </div>
        <el-form-item :label="translate('接口协议')" required>
          <el-select v-model="form.protocol" :aria-label="translate('接口协议')">
            <el-option v-for="item in PROTOCOLS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item :label="translate('API 地址')" required>
          <el-input v-model="form.apiUrl" dir="ltr" placeholder="https://api.example.com/v1" />
        </el-form-item>
        <el-form-item :label="translate('API Key')" :required="!hasSavedKey">
          <el-input v-model="form.apiKey" type="password" showPassword dir="ltr" autocomplete="off"
            :placeholder="hasSavedKey ? translate('已保存，留空表示不修改') : presetId === 'ollama' ? translate('本机模型可随便填，例如 ollama') : translate('填写该供应商的 API Key')" />
        </el-form-item>

        <div class="modelsHeader">
          <span class="modelsTitle">{{ translate('模型') }}<small>{{ t`已添加 ${form.models.length} 个` }}</small></span>
          <el-button size="small" :icon="IconDownload" :loading="fetching" :disabled="!form.apiUrl.trim()" @click="fetchModels">{{ translate('从接口获取') }}</el-button>
        </div>
        <div v-if="fetched.length" class="fetchedBox">
          <el-input v-model="fetchedQuery" size="small" :prefixIcon="IconSearch" clearable :placeholder="translate('搜索模型')" />
          <div class="fetchedList">
            <el-checkbox v-for="model in filteredFetched" :key="model.id" :modelValue="hasModel(model.id)" @change="checked => toggleFetched(model, checked === true)">
              <span dir="ltr">{{ model.id }}</span>
            </el-checkbox>
          </div>
        </div>
        <div class="manualRow">
          <el-input v-model="manualId" size="small" dir="ltr" :placeholder="translate('手动填写模型 ID，例如 deepseek-chat')" @keydown.enter.prevent="addManual" />
          <el-button size="small" :icon="IconPlus" :disabled="!manualId.trim()" @click="addManual">{{ translate('添加') }}</el-button>
        </div>
        <div v-if="form.models.length" class="modelTable" role="table" :aria-label="translate('已添加的模型')">
          <div class="modelHead" role="row">
            <span>{{ translate('模型 ID') }}</span><span>{{ translate('显示名称') }}</span><span>{{ translate('上下文') }}</span><span>{{ translate('最大输出') }}</span><span>{{ translate('推理') }}</span><span>{{ translate('图片') }}</span><span />
          </div>
          <div v-for="(model, index) in form.models" :key="model.id" class="modelRow" role="row">
            <span class="modelId" dir="ltr" :title="model.id">{{ model.id }}</span>
            <el-input v-model="model.label" size="small" :placeholder="model.id" />
            <el-input-number v-model="model.contextWindow" size="small" :min="1" :controls="false" :placeholder="translate('自动')" />
            <el-input-number v-model="model.maxOutputTokens" size="small" :min="1" :controls="false" :placeholder="translate('自动')" />
            <el-switch v-model="model.reasoning" size="small" :aria-label="translate('推理')" />
            <el-switch :model-value="supportsImage(model)" size="small" :aria-label="translate('图片输入')" @change="checked => setImageInput(model, checked === true)" />
            <el-button text size="small" :icon="IconTrash" :aria-label="translate('移除')" @click="form.models.splice(index, 1)" />
          </div>
        </div>
        <p class="privacyNote">{{ translate('API Key 只在这台电脑上，不消耗妙图积分') }}</p>
      </el-form>
    </div>
    <template #footer>
      <el-button @click="close">{{ translate('取消') }}</el-button>
      <el-button type="primary" :loading="saving" @click="save">{{ translate('保存') }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { IconDownload, IconPlus, IconSearch, IconTrash } from "@tabler/icons-vue";
import { t, translate } from "@miaoimg/i18n/vue";
import { fetchProviderModels, saveUserProvider, type ProviderModelEntry, type UserProvider } from "@/lib/providerModels";
import { dialogTheme } from "../../dialogTheme";
import { PROVIDER_PRESETS, type ProviderPreset } from "./providerPresets";

const props = defineProps<{ visible: boolean; provider?: UserProvider | null; existingIds: string[] }>();
const emit = defineEmits<{ close: []; saved: [provider: UserProvider] }>();

const PROTOCOLS = [
  { value: "openai-completions", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic-messages", label: "Anthropic Messages" },
] as const;
type ModelDraft = ProviderModelEntry & { reasoning: boolean };
const form = reactive({ id: "", label: "", apiUrl: "", protocol: "openai-completions", apiKey: "", compat: {} as Record<string, string | number | boolean>, models: [] as ModelDraft[] });
const presetId = ref("custom");
const idTouched = ref(false);
const fetching = ref(false);
const saving = ref(false);
const fetched = ref<ProviderModelEntry[]>([]);
const fetchedQuery = ref("");
const manualId = ref("");
const editing = computed(() => !!props.provider);
const hasSavedKey = computed(() => !!props.provider?.hasKey);
function protocolLabel(value: string) { return PROTOCOLS.find(item => item.value === value)?.label || value; }
const filteredFetched = computed(() => {
  const query = fetchedQuery.value.trim().toLowerCase();
  return query ? fetched.value.filter(model => model.id.toLowerCase().includes(query)) : fetched.value;
});
const presetGroups = computed(() => {
  const groups = new Map<string, ProviderPreset[]>();
  for (const preset of PROVIDER_PRESETS) groups.set(preset.family, [...(groups.get(preset.family) ?? []), preset]);
  return [...groups].map(([family, presets]) => ({ family, presets }));
});

watch(() => props.visible, open => {
  if (!open) return;
  const provider = props.provider;
  Object.assign(form, {
    id: provider?.id ?? "", label: provider?.label ?? "", apiUrl: provider?.apiUrl ?? "", protocol: provider?.protocol ?? "openai-completions", apiKey: "",
    compat: { ...(provider?.compat ?? {}) },
    models: (provider?.models ?? []).map(model => ({ ...model, label: model.label === model.id ? "" : model.label, reasoning: !!model.reasoning })),
  });
  presetId.value = provider ? "" : "custom";
  idTouched.value = !!provider;
  fetched.value = []; fetchedQuery.value = ""; manualId.value = "";
}, { immediate: true });

function slug(value: string) {
  const base = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "").slice(0, 32);
  return base || "provider";
}
function uniqueId(base: string) {
  let id = base, index = 2;
  while (props.existingIds.includes(id)) id = `${base}-${index++}`;
  return id;
}
function syncId() {
  if (!editing.value && !idTouched.value) form.id = uniqueId(slug(form.label));
}
function choosePreset(id: string) {
  const preset = PROVIDER_PRESETS.find(item => item.id === id);
  if (preset) applyPreset(preset);
}
function applyPreset(preset: ProviderPreset) {
  presetId.value = preset.id;
  form.apiUrl = preset.apiUrl;
  form.protocol = preset.protocol;
  form.label = preset.id === "custom" ? "" : `${preset.label} · ${preset.variant}`;
  if (!idTouched.value) form.id = uniqueId(preset.id);
  form.models = preset.models.map(model => ({ ...model, reasoning: Boolean(model.reasoning), input: [...(model.input ?? ["text"])], compat: model.compat ? { ...model.compat } : undefined }));
  fetched.value = [];
}
function hasModel(id: string) { return form.models.some(model => model.id === id); }
function toggleFetched(model: ProviderModelEntry, checked: boolean) {
  if (checked && !hasModel(model.id)) form.models.push({ ...model, label: model.label && model.label !== model.id ? model.label : "", reasoning: Boolean(model.reasoning), input: [...(model.input ?? ["text"])] });
  if (!checked) form.models = form.models.filter(item => item.id !== model.id);
}
function supportsImage(model: ModelDraft) { return model.input?.includes("image") === true; }
function setImageInput(model: ModelDraft, checked: boolean) { model.input = checked ? ["text", "image"] : ["text"]; }
function addManual() {
  const id = manualId.value.trim();
  if (!id) return;
  if (!hasModel(id)) form.models.push({ id, label: "", reasoning: false, input: ["text"] });
  manualId.value = "";
}

async function fetchModels() {
  fetching.value = true;
  try {
    const models = await fetchProviderModels({ ...(editing.value ? { id: form.id } : {}), apiUrl: form.apiUrl.trim(), protocol: form.protocol, apiKey: form.apiKey.trim() || undefined });
    fetched.value = models;
    if (!models.length) ElMessage.warning(translate("接口没有返回模型，可以手动添加模型 ID"));
    else ElMessage.success(t`获取到 ${models.length} 个模型，勾选要用的`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("获取模型列表失败"));
  } finally { fetching.value = false; }
}

async function save() {
  if (!form.label.trim()) return void ElMessage.warning(translate("请填写名称"));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(form.id) || form.id === "miaoimg") return void ElMessage.warning(translate("供应商 ID 只能用字母、数字、点、下划线和短横线"));
  if (!editing.value && props.existingIds.includes(form.id)) return void ElMessage.warning(translate("供应商 ID 已存在，请换一个"));
  if (!form.apiUrl.trim()) return void ElMessage.warning(translate("请填写 API 地址"));
  if (!hasSavedKey.value && !form.apiKey.trim()) return void ElMessage.warning(translate("请填写 API Key"));
  if (!form.models.length) return void ElMessage.warning(translate("至少添加一个模型"));
  saving.value = true;
  try {
    const provider = await saveUserProvider({
      id: form.id, label: form.label.trim(), apiUrl: form.apiUrl.trim(), protocol: form.protocol,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      ...(Object.keys(form.compat).length ? { compat: form.compat } : {}),
      models: form.models.map(model => ({ id: model.id, label: model.label.trim() || model.id,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        reasoning: model.reasoning,
        ...(model.input?.length ? { input: model.input } : {}),
        ...(model.maxTokensField ? { maxTokensField: model.maxTokensField } : {}),
        ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
        ...(model.compat && Object.keys(model.compat).length ? { compat: model.compat } : {}) })),
    });
    ElMessage.success(translate("已保存"));
    emit("saved", provider);
    close();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : translate("保存失败"));
  } finally { saving.value = false; }
}
function close() { form.apiKey = ""; emit("close"); }
</script>

<style lang="scss" scoped>
.providerEditor {
  display: flex; flex-direction: column; gap: 14px;
  .presetOption { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 16px;
    strong { overflow: hidden; color: var(--el-text-color-primary); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
    small { flex: none; color: var(--el-text-color-secondary); font-size: 11px; } }
  .fieldGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
  :deep(.el-form-item) { margin-bottom: 12px; }
  .el-select { width: 100%; }
  .modelsHeader { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 8px; }
  .modelsTitle { font-size: 13px; font-weight: 600; color: var(--el-text-color-primary); small { margin-left: 8px; font-weight: 400; color: var(--el-text-color-secondary); } }
  .fetchedBox { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
  .fetchedList { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2px 12px; max-height: 180px; overflow: auto; :deep(.el-checkbox) { min-width: 0; margin-right: 0; } :deep(.el-checkbox__label) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } }
  .manualRow { display: flex; gap: 8px; margin-bottom: 10px; }
  .modelTable { display: flex; flex-direction: column; gap: 6px; }
  .modelHead, .modelRow { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1.1fr) 86px 86px 42px 42px 28px; align-items: center; gap: 8px; }
  .modelHead { color: var(--el-text-color-secondary); font-size: 12px; }
  .modelId { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-family: var(--el-font-family); }
  :deep(.el-input-number) { width: 100%; }
  .privacyNote { margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
}
</style>
