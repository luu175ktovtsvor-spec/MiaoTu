import { localModelCaption } from '../../../../../local-media/catalog.ts';

export function nodeLocalModelLabel(value: unknown): string {
  try {
    const pair = typeof value === 'string' ? JSON.parse(value) : undefined;
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string')) return '';
    return localModelCaption(pair[1], pair[0]);
  } catch { return ''; }
}

export function nodeModelOptionLabel(model: { providerId: string; modelId: string; label?: string }) {
  if ((model.providerId === 'doubao-local' || model.providerId === 'dola-local') && model.label && model.label !== model.modelId) return model.label;
  return nodeLocalModelLabel(JSON.stringify([model.providerId, model.modelId])) || model.label || model.modelId;
}

// 模型列表还没拿到（未登录、离线）时，选择框按保存的值显示名称，而不是原始 JSON。
export function nodeModelValueLabel(value: unknown) {
  const local = nodeLocalModelLabel(value);
  if (local) return local;
  try {
    const pair = typeof value === 'string' ? JSON.parse(value) : undefined;
    if (Array.isArray(pair) && typeof pair[1] === 'string') return pair[1];
  } catch { /* 不是模型对 */ }
  return typeof value === 'string' ? value : '';
}
