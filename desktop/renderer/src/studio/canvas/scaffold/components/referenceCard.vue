<template>
  <div class="referenceItem" role="group" :title="title" :aria-label="title" @keydown.enter.self.stop.prevent="openPreview()" @keydown.space.self.stop.prevent="openPreview()">
    <el-image
      v-if="(item.dataType === 'IMAGE' || videoPoster) && previewUrl && !previewError"
      class="preview"
      :src="previewUrl"
      fit="cover"
      :alt="translate('预览引用 {0}', { 0: index })"
      draggable="false"
      @click.stop="openPreview"
      @error="mediaError" />
    <video
      v-else-if="item.dataType === 'VIDEO' && previewUrl && !previewError"
      class="preview"
      :src="previewUrl"
      preload="metadata"
      muted
      playsinline
      aria-hidden="true"
      @loadedmetadata="readDuration"
      @loadeddata="readVideoPreview"
      @error="mediaError" />
    <component v-else :is="itemIcon" class="typeIcon" :size="21" aria-hidden="true" />
    <audio
      v-if="item.dataType === 'AUDIO' && originalUrl"
      ref="audioElement"
      :src="originalUrl"
      preload="metadata"
      @loadedmetadata="readDuration"
      @play="audioPlaying = true"
      @pause="audioPlaying = false"
      @ended="audioPlaying = false"
      @error="playbackError = translate('无法播放该素材')" />
    <button v-if="canPreview" type="button" class="previewButton nodrag nopan" :class="{ playing: audioPlaying }" :aria-label="audioPlaying ? translate('暂停引用 {0}', { 0: index }) : translate('预览引用 {0}', { 0: index })" :title="audioPlaying ? translate('暂停') : translate('预览')" @pointerdown.stop @mousedown.stop @dblclick.stop @click.stop="openPreview">
      <icon-player-pause v-if="audioPlaying" :size="14" />
      <icon-player-play v-else-if="item.dataType === 'VIDEO' || item.dataType === 'AUDIO'" :size="14" />
      <icon-eye v-else :size="14" />
    </button>
    <el-button
      class="removeButton nodrag nopan"
      :icon="IconX"
      circle
      :aria-label="translate('删除引用 {0}', { 0: index })"
      :title="translate('删除引用')"
      @pointerdown.stop
      @mousedown.stop
      @dblclick.stop
      @click.stop="emit('remove')" />
    <span class="indexBadge" :class="{ roleBadge: label }" aria-hidden="true">{{ label || index }}</span>
    <div v-if="(item.dataType === 'VIDEO' && previewUrl && !previewError) || (item.dataType === 'AUDIO' && duration)" class="videoInfo" aria-hidden="true">
      <icon-player-play v-if="item.dataType === 'VIDEO'" :size="12" />
      <span v-if="displayDuration">{{ displayDuration }}</span>
    </div>
    <el-image-viewer v-if="previewVisible && item.dataType === 'IMAGE' && (originalUrl || previewUrl)" :urlList="[originalUrl || previewUrl]" teleported @close="previewVisible = false" />
    <el-dialog :modelValue="previewVisible && item.dataType !== 'IMAGE' && item.dataType !== 'AUDIO'" :title="title" :width="item.dataType === 'VIDEO' ? 'min(800px, calc(100vw - 32px))' : 'min(520px, calc(100vw - 32px))'" alignCenter appendToBody destroyOnClose @update:modelValue="previewVisible = false">
      <div v-if="previewVisible" class="referenceMediaPreview">
        <pre v-if="item.dataType === 'STRING'" class="referenceText">{{ item.value }}</pre>
        <p v-else-if="playbackError" role="alert">{{ playbackError }}</p>
        <p v-else-if="!originalUrl" role="status">{{ translate('正在读取素材…') }}</p>
        <video v-else-if="item.dataType === 'VIDEO'" :src="workspacePlaybackUrl(originalUrl)" controls playsinline preload="metadata" :aria-label="translate('预览引用 {0}', { 0: index })" @error="playbackError = translate('无法播放该素材')" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElDialog, ElImage, ElImageViewer } from "element-plus";
import { IconX, IconEye, IconFileText, IconPhoto, IconVideo, IconMusic, IconPlayerPlay, IconPlayerPause } from "@tabler/icons-vue";
import { workspacePlaybackUrl } from "@/lib/workspaceFiles";
import { useNodeFiles } from "../workspaceFiles";
import { translate } from "@miaoimg/i18n/vue";
import type { NodeInputValue } from "../values";

const props = defineProps<{ item: NodeInputValue; index: number; label?: string; durationSeconds?: number }>();
const emit = defineEmits<{ remove: []; preview: [url: string] }>();
const previewVisible = ref(false);
const previewError = ref("");
const duration = ref("");
const displayDuration = computed(() => props.durationSeconds && props.durationSeconds > 0 ? translate("{0}s", {0: props.durationSeconds.toFixed(1)}) : duration.value);
const videoThumbnail = ref("");
const originalPreview = ref(false);
const playbackError = ref("");
const audioElement = ref<HTMLAudioElement>();
const audioPlaying = ref(false);
const media = computed(() => props.item.value !== undefined && (props.item.dataType === "IMAGE" || props.item.dataType === "VIDEO" || props.item.dataType === "AUDIO") ? props.item.value : undefined);
const thumbnailMedia = computed(() => props.item.dataType === 'AUDIO' ? undefined : media.value);
const canPreview = computed(() => props.item.dataType === 'STRING' ? props.item.value !== undefined : Boolean(media.value));
const itemIcon = computed(() => props.item.dataType === "IMAGE" ? IconPhoto : props.item.dataType === "VIDEO" ? IconVideo : props.item.dataType === "AUDIO" ? IconMusic : IconFileText);
const title = computed(() => {
  const content = props.item.value === undefined ? translate("暂无内容") : props.item.dataType === "STRING" ? translate("文本") : props.item.dataType === "VIDEO" ? translate("视频") : props.item.dataType === "AUDIO" ? translate("音频") : translate("图片");
  const suffix = previewError.value ? translate("（{0}）", { 0: previewError.value }) : "";
  return (props.label ? `${props.label} · ` : '') + translate("引用 {0}：{1}", { 0: props.index, 1: content }) + suffix;
});

