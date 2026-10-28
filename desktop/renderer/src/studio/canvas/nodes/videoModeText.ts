import type { NodeMediaModel } from '../scaffold/nodeAiTypes';
import { translate } from '@miaoimg/i18n/vue';

type VideoMode = string | string[] | undefined;
type ReferenceType = 'image' | 'video' | 'audio';

// Keep the saved/API mode values intact; only the user-facing names change.
export function videoReferenceTypes(mode: VideoMode, model?: NodeMediaModel): ReferenceType[] {
  if (!Array.isArray(mode)) return [];
  return (['image', 'video', 'audio'] as const).filter(type => {
    const rule = model?.parameterRules?.referencesByMode?.image?.[type];
    const maximum = rule?.[1] ?? Number(mode.find(item => item.startsWith(`${type}Reference:`))?.split(':')[1] || 0);
    return maximum > 0;
  });
}

export function videoModeLabel(mode: VideoMode, model?: NodeMediaModel): string {
  if (Array.isArray(mode)) {
    return translate(videoReferenceTypes(mode, model).some(type => type !== 'image') ? '全能参考' : '图片参考');
  }
  const labels: Record<string, string> = {
    text: '文生视频', singleImage: '图生视频', startEndRequired: '首尾帧',
    endFrameOptional: '首尾帧（尾帧可选）', startFrameOptional: '首尾帧（首帧可选）',
    edit: '编辑视频', extend: '延长视频',
  };
  return translate(labels[mode || ''] || mode || '');
}

// What the mode needs connected, derived from the same catalog limits the node
// and the server validate against. Shown when the current references do not fit.
export function videoModeRequirement(mode: VideoMode, model?: NodeMediaModel): string {
  if (mode === undefined || mode === '') return '';
  const rules = model?.parameterRules;
  if (Array.isArray(mode)) {
    const names = { image: '图片', video: '视频', audio: '音频' };
    const limits = videoReferenceTypes(mode, model).map(type => {
      const maximum = rules?.referencesByMode?.image?.[type]?.[1] ?? Number(mode.find(item => item.startsWith(`${type}Reference:`))?.split(':')[1] || 0);
      return translate('{0}最多 {1}', { 0: translate(names[type]), 1: maximum });
    }).join(translate('、'));
    return translate(rules?.requireVisualInMixed ? '需连入参考素材（{0}），至少包含一张图片或一段视频' : '需连入参考素材（{0}）', { 0: limits });
  }
  const span = rules?.referencesByMode?.[mode];
  const input = rules?.referenceInputsByMode?.[mode]?.video;
  const seconds = input?.maxDuration ? translate('（{0}–{1} 秒）', { 0: input.minDuration ?? 1, 1: input.maxDuration }) : '';
  switch (mode) {
    case 'text': return translate('不连入参考素材');
    case 'singleImage': return translate('需连入 1 张图片作为首帧，不能带视频或音频');
    case 'startEndRequired': return translate('需连入 2 张图片，依次作为首帧、尾帧，不能带视频或音频');
    case 'endFrameOptional':
    case 'startFrameOptional':
      return rules?.framePlusReferences
        ? translate('需连入 1–{0} 张图片：前两张作为首帧、尾帧，其余作为参考图，不能带视频或音频', { 0: model?.referenceLimits?.image ?? 2 })
        : translate('需连入 1–2 张图片，依次作为首帧、尾帧，不能带视频或音频');
    case 'edit': return translate('需连入 1 个要编辑的视频{0}', { 0: seconds }) + (span?.image?.[1] || span?.audio?.[1] ? translate('，可另加参考图片或音频') : '');
    case 'extend': return translate('需连入 1 个要延长的视频{0}', { 0: seconds });
    default: return '';
  }
}

export function videoModeDescription(mode: VideoMode, model?: NodeMediaModel): string {
  if (Array.isArray(mode)) {
    const names = { image: '图片', video: '视频', audio: '音频' };
    const media = videoReferenceTypes(mode, model).map(type => translate(names[type])).join(translate('、'));
    return translate('使用{0}作为参考，输入 @ 引用素材', { 0: media });
  }
  const descriptions: Record<string, string> = {
    text: '描述你想要生成的画面内容',
    singleImage: '上传一张图片，作为视频的首帧',
    startEndRequired: '上传首帧和尾帧图片，控制视频的开始与结束',
    endFrameOptional: '上传首帧图片，可添加尾帧控制结束画面',
    startFrameOptional: '仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧',
    edit: '上传一个 4–30 秒的视频，在原视频基础上进行编辑',
    extend: '上传一个视频，生成它的延长片段',
  };
  return descriptions[mode || ''] ? translate(descriptions[mode!]) : '';
}
