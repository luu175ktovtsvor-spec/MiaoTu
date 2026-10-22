import type { AnyTagProps, MentionItem } from "x-sender";
import { remapReferenceKey } from "./nodeReferences";
import { translate } from "@miaoimg/i18n/vue";

export type PromptModel = AnyTagProps[][];
type Reference = MentionItem & { value: string };

export function isPromptModel(value: unknown): value is PromptModel {
  return Array.isArray(value) && value.every(line => Array.isArray(line) && line.every(tag => {
    if (!tag || typeof tag !== "object") return false;
    switch (tag.type) {
      case "Write": return typeof tag.text === "string";
      case "Custom": return typeof tag.html === "string";
      case "Input": return (tag.text === undefined || typeof tag.text === "string") && typeof tag.placeholder === "string" && typeof tag.key === "string";
      case "Mention": return typeof tag.id === "string" && typeof tag.name === "string";
      case "Select":
      case "Trigger": return typeof tag.id === "string" && typeof tag.name === "string" && typeof tag.key === "string";
      default: return false;
    }
  }));
}

export function referenceHtml(reference: MentionItem & { value: string }) {
  const tag = document.createElement("span");
  tag.className = "imageReference";
  tag.dataset.referenceId = reference.id;
  tag.dataset.value = reference.value;
  if (reference.avatar) {
    const image = document.createElement("img");
    image.src = String(reference.avatar);
    image.alt = "";
    image.draggable = false;
    tag.append(image);
  }
  tag.append(document.createTextNode(reference.name));
  return tag.outerHTML;
}

export function normalizePromptModel(value: PromptModel, references: readonly Reference[]): AnyTagProps[][] {
  if (!value.length) return [[{ type: "Write", text: "" }]];
  const byId = new Map<string, Reference>(), byValue = new Map<string, Reference>();
  for (const reference of references) {
    if (!byId.has(reference.id)) byId.set(reference.id, reference);
    if (!byValue.has(reference.value)) byValue.set(reference.value, reference);
  }
  return value.map(line => {
    const tags = line.flatMap((tag): AnyTagProps[] => {
      if (tag.type === "Write") return tag.text.split(/(\{\{ref \d+\}\})/g).map(text => {
        const reference = byValue.get(text);
        return reference
          ? { type: "Custom", html: `<span style="display: inline-block;">${referenceHtml(reference)}</span>` }
          : { type: "Write", text };
      });
      if (tag.type === "Mention") {
        const reference = byId.get(tag.id);
        if (reference) return [{ type: "Custom", html: `<span style="display: inline-block;">${referenceHtml(reference)}</span>` }];
      }
      if (tag.type !== "Custom") return [tag];
      const template = document.createElement("template");
      template.innerHTML = tag.html;
      const tags = template.content.querySelectorAll<HTMLElement>(".imageReference[data-reference-id]");
      if (!tags.length) return [tag];
      for (const element of tags) {
        const reference = byId.get(element.dataset.referenceId ?? "");
        // A disconnected tag still belongs to its original source. Preserve
        // it so reconnect/undo can restore it without binding a new ordinal.
        if (reference) element.outerHTML = referenceHtml(reference);
        else if (!element.dataset.referenceDisconnected) {
          element.dataset.referenceDisconnected = "true";
          element.title = translate("请重新连接原参考节点，或移除失联标签");
          element.append(document.createTextNode(translate("（未连接）")));
        }
      }
      return [{ ...tag, html: template.innerHTML }];
    });
    const next: AnyTagProps[] = [{ type: "Write", text: "" }];
    for (const tag of tags) {
      const previous = next[next.length - 1];
      if (tag.type === "Write" && previous.type === "Write") previous.text += tag.text;
      else {
        if (tag.type !== "Write" && previous.type !== "Write") next.push({ type: "Write", text: "" });
        next.push(tag);
      }
    }
    if (next[next.length - 1].type !== "Write") next.push({ type: "Write", text: "" });
    return next;
  });
}

export function assertPromptReferencesConnected(value: PromptModel, references: readonly Reference[]) {
  const connected = new Set(references.map(reference => reference.id));
  const placeholders = new Set(references.map(reference => reference.value));
  const disconnected = () => { throw new Error(translate("提示词中的参考已断开连接，请重新连接原节点或移除失联标签后再生成")); };
  for (const line of value) for (const tag of line) {
    if (tag.type === "Write") {
      for (const placeholder of tag.text.matchAll(/\{\{ref \d+\}\}/g)) if (!placeholders.has(placeholder[0])) disconnected();
    } else if (tag.type === "Mention") {
      let id: unknown;
      try { id = JSON.parse(decodeURIComponent(tag.id)); } catch { continue; }
      if (Array.isArray(id) && id.length === 2 && id.every(part => typeof part === "string") && !connected.has(tag.id)) disconnected();
    } else if (tag.type === "Custom") {
      const template = document.createElement("template");
      template.innerHTML = tag.html;
      for (const reference of template.content.querySelectorAll<HTMLElement>(".imageReference[data-reference-id]")) {
        if (!connected.has(reference.dataset.referenceId ?? "")) disconnected();
      }
    }
  }
}

export function getPromptText(value: AnyTagProps[][]) {
  return value.map(line => line.map(tag => {
    if (tag.type === "Write") return tag.text;
    if (tag.type === "Input") return tag.text || tag.placeholder;
    if (tag.type !== "Custom") {
      const prefix = tag.type === "Mention" ? "@" : tag.type === "Trigger" ? tag.key : "";
      return prefix + tag.name;
    }
    const content = document.createElement("template");
    content.innerHTML = tag.html;
    for (const reference of content.content.querySelectorAll<HTMLElement>(".imageReference[data-value]")) {
      reference.replaceWith(reference.dataset.value ?? "");
    }
    return content.content.textContent ?? "";
  }).join("")).join("\n");
}

// 只更新正式参考标签的 ID，不替换普通文本、媒体路径或其他自定义 HTML。
export function remapPromptReferenceIds(value: PromptModel, ids: ReadonlyMap<string, string>): PromptModel {
  return value.map(line => line.map(tag => {
    if (tag.type === "Mention") {
      const id = remapReferenceKey(tag.id, ids);
      return id === tag.id ? tag : { ...tag, id };
    }
    if (tag.type !== "Custom") return tag;
    const template = document.createElement("template");
    template.innerHTML = tag.html;
    let changed = false;
    for (const reference of template.content.querySelectorAll<HTMLElement>(".imageReference[data-reference-id]")) {
      const oldId = reference.dataset.referenceId!;
      const id = remapReferenceKey(oldId, ids);
      if (id !== oldId) { reference.dataset.referenceId = id; changed = true; }
    }
    return changed ? { ...tag, html: template.innerHTML } : tag;
  }));
}
