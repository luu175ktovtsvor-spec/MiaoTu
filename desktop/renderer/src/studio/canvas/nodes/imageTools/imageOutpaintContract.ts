import { translate } from "@miaoimg/i18n/vue";
import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { fitsCustomSize } from "../../scaffold/nodeAi";
import { assertGeometrySize } from "./imageGeometry";

export type OutpaintGeometry = { width: number; height: number; left: number; top: number; sourceWidth: number; sourceHeight: number };
export type OutpaintSettings = { left: number; right: number; top: number; bottom: number; ratio: string; anchorX: number; anchorY: number };
export type PreparedOutpaint = {
  version: 1; imagePath: string; maskPath: string; sourcePath: string;
  imageRevision: string; maskRevision: string; geometry: OutpaintGeometry;
  imageBytes: number; maskBytes: number;
  config: { providerId: string; modelId: string; prompt: string; size: string; ratio: string };
};
type ImagePolicy = NonNullable<NodeMediaModel["referenceInputs"]>[string] & { exclusiveMaxBytes?: boolean; minPixels?: number; maxPixels?: number; minRatio?: number; maxRatio?: number };
const fail = () => new Error(translate("扩展画布不符合当前模型限制，请调整扩展范围或更换模型"));
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

export function outpaintModel(model: NodeMediaModel) {
  const policy = model.referenceInputs?.image;
  return model.type === "image" && model.supportsEdit === true && model.regionEdit === "mask"
    && (model.maxReferences ?? 0) >= 1 && model.formats?.includes("png")
    && policy?.mimes?.includes("image/png") && Number.isFinite(policy.maxBytes) && policy.maxBytes! > 0
    && (model.customSize && model.sizeRule || model.imageSizes?.some(size => /^\d+x\d+$/.test(size)));
}

