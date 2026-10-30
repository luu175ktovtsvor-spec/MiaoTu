import type { ObjectDirective } from "vue";

// Element Plus 2.14 initializes these attributes on mount but updates only
// aria-valuenow afterwards. Preserve the input instance and its keyboard focus.
function syncNumberAria(element: HTMLElement) {
  const input = element.querySelector("input");
  if (!input) return;
  input.setAttribute("aria-disabled", String(input.disabled));
  for (const name of ["min", "max"] as const) {
    const value = input.getAttribute(name);
    if (value !== null && Number.isFinite(Number(value))) input.setAttribute(`aria-value${name}`, value);
    else input.removeAttribute(`aria-value${name}`);
  }
}

export const vNumberAria: ObjectDirective<HTMLElement> = {
  mounted: syncNumberAria,
  updated: syncNumberAria,
};
