import { IconPencil, IconEraser, IconBackground, IconUser, IconScissors, IconWriting, IconTransfer } from "@tabler/icons-vue";
import type { CanvasTool } from "./canvasToolCatalogue";
import type { NodeMediaModel } from "./scaffold/nodeAi";

export const videoIntents = [
  { id: "video:replace-element", label: "元素替换", icon: IconTransfer, placeholder: "描述要替换的对象，以及希望替换成什么。", prompt: "" },
  { id: "video:remove-subject", label: "主体消除", icon: IconEraser, placeholder: "描述要移除的人或物，以及需要保留的内容。", prompt: "" },
  { id: "video:remove-subtitles", label: "去字幕", icon: IconWriting, placeholder: "描述字幕的位置或需要处理的文字。", prompt: "移除画面中的字幕，尽量补全被文字覆盖的背景，保留其它内容。",
    hint: "这是 AI 重绘去字幕尝试，可能残留文字或改变背景，不能保证逐帧无残留或像素保真。" },
  { id: "video:edit-background", label: "背景编辑", icon: IconBackground, placeholder: "描述新的背景或环境，以及人物和动作需要保留的部分。", prompt: "" },
  { id: "video:edit-person", label: "人物编辑", icon: IconUser, placeholder: "描述人物、服装或外貌需要怎样改变，可添加人物或服装参考图。", prompt: "" },
  { id: "video:retake-segment", label: "片段重拍", icon: IconScissors, placeholder: "描述指定时间段中需要重新演绎或修改的内容。", prompt: "",
    hint: "时间段用于语义编辑，不会裁剪原片，也不保证只改动指定帧；严格局部替换需要另行截段、校验后拼回。" },
  { id: "video:edit", label: "编辑视频", icon: IconPencil, placeholder: "描述需要修改的内容，以及希望保留的部分。", prompt: "" },
] as const;
export type VideoIntentToolId = typeof videoIntents[number]["id"];
export function videoIntent(id: string) { return videoIntents.find(intent => intent.id === id); }
export function videoEditModels(models: NodeMediaModel[]) { return models.filter(model => model.type === "video" && model.mode?.includes("edit")); }
export const videoIntentTools: CanvasTool[] = videoIntents.map(intent => ({ id: intent.id, label: intent.label, icon: intent.icon, group: "视频编辑", capability: models => videoEditModels(models).length > 0 }));
