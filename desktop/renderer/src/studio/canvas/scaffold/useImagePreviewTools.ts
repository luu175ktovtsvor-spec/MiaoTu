import { nextTick, type Ref } from 'vue';
import { nodeTools, z } from './nodeTools';

export function useImagePreviewTools(visible: Ref<boolean>, available: () => boolean) {
  nodeTools.register({
    name: 'setImagePreview', description: '打开或关闭此节点已有图片的大图预览，与界面全屏预览按钮相同；不改变图片或调用模型。',
    parameters: z.strictObject({ open: z.boolean() }),
    async execute({ open }, { signal }) {
      signal?.throwIfAborted();
      if (open && !available()) throw new Error('节点尚无可预览图片');
      visible.value = open; await nextTick(); signal?.throwIfAborted();
      return { open: visible.value };
    },
  });
}
