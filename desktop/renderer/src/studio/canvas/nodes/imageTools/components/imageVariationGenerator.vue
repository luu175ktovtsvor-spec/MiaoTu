<template>
  <footer class="variationFooter">
    <el-select v-model="settings.model" class="modelSelect" filterable :loading="modelsLoading" :disabled="busy" :placeholder="translate('选择图片模型')" :aria-label="`${label}模型`" :noDataText="translate('请先在设置中添加图片模型')" placement="top-start" @visible-change="visible => visible && refreshModels()">
      <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
        <el-option v-for="model in provider.models" :key="model.modelId" :label="model.label" :value="JSON.stringify([model.providerId, model.modelId])" />
      </el-option-group>
    </el-select>
    <el-popover trigger="click" placement="top" :width="220" :disabled="busy || !selectedModel" :showArrow="false">
      <template #reference><el-button class="sizeButton" text :disabled="busy || !selectedModel" :aria-label="`${label}输出设置`">{{ settings.ratio || translate('比例') }} · {{ settings.size || translate('分辨率') }}</el-button></template>
      <div class="variationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @wheel.stop @keydown.stop>
        <label>{{ translate('分辨率') }}<el-select v-model="settings.size" :disabled="busy" :aria-label="`${label}分辨率`"><el-option v-for="size in sizeOptions" :key="size" :label="size" :value="size" /></el-select></label>
        <label>{{ translate('比例') }}<el-select v-model="settings.ratio" :disabled="busy" :aria-label="`${label}比例`" @change="ratioFromSource = false"><el-option v-for="ratio in ratioOptions" :key="ratio" :label="ratio" :value="ratio" /></el-select></label>
      </div>
    </el-popover>
    <el-button type="primary" :icon="IconSparkles" :loading="generating" :disabled="busy || modelsLoading || !source || !selectedModel || !prompt.trim()" @click="generate">{{ translate('添加到画布') }}</el-button>
  </footer>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useNode } from "@vue-flow/core";
import { ElButton, ElOption, ElOptionGroup, ElPopover, ElSelect } from "element-plus";
import { IconSparkles } from "@tabler/icons-vue";
import { useNodeAi, type NodeMediaModel, type NodeMediaValue } from "@miaoimg/nodes-scaffold/runtime";
const groupNodeModels = (models: NodeMediaModel[]) => [{ id: "miaoimg", label: "妙图", models }];
import { showNodeError } from "../../../scaffold/showNodeError";
import { useImageVariationNode } from "../useImageVariationNode";

const props = defineProps<{
  settings: { model?: string; size?: string; ratio?: string };
  source?: NodeMediaValue;
  aspectRatio: number;
  prompt: string;
  label: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ generated: [] }>();
const generating = defineModel<boolean>("generating", { default: false });
const { node } = useNode();
const ai = useNodeAi();
const createVariation = useImageVariationNode();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const busy = computed(() => props.disabled || generating.value);
const modelGroups = computed(() => groupNodeModels(models.value));
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === props.settings.model));
const sizeOptions = computed(() => selectedModel.value?.imageSizes || []);
const ratioOptions = computed(() => selectedModel.value?.imageRatios || []);
let generationController: AbortController | undefined;
let disposed = false;
let inheritModelConfig = true;
let ratioFromSource = !props.settings.ratio;

function nearestRatio() {
  const numeric = ratioOptions.value.map(value => ({ value, number: value.split(":").map(Number).reduce((width, height) => width / height) })).filter(item => Number.isFinite(item.number) && item.number > 0);
  return props.aspectRatio && numeric.length ? numeric.sort((left, right) => Math.abs(Math.log(left.number / props.aspectRatio)) - Math.abs(Math.log(right.number / props.aspectRatio)))[0]!.value : (ratioOptions.value[0] || "");
}

watch(selectedModel, choice => {
  if (!choice) return;
  if (!sizeOptions.value.includes(props.settings.size || "")) props.settings.size = sizeOptions.value.toSorted((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity))[0] || "";
  if (!ratioOptions.value.includes(props.settings.ratio || "")) props.settings.ratio = nearestRatio();
  if (ratioFromSource && props.aspectRatio) { props.settings.ratio = nearestRatio(); ratioFromSource = false; }
}, { flush: "sync" });
watch(() => props.aspectRatio, value => {
  if (value && ratioFromSource && selectedModel.value) { props.settings.ratio = nearestRatio(); ratioFromSource = false; }
});
watch(() => [props.source?.url, props.source?.mimeType], () => generationController?.abort(), { flush: "sync" });
onMounted(refreshModels);
onScopeDispose(() => { disposed = true; generationController?.abort(); });

async function refreshModels() {
  if (modelsLoading.value || busy.value) return;
  modelsLoading.value = true;
  try {
    const result = await ai.getMediaModels();
    if (disposed) return;
    if (inheritModelConfig) {
      for (const key of ["model", "size", "ratio"] as const) {
        const value = node.data[key];
        if (typeof value === "string" && value.trim()) props.settings[key] = value;
      }
      ratioFromSource = !props.settings.ratio;
      inheritModelConfig = false;
    }
    models.value = result.filter(item => item.type === "image");
    if (!props.settings.model) {
      const choice = models.value[0];
      props.settings.model = choice ? JSON.stringify([choice.providerId, choice.modelId]) : "";
    }
  } catch (error) { if (!disposed) showNodeError(error, "模型读取失败"); }
  finally { modelsLoading.value = false; }
}

async function generate() {
  if (disposed || busy.value || modelsLoading.value || !selectedModel.value || !props.source || !props.prompt.trim()) return;
  const controller = generationController = new AbortController();
  const source = JSON.stringify(props.source);
  const assertAvailable = () => {
    if (disposed || props.disabled || JSON.stringify(props.source) !== source) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
  };
  generating.value = true;
  try {
    await createVariation({ model: props.settings.model || "", size: props.settings.size || "", ratio: props.settings.ratio || "", label: props.label, prompt: props.prompt }, controller.signal, assertAvailable);
    emit("generated");
  } catch (error) { if (!controller.signal.aborted && !disposed) showNodeError(error, `${props.label}失败`); }
  finally { generating.value = false; generationController = undefined; }
}
</script>

<style scoped lang="scss">
.variationFooter {
  display: flex; align-items: center; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 0;
  .modelSelect { flex: 1; min-width: 0; }
  .sizeButton { max-width: 180px; overflow: hidden; }
  > .el-button { margin-left: 0; flex-shrink: 0; }
}
.variationSettings {
  display: grid; gap: 12px;
  label { display: grid; gap: 6px; font-size: 12px; }
}
</style>
