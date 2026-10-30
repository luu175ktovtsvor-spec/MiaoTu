import { IconSun, IconCameraRotate, IconPanoramaHorizontal, IconPencil, IconLayoutGrid, IconBrush, IconLayersSubtract, IconTemplate, IconPhotoScan, IconMusic, IconScissors, IconGauge, IconFileMusic, IconLayoutBoard, IconCube, IconArrowAutofitRight } from "@tabler/icons-vue";
import { imagePresets } from "./nodes/imageTools/imagePresets";
import { imageIntentTools } from "./nodes/imageTools/imageIntentCatalogue";
import { imageGeometryTools } from "./nodes/imageTools/imageGeometryCatalogue";
import { imageOutpaintTools } from "./nodes/imageTools/imageOutpaintCatalogue";
import { videoIntentTools } from "./videoIntentCatalogue";
import { videoLocalTools, audioLocalTools } from "./videoLocalCatalogue";
import type { NodeMediaModel } from "./scaffold/nodeAi";
import type { Component } from "vue";
import { imagePanoramaOutput } from "./nodes/imageTools/imagePanoramaOutput";

export type CanvasToolId = "image:lighting" | "image:angle" | "image:mark" | "image:inpaint" | "image:grid" | "image:layers"
  | "image:outpaint" | "image:crop" | "image:rotate" | "image:mirror"
  | "image:edit-element" | "image:erase-object" | "image:remove-background" | "image:portrait-texture" | "image:restyle" | "image:ai-redraw"
  | "image:generateSphere" | "image:generateCylinder" | "image:previewSphere" | "image:previewCylinder" | `image:preset:${string}`
  | "video:capture" | "video:extractAudio" | "video:separate" | "video:trim" | "video:edit" | "video:extend"
  | "video:replace-element" | "video:remove-subject" | "video:remove-subtitles" | "video:edit-background" | "video:edit-person" | "video:retake-segment"
  | "video:crop" | "video:speed"
  | "audio:clip" | "audio:speed" | "audio:convert" | "audio:split-silence" | "text:storyboard";
export type CanvasTool = { id: CanvasToolId; label: string; group: string; icon: Component; capability?: (models: NodeMediaModel[]) => boolean };
const images = (models: NodeMediaModel[]) => models.filter(model => model.type === "image");
const imageEdit = (models: NodeMediaModel[]) => images(models).some(model => (model.maxReferences ?? 0) > 0);
const imageGroup = "图片编辑", videoGroup = "视频编辑", audioGroup = "音频编辑";
export const canvasTools: CanvasTool[] = [
  { id: "video:capture", label: "截取视频帧", group: videoGroup, icon: IconPhotoScan },
  { id: "video:extractAudio", label: "提取音轨", group: videoGroup, icon: IconMusic },
  { id: "video:separate", label: "分离音视频", group: videoGroup, icon: IconLayersSubtract },
  { id: "video:trim", label: "片段截取", group: videoGroup, icon: IconScissors },
  ...videoLocalTools,
  ...videoIntentTools,
  { id: "video:extend", label: "延长视频", group: videoGroup, icon: IconArrowAutofitRight, capability: models => models.some(model => model.type === "video" && model.mode?.includes("extend")) },
  { id: "image:lighting", label: "打光", group: imageGroup, icon: IconSun, capability: imageEdit },
  { id: "image:angle", label: "多角度", group: imageGroup, icon: IconCameraRotate, capability: imageEdit },
  { id: "image:grid", label: "宫格切分", group: imageGroup, icon: IconLayoutGrid },
  { id: "image:layers", label: "图层分离", group: imageGroup, icon: IconLayersSubtract, capability: models => images(models).some(model => model.supportsLayerDecomposition) },
  { id: "image:generateSphere", label: "生成720°全景图", group: imageGroup, icon: IconPanoramaHorizontal, capability: models => images(models).some(model => (model.maxReferences ?? 0) > 0 && imagePanoramaOutput(model, "sphere")) },
  { id: "image:generateCylinder", label: "生成360°环绕图", group: imageGroup, icon: IconPanoramaHorizontal, capability: models => images(models).some(model => (model.maxReferences ?? 0) > 0 && imagePanoramaOutput(model, "cylinder")) },
  { id: "image:previewSphere", label: "预览720°全景图", group: imageGroup, icon: IconPanoramaHorizontal },
  { id: "image:previewCylinder", label: "预览360°环绕图", group: imageGroup, icon: IconPanoramaHorizontal },
  { id: "image:mark", label: "标注", group: imageGroup, icon: IconPencil },
  { id: "image:inpaint", label: "重绘", group: imageGroup, icon: IconBrush, capability: models => images(models).some(model => Boolean(model.regionEdit)) },
  ...imageIntentTools,
  ...imageGeometryTools,
  ...imageOutpaintTools,
  ...imagePresets.map(preset => ({ id: `image:preset:${preset.id}` as CanvasToolId, label: preset.label, group: imageGroup, icon: IconTemplate, capability: imageEdit })),
  { id: "audio:clip", label: "截取与拼接", group: audioGroup, icon: IconScissors },
  { id: "audio:speed", label: "变速", group: audioGroup, icon: IconGauge },
  { id: "audio:convert", label: "转换音频格式", group: audioGroup, icon: IconFileMusic },
  ...audioLocalTools,
  { id: "text:storyboard", label: "生成分镜", group: "文本工具", icon: IconLayoutBoard, capability: models => images(models).length > 0 },
];
export const directorTool = { label: "导演台", group: "小工具", icon: IconCube };
export function toolCapability(id: CanvasToolId, models: NodeMediaModel[]) {
  const tool = canvasTools.find(item => item.id === id);
  return Boolean(tool && (!tool.capability || tool.capability(models)));
}
