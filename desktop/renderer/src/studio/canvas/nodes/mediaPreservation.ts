import type { FfprobeData } from "@miaoimg/ffmpeg/browser";

type Stream = FfprobeData["streams"][number];
export function primaryAudio(media: FfprobeData) {
  const streams = media.streams.filter(stream => stream.codec_type === "audio");
  return streams.find(stream => stream.disposition?.default) || streams[0];
}

function output(path: string, extension: string, format: string, mimeType: string, codec = "copy") {
  return { path: path.replace(/\.[^/.]+$/, "") + "." + extension, format, mimeType, codec };
}

// 提取只换容器、不压缩音轨。需要采样级编辑时保存无损 PCM，不再反复压 AAC。
export function preservedAudioOutput(path: string, stream: Stream, copy = true, media?: FfprobeData) {
  if (copy) {
    // WebM 的丢弃尾采样信息在转成 Ogg 时可能被时间基舍入；保留其原封装。
    if (["opus", "vorbis"].includes(stream.codec_name || "") && String(media?.format.format_name || "").includes("webm")) {
      return output(path, "weba", "webm", "audio/webm");
    }
    switch (stream.codec_name) {
      case "aac": case "alac": return output(path, "m4a", "ipod", "audio/mp4");
      case "mp3": return output(path, "mp3", "mp3", "audio/mpeg");
      case "opus": return output(path, "opus", "opus", "audio/ogg");
      case "vorbis": return output(path, "ogg", "ogg", "audio/ogg");
      case "flac": return output(path, "flac", "flac", "audio/flac");
      case "pcm_u8": case "pcm_s16le": case "pcm_s24le": case "pcm_s32le": case "pcm_f32le": case "pcm_f64le":
        return output(path, "wav", "wav", "audio/wav");
    }
  }
  // 保持整数源的有效位深；有损音轨通常解码为浮点，浮点 WAV 保留解码后的采样。
  const bits = Number(stream.bits_per_raw_sample) || Number(stream.bits_per_sample) || Number(String(stream.sample_fmt || "").match(/\d+/)?.[0]);
  const integer = /^(?:s|u)\d/.test(String(stream.sample_fmt || ""));
  const codec = integer ? (bits > 16 ? "pcm_s32le" : "pcm_s16le") : /dbl/.test(String(stream.sample_fmt || "")) ? "pcm_f64le" : "pcm_f32le";
  return output(path, "wav", "wav", "audio/wav", codec);
}

export function preservedVideoOutput(path: string, source: string, media: FfprobeData) {
  const formats = String(media.format.format_name || "").split(",");
  if (formats.includes("mov") || formats.includes("mp4")) {
    return /\.mov$/i.test(source) ? output(path, "mov", "mov", "video/quicktime") : output(path, "mp4", "mp4", "video/mp4");
  }
  if (formats.includes("webm") && media.streams.every(stream => stream.codec_type === "video"
    ? ["vp8", "vp9", "av1"].includes(stream.codec_name || "")
    : stream.codec_type !== "audio" || ["opus", "vorbis"].includes(stream.codec_name || ""))) {
    return output(path, "webm", "webm", "video/webm");
  }
  // 未知封装不偷偷转码；Matroska 可容纳原有视频及音轨。
  return output(path, "mkv", "matroska", "video/x-matroska");
}