watch(() => media.value ? JSON.stringify([props.item.dataType, media.value.url, media.value.mimeType]) : props.item.value, () => {
  previewVisible.value = false;
  previewError.value = "";
  duration.value = "";
  videoThumbnail.value = "";
  originalPreview.value = false;
  playbackError.value = "";
  audioElement.value?.pause();
});
const { useFileUrl } = useNodeFiles();
const thumbnailUrl = useFileUrl(thumbnailMedia, error => {
  if (thumbnailMedia.value && !originalPreview.value) originalPreview.value = true;
  else previewError.value = error instanceof Error ? error.message : translate("读取引用文件失败");
}, 320);
// 缩略图转换不可用时仍可显示本机原件；只回退一次，不把可读素材当成损坏文件。
// 音频没有缩略图，直接读原件元数据显示时长，并在卡片上就地播放。
const originalUrl = useFileUrl(computed(() => previewVisible.value || originalPreview.value || props.item.dataType === "AUDIO" ? media.value : undefined), error => {
  playbackError.value = error instanceof Error ? error.message : translate("读取引用文件失败");
  if (originalPreview.value) previewError.value = playbackError.value;
});
const previewUrl = computed(() => originalPreview.value ? originalUrl.value : thumbnailUrl.value);
const videoPoster = computed(() => props.item.dataType === "VIDEO" && /[?&]preview=1(?:&|$)/.test(previewUrl.value));
function openPreview() {
  if (!canPreview.value) return;
  if (props.item.dataType === "AUDIO") {
    const audio = audioElement.value;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => { playbackError.value = translate("无法播放该素材"); });
    else audio.pause();
    return;
  }
  playbackError.value = "";
  previewVisible.value = true;
}

watch([previewUrl, previewError, videoThumbnail], ([url, error, thumbnail]) => {
  emit("preview", error ? "" : props.item.dataType === "VIDEO" ? (videoPoster.value ? url : thumbnail) : url);
}, { immediate: true });

function mediaError() {
  if (!originalPreview.value) { originalPreview.value = true; return; }
  previewError.value = props.item.dataType === "VIDEO" ? translate("无法预览该视频") : translate("无法预览该图片");
}

function readVideoPreview(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (video.currentSrc !== previewUrl.value || !video.videoWidth || !video.videoHeight) return;
  const canvas = document.createElement("canvas");
  const scale = 96 / Math.max(video.videoWidth, video.videoHeight);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  videoThumbnail.value = canvas.toDataURL("image/webp");
}

function readDuration(event: Event) {
  const seconds = (event.currentTarget as HTMLMediaElement).duration;
  if (!Number.isFinite(seconds) || seconds < 0) return;
  // 一分钟内按秒显示一位小数（3.0s），更长的素材用 分:秒。
  if (seconds < 60) { duration.value = `${seconds.toFixed(1)}s`; return; }
  const totalSeconds = Math.floor(seconds);
  duration.value = `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
</script>

<style scoped>
.referenceItem {
  position: relative;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  box-sizing: border-box;
  width: 48px;
  height: 48px;
  overflow: hidden;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base, 8px);
  background: var(--el-fill-color-light);
  color: var(--el-text-color-secondary);
  cursor: grab;
  user-select: none;

  &:active {
    cursor: grabbing;
  }

  &.referenceGhost {
    opacity: 0.35;
  }

  &:focus-visible {
    outline: 2px solid var(--el-color-primary);
    outline-offset: -2px;
  }

  .preview {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .removeButton {
    z-index: 2;
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    margin: 0;
    opacity: 0;
  }

  /* 删除按钮只在悬停或键盘聚焦时出现，平时不压住缩略图和角色标签。 */
  &:hover .removeButton,
  &:focus-within .removeButton {
    opacity: 1;
  }

  .indexBadge {
    pointer-events: none;
    position: absolute;
    top: 2px;
    left: 2px;
    min-width: 13px;
    padding: 0 2px;
    border-radius: 3px;
    background: var(--el-bg-color-overlay);
    color: var(--el-text-color-primary);
    font-size: 9px;
    line-height: 13px;
    text-align: center;
    white-space: nowrap;

    /* 首帧/尾帧等角色标签横跨顶部，和序号角标区分开。 */
    &.roleBadge {
      top: 0;
      right: 0;
      left: 0;
      border-radius: 0;
      background: color-mix(in srgb, var(--el-bg-color-overlay) 85%, transparent);
    }
  }

  .videoInfo {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 2px;
    padding: 2px 3px;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 85%, transparent);
    color: var(--el-text-color-primary);
    font-size: 9px;
    line-height: 12px;
  }
}
.previewButton { position: absolute; z-index: 1; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: rgba(0,0,0,.7); color: white; cursor: pointer; opacity: 0; }
.referenceItem:hover .previewButton, .referenceItem:focus-within .previewButton, .previewButton.playing { opacity: 1; }
.referenceMediaPreview video { display: block; width: 100%; max-height: 65vh; }
.referenceMediaPreview audio { display: block; width: 100%; }
.referenceText { margin: 0; max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 13px; line-height: 1.7; user-select: text; }
</style>
