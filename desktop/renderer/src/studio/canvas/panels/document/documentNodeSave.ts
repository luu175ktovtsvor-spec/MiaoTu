import type { DocumentSession } from "./documentSession";

// Only document drafts for the nodes being removed participate. Split views
// share sessions; unrelated documents keep their own ordinary save lifecycle.
export async function flushNodeDocumentSessions(sessions: () => DocumentSession[], directory: string, canvasPath: string,
  nodeIds: readonly string[], signal?: AbortSignal) {
  const ids = new Set(nodeIds);
  const relevant = () => [...new Set(sessions())].filter(session => {
    const resource = session.context.resource;
    return resource.kind === "canvasNode" && resource.directory === directory && resource.path === canvasPath && ids.has(resource.nodeId);
  });
  while (true) {
    signal?.throwIfAborted();
    const current = relevant();
    const results = await Promise.allSettled(current.map(session => session.context.flushSave()));
    signal?.throwIfAborted();
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    // Include edits or newly opened views created while another session saved.
    const latest = relevant();
    if (latest.length === current.length && latest.every(session => current.includes(session) && !session.hasPendingText)) return;
  }
}
