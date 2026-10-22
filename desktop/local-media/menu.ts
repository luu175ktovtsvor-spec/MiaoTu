import type { LiveMenuModel } from './catalog.ts'

const RATIO = /^(?:auto|\d{1,2}:\d{1,2})$/
const RESOLUTION = /^(?:\d{3,4}p|[124]k)$/i
const MODEL_KEY = /^[\w .+:-]{1,80}$/

function textOf(value: unknown, limit = 80) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

// The page receives this function alone. Everything it needs is inside the body.
export function parseLiveCreationMenu(input, itemKinds = {}) {
  const ratioPattern = /^(?:auto|\d{1,2}:\d{1,2})$/
  const resolutionPattern = /^(?:\d{3,4}p|[124]k)$/i
  const modelPattern = /^[\w .+:-]{1,80}$/
  const clean = (value, limit = 80) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
  const optionKey = option => clean(option?.option_key || option?.value || option?.extra?.resolution || option?.key, 80)
  const optionLabels = option => [...new Set([option?.display_text, option?.selected_display_text, option?.show_name, option?.label, option?.option_key, option?.value].map(value => clean(value)).filter(Boolean))]
  const selectorFrom = node => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return
    const template = node.template && typeof node.template === 'object' ? node.template : node
    const key = clean(template.key || template.value, 80)
    const label = clean(template.label || template.show_name, 80)
    const options = template.option_list || template.options || node.options || node.option_list
    const configs = template.configs && typeof template.configs === 'object' ? template.configs : undefined
    if (!key && !label && !Array.isArray(options) && !configs && !Number.isFinite(Number(template.lower_bound)) && !Number.isFinite(Number(template.upper_bound))) return
    return { key, label, options: Array.isArray(options) ? options : [], template, configs }
  }
  const selectorList = value => {
    if (!Array.isArray(value) || !value.length || value.length > 30) return
    const selectors = value.map(selectorFrom).filter(Boolean)
    return selectors.length && selectors.length >= Math.ceil(value.length / 2) ? selectors : undefined
  }
  const durationsOf = selector => {
    if (!selector) return []
    const lower = Number(selector.template.lower_bound), upper = Number(selector.template.upper_bound), step = Number(selector.template.step_length)
    if (Number.isInteger(lower) && Number.isInteger(upper) && Number.isInteger(step) && step > 0 && upper >= lower && upper <= 120 && (upper - lower) / step <= 60) {
      const values = []
      for (let value = lower; value <= upper; value += step) values.push(value)
      return values
    }
    return [...new Set(selector.options.map(optionKey).map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 120))]
  }
  const keysOf = (selector, pattern) => selector ? [...new Set(selector.options.map(optionKey).filter(key => pattern.test(key)))] : []
  const kindOf = (value, hint) => /seedance|ic_mini|dreamina\s+seedance|video/i.test(value) ? 'video' : /seedream|image/i.test(value) ? 'image' : hint
  const models = []
  const addModel = model => {
    const existing = models.find(item => item.kind === model.kind && item.key === model.key)
    if (!existing) { models.push(model); return }
    if (model.durations.length > existing.durations.length) existing.durations = model.durations
    if (model.defaultDuration && existing.durations.includes(model.defaultDuration)) existing.defaultDuration = model.defaultDuration
    if (existing.defaultDuration && !existing.durations.includes(existing.defaultDuration)) delete existing.defaultDuration
    if (model.ratios.length > existing.ratios.length) existing.ratios = model.ratios
    if (model.resolutions.length > existing.resolutions.length) existing.resolutions = model.resolutions
    if (model.label !== model.key && (existing.label === existing.key || model.label.length > existing.label.length)) existing.label = model.label
    existing.labels = [...new Set([...existing.labels, ...model.labels])].slice(0, 6)
  }
  const parametersOf = selectors => {
    const duration = selectors.find(item => /duration/i.test(item.key) || item.label === '时长' || item.label === 'Duration')
    const ratio = selectors.find(item => item.label === '比例' || item.label === 'Ratio' || /(?:^|[-_])ratio$/.test(item.key))
    const resolution = selectors.find(item => /resolution/i.test(item.key) || /分辨率|清晰度/.test(item.label))
    const durations = durationsOf(duration).slice(0, 60)
    const selected = Number(duration?.template?.default_selected_duration ?? duration?.template?.default_duration)
    return { durations, defaultDuration: durations.includes(selected) ? selected : undefined, ratios: keysOf(ratio, ratioPattern).slice(0, 24), resolutions: keysOf(resolution, resolutionPattern).map(value => String(value).toLowerCase()).slice(0, 8) }
  }
  const unwrap = (value, depth) => {
    if (depth > 24) return value
    if (typeof value === 'string') {
      const text = value.trim()
      if (!text || text.length > 1_500_000 || (text[0] !== '{' && text[0] !== '[')) return value
      try { return unwrap(JSON.parse(text), depth + 1) } catch { return value }
    }
    if (Array.isArray(value)) return value.map(item => unwrap(item, depth + 1))
    if (!value || typeof value !== 'object') return value
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      if (/url|icon|avatar|token|sign|prompt|uri|cover/i.test(key)) continue
      output[key] = unwrap(item, depth + 1)
    }
    return output
  }
  const absorb = (selectors, hint) => {
    const modelSelector = selectors.find(item => /^(?:video-model|image-model|model)$/.test(item.key) || /^(?:模型|Model|モデル|model)$/.test(item.label))
    if (!modelSelector) return
    const shared = parametersOf(selectors)
    const configFor = option => {
      for (const selector of selectors) {
        const entry = selector.configs && (selector.configs[option?.id] || selector.configs[String(option?.id)])
        const nested = entry && (selectorList(entry.selectors) || selectorList(entry.selector_list))
        if (nested) return parametersOf(nested)
      }
    }
    for (const option of modelSelector.options) {
      const key = optionKey(option)
      if (!key || !modelPattern.test(key) || ratioPattern.test(key) || resolutionPattern.test(key) || /^\d+s?$/i.test(key)) continue
      const labels = optionLabels(option)
      const parameters = configFor(option) || shared
      const fallback = /video/.test(modelSelector.key) || parameters.durations.length || parameters.resolutions.length ? 'video' : modelSelector.key === 'model' || /image/.test(modelSelector.key) ? 'image' : undefined
      const kind = kindOf(`${key} ${labels.join(' ')}`, hint || fallback)
      if (!kind) continue
      addModel({ kind, key, label: labels.find(value => value !== key) || labels[0] || key, labels: labels.length ? labels : [key], durations: kind === 'video' ? parameters.durations : [], defaultDuration: kind === 'video' ? parameters.defaultDuration : undefined, ratios: parameters.ratios, resolutions: kind === 'video' ? parameters.resolutions : [] })
    }
  }
  const walk = (node, hint, depth) => {
    if (!node || depth > 24) return
    if (Array.isArray(node)) {
      const selectors = selectorList(node)
      if (selectors) absorb(selectors, hint)
      else node.forEach(item => walk(item, hint, depth + 1))
      return
    }
    if (typeof node !== 'object') return
    const modelKey = clean(node.modelKey || node.model_key || node.model, 80)
    const nested = selectorList(node.selectors) || selectorList(node.selector_list)
    if (modelKey && modelPattern.test(modelKey) && nested) {
      const parameters = parametersOf(nested)
      const kind = kindOf(modelKey, hint || (parameters.durations.length || parameters.resolutions.length ? 'video' : parameters.ratios.length ? 'image' : undefined))
      if (kind) addModel({ kind, key: modelKey, label: modelKey, labels: [modelKey], durations: kind === 'video' ? parameters.durations : [], defaultDuration: kind === 'video' ? parameters.defaultDuration : undefined, ratios: parameters.ratios, resolutions: kind === 'video' ? parameters.resolutions : [] })
    } else if (nested) absorb(nested, hint)
    if (node.model_capability && typeof node.model_capability === 'object' && !Array.isArray(node.model_capability)) {
      for (const [key, value] of Object.entries(node.model_capability)) {
        const parameters: Record<string, any> = value && typeof value === 'object' ? value as Record<string, any> : {}
        const kind = kindOf(`${key} ${JSON.stringify(parameters)}`, hint || (parameters.supported_durations || parameters.supported_resolutions ? 'video' : undefined))
        if (kind) addModel({
          kind, key, label: key, labels: [key],
          durations: kind === 'video' ? [...new Set((Array.isArray(parameters.supported_durations) ? parameters.supported_durations : []).map(Number).filter(value => Number.isInteger(value) && value > 0 && value <= 120))] : [],
          ratios: [...new Set((Array.isArray(parameters.supported_ratios) ? parameters.supported_ratios : []).map(value => clean(value, 16)).filter(value => ratioPattern.test(value)))],
          resolutions: kind === 'video' ? [...new Set((Array.isArray(parameters.supported_resolutions) ? parameters.supported_resolutions : []).map(value => clean(value, 16).toLowerCase()).filter(value => resolutionPattern.test(value)))] : [],
        })
      }
    }
    if (node.item_list && typeof node.item_list === 'object' && !Array.isArray(node.item_list)) {
      for (const [id, value] of Object.entries(node.item_list)) walk(value, itemKinds[id] || hint, depth + 1)
      for (const [key, value] of Object.entries(node)) if (key !== 'item_list' && key !== 'selectors' && key !== 'selector_list') walk(value, hint, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'selectors' || key === 'selector_list') && nested) continue
      walk(value, hint, depth + 1)
    }
  }
  walk(unwrap(input, 0), undefined, 0)
  return models.slice(0, 40)
}

