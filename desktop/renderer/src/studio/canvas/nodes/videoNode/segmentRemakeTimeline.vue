<template>
  <section ref="host" class="segmentTimeline nodrag nopan nowheel" :aria-label="translate('片段重拍时间轴')" @pointerdown.stop @mousedown.stop @dblclick.stop @wheel.stop @keydown.stop="onRootKey" @contextmenu.prevent.stop>
    <div ref="lane" class="timelineLane" :class="{ unavailable: !editable }" tabindex="0" role="group" :aria-label="translate('片段重拍时间轴')" :aria-disabled="!editable" :aria-description="notice || hint" @pointerdown.prevent="begin($event, 'create')" @pointermove="move" @pointerup="finish" @pointercancel="cancelPointer" @lostpointercapture="cancelPointer" @keydown.self="onLaneKey">
      <div class="thumbnailStrip" aria-hidden="true"><span v-for="(frame, index) in frames" :key="index" :style="frame ? { backgroundImage: `url(${frame})` } : undefined" /></div>
      <div v-for="(blank, index) in blankZones" :key="`blank-${index}`" class="blankMask" :style="rangeStyle(blank)" aria-hidden="true" />
      <div v-for="(range, index) in displayRanges" :key="range.id" class="segmentRange" :class="{ selected: selectedId === range.id }" :style="rangeStyle(range)" :data-range-id="range.id" tabindex="0" role="group" :aria-label="rangeLabel(range, index)" @focus="choose(range.id)" @pointerdown.stop.prevent="begin($event, 'move', range)" @keydown.stop="onRangeKey($event, range, 'move')" @contextmenu.prevent.stop="openContextMenu($event, range)">
        <button class="edge start" type="button" role="slider" :disabled="!editable" :aria-label="translate('片段起点')" :aria-valuemin="Math.max(limits(range).start, range.end - maximum)" :aria-valuemax="round(range.end - minimum)" :aria-valuenow="range.start" :aria-valuetext="`${time(range.start)} ${translate('秒')}`" @pointerdown.stop.prevent="begin($event, 'start', range)" @keydown.stop="onRangeKey($event, range, 'start')"><span /></button>
        <span v-if="selectedId === range.id" class="rangeDuration" aria-hidden="true">{{ translate('{0}s', { 0: time(range.end - range.start) }) }}</span>
        <button class="edge end" type="button" role="slider" :disabled="!editable" :aria-label="translate('片段终点')" :aria-valuemin="round(range.start + minimum)" :aria-valuemax="Math.min(limits(range).end, range.start + maximum)" :aria-valuenow="range.end" :aria-valuetext="`${time(range.end)} ${translate('秒')}`" @pointerdown.stop.prevent="begin($event, 'end', range)" @keydown.stop="onRangeKey($event, range, 'end')"><span /></button>
      </div>
      <div v-if="length" class="playhead" :style="{ left: `${percent(currentTime || 0)}%` }" aria-hidden="true" />
    </div>
    <span class="segmentCount">{{ translate('{count}/5 个片段', { count: displayRanges.length }) }}</span>
    <span class="srOnly" role="status" aria-live="polite">{{ notice }}</span>
    <div v-if="menu && selectedRange" ref="contextMenu" class="rangeMenu" role="menu" :aria-label="rangeLabel(selectedRange, displayRanges.indexOf(selectedRange))" :style="{ left: `${menu.left}px`, top: `${menu.top}px` }" @pointerdown.stop @keydown.stop="onMenuKey">
      <button type="button" role="menuitem" :disabled="disabled" @click="seekSelected"><IconPlayerSkipForward :size="14" />{{ translate('跳转到片段') }}</button>
      <button type="button" role="menuitem" :disabled="disabled" @click="removeSelected"><IconTrash :size="14" />{{ translate('删除片段') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconPlayerSkipForward, IconTrash } from '@tabler/icons-vue';
import { translate } from '@miaoimg/i18n/vue';

type Range = { id: string; start: number; end: number };
type Mode = 'create' | 'move' | 'start' | 'end';
const props = withDefaults(defineProps<{ src: string; duration: number; ranges: Range[]; disabled?: boolean; currentTime?: number; minDuration?: number; maxDuration?: number }>(), { disabled: false, currentTime: 0, minDuration: 4.1, maxDuration: 30 });
const emit = defineEmits<{ 'update:ranges': [ranges: Range[]]; seek: [seconds: number]; select: [id: string | undefined] }>();
const host = ref<HTMLElement>();
const lane = ref<HTMLElement>();
const contextMenu = ref<HTMLElement>();
const menu = ref<{ left: number; top: number }>();
let menuReturnFocus: HTMLElement | undefined;
const selectedId = ref<string>();
const draft = ref<Range[]>();
const notice = ref('');
const frames = ref<string[]>(Array(8).fill(''));
const length = computed(() => Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0);
const minimum = computed(() => Number.isFinite(props.minDuration) && props.minDuration > 0 ? props.minDuration : 4.1);
const maximum = computed(() => Number.isFinite(props.maxDuration) && props.maxDuration > 0 ? props.maxDuration : 30);
const editable = computed(() => !props.disabled && length.value >= minimum.value && maximum.value >= minimum.value);
const sortedRanges = computed(() => props.ranges.map(range => ({ ...range })).sort((a, b) => a.start - b.start));
const displayRanges = computed(() => draft.value || sortedRanges.value);
const blankZones = computed(() => {
  const blanks: { start: number; end: number }[] = []; let cursor = 0;
  for (const range of displayRanges.value) { if (range.start > cursor) blanks.push({ start: cursor, end: range.start }); cursor = Math.max(cursor, range.end); }
  if (cursor < length.value) blanks.push({ start: cursor, end: length.value });
  return blanks;
});
const selectedRange = computed(() => displayRanges.value.find(range => range.id === selectedId.value));
const hint = computed(() => !length.value ? translate('视频时长尚未就绪') : displayRanges.value.length >= 5 ? translate('已达到片段上限') : translate('拖动空白区域添加片段'));
const fingerprint = () => JSON.stringify([props.src, props.duration, props.minDuration, props.maxDuration, props.ranges]);
let drag: { pointerId: number; mode: Mode; id: string; anchor: number; range: Range; base: Range[]; snapshot: string; previousSelection?: string } | undefined;

function round(value: number) { return Math.round(value * 1000) / 1000; }
function snap(value: number) { return Math.round(value * 10) / 10; }
function time(value: number) { return Number.isFinite(value) ? value.toFixed(1) : '0.0'; }
function clamp(value: number, min: number, max: number) { return Math.max(min, Math.min(max, value)); }
function percent(value: number) { return length.value ? clamp(value / length.value * 100, 0, 100) : 0; }
function rangeStyle(range: { start: number; end: number }) { return { left: `${percent(range.start)}%`, width: `${Math.max(0, percent(range.end) - percent(range.start))}%` }; }
function rangeLabel(range: Range, index: number) { return `${translate('片段 {number}', { number: index + 1 })} · ${time(range.start)}–${time(range.end)} ${translate('秒')}`; }
function closeMenu(restoreFocus = true) {
  if (!menu.value) return;
  menu.value = undefined;
  if (restoreFocus) {
    const target = menuReturnFocus?.isConnected ? menuReturnFocus : lane.value;
    target?.focus({ preventScroll: true });
  }
  menuReturnFocus = undefined;
}
function openContextMenu(event: MouseEvent | KeyboardEvent, range: Range) {
  if (props.disabled || !host.value || !lane.value) return;
  cancelDrag(); choose(range.id);
  const box = host.value.getBoundingClientRect(), track = lane.value.getBoundingClientRect();
  const scale = box.width / host.value.offsetWidth || 1;
  const pointer = event instanceof MouseEvent;
  const left = pointer ? (event.clientX - box.left) / scale : (track.left - box.left) / scale + (range.start + range.end) / 2 / length.value * lane.value.offsetWidth;
  const top = pointer ? (event.clientY - box.top) / scale : host.value.offsetHeight - 4;
  menuReturnFocus = event.target instanceof HTMLElement ? event.target : document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  menu.value = { left: clamp(left, 4, Math.max(4, host.value.offsetWidth - 164)), top: Math.max(4, top) };
  void nextTick(() => { if (menu.value) contextMenu.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); });
}
function seekSelected() { if (!props.disabled && selectedRange.value) { emit('seek', selectedRange.value.start); closeMenu(); } }
function onMenuKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); closeMenu(); return; }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); return; }
  if (event.key === 'Tab') { closeMenu(false); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const items = [...contextMenu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []];
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[index]?.focus({ preventScroll: true });
}
const dismissMenu = (event: PointerEvent) => { if (!(event.target instanceof Node) || !contextMenu.value?.contains(event.target)) closeMenu(false); };
onMounted(() => document.addEventListener('pointerdown', dismissMenu, true));
function choose(id?: string) { if (selectedId.value !== id) { selectedId.value = id; emit('select', id); } }
function atPointer(event: PointerEvent) { const box = lane.value?.getBoundingClientRect(); return box?.width ? clamp((event.clientX - box.left) / box.width * length.value, 0, length.value) : 0; }
function limits(range: Range, ranges = sortedRanges.value) { return { start: ranges.filter(item => item.id !== range.id && item.end <= range.start).reduce((end, item) => Math.max(end, item.end), 0), end: ranges.filter(item => item.id !== range.id && item.start >= range.end).reduce((start, item) => Math.min(start, item.start), length.value) }; }
function isValid(ranges: Range[]) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  return sorted.length <= 5 && new Set(sorted.map(range => range.id)).size === sorted.length && sorted.every((range, index) => range.id && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end <= length.value + 0.00001 && range.end - range.start >= minimum.value - 0.00001 && range.end - range.start <= maximum.value + 0.00001 && (!index || range.start >= sorted[index - 1]!.end - 0.00001));
}
function createdRange(anchor: number, ranges: Range[]): Range | undefined {
  if (ranges.length >= 5) { notice.value = translate('已达到片段上限'); return; }
  const boundaries = [0, ...ranges.flatMap(range => [range.start, range.end]), length.value];
  // Only the blank gap under the pointer can receive a new segment.
  for (let index = 0; index < boundaries.length - 1; index += 2) {
    const start = boundaries[index]!, end = boundaries[index + 1]!;
    if (anchor < start || anchor > end || end - start < minimum.value) continue;
    const duration = Math.min(5, maximum.value, end - start);
    if (duration < minimum.value) continue;
    const position = clamp(snap(snap(anchor) - duration / 2), start, end - duration);
    return { id: crypto.randomUUID(), start: round(position), end: round(position + duration) };
  }
  notice.value = translate('没有足够长的空白片段');
}
function begin(event: PointerEvent, mode: Mode, range?: Range) {
  if (!editable.value || event.button !== 0 || drag || !lane.value) return;
  closeMenu(false);
  const base = sortedRanges.value;
  if (!isValid(base)) return;
  const anchor = atPointer(event), next = range ? { ...range } : createdRange(anchor, base);
  if (!next) return;
  const previousSelection = selectedId.value;
  lane.value.setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, mode, id: next.id, anchor, range: next, base, snapshot: fingerprint(), previousSelection };
  draft.value = (mode === 'create' ? [...base, next] : base).sort((a, b) => a.start - b.start);
  choose(next.id);
  notice.value = '';
  lane.value.focus({ preventScroll: true });
}
function adjusted(range: Range, mode: Mode, delta: number, base: Range[]) {
  const bounds = limits(range, base), duration = range.end - range.start;
  if (mode === 'start') return { ...range, start: round(clamp(snap(range.start + delta), Math.max(bounds.start, range.end - maximum.value), range.end - minimum.value)) };
  if (mode === 'end') return { ...range, end: round(clamp(snap(range.end + delta), range.start + minimum.value, Math.min(bounds.end, range.start + maximum.value))) };
  const start = round(clamp(snap(range.start + delta), bounds.start, bounds.end - duration));
  return { ...range, start, end: round(start + duration) };
}
function move(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!editable.value || drag.snapshot !== fingerprint()) { cancelDrag(); return; }
  const mode = drag.mode === 'create' ? 'move' : drag.mode;
  const next = adjusted(drag.range, mode, atPointer(event) - drag.anchor, drag.base);
  draft.value = [...drag.base.filter(range => range.id !== drag!.id), next].sort((a, b) => a.start - b.start);
}
function release(pointerId: number) { if (lane.value?.hasPointerCapture(pointerId)) lane.value.releasePointerCapture(pointerId); }
function finish(event: PointerEvent) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const current = drag, result = draft.value;
  drag = undefined; draft.value = undefined; release(current.pointerId);
  if (editable.value && current.snapshot === fingerprint() && result && isValid(result)) emit('update:ranges', result.map(range => ({ ...range })));
  else choose(current.previousSelection);
}
function cancelDrag() {
  if (!drag) return;
  const current = drag; drag = undefined; draft.value = undefined; release(current.pointerId); choose(current.previousSelection);
}
function cancelPointer(event: PointerEvent) { if (drag?.pointerId === event.pointerId) cancelDrag(); }
function removeSelected() {
  if (props.disabled || !selectedId.value) return;
  const id = selectedId.value;
  cancelDrag();
  const next = props.ranges.filter(range => range.id !== id).map(range => ({ ...range }));
  emit('update:ranges', next); choose(undefined); notice.value = ''; closeMenu(false); lane.value?.focus({ preventScroll: true });
}
function onRootKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); if (menu.value) closeMenu(); else if (drag) cancelDrag(); else choose(undefined); }
  else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedRange.value) { event.preventDefault(); removeSelected(); }
}
function onLaneKey(event: KeyboardEvent) {
  if ((event.key !== 'Enter' && event.key !== ' ') || !editable.value || drag) return;
  event.preventDefault();
  const range = createdRange(clamp(props.currentTime, 0, length.value), sortedRanges.value);
  if (range) { const next = [...sortedRanges.value, range].sort((a, b) => a.start - b.start); if (isValid(next)) { emit('update:ranges', next); choose(range.id); notice.value = ''; } }
}
function onRangeKey(event: KeyboardEvent, range: Range, mode: Mode) {
  // @keydown.stop keeps canvas shortcuts away even for unhandled keys.
  if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); openContextMenu(event, range); return; }
  if (event.key === 'Escape' || event.key === 'Delete' || event.key === 'Backspace') { onRootKey(event); return; }
  if (props.disabled || !editable.value || drag) return;
  choose(range.id);
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); emit('seek', range.start); return; }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const bounds = limits(range), step = event.shiftKey ? 1 : 0.1;
  const delta = event.key === 'Home' ? bounds.start - range.start : event.key === 'End' ? bounds.end - range.end : event.key === 'ArrowLeft' ? -step : step;
  const next = adjusted(range, mode, delta, sortedRanges.value);
  const result = sortedRanges.value.map(item => item.id === range.id ? next : item);
  if (isValid(result)) emit('update:ranges', result);
}
watch(() => [props.src, props.duration, props.minDuration, props.maxDuration, props.disabled, JSON.stringify(props.ranges)], () => {
  cancelDrag(); closeMenu(false); notice.value = '';
  if (selectedId.value && !props.ranges.some(range => range.id === selectedId.value)) choose(undefined);
}, { flush: 'sync' });

