<template>
  <div ref="host" class="videoPlayer" :style="{ aspectRatio: videoAspect || '16 / 9' }">
    <img v-if="mediaActive && !mediaRequested && posterUrl" class="videoPoster" :src="posterUrl" alt="" draggable="false" @load="readPoster" @error="requestMedia" />
    <video
      v-show="mediaRequested || !posterUrl"
      ref="video"
      class="videoPreview"
      :class="{ nodrag: fullscreen }"
      :src="mediaActive && mediaRequested ? playbackSrc : undefined"
      :poster="mediaActive ? posterUrl : undefined"
      :style="{ aspectRatio: videoAspect || undefined }"
      :controls="fullscreen"
      playsinline
      preload="metadata"
      draggable="false"
      :aria-label="label"
      @fullscreenchange="fullscreen = !!video?.matches(':fullscreen')"
      @loadedmetadata="readMetadata"
      @loadeddata="markReady"
      @durationchange="readDuration"
      @timeupdate="readTime"
      @play="playing = true"
      @waiting="buffering = true"
      @canplay="buffering = false"
      @playing="buffering = false"
      @pause="playing = false"
      @ended="playing = false"
      @volumechange="readVolume"
      @error="mediaError" />
    <span v-if="mediaActive && mediaRequested && !failed && (!ready || buffering)" class="playbackStatus" role="status">{{ ready ? translate("正在缓冲…") : translate("正在准备播放…") }}</span>
    <button v-if="mediaActive && failed" class="playbackStatus retryPlayback nodrag nopan" @pointerdown.stop @click.stop="retryPlayback">{{ translate('视频加载未完成，点击重试') }}</button>
    <div v-show="!fullscreen" class="playerControls nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <el-button class="playerButton playButton" text circle :icon="playing ? IconPlayerPause : IconPlayerPlay" :disabled="!mediaActive || failed" :aria-label="playing ? translate('暂停视频') : translate('播放视频')" :title="playing ? translate('暂停') : translate('播放')" @click="togglePlayback" />
      <span class="currentTime">{{ formatTime(currentTime) }}</span>
      <el-slider class="progressSlider" :persistent="false" :modelValue="currentTime" :min="0" :max="duration || 1" :step="0.01" :disabled="!ready || !duration" :formatTooltip="formatTime" :aria-label="translate('视频播放进度')" @input="scrub" @change="seek" />
      <span class="durationLabel"><template v-if="duration"><span class="timeSeparator">/</span>{{ formatTime(duration) }}</template></span>
      <div class="volumeControl">
        <el-popover :persistent="false" trigger="hover" placement="top" :width="40" :popperStyle="{ minWidth: '40px', padding: '8px 0', borderRadius: 'var(--el-border-radius-base)' }" :showArrow="false" :showAfter="80" :hideAfter="150" :disabled="!ready">
          <template #reference>
            <el-button class="playerButton volumeButton" text circle :icon="muted || !volume ? IconVolumeOff : IconVolume" :disabled="!ready" :aria-pressed="muted || !volume" :aria-label="muted || !volume ? translate('取消静音') : translate('静音视频')" :title="translate('音量 · 点击切换静音')" @click="toggleMute" />
          </template>
          <div class="volumePanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
            <span class="volumeValue">{{ muted ? 0 : volume }}%</span>
            <el-slider class="volumeSlider" :modelValue="muted ? 0 : volume" vertical height="60px" :min="0" :max="100" :showTooltip="false" :aria-label="translate('视频音量')" @input="setVolume" />
          </div>
        </el-popover>
      </div>
      <el-dropdown class="captureMenu" :persistent="false" trigger="click" placement="top-end" :disabled="disabled || !mediaActive || failed || capturing" @visibleChange="captureMenuVisible = $event" @command="command => captureFrame(command)">
        <el-button class="playerButton" text circle :icon="IconPhotoScan" :loading="capturing" :disabled="disabled || !mediaActive || failed || capturing" :aria-expanded="captureMenuVisible" :aria-label="translate('截取视频帧')" :title="translate('截取视频帧')" />
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="current" :icon="IconPhotoScan">{{ translate('截取当前帧') }}</el-dropdown-item>
            <el-dropdown-item command="first" :icon="IconPlayerSkipBack">{{ translate('截取首帧') }}</el-dropdown-item>
            <el-dropdown-item command="last" :icon="IconPlayerSkipForward">{{ translate('截取尾帧') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nodeTools, z } from "../nodeTools";
import { extractVideoFrame } from "../../nodes/videoNode/videoProcessing";
import { useNodeFfmpeg } from "../nodeFfmpeg";
import { useMediaPlaybackTools } from "../useMediaPlaybackTools";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import { useNode, useVueFlow } from "@vue-flow/core";
import { ElButton, ElDropdown, ElDropdownMenu, ElDropdownItem, ElMessage, ElPopover, ElSlider } from "element-plus";
import { IconPlayerPlay, IconPlayerPause, IconVolume, IconVolumeOff, IconPhotoScan, IconPlayerSkipBack, IconPlayerSkipForward } from "@tabler/icons-vue";
import { useNodeFiles } from "../workspaceFiles";
import { translate } from "@miaoimg/i18n/vue";
import { workspacePreviewUrl, workspacePlaybackUrl } from "@/lib/workspaceFiles";

const props = defineProps<{ src: string; label?: string; disabled?: boolean }>();
const originalFallback = ref(false);
const adaptivePreview = ref(false);
let resumeAfterSwitch = false;
const mediaRequested = ref(false);
let scrubbing = false;
const host = ref<HTMLElement>();
const inView = ref(false);
const pageVisible = ref(!document.hidden);
const failed = ref(false);
const videoAspect = ref("");
let observer: IntersectionObserver | undefined;
let resumeTime = 0;
const buffering = ref(false);
const playbackSrc = computed(() => originalFallback.value ? props.src : workspacePlaybackUrl(props.src, adaptivePreview.value));
const canAdaptPlayback = computed(() => Boolean(window.miaoDesktop) && workspacePlaybackUrl(props.src, true) !== props.src);
const posterUrl = computed(() => props.src.includes("/api/imagine/workspace/files?") ? workspacePreviewUrl(props.src) : undefined);
// 节点名是画布数据：展示时按当前语言兜底，写进画布（新建节点名）仍用中文原文。
const label = computed(() => props.label || translate("节点视频"));
const emit = defineEmits<{ dimensions: [size: { width: number; height: number }] }>();
const video = ref<HTMLVideoElement>();
const fullscreen = ref(false);
const ready = ref(false);
const playing = ref(false);
const muted = ref(false);
const volume = ref(100);
let lastVolume = 100;
const currentTime = ref(0);
const duration = ref(0);
const capturing = ref(false);
const captureMenuVisible = ref(false);
const { node } = useNode();
const { addNodes, findNode, getNodes, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const canvasUiActive = inject<Ref<boolean> | undefined>("canvasUiActive", undefined);
// 离开视口后释放解码器和下载连接，保留尺寸与进度；重新进入时按需读取。
const mediaActive = computed(() => inView.value && pageVisible.value && canvasUiActive?.value !== false);
onMounted(() => {
  observer = new IntersectionObserver(entries => { inView.value = entries[0]?.isIntersecting ?? false; }, { rootMargin: "240px" });
  if (host.value) observer.observe(host.value);
});
watch(mediaActive, active => {
  if (!active) {
    resumeAfterSwitch = false;
    resumeTime = video.value?.currentTime ?? resumeTime;
    video.value?.pause();
    // load() 终止已有 Range 请求，单纯移除 src 不足以释放播放器。
    video.value?.removeAttribute("src");
    video.value?.load();
    ready.value = false;
    mediaRequested.value = false;
    scrubbing = false;
  } else { failed.value = false; if (!posterUrl.value) void requestMedia(); }
}, { flush: "pre" });
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
let captureController: AbortController | undefined;
let captureJob: Promise<unknown> | undefined;

watch(() => getCanvas?.()?.id, () => captureController?.abort(), { flush: "sync" });
watch(() => props.disabled, disabled => { if (disabled) captureController?.abort(); }, { flush: "sync" });
watch(() => props.src, () => {
  captureController?.abort();
  ready.value = false;
  originalFallback.value = false;
  adaptivePreview.value = false;
  resumeAfterSwitch = false;
  mediaRequested.value = false;
  scrubbing = false;
  buffering.value = false;
  playing.value = false;
  currentTime.value = 0;
  duration.value = 0;
  resumeTime = 0;
  failed.value = false;
  if (mediaActive.value && !posterUrl.value) void requestMedia();
}, { flush: "sync" });
onBeforeUnmount(() => { observer?.disconnect(); captureController?.abort(); video.value?.pause(); video.value?.removeAttribute("src"); video.value?.load(); });
// 切到其他画布或后台标签时停止播放，避免看不见的播放器继续抢带宽。
const visibility = () => { pageVisible.value = !document.hidden; };
document.addEventListener("visibilitychange", visibility);
onBeforeUnmount(() => document.removeEventListener("visibilitychange", visibility));

async function enterFullscreen() {
  if (!video.value) return;
  inView.value = true;
  fullscreen.value = true;
  try {
    // requestFullscreen must retain the click's transient user activation.
    mediaRequested.value = true;
    await video.value.requestFullscreen();
  } catch {
    fullscreen.value = false;
    ElMessage.error(translate("无法进入视频全屏"));
  }
}

async function prepareToolPlayback(signal?: AbortSignal) {
  if (!mediaActive.value) {
    await useVueFlowForPlayback.fitView({ nodes: [node.id], duration: 0, padding: 0.25 });
    inView.value = true;
    await nextTick();
  }
  signal?.throwIfAborted();
  if (!mediaActive.value) throw new Error('请切换到该视频所在画布并保持窗口可见');
  await requestMedia();
}
const useVueFlowForPlayback = useVueFlow();
useMediaPlaybackTools(() => video.value, prepareToolPlayback);
nodeTools.register({
  name: 'captureVideoFrame', description: '将当前视频的 current 当前帧、first 首帧或 last 尾帧截为真实 PNG 图片节点，保留原片，不调用图片或视频模型。current 固定调用瞬间的播放位置，截取该位置对应的实际画面；播放器已释放时沿用保留的进度。当前帧与尾帧返回实际画面时间，不用平均帧率估算，也不因较长的音轨错取画面。',
  parameters: z.strictObject({ frame: z.enum(['current','first','last']).default('current') }),
  async execute({ frame }, { signal }) { return captureFrame(frame, signal, true); },
});

defineExpose({ enterFullscreen, cancelAndWait });

async function cancelAndWait() {
  captureController?.abort();
  await captureJob;
}

function formatTime(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readMetadata() {
  // 只加载 metadata 时也允许播放，不等待 loadeddata 才开放按钮。
  markReady();
  if (video.value?.videoWidth && video.value.videoHeight) dimensions(video.value.videoWidth, video.value.videoHeight);
  if (resumeTime && video.value && Number.isFinite(video.value.duration)) {
    // A completed clip starts again when reopened; restoring exactly duration
    // would immediately end the new play request.
    video.value.currentTime = resumeTime < video.value.duration - 0.05 ? resumeTime : 0;
  }
  if (resumeAfterSwitch && video.value) {
    resumeAfterSwitch = false;
    void video.value.play().catch(() => { playing.value = false; });
  }
}
function dimensions(width: number, height: number) {
  if (!width || !height) return;
  videoAspect.value = `${width} / ${height}`;
  emit("dimensions", { width, height });
}
function readPoster(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  // A poster preserves aspect ratio, but is not the video's resolution.
  if (image.naturalWidth && image.naturalHeight) videoAspect.value = `${image.naturalWidth} / ${image.naturalHeight}`;
}
async function requestMedia() {
  if (!mediaActive.value) return;
  mediaRequested.value = true;
  await nextTick();
}

function readDuration() {
  const value = video.value?.duration ?? 0;
  if (Number.isFinite(value) && value > 0) duration.value = value;
}
function markReady() { failed.value = false; ready.value = true; readDuration(); }
function retryPlayback() {
  failed.value = false;
  originalFallback.value = false;
  // Retry the local original first; the transcoded copy is only for decode failures.
  adaptivePreview.value = false;
  mediaRequested.value = true;
  if (video.value) { video.value.src = workspacePlaybackUrl(props.src, adaptivePreview.value); video.value.load(); }
}
function mediaError() {
  if (!mediaActive.value) return;
  if (canAdaptPlayback.value && !adaptivePreview.value) { useLightweightPlayback(true); return; }
  if (!originalFallback.value && playbackSrc.value !== props.src) { originalFallback.value = true; return; }
  buffering.value = false;
  ready.value = false;
  playing.value = false;
  failed.value = true;
}

async function togglePlayback() {
  if (!video.value) return;
  if (playing.value) video.value.pause();
  else {
    try { await requestMedia(); await video.value?.play(); }
    catch (error) { if (!resumeAfterSwitch && !(error instanceof DOMException && error.name === "AbortError")) ElMessage.error(translate("视频播放失败")); }
  }
}

function useLightweightPlayback(resume: boolean) {
  resumeTime = video.value?.currentTime || 0;
  resumeAfterSwitch = resume;
  ready.value = false;
  buffering.value = true;
  originalFallback.value = false;
  adaptivePreview.value = true;
}
function readTime() {
  if (!scrubbing) currentTime.value = video.value?.currentTime ?? 0;
  // 桌面版始终播放本机原片。以前按丢帧率中途切到转码副本：播放会停下来等 ffmpeg
  // 转完整段，回来还是 720p 低码率，看起来就是"卡一下再变糊"。只有解码失败才降载。
}
function scrub(value: number | number[]) {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  scrubbing = true;
  currentTime.value = value;
}
function seek(value: number | number[]) {
  scrubbing = false;
  if (!video.value || !Number.isFinite(value)) return;
  video.value.currentTime = Math.min(duration.value, Math.max(0, Number(value)));
  currentTime.value = video.value.currentTime;
}

function readVolume() {
  if (!video.value) return;
  volume.value = Math.round(video.value.volume * 100);
  muted.value = video.value.muted;
  if (volume.value > 0) lastVolume = volume.value;
}

function setVolume(value: number | number[]) {
  if (!video.value || typeof value !== "number" || !Number.isFinite(value)) return;
  video.value.volume = Math.min(100, Math.max(0, value)) / 100;
  video.value.muted = video.value.volume === 0;
  readVolume();
}

function toggleMute() {
  if (!video.value) return;
  const silent = video.value.muted || video.value.volume === 0;
  if (video.value.volume === 0) video.value.volume = lastVolume / 100;
  video.value.muted = !silent;
  readVolume();
}

function loadFrame(source: HTMLVideoElement, time: number | "last", signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error(translate("视频帧读取超时"))), 15000);
    function finish(error?: unknown) {
      clearTimeout(timer);
      source.onloadeddata = null;
      source.onseeked = null;
      source.onerror = null;
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    }
    function abort() { finish(signal.reason); }
    source.onloadeddata = () => {
      const target = time === "last" ? Math.max(0, source.duration - 0.001) : time;
      if (!Number.isFinite(target)) return finish(new Error(translate("无法读取视频帧")));
      if (target === source.currentTime && !source.seeking) finish();
      else source.currentTime = target;
    };
    source.onseeked = () => finish();
    source.onerror = () => finish(new Error(translate("无法读取视频帧")));
    signal.addEventListener("abort", abort, { once: true });
    source.src = props.src;
    source.load();
    if (signal.aborted) abort();
  });
}

