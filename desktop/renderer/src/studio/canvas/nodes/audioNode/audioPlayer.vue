<template>
  <div class="audioPlayer" @keydown.stop>
    <audio ref="audio" :src="src" preload="auto" :aria-label="label" @loadedmetadata="readMetadata" @durationchange="readDuration" @timeupdate="readTime" @play="startProgress(); emit('play')" @pause="stopProgress" @ended="stopProgress" @volumechange="readVolume" @error="mediaError" />
    <div class="waveformPanel" :class="{ unavailable: !duration || failed }">
      <div class="waveformTrack">
        <slot name="track" :duration="duration" :currentTime="currentTime" :peaks="peaks">
          <template v-if="peaks.length">
            <svg v-for="played in [false, true]" :key="String(played)" class="waveform" :class="{ played }" :style="played ? { clipPath: `inset(0 ${100 - progress}% 0 0)` } : undefined" viewBox="0 0 512 100" preserveAspectRatio="none" aria-hidden="true">
              <rect v-for="(peak, index) in peaks" :key="index" :x="index * 4 + 1" :y="50 - Math.max(2, peak * 78) / 2" width="2" :height="Math.max(2, peak * 78)" rx="1" />
            </svg>
          </template>
          <span v-else class="waveformStatus">{{ failed ? translate('无法播放音频') : waveformLoading ? translate('正在读取波形…') : translate('当前音频无法显示波形') }}</span>
          <span v-if="duration && !failed" class="playhead" :style="{ left: `${progress}%` }" aria-hidden="true" />
          <input
            class="seekInput nodrag nopan nowheel"
            type="range"
            min="0"
            :max="duration || 1"
            step="0.01"
            :value="currentTime"
            :disabled="!duration || failed"
            :aria-label="translate('音频播放进度')"
            :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
            @pointerdown.stop
            @mousedown.stop
            @dblclick.stop
            @input="seek"
            @keydown.space.prevent="togglePlayback" />
        </slot>
      </div>
    </div>
    <div class="playerControls">
      <el-button class="playButton nodrag nopan nowheel" :icon="playing ? IconPlayerPause : IconPlayerPlay" :disabled="!duration || failed" circle :aria-label="playing ? translate('暂停音频') : translate('播放音频')" :title="playing ? translate('暂停') : translate('播放')" @pointerdown.stop @mousedown.stop @dblclick.stop @click="togglePlayback" />
      <span class="timeLabel"><slot name="time"><span>{{ formatTime(currentTime) }}</span><span class="timeSeparator">/</span>{{ formatTime(duration) }}</slot></span>
      <div class="volumeControl nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop>
        <el-button class="volumeButton" :icon="muted || !volume ? IconVolumeOff : IconVolume" text circle :disabled="failed" :aria-label="muted || !volume ? translate('取消静音') : translate('静音音频')" :title="muted || !volume ? translate('取消静音') : translate('静音')" :aria-pressed="muted || !volume" @click="toggleMute" />
        <input class="volumeInput" type="range" min="0" max="100" :value="muted ? 0 : volume" :disabled="failed" :aria-label="translate('音频音量')" @input="setVolume" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMediaPlaybackTools } from "../../scaffold/useMediaPlaybackTools";
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { ElButton, ElMessage } from "element-plus";
import { IconPlayerPlay, IconPlayerPause, IconVolume, IconVolumeOff } from "@tabler/icons-vue";
import { getWaveformPeaks } from "./audioWaveform";
import { translate } from "@miaoimg/i18n/vue";

const props = withDefaults(defineProps<{ src: string; label?: string; registerPlaybackTools?: boolean }>(), { registerPlaybackTools: true });
// 节点名是画布数据：展示时按当前语言兜底，写进画布（新建节点名）仍用中文原文。
const label = computed(() => props.label || translate("节点音频"));
const emit = defineEmits<{ loadedmetadata: [event: Event]; play: [] }>();
const audio = ref<HTMLAudioElement>();
// 剪辑窗口的试听播放器不接管画布节点的控制工具。
if (props.registerPlaybackTools !== false) useMediaPlaybackTools(() => audio.value);
const peaks = shallowRef<number[]>([]);
const waveformLoading = ref(false);
const currentTime = ref(0);
const duration = ref(0);
const playing = ref(false);
const failed = ref(false);
const volume = ref(100);
const muted = ref(false);
const progress = computed(() => duration.value ? Math.min(100, Math.max(0, currentTime.value / duration.value * 100)) : 0);
let animationFrame = 0;
let disposed = false;

