<template>
  <el-popover :persistent="false" :popper-options="{ modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true } }] }" trigger="click" placement="top-start" width="min(340px, calc(100vw - 24px))" :disabled="disabled" :showArrow="false" :popperStyle="{ padding: '14px' }">
    <template #reference>
      <el-button class="settingsButton" text size="small" :disabled="disabled" :aria-label="translate('图片生成设置')">
        <span class="ratioShape" :style="ratioStyle(effectiveRatio)" aria-hidden="true" />
        <span>{{ settingsSummary }}</span>
        <icon-chevron-up :size="14" aria-hidden="true" />
      </el-button>
    </template>
    <div class="generationSettings nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @wheel.stop>
      <div class="sectionLabel">{{ translate('分辨率') }}</div>
      <el-radio-group v-model="size" class="sizeOptions" :disabled="disabled" :aria-label="translate('图片分辨率')">
        <el-radio-button v-for="item in sizes" :key="item" :value="item">{{ item }}</el-radio-button>
      </el-radio-group>
      <template v-if="customRule">
        <div class="sectionLabel">{{ translate('自定义宽高') }}</div>
        <div class="customSize">
          <el-input-number v-model="customWidth" :min="1" :step="customRule.multipleOf || 1" :disabled="disabled" controls-position="right" :aria-label="translate('宽度')" />
          <span>×</span>
          <el-input-number v-model="customHeight" :min="1" :step="customRule.multipleOf || 1" :disabled="disabled" controls-position="right" :aria-label="translate('高度')" />
          <el-button size="small" :disabled="disabled || !customFits" @click="applyCustomSize">{{ translate('使用') }}</el-button>
        </div>
        <p v-if="customWidth && customHeight && !customFits" class="customHint">{{ translate('当前宽高不在这个模型接受的范围内') }}</p>
      </template>
      <div class="sectionLabel">{{ translate('比例') }}</div>
      <div class="ratioOptions" role="group" :aria-label="translate('图片比例')">
        <el-button
          v-for="item in ratios"
          :key="item"
          class="ratioButton"
          :disabled="disabled"
          :aria-label="translate('比例 {0}', { 0: item })"
          :aria-pressed="ratio === item"
          @click="ratio = item">
          <span class="ratioContent">
            <span class="ratioShape" :style="ratioStyle(item)" aria-hidden="true" />
            <span>{{ item }}</span>
          </span>
        </el-button>
      </div>
      <template v-if="formatOptions.length > 1">
        <div class="sectionLabel">{{ translate('输出格式') }}</div>
        <el-radio-group v-model="format" class="sizeOptions" :disabled="disabled" :aria-label="translate('输出格式')">
          <el-radio-button v-for="item in formatOptions" :key="item" :value="item">{{ item.toUpperCase() }}</el-radio-button>
        </el-radio-group>
      </template>
      <template v-if="qualityOptions.length">
        <div class="sectionLabel">{{ translate('质量') }}</div>
        <el-select v-model="quality" size="small" :disabled="disabled" :aria-label="translate('质量')" :placeholder="translate('自动')">
          <el-option :label="translate('自动')" value="" />
          <el-option v-for="item in qualityOptions" :key="item" :label="item" :value="item" />
        </el-select>
      </template>
      <template v-if="fidelityOptions.length">
        <div class="sectionLabel">{{ translate('输入保真度') }}</div>
        <el-select v-model="inputFidelity" size="small" :disabled="disabled" :aria-label="translate('输入保真度')" :placeholder="translate('自动')">
          <el-option :label="translate('自动')" value="" />
          <el-option v-for="item in fidelityOptions" :key="item" :label="item" :value="item" />
        </el-select>
      </template>
      <template v-if="maxCount > 1 && !layerDecomposition">
        <div class="sectionLabel">{{ translate('最多张数（模型决定实际张数）') }}</div>
        <el-select v-model="count" size="small" :disabled="disabled" :aria-label="translate('生成张数')">
          <el-option v-for="n in maxCount" :key="n" :label="translate('{0} 张', { 0: n })" :value="n" />
        </el-select>
      </template>
      <template v-if="transparentAllowed">
        <div class="sectionLabel">{{ translate('背景') }}</div>
        <el-radio-group v-model="background" class="sizeOptions" :disabled="disabled" :aria-label="translate('背景')">
          <el-radio-button value="opaque">{{ translate('不透明') }}</el-radio-button>
          <el-radio-button value="transparent">{{ translate('透明') }}</el-radio-button>
        </el-radio-group>
      </template>
      <template v-if="optimizeModes.length">
        <div class="sectionLabel">{{ translate('提示词优化') }}</div>
        <el-radio-group v-model="optimizePrompt" class="sizeOptions" :disabled="disabled" :aria-label="translate('提示词优化')">
          <el-radio-button value="">{{ translate('标准') }}</el-radio-button>
          <el-radio-button v-if="optimizeModes.includes('fast')" value="fast">{{ translate('极速') }}</el-radio-button>
        </el-radio-group>
      </template>
      <template v-for="control in controls" :key="control.key">
        <div class="sectionLabel">{{ translate(control.label) }}</div>
        <el-switch v-if="control.type === 'boolean'" :model-value="Boolean(parameters[control.key])" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }" />
        <el-select v-else-if="control.type === 'select'" :model-value="String(parameters[control.key] || '')" :disabled="disabled" :aria-label="translate(control.label)" @update:model-value="parameters = { ...parameters, [control.key]: $event }">
          <el-option v-for="option in control.options || []" :key="option" :value="option" :label="option" />
        </el-select>
      </template>
      <label v-if="supportsLayers" class="layerToggle">
        <el-switch v-model="layerDecomposition" :disabled="disabled || !layerReady" :aria-label="translate('图层拆分')" />
        <span>
          {{ translate('图层拆分') }}
          <small>{{ layerReady ? translate("1 张底图 + 最多 16 个透明图层") : translate("需要恰好 1 张参考图") }}</small>
        </span>
      </label>
      <local-media-info :model="model" />
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElInputNumber, ElOption, ElPopover, ElRadioGroup, ElRadioButton, ElSelect, ElSwitch } from "element-plus";
import { IconChevronUp } from "@tabler/icons-vue";
import { translate } from "@miaoimg/i18n/vue";
import { fitsCustomSize } from "../scaffold/nodeAi";
import { visibleControls } from "../scaffold/mediaParameters";
import localMediaInfo from './localMediaInfo.vue';