// Use a separate muted decoder; never seek or replace the original preview.
watch(() => [props.src, length.value, props.disabled] as const, ([src, duration, disabled], _, onCleanup) => {
  frames.value = Array(8).fill('');
  if (!src || !duration || disabled) return;
  let url: URL;
  try { url = new URL(src, location.href); } catch { return; }
  if (url.origin !== location.origin || !['http:', 'https:', 'blob:', 'file:'].includes(url.protocol)) return;
  const abort = new AbortController(), video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const releaseVideo = () => { video.pause(); video.removeAttribute('src'); video.load(); };
  onCleanup(() => { abort.abort(); releaseVideo(); });
  function waitFor(event: string, action?: () => void) {
    return new Promise<void>((resolve, reject) => {
      const done = () => { cleanup(); resolve(); }, fail = () => { cleanup(); reject(new Error('thumbnail unavailable')); };
      const timer = window.setTimeout(fail, 2500);
      const cleanup = () => { clearTimeout(timer); video.removeEventListener(event, done); video.removeEventListener('error', fail); abort.signal.removeEventListener('abort', fail); };
      video.addEventListener(event, done, { once: true }); video.addEventListener('error', fail, { once: true }); abort.signal.addEventListener('abort', fail, { once: true });
      if (abort.signal.aborted) fail(); else { try { action?.(); } catch { fail(); } }
    });
  }
  void (async () => {
    await waitFor('loadeddata', () => { video.src = url.href; video.load(); });
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 72;
    const context = canvas.getContext('2d'); if (!context || !video.videoWidth || !video.videoHeight) return;
    for (let index = 0; index < 8; index++) {
      abort.signal.throwIfAborted();
      const target = Math.max(0, Math.min(duration * (index + 0.5) / 8, video.duration - 0.01));
      if (Math.abs(video.currentTime - target) > 0.005) await waitFor('seeked', () => { video.currentTime = target; });
      abort.signal.throwIfAborted();
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight), w = video.videoWidth * scale, h = video.videoHeight * scale;
      context.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      const frame = canvas.toDataURL('image/jpeg', 0.65);
      abort.signal.throwIfAborted(); frames.value[index] = frame;
    }
  })().catch(() => { /* Local decoding/CORS failures retain the quiet placeholder strip. */ }).finally(releaseVideo);
}, { immediate: true });
onBeforeUnmount(() => { cancelDrag(); closeMenu(false); document.removeEventListener('pointerdown', dismissMenu, true); });
</script>

