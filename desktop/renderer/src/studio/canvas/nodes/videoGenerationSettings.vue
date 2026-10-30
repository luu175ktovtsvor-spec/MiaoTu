<template>
  <el-popover :persistent="false" :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }" trigger="click" placement="top-start" width="min(380px, calc(100vw - 24px))" :disabled="disabled && !openWhenDisabled" :showArrow="false" :popperStyle="{ padding: '14px 16px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled && !openWhenDisabled" :aria-label="translate('视频生成设置')">
        <span v-if="!hideRatioIcon" class="ratioShape" :style="ratioStyle(ratio)" aria-hidden="true" />
        <span>{{ summary }}</span>
        <component :is="generateAudio ? IconVolume : IconVolumeOff" v-if="audioOptional || model?.audio === true" :size="15" :aria-label="translate(generateAudio || model?.audio === true ? '生成音频' : '不生成音频')" />
        <component :is="summaryOverride ? IconChevronDown : IconChevronUp" :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <p v-if="localPlatform && !durations.length && !inheritsSourceDuration" class="inputHint">{{ translate('正在读取当前账号的时长和比例') }}</p>
      <template v-if="!inheritsSourceRatio && ratios.length">
        <div class="sectionLabel">{{ translate('比例') }}</div>
        <settingOptions v-model="ratio" :options="ratios.map(item => ({ value: item, label: ratioLabel(item) }))" :columns="5" ratio :disabled="disabled || inheritsSourceFormat" :label="translate('视频比例')" />
      </template>
      <p v-else-if="localPlatform && !inheritsSourceRatio" class="inputHint">{{ translate('比例跟随平台页面') }}</p>
      <template v-if="resolutions.length && !inheritsSourceFormat">
        <div class="sectionLabel">{{ translate('清晰度') }}</div>
        <settingOptions v-model="resolution" :options="resolutions.map(item => ({ value: item, label: sizeTier(item) || item }))" :columns="resolutions.length > 3 ? 2 : resolutions.length" :disabled="disabled" :label="translate('视频清晰度')" />
      </template>
      <p v-else-if="localPlatform && !inheritsSourceFormat" class="inputHint">{{ translate('清晰度跟随平台') }}</p>
      <template v-if="durations.length && !inheritsSourceDuration">
        <div class="sectionLabel">{{ translate('视频时长') }}</div>
        <div v-if="durationRange" class="durationSlider">
          <el-slider v-model="durationValue" :min="durationRange[0]" :max="durationRange[1]" :step="1" :show-tooltip="false" :disabled="disabled" :aria-label="translate('视频时长')" />
          <el-input-number v-model="durationValue" :min="durationRange[0]" :max="durationRange[1]" :step="1" :controls="false" :disabled="disabled" :aria-label="translate('视频时长（秒）')" />
          <span>s</span>
        </div>
        <settingOptions v-else v-model="durationValue" :options="durations.map(item => ({ value: item, label: durationLabel(item) }))" :columns="Math.min(4, durations.length)" :disabled="disabled" :label="translate('视频时长')" />
      </template>
      <p v-if="inputHint && !hideInputHint" class="inputHint">{{ inputHint }}</p>
      <template v-if="audioOptional">
        <div class="sectionLabel">{{ translate('生成音频') }}</div>
        <settingOptions v-model="generateAudio" :options="[{ value: true, label: translate('开启') }, { value: false, label: translate('关闭') }]" :columns="2" :disabled="disabled" :label="translate('生成音频')" />
      </template>
      <template v-if="voiceOptions.length">
        <div class="sectionLabel">{{ translate('预设声音') }} <small>{{ voices.length }}/{{ model?.maxReferenceVoices }}</small></div>
        <el-select
          v-model="voices"
          multiple filterable allow-create default-first-option
          :multiple-limit="model?.maxReferenceVoices || 0"
          :disabled="disabled"
          :aria-label="translate('预设声音')">
          <el-option v-for="voice in voiceOptions" :key="voice" :label="voice.charAt(0).toUpperCase() + voice.slice(1)" :value="voice" />
        </el-select>
      </template>
      <template v-if="model?.parameterRules?.pinFramesInMixed && selectedModeName === 'image'">
        <template v-for="pin in (['firstFrame', 'lastFrame'] as const)" :key="pin">
          <div class="sectionLabel">{{ translate(pin === 'firstFrame' ? '首帧' : '尾帧') }}</div>
          <el-select :model-value="keyframeImages?.some(image => image.reference === pinnedFrames[pin]) ? pinnedFrames[pin] : undefined"
            clearable :disabled="disabled" :placeholder="translate('选择图片')" :aria-label="translate(pin === 'firstFrame' ? '首帧' : '尾帧')"
            @update:model-value="value => pinnedFrames = { ...pinnedFrames, [pin]: value || undefined }">
            <el-option v-for="image in keyframeImages" :key="image.reference" :label="image.label" :value="image.reference">
              <span class="frameImageOption"><img v-if="image.preview" :src="image.preview" alt="" loading="lazy" /><span>{{ image.label }}</span></span>
            </el-option>
          </el-select>
        </template>
      </template>
      <template v-if="keyframesAvailable">
        <div class="sectionLabel">{{ translate('关键帧') }} <small>{{ keyframes.length }}/{{ model?.keyframes }}</small></div>
        <div class="keyframeOptions">
          <div v-for="(item, index) in keyframes" :key="index" class="keyframeRow">
            <el-select :model-value="keyframeImages?.some(image => image.reference === item.reference) ? item.reference : undefined"
              :disabled="disabled" :placeholder="translate('选择图片')" :aria-label="translate('选择图片')"
              @update:model-value="value => updateKeyframeReference(index, value)">
              <el-option v-for="image in keyframeImages" :key="image.reference" :label="image.label" :value="image.reference">
              <span class="frameImageOption"><img v-if="image.preview" :src="image.preview" alt="" loading="lazy" /><span>{{ image.label }}</span></span>
            </el-option>
            </el-select>
            <el-input-number :model-value="item.timestamp_s" :min="1 / 3" :max="Math.max(1 / 3, (duration || 1) - 1 / 3)"
              :step="1 / 3" :precision="3" :controls="false" :disabled="disabled" :aria-label="translate('关键帧') + ' (s)'"
              @update:model-value="value => updateKeyframeTime(index, value)" />
            <span>s</span>
            <el-button text :disabled="disabled" :aria-label="translate('删除')" @click="keyframes = keyframes.filter((_, other) => other !== index)">×</el-button>
          </div>
          <el-button text :disabled="disabled || !nextKeyframe" @click="addKeyframe">{{ translate('添加') }}</el-button>
        </div>
      </template>
      <template v-if="controls.length">
        <el-button class="advancedToggle" text :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
          {{ translate(showAdvanced ? '收起高级设置' : '高级设置') }}
          <icon-chevron-down :size="14" :class="{ flipped: showAdvanced }" aria-hidden="true" />
        </el-button>
        <div v-if="showAdvanced" class="advancedSettings">
          <template v-for="control in controls" :key="control.key">
            <div v-if="control.type === 'boolean'" class="controlRow">
              <span class="sectionLabel">{{ controlLabel(control.key, control.label) }}</span>
              <el-switch :model-value="Boolean(parameters[control.key])" :disabled="disabled" :aria-label="controlLabel(control.key, control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }" />
            </div>
            <template v-else-if="control.type === 'select'">
              <div class="sectionLabel">{{ controlLabel(control.key, control.label) }}</div>
              <settingOptions :model-value="String(parameters[control.key] || control.default || '')" :options="(control.options || []).map(option => ({ value: option, label: controlOptionLabel(control.key, option) }))" :columns="Math.min(3, (control.options || []).length)" :disabled="disabled" :label="controlLabel(control.key, control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }" />
            </template>
          </template>
        </div>
      </template>
      <slot name="additional" />
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElInputNumber, ElPopover, ElSlider, ElSwitch } from "element-plus";
import { IconChevronDown, IconChevronUp, IconVolume, IconVolumeOff } from "@tabler/icons-vue";
import type { NodeMediaModel } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import { durationsForMode, inheritedFields, resolutionsForMode, visibleControls, type VideoFramePins, type VideoKeyframeImage, type VideoKeyframeSelection } from "../scaffold/mediaParameters";
import { sizeTier } from "../../../../../../server/media-size-label";
import settingOptions from "./settingOptions.vue";

