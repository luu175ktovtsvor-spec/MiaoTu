import type { MentionItem } from "x-sender";
import type { NodeMediaValue } from "./values";

export type ReferenceKind = "IMAGE" | "VIDEO" | "AUDIO" | "STRING";
export type ReferenceMenuItem = MentionItem & {
  kind?: ReferenceKind;
  label?: string;
  media?: NodeMediaValue;
};

export const REFERENCE_KINDS: ReferenceKind[] = ["IMAGE", "VIDEO", "AUDIO", "STRING"];
export const REFERENCE_KIND_LABELS: Record<ReferenceKind, string> = {
  IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", STRING: "文本",
};
