<template>
  <teleport :to="target ?? 'body'" :disabled="!target">
  <el-card v-show="!!target" class="inpaintPrompt" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
    <promptInput v-model="promptModel" v-model:text="prompt" :references="[]" expandable />
    <div class="promptFooter">
      <el-select
        v-model="model"
        class="modelSelect" popper-class="modelSelectPopper"
        filterable
        :loading="modelsLoading"
        :disabled="disabled || generating"
        :placeholder="translate('选择模型')"
        :aria-label="translate('局部重绘模型')"
        :noDataText="modelsNeedSignIn ? translate('登录后可选择模型') : translate('暂无可用于局部重绘的图片模型')"
        placement="top-start"
        @visible-change="visible => visible && loadModels().catch(error => showNodeError(error, translate('模型读取失败')))">
        <template #prefix><icon-sparkles :size="17" /></template>
        <el-option v-for="item in models" :key="JSON.stringify([item.providerId, item.modelId])" :label="item.label || item.modelId" :value="JSON.stringify([item.providerId, item.modelId])" />
      </el-select>
      <el-popover trigger="click" placement="top-start" :width="260" :disabled="disabled || generating || !selectedModel" :showArrow="false">
        <template #reference>
          <el-button class="settingsButton" text size="small" :disabled="disabled || generating || !selectedModel" :aria-label="translate('局部重绘设置')">
            <span>{{ ratio || translate('比例') }} · {{ size ? sizeTier(size) || translate('自动') : translate('清晰度') }} · {{ translate('1 张') }}</span>
            <icon-chevron-up :size="14" aria-hidden="true" />
          </el-button>
        </template>
        <div class="inpaintSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
          <label>
            <span>{{ translate('清晰度') }}</span>
            <el-select v-model="size" :disabled="disabled || generating" :aria-label="translate('局部重绘清晰度')">
              <el-option v-for="item in sizeOptions" :key="item" :label="mediaSizeLabel(item, '', translate('自动'))" :value="item" />
            </el-select>
          </label>
          <label>
            <span>{{ translate('比例') }}</span>
            <el-select v-model="ratio" :disabled="disabled || generating" :aria-label="translate('局部重绘比例')">
              <el-option v-for="item in ratioOptions" :key="item" :label="item" :value="item" />
            </el-select>
          </label>
        </div>
      </el-popover>
      <el-button
        class="sendButton"
        :icon="generating ? IconPlayerStop : IconArrowUp"
        :disabled="!generating && (disabled || !pending && (!prompt.trim() || !selectedModel))"
        :title="generating ? translate('停止生成') : pending ? translate('继续取回') : translate('重绘')"
        :aria-label="generating ? translate('停止生成') : pending ? translate('继续取回') : translate('重绘')"
        @click="generating ? cancel() : startGeneration()" />
    </div>
  </el-card>
  </teleport>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElOption, ElPopover, ElSelect } from "element-plus";
import { IconArrowUp, IconChevronUp, IconPlayerStop, IconSparkles } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { nodeTools, z } from "../nodeTools";
import { useNodeAi, type NodeInpaintInput, type NodeMediaModel } from "../nodeAi";
import { isSignInRequired, showNodeError } from "../showNodeError";
import promptInput from "./promptInput.vue";
import { mediaSizeLabel, sizeTier } from "../../../../../../../server/media-size-label";

const props = defineProps<{
  generate: (input?: NodeInpaintInput, signal?: AbortSignal) => Promise<void>;
  cancel: () => void;
  generating: boolean;
  pending: boolean;
  disabled?: boolean;
  target?: HTMLElement;
}>();
// 只有带区域编辑通道的模型才进这个列表：蒙版通道（GPT 图片编辑）或标注通道（Seedream 5.0）。
// 服务端对没有通道的模型会直接拒绝 edit，所以这里不列出来，界面上也不写解释。
const regionEdit = defineModel<"mask" | "annotation" | null>("regionEdit", { default: null });
const ai = useNodeAi();
const prompt = ref("");
const promptModel = ref<NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>>([]);
const model = ref("");
const size = ref("");
const ratio = ref("");
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const modelsNeedSignIn = ref(false);
const generating = computed(() => props.generating);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const sizeOptions = computed(() => selectedModel.value?.imageSizes || []);
const ratioOptions = computed(() => selectedModel.value?.imageRatios || []);
let modelsRequest: Promise<void> | undefined;
let disposed = false;