export function acceptLiveMenu(value: unknown): LiveMenuModel[] {
  if (!Array.isArray(value)) return []
  const models: LiveMenuModel[] = []
  for (const item of value.slice(0, 80) as any[]) {
    if (!item || (item.kind !== 'image' && item.kind !== 'video') || typeof item.key !== 'string' || !MODEL_KEY.test(item.key)) continue
    const labels = [...new Set((Array.isArray(item.labels) ? item.labels : []).map((label: unknown) => textOf(label)).filter(Boolean))].slice(0, 6)
    const label = textOf(item.label) || labels[0] || item.key
    const durations = [...new Set<number>((Array.isArray(item.durations) ? item.durations : []).filter((duration: unknown) => Number.isInteger(duration) && Number(duration) > 0 && Number(duration) <= 120))].sort((left, right) => left - right).slice(0, 60)
    const defaultDuration = Number(item.defaultDuration)
    models.push({
      kind: item.kind, key: item.key, label, labels: labels.length ? labels : [label],
      durations,
      ...(Number.isInteger(defaultDuration) && durations.includes(defaultDuration) ? { defaultDuration } : {}),
      ratios: [...new Set<string>((Array.isArray(item.ratios) ? item.ratios : []).map((ratio: unknown) => textOf(ratio, 16)).filter(ratio => RATIO.test(ratio)))].slice(0, 24),
      resolutions: [...new Set<string>((Array.isArray(item.resolutions) ? item.resolutions : []).map((resolution: unknown) => textOf(resolution, 16).toLowerCase()).filter(resolution => RESOLUTION.test(resolution)))].slice(0, 8),
    })
  }
  const merged: LiveMenuModel[] = []
  for (const model of models) {
    const existing = merged.find(item => item.kind === model.kind && item.key === model.key)
    if (!existing) { merged.push(model); continue }
    if (model.durations.length > existing.durations.length) existing.durations = model.durations
    if (model.defaultDuration && existing.durations.includes(model.defaultDuration)) existing.defaultDuration = model.defaultDuration
    if (existing.defaultDuration && !existing.durations.includes(existing.defaultDuration)) delete existing.defaultDuration
    if (model.ratios.length > existing.ratios.length) existing.ratios = model.ratios
    if (model.resolutions.length > existing.resolutions.length) existing.resolutions = model.resolutions
    if (model.label !== model.key && (existing.label === existing.key || model.label.length > existing.label.length)) existing.label = model.label
    existing.labels = [...new Set([...existing.labels, ...model.labels])].slice(0, 6)
  }
  return merged.slice(0, 40)
}

