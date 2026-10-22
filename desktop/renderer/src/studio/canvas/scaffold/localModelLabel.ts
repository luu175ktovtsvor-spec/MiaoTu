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
