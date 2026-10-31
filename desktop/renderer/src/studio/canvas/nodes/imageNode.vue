<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :mediaMeta="mediaMeta"
    :mediaMetaTitle="mediaMetaTitle"
    :topVisible="node.selected"
    :bottomVisible="node.selected && (!!variationMode || editor?.mode === 'inpaint' || preparedOutpaint.active && !editor?.mode)"
    topWidth="max-content"
    :bottomWidth="660"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :mediaFrameHeight="imageWidth ? 360 : undefined"
    :style="{ width: imageWidth ? `${imageWidth + 2}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <imageIntentMenu v-if="previewUrl" :controller="imageIntents" :disabled="imageOutpaint.busy || imageOutpaint.state.visible || imageGeometry.state.visible || imageGeometry.busy || imageBusy || gridSplit?.splitting" />
      <imageGeometryMenu v-if="previewUrl" :controller="imageGeometry" :disabled="imageOutpaint.busy || imageOutpaint.state.visible || imageBusy || imageIntents.busy || imageIntents.state.visible" />
      <imageOutpaintMenu v-if="previewUrl" :controller="imageOutpaint" :disabled="imageBusy || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible" />
      <el-button v-if="layerEntryAvailable" :icon="IconLayersSubtract" text :loading="creatingLayerEntry" :disabled="imageBusy || gridSplit?.splitting" :title="translate('图层分离')" :aria-label="translate('图层分离')" @click.stop="createLayerEntry">{{ translate('图层分离') }}</el-button>
      <el-button v-if="generating || pendingInpaint" :icon="generating ? IconPlayerStop : IconPlayerPlay" text :title="generating ? translate('停止生成') : translate('继续取回')" :aria-label="generating ? translate('停止生成') : translate('继续取回')" @click="generating ? inpaintTask.stop() : resumeInpaint()">{{ generating ? translate('停止生成') : translate('继续取回') }}</el-button>
      <el-button v-if="previewUrl" :icon="IconSun" text :disabled="!previewUrl || imageBusy" :title="translate('打光')" :aria-label="translate('打光')" @click.stop="variationMode = variationMode === 'lighting' ? undefined : 'lighting'; editor?.cancel()" />
      <el-button v-if="previewUrl" :icon="IconCamera" text :disabled="!previewUrl || imageBusy" :title="translate('多角度')" :aria-label="translate('多角度')" @click.stop="variationMode = variationMode === 'angle' ? undefined : 'angle'; editor?.cancel()" />
      <el-button v-if="previewUrl" :icon="IconPanoramaHorizontal" text :disabled="!previewUrl || imageBusy" :title="translate('720度全景图')" :aria-label="translate('720度全景图')" @click.stop="panorama?.open($event)" />
      <el-button v-if="previewUrl"
        :icon="IconBrush"
        :disabled="imageBusy || !previewUrl || gridSplit?.splitting"
        text
        :title="translate('重绘')"
        :aria-label="translate('重绘')"
        @click.stop="editor?.start('inpaint')" />
      <el-button v-if="previewUrl"
        :icon="IconLayoutGrid"
        :disabled="imageBusy || !previewUrl"
        :loading="gridSplit?.splitting"
        text
        :title="translate('宫格切分')"
        :aria-label="translate('宫格切分')"
        @click.stop="gridSplit?.open($event)" />
      <imagePresetMenu v-if="previewUrl" ref="presetMenu" :disabled="imageBusy || !previewUrl" :loadModels="() => ai.getMediaModels()" />
      <el-button v-if="previewUrl"
        :icon="IconPencil"
        :disabled="imageBusy || !previewUrl || gridSplit?.splitting"
        text
        :title="translate('标注')"
        :aria-label="translate('标注')"
        @click.stop="editor?.start('mark')" />
      <el-button
        :icon="IconTransfer"
        :loading="uploading || uploadingDrag"
        :disabled="imageBusy"
        text
        :title="translate('替换图片')"
        :aria-label="translate('替换图片')"
        @click.stop="fileInput?.click()" />
    </template>
    <div class="imageContent nopan" :style="imageWidth ? { aspectRatio: `${imageWidth} / 360` } : undefined">
      <div v-if="outputFile" class="mediaFramePlaceholder" aria-hidden="true" />
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :toolbarTarget="paintToolbar"
        :regionEdit="inpaintRegionEdit"
        :disabled="imageBusy"
        :alt="translate('节点图片')"
        @load="resizeImage"
        @error="ElMessage.error(translate('无法预览该图片'))" />
      <input ref="fileInput" class="fileInput" type="file" accept="image/*" :aria-label="translate('选择图片')" :disabled="imageBusy" @change="uploadImage" />
      <nodeEmptyState v-if="!outputFile" v-loading="uploading" :icon="IconPhoto" :label="translate('暂无图片')" :hints="emptyHints" :disabled="imageBusy" @pick="pickHint" />
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
      <generationProgress :progress="inpaintTask.progress" :label="translate('图片生成进度')" />
    </div>
    <template #bottom><div v-if="variationMode" ref="variationTarget" /><div v-else-if="editor?.mode === 'inpaint'" ref="inpaintTarget" /><div v-else-if="preparedOutpaint.active && !editor?.mode" ref="outpaintTarget" /></template>
  </nodeSkeleton>
  <imageInpaintPrompt
    v-if="editor?.mode === 'inpaint'"
    ref="inpaintPrompt"
    v-model:regionEdit="inpaintRegionEdit"
    :target="inpaintTarget"
    :generate="generateInpaint"
    :generating="generating"
    :pending="pendingInpaint"
    :cancel="inpaintTask.stop"
    :disabled="uploading || uploadingDrag" />
  <imageOutpaintPreparedPanel
    v-if="preparedOutpaint.active && !editor?.mode && !variationMode"
    ref="preparedPanel"
    :controller="preparedOutpaint"
    :target="outpaintTarget"
    :generate="generateInpaint"
    :generating="generating"
    :pending="pendingInpaint"
    :cancel="inpaintTask.stop"
    :disabled="uploading || uploadingDrag" />
  <imageLighting v-if="variationMode === 'lighting'" :src="previewUrl" :source="outputFile" :target="variationTarget" :disabled="imageBusy" @close="variationMode = undefined" />
  <imageMultiAngle v-if="variationMode === 'angle'" :src="previewUrl" :source="outputFile" :target="variationTarget" :disabled="imageBusy" @close="variationMode = undefined" />
  <imagePanorama ref="panorama" :src="previewUrl" :source="outputFile" :disabled="imageBusy" @open="variationMode = undefined; editor?.cancel()" />
  <imageGridSplit ref="gridSplit" :src="previewUrl" :source="outputFile" :disabled="imageBusy" :active="node.selected" />
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { useImagePreviewTools } from '../scaffold/useImagePreviewTools';
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { IconPhoto, IconPhotoAi, IconVideo, IconClipboard, IconUpload, IconTransfer, IconLayoutGrid, IconBrush, IconPencil, IconSun, IconCamera, IconPanoramaHorizontal, IconPlayerStop, IconPlayerPlay, IconLayersSubtract } from "@tabler/icons-vue";
import { ElButton, ElImageViewer, ElMessage } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, useNodeUpload, z, type NodeHandle, type NodeInpaintInput } from "@miaoimg/nodes-scaffold/runtime";
import imageEditor from "@miaoimg/nodes-scaffold/imageEditor";
import imageInpaintPrompt from "@miaoimg/nodes-scaffold/imageInpaintPrompt";
import imageGridSplit from "@miaoimg/nodes-scaffold/imageGridSplit";
import generationProgress from "@miaoimg/nodes-scaffold/generationProgress";
import { useInpaintTask } from "./imageTools/useInpaintTask";
import { translate } from "@miaoimg/i18n/vue";
import { useImageTools } from "./imageTools/useImageTools";
import { useImageLayerEntry } from "./imageTools/useImageLayerEntry";
import { useImageIntentActions } from "./imageTools/useImageIntentActions";
import imageIntentMenu from "./imageTools/components/imageIntentMenu.vue";
import { useImageGeometryActions } from "./imageTools/useImageGeometryActions";
import imageGeometryMenu from "./imageTools/components/imageGeometryMenu.vue";
import { usePreparedOutpaint } from "./imageTools/usePreparedOutpaint";
import imageOutpaintPreparedPanel from "./imageTools/components/imageOutpaintPreparedPanel.vue";
import { useImageOutpaintActions } from "./imageTools/useImageOutpaintActions";
import imageOutpaintMenu from "./imageTools/components/imageOutpaintMenu.vue";
import { useImagePaletteActions, combineCanvasToolExtensions } from "../useMediaPaletteActions";
import { useNodeToolsContext } from "../scaffold/nodeTools";
import imageLighting from './imageTools/components/imageLighting.vue';
import imageMultiAngle from './imageTools/components/imageMultiAngle.vue';
import imagePanorama from './imageTools/components/imagePanorama.vue';
import imagePresetMenu from './imageTools/components/imagePresetMenu.vue';
import uploadProgress from "../components/uploadProgress.vue";
import nodeEmptyState, { type EmptyHint } from "../components/nodeEmptyState.vue";
import { useLinkedNode } from "../linkedNode";
import { readClipboardFiles } from "@/lib/clipboard";
import { beginUpload } from "../uploadStatus";
import { mediaSizeLabel } from "../../../../../../server/media-size-label";
import { assetFileType } from "../assetFile";
import { useMediaTaskDelivery } from "../scaffold/useMediaTaskDelivery";
import { useMediaPublication } from "../scaffold/mediaPublication";
import { commitImageFrame, imageMediaWidth, layoutAspect, pixelsFromNodeData, watchImageFrame } from "../scaffold/mediaFrame";

