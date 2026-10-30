import { translate } from "@miaoimg/i18n/vue";
export type PixelRect = { x: number; y: number; width: number; height: number };
export type ImageGeometry = { crop: PixelRect; turns: 0 | 1 | 2 | 3; flipX: boolean; flipY: boolean };
export function assertGeometrySize(width: number, height: number) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || width * height > 36_000_000)
    throw new Error(translate("本地图片处理支持最长边8192像素、最多3600万像素"));
}
export function validPixelRect(rect: PixelRect, width: number, height: number) {
  return Object.values(rect).every(Number.isSafeInteger) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= width && rect.y + rect.height <= height;
}
export function fitCrop(width: number, height: number, ratio: number): PixelRect {
  const cropWidth = ratio > 0 ? Math.min(width, Math.round(height * ratio)) : width;
  const cropHeight = ratio > 0 ? Math.min(height, Math.round(width / ratio)) : height;
  return { x: Math.floor((width - cropWidth) / 2), y: Math.floor((height - cropHeight) / 2), width: Math.max(1, cropWidth), height: Math.max(1, cropHeight) };
}
// Pointer coordinates are measured in the displayed oriented image, then mapped
// to integer original pixels. The preview never becomes the export source.
export function pixelPoint(clientX: number, clientY: number, bounds: Pick<DOMRect, "left" | "top" | "width" | "height">, width: number, height: number) {
  return { x: Math.max(0, Math.min(width, Math.round((clientX - bounds.left) / bounds.width * width))),
    y: Math.max(0, Math.min(height, Math.round((clientY - bounds.top) / bounds.height * height))) };
}
export function dragCrop(start: { x: number; y: number }, end: { x: number; y: number }, width: number, height: number, ratio = 0): PixelRect {
  const sx = end.x < start.x ? -1 : 1, sy = end.y < start.y ? -1 : 1;
  let w = Math.max(1, Math.abs(end.x - start.x)), h = Math.max(1, Math.abs(end.y - start.y));
  const maxW = sx > 0 ? width - start.x : start.x, maxH = sy > 0 ? height - start.y : start.y;
  if (ratio > 0) {
    w = Math.min(Math.max(w, h * ratio), maxW, maxH * ratio); h = w / ratio;
  } else { w = Math.min(w, maxW); h = Math.min(h, maxH); }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  return { x: sx > 0 ? Math.min(start.x, width - w) : Math.max(0, start.x - w), y: sy > 0 ? Math.min(start.y, height - h) : Math.max(0, start.y - h), width: w, height: h };
}
export function renderImageGeometry(source: CanvasImageSource & { width: number; height: number }, settings: ImageGeometry, previewMax?: number) {
  const rect = settings.crop;
  if (!validPixelRect(rect, source.width, source.height)) throw new Error(translate("请设置有效裁剪范围"));
  const swap = settings.turns % 2 === 1;
  const width = swap ? rect.height : rect.width, height = swap ? rect.width : rect.height;
  assertGeometrySize(width, height);
  const scale = previewMax ? Math.min(1, previewMax / Math.max(width, height)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(translate("无法创建图片画布"));
  context.scale(canvas.width / width, canvas.height / height);
  context.translate(width / 2, height / 2);
  context.rotate(settings.turns * Math.PI / 2);
  context.scale(settings.flipX ? -1 : 1, settings.flipY ? -1 : 1);
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
  return canvas;
}
export async function geometryPng(source: ImageBitmap, settings: ImageGeometry) {
  const canvas = renderImageGeometry(source, settings);
  try { return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(translate("图片处理失败"))), "image/png")); }
  finally { canvas.width = canvas.height = 0; }
}
