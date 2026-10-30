import type { NodeMediaValue } from "../../scaffold/values";

export type SegmentRange = { id: string; start: number; end: number };
export type SegmentSource = { nodeId: string; handle: string; file: NodeMediaValue; revision: string; duration: number; width: number; height: number; fps: number };
export type SegmentRemakeDraft = { version: 1; source: SegmentSource; ranges: SegmentRange[] };
export type SegmentRemakePart = SegmentRange & { input: NodeMediaValue; prompt: string; taskRequestId?: string; completedRequestId?: string; output?: NodeMediaValue; state: "ready" | "pending" | "complete" | "failed"; error?: string };
export type SegmentRemakeRun = {
  id: string; source: SegmentSource; parts: SegmentRemakePart[];
  draftSourceRevision?: string;
  phase: "ready" | "generating" | "paused" | "merging" | "complete";
  model: string; resolution: string; ratio: string; parameters: Record<string, unknown>;
  audio: "original" | "generated"; generateAudio: boolean;
  references: { images: NodeMediaValue[]; audios: NodeMediaValue[] };
  result?: NodeMediaValue;
};
export type SegmentRemakeData = { segmentRemakeDraft?: SegmentRemakeDraft; segmentRemakeRun?: SegmentRemakeRun; segmentRemakeAudio?: "original" | "generated" };

export function normalizeSegmentRanges(ranges: readonly SegmentRange[], duration: number): SegmentRange[] {
  if (!Number.isFinite(duration) || duration < 4) throw new Error("原视频至少需要 4 秒");
  if (!ranges.length || ranges.length > 5) throw new Error("请选择 1–5 个重拍片段");
  const ids = new Set<string>();
  const result = ranges.map(range => {
    const start = Math.round(range.start * 100) / 100, end = Math.round(range.end * 100) / 100;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(range.id) || ids.has(range.id) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 0.000001
      || end - start < 4 - 0.000001 || end - start > 30 + 0.000001) throw new Error("每个重拍片段需为 4–30 秒，且在原视频范围内");
    ids.add(range.id); return { id: range.id, start, end };
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  if (result.some((range, index) => index > 0 && range.start < result[index - 1].end - 0.000001)) throw new Error("重拍片段不能重叠");
  return result;
}

export function segmentRangeLabel(range: SegmentRange) {
  const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
  return `${time(Math.floor(range.start))}–${time(Math.ceil(range.end))}`;
}

export const segmentToken = (id: string) => `{{segment:${id}}}`;

export function segmentInstructions(prompt: string, ranges: readonly SegmentRange[]) {
  const matches = [...prompt.matchAll(/\{\{segment:([^}]+)\}\}/g)];
  if (matches.some(match => !ranges.some(range => range.id === match[1]))) throw new Error("提示词中的重拍片段已失效，请重新选择片段");
  if (new Set(matches.map(match => match[1])).size !== matches.length) throw new Error("提示词中的重拍片段已失效，请重新选择片段");
  const common = matches.length ? prompt.slice(0, matches[0].index).trim() : prompt.trim();
  return ranges.map(range => {
    const index = matches.findIndex(match => match[1] === range.id);
    const text = index < 0 ? ""
      : prompt.slice(matches[index].index! + matches[index][0].length, matches[index + 1]?.index ?? prompt.length).trim();
    return [common, text].filter(Boolean).join("\n") || "保留原片主体、动作、镜头和风格，重新生成这段视频。";
  });
}
