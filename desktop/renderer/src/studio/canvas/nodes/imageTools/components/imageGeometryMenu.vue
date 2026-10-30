<template>
  <el-dropdown trigger="click" :disabled="disabled || controller.busy" @command="id => controller.open(String(id))">
    <el-button text :icon="IconCrop" :disabled="disabled || controller.busy" :title="translate('裁剪与旋转')" :aria-label="translate('裁剪与旋转')" @click.stop />
    <template #dropdown><el-dropdown-menu><el-dropdown-item v-for="tool in imageGeometryActions" :key="tool.id" :command="tool.id">{{ translate(tool.label) }}</el-dropdown-item></el-dropdown-menu></template>
  </el-dropdown>
  <el-dialog v-model="controller.state.visible" :title="translate('裁剪与旋转')" width="min(720px, calc(100vw - 32px))" appendToBody :closeOnClickModal="false" :closeOnPressEscape="!controller.state.saving" :showClose="!controller.state.saving" @close="controller.close">
    <div v-loading="controller.state.loading" class="geometryForm nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @keydown.stop>
      <div class="geometryHeading"><el-radio-group v-model="controller.state.intent" :disabled="disabled || controller.busy" @change="reset"><el-radio-button v-for="tool in imageGeometryActions" :key="tool.id" :value="tool.id">{{ translate(tool.label) }}</el-radio-button></el-radio-group>
        <el-tooltip placement="top" :content="translate('读取原图并按显示方向处理，另存为PNG图片节点，不调用模型。保留原图和透明通道；动画只处理首帧，色彩与元数据可能变化。')"><el-button text :icon="IconInfoCircle" :aria-label="translate('操作说明')" /></el-tooltip>
      </div>
      <div v-if="controller.state.preview" class="previewHost">
        <div ref="imageArea" class="geometryImage" :class="{ cropMode: cropMode }" :style="{ aspectRatio: previewRatio, width: `min(100%, calc(min(42vh, 420px) * ${previewRatio}))` }" @pointerdown="startDrag" @pointermove="moveDrag" @pointerup="finishDrag" @pointercancel="finishDrag">
          <img :src="controller.state.preview" :alt="translate('图片处理预览')" draggable="false" />
          <div v-if="cropMode" class="cropRect" :style="cropStyle" data-crop="move"><span>{{ s.crop.width }} × {{ s.crop.height }}</span><button type="button" class="resizeHandle" data-crop="resize" :aria-label="translate('调整裁剪范围')" /></div>
        </div>
      </div>
      <template v-if="cropMode">
        <label class="ratioField">{{ translate('裁剪比例') }}<el-select v-model="s.ratio" :disabled="disabled || controller.busy" @change="controller.chooseRatio"><el-option v-for="ratio in ['free', '1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']" :key="ratio" :value="ratio" :label="ratio === 'free' ? translate('自由裁剪') : ratio" /></el-select></label>
        <div v-if="dimensionsReady" class="pixelFields"><label v-for="field in pixelFields" :key="field.key">{{ translate(field.label) }}<el-input-number v-number-aria v-model="s.crop[field.key]" :min="field.key === 'x' || field.key === 'y' ? 0 : 1" :max="pixelMaximum(field.key)" :precision="0" :disabled="disabled || controller.busy" controlsPosition="right" @change="s.ratio = 'free'" /></label></div>
      </template>
      <el-radio-group v-else-if="s.intent === 'image:rotate'" v-model="s.turns" :disabled="disabled || controller.busy"><el-radio-button v-for="turns in [1, 2, 3]" :key="turns" :value="turns">{{ turns * 90 }}°</el-radio-button></el-radio-group>
      <div v-else class="mirrorFields"><el-checkbox v-model="s.flipX" :disabled="disabled || controller.busy">{{ translate('水平镜像') }}</el-checkbox><el-checkbox v-model="s.flipY" :disabled="disabled || controller.busy">{{ translate('垂直镜像') }}</el-checkbox></div>
      <div class="pixelSummary">{{ translate('原图像素') }} {{ s.width }} × {{ s.height }}</div>
    </div>
    <template #footer><el-button :disabled="s.saving" @click="controller.close">{{ translate('取消') }}</el-button><el-button type="primary" :loading="s.saving" :disabled="disabled || controller.busy || !controller.valid" @click="controller.save">{{ translate('另存为图片节点') }}</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, ref } from "vue";
