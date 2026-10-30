<template>
  <teleport v-if="mode === 'speed' && target" :to="target">
    <el-card class="speedPanel" shadow="never" :bodyStyle="{ padding: '8px' }">
      <div class="speedControls nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
        <el-button class="exitButton" :icon="IconX" text :disabled="cancelling" :title="processing ? translate('取消处理') : translate('关闭变速')" :aria-label="processing ? translate('取消变速处理') : translate('关闭变速')" @click="close">{{ translate('变速') }}</el-button>
        <span class="speedLimit">0.1×</span>
        <el-slider v-model="speed" class="speedSlider" :min="0.1" :max="4" :step="0.1" :disabled="processing" :formatTooltip="value => `${value.toFixed(2)}×`" :aria-label="translate('音频变速滑块')" />
        <span class="speedLimit">4×</span>
        <el-input-number :key="String(processing)" v-model="speed" class="speedInput" :min="0.1" :max="4" :step="0.1" :precision="2" :disabled="processing" controlsPosition="right" :aria-label="translate('音频变速倍数')" />
        <el-button class="exportButton" :icon="IconDownload" type="primary" :loading="processing" :disabled="disabled || !validSpeed" :title="translate('导出变速音频')" :aria-label="translate('导出变速音频')" @click="run" />
      </div>
      <div v-if="processing" class="processingStatus" role="status">{{ cancelling ? translate('正在取消并清理…') : translate('正在导出变速音频…') }}</div>
    </el-card>
  </teleport>
  <el-dialog class="clipDialog" :modelValue="mode === 'clip' || mode === 'silence'" width="900px" alignCenter appendToBody destroyOnClose :showClose="false" :closeOnClickModal="!processing" :closeOnPressEscape="!processing" :style="{ maxWidth: 'calc(100vw - 24px)', maxHeight: '84vh', display: 'flex', flexDirection: 'column' }" @update:modelValue="value => !value && close()">
    <template #header="{ titleId, titleClass }">
      <div class="clipHeader">
        <el-button :icon="IconX" text :disabled="cancelling" :aria-label="processing ? translate('取消截取处理') : translate('关闭音频截取')" :title="processing ? translate('取消处理') : translate('关闭')" @click="close" />
        <span :id="titleId" :class="titleClass">{{ translate(mode === 'silence' ? '按静音切分' : '截取与拼接') }}</span>
      </div>
    </template>
    <div v-if="mode === 'silence'" class="silenceSettings">
      <el-tooltip :content="translate('按绝对音量阈值和静音间隔划分，不识别语义。短声音不会自动丢弃；试听确认后才导出，原件保留。')" placement="top"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip>
      <div class="silenceFields">
        <label>{{ translate('静音阈值（dBFS）') }}<el-input-number v-model="thresholdDb" :min="-90" :max="-5" :step="1" :disabled="processing || analyzing" /></label>
        <label>{{ translate('最短静音（秒）') }}<el-input-number v-model="minSilence" :min="0.05" :max="10" :step="0.05" :precision="2" :disabled="processing || analyzing" /></label>
        <label>{{ translate('两侧保留（秒）') }}<el-input-number v-model="padding" :min="0" :max="1" :step="0.01" :precision="2" :disabled="processing || analyzing" /></label>
        <el-button :loading="analyzing" :disabled="processing || !validSilenceOptions" @click="analyzeSilence()">{{ translate('分析静音') }}</el-button>
      </div>
      <p v-if="analysisKey && !analysisReady" role="status">{{ translate('参数已更改，请重新分析静音。') }}</p>
      <p v-else-if="silenceStatus" role="status">{{ translate(silenceStatus) }}</p>
      <el-radio-group v-model="splitExport" :disabled="processing || analyzing"><el-radio value="separate">{{ translate('逐段导出') }}</el-radio><el-radio value="join">{{ translate('拼接导出') }}</el-radio></el-radio-group>
      <p v-if="splitExport === 'separate' && exportCount > 64" role="alert">{{ translate('逐段导出最多 64 段，请先合并或删除部分片段，也可选择拼接导出。') }}</p>
    </div>
    <audioClipEditor v-if="mode === 'clip' || mode === 'silence' && analysisReady && analysisHasSegments" :key="analysisVersion" ref="clipEditor" v-model="segments" :src="src" :sourceDuration="mode === 'silence' ? analysisDuration : undefined" :disabled="processing || analyzing" />
    <template #footer>
      <div class="clipFooter">
        <span v-if="processing" class="processingStatus" role="status">{{ cancelling ? translate('正在取消并清理…') : translate('正在导出音频…') }}</span>
        <el-button :disabled="cancelling" @click="close">{{ processing ? translate('取消处理') : translate('取消') }}</el-button>
        <el-button type="primary" :loading="processing" :disabled="disabled || analyzing || !clipEditor?.valid || (mode === 'silence' && (!analysisReady || !segments.length || (splitExport === 'separate' && exportCount > 64)))" @click="run">{{ translate('导出音频') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard, ElDialog, ElInputNumber, ElMessage, ElSlider, ElRadio, ElRadioGroup, ElTooltip } from "element-plus";
import { IconDownload, IconX, IconInfoCircle } from "@tabler/icons-vue";
import { nodeTools, z, showNodeError, useNodeFfmpeg, useNodeFiles, type NodeMediaValue, type WorkspaceFiles } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import { processAudio, AUDIO_FORMATS, type AudioFormat, type AudioSegment, type AudioProcessingOptions } from "./audioProcessing";
import audioClipEditor from "./audioClipEditor.vue";
import { captureWorkspaceScope, assertWorkspaceScope } from "@/lib/workspaceRemote";

const props = defineProps<{ file?: NodeMediaValue; src: string; disabled?: boolean; target?: HTMLElement }>();
const emit = defineEmits<{ pause: [] }>();
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const loadFfmpeg = useNodeFfmpeg();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const mode = ref<"speed" | "clip" | "convert" | "silence">();
const getCanvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
const thresholdDb = ref(-40), minSilence = ref(0.4), padding = ref(0.04), analyzing = ref(false), analysisVersion = ref(0), analysisDuration = ref(0), analysisKey = ref(""), silenceStatus = ref("");
const splitExport = ref<"separate" | "join">("separate");
const analysisHasSegments = ref(false);
const analysisRevision = ref("");
const silenceKey = computed(() => JSON.stringify([thresholdDb.value,minSilence.value,padding.value]));
const analysisReady = computed(() => Boolean(analysisKey.value && analysisKey.value === silenceKey.value));
const validSilenceOptions = computed(() => Number.isFinite(thresholdDb.value) && thresholdDb.value>=-90 && thresholdDb.value<=-5 && Number.isFinite(minSilence.value) && minSilence.value>=0.05 && minSilence.value<=10 && Number.isFinite(padding.value) && padding.value>=0 && padding.value<=1);
let analysisController: AbortController | undefined;
let analysisJob: Promise<unknown> | undefined;
const convertFormat = ref<AudioFormat>("mp3");
const speed = ref(1);
const segments = ref<AudioSegment[]>([]);
const processing = ref(false);
const cancelling = ref(false);
const clipEditor = ref<InstanceType<typeof audioClipEditor>>();
const exportCount = computed(() => clipEditor.value?.getGroups().length || 0);
const validSpeed = computed(() => Number.isFinite(speed.value) && speed.value >= 0.1 && speed.value <= 4);
let controller: AbortController | undefined;
let job: Promise<unknown> | undefined;

function cancel() {
  analysisController?.abort();
  if (!controller) return;
  cancelling.value = true;
  controller.abort();
}

function close() {
  if (analyzing.value) { analysisController?.abort(); mode.value = undefined; return; }
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

function open(value: "speed" | "clip" | "convert" | "silence", format?: AudioFormat) {
  if (processing.value || analyzing.value || props.disabled || !props.file || !props.src) return;
  emit("pause");
  segments.value = []; analysisHasSegments.value=false; analysisRevision.value=""; analysisKey.value = ""; silenceStatus.value = ""; analysisVersion.value++;
  mode.value = value;
  // Format conversion has no settings to adjust; start right away.
  if (value === "convert") { convertFormat.value = format && Object.hasOwn(AUDIO_FORMATS, format) ? format : "mp3"; run(); }
}

async function cancelAndWait() {
  reset();
  await Promise.allSettled([job,analysisJob]);
}

defineExpose({ open, mode, processing: computed(() => processing.value || analyzing.value), cancelAndWait });

function run() {
  if (processing.value || props.disabled || !props.file || !mode.value || (mode.value === "speed" ? !validSpeed.value : ["clip","silence"].includes(mode.value) && !clipEditor.value?.valid)) return;
  if (mode.value === "silence" && (!analysisReady.value || !segments.value.length || splitExport.value === "separate" && (clipEditor.value?.getGroups().length || 0) > 64)) return;
  job = process();
}

async function analyzeSilence(callerSignal?: AbortSignal, toolCall = false) {
  if (processing.value || analyzing.value || props.disabled || !props.file || !validSilenceOptions.value) return;
  emit("pause"); clipEditor.value?.pause();
  analysisController?.abort(); const current = analysisController = new AbortController();
  const canvas = getCanvasSignal?.(), signal = AbortSignal.any([current.signal,...(callerSignal?[callerSignal]:[]),...(canvas?[canvas]:[])]), scope=captureWorkspaceScope(), source=JSON.stringify(node.data.outputs?.audio), key=silenceKey.value;
  analyzing.value=true; analysisKey.value=""; silenceStatus.value="";
  analysisJob=(async()=>{
    const url=new URL(props.src,window.location.href);
    if(!window.miaoDesktop || url.origin!==window.location.origin || url.pathname!=="/api/imagine/workspace/files")throw new Error(translate("请使用桌面端进行静音分析"));
    url.searchParams.set("silence","1");url.searchParams.delete("waveform");url.searchParams.set("thresholdDb",String(thresholdDb.value));url.searchParams.set("minSilence",String(minSilence.value));url.searchParams.set("padding",String(padding.value));
    const response=await fetch(url,{signal,cache:"no-store"}),value=await response.json();
    signal.throwIfAborted();assertWorkspaceScope(scope);
    if(!response.ok)throw new Error(value.error || translate("静音分析失败"));
    if(findNode(node.id)!==node || JSON.stringify(node.data.outputs?.audio)!==source)throw new Error(translate("原音频已变化，请重新分析"));
    if(typeof value.revision!=="string"||!value.revision||!Number.isFinite(value.duration)||value.duration<=0||!Array.isArray(value.segments)||value.segments.length>100||value.segments.some((item:any)=>!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.start<0||item.end<=item.start||item.end>value.duration+0.000001))throw new Error(translate("静音分析结果无效或片段超过 100 段，请调整参数后重试"));
    analysisRevision.value=value.revision; analysisHasSegments.value=value.segments.length>0; segments.value=value.segments.map((item:any)=>({start:item.start,end:Math.min(value.duration,item.end)}));analysisDuration.value=value.duration;analysisKey.value=key;analysisVersion.value++;
    silenceStatus.value=value.status==="all_silent"?"未检测到高于阈值的声音，请调整阈值后重试。":value.status==="no_silence"?"未检测到符合条件的静音，已保留整段。":"已按静音生成可编辑片段，请试听后确认导出。";
    return value;
  })().catch(error=>{if(toolCall)throw error;if(!signal.aborted)showNodeError(error,translate("静音分析失败"));}).finally(()=>{if(current===analysisController)analyzing.value=false;});
  return await analysisJob;
}

async function process(signal?: AbortSignal, toolCall = false) {
  signal?.throwIfAborted();
  if (!nodeTypes?.value?.["remote-audioNode"]) throw new Error(translate("请先启用音频节点插件"));
  const source = props.file!.url;
  const sourceState = JSON.stringify(node.data.outputs?.audio);
  const id = crypto.randomUUID();
  const groups = mode.value === "silence" && splitExport.value === "separate" ? clipEditor.value!.getGroups() : [segments.value.map(segment => ({ ...segment }))];
  const plans = groups.map((ranges,index) => ({ id: index===0 ? id : crypto.randomUUID(), ranges }));
  const outputPath = `assets/${id}/audio.m4a`;
  const options: AudioProcessingOptions = mode.value === "speed"
    ? { action: "speed", outputPath, speed: speed.value }
    : mode.value === "convert" ? { action: "convert", outputPath, format: convertFormat.value }
    : { action: "clip", outputPath, segments: segments.value.map(segment => ({ ...segment })) };
  const label = options.action === "speed" ? `${options.speed.toFixed(2)}×` : options.action === "convert" ? options.format.toUpperCase() : "拼接";
  const current = controller = new AbortController();
  const canvasSignal = getCanvasSignal?.();
  const caller = AbortSignal.any([...(signal ? [signal] : []),...(canvasSignal ? [canvasSignal] : [])]);
  const abort = () => current.abort(caller.reason);
  caller.addEventListener("abort", abort, { once: true });
  if (caller.aborted) abort();
  processing.value = true;
  cancelling.value = false;
  emit("pause");
  clipEditor.value?.pause();
  let workspace: WorkspaceFiles | undefined;
  const created: string[] = [];
  let committed = false;
  try {
    workspace = files.getWorkspaceFiles();
    const ffmpeg = await loadFfmpeg(current.signal);
    current.signal.throwIfAborted();
    await workspace.mkdir("assets").catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
    current.signal.throwIfAborted();
    const revision = await workspace.stat?.(source,current.signal);
    if (mode.value === "silence" && (!analysisRevision.value || revision?.revision !== analysisRevision.value)) throw new Error(translate("原音频已变化，请重新分析"));
    const results: Array<{id:string;path:string;mimeType:string}> = [];
    for (const plan of plans) {
      current.signal.throwIfAborted();
      await workspace.mkdir(`assets/${plan.id}`,current.signal); created.push(`assets/${plan.id}`);
      const request = mode.value === "silence" && splitExport.value === "separate" ? {action:"clip" as const,outputPath:`assets/${plan.id}/audio.m4a`,segments:plan.ranges.map(range=>({...range}))} : options;
      const result = await processAudio(ffmpeg,source,request,current.signal); results.push({id:plan.id,...result});
    }
    current.signal.throwIfAborted();
    const currentRevision = revision ? await workspace.stat?.(source,current.signal) : undefined;
    if (revision?.revision !== currentRevision?.revision || JSON.stringify(node.data.outputs?.audio) !== sourceState) throw new Error(translate("原音频已变化，请重新处理"));
    const result = results[0]!;
    const x = node.computedPosition.x + Math.max(node.dimensions.width || 0, node.data.mediaExportSize?.width || 320) + 80;
    const width = 320;
    const height = Math.max(node.dimensions.height || 0, node.data.mediaExportSize?.height || 200);
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const position = other.computedPosition;
      const reserved = other.data.mediaExportSize || other.data.directorExportSize;
      const otherWidth = Math.max(other.dimensions.width || 0, reserved?.width || 320);
      const otherHeight = Math.max(other.dimensions.height || 0, reserved?.height || 200);
      if (position.x < x + width && position.x + otherWidth > x && position.y < y + (height + 40) * plans.length && position.y + otherHeight > y) y = position.y + otherHeight + 40;
    }
    await batchHistory(async () => {
      current.signal.throwIfAborted();
      if (findNode(node.id) !== node || !nodeTypes?.value?.["remote-audioNode"]) throw new Error(translate("画布节点已变化，请重新处理"));
      if (JSON.stringify(node.data.outputs?.audio) !== sourceState) throw new Error(translate("原音频已变化，请重新处理"));
      addNodes(results.map((result,index)=>({ id:result.id, type:"remote-audioNode", position:{x,y:y+(height+40)*index}, data:{label:`${node.data.label||"音频"} · ${results.length>1?translate("片段 {0}",{0:index+1}):label}`,mediaExportSize:{width,height},outputs:{audio:{dataType:"AUDIO",value:{url:result.path,mimeType:result.mimeType}}}} })));
      committed = true;
    });
    mode.value = undefined;
    if (!toolCall) ElMessage.success(translate("已在右侧生成新的音频节点"));
    return { nodeId: id, path: result.path, mimeType: result.mimeType, ...(results.length>1?{nodeIds:results.map(item=>item.id),outputs:results}: {}) };
  } catch (error) {
    if (toolCall) throw error;
    if (!current.signal.aborted) showNodeError(error, translate("音频处理失败"));
  } finally {
    if (!committed && workspace) await Promise.allSettled(created.map(path=>workspace!.remove(path,true).catch(error=>{if(error?.response?.data?.data?.code!=="ENOENT")showNodeError(error,translate("临时音频清理失败"));})));
    // 转换格式没有设置面板，失败后也要退出，避免节点停在处理状态。
    if (current.signal.aborted || mode.value === "convert") mode.value = undefined;
    processing.value = cancelling.value = false;
    caller.removeEventListener("abort", abort);
    controller = undefined;
  }
}

nodeTools.register({
  name: "analyzeSilence",
  description: "按当前音轨的绝对音量阈值与最短静音时长分析切分，打开可试听、可修改的分段预览，返回原片秒数和分段；不识别语义或对白，不调用模型，不自动导出。确认后可用processAudio的clip参数导出用户选定范围。",
  parameters: z.strictObject({ thresholdDb: z.number().finite().min(-90).max(-5).optional(), minSilence: z.number().finite().min(0.05).max(10).optional(), padding: z.number().finite().min(0).max(1).optional() }),
  async execute(args, { signal }) {
    if (processing.value || analyzing.value || props.disabled || !props.file) throw new Error("音频尚未就绪或正在处理");
    open("silence"); thresholdDb.value=args.thresholdDb??-40;minSilence.value=args.minSilence??0.4;padding.value=args.padding??0.04;
    return analyzeSilence(signal,true);
  },
});

nodeTools.register({
  name: 'processAudio',
  description: '对当前音频执行 speed 变速（0.1–4 倍，保持音高）、clip 按 segments 起止秒数顺序截取并拼接，或 convert 转换为 format（mp3 320k / m4a AAC 256k / wav 16 位 / flac 无损）。复用界面处理，创建新的音频节点并保留原件，不调用生成模型。',
  parameters: z.strictObject({ action: z.enum(['speed', 'clip', 'convert']), speed: z.number().finite().min(0.1).max(4).optional(), segments: z.array(z.strictObject({ start: z.number().finite().min(0), end: z.number().finite().positive() })).min(1).max(100).optional(), format: z.enum(['mp3', 'm4a', 'wav', 'flac']).optional() }),
  async execute(args, { signal }) {
    if (processing.value || analyzing.value || props.disabled || !props.file) throw new Error('音频尚未就绪或正在处理');
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
    .exportButton { width: 32px; height: 32px; padding: 0; margin: 0; flex-shrink: 0; }
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

<style scoped>
.silenceSettings{padding:0 20px 12px}.silenceFields{display:flex;flex-wrap:wrap;align-items:end;gap:12px}.silenceFields>label{display:grid;font-size:12px;gap:4px}.silenceSettings p{font-size:13px;color:var(--el-text-color-secondary)}
</style>
