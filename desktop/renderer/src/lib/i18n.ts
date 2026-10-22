// 妙图画布的中文文案（MiaoImg 的 Markdown / Chat 组件要用的语言包入口）。
import { computed } from 'vue'
import { translate } from '@miaoimg/i18n/vue'

export const markdownLocale = computed(() => ({
  button: {
    zoomIn: translate('放大'), zoomOut: translate('缩小'), resetZoom: translate('重置缩放'),
    preview: translate('预览'), source: translate('代码'), collapse: translate('折叠'),
    copy: translate('复制'), copied: translate('已复制'), download: translate('下载'),
    minimize: translate('最小化'), maximize: translate('最大化'), flipY: translate('垂直翻转'),
    flipX: translate('水平翻转'), rotateLeft: translate('向左旋转'), rotateRight: translate('向右旋转'),
    previous: translate('上一个'), next: translate('下一个'), back: translate('返回'),
    confirm: translate('确认'), cancel: translate('取消'),
  },
  error: {
    vanilla: translate('错误'), image: translate('图片加载失败'), mermaid: translate('Mermaid 渲染失败'),
    katex: translate('KaTeX 渲染失败'), harden: translate('已拦截'),
  },
  link: {
    title: translate('打开外部链接？'), description: translate('你即将访问外部网站'),
    copy: translate('复制链接'), open: translate('打开链接'),
  },
  dialog: { fullscreen: translate('全屏预览'), imagePreview: translate('图片预览') },
}))

export const chatLocale = computed(() => ({
  placeholder: translate('请输入消息...'), stopBtnText: translate('中止'), refreshTipText: translate('重新生成'),
  copyTipText: translate('复制'), likeTipText: translate('点赞'), dislikeTipText: translate('点踩'),
  copyCodeBtnText: translate('复制代码'), copyCodeSuccessText: translate('已复制'), clearHistoryBtnText: translate('清空历史记录'),
  copyTextSuccess: translate('已成功复制到剪贴板'), copyTextFail: translate('复制到剪贴板失败'),
  confirmClearHistory: translate('确定要清空所有的消息吗？'), loadingText: translate('思考中...'), loadingEndText: translate('已深度思考'),
  uploadImageText: translate('上传图片'), uploadAttachmentText: translate('上传附件'), shareTipText: translate('分享'),
}))