defineOptions({
  inheritAttrs: false,
  icon: IconPhoto,
  handles: [{ id: "in", type: "target", dataType: "IMAGE", label: "来源图片" }, { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" }] satisfies NodeHandle[],
});
const { id, node, nodeProps, outputs, nodeEvent, files, ai, updateNodeInternals } = useNode({
  label: "图片",
});
const captureMediaPublication = useMediaPublication(() => outputs.value);
const fileInput = ref<HTMLInputElement>();
const variationMode = ref<'lighting' | 'angle'>();
const variationTarget = ref<HTMLElement>();
const panorama = ref<InstanceType<typeof imagePanorama>>();
const presetMenu = ref<InstanceType<typeof imagePresetMenu>>();
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const inpaintPrompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const paintToolbar = ref<HTMLElement>();
const inpaintTarget = ref<HTMLElement>();
const outpaintTarget = ref<HTMLElement>();
const preparedPanel = ref<InstanceType<typeof imageOutpaintPreparedPanel>>();
const inpaintRegionEdit = ref<"mask" | "annotation" | null>(null);
const uploading = ref(false);
const previewVisible = ref(false);
useImagePreviewTools(previewVisible, () => !!previewUrl.value);
const storedImage = pixelsFromNodeData(node.data);
const storedLayout = layoutAspect(node.data);
const imageWidth = ref(storedLayout ? imageMediaWidth(storedLayout.width, storedLayout.height) : 0);
const imageDimensions = ref<{ width: number; height: number } | undefined>(storedImage);
const mediaMeta = computed(() => imageDimensions.value ? mediaSizeLabel(`${imageDimensions.value.width}x${imageDimensions.value.height}`) : "");
const mediaMetaTitle = computed(() => imageDimensions.value ? `${imageDimensions.value.width} × ${imageDimensions.value.height}` : "");

// 画布拖入的文件先建出这个节点，上传由节点自己跑：环形进度就画在本节点的预览框里。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  if (generating.value || pendingInpaint.value) throw new Error(translate("图片处理中，请稍后重试"));
  outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType } };
}, () => outputs.value);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const inpaintData = computed(() => node.data as { taskRequestId?: string; mediaPixels?: { width: number; height: number } });
const delivery = useMediaTaskDelivery(node, outputs, "image");
const preparedOutpaint = usePreparedOutpaint({ node, outputs, files, loadModels: () => ai.getMediaModels(true) });
const inpaintTask = useInpaintTask({ nodeId: id, data: inpaintData, outputs, ai, delivery, prepare: prepareInpaint, applied: () => editor.value?.cancel() });
const { generating, pending: pendingInpaint } = inpaintTask;
const imageBusy = computed(() => uploading.value || uploadingDrag.value || generating.value || pendingInpaint.value);
const { available: layerEntryAvailable, creating: creatingLayerEntry, create: createLayerEntry } = useImageLayerEntry({
  node, hasImage: () => Boolean(outputFile.value), disabled: () => imageBusy.value || Boolean(gridSplit.value?.splitting),
  loadModels: () => ai.getMediaModels(), onError: error => showError(error, translate("新建节点失败")),
});
const getImageNodeTools = useNodeToolsContext();
const imageIntents = useImageIntentActions({
  node, hasImage: () => Boolean(outputFile.value?.url),
  disabled: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  loadModels: () => ai.getMediaModels(true), onError: error => showError(error, translate("新建节点失败")),
  async prepareErase(input, signal) {
    if (!editor.value) throw new Error(translate("图片编辑器尚未就绪，请确认原图已加载"));
    variationMode.value = undefined;
    await editor.value.start("inpaint"); await nextTick(); signal.throwIfAborted();
    await getImageNodeTools().call({ nodeId: id, name: "node:setInpaintConfig", args: input }, signal);
  },
});
const imageGeometry = useImageGeometryActions({
  node, disabled: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageIntents.busy || imageIntents.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  onError: error => showError(error, translate("图片处理失败")),
});
const imageOutpaint = useImageOutpaintActions({
  node, disabled: () => imageBusy.value || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  loadModels: () => ai.getMediaModels(true), onError: error => showError(error, translate("新建节点失败")),
});
useImagePaletteActions({
  node, hasImage: () => Boolean(outputFile.value?.url),
  busy: () => imageBusy.value || imageOutpaint.busy || imageOutpaint.state.visible || imageIntents.busy || imageIntents.state.visible || imageGeometry.busy || imageGeometry.state.visible || Boolean(gridSplit.value?.splitting || editor.value?.busy || panorama.value?.busy || creatingLayerEntry.value),
  inpaintAllowed: () => true,
  ready: tool => ["image:lighting", "image:angle", "image:layers"].includes(tool) ? true
    : tool === "image:mark" || tool === "image:inpaint" ? Boolean(editor.value)
      : tool === "image:grid" ? Boolean(gridSplit.value) : tool.startsWith("image:preset:") ? Boolean(presetMenu.value) : Boolean(panorama.value),
  lighting: () => { variationMode.value = "lighting"; editor.value?.cancel(); },
  angle: () => { variationMode.value = "angle"; editor.value?.cancel(); },
  mark: () => editor.value?.start("mark"), inpaint: () => editor.value?.start("inpaint"),
  grid: event => gridSplit.value?.open(event), panorama: command => panorama.value?.selectAction(command),
  layers: createLayerEntry, preset: preset => presetMenu.value?.apply(preset), extension: combineCanvasToolExtensions(imageIntents.extension, imageGeometry.extension, imageOutpaint.extension),
});
let disposed = false;
onScopeDispose(() => { disposed = true; });
onMounted(() => { if (inpaintData.value.taskRequestId) void resumeInpaint(); });
watch(() => inpaintData.value.taskRequestId, requestId => {
  if (requestId && !disposed && !generating.value) void resumeInpaint();
}, { flush: "post" });
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, translate("图片读取失败"))
);
watchImageFrame(
  () => outputFile.value?.url,
  imageWidth,
  node.data,
  (path, signal) => files.getWorkspaceFiles().readImageSize?.(path, signal),
);
// Preview dimensions only control layout; the quality label belongs to the original.
watch([() => outputFile.value?.url, previewUrl, () => node.selected], async ([path, source, selected], previous, onCleanup) => {
  if (path !== previous?.[0] || source !== previous?.[1]) imageDimensions.value = undefined;
  if (!path || !source || !selected || imageDimensions.value) return;
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  try {
    const size = await files.getWorkspaceFiles().readImageSize?.(path, controller.signal);
    if (!controller.signal.aborted && size) imageDimensions.value = size;
  } catch { /* Keep the preview usable if the original is unavailable. */ }
}, { immediate: true });

