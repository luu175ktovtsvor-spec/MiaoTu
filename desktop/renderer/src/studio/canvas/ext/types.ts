// 文件扩展的宿主契约，与上游 extScaffold 的 runtime 对齐：
// 上游脚手架构建出来的 UMD 扩展能直接在妙图里跑，扩展只认这里的 context，不导入 web 源码。
// 画布节点的 outputs / handleId / selectOutput 是妙图自己的补充字段。
import type { Component } from "vue";

export type ExtResource =
  | { kind: "file"; directory: string; path: string; label: string }
  | { kind: "canvasNode"; directory: string; path: string; nodeId: string; label: string };

// 文件能力全部落在资源所属工作区内，路径一律是相对路径。
// 上游脚手架里 read() 返回 ArrayBuffer、另有 reveal()；妙图的宿主按同一形状包了一层，
// reveal 依赖桌面客户端，网页端不提供这个能力，因此契约里也不出现。
export interface ExtFiles {
  list(path?: string, signal?: AbortSignal): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  readText(path: string, maxBytes?: number, signal?: AbortSignal): Promise<string>;
  readJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean, signal?: AbortSignal): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  acquireUrl(path: string, mimeType?: string): { url: Promise<string>; release(): void };
  rename(path: string, target: string): Promise<void>;
  copy(path: string, target: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface ExtContext {
  resource: ExtResource;
  files: ExtFiles;
  // 正文与保存状态由宿主管理：扩展调 updateText()，不要绕过宿主直接写文件。
  text: string;
  loading: boolean;
  error: string;
  dirty: boolean;
  // 文档页是否在前台。画布节点据此挂载或释放，媒体组件据此暂停播放。
  active: boolean;
  config: Record<string, unknown>;
  saveConfig: (config: Record<string, unknown>) => Promise<void>;
  updateText: (text: string) => void;
  flushSave: () => Promise<void>;
  writeClipboardText: (text: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  // 仅画布节点资源提供（对应上游 extScaffold 的 mountNode）：
  // 把该节点在画布里的界面投射到 element，返回释放投射的方法；卸载时必须调用。
  mountNode?: (element: HTMLElement) => Promise<() => void>;
  // 定位请求：文本编辑器按 query 找到第一处匹配，带行列号时优先按行列号定位。
  location?: { query: string; revision: number; line?: number; column?: number };
  outputs: { id: string; label: string }[];
  handleId: string;
  selectOutput: (id: string) => Promise<void>;
}

export interface ExtDefinition {
  id: string;
  displayName: string;
  icon?: string;
  // 表单规则（form-create Rule[]），每条 rule.value 提供默认值；最多 100 项，必须可序列化。
  configRules?: Record<string, unknown>[];
  extensions: string[];
  resourceKind: ExtResource["kind"];
  text?: boolean;
  load: () => Promise<{ default: Component }>;
}

// 与扩展脚手架同一套声明校验：装到浏览器里的脚本也要先过一遍，
// 有问题的扩展在加载时报出人话，而不是在组件渲染时才炸。
export function defineExt(definition: ExtDefinition): ExtDefinition {
  if (typeof definition.id !== "string" || definition.id.length > 96 || !/^ext-[a-z][a-zA-Z0-9]*$/.test(definition.id)) {
    throw new Error(`扩展 ID 必须为 ext- 加小驼峰名称，最多 96 个字符：${definition.id}`);
  }
  if (typeof definition.displayName !== "string" || !definition.displayName.trim()) throw new Error("扩展显示名不能为空");
  if (definition.icon !== undefined) {
    const icon = definition.icon;
    if (typeof icon !== "string" || (icon && !/^data:image\/(?:svg\+xml|png|jpeg|webp|gif|avif)(?:;[^,]*)?,/i.test(icon)
      && !(URL.canParse(icon) && ["http:", "https:"].includes(new URL(icon).protocol)))) throw new Error("扩展图标必须是 HTTP、HTTPS 或图片 data URL");
  }
  if (definition.configRules !== undefined && (!Array.isArray(definition.configRules) || definition.configRules.length > 100)) {
    throw new Error("扩展配置规则必须为最多 100 项的表单规则数组");
  }
  if (definition.resourceKind !== "file" && definition.resourceKind !== "canvasNode") throw new Error("扩展资源类型无效");
  if (definition.text !== undefined && typeof definition.text !== "boolean") throw new Error("扩展文本标记必须为布尔值");
  if (!Array.isArray(definition.extensions) || definition.extensions.some(extension => typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension))) {
    throw new Error("文件后缀必须是不带点的小写字母或数字");
  }
  if (definition.resourceKind === "file" && !definition.extensions.length) throw new Error("文件扩展至少需要一个后缀");
  if (new Set(definition.extensions).size !== definition.extensions.length) throw new Error("文件后缀不能重复");
  if (typeof definition.load !== "function") throw new Error("扩展必须提供组件加载函数");
  return definition;
}
