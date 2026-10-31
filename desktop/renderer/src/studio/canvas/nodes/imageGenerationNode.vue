<template>
  <nodeSkeleton
    class="imageNodeShell"
    :class="{ emptyGeneration: !previewUrl }"
    v-bind="nodeProps"
    :modelLabel="nodeLocalModelLabel(data.model)"
    :mediaMeta="mediaMeta"
    :mediaMetaTitle="mediaMetaTitle"
    v-model:bottomVisible="composerVisible"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :bottomWidth="660"
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 2}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <imageIntentMenu v-if="previewUrl" :controller="imageIntents" :disabled="imageOutpaint.busy || imageOutpaint.state.visible || imageGeometry.state.visible || imageGeometry.busy || imageBusy" />
      <imageGeometryMenu v-if="previewUrl" :controller="imageGeometry" :disabled="imageOutpaint.busy || imageOutpaint.state.visible || imageBusy || imageIntents.busy || imageIntents.state.visible" />
      <imageOutpaintMenu v-if="previewUrl" :controller="imageOutpaint" :disabled="imageBusy || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible" />
      <el-button v-if="layerEntryAvailable" :icon="IconLayersSubtract" text :loading="creatingLayerEntry" :disabled="generating || deleting || uploading || uploadingDrag || gridSplit?.splitting" :title="translate('图层分离')" :aria-label="translate('图层分离')" @click.stop="createLayerEntry">{{ translate('图层分离') }}</el-button>
      <el-button :icon="IconPanoramaHorizontal" :disabled="imageBusy || !previewUrl" text :title="translate('720度全景图')" :aria-label="translate('720度全景图')" @click.stop="panorama?.open($event)" />
      <el-button v-if="selectedModel?.regionEdit" :icon="IconBrush" :disabled="generating || deleting || uploading || !previewUrl || gridSplit?.splitting" text :title="translate('重绘')" :aria-label="translate('重绘')" @click.stop="editor?.start('inpaint')" />
      <el-button :icon="IconSun" :disabled="imageBusy || !previewUrl" text :title="translate('打光')" :aria-label="translate('打光')" @click.stop="openLighting" />
      <el-button :icon="IconCameraRotate" :disabled="imageBusy || !previewUrl" text :title="translate('多角度')" :aria-label="translate('多角度')" @click.stop="openMultiAngle" />
      <el-button :icon="IconLayoutGrid" :disabled="generating || deleting || uploading || !previewUrl" :loading="gridSplit?.splitting" text :title="translate('宫格切分')" :aria-label="translate('宫格切分')" @click.stop="gridSplit?.open($event)" />
      <imagePresetMenu v-if="previewUrl" ref="presetMenu" :disabled="imageBusy || !previewUrl" :loadModels="() => ai.getMediaModels()" />
      <span ref="historyTarget" />
      <el-button :icon="IconTransfer" :loading="uploading || uploadingDrag" :disabled="generating || deleting" text :title="translate('替换图片')" :aria-label="translate('替换图片')" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="image/*" hidden :aria-label="translate('选择替换图片')" :disabled="generating || deleting || uploading || uploadingDrag" @change="replaceOutput" />
      <el-button :icon="IconPencil" :disabled="generating || deleting || uploading || !previewUrl || gridSplit?.splitting" text :title="translate('标注')" :aria-label="translate('标注')" @click.stop="editor?.start('mark')" />
    </template>
    <div v-loading="uploading" class="imageContent nopan" :aria-busy="generating || uploading">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :previewSrc="displayPreviewUrl"
        :toolbarTarget="paintToolbar"
        :regionEdit="selectedModel?.regionEdit ?? null"
        :disabled="generating || deleting || uploading"
        :alt="translate('生成图片')"
        @load="resizeImage"
        @error="showNodeError(translate('无法预览该图片'), translate('图片预览失败'))" />
      <div v-else class="imageEmpty mediaEmpty" :aria-label="translate('暂无生成图片')">
        <icon-photo-ai :size="48" stroke="1.25" aria-hidden="true" />
        <div v-if="!refList.length" class="emptyHints nodrag nopan" role="group" :aria-label="translate('尝试')">
          <span class="emptyHintsTitle">{{ translate('尝试：') }}</span>
          <button type="button" class="emptyHint" :disabled="generating || deleting" @pointerdown.stop @click.stop="focusPrompt">
            <icon-writing :size="16" aria-hidden="true" />{{ translate('文生图') }}
          </button>
          <button v-if="(selectedModel?.maxReferences ?? 1) > 0" type="button" class="emptyHint" :disabled="generating || deleting" @pointerdown.stop @click.stop="requestReference()">
            <icon-photo-plus :size="16" aria-hidden="true" />{{ translate('图生图') }}
          </button>
        </div>
      </div>
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
      <generationProgress :progress="progress" :label="translate('图片生成进度')" />
    </div>
    <template #bottom>
      <div v-if="variationMode" ref="variationTarget" />
      <Teleport to="body">
        <div v-if="composerExpanded" class="promptComposerBackdrop" aria-hidden="true" @pointerdown.stop @click="composerExpanded = false" />
      </Teleport>
      <Teleport v-if="!variationMode" to="body" :disabled="!composerExpanded">
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
              <icon-upload :size="14" aria-hidden="true" />{{ translate('上传') }}
            </button>
            <button v-if="canvasReferenceMentions.length || refList.length" type="button" class="composerChip nodrag" :disabled="generating || deleting" :aria-label="translate('画布参考')" @mousedown.prevent @click.stop="promptEditor?.openReferenceMenu()">
              <icon-layers-linked :size="14" aria-hidden="true" />{{ translate('画布参考') }}
            </button>
          </div>
          <referenceItem
            v-if="refList.length && editor?.mode !== 'inpaint'"
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
          <imageReferenceRoles v-if="editor?.mode !== 'inpaint'" v-model="data.imageReferenceRoles" :references="refList" :model="selectedModel" :disabled="generating || deleting" />
          <promptInput
            v-if="editor?.mode === 'inpaint'"
            v-model="data.inpaintPromptModel"
            v-model:text="data.inpaintPrompt"
            v-model:expanded="composerExpanded"
            :references="[]"
            expandable
            expand-mode="external" />
          <promptInput
            ref="promptEditor"
            v-else
            v-model="data.promptModel"
            v-model:text="data.prompt"
            v-model:expanded="composerExpanded"
            :references="referenceMentions"
            :canvas-references="canvasReferenceMentions"
            :reference-kinds="referenceKinds"
            :connect-reference="connectReference"
            placeholder="可直接文字生图，或上传图片输入文字指令对图片进行编辑，如：将背景改为雪夜"
            expandable
            expand-mode="external" />
        </div>
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
            :noDataText="modelsNeedSignIn ? translate('登录后可选择模型') : translate('请先在设置中添加图片模型')"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, translate('模型读取失败')))">
            <template #prefix><modelIcon :model="selectedModel?.modelId || nodeModelValueId(data.model)" :size="17" /></template>
            <el-option v-if="data.model && !models.some(item => JSON.stringify([item.providerId, item.modelId]) === data.model)" class="savedModelOption" disabled :label="nodeModelValueLabel(data.model)" :value="data.model" />
            <el-option-group v-for="group in groupNodeModels(models)" :key="group.id" :label="group.label">
              <el-option v-for="item in group.models" :key="JSON.stringify([item.providerId, item.modelId])"
                :label="nodeModelOptionLabel(item)" :value="JSON.stringify([item.providerId, item.modelId])" >
                <span class="modelOptionContent"><modelIcon :model="item.modelId" :size="16" /><span class="modelOptionText" :title="nodeModelOptionLabel(item)">{{ nodeModelOptionLabel(item) }}</span></span>
              </el-option>
            </el-option-group>
          </el-select>
          <el-popover :persistent="false" v-if="['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')" trigger="click" placement="top-start" :width="360">
            <template #reference><el-button text size="small">{{ translate('参数与水印') }}</el-button></template>
            <div v-if="ratioOptions.some(ratio => ratio !== 'auto')" class="localRatio">
              <span>{{ translate('比例') }}</span>
              <el-radio-group v-model="data.ratio" size="small" :disabled="generating || deleting">
                <el-radio-button v-for="ratio in ratioOptions" :key="ratio" :value="ratio">{{ ratio === 'auto' ? translate('自动') : ratio }}</el-radio-button>
              </el-radio-group>
            </div>
            <p v-else>{{ translate('图片尺寸、比例跟随平台页面') }}</p>
          </el-popover>
          <generationSettings v-else
            v-model:size="data.size"
            v-model:ratio="data.ratio"
            v-model:format="data.format"
            v-model:background="data.background"
            v-model:quality="data.quality"
            v-model:input-fidelity="data.inputFidelity"
            v-model:count="data.count"
            v-model:layer-decomposition="data.layerDecomposition"
            v-model:optimize-prompt="data.optimizePrompt"
            v-model:parameters="data.parameters"
            :sizes="sizeOptions"
            :ratios="ratioOptions"
            :model="settingsModel"
            :reference-count="editor?.mode === 'inpaint' ? 1 : refList.filter(item => item.dataType === 'IMAGE' && item.value).length"
            :disabled="generating || deleting || !selectedModel" />
          <div class="sendActions">
            <feedbackNotice :message="imageEstimateError" />
            <div class="estimateLine" aria-live="polite" :title="imageEstimate?.points != null ? translate('预计 {0} 积分', { 0: formatCredits(imageEstimate.points) }) : translate('预计积分')" :data-estimate-source="imageEstimate?.source || 'unavailable'">
              <icon-bolt :size="13" aria-hidden="true" />
              <strong v-if="['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')">{{ translate(selectedModel?.providerId === 'dola-local' ? '使用 Dola 额度' : '使用豆包额度') }}</strong>
              <span v-else class="srOnly">{{ translate('预计') }}</span>
              <strong v-if="!['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '') && imageEstimate?.points != null">{{ formatCredits(imageEstimate.points) }}<span class="srOnly">{{ translate('积分') }}</span></strong>
              <strong v-else-if="!['doubao-local', 'dola-local'].includes(selectedModel?.providerId || '')">—</strong>
            </div>
            <el-button
              class="sendButton"
              :icon="generating ? IconPlayerStop : IconArrowUp"
              :loading="checkingTask"
              :disabled="checkingTask || deleting || uploading || uploadingDrag || (!generating && !pendingTask && (!canGenerate || Boolean(imageEstimateError)))"
              :title="checkingTask ? translate('正在确认原任务') : generating ? translate('取消生成（{0}）', { 0: cancellationHint }) : pendingTask ? translate('继续取回') : editor?.mode === 'inpaint' ? translate('重绘') : translate('生成图片')"
              :aria-label="checkingTask ? translate('正在确认原任务') : generating ? translate('取消生成') : pendingTask ? translate('继续取回') : editor?.mode === 'inpaint' ? translate('重绘') : translate('生成图片')"
              @click="generating ? generationController?.abort() : startGeneration().catch((error) => showNodeError(error, translate('图片生成失败')))" />
          </div>
        </div>
      </el-card>
      </Teleport>
    </template>
  </nodeSkeleton>
  <imageLighting v-if="variationMode === 'lighting'" ref="lighting" :src="previewUrl" :source="outputFile" :target="variationTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="variationMode = undefined" />
  <imageMultiAngle v-if="variationMode === 'angle'" ref="multiAngle" :src="previewUrl" :source="outputFile" :target="variationTarget" :disabled="generating || deleting || uploading || gridSplit?.splitting" @close="variationMode = undefined" />
  <imagePanorama ref="panorama" :src="previewUrl" :source="outputFile" :disabled="imageBusy" @open="openPanorama" />
  <mediaHistory :target="historyTarget" mediaType="image" :current="outputFile" :disabled="generating || deleting || uploading" @select="outputs.image = { dataType: 'IMAGE', value: $event }" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :source="outputFile" :disabled="generating || deleting || uploading" :active="node.selected" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { modelIcon } from "@miaoimg/model-icons";