useImageTools(() => !!outputFile.value && !imageBusy.value);

nodeEvent.on("save", (reason) => {
  if (uploading.value || uploadingDrag.value || editor.value?.busy || reason === "reload" && generating.value) throw new Error(translate("图片处理中，请完成后再切换或刷新节点"));
});
nodeEvent.on("copy", () => ({ taskRequestId: undefined, taskOutputPath: undefined, taskExtraNodeIds: undefined }));
nodeEvent.on("delete", async () => {
  if (uploading.value || uploadingDrag.value || editor.value?.busy) throw new Error(translate("图片处理中，请稍后删除节点"));
  uploading.value = true;
  inpaintTask.stop();
  try {
    await inpaintTask.wait();
    if (pendingInpaint.value) throw new Error(translate("原任务尚未结束，请先继续取回或确认取消后再删除节点。"));
    await files.removeNodeFiles();
  } finally {
    uploading.value = false;
  }
});

// 局部重绘用当前这张图当原图，按所选模型的通道参数（蒙版或标注）提交；
// 结果写回本节点自己的目录，和普通生成的落盘方式一致。
async function prepareInpaint(input: NodeInpaintInput, signal: AbortSignal) {
  if (preparedOutpaint.active && !editor.value?.mode && !variationMode.value) return preparedOutpaint.prepare(input, signal);
  const instance = editor.value;
  const source = outputFile.value;
  if (!instance || !source) throw new Error(translate("请先进入局部重绘"));
  const edit = instance.buildEdit();
  const { directory } = await files.getWorkspaceFiles().list();
  signal.throwIfAborted();
  return {
    ...input,
    directory,
    outputDirectory: `assets/${id}`,
    images: [{ path: source.url, mimeType: source.mimeType }],
    edit,
  };
}

