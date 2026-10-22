<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    :bottomVisible="node.selected && (!!variationMode || editor?.mode === 'inpaint')"
    topWidth="max-content"
    :bottomWidth="660"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 2}px` : undefined }">
    <template v-if="editor?.mode" #top><div ref="paintToolbar" /></template>
    <template #topActions>
      <el-button v-if="generating || pendingInpaint" :icon="generating ? IconPlayerStop : IconPlayerPlay" text :title="generating ? translate('停止生成') : translate('继续取回')" :aria-label="generating ? translate('停止生成') : translate('继续取回')" @click="generating ? inpaintTask.stop() : resumeInpaint()">{{ generating ? translate('停止生成') : translate('继续取回') }}</el-button>
      <el-button :icon="IconSun" text :disabled="!previewUrl || imageBusy" :title="translate('图片打光')" :aria-label="translate('图片打光')" @click.stop="variationMode = variationMode === 'lighting' ? undefined : 'lighting'; editor?.cancel()" />
      <el-button :icon="IconCamera" text :disabled="!previewUrl || imageBusy" :title="translate('多角度')" :aria-label="translate('多角度')" @click.stop="variationMode = variationMode === 'angle' ? undefined : 'angle'; editor?.cancel()" />
      <el-button :icon="IconPanoramaHorizontal" text :disabled="!previewUrl || imageBusy" :title="translate('全景')" :aria-label="translate('全景')" @click.stop="panorama?.open($event)" />
      <el-button
        :icon="IconBrush"
        :disabled="imageBusy || !previewUrl || gridSplit?.splitting"
        text
        :title="translate('局部重绘')"
        :aria-label="translate('局部重绘')"
        @click.stop="editor?.start('inpaint')" />
      <el-button
        :icon="IconLayoutGrid"
        :disabled="imageBusy || !previewUrl"
        :loading="gridSplit?.splitting"
        text
        :title="translate('宫格切分')"
        :aria-label="translate('宫格切分')"
        @click.stop="gridSplit?.open($event)" />
      <el-button
        :icon="IconPencil"
        :disabled="imageBusy || !previewUrl || gridSplit?.splitting"
        text
        :title="translate('标记')"
        :aria-label="translate('标记')"
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
    <div class="imageContent nopan">
      <imageEditor
        v-if="previewUrl"
        ref="editor"
        :src="previewUrl"
        :previewSrc="displayPreviewUrl"
        :toolbarTarget="paintToolbar"
        :regionEdit="inpaintRegionEdit"
        :disabled="imageBusy"
        :alt="translate('节点图片')"
        @load="resizeImage"
        @error="ElMessage.error(translate('无法预览该图片'))" />
      <input ref="fileInput" class="fileInput" type="file" accept="image/*" :aria-label="translate('选择图片')" :disabled="imageBusy" @change="uploadImage" />
      <el-button
        v-if="!outputFile"
        class="uploadButton"
        text
        :loading="uploading"
        :title="translate('上传图片')"
        :aria-label="translate('上传图片')"
        @dblclick.stop
        @click="fileInput?.click()">
        <icon-upload v-if="!uploading" :size="48" stroke="1.5" />
      </el-button>
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
      <generationProgress :progress="inpaintTask.progress" :label="translate('图片生成进度')" />
    </div>
    <template #bottom><div v-if="variationMode" ref="variationTarget" /><div v-else-if="editor?.mode === 'inpaint'" ref="inpaintTarget" /></template>
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
import { IconPhoto, IconUpload, IconTransfer, IconLayoutGrid, IconBrush, IconPencil, IconSun, IconCamera, IconPanoramaHorizontal, IconPlayerStop, IconPlayerPlay } from "@tabler/icons-vue";
import { ElButton, ElImageViewer, ElMessage } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, useNodeUpload, z, type NodeHandle, type NodeInpaintInput } from "@miaoimg/nodes-scaffold/runtime";
import imageEditor from "@miaoimg/nodes-scaffold/imageEditor";
import imageInpaintPrompt from "@miaoimg/nodes-scaffold/imageInpaintPrompt";
import imageGridSplit from "@miaoimg/nodes-scaffold/imageGridSplit";
import generationProgress from "@miaoimg/nodes-scaffold/generationProgress";
import { useInpaintTask } from "./imageTools/useInpaintTask";
import { translate } from "@miaoimg/i18n/vue";
import { useImageTools } from "./imageTools/useImageTools";
import imageLighting from './imageTools/components/imageLighting.vue';
import imageMultiAngle from './imageTools/components/imageMultiAngle.vue';
import imagePanorama from './imageTools/components/imagePanorama.vue';
import uploadProgress from "../components/uploadProgress.vue";
import { beginUpload } from "../uploadStatus";
import { assetFileType, ASSET_MAX_BYTES } from "../assetFile";
import { useMediaTaskDelivery } from "../scaffold/useMediaTaskDelivery";
import { useMediaPublication } from "../scaffold/mediaPublication";

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
const gridSplit = ref<InstanceType<typeof imageGridSplit>>();
const editor = ref<InstanceType<typeof imageEditor>>();
const inpaintPrompt = ref<InstanceType<typeof imageInpaintPrompt>>();
const paintToolbar = ref<HTMLElement>();
const inpaintTarget = ref<HTMLElement>();
const inpaintRegionEdit = ref<"mask" | "annotation" | null>(null);
const uploading = ref(false);
const previewVisible = ref(false);
useImagePreviewTools(previewVisible, () => !!previewUrl.value);
const imageWidth = ref(0);

// 画布拖入的文件先建出这个节点，上传由节点自己跑：环形进度就画在本节点的预览框里。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  if (generating.value || pendingInpaint.value) throw new Error(translate("图片处理中，请稍后重试"));
  outputs.value.image = { dataType: "IMAGE", value: { url: path, mimeType } };
}, () => outputs.value);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const inpaintData = computed(() => node.data as { taskRequestId?: string });
const delivery = useMediaTaskDelivery(node, outputs, "image");
const inpaintTask = useInpaintTask({ nodeId: id, data: inpaintData, outputs, ai, delivery, prepare: prepareInpaint, applied: () => editor.value?.cancel() });
const { generating, pending: pendingInpaint } = inpaintTask;
const imageBusy = computed(() => uploading.value || uploadingDrag.value || generating.value || pendingInpaint.value);
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

const displayPreviewUrl = files.useFileUrl(outputFile, () => {}, true);

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
  // 预览高度放大到 360：文件本身按原图保存（不做压缩），但 240px 的缩小预览
  // 会让人以为画质被压了，这里让节点里的画面更接近原图观感。
  imageWidth.value = 360 * image.naturalWidth / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || imageBusy.value) return;
  if (assetFileType(file).kind !== "image") return void ElMessage.error(translate("请选择图片文件"));
  if (!file.size || file.size > ASSET_MAX_BYTES) return void ElMessage.error(translate("图片为空或超过当前工作区允许的大小"));
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
  min-height: 144px;

  .fileInput {
    display: none;
  }

  .uploadButton {
    width: 100%;
    height: 144px;
    padding: 0;
    color: var(--el-text-color-placeholder);

    &:hover {
      color: var(--el-color-primary);
    }
  }
}
</style>
