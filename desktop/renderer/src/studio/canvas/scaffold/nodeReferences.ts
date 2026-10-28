import type { NodeInputValue } from "./values";
import { translate } from "@miaoimg/i18n/vue";
import type { ReferenceKind } from "./referenceMenu";

export function referenceKey(item: Pick<NodeInputValue, "source" | "sourceHandle">) {
  return encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]));
}

export function remapReferenceKey(key: string, ids: ReadonlyMap<string, string>) {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(key));
    if (Array.isArray(value) && value.length === 2 && value.every(part => typeof part === "string") && ids.has(value[0])) {
      return referenceKey({ source: ids.get(value[0])!, sourceHandle: value[1] });
    }
  } catch { /* 不修改插件的其他索引或历史无效值。 */ }
  return key;
}

export function orderNodeReferences(values: NodeInputValue[], keys?: readonly string[]) {
  const order = new Map(keys?.map((key, index) => [key, index]));
  return [...values].sort((a, b) => (order.get(referenceKey(a)) ?? order.size) - (order.get(referenceKey(b)) ?? order.size));
}

// 显示名按类型各自编号（图片 1、视频 1…，与 LibTV 一致）；提交给模型的仍是按连入顺序的 {{ref N}}。
const REFERENCE_TYPE_NAMES: Record<string, string> = { IMAGE: "图片", VIDEO: "视频", AUDIO: "音频", STRING: "文本" };
export function nodeReferenceMentions(values: NodeInputValue[], preview?: (key: string) => string | undefined) {
  const counts = new Map<string, number>();
  return values.flatMap((item, index) => {
    if (typeof item.dataType !== "string" || !REFERENCE_TYPE_NAMES[item.dataType]) return [];
    const number = (counts.get(item.dataType) ?? 0) + 1;
    counts.set(item.dataType, number);
    return [{ id: referenceKey(item), name: `${translate(REFERENCE_TYPE_NAMES[item.dataType]!)} ${number}`, value: `{{ref ${index + 1}}}`, avatar: preview?.(referenceKey(item)), kind: item.dataType as ReferenceKind }];
  });
}
