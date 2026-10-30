export type PixelCrop = { x: number; y: number; width: number; height: number };
export type VideoGeometry = { width: number; height: number; sarNumerator: number; sarDenominator: number; displayRatio: number };
const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const even = (value: number) => Math.floor(value / 2) * 2;
export function videoGeometry(stream: Record<string, any>): VideoGeometry {
  const width = Number(stream.width), height = Number(stream.height);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 2 || height < 2) throw new Error("无法读取有效的视频尺寸");
  const angle = Number(stream.side_data_list?.find((item: any) => item.rotation != null)?.rotation ?? stream.tags?.rotate ?? 0);
  if (!Number.isFinite(angle) || Math.abs(angle / 90 - Math.round(angle / 90)) > 0.00001) throw new Error("当前裁剪暂不支持此旋转角度，请先转码");
  let [n, d] = String(stream.sample_aspect_ratio || "1:1").split(":").map(Number);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || n <= 0 || d <= 0) n = d = 1;
  const rotate = Math.abs(Math.round(angle / 90)) % 2 === 1;
  if (rotate) [n, d] = [d, n];
  const w = rotate ? height : width, h = rotate ? width : height;
  return { width: w, height: h, sarNumerator: n, sarDenominator: d, displayRatio: w * n / d / h };
}
export function normalizedCrop(crop: PixelCrop, geometry: VideoGeometry): PixelCrop {
  if (Object.values(crop).some(value => !Number.isFinite(value))) throw new Error("裁剪坐标必须为有效数字");
  const x = Math.max(0, Math.min(even(geometry.width) - 2, even(crop.x)));
  const y = Math.max(0, Math.min(even(geometry.height) - 2, even(crop.y)));
  return { x, y, width: Math.max(2, Math.min(even(geometry.width - x), even(crop.width))), height: Math.max(2, Math.min(even(geometry.height - y), even(crop.height))) };
}
export function aspectCrop(ratio: string, geometry: VideoGeometry): PixelCrop | undefined {
  if (ratio === "free" || ratio === "original") return normalizedCrop({ x: 0, y: 0, width: geometry.width, height: geometry.height }, geometry);
  const pair = /^(\d+):(\d+)$/.exec(ratio); if (!pair) return;
  let w = Number(pair[1]) * geometry.sarDenominator, h = Number(pair[2]) * geometry.sarNumerator;
  const factor = gcd(w, h); w /= factor; h /= factor;
  const multiple = w % 2 || h % 2 ? 2 : 1;
  const count = Math.floor(Math.min(geometry.width / w, geometry.height / h) / multiple) * multiple;
  if (count < 1) return;
  return normalizedCrop({ x: (geometry.width - w * count) / 2, y: (geometry.height - h * count) / 2, width: w * count, height: h * count }, geometry);
}
export function audioTempoFilters(speed: number) {
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 4) throw new Error("视频速度须在 0.1 至 4 倍之间");
  let tempo = speed; const filters: string[] = [];
  while (tempo < 0.5) { filters.push("atempo=0.5"); tempo /= 0.5; }
  while (tempo > 2) { filters.push("atempo=2"); tempo /= 2; }
  return [...filters, `atempo=${tempo}`];
}
