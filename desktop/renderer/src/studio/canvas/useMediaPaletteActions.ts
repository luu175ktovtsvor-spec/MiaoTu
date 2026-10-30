import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { useRegisterCanvasTools, canvasToolAnchor } from "./canvasToolRegistry";
import type { CanvasToolId } from "./canvasToolCatalogue";
import type { BoundActionContext } from "./boundActionRegistry";

export type CanvasToolExtension = {
  available: (tool: CanvasToolId) => boolean;
  ready?: (tool: CanvasToolId) => boolean;
  run: (tool: CanvasToolId, context: BoundActionContext) => unknown | Promise<unknown>;
};
export function combineCanvasToolExtensions(...extensions: CanvasToolExtension[]): CanvasToolExtension {
  const owner = (tool: CanvasToolId) => extensions.find(extension => extension.available(tool));
  return {
    available: tool => Boolean(owner(tool)),
    ready: tool => owner(tool)?.ready?.(tool) ?? true,
    run: (tool, context) => owner(tool)?.run(tool, context),
  };
}
const imageActions = ["image:lighting", "image:angle", "image:mark", "image:inpaint", "image:grid", "image:layers", "image:generateSphere", "image:generateCylinder", "image:previewSphere", "image:previewCylinder"];
const baseImageTool = (tool: CanvasToolId) => imageActions.includes(tool) || tool.startsWith("image:preset:");

export function useImagePaletteActions(options: {
  node: GraphNode; hasImage: () => boolean; busy: () => boolean; inpaintAllowed: () => boolean;
  ready: (tool: CanvasToolId) => boolean;
  lighting: () => void; angle: () => void; mark: () => unknown; inpaint: () => unknown;
  grid: (event: MouseEvent) => void; panorama: (command: string) => unknown;
  layers: () => unknown; preset: (id: string) => unknown;
  extension?: CanvasToolExtension;
}) {
  const flow = useVueFlow();
  const extension = (tool: CanvasToolId) => Boolean(options.extension?.available(tool));
  useRegisterCanvasTools(options.node, {
    available: tool => tool.startsWith("image:") && options.hasImage() && !options.busy()
      && (baseImageTool(tool) ? tool !== "image:inpaint" || options.inpaintAllowed() : Boolean(options.extension?.available(tool))),
    ready: tool => extension(tool) ? options.extension?.ready?.(tool) ?? true : options.ready(tool),
    run: (tool, context) => {
      if (extension(tool)) return options.extension?.run(tool, context);
      if (!baseImageTool(tool)) return options.extension?.run(tool, context);
      if (tool.startsWith("image:preset:")) return options.preset(tool.slice("image:preset:".length));
      if (tool === "image:lighting") return options.lighting();
      if (tool === "image:angle") return options.angle();
      if (tool === "image:mark") return options.mark();
      if (tool === "image:inpaint") return options.inpaint();
      if (tool === "image:grid") return options.grid(canvasToolAnchor(options.node, flow.vueFlowRef.value));
      if (tool === "image:layers") return options.layers();
      return options.panorama(tool.slice("image:".length));
    },
  });
}

export function useVideoPaletteActions(options: {
  node: GraphNode; hasVideo: () => boolean; busy: () => boolean;
  ready: (tool: CanvasToolId) => boolean; capture: () => unknown; open: (action: "extractAudio" | "separate" | "trim") => unknown;
  mode: (mode: "edit" | "extend") => unknown;
  extension?: CanvasToolExtension;
}) {
  const baseVideoTool = (tool: CanvasToolId) => ["video:capture", "video:extractAudio", "video:separate", "video:trim", "video:extend"].includes(tool);
  const extension = (tool: CanvasToolId) => Boolean(options.extension?.available(tool));
  useRegisterCanvasTools(options.node, {
    available: tool => tool.startsWith("video:") && options.hasVideo() && !options.busy() && (baseVideoTool(tool) || extension(tool)),
    ready: tool => extension(tool) ? options.extension?.ready?.(tool) ?? true : options.ready(tool),
    run: (tool, context) => extension(tool) ? options.extension?.run(tool, context)
      : tool === "video:capture" ? options.capture()
        : tool === "video:edit" || tool === "video:extend" ? options.mode(tool === "video:edit" ? "edit" : "extend")
          : options.open(tool.slice("video:".length) as "extractAudio" | "separate" | "trim"),
  });
}