import { vNumberAria } from "../../../numberInputAria";
import { ElButton, ElCheckbox, ElDialog, ElDropdown, ElDropdownMenu, ElDropdownItem, ElInputNumber, ElOption, ElRadioButton, ElRadioGroup, ElSelect, ElTooltip, ElLoading } from "element-plus";
import { IconCrop, IconInfoCircle } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { imageGeometryActions } from "../imageGeometryCatalogue";
import { dragCrop, fitCrop, pixelPoint, type PixelRect } from "../imageGeometry";
import type { useImageGeometryActions } from "../useImageGeometryActions";
const props = defineProps<{ controller: ReturnType<typeof useImageGeometryActions>; disabled?: boolean }>();
const s = props.controller.state, imageArea = ref<HTMLElement>();
const vLoading = ElLoading.directive;
const pixelFields = [{ key: "x", label: "左侧像素" }, { key: "y", label: "顶部像素" }, { key: "width", label: "宽度像素" }, { key: "height", label: "高度像素" }] as const;
const cropMode = computed(() => s.intent === "image:crop");
const dimensionsReady = computed(() => !s.loading && [s.width, s.height].every(value => Number.isSafeInteger(value) && value > 0));
function pixelMaximum(key: typeof pixelFields[number]["key"]) {
  const minimum = key === "x" || key === "y" ? 0 : 1;
  const remaining = key === "x" ? s.width - s.crop.width : key === "y" ? s.height - s.crop.height : key === "width" ? s.width - s.crop.x : s.height - s.crop.y;
  return Math.max(minimum, Number.isFinite(remaining) ? remaining : minimum);
}
const previewRatio = computed(() => s.intent === "image:rotate" && s.turns % 2 ? s.height / s.width : s.width / s.height);
const cropStyle = computed(() => ({ left: `${s.crop.x / s.width * 100}%`, top: `${s.crop.y / s.height * 100}%`, width: `${s.crop.width / s.width * 100}%`, height: `${s.crop.height / s.height * 100}%` }));
let drag: { pointer: number; mode: string; start: { x: number; y: number }; rect: PixelRect } | undefined;
function reset() { s.crop = fitCrop(s.width, s.height, 0); s.ratio = "free"; s.turns = s.intent === "image:rotate" ? 1 : 0; s.flipX = s.intent === "image:mirror"; s.flipY = false; }
function point(event: PointerEvent) { return pixelPoint(event.clientX, event.clientY, imageArea.value!.getBoundingClientRect(), s.width, s.height); }
function startDrag(event: PointerEvent) {
  if (!cropMode.value || props.disabled || props.controller.busy || !imageArea.value || event.button !== 0) return;
  event.preventDefault();
  drag = { pointer: event.pointerId, mode: (event.target as HTMLElement).closest<HTMLElement>("[data-crop]")?.dataset.crop || "new", start: point(event), rect: { ...s.crop } };
  imageArea.value.setPointerCapture(event.pointerId);
}
function moveDrag(event: PointerEvent) {
  if (!drag || drag.pointer !== event.pointerId || props.disabled || props.controller.busy || !s.visible) return;
  const end = point(event), original = drag.rect;
  if (drag.mode === "move") s.crop = { ...original, x: Math.max(0, Math.min(s.width - original.width, original.x + end.x - drag.start.x)), y: Math.max(0, Math.min(s.height - original.height, original.y + end.y - drag.start.y)) };
  else { const [w, h] = s.ratio.split(":").map(Number); const start = drag.mode === "resize" ? { x: original.x, y: original.y } : drag.start;
    s.crop = dragCrop(start, end, s.width, s.height, w > 0 && h > 0 ? w / h : 0); }
}
function finishDrag(event: PointerEvent) { if (drag?.pointer !== event.pointerId) return; drag = undefined; if (imageArea.value?.hasPointerCapture(event.pointerId)) imageArea.value.releasePointerCapture(event.pointerId); }
</script>
<style scoped>
.geometryForm { display: grid; gap: 16px; }
.geometryHeading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.previewHost { display: flex; justify-content: center; overflow: hidden; background: repeating-conic-gradient(#8882 0 25%, transparent 0 50%) 0 / 16px 16px; border-radius: 8px; }
.geometryImage { position: relative; max-width: 100%; height: auto; touch-action: none; user-select: none; overflow: hidden; }
.geometryImage img { width: 100%; height: 100%; display: block; pointer-events: none; }
.cropMode { cursor: crosshair; }
.cropRect { position: absolute; box-sizing: border-box; border: 2px solid #fff; outline: 1px solid #222; box-shadow: 0 0 0 10000px #0007; cursor: move; }
.cropRect span { position: absolute; left: 4px; top: 4px; color: white; background: #0008; font-size: 11px; padding: 2px 4px; pointer-events: none; }
.resizeHandle { position: absolute; right: -5px; bottom: -5px; width: 14px; height: 14px; background: #fff; border: 1px solid #222; cursor: nwse-resize; }
.pixelFields { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.pixelFields label, .ratioField { display: grid; gap: 6px; font-size: 12px; }
.pixelFields :deep(.el-input-number) { width: 100%; }
.mirrorFields { display: flex; gap: 16px; }
.pixelSummary { font-size: 12px; color: var(--el-text-color-secondary); }
@media (max-width: 560px) { .pixelFields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