export async function platformCreationMenu(platform, allowClick = false) {
  const parse = globalThis.__miaoParseLiveCreationMenu
  if ((platform !== 'doubao' && platform !== 'dola') || typeof parse !== 'function') return { ok: false, models: [] }
  const origin = platform === 'dola' ? 'https://www.dola.com' : 'https://www.doubao.com'
  if (location.origin !== origin || !/^\/chat(?:\/|$)/.test(location.pathname)) return { ok: false, models: [] }
  const capture = globalThis.__miaoCreationMenuCapture ||= { texts: [], at: 0 }
  if (!globalThis.__miaoCreationMenuHook) {
    globalThis.__miaoCreationMenuHook = true
    const remember = (url, text) => {
      if (!String(url).includes('/alice/slot/action_bar_v3/get_item_conf') || typeof text !== 'string' || !text || text.length > 1_500_000) return
      capture.texts = [...capture.texts, text].slice(-4)
      capture.at = Date.now()
    }
    const originalFetch = window.fetch
    window.fetch = function (input) {
      const pending = originalFetch.apply(this, arguments)
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : ''
      pending.then(response => response.clone().text().then(text => remember(url, text)).catch(() => {})).catch(() => {})
      return pending
    }
    const open = XMLHttpRequest.prototype.open
    const send = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function (_method, url) { this.__miaoUrl = String(url || ''); return open.apply(this, arguments) }
    XMLHttpRequest.prototype.send = function () {
      this.addEventListener('load', () => { try { remember(this.__miaoUrl, this.responseText) } catch { /* ignore unreadable responses */ } })
      return send.apply(this, arguments)
    }
  }
  // Only retain the action-bar creation configuration. Broader video config
  // caches also contain a generic 720p capability table that can be stale or
  // account-independent; merging it would advertise an option the page did
  // not expose for this signed-in account.
  const interesting = value => typeof value === 'string' && value.length > 20 && value.length < 1_500_000 && /option_key|modelKey|bot_id|botId|selector_list|instruction_item_list|actionBarItemId|valueKey/.test(value)
  const texts = []
  try {
    for (const store of [localStorage, sessionStorage]) {
      for (let index = 0; index < store.length && texts.length < 40; index += 1) {
        const value = store.getItem(store.key(index) || '') || ''
        if (interesting(value)) texts.push(value)
      }
    }
  } catch { /* storage can be blocked; the page request remains the source */ }
  if (indexedDB.databases) {
    try {
      const databases = (await indexedDB.databases()).filter(item => item?.name).slice(0, 6)
      for (const info of databases) {
        const database = await new Promise<IDBDatabase | undefined>(resolve => {
          const request = indexedDB.open(info.name)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => resolve(undefined)
        })
        if (!database) continue
        try {
          for (const name of [...database.objectStoreNames].slice(0, 8)) {
            const rows = await new Promise<unknown[]>(resolve => {
              try {
                const request = database.transaction(name, 'readonly').objectStore(name).getAll()
                request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result.slice(0, 30) : [])
                request.onerror = () => resolve([])
              } catch { resolve([]) }
            })
            for (const row of rows) {
              const text = typeof row === 'string' ? row : JSON.stringify(row)
              if (interesting(text)) texts.push(text)
              if (texts.length >= 60) break
            }
          }
        } finally { database.close() }
        if (texts.length >= 60) break
      }
    } catch { /* an unavailable database does not invent a menu */ }
  }
  const itemKinds = {}
  const rememberSkill = (id, skill) => {
    if (/^\d{8,24}$/.test(String(id)) && (skill === 'video_generation' || skill === 'image_generation')) itemKinds[String(id)] = skill === 'video_generation' ? 'video' : 'image'
  }
  const visit = node => {
    if (!node || typeof node !== 'object') return
    rememberSkill(node.itemId || node.item_id, node.skillKey || node.skill_key || node.configKey)
    for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
  }
  let botId = '', version = ''
  for (const text of texts) {
    try { visit(JSON.parse(text)) } catch { /* raw storage is scanned below */ }
    for (const match of text.matchAll(/itemId\\?"?\s*[:=]\s*"?(\d{8,24})[\s\S]{0,800}?skillKey\\?"?\s*[:=]\s*"?(video_generation|image_generation)/g)) rememberSkill(match[1], match[2])
    for (const match of text.matchAll(/skillKey\\?"?\s*[:=]\s*"?(video_generation|image_generation)[\s\S]{0,800}?itemId\\?"?\s*[:=]\s*"?(\d{8,24})/g)) rememberSkill(match[2], match[1])
    botId ||= (text.match(/"(?:bot_id|botId)"\s*:\s*"(\d{8,24})"/) || [])[1] || ''
    version ||= (text.match(/"instruction_code_version"\s*:\s*"?(\d{1,12})"?/) || [])[1] || ''
  }
  const modelsFrom = values => values.flatMap(text => { try { return parse(JSON.parse(text), itemKinds) } catch { return [] } })
  let models = modelsFrom([...capture.texts, ...texts])
  if (!models.length && botId && Object.keys(itemKinds).length) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
      const body = { language_code: (document.documentElement.lang || navigator.language || 'zh').slice(0, 16), bot_id: botId, item_ids: Object.keys(itemKinds), ...(version ? { instruction_code_version: version } : {}) }
      const response = await fetch('/alice/slot/action_bar_v3/get_item_conf', { method: 'POST', credentials: 'include', redirect: 'error', headers: { 'content-type': 'application/json', 'agw-js-conv': 'str' }, body: JSON.stringify(body), signal: controller.signal })
      if (response.status === 200) {
        const data = await response.json()
        if (data?.code === 0 || data?.code === '0') models = parse(data, itemKinds)
      } else await response.body?.cancel()
    } catch { /* an unsigned request must not be replaced with a guessed menu */ }
    finally { clearTimeout(timer) }
  }
  if (!models.length && allowClick) {
    const click = kind => {
      const button = document.querySelector(`[data-testid="skill_bar_button_${kind}"]`)
      if (button instanceof HTMLElement) { button.click(); return }
      if (kind === 0) return
      const names = kind === 17 ? ['视频生成', '生成视频', 'Create Videos', 'Create videos', '動画を作成'] : ['图像生成', '图片生成', 'Create Images', 'Create images', '画像を作成']
      const labeled = [...document.querySelectorAll('button,[role="button"]')].filter(element => {
        const name = (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim()
        return names.some(expected => name === expected || name.includes(expected) && name.length < 12)
      })
      if (labeled.length === 1) (labeled[0] as HTMLElement).click()
    }
    const waitFor = async since => {
      const deadline = Date.now() + 4_000
      while (Date.now() < deadline && capture.at < since) await new Promise(resolve => setTimeout(resolve, 200))
    }
    for (const kind of [17, 3]) {
      const since = Date.now()
      click(kind)
      await waitFor(since)
    }
    click(0)
    models = modelsFrom(capture.texts)
  }
  return { ok: models.length > 0, models }
}

export function creationMenuSource(platform: 'doubao' | 'dola', allowClick: boolean) {
  return `globalThis.__miaoParseLiveCreationMenu=${parseLiveCreationMenu.toString()};(${platformCreationMenu.toString()})(${JSON.stringify(platform)},${allowClick ? 'true' : 'false'})`
}