watch(selectedModel, choice => {
  // 选中的模型决定编辑器用涂抹还是框选，先把通道告诉父组件，再对齐尺寸档位。
  regionEdit.value = choice?.regionEdit ?? null;
  if (!choice) return;
  // ACT: 沿用图片生成节点的 K 单位排序，其他单位排在数值选项之后。
  if (!sizeOptions.value.includes(size.value)) size.value = sizeOptions.value.toSorted((left, right) =>
    (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
  )[0] || "";
  if (!ratioOptions.value.includes(ratio.value)) ratio.value = ratioOptions.value[0] || "";
}, { flush: "sync" });

onMounted(() => loadModels().catch(error => { if (!disposed) showNodeError(error, translate("模型读取失败")); }));
onScopeDispose(() => {
  disposed = true;
});
defineExpose({ generating, startGeneration });

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then(items => {
    if (disposed || generating.value) return;
    // 没有区域编辑通道的图片模型不进列表，避免选了之后只能得到服务端拒绝。
    models.value = items.filter(item => item.type === "image" && item.regionEdit);
    if (!model.value) {
      const first = models.value[0];
      model.value = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).then(() => { modelsNeedSignIn.value = false; }, (error) => {
    if (!isSignInRequired(error)) throw error;
    modelsNeedSignIn.value = true;
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

async function startGeneration(signal?: AbortSignal, toolCall = false) {
  signal?.throwIfAborted();
  const choice = selectedModel.value;
  if (disposed || generating.value || props.disabled) throw new Error('节点正在处理');
  if (!props.pending && (!choice || !prompt.value.trim())) throw new Error('请先配置模型、提示词和选区');
  try {
    await props.generate(props.pending ? undefined : {
      providerId: choice!.providerId,
      modelId: choice!.modelId,
      prompt: prompt.value.trim(),
      size: size.value,
      ratio: ratio.value,
    }, signal);
  } catch (error) {
    if (toolCall) throw error;
    if (!props.pending && !disposed && (error as Error)?.name !== 'AbortError') showNodeError(error, translate("局部重绘失败"));
  }
}

function currentConfig() { return { config: { providerId: selectedModel.value?.providerId, modelId: selectedModel.value?.modelId, prompt: prompt.value, size: size.value, ratio: ratio.value, regionEdit: regionEdit.value }, models: models.value }; }
nodeTools.register({
  name: 'getInpaintConfig', description: '进入 editImageMarks 的 inpaint 模式后读取局部重绘配置与真实模型能力，仅查询不生成。', parameters: z.strictObject({}),
  async execute() { await loadModels(); return currentConfig(); },
});
nodeTools.register({
  name: 'setInpaintConfig', description: '设置局部重绘模型、提示词和输出参数，不发起生成。切换模型可能切换蒙版/框选模式并清空旧选区，设置后再用 editImageMarks 绘制。',
  parameters: z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1), prompt: z.string().optional(), size: z.string().optional(), ratio: z.string().optional() }),
  async execute(args, { signal }) {
    if (generating.value || props.disabled) throw new Error('节点正在处理');
    await loadModels(); signal?.throwIfAborted();
    const choice = models.value.find(item => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error('请选择 getInpaintConfig 返回的模型');
    if (args.size !== undefined && !choice.imageSizes?.includes(args.size)) throw new Error('当前模型不支持该分辨率');
    if (args.ratio !== undefined && !choice.imageRatios?.includes(args.ratio)) throw new Error('当前模型不支持该比例');
    model.value = JSON.stringify([args.providerId, args.modelId]);
    if (args.size !== undefined) size.value = args.size;
    if (args.ratio !== undefined) ratio.value = args.ratio;
    if (args.prompt !== undefined) { prompt.value = args.prompt; promptModel.value = args.prompt.split('\n').map(text => [{type:'Write',text}]); }
    return currentConfig();
  },
});
</script>

<style scoped lang="scss">
.inpaintPrompt {
  .promptFooter {
    display: flex;
    align-items: center;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      :deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .settingsButton {
      flex-shrink: 0;
      :deep(> span) { gap: 6px; }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}

.inpaintSettings {
  display: grid;
  gap: 12px;

  label {
    display: grid;
    gap: 6px;
    color: var(--el-text-color-regular);
    font-size: 12px;
  }
}
</style>
