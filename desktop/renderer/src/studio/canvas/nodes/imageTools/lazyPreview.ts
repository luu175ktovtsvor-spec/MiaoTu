import { defineAsyncComponent, defineComponent, h, type AsyncComponentLoader, type Component } from 'vue'
import { translate } from '@miaoimg/i18n/vue'

const state = (failed: boolean) => defineComponent({
  setup: () => () => h('div', {
    role: failed ? 'alert' : 'status',
    style: { display: 'grid', placeItems: 'center', minHeight: '180px', color: 'var(--el-text-color-secondary)' },
  }, translate(failed ? '读取失败，请重试' : '正在加载…')),
})

// Vue forwards exposed refs to the loaded preview. Reopening a failed panel
// retries its loader; do not mount a second renderer or impose retry quotas.
export function lazyPreview<T extends Component>(loader: AsyncComponentLoader<T>): T {
  return defineAsyncComponent({ loader, delay: 0, loadingComponent: state(false), errorComponent: state(true) })
}
