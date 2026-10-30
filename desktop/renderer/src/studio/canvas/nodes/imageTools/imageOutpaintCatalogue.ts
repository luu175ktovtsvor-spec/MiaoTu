import { IconArrowsMaximize } from "@tabler/icons-vue";
import type { CanvasTool } from "../../canvasToolCatalogue";
import { outpaintModel } from "./imageOutpaintContract";
export const imageOutpaintTools: CanvasTool[] = [{ id: "image:outpaint", label: "扩图", group: "图片编辑", icon: IconArrowsMaximize,
  capability: models => models.some(model => Boolean(outpaintModel(model))) }];
