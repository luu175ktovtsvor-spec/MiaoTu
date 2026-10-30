import type { BrowserFfmpegCommand, BrowserFfmpegFactory, FfprobeData } from "@miaoimg/ffmpeg/browser";
import { preservedAudioOutput, preservedVideoOutput, primaryAudio } from "../mediaPreservation";
import { audioTempoFilters, normalizedCrop, videoGeometry, type PixelCrop } from "./videoLocalGeometry";

export type VideoProcessingOptions = {
  action: "extractAudio" | "separate" | "trim" | "crop" | "speed";
  crop?: PixelCrop;
  speed?: number;
  audioPath?: string;
  videoPath?: string;
  start?: number;
  end?: number;
};

function normalizePath(path: string) {
  if (!path || /[\x00-\x1f]/.test(path) || /^(?:[\\/]|[a-z][a-z\d+.-]*:)/i.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw new Error("视频处理必须使用工作区相对路径");
  }
  return path.split(/[\\/]+/).filter(part => part && part !== ".").join("/").toLowerCase();
}

function probeMedia(ffmpeg: BrowserFfmpegFactory, path: string, signal?: AbortSignal, args: string[] = []) {
  signal?.throwIfAborted();
  const command = ffmpeg(path);
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<FfprobeData>((resolve, reject) => {
    command.ffprobe(args, (error: Error | null, data: FfprobeData) => {
      if (signal?.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(data);
    });
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

function runCommand(command: BrowserFfmpegCommand, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const cancel = () => command.kill();
  signal?.addEventListener("abort", cancel, { once: true });
  return new Promise<void>((resolve, reject) => {
    command.on("start", () => { if (signal?.aborted) command.kill(); });
    command.on("error", error => reject(signal?.aborted ? signal.reason : error));
    command.on("end", () => signal?.aborted ? reject(signal.reason) : resolve());
    command.run();
  }).finally(() => signal?.removeEventListener("abort", cancel));
}

/** 目录创建、唯一文件名和失败清理由调用方负责，原视频始终保留。 */
export async function processVideo(ffmpeg: BrowserFfmpegFactory, source: string, options: VideoProcessingOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const sourcePath = normalizePath(source);
  if (!["extractAudio", "separate", "trim", "crop", "speed"].includes(options.action)) throw new Error("未知的视频处理操作");
  const needsAudio = options.action === "extractAudio" || options.action === "separate";
  const needsVideo = options.action !== "extractAudio";
  if (needsAudio && !options.audioPath) throw new Error("缺少音轨输出路径");
  if (needsVideo && !options.videoPath) throw new Error("缺少视频输出路径");
  const outputs = [needsAudio ? options.audioPath : undefined, needsVideo ? options.videoPath : undefined].filter((path): path is string => !!path).map(normalizePath);
  if (outputs.includes(sourcePath) || new Set(outputs).size !== outputs.length) throw new Error("输出文件不能覆盖原视频或彼此覆盖");

  const media = await probeMedia(ffmpeg, source, signal);
  const video = media.streams.find(stream => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("文件不包含视频画面");
  const duration = Number(media.format.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取有效的视频时长");
  const audio = primaryAudio(media);
  if (needsAudio && !audio) throw new Error("该视频没有音轨");
  if (options.action === "trim" && (!Number.isFinite(options.start) || !Number.isFinite(options.end)
    || options.start! < 0 || options.end! <= options.start! || options.end! > duration)) {
    throw new Error("截取范围须满足 0 ≤ 开始时间 < 结束时间 ≤ 视频时长");
  }

  const geometry = options.action === "crop" ? videoGeometry(video) : undefined;
  if (options.action === "crop" && (!options.crop || Object.entries(normalizedCrop(options.crop, geometry!)).some(([key,value])=>options.crop![key] !== value))) throw new Error("裁剪坐标和尺寸须为范围内的偶数，宽高至少为 2 像素");
  if (options.action === "speed") audioTempoFilters(options.speed!);
  const transform = options.action === "trim" || options.action === "crop" || options.action === "speed" && options.speed !== 1;
  const audioOutput = needsAudio ? preservedAudioOutput(options.audioPath!, audio!, true, media) : undefined;
  // Trim re-encodes for a frame-accurate range, so it always writes H.264 MP4.
  const videoOutput = !needsVideo ? undefined : transform
    ? { path: options.videoPath!.replace(/\.[^/.]+$/, "") + ".mp4", format: "mp4", mimeType: "video/mp4", codec: "libx264" }
    : preservedVideoOutput(options.videoPath!, source, media);
  for (const target of [audioOutput, videoOutput]) {
    if (target && normalizePath(target.path) === sourcePath) throw new Error("输出文件不能覆盖原视频");
  }
  const actualStart = options.start ?? 0;
  const actualEnd = options.end ?? duration;
  const command = ffmpeg(source);
  if (options.action === "trim") command.seekInput(actualStart);
  if (needsAudio) {
    command.output(audioOutput!.path).noVideo().audioCodec(audioOutput!.codec).format(audioOutput!.format)
      .outputOptions("-map", `0:${audio!.index}`);
    if (audioOutput!.format === "ipod") command.outputOptions("-movflags", "+faststart");
  }
  if (needsVideo && transform) {
    command.output(videoOutput!.path).videoCodec("libx264").format("mp4")
      .outputOptions("-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
    if (options.action === "speed") {
      const speed = options.speed!, tracks = media.streams.filter(stream => stream.codec_type === "audio");
      const starts = [video, ...tracks].map(stream => Number(stream.start_time)).filter(Number.isFinite);
      const origin = starts.length ? Math.min(...starts) : 0;
      const [n, d = 1] = String(video.avg_frame_rate || video.r_frame_rate || "0/1").split("/").map(Number);
      if (!(n > 0) || !(d > 0)) throw new Error("无法读取有效的视频帧率");
      const offset = (stream: typeof video) => Math.max(0, (Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : origin) - origin) / speed;
      const filters = [`[0:${video.index}]setpts=(PTS-STARTPTS)/${speed}+${offset(video)}/TB,fps=${n}/${d}[retimedVideo]`,
        ...tracks.map((track, index) => {
          const trackDuration = Number(track.duration) > 0 ? Number(track.duration) : Math.max(0, duration - offset(track) * speed);
          // Feed a short silent tail through the time stretcher to flush its
          // analysis window, then trim to the exact requested sample duration.
          return `[0:${track.index}]asetpts=PTS-STARTPTS,apad=pad_dur=0.25,${audioTempoFilters(speed).join(",")},atrim=duration=${trackDuration / speed},asetpts=PTS-STARTPTS+${offset(track)}/TB[retimedAudio${index}]`;
        })];
      command.complexFilter(filters).outputOptions("-map", "[retimedVideo]");
      tracks.forEach((track, index) => {
        command.outputOptions("-map", `[retimedAudio${index}]`, `-map_metadata:s:a:${index}`, `0:s:a:${index}`, `-disposition:a:${index}`, track.disposition?.default ? "default" : "0");
      });
    } else {
      command.outputOptions("-map", `0:${video.index}`);
      if (options.action === "trim") command.duration(actualEnd - actualStart);
      if (options.action === "crop") {
        const crop = options.crop!;
        command.videoFilters(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},setsar=${geometry!.sarNumerator}/${geometry!.sarDenominator}`)
          .outputOptions("-metadata:s:v:0", "rotate=0");
      }
      if (audio) command.outputOptions("-map", "0:a?");
    }
    if (audio) command.audioCodec("aac").outputOptions("-b:a", "256k");
    else command.noAudio();
  } else if (needsVideo && options.action === "speed") {
    command.output(videoOutput!.path).videoCodec("copy").format(videoOutput!.format).outputOptions("-map", `0:${video.index}`, "-map", "0:a?");
    if (audio) command.audioCodec("copy"); else command.noAudio();
    if (["mp4", "mov"].includes(videoOutput!.format)) command.outputOptions("-movflags", "+faststart");
  } else if (needsVideo) {
    // 分离直接复制视频，不修改尺寸、帧率、色彩或编码质量。
    command.output(videoOutput!.path).videoCodec("copy").format(videoOutput!.format)
      .outputOptions("-map", `0:${video.index}`);
    if (["mp4", "mov"].includes(videoOutput!.format)) command.outputOptions("-movflags", "+faststart");
    command.noAudio();
  }
  await runCommand(command, signal);
  const result = await probeMedia(ffmpeg, (videoOutput || audioOutput)!.path, signal);
  const resultVideo = result.streams.find(stream => stream.codec_type === "video");
  const resultDuration = Number(result.format.duration);
  if (!Number.isFinite(resultDuration) || resultDuration <= 0 || (needsVideo && !resultVideo)) throw new Error("生成的媒体文件无效");
  if (options.action === "crop" && (resultVideo?.width !== options.crop!.width || resultVideo?.height !== options.crop!.height)) throw new Error("生成的媒体文件无效");
  if (options.action === "speed" && Math.abs(resultDuration - duration / options.speed!) > 0.15) throw new Error("生成的媒体文件无效");
  return { duration: resultDuration, start: actualStart, end: actualStart + resultDuration, audio: audioOutput, video: videoOutput, width: resultVideo?.width ?? video.width, height: resultVideo?.height ?? video.height };
}

/** Agent frame extraction also works when Chromium has released the offscreen decoder. */
export async function extractVideoFrame(ffmpeg: BrowserFfmpegFactory, source: string, output: string, frame: 'first' | 'last' | 'current', currentTime: number, signal?: AbortSignal) {
  if (normalizePath(source) === normalizePath(output)) throw new Error('截图不能覆盖原视频');
  const media = await probeMedia(ffmpeg, source, signal);
  const video = media.streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const origin = Number(media.format.start_time) || 0;
  const videoStart = Number.isFinite(Number(video?.start_time)) ? Number(video!.start_time) : origin;
  const videoDuration = Number(video?.duration);
  const duration = Number.isFinite(videoDuration) && videoDuration > 0
    ? videoStart - origin + videoDuration : Number(media.format.duration);
  if (!video || !Number.isFinite(duration) || !(duration > 0)) throw new Error('原片不包含有效视频画面');
  if (frame === 'current' && !Number.isFinite(currentTime)) throw new Error('无法读取有效的播放时间');
  let time = frame === 'current' ? Math.max(0, currentTime) : 0;
  if (frame !== 'first') {
    // Inspect actual presentation timestamps near the requested position or
    // video tail. Sparse frames and longer audio can require a wider window.
    let span = 1;
    for (;;) {
      const start = Math.max(0, (frame === 'last' ? duration : Math.min(time, duration)) - span);
      // Duration is only a seek hint: reordered VFR frames can have later PTS.
      // Current-frame lookup normally stops shortly after the target. Near the
      // advertised end, read to EOF because that duration can be inaccurate.
      const bounded = frame === 'current' && Math.max(time, videoStart - origin) + span < duration;
      const end = bounded ? String(Math.max(time + origin, videoStart) + span) : '';
      const tail = await probeMedia(ffmpeg, source, signal, ['-threads', '1', '-select_streams', String(video.index), '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pts_time', '-read_intervals', `${start + origin}%${end}`]);
      const frames = (tail as FfprobeData & { frames?: { pts_time?: string; best_effort_timestamp_time?: string }[] }).frames ?? [];
      const times = frames.map(value => Number(value.best_effort_timestamp_time ?? value.pts_time) - origin).filter(Number.isFinite);
      // A bounded packet read flushes the decoder's reorder buffer and can
      // omit B-frames preceding its last reference frame. Require a decoded
      // frame beyond the target before that flushed suffix, or read farther.
      const reorder = Math.max(0, Number(tail.streams[0]?.has_b_frames ?? video.has_b_frames) || 0);
      if (bounded && !times.slice(0, -(reorder + 1)).some(value => value > time)) { span *= 2; continue; }
      const candidates = frame === 'last' ? times : times.filter(value => value <= time + 0.0000001);
      if (candidates.length) { time = Math.max(0, candidates.reduce((latest, value) => Math.max(latest, value), -Infinity)); break; }
      // A video track may start after the audio. Before its first timestamp,
      // capture the first available video frame and report that actual time.
      if (start === 0 && times.length) { time = Math.max(0, times.reduce((first, value) => Math.min(first, value), Infinity)); break; }
      if (start === 0) throw new Error('截图未产生有效画面');
      span *= 2;
    }
  }
  // ffprobe prints microseconds; a rounded-up timestamp must not skip the
  // very frame it identifies when ffmpeg applies an accurate input seek.
  const seekTime = frame === 'first' ? 0 : Math.max(0, time - 0.000001);
  await runCommand(ffmpeg(source).seekInput(seekTime).output(output).outputOptions('-map', `0:${video.index}`, '-frames:v', '1').noAudio().videoCodec('png').format('image2'), signal);
  const result = await probeMedia(ffmpeg, output, signal);
  const image = result.streams.find(stream => stream.codec_type === 'video');
  if (!image?.width || !image.height) throw new Error('截图未产生有效画面');
  return { width: image.width, height: image.height, time };
}
