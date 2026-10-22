import { canvasInjectionKey } from '../../../../../../server/canvas-document.ts';

const exportKey: unique symbol = canvasInjectionKey("miaoimg.mediaExport") as any;
type ExportNode = { [exportKey]?: Readonly<{ progress: () => number }> };

// The node survives metadata reconciliation; its persistent data object does
// not. A non-enumerable shared symbol also stays out of copies and canvas JSON.
export function beginMediaExport(node: object, progress: () => number) {
  const target = node as ExportNode;
  if (target[exportKey]) throw new Error("该节点正在导出");
  const state = Object.freeze({ progress });
  Object.defineProperty(target, exportKey, { value: state, configurable: true });
  return {
    owns: () => target[exportKey] === state,
    finish() { if (target[exportKey] === state) delete target[exportKey]; },
  };
}

export function mediaExportProgress(node: object): number | undefined {
  return (node as ExportNode)[exportKey]?.progress();
}
