import { markRaw, ref, shallowReactive, type Component } from "vue";
import { translate } from "@miaoimg/i18n/vue";
import { useWorkspaceContentFiles as useWorkspaceFiles } from "@/lib/workspaceFiles";
import type { ExtContext, ExtDefinition, ExtResource } from "../../ext";
import { createFileRevisionOwner } from '@/lib/workspaceFileSelection';

// 文件树、快速打开与全文搜索共用的选择：工作区文件，或画布里的文本节点。
export type DocumentSelection =
  | { filePath: string; label: string }
  | { canvasPath: string; nodeId: string; label: string };

export type DocumentNodeText = { label: string; outputs: { id: string; label: string; text: string; path?: string }[] };
export type DocumentHost = {
  readNode(directory: string, canvasPath: string, nodeId: string): Promise<DocumentNodeText>;
  reloadNode?(directory: string, canvasPath: string, nodeId: string, handleId: string, savedText: string, draftText: string, signal?: AbortSignal): Promise<DocumentNodeText>;
  saveNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedText?: string): Promise<void>;
  // 把画布节点在画布里的界面投射到 target，返回值用于释放投射；只有画布节点资源会用到。
  mountNode?(directory: string, canvasPath: string, nodeId: string, target: HTMLElement): Promise<() => void>;
  // 订阅画布节点的保存 / 错误 / 删除状态；只有画布节点资源会用到。
  observeNode?(
    directory: string, canvasPath: string, nodeId: string,
    onState: (state: { dirty: boolean; error: string; deleted: boolean }) => void,
  ): Promise<{ release(): void; flushSave(): Promise<void> }>;
};

export type SessionContext = {
  resource: ExtResource;
  files: ReturnType<typeof useWorkspaceFiles>;
  text: string;
  sourcePath?: string;
  error: string;
  dirty: boolean;
  active: boolean;
  readonly loading: boolean;
  // 画布节点的多个文本输出；普通文件只有一个隐含的正文。
  outputs: { id: string; label: string }[];
  handleId: string;
  updateText(text: string): void;
  selectOutput(id: string): Promise<void>;
  flushSave(): Promise<void>;
  // 只有画布节点资源：把宿主的节点界面嵌进当前文档视图，与上游同名同义。
  mountNode?: (element: HTMLElement) => Promise<() => void>;
};

// 工作区文件封装把服务端错误塞进 Error.response，这里统一取出人话。
export function documentError(error: unknown) {
  const response = (error as { response?: { data?: { message?: string; error?: string } } })?.response;
  const message = response?.data?.message || response?.data?.error;
  if (typeof message === "string" && message) return message;
  return error instanceof Error ? error.message : translate("文档操作失败");
}

function isConflict(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}