const props = defineProps<{ sizes: string[]; ratios: string[]; disabled?: boolean; model?: { providerId?: string; modelId?: string; formats?: string[]; quality?: string[]; inputFidelity?: string[]; maxCount?: number; supportsTransparent?: boolean; supportsLayerDecomposition?: boolean; optimizePromptModes?: string[]; customSize?: boolean; sizes?: { value: string; ratio?: string; label?: string }[]; sizeRule?: { minPixels: number; maxPixels: number; minRatio: number; maxRatio: number; multipleOf?: number; maxEdge?: number } | null }; referenceCount?: number }>();
const size = defineModel<string>("size", { required: true });
const ratio = defineModel<string>("ratio", { required: true });
const format = defineModel<string>("format", { default: "" });
const background = defineModel<string>("background", { default: "opaque" });
const quality = defineModel<string>("quality", { default: "" });
const inputFidelity = defineModel<string>("inputFidelity", { default: "" });
const count = defineModel<number>("count", { default: 1 });
const layerDecomposition = defineModel<boolean>("layerDecomposition", { default: false });
const optimizePrompt = defineModel<string>("optimizePrompt", { default: "" });
const parameters = defineModel<Record<string, unknown>>("parameters", { default: () => ({}) });
const controls = computed(() => visibleControls(props.model, "text"));