import feedbackNotice from "../components/feedbackNotice.vue";
import { fitsCustomSize, groupNodeModels } from "../scaffold/nodeAi";
import { controlPayload } from "../scaffold/mediaParameters";
import { nodeLocalModelLabel, nodeModelValueId, nodeModelOptionLabel, nodeModelValueLabel } from '../scaffold/localModelLabel';
import { useImagePreviewTools } from '../scaffold/useImagePreviewTools';
import { computed, inject, nextTick, onMounted, onScopeDispose, ref, watch, watchEffect } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElLoading, ElImageViewer, ElMessage } from "element-plus";
import { IconBolt, IconPhotoAi, IconArrowUp, IconPlayerStop, IconTransfer, IconLayoutGrid, IconBrush, IconPencil, IconUpload, IconWriting, IconPhotoPlus, IconLayersLinked, IconSun, IconCameraRotate, IconPanoramaHorizontal, IconLayersSubtract } from "@tabler/icons-vue";
import { nodeSkeleton, nodeTools, showNodeError, isSignInRequired, useGenerationProgress, useNode, useNodeGeneration, useNodeReferences, useNodeUpload, z, type NodeMediaModel, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import { assertPromptReferencesConnected, isPromptModel } from "../scaffold/promptModel";
import promptInput from "@miaoimg/nodes-scaffold/promptInput";
import referenceItem from "@miaoimg/nodes-scaffold/referenceItem";
import mediaHistory from "@miaoimg/nodes-scaffold/mediaHistory";
import imageEditor from "@miaoimg/nodes-scaffold/imageEditor";
import imageGridSplit from "@miaoimg/nodes-scaffold/imageGridSplit";
import generationProgress from "@miaoimg/nodes-scaffold/generationProgress";
import uploadProgress from "../components/uploadProgress.vue";
import { beginUpload } from "../uploadStatus";
import { assetFileType } from "../assetFile";
import generationSettings from "./generationSettings.vue";
import { localReferenceRejection } from '../../../../../local-media/catalog.ts';
import { getTargetValues } from "../scaffold/nodeInputs";
import { translate } from "@miaoimg/i18n/vue";
import { useMediaTaskDelivery } from "../scaffold/useMediaTaskDelivery";
import { useImageTools } from "./imageTools/useImageTools";
import { useImageLayerEntry } from "./imageTools/useImageLayerEntry";
import { useImageIntentActions } from "./imageTools/useImageIntentActions";
import imageIntentMenu from "./imageTools/components/imageIntentMenu.vue";
import { useImageGeometryActions } from "./imageTools/useImageGeometryActions";
import imageGeometryMenu from "./imageTools/components/imageGeometryMenu.vue";
import { useImageOutpaintActions } from "./imageTools/useImageOutpaintActions";
import imageOutpaintMenu from "./imageTools/components/imageOutpaintMenu.vue";
import imageReferenceRoles from "./imageTools/components/imageReferenceRoles.vue";
import { imageReferenceRoles as collectImageReferenceRoles } from "./imageTools/imageReferenceRoles";
import { useImagePaletteActions, combineCanvasToolExtensions } from "../useMediaPaletteActions";
import imageLighting from "./imageTools/components/imageLighting.vue";
import imageMultiAngle from "./imageTools/components/imageMultiAngle.vue";
import imagePanorama from "./imageTools/components/imagePanorama.vue";
import imagePresetMenu from "./imageTools/components/imagePresetMenu.vue";
import { mediaSizeLabel } from "../../../../../../server/media-size-label";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "图片生成",
});
const delivery = useMediaTaskDelivery(node, outputs, "image");
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; inpaintPrompt: string; inpaintPromptModel: PromptModel; model: string; size: string; ratio: string; format?: string; background?: string; quality?: string; inputFidelity?: string; count?: number; layerDecomposition?: boolean; optimizePrompt?: string; imageReferenceRoles: Record<string, string>; parameters: Record<string, unknown>; taskRequestId?: string; taskExtraNodeIds?: string[] });
if (!data.value.parameters) data.value.parameters = {};
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.inpaintPrompt ??= "";
data.value.inpaintPromptModel ??= [];
data.value.model ??= "";
data.value.size ??= "";
data.value.ratio ??= "";
data.value.format ??= "";
data.value.background ??= "opaque";
data.value.quality ??= "";
data.value.inputFidelity ??= "";
data.value.count ??= 1;
data.value.layerDecomposition ??= false;
data.value.optimizePrompt ??= "";
data.value.imageReferenceRoles ??= {};
const { refList, referenceMentions, canvasReferenceMentions, referenceKinds, connectReference, referenceHistory, preparePromptReferences, setReferencePreview, removeReference } = useNodeReferences();
const promptEditor = ref<InstanceType<typeof promptInput>>();
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const modelsNeedSignIn = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
const historyTarget = ref<HTMLElement>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const variationTarget = ref<HTMLElement>();
const variationMode = ref<"lighting" | "angle">();
const lighting = ref<InstanceType<typeof imageLighting>>();
const multiAngle = ref<InstanceType<typeof imageMultiAngle>>();
const panorama = ref<InstanceType<typeof imagePanorama>>();
const presetMenu = ref<InstanceType<typeof imagePresetMenu>>();
const paintToolbar = ref<HTMLElement>();
let disposed = false;
const deleting = ref(false);
const previewVisible = ref(false);
useImagePreviewTools(previewVisible, () => !!previewUrl.value);
const imageWidth = ref(0);
const imageDimensions = ref<{ width: number; height: number }>();
// 节点头部按 LibTV 的叫法显示“比例 · 清晰度”，精确像素放在悬停提示里。
const mediaMeta = computed(() => imageDimensions.value ? mediaSizeLabel(`${imageDimensions.value.width}x${imageDimensions.value.height}`) : "");
const mediaMetaTitle = computed(() => imageDimensions.value ? `${imageDimensions.value.width} × ${imageDimensions.value.height}` : "");
let generationController: AbortController | undefined;
// 进度条要的上游状态：queued / running / saving（nodeAi 在写回画布前会补发一次 saving）。
const generationStatus = ref("");
const generationMessage = ref("");
const upstreamPercent = ref<number | null>(null);
const generationState = useNodeGeneration(outputs, () => generationController?.abort(), undefined, () => ({ phase: generationStatus.value, message: generationMessage.value, requestId: data.value.taskRequestId }));
const { generating } = generationState;
const pendingTask = computed(() => Boolean(data.value.taskRequestId) || generationState.outcome.value === "pending");
nodeEvent.on("copy", () => ({ taskRequestId: undefined, taskOutputPath: undefined, taskExtraNodeIds: undefined }));
// 取消按钮的提示语：排队中取消会退积分，已发出的请求不退。
const cancellationHint = computed(() => ['doubao-local', 'dola-local'].includes(selectedModel.value?.providerId || '') ? translate("额度以平台实际结算为准") : generationStatus.value === "queued" ? translate("排队中取消会退回积分") : translate("已发出的请求取消不退积分"));
let generation: Promise<void> | undefined;
let recoveryLookup: Promise<boolean> | undefined;
let recoveryTaskId: string | undefined;
let recoveryChecked = false;
const checkingTask = ref(false);
let modelsRequest: Promise<void> | undefined;
// 「替换图片」也走环形进度：复用生成节点自己的 upload 通道。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType } };
}, () => outputs.value);
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
nodeEvent.on("canConnect", (connection, context) => {
  if (connection.target !== id || connection.targetHandle !== "in") return true;
  const choice = selectedModel.value;
  if (!choice || !["doubao-local", "dola-local"].includes(choice.providerId)) return true;
  const edges = context.edges.filter(edge => edge.source !== connection.source || edge.sourceHandle !== connection.sourceHandle
    || edge.target !== connection.target || edge.targetHandle !== connection.targetHandle);
  const references = getTargetValues(id, "in", context.nodes, [...edges, connection]);
  const imageCount = references.filter(item => Array.isArray(item.dataType) ? item.dataType.includes("IMAGE") : item.dataType === "IMAGE").length;
  const message = localReferenceRejection(choice.modelId, choice.providerId, { image: imageCount });
  if (!message) return true;
  ElMessage({ message: translate(message), type: "warning", grouping: true });
  return false;
});
// 图片通道未返回真实百分比时，进度条按已用时估算并显示 ≈，生成时封顶 90%。
// 有真实值时与视频节点共用真值优先的规则，保存阶段保留带 ≈ 的百分比。
// 典型耗时的数据来源与算法见 scaffold/generationProgress.ts。
const progress = useGenerationProgress({
  generating,
  outcome: generationState.outcome,
  cancelled: generationState.cancelled,
  error: generationState.error,
  status: generationStatus,
  statusMessage: generationMessage,
  realPercent: upstreamPercent,
  modelId: () => selectedModel.value?.modelId ?? "",
  kind: "image",
});
const sizeOptions = computed(() => selectedModel.value?.imageSizes || []);
const ratioOptions = computed(() => selectedModel.value?.imageRatios || []);
type ImageEstimate = { points?: number | null; perImage?: number | null; source?: string };
const imageEstimate = ref<ImageEstimate | null>(null);
const imageEstimateError = ref("");
let imageEstimateTimer: number | undefined;
let imageEstimateController: AbortController | undefined;
let imageEstimateSequence = 0;
watch(
  selectedModel,
  (choice) => {
    if (!choice) return;
    if (['doubao-local', 'dola-local'].includes(choice.providerId)) { data.value.quality = ''; data.value.inputFidelity = ''; data.value.format = ''; data.value.background = ''; }
    // ACT: 现有分辨率使用 K 单位；出现其他单位时再统一换算，未知名称排在数值选项之后。
    const keepCustom = Boolean(choice.customSize) && fitsCustomSize(choice.sizeRule, data.value.size);
    if (sizeOptions.value.length && !sizeOptions.value.includes(data.value.size) && !keepCustom) {
      const sorted = sizeOptions.value.toSorted((left, right) =>
        (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
      );
      // 已有比例（如快捷预设预填的 16:9）时，优先选同比例的最小尺寸，避免尺寸自带的比例把它改掉。
      data.value.size = sorted.find(value => choice.sizes?.find(item => item.value === value)?.ratio === data.value.ratio) ?? sorted[0]!;
    }
    const listedRatios = ratioOptions.value;
    const waitingForMenu = ['doubao-local', 'dola-local'].includes(choice.providerId) && (!listedRatios.length || listedRatios.every(item => item === "auto"));
    if (!waitingForMenu && listedRatios.length && !listedRatios.includes(data.value.ratio)) data.value.ratio = listedRatios[0]!;
    // Size-encoded image APIs expose one concrete size for each aspect ratio.
    // Repair old canvases that saved contradictory pairs such as 16:9 + 1024².
    const sizeMeta = choice.sizes?.find(item => item.value === data.value.size);
    if (!waitingForMenu && sizeMeta?.ratio && sizeMeta.ratio !== "auto" && sizeMeta.ratio !== data.value.ratio) {
      data.value.ratio = sizeMeta.ratio;
    }
    // 图片模型的官方可选参数：格式 / 质量 / 输入保真度 / 张数 / 透明背景 / 提示词优化 / 图层拆分。
    const localMedia = ['doubao-local', 'dola-local'].includes(choice.providerId);
    const formats = choice.formats || [];
    if (!localMedia && !formats.includes(data.value.format || "")) data.value.format = formats[0] || "";
    if (!localMedia && !choice.supportsTransparent) data.value.background = "opaque";
    if (data.value.quality && !choice.quality?.includes(data.value.quality)) data.value.quality = "";
    if (data.value.inputFidelity && !choice.inputFidelity?.includes(data.value.inputFidelity)) data.value.inputFidelity = "";
    data.value.parameters = controlPayload(choice, "text", data.value.parameters);
    data.value.count = Math.max(1, Math.min(Number(data.value.count) || 1, choice.maxCount || 1));
    if (!choice.supportsLayerDecomposition) data.value.layerDecomposition = false;
    if (choice.optimizePromptModes?.length && data.value.optimizePrompt && !choice.optimizePromptModes.includes(data.value.optimizePrompt)) data.value.optimizePrompt = "";
    if (!choice.optimizePromptModes?.length) data.value.optimizePrompt = "";
    // 透明背景与图层拆分的官方限制：透明背景要 png；图层拆分只用 1K/1.5K/2K/auto。
    if (data.value.background === "transparent" && data.value.format !== "png") data.value.format = "png";
    const layerSizes = choice.layerSizes || [];
    if (data.value.layerDecomposition && layerSizes.length && !layerSizes.includes(data.value.size || "")) data.value.size = layerSizes.includes("1.5K") ? "1.5K" : layerSizes[0]!;
    normalizeInpaintSettings();
  },
  { flush: "sync" }
);
// 服务端的 edit 契约一次只出一张、且不接受图层拆分和透明背景；进入重绘模式时把这三项归位，
// 面板上显示的就是真正会提交的值。切换模型或中途进模式都要按住，所以两边都调用。
function normalizeInpaintSettings() {
  if (editor.value?.mode !== "inpaint") return;
  data.value.count = 1;
  data.value.layerDecomposition = false;
  data.value.background = "opaque";
}
watch(() => editor.value?.mode, normalizeInpaintSettings);
// 重绘模式下要隐藏图层拆分和透明背景开关，避免摆出提交不了的选项。
const settingsModel = computed(() => {
  const model = selectedModel.value;
  if (!model) return model;
  if (editor.value?.mode !== "inpaint") return model.maxCombinedImages
    ? { ...model, maxCount: Math.max(1, Math.min(model.maxCount || 1, model.maxCombinedImages - refList.value.filter(item => item.dataType === "IMAGE").length)) }
    : model;
  return { ...model, maxCount: 1, supportsLayerDecomposition: false, supportsTransparent: false };
});
// 重绘模式只提交原图一张参考，引用素材不参与；提示词里也不再追加文本引用，避免出现无效的参考标记。
const generationPrompt = computed(() => {
  if (editor.value?.mode === "inpaint") return data.value.inpaintPrompt.trim();
  return [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n");
});
// 局部重绘要么有重绘提示词、要么是普通生成且给了提示词或开了图层拆分。
const canGenerate = computed(() => {
  const model = selectedModel.value;
  if (!model) return false;
  if (refList.value.some(item => item.value === undefined)) return false;
  if (editor.value?.mode === "inpaint") return Boolean(model.regionEdit) && Boolean(data.value.inpaintPrompt.trim());
  const references = refList.value.filter(item => item.dataType === "IMAGE").length;
  if (references > (model.maxReferences ?? 0)) return false;
  if (model.maxCombinedImages && references + (Number(data.value.count) || 1) > model.maxCombinedImages) return false;
  return Boolean(generationPrompt.value) || Boolean(data.value.layerDecomposition);
});
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const imageRolePayload = computed(() => editor.value?.mode === "inpaint" ? undefined : collectImageReferenceRoles(refList.value, data.value.imageReferenceRoles, selectedModel.value));
const imageEstimateKey = computed(() => JSON.stringify({
  provider: selectedModel.value?.providerId || "",
  model: selectedModel.value?.modelId || "",
  prompt: generationPrompt.value,
  size: data.value.size,
  ratio: data.value.ratio,
  format: data.value.format,
  background: data.value.background,
  quality: data.value.quality,
  inputFidelity: data.value.inputFidelity,
  count: data.value.count,
  layerDecomposition: data.value.layerDecomposition,
  referenceRoles: imageRolePayload.value,
  optimizePrompt: data.value.optimizePrompt,
  editMode: editor.value?.mode || "",
  output: outputFile.value?.url || "",
  references: refList.value.map(item => (item.value && typeof item.value === "object" ? item.value.url : item.value) || item.dataType),
}));
const documentContext = inject<{ targets: Map<string, HTMLElement> } | undefined>("nodeDocument", undefined);
const autoEstimateVisible = computed(() => node.selected || Boolean(documentContext?.targets.has(id)));
watch([imageEstimateKey, autoEstimateVisible], scheduleImageEstimate, { immediate: true });
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showNodeError(error, translate("图片读取失败"))
);
const imageBusy = computed(() => generating.value || deleting.value || uploading.value || uploadingDrag.value
  || Boolean(editor.value?.busy) || Boolean(lighting.value?.generating) || Boolean(multiAngle.value?.generating)
  || Boolean(panorama.value?.busy) || Boolean(gridSplit.value?.splitting));
useImageTools(() => Boolean(outputFile.value) && !imageBusy.value);
const { available: layerEntryAvailable, creating: creatingLayerEntry, create: createLayerEntry } = useImageLayerEntry({
  node, hasImage: () => Boolean(outputFile.value), disabled: () => imageBusy.value || Boolean(gridSplit.value?.splitting),
  loadModels: () => ai.getMediaModels(), onError: error => showNodeError(error, translate("新建节点失败")),
});
const imageIntents = useImageIntentActions({
  node, hasImage: () => Boolean(outputFile.value?.url),
  disabled: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  loadModels: () => ai.getMediaModels(true), onError: error => showNodeError(error, translate("新建节点失败")),
  async prepareErase(input, signal) {
    const current = (await ai.getMediaModels(true)).find(model => model.providerId === input.providerId && model.modelId === input.modelId && model.regionEdit);
    signal.throwIfAborted();
    if (!current || !editor.value) throw new Error(translate("图片编辑器尚未就绪，请确认原图已加载"));
    if (!models.value.some(model => model.providerId === current.providerId && model.modelId === current.modelId)) models.value = [...models.value, current];
    data.value.model = JSON.stringify([input.providerId, input.modelId]); data.value.size = input.size; data.value.ratio = input.ratio;
    data.value.inpaintPrompt = input.prompt; data.value.inpaintPromptModel = input.prompt.split("\n").map(text => [{ type: "Write", text }]);
    await nextTick(); signal.throwIfAborted(); await editor.value.start("inpaint");
  },
});
const imageGeometry = useImageGeometryActions({
  node, disabled: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageIntents.busy || imageIntents.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  onError: error => showNodeError(error, translate("图片处理失败")),
});
const imageOutpaint = useImageOutpaintActions({
  node, disabled: () => imageBusy.value || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  loadModels: () => ai.getMediaModels(true), onError: error => showNodeError(error, translate("新建节点失败")),
});
useImagePaletteActions({
  node, hasImage: () => Boolean(outputFile.value?.url),
  busy: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  inpaintAllowed: () => Boolean(selectedModel.value?.regionEdit),
  ready: tool => ["image:lighting", "image:angle", "image:layers"].includes(tool) ? true
    : tool === "image:mark" || tool === "image:inpaint" ? Boolean(editor.value)
      : tool === "image:grid" ? Boolean(gridSplit.value) : tool.startsWith("image:preset:") ? Boolean(presetMenu.value) : Boolean(panorama.value),
  lighting: openLighting, angle: openMultiAngle, mark: () => editor.value?.start("mark"), inpaint: () => editor.value?.start("inpaint"),
  grid: event => gridSplit.value?.open(event), panorama: command => panorama.value?.selectAction(command),
  layers: createLayerEntry, preset: preset => presetMenu.value?.apply(preset), extension: combineCanvasToolExtensions(imageIntents.extension, imageGeometry.extension, imageOutpaint.extension),
});
const composerVisible = ref(false);
const composerExpanded = ref(false);
const { addSelectedNodes, removeSelectedElements } = useVueFlow();
watchEffect(() => { composerVisible.value = composerExpanded.value || autoEstimateVisible.value; });

const displayPreviewUrl = files.useFileUrl(outputFile, () => {}, true);
// A thumbnail only determines layout. Read the original dimensions on demand
// for the selected node, reusing the workspace's browser media cache.
watch([previewUrl, () => node.selected], async ([source, selected], previous, onCleanup) => {
  if (source !== previous?.[0]) imageDimensions.value = undefined;
  if (!source || !selected || imageDimensions.value || !outputFile.value) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  try {
    const size = await files.getWorkspaceFiles().readImageSize?.(outputFile.value.url, controller.signal);
    if (!controller.signal.aborted && size) imageDimensions.value = size;
  } catch { /* Preview remains usable when original metadata is unavailable. */ }
}, { immediate: true });

onMounted(() => {
  void loadModels().catch(error => { if (!disposed) showNodeError(error, translate("模型读取失败")); });
  void recoverGeneration().catch(error => { if (!disposed) showNodeError(error, translate("图片取回失败")); });
});
watch(() => data.value.taskRequestId, requestId => {
  if (requestId && !disposed && !deleting.value && !generating.value) void recoverGeneration().catch(error => { if (!disposed) showNodeError(error, translate("图片取回失败")); });
}, { flush: "post" });
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
  if (imageEstimateTimer !== undefined) window.clearTimeout(imageEstimateTimer);
  imageEstimateController?.abort();
});

