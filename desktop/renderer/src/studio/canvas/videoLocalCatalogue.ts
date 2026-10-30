import { IconCrop, IconGauge, IconScissors } from "@tabler/icons-vue";
import type { CanvasTool } from "./canvasToolCatalogue";
export const videoLocalTools: CanvasTool[] = [
  { id: "video:crop", label: "画面裁剪", group: "视频编辑", icon: IconCrop },
  { id: "video:speed", label: "视频变速", group: "视频编辑", icon: IconGauge },
];
export const audioLocalTools: CanvasTool[] = [
  { id: "audio:split-silence", label: "按静音切分", group: "音频编辑", icon: IconScissors },
];
