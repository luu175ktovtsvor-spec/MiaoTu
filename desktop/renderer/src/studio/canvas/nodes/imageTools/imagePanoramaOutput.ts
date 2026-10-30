import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { fitsCustomSize } from "../../scaffold/nodeAi";
type PanoramaModel = Pick<NodeMediaModel, "imageSizes" | "imageRatios" | "sizes" | "customSize" | "sizeRule" | "maxReferences">;
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;

// A concrete pixel size carries the aspect ratio itself. Never invent a ratio
// in the model catalogue merely because its custom-size range can express it.
export function imagePanoramaOutput(model: PanoramaModel, kind: "sphere" | "cylinder", preferredSize?: string) {
  if (!(model.maxReferences && model.maxReferences > 0)) return undefined;
  const a = kind === "sphere" ? 2 : 4, ratio = `${a}:1`;
  const pixelsMatch = (size: string) => {
    const match = /^(\d+)x(\d+)$/.exec(size);
    return Boolean(match && Number(match[1]) === Number(match[2]) * a
      && (model.imageSizes?.includes(size) || model.customSize && fitsCustomSize(model.sizeRule, size)));
  };
  if (preferredSize) {
    if (pixelsMatch(preferredSize)) return { size: preferredSize, ratio: "" };
    if (model.imageSizes?.includes(preferredSize) && !/^\d+x\d+$/.test(preferredSize) && model.imageRatios?.includes(ratio)) return { size: preferredSize, ratio };
    return undefined;
  }
  const listed = model.imageSizes?.find(pixelsMatch);
  if (listed) return { size: listed, ratio: "" };
  const independent = model.imageRatios?.includes(ratio) ? model.imageSizes?.find(size => !/^\d+x\d+$/.test(size)) : undefined;
  if (independent) return { size: independent, ratio };
  const rule = model.customSize ? model.sizeRule : undefined;
  if (!rule || !Number.isFinite(rule.minPixels) || rule.minPixels <= 0 || a < rule.minRatio || a > rule.maxRatio) return undefined;
  const step = Number.isSafeInteger(rule.multipleOf) && rule.multipleOf! > 0 ? rule.multipleOf! : 1;
  const unit = (step / gcd(a, step)) * step / gcd(step / gcd(a, step), step);
  const scale = Math.ceil(Math.sqrt(rule.minPixels / a) / unit) * unit;
  const size = `${a * scale}x${scale}`;
  return fitsCustomSize(rule, size) ? { size, ratio: "" } : undefined;
}