watch(() => props.src, async (value, _previous, onCleanup) => {
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  audio.value?.pause();
  stopProgress();
  currentTime.value = duration.value = 0;
  failed.value = false;
  peaks.value = [];
  waveformLoading.value = true;
  try {
    const source = new URL(value, window.location.href);
    if (window.miaoDesktop && source.origin === window.location.origin && source.pathname === "/api/imagine/workspace/files") {
      source.searchParams.set("waveform", "1");
      const response = await fetch(source.href, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(translate("无法读取音频"));
      const data = await response.json() as { peaks?: unknown };
      controller.signal.throwIfAborted();
      if (!Array.isArray(data.peaks) || data.peaks.length !== 128 || data.peaks.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(translate("无法读取音频"));
      peaks.value = data.peaks;
      return;
    }
    const response = await fetch(value, { signal: controller.signal });
    if (!response.ok) throw new Error(translate("无法读取音频"));
    const content = await response.arrayBuffer();
    controller.signal.throwIfAborted();
    // 非桌面工作区来源沿用浏览器解码；本机工作区仅读取流式提取的峰值。
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(content);
    controller.signal.throwIfAborted();
    peaks.value = getWaveformPeaks(Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index)));
  } catch {
    // ACT: 浏览器能播放但不能解码的格式仍保留播放和定位，波形区域提示不可用。
  } finally {
    if (!controller.signal.aborted) waveformLoading.value = false;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
  audio.value?.pause();
  stopProgress();
});

function formatTime(value: number) {
  const seconds = Math.floor(Number.isFinite(value) ? Math.max(0, value) : 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readDuration() {
  const value = audio.value?.duration ?? 0;
  duration.value = Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readMetadata(event: Event) {
  readDuration();
  emit("loadedmetadata", event);
}

function readTime() {
  currentTime.value = audio.value?.currentTime ?? 0;
}

function updateProgress() {
  readTime();
  animationFrame = requestAnimationFrame(updateProgress);
}

function startProgress() {
  cancelAnimationFrame(animationFrame);
  playing.value = true;
  updateProgress();
}

function stopProgress() {
  cancelAnimationFrame(animationFrame);
  playing.value = false;
  readTime();
}

async function togglePlayback() {
  const element = audio.value;
  if (!element || !duration.value || failed.value) return;
  if (!element.paused) return element.pause();
  try { await element.play(); }
  catch (error) {
    if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) ElMessage.error(translate("音频播放失败"));
  }
}

function seek(event: Event) {
  seekTo((event.target as HTMLInputElement).valueAsNumber);
}

function seekTo(value: number) {
  if (!audio.value || !duration.value) return;
  if (!Number.isFinite(value)) return;
  audio.value.currentTime = Math.min(duration.value, Math.max(0, value));
  readTime();
}

function pause() {
  audio.value?.pause();
}

defineExpose({ duration, currentTime, playing, seekTo, pause });

function readVolume() {
  volume.value = Math.round((audio.value?.volume ?? 1) * 100);
  muted.value = audio.value?.muted ?? false;
}

function setVolume(event: Event) {
  if (!audio.value) return;
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (!Number.isFinite(value)) return;
  audio.value.volume = Math.min(100, Math.max(0, value)) / 100;
  audio.value.muted = value === 0;
}

function toggleMute() {
  if (!audio.value) return;
  if (!audio.value.volume) audio.value.volume = 1;
  audio.value.muted = !(muted.value || !volume.value);
}

function mediaError() {
  failed.value = true;
  stopProgress();
}
</script>

<style scoped lang="scss">
.audioPlayer {
  width: 100%;
  min-width: 0;
  color: var(--el-text-color-primary);

  audio { display: none; }
  .waveformPanel {
    padding: 10px 14px;
    border-radius: var(--el-border-radius-base);
    background: var(--miaoimg-glass-inset);
    &.unavailable { opacity: 0.65; }

    .waveformTrack {
      position: relative;
      height: 96px;
      .waveform { position: absolute; inset: 0; width: 100%; height: 100%; fill: var(--el-text-color-placeholder); &.played { fill: var(--el-color-primary); } }
      .waveformStatus { position: absolute; inset: 0; display: grid; place-items: center; font-size: 12px; color: var(--el-text-color-secondary); }
      .playhead {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        transform: translateX(-50%);
        background: var(--el-color-primary);
        pointer-events: none;
        &::before { content: ""; position: absolute; top: 0; left: 50%; width: 8px; height: 8px; border-radius: 3px; background: inherit; transform: translate(-50%, -2px); }
      }
      .seekInput {
        position: absolute;
        inset: 0 -6px;
        width: calc(100% + 12px);
        height: 100%;
        margin: 0;
        opacity: 0;
        appearance: none;
        // ACT: 只让位置线附近的滑块接收拖动，波形其余区域交给节点拖拽。
        pointer-events: none;
        touch-action: none;
        &::-webkit-slider-thumb { appearance: none; width: 12px; height: 96px; pointer-events: auto; cursor: ew-resize; }
        &::-moz-range-thumb { width: 12px; height: 96px; border: 0; pointer-events: auto; cursor: ew-resize; }
        &:disabled::-webkit-slider-thumb { pointer-events: none; }
        &:disabled::-moz-range-thumb { pointer-events: none; }
      }
      &:has(.seekInput:focus-visible) { outline: 2px solid var(--el-color-primary); outline-offset: 5px; border-radius: 3px; }
    }
  }
  .playerControls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 2px 0;
    .playButton { width: 30px; height: 30px; color: var(--el-color-primary); border-color: var(--el-color-primary-light-8); background: var(--el-color-primary-light-9); }
    .timeLabel { display: flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--el-text-color-secondary); > span:first-child { color: var(--el-text-color-primary); } .timeSeparator { opacity: 0.5; } }
    .volumeControl {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      .volumeButton { width: 26px; height: 26px; padding: 4px; }
      .volumeInput { width: 56px; height: 16px; margin: 0; cursor: pointer; accent-color: var(--el-color-primary); }
    }
  }
}
</style>
