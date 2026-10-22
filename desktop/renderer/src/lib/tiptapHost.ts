import * as core from "@tiptap/core";
import * as vue3 from "@tiptap/vue-3";
import * as starterKit from "@tiptap/starter-kit";
import * as markdown from "@tiptap/markdown";
import * as findAndReplace from "@tiptap/extension-find-and-replace";
import * as highlight from "@tiptap/extension-highlight";
import * as image from "@tiptap/extension-image";
import * as list from "@tiptap/extension-list";
import * as subscript from "@tiptap/extension-subscript";
import * as superscript from "@tiptap/extension-superscript";
import * as table from "@tiptap/extension-table";
import * as textAlign from "@tiptap/extension-text-align";
import * as model from "@tiptap/pm/model";
import * as state from "@tiptap/pm/state";
import * as view from "@tiptap/pm/view";
import * as marked from "marked";
import dompurify from "dompurify";

// 文件扩展的脚本不打包 tiptap，改为在运行时从宿主取同一份实例，避免出现两份 schema。
// 由扩展加载器按需 import（脚本里出现 miaoimgTiptapHost 时才加载）；扩展安装与脚本注入
// 由插件线实现，这里只负责把运行时挂到全局。外置清单见
Object.assign(globalThis, {
  miaoimgTiptapHost: { core, vue3, starterKit, markdown, findAndReplace, highlight, image, list, subscript, superscript, table, textAlign, model, state, view, marked, dompurify },
});
