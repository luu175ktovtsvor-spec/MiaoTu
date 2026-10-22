# 妙图的真实执行方式

创作说明中的 Brief、Treatment、Script、Segment、Take、Selection、Moment、Timeline、Track、Recipe、Style、Resource、Output、Candidate 和 Result 是用于描述作品的概念，不是妙图的接口名。用当前画布节点、工作区文件和现有工具实现这些关系。参考文档的 Markdown 链接是同一份参考库中的定位；读取时把相对链接解析为 video-create 根目录下的 references/... 路径，再调用 readSkill，不能传含 .. 的路径。

## 发现能力和按需阅读

画布任务先 getCanvas / getCanvasNodes、listWorkspaceFiles 找当前账号真实素材。本地文件任务无需打开画布，桌面端授权后使用 read/write/edit/bash/powershell/find/grep/ls/browser；先读取 readSkill({name:"canvas",path:"references/local-tools.md"}) 并检查实际环境，复用已有工具。getCanvas 返回 nodeTypes；不要调用不存在的 getNodeTypes。addNode 后通过 getNodeTools 获取节点函数的完整 schema，以 nodeTools 调用本轮返回的名字与 args，不从文档术语猜接口。readSkill({name:"video-create",path:"references/creation/brief.md"}) 是共享参考的读取方式；也可 readSkill({name:"video-script"}) 读取独立子技能。正文截断时用 nextOffset 继续，只加载当前任务需要的参考。

## 参考视频与声音

probeMedia({path}) 返回实际时长、尺寸、fps 和音轨；ffprobe({path,options}) 在需要完整字段时使用。inspectVideo({path,frameCount:6}) 只作初步导航，单次可传 1–8 帧；inspectVideo({path,timestamps:[...]}) 按具体时间细看，两种采样参数不要同时传。重要段落应改变采样范围与密度、分批查看，不能以初始六帧代替全片分析。图像是传给模型的内存画面，不是已保存的参考素材。需持久化帧时用 ffmpeg 按真实 schema 提取并以返回路径引用。随机 seek 的采样不是原生逐帧连续解码，也不证明 VFR 的准确剪切帧。

音轨存在不等于已经审听；需要对白时读取已有字幕或用户提供的文字，缺失明确说明。声音身份、字幕跟踪和动效可以形成创作方案；执行前必须发现当前节点或媒体工具确实具备所需能力。用户电脑上已有的转写、声音或跟踪工具可以按本文完整步骤使用；先检查实际安装、可用版本和所需配置；任务需要的缺失依赖按统一工具说明处理，不编造结果。

## 模型配置、报价与任务

生成节点的 node:getConfig 返回当前模型、模式、素材要求、比例和 durationResolutionMap；所有名称与字段以实际响应和 getNodeTools schema 为准。不是每个模型支持音频参考、多人物、多机位、视频续接或首尾帧。图片尺寸、视频时长、画质设在真实配置字段，不只写进提示词。保留用户选定的模型，不把示例中的模型当作默认模型。

在允许的预算和范围内执行。当前节点 estimate 给生成前预计积分；未知不当作 0，不能用静态技能文案计算积分。修改素材/时长/尺寸后重新读取报价。下单后 node:getGenerationStatus 查询同一请求至明确终态，返回不明或 running 时不重复下单。成功须有真实原始输出并写回所属画布，刷新可读取；任务 ID 和 idle 旧输出不能证明本次成功。原片与已接受产物用路径/连接引用，不复制多个完整文件，不删除账本或付费结果。

## 媒体合成与文件

writeWorkspaceFile 只写当前账号工作区文本，文件最大 200KB；readWorkspaceFile 按 nextOffset 续读截断内容。按需要保存 Brief、Treatment、唯一正式脚本、分析、时间表和制作进度，不制造一堆空文档。用户只要一个短方案时可保留在一个可编辑文本节点。文件和角色依真实路径/ID区分，不依赖“参考素材1”等固定名称。

