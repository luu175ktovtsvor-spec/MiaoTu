import { computed } from "vue";
import { uiSettings } from "@/stores/settings";

// One theme for the canvas and every body-mounted dialog/popover.
export const canvasTheme = computed(() => {
  const { radius, fontScale } = uiSettings.value;
  const color = "var(--color-accent)";
  return {
    "--el-color-primary": color,
    "--canvas-accent-ink": "var(--color-accent-ink)",
    "--el-border-radius-base": radius + "px",
    "--canvas-card-radius": Math.max(10, radius) + "px",
    "--canvas-font-scale": String(fontScale / 100),
    fontSize: fontScale + "%",
  };
});
