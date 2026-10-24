<template>
  <div v-if="capabilities" class="localMediaInfo" :class="{ compact }" :aria-label="translate('账号模型能力')">
    <p class="watermarkPolicy">{{ translate('生成前，妙图会自动打开账号里的「去除 AI 水印」；优先保存平台确认的原片，平台只提供播放器地址时也会保留结果并标明取回来源。') }}</p>
    <p>{{ referenceHint }}</p>
    <p v-if="parameterHint" class="parameterPreset">{{ parameterHint }}</p>
    <p v-if="presetSource" class="parameterSource">{{ translate('预置参数会先显示；读到当前账号菜单后自动校正') }}</p>
    <template v-if="!compact">
      <p>{{ translate(capabilities.platform === 'doubao' ? '普通豆包账号会保留豆包品牌标识，订阅账号没有。' : 'Dola 按平台实际返回的原片保存；去 AI 水印和品牌标识状态以返回文件为准。') }}</p>
      <p>{{ translate(capabilities.kind === 'video' ? '按平台给的原片保存（MP4 或 WebM），不转码、不改分辨率。' : '按平台给的原图保存（PNG、JPEG 或 WebP）。') }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '@miaoimg/i18n/vue';
import { localMediaCapabilities } from '../../../../../local-media/catalog.ts';

const props = defineProps<{
  model?: {
    providerId?: string; modelId?: string; durations?: number[]; resolutions?: string[]; ratios?: string[];
    imageRatios?: string[]; parameterSource?: 'preset' | 'account';
    parameterPreset?: { imageSizeTiers?: string[] };
  };
  compact?: boolean;
}>();
const capabilities = computed(() => props.model?.modelId && props.model.providerId ? localMediaCapabilities(props.model.modelId, props.model.providerId) : undefined);
const referenceHint = computed(() => capabilities.value?.references.maxImages
  ? translate('可以放参考图：PNG、JPEG 或 WebP，最多 {0} 张，每张不超过 20MB。', { 0: capabilities.value.references.maxImages })
  : translate('用文字提示词生成。'));
const presetSource = computed(() => props.model?.parameterSource === 'preset');
const parameterHint = computed(() => {
  const model = props.model, kind = capabilities.value?.kind;
  if (!model || !kind) return '';
  if (kind === 'video') {
    const durations = [...new Set(model.durations || [])].sort((left, right) => left - right);
    const duration = !durations.length ? ''
      : durations.length > 2 && durations.every((value, index) => !index || value === durations[index - 1] + 1)
        ? translate('{0}–{1} 秒', { 0: durations[0], 1: durations.at(-1) })
        : translate('{0} 秒', { 0: durations.join(' / ') });
    const resolution = model.resolutions?.length ? model.resolutions.join(' / ') : translate('跟随平台');
    const ratio = model.ratios?.length ? translate('{0} 种比例', { 0: model.ratios.length }) : translate('比例跟随平台');
    return translate('视频参数：{0} · {1} · {2}', { 0: duration || translate('时长跟随平台'), 1: resolution, 2: ratio });
  }
  const size = model.parameterSource === 'preset' && model.parameterPreset?.imageSizeTiers?.length
    ? translate('预置规格 {0}', { 0: model.parameterPreset.imageSizeTiers.join(' / ') })
    : translate('尺寸跟随平台');
  const ratio = model.imageRatios?.length ? translate('{0} 种比例', { 0: model.imageRatios.length }) : translate('比例跟随平台');
  return translate('图片参数：{0} · {1}', { 0: size, 1: ratio });
});
</script>
<style scoped>
.localMediaInfo { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.localMediaInfo p { margin: 8px 0 0; }
.localMediaInfo .watermarkPolicy { color: var(--el-text-color-regular); }
.localMediaInfo .parameterPreset { color: var(--el-text-color-regular); }
.localMediaInfo .parameterSource { font-size: 11px; }
.localMediaInfo.compact p { margin: 8px 0; }
</style>
