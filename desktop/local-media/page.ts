// Both platforms use the same input-engine family. Platform-specific names
// and exact model aliases enter through the host, never through page state.
// Everything below executes in the sandboxed platform page, with no Node or
// workspace access. DOM observations never inspect cookies or React stores.
export function localMediaPage(action: string, payload: Record<string, any> = {}): any {
  const platform = payload.platform === 'dola' ? 'Dola' : '豆包'
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const elements = (selector: string, root: ParentNode = document) => Array.from(root.querySelectorAll(selector)).filter(visible) as HTMLElement[]
  const normalize = (value: string) => value.replace(/\u200b|\ufeff/g, '').replace(/\r\n/g, '\n').trim()
  const promptKey = (value: string) => normalize(value).replace(/\s+(?=[，。！？；：、“”‘’…（）【】《》])/g, '')
  const text = (element?: Element) => normalize((element as HTMLElement)?.innerText || '')
  const label = (element: Element) => (element.getAttribute('aria-label') || element.getAttribute('title') || text(element)).replace(/\s+/g, ' ').trim()
  const enabled = (element: Element) => !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true' && element.getAttribute('data-disabled') !== 'true'
  const isSearch = (element: Element) => element.getAttribute('type') === 'search' || !!element.closest('[role="search"],header') || /搜索|search/i.test(element.getAttribute('aria-label') || element.getAttribute('placeholder') || '')
  const composerOf = (element: HTMLElement) => {
    const surface = element.closest<HTMLElement>('.guidance-input-surface')
    if (surface) return surface
    for (let parent = element.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth++) {
      if (parent === document.body) break
      if (parent.querySelector('#flow-end-msg-send,[data-input-engine-actionbar-control-key]')) return parent
    }
  }
  const candidates = elements('textarea,[contenteditable="true"]').filter(element => !element.closest('[role="dialog"],nav,aside') && !isSearch(element))
  const input = (candidates.find(element => composerOf(element)) || (candidates.length === 1 ? candidates[0] : undefined)) as HTMLElement | HTMLTextAreaElement | undefined
  const value = () => input instanceof HTMLTextAreaElement ? input.value : input?.innerText || ''
  const composer = input ? composerOf(input) : undefined
  const buttons = (root: ParentNode = document) => elements('button,[role="button"]', root)
  const messageSelector = '[data-message-id],[data-message-role],[data-role="user"],[data-role="assistant"],[class*="message-item"],[class*="messageItem"],[class*="inner-item"]'
  const controls = () => buttons().filter(element => !element.closest(messageSelector))
  const point = (element?: HTMLElement) => {
    if (!element || !visible(element) || !enabled(element)) return null
    const box = element.getBoundingClientRect()
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
    const hit = document.elementFromPoint(x, y)
    return hit && (element.contains(hit) || hit === element) ? { x, y } : null
  }
  const unique = (values: HTMLElement[]) => values.length === 1 ? values[0] : undefined
  const send = () => {
    const exact = elements('#flow-end-msg-send,[data-testid="chat_input_send_button"]')
    if (exact.length === 1) return exact[0]
    return composer ? unique(buttons(composer).filter(element => /^(发送|发送消息|Send|Send message)$/i.test(label(element)))) : undefined
  }
  const modelControl = () => {
    const exact = elements('[data-input-engine-actionbar-control-key="video-model"],[data-input-engine-actionbar-control-key="image-model"],[data-input-engine-actionbar-control-key="model"],[data-testid="chat_input_action_model"]')
    if (exact.length === 1) return exact[0]
    return composer ? unique(buttons(composer).filter(element => /^(?:(?:模型|Model|モデル)\s*)?(?:(?:Dreamina\s+)?Seedance|Seedream)\b|^(?:豆包\s+(?:快速|专家)|Fast|Pro)$/.test(label(element)))) : undefined
  }
  const cleanModel = (value: string) => value.replace(/^(?:模型|Model|モデル)\s*/i, '').replace(/\s+/g, ' ').trim()
  const model = () => cleanModel(label(modelControl() || document.createElement('span')))
  const modelLabels = () => (Array.isArray(payload.labels) ? payload.labels : [payload.label]).filter(value => typeof value === 'string').map(cleanModel)
  const modelMatches = () => modelLabels().includes(model())
  const parameterControl = () => unique(elements('button[data-creation-params-panel-id]'))
  const standaloneParameter = (kind: 'duration' | 'ratio') => {
    const keys = kind === 'duration' ? ['video-duration'] : ['video-ratio', 'image_creation_ratio']
    const exact = elements(keys.map(key => `[data-input-engine-actionbar-control-key="${key}"]`).join(','))
    if (exact.length === 1) return exact[0]
    return unique((composer ? buttons(composer) : controls()).filter(element => !element.closest('nav,aside') && (kind === 'duration'
      ? /^(?:Duration\s*)?\d+\s*s$/i.test(text(element))
      : /^(比率|比例|Ratio|Aspect ratio|アスペクト比)$/i.test(label(element)) || /^(?:Auto|自动|自動|\d+:\d+)(?:\s|$)/.test(text(element)))))
  }
  const parameters = () => {
    if (platform === 'Dola') {
      const summary = text(parameterControl()).match(/^(自动|Auto|[0-9]+:[0-9]+)\s*·\s*([0-9]+)s$/i)
      if (summary) return { ratio: /^(Auto|自动)$/i.test(summary[1]) ? 'auto' : summary[1], duration: Number(summary[2]) }
      const imageSummary = text(parameterControl()).match(/^比例\s*(自动|Auto|自動|[0-9]+:[0-9]+)$/i)
      if (imageSummary) return { ratio: /^(Auto|自动|自動)$/i.test(imageSummary[1]) ? 'auto' : imageSummary[1] }
      const duration = text(standaloneParameter('duration')).match(/(\d+)\s*s$/i)
      const ratio = text(standaloneParameter('ratio')).match(/\d+:\d+|Auto|自动|自動/i)?.[0]
      return { duration: duration ? Number(duration[1]) : undefined, ratio: ratio && /^(Auto|自动|自動)$/i.test(ratio) ? 'auto' : ratio }
    }
    const match = label(parameterControl() || document.createElement('span')).match(/^(自动|Auto|[0-9]+:[0-9]+)\s*·\s*([0-9]+)s(?:\s*·\s*(720P|1080P))?$/i)
    // The native panel omits its default 720p from the summary.
    if (match) return { ratio: /^(自动|Auto)$/i.test(match[1]) ? 'auto' : match[1], duration: Number(match[2]), resolution: match[3]?.toLowerCase() || '720p' }
    const imageRatioControl = elements('[data-input-engine-actionbar-control-key="image_creation_ratio"]')
    if (imageRatioControl.length === 1) {
      const ratio = text(imageRatioControl[0]).match(/\d+:\d+|Auto|自动|自動/i)?.[0]
      if (ratio) return { ratio: /^(Auto|自动|自動)$/i.test(ratio) ? 'auto' : ratio }
    }
    if (parameterControl()) return undefined
    const ratio = text(standaloneParameter('ratio')).match(/\d+:\d+|Auto|自动|自動/i)?.[0]
    return ratio ? { ratio: /^(Auto|自动|自動)$/i.test(ratio) ? 'auto' : ratio } : undefined
  }
  // Older Dola ratio buttons keep only their caption after selection. In that
  // case the mandatory outgoing-request check is the authoritative readback.
  const parametersMatch = () => (payload.duration === undefined || parameters()?.duration === payload.duration)
    && (!payload.ratio || platform === 'Dola' && (payload.ratio === 'auto' || !parameters()?.ratio) || parameters()?.ratio === payload.ratio)
    && (!payload.resolution || parameters()?.resolution === payload.resolution)
  const kind = () => {
    const hint = [input?.getAttribute('placeholder'), input?.getAttribute('data-placeholder'), input?.getAttribute('aria-label'), composer ? text(composer) : '', model()].filter(Boolean).join(' ')
    if (/Seedance|描述你想要的视频|describe.{0,30}video|動画/i.test(hint)) return 'video'
    if (/Seedream|描述你想要的(?:图像|图片)|describe.{0,30}image|画像/i.test(hint)) return 'image'
    // Media modes are identifiable by their explicit placeholders or model
    // families. Any other composer is the ordinary chat mode, including new
    // account-specific text model names that are not in the built-in fallback.
    return input ? 'text' : ''
  }
  // Dola can localize a media composer without exposing a stable model label.
  // An unknown presentation is allowed only for media: the host must still
  // verify its actual ability_type before allowing the request to leave.
  const kindMatches = () => kind() === payload.kind || platform === 'Dola' && ['image', 'video'].includes(payload.kind) && !kind()
  const dialogs = elements('[role="dialog"],[aria-modal="true"]').filter(element => !element.contains(input || document.body))
  const dialog = dialogs.map(text).join('\n')
  const promotion = /下载电脑版|download.{0,20}(desktop|app)/i.test(dialog) && !/验证码|扫码|手机号|支付|会员|password|payment/i.test(dialog)
  const login = controls().some(element => /^(登录|立即登录|手机号登录|扫码登录|Log in|Sign in|Login)$/i.test(label(element)))
  const challenge = elements('[data-testid*="captcha"],[class*="captcha"],iframe[title*="captcha"],[class*="verification"]').filter(element => !element.closest(messageSelector)).length > 0 || /人机验证|拖动滑块|完成安全验证|verify you are human|security verification/i.test(dialog)
  const conversation = /^\/chat\/\d{8,}\/?$/.test(location.pathname)
  if (action === 'snapshot') return {
    url: location.href, hasEditor: !!input, kind: kind(), model: model(), login, challenge,
    canSend: !!point(send()), regionBlocked: /doubao-region-ban|region-restricted/.test(location.pathname),
    networkError: document.documentURI.startsWith('chrome-error:'), dialog: promotion ? '' : dialog.slice(0, 500), name: '',
    quotaTexts: elements('[data-testid*="quota"],[data-testid*="credit"],[class*="quota"],[class*="benefit"],[class*="remaining"],[class*="credit"]').filter(element => !element.closest(messageSelector) && !element.querySelector(messageSelector)).map(text).filter(value => value.length < 180 && /剩余|还可|可用|remaining|available/i.test(value)),
    controls: controls().map(label).filter(value => value.length < 60),
  }
  if (action === 'login') return point(unique(controls().filter(element => /^(登录|立即登录|Log in|Sign in)$/i.test(label(element)))))
  if (action === 'dismissPromotion') return promotion ? point(unique(buttons().filter(element => /^(下次再说|下次提醒我|暂不下载|Not now|Maybe later)$/i.test(label(element))))) : null
  if (login || challenge || dialog && !promotion) throw new Error(`${platform}页面需要人工处理，请打开${platform}窗口`)
  if (action === 'capability') {
    if (kind() === payload.kind) return { selected: true }
    const exact = elements(`[data-testid="skill_bar_button_${payload.kind === 'video' ? 17 : payload.kind === 'image' ? 3 : 0}"]`)
    if (exact.length === 1) return point(exact[0])
    const names = payload.kind === 'video' ? ['视频生成', '生成视频', 'Create Videos', 'Create videos', '動画を作成'] : payload.kind === 'image' ? ['图像生成', '图片生成', 'Create Images', 'Create images', '画像を作成'] : ['对话', 'Chat', 'Chat with Dola']
    return point(unique((composer ? buttons(composer) : controls()).filter(element => names.includes(label(element)))))
  }
  if (action === 'modelMatches') return modelMatches()
  if (action === 'modelOpen') return model() === cleanModel(String(payload.label)) ? { selected: true } : point(modelControl())
  if (action === 'modelOptions') return elements('[role="menuitem"],[role="option"]').map(label)
  if (action === 'modelSelect') {
    const options = elements('[role="menuitem"],[role="option"]')
    for (const expected of modelLabels()) {
      const matches = options.filter(element => {
        const name = cleanModel(label(element))
        return name === expected || name.startsWith(expected + ' ') && !/^\s*(Fast|Mini)\b/.test(name.slice(expected.length))
      })
      if (matches.length) return point(unique(matches))
    }
    return null
  }
  if (action === 'parameters') return parameters()
  if (action === 'parametersOpen') return parameterControl()?.getAttribute('data-state') === 'open' ? { selected: true } : point(parameterControl())
  if (action === 'parameterOption') {
    const wanted = String(payload.value || '')
    return point(unique(buttons().filter(element => !element.closest(messageSelector) && label(element) === wanted)))
  }
  if (action === 'parameterRatio') {
    const menu = unique(elements('[role="menu"]'))
    return menu ? point(unique(buttons(menu).filter(element => label(element) === (payload.ratio === 'auto' ? '自动' : payload.ratio)))) : null
  }
  if (action === 'parameterResolution') {
    const menu = unique(elements('[role="menu"]'))
    return menu ? point(unique(buttons(menu).filter(element => label(element).toLowerCase() === payload.resolution))) : null
  }
  if (action === 'durationTarget') {
    const slider = unique(elements('[role="slider"][aria-valuemin="0"]'))
    if (slider && Number(slider.getAttribute('aria-valuemax')) < Number(payload.duration) - 4) throw new Error(`${platform}当前型号未开放所选时长，本次尚未发送`)
    return point(slider)
  }
  if (action === 'dolaDurationOpen') return parameters()?.duration === payload.duration ? { selected: true } : point(standaloneParameter('duration'))
  if (action === 'dolaRatioOpen') return parameters()?.ratio === payload.ratio ? { selected: true } : point(standaloneParameter('ratio'))
  if (action === 'dolaParameterSelect') {
    const wanted = String(payload.value || '')
    const names = wanted === 'auto' ? ['自动', '自動', 'Auto', 'auto'] : [wanted]
    return point(unique(elements('[role="menuitem"],[role="option"]').filter(element => {
      const name = label(element)
      return names.includes(name) || /^\d+:\d+$/.test(wanted) && name.startsWith(wanted + ' ')
    })))
  }
  if (action === 'focus') {
    if (!input) throw new Error(`未找到唯一的${platform}提示词输入框`)
    input.focus()
    if (input instanceof HTMLTextAreaElement) input.select()
    else { const range = document.createRange(); range.selectNodeContents(input); const selection = getSelection(); selection?.removeAllRanges(); selection?.addRange(range) }
    return true
  }
  if (action === 'prepared') return normalize(value()) === normalize(String(payload.prompt)) && kindMatches() && (!payload.label || modelMatches()) && parametersMatch()
  if (action === 'sendTarget') {
    if (conversation || normalize(value()) !== normalize(String(payload.prompt)) || !kindMatches() || payload.label && !modelMatches() || !parametersMatch()) throw new Error(`${platform}页面、模型、参数或提示词已变化，本次尚未发送`)
    const target = point(send())
    if (!target) throw new Error(`未找到可用的${platform}发送按钮，本次尚未发送`)
    return target
  }
  if (action === 'upload') {
    if (!composer) throw new Error(`未找到${platform}素材上传区，本次尚未发送`)
    const inputs = Array.from(composer.querySelectorAll<HTMLInputElement>('input[type="file"]')).filter(element => !element.disabled && (!element.accept || /image|\.png|\.jpe?g/.test(element.accept)))
    const fileInput = inputs.length === 1 ? inputs[0] : undefined
    if (!fileInput) throw new Error(`未找到唯一的${platform}图片上传入口，本次尚未发送`)
    const transfer = new DataTransfer()
    for (const file of payload.files || []) transfer.items.add(new File([Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))], file.name, { type: file.mime }))
    fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }
  if (action === 'uploads') {
    if (!composer) return { count: 0, pending: true }
    const images = elements('img', composer).filter(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)
    const pending = elements('[aria-busy="true"],[data-status="uploading"],[class*="uploading"],[role="progressbar"]', composer).length > 0
    return { count: images.length, pending }
  }
  if (action === 'result' || action === 'cancel' || action === 'activateVideo' || action === 'confirmationTarget') {
    const declaredMessages = elements('[data-message-id],[data-message-role],[data-role="user"],[data-role="assistant"]')
    const candidates = (declaredMessages.length ? declaredMessages : elements('[class*="message-item"],[class*="messageItem"],[class*="inner-item"]'))
      .filter(element => !element.closest('nav,aside,[data-testid="flow_chat_sidebar"],#flow_chat_sidebar,[class*="sidebar"]') && !element.contains(input || document.body))
    const messages = candidates.filter(element => !candidates.some(other => other !== element && other.contains(element)))
    // Doubao keeps a newly-created chat at /chat/ until its SPA history state
    // settles. Treat it as a conversation only when actual message elements
    // already exist; an untouched blank home page remains non-conversational.
    const activeConversation = conversation || location.pathname === '/chat/' && messages.length > 0
    if (!activeConversation) return { url: location.href, turns: 0, userPrompt: '', text: '', replyText: '', items: [], running: false }
    const role = (element: HTMLElement) => {
      const roleElement = element.querySelector('[data-message-role],[data-role="user"],[data-role="assistant"]')
      const declared = element.getAttribute('data-message-role') || element.getAttribute('data-role') || roleElement?.getAttribute('data-message-role') || roleElement?.getAttribute('data-role')
      if (declared === 'user' || declared === 'assistant') return declared
      const descriptor = [element.className, element.getAttribute('data-testid')].join(' ')
      if (/user|human|send-message/i.test(descriptor)) return 'user'
      if (/assistant|bot|receive-message/i.test(descriptor) || element.querySelector('[class*="message-action"],[class*="suggest-message"]')) return 'assistant'
      return ''
    }
    const users = messages.filter(element => role(element) === 'user')
    const userContent = (user: HTMLElement) => user.querySelector('[data-testid="message_text_content"],[class*="message-content"],[class*="messageContent"]') || user
    // Media skills decorate the displayed user turn with their own prefix.
    // Accept only that exact prefix plus this job's full prompt; never strip
    // arbitrary prose or adopt a different message from the conversation.
    const expected = payload.prompt ? normalize(String(payload.prompt)) : ''
    const prefixes = payload.kind === 'image' ? ['生成图片：', 'Create Images:', 'Create images:', 'Create image:', 'Generate image:', '画像を作成：'] : payload.kind === 'video' ? ['生成视频：', 'Create Videos:', 'Create videos:', 'Create video:', 'Generate video:', '動画を作成：'] : []
    const userMatch = (user: HTMLElement) => {
      const raw = text(userContent(user))
      const prefix = prefixes.find(value => raw.startsWith(value))
      const decorated = normalize(prefix ? raw.slice(prefix.length) : raw)
      if (!payload.prompt) return { decorated }
      // Doubao may append confirmation turns and encode the selected output
      // after the prompt. The implicit-auto summary omits the ratio:
      // `<prompt>，6s，720p`; an explicit ratio is also possible.
      const video = payload.kind === 'video' ? decorated.match(/^([\s\S]+?)[，,]\s*(?:(自动|Auto|\d+:\d+)[，,]\s*)?(\d+)s(?:[，,]\s*(\d{3,4}p))?$/i) : null
      const image = payload.kind === 'image' ? decorated.match(/^([\s\S]+?)[，,]\s*(自动|Auto|\d+:\d+)$/i) : null
      const promptPart = video?.[1] || image?.[1] || decorated
      if (promptKey(promptPart) !== promptKey(expected)) return
      const duration = video?.[3]
      const resolution = video?.[4]
      const ratio = video?.[2] || image?.[2]
      if (payload.duration !== undefined && Number(duration) !== payload.duration) return
      if (payload.resolution && resolution?.toLowerCase() !== String(payload.resolution).toLowerCase()) return
      if (payload.ratio && payload.ratio !== 'auto' && ratio !== payload.ratio) return
      return { decorated }
    }
    const matchedUsers = users.filter(user => !!userMatch(user))
    // A generation can be split into several user turns by the platform's
    // parameter confirmation. Bind the unique original prompt, then inspect
    // every assistant reply after it, including the eventual video message.
    const user = matchedUsers.length === 1 ? matchedUsers[0] : undefined
    const matches = !payload.prompt || !!user
    const userPrompt = matches ? payload.prompt ? expected : text(userContent(user!)) : ''
    const userIndex = user ? messages.indexOf(user) : -1
    const replies = userIndex >= 0 ? messages.filter((element, index) => role(element) === 'assistant' && index > userIndex) : []
    const reply = replies.at(-1)
    const videoCards = replies.map(item => unique(elements('[class*="block-video-"]', item))).filter(Boolean) as HTMLElement[]
    const videoCard = videoCards.at(-1)
    const laterUsers = users.map(element => messages.indexOf(element)).filter(index => index > userIndex)
    const nextUserIndex = laterUsers.length ? Math.min(...laterUsers) : messages.length
    const pendingReplies = userIndex >= 0
      ? messages.filter((element, index) => role(element) === 'assistant' && index > userIndex && index < nextUserIndex)
      : []
    const confirmationText = pendingReplies.map(item => text(item)).join('\n')
    const confirmedModel = cleanModel(confirmationText.match(/(?:模型|Model)[：:]\s*([^\n]+)/i)?.[1] || '')
    const confirmedDuration = Number(confirmationText.match(/(?:时长|Duration)[：:]\s*(\d+)\s*秒?/i)?.[1])
    const confirmedRatio = confirmationText.match(/(?:比例|Ratio)[：:]\s*(自动|Auto|\d+:\d+)/i)?.[1]
    const confirmationRequested = /(?:视频|图片)生成参数确认|请.{0,8}确认参数|please confirm.{0,20}(?:parameters|settings)/i.test(confirmationText)
    const confirmationReady = matches && confirmationRequested
      && (!modelLabels().length || modelLabels().includes(confirmedModel))
      && (payload.duration === undefined || confirmedDuration === payload.duration)
      && (!payload.ratio || payload.ratio === 'auto' || confirmedRatio === payload.ratio)
    if (action === 'confirmationTarget') return confirmationReady && normalize(value()) === '确定' ? point(send()) : null
    if (action === 'cancel') return matches ? point(unique(controls().filter(element => /^(停止生成|停止回答|停止|Stop generating|Stop)$/.test(label(element))))) : null
    if (action === 'activateVideo') {
      if (!matches || !videoCard || videoCard.querySelector('video')) return null
      const play = videoCard
      return point(play)
    }
    const items: any[] = []
    if (matches) {
      const taskReplies = replies as HTMLElement[]
      for (const image of taskReplies.flatMap(item => Array.from(item.querySelectorAll('img')))) {
        const url = image.currentSrc || image.src
        if (image.getAttribute('aria-hidden') !== 'true' && /^https:\/\//.test(url) && image.complete && image.naturalWidth >= 512 && image.naturalHeight >= 256 && !items.some(item => item.url === url)) items.push({ kind: 'image', url })
      }
      for (const video of taskReplies.flatMap(item => Array.from(item.querySelectorAll('video')))) {
        const source = video.currentSrc || video.src || video.querySelector('source')?.src
        if (source && !items.some(item => item.url === source)) items.push({ kind: 'video', url: source })
      }
    }
    const content = (reply?.querySelector('[data-testid="message_text_content"],[class*="markdown"]') || reply)?.cloneNode(true) as HTMLElement | undefined
    content?.querySelectorAll('button,time,[class*="message-action"],[class*="suggest-message"]').forEach(element => element.remove())
    content?.querySelectorAll('br').forEach(element => element.replaceWith('\n'))
    content?.querySelectorAll('p,li,pre,h1,h2,h3,h4,blockquote').forEach(element => element.append('\n'))
    const responseText = normalize(content?.textContent || '')
    const replyText = replies.map(item => text(item)).join('\n').slice(-2400)
    const running = controls().some(element => /^(停止生成|停止回答|停止|Stop generating|Stop)$/.test(label(element))) || !!reply && elements('[role="progressbar"],[class*="loading-spinner"],[class*="generating"]', reply).length > 0
    const complete = !!reply && elements('[class*="message-action"],[class*="messageAction"],[data-testid*="message_action"]', reply).length > 0 && !running
    const replyId = reply?.getAttribute('data-message-id') || reply?.querySelector('[data-message-id]')?.getAttribute('data-message-id') || ''
    return { url: location.href, turns: messages.length, userPrompt, text: matches ? responseText : '', replyText, replyId, items, running, complete, hasVideoCard: matches && !!videoCard, confirmationReady,
      failed: /生成失败|无法生成|未能生成|不符合.*规范|unable to generate|generation failed|couldn.t generate/i.test(replyText), needsConfirmation: /请.{0,8}确认|是否确认|确认后.{0,8}(开始|生成)|please confirm|confirm.{0,30}generat/i.test(replyText) }
  }
  throw new Error(`未知${platform}页面操作`)
}
