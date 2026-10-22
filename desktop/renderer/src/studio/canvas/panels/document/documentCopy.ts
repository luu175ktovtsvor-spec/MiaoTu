import { translate } from "@miaoimg/i18n/vue";
import { isMarkdownFile } from "../../../../../../../server/workspace-path";
import type { ExtResource } from "../../ext";
import type { DocumentSession } from "./documentSession";

export function documentCopyPath(resource: ExtResource) {
  if (resource.kind === "canvasNode") {
    const label = Array.from(resource.label.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").trim()).slice(0, 60).join("") || translate("文本");
    return `${label} 副本.md`;
  }
  const dot = resource.path.lastIndexOf(".");
  return dot > resource.path.lastIndexOf("/")
    ? `${resource.path.slice(0, dot)} 副本${resource.path.slice(dot)}` : `${resource.path} 副本`;
}

export async function saveDocumentCopy(session: DocumentSession, target: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { resource, text, sourcePath } = session.context;
  let content = text;
  if ((resource.kind === "canvasNode" || isMarkdownFile(resource.path)) && isMarkdownFile(target)) {
    const { rebaseMarkdownPaths } = await import("../../../../../../../server/markdown-rebase.ts");
    content = rebaseMarkdownPaths(text, sourcePath ?? resource.path, target);
  }
  signal?.throwIfAborted();
  await session.context.files.write(target, content, true, signal);
  signal?.throwIfAborted();
  return { recovered: session.acknowledgeSavedCopy(text) };
}
