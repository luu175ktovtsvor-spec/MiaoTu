// Runs inside the signed-in platform page. Both platforms' current native
// settings and creation SDK independently confirm this contract: privacy
// object 150 plus creativity type 1; true means AI-mark removal is enabled.
// No model request, subscription change or other privacy setting is involved.
export async function platformWatermarkPreference(platform: 'doubao' | 'dola', update = false): Promise<{ confirmed: boolean; changed: boolean }> {
  if (platform !== 'doubao' && platform !== 'dola') throw new Error('未知的本机模型来源')
  const origin = platform === 'dola' ? 'https://www.dola.com' : 'https://www.doubao.com', path = location.pathname
  const label = platform === 'dola' ? 'Dola' : '豆包'
  const current = () => location.origin === origin && location.pathname === path && /^\/chat(?:\/|$)/.test(path)
  if (!current()) throw new Error(`${label}水印设置页面已变化，本次尚未发送`)
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 12_000)
  const abort = () => controller.abort()
  addEventListener('pagehide', abort, { once: true })
  try {
    const post = async (endpoint: string, body: unknown) => {
      if (!current()) throw new Error(`${label}页面已变化`)
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include', redirect: 'error',
        headers: { 'content-type': 'application/json', 'agw-js-conv': 'str' }, body: JSON.stringify(body), signal: controller.signal })
      if (!current() || response.status !== 200) { await response.body?.cancel(); throw new Error(`${label}水印设置暂不可读`) }
      const reader = response.body?.getReader()
      if (!reader) throw new Error(`${label}水印设置响应缺失`)
      let size = 0, text = ''; const decoder = new TextDecoder()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 256 * 1024) { await reader.cancel(); throw new Error(`${label}水印设置响应异常`) }
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock() }
      if (!current()) throw new Error(`${label}页面已变化`)
      const data = JSON.parse(text)
      if (data?.code !== 0 && data?.code !== '0') throw new Error(`${label}未确认水印设置`)
      return data.data
    }
    const read = async () => {
      const privacy = await post('/privacy/watermark_config/get', { objects: [150] })
      const matches = Array.isArray(privacy?.configs) ? privacy.configs.filter(item => item?.object === 150) : []
      const config = matches.length === 1 ? matches[0] : undefined
      const version = config?.version
      if (!config || ![0, 1].includes(config.value) || !(Number.isSafeInteger(version) && version >= 0 || typeof version === 'string' && /^\d{1,20}$/.test(version))) throw new Error(`${label}图片视频水印配置无法确认`)
      const creativity = await post('/creativity/user_config/get', {})
      const option = creativity?.config_map?.['1']?.watermark_option
      if (!option || typeof option.is_on !== 'boolean') throw new Error(`${label}去 AI 明水印选项无法确认`)
      return { config, option, confirmed: config.value === 1 && option.is_on === true }
    }
    let state = await read()
    if (state.confirmed || !update) return { confirmed: state.confirmed, changed: false }
    if (state.option.subscribe_config?.need_upgrade === true) throw new Error(`${label}账号暂未开放此水印选项，请在平台设置中查看`)
    if (state.config.value !== 1) await post('/privacy/watermark_config/set', { configs: [{ object: 150, value: 1, version: state.config.version }] })
    if (state.option.is_on !== true) await post('/creativity/user_config/set', { config_type: 1, config_value: { watermark_option: { is_on: true } } })
    state = await read()
    if (!state.confirmed) throw new Error(`${label}去 AI 明水印设置未生效`)
    return { confirmed: true, changed: true }
  } finally { clearTimeout(timeout); removeEventListener('pagehide', abort) }
}
