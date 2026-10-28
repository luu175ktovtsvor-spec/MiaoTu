export type ReleaseNoteItem = { zh: string; en: string }

export type ReleaseNotes = {
  title: { zh: string; en: string }
  fixes: ReleaseNoteItem[]
  improvements: ReleaseNoteItem[]
}

// 更新说明面向使用软件的客户：只写具体修复和使用变化。
// 不写部署位置、内部链路、账号架构、供应商名称或问题清单。
// 写法：一句话说清哪里不对、现在怎样，或者现在能做什么；不解释实现。
const item = (zh: string, en: string): ReleaseNoteItem => ({ zh, en })

export const RELEASE_NOTES: Record<string, ReleaseNotes> = {
  '3.2.0': {
    title: { zh: '视频模式随时可选，Seedream 尺寸更全', en: 'Pick any video mode first, and more Seedream sizes' },
    fixes: [
      item('修复视频节点在连入素材前只能用文生视频、连入后总被切到全能参考的问题。现在可以先选图生视频、首尾帧等模式再连素材，素材不符合时会直接提示还缺什么。', 'Fixed video nodes only allowing text-to-video before media was connected, then always switching to omni reference. You can now pick image-to-video, first and last frames or any other mode first, and the node tells you what media is still missing.'),
    ],
    improvements: [
      item('Seedance 2.5 可以延长视频。', 'Seedance 2.5 can now extend videos.'),
      item('Seedream 每个清晰度都补齐 8 种比例，新增 21:9；5.0 Lite 的 3K 和 4.0 的 1K 可以搭配任意比例。', 'Every Seedream resolution now offers eight ratios, including 21:9, and 3K on Seedream 5.0 Lite and 1K on Seedream 4.0 work with any ratio.'),
      item('Agent 对话重新整理：运行时底部一直显示「处理中」和用时，读写画布等步骤收进「处理过程」，需要时点开查看；思考内容可以展开。', 'The Agent conversation is reorganised: while it works, the bottom of the chat shows what it is doing and for how long, and steps such as reading the canvas are tucked under Process, ready to expand. Its thinking can be expanded too.'),
      item('Agent 工作时可以继续输入，新消息会作为引导在当前这一步完成后接着处理，不会打断它；不需要时可以撤回。', 'You can keep typing while the Agent works: new messages guide it once the current step finishes, without interrupting, and can be withdrawn.'),
      item('Agent 知道每个模型支持哪些模式、各需要什么素材，还能直接生成分镜、使用图片快捷预设和查看整组预计积分。', 'The Agent now knows which modes each model supports and what media they need, and can create storyboards, use image quick presets and check the estimated credits for a whole group.'),
      item('模型选择改成简洁的列表，模型标识大小统一。', 'The model picker is now a simple list with evenly sized model logos.'),
    ],
  },
  '3.1.14': {
    title: { zh: '画布参考、分组生成与分镜', en: 'Canvas references, group generation and storyboards' },
    fixes: [
      item('修复 @ 引用菜单背景透明、文字和画布叠在一起的问题。', 'Fixed the @ reference menu being see-through, with its text overlapping the canvas.'),
      item('修复定位到节点时放得过大、编辑卡片被底部工具栏挡住的问题。', 'Fixed jumping to a node zooming in too far and hiding its edit card behind the bottom toolbar.'),
    ],
    improvements: [
      item('编辑卡片新增「画布参考」，直接从画布挑素材并自动连线；@ 菜单支持搜索和按类型筛选。', 'The edit card has a new Canvas reference button to pick media from the canvas and connect it automatically. The @ menu can be searched and filtered by type.'),
      item('参数菜单改用「比例 · 清晰度」的叫法（如 16:9 · 2K），只列当前模型能选的值。', 'Parameter menus now read as ratio and resolution (such as 16:9 · 2K) and only list what the selected model accepts.'),
      item('图片新增快捷预设：角色三视图、剧情推演四宫格、25 宫格分镜、电影级光影、画面推演前后。', 'New image quick presets: character turnaround, four-panel story, 25-panel storyboard, cinematic lighting, and the moment before or after.'),
      item('分组可以「整组生成」，先看总预计积分再确认；也可以「批量下载」成一个压缩包。', 'Groups can generate every node at once after showing the total estimated credits, or download everything as one archive.'),
      item('文本节点可以「生成分镜」，按段落或编号拆成一组图片生成节点。', 'Text nodes can create a storyboard, splitting the text by paragraph or number into a group of image generation nodes.'),
      item('导演台新增场景列表和属性面板，可以直接改物体的名称、位置、旋转、缩放和颜色。', 'The director adds a scene list and property panel for editing object names, position, rotation, scale and colour.'),
      item('参考音频可以在缩略图上试听，首帧和尾帧图片会标出来；节点搜索可以按类型筛选。', 'Reference audio can be played on its thumbnail, first and last frame images are labelled, and node search can filter by type.'),
    ],
  },
  '3.1.12': {
    title: { zh: '帧数提示与保存修复', en: 'Frame count and saving fixes' },
    fixes: [
      item('视频帧数不符合模型要求时会直接提示，不再被悄悄改成别的值。', 'A video frame count the model does not accept is now reported instead of being silently changed.'),
      item('修复项目路径带特殊字符时，生成的图片和视频保存不回项目的问题。', 'Fixed generated images and videos not saving back to projects whose path contains unusual characters.'),
    ],
    improvements: [],
  },
  '3.1.11': {
    title: { zh: '创作精选与模型选项更准确', en: 'More accurate featured work and model options' },
    fixes: [
      item('创作精选素材缺失时会明确提示，不再显示成已加载；修复精选封面保存失败、Agent 读不到精选素材的问题。', 'Missing featured work is now reported instead of appearing loaded, and featured covers save and open in the Agent correctly.'),
      item('模型菜单只显示当前模型真正能用的模式、尺寸、比例、时长和参考素材类型。', 'Model menus only show the modes, sizes, ratios, durations and reference types the selected model can use.'),
      item('参考素材格式不对时，提示会写明当前格式和可用格式。', 'When a reference file has the wrong format, the message shows its format and the accepted ones.'),
    ],
    improvements: [
      item('切换模型后，模式和参数会自动跟着新模型调整。', 'Modes and parameters now adjust to the new model when you switch.'),
    ],
  },
  '3.1.10': {
    title: { zh: '报价更准，反馈可以删除', en: 'More accurate quotes, and feedback you can delete' },
    fixes: [
      item('视频预计积分按所选模式和参数计算，提交前再核对一次，界面价格和实际预扣保持一致。', 'Video estimates follow the selected mode and parameters and are checked again before submitting, so the price shown matches what is reserved.'),
      item('模型信息页的价格和可用状态更清楚，切换模型时不再显示上一个模型的信息。', 'Model details show prices and availability more clearly and no longer show the previous model after switching.'),
    ],
    improvements: [
      item('可以删除自己提交的反馈和附件。', 'You can delete your own feedback and attachments.'),
      item('连点生成或隔很久再提交，不会再产生重复或异常的任务。', 'Clicking generate repeatedly or submitting after a long pause no longer creates duplicate or broken tasks.'),
    ],
  },
  '3.1.9': {
    title: { zh: '生成选项与节点说明更清楚', en: 'Clearer generation options and node guidance' },
    fixes: [
      item('图片和视频节点按所选模型和模式显示可用的分辨率、时长和参考要求，换模型时清掉不适用的旧参数。', 'Image and video nodes show the resolutions, durations and reference requirements for the selected model and mode, and clear options that no longer apply after switching.'),
      item('重新打开模型菜单会显示最新的可选项，不再沿用旧列表。', 'Reopening the model menu shows the latest options instead of an old list.'),
    ],
    improvements: [
      item('各类节点的名称和说明统一，已经改过的节点名保持不变。', 'Node names and guidance are consistent across node types, and names you changed are kept.'),
      item('参考素材说明写清格式、数量、大小和时长限制。', 'Reference guidance lists format, count, size and duration limits.'),
    ],
  },
  '3.1.8': {
    title: { zh: '视频精选补齐提示词与译文', en: 'Prompts and translations for featured films' },
    fixes: [
      item('视频精选补齐原始提示词和中文译文，详情页可以切换；复制和带入画布使用原文。', 'Featured films include their original prompt and a Chinese translation you can switch between; copying and using a prompt on the canvas keeps the original.'),
      item('切换作品时提示词同步切换，译文加载失败可以单独重试。', 'The prompt follows the selected film, and a failed translation can be retried on its own.'),
    ],
    improvements: [
      item('视频精选按网速自动调整清晰度播放。', 'Featured films adjust their quality to your connection.'),
    ],
  },
  '3.1.7': {
    title: { zh: '豆包与 Dola 参数提前显示', en: 'Doubao and Dola options appear right away' },
    fixes: [
      item('连接豆包或 Dola 后，图片和视频节点先显示常用的时长、比例和清晰度，账号菜单加载完再换成实际可选项。', 'Doubao and Dola image and video nodes show common duration, ratio and quality options while the account menu loads, then switch to what your account offers.'),
      item('Dola 视频时长改为 4–10 秒，图片和视频补上「自动」比例。', 'Dola video lengths are now 4–10 seconds, and images and videos gain an Auto ratio.'),
    ],
    improvements: [
      item('账号设置里区分「预置参数」和「当前账号菜单」。', 'Account settings separate preset options from the current account menu.'),
    ],
  },
  '3.1.6': {
    title: { zh: 'Dola 图片直接回到画布', en: 'Dola images return straight to the canvas' },
    fixes: [
      item('适配 Dola 新版的比例、时长和提示词格式；图片生成完直接保存原图并写回节点，不再停在待确认。', 'Updated for the new Dola ratio, duration and prompt controls. Finished images are saved and written back to the node instead of waiting for confirmation.'),
      item('修复 Dola 因为找不到旧的去水印设置而无法发送的问题。', 'Fixed Dola refusing to send because an old watermark setting was missing.'),
      item('Dola 的图片和视频不会再因为旧设置被误拦。', 'Dola images and videos are no longer blocked by stale settings.'),
    ],
    improvements: [],
  },
  '3.1.5': {
    title: { zh: '豆包自动确认生成，支持多账号', en: 'Doubao confirms automatically, plus multiple accounts' },
    fixes: [
      item('豆包视频需要确认参数时会自动完成，不用再打开豆包点「确定」；生成完成后即使拿不到去水印下载，也会保存原片，不再一直显示待确认。', 'Doubao video parameter confirmations now complete automatically, without opening Doubao to click OK. A finished video is saved even without a watermark-free download, so it no longer stays pending.'),
    ],
    improvements: [
      item('豆包和 Dola 可以添加多个账号，分别命名、切换、登录和退出；任务固定在提交时使用的账号上。', 'Doubao and Dola support several accounts, each with its own name, sign-in and sign-out. Each task stays with the account used to submit it.'),
      item('设置里列出当前账号实际可用的图片、视频和文本模型，以及各自的比例、时长和分辨率。', 'Settings list the image, video and text models your account can use, with their ratios, durations and resolutions.'),
    ],
  },
  '3.1.4': {
    title: { zh: 'Dola 标签选中后看得清', en: 'Readable Dola label when selected' },
    fixes: [
      item('修复设置里选中 Dola 后白底白字的问题。', 'Fixed white text on a white background when Dola is selected in Settings.'),
    ],
    improvements: [],
  },
  '3.1.3': {
    title: { zh: '最近项目删除修复', en: 'Recent project deletion fix' },
    fixes: [
      item('修复项目里有已经不存在的旧文件时，「最近项目」删除失败的问题。', 'Fixed Recent projects failing to delete a project that refers to files no longer on your computer.'),
    ],
    improvements: [
      item('视频时长和清晰度按各模型的实际范围显示，例如 MiniMax H3 的 480p、768P、1080p 最长 30 秒，2K 最长 15 秒。', 'Video length and resolution follow each model, for example up to 30 seconds at 480p, 768P and 1080p on MiniMax H3, and up to 15 seconds at 2K.'),
    ],
  },
  '3.1.2': {
    title: { zh: '豆包与 Dola 标签分开显示', en: 'Separate Doubao and Dola labels' },
    fixes: [],
    improvements: [
      item('「豆包与 Dola」切换改成两个独立标签，选中状态更清楚。', 'The Doubao and Dola switch is now two separate labels with a clear selected state.'),
    ],
  },
  '3.1.1': {
    title: { zh: '换上官网风格，所有项目都能删除', en: 'Website styling, and every project can be deleted' },
    fixes: [
      item('「最近项目」和「全部项目」里的所有项目都能删除，包括默认项目，内容会先放进系统废纸篓。', 'Every project in Recent and All projects can be deleted, including the default one; its contents go to the system Trash first.'),
      item('修复删除正在打开的项目后，积分明细、反馈和充值页一直报「项目不存在」的问题。', 'Fixed the credit history, feedback and top-up pages reporting a missing project after the open project was deleted.'),
      item('修复关闭某个创作技能后，其他技能用到的共享方法读不到的问题。', 'Fixed turning off one creative skill breaking other skills that share its methods.'),
      item('生成进度按各模型的实际耗时估算，不再很快到九成后长时间不动。', 'Generation progress now follows real run times per model instead of racing to 90% and stalling.'),
      item('修复语言列表里俄语等西里尔文字被拉开显示的问题。', 'Fixed Russian and other Cyrillic language names being spread out in the language list.'),
    ],
    improvements: [
      item('首页、项目、资产、创作精选、反馈、账号和设置换上与官网一致的配色、字体和控件，布局不变。', 'Home, projects, assets, featured work, feedback, account and settings now use the website colours, type and controls, with the same layout.'),
      item('创作技能重新整理：「短剧漫剧全流程」从立项到出稿质检一条线完成，「视频复刻与创作」收纳复刻、剧情短片和短视频脚本，「视频拉片」专做分析。', 'Creative skills are reorganised: the short drama pipeline runs from set-up to final checks, video remake and production covers remakes, story shorts and short-video scripts, and video breakdown focuses on analysis.'),
      item('设置里的创作技能和图片视频模型改成卡片，模型卡片列出时长、分辨率、比例、参考素材和积分。', 'Creative skills and image and video models in Settings are shown as cards, with each model listing duration, resolution, ratio, references and credits.'),
      item('生成和上传进度改成节点底部的进度条；登录输入框改为简洁的下划线样式。', 'Generation and upload progress is a bar along the bottom of the node, and sign-in fields use a simple underline style.'),
      item('macOS 安装镜像附带「首次使用」程序，自动完成复制和首次打开。', 'The macOS disk image includes a first-use helper that copies and opens the app for you.'),
    ],
  },
  '3.1.0': {
    title: { zh: '画布焕新，删除的内容进废纸篓', en: 'A refreshed canvas, and deletions go to the Trash' },
    fixes: [
      item('修复首页项目改名没有反应的问题。', 'Fixed renaming a project on the home page doing nothing.'),
      item('修复删除项目会留下隐藏备份、越删越占空间的问题；旧版本留下的备份会移到废纸篓。', 'Deleting a project no longer leaves a hidden copy that takes up space, and copies left by older versions are moved to the Trash.'),
      item('刚生成就删掉的图片和视频，下次启动会释放磁盘空间。', 'Images and videos deleted right after generation free their disk space on the next start.'),
      item('修复浅色外观下部分设置白底白字看不清的问题。', 'Fixed white-on-white text in some settings in the light appearance.'),
      item('创作精选视频从最清晰的画质开始播放，不再先模糊一阵。', 'Featured videos now start at their sharpest quality instead of blurry.'),
      item('修复图片节点「全景图」打不开的问题。', 'Fixed the Panorama button on image nodes not opening.'),
      item('打光、多角度和全景建好节点后会直接开始生成，并显示真实的模型来源。', 'Lighting, multi-angle and panorama now start generating once the node is created and show where the model comes from.'),
    ],
    improvements: [
      item('删除的项目、画布和素材按原目录放进系统废纸篓（Windows 为回收站），随时可以拖回来。', 'Deleted projects, canvases and assets go to the system Trash (Recycle Bin on Windows) with their folders, ready to drag back.'),
      item('「最近项目」卡片新增「⋯」菜单，「全部项目」支持搜索；画布左上角显示「项目 / 画布」。', 'Recent project cards have a ⋯ menu, All projects can be searched, and the canvas shows Project / Canvas in the top-left corner.'),
      item('新的登录窗口：左侧播放精选作品，右侧填邮箱和验证码或密码，新用户不用填昵称。', 'A new sign-in window plays featured work on the left and asks only for email and a code or password on the right; new users no longer pick a nickname.'),
      item('选中节点时相连的线会发光；点节点两侧的「+」可以直接新建下游节点并连好。', 'Connections of the selected node glow, and the + on either side of a node creates a connected downstream node.'),
      item('空画布和空节点给出常用操作的快捷入口；文本节点可以直接在节点里编辑和设置格式。', 'Empty canvases and nodes offer shortcuts for common steps, and text nodes can be edited and formatted in place.'),
      item('新增快捷键面板，右键菜单写出快捷键，节点右键可以下载。', 'A new shortcuts panel, shortcuts shown in the right-click menu, and Download in the node menu.'),
      item('可以接入你自己的大模型账号给 Agent 使用，不消耗妙图积分；预置 OpenAI、Anthropic、DeepSeek、Kimi、智谱、千问、MiniMax、OpenRouter、Ollama、LM Studio 等。', 'Connect your own model account for the Agent without using MiaoImg credits, with presets for OpenAI, Anthropic, DeepSeek, Kimi, Zhipu, Qwen, MiniMax, OpenRouter, Ollama, LM Studio and more.'),
      item('豆包和 Dola 的文本模型按账号实际菜单显示。', 'Doubao and Dola text models follow the menu your account offers.'),
      item('生成的视频也能截取片段、提取音轨和分离音视频。', 'Generated videos can be trimmed, have their audio extracted, or be split into audio and video.'),
      item('启动时不再自动弹出更新说明，可以随时在左侧「版本更新记录」查看。', 'Release notes no longer pop up at launch; open them from Release notes on the left.'),
    ],
  },
  '3.0.2': {
    title: { zh: '关闭应用不再卡住', en: 'Closing the app no longer hangs' },
    fixes: [
      item('修复关闭妙图时窗口偶尔变灰卡住的问题。', 'Fixed the window occasionally turning grey and hanging while MiaoImg closes.'),
      item('保存超时会取消这次关闭并恢复窗口，不会留下无法操作的界面。', 'If saving times out, closing is cancelled and the window stays usable.'),
    ],
    improvements: [],
  },
  '3.0.1': {
    title: { zh: 'MiniMax H3 比例可选，Seedream 4.0 支持 4K', en: 'MiniMax H3 ratios, and 4K on Seedream 4.0' },
    fixes: [
      item('MiniMax H3 首帧、尾帧生成可以选 7 种比例，不再只有自适应。', 'MiniMax H3 first and last frame videos can use all seven ratios, not just adaptive.'),
      item('修复 MiniMax H3 和 Seedance 2.0 多图参考选「自适应」时报错的问题。', 'Fixed MiniMax H3 and Seedance 2.0 rejecting the adaptive ratio with several reference images.'),
      item('旧画布里保存的视频比例不再适用时，会自动换成可用比例。', 'A video ratio saved on an older canvas that no longer applies is switched to a valid one.'),
    ],
    improvements: [
      item('MiniMax H3 高级设置新增「原样使用提示词」，跳过提示词优化，也省下这部分费用。', 'MiniMax H3 advanced settings add Use prompt as written, which skips prompt optimisation and its charge.'),
      item('Seedream 4.0 新增 7 个 4K 尺寸，价格和 2K 相同。', 'Seedream 4.0 adds seven 4K sizes at the 2K price.'),
    ],
  },
  '3.0.0': {
    title: { zh: '全新画布、反馈入口和更简单的登录', en: 'A new canvas, feedback and simpler sign-in' },
    fixes: [
      item('大画布打开和切换明显变快：99 个节点的画布打开从 5 秒多降到约 1.4 秒。', 'Large canvases open and switch much faster: a 99-node canvas opens in about 1.4 seconds instead of over 5.'),
      item('修复宫格切分、截帧偶尔没反应的问题。', 'Fixed grid split and frame capture sometimes doing nothing.'),
      item('修复手机竖拍照片缩略图横着显示、局部重绘区域对不上的问题。', 'Fixed portrait phone photos showing sideways and inpainting areas not lining up.'),
      item('恢复充值入口，点积分余额即可进入。', 'Top-up is back: click your balance to open it.'),
      item('修复图片选同比例的大尺寸后又被改回小尺寸的问题。', 'Fixed a larger image size with the same ratio switching back to a smaller one.'),
      item('修复豆包、Dola 视频时长选项为空、模型显示内部编号的问题。', 'Fixed empty Doubao and Dola duration options and models showing internal codes.'),
      item('修复 MiniMax H3 15 秒成片略长时按长视频价格计费的问题。', 'Fixed 15-second MiniMax H3 videos that ran slightly long being charged at the long-video rate.'),
      item('弹窗可以按 Esc 关闭；截取视频保留全部音轨；从未登录过时不再提示「登录已过期」。', 'Esc closes dialogs, trimmed videos keep every audio track, and you no longer see “sign-in expired” before ever signing in.'),
    ],
    improvements: [
      item('登录改为邮箱验证码（新邮箱自动注册）或密码二选一，忘记密码可以验证邮箱后重设。', 'Sign in with an email code (new emails register automatically) or a password, and reset a forgotten password by verifying your email.'),
      item('新增「反馈」：可以附截图，回复显示在同一条反馈下，有新回复时亮红点。', 'New Feedback page with screenshots; replies appear under your report and a red dot shows new ones.'),
      item('设置重新排版，按通用、创作、模型、连接分组。', 'Settings are reorganised into General, Create, Models and Connections.'),
      item('内置创作技能整理成 8 个板块。', 'Built-in creative skills are organised into eight sections.'),
      item('画布工具重新排布，输入框更简洁，空的生成节点给出「试试」入口。', 'Canvas tools are rearranged, the prompt box is simpler, and empty generation nodes offer Try shortcuts.'),
      item('音频节点可以转换为 MP3、M4A、WAV、FLAC；截取视频精确到帧。', 'Audio nodes convert to MP3, M4A, WAV or FLAC, and video trims are frame-accurate.'),
      item('未登录也能打开本机项目和画布；登录、退出和积分移到右上角的小面板。', 'Local projects and canvases open without signing in, and sign-in, sign-out and balance move to a small panel at the top right.'),
      item('资产页分为「生成历史」和「个人资产库」，浏览大项目更快。', 'Assets is split into Generation history and Personal assets, and large projects browse faster.'),
      item('Agent 可以查看本机其他项目的画布；切换画布后，新消息只作用于当前画布。', 'The Agent can look at canvases in your other local projects, and new messages always apply to the current canvas.'),
      item('MiniMax H3 支持 480p 到 2K、4–30 秒（2K 最长 15 秒）；Grok Imagine Image 2.0 新增自动质量。', 'MiniMax H3 supports 480p to 2K and 4–30 seconds (up to 15 at 2K), and Grok Imagine Image 2.0 adds automatic quality.'),
    ],
  },
  '0.2.19': {
    title: { zh: '充值与案例', en: 'Top-up and cases' },
    fixes: [
      item('充值暂时只支持支付宝；支付方式暂不可用时，会给出能照着做的提示。', 'Top-up currently supports Alipay only, and an unavailable payment method shows a clear next step.'),
    ],
    improvements: [
      item('「灵感库」改名「案例」，打开应用先看到项目和案例。', 'The inspiration library is now called Cases, and the app opens on your projects and cases.'),
    ],
  },
  '0.2.18': {
    title: { zh: '登录更安全，项目首页', en: 'Safer sign-in and a project home' },
    fixes: [
      item('登录需要同时填写密码和邮箱验证码。', 'Sign-in now takes your password and an email code together.'),
      item('修复图片、视频节点显示模型不支持的比例或清晰度的问题。', 'Fixed image and video nodes offering ratios or resolutions the model does not support.'),
      item('修复 Dola 不接受本机项目里参考图的问题。', 'Fixed Dola rejecting reference images saved in the local project.'),
      item('修复对话里较长的消息、引用和附件被截断的问题；自动时长不再显示成「-1 秒」。', 'Fixed long messages, mentions and attachments being cut off in chats, and automatic duration no longer shows as “-1 seconds”.'),
    ],
    improvements: [
      item('打开应用先看到项目和灵感库，点项目进入画布。', 'The app opens on your projects and the inspiration library; choose a project to open its canvas.'),
      item('支持的模型可以自定义图片宽高；视频可以「返回尾帧」，文本生成可以「联网搜索」。', 'Supported models accept a custom image size, videos can return their last frame, and text generation can search the web.'),
      item('创作说明和创作记忆不再限制 2 万字。', 'Creative notes and memory are no longer limited to 20,000 characters.'),
      item('豆包和 Dola 发送前会先打开去除 AI 水印的设置。', 'Doubao and Dola turn on visible AI mark removal before sending.'),
    ],
  },
  '0.2.17': {
    title: { zh: '生成参数和结果取回更可靠', en: 'More reliable generation settings and results' },
    fixes: [
      item('修复视频时长、比例和清晰度没有完整生效的问题。', 'Fixed video duration, ratio and resolution not fully taking effect.'),
      item('继续未完成的任务时沿用原来的参数，避免重复生成。', 'Resuming an unfinished task keeps its original settings, avoiding duplicate generation.'),
      item('生成的视频取回和保存更可靠，等待时显示真实状态。', 'Generated videos are retrieved and saved more reliably, with the real status shown while waiting.'),
    ],
    improvements: [
      item('同名版本的模型更容易区分；修复参数菜单点选时意外关闭的问题。', 'Models with the same version name are easier to tell apart, and settings menus no longer close while you choose.'),
    ],
  },
  '0.2.16': {
    title: { zh: '保存与对话更可靠', en: 'More reliable saving and chats' },
    fixes: [
      item('修复画布更新时部分节点结果没有保存的问题。', 'Fixed some node results not saving while the canvas updated.'),
      item('复制画布和文本节点后，副本内容彼此独立。', 'Copied canvases and text nodes keep independent content.'),
      item('修复切换账号、项目或对话后，旧请求影响当前内容的问题。', 'Fixed earlier requests affecting the current content after switching accounts, projects or chats.'),
      item('Mac 更新会选择和电脑匹配的安装包。', 'Mac updates pick the package that matches your computer.'),
    ],
    improvements: [
      item('Agent 对话层次更清楚，宽表格可以横向滚动。', 'Agent chats are easier to read, and wide tables scroll sideways.'),
      item('整理、改名和删除文件时，会保护你后来改过的内容。', 'Organising, renaming and deleting files protects changes you made later.'),
    ],
  },
  '0.2.15': {
    title: { zh: '画布工具更完善', en: 'Better canvas tools' },
    fixes: [
      item('修复部分文本操作被误拒绝的问题。', 'Fixed some text actions being wrongly refused.'),
      item('修复 Agent 找不到新建节点的功能、无法切分画面外图片的问题。', 'Fixed the Agent missing functions on new nodes and failing to split images outside the view.'),
    ],
    improvements: [
      item('分组、解组、复制粘贴和画布文件夹操作更完善；Agent 复制的节点可以粘贴到其他画布。', 'Grouping, ungrouping, copy and paste and canvas folders work better, and nodes the Agent copies can be pasted into other canvases.'),
    ],
  },
  '0.2.14': {
    title: { zh: 'Agent 连续任务与视频预览', en: 'Continuous Agent tasks and video previews' },
    fixes: [
      item('修复切换对话或刷新页面时任务中断、补充消息丢失的问题。', 'Fixed tasks stopping and follow-up messages being lost when switching chats or reloading.'),
      item('修复视频播完后重新打开无法重播的问题；素材更新后节点预览会自动刷新。', 'Fixed finished videos not replaying after reopening, and node previews refresh when media changes.'),
    ],
    improvements: [
      item('视频多的画布先显示首帧，点播放才加载，离开后释放资源。', 'Canvases with many videos show the first frame and load a video only when you play it.'),
      item('拖动进度条松手后再跳转，减少反复缓冲；长对话可以按需展开更早的记录。', 'Seeking happens when you release the timeline, reducing buffering, and long chats load older messages on demand.'),
    ],
  },
  '0.2.13': {
    title: { zh: 'Agent 画布操作与灵感库', en: 'Agent canvas control and the inspiration library' },
    fixes: [
      item('修复长对话和工具执行中途中断、换模型后选择丢失的问题。', 'Fixed long chats and tool runs stopping midway and model choices being lost after switching.'),
      item('修复取消后的操作和下一条画布指令冲突的问题。', 'Fixed cancelled actions clashing with the next canvas instruction.'),
    ],
    improvements: [
      item('任务执行中可以随时补充要求；子任务有独立记录，可以单独查看和停止。', 'Add instructions while a task runs; child tasks keep their own history and can be viewed or stopped separately.'),
      item('长对话自动整理上下文；在文档面板里也能让 Agent 操作画布。', 'Long chats tidy their context automatically, and the Agent can work on the canvas from the document panel.'),
      item('灵感库汇集精选视频和图片、视频提示词，可以查看原始提示词。', 'The inspiration library gathers featured videos and image and video prompts, with the original prompts.'),
    ],
  },
  '0.2.12': {
    title: { zh: '视频播放与导演台修复', en: 'Video playback and director fixes' },
    fixes: [
      item('修复 Agent 回复里的成片链接打不开的问题。', 'Fixed video links in Agent replies not opening.'),
      item('导演台的画面比例会保存，竖屏方案重新打开不再变回横屏。', 'The director keeps its aspect ratio, so portrait plans stay portrait when reopened.'),
      item('修复 3D 取景无法锁定鼠标的问题；视频加载失败可以直接重试。', 'Fixed 3D framing not capturing the mouse, and failed video loads can be retried.'),
    ],
    improvements: [
      item('Agent 按任务自动选用创作技能，也能用你电脑上的个人技能。', 'The Agent picks creative skills for each task and can use personal skills on your computer.'),
      item('Agent 可以查看导演台的白模姿态并继续修改方案。', 'The Agent can check mannequin poses in the director and keep refining the plan.'),
      item('导出大文件不再卡住界面；工具调用的状态显示更清楚。', 'Exporting large files no longer freezes the app, and tool steps are shown more clearly.'),
    ],
  },
  '0.2.11': {
    title: { zh: '导演台参考素材修复', en: 'Director reference fixes' },
    fixes: [
      item('修复导演台引用的图片和视频没有用于规划的问题；白模默认光照恢复立体感。', 'Fixed director references not being used for planning, and the default mannequin lighting has depth again.'),
    ],
    improvements: [
      item('视频参考带时间标记；修改方案失败时保留原方案。', 'Video references carry timestamps, and a failed revision keeps the original plan.'),
    ],
  },
  '0.2.10': {
    title: { zh: '音质与模型选择修复', en: 'Audio quality and model choice fixes' },
    fixes: [
      item('修复截取视频、提取音轨后音质下降的问题。', 'Fixed audio losing quality after trimming video or extracting audio.'),
      item('文本节点不再显示已关闭的模型。', 'Text nodes no longer list models that were turned off.'),
    ],
    improvements: [
      item('截取视频尽量保留原画原声，并标出实际的起止时间。', 'Video trims keep the original picture and sound where possible and show the actual start and end.'),
    ],
  },
  '0.2.9': {
    title: { zh: '外观随心切换', en: 'Choose your appearance' },
    fixes: [
      item('去掉提示词卡片圆角外的灰边。', 'Removed the grey edge around prompt card corners.'),
    ],
    improvements: [
      item('可以跟随系统，或选浅色、深色和自定义背景；图片和视频保持原色，重启后沿用。', 'Follow the system or choose light, dark or a custom background; images and videos keep their colours, and your choice is remembered.'),
    ],
  },
  '0.2.8': {
    title: { zh: '项目与任务控制', en: 'Project and task control' },
    fixes: [
      item('修复外部 AI 工具可能操作到另一个已打开项目的问题。', 'Fixed external AI tools possibly acting on a different open project.'),
      item('修复大项目素材列表读不全的问题；断开连接后，仍在执行的操作会停止。', 'Fixed incomplete file lists in large projects, and pending actions stop when a connection is closed.'),
    ],
    improvements: [
      item('改名、移动文件和处理媒体时统一保护正在编辑的内容。', 'Renaming, moving files and media processing all protect content being edited.'),
    ],
  },
  '0.2.7': {
    title: { zh: '外部 AI 工具连接画布', en: 'Connect external AI tools to the canvas' },
    fixes: [
      item('恢复外部连接的设置入口，修复连接刚建立就断开的问题；重启后保留连接设置。', 'The external connection setting is back, connections no longer drop right away, and settings survive a restart.'),
    ],
    improvements: [
      item('提供 Codex 连接配置和可导出的妙图画布 Skill；正在编辑的文档不会被覆盖。', 'Added Codex connection settings and an exportable MiaoImg canvas skill, and open documents are protected from being overwritten.'),
    ],
  },
  '0.2.6': {
    title: { zh: '登录与启动更顺', en: 'Smoother sign-in and start-up' },
    fixes: [
      item('修复启动时闪过旧介绍页、反复出现登录页、账号过期后回不到登录页的问题。', 'Fixed the old landing page flashing at start-up, repeated sign-in screens, and not returning to sign-in after a session expired.'),
    ],
    improvements: [
      item('提示和确认弹窗统一为深色样式；登录跟随系统的网络和代理设置，重启后自动恢复已登录的账号。', 'Notices and dialogs share the dark style, sign-in follows your system network and proxy settings, and your account is restored after a restart.'),
    ],
  },
  '0.2.5': {
    title: { zh: '素材与视频处理', en: 'Media and video handling' },
    fixes: [
      item('修复搜索后新建画布名称框不显示、编辑长提示词时画布偏移的问题。', 'Fixed the name field missing when creating a canvas after searching, and the canvas shifting while editing long prompts.'),
      item('修复保存到素材库的素材搜不到、部分项目截取视频被误拦的问题。', 'Fixed saved assets missing from search and video trimming being blocked in some projects.'),
    ],
    improvements: [
      item('连续截取的片段和帧不再互相遮挡；原视频始终保留。', 'Successive clips and frames no longer overlap, and the original video is always kept.'),
    ],
  },
  '0.2.4': {
    title: { zh: '3D 导演台更稳定', en: 'A steadier 3D director' },
    fixes: [
      item('修复复杂场景规划三分钟后被停止、部分动画方案读改场景失败的问题。', 'Fixed complex scene planning stopping after three minutes and some animation plans failing to edit the scene.'),
      item('修复连续导出视频和取景图时节点互相遮挡的问题。', 'Fixed nodes overlapping when exporting videos and frames one after another.'),
    ],
    improvements: [
      item('生成没完成时保留你的修改要求，方便调整后继续。', 'Your instructions are kept when generation does not finish, so you can adjust and continue.'),
    ],
  },
  '0.2.3': {
    title: { zh: '灵感库与联网修复', en: 'Library and web search fixes' },
    fixes: [
      item('修复部分代理网络下联网搜索被拦截、灵感库视频空白无法播放的问题。', 'Fixed web search being blocked on some proxy networks and library videos showing blank.'),
    ],
    improvements: [
      item('灵感库显示图片和视频数量，卡片可以静音预览，详情可以拖动进度。', 'The library shows image and video counts, cards preview muted, and details support seeking.'),
    ],
  },
  '0.2.2': {
    title: { zh: '对话连接修复', en: 'Chat connection fix' },
    fixes: [
      item('修复发送消息后提示「连接已中断」的问题。', 'Fixed “connection interrupted” appearing after sending a message.'),
    ],
    improvements: [
      item('本机操作可以访问你的系统账号能读写的文件；新增 macOS 文件权限设置入口。', 'Computer access covers files your system account can use, with a shortcut to macOS file permissions.'),
    ],
  },
  '0.2.1': {
    title: { zh: '30 秒完整视频', en: 'Complete 30-second videos' },
    fixes: [
      item('注册入口更清楚；调价后，已提交视频的报价保持不变。', 'Registration is easier to find, and submitted videos keep their price when prices change.'),
    ],
    improvements: [
      item('新增 Seedance 2.5：最长 30 秒，支持多素材参考和原生声音。', 'Added Seedance 2.5 with videos up to 30 seconds, multiple references and native sound.'),
      item('新增微电影、人物对白、音乐 MV、动画和旅行等创作方法。', 'New creative methods for short films, dialogue, music videos, animation and travel.'),
    ],
  },
  '0.2.0': {
    title: { zh: '全新妙图桌面版', en: 'The new MiaoImg desktop app' },
    fixes: [
      item('打开应用登录后直接进入画布；不会再选中已暂停的模型。', 'The app goes straight to your canvas after sign-in and no longer picks paused models.'),
    ],
    improvements: [
      item('授权本机操作后，Agent 可以整理文件、修改内容、运行命令和操作浏览器。', 'With computer access, the Agent can organise files, edit content, run commands and use a browser.'),
      item('可以导入大视频，拖动起止点截取片段，原视频完整保留。', 'Import large videos and drag the handles to trim a clip while keeping the original.'),
      item('新增画布搜索、文件夹、图片打光、多角度和全景，支持粘贴文字和媒体到画布。', 'Added canvas search, folders, image lighting, camera angles and panorama, and pasting text or media onto the canvas.'),
      item('创作技能可以搜索和开关；新增使用手册。', 'Creative skills can be searched and switched on or off, and a user guide is included.'),
    ],
  },
  '0.1.19': {
    title: { zh: '登录流程修复', en: 'Sign-in fixes' },
    fixes: [
      item('修复打开桌面版进入官网介绍页的问题；退出后直接回到登录界面。', 'Fixed the desktop app opening the website introduction, and signing out returns straight to sign-in.'),
    ],
    improvements: [
      item('不会默认选中已暂停的模型；小窗口下的登录布局更合适。', 'Paused models are no longer selected by default, and sign-in fits small windows better.'),
    ],
  },
  '0.1.18': {
    title: { zh: '模型列表修复', en: 'Model list fixes' },
    fixes: [
      item('修复不可用的模型仍出现在列表里、默认文本模型和实际选择不一致的问题。', 'Fixed unavailable models staying in the list and the default text model not matching your choice.'),
    ],
    improvements: [
      item('模型选择和价格显示更清楚，可用模型及时更新。', 'Model choice and prices are clearer, and the available models stay current.'),
    ],
  },
  '0.1.17': {
    title: { zh: 'Mac 应用内更新', en: 'In-app updates on Mac' },
    fixes: [
      item('修复 macOS 更新后无法自动替换应用的问题。', 'Fixed macOS updates not replacing the installed app.'),
      item('视频生成前的检查和失败提示更容易看懂；文本模型积分在提交、完成和失败退回时保持一致。', 'Video checks and failure messages are easier to understand, and text model credits stay correct through submission, completion and refunds.'),
    ],
    improvements: [
      item('Mac 版可以在应用内下载更新，重启后完成安装。', 'On Mac, updates download in the app and install when you restart.'),
    ],
  },
}