function addFrameNode(id: string, path: string, frameWidth: number, frameHeight: number, frameLabel: string) {
    const sourceSize = node.data.mediaExportSize || node.data.directorExportSize;
    const sourceWidth = Math.min(640, Math.max(240, 240 * frameWidth / frameHeight));
    const x = node.computedPosition.x + Math.max(node.dimensions.width || 0, sourceSize?.width || sourceWidth) + 40;
    let y = node.computedPosition.y;
    const width = 360 * frameWidth / frameHeight + 2;
    const height = 410;
    for (const other of [...getNodes.value].sort((a, b) => a.computedPosition.y - b.computedPosition.y)) {
      const position = other.computedPosition;
      const reserved = other.data.mediaExportSize || other.data.directorExportSize;
      const otherWidth = Math.max(other.dimensions.width || 0, reserved?.width || 320);
      const otherHeight = Math.max(other.dimensions.height || 0, reserved?.height || 320);
      if (position.x < x + width && position.x + otherWidth > x && position.y < y + height && position.y + otherHeight > y) y = position.y + otherHeight + 32;
    }
    addNodes({ id, type: "remote-imageNode", position: { x, y }, data: { label: `${node.data.label || props.label || "节点视频"} · ${frameLabel}`, mediaExportSize: { width, height }, outputs: { image: { dataType: "IMAGE", value: { url: path, mimeType: "image/png" } } } } });
  return { nodeId: id, path, width: frameWidth, height: frameHeight };
}
function captureFrame(command: "current" | "first" | "last", signal?: AbortSignal, toolCall = false) {
  // Rejected overlapping calls must not replace the work deletion is waiting on.
  const alreadyCapturing = capturing.value;
  const work = performCaptureFrame(command, signal, toolCall);
  if (!alreadyCapturing) captureJob = work.catch(() => {});
  return work;
}

