// 节点类型沿用 MiaoImg 的 remote-<name> 约定；内置节点直接挂在这个名字下。
// 这里负责把工作台历史上出现过的两种写法统一到该约定：
//   1. 更早版本的 remote-imageNode / remote-videoNode 指的是生成节点；
//   2. 中间版本用过不带 remote- 前缀的裸类型名。
const BARE_TO_REMOTE: Record<string, string> = {
  textNode: "remote-textNode",
  imageNode: "remote-imageNode",
  imageGenerationNode: "remote-imageGenerationNode",
  videoGenerationNode: "remote-videoGenerationNode",
  videoNode: "remote-videoNode",
  audioNode: "remote-audioNode",
  director3dNode: "remote-director3dNode",
};

export function migrateNodeTypes<T extends { type?: string; data?: unknown }>(nodes: T[]): T[] {
  for (const node of nodes) {
    const type = node.type;
    if (!type) continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    // 旧生成节点带 prompt/model 字段，旧结果节点没有。
    const legacyGeneration = typeof data.prompt === "string" || typeof data.model === "string";
    if (type === "remote-imageNode" && legacyGeneration) node.type = "remote-imageGenerationNode";
    else if (type === "remote-videoNode" && legacyGeneration) node.type = "remote-videoGenerationNode";
    else if (BARE_TO_REMOTE[type]) node.type = BARE_TO_REMOTE[type];
  }
  return nodes;
}
