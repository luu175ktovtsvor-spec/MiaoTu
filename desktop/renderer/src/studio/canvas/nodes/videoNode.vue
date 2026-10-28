<template>
  <nodeSkeleton
    class="videoNodeShell"
    v-bind="nodeProps"
    :mediaMeta="mediaMeta"
    :mediaMetaTitle="mediaMetaTitle"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="exporting ? '' : previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth}px` : undefined }"
    @fullscreen="player?.enterFullscreen()">
    <template #topActions>
      <el-button v-for="entry in modelEntries" :key="entry.mode" :icon="entry.icon" text :disabled="!outputFile || uploading || uploadingDrag || exporting || actions?.processing || creatingEntry" :title="translate(entry.label)" :aria-label="translate(entry.label)" @click.stop="createModeNode(entry)">{{ translate(entry.label) }}</el-button>
      <el-button v-if="outputFile" :icon="IconMusic" text :disabled="!outputFile || uploading || uploadingDrag || exporting || actions?.processing" :title="translate('提取音轨')" :aria-label="translate('提取音轨')" @click.stop="actions?.open('extractAudio')">{{ translate('提取音轨') }}</el-button>
      <el-button v-if="outputFile" :icon="IconLayersSubtract" text :disabled="!outputFile || uploading || uploadingDrag || exporting || actions?.processing" :title="translate('分离音视频')" :aria-label="translate('分离音视频')" @click.stop="actions?.open('separate')">{{ translate('分离音视频') }}</el-button>
      <el-button v-if="outputFile" :icon="IconScissors" text :disabled="!outputFile || uploading || uploadingDrag || exporting || actions?.processing" :title="translate('片段截取')" :aria-label="translate('片段截取')" @click.stop="actions?.open('trim')">{{ translate('片段截取') }}</el-button>
      <el-button
        :icon="IconTransfer"
        :loading="uploading || uploadingDrag"
        :disabled="exporting || actions?.processing"
        text
        :title="translate('替换视频')"
        :aria-label="translate('替换视频')"
        @click.stop="fileInput?.click()" />
    </template>
    <div class="videoContent nopan">
      <div v-if="exporting" class="exportLoading" role="status" :aria-label="translate('视频导出中')">
        <el-progress type="circle" :percentage="exportProgress" :width="64" :strokeWidth="3" />
        <span>{{ translate('正在导出视频') }}</span>
      </div>
      <videoPlayer
        v-else-if="previewUrl"
        ref="player"
        :src="previewUrl"
        :disabled="uploading || uploadingDrag"
        @dimensions="resizeVideo" />
      <input ref="fileInput" class="fileInput" type="file" accept="video/*" :aria-label="translate('选择视频')" :disabled="uploading || exporting" @change="uploadVideo" />
      <nodeEmptyState v-if="!exporting && !outputs.video" v-loading="uploading" :icon="IconVideo" :label="translate('暂无视频')" :hints="emptyHints" :disabled="uploading || uploadingDrag" @pick="pickHint" />
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
    </div>
  </nodeSkeleton>
  <videoActions ref="actions" :file="outputFile" :src="previewUrl" :disabled="uploading || uploadingDrag || exporting" />
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { IconVideo, IconClipboard, IconUpload, IconTransfer, IconMusic, IconLayersSubtract, IconScissors, IconPencil, IconArrowAutofitRight } from "@tabler/icons-vue";
import { ElButton, ElMessage, ElProgress } from "element-plus";
import { nodeSkeleton, nodeTools, useNode, useNodeUpload, z, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import uploadProgress from "../components/uploadProgress.vue";
import nodeEmptyState, { type EmptyHint } from "../components/nodeEmptyState.vue";
import { readClipboardFiles } from "@/lib/clipboard";
import { beginUpload } from "../uploadStatus";
import { assetFileType, ASSET_MAX_BYTES } from "../assetFile";
import videoPlayer from "@miaoimg/nodes-scaffold/videoPlayer";
import videoActions from "./videoNode/videoActions.vue";
import { useMediaPublication } from "../scaffold/mediaPublication";
import { mediaExportProgress } from "../scaffold/mediaExport";
import { videoSizeLabel } from "../../../../../../server/media-size-label";
import { useLinkedNode } from "../linkedNode";

defineOptions({
  inheritAttrs: false,
  icon: IconVideo,
  handles: [{ id: "video", type: "source", dataType: "VIDEO", label: "视频输出" }] satisfies NodeHandle[],
});
const { id, node, nodeProps, outputs, nodeEvent, files, ai, updateNodeInternals } = useNode({
  label: "视频",
});
const captureMediaPublication = useMediaPublication(() => outputs.value);
const fileInput = ref<HTMLInputElement>();
const uploading = ref(false);
const player = ref<InstanceType<typeof videoPlayer>>();
const actions = ref<InstanceType<typeof videoActions>>();
const exportProgress = computed(() => mediaExportProgress(node));
const exporting = computed(() => typeof exportProgress.value === "number");
const videoWidth = ref(0);
const videoDimensions = ref<{ width: number; height: number }>();
const mediaMeta = computed(() => videoDimensions.value ? videoSizeLabel(videoDimensions.value.width, videoDimensions.value.height) : "");
const mediaMetaTitle = computed(() => videoDimensions.value ? `${videoDimensions.value.width} × ${videoDimensions.value.height}` : "");

// 画布拖入的文件先建出这个节点，上传由节点自己跑：环形进度就画在本节点的预览框里。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  outputs.value.video = { dataType: "VIDEO", value: { url: path, mimeType } };
}, () => outputs.value);
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
watch(() => outputFile.value?.url, () => { videoDimensions.value = undefined; });
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, translate("视频读取失败"))
);