function formatCredits(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(4).replace(/\.?0+$/, "") : "—";
}

function scheduleImageEstimate() {
  const sequence = ++imageEstimateSequence;
  if (imageEstimateTimer !== undefined) window.clearTimeout(imageEstimateTimer);
  imageEstimateController?.abort();
  imageEstimateController = undefined;
  imageEstimate.value = null;
  imageEstimateError.value = "";
  if (!autoEstimateVisible.value || (!generationPrompt.value && !data.value.layerDecomposition)) return;
  imageEstimateTimer = window.setTimeout(() => {
    if (autoEstimateVisible.value) void refreshImageEstimate(sequence);
  }, 220);
}

async function refreshImageEstimate(sequence: number, signal?: AbortSignal) {
  const choice = selectedModel.value;
  if (!choice || disposed || sequence !== imageEstimateSequence) return;
  const inpaintEditor = editor.value?.mode === "inpaint" ? editor.value : undefined;
  let edit;
  try { edit = inpaintEditor?.buildEdit(); } catch { return; }
  const source = outputFile.value;
  const images = inpaintEditor && source
    ? [{ path: source.url, mimeType: source.mimeType }]
    : refList.value.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
  const controller = new AbortController();
  imageEstimateController = controller;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const result = await ai.estimateImage({
      providerId: choice.providerId,
      modelId: choice.modelId,
      prompt: generationPrompt.value,
      outputDirectory: "assets/" + id,
      images,
      referenceRoles: imageRolePayload.value,
      size: data.value.size,
      ratio: data.value.ratio,
      format: data.value.format || undefined,
      background: inpaintEditor ? "opaque" : data.value.background || undefined,
      quality: data.value.quality || undefined,
      inputFidelity: data.value.inputFidelity || undefined,
      count: inpaintEditor ? 1 : data.value.count,
      layerDecomposition: inpaintEditor ? false : Boolean(data.value.layerDecomposition),
      optimizePrompt: data.value.optimizePrompt || undefined,
    parameters: controlPayload(choice, "text", data.value.parameters),
      ...(edit ? { edit } : {}),
    }, controller.signal);
    if (sequence === imageEstimateSequence && !controller.signal.aborted) {
      imageEstimate.value = result;
      imageEstimateError.value = "";
    }
  } catch (error) {
    if (sequence === imageEstimateSequence && !controller.signal.aborted) {
      imageEstimate.value = null;
      imageEstimateError.value = error instanceof Error ? error.message : translate("当前素材或参数不符合模型要求");
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (imageEstimateController === controller) imageEstimateController = undefined;
  }
}

