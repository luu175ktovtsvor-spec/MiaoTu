import { IconPencil, IconEraser, IconBackground, IconUser, IconShirt, IconPhotoScan } from "@tabler/icons-vue";
import type { CanvasTool } from "../../canvasToolCatalogue";
import type { NodeMediaModel } from "../../scaffold/nodeAi";

export const imageIntents = [
  { id: "image:edit-element", label: "元素编辑", prompt: "", icon: IconPencil },
  { id: "image:erase-object", label: "擦除物体", prompt: "移除选区内的对象，自然补齐背景；尽可能保留选区外的主体、构图和细节。", icon: IconEraser },
  { id: "image:remove-background", label: "生成透明背景", prompt: "移除参考图背景，仅保留主体，生成透明背景；尽可能保留主体的形状、颜色与细节，不添加新物体。", icon: IconBackground },
  { id: "image:portrait-texture", label: "人像质感", prompt: "调整参考人像的皮肤与材质质感，保留自然毛孔和细节，减少过度磨皮；尽可能保持人物特征、年龄、发型、服装与构图。", icon: IconUser },
  { id: "image:restyle", label: "造型调整", prompt: "", icon: IconShirt },
  { id: "image:ai-redraw", label: "AI高清重绘", prompt: "以参考图为依据进行高质量细节重绘，改善清晰度、纹理和光影；尽可能保持主体、构图、文字和色彩，不添加新物体。", icon: IconPhotoScan },
] as const;
export type ImageIntentId = typeof imageIntents[number]["id"];
export function imageIntent(id: string) { return imageIntents.find(item => item.id === id); }
export function imageIntentModels(id: string, models: NodeMediaModel[]) {
  if (!imageIntent(id)) return [];
  return models.filter(model => model.type === "image" && model.supportsEdit === true
    && (model.maxReferences ?? 0) >= 1 && Boolean(model.imageSizes?.length)
    && (id !== "image:erase-object" || model.regionEdit === "mask" || model.regionEdit === "annotation")
    // Alpha-only contracts cannot remove a background from an ordinary JPG.
    && (id !== "image:remove-background" || model.supportsTransparent === true
      && model.transparentInput === "any-image" && model.formats?.includes("png")));
}
export const imageIntentTools: CanvasTool[] = imageIntents.map(item => ({
  id: item.id, label: item.label, group: "图片编辑", icon: item.icon,
  capability: models => imageIntentModels(item.id, models).length > 0,
}));
