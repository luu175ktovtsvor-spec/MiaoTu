import type { NodeMediaModel } from "../../scaffold/nodeAi";
import { durationsForMode, inheritedFields, ratiosForMode, resolutionsForMode } from "../../scaffold/mediaParameters.ts";

export type EditMediaMetadata = { kind: "video" | "image" | "audio"; duration?: number; sizeBytes: number; width?: number; height?: number; fps?: number; format?: string; codec?: string; mimeType: string; revision?: string };
export type VideoEditIssue = { key: string; params?: Record<string, string | number> };
type EditInputs = { source?: EditMediaMetadata; images: EditMediaMetadata[]; audios: EditMediaMetadata[] };
const issue = (key: string, params?: VideoEditIssue["params"]): VideoEditIssue => ({ key, ...(params ? { params } : {}) });
function bounds(model: NodeMediaModel, kind: "image" | "video" | "audio") {
  return model.parameterRules?.referencesByMode?.edit?.[kind] ?? [kind === "video" ? 1 : 0, kind === "video" ? Math.max(1, model.referenceLimits?.video ?? 1) : model.referenceLimits?.[kind] ?? 0];
}
function policy(model: NodeMediaModel, kind: string) {
  return { ...(model.referenceInputs?.[kind] || {}), ...(model.parameterRules?.referenceInputsByMode?.edit?.[kind] || {}) } as Record<string, any>;
}
function mediaIssue(model: NodeMediaModel, media: EditMediaMetadata, label: string): VideoEditIssue | undefined {
  const rule = policy(model, media.kind);
  if (!Number.isFinite(media.sizeBytes) || media.sizeBytes <= 0 || media.kind !== "audio" && (!Number.isFinite(media.width) || !Number.isFinite(media.height) || media.width! <= 0 || media.height! <= 0)
    || media.kind !== "image" && (!Number.isFinite(media.duration) || media.duration! <= 0)) return issue("无法读取 {0} 的有效素材信息", { 0: label });
  if (rule.maxBytes && (rule.exclusiveMaxBytes ? media.sizeBytes >= rule.maxBytes : media.sizeBytes > rule.maxBytes)) return issue("{0} 超过所选模型的文件大小上限", { 0: label });
  if (rule.minDuration != null && media.duration! < rule.minDuration || rule.maxDuration != null && media.duration! > rule.maxDuration) {
    if (rule.minDuration != null && rule.maxDuration != null) return issue("{0} 时长需为 {1}–{2} 秒", { 0: label, 1: rule.minDuration, 2: rule.maxDuration });
    if (rule.maxDuration != null) return issue("{0} 时长不能超过 {1} 秒", { 0: label, 1: rule.maxDuration });
    return issue("{0} 时长不能少于 {1} 秒", { 0: label, 1: rule.minDuration });
  }
  const formats = String(media.format || "").toLowerCase().split(",");
  if (rule.formats?.length && !rule.formats.some((format: string) => formats.includes(format.toLowerCase())) || rule.codecs?.length && !rule.codecs.includes(media.codec)
    || rule.mimes?.length && !rule.mimes.includes(media.mimeType)) return issue("{0} 的格式不符合所选模型要求", { 0: label });
  if (media.kind !== "audio") {
    const edge = [media.width!, media.height!], pixels = edge[0] * edge[1], ratio = edge[0] / edge[1];
    if (rule.minEdge && Math.min(...edge) < rule.minEdge || rule.maxEdge && Math.max(...edge) > rule.maxEdge
      || rule.minPixels && pixels < rule.minPixels || rule.maxPixels && pixels > rule.maxPixels
      || rule.minRatio && ratio < rule.minRatio || rule.maxRatio && ratio > rule.maxRatio) return issue("{0} 的尺寸不符合所选模型要求", { 0: label });
    if (media.kind === "video" && (rule.minFps && (!Number.isFinite(media.fps) || media.fps! < rule.minFps) || rule.maxFps && (!Number.isFinite(media.fps) || media.fps! > rule.maxFps))) return issue("原视频帧率不符合所选模型要求");
  }
}
export function videoEditEligibility(model: NodeMediaModel, inputs: EditInputs): VideoEditIssue | undefined {
  if (model.type !== "video" || !model.mode?.includes("edit")) return issue("当前模型不支持视频编辑");
  if (!inputs.source) return issue("正在读取原视频信息");
  const sourceIssue = mediaIssue(model, inputs.source, "原视频");
  if (sourceIssue) return sourceIssue;
  for (const [kind, count] of [["video", 1], ["image", inputs.images.length], ["audio", inputs.audios.length]] as const) {
    const [min, max] = bounds(model, kind);
    if (count < min || count > max) return issue("所选模型不支持当前附加素材，请保留素材并选择其他模型");
  }
  for (const media of [...inputs.images, ...inputs.audios]) {
    const invalid = mediaIssue(model, media, media.kind === "image" ? "参考图片" : "参考音频");
    if (invalid) return invalid;
  }
  // Current Seedance editing contracts apply the advertised audio duration
  // ceiling to the combined references as well as each individual clip.
  const audioLimit = policy(model, "audio").maxTotalDuration ?? policy(model, "audio").maxDuration;
  if (audioLimit && inputs.audios.reduce((total, audio) => total + Number(audio.duration || 0), 0) > audioLimit) return issue("参考音频总时长超过所选模型上限");
  const defaults = videoEditDefaults(model, inputs.source.duration!);
  if (defaults.duration === undefined || !defaults.resolution) return issue("当前模型没有可用的视频编辑规格");
}
export function videoEditDefaults(model: NodeMediaModel, sourceSeconds: number) {
  const parameters = Object.fromEntries((model.controls || []).filter(control => control.default !== undefined).map(control => [control.key, control.default]));
  const durations = durationsForMode(model, "edit");
  const inherited = inheritedFields(model, "edit");
  const duration = inherited.includes("duration") && durations.includes(-1) ? -1
    : durations.filter(value => value > 0).sort((a, b) => Math.abs(a - sourceSeconds) - Math.abs(b - sourceSeconds))[0];
  const resolutions = resolutionsForMode(model, "edit", duration, parameters);
  const preferred = (model as NodeMediaModel & { defaultResolution?: string }).defaultResolution;
  const resolution = preferred && resolutions.includes(preferred) ? preferred : resolutions[0] || "";
  const ratios = ratiosForMode(model, "edit");
  return { duration, resolution, ratio: ratios.includes("adaptive") ? "adaptive" : ratios[0] || "", parameters, generateAudio: true };
}
export function validSemanticRange(start: number, end: number, duration: number) { return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(duration) && start >= 0 && end > start && end <= duration; }
export function preparedVideoEditData(input: { model: NodeMediaModel; label: string; prompt: string; sourceSeconds: number; duration?: number; resolution?: string; range?: { start: number; end: number }; intent: string }) {
  if (input.model.type !== "video" || !input.model.mode?.includes("edit")) throw new Error("当前模型不支持视频编辑");
  const defaults = videoEditDefaults(input.model, input.sourceSeconds);
  const duration = input.duration ?? defaults.duration, resolution = input.resolution ?? defaults.resolution;
  if (!durationsForMode(input.model, "edit").includes(duration!) || !resolutionsForMode(input.model, "edit", duration, defaults.parameters).includes(resolution)) throw new Error("当前模型没有可用的视频编辑规格");
  if (!input.prompt.trim()) throw new Error("请填写具体编辑要求");
  const promptLimit = input.model.parameterRules?.maxPromptCharacters;
  if (promptLimit && [...input.prompt.trim()].length > promptLimit) throw new Error("编辑描述超过当前模型的字符上限");
  if (input.range && !validSemanticRange(input.range.start, input.range.end, input.sourceSeconds)) throw new Error("编辑时间段须在原视频范围内");
  return { label: input.label, ...defaults, duration, resolution, mode: JSON.stringify("edit"), modeChosen: true,
    model: JSON.stringify([input.model.providerId, input.model.modelId]), prompt: input.prompt.trim(),
    promptModel: input.prompt.trim().split("\n").map(text => [{ type: "Write", text }]),
    videoEditIntent: input.intent, ...(input.range ? { semanticEditRange: input.range } : {}) };
}