export function createDocumentSession(resource: ExtResource, extension: ExtDefinition, host: DocumentHost, onDeleted?: () => void) {
  const files = useWorkspaceFiles(resource.directory);
  const nodeResource = resource.kind === "canvasNode" ? resource : undefined;
  const mountHost = host.mountNode;
  const observeHost = host.observeNode;
  let nodeLease: { release(): void; flushSave(): Promise<void> } | undefined;
  // 面板里有没有还没落盘的正文。宿主的 dirty 只在它为空时才说了算（见 onNodeState）。
  let pendingText = false;
  let suspendedPendingText = false;
  let replacing: Promise<void> | undefined;
  let nodeDirty = false;
  let nodeError = "";
  let nodeDeleted = false;
  const deletedDraftMessage = () => translate("节点已删除，未保存的正文已保留，请另存副本。");
  let savedNodeText = "";
  let savedFileRevision = "";
  const fileRevisionOwner = createFileRevisionOwner();
  // 扩展声明 text 才是工作区文本；画布节点的正文走宿主节点接口，二进制资源不落文本。
  const writable = extension.text === true || resource.kind === "canvasNode";
  let disposed = false;
  let revision = 0;
  let saveEpoch = 0;
  let queuedRevision = -1;
  let saving: Promise<void> = Promise.resolve();
  let loadRequest: Promise<void> | undefined;
  let readRevision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loading = ref(false);
  const context = shallowReactive<SessionContext>({
    resource,
    files,
    text: "",
    error: "",
    dirty: false,
    active: true,
    outputs: [],
    handleId: "",
    mountNode: mountHost && nodeResource
      ? (target) => mountHost(nodeResource.directory, nodeResource.path, nodeResource.nodeId, target)
      : undefined,
    get loading() { return loading.value; },
    updateText(text) {
      if (disposed || session.closing || loading.value || !writable || context.text === text) return;
      // A failed first read has no text revision to save against. Keep its
      // error tab closable and retryable instead of creating an unsavable draft.
      if (resource.kind === "file" && !savedFileRevision) return;
      context.text = text;
      context.dirty = true;
      pendingText = true;
      context.error = nodeDeleted ? deletedDraftMessage() : "";
      revision++;
      clearTimeout(timer);
      if (!nodeDeleted) timer = setTimeout(() => { void flushSave().catch(() => {}); }, 400);
    },
    selectOutput,
    flushSave,
  });

  async function readText(fromDisk = false, signal?: AbortSignal) {
    const currentRead = ++readRevision;
    if (resource.kind === "file") {
      // 二进制资源由扩展自己用 files.acquireUrl() 取，宿主不读成文本。
      const snapshot = extension.text ? await files.readTextSnapshot(resource.path, signal) : undefined;
      if (!disposed && currentRead === readRevision) {
        context.text = snapshot?.text ?? "";
        context.sourcePath = resource.path;
        savedFileRevision = snapshot?.revision ?? "";
        fileRevisionOwner.reset(savedFileRevision);
      }
      return;
    }
    if (fromDisk && !host.reloadNode) throw new Error(translate("此节点不支持重新读取磁盘正文"));
    const node = fromDisk
      ? await host.reloadNode!(resource.directory, resource.path, resource.nodeId, context.handleId, savedNodeText, context.text, signal)
      : await host.readNode(resource.directory, resource.path, resource.nodeId);
    if (disposed || currentRead !== readRevision) return;
    signal?.throwIfAborted();
    if (fromDisk && nodeDeleted) throw new Error(deletedDraftMessage());
    acceptNodeLabel(node.label);
    if (!node.outputs.length) throw new Error(translate("节点没有文本输出"));
    const output = node.outputs.find((item) => item.id === context.handleId) ?? node.outputs[0]!;
    context.handleId = output.id;
    context.outputs = node.outputs.map(({ id, label }) => ({ id, label }));
    context.text = output.text;
    context.sourcePath = output.path ?? resource.path;
    savedNodeText = output.text;
  }

  function acceptNodeLabel(label: string) {
    if (context.resource.label !== label) context.resource = { ...context.resource, label };
  }

  // 宿主报告的画布节点状态：脏标记 / 错误 / 节点已删除。
  function onNodeState(state: { dirty: boolean; error: string; deleted: boolean }) {
    if (disposed) return;
    // 宿主的未保存状态只参与显示和 lease.flushSave，不能触发面板旧正文回写。
    // 面板仍有待存正文时，宿主变干净也不能清除本地草稿或保存错误。
    const wasDeleted = nodeDeleted;
    nodeDeleted = state.deleted;
    nodeDirty = !state.deleted && state.dirty;
    nodeError = state.error;
    context.dirty = pendingText || suspendedPendingText || nodeDirty;
    if (state.deleted) {
      clearTimeout(timer);
      if (pendingText || suspendedPendingText) context.error = deletedDraftMessage();
      else onDeleted?.();
      return;
    }
    if (wasDeleted) {
      context.error = nodeError;
      if (pendingText) {
        queuedRevision = -1;
        clearTimeout(timer);
        timer = setTimeout(() => { void flushSave().catch(() => {}); }, 400);
      }
    } else if (nodeError || !pendingText) context.error = nodeError;
  }

  async function flushSave(skipReplacement = false) {
    if (!skipReplacement && replacing) await replacing;
    if (nodeResource) {
      // 上游在画布节点分支里先等 session.ready：读节点失败但也没有待写正文时，不该把关闭流程卡死。
      try { await session.ready; } catch (error) { if (nodeLease || context.dirty) throw error; }
    }
    while (!disposed) {
      if (!skipReplacement && replacing) await replacing;
      if (disposed) return;
      clearTimeout(timer);
      if (nodeDeleted) {
        if (pendingText) throw new Error(deletedDraftMessage());
        return;
      }
      if (pendingText && queuedRevision !== revision) {
        const currentRevision = revision;
        const epoch = saveEpoch;
        const text = context.text;
        const handleId = context.handleId;
        queuedRevision = currentRevision;
        // ACT: 保存始终绑定打开时的文件或节点，排队期间切换标签不改变写入目标。
        saving = saving.catch(() => {}).then(async () => {
          if (disposed || epoch !== saveEpoch) return;
          if (resource.kind === "canvasNode") {
            if (nodeDeleted) throw new Error(deletedDraftMessage());
            if (!handleId) throw new Error(translate("节点没有可编辑的文本输出"));
            await host.saveNode(resource.directory, resource.path, resource.nodeId, handleId, text, savedNodeText);
            savedNodeText = text;
            return;
          }
          if (!writable) return;
          const before = savedFileRevision;
          savedFileRevision = await files.writeText(resource.path, text, before);
          fileRevisionOwner.written(before, savedFileRevision);
        }).then(() => {
          if (disposed || currentRevision !== revision) return;
          context.dirty = nodeDirty;
          pendingText = false;
          context.error = nodeError;
          session.conflict = false;
          if (nodeDeleted) onDeleted?.();
        }).catch((error) => {
          if (queuedRevision === currentRevision) queuedRevision = -1;
          context.error = nodeDeleted ? deletedDraftMessage() : documentError(error);
          session.conflict = !nodeDeleted && isConflict(error);
          throw error;
        });
      }
      const pending = saving;
      await pending;
      if (!skipReplacement && replacing) await replacing;
      if (disposed) return;
      if (nodeDeleted) {
        if (pendingText) throw new Error(deletedDraftMessage());
        return;
      }
      // 保存期间仍可继续输入；退出工作区前必须一并落盘等待期间产生的新版本。
      if (pending === saving && !pendingText) {
        // saveNode writes the pane text; the lease additionally saves the
        // node and canvas state and cannot replace that text write.
        // The user may keep typing while the host saves its canvas. Include
        // those edits before allowing the workspace to close or switch.
        if (nodeLease) await nodeLease.flushSave();
        if (pending === saving && !pendingText) break;
      }
    }
  }

  // 换输出或载入磁盘版本都会整段替换正文，期间挡住编辑器的自动保存。
  async function replaceText(read: () => Promise<void>, savePending = false) {
    if (disposed || session.closing || loading.value) throw new Error(translate("文档正在加载或关闭，请稍后重试"));
    const work = (async () => {
      loading.value = true;
      clearTimeout(timer);
      if (!savePending) {
        // Stop an already-running autosave from submitting a newer draft after
        // the user confirmed loading another version. Retain it until read success.
        suspendedPendingText = pendingText;
        pendingText = false;
        saveEpoch++;
        revision++;
        queuedRevision = -1;
      }
      try {
        if (savePending) await flushSave(true);
        else await saving.catch(() => {});
        if (disposed) return;
        saving = Promise.resolve();
        await read();
        if (disposed) return;
        context.dirty = nodeDirty;
        pendingText = false;
        context.error = nodeError;
        session.conflict = false;
        revision++;
        queuedRevision = -1;
      } catch (error) {
        if (!savePending && !disposed) {
          pendingText = suspendedPendingText;
          context.dirty = pendingText || nodeDirty;
          queuedRevision = -1;
        }
        throw error;
      } finally {
        suspendedPendingText = false;
        loading.value = false;
      }
    })();
    replacing = work;
    try { await work; }
    finally { if (replacing === work) replacing = undefined; }
  }

  async function selectOutput(id: string) {
    if (resource.kind !== "canvasNode" || disposed || id === context.handleId) return;
    await replaceText(async () => {
      const node = await host.readNode(resource.directory, resource.path, resource.nodeId);
      if (disposed) return;
      acceptNodeLabel(node.label);
      const output = node.outputs.find((item) => item.id === id);
      if (!output) throw new Error(translate("文本输出不存在"));
      context.handleId = output.id;
      context.text = output.text;
      context.sourcePath = output.path ?? resource.path;
      context.outputs = node.outputs.map(({ id, label }) => ({ id, label }));
      savedNodeText = output.text;
    }, true);
  }

  const session = shallowReactive({
    context,
    extension,
    get canWriteText() { return writable; },
    get hasPendingText() { return pendingText || suspendedPendingText; },
    component: undefined as Component | undefined,
    closing: false,
    conflict: false,
    ready: Promise.resolve(),
    load() {
      if (loadRequest) return loadRequest;
      if (disposed) return Promise.resolve();
      if (pendingText || session.closing || loading.value) return Promise.reject(new Error(translate("文档正在加载或关闭，请稍后重试")));
      loadRequest = (async () => {
        loading.value = true;
        context.error = "";
        try {
          const [module] = await Promise.all([extension.load(), readText()]);
          if (disposed) return;
          if (observeHost && nodeResource && !nodeLease) {
            const lease = await observeHost(nodeResource.directory, nodeResource.path, nodeResource.nodeId, onNodeState);
            if (disposed) { lease.release(); return; }
            nodeLease = lease;
          }
          session.component = markRaw(module.default);
        } catch (error) {
          // Promise.all may reject while readText is still awaiting its host.
          // A failed load must not apply that late text after a successful retry.
          readRevision++;
          if (disposed) return;
          context.error = documentError(error);
          throw error;
        } finally {
          loading.value = false;
        }
      })().finally(() => { loadRequest = undefined; });
      return loadRequest;
    },
    async reloadDisk(expectedText = context.text, signal?: AbortSignal) {
      if (!writable || disposed) return;
      signal?.throwIfAborted();
      if (context.text !== expectedText) throw new Error(translate("文档内容已变化，请重新读取后编辑"));
      clearTimeout(timer);
      try {
        await replaceText(() => readText(true, signal));
      } catch (error) {
        if (disposed) return;
        context.error = documentError(error);
        throw error;
      }
    },
    // A read must not replace edits made while its host request was in flight.
    async syncNode() {
      if (resource.kind !== "canvasNode") return;
      if (disposed || session.closing || loading.value) throw new Error(translate("文档正在加载或关闭，请稍后重试"));
      await flushSave();
      if (disposed || session.closing || loading.value) throw new Error(translate("文档正在加载或关闭，请稍后重试"));
      const currentRevision = revision;
      const handleId = context.handleId;
      const node = await host.readNode(resource.directory, resource.path, resource.nodeId);
      if (disposed || session.closing || loading.value || currentRevision !== revision || handleId !== context.handleId || pendingText) {
        throw new Error(translate("文档内容已变化，请重新读取后编辑"));
      }
      acceptNodeLabel(node.label);
      const output = node.outputs.find((item) => item.id === context.handleId) ?? node.outputs[0];
      context.handleId = output?.id ?? "";
      context.outputs = node.outputs.map(({ id, label }) => ({ id, label }));
      context.text = output?.text ?? "";
      context.sourcePath = output?.path ?? resource.path;
      savedNodeText = context.text;
      context.dirty = nodeDirty;
      pendingText = false;
      context.error = nodeError;
      session.conflict = false;
      revision++;
      queuedRevision = -1;
    },
    mutationRevision: (selected: string) => resource.kind === 'file' ? fileRevisionOwner.resolve(selected) : undefined,
    // Only an exact, successfully written copy releases a deleted draft. A
    // newer edit or a restored node still needs its own ordinary save.
    acknowledgeSavedCopy(text: string) {
      if (disposed || !nodeDeleted || !pendingText || context.text !== text) return false;
      clearTimeout(timer);
      revision++;
      queuedRevision = -1;
      pendingText = false;
      context.dirty = false;
      context.error = "";
      session.conflict = false;
      onDeleted?.();
      return true;
    },
    cancelSave() {
      clearTimeout(timer);
      disposed = true;
      nodeLease?.release();
    },
  });
  session.ready = session.load();
  void session.ready.catch(() => {});
  return session;
}

export type DocumentSession = ReturnType<typeof createDocumentSession>;

export type TabAction = "close" | "closeOthers" | "closeRight" | "closeAll" | "reopen" | "splitRight" | "splitDown" | "keepOpen";
// 每个 dockview 面板一份视图状态：同一份文档可以拆成多个视图，预览标记与搜索定位都按视图走。
export type EditorView = { preview: boolean; description: string; location?: ExtContext["location"] };
export type EditorParams = { session: DocumentSession; view: EditorView; close: () => Promise<void>; action: (action: TabAction) => void };