const formatOptions = computed(() => props.model?.formats || []);
const qualityOptions = computed(() => props.model?.quality || []);
const fidelityOptions = computed(() => props.model?.inputFidelity || []);
const maxCount = computed(() => Math.max(1, Number(props.model?.maxCount) || 1));
const transparentAllowed = computed(() => Boolean(props.model?.supportsTransparent));
const supportsLayers = computed(() => Boolean(props.model?.supportsLayerDecomposition));
const optimizeModes = computed(() => props.model?.optimizePromptModes || []);
const layerReady = computed(() => (props.referenceCount || 0) === 1);
const customRule = computed(() => props.model?.customSize ? props.model.sizeRule || null : null);
const parsedSize = computed(() => /^(\d+)x(\d+)$/.exec(size.value || ""));
const sizeMeta = computed(() => props.model?.sizes || []);
// Grok uses resolution and aspect ratio as independent upstream fields. Other
// image providers encode the aspect ratio in `size`; keeping the two controls
// independent would let the composer show combinations the upstream never gets.
const independentRatio = computed(() => sizeMeta.value.length > 0 && sizeMeta.value.every(item => !item.ratio));
const effectiveRatio = computed(() => {
  if (independentRatio.value) return ratio.value || "auto";
  const mapped = sizeMeta.value.find(item => item.value === size.value)?.ratio;
  if (mapped) return mapped;
  const match = parsedSize.value;
  if (!match) return ratio.value || "auto";
  const width = Number(match[1]), height = Number(match[2]);
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
});
const settingsSummary = computed(() => {
  const parts = !independentRatio.value && effectiveRatio.value === size.value
    ? [size.value]
    : [effectiveRatio.value, size.value];
  return `${parts.filter(Boolean).join(" · ")} · ${translate("{0}张", { 0: count.value })}`;
});
const customWidth = ref<number | undefined>(parsedSize.value ? Number(parsedSize.value[1]) : undefined);
const customHeight = ref<number | undefined>(parsedSize.value ? Number(parsedSize.value[2]) : undefined);
watch(parsedSize, (value) => {
  if (!value) return;
  customWidth.value = Number(value[1]);
  customHeight.value = Number(value[2]);
});
const customFits = computed(() => fitsCustomSize(customRule.value, customWidth.value && customHeight.value ? `${customWidth.value}x${customHeight.value}` : undefined));
function applyCustomSize() {
  if (!customFits.value || !customWidth.value || !customHeight.value) return;
  size.value = `${customWidth.value}x${customHeight.value}`;
}

function reconcileSizeAndRatio() {
  if (independentRatio.value) return;
  const mapped = sizeMeta.value.find(item => item.value === size.value)?.ratio;
  if (mapped) {
    if (ratio.value !== mapped) ratio.value = mapped;
    return;
  }
  const match = parsedSize.value;
  if (!match) return;
  const width = Number(match[1]), height = Number(match[2]);
  const gcd = (left: number, right: number): number => right ? gcd(right, left % right) : left;
  const divisor = gcd(width, height);
  const exact = `${width / divisor}:${height / divisor}`;
  const next = props.ratios.includes(exact) ? exact : "";
  if (ratio.value !== next) ratio.value = next;
}
watch(size, reconcileSizeAndRatio, { immediate: true });
watch(() => sizeMeta.value.map(item => `${item.value}:${item.ratio || ""}`).join("|"), reconcileSizeAndRatio, { immediate: true });
watch(ratio, value => {
  if (independentRatio.value || !value) return;
  const target = sizeMeta.value.find(item => item.ratio === value);
  if (target && size.value !== target.value) size.value = target.value;
});

function ratioStyle(value: string) {
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

.generationSettings {
  text-align: left;
  max-height: min(70vh, 560px);
  overflow-y: auto;
  .layerToggle {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-top: 14px;
    color: var(--el-text-color-primary);
    font-size: 13px;
    cursor: pointer;
    > span { display: grid; gap: 2px; }
    small { color: var(--el-text-color-secondary); font-size: 11px; font-weight: 400; }
  }
  .sectionLabel {
    margin-bottom: 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    font-weight: 500;
  }

  .customSize {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;

    :deep(.el-input-number) { width: 112px; }
  }

  .customHint {
    margin: 0 0 14px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .sizeOptions {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
    .el-radio-button {
      flex: 1;
      --el-radio-button-checked-bg-color: color-mix(in srgb, var(--el-color-primary) 12%, var(--canvas-surface, #1e1e24));
      --el-radio-button-checked-text-color: var(--el-text-color-primary);
      --el-radio-button-checked-border-color: var(--el-color-primary);

      :deep(.el-radio-button__inner) {
        width: 100%;
        padding: 8px 12px;
        border: 1px solid var(--el-border-color);
        border-radius: var(--el-border-radius-base);
        box-shadow: none;

        &:hover { color: var(--el-text-color-primary); }
      }

      &.is-active :deep(.el-radio-button__inner) {
        color: var(--el-text-color-primary);
        background: color-mix(in srgb, var(--el-color-primary) 12%, var(--canvas-surface, #1e1e24));
        border-color: var(--el-color-primary);
        box-shadow: none;
      }
    }
  }

  .ratioOptions {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;

    .ratioButton {
      height: 60px;
      margin: 0;
      padding: 8px 4px;
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
        gap: 8px;
        font-size: 12px;
      }
    }
  }
}
</style>