nodeEvent.on("save", (reason) => {
  if (uploading.value || uploadingDrag.value) throw new Error(translate("视频处理中，请完成后再切换或刷新节点"));
  if (reason === "reload" && (exporting.value || actions.value?.processing)) throw new Error(translate("视频正在导出，请完成后再刷新节点"));
});
nodeEvent.on("delete", async () => {
  if (uploading.value || uploadingDrag.value) throw new Error(translate("视频上传中，请稍后删除节点"));
  uploading.value = true;
  try {
    await Promise.all([actions.value?.cancelAndWait(), player.value?.cancelAndWait()]);
    await files.removeNodeFiles();
  } finally {
    uploading.value = false;
  }
});

nodeTools.register({
  name: "setVideo",
  description: "选择工作区视频作为此节点输出。普通素材保存内部副本，已有内部原片直接共享；返回实际保存路径，素材库后续整理不影响此节点。",
  parameters: z.strictObject({
    path: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^video\/[a-zA-Z0-9.+-]+$/).optional().describe('通常从文件元信息识别；文件未声明类型时可补充'),
  }),
  async execute({ path, mimeType }, { signal }) {
    signal?.throwIfAborted();
    if (uploading.value || uploadingDrag.value || exporting.value || actions.value?.processing) throw new Error(translate("视频处理中，请稍后重试"));
    const checkPublication = captureMediaPublication();
    uploading.value = true;
    try {
      const value = await files.retainMedia(path, 'video', signal, mimeType);
      checkPublication(signal, value.url);
      outputs.value.video = { dataType: "VIDEO", value };
      return outputs.value.video;
    } finally {
      uploading.value = false;
    }
  },
});

// 模型能编辑或延长已有视频时，在视频节点上直接给入口（和图片的打光、多角度一样）：
// 新建一个连好这段视频、已选好模式和支持该模式的模型的视频生成节点，不自动生成。
// 只有当前目录里确实有模型支持该模式时才显示。
type ModeEntry = { mode: "edit" | "extend"; label: string; icon: typeof IconScissors; model: string };
const videoModels = ref<Array<{ providerId: string; modelId: string; mode?: unknown[] }>>([]);
const creatingEntry = ref(false);
const { createLinked } = useLinkedNode();
watch(() => Boolean(outputFile.value), async (hasVideo) => {
  if (!hasVideo || videoModels.value.length) return;
  videoModels.value = (await ai.getMediaModels().catch(() => [])).filter(item => item.type === "video");
}, { immediate: true });
const modelEntries = computed<ModeEntry[]>(() => ([["edit", "编辑视频", IconPencil], ["extend", "延长视频", IconArrowAutofitRight]] as const).flatMap(([mode, label, icon]) => {
  const model = videoModels.value.find(item => item.mode?.includes(mode));
  return model ? [{ mode, label, icon, model: JSON.stringify([model.providerId, model.modelId]) }] : [];
}));
async function createModeNode(entry: ModeEntry) {
  if (creatingEntry.value) return;
  creatingEntry.value = true;
  try {
    const created = await createLinked(node, "remote-videoGenerationNode", translate(entry.label));
    if (!created) return;
    await nextTick();
    // 顺序要和节点里的同步监听对上：先模型，再标记为明确选择，最后写模式。
    created.data.model = entry.model;
    created.data.modeChosen = true;
    created.data.mode = JSON.stringify(entry.mode);
  } catch (error) {
    showError(error, translate("新建节点失败"));
  } finally {
    creatingEntry.value = false;
  }
}

async function resizeVideo({ width, height }: { width: number; height: number }) {
  if (!width || !height) return;
  videoDimensions.value = { width, height };
  videoWidth.value = Math.min(640, Math.max(240, (240 * width) / height));
  await nextTick();
  updateNodeInternals();
}

const emptyHints: EmptyHint[] = [
  { key: "upload", label: "上传本地视频", icon: IconUpload },
  { key: "paste", label: "粘贴剪贴板里的视频", icon: IconClipboard },
];
async function pickHint(key: string) {
  if (key === "upload") return fileInput.value?.click();
  const file = (await readClipboardFiles().catch(() => [])).find(item => assetFileType(item).kind === "video");
  if (!file) return void ElMessage.warning(translate("剪贴板里没有视频"));
  takeVideo(file);
}

function uploadVideo(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) takeVideo(file);
}

function takeVideo(file: File) {
  if (uploading.value || uploadingDrag.value || exporting.value || actions.value?.processing) return;
  if (assetFileType(file).kind !== "video") return void ElMessage.error(translate("请选择视频文件"));
  if (!file.size) return void ElMessage.error(translate("视频不能为空"));
  if (file.size > ASSET_MAX_BYTES) return void ElMessage.error(translate("视频不能超过 100 MB"));
  // 和「拖文件进画布」走同一条通道：真上传进度的环形、失败可重试、写回 outputs 都由
  // useNodeUpload 统一处理。
  // ACT: 复制节点可能仍引用旧视频，替换输出不删除共享文件。
  beginUpload(id, file.name, file, assetFileType(file).mimeType);
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
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

  .exportLoading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 20px;
    color: var(--el-text-color-secondary);
  }

  .fileInput {
    display: none;
  }

}
</style>
