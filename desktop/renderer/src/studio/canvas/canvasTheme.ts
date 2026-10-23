import { computed } from "vue";
import { uiSettings } from "@/stores/settings";

// One theme for the canvas and every body-mounted dialog/popover.
export const canvasTheme = computed(() => {
  const { radius, fontScale } = uiSettings.value;
  const color = "var(--color-accent)";
  return {
    "--el-color-primary": color,
    // 由强调色和面板底色推出整套深浅：选中底、悬停、按下都跟着强调色走，
    // 不再落回组件库默认的浅蓝，浅色或深色强调色上的字都看得清。
    "--el-color-primary-light-3": `color-mix(in srgb, ${color} 72%, var(--color-surface))`,
    "--el-color-primary-light-5": `color-mix(in srgb, ${color} 52%, var(--color-surface))`,
    "--el-color-primary-light-7": `color-mix(in srgb, ${color} 32%, var(--color-surface))`,
    "--el-color-primary-light-8": `color-mix(in srgb, ${color} 22%, var(--color-surface))`,
    "--el-color-primary-light-9": `color-mix(in srgb, ${color} 13%, var(--color-surface))`,
    "--el-color-primary-dark-2": `color-mix(in srgb, ${color} 82%, var(--color-ink))`,
    "--canvas-accent-ink": "var(--color-accent-ink)",
    "--el-border-radius-base": radius + "px",
    "--canvas-card-radius": Math.max(10, radius) + "px",
    "--canvas-font-scale": String(fontScale / 100),
    fontSize: fontScale + "%",
  };
});
