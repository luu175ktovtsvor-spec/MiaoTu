<template>
  <teleport v-if="mode === 'speed' && target" :to="target">
    <el-card class="speedPanel" shadow="never" :bodyStyle="{ padding: '8px' }">
      <div class="speedControls nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
        <el-button class="exitButton" :icon="IconX" text :disabled="cancelling" :title="processing ? translate('取消处理') : translate('关闭变速')" :aria-label="processing ? translate('取消变速处理') : translate('关闭变速')" @click="close">{{ translate('变速') }}</el-button>
        <span class="speedLimit">0.1×</span>
        <el-slider v-model="speed" class="speedSlider" :min="0.1" :max="4" :step="0.1" :disabled="processing" :formatTooltip="value => `${value.toFixed(2)}×`" :aria-label="translate('音频变速滑块')" />
        <span class="speedLimit">4×</span>
        <el-input-number :key="String(processing)" v-model="speed" class="speedInput" :min="0.1" :max="4" :step="0.1" :precision="2" :disabled="processing" controlsPosition="right" :aria-label="translate('音频变速倍数')" />
        <el-button class="generateButton" :icon="IconArrowUp" type="primary" :loading="processing" :disabled="disabled || !validSpeed" :title="translate('生成变速音频')" :aria-label="translate('生成变速音频')" @click="run" />
      </div>
      <div v-if="processing" class="processingStatus" role="status">{{ cancelling ? translate('正在取消并清理…') : translate('正在生成变速音频…') }}</div>
    </el-card>
  </teleport>
  <el-dialog class="clipDialog" :modelValue="mode === 'clip'" width="900px" alignCenter appendToBody destroyOnClose :showClose="false" :closeOnClickModal="!processing" :closeOnPressEscape="!processing" :style="{ maxWidth: 'calc(100vw - 24px)', maxHeight: '84vh', display: 'flex', flexDirection: 'column' }" @update:modelValue="value => !value && close()">
    <template #header>
      <div class="clipHeader">
        <el-button :icon="IconX" text :disabled="cancelling" :aria-label="processing ? translate('取消截取处理') : translate('关闭音频截取')" :title="processing ? translate('取消处理') : translate('关闭')" @click="close" />
        <span>{{ translate('截取与拼接') }}</span>
      </div>
    </template>
    <audioClipEditor v-if="mode === 'clip'" ref="clipEditor" v-model="segments" :src="src" :disabled="processing" />
    <template #footer>
      <div class="clipFooter">
        <span v-if="processing" class="processingStatus" role="status">{{ cancelling ? translate('正在取消并清理…') : translate('正在导出音频…') }}</span>
        <el-button :disabled="cancelling" @click="close">{{ processing ? translate('取消处理') : translate('取消') }}</el-button>
        <el-button type="primary" :loading="processing" :disabled="disabled || !clipEditor?.valid" @click="run">{{ translate('导出音频') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard, ElDialog, ElInputNumber, ElMessage, ElSlider } from "element-plus";
import { IconArrowUp, IconX } from "@tabler/icons-vue";
import { nodeTools, z, showNodeError, useNodeFfmpeg, useNodeFiles, type NodeMediaValue, type WorkspaceFiles } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import { processAudio, AUDIO_FORMATS, type AudioFormat, type AudioSegment, type AudioProcessingOptions } from "./audioProcessing";
import audioClipEditor from "./audioClipEditor.vue";

const props = defineProps<{ file?: NodeMediaValue; src: string; disabled?: boolean; target?: HTMLElement }>();
const emit = defineEmits<{ pause: [] }>();
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const loadFfmpeg = useNodeFfmpeg();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const mode = ref<"speed" | "clip" | "convert">();
const convertFormat = ref<AudioFormat>("mp3");
const speed = ref(1);
const segments = ref<AudioSegment[]>([]);
const processing = ref(false);
const cancelling = ref(false);
const clipEditor = ref<InstanceType<typeof audioClipEditor>>();
const validSpeed = computed(() => Number.isFinite(speed.value) && speed.value >= 0.1 && speed.value <= 4);
let controller: AbortController | undefined;
let job: Promise<unknown> | undefined;

function cancel() {
  if (!controller) return;
  cancelling.value = true;
  controller.abort();
}

function close() {
  if (processing.value) return cancel();
  clipEditor.value?.pause();
  mode.value = undefined;
}

function reset() {
  cancel();
  clipEditor.value?.pause();
  mode.value = undefined;
}

watch(() => props.file?.url, reset, { flush: "sync" });
watch(() => props.disabled, disabled => { if (disabled) reset(); }, { flush: "sync" });
watch(() => getCanvas?.()?.id, reset, { flush: "sync" });
onBeforeUnmount(cancel);

function open(value: "speed" | "clip" | "convert", format?: AudioFormat) {
  if (processing.value || props.disabled || !props.file || !props.src) return;
  emit("pause");
  segments.value = [];
  mode.value = value;
  // Format conversion has no settings to adjust; start right away.
  if (value === "convert") { convertFormat.value = format && Object.hasOwn(AUDIO_FORMATS, format) ? format : "mp3"; run(); }
}

async function cancelAndWait() {
  reset();
  await job;
}

defineExpose({ open, mode, processing, cancelAndWait });

function run() {
  if (processing.value || props.disabled || !props.file || !mode.value || (mode.value === "speed" ? !validSpeed.value : mode.value === "clip" && !clipEditor.value?.valid)) return;
  job = process();
}

async function process(signal?: AbortSignal, toolCall = false) {
  signal?.throwIfAborted();
  if (!nodeTypes?.value?.["remote-audioNode"]) throw new Error(translate("请先启用音频节点插件"));
  const source = props.file!.url;
  const id = crypto.randomUUID();
  const outputPath = `assets/${id}/audio.m4a`;
  const options: AudioProcessingOptions = mode.value === "speed"
    ? { action: "speed", outputPath, speed: speed.value }
    : mode.value === "convert" ? { action: "convert", outputPath, format: convertFormat.value }
    : { action: "clip", outputPath, segments: segments.value.map(segment => ({ ...segment })) };
  const label = options.action === "speed" ? `${options.speed.toFixed(2)}×` : options.action === "convert" ? options.format.toUpperCase() : "拼接";
  const current = controller = new AbortController();
  const abort = () => current.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  processing.value = true;
  cancelling.value = false;
  emit("pause");
  clipEditor.value?.pause();
  let workspace: WorkspaceFiles | undefined;
  let created = false;
  let committed = false;
  try {
    workspace = files.getWorkspaceFiles();
    const ffmpeg = await loadFfmpeg(current.signal);
    current.signal.throwIfAborted();
    await workspace.mkdir("assets").catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
    current.signal.throwIfAborted();
    await workspace.mkdir(`assets/${id}`);
    created = true;
    const result = await processAudio(ffmpeg, source, options, current.signal);
    current.signal.throwIfAborted();
    const x = node.computedPosition.x + Math.max(node.dimensions.width || 0, node.data.mediaExportSize?.width || 320) + 80;
    const width = 320;
    const height = Math.max(node.dimensions.height || 0, node.data.mediaExportSize?.height || 200);
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const position = other.computedPosition;
      const reserved = other.data.mediaExportSize || other.data.directorExportSize;
      const otherWidth = Math.max(other.dimensions.width || 0, reserved?.width || 320);
      const otherHeight = Math.max(other.dimensions.height || 0, reserved?.height || 200);
      if (position.x < x + width && position.x + otherWidth > x && position.y < y + height && position.y + otherHeight > y) y = position.y + otherHeight + 40;
    }
    await batchHistory(async () => {
      current.signal.throwIfAborted();
      if (findNode(node.id) !== node || !nodeTypes?.value?.["remote-audioNode"]) throw new Error(translate("画布节点已变化，请重新处理"));
      addNodes([{ id, type: "remote-audioNode", position: { x, y }, data: { label: `${node.data.label || "音频"} · ${label}`, mediaExportSize: { width, height }, outputs: { audio: { dataType: "AUDIO", value: { url: result.path, mimeType: result.mimeType } } } } }]);
      committed = true;
    });
    mode.value = undefined;
    if (!toolCall) ElMessage.success(translate("已在右侧生成新的音频节点"));
    return { nodeId: id, path: result.path, mimeType: result.mimeType };
  } catch (error) {
    if (toolCall) throw error;
    if (!current.signal.aborted) showNodeError(error, translate("音频处理失败"));
  } finally {
    if (!committed && created && workspace) await workspace.remove(`assets/${id}`, true).catch(error => {
      if (error?.response?.data?.data?.code !== "ENOENT") showNodeError(error, translate("临时音频清理失败"));
    });
    if (current.signal.aborted) mode.value = undefined;
    processing.value = cancelling.value = false;
    signal?.removeEventListener("abort", abort);
    controller = undefined;
  }
}

