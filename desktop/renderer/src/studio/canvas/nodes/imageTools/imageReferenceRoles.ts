import type { NodeMediaModel } from "../../scaffold/nodeAi";
import type { NodeInputValue } from "../../scaffold/values";
import { referenceKey } from "../../scaffold/nodeReferences";

export function imageReferenceRoles(references: NodeInputValue[], saved: Record<string, string> | undefined, model: NodeMediaModel | undefined) {
  if (!model?.referenceRoles?.length) return undefined;
  const allowed = new Set(model.referenceRoles.map(role => role.value));
  return references.filter(item => item.dataType === "IMAGE" && item.value).map(item => {
    const value = saved?.[referenceKey(item)];
    return value && allowed.has(value) ? value : "general";
  });
}