function generateInpaint(input?: NodeInpaintInput, signal?: AbortSignal) {
  if (uploading.value || uploadingDrag.value) throw new Error(translate("图片处理中，请稍后重试"));
  return inpaintTask.run(input, signal);
}

async function resumeInpaint() {
  try { await generateInpaint(); }
  catch (error) { if (!disposed && !pendingInpaint.value && (error as Error)?.name !== "AbortError") showError(error, translate("图片取回失败")); }
}

nodeTools.register({
  name: "generateInpaint", description: "启动当前已配置的后台局部重绘，写回本图片节点；若有未结束任务，只继续取回原编号，不再生成，也不要求重新选择模型或绘制选区。返回 generating/recovering 表示本机已开始处理或取回，不代表上游已接纳或生成完成；通过 getGenerationStatus 查询结果，cancelInpaint 请求停止。新生成会真实调用图片模型，须先取得用户授权。", parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    return inpaintTask.start(() => {
      if (pendingInpaint.value) return generateInpaint(undefined, signal);
      if (preparedOutpaint.active && !editor.value?.mode && !variationMode.value) {
        if (!preparedPanel.value) throw new Error(translate("资源尚未就绪，请稍后重试"));
        return preparedPanel.value.startGeneration(signal, true);
      }
      if (!inpaintPrompt.value) throw new Error(translate("请先进入局部重绘"));
      return inpaintPrompt.value.startGeneration(signal, true);
    });
  },
});
nodeTools.register({
  name: "cancelInpaint", description: "请求停止本节点进行中的局部重绘；取消是否成功以 getGenerationStatus 回执为准，未确认时保留原编号供继续取回，不删除已有图片。", parameters: z.strictObject({}),
  execute() { const cancellationRequested = generating.value; inpaintTask.stop(); return { cancellationRequested }; },
});

