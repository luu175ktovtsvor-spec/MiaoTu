<template>
  <div v-if="capabilities" class="localMediaInfo" :class="{ compact }" :aria-label="translate('本机模型能力')">
    <p class="watermarkPolicy">{{ translate('发送图片或视频前，妙图会直接打开账号里的去除 AI 明水印，不用自己去平台设置里点。视频只保存平台确认没有 AI 明水印的原片。') }}</p>
    <p>{{ referenceHint }}</p>
    <template v-if="!compact">
      <p>{{ translate(capabilities.platform === 'doubao' ? '普通豆包账号仍会保留品牌水印，订阅账号才不保留。' : '免费和付费账户使用同一套去除 AI 明水印流程；品牌标识以 Dola 实际返回为准。') }}</p>
      <p>{{ translate(capabilities.kind === 'video' ? '原片保存：MP4／WebM，跟随平台返回，不改写分辨率或转码。' : '原图保存：PNG／JPEG／WebP，跟随平台返回。') }}</p>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { translate } from '@miaoimg/i18n/vue';
import { localMediaCapabilities } from '../../../../../local-media/catalog.ts';

const props = defineProps<{ model?: { providerId?: string; modelId?: string }; compact?: boolean }>();
const capabilities = computed(() => props.model?.modelId && props.model.providerId ? localMediaCapabilities(props.model.modelId, props.model.providerId) : undefined);
const referenceHint = computed(() => capabilities.value?.references.maxImages
  ? translate('参考图：PNG／JPEG／WebP，最多 {0} 张，单张 20MB；暂不支持视频、音频及首尾帧模式。', { 0: capabilities.value.references.maxImages })
  : translate('当前接入：文字提示词；暂不支持图片、视频、音频参考及首尾帧模式。'));
</script>
<style scoped>
.localMediaInfo { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.localMediaInfo p { margin: 8px 0 0; }
.localMediaInfo .watermarkPolicy { color: var(--el-text-color-regular); }
.localMediaInfo.compact p { margin: 8px 0; }
</style>
