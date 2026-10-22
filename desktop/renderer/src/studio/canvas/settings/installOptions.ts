// 安装选项：仅供本地显式调试开关使用，在会话内共享给节点与工具面板。
// 只放在内存里、不落 localStorage——这是一个覆盖版本检查的危险开关，刷新即失效。
import { ref } from "vue";

export const forceInstall = ref(false);
