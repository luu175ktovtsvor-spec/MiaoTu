import type { Directive } from 'vue';

// The installed number-input component initializes these attributes only once.
// Keep assistive state aligned when loading finishes or a value changes.
function synchronize(element: HTMLElement) {
  const input = element.querySelector<HTMLInputElement>('input');
  if (!input) return;
  input.setAttribute('aria-disabled', String(input.disabled));
  for (const [attribute, value] of [['aria-valuenow', input.value], ['aria-valuemin', input.min], ['aria-valuemax', input.max]]) {
    if (value && Number.isFinite(Number(value))) input.setAttribute(attribute!, value);
    else input.removeAttribute(attribute!);
  }
}
export const vNumberA11y: Directive<HTMLElement> = { mounted: synchronize, updated: synchronize };
