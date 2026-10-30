<template>
  <div class="localSettings">
    <template v-if="action === 'crop'">
      <div ref="stage" class="cropStage" :style="geometry ? { maxWidth: `${Math.min(700, 260 * geometry.displayRatio)}px`, aspectRatio: geometry.displayRatio } : {}" @pointerdown.prevent="begin($event, 'draw')" @pointermove="move" @pointerup="finish" @pointercancel="finish" @lostpointercapture="finish">
        <video ref="preview" :src="workspacePlaybackUrl(src)" preload="metadata" playsinline @timeupdate="time = preview?.currentTime || 0" />
        <div v-if="crop && geometry" class="cropRegion" :style="cropStyle" tabindex="0" role="group" :aria-label="translate('裁剪选区')" @pointerdown.stop.prevent="begin($event, 'move')" @keydown="nudge($event, false)">
          <button class="resizeHandle" type="button" :disabled="disabled" :aria-label="translate('调整裁剪选区大小')" @pointerdown.stop.prevent="begin($event, 'resize')" @keydown.stop="nudge($event, true)" />
        </div>
      </div>
      <div class="previewControls"><el-button :disabled="!ready || disabled" @click="toggle">{{ translate('播放或暂停预览') }}</el-button><el-slider v-model="time" :min="0" :max="duration || 1" :step="0.01" :disabled="!ready || disabled" :aria-label="translate('预览时间')" @input="seek" /></div>
      <div class="pixelControls">
        <el-select v-model="ratio" :disabled="!geometry || disabled" :aria-label="translate('裁剪比例')" @change="setRatio"><el-option v-for="value in ratios" :key="value" :value="value" :label="value === 'free' ? translate('自由比例') : value === 'original' ? translate('原始比例') : value" :disabled="Boolean(geometry && !aspectCrop(value, geometry))" /></el-select>
        <template v-if="ready && geometry && crop"><label v-for="key in (['x','y','width','height'] as const)" :key="key"><span>{{ translate(pixelLabels[key]) }}</span><el-input-number v-number-aria :model-value="crop?.[key]" :min="key === 'x' || key === 'y' ? 0 : 2" :step="2" step-strictly :max="pixelMax(key)" :precision="0" :disabled="!geometry || disabled" controls-position="right" @update:model-value="value => setPixel(key, value)" /></label></template>
      </div>
    </template>
    <template v-else>
      <video ref="preview" class="speedPreview" :src="workspacePlaybackUrl(src)" controls playsinline preload="metadata" @loadedmetadata="setPlaybackRate" />
      <label class="speedControl"><span>{{ translate('变速倍数') }}</span><el-slider v-model="speed" :min="0.1" :max="4" :step="0.1" :disabled="disabled" :format-tooltip="value => `${value.toFixed(2)}×`" /><el-input-number v-number-aria v-model="speed" :min="0.1" :max="4" :precision="2" :step="0.1" :disabled="disabled" /></label>
    </template>
    <p v-if="error" class="localError" role="alert">{{ error }}</p>
    <div v-if="loading" role="status">{{ translate('正在读取视频信息…') }}</div>
  </div>
