<template>
  <nodeSkeleton
    class="videoNodeShell"
    :class="{ emptyGeneration: !previewUrl }"
    v-bind="nodeProps"
    :modelLabel="nodeLocalModelLabel(data.model)"
    :mediaMeta="mediaMeta"
    v-model:bottomVisible="composerVisible"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth}px` : undefined }">
    <template #topActions>
      <span ref="historyTarget" />
      <el-button :icon="IconTransfer" :loading="uploading || uploadingDrag" :disabled="generating || deleting" text :title="translate('替换视频')" :aria-label="translate('替换视频')" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="video/*" hidden :aria-label="translate('选择替换视频')" :disabled="generating || deleting || uploading || uploadingDrag" @change="replaceOutput" />
    </template>
    <div v-loading="uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        :disabled="deleting || uploading || uploadingDrag"
        :label="translate('生成视频')"
        @dimensions="resizeVideo" />
      <div v-else class="videoEmpty mediaEmpty" :aria-label="translate('暂无生成视频')">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
        <div v-if="emptyHints.length" class="emptyHints nodrag nopan" role="group" :aria-label="translate('试试')">
          <span class="emptyHintsTitle">{{ translate('试试：') }}</span>
          <button v-for="hint in emptyHints" :key="hint.key" type="button" class="emptyHint" :disabled="generating || deleting" @pointerdown.stop @click.stop="hint.run()">
            <component :is="hint.icon" :size="16" aria-hidden="true" />{{ hint.label }}
          </button>
        </div>
      </div>
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
      <generationProgress :progress="progress" :label="translate('视频生成进度')" />
    </div>
    <template #bottom>
      <Teleport to="body">
        <div v-if="composerExpanded" class="promptComposerBackdrop" aria-hidden="true" @pointerdown.stop @click="composerExpanded = false" />
      </Teleport>
      <Teleport to="body" :disabled="!composerExpanded">
      <el-card
        class="promptCard"
        :class="{ expandedPromptCard: composerExpanded }"
        shadow="never"
        :bodyStyle="{ padding: '14px 16px 12px' }"
        @pointerdown.stop
        @click.stop
        @keydown.esc.stop="composerExpanded = false">
        <div class="promptBody">
          <div class="composerTools">
            <button type="button" class="composerChip nodrag" :disabled="generating || deleting" :aria-label="translate('添加参考素材')" @click.stop="requestReference()">
              <icon-plus :size="14" aria-hidden="true" />{{ translate('参考') }}
            </button>
          </div>
          <referenceItem
            v-if="refList.length"
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
          <div v-if="frameMode" class="referenceHint">
            {{ selectedMode === "startFrameOptional" ? translate("仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧") : translate("图片引用按顺序作为首帧、尾帧") }}
          </div>
          <promptInput
            v-model="data.promptModel"
            v-model:text="data.prompt"
            v-model:expanded="composerExpanded"
            :references="referenceMentions"
            expandable
            expand-mode="external" />
          <div v-if="promptOptional && !generationPrompt" class="referenceHint">{{ translate('当前模型可只使用图片参考，不填写提示词') }}</div>
        </div>
        <local-media-info :model="selectedModel" compact />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            popper-class="modelSelectPopper"
            :loading="modelsLoading"
            :disabled="generating || deleting"
            :placeholder="translate('选择模型')"
            :aria-label="translate('生成模型')"
            :noDataText="translate('请先在设置中添加视频模型')"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, translate('模型读取失败')))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="group in groupNodeModels(models)" :key="group.id" :label="group.label">
              <el-option v-for="item in group.models" :key="JSON.stringify([item.providerId, item.modelId])"
                :label="nodeModelOptionLabel(item)" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            v-model:mode="data.mode"
            v-model:generateAudio="data.generateAudio"
            v-model:parameters="data.parameters"
            :ratios="ratioOptions"
            :model="selectedModel"
            :videoReferences="mediaCounts.video"
            :imageReferences="mediaCounts.image"
            :disabled="generating || deleting || !selectedModel" />
          <div class="sendActions">
            <div class="estimateLine" aria-live="polite" :data-estimate-source="videoEstimate?.breakdown?.billingSource || 'unavailable'">
              <icon-coins :size="14" aria-hidden="true" />
              <strong v-if="['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')">{{ translate(selectedModel?.providerId === 'dola-local' ? '使用 Dola 额度' : '使用豆包额度') }}</strong>
              <span v-else>{{ translate('预计') }}</span>
              <strong v-if="!['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '') && videoEstimate?.points != null">{{ translate('{0} 积分', { 0: formatCredits(videoEstimate.points) }) }}</strong>
              <strong v-else-if="!['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')">—</strong>
            </div>
            <div v-if="videoEstimateError" class="estimateError" role="alert">{{ videoEstimateError }}</div>
            <el-button
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :loading="checkingTask"
              :disabled="checkingTask || deleting || uploading || uploadingDrag || (!generating && !pendingTask && !canStartGeneration)"
              :title="checkingTask ? translate('正在确认原任务') : generating ? translate('取消生成（{0}）', { 0: cancellationHint }) : pendingTask ? translate('继续取回') : translate('生成视频')"
              :aria-label="checkingTask ? translate('正在确认原任务') : generating ? translate('取消生成') : pendingTask ? translate('继续取回') : translate('生成视频')"
              @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, translate('视频生成失败')))" />
          </div>
        </div>
      </el-card>
      </Teleport>
    </template>
  </nodeSkeleton>
  <mediaHistory :target="historyTarget" mediaType="video" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.video = { dataType: 'VIDEO', value: $event }" />
</template>

<script setup lang="ts">
import { groupNodeModels } from "../scaffold/nodeAi";
import { nodeLocalModelLabel, nodeModelOptionLabel } from '../scaffold/localModelLabel';
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch, watchEffect } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElMessage } from "element-plus";
import { IconCameraAi, IconCoins, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer, IconPlus, IconWriting, IconPhoto, IconLayersLinked, IconStack2 } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, showNodeError, useGenerationProgress, useNode, useNodeGeneration, useNodeReferences, useNodeUpload, z, type NodeMediaModel, type NodeVideoRequest, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import promptInput from "@miaoimg/nodes-scaffold/promptInput";
import videoPlayer from "@miaoimg/nodes-scaffold/videoPlayer";
import referenceItem from "@miaoimg/nodes-scaffold/referenceItem";
import mediaHistory from "@miaoimg/nodes-scaffold/mediaHistory";
import generationProgress from "@miaoimg/nodes-scaffold/generationProgress";
import uploadProgress from "../components/uploadProgress.vue";
import { beginUpload } from "../uploadStatus";
import { assetFileType, ASSET_MAX_BYTES } from "../assetFile";
import generationSettings from "./videoGenerationSettings.vue";
import { controlPayload, durationsForMode, modeName, ratiosForMode } from "../scaffold/mediaParameters";
import localMediaInfo from './localMediaInfo.vue';
import { translate } from "@miaoimg/i18n/vue";
import { localReferenceRejection } from '../../../../../local-media/catalog.ts';
import { getTargetValues } from "../scaffold/nodeInputs";
import { useMediaTaskDelivery } from "../scaffold/useMediaTaskDelivery";

defineOptions({
  inheritAttrs: false,
  icon: IconCameraAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "视频生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; duration?: number; resolution: string; ratio: string; mode: string; generateAudio: boolean; parameters: Record<string, unknown>; taskRequestId?: string });
if (!data.value.parameters) data.value.parameters = {};
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.resolution ??= "";
data.value.mode ??= "";
data.value.generateAudio ??= true;
data.value.ratio ??= "";
const { refList, referenceMentions, referenceHistory, preparePromptReferences, setReferencePreview, removeReference } = useNodeReferences();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
const historyTarget = ref<HTMLElement>();
let disposed = false;
const deleting = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const videoWidth = ref(0);
const videoDimensions = ref<{ width: number; height: number }>();
const mediaMeta = computed(() => videoDimensions.value ? `${videoDimensions.value.width} × ${videoDimensions.value.height}` : "");
let generationController: AbortController | undefined;
// 进度条要的上游状态：queued / running / saving（nodeAi 在写回画布前会补发一次 saving）。
const generationStatus = ref("");
const generationMessage = ref("");
const generationState = useNodeGeneration(outputs, () => generationController?.abort(), undefined, () => ({ phase: generationStatus.value, message: generationMessage.value, requestId: data.value.taskRequestId }));
const { generating } = generationState;
const pendingTask = computed(() => Boolean(data.value.taskRequestId) || generationState.outcome.value === "pending");
const delivery = useMediaTaskDelivery(node, outputs, "video");
nodeEvent.on("copy", () => ({ taskRequestId: undefined, taskOutputPath: undefined, taskExtraNodeIds: undefined }));
// 上游真报的百分比。方舟通道回得到（server/video-api.ts 的 pollVideo 把
// ark-video.ts 的 progress 放进响应体），秘塔/Grok 通道多数只回 running，这时是 null。
const upstreamPercent = ref<number | null>(null);
// 取消按钮的提示语：排队中取消会退积分，已发出的请求不退。
const cancellationHint = computed(() => ['doubao-local', 'dola-local'].includes(selectedModel.value?.providerId || '') ? translate("额度以平台实际结算为准") : generationStatus.value === "queued" ? translate("排队中取消会退回积分") : translate("已发出的请求取消不退积分"));
let generation: Promise<void> | undefined;
let recoveryLookup: Promise<boolean> | undefined;
let recoveryTaskId: string | undefined;
let recoveryChecked = false;
const checkingTask = ref(false);
let modelsRequest: Promise<void> | undefined;
const ratioOptions = computed(() => ratiosForMode(selectedModel.value, data.value.mode));
// 「替换视频」也走环形进度：复用生成节点自己的 upload 通道。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  outputs.value.video = { dataType: "VIDEO", value: { url: path, mimeType } };
}, () => outputs.value);
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
// 有真实百分比就用真值并显示数字；通道不报进度时才退回「已用时 / 该模型典型耗时」估算，
// 估算态显示 ≈ 数字并封顶 90%；失败/取消没有数字语义。口径见 generationProgressCore.ts。
const progress = useGenerationProgress({
  generating,
  outcome: generationState.outcome,
  cancelled: generationState.cancelled,
  error: generationState.error,
  status: generationStatus,
  statusMessage: generationMessage,
  realPercent: upstreamPercent,
  modelId: () => selectedModel.value?.modelId ?? "",
  kind: "video",
});
const selectedMode = computed(() => selectedModel.value?.mode?.find((item) => JSON.stringify(item) === data.value.mode) as NodeVideoRequest["mode"]);
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));
const mediaCounts = computed(() => ({
  image: refList.value.filter((item) => item.dataType === "IMAGE").length,
  video: refList.value.filter((item) => item.dataType === "VIDEO").length,
  audio: refList.value.filter((item) => item.dataType === "AUDIO").length,
}));
// Grok 1.5 supports image-to-video requests without a text prompt. Keep the
// exception tied to an actual image reference so an empty text-only request
// still gets blocked before it reaches the server.
const promptOptional = computed(() =>
  Boolean(selectedModel.value?.parameterRules?.promptOptionalWithImage) &&
  refList.value.some((item) => item.dataType === "IMAGE" && Boolean(item.value))
);
const canStartGeneration = computed(() => Boolean(selectedModel.value && (generationPrompt.value || promptOptional.value)));
const matchingModes = computed(() => getMatchingModes(selectedModel.value));
type VideoEstimate = { points?: number | null; billingSource?: string; breakdown?: { outputPerSecond?: number; perSecond?: number; billingSource?: string } };
const videoEstimate = ref<VideoEstimate | null>(null);
const videoEstimateError = ref("");
let videoEstimateTimer: number | undefined;
let videoEstimateController: AbortController | undefined;
let videoEstimateSequence = 0;

function referenceCap(choice: NodeMediaModel, mode: string | string[], type: string) {
  const exact = choice.parameterRules?.referencesByMode?.[modeName(mode)]?.[type as "image" | "video" | "audio"];
  if (exact) return exact[1];
  if (Array.isArray(mode)) return Number(mode.find((item) => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0);
  return 0;
}
function getMatchingModes(choice?: NodeMediaModel) {
  return (choice?.mode ?? []).filter((mode) => {
    const { image, video, audio } = mediaCounts.value;
    const counts = { image, video, audio };
    if (Array.isArray(mode)) {
      const visual = !choice.parameterRules?.requireVisualInMixed || image + video > 0;
      return image + video + audio > 0 && visual && Object.entries(counts).every(([type, count]) => count <= referenceCap(choice, mode, type));
    }
    const limited = choice.parameterRules?.referencesByMode?.[mode];
    if (limited) {
      return (["image", "video", "audio"] as const).every((type) => {
        const span = limited[type] || [0, 0];
        return counts[type] >= span[0] && counts[type] <= span[1];
      });
    }
    if (mode === "text") return image + video + audio === 0;
    if (mode === "edit" || mode === "extend") {
      if (video < 1) return false;
      const referenceMode = choice.mode?.find(Array.isArray);
      return Object.entries(counts).every(([type, count]) =>
        count <= Number(referenceMode?.find(item => item.startsWith(type + "Reference:"))?.split(":")[1] ?? (type === "video" ? 1 : 0)));
    }
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    const frameCap = choice.parameterRules?.framePlusReferences ? (choice.referenceLimits?.image ?? 0) : 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= frameCap;
  });
}

function getDurations(choice: NodeMediaModel, mode: NodeVideoRequest["mode"] = selectedMode.value) {
  return durationsForMode(choice, mode);
}

function frameInputs(mode: NodeVideoRequest["mode"], images: Array<{ path: string; mimeType: string }>) {
  const frame = ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode));
  if (!frame) return { firstFrame: undefined, lastFrame: undefined };
  return {
    firstFrame: mode !== "startFrameOptional" || images.length > 1 ? images[0] : undefined,
    lastFrame: images[mode === "startFrameOptional" && images.length === 1 ? 0 : 1],
  };
}

function requestImages(choice: NodeMediaModel, mode: NodeVideoRequest["mode"], images: Array<{ path: string; mimeType: string }>) {
  if (!["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode))) return images;
  if (!choice.parameterRules?.framePlusReferences) return undefined;
  const { firstFrame, lastFrame } = frameInputs(mode, images);
  const framePaths = new Set([firstFrame?.path, lastFrame?.path].filter(Boolean));
  return images.filter(item => !framePaths.has(item.path));
}

nodeEvent.on("canConnect", (connection, context) => {
  if (connection.target !== id || connection.targetHandle !== "in") return true;
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  const references = getTargetValues(id, "in", context.nodes, [...edges, connection]);
  const count = (type: string) => references.filter(item => Array.isArray(item.dataType) ? item.dataType.includes(type) : item.dataType === type).length;
  const choice = selectedModel.value;
  if (choice && ["doubao-local", "dola-local"].includes(choice.providerId)) {
    const message = localReferenceRejection(choice.modelId, choice.providerId, { image: count("IMAGE"), video: count("VIDEO"), audio: count("AUDIO") });
    if (message) {
      ElMessage({ message: translate(message), type: "warning", grouping: true });
      return false;
    }
    return true;
  }
  const frameCap = selectedModel.value?.parameterRules?.framePlusReferences ? (selectedModel.value.referenceLimits?.image ?? 0) : 0;
  if (!frameCap || !frameMode.value) return true;
  if (count("IMAGE") <= frameCap) return true;
  ElMessage({ message: translate("首尾帧和参考图最多支持 {0} 张图片", { 0: frameCap }), type: "warning", grouping: true });
  return false;
});

function getResolutions(choice: NodeMediaModel, duration?: number) {
  // ACT: 分辨率按服务端目录给出的顺序（如 768P、2K / 480p、720p），不做跨单位数值排序。
  return [...new Set((choice.durationResolutionMap ?? []).filter((item) => item.duration.includes(duration!)).flatMap((item) => item.resolution))];
}
// ACT: 引用改变时只替换不适用的模式；普通媒体优先作为参考，避免自动变成首尾帧。
// A "试试" hint asks for a mode before its references exist; apply it once the
// connected media make that mode valid, instead of the default reference mode.
const preferredMode = ref<string | null>(null);
watch([selectedModel, matchingModes, () => data.value.mode], ([choice, matches]) => {
  if (choice && preferredMode.value && matches.some((item) => JSON.stringify(item) === preferredMode.value)) {
    data.value.mode = preferredMode.value;
    preferredMode.value = null;
    return;
  }
  if (!choice || matches.some((item) => JSON.stringify(item) === data.value.mode)) return;
  const modes = choice.mode ?? [];
  const mode = matches.find(Array.isArray) ?? matches.find((item) => item === "singleImage")
    ?? matches.find((item) => item === "endFrameOptional") ?? matches[0]
    ?? modes.find((item) => JSON.stringify(item) === data.value.mode) ?? modes.find(Array.isArray) ?? modes[0];
  data.value.mode = mode === undefined ? "" : JSON.stringify(mode);
}, { flush: "sync" });
// ACT: 参数在节点内归一化，未选中、未挂载底部设置时也可由 Agent 直接生成。
watch([selectedModel, () => data.value.duration, selectedMode], ([choice]) => {
  if (!choice) return;
  const durations = getDurations(choice);
  const pageDefault = choice.defaultDuration;
  const menuReady = durations.length > 0 || !["doubao-local", "dola-local"].includes(choice.providerId);
  if (menuReady && !durations.includes(data.value.duration!)) data.value.duration = typeof pageDefault === "number" && durations.includes(pageDefault) ? pageDefault : durations[0];
  const resolutions = getResolutions(choice, data.value.duration);
  if (menuReady) {
    if (resolutions.length) {
      if (!resolutions.includes(data.value.resolution)) data.value.resolution = resolutions[0];
    } else if (["doubao-local", "dola-local"].includes(choice.providerId)) data.value.resolution = "";
  }
  if (!data.value.parameters) data.value.parameters = {};
  if (menuReady && ratioOptions.value.length && !ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value[0];
  if (choice.audio !== "optional") data.value.generateAudio = choice.audio === true;
}, { flush: "sync" });
const generationPrompt = computed(() =>
  [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const videoEstimateKey = computed(() => JSON.stringify({
  model: selectedModel.value?.modelId || "",
  prompt: generationPrompt.value,
  duration: data.value.duration,
  resolution: data.value.resolution,
  ratio: data.value.ratio,
  mode: selectedMode.value,
  generateAudio: data.value.generateAudio,
  references: refList.value.map(item => (item.value && typeof item.value === "object" ? item.value.url : item.value) || item.dataType),
}));
const documentContext = inject<{ targets: Map<string, HTMLElement> } | undefined>("nodeDocument", undefined);
const autoEstimateVisible = computed(() => node.selected || Boolean(documentContext?.targets.has(id)));
watch([videoEstimateKey, autoEstimateVisible], scheduleVideoEstimate, { immediate: true });
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, translate("视频读取失败"))
);
const composerVisible = ref(false);
const composerExpanded = ref(false);
watchEffect(() => { composerVisible.value = composerExpanded.value || node.selected || !previewUrl.value; });

onMounted(() => {
  void loadModels().catch(error => { if (!disposed) showNodeError(error, translate("模型读取失败")); });
  void recoverGeneration().catch(error => { if (!disposed) showNodeError(error, translate("视频取回失败")); });
});
watch(() => data.value.taskRequestId, requestId => {
  if (requestId && !disposed && !deleting.value && !generating.value) void recoverGeneration().catch(error => { if (!disposed) showNodeError(error, translate("视频取回失败")); });
}, { flush: "post" });
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
  if (videoEstimateTimer !== undefined) window.clearTimeout(videoEstimateTimer);
  videoEstimateController?.abort();
});

function formatCredits(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(2).replace(/\.?0+$/, "") : "—";
}

function scheduleVideoEstimate() {
  const sequence = ++videoEstimateSequence;
  if (videoEstimateTimer !== undefined) window.clearTimeout(videoEstimateTimer);
  videoEstimateController?.abort();
  videoEstimateController = undefined;
  videoEstimate.value = null;
  videoEstimateError.value = "";
  if (!autoEstimateVisible.value) return;
  // Nothing to quote before there is a prompt; the send button already explains it.
  if (!generationPrompt.value && !promptOptional.value) return;
  videoEstimateTimer = window.setTimeout(() => {
    if (autoEstimateVisible.value) void refreshVideoEstimate(sequence);
  }, 220);
}

async function refreshVideoEstimate(sequence: number, signal?: AbortSignal) {
  const choice = selectedModel.value;
  if (!choice || disposed || sequence !== videoEstimateSequence) return;
  const images = refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const videos = refList.value.flatMap(item => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const audios = refList.value.flatMap(item => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const frame = frameMode.value;
  const mode = selectedMode.value;
  const { firstFrame, lastFrame } = frameInputs(mode, images);
  const request = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    mode,
    duration: data.value.duration,
    resolution: data.value.resolution || undefined,
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    images: requestImages(choice, mode, images),
    firstFrame: frame ? firstFrame : undefined,
    lastFrame: frame ? lastFrame : undefined,
    videos,
    audios,
  };
  const controller = new AbortController();
  videoEstimateController = controller;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const result = await ai.estimateVideo(request, controller.signal);
    if (sequence === videoEstimateSequence && !controller.signal.aborted) {
      videoEstimate.value = result;
      videoEstimateError.value = "";
    }
  } catch (error) {
    if (sequence === videoEstimateSequence && !controller.signal.aborted) {
      videoEstimate.value = null;
      videoEstimateError.value = error instanceof Error ? error.message : translate("当前素材或参数不符合模型要求");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (videoEstimateController === controller) videoEstimateController = undefined;
  }
}

function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || uploadingDrag.value || disposed) return;
  if (assetFileType(file).kind !== "video") return void showNodeError(translate("请选择视频文件"), translate("视频替换失败"));
  if (!file.size || file.size > ASSET_MAX_BYTES) return void showNodeError(translate("视频为空或超过当前工作区允许的大小"), translate("视频替换失败"));
  // 和「拖文件进画布」、以及基础媒体节点的「替换」走同一条通道：真上传进度的环形、
  // 失败可重试、写回 outputs 都在 useNodeUpload 里，别再退回一个没有百分比的转圈。
  // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
  beginUpload(id, file.name, file, assetFileType(file).mimeType);
}

function keepSavedLocalModel(items: NodeMediaModel[]) {
  let pair: unknown;
  try { pair = JSON.parse(String(data.value.model || "")); } catch { return items; }
  if (!Array.isArray(pair) || pair.length !== 2 || (pair[0] !== "doubao-local" && pair[0] !== "dola-local") || typeof pair[1] !== "string") return items;
  if (items.some((item) => item.providerId === pair[0] && item.modelId === pair[1])) return items;
  return [...items, { providerId: pair[0], providerLabel: pair[0] === "dola-local" ? "Dola" : "豆包", modelId: pair[1], label: pair[1], type: "video" as const, mode: ["text"], ratios: [], durations: [], durationResolutionMap: [] }];
}
function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (disposed || deleting.value || (generating.value && models.value.length > 0)) return;
    models.value = keepSavedLocalModel(items.filter((item) => item.type === "video"));
    // ACT: 只给空配置选默认模型，保留暂时不可用的旧选择及其参数。
    if (!data.value.model) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}
function refreshLiveModels() { void loadModels()?.catch(() => {}); }
onMounted(() => window.addEventListener("miao-media-models", refreshLiveModels));
onScopeDispose(() => window.removeEventListener("miao-media-models", refreshLiveModels));
watch(() => node.selected, selected => { if (selected) refreshLiveModels(); });

function recordGenerationStatus(status: string, progress?: number | null, message = "", requestId?: string) {
  generationMessage.value = message;
  generationStatus.value = status;
  if (progress !== undefined) upstreamPercent.value = progress;
  if (requestId && ["failed", "cancelled", "expired"].includes(status)) delivery.clear(requestId);
}

function recoverGeneration(): Promise<boolean> {
  if (recoveryLookup) {
    const requestedTask = data.value.taskRequestId;
    // A newer background task must get its own lookup after the older read.
    if (requestedTask && requestedTask !== recoveryTaskId) {
      return recoveryLookup.catch(() => false).then(() => data.value.taskRequestId === requestedTask ? recoverGeneration() : false);
    }
    return recoveryLookup;
  }
  if (disposed || deleting.value || generating.value || uploading.value || uploadingDrag.value
    || (!pendingTask.value && (recoveryChecked || outputs.value.video?.value))) return Promise.resolve(false);
  const previousGeneration = generation;
  const previousTask = data.value.taskRequestId;
  recoveryTaskId = previousTask;
  const previousOutput = outputs.value.video;
  const previousValue = JSON.stringify(previousOutput);
  checkingTask.value = true;
  const pending = (async () => {
    const requestId = await ai.findVideoTask(`assets/${id}`);
    if (disposed || deleting.value || generating.value || uploading.value || uploadingDrag.value
      || generation !== previousGeneration || data.value.taskRequestId !== previousTask
      || outputs.value.video !== previousOutput || JSON.stringify(outputs.value.video) !== previousValue) return false;
    recoveryChecked = true;
    if (!requestId) {
      if (generationState.outcome.value === "pending") throw new Error(translate("暂未找到原任务，请稍后继续取回，或查看生成历史。"));
      if (previousTask) delivery.clear(previousTask);
      return false;
    }
    delivery.recover(requestId);
    const controller = new AbortController();
    generationController = controller;
    generation = generationState.run(async () => {
      const { directory } = await files.getWorkspaceFiles().list();
      const results = await ai.resumeVideo(requestId, { directory, outputDirectory: `assets/${id}`, onStatus: (status, progress, message) => recordGenerationStatus(status, progress, message, requestId), shouldCancel: () => !disposed }, controller.signal);
      controller.signal.throwIfAborted();
      if (!results.length) throw new Error(translate("生成服务没有返回视频"));
      delivery.apply(requestId, results);
    }).catch(error => { if (!disposed) showNodeError(error, translate("视频取回失败")); }).finally(() => { if (generationController === controller) generationController = undefined; });
    return true;
  })().finally(() => {
    if (recoveryLookup === pending) { recoveryLookup = undefined; recoveryTaskId = undefined; checkingTask.value = false; }
  });
  recoveryLookup = pending;
  return pending;
}

async function startGeneration(signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (disposed || deleting.value) throw new Error(translate("节点正在删除"));
  if (generating.value) throw new Error(translate("视频正在生成，请等待完成"));
  if (uploading.value || uploadingDrag.value) throw new Error(translate("视频正在替换，请等待完成"));
  const wasPending = pendingTask.value;
  const previousOutput = outputs.value.video;
  const previousValue = JSON.stringify(previousOutput);
  const recovered = await recoverGeneration();
  signal?.throwIfAborted();
  if (disposed) throw new Error(translate("画布节点已变化，请重新操作"));
  if (deleting.value) throw new Error(translate("节点正在删除"));
  if (recovered) return { status: "recovering" };
  if (wasPending) {
    if (!pendingTask.value && outputs.value.video?.value) return { status: "ready" };
    throw new Error(translate("暂未找到原任务，请稍后继续取回，或查看生成历史。"));
  }
  if (outputs.value.video !== previousOutput || JSON.stringify(outputs.value.video) !== previousValue) throw new Error(translate("画布节点已变化，请重新操作"));
  const choice = selectedModel.value;
  if (generating.value) throw new Error(translate("视频正在生成，请等待完成"));
  if (uploading.value || uploadingDrag.value) throw new Error(translate("视频正在替换，请等待完成"));
  if (deleting.value) throw new Error(translate("节点正在删除"));
  if (!choice) throw new Error(translate("请先选择视频模型"));
  preparePromptReferences();
  if (!generationPrompt.value && !promptOptional.value) throw new Error(translate("请输入生成提示词，或为当前模型添加图片参考"));
  if (refList.value.some(item => item.value === undefined)) throw new Error(translate("引用节点暂无内容，请先补充引用内容"));
  const images = refList.value.flatMap((item) => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  if (choice.mode?.length && !matchingModes.value.length) throw new Error(translate("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用"));
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  recordGenerationStatus("queued");
  upstreamPercent.value = null;
  let requestId = "";
  const input: Omit<NodeVideoRequest, "directory"> = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    referenceHistory: referenceHistory(),
    mode: selectedMode.value,
    duration: data.value.duration,
    resolution: data.value.resolution || undefined,
    ratio: data.value.ratio,
    generateAudio: choice.audio === "optional" ? data.value.generateAudio : choice.audio,
    onStatus: (status, progress, message) => recordGenerationStatus(status, progress, message, requestId),
    onTask: async (value, existing = false) => { requestId = value; await delivery.bind(value, existing, undefined, controller.signal); },
    shouldCancel: () => !disposed,
    outputDirectory: `assets/${id}`,
    images: requestImages(choice, selectedMode.value, images),
    firstFrame: frameInputs(selectedMode.value, images).firstFrame,
    lastFrame: frameInputs(selectedMode.value, images).lastFrame,
    videos: refList.value.flatMap((item) => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    audios: refList.value.flatMap((item) => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
    ...controlPayload(choice, selectedMode.value, data.value.parameters),
  };
  generationController = controller;
  // Explicit stop cancels; unmount only detaches. The next mount resumes the same paid task.
  generation = generationState.run(() => workspace
    .list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return ai.estimateVideo(input, controller.signal).then(() => directory);
    })
    .then((directory) => {
      controller.signal.throwIfAborted();
      return ai.generateVideo({ ...input, directory }, controller.signal);
    })
    .then((results) => {
      controller.signal.throwIfAborted();
      if (!results.length) throw new Error(translate("生成服务没有返回视频"));
      delivery.apply(requestId, results);
    }))
    .catch((error) => { if (!disposed) showNodeError(error, translate("视频生成失败")); })
    .finally(() => {
      if (generationController === controller) generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value)) throw new Error(translate("视频处理中，请完成后再刷新节点"));
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error(translate("视频正在替换，请稍后删除节点"));
  deleting.value = true;
  generationController?.abort();
  try {
    await Promise.all([generation, player.value?.cancelAndWait()]);
    if (pendingTask.value) throw new Error(translate("原任务尚未结束，请先继续取回或确认取消后再删除节点。"));
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeVideo({ width, height }: { width: number; height: number }) {
  if (!width || !height) return;
  videoDimensions.value = { width, height };
  videoWidth.value = Math.min(640, Math.max(240, (240 * width) / height));
  await nextTick();
  updateNodeInternals();
}

async function getConfigWithEstimate(signal?: AbortSignal) {
  // Flush model normalization and quote invalidation before reading the configured price.
  await nextTick();
  signal?.throwIfAborted();
  if (videoEstimateTimer !== undefined) window.clearTimeout(videoEstimateTimer);
  videoEstimateTimer = undefined;
  videoEstimateController?.abort();
  const sequence = ++videoEstimateSequence;
  videoEstimate.value = null;
  await refreshVideoEstimate(sequence, signal);
  signal?.throwIfAborted();
  return getConfig();
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      duration: data.value.duration,
      resolution: data.value.resolution,
      ratio: data.value.ratio,
      mode: selectedMode.value,
      generateAudio: data.value.generateAudio,
      keyframes: selectedModel.value?.keyframes ?? 0,
    },
    models: models.value,
    ratios: ratioOptions.value,
    matchingModes: matchingModes.value,
    estimate: videoEstimate.value ? { points: videoEstimate.value.points, source: videoEstimate.value.breakdown?.billingSource || 'server' } : null,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此视频生成节点的当前配置、可选视频模型能力、通用比例及适合当前引用的模式，等待当前参数的积分报价后返回，报价失败为 null；不含密钥；时长与分辨率须符合 durationResolutionMap",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return await getConfigWithEstimate(signal);
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此视频生成节点的模型、时长、分辨率、比例、模式或声音；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供；mode 使用返回的原始字符串或数组，须匹配当前引用；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    duration: z.number().int().optional(),
    resolution: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
    mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    generateAudio: z.boolean().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
    const durations = getDurations(choice, args.mode ?? selectedMode.value);
    if (args.duration !== undefined && (args.duration === 0 || !durations.includes(args.duration))) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
    const pageDefault = choice.defaultDuration;
    const duration = args.duration ?? (durations.includes(data.value.duration!) || !durations.length ? data.value.duration : typeof pageDefault === "number" && durations.includes(pageDefault) ? pageDefault : durations[0]);
    const resolutions = getResolutions(choice, duration);
    if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
    const resolution = args.resolution ?? (resolutions.includes(data.value.resolution) ? data.value.resolution : resolutions[0] ?? "");
    if (args.mode !== undefined && !getMatchingModes(choice).some((item) => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
    if (args.ratio !== undefined && !ratioOptions.value.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratioOptions.value.join("、")}`);
    if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    data.value.duration = duration;
    data.value.resolution = resolution;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    if (args.mode !== undefined) data.value.mode = JSON.stringify(args.mode);
    if (args.generateAudio !== undefined) data.value.generateAudio = args.generateAudio;
    return await getConfigWithEstimate(signal);
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateVideo",
  description: "启动此节点的后台视频生成；节点尚无输出时先核对本节点原任务，查询失败不提交新请求；找到原任务或仍有待取回任务时，只取回原结果，不重新下单。新生成使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 请求停止",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration(signal);
  },
});