const props = defineProps<{ model?: NodeMediaModel; summaryOverride?: string; hideRatioIcon?: boolean; hideInputHint?: boolean; openWhenDisabled?: boolean; disabled?: boolean; ratios: string[]; videoReferences?: number; imageReferences?: number; keyframeImages?: VideoKeyframeImage[] }>();
const duration = defineModel<number | undefined>("duration", { required: true });
const resolution = defineModel<string>("resolution", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const mode = defineModel<string>("mode", { required: true });
const generateAudio = defineModel<boolean>("generateAudio", { required: true });
const parameters = defineModel<Record<string, unknown>>("parameters", { default: () => ({}) });
const voices = defineModel<string[]>("voices", { default: () => [] });
const keyframes = defineModel<VideoKeyframeSelection[]>("keyframes", { default: () => [] });
const pinnedFrames = defineModel<VideoFramePins>("pinnedFrames", { default: () => ({}) });
const showAdvanced = ref(false);
const localPlatform = computed(() => ['doubao-local', 'dola-local'].includes(props.model?.providerId || ''));
function ratioLabel(value: string) {
  if (value === 'adaptive') return translate('自适应');
  return value === 'auto' ? translate(props.model?.providerId === 'dola-local' ? '跟随平台' : '自动') : value;
}
function durationLabel(value: number | undefined) {
  if (value === -1) return translate('自动');
  return value ? `${value}s` : '';
}
const selectedModeName = computed(() => {
  // 节点使用 JSON.stringify 保存模式，多素材参考模式保存为数组。
  try { const value = JSON.parse(mode.value); return typeof value === "string" ? value : "image"; }
  catch { return mode.value; }
});
const inherited = computed(() => inheritedFields(props.model, selectedModeName.value));
const inheritsSourceDuration = computed(() => inherited.value.includes("duration"));
const inheritsSourceFormat = computed(() => inherited.value.includes("resolution"));
const inheritsSourceRatio = computed(() => inherited.value.includes("ratio") || inheritsSourceFormat.value);
const audioOptional = computed(() => props.model?.audio === "optional" && props.model.parameterRules?.audioByMode?.[selectedModeName.value] !== "hidden");
const controls = computed(() => visibleControls(props.model, selectedModeName.value));
// 预设声音只用于带参考素材的生成，文生视频不带。
const voiceOptions = computed(() => props.model?.maxReferenceVoices && selectedModeName.value !== "text" ? props.model.referenceVoices || [] : []);


const keyframesAvailable = computed(() => Boolean(props.model?.keyframes && ['image', 'startFrameOptional', 'endFrameOptional', 'startEndRequired'].includes(selectedModeName.value)));
const nextKeyframe = computed(() => {
  if (keyframes.value.length >= (props.model?.keyframes || 0)) return null;
  const image = props.keyframeImages?.find(image => !keyframes.value.some(item => item.reference === image.reference)) || props.keyframeImages?.[0];
  if (!image) return null;
  const occupied = new Set(keyframes.value.map(item => Math.round(item.timestamp_s * 3)));
  for (let slot = 1; slot < (duration.value || 0) * 3; slot++) {
    if (!occupied.has(slot)) return { reference: image.reference, timestamp_s: slot / 3 };
  }
  return null;
});
function addKeyframe() { if (nextKeyframe.value) keyframes.value = [...keyframes.value, nextKeyframe.value]; }
function updateKeyframeReference(index: number, reference: string) {
  keyframes.value = keyframes.value.map((item, other) => other === index ? { ...item, reference } : item);
}
function updateKeyframeTime(index: number, value: number | undefined | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  keyframes.value = keyframes.value.map((item, other) => other === index ? { ...item, timestamp_s: Math.round(value * 3) / 3 } : item);
}

function controlOptionLabel(key: string, option: string) {
  if (key === "creativeMode") {
    if (option === "native") return translate("标准");
    if (option === "super_economy") return translate("节省模式");
  }
  return translate(option);
}

function controlLabel(key: string, label: string) {
  return key === "creativeMode" ? translate("生成模式") : translate(label);
}
const durations = computed(() => durationsForMode(props.model, selectedModeName.value)
  // 清晰度跟随平台（没有分辨率可选）时不按分辨率筛时长。
  .filter(value => value < 0 || !resolution.value || resolutionsFor(value).includes(resolution.value)));
const resolutions = computed(() => resolutionsFor(duration.value));
// 连续整数时长（如 4–15 秒）用滑杆加输入框，零散档位（含自动）用按钮。
const durationRange = computed<[number, number] | null>(() => {
  const values = durations.value;
  if (values.length < 5 || values.some(value => value < 0)) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.every((value, index) => !index || value === sorted[index - 1]! + 1) ? [sorted[0]!, sorted.at(-1)!] : null;
});
const durationValue = computed({
  get: () => duration.value ?? durations.value[0] ?? 0,
  set: (value: number) => { if (durations.value.includes(value)) duration.value = value; },
});
// 和 LibTV 一样：比例 · 清晰度 · 时长，音频状态用图标表示。
const summary = computed(() => {
  if (props.summaryOverride) return props.summaryOverride;
  if (inheritsSourceDuration.value) return translate('编辑 · 跟随输入');
  if (inheritsSourceFormat.value) return translate('延长 {0} · 跟随输入', { 0: durationLabel(duration.value) });
  const resolutionText = resolution.value ? sizeTier(resolution.value) || resolution.value : localPlatform.value ? translate('清晰度跟随平台') : '';
  return [ratioLabel(ratio.value), resolutionText, durationLabel(duration.value)].filter(Boolean).join(' · ');
});

// 输入素材另计：参考视频按输入时长、图片素材超出免费张数按张计费（结算时合并预扣）。
const inputHint = computed(() => {
  const hints: string[] = [];
  if (duration.value === -1) hints.push(translate("自动时长先按最长秒数预扣，结束后按实际结算"));
  const modeHint = props.model?.parameterRules?.hintsByMode?.[selectedModeName.value];
  if (modeHint) hints.push(translate(modeHint));
  const pricing = props.model?.inputPricing;
  if (pricing?.billReferenceVideoSeconds && (props.videoReferences || 0) > 0) hints.push(translate("参考视频按输入时长计积分"));
  const free = pricing?.freeReferenceImages || 0;
  if (pricing?.extraImageCredits && (props.imageReferences || 0) > free) hints.push(translate("超出 {0} 张的图片已计入预估", { 0: free }));
  return hints.join(translate("；"));
});

function resolutionsFor(value: number | undefined) {
  const listed = resolutionsForMode(props.model, selectedModeName.value, value, parameters.value);
  const limit = props.model?.parameterRules?.referenceResolutions;
  const pinnedLast = selectedModeName.value === 'startFrameOptional' && (props.imageReferences || 0) > 0
    || ['endFrameOptional', 'startEndRequired'].includes(selectedModeName.value) && (props.imageReferences || 0) > 1;
  return limit && (voices.value.length || keyframes.value.length || pinnedLast) ? listed.filter(item => limit.includes(item)) : listed;
}

function ratioStyle(value: string) {
  if (!value) return { width: "16px", height: "12px", borderStyle: "dashed" };
  if (value === "adaptive" || value === 'auto') return { width: "16px", height: "12px", borderStyle: "dashed" };
  const [width = 1, height = 1] = value.split(":").map(Number);
  return { width: `${16 * Math.min(width / height, 1)}px`, height: `${16 * Math.min(height / width, 1)}px` };
}
</script>

<style scoped lang="scss">
.ratioShape {
  display: inline-block;
  flex-shrink: 0;
  border: 1px solid currentColor;
  border-radius: 2px;
  box-sizing: border-box;
}

.settingsButton {
  flex-shrink: 0;
  border-radius: 8px;
  :deep(> span) { gap: 6px; }
}

.generationSettings {
  display: flex;
  flex-direction: column;
  text-align: left;
  max-height: min(70vh, 600px);
  overflow-y: auto;

  .sectionLabel {
    margin: 14px 0 8px;
    color: var(--el-text-color-regular);
    font-size: 13px;
    font-weight: 500;
    &:first-child { margin-top: 0; }
  }

  .inputHint {
    margin: 8px 0 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--el-text-color-secondary);
  }

  .durationSlider {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--el-text-color-secondary);

    .el-slider { flex: 1; margin-left: 6px; }
    :deep(.el-input-number) { width: 56px; }
    :deep(.el-input__inner) { text-align: center; }
  }

  .advancedToggle {
    align-self: flex-start;
    margin-top: 12px;
    padding-inline: 0;
    color: var(--el-text-color-secondary);
    :deep(> span) { gap: 4px; }
    .flipped { transform: rotate(180deg); }
  }

  .advancedSettings {
    display: flex;
    flex-direction: column;
  }

  .frameImageOption { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .frameImageOption img { width: 28px; height: 28px; flex: 0 0 28px; object-fit: cover; border-radius: 5px; }
  .frameImageOption span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .keyframeOptions { display: flex; flex-direction: column; gap: 8px; }
  .keyframeRow { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .keyframeRow .el-select { min-width: 0; flex: 1; }
  .keyframeRow .el-input-number { width: 84px; flex: 0 0 84px; }
  .sectionLabel small { margin-left: 4px; color: var(--el-text-color-secondary); font-weight: 400; }

  .controlRow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    .sectionLabel { margin: 14px 0 8px; }
  }
}
</style>
