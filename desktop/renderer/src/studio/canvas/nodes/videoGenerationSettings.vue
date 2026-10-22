<template>
  <el-popover :persistent="false" :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }" trigger="click" placement="top-start" width="min(340px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" :aria-label="translate('视频生成设置')">
        <span class="ratioShape" :style="ratioStyle(ratio)" aria-hidden="true" />
        <span>{{ inheritsSourceDuration ? translate('编辑 · 跟随输入') : inheritsSourceFormat ? translate('延长 {0}秒 · 跟随输入', { 0: duration }) : [ratioLabel(ratio), resolution || (localPlatform ? translate('清晰度跟随平台') : ''), durationLabel(duration)].filter(Boolean).join(' · ') }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div v-if="modes.length" class="sectionLabel">{{ translate('生成模式') }}</div>
      <el-select v-if="modes.length" v-model="mode" :teleported="false" :disabled="disabled" :aria-label="translate('视频生成模式')">
        <el-option v-for="item in modes" :key="item.value" :value="item.value" :label="item.label" />
      </el-select>
      <p v-if="localPlatform && !durations.length && !inheritsSourceDuration" class="inputHint">{{ translate('正在读取当前账号的时长和比例') }}</p>
      <div v-if="!inheritsSourceDuration" class="outputOptions">
        <div v-if="durations.length" class="outputField">
          <div class="sectionLabel">{{ translate('时长') }}</div>
          <el-select v-model="duration" :teleported="false" :disabled="disabled || inheritsSourceDuration" :aria-label="translate('视频时长')">
            <el-option v-for="item in durations" :key="item" :value="item" :label="item === -1 ? translate('自动') : translate('{0}秒', { 0: item })" />
          </el-select>
        </div>
        <div v-if="resolutions.length && !inheritsSourceFormat" class="outputField">
          <div class="sectionLabel">{{ translate('分辨率') }}</div>
          <el-select v-model="resolution" :teleported="false" :disabled="disabled || inheritsSourceFormat" :aria-label="translate('视频分辨率')">
            <el-option v-for="item in resolutions" :key="item" :value="item" :label="item" />
          </el-select>
        </div>
        <div v-else-if="localPlatform && !inheritsSourceFormat" class="outputField">
          <div class="sectionLabel">{{ translate('分辨率') }}</div>
          <span>{{ translate('跟随平台') }}</span>
        </div>
      </div>
      <p v-if="inputHint" class="inputHint">{{ inputHint }}</p>
      <div v-if="!inheritsSourceRatio && ratios.length" class="sectionLabel">{{ translate('通用比例') }}</div>
      <div v-if="!inheritsSourceRatio && ratios.length" class="ratioOptions" role="group" :aria-label="translate('视频比例')">
        <el-button v-for="item in ratios" :key="item" class="ratioButton" :disabled="disabled || inheritsSourceFormat" :aria-label="translate('比例 {0}', { 0: item })" :aria-pressed="ratio === item" @click="ratio = item">
          <span class="ratioContent">
            <span class="ratioShape" :style="ratioStyle(item)" aria-hidden="true" />
            <span>{{ ratioLabel(item) }}</span>
          </span>
        </el-button>
      </div>
      <p v-else-if="localPlatform && !inheritsSourceRatio" class="inputHint">{{ translate('比例跟随平台页面') }}</p>
      <el-button class="advancedToggle" text :aria-expanded="showAdvanced" @click="showAdvanced = !showAdvanced">
        {{ translate(showAdvanced ? '收起高级设置' : '高级设置') }}
      </el-button>
      <div v-if="showAdvanced" class="advancedSettings">
        <div v-if="audioOptional" class="audioOption">
          <span class="sectionLabel">{{ translate('生成音频') }}</span>
          <el-switch v-model="generateAudio" :disabled="disabled" :aria-label="translate('生成音频')" />
        </div>
        <template v-for="control in controls" :key="control.key">
          <div class="sectionLabel">{{ translate(control.label) }}</div>
          <el-switch v-if="control.type === 'boolean'" :model-value="Boolean(parameters[control.key])" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }" />
          <el-select v-else-if="control.type === 'select'" :model-value="String(parameters[control.key] || '')" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }">
            <el-option v-for="option in control.options || []" :key="option" :value="option" :label="option" />
          </el-select>
        </template>
        <local-media-info :model="model" />
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { ElButton, ElPopover, ElSelect, ElOption, ElSwitch } from "element-plus";
import { IconChevronUp } from "@tabler/icons-vue";
import type { NodeMediaModel } from "@miaoimg/nodes-scaffold/runtime";
import { translate } from "@miaoimg/i18n/vue";
import localMediaInfo from './localMediaInfo.vue';
import { durationsForMode, inheritedFields, visibleControls } from "../scaffold/mediaParameters";

