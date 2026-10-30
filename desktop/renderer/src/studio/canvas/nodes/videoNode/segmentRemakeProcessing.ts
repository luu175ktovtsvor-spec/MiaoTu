import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData, FfprobeStream } from "../../scaffold/browserFfmpeg";
import { videoGeometry } from "./videoLocalGeometry";
import { normalizeSegmentRanges, type SegmentRange } from "./segmentRemake";

function safePath(value: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f]/.test(value) || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(value) || value.split(/[\\/]+/).includes("..")) throw new Error("视频处理必须使用工作区相对路径");
  const path = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/");
  if (!path) throw new Error("视频处理必须使用工作区相对路径");
  return path;
}
const samePath = (a: string, b: string) => a.normalize("NFC").toLowerCase() === b.normalize("NFC").toLowerCase();
async function probe(factory: BrowserFfmpegFactory, path: string, signal?: AbortSignal): Promise<FfprobeData> {
  signal?.throwIfAborted(); const command = factory(safePath(path)), cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  try { return await new Promise<FfprobeData>((resolve, reject) => command.ffprobe((error, result) => signal?.aborted ? reject(signal.reason) : error ? reject(error) : resolve(result))); }
  finally { signal?.removeEventListener("abort", cancel); }
}
async function execute(command: BrowserFfmpegCommand, signal?: AbortSignal) {
  signal?.throwIfAborted(); const cancel = () => command.kill(); signal?.addEventListener("abort", cancel, { once: true });
  try { await new Promise<void>((resolve, reject) => { command.on("start", () => { if (signal?.aborted) command.kill(); }); command.on("error", error => reject(signal?.aborted ? signal.reason : error)); command.on("end", () => signal?.aborted ? reject(signal.reason) : resolve()); command.run(); }); }
  finally { signal?.removeEventListener("abort", cancel); }
}
function frameRate(video: FfprobeStream) {
  const [n, d = 1] = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number), fps = n / d;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0 || !Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error("无法读取有效的视频帧率");
  return { fps, expression: `${n}/${d}` };
}
function containerStart(data: FfprobeData) {
  const value = Number(data.format.start_time ?? 0);
  if (!Number.isFinite(value)) throw new Error("无法读取有效的视频时间戳，请先转码");
  return value;
}
function startTime(data: FfprobeData, stream: FfprobeStream) {
  const value = Number(stream.start_time ?? containerStart(data));
  if (!Number.isFinite(value)) throw new Error("无法读取有效的视频时间戳，请先转码");
  return value;
}
function streamDuration(data: FfprobeData, stream: FfprobeStream) {
  const direct = Number(stream.duration);
  const value = Number.isFinite(direct) && direct > 0 ? direct : Number(data.format.duration) - Math.max(0, startTime(data, stream) - containerStart(data));
  if (!Number.isFinite(value) || value <= 0) throw new Error("无法读取有效的视频时长");
  return value;
}
function visual(data: FfprobeData) {
  const video = data.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("文件不包含视频画面");
  const geometry = videoGeometry(video), rate = frameRate(video), duration = streamDuration(data, video);
  if (geometry.width % 2 || geometry.height % 2) throw new Error("视频尺寸需为偶数，请先转码");
  // Browser currentTime is relative to the container start. Do not silently move a delayed picture track to zero.
  if (Math.abs(startTime(data, video) - containerStart(data)) > 1 / rate.fps + 0.005) throw new Error("视频画面起始时间不一致，请先转码");
  return { video, selector: data.streams.filter(stream => stream.codec_type === "video").indexOf(video), geometry, ...rate, duration };
}
const tolerance = (fps: number) => Math.min(0.05, 1 / fps + 0.005);
function sourceVisual(data: FfprobeData) {
  const result = visual(data), duration = Number(data.format.duration);
  if (!Number.isFinite(duration) || Math.abs(duration - result.duration) > tolerance(result.fps)) throw new Error("视频画面与音轨时长不一致，请先转码");
  return result;
}
function sameGeometry(actual: ReturnType<typeof visual>, expected: ReturnType<typeof visual>) {
  return actual.geometry.width === expected.geometry.width && actual.geometry.height === expected.geometry.height
    && Math.abs(actual.geometry.sarNumerator / actual.geometry.sarDenominator - expected.geometry.sarNumerator / expected.geometry.sarDenominator) < 0.00001
    && Math.abs(actual.geometry.displayRatio - expected.geometry.displayRatio) < 0.00001;
}
export async function prepareRemakeClip(factory: BrowserFfmpegFactory, source: string, range: SegmentRange, output: string, signal?: AbortSignal) {
  source = safePath(source); output = safePath(output);
  if (samePath(source, output)) throw new Error("输出文件不能覆盖原视频");
  const metadata = await probe(factory, source, signal), original = sourceVisual(metadata);
  const [selected] = normalizeSegmentRanges([range], original.duration), requested = selected.end - selected.start;
  const normalizedFps = original.fps < 23.8 || original.fps > 30 ? 30 : original.fps;
  const command = factory(source).seekInput(selected.start).duration(requested).noAudio().videoFilters("setpts=PTS-STARTPTS")
    .output(output).videoCodec("libx264").format("mp4").outputOptions("-map", `0:v:${original.selector}`, "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
  if (normalizedFps !== original.fps) command.fps(normalizedFps);
  await execute(command, signal);
  const result = await probe(factory, output, signal), clip = visual(result);
  if (!sameGeometry(clip, original) || clip.duration < 4 || clip.duration > 30 + tolerance(clip.fps) || Math.abs(clip.duration - requested) > tolerance(clip.fps)
    || Math.abs(clip.fps - normalizedFps) > 0.01 || result.streams.some(stream => stream.codec_type === "audio")) throw new Error("重拍片段实际时长不符合要求，请重新选择范围");
  return { path: output, mimeType: "video/mp4", duration: clip.duration, width: clip.geometry.width, height: clip.geometry.height, fps: clip.fps };
}
function audioShape(stream: FfprobeStream) {
  const channels = Number(stream.channels), sampleRate = Number(stream.sample_rate);
  const layouts: Record<number, string> = { 1: "mono", 2: "stereo", 3: "2.1", 4: "quad", 5: "5.0", 6: "5.1", 8: "7.1" };
  const declared = String(stream.channel_layout || ""), known = ["mono", "stereo", "2.1", "3.0", "4.0", "quad", "5.0", "5.0(side)", "5.1", "5.1(side)", "6.1", "7.1", "7.1(wide)"];
  const layout = known.includes(declared) ? declared : layouts[channels];
  if (!layout || !Number.isSafeInteger(channels) || channels < 1 || channels > 8) throw new Error("暂不支持此音轨布局，请先转码");
  return { channels, layout, rate: Number.isSafeInteger(sampleRate) && sampleRate >= 8000 && sampleRate <= 192000 ? sampleRate : 48000 };
}
function audioSegment(data: FfprobeData, video: FfprobeStream, stream: FfprobeStream, reference: FfprobeStream, input: number, track: number, start: number, end: number, label: string) {
  const shape = audioShape(reference), offset = startTime(data, stream) - startTime(data, video);
  const shift = offset < 0 ? `atrim=start=${-offset},asetpts=PTS-STARTPTS` : `adelay=${Math.round(offset * shape.rate)}S:all=1`;
  // Restore each track's delay before trimming. Resetting every trimmed track to its first packet would desynchronise it.
  return `[${input}:a:${track}]asetpts=PTS-STARTPTS,aresample=${shape.rate},aformat=sample_fmts=fltp:channel_layouts=${shape.layout},${shift},apad,atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[${label}]`;
}

/** Only the selected visual intervals are replaced. Original paths are never written. */
export async function mergeRemakeClips(factory: BrowserFfmpegFactory, source: string, parts: readonly (SegmentRange & { path: string })[], output: string, audio: "original" | "generated", signal?: AbortSignal) {
  source = safePath(source); output = safePath(output);
  const paths = parts.map(part => safePath(part.path));
  if (!parts.length || samePath(source, output) || paths.some(path => samePath(path, output))) throw new Error("输出文件不能覆盖原视频或彼此覆盖");
  const original = await probe(factory, source, signal), originalVisual = sourceVisual(original), { geometry, fps, expression, duration, video } = originalVisual;
  const ranges = normalizeSegmentRanges(parts, duration), ordered = ranges.map(range => ({ ...range, path: paths[parts.findIndex(part => part.id === range.id)] }));
  const clips = await Promise.all(ordered.map(part => probe(factory, part.path, signal))), visuals = clips.map(visual);
  visuals.forEach((clip, index) => {
    if (Math.abs(clip.duration - (ordered[index].end - ordered[index].start)) > tolerance(Math.max(fps, clip.fps))) throw new Error("重拍结果时长与所选片段不一致，请保留结果后重试拼接");
  });
  const tracks = original.streams.filter(stream => stream.codec_type === "audio"), clipTracks = clips.map(clip => clip.streams.filter(stream => stream.codec_type === "audio"));
  tracks.forEach(audioShape);
  const command = factory(source); ordered.forEach(part => command.input(part.path));
  const filters: string[] = [], pieces: { input: number; start: number; end: number }[] = [];
  let cursor = 0;
  ordered.forEach((part, index) => { if (part.start > cursor) pieces.push({ input: 0, start: cursor, end: part.start }); pieces.push({ input: index + 1, start: 0, end: part.end - part.start }); cursor = part.end; });
  if (cursor < duration) pieces.push({ input: 0, start: cursor, end: duration });
  pieces.forEach((piece, index) => {
    let fit = "";
    if (piece.input) {
      const dar = visuals[piece.input - 1].geometry.displayRatio, sar = geometry.sarNumerator / geometry.sarDenominator;
      // Convert the incoming DISPLAY ratio to the target pixel grid before setting SAR. Never stretch the generated picture.
      const width = dar >= geometry.displayRatio ? geometry.width : Math.max(2, Math.floor(geometry.height * dar / sar / 2) * 2);
      const height = dar >= geometry.displayRatio ? Math.max(2, Math.floor(geometry.width * sar / dar / 2) * 2) : geometry.height;
      fit = `scale=${width}:${height},setsar=${geometry.sarNumerator}/${geometry.sarDenominator},pad=${geometry.width}:${geometry.height}:(ow-iw)/2:(oh-ih)/2,`;
    }
    const selector = piece.input ? visuals[piece.input - 1].selector : originalVisual.selector;
    filters.push(`[${piece.input}:v:${selector}]setpts=PTS-STARTPTS,trim=start=${piece.start}:end=${piece.end},setpts=PTS-${piece.start}/TB,${fit}setsar=${geometry.sarNumerator}/${geometry.sarDenominator},fps=${expression}:start_time=0:round=near,format=yuv420p[v${index}]`);
  });
  filters.push(`${pieces.map((_, index) => `[v${index}]`).join("")}concat=n=${pieces.length}:v=1:a=0[remadeVideo]`);
  const count = Math.max(1, tracks.length);
  if (audio === "generated") {
    for (let track = 0; track < count; track++) {
      const reference = tracks[track] || clipTracks.find(list => list[track])?.[track] || { channels: 2, sample_rate: "48000", channel_layout: "stereo" };
      const shape = audioShape(reference);
      pieces.forEach((piece, index) => {
        const stream = piece.input === 0 ? tracks[track] : clipTracks[piece.input - 1][track], label = `a${track}_${index}`;
        filters.push(stream ? audioSegment(piece.input ? clips[piece.input - 1] : original, piece.input ? visuals[piece.input - 1].video : video, stream, reference, piece.input, track, piece.start, piece.end, label)
          : `anullsrc=r=${shape.rate}:cl=${shape.layout},atrim=duration=${piece.end - piece.start},asetpts=PTS-STARTPTS[${label}]`);
      });
      filters.push(`${pieces.map((_, index) => `[a${track}_${index}]`).join("")}concat=n=${pieces.length}:v=0:a=1[remadeAudio${track}]`);
    }
  }
  command.complexFilter(filters).output(output).videoCodec("libx264").format("mp4")
    .outputOptions("-map", "[remadeVideo]", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-t", String(duration), "-map_metadata:s:v:0", "-1");
  if (audio === "original") { if (tracks.length) command.audioCodec("copy").outputOptions("-map", "0:a?"); else command.noAudio(); }
  else { command.audioCodec("aac"); for (let track = 0; track < count; track++) command.outputOptions("-map", `[remadeAudio${track}]`); }
  tracks.forEach((track, index) => {
    const flags = ["default", "dub", "original", "comment", "lyrics", "karaoke", "forced", "hearing_impaired", "visual_impaired", "clean_effects"].filter(flag => track.disposition?.[flag]).join("+") || "0";
    command.outputOptions(`-map_metadata:s:a:${index}`, `0:s:a:${index}`, `-disposition:a:${index}`, flags);
  });
  await execute(command, signal);
  const result = await probe(factory, output, signal), actual = visual(result), resultTracks = result.streams.filter(stream => stream.codec_type === "audio");
  if (!sameGeometry(actual, originalVisual) || Math.abs(actual.duration - duration) > tolerance(fps) || Math.abs(actual.fps - fps) > 0.01
    || resultTracks.length !== (audio === "original" ? tracks.length : count)) throw new Error("拼接结果校验失败，已保留原片和重拍片段");
  resultTracks.forEach((stream, index) => {
    const expected = tracks[index], expectedStart = audio === "original" ? startTime(original, expected) - startTime(original, video) : 0;
    const actualStart = startTime(result, stream) - startTime(result, actual.video);
    if (Math.abs(actualStart - expectedStart) > 0.05 || Number(stream.channels) !== (expected ? Number(expected.channels) : audioShape(stream).channels)) throw new Error("拼接音轨时间不一致，已保留原片和重拍片段");
    if (audio === "original" && (stream.codec_name !== expected.codec_name || Number(stream.sample_rate) !== Number(expected.sample_rate)
      || Math.abs(actualStart + streamDuration(result, stream) - Math.min(duration, expectedStart + streamDuration(original, expected))) > 0.05)) throw new Error("拼接音轨时间不一致，已保留原片和重拍片段");
    if (audio === "generated" && Math.abs(streamDuration(result, stream) - duration) > 0.05) throw new Error("拼接音轨时间不一致，已保留原片和重拍片段");
  });
  return { path: output, mimeType: "video/mp4", duration: actual.duration };
}