nodeTools.register({
  name: "setImage",
  description: "选择工作区图片作为此节点输出。普通素材保存内部副本，已有内部原片直接共享；返回实际保存路径，素材库后续整理不影响此节点。",
  parameters: z.strictObject({
    path: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/).optional().describe('通常从文件元信息识别；文件未声明类型时可补充'),
  }),
  async execute({ path, mimeType }, { signal }) {
    signal?.throwIfAborted();
    if (imageBusy.value) throw new Error("图片处理中，请稍后重试");
    const checkPublication = captureMediaPublication();
    uploading.value = true;
    try {
      const value = await files.retainMedia(path, 'image', signal, mimeType);
      checkPublication(signal, value.url);
      outputs.value.image = { dataType: "IMAGE", value };
      return outputs.value.image;
    } finally {
      uploading.value = false;
    }
  },
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  if (image.src === previewUrl.value) imageDimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
  if (!commitImageFrame(imageWidth, node.data, image.naturalWidth, image.naturalHeight)) return;
  await nextTick();
  updateNodeInternals();
}

const { canLink, createLinked } = useLinkedNode();
const emptyHints = computed<EmptyHint[]>(() => [
  { key: "upload", label: "上传本地图片", icon: IconUpload },
  { key: "paste", label: "粘贴剪贴板里的图片", icon: IconClipboard },
  ...(canLink(node, "remote-imageGenerationNode") ? [{ key: "image", label: "图生图", icon: IconPhotoAi }] : []),
  ...(canLink(node, "remote-videoGenerationNode") ? [{ key: "video", label: "图生视频", icon: IconVideo }] : []),
]);
async function pickHint(key: string) {
  if (key === "upload") return fileInput.value?.click();
  if (key === "image") return void createLinked(node, "remote-imageGenerationNode", "图片生成");
  if (key === "video") return void createLinked(node, "remote-videoGenerationNode", "视频生成");
  const file = (await readClipboardFiles().catch(() => [])).find(item => assetFileType(item).kind === "image");
  if (!file) return void ElMessage.warning(translate("剪贴板里没有图片"));
  takeImage(file);
}

function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) takeImage(file);
}

function takeImage(file: File) {
  if (imageBusy.value) return;
  if (assetFileType(file).kind !== "image") return void ElMessage.error(translate("请选择图片文件"));
  if (!file.size) return void ElMessage.error(translate("图片为空或超过当前工作区允许的大小"));
  // 和「拖文件进画布」走同一条通道：真上传进度的环形、失败可重试、写回 outputs 都由
  // useNodeUpload 统一处理。
  // ACT: 复制节点可能仍引用旧图片，替换输出不删除共享文件。
  beginUpload(id, file.name, file, assetFileType(file).mimeType);
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
</script>

<style scoped lang="scss">
.imageContent {
  position: relative;
  min-height: 144px;
  overflow: hidden;
  border-radius: inherit;
  background: var(--canvas-node, var(--el-bg-color-overlay));
}
.mediaFramePlaceholder {
  position: absolute;
  inset: 0;
  background: var(--canvas-node, var(--el-bg-color-overlay));
}
.imageContent :deep(.imageEditor) { position: absolute; inset: 0; width: 100%; height: 100%; }
.fileInput { display: none; }
</style>