nodeTools.register({
  name: 'processAudio',
  description: '对当前音频执行 speed 变速（0.1–4 倍，保持音高）、clip 按 segments 起止秒数顺序截取并拼接，或 convert 转换为 format（mp3 320k / m4a AAC 256k / wav 16 位 / flac 无损）。复用界面处理，创建新的音频节点并保留原件，不调用生成模型。',
  parameters: z.strictObject({ action: z.enum(['speed', 'clip', 'convert']), speed: z.number().finite().min(0.1).max(4).optional(), segments: z.array(z.strictObject({ start: z.number().finite().min(0), end: z.number().finite().positive() })).min(1).max(100).optional(), format: z.enum(['mp3', 'm4a', 'wav', 'flac']).optional() }),
  async execute(args, { signal }) {
    if (processing.value || props.disabled || !props.file) throw new Error('音频尚未就绪或正在处理');
    if (args.action === 'speed' && args.speed === undefined) throw new Error('变速需要 speed');
    if (args.action === 'clip' && !args.segments?.length) throw new Error('截取需要 segments');
    if (args.action === 'convert' && !args.format) throw new Error('转换格式需要 format');
    mode.value = args.action;
    convertFormat.value = args.format ?? 'mp3';
    speed.value = args.speed ?? 1;
    segments.value = args.segments ?? [];
    const pending = process(signal, true); job = pending.then(() => {}, () => {});
    return pending;
  },
});
</script>

