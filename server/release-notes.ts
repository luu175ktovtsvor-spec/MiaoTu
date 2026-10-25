export type ReleaseNoteItem = { zh: string; en: string }

export type ReleaseNotes = {
  title: { zh: string; en: string }
  fixes: ReleaseNoteItem[]
  improvements: ReleaseNoteItem[]
  knownIssues: ReleaseNoteItem[]
}

// 更新说明直接写软件修好了什么：哪一个界面、哪一项操作，以前错在哪里，现在怎样。
// 不写「上游」「部分问题」「体验优化」这类看不出具体改动的话。
export const RELEASE_NOTES: Record<string, ReleaseNotes> = {
  '3.1.8': {
    title: { zh: '视频精选补齐提示词与译文', en: 'Complete prompts and translations for selected films' },
    fixes: [
      { zh: '视频精选补齐原始提示词和中文译文，详情页可切换原文与译文；复制及带入画布继续使用原文。', en: 'Selected films now include complete original prompts and Chinese translations, with a switch in the detail view. Copying and using a prompt on the canvas keeps the original text.' },
      { zh: '切换作品时同步切换提示词，译文读取失败可单独重试。', en: 'Prompts follow the selected film immediately, and failed translations can be retried separately.' },
    ],
    improvements: [
      { zh: '移出 9 条带水印或外部标记的作品，补入 36 条合格遗漏作品，精选共 682 条；新增视频支持分段自适应播放。', en: 'Removed 9 films with watermarks or external marks and added 36 eligible missing films, bringing the selection to 682. New films support adaptive playback.' },
    ],
    knownIssues: [],
  },
  '3.1.7': {
    title: { zh: '豆包与 Dola 的模型参数提前显示', en: 'Doubao and Dola model parameters appear immediately' },
    fixes: [
      { zh: '已连接豆包或 Dola 后，图片与视频节点会先显示已核对的时长、比例和清晰度，避免菜单加载期间参数空白；账号菜单返回后自动更新为实际可选值。', en: 'Connected Doubao and Dola image and video nodes show verified duration, ratio and quality presets while the account menu loads, then update to the choices available to that account.' },
      { zh: 'Dola 视频预置修正为 4–10 秒，图片与视频补齐自动比例；没有独立清晰度或尺寸选项的模型会明确显示跟随平台。', en: 'Dola video presets now offer 4–10 seconds, and image and video ratios include Auto. Models without separate quality or size controls clearly follow the platform.' },
    ],
    improvements: [
      { zh: '账号设置会区分“预置参数”和“当前账号菜单”，方便确认参数来源。', en: 'Account settings distinguish preset parameters from the current account menu.' },
    ],
    knownIssues: [
      { zh: '参数预置不代表账号已获得生成权限；发送前仍需登录并读取当前账号菜单。', en: 'Presets do not grant generation access; sending still requires signing in and loading the current account menu.' },
    ],
  },
  '3.1.6': {
    title: { zh: 'Dola 图片生成可以直接返回画布', en: 'Dola image generation returns directly to the canvas' },
    fixes: [
      { zh: 'Dola 当前版本的比例、时长滑动条和提示词格式已经重新适配；图片生成完成后会直接保存原图并写回节点，不再停在待确认。', en: 'MiaoImg now follows Dola’s current ratio controls, duration slider and prompt format. Completed images are saved as originals and written back to the node instead of remaining unconfirmed.' },
      { zh: 'Dola 不再因为旧版去水印设置接口不存在而阻止发送；平台没有返回可核对的水印选项时，妙图会按实际下载文件保存并如实标明状态。', en: 'Dola is no longer blocked when its older no-watermark settings endpoint is unavailable. If the platform does not expose a verifiable option, MiaoImg saves the returned file and states the actual status.' },
    ],
    improvements: [
      { zh: 'Dola 路由回执使用账号当前真实能力编号和模型标识核对，图片、视频不会因为写死旧编号而被误拦。', en: 'Dola routing receipts now use the account’s current ability type and model key, so image and video requests are not rejected by an outdated hard-coded ability number.' },
    ],
    knownIssues: [
      { zh: 'Dola 视频是否可用仍取决于账号权益和平台状态。本次账号生成图片成功；视频请求由 Dola 返回“视频生成失败、额度未扣除”，妙图会显示失败，不会重新下单。', en: 'Dola video availability still depends on account entitlements and platform status. Image generation succeeded in testing; Dola returned “video generation failed, quota not deducted” for video, and MiaoImg reports the failure without resubmitting.' },
    ],
  },
  '3.1.5': {
    title: { zh: '豆包生成可以直接完成并取回', en: 'Doubao generation completes and returns automatically' },
    fixes: [
      { zh: '豆包生成视频时，妙图会按原提示词、模型、时长和比例继续核对多轮消息；平台需要参数确认时会自动完成确认，不需要用户再打开豆包点「确定」。生成完成后即使没有去水下载地址，也会保存平台播放器原片，不会一直卡在「提交结果待确认」。', en: 'For Doubao video generation, MiaoImg now follows the original prompt, model, duration and ratio across confirmation turns and completes a matching parameter confirmation automatically. After generation, a completed platform player result is preserved even without a no-watermark download URL, so the task no longer remains stuck on submission confirmation.' },
      { zh: '豆包与 Dola 的设置页会列出当前账号实际开放的图片、视频和文本模型，显示节点模型 ID、平台模型 ID、比例、时长与分辨率。', en: 'The Doubao and Dola settings now list the image, video and text models actually available to the connected account, including the node model ID, platform model ID, ratios, durations and resolutions.' },
      { zh: '豆包和 Dola 支持添加多个独立网页账号，可以为每个账号单独重命名、切换、登录和清除登录状态；新任务会固定记下提交时使用的账号，切换默认账号不会改写原任务归属。', en: 'Doubao and Dola now support multiple isolated web accounts with separate names, switching, sign-in and sign-out. New tasks record the account used at submission, and changing the active account does not move existing tasks to another account.' },
    ],
    improvements: [
      { zh: '豆包视频的比例、时长和清晰度仍按平台当前菜单发送；能读到平台请求回执时会继续核对，读不到时也会保留任务并明确记录未核验状态。', en: 'Doubao video ratio, duration and resolution still follow the current platform menu; MiaoImg verifies the platform request when a receipt is available and keeps the task with an explicit unverified state when it is not.' },
    ],
    knownIssues: [],
  },
  '3.1.4': {
    title: { zh: '豆包和 Dola 选中后文字清晰可读', en: 'Doubao and Dola labels stay readable when selected' },
    fixes: [
      { zh: '修复设置里选中 Dola 后白色胶囊配白色文字的问题，现在选中和未选中状态都能清楚看见。', en: 'Fixed the selected Dola pill using white text on a white background; both selected and unselected states are now readable.' },
    ],
    improvements: [],
    knownIssues: [],
  },
  '3.1.3': {
    title: { zh: '项目删除遇到残缺文件时也能正常完成', en: 'Project deletion now completes even when old files are missing' },
    fixes: [
      { zh: '项目索引里还记着、但电脑上已经不存在的旧文件，不会再让「最近项目」删除失败；现有文件照常移到废纸篓，残缺记录会一起清掉。', en: 'Old files missing from the computer no longer make Recent Projects deletion fail; existing files still go to Trash and stale records are cleared.' },
    ],
    improvements: [
      { zh: '视频模型的时长和清晰度选项按各自实际支持的范围显示：MiniMax H3 的 480p、768P 和 1080p 最长 30 秒，2K 最长 15 秒；其他模型也分别显示自己的可用范围。', en: 'Video duration and resolution choices now follow each model’s actual capabilities: MiniMax H3 supports up to 30 seconds at 480p, 768P and 1080p, and up to 15 seconds at 2K; other models show their own supported ranges too.' },
    ],
    knownIssues: [],
  },
  '3.1.2': {
    title: { zh: '豆包和 Dola 的设置标签分开显示', en: 'Doubao and Dola settings now use separate labels' },
    fixes: [],
    improvements: [
      { zh: '「豆包与 Dola」的平台切换改成两个有间距的独立圆角标签，选中状态清楚，不再连成一片。', en: 'The Doubao and Dola selector now uses two separate rounded pills with clear spacing, so the selected state is easy to see.' },
    ],
    knownIssues: [],
  },
  '3.1.1': {
    title: { zh: '客户端换上官网的配色与控件、登录输入更简洁、所有项目都能删除', en: 'Client styling now matches the website, cleaner sign-in fields and every project can be deleted' },
    fixes: [
      { zh: '账号和密码登录输入区不再有外框，只留底部细线；输入时细线亮起一道蓝光。', en: 'Email and password fields no longer have a frame, only an underline that lights up in blue while typing.' },
      { zh: '画布文件和删除到废纸篓的副本只写妙图自己的格式标记，不再带旧的兼容字段；旧画布照常打开，之后保存或删除时会自动清理。', en: 'Canvas files and copies sent to the Trash carry only the MiaoImg format marker; older canvases still open and drop the old field when saved or deleted.' },
      { zh: '「最近项目」和「全部项目」里的每个项目都能删除，默认项目也不再例外；项目内容会先放进电脑废纸篓。', en: 'Every project in Recent and All projects can now be deleted, including the default project; its contents go to the computer Trash first.' },
      { zh: '停用某个创作技能板块后，其他板块用到的共享方法不再读不到；例如停用「视频复刻与创作」后，「视频拉片」和「图片与视觉指导」照常可用。', en: 'Turning off one creative skill section no longer stops other sections from reading the methods they share; for example, video breakdown and image direction keep working when video remake and production is off.' },
      { zh: '删除当前项目后，积分流水、反馈和充值页面不再一直报「项目不存在」；打开时如果记住的项目已经删除，会自动回到默认项目。', en: 'After the open project is deleted, the credit ledger, feedback and top-up pages no longer fail with a missing-project error; a deleted remembered project falls back to the default one.' },
      { zh: '生成进度的估算按各模型的实际耗时重新校准，视频按所选片长计算，不再很快跑到九成后长时间不动。', en: 'Generation progress estimates are recalibrated from real run times per model, and videos account for the chosen length, so the bar no longer races to 90% and stalls.' },
      { zh: '设置的语言列表里，俄语等西里尔文字不再被拉开成一个字母一格。', en: 'Cyrillic language names such as Russian are no longer spread out letter by letter in the language list.' },
    ],
    improvements: [
      { zh: '首页、项目、资产、创作精选、反馈、账号和设置沿用原来的布局，配色、字体、卡片、按钮、输入框和选中状态改为与官网一致。', en: 'Home, projects, assets, featured work, feedback, account and settings keep their layout, with colors, type, cards, buttons, fields and selected states matching the website.' },
      { zh: '创作技能重新整理：「短剧与漫剧制作」升级为完整的「短剧漫剧全流程」，从立项、剧本、资产、分镜、打戏到视频提示词和出稿质检一条线做完；「视频创作」改名「视频复刻与创作」，复刻、单段剧情短片和短视频脚本都归到这里；「拉片与复刻」改为只做分析的「视频拉片」；视频制作工作流并入「画布操作手册」。', en: 'Creative skills are reorganised: short drama and comic drama production becomes a full pipeline from set-up and script to assets, storyboards, action, video prompts and QC; video production is renamed video remake and production and now holds remakes, single-scene drama and short-video scripts; breakdown and remake becomes analysis-only video breakdown; the production workflow joins the canvas guide.' },
      { zh: '设置里的「创作技能」改为卡片排列：每个技能显示来源和开关，顶部显示已启用数量。', en: 'Creative skills in Settings are now shown as cards with their source and switch, and the number enabled at the top.' },
      { zh: '设置里的「图片与视频」改为模型卡片：每个模型显示官方标识，时长、分辨率、比例、参考素材和积分分行列出；自动时长、自适应比例和各分辨率的时长上限直接写清楚。文本模型和画布里的模型选择也换成官方标识。', en: 'Images and video in Settings now shows a card per model with its official logo and its duration, resolution, ratio, reference and credit details, including auto duration, adaptive ratio and per-resolution limits. Text models and the canvas model picker use official logos too.' },
      { zh: '资产、生成记录、保存提示和报错里的说法改得更直白，例如「本机项目」改成「妙图项目」、文件「保存在这台电脑上」，不再出现「路由」这类内部用词。', en: 'Wording in assets, history, save notices and errors is plainer, for example MiaoImg projects and files stored on this computer, without internal terms.' },
      { zh: '生成进度改成节点底部的蓝色进度条：从左往右推进，百分比跟着进度走；上传进度同样改成进度条。', en: 'Generation progress is now a glowing blue bar along the bottom of the node, with the percentage moving along it; uploads use the same bar.' },
      { zh: '提示和报错不再是带底色的框，只用左侧一根细线标出状态。生成历史的模型筛选按图片、视频分组，显示模型名和官方标识；充值页的支付方式改成小巧的选项，配支付宝官方标识。', en: 'Notices and errors are a thin line instead of a tinted box. The history model filter is grouped by image and video with model names and official logos; the top-up page shows a compact payment choice with the official Alipay logo.' },
      { zh: '「豆包与 Dola」设置的说明重写：直接写明可用地区，其余说法也改得更直白。', en: 'The Doubao and Dola settings are rewritten in plain language and state the supported regions directly.' },
      { zh: 'macOS 安装镜像增加「首次使用」辅助程序，可自动复制应用、清理下载隔离并启动。', en: 'The macOS disk image now includes a first-use helper that copies the app, clears the download quarantine and launches it.' },
    ],
    knownIssues: [
      { zh: 'macOS 未签名版本第一次运行「首次使用」辅助程序时，可能需要在文件上右键选择「打开」一次。', en: 'The unsigned macOS build may require right-clicking the first-use helper and choosing Open once.' },
    ],
  },
  '3.1.0': {
    title: { zh: '画布节点统一风格、连线发光、快捷键面板；删除的项目放进系统废纸篓', en: 'Unified canvas nodes, glowing connections and a shortcuts panel; deleted projects go to the system Trash' },
    fixes: [
      { zh: '首页项目的「改名」以前点了没有反应，现在可以直接在卡片上输入新名字，回车保存。', en: 'Renaming a project on the home page used to do nothing; you can now type the new name on the card and press Enter to save.' },
      { zh: '删除项目以前会在妙图里偷偷留一份备份，越删占的空间越大；现在不再留备份，旧版本留下的备份会在启动时一起移到废纸篓。', en: 'Deleting a project used to leave a hidden copy inside MiaoImg, so deleting took more space instead of less. No copy is kept now, and copies left by older versions are moved to the Trash on start-up.' },
      { zh: '刚生成就删掉的图片和视频，以前会一直占着硬盘空间；现在下次启动时会自动释放。', en: 'Images and videos deleted right after they were generated used to stay on disk; their space is now released the next time MiaoImg starts.' },
      { zh: '设置在浅色外观下有几处白底白字、黑色输入框，看不清；现在文字和底色对比清楚。', en: 'A few settings panels in the light appearance showed white text on white and black input boxes; text now contrasts clearly.' },
      { zh: '「创作精选」的视频以前总是从很模糊的画质开始播；现在一开始就按最清晰的画质播放，网络跟不上时才自动降低。', en: 'Featured videos used to start at a blurry quality; they now start at the sharpest quality and only step down when the connection cannot keep up.' },
      { zh: '图片节点的「全景图」按钮以前点了会报错，现在可以正常打开。', en: 'The Panorama button on image nodes used to fail; it now opens normally.' },
      { zh: '打光、多角度、全景以前只建好下一个节点、不会开始生成，模型名称也一律显示成妙图；现在连好就自动生成，并显示模型真实来自妙图、豆包、Dola 还是你自己添加的模型。', en: 'Lighting, multi-angle and panorama used to create the next node without generating, and labelled every model as MiaoImg; they now generate as soon as they are connected and show whether the model comes from MiaoImg, Doubao, Dola or a model you added.' },
    ],
    improvements: [
      { zh: '删除项目、画布或素材后，文件会按原来的目录结构放进电脑的废纸篓（Windows 为回收站），想找回直接拖回来，想腾空间在废纸篓里清空即可。', en: 'Deleted projects, canvases and assets are moved to your computer\'s Trash (Recycle Bin on Windows) with their original folders, so you can drag them back or empty the Trash to free up space.' },
      { zh: '「最近项目」卡片新增「⋯」菜单，可以打开、重命名、删除项目；「全部项目」可以按名称搜索。', en: 'Recent project cards have a ⋯ menu to open, rename or delete a project, and All projects can be searched by name.' },
      { zh: '画布左上角显示「项目名 / 画布名」，一眼看出当前画布属于哪个项目。', en: 'The top-left corner of the canvas shows Project / Canvas so you can tell which project a canvas belongs to.' },
      { zh: '登录改为居中大窗口：左侧播放精选作品，右侧只留邮箱、验证码或密码，底部切换登录方式；新用户不用再填昵称。', en: 'Sign-in is now a larger centred window with a featured film on the left, just email and code or password on the right, and sign-in methods at the bottom. New users no longer need to enter a nickname.' },
      { zh: '侧边栏「案例」改名为「创作精选」。', en: 'Cases in the sidebar is renamed to Featured.' },
      { zh: '选中画布上的节点时，和它相连的线会变成蓝色发光，并有一小段光沿线流动；拖出连线时整条线发光。', en: 'Selecting a node on the canvas makes its connections glow blue with light flowing along them, and a connection you are dragging glows along its whole length.' },
      { zh: '单击节点两侧的「+」直接弹出节点菜单，选好就建出下游节点并自动连上。', en: 'Clicking the + on either side of a node opens the node menu; pick one and the new node is created and connected.' },
      { zh: '空画布中间给出常用节点的快捷按钮（图片生成、视频生成、文本、音频、3D 导演台），点一下就建好。', en: 'An empty canvas shows shortcut buttons for common nodes (image generation, video generation, text, audio, 3D director) in the middle.' },
      { zh: '文本节点可以直接在节点里编辑：上方工具栏可切换正文、标题、列表，设置加粗、斜体、文字颜色和背景色。', en: 'Text nodes can be edited in place, with a toolbar above the node for body, headings and lists, bold, italic, text colour and background.' },
      { zh: '右键菜单里写出撤销、重做、粘贴的快捷键。', en: 'The right-click menu shows the shortcuts for undo, redo and paste.' },
      { zh: '文本、图片、视频、音频节点空着时统一显示类型图标和「尝试：」：可以上传本地文件、粘贴剪贴板里的素材，或一键建好「文生图片」「文生视频」「图片生成视频」「音频生成视频」等下游节点并连上。', en: 'Empty text, image, video and audio nodes now share one layout with a Try: list: upload a file, paste from the clipboard, or create a connected downstream node such as text to image, text to video, image to video or audio to video.' },
      { zh: '新建的节点名字带序号（如「图片生成 1」「文本 2」），多个同类节点一眼分得清。', en: 'New nodes are numbered (for example Image generation 1, Text 2) so nodes of the same kind are easy to tell apart.' },
      { zh: '画布底部工具栏新增「快捷键」，按创作、缩放、移动画布、其他四栏列出当前键位。', en: 'A Shortcuts button in the bottom toolbar lists the current key bindings in four groups: create, zoom, move canvas and other.' },
      { zh: '「添加节点」菜单底部新增「添加资源 · 上传」；节点右键菜单新增「下载」，「复制到剪贴板」「删除」旁写出快捷键。', en: 'The Add node menu gains Add resources · Upload, and the node right-click menu gains Download with shortcuts shown next to Copy to clipboard and Delete.' },
      { zh: '生成输入框左上角的「参考」改名「上传」；图片比例为 auto 时显示虚线方框，不再只剩一个小点。', en: 'The Reference chip in the prompt box is renamed Upload, and an auto aspect ratio now shows a dashed frame instead of a tiny dot.' },
      { zh: '首页大按钮改为「新建画布创作」；侧边栏分为常用、社区、更多三组，底部新增「版本更新记录」。', en: 'The home button now reads New canvas, the sidebar is grouped into main, community and more, and a Release notes entry sits at the bottom.' },
      { zh: '文本模型设置里可以接入你自己的大模型账号：填写请求地址和 Key、选择接口格式，一键读取可用模型，Agent 就能用你自己的账号额度对话，不消耗妙图积分；内置 OpenAI、Anthropic、DeepSeek、Kimi、智谱、千问、火山方舟（Agent Plan、Coding Plan、豆包按量付费分开列出）、MiniMax、OpenRouter、Ollama、LM Studio 等常用预设。', en: 'Text model settings can now connect your own model account: enter the request address and key, choose the format and load the available models, and the agent can chat with your own account without using MiaoImg credits. Presets include OpenAI, Anthropic, DeepSeek, Kimi, Zhipu, Qwen, Volcano Ark (Agent Plan, Coding Plan and Doubao pay-as-you-go listed separately), MiniMax, OpenRouter, Ollama and LM Studio.' },
      { zh: '豆包和 Dola 的文本模型按你账号里实际能用的菜单显示，不再只有固定的几项；Dola 设置里写明了它按访问地区开放。', en: 'Doubao and Dola text models now follow the menu your account actually offers instead of a fixed list, and the Dola settings explain that availability depends on your region.' },
      { zh: 'Agent 对话里你发出的消息改成干净的右对齐文字，不再套厚边框和阴影。', en: 'Your messages in the agent conversation are now clean right-aligned text without heavy borders or shadows.' },
      { zh: '生成出来的视频节点也能截取片段、提取音轨、分离音视频，和导入的视频一样。', en: 'Generated video nodes can now trim clips, extract audio and split audio from video, just like imported videos.' },
      { zh: '3D 导演台的文本模型菜单按来源分组；图片打光页的阴影更柔和，更接近真实光照。', en: 'The 3D director groups its text models by source, and shadows on the image lighting page are softer and closer to real light.' },
      { zh: '启动时不再自动弹出更新说明，想看随时点左侧的「版本更新记录」；左上角品牌改为「妙图 MiaoImg」。', en: 'Release notes no longer pop up on launch; open Release notes on the left whenever you like. The top-left brand now reads 妙图 MiaoImg.' },
    ],
    knownIssues: [],
  },
  '3.0.2': {
    title: { zh: '修复关闭应用时偶发卡住', en: 'Fixes the app occasionally getting stuck while closing' },
    fixes: [
      { zh: '关闭妙图时，如果本机后台清理没有及时结束，窗口不再一直变灰卡住；保存完成后会继续退出。', en: 'If local background cleanup takes too long while MiaoImg is closing, the window no longer stays grey and stuck; the app continues exiting after your work is saved.' },
      { zh: '如果保存本身超时，会取消这次关闭并恢复窗口，不再出现本机服务已经停止、界面却无法继续操作的情况。', en: 'If saving itself times out, closing is cancelled and the window becomes usable again instead of leaving local services stopped behind an unresponsive interface.' },
    ],
    improvements: [],
    knownIssues: [],
  },
  '3.0.1': {
    title: { zh: 'MiniMax H3 可选比例与提示词优化开关，Seedream 4.0 支持 4K', en: 'MiniMax H3 ratios and prompt optimisation switch, 4K for Seedream 4.0' },
    fixes: [
      { zh: 'MiniMax H3 用首帧或尾帧生成视频时，以前只能选「自适应」比例，现在 7 种比例都可以选，生成的画面按所选比例输出。', en: 'MiniMax H3 first-frame and last-frame videos were limited to the adaptive ratio; all seven ratios can now be chosen and the video follows the one you pick.' },
      { zh: 'MiniMax H3 和 Seedance 2.0 用多张参考图生成时，选「自适应」比例不再报「需要选择具体比例」。', en: 'MiniMax H3 and Seedance 2.0 no longer ask for a specific ratio when you pick adaptive with several reference images.' },
      { zh: '旧版本画布里存下的视频比例和当前模式不符时，会自动换成可用的比例继续生成，不再直接报错。', en: 'A video ratio saved on an older canvas that no longer fits the selected mode is switched to a valid one instead of stopping with an error.' },
    ],
    improvements: [
      { zh: 'MiniMax H3 的「高级设置」新增「原样使用提示词」：打开后不再做提示词优化，按你写的原文生成，每次少收这部分费用；默认仍会优化。', en: 'MiniMax H3 Advanced settings add Use prompt as written: prompt optimisation is skipped, the video follows your exact wording and that charge is removed. Optimisation stays on by default.' },
      { zh: 'Seedream 4.0 新增 7 个 4K 尺寸（方形、横屏、竖屏等），价格和 2K 相同。', en: 'Seedream 4.0 adds seven 4K sizes (square, landscape, portrait and more) at the same price as 2K.' },
    ],
    knownIssues: [],
  },
  '3.0.0': {
    title: { zh: '画布全新排布、反馈入口与更顺手的登录', en: 'A rearranged canvas, a feedback channel and simpler sign-in' },
    fixes: [
      { zh: '打开和切换大画布明显变快：99 个节点的画布，打开从 5 秒多降到约 1.4 秒，切回已经打开过的画布从 6 秒降到 1 秒多。', en: 'Large canvases open and switch much faster: a 99-node canvas now opens in about 1.4 s instead of over 5 s, and switching back to an open canvas takes about 1 s instead of 6 s.' },
      { zh: '宫格切分、截帧等需要写入本机项目的操作，偶尔点了没有反应，现在会正常生成新节点。', en: 'Grid split, frame capture and other actions that write into the local project sometimes did nothing; they now create the new nodes.' },
      { zh: '手机竖拍的照片在节点缩略图里不再横着显示；发给模型的参考图和局部重绘也按画面方向转正，涂抹区域和原图对得上。', en: 'Portrait phone photos no longer appear sideways in node thumbnails. Reference images sent for generation and inpainting are also rotated upright, so the painted area matches the picture.' },
      { zh: '桌面版恢复了充值入口：点击积分余额会打开账号页，账号面板里也能进入「充值与积分明细」。', en: 'Top-up is back in the desktop app: clicking your balance opens the account page, and the account panel links to Top up and credit history.' },
      { zh: '图片生成选择同比例的大尺寸（例如 2K 方形）时，不会再被改回列表里较小的尺寸。', en: 'Choosing a larger size with the same ratio in image generation (for example 2K square) no longer switches back to a smaller size.' },
      { zh: '豆包、Dola 视频在清晰度跟随平台时，时长选项不再是空的。', en: 'Doubao and Dola video duration options are no longer empty when the resolution follows the platform.' },
      { zh: '豆包、Dola 模型显示官方名称，不再显示内部编号；没有登录时，模型选择框也会显示模型名而不是一串代码。', en: 'Doubao and Dola models show their official names instead of internal IDs, and the model picker shows names even when you are signed out.' },
      { zh: 'MiniMax H3 生成 15 秒视频时，成片略长于 15 秒不再按 16–30 秒的长视频价格结算。', en: 'A 15-second MiniMax H3 video that comes out slightly longer than 15 seconds is no longer charged at the 16–30 second long-video rate.' },
      { zh: '全景预览、视频截取、历史记录等弹窗可以按 Esc 关闭。', en: 'Esc now closes the panorama preview, video trim, history and similar dialogs.' },
      { zh: '截取视频会保留原视频的全部音轨；音频转换格式失败后，节点不再停在处理中。', en: 'Trimmed videos keep every audio track, and a failed audio format conversion no longer leaves the node stuck processing.' },
      { zh: '从没登录过的情况下添加生成节点，不再弹出「登录已过期」，模型菜单会直接提示登录后可选。', en: 'Adding a generation node before you have ever signed in no longer shows “sign-in expired”; the model menu simply asks you to sign in.' },
      { zh: '已经连上参考素材的生成节点，不再显示和当前情况不符的「试试」提示。', en: 'Generation nodes that already have references connected no longer show Try hints that do not fit.' },
      { zh: '设置页在浅色背景或白色强调色下，选中项、按钮和标签上的文字看不清的问题已经修好。', en: 'Selected options, buttons and tags in Settings are readable again on light backgrounds and with a white accent colour.' },
      { zh: '「图片与视频」设置里的单价不再显示一长串小数。', en: 'Prices in Image and video settings no longer show long trailing decimals.' },
      { zh: '切换画布时偶尔加载不出自己安装的插件节点，现在会自动重试。', en: 'Plugin nodes you installed sometimes failed to load when switching canvases; they now retry automatically.' },
    ],
    improvements: [
      { zh: '登录改成二选一：用邮箱验证码直接登录（新邮箱会自动注册），或者切换到密码登录。忘记密码时验证邮箱即可设置新密码。同一个邮箱连续输错 5 次密码会暂停 15 分钟，这期间可以继续用验证码登录。', en: 'Sign-in is now one or the other: sign in with an email code (new emails register automatically) or switch to password sign-in. If you forget your password, verify your email to set a new one. Five wrong passwords in a row pause password sign-in for 15 minutes; email codes keep working.' },
      { zh: '新增「反馈」：在左侧导航提交问题或建议，可以附截图，版本和系统会自动带上。我们的回复会出现在同一条反馈下面，有新回复时导航上会亮红点。', en: 'New Feedback page: report a bug or send an idea from the left rail, with screenshots; your app version and system are attached automatically. Replies appear under the same report, and a red dot shows when there is a new one.' },
      { zh: '设置页重新排版：左侧按通用、创作、模型、连接分组，右侧每一项放在卡片里，说明在左、开关和选项在右；浅色、深色和各种强调色下文字都清楚。', en: 'Settings are reorganised: the left side groups General, Create, Models and Connections, and each option sits in a card with its description on the left and the control on the right. Text stays readable in light, dark and any accent colour.' },
      { zh: '内置创作技能按板块整理成 8 个：剧本创作、角色与场景设定、分镜设计、短剧与漫剧制作、视频创作、拉片与复刻、图片与视觉指导、画布操作手册。每个板块先帮 Agent 选对方法，各方法的原文完整保留。', en: 'Built-in creative skills are organised into 8 sections: screenwriting, character and scene design, storyboards, short and comic drama production, video production, breakdown and remake, image direction, and the canvas guide. Each section helps the Agent pick the right method, and every method keeps its full original text.' },
      { zh: '设置里的豆包与 Dola 页面重新整理：账号和额度放在前面，网络说明可以收起；界面上直接写豆包或 Dola，不再写「本机账户」。', en: 'The Doubao and Dola settings page is reorganised: account and allowance come first, the network guide can be collapsed, and the interface names Doubao or Dola directly.' },
      { zh: '画布左上角的画布名和切换按钮不再挡住 macOS 窗口的红黄绿按钮；窗口顶部空白处可以直接拖动窗口。', en: 'The canvas name and switcher in the top-left no longer cover the macOS window buttons, and the empty strip along the top drags the window.' },
      { zh: '画布工具重新排布：左下角是素材库、整理、小地图、连线和吸附，底部中间是添加节点、选择、抓手、撤销、重做、适应视图和设置。', en: 'Canvas tools are rearranged: the asset library, tidy, minimap, links and snapping sit at the bottom left; add node, select, hand, undo, redo, fit view and settings sit at the bottom center.' },
      { zh: '输入框去掉了框中框；空的图片、视频生成节点给出「试试」入口，连上参考后自动收起；输入框新增「+ 参考」，选中的文件放在节点左侧并自动连好线。', en: 'The prompt box no longer has a box inside a box. Empty image and video generation nodes offer Try shortcuts that disappear once references are connected, and + Reference places the chosen files to the left of the node and links them.' },
      { zh: '没有素材的图片、视频、音频节点只显示能用的按钮和上传提示。', en: 'Image, video and audio nodes without media show only usable buttons and an upload hint.' },
      { zh: '截取视频按所选起止精确到帧。', en: 'Video trim now cuts at the exact frames you select.' },
      { zh: '音频节点新增格式转换：MP3、M4A、WAV、FLAC。', en: 'Audio nodes can convert to MP3, M4A, WAV or FLAC.' },
      { zh: '画布里的视频直接播放原文件，不再自动换成低清副本。', en: 'Videos on the canvas play the original file instead of switching to a low-resolution copy.' },
      { zh: '节点右键菜单的「复制节点」改名为「创建副本」，原来的「创建副本」改为「创建副本（保留输入连线）」，名称和实际效果一致。', en: 'In the node menu, Copy node is now Create a copy, and the old Create a copy is now Create a copy (keep input links), matching what each does.' },
      { zh: '登录、退出和积分改在窗口右上角的小面板里。打开软件先看到本机项目和案例，点「登录 / 注册」再登录，不再整页切到登录页。', en: 'Sign-in, sign-out and balance now live in a small panel at the top right. The app opens on local projects and cases; choose Sign in / Register to sign in instead of switching to a full-page sign-in screen.' },
      { zh: '未登录时也能打开本机项目和画布继续查看；历史、积分这些需要账号的入口在登录后才出现。', en: 'Local projects and canvases open without signing in; account-only entries such as history and balance appear after sign-in.' },
      { zh: '项目卡片只显示项目名和日期，不再写「进入这个画布」。', en: 'Project cards show the project name and date without the “enter this canvas” label.' },
      { zh: '设置入口放在左侧桌边栏；画布底部齿轮仍可直接打开同一设置。外观、语言、画布、模型、技能、MCP、本机操作和版本信息都在这里调整，打开时画布暂停快捷键。', en: 'Settings now sit in the left rail, while the canvas bottom gear opens the same panel directly. Appearance, language, canvas, models, skills, MCP, local tools and version information are managed here; canvas shortcuts pause while settings are open.' },
      { zh: '深色和浅色画布统一了底色、点阵、节点外形、端口、标题和底部工具条；图片与视频节点改为媒体卡加独立提示词卡。', en: 'Dark and light canvases now share one background, dot grid, node shape, port, title and bottom-toolbar treatment. Image and video nodes use a media card with a separate prompt card.' },
      { zh: '桌面画布顶部只保留返回、当前画布切换和画布/文档切换；项目名称仍在项目管理里，画布不再重复显示；画布内不再放独立历史页。', en: 'The desktop canvas header now keeps only Back, the current canvas switcher and Canvas/Document tabs. Project naming stays in project management, and the canvas no longer repeats it or contains a separate History page.' },
      { zh: '展开提示词会把整张生成卡放大到画布中央，输入、模型、参数和发送操作保持在一起；收起入口固定在卡片右上角，参考素材不再把它挤到下一行。', en: 'Expanding a prompt enlarges the whole generation card in the canvas center, keeping prompt, model, parameters and send action together. The collapse action stays at the card’s top-right instead of being pushed down by references.' },
      { zh: '缩放菜单补上 50%、100%、800% 和当前快捷键；适合屏幕不会再为了铺满窗口把小画布强行放大到 100% 以上。', en: 'The zoom menu now includes 50%, 100%, 800% and the current shortcuts. Fit to screen no longer enlarges a small canvas above 100% just to fill the window.' },
      { zh: 'Agent 悬浮球在空闲时不再持续播放渐变动画，减少画布静止时的显卡占用和拖动卡顿。', en: 'The floating Agent orb no longer animates continuously while idle, reducing GPU use and canvas stutter.' },
      { zh: '切换项目或画布后，Agent 的新消息会绑定当前画布；画布尚未打开完成时先暂停发送，避免继续操作上一张画布。', en: 'After switching projects or canvases, a new Agent message binds to the current canvas. Sending pauses until that canvas is ready so work cannot continue on the previous one by mistake.' },
      { zh: '同一 Agent 会话现在可以只读列出本机其他项目、查看项目内画布并读取指定画布结构和节点内容，不必先丢弃当前会话；跨项目修改仍要先切到对应项目。', en: 'One Agent conversation can now list other local projects, inspect their canvases and read a selected canvas structure and node content without discarding the current conversation. Cross-project edits still require switching to that project.' },
      { zh: '桌面画布直接读写本机工作区，不再定时向云端拉取整张画布；回到窗口或切换画布时会读一次本机文件，后台保存的生成结果也能显示出来。', en: 'The desktop canvas reads and writes its local workspace directly instead of polling the cloud for the whole canvas. Returning to the window or switching canvases reads the local file once, so results saved in the background appear.' },
      { zh: '资产页分成“生成历史”和“个人资产库”：生成历史对应账号里的模型任务，个人资产库直接读取本机项目里的图片、视频和音频；未登录也能离线浏览本机资产。', en: 'Assets now separates Generation history from Personal assets: generation history follows account model tasks, while Personal assets reads images, videos and audio from local projects and remains available while signed out.' },
      { zh: '资产页的图片和视频先显示本机 320px 缩略图，点开后才读取原文件，浏览大项目时不再一次加载大量原始媒体。', en: 'Images and videos in Assets use cached local 320 px thumbnails, loading the original only when opened instead of pulling many full-size files at once.' },
      { zh: '生成历史里旧版本保存的图片改用本机缩略图，不再显示裂图；本机原件已删除的记录显示类型图标，视频记录显示实际消耗积分。', en: 'Images saved by earlier versions now use local thumbnails in Generation history instead of broken images. Records whose local original was deleted show a type icon, and video records show the credits actually used.' },
      { zh: '节点靠近画布底部时输入卡不再被压扁：输入框保持完整圆角，底部工具栏在选中期间暂时让位，取消选中后恢复。', en: 'A node near the bottom of the canvas no longer crushes its composer: the prompt box keeps its rounded shape and the bottom toolbar steps aside while the node is selected, returning when it is deselected.' },
      { zh: '设置页可以按 Esc 返回原画布；比例选项中的“自适应”显示为中文。', en: 'Esc now leaves Settings and returns to the canvas; the adaptive ratio option is labelled in the interface language.' },
      { zh: '窄窗口下妙图 Agent 圆球默认停在底部工具栏上方；拖动或恢复旧位置时也会自动避开工具栏。', en: 'The MiaoImg Agent orb now stays above the bottom toolbar in narrow windows and automatically avoids it when dragged or restored.' },
      { zh: '设置中的豆包与 Dola 页面补全网络自检顺序，并说明只切换节点、没有开启系统代理或 TUN 时，妙图窗口仍可能直连；Dola 需要日本、英国、东南亚等开放地区的出口，美国出口会被 Dola 限制。', en: 'The Doubao and Dola settings now explain the network checks and note that selecting a node without enabling System Proxy or TUN may leave MiaoImg on a direct connection. Dola needs an exit in an offered region such as Japan, the UK or Southeast Asia; US exits are restricted by Dola.' },
      { zh: 'MiniMax H3 按当前官方能力开放 480p、768P、1080p 和 2K，并支持 4–30 秒；2K 仍按官方限制最长 15 秒，16–30 秒报价按官方长视频档计算。', en: 'MiniMax H3 now follows its current official options for 480p, 768P, 1080p and 2K with 4–30 second clips. 2K keeps the official 15-second limit, while 16–30 second quotes use the official long-video rate.' },
      { zh: 'Grok Imagine Image 2.0 补上官方支持的自动质量选项；多图编辑上限按当前官方能力保持 5 张。', en: 'Grok Imagine Image 2.0 now includes the official automatic quality option; multi-image editing keeps the current official five-image limit.' },
    ],
    knownIssues: [
      { zh: '收不到验证码时，请先看看垃圾邮件；仍然没有的话，可以改用密码登录。', en: 'If the email code does not arrive, check your spam folder, or switch to password sign-in.' },
      { zh: '豆包和 Dola 的参考图需要先保存在本机项目里，画布上还没落盘的图片不能直接发送。', en: 'Doubao and Dola reference images must already be saved in the local project. An image still only on the canvas cannot be sent directly.' },
      { zh: '妙图不会自动切换 Clash 节点、系统代理或 TUN。Dola 是否可用仍取决于当前账号地区、登录状态和妙图窗口实际使用的网络出口。', en: 'MiaoImg does not switch Clash nodes, System Proxy or TUN automatically. Dola availability still depends on the account region, sign-in state and the network exit actually used by the MiaoImg window.' },
      { zh: '遇到问题可以在左侧「反馈」里告诉我们，附上截图会更快处理。', en: 'If something goes wrong, tell us from Feedback in the left rail; a screenshot helps us fix it faster.' },
    ],
  },
  '0.2.19': {
    title: { zh: '充值页与案例入口', en: 'Top-up page and cases' },
    fixes: [
      { zh: '关闭了微信支付。充值页只保留支付宝，金额和付款二维码仍在同一页。', en: 'Closed WeChat Pay. The top-up page keeps Alipay, with the amount and payment code on the same page.' },
      { zh: '支付方式暂不可用时，充值页直接显示可操作的提示，不再显示支付平台返回的原始错误。', en: 'When a payment method is unavailable, the top-up page shows an actionable message instead of the raw error returned by the payment platform.' },
    ],
    improvements: [
      { zh: '「灵感库」更名为「案例」。打开后先看到项目和案例。点一个项目进入这一份画布。案例在项目下方，可切换视频精选和提示词。', en: '“灵感库” is now called “案例”. Opening the app shows projects and cases first. Choosing a project opens that canvas. Cases sit below the projects, with curated films and prompts.' },
    ],
    knownIssues: [
      { zh: '还停在只填密码登录页的旧版本，需要安装这个版本后再登录。', en: 'Older installs still showing password-only sign-in need this version before signing in again.' },
      { zh: '豆包和 Dola 的参考图需要先保存在本机项目里，画布上还没落盘的图片不能直接发送。', en: 'Doubao and Dola reference images must already be saved in the local project. An image still only on the canvas cannot be sent directly.' },
      { zh: '豆包普通账号仍会保留品牌水印。Dola 的品牌标识以实际返回为准。', en: 'Ordinary Doubao accounts still keep the brand watermark. Dola’s brand mark follows what the account actually returns.' },
    ],
  },
  '0.2.18': {
    title: { zh: '登录、项目首页与生成选项', en: 'Sign-in, project home and generation choices' },
    fixes: [
      { zh: '登录不能只填密码。账号入口和登录页都在同一页填写密码和邮箱验证码，先收取验证码再一起提交，不再分成「密码登录」「邮箱验证码」「注册账号」三个页签。允许注册时，新邮箱会创建账号。', en: 'Sign-in no longer accepts a password alone. The account menu and sign-in page take the password and email code together, after requesting the code, instead of separate password, code and registration tabs. A new email creates an account when registration is open.' },
      { zh: '修复图片、视频节点显示当前型号没有的比例或清晰度的问题。新节点不再先填 16:9 或 9:16。换型号只取该型号列出的第一项，不再优先补 16:9。没有列出的项显示跟随平台页面，打光和局部重绘也不再把 2K 或 16:9 当成可用项。', en: 'Fixed image and video nodes showing ratios or resolutions the selected model does not offer. New nodes no longer start with 16:9 or 9:16. Switching models takes the first listed choice instead of preferring 16:9. Missing choices follow the platform page. Lighting and inpaint no longer treat 2K or 16:9 as available when the model does not list them.' },
      { zh: '修复 Dola 图片、视频节点拒绝已保存在本机项目里的参考图的问题。豆包和 Dola 都使用本机项目里的参考图。', en: 'Fixed Dola image and video nodes rejecting reference images already saved in the local project. Doubao and Dola both use reference images saved in the local project.' },
      { zh: '修复对话里的引用、附件、补充消息和子任务说明被截短的问题。过长的补充消息不再被当成无效内容拒绝。Agent 提问卡的回答不再限制 8000 字。', en: 'Fixed mentions, attachments, follow-up messages and child-task instructions being cut short. Long follow-ups are no longer rejected as invalid. Answers on the Agent question card are no longer limited to 8,000 characters.' },
      { zh: '视频秒数里的自动时长不再显示成「-1秒」。', en: 'Automatic video duration no longer appears as “-1 seconds”.' },
      { zh: '充值页支付宝不再标「推荐」，和微信支付并排。金额和付款二维码改到同一页，不再左右分栏对不齐。', en: 'On the top-up page, Alipay is no longer marked recommended and sits beside WeChat Pay. The amount and payment code are on the same page instead of a split layout that was hard to line up.' },
    ],
    improvements: [
      { zh: '打开后先看到项目和灵感库。点一个项目进入这一份画布。灵感库在项目下方，可切换视频精选和提示词。', en: 'Opening the app shows projects and the inspiration library first. Choosing a project opens that canvas. The library sits below the projects, with curated films and prompts.' },
      { zh: '图片节点在当前型号允许时可以填写自定义宽高。宽高超出该型号范围时，使用按钮不可点。', en: 'Image nodes can take a custom width and height when the selected model allows it. The apply button stays disabled when the size is outside that model’s range.' },
      { zh: '视频节点按当前型号显示「返回尾帧」。文字生成时，列出了「联网搜索」的型号也会显示这个开关。', en: 'Video nodes show “Return last frame” when the selected model lists it. Text generation also shows “Web search” on models that list that switch.' },
      { zh: '设置里的创作说明、创作记忆，以及开发设置里的 Agent 系统提示词，不再卡在 20000 字。保存保留全文，字数只作显示。', en: 'Creative notes, creative memory and the Agent system prompt in developer settings are no longer capped at 20,000 characters. Saving keeps the full text; the count is only a display.' },
      { zh: '发送豆包或 Dola 的图片、视频前，会先打开该账号里的去除 AI 明水印。确认不了就停在发送前。节点上的「参数与水印」可以查看这项说明。', en: 'Before sending a Doubao or Dola image or video, the app turns on that account’s removal of the visible AI mark. If it cannot be confirmed, sending stops. The node’s “Settings and watermark” control explains this.' },
    ],
    knownIssues: [
      { zh: '还停在只填密码登录页的旧版本，需要安装这个版本后再登录。', en: 'Older installs still showing password-only sign-in need this version before signing in again.' },
      { zh: '豆包和 Dola 的参考图需要先保存在本机项目里，画布上还没落盘的图片不能直接发送。', en: 'Doubao and Dola reference images must already be saved in the local project. An image still only on the canvas cannot be sent directly.' },
      { zh: '豆包普通账号仍会保留品牌水印。Dola 的品牌标识以实际返回为准。', en: 'Ordinary Doubao accounts still keep the brand watermark. Dola’s brand mark follows what the account actually returns.' },
    ],
  },
  '0.2.17': {
    title: { zh: '生成选择与结果恢复改进', en: 'Clearer generation choices and result recovery' },
    fixes: [
      { zh: '修复部分生成选项与实际请求不一致的问题。', en: 'Fixed some generation choices not matching the submitted request.' },
      { zh: '修复视频秒数、比例和清晰度设置未完整传递的问题。', en: 'Fixed video duration, aspect ratio and resolution settings not being fully applied.' },
      { zh: '继续未完成任务时保留原请求和参数，减少重复生成与结果错配。', en: 'Continuing unfinished tasks preserves the original request and settings to reduce duplicate generation and mismatched results.' },
      { zh: '完善已生成视频的取回与保存，等待确认时显示实际状态。', en: 'Improved retrieval and saving of generated videos, with clearer status while confirmation is pending.' },
      { zh: '生成前确认图片和视频的水印设置，无法确认时停止发送，避免无效消耗。', en: 'Image and video watermark settings are checked before generation; unconfirmed settings stop submission to avoid unnecessary usage.' },
    ],
    improvements: [
      { zh: '节点标题和模型选择框显示更清晰，便于区分相同版本的选项。', en: 'Clearer node titles and model selectors distinguish options with the same version name.' },
      { zh: '视频参数按具体选项分别展示，未开放的清晰度会明确标注。', en: 'Video settings follow each selected option, with unavailable resolution controls clearly indicated.' },
      { zh: '修复参数下拉菜单点选时意外关闭的问题。', en: 'Fixed settings menus closing unexpectedly while choosing an option.' },
    ],
    knownIssues: [
      { zh: '部分生成选项受账号权限和所在地区限制，不可用时会在提交前提示。', en: 'Some generation options depend on account permissions and region; unavailable options are reported before submission.' },
      { zh: '去除 AI 明水印后，普通账号仍可能保留品牌水印，具体以账号可用权限为准。', en: 'Brand watermarks may remain on free accounts after removing the AI visible mark, depending on account permissions.' },
    ],
  },
  '0.2.16': {
    title: { zh: '保存恢复与对话体验改进', en: 'Safer saving, recovery and clearer conversations' },
    fixes: [
      { zh: '修复画布更新期间，部分节点结果未及时保存的问题。', en: 'Fixed some node results not being saved during canvas updates.' },
      { zh: '复制画布和文本节点时，正文保持独立，所复制文本之间的链接跟随副本。', en: 'Copied canvases and text nodes keep independent text, with links between copied texts following their copies.' },
      { zh: '整理、重命名和删除文件时检查所选版本，避免覆盖或移除后来修改的内容。', en: 'File organization, renaming and deletion check the selected version to protect newer changes.' },
      { zh: '修复切换账号、项目或对话后，旧请求影响当前内容或回答的问题。', en: 'Fixed older requests affecting current content or answers after switching accounts, projects or chats.' },
      { zh: '完善长任务中断后的状态恢复，减少重复提交和结果重复保存。', en: 'Improved recovery after interruptions to reduce duplicate submissions and repeated result saves.' },
      { zh: 'Mac 更新只选择匹配本机架构的安装包；应用所在位置无法直接替换时，使用下载入口。', en: 'Mac updates select packages matching the computer architecture and offer a download when the application cannot be replaced in place.' },
    ],
    improvements: [
      { zh: '优化 Agent 对话的消息层次、工具状态与输入区，长表格可在对话内横向查看。', en: 'Clearer Agent messages, compact tool status and a refined input area, with wide tables scrolling within the conversation.' },
      { zh: '结果保存时保留已被修改的文件，必要时将原结果另存为独立副本。', en: 'Saving results preserves modified files and keeps the original result in a separate copy when needed.' },
      { zh: '完善回收站恢复和备份清理，恢复失败时继续保留原文件。', en: 'Improved trash recovery and backup cleanup, preserving original files when recovery fails.' },
      { zh: '完善退出和重新加载时的保存与操作收尾，减少状态丢失。', en: 'Improved saving and cleanup when exiting or reloading to reduce lost state.' },
    ],
    knownIssues: [
      { zh: '本机文件与命令仍受系统权限限制；已开始的操作停止等待后，请先查看实际结果再重试。', en: 'Local files and commands remain subject to system permissions. After stopping a wait for an operation already underway, check its actual result before retrying.' },
    ],
  },
  '0.2.15': {
    title: { zh: '画布工具与本机操作完善', en: 'Canvas tools and local operations' },
    fixes: [
      { zh: '修复文本节点重复创建目录产生的无效请求。', en: 'Removed redundant directory creation requests from text nodes.' },
      { zh: '修复部分文本工具请求被错误拒绝的问题。', en: 'Fixed text tool requests being incorrectly rejected.' },
      { zh: '保持画布文件与官网、已安装客户端的读写兼容。', en: 'Canvas files remain readable and editable on the website and installed clients.' },
      { zh: '关闭外部连接后停止无效重连，保留内置 Agent 的画布操作。', en: 'Disabled external connections stop retrying while the built-in Agent keeps canvas access.' },
      { zh: '修复新建节点未就绪时 Agent 查不到功能，以及画面外图片无法直接切分的问题。', en: 'Fixed missing functions on newly created nodes and image splitting outside the visible canvas.' },
      { zh: '完善分组、解组、复制粘贴、文档与画布目录操作；未选中节点也能读取和恢复历史结果。', en: 'Improved grouping, clipboard transfer, documents and canvas folder operations.' },
    ],
    improvements: [
      { zh: 'Agent 默认复制节点时保留系统剪贴板内容，可继续在其他画布粘贴。', en: 'Agent node copying preserves the system clipboard by default and supports pasting into other canvases.' },
      { zh: '本机操作与画布能力使用统一工具目录，节点功能按需发现。', en: 'Local operations and canvas controls use a shared tool directory with node functions discovered on demand.' },
    ],
    knownIssues: [
      { zh: '本机文件操作受系统权限限制；应用退出后，需先确认未完成命令的实际结果。', en: 'Local file operations require system permissions; check unfinished commands after reopening the app.' },
    ],
  },
  '0.2.14': {
    title: { zh: 'Agent 连续任务与视频预览优化', en: 'Continuous Agent tasks and lighter video previews' },
    fixes: [
      { zh: '修复切换对话、刷新页面或等待子任务时任务中断、补充消息丢失的问题。', en: 'Fixed interrupted tasks and lost follow-up messages when switching chats, reloading or waiting for child tasks.' },
      { zh: '修复子任务结果回传、单独继续对话和停止排队任务的状态不同步问题。', en: 'Fixed stale child-task results, continued conversations and cancellation of queued tasks.' },
      { zh: '修复视频播放到结尾后重新打开无法正常重播的问题。', en: 'Fixed completed videos failing to replay after reopening.' },
      { zh: '素材版本变化后自动更新节点预览，减少手动刷新画布。', en: 'Node previews update when asset revisions change, reducing manual canvas refreshes.' },
    ],
    improvements: [
      { zh: '多视频画布优先展示首帧，点播放才加载视频；离开画布释放播放资源，重新查看复用缓存。', en: 'Video canvases show posters first and load videos on play, release resources when leaving and reuse cached media on return.' },
      { zh: '拖动视频进度条时先选择位置，松手后定位，减少反复缓冲。', en: 'Choose a position while dragging the video timeline and seek on release, reducing repeated buffering.' },
      { zh: '长对话保留完整可见历史，按需展开更早记录；分镜表可在对话内横向查看。', en: 'Long chats preserve visible history with earlier records loaded on demand; storyboard tables scroll within the conversation.' },
    ],
    knownIssues: [
      { zh: '应用退出会中断正在执行的本机命令；重新打开后，请先确认未完成操作的实际结果。', en: 'Exiting the app interrupts running local commands; check unfinished operations before continuing after reopening.' },
    ],
  },
  '0.2.13': {
    title: { zh: 'Agent 画布操作与灵感库升级', en: 'Agent canvas controls and inspiration library updates' },
    fixes: [
      { zh: '修复长对话和工具执行中意外中断、切换模型后选择丢失的问题。', en: 'Fixed interruptions in long conversations and tool execution, and model selections being lost after switching.' },
      { zh: '修复取消后操作仍在保存、与下一条画布指令冲突的问题。', en: 'Fixed cancelled operations still saving and conflicting with the next canvas command.' },
      { zh: '修复多个子任务切换画布时互相影响操作目标的问题。', en: 'Fixed child tasks redirecting each other when switching canvases.' },
      { zh: '修复外部工具连接状态不同步、文件参数缺失误写和文档打开失败后无法重试的问题。', en: 'Fixed stale external tool connection states, missing file arguments causing incorrect writes and failed documents not reopening.' },
    ],
    improvements: [
      { zh: '执行中可直接补充要求，继续同一任务；子任务保留独立完整记录，可单独查看和停止。', en: 'Add instructions during a running task; child tasks keep separate full histories and can be viewed or stopped independently.' },
      { zh: '长对话自动整理上下文，保留原始记录；在文档面板中也能让 Agent 操作画布。', en: 'Long conversations compact automatically while preserving original records; the Agent can operate the canvas from the document panel.' },
      { zh: '灵感库整合精选视频与图片、视频提示词，按需加载素材，支持查看原始提示词。', en: 'The inspiration library brings together curated videos and image and video prompts, loading media on demand and showing original prompts.' },
    ],
    knownIssues: [
      { zh: '参考视频用于近似动作预演；精细舞蹈仍需调整关键帧，动画导出耗时约等于影片时长。', en: 'Video references guide approximate motion previs; detailed choreography still needs keyframe adjustments, and export takes approximately the video duration.' },
    ],
  },
  '0.2.12': {
    title: { zh: '视频体验与 Agent 工具优化', en: 'Video playback and Agent tool improvements' },
    fixes: [
      { zh: '修复 Agent 回复中的成片链接无法打开或播放的问题。', en: 'Fixed video links in Agent replies failing to open or play.' },
      { zh: '修复 Agent 调用导演台时未加载可用模型、动画任务提前中断的问题。', en: 'Fixed missing model initialization and premature interruption when the Agent runs the director.' },
      { zh: '导演台画面比例会保存并应用到预览和导出，竖屏方案重新打开后不再恢复横屏。', en: 'Director aspect ratios persist across preview, export and reopening.' },
      { zh: '修复 3D 取景鼠标锁定被拒绝及错误提示出现英文的问题。', en: 'Fixed blocked pointer locking in 3D camera control and localized its error message.' },
      { zh: '视频加载未完成时可直接重试，切换画布和移出视野后释放播放资源。', en: 'Retry incomplete video loads and release playback resources outside the active view.' },
      { zh: '本地搜索支持文件夹和用户目录缩写，并明确显示未搜索的范围。', en: 'Local search supports folders and home paths and reports incomplete searches.' },
      { zh: '工具结果统一圆角边框与内容裁切，去除重叠边框和露出的方角。', en: 'Tool results use one rounded frame that clips content cleanly, without overlapping borders or square corners.' },
    ],
    improvements: [
      { zh: 'Agent 按任务选择技能；开启本机操作后，可发现个人和当前文件夹中的本地技能。', en: 'The Agent selects skills for each task and discovers personal and current-folder skills when computer access is enabled.' },
      { zh: 'Agent 可回看真实白模姿态、继续修改方案，并将已有动画导出到画布。', en: 'The Agent can inspect rendered poses, refine plans and export existing animations to the canvas.' },
      { zh: '减少重复缩略图处理与媒体复制开销，大文件导出不再阻塞界面。', en: 'Reduced duplicate thumbnail work and media copying; large file exports no longer block the interface.' },
      { zh: '工具调用以清楚的动作、处理对象和状态呈现，详细参数可按需展开。', en: 'Tool calls show clear actions, targets and states, with details available on demand.' },
      { zh: '网页操作默认在后台进行，需要查看或登录时再打开浏览器窗口。', en: 'Web interactions run in the background by default, with visible browser windows available when needed.' },
    ],
    knownIssues: [
      { zh: '导演台视频目前按播放时长录制，导出耗时约等于影片时长。', en: 'Director videos are recorded in real time, so export takes approximately the video duration.' },
      { zh: '参考视频用于近似动作预演，精细舞蹈仍需调整关键帧。', en: 'Video references guide approximate motion previs; detailed choreography still needs keyframe adjustments.' },
    ],
  },
  '0.2.11': {
    title: { zh: '导演台参考素材与场景编辑修复', en: 'Director reference media and scene editing fixes' },
    fixes: [
      { zh: '修复导演台已引用的图片和视频未传入规划过程的问题。', en: 'Fixed attached images and videos being omitted from director planning.' },
      { zh: '修复白模默认光照缺少立体层次的问题。', en: 'Restored depth and shading in the default mannequin lighting.' },
    ],
    improvements: [
      { zh: '视频参考带时间标记，可继续查看动作细节；修改方案前后检查草稿，失败保留原方案。', en: 'Video references include timestamps and support closer inspection; draft validation preserves the original plan on failure.' },
    ],
    knownIssues: [
      { zh: '参考视频生成的是近似动作预演，不等同于逐帧动作捕捉；精细舞蹈仍需调整关键帧。', en: 'Reference videos guide approximate motion previs, not frame-by-frame motion capture; detailed choreography still needs keyframe adjustments.' },
    ],
  },
  '0.2.10': {
    title: { zh: '音画保真与模型选择修复', en: 'Media fidelity and model selection fixes' },
    fixes: [
      { zh: '修复视频截取、音轨提取和音频处理后音质下降的问题。', en: 'Fixed audio quality loss after trimming videos, extracting audio and editing audio.' },
      { zh: '文本节点及时更新可用模型，已关闭的模型不再保留为可用选项。', en: 'Text nodes refresh available models and remove disabled choices.' },
    ],
    improvements: [
      { zh: '视频截取优先保留原始音画，范围向外对齐关键帧并标注实际起止时间。', en: 'Video trimming preserves original media, aligns the range outward to keyframes and shows the actual times.' },
      { zh: '提取和分离优先保留原始音轨，精确音频剪辑使用无损格式，原素材保持不变。', en: 'Extraction and separation preserve original audio where supported; precise audio edits use lossless output and leave source files unchanged.' },
    ],
    knownIssues: [],
  },
  '0.2.9': {
    title: { zh: '外观随心切换', en: 'Choose your appearance' },
    fixes: [
      { zh: '清理提示词卡片圆角外的灰边，以及聊天气泡外的重复底色。', en: 'Removed gray corners around prompt cards and duplicate backgrounds around chat bubbles.' },
    ],
    improvements: [
      { zh: '新增跟随系统、浅色、深色与自定义背景，切换后立即生效。', en: 'Follow the system, choose light or dark, or set a custom background instantly.' },
      { zh: '背景、面板、文字和网格同步适配，图片与视频保持原色。', en: 'Backgrounds, panels, text and grids adapt together while media keeps its original colors.' },
      { zh: '记住你的外观选择，登录页和重新启动后继续沿用。', en: 'Keep your appearance on the sign-in screen and after restarting.' },
    ],
    knownIssues: [],
  },
  '0.2.8': {
    title: { zh: 'MCP 操作范围与任务控制优化', en: 'MCP project and task controls' },
    fixes: [
      { zh: '修复 MCP 指令可能操作到其他已打开项目的问题。', en: 'Fixed MCP commands reaching a different open project.' },
      { zh: '修复素材列表较长时无法继续读取的问题。', en: 'Fixed incomplete file lists in larger projects.' },
      { zh: '修复取消连接后部分画布与媒体操作仍继续执行的问题。', en: 'Stop pending canvas and media operations when an MCP request is cancelled.' },
    ],
    improvements: [
      { zh: '统一文件改名、目录操作与媒体处理的编辑保护。', en: 'Apply consistent file protection to renaming, folders and media processing.' },
      { zh: '完善项目连接状态与画布工具发现。', en: 'Clarify project connections and available canvas tools.' },
    ],
    knownIssues: [],
  },
  '0.2.7': {
    title: { zh: '外部 Agent 画布连接修复', en: 'External agent canvas connection fixes' },
    fixes: [
      { zh: '补回 MCP 设置入口，修复画布连接刚建立就断开的问题。', en: 'Restored MCP settings and fixed canvas connections closing immediately.' },
      { zh: '正常重启后保留连接配置，关闭授权和更新令牌立即生效。', en: 'Keep connection settings across normal restarts, with immediate disable and token rotation.' },
      { zh: '修复复制配置缺少有效令牌和首次调用媒体工具失败的问题。', en: 'Fixed invalid copied credentials and first-use media tool failures.' },
    ],
    improvements: [
      { zh: '提供 Codex 专用连接配置与可导出的妙图画布 Skill。', en: 'Added Codex connection settings and an exportable MiaoImg canvas skill.' },
      { zh: '加强文档编辑冲突保护，避免覆盖正在编辑的内容。', en: 'Protect open documents and reject conflicting edits.' },
    ],
    knownIssues: [],
  },
  '0.2.6': {
    title: { zh: '登录与连接体验优化', en: 'Sign-in and connection improvements' },
    fixes: [
      { zh: '移除桌面启动时短暂出现的旧版展示页。', en: 'Removed the old landing page flashing during desktop startup.' },
      { zh: '修复启动和登录后反复切换登录页面的问题。', en: 'Fixed repeated sign-in screens during startup and after signing in.' },
      { zh: '修复登录失败时出现生成任务提示的问题。', en: 'Fixed unrelated generation messages appearing when sign-in fails.' },
      { zh: '修复账号失效后无法回到统一登录入口的问题。', en: 'Return to one sign-in screen when your session expires.' },
    ],
    improvements: [
      { zh: '统一提示和确认弹窗的黑灰样式，去除旧版黄色提示。', en: 'Unified notices and confirmation dialogs with the dark gray interface.' },
      { zh: '登录连接适配电脑的系统网络与代理设置。', en: 'Sign-in connections now follow system network and proxy settings.' },
      { zh: '登录、注册和退出在同一界面完成，重启后直接恢复已保存的账号。', en: 'Sign in, register and sign out in one place, with saved accounts restored on restart.' },
    ],
    knownIssues: [],
  },
  '0.2.5': {
    title: { zh: '素材与视频处理优化', en: 'Media and video processing improvements' },
    fixes: [
      { zh: '修复搜索画布后新建画布时名称输入框不显示的问题。', en: 'Fixed the name field staying hidden when creating a canvas after a search.' },
      { zh: '修复编辑较长提示词后画布和底部工具栏偏移的问题。', en: 'Fixed the canvas and bottom toolbar shifting while editing long prompts.' },
      { zh: '修复保存到素材库的人物图等素材无法搜索到的问题。', en: 'Fixed saved reference images and other media missing from library search.' },
      { zh: '修复部分项目截取视频片段、提取音轨时被误拦截的问题。', en: 'Fixed video trimming and audio extraction being incorrectly blocked in some projects.' },
    ],
    improvements: [
      { zh: '优化连续截取片段和视频帧时的摆放，避免结果相互遮挡。', en: 'Keep successive clips and captured frames from overlapping on the canvas.' },
      { zh: '保留原视频，处理后的片段继续保存到当前项目。', en: 'Keep the original video and save processed clips in the current project.' },
    ],
    knownIssues: [
      { zh: '导出预演视频时，请保持妙图窗口可见，直到导出完成。', en: 'Keep the MiaoImg window visible until previs video export finishes.' },
    ],
  },
  '0.2.4': {
    title: { zh: '3D 导演台创作优化', en: '3D director improvements' },
    fixes: [
      { zh: '修复复杂场景规划进行三分钟后被提前停止的问题。', en: 'Fixed complex scene planning stopping after three minutes.' },
      { zh: '修复部分动画规划无法正确读取和修改场景的问题。', en: 'Fixed some animation plans failing to read and edit scenes correctly.' },
      { zh: '修复连续导出视频和取景图时，画布节点相互遮挡的问题。', en: 'Fixed overlapping canvas nodes when exporting videos and keyframes in succession.' },
    ],
    improvements: [
      { zh: '生成未完成时保留原来的修改要求，方便调整后继续。', en: 'Keep your instructions when generation does not finish, so you can revise and continue.' },
      { zh: '优化生成中断提示，让下一步操作更清楚。', en: 'Clearer messages when generation is interrupted.' },
    ],
    knownIssues: [
      { zh: '导出预演视频时，请保持妙图窗口可见，直到导出完成。', en: 'Keep the MiaoImg window visible until previs video export finishes.' },
    ],
  },
  '0.2.3': {
    title: { zh: '灵感库与联网工具修复', en: 'Library and web tool fixes' },
    fixes: [
      { zh: '修复部分代理网络下，联网搜索和网页读取被误拦截的问题。', en: 'Fixed web search and page reading being blocked on some proxy networks.' },
      { zh: '修复灵感库视频内容显示为空白、详情无法播放的问题。', en: 'Fixed blank video cards and missing video playback in library details.' },
    ],
    improvements: [
      { zh: '重新整理灵感库文案，显示图片与视频数量。', en: 'Refreshed library copy and added image and video counts.' },
      { zh: '支持卡片静音预览、详情播放与拖动进度，自动切换可用视频来源。', en: 'Added muted card previews, detail playback, seeking and video source fallback.' },
    ],
    knownIssues: [
      { zh: '部分视频使用原站地址，播放取决于原站状态和网络连接。', en: 'Some videos use original URLs; playback depends on source availability and your connection.' },
    ],
  },
  '0.2.2': {
    title: { zh: '对话连接与本机访问修复', en: 'Conversation and computer access fixes' },
    fixes: [
      { zh: '修复发送消息后出现“连接已中断”的问题。', en: 'Fixed interrupted connections after sending a message.' },
      { zh: '统一更新说明的黑灰界面和白色按钮。', en: 'Release notes now match the dark gray interface and white buttons.' },
    ],
    improvements: [
      { zh: '明确本机操作允许访问当前系统账号可读写的文件，默认文件夹不限制访问范围。', en: 'Computer access covers files available to your system account, beyond the default folder.' },
      { zh: '新增 macOS 系统文件权限设置入口。', en: 'Added a shortcut to macOS file permission settings.' },
    ],
    knownIssues: [
      { zh: '受系统保护的文件需要额外系统授权；Windows 版本本次未进行真机操作验证。', en: 'Protected files require additional system permissions. This Windows version has not been checked on a physical device.' },
    ],
  },
  '0.2.1': {
    title: { zh: '30 秒完整视频创作', en: 'Create complete 30-second videos' },
    fixes: [
      { zh: '新增清晰的账号注册入口，登录后直接进入画布。', en: 'A clear account registration entry, with direct access to the canvas after signing in.' },
      { zh: '修复调整价格后影响已提交视频报价的问题。', en: 'Submitted videos now keep their original pricing when prices change.' },
      { zh: '优化视频编辑的时长、比例与积分提示。', en: 'Clearer duration, aspect ratio and credit information when editing videos.' },
    ],
    improvements: [
      { zh: '新增 Seedance 2.5，支持最长 30 秒视频、多素材参考和原生声音。', en: 'Added Seedance 2.5 with videos up to 30 seconds, multiple references and generated audio.' },
      { zh: '补充微电影、人物对白、音乐 MV、动画和旅行等创作方法。', en: 'Expanded workflows for short films, dialogue, music videos, animation and travel.' },
    ],
    knownIssues: [
      { zh: '部分设备播放 1080p 视频时需要兼容 H.265 的播放器，可下载原片查看。', en: 'Some devices need an H.265-compatible player for 1080p video. Download the original to view it.' },
    ],
  },
  '0.2.0': {
    title: { zh: '妙图桌面版全新升级', en: 'A new MiaoImg desktop experience' },
    fixes: [
      { zh: '修复打开应用时进入介绍页的问题，登录后直接开始创作。', en: 'Open the app, sign in and go straight to your canvas.' },
      { zh: '优化模型选择，避免选中已暂停使用的模型。', en: 'Improved model selection to avoid paused models.' },
    ],
    improvements: [
      { zh: '新增本机操作授权，Agent 可以整理文件、修改内容、运行命令和操作浏览器。', en: 'Grant computer access so Agent can organize files, edit content, run commands and use a browser.' },
      { zh: '桌面版支持导入大视频，拖动起止点即可截取片段，原视频完整保留。', en: 'Import large videos and drag the range handles to trim a new clip while keeping the original.' },
      { zh: '补全创作技能与操作步骤，支持搜索和开启或关闭技能。', en: 'Expanded creative methods and instructions, with skill search and toggles.' },
      { zh: '新增画布搜索、文件夹整理、图片打光、多角度和全景创作入口。', en: 'Added canvas search, folders, image lighting, camera angles and panorama tools.' },
      { zh: '新增使用手册与联系入口，支持粘贴文字和媒体到画布。', en: 'Added a user guide, contact details and pasting text or media onto the canvas.' },
    ],
    knownIssues: [
      { zh: '大视频项目保存在本机，暂不支持云端同步。部分创作方法需要先自行安装所需软件。', en: 'Projects containing large videos stay on this computer and currently do not sync. Some creative methods require software you install separately.' },
    ],
  },
  '0.1.19': {
    title: { zh: '妙图桌面版更新', en: 'MiaoImg desktop update' },
    fixes: [
      { zh: '修复打开桌面版时进入官网介绍页的问题。', en: 'Fixed the desktop app opening the website introduction page.' },
      { zh: '退出账号后直接回到登录界面，重新登录即可继续创作。', en: 'Signing out now returns directly to sign-in. Sign in again to continue creating.' },
    ],
    improvements: [
      { zh: '优化可用模型的选择，避免默认选中已暂停的模型。', en: 'Improved model selection so paused models are no longer selected by default.' },
      { zh: '未登录时直接显示登录界面；已登录时直接进入画布。', en: 'The app opens sign-in when signed out and the canvas when signed in.' },
      { zh: '保留邮箱验证码和密码登录，优化小窗口下的登录布局。', en: 'Kept email-code and password sign-in and improved the layout in smaller windows.' },
    ],
    knownIssues: [
      { zh: '首次登录和重新验证账号需要联网。', en: 'An internet connection is required to sign in or verify your account again.' },
    ],
  },
  '0.1.18': {
    title: { zh: '妙图桌面版更新', en: 'MiaoImg desktop update' },
    fixes: [
      { zh: '修复部分不可用模型仍出现在选择列表中的问题。', en: 'Fixed unavailable models remaining in the model list.' },
      { zh: '修复默认文本模型与实际选择不一致的问题。', en: 'Fixed the default text model not matching the selected model.' },
    ],
    improvements: [
      { zh: '优化图片、视频和文本模型的选择与价格展示。', en: 'Improved model selection and price displays for images, videos, and text.' },
      { zh: '可用模型列表会及时更新。', en: 'The available model list now stays up to date.' },
    ],
    knownIssues: [
      { zh: '暂未发现影响正常使用的已知问题；如果遇到异常，请先重启妙图后再重试。', en: 'No known issue currently affects normal use. Restart MiaoImg and retry if something looks unusual.' },
    ],
  },
  '0.1.17': {
    title: { zh: '妙图桌面版更新', en: 'MiaoImg desktop update' },
    fixes: [
      { zh: '修复 macOS 桌面版更新时无法自动替换应用的问题。', en: 'Fixed macOS desktop updates that could not replace the installed app automatically.' },
      { zh: '修复视频生成前的参数校验和失败提示，让错误原因更容易看懂。', en: 'Improved preflight validation and failure messages for video generation.' },
      { zh: '修复文字模型额度在提交、完成和失败退回之间的结算一致性。', en: 'Fixed text-model credit accounting across submission, completion, and failure recovery.' },
    ],
    improvements: [
      { zh: '更新检查、下载和重启安装流程的状态提示更清晰。', en: 'Clarified update checking, downloading, and restart-to-install status.' },
      { zh: 'Mac 版可在应用内下载更新，重启后完成安装。', en: 'On Mac, download updates in the app and restart to finish installing.' },
    ],
    knownIssues: [
      { zh: '暂未发现影响正常使用的已知问题；如果遇到异常，请先重启妙图后再重试。', en: 'No known issue currently affects normal use. Restart MiaoImg and retry if something looks unusual.' },
    ],
  },
}
