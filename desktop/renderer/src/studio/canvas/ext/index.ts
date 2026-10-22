// 文件扩展运行时入口：面板只从这里取扩展清单、候选与宿主上下文。
export { defineExt } from "./types";
export type { ExtContext, ExtDefinition, ExtFiles, ExtResource } from "./types";
export { installExtHost } from "./host";
export { extFiles } from "./extFiles";
export {
  candidateExtensions,
  createExtContext,
  currentExtensions,
  extensionAssociations,
  extensionCandidates,
  extensionConfig,
  extensionIcon,
  listExtensions,
  resolveExtension,
  saveExtensionConfig,
  setExtensionAssociation,
  textExtensions,
  updateExtensionConfig,
} from "./extensions";
export type { InstalledExtension } from "./extensions";
