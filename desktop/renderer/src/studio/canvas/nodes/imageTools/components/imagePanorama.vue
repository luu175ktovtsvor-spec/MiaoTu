<template>
  <el-dropdown ref="dropdown" trigger="click" virtualTriggering :virtualRef="trigger" :disabled="disabled || busy || !src" @command="selectAction">
    <template #dropdown>
      <el-dropdown-menu>
        <el-dropdown-item command="generateSphere">{{ translate('生成720°全景图') }}</el-dropdown-item>
        <el-dropdown-item command="generateCylinder">{{ translate('生成360°环绕图') }}</el-dropdown-item>
        <el-dropdown-item command="previewSphere" divided>{{ translate('预览720°全景图') }}</el-dropdown-item>
        <el-dropdown-item command="previewCylinder">{{ translate('预览360°环绕图') }}</el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
  <el-dialog
    v-model="visible"
    class="panoramaDialog"
    :title="`预览${mode === 'sphere' ? '720°全景图' : '360°环绕图'}`"
    width="80%"
    alignCenter
    appendToBody
    destroyOnClose
    :closeOnClickModal="false"
    :closeOnPressEscape="!busy"
    :showClose="!busy"
    :beforeClose="close"
    :style="{ maxWidth: 'calc(100vw - 32px)' }">
    <template #header>
      <div class="panoramaHeader">
        <icon-panorama-horizontal :size="20" />
        <strong>{{ mode === 'sphere' ? translate('720°全景图') : translate('360°环绕图') }}</strong>
        <span>{{ translate('预览与校正') }}</span>
      </div>
    </template>
    <div class="panoramaPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop>
      <imagePanoramaPreview v-if="visible" ref="previewStage" :src="src" :mode="mode" :disabled="disabled || saving" @capture="saveCapture" />
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { translate } from "@miaoimg/i18n/vue";
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu } from "element-plus";
import { IconPanoramaHorizontal } from "@tabler/icons-vue";
import { useNode } from "@vue-flow/core";
import { nodeTools, z, useNodeAi, type NodeMediaValue } from "@miaoimg/nodes-scaffold/runtime";
import { showNodeError } from "../../../scaffold/showNodeError";
import { buildPanoramaPrompt, type PanoramaMode } from "../imagePanorama";
import { usePanoramaCapture } from "../usePanoramaCapture";
import { useImageVariationNode } from "../useImageVariationNode";
import { lazyPreview } from '../lazyPreview';
const imagePanoramaPreview = lazyPreview(() => import('./imagePanoramaPreview.vue'));

const props = defineProps<{ src: string; source?: NodeMediaValue; disabled?: boolean }>();
const emit = defineEmits<{ open: [] }>();
const { node } = useNode();
const dropdown = ref<InstanceType<typeof ElDropdown>>();
const trigger = ref<HTMLElement>();
const visible = ref(false);
const mode = ref<PanoramaMode>("sphere");
const creating = ref(false);
const createVariation = useImageVariationNode();
const ai = useNodeAi();
const previewStage = ref<InstanceType<typeof imagePanoramaPreview>>();
const { saving, saveCapture } = usePanoramaCapture(() => props.src);
const busy = computed(() => creating.value || saving.value || !!previewStage.value?.capturing);
let disposed = false;
onScopeDispose(() => { disposed = true; });

defineExpose({ open, busy, visible });

watch(() => props.src, () => { visible.value = false; }, { flush: "sync" });

async function open(event: MouseEvent) {
  if (props.disabled || busy.value || !props.src) return;
  trigger.value = event.currentTarget as HTMLElement;
  await nextTick();
  dropdown.value?.handleOpen();
}

async function selectAction(command: string) {
  if (props.disabled || busy.value || !props.src) return;
  emit("open");
  mode.value = command.endsWith("Sphere") ? "sphere" : "cylinder";
  if (command.startsWith("preview")) {
    visible.value = true;
    return;
  }
  if (!props.source) return;
  const source = JSON.stringify(props.source);
  const src = props.src;
  const currentMode = mode.value;
  const assertAvailable = () => {
    if (disposed || props.disabled || props.src !== src || JSON.stringify(props.source) !== source || mode.value !== currentMode) throw new Error(translate("原图片已变化或正在处理，请重新操作"));
  };
  creating.value = true;
  try {
    const ratio = currentMode === "sphere" ? "2:1" : "4:1";
    const models = (await ai.getMediaModels()).filter(model => model.type === "image" && model.imageRatios?.includes(ratio));
    assertAvailable();
    const model = models.find(model => JSON.stringify([model.providerId, model.modelId]) === node.data.model) || models[0];
    if (!model) throw new Error(translate("当前可用模型暂不支持 {0} 全景生成，可导入已有全景图进行预览和取景。", { 0: ratio }));
    await createVariation({
      label: currentMode === "sphere" ? "720°全景图" : "360°环绕图",
      prompt: buildPanoramaPrompt(currentMode),
      model: JSON.stringify([model.providerId, model.modelId]),
      size: model.imageSizes?.[0] || "",
      ratio,
    }, undefined, assertAvailable);
  } catch (error) {
    if (!disposed) showNodeError(error, "全景节点创建失败");
  } finally {
    creating.value = false;
  }
}

nodeTools.register({
  name: 'openPanorama', description: '打开或关闭当前图片的 sphere 球形全景或 cylinder 环绕预览，不调用生成模型。打开后可通过 getNodeTools 发现 getPanoramaView / setPanoramaView 进行校正，再用 capturePanorama 创建截图节点。',
  parameters: z.strictObject({ mode: z.enum(['sphere','cylinder']), visible: z.boolean().default(true) }),
  async execute(args) {
    if (props.disabled || busy.value || !props.src) throw new Error('原图尚未就绪或正在处理');
    emit('open'); mode.value = args.mode; visible.value = args.visible;
    await nextTick(); return { mode: mode.value, visible: visible.value };
  },
});
nodeTools.register({
  name: 'capturePanorama', description: '按已打开全景预览的视角、校正和张数创建真实 PNG 截图节点，可合图或分图成组；每个视角 1280×720，不调用图片或视频模型。',
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    const stage = previewStage.value;
    if (!visible.value || !stage?.ready || props.disabled || busy.value) throw new Error('请先打开全景预览并等待原图加载完成');
    const payload = await stage.capture(true);
    signal?.throwIfAborted();
    if (!payload) throw new Error('全景截图未完成');
    return saveCapture(payload, signal, true);
  },
});

function close(done: () => void) {
  if (!busy.value) done();
}
</script>

<style scoped lang="scss">
:global(.panoramaDialog .el-dialog__header) { padding-bottom: 16px; }
.panoramaHeader {
  display: flex; align-items: center; gap: 8px; min-height: 24px; padding-right: 24px; color: var(--el-text-color-primary);
  strong { font-size: 15px; font-weight: 600; }
  span { margin-left: 4px; color: var(--el-text-color-secondary); font-size: 12px; }
}
.panoramaPanel { height: min(70vh, 760px); min-height: 0; }
</style>
