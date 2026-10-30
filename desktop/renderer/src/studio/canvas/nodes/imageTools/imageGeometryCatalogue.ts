import { IconCrop, IconRotateClockwise, IconFlipHorizontal } from "@tabler/icons-vue";
import type { CanvasTool } from "../../canvasToolCatalogue";
export const imageGeometryActions = [
  { id: "image:crop", label: "裁剪图片", icon: IconCrop },
  { id: "image:rotate", label: "旋转图片", icon: IconRotateClockwise },
  { id: "image:mirror", label: "镜像图片", icon: IconFlipHorizontal },
] as const;
export type ImageGeometryId = typeof imageGeometryActions[number]["id"];
export const imageGeometryTools: CanvasTool[] = imageGeometryActions.map(item => ({ ...item, group: "图片编辑" }));
export const isImageGeometry = (id: string): id is ImageGeometryId => imageGeometryActions.some(item => item.id === id);