function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || imageBusy.value || disposed) return;
  if (assetFileType(file).kind !== "image") return void showNodeError(translate("请选择图片文件"), translate("图片替换失败"));
  if (!file.size) return void showNodeError(translate("图片为空或超过当前工作区允许的大小"), translate("图片替换失败"));
  // 和「拖文件进画布」、以及基础媒体节点的「替换」走同一条通道：真上传进度的环形、
  // 失败可重试、写回 outputs 都在 useNodeUpload 里，别再退回一个没有百分比的转圈。
  // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
  beginUpload(id, file.name, file, assetFileType(file).mimeType);
}

function openPanorama() {
  if (imageBusy.value || !previewUrl.value) return;
  editor.value?.cancel();
  variationMode.value = undefined;
}

function openLighting() {
  if (imageBusy.value || !previewUrl.value) return;
  editor.value?.cancel();
  variationMode.value = "lighting";
}

function openMultiAngle() {
  if (imageBusy.value || !previewUrl.value) return;
  editor.value?.cancel();
  variationMode.value = "angle";
}

function keepSavedLocalModel(items: NodeMediaModel[]) {
  let pair: unknown;
  try { pair = JSON.parse(String(data.value.model || "")); } catch { return items; }
  if (!Array.isArray(pair) || pair.length !== 2 || (pair[0] !== "doubao-local" && pair[0] !== "dola-local") || typeof pair[1] !== "string") return items;
  if (items.some((item) => item.providerId === pair[0] && item.modelId === pair[1])) return items;
  return [...items, { providerId: pair[0], providerLabel: pair[0] === "dola-local" ? "Dola" : "豆包", modelId: pair[1], label: pair[1], type: "image" as const, mode: ["text"], imageRatios: [], ratios: [], durations: [], durationResolutionMap: [] }];
}
function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (disposed || deleting.value || (generating.value && models.value.length > 0)) return;
    models.value = keepSavedLocalModel(items.filter((item) => item.type === "image"));
    // ACT: 只给空配置选默认模型，保留暂时不可用的旧选择及其参数。
    if (!data.value.model) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
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
function refreshLiveModels() { void loadModels()?.catch(() => {}); }
onMounted(() => window.addEventListener("miao-media-models", refreshLiveModels));
onScopeDispose(() => window.removeEventListener("miao-media-models", refreshLiveModels));
watch(() => node.selected, selected => { if (selected) refreshLiveModels(); });

