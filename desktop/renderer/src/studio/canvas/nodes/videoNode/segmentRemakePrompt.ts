import type { PromptModel } from "../../scaffold/promptModel";
import { segmentRangeLabel, segmentToken, type SegmentRange } from "./segmentRemake";

type Tag = PromptModel[number][number];
type Piece = { kind: "tag"; tag: Tag } | { kind: "break" } | { kind: "range"; id: string };
const rangePattern = /\{\{segment:([^}]+)\}\}/g;
const rangeSelector = ".segmentRangeReference[data-range-id], .segmentRangeReference[data-value]";

function rangeTag(range: SegmentRange): Tag {
  const element = document.createElement("span");
  element.className = "segmentRangeReference";
  element.dataset.rangeId = range.id;
  element.dataset.value = segmentToken(range.id);
  element.setAttribute("contenteditable", "false");
  element.style.cssText = "display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;background:var(--el-color-primary-light-9);color:var(--el-color-primary);white-space:nowrap";
  element.textContent = segmentRangeLabel(range);
  return { type: "Custom", html: element.outerHTML };
}

// Split only the range elements. Other custom HTML, including normal media
// references, stays intact even when the editor has put it in the same wrapper.
function customPieces(tag: Extract<Tag, { type: "Custom" }>): Piece[] {
  const template = document.createElement("template");
  template.innerHTML = tag.html;
  if (!template.content.querySelector(rangeSelector)) return [{ kind: "tag", tag }];
  type HtmlPiece = { node: Node } | { id: string };
  const split = (node: Node): HtmlPiece[] => {
    if (node instanceof HTMLElement && node.matches(rangeSelector)) {
      const id = node.dataset.rangeId || /\{\{segment:([^}]+)\}\}/.exec(node.dataset.value || "")?.[1];
      if (id) return [{ id }];
    }
    if (!(node instanceof Element) || !node.querySelector(rangeSelector)) return [{ node: node.cloneNode(true) }];
    return [...node.childNodes].flatMap(child => split(child).map(piece => {
      if ("id" in piece) return piece;
      const wrapper = node.cloneNode(false);
      wrapper.appendChild(piece.node);
      return { node: wrapper };
    }));
  };
  return [...template.content.childNodes].flatMap(node => split(node).map(piece => {
    if ("id" in piece) return { kind: "range" as const, id: piece.id };
    const container = document.createElement("template");
    container.content.appendChild(piece.node);
    return { kind: "tag" as const, tag: { type: "Custom" as const, html: container.innerHTML } };
  }));
}

function modelPieces(model: PromptModel): Piece[] {
  return model.flatMap((line, lineIndex) => [
    ...(lineIndex ? [{ kind: "break" as const }] : []),
    ...line.flatMap((tag): Piece[] => {
      if (tag.type === "Custom") return customPieces(tag);
      if (tag.type !== "Write") return [{ kind: "tag", tag }];
      const pieces: Piece[] = [];
      let end = 0;
      for (const match of tag.text.matchAll(rangePattern)) {
        if (match.index! > end) pieces.push({ kind: "tag", tag: { type: "Write", text: tag.text.slice(end, match.index) } });
        pieces.push({ kind: "range", id: match[1] });
        end = match.index! + match[0].length;
      }
      if (end < tag.text.length || !pieces.length) pieces.push({ kind: "tag", tag: { type: "Write", text: tag.text.slice(end) } });
      return pieces;
    }),
  ]);
}

function referencesIn(pieces: Piece[]): Piece[] {
  return pieces.flatMap((piece): Piece[] => {
    if (piece.kind !== "tag") return [];
    if (piece.tag.type === "Mention") return [piece];
    if (piece.tag.type === "Write") return [...piece.tag.text.matchAll(/\{\{ref \d+\}\}/g)].map(match => ({ kind: "tag", tag: { type: "Write", text: match[0] } }));
    if (piece.tag.type !== "Custom") return [];
    const template = document.createElement("template");
    template.innerHTML = piece.tag.html;
    return template.content.querySelector(".imageReference[data-reference-id], .imageReference[data-value]") ? [piece] : [];
  });
}

function toModel(pieces: Piece[]): PromptModel {
  const result: PromptModel = [[]];
  for (const piece of pieces) {
    if (piece.kind === "break") { result.push([]); continue; }
    if (piece.kind !== "tag") continue;
    const line = result[result.length - 1], previous = line[line.length - 1];
    if (piece.tag.type === "Write" && previous?.type === "Write") line[line.length - 1] = { ...previous, text: previous.text + piece.tag.text };
    else line.push(piece.tag);
  }
  return result.map(line => {
    if (!line.length) return [{ type: "Write", text: "" }];
    if (line[0].type !== "Write") line.unshift({ type: "Write", text: "" });
    if (line[line.length - 1].type !== "Write") line.push({ type: "Write", text: "" });
    return line;
  });
}

function withoutBoundaryPadding(pieces: Piece[]): Piece[] {
  const result = [...pieces];
  const empty = (piece: Piece) => piece.kind === "tag" && piece.tag.type === "Write" && piece.tag.text === "";
  while (result.length && empty(result[0])) result.shift();
  while (result.length && (empty(result[result.length - 1]) || result[result.length - 1].kind === "break")) result.pop();
  return result;
}

/** Keep each range's following instructions bound to its stable range ID. */
export function syncSegmentPrompt(model: PromptModel, ranges: readonly SegmentRange[]): PromptModel {
  const prefix: Piece[] = [], blocks = new Map<string, Piece[]>();
  let current = prefix;
  for (const piece of modelPieces(model)) {
    if (piece.kind !== "range") { current.push(piece); continue; }
    const existing = blocks.get(piece.id);
    current = existing || [];
    if (existing?.length) current.push({ kind: "break" });
    blocks.set(piece.id, current);
  }
  const ids = new Set(ranges.map(range => range.id));
  // Removing a segment must never disconnect a normal media reference. Keep
  // those tags in the unassigned prefix rather than another segment's prompt.
  for (const [id, pieces] of blocks) if (!ids.has(id)) prefix.push(...referencesIn(pieces));
  const result = withoutBoundaryPadding(prefix);
  const emitted = new Set<string>();
  for (const range of ranges) {
    if (emitted.has(range.id)) continue;
    emitted.add(range.id);
    if (result.length && result[result.length - 1].kind !== "break") result.push({ kind: "break" });
    const instructions = withoutBoundaryPadding(blocks.get(range.id) || []);
    result.push({ kind: "tag", tag: rangeTag(range) }, ...(instructions.length
      ? instructions : [{ kind: "tag" as const, tag: { type: "Write" as const, text: " " } }]));
  }
  return toModel(result);
}