const props = defineProps<{ model?: NodeMediaModel; disabled?: boolean; ratios: string[]; videoReferences?: number; imageReferences?: number }>();
const duration = defineModel<number | undefined>("duration", { required: true });
const resolution = defineModel<string>("resolution", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const mode = defineModel<string>("mode", { required: true });
const generateAudio = defineModel<boolean>("generateAudio", { required: true });
const parameters = defineModel<Record<string, unknown>>("parameters", { default: () => ({}) });
const showAdvanced = ref(false);
// value 是词表 key（中文原文），取值时再按当前语言翻译。
const modeLabels: Record<string, string> = {
  text: "文生视频", singleImage: "单图参考", startEndRequired: "首尾帧必填", endFrameOptional: "尾帧可选", startFrameOptional: "首帧可选",
  edit: "编辑视频", extend: "延长视频",
};
const localPlatform = computed(() => ['doubao-local', 'dola-local'].includes(props.model?.providerId || ''));
function ratioLabel(value: string) {
  if (value === 'adaptive') return translate('自适应');
  return value === 'auto' ? translate(props.model?.providerId === 'dola-local' ? '跟随平台' : '自动') : value;
}
function durationLabel(value: number | undefined) {
  if (value === -1) return translate('自动');
  return value ? translate('{0}秒', { 0: value }) : '';
}
const selectedModeName = computed(() => {
  // 节点使用 JSON.stringify 保存模式，混合参考模式则保存为数组。
  try { const value = JSON.parse(mode.value); return typeof value === "string" ? value : "image"; }
  catch { return mode.value; }
});
const inherited = computed(() => inheritedFields(props.model, selectedModeName.value));
const inheritsSourceDuration = computed(() => inherited.value.includes("duration"));
const inheritsSourceFormat = computed(() => inherited.value.includes("resolution"));
const inheritsSourceRatio = computed(() => inherited.value.includes("ratio") || inheritsSourceFormat.value);
const audioOptional = computed(() => props.model?.audio === "optional" && props.model.parameterRules?.audioByMode?.[selectedModeName.value] !== "hidden");
const controls = computed(() => visibleControls(props.model, selectedModeName.value));
const modes = computed(() => (props.model?.mode ?? []).map(item => ({
  value: JSON.stringify(item),
  label: translate(Array.isArray(item) ? "混合参考" : modeLabels[item] ?? item),
})));
const durations = computed(() => durationsForMode(props.model, selectedModeName.value)
  // 清晰度跟随平台（没有分辨率可选）时不按分辨率筛时长。
  .filter(value => value < 0 || !resolution.value || resolutionsFor(value).includes(resolution.value)));
const resolutions = computed(() => resolutionsFor(duration.value));

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
  return [...new Set((props.model?.durationResolutionMap ?? []).filter(item => value !== undefined && item.duration.includes(value)).flatMap(item => item.resolution))];
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
  border-radius: 12px;
  :deep(> span) { gap: 6px; }
}

.advancedToggle {
  justify-content: flex-start;
  width: 100%;
  margin-top: 4px;
  padding-inline: 0;
}

.generationSettings {
  text-align: left;

  .sectionLabel {
    margin-bottom: 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 500;
  }

  > .el-select { margin-bottom: 14px; }

  .outputOptions {
    display: flex;
    gap: 12px;
    margin-bottom: 14px;
    .outputField { flex: 1; min-width: 0; }
  }

  .inputHint {
    margin: -7px 0 10px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--el-text-color-secondary);
  }

  .ratioOptions {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;

    .ratioButton {
      height: 50px;
      margin: 0;
      padding: 6px 3px;
      border-radius: 12px;
      color: var(--el-text-color-secondary);
      --el-button-bg-color: var(--el-fill-color-light);
      --el-button-hover-bg-color: var(--el-fill-color);
      --el-button-hover-text-color: var(--el-text-color-primary);
      --el-button-hover-border-color: var(--el-border-color-darker);

      &[aria-pressed="true"] {
        color: var(--el-text-color-primary);
        border-color: var(--el-color-primary);
        background: color-mix(in srgb, var(--el-color-primary) 12%, var(--canvas-surface, #1e1e24));
      }

      .ratioContent {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 5px;
        font-size: 11px;
      }
    }
  }

  .audioOption {
    display: flex;
    align-items: center;
    justify-content: space-between;
    .sectionLabel { margin: 0; }
  }

  .advancedSettings {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
    padding-top: 4px;
  }
}
</style>