<style scoped lang="scss">
.speedPanel {
  .speedControls {
    display: flex;
    align-items: center;
    gap: 10px;
    .exitButton { margin: 0; padding: 0 4px; }
    .speedLimit { font-size: 11px; color: var(--el-text-color-secondary); }
    .speedSlider { flex: 1; min-width: 70px; }
    .speedInput { width: 96px; flex-shrink: 0; }
    .generateButton { width: 32px; height: 32px; padding: 0; margin: 0; flex-shrink: 0; }
  }
  .processingStatus { margin: 6px 4px 0; }
}
.clipHeader { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 600; .el-button { width: 30px; padding: 0; } }
.clipFooter { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; .processingStatus { margin-right: auto; } .el-button { margin: 0; } }
.processingStatus { font-size: 12px; color: var(--el-text-color-secondary); }
:global(.clipDialog .el-dialog__body) { min-height: 0; overflow-y: auto; }
:global(.clipDialog .el-dialog__header), :global(.clipDialog .el-dialog__footer) { flex-shrink: 0; }
</style>

<style scoped>
@media (max-width: 700px) {
  .speedPanel .speedControls { flex-wrap: wrap; }
  .speedPanel .speedControls .exitButton { flex-shrink: 0; }
  .speedPanel .speedControls .speedSlider { flex-basis: calc(100% - 160px); }
}
</style>