export function outpaintGeometry(width: number, height: number, settings: OutpaintSettings, multiple = 1): OutpaintGeometry {
  assertGeometrySize(width, height);
  const step = Number.isSafeInteger(multiple) && multiple > 0 ? multiple : 1;
  if (![settings.left, settings.right, settings.top, settings.bottom].every(value => Number.isFinite(value) && value >= 0 && value <= 400)
    || ![settings.anchorX, settings.anchorY].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw fail();
  let targetWidth: number, targetHeight: number, left: number, top: number;
  const match = /^(\d+):(\d+)$/.exec(settings.ratio);
  if (settings.ratio !== "free" && !match) throw fail();
  if (match) {
    const divisor = gcd(Number(match[1]), Number(match[2]));
    const a = Number(match[1]) / divisor, b = Number(match[2]) / divisor;
    if (!(a > 0 && b > 0)) throw fail();
    const unitA = step / gcd(a, step), unitB = step / gcd(b, step);
    const unit = unitA * unitB / gcd(unitA, unitB);
    const minimumWidth = width * (1 + (settings.left + settings.right) / 100);
    const minimumHeight = height * (1 + (settings.top + settings.bottom) / 100);
    const scale = Math.ceil(Math.max(minimumWidth / a, minimumHeight / b) / unit) * unit;
    targetWidth = a * scale; targetHeight = b * scale;
    left = Math.round((targetWidth - width) * settings.anchorX); top = Math.round((targetHeight - height) * settings.anchorY);
  } else {
    if (!(settings.left + settings.right + settings.top + settings.bottom > 0)) throw fail();
    left = Math.round(width * settings.left / 100); top = Math.round(height * settings.top / 100);
    const requestedWidth = width + left + Math.round(width * settings.right / 100);
    const requestedHeight = height + top + Math.round(height * settings.bottom / 100);
    targetWidth = Math.ceil(requestedWidth / step) * step;
    targetHeight = Math.ceil(requestedHeight / step) * step;
    if (settings.left > 0 && settings.right === 0) left += targetWidth - requestedWidth;
    if (settings.top > 0 && settings.bottom === 0) top += targetHeight - requestedHeight;
  }
  const geometry = { width: targetWidth, height: targetHeight, left, top, sourceWidth: width, sourceHeight: height };
  assertOutpaintGeometry(geometry);
  return geometry;
}

export function assertOutpaintGeometry(geometry: OutpaintGeometry) {
  const { width, height, left, top, sourceWidth, sourceHeight } = geometry;
  assertGeometrySize(width, height); assertGeometrySize(sourceWidth, sourceHeight);
  if (!Object.values(geometry).every(Number.isSafeInteger) || left < 0 || top < 0 || sourceWidth + left > width || sourceHeight + top > height
    || width * height <= sourceWidth * sourceHeight) throw fail();
}

export function outpaintSize(model: NodeMediaModel, geometry: OutpaintGeometry) {
  assertOutpaintGeometry(geometry);
  if (!outpaintModel(model)) throw fail();
  const size = `${geometry.width}x${geometry.height}`;
  if (!model.imageSizes?.includes(size) && !(model.customSize && fitsCustomSize(model.sizeRule, size))) throw fail();
  const policy = model.referenceInputs!.image as ImagePolicy;
  const pixels = geometry.width * geometry.height, ratio = geometry.width / geometry.height;
  if (policy.minEdge && Math.min(geometry.width, geometry.height) < policy.minEdge || policy.maxEdge && Math.max(geometry.width, geometry.height) > policy.maxEdge
    || policy.minPixels && pixels < policy.minPixels || policy.maxPixels && pixels > policy.maxPixels
    || policy.minRatio && ratio < policy.minRatio || policy.maxRatio && ratio > policy.maxRatio) throw fail();
  return size;
}

export function assertOutpaintBytes(model: NodeMediaModel, imageBytes: number, maskBytes: number) {
  const policy = model.referenceInputs?.image as ImagePolicy | undefined;
  const limit = policy?.maxBytes;
  if (!Number.isFinite(limit) || !limit || ![imageBytes, maskBytes].every(bytes => Number.isSafeInteger(bytes) && bytes > 0
    && (policy.exclusiveMaxBytes ? bytes < limit : bytes <= limit))
    || (Math.ceil(imageBytes / 3) + Math.ceil(maskBytes / 3)) * 4 + 64 * 1024 > 200 * 1024 * 1024)
    throw new Error(translate("扩图文件超过当前模型限制，请减少扩展范围或更换模型"));
}

export function assertPreparedPng(bytes: Uint8Array, geometry: OutpaintGeometry, mask = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = [137,80,78,71,13,10,26,10];
  if (bytes.length < 33 || !signature.every((value, i) => bytes[i] === value) || String.fromCharCode(...bytes.slice(12,16)) !== "IHDR"
    || view.getUint32(16) !== geometry.width || view.getUint32(20) !== geometry.height
    || mask && (bytes[24] !== 8 || bytes[25] !== 6 || bytes[28] !== 0)) throw new Error(translate("扩图画布或蒙版无效，请重新准备"));
}

export async function renderOutpaintFiles(source: ImageBitmap, geometry: OutpaintGeometry, signal: AbortSignal) {
  assertOutpaintGeometry(geometry); signal.throwIfAborted();
  if (source.width !== geometry.sourceWidth || source.height !== geometry.sourceHeight) throw fail();
  async function encode(mask: boolean) {
    signal.throwIfAborted();
    const canvas = document.createElement("canvas"); canvas.width = geometry.width; canvas.height = geometry.height;
    try {
      const context = canvas.getContext("2d"); if (!context) throw new Error(translate("无法创建图片画布"));
      if (mask) { context.fillStyle = "#000"; context.fillRect(geometry.left, geometry.top, geometry.sourceWidth, geometry.sourceHeight); }
      else { context.imageSmoothingEnabled = false; context.drawImage(source, geometry.left, geometry.top); }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(translate("图片编码失败"))), "image/png"));
      signal.throwIfAborted(); assertPreparedPng(new Uint8Array(await blob.arrayBuffer()), geometry, mask); signal.throwIfAborted();
      return new File([blob], mask ? "outpaint-mask.png" : "outpaint.png", { type: "image/png" });
    } finally { canvas.width = canvas.height = 0; }
  }
  // Encode sequentially so two full-size RGBA canvases are never held at once.
  return { image: await encode(false), mask: await encode(true) };
}