</template>
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { vNumberAria } from "../../numberInputAria";
import { ElButton, ElInputNumber, ElOption, ElSelect, ElSlider } from "element-plus";
import { translate } from "@miaoimg/i18n/vue";
import { useNodeFfmpeg, useNodeFiles, type NodeMediaValue } from "@miaoimg/nodes-scaffold/runtime";
import { publicError } from "@/lib/publicError";
import { workspacePlaybackUrl } from "@/lib/workspaceFiles";
import { aspectCrop, normalizedCrop, videoGeometry, type PixelCrop, type VideoGeometry } from "./videoLocalGeometry";
const props = defineProps<{ action: "crop" | "speed"; file?: NodeMediaValue; src: string; disabled?: boolean }>();
const crop = defineModel<PixelCrop>("crop"), speed = defineModel<number>("speed", { required: true });
const preview = ref<HTMLVideoElement>(), stage = ref<HTMLDivElement>(), geometry = ref<VideoGeometry>(), ready = ref(false), loading = ref(false), error = ref(""), time = ref(0), duration = ref(0), ratio = ref("original");
const files = useNodeFiles(), revision = ref("");
const load = useNodeFfmpeg(), getCanvasSignal = inject<(() => AbortSignal) | undefined>("canvasOperationSignal", undefined);
const ratios = ["free","original","16:9","9:16","1:1","4:3","3:4"];
const pixelLabels = { x:"横向位置", y:"纵向位置", width:"裁剪宽度", height:"裁剪高度" };
let controller: AbortController | undefined, job: Promise<unknown> | undefined;
let drag: { id: number; mode: "move" | "resize" | "draw"; x: number; y: number; crop: PixelCrop } | undefined;
const valid = computed(() => ready.value && !error.value && (props.action === "speed" ? Number.isFinite(speed.value) && speed.value >= 0.1 && speed.value <= 4 : Boolean(crop.value && geometry.value && JSON.stringify(normalizedCrop(crop.value, geometry.value)) === JSON.stringify(crop.value))));
const cropStyle = computed(() => crop.value && geometry.value ? { left:`${crop.value.x / geometry.value.width * 100}%`,top:`${crop.value.y / geometry.value.height * 100}%`,width:`${crop.value.width / geometry.value.width * 100}%`,height:`${crop.value.height / geometry.value.height * 100}%` } : {});
watch(() => [props.file?.url, props.action], () => {
  controller?.abort(); controller = new AbortController(); const current = controller;
  const canvas = getCanvasSignal?.(), signal = AbortSignal.any([current.signal,...(canvas ? [canvas] : [])]);
  ready.value = false; revision.value=""; error.value = ""; loading.value = true; geometry.value = undefined;
  job = (async () => {
    if (!props.file) return;
    const workspace = files.getWorkspaceFiles(), original = await workspace.stat?.(props.file.url,signal);
    const ffmpeg = await load(signal), command = ffmpeg(props.file.url), cancel = () => command.kill();
    signal.addEventListener("abort",cancel,{once:true});
    try {
      const data = await new Promise<any>((resolve,reject)=>command.ffprobe((failure,value)=>failure?reject(failure):resolve(value)));
      signal.throwIfAborted();
      const stream = data.streams.find((item:any)=>item.codec_type === "video" && !item.disposition?.attached_pic);
      if (!stream) throw new Error(translate("文件不包含视频画面"));
      duration.value = Number(data.format.duration || stream.duration);
      if (!(duration.value > 0) || !Number.isFinite(duration.value)) throw new Error(translate("无法读取有效的视频时长"));
      if (props.action === "crop") { geometry.value = videoGeometry(stream); crop.value = aspectCrop("original",geometry.value); ratio.value = "original"; }
      const latest = original ? await workspace.stat?.(props.file!.url,signal) : undefined;
      signal.throwIfAborted();
      if (original?.revision !== latest?.revision) throw new Error(translate("原视频已变化，请重新处理"));
      revision.value=original?.revision || ""; ready.value = true; setPlaybackRate();
    } finally { signal.removeEventListener("abort",cancel); }
  })().catch(failure=>{if(!signal.aborted)error.value=publicError(failure);}).finally(()=>{if(current===controller)loading.value=false;});
}, { immediate:true });
watch(speed, setPlaybackRate);
onBeforeUnmount(()=>{controller?.abort();preview.value?.pause();});
function setPlaybackRate() { if(preview.value && props.action === "speed" && Number.isFinite(speed.value) && speed.value>=0.1 && speed.value<=4) {preview.value.playbackRate=speed.value;preview.value.preservesPitch=true;} }
function toggle(){if(preview.value)preview.value.paused?void preview.value.play().catch(()=>{}):preview.value.pause();}
function seek(value:number|number[]){if(preview.value && typeof value === "number")preview.value.currentTime=value;}
function setRatio(){if(geometry.value){crop.value=aspectCrop(ratio.value,geometry.value);error.value="";}}
function pixelMax(key:keyof PixelCrop){if(!geometry.value||!crop.value)return 2;const value=key==='x'?geometry.value.width-crop.value.width:key==='y'?geometry.value.height-crop.value.height:key==='width'?geometry.value.width-crop.value.x:geometry.value.height-crop.value.y;return Math.floor(value/2)*2;}
function setPixel(key:keyof PixelCrop,value:number|undefined){if(!Number.isFinite(value)){error.value=translate("裁剪坐标必须为有效数字");return;}if(crop.value&&geometry.value){ratio.value="free";crop.value=normalizedCrop({...crop.value,[key]:value},geometry.value);error.value="";}}
function begin(event:PointerEvent, mode:"move"|"resize"|"draw"){
  if(props.disabled||!geometry.value||!crop.value||!stage.value||event.button!==0)return;
  stage.value.setPointerCapture(event.pointerId);drag={id:event.pointerId,mode,x:event.clientX,y:event.clientY,crop:{...crop.value}};
  if(mode==='draw')ratio.value='free';
}
function move(event:PointerEvent){
  if(!drag||drag.id!==event.pointerId||!stage.value||!geometry.value)return;
  const box=stage.value.getBoundingClientRect(),g=geometry.value,dx=(event.clientX-drag.x)/box.width*g.width,dy=(event.clientY-drag.y)/box.height*g.height;
  if(drag.mode==='move')crop.value=normalizedCrop({...drag.crop,x:Math.max(0,Math.min(g.width-drag.crop.width,drag.crop.x+dx)),y:Math.max(0,Math.min(g.height-drag.crop.height,drag.crop.y+dy))},g);
  else if(drag.mode==='draw'){
    const x=(drag.x-box.left)/box.width*g.width,y=(drag.y-box.top)/box.height*g.height;
    crop.value=normalizedCrop({x:Math.min(x,x+dx),y:Math.min(y,y+dy),width:Math.abs(dx),height:Math.abs(dy)},g);
  }else{
    const fit=aspectCrop(ratio.value,{...g,width:Math.max(2,Math.min(g.width-drag.crop.x,drag.crop.width+dx)),height:Math.max(2,Math.min(g.height-drag.crop.y,drag.crop.height+dy))});
    if(fit)crop.value=normalizedCrop({...drag.crop,width:fit.width,height:fit.height},g);
    if(ratio.value==='original')ratio.value='free';
  }
  error.value="";
}
function finish(event:PointerEvent){if(drag?.id===event.pointerId){drag=undefined;if(stage.value?.hasPointerCapture(event.pointerId))stage.value.releasePointerCapture(event.pointerId);}}
function nudge(event:KeyboardEvent,resize:boolean){if(!crop.value||!geometry.value||props.disabled||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?10:2,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;crop.value=normalizedCrop({...crop.value,...(resize?{width:crop.value.width+dx,height:crop.value.height+dy}:{x:Math.max(0,Math.min(geometry.value.width-crop.value.width,crop.value.x+dx)),y:Math.max(0,Math.min(geometry.value.height-crop.value.height,crop.value.y+dy))})},geometry.value);if(resize)ratio.value='free';}
defineExpose({valid,revision,pause:()=>preview.value?.pause(),cancelAndWait:async()=>{controller?.abort();await job;}});
</script>
<style scoped>
.cropStage{position:relative;margin:auto;width:100%;overflow:hidden;background:#111;border-radius:6px;touch-action:none}.cropStage video{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:fill;pointer-events:none}.cropRegion{position:absolute;border:2px solid #fff;box-sizing:border-box;box-shadow:0 0 0 2000px #0008;cursor:move}.cropRegion:focus{outline:2px solid var(--el-color-primary)}.resizeHandle{position:absolute;right:-6px;bottom:-6px;width:14px;height:14px;border:1px solid #222;background:white;cursor:nwse-resize}.pixelControls{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:12px 0}.pixelControls>label{display:grid;font-size:12px;gap:4px}.pixelControls :deep(.el-input-number){width:112px}.pixelControls :deep(.el-select){width:125px}.previewControls,.speedControl{display:flex;align-items:center;gap:14px;margin:12px 0}.previewControls :deep(.el-slider),.speedControl :deep(.el-slider){flex:1}.speedPreview{display:block;width:100%;max-height:280px;background:#111}.localError{color:var(--el-color-danger);font-size:13px}
</style>
