// 文件选择和拖拽使用同一份类型判断；浏览器可能不给 File.type。
const mimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", log: "text/plain",
  json: "application/json", xml: "application/xml", html: "text/html", css: "text/css", js: "text/javascript", ndjson: "application/x-ndjson",
};
export function assetFileType(file: Pick<File, "name" | "type">) {
  const declared = file.type.split(";")[0]!.trim().toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const known = mimeTypes[extension] ?? "";
  const recognized = /^(image|video|audio|text)\//.test(declared) || /^application\/(json|xml|javascript|x-ndjson)$/.test(declared);
  const mimeType = recognized ? declared : known || declared;
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio"
    : mimeType.startsWith("text/") || /^application\/(json|xml|javascript|x-ndjson)$/.test(mimeType) ? "text" : undefined;
  return { mimeType, kind };
}