function recordGenerationStatus(status: string, progress?: number | null, message = "", requestId?: string) {
  generationMessage.value = message;
  if (progress !== undefined) upstreamPercent.value = progress;
  generationStatus.value = status;
  if (requestId && ["failed", "cancelled", "expired"].includes(status)) delivery.clear(requestId);
}

function applyImageResults(requestId: string, results: Awaited<ReturnType<typeof ai.generateImage>>) {
  if (!results.length) throw new Error(translate("生成服务没有返回图片"));
  delivery.apply(requestId, results);
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
    || (!pendingTask.value && (recoveryChecked || outputs.value.image?.value))) return Promise.resolve(false);
  const previousGeneration = generation;
  const previousTask = data.value.taskRequestId;
  recoveryTaskId = previousTask;
  const previousOutput = outputs.value.image;
  const previousValue = JSON.stringify(previousOutput);
  checkingTask.value = true;
  const pending = (async () => {
    const requestId = await ai.findImageTask(`assets/${id}`);
    if (disposed || deleting.value || generating.value || uploading.value || uploadingDrag.value
      || generation !== previousGeneration || data.value.taskRequestId !== previousTask
      || outputs.value.image !== previousOutput || JSON.stringify(outputs.value.image) !== previousValue) return false;
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
      const results = await ai.resumeImage(requestId, { outputDirectory: `assets/${id}`, onStatus: (status, progress, message) => recordGenerationStatus(status, progress, message, requestId), shouldCancel: () => !disposed }, controller.signal);
      controller.signal.throwIfAborted();
      applyImageResults(requestId, results);
    }).catch((error) => { if (!disposed) showNodeError(error, translate("图片取回失败")); })
      .finally(() => { if (generationController === controller) generationController = undefined; });
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
  if (generating.value) throw new Error(translate("图片正在生成，请等待完成"));
  if (uploading.value || uploadingDrag.value) throw new Error(translate("图片正在替换，请等待完成"));
  if (variationMode.value) throw new Error(translate("请先退出打光或多角度，再开始生成"));
  if (panorama.value?.visible || panorama.value?.busy) throw new Error(translate("请先关闭全景图，再开始生成"));
  const wasPending = pendingTask.value;
  const previousOutput = outputs.value.image;
  const previousValue = JSON.stringify(previousOutput);
  const recovered = await recoverGeneration();
  signal?.throwIfAborted();
  if (disposed) throw new Error(translate("画布节点已变化，请重新操作"));
  if (deleting.value) throw new Error(translate("节点正在删除"));
  if (recovered) return { status: "recovering" };
  if (wasPending) {
    if (!pendingTask.value && outputs.value.image?.value) return { status: "ready" };
    throw new Error(translate("暂未找到原任务，请稍后继续取回，或查看生成历史。"));
  }
  if (outputs.value.image !== previousOutput || JSON.stringify(outputs.value.image) !== previousValue) throw new Error(translate("画布节点已变化，请重新操作"));
  const choice = selectedModel.value;
  if (generating.value) throw new Error(translate("图片正在生成，请等待完成"));
  if (uploading.value || uploadingDrag.value) throw new Error(translate("图片正在替换，请等待完成"));
  if (deleting.value) throw new Error(translate("节点正在删除"));
  if (editor.value?.busy || editor.value?.mode === "mark") throw new Error(translate("请先完成图片标记"));
  const inpaintEditor = editor.value?.mode === "inpaint" ? editor.value : undefined;
  if (!choice) throw new Error(translate("请先选择图片模型"));
  // 重绘通道由模型能力决定：没通道的模型在界面上没有入口，这里再挡一次。
  if (inpaintEditor && !choice.regionEdit) throw new Error(translate("当前模型不支持局部重绘"));
  // 图层拆分官方允许不写提示词（自动拆主要元素）；重绘必须给重绘提示词。
  if (inpaintEditor) {
    const inpaintPromptModel = isPromptModel(data.value.inpaintPromptModel) && data.value.inpaintPromptModel.length
      ? data.value.inpaintPromptModel : [[{ type: "Write" as const, text: data.value.inpaintPrompt }]];
    assertPromptReferencesConnected(inpaintPromptModel, []);
    if (!data.value.inpaintPrompt.trim()) throw new Error(translate("请输入重绘提示词"));
    if (data.value.layerDecomposition) throw new Error(translate("局部重绘不能和图层拆分同时使用"));
  } else {
    preparePromptReferences();
    if (!generationPrompt.value && !data.value.layerDecomposition) throw new Error(translate("请输入生成提示词"));
  }
  if (!inpaintEditor && refList.value.some(item => item.value === undefined)) throw new Error(translate("引用节点暂无内容，请先补充引用内容"));
  // 服务端要求 edit 只配一张原图；重绘时用当前结果，其余引用不参与。
  const edit = inpaintEditor?.buildEdit();
  const source = outputFile.value;
  if (inpaintEditor && !source) throw new Error(translate("节点还没有可重绘的图片"));
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  recordGenerationStatus("queued");
  upstreamPercent.value = null;
  const layerDecomposition = !inpaintEditor && Boolean(data.value.layerDecomposition);
  // 官方图层拆分固定 1 张底图 + 最多 16 个透明图层；普通多图生成按张数；重绘由服务端固定 1 张。
  const maxResults = inpaintEditor ? 1 : layerDecomposition ? 17 : Math.max(1, Math.floor(Number(data.value.count) || 1));
  const extraNodeIds = Array.from({ length: maxResults - 1 }, () => crypto.randomUUID());
  let requestId = "";
  const input = {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    referenceHistory: inpaintEditor ? [{ index: 1, name: String(node.data.label || ""), kind: "IMAGE" }] : referenceHistory(),
    referenceRoles: imageRolePayload.value,
    size: data.value.size,
    ratio: data.value.ratio,
    format: data.value.format || undefined,
    background: data.value.background || undefined,
    quality: data.value.quality || undefined,
    inputFidelity: data.value.inputFidelity || undefined,
    count: inpaintEditor ? 1 : data.value.count,
    layerDecomposition,
    optimizePrompt: data.value.optimizePrompt || undefined,
    parameters: controlPayload(choice, "text", data.value.parameters),
    onStatus: (status: string, progress?: number | null, message?: string) => recordGenerationStatus(status, progress, message, requestId),
    onTask: async (value: string, existing = false) => { requestId = value; await delivery.bind(value, existing, extraNodeIds, controller.signal); },
    shouldCancel: () => !disposed,
    outputDirectory: `assets/${id}`,
    outputDirectories: [`assets/${id}`, ...extraNodeIds.map((nodeId) => `assets/${nodeId}`)],
    images: inpaintEditor && source
      ? [{ path: source.url, mimeType: source.mimeType }]
      : refList.value.flatMap((item) => (item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : [])),
    ...(edit ? { edit } : {}),
  };
  generationController = controller;
  // Explicit stop cancels; unmount detaches and the next mount resumes.
  generation = generationState.run(() => workspace
    .list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return ai.generateImage({ ...input, directory }, controller.signal);
    })
    .then((results) => {
      controller.signal.throwIfAborted();
      applyImageResults(requestId, results);
      inpaintEditor?.cancel();
    }))
    .catch((error) => { if (!disposed) showNodeError(error, translate("图片生成失败")); })
    .finally(() => {
      if (generationController === controller) generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (imageBusy.value || variationMode.value)) throw new Error(translate("图片处理中，请完成后再刷新节点"));
});
nodeEvent.on("delete", async () => {
  if (uploading.value || uploadingDrag.value || variationMode.value || lighting.value?.generating || multiAngle.value?.generating
    || panorama.value?.busy || (editor.value?.busy && !generating.value)) throw new Error(translate("图片处理中，请稍后删除节点"));
  deleting.value = true;
  generationController?.abort();
  try {
    await generation;
    if (pendingTask.value) throw new Error(translate("原任务尚未结束，请先继续取回或确认取消后再删除节点。"));
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  if (image.src === previewUrl.value) imageDimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
  imageWidth.value = (360 * image.naturalWidth) / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

async function getConfigWithEstimate(signal?: AbortSignal) {
  // Flush model normalization and quote invalidation before reading the configured price.
  await nextTick();
  signal?.throwIfAborted();
  if (imageEstimateTimer !== undefined) window.clearTimeout(imageEstimateTimer);
  imageEstimateTimer = undefined;
  imageEstimateController?.abort();
  const sequence = ++imageEstimateSequence;
  imageEstimate.value = null;
  await refreshImageEstimate(sequence, signal);
  signal?.throwIfAborted();
  return getConfig();
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      size: data.value.size,
      ratio: data.value.ratio,
      format: data.value.format, background: data.value.background, quality: data.value.quality, inputFidelity: data.value.inputFidelity,
      count: data.value.count, layerDecomposition: data.value.layerDecomposition, optimizePrompt: data.value.optimizePrompt,
    },
    models: models.value,
    estimate: imageEstimate.value ? { points: imageEstimate.value.points, source: imageEstimate.value.source || "server" } : null,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此图片生成节点的当前模型、分辨率、比例及可选图片模型能力，等待当前参数的积分报价后返回，报价失败为 null；不含密钥；分辨率和比例只使用模型目录列出的值",
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
  description: "修改此图片生成节点的模型、分辨率、比例、输出格式、背景、质量、输入保真度、张数、图层拆分或提示词优化；先用 getConfig 查询可选能力，providerId 与 modelId 必须同时提供；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
    format: z.string().min(1).optional(), background: z.enum(['opaque', 'transparent']).optional(), quality: z.string().optional(), inputFidelity: z.string().optional(),
    count: z.number().int().min(1).max(17).optional(), layerDecomposition: z.boolean().optional(), optimizePrompt: z.string().optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error(translate("节点正在生成或删除，请稍后修改配置"));
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error(translate("节点正在生成或删除，请稍后修改配置"));
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
    const sizes = choice.imageSizes || [];
    const ratios = choice.imageRatios || [];
    if (args.size !== undefined && !sizes.includes(args.size) && !fitsCustomSize(choice.sizeRule, args.size)) throw new Error(sizes.length ? `当前模型不支持分辨率 ${args.size}，可选：${sizes.join("、")}` : "当前模型没有列出可选分辨率");
    if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(ratios.length ? `当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}` : "当前模型没有列出可选比例");

    for (const [field, values] of [['format', choice.formats || []], ['quality', ['', ...(choice.quality || [])]], ['inputFidelity', ['', ...(choice.inputFidelity || [])]], ['optimizePrompt', ['', ...(choice.optimizePromptModes || [])]]] as const) {
      if (args[field] !== undefined && !values.includes(args[field])) throw new Error(`当前模型不支持 ${field}=${args[field]}`);
    }
    if (args.count !== undefined && args.count > (choice.maxCount || 1)) throw new Error('生成张数超过当前模型上限');
    if (args.background === 'transparent' && !choice.supportsTransparent) throw new Error('当前模型不支持透明背景');
    if (args.layerDecomposition && (!choice.supportsLayerDecomposition || refList.value.filter(item => item.dataType === 'IMAGE').length !== 1)) throw new Error('图层拆分需要支持该能力的模型和一张参考图片');
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.size !== undefined) data.value.size = args.size;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    // Most image models encode the ratio in `size` (only Grok keeps them independent),
    // so keep the pair consistent like the settings panel does, preferring the same tier.
    const sizeMeta = (choice.sizes || []) as { value: string; ratio?: string; label?: string }[];
    if (sizeMeta.some(item => item.ratio)) {
      if (args.size !== undefined) {
        const mapped = sizeMeta.find(item => item.value === args.size)?.ratio;
        if (mapped) data.value.ratio = mapped;
      } else if (args.ratio !== undefined) {
        const current = sizeMeta.find(item => item.value === data.value.size);
        const target = sizeMeta.find(item => item.ratio === args.ratio && item.label === current?.label) ?? sizeMeta.find(item => item.ratio === args.ratio);
        if (target && sizes.includes(target.value)) data.value.size = target.value;
      }
    }
    for (const field of ['format', 'background', 'quality', 'inputFidelity', 'count', 'layerDecomposition', 'optimizePrompt'] as const) {
      if (args[field] !== undefined) Reflect.set(data.value, field, args[field]);
    }
    // Same official limits the model watcher applies: transparency needs png, layer decomposition 1K–2K/auto.
    if (data.value.background === "transparent" && args.format === undefined && data.value.format !== "png" && (choice.formats || []).includes("png")) data.value.format = "png";
    const layerSizes = choice.layerSizes || [];
    if (data.value.layerDecomposition && layerSizes.length && !layerSizes.includes(data.value.size || "")) data.value.size = layerSizes.includes("1.5K") ? "1.5K" : layerSizes[0]!;
    return await getConfigWithEstimate(signal);
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的图片提示词，支持 {{ref 1}} 等参考标记；target=generate 修改普通生图提示词，target=inpaint 修改局部重绘提示词；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string(), target: z.enum(["generate", "inpaint"]).default("generate") }),
  execute({ prompt: value, target }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    if (target === "inpaint") {
      data.value.inpaintPrompt = value;
      data.value.inpaintPromptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    } else {
      data.value.prompt = value;
      data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    }
    return { prompt: value, target };
  },
});

