<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :mediaMeta="durationLabel"
    :topVisible="node.selected"
    :bottomVisible="node.selected && actions?.mode === 'speed'"
    :bottomWidth="440"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    style="width: 320px"
    @fullscreen="enterFullscreen">
    <template #topActions>
      <el-button v-if="previewUrl" :icon="IconScissors" :disabled="!previewUrl || uploading || uploadingDrag || actions?.processing" text :title="translate('截取音频')" :aria-label="translate('截取音频')" @click.stop="actions?.open('clip')">{{ translate('截取') }}</el-button>
      <el-button v-if="previewUrl" :icon="IconGauge" :disabled="!previewUrl || uploading || uploadingDrag || actions?.processing" text :title="translate('音频变速')" :aria-label="translate('音频变速')" @click.stop="actions?.open('speed')">{{ translate('变速') }}</el-button>
      <el-dropdown v-if="previewUrl" ref="formatMenu" :persistent="false" trigger="click" :disabled="!previewUrl || uploading || uploadingDrag || actions?.processing" @command="(format: AudioFormat) => actions?.open('convert', format)">
        <el-button v-if="previewUrl" :icon="IconFileMusic" :disabled="!previewUrl || uploading || uploadingDrag || actions?.processing" text :title="translate('转换音频格式')" :aria-label="translate('转换音频格式')" @click.stop>{{ translate('格式') }}</el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="mp3">MP3 · 320 kbps</el-dropdown-item>
            <el-dropdown-item command="m4a">M4A · AAC 256 kbps</el-dropdown-item>
            <el-dropdown-item command="wav">WAV · {{ translate('未压缩') }}</el-dropdown-item>
            <el-dropdown-item command="flac">FLAC · {{ translate('无损压缩') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button
        :icon="IconTransfer"
        :loading="uploading || uploadingDrag"
        :disabled="actions?.processing"
        text
        :title="translate('替换音频')"
        :aria-label="translate('替换音频')"
        @click.stop="fileInput?.click()" />
    </template>
    <div ref="audioContent" class="audioContent nopan">
      <audioPlayer
        v-if="previewUrl"
        ref="player"
        class="audioPreview"
        :src="previewUrl"
        @loadedmetadata="updateNodeInternals" />
      <input ref="fileInput" class="fileInput" type="file" accept="audio/*" :aria-label="translate('选择音频')" :disabled="uploading" @change="uploadAudio" />
      <nodeEmptyState v-if="!outputs.audio" v-loading="uploading" :icon="IconMusic" :label="translate('暂无音频')" :hints="emptyHints" :disabled="uploading || uploadingDrag" @pick="pickHint" />
      <uploadProgress v-if="dragUploadEntry" :entry="dragUploadEntry" @retry="retryDragUpload" @dismiss="dismissDragUpload" />
    </div>
    <template v-if="actions?.mode === 'speed'" #bottom><div ref="speedTarget" /></template>
  </nodeSkeleton>
  <audioActions ref="actions" :file="outputFile" :src="previewUrl" :target="speedTarget" :disabled="uploading || uploadingDrag" @pause="player?.pause()" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { IconMusic, IconVideo, IconClipboard, IconUpload, IconTransfer, IconScissors, IconGauge, IconFileMusic } from "@tabler/icons-vue";
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElMessage } from "element-plus";
import type { AudioFormat } from "./audioNode/audioProcessing";
import { nodeSkeleton, nodeTools, useNode, useNodeUpload, z, type NodeHandle } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import uploadProgress from "../components/uploadProgress.vue";
import nodeEmptyState, { type EmptyHint } from "../components/nodeEmptyState.vue";
import { useLinkedNode } from "../linkedNode";
import { readClipboardFiles } from "@/lib/clipboard";
import { beginUpload } from "../uploadStatus";
import { assetFileType } from "../assetFile";
import audioPlayer from "./audioNode/audioPlayer.vue";
import audioActions from "./audioNode/audioActions.vue";
import { useMediaPublication } from "../scaffold/mediaPublication";
import { useRegisterCanvasTools } from "../canvasToolRegistry";

defineOptions({
  inheritAttrs: false,
  icon: IconMusic,
  handles: [{ id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" }] satisfies NodeHandle[],
});
const { id, node, nodeProps, outputs, nodeEvent, files, updateNodeInternals } = useNode({
  label: "音频",
});
const captureMediaPublication = useMediaPublication(() => outputs.value);
const fileInput = ref<HTMLInputElement>();
const uploading = ref(false);
const audioContent = ref<HTMLDivElement>();
const player = ref<InstanceType<typeof audioPlayer>>();
const durationLabel = computed(() => {
  const duration = player.value?.duration;
  if (!duration || !Number.isFinite(duration)) return "";
  const seconds = Math.floor(duration);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
const actions = ref<InstanceType<typeof audioActions>>();
const formatMenu = ref<InstanceType<typeof ElDropdown>>();
const speedTarget = ref<HTMLElement>();

// 画布拖入的文件先建出这个节点，上传由节点自己跑：环形进度就画在本节点的预览框里。
const { entry: dragUploadEntry, uploading: uploadingDrag, retry: retryDragUpload, dismiss: dismissDragUpload } = useNodeUpload(id, (path, mimeType) => {
  outputs.value.audio = { dataType: "AUDIO", value: { url: path, mimeType } };
}, () => outputs.value);
const outputFile = computed(() => outputs.value.audio?.dataType === "AUDIO" ? outputs.value.audio.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, translate("音频读取失败"))
);
useRegisterCanvasTools(node, {
  available: tool => ["audio:clip", "audio:speed", "audio:convert", "audio:split-silence"].includes(tool)
    && Boolean(outputFile.value?.url) && !uploading.value && !uploadingDrag.value && !actions.value?.processing,
  ready: tool => Boolean(previewUrl.value && (tool === "audio:convert" ? formatMenu.value : actions.value)),
  run: tool => tool === "audio:convert" ? formatMenu.value?.handleOpen() : actions.value?.open(tool === "audio:speed" ? "speed" : tool === "audio:split-silence" ? "silence" : "clip"),
});

async function enterFullscreen() {
  try { await audioContent.value?.requestFullscreen(); }
  catch (error) { showError(error, translate("无法进入音频全屏")); }
}

nodeEvent.on("save", (reason) => {
  if (uploading.value || uploadingDrag.value) throw new Error(translate("音频处理中，请完成后再切换或刷新节点"));
  if (reason === "reload" && actions.value?.processing) throw new Error(translate("音频处理中，请完成或取消后再刷新节点"));
});
nodeEvent.on("delete", () => {
  if (uploading.value || uploadingDrag.value) throw new Error(translate("音频上传中，请稍后删除节点"));
  uploading.value = true;
  return (async () => {
    // 截取/变速正在跑时先取消并等它清理完临时文件，再删节点素材。
    await actions.value?.cancelAndWait();
    await files.removeNodeFiles();
  })().finally(() => {
    uploading.value = false;
  });
});

nodeTools.register({
  name: "setAudio",
  description: "选择工作区音频作为此节点输出。普通素材保存内部副本，已有内部原片直接共享；返回实际保存路径，素材库后续整理不影响此节点。",
  parameters: z.strictObject({
    path: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^audio\/[a-zA-Z0-9.+-]+$/).optional().describe('通常从文件元信息识别；文件未声明类型时可补充'),
  }),
  async execute({ path, mimeType }, { signal }) {
    signal?.throwIfAborted();
    if (uploading.value || uploadingDrag.value || actions.value?.processing) throw new Error(translate("音频处理中，请稍后重试"));
    const checkPublication = captureMediaPublication();
    uploading.value = true;
    try {
      const value = await files.retainMedia(path, 'audio', signal, mimeType);
      checkPublication(signal, value.url);
      outputs.value.audio = { dataType: "AUDIO", value };
      return outputs.value.audio;
    } finally {
      uploading.value = false;
    }
  },
});

const { canLink, createLinked } = useLinkedNode();
const emptyHints = computed<EmptyHint[]>(() => [
  { key: "upload", label: "上传本地音频", icon: IconUpload },
  { key: "paste", label: "粘贴剪贴板里的音频", icon: IconClipboard },
  ...(canLink(node, "remote-videoGenerationNode") ? [{ key: "video", label: "音频生视频", icon: IconVideo }] : []),
]);
async function pickHint(key: string) {
  if (key === "upload") return fileInput.value?.click();
  if (key === "video") return void createLinked(node, "remote-videoGenerationNode", "视频生成");
  const file = (await readClipboardFiles().catch(() => [])).find(item => assetFileType(item).kind === "audio");
  if (!file) return void ElMessage.warning(translate("剪贴板里没有音频"));
  takeAudio(file);
}

function uploadAudio(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) takeAudio(file);
}

function takeAudio(file: File) {
  if (uploading.value || uploadingDrag.value || actions.value?.processing) return;
  if (assetFileType(file).kind !== "audio") return void ElMessage.error(translate("请选择音频文件"));
  if (!file.size) return void ElMessage.error(translate("音频为空或超过当前工作区允许的大小"));
  // 和「拖文件进画布」走同一条通道：真上传进度的环形、失败可重试、写回 outputs 都由
  // useNodeUpload 统一处理。
  // ACT: 复制节点可能仍引用旧音频，替换输出不删除共享文件。
  beginUpload(id, file.name, file, assetFileType(file).mimeType);
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
</script>

<style scoped lang="scss">
.audioContent {
  position: relative;
  min-height: 144px;
  display: flex;
  align-items: center;

  &:fullscreen {
    justify-content: center;
    padding: 48px;
    background: var(--el-bg-color);

    .audioPlayer {
      max-width: 720px;
    }

  }

  .audioPreview {
    display: block;
    width: 100%;
    border-radius: var(--el-border-radius-base);
  }

  .fileInput {
    display: none;
  }

}
</style>