// "+ 参考" picks local media; the canvas imports it and wires it into this node.
function requestReference(accept?: string[]) {
  window.dispatchEvent(new CustomEvent("miao-canvas-add-reference", { detail: { nodeId: id, accept } }));
}
function focusPrompt() {
  document.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(id)}"] .promptInput [contenteditable="true"]`)?.focus();
}
// Empty-node shortcuts list only the modes the selected model really offers.
const emptyHints = computed(() => {
  const modes = selectedModel.value?.mode ?? [];
  const has = (name: string) => modes.some((item) => item === name);
  const reference = modes.find(Array.isArray);
  const prefer = (mode: unknown, accept: string[]) => () => { preferredMode.value = JSON.stringify(mode); requestReference(accept); };
  const hints: { key: string; label: string; icon: unknown; run: () => void }[] = [];
  if (has("text")) hints.push({ key: "text", label: translate("文字生成视频"), icon: IconWriting, run: focusPrompt });
  const first = has("singleImage") ? "singleImage" : has("endFrameOptional") ? "endFrameOptional" : null;
  if (first) hints.push({ key: "first", label: translate("首帧生成视频"), icon: IconPhoto, run: prefer(first, ["IMAGE"]) });
  if (has("endFrameOptional")) hints.push({ key: "frames", label: translate("首尾帧生成视频"), icon: IconLayersLinked, run: prefer("endFrameOptional", ["IMAGE"]) });
  if (reference) hints.push({ key: "reference", label: translate("多素材参考生成"), icon: IconStack2, run: prefer(reference, ["IMAGE", "VIDEO", "AUDIO"]) });
  return hints;
});
</script>

<style scoped lang="scss">
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  &:has(.videoPlayer) { min-height: 0; }
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    align-content: center;
    gap: 18px;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: 0;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }

  .sendActions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: auto;
    flex: 0 0 auto;
    min-width: 0;
    max-width: 100%;
  }

  .estimateLine {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 20px;
    margin-top: 0;
    flex: 0 1 auto;
    min-width: 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;

    strong {
      color: var(--el-text-color-primary);
      font-weight: 600;
    }
  }
}
</style>