async function performCaptureFrame(command: "current" | "first" | "last", signal?: AbortSignal, toolCall = false) {
  if (toolCall) return captureFrameUsingFfmpeg(command, signal);
  if (props.disabled || !video.value || !mediaActive.value || capturing.value) return;
  if (!nodeTypes?.value?.["remote-imageNode"]) return void ElMessage.error(translate("请先启用图片节点插件"));
  const captureTime = video.value.readyState > 0 ? video.value.currentTime : resumeTime;
  capturing.value = true;
  const controller = captureController = new AbortController();
  const id = crypto.randomUUID();
  let frameVideo: HTMLVideoElement | undefined;
  let uploadStarted = false;
  let committed = false;
  let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  try {
    controller.signal.throwIfAborted();
    let source = video.value;
    if (command !== "current" || playbackSrc.value !== props.src || source.readyState < 2 || source.seeking) {
      frameVideo = document.createElement("video");
      frameVideo.muted = true;
      frameVideo.preload = "auto";
      // Decode the original independently when the preview is unavailable or
      // seeking. For a ready current frame, draw synchronously before awaiting.
      // The independent source supplies duration even before preview loading.
      await loadFrame(frameVideo, command === "current" ? captureTime : command === "first" ? 0 : "last", controller.signal);
      source = frameVideo;
    }
    controller.signal.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error(translate("视频帧尚未就绪"));
    context.drawImage(source, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(translate("截图生成失败"))), "image/png"));
    controller.signal.throwIfAborted();
    // 截帧新建节点的名称会写进画布数据，保持中文原文，不随语言切换。
    const frameLabel = { current: "当前帧", first: "首帧", last: "尾帧" }[command];
    if (findNode(node.id) !== node) throw new Error(translate("画布节点已变化，请重新截帧"));
    workspace = files.getWorkspaceFiles();
    uploadStarted = true;
    const path = await files.uploadFile(id, new File([blob], "frame.png", { type: "image/png" }), undefined, controller.signal);
    controller.signal.throwIfAborted();
    if (findNode(node.id) !== node || !nodeTypes?.value?.["remote-imageNode"]) throw new Error(translate("画布节点已变化，请重新截帧"));
    addFrameNode(id, path, canvas.width, canvas.height, frameLabel);
    committed = true;
    ElMessage.success(translate("已截取为图片节点"));
  } catch (error) {
    if (!controller.signal.aborted) ElMessage.error(error instanceof Error ? error.message : translate("截帧失败"));
  } finally {
    try {
      try {
        if (frameVideo) { frameVideo.removeAttribute("src"); frameVideo.load(); }
      } finally {
        if (uploadStarted && !committed) {
          await workspace!.remove(`assets/${id}`, true).catch(error => {
            if (error?.response?.data?.data?.code !== "ENOENT") ElMessage.error(translate("截帧中断，临时图片清理失败"));
          });
        }
      }
    } finally {
      capturing.value = false;
      captureController = undefined;
    }
  }
}
const loadFrameFfmpeg = useNodeFfmpeg();
async function captureFrameUsingFfmpeg(command: 'first' | 'last' | 'current', signal?: AbortSignal) {
  if (props.disabled) throw new Error(translate("视频处理中，请稍后重试"));
  if (capturing.value || !nodeTypes.value?.['remote-imageNode']) throw new Error('正在截帧或图片节点尚未启用');
  signal?.throwIfAborted();
  // A seek changes the media element before Vue receives timeupdate. Snapshot
  // now: preparing ffmpeg may take time while playback continues. A released
  // decoder has reset to zero, so retain its saved playback position instead.
  const captureTime = mediaActive.value && mediaRequested.value && video.value && video.value.readyState > 0
    ? video.value.currentTime : resumeTime;
  const source = new URL(props.src, window.location.href).searchParams.get('path');
  if (!source) throw new Error('请先将原片导入项目');
  const controller = captureController = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const id = crypto.randomUUID(), path = `assets/${id}/frame.png`;
  let workspace: ReturnType<typeof files.getWorkspaceFiles> | undefined;
  let created = false, committed = false;
  capturing.value = true;
  try {
    controller.signal.throwIfAborted();
    workspace = files.getWorkspaceFiles();
    await workspace.mkdir(`assets/${id}`); created = true;
    const ffmpeg = await loadFrameFfmpeg(controller.signal);
    const result = await extractVideoFrame(ffmpeg, source, path, command, captureTime, controller.signal);
    controller.signal.throwIfAborted();
    if (findNode(node.id) !== node || !nodeTypes.value?.['remote-imageNode']) throw new Error('原节点已变化');
    const output = addFrameNode(id, path, result.width, result.height, {first:'首帧',last:'尾帧',current:'当前帧'}[command]);
    committed = true;
    return { ...output, time: result.time };
  } finally {
    try {
      if (created && !committed) await workspace!.remove(`assets/${id}`, true).catch(error => { if (error?.response?.data?.data?.code !== 'ENOENT') throw error; });
    } finally {
      signal?.removeEventListener('abort', abort);
      capturing.value = false; captureController = undefined;
    }
  }
}