nodeTools.register({
  name: "generateImage",
  description: "启动此节点的后台图片生成；节点尚无输出时先核对本节点原任务，查询失败不提交新请求；找到原任务或仍有待取回任务时，只取回原结果，不重新下单。新生成使用当前提示词、模型、分辨率、比例和参考图片；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 请求停止",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration(signal);
  },
});

// "+ 参考" picks local media; the canvas imports it and wires it into this node.
function requestReference() {
  selectComposerNode();
  window.dispatchEvent(new CustomEvent("miao-canvas-add-reference", { detail: { nodeId: id } }));
}
function selectComposerNode() {
  if (documentContext?.targets.has(id)) return;
  removeSelectedElements();
  addSelectedNodes([node]);
}
async function focusPrompt() {
  selectComposerNode();
  await nextTick();
  document.querySelector<HTMLElement>(`.vue-flow__node[data-id="${CSS.escape(id)}"] .promptInput [contenteditable="true"]`)?.focus();
}
</script>

<style scoped lang="scss">
.imageContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .imageEmpty {
    align-content: center;
    gap: 18px;
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.localRatio {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;

  :deep(.el-radio-group) {
    display: flex;
    flex-wrap: wrap;
  }
}

.promptCard {
  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    flex-wrap: wrap;
    gap: 4px;

    .modelSelect {
      width: 172px;
      margin-right: 4px;
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
      color: var(--el-text-color-secondary);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
  }

  .srOnly {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
}
</style>