<style scoped>
.segmentTimeline{position:relative;display:flex;align-items:center;gap:16px;width:100%;min-width:0;box-sizing:border-box;padding:4px 20px 4px 4px;border-radius:12px;background:var(--el-fill-color-dark,#262626);color:var(--el-text-color-secondary);font-size:12px;line-height:16px;user-select:none}
.timelineLane{position:relative;flex:1;min-width:0;height:48px;border-radius:8px;background:#000;touch-action:none;cursor:crosshair;isolation:isolate;outline-offset:2px}
.timelineLane.unavailable{cursor:default}
.thumbnailStrip{position:absolute;inset:0;display:flex;overflow:hidden;border-radius:8px;pointer-events:none}
.thumbnailStrip span{flex:1;min-width:0;background-position:center;background-size:cover;background-color:#000}
.blankMask{position:absolute;inset-block:0;background:rgba(0,0,0,.65);pointer-events:none}
.segmentRange{position:absolute;inset-block:0;min-width:0;box-sizing:border-box;border:2px solid var(--el-color-primary,#409eff);border-radius:8px;background:transparent;cursor:grab;touch-action:none;color:white;z-index:1;outline-offset:2px}
.segmentRange.selected{z-index:2}
.segmentRange:active{cursor:grabbing}
.rangeDuration{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:3px 8px;border-radius:4px;background:rgba(0,0,0,.85);color:#fff;font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}
.edge{position:absolute;top:-2px;bottom:-2px;width:12px;padding:0;border:0;background:var(--el-color-primary,#409eff);color:white;cursor:ew-resize;touch-action:none;z-index:1}
.edge.start{left:-2px;border-radius:8px 0 0 8px}
.edge.end{right:-2px;border-radius:0 8px 8px 0}
.edge span{display:block;width:2px;height:16px;margin:auto;border-radius:1px;background:#fff}
.edge:disabled{cursor:default}
.playhead{position:absolute;inset-block:0;width:2px;background:white;pointer-events:none;z-index:3;transform:translateX(-1px)}
.segmentCount{flex-shrink:0;white-space:nowrap;text-align:center;font-variant-numeric:tabular-nums}
.rangeMenu{position:absolute;z-index:20;width:160px;max-width:calc(100% - 8px);box-sizing:border-box;padding:4px;border:1px solid var(--el-border-color);border-radius:8px;background:var(--el-bg-color-overlay);color:var(--el-text-color-regular);box-shadow:var(--el-box-shadow-light)}
.rangeMenu button{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;white-space:nowrap;cursor:pointer}
.rangeMenu button:hover,.rangeMenu button:focus-visible{background:var(--el-fill-color);outline:none}
.rangeMenu button:disabled{opacity:.4;cursor:default}
.segmentTimeline button:focus-visible,.segmentRange:focus-visible,.timelineLane:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:2px}
.srOnly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
@media(max-width:360px){.segmentTimeline{gap:10px;padding-right:12px}.rangeDuration{padding-inline:5px}}
</style>
