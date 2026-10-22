import type { NodeInputValue } from "./values";

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

export function nodeReferenceMentions(values: NodeInputValue[], preview?: (key: string) => string | undefined) {
  return values.flatMap((item, index) => typeof item.dataType === "string" && ["IMAGE", "VIDEO", "AUDIO", "STRING"].includes(item.dataType)
    ? [{ id: referenceKey(item), name: `参考 ${index + 1}`, value: `{{ref ${index + 1}}}`, avatar: preview?.(referenceKey(item)) }]
    : []);
}