ffmpeg 参数是 {steps:[{method,args}],operation:{method,args}}，不是 shell 命令。先查询 availableEncoders / availableFilters 等实际能力。路径必须是当前工作区相对文件，禁止绝对路径、外部 URL、..、任意脚本或代码执行。原始选项拆成 ["-map","[video]"]，不写整串 "-map [video]"；工具只映射字面存在的文件，序列通配、清单里的隐含路径、movie=/subtitles= 不自动进入沙箱。此工作区包装器不执行外部编排组件；桌面复杂字幕、动效和原方法脚本通过本机命令执行，按统一工具说明准备所需环境，保留完整原方法。

截帧示例（执行前仍读实际 schema）：steps=[{method:"input",args:["assets/source.mp4"]}]，operation={method:"screenshots",args:[{timemarks:["00:00:06.900","00:00:07.300"],folder:"assets/evidence",filename:"detail.png"}]}。输出名以工具返回为准；count:3 的命名通常为 detail.png、detail_1.png、detail_2.png。只需分析时优先 inspectVideo，避免保存无用途的帧。

## 交付证据

成片检查宽高、时长、关键动作、人物/产品连续性、字幕可读性、转场，以及可核实的声音处理。保留实际结果、节点和连接，并说明未完成部分。采样看不到的动作、未转写的对白、未经播放的声音都不能声称已核实。工具可用和成片完成是两回事。


## 完整工具配方

本节是具备本机命令工具的桌面执行路线。网页版未提供 localToolInfo、write 或命令工具时，不调用这些入口；继续用实际可用的工作区与媒体工具处理兼容部分，并保留需在桌面版完成的步骤，不把示例渲染器当成妙图网页内置功能。

video-tool、@video-tool/、VIDEO_SOURCE_URL、VIDEO_WEBSITE 是中性占位符。先调用 localToolInfo({tool:"video"})；用结果中的 replacements 还原真实命令和模块标识，核对已安装版本，再执行方法。未找到时按统一工具说明，在用户任务授权范围内准备依赖。Skill 中的 scripts 可由 readSkill 读取，使用 write 原样保存到本次项目的 scripts 文件夹后运行；先检查 Python 和依赖，复用或在项目隔离环境准备。引用文档的相对路径按各自所在目录解析，readSkill 使用规范化后的技能内路径。安装、配置和使用示例完整保留；是否执行取决于用户当前任务和授权，不能仅因读取 Skill 就安装无关软件。


本机依赖统一读取 `readSkill({name:"canvas",path:"references/local-tools.md"})`；同一个工具供多个 Skill 共用。

## Seedance 2.5 的执行配置

用户选定 Seedance 2.5 时使用实际节点目录中的 seedance-2.5。固定生成时长可选4–30秒，分别核对480p/720p/1080p和声音开关；提示词写30秒不能代替duration=30。图片、视频、音频参考分别最多30/10/10；视频和音频分别合计最多30秒。只提供音频也可以走混合参考。先读取当前 node:getConfig，未来能力以实际返回为准。

单图首帧、首尾帧、编辑和延长保持输入画幅；编辑保持输入视频时长，需要4–30秒的输入，不能在提示词里把编辑伪装成任意时长生成。多素材普通生成使用混合参考，提示词明确各素材用途。画布显示的预计积分包含实际输入素材；管理员调整价格后重新estimate，不引用本文中的固定积分数。人物参考必须是当前实际可用素材，不能承诺任意人脸图片都能直接提交。

30秒案例可用文字节点保存完整时间轴并连接视频生成节点，开启声音时分别写对白、配乐、环境音。目标效果视频保留在独立视频节点；只有生成工具返回的本次成功结果才写成生成成果。修改现有已定稿提示词时继续服从workflow内嵌PART A，不用教程示例覆盖用户的定稿。
