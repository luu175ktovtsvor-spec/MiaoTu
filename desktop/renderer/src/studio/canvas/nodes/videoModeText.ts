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
  };
  return descriptions[mode || ''] ? translate(descriptions[mode!]) : '';
}
