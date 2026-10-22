import type { AgentMention } from "@miaoimg/server/agent/types";
import { translate } from "@miaoimg/i18n/vue";

function safeAssetLabel(mention: AgentMention) {
  if (mention.source.kind !== "asset" || !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(mention.label)) return mention.label;
  return mention.dataType === "IMAGE" || mention.dataType === "MASK" ? translate("图片") : mention.dataType === "VIDEO" ? translate("视频") : mention.dataType === "AUDIO" ? translate("音频") : translate("文件");
}

export function mentionName(mention: AgentMention) {
  return `${mention.source.kind === "asset" ? translate("工作区素材") : mention.source.canvasName} / ${safeAssetLabel(mention)}`;
}

export function mentionLabel(mention: AgentMention) { return safeAssetLabel(mention); }

export function mentionThumbnailProps(mention: AgentMention) {
  const value = mention.value as { url?: unknown; mimeType?: unknown } | null;
  return {
    thumbnail: ["IMAGE", "MASK", "VIDEO"].includes(mention.dataType) && typeof value?.url === "string" && typeof value.mimeType === "string"
      ? { url: value.url, mimeType: value.mimeType } : undefined,
  };
}

export function mentionParts(content: string, mentions: AgentMention[] = []) {
  const byId = new Map(mentions.map(mention => [mention.id, mention]));
  return content.split(/(\{\{mention:[^{}]+\}\})/g).filter(Boolean).map(text => {
    const id = /^\{\{mention:([^{}]+)\}\}$/.exec(text)?.[1];
    return { text, mention: id ? byId.get(id) : undefined };
  });
}

export function mentionPlainText(content: string, mentions?: AgentMention[]) {
  return mentionParts(content, mentions).map(part => part.mention ? `@${mentionName(part.mention)}` : part.text).join("");
}