</script>

<style scoped lang="scss">
.videoPlayer {
  position: relative;
  width: 100%;
  min-width: 0;
  container-type: inline-size;
  border-radius: var(--el-border-radius-base);
  background: transparent;
  cursor: grab;

  &:active { cursor: grabbing; }
  .videoPoster, .videoPreview {
    display: block;
    width: 100%;
    height: 100%;
    max-height: none;
    object-fit: contain;
    border-radius: var(--el-border-radius-base);
    pointer-events: none;

    &:fullscreen {
      height: 100%;
      max-height: none;
      border-radius: 0;
      background: #000;
      pointer-events: auto;
      cursor: default;
    }
  }
  .playbackStatus {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    padding: 5px 9px; border-radius: 8px; font-size: 12px; white-space: nowrap;
    color: #fff; background: #111b; pointer-events: none;
  }
  .retryPlayback { border: 0; cursor: pointer; pointer-events: auto; z-index: 2; }
  .playerControls {
    position: absolute;
    bottom: 4px;
    left: 4px;
    right: 4px;
    display: grid;
    grid-template-columns: 24px auto minmax(20px, 1fr) auto 24px 24px;
    grid-template-areas: "play current progress duration volume capture";
    align-items: center;
    gap: 2px 3px;
    padding: 2px 4px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--el-bg-color-overlay) 60%, transparent);
    color: var(--el-text-color-primary);
    cursor: default;
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;

    .playerButton {
      width: 24px;
      height: 24px;
      margin: 0;
      padding: 0;
      font-size: 15px;
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
    }
    .playButton { grid-area: play; }
    .volumeControl {
      grid-area: volume;
      .volumeButton { color: var(--el-text-color-regular); }
    }
    .captureMenu { grid-area: capture; }
    .currentTime, .durationLabel {
      white-space: nowrap;
      font-size: 10px;
      line-height: 16px;
      font-variant-numeric: tabular-nums;
    }
    .currentTime { grid-area: current; text-align: right; }
    .durationLabel {
      grid-area: duration;
      color: var(--el-text-color-secondary);
      .timeSeparator { display: none; }
    }
    .progressSlider {
      grid-area: progress;
      min-width: 0;
      width: calc(100% - 8px);
      justify-self: center;
      height: 16px;
      --el-slider-height: 2px;
      --el-slider-button-size: 8px;
      --el-slider-button-wrapper-size: 22px;

      :deep(.el-slider__button-wrapper) {
        top: 50%;
        display: grid;
        place-items: center;
        transform: translate(-50%, -50%);

        &::after { display: none; }
      }
    }

    @container (min-width: 320px) {
      grid-template-columns: 24px auto minmax(32px, 1fr) auto 24px 24px;
      grid-template-areas: "play current progress duration volume capture";
      gap: 6px;
      padding: 2px 4px;
      .currentTime, .durationLabel { font-size: 11px; }
      .durationLabel .timeSeparator { display: none; }
    }
    @media (prefers-reduced-motion: reduce) { transition: none; }
  }
  @media (hover: none) {
    .retryPlayback { border: 0; cursor: pointer; pointer-events: auto; z-index: 2; }
  .playerControls { opacity: 1; pointer-events: auto; }
  }
  &:hover .playerControls, .playerControls:has(:focus-visible) {
    opacity: 1;
    pointer-events: auto;
  }
}
.volumePanel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;

  .volumeValue { color: var(--el-text-color-secondary); font-size: 10px; line-height: 14px; font-variant-numeric: tabular-nums; }
  .volumeSlider {
    --el-slider-height: 2px;
    --el-slider-button-size: 8px;
    --el-slider-button-wrapper-size: 22px;

    :deep(.el-slider__button-wrapper) {
      left: 50%;
      display: grid;
      place-items: center;
      transform: translate(-50%, 50%);

      &::after { display: none; }
    }
  }
}
</style>
