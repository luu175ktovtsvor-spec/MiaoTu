// 文档面板与画布文本节点共用同一条 Markdown 管线。
// 上游本来就是同一份实现（packages/ext/md 与 packages/nodes/textNode 各带一份、内容逐字相同），
// 妙图只保留 nodes/textNode 下那一份，面板从这里转出去——面板里那份简化副本就是这么丢掉
// parseMarkdownContent / 工作区图片 node view / 复杂表格判定的，避免再出现第二次漂移。
export { default, parseMarkdownContent, serializeMarkdown } from "../../nodes/textNode/markdownExtensions";
export { resolveMarkdownPath as resolveDocumentPath } from "../../nodes/textNode/markdownContent";
