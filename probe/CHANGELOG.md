# 更新记录（CHANGELOG）

本文件按「日期」记录每一次对外可见的改动。**第一个对外发布的版本号是 `0.2.1`**
（`0.1.0` 只是本机开发期的内部编号，从未发布到 npm）。

---

## 仓库形态（GitHub）

`probe/client.js` 是浏览器半的**构建产物**（源头 `probe/scripts/build-client.mjs`），
但它**纳入版本控制**。理由：这个插件常见用法是把仓库目录直接 `link:` 进 DSH profile
（安装根就是 `probe/`），那条路不会跑 npm 的 `prepare`；`client.js` 缺席就等于
「浏览器半 import failed」，整块界面哑掉。宁可让产物跟着源码走。

代价与约束：**每次改 `scripts/build-client.mjs` 之后必须先 `npm run build` 再提交**，
`npm run build:check` 会在 CI/本地拦住「改了源码忘了重建」。

不要用 `npm i github:hulibuld/dsh-pet-cuteness-plugin` 安装：包在 `probe/` 子目录，
仓库根没有 `package.json`，npm 从 git 装会找不到包。装 npm 上的包名。

---

## 0.2.1 — 2026-10-24（首个公开版本）

第一次发到 npm。给 `@linxin666/dsh-pet`（右下角那只鲸鱼娘）配上一个"人"：

- **人格口吻**：按模型映射角色卡，注入系统提示词；会话级开关（输入框左边「语气」）。
- **中文思考**：要求模型直接用简体中文推理（输入框左边「中文思考」）。
- **头顶台词**：从模型自己的思考过程里摘人话，冒在挂件头顶；不额外请求、零 token 成本。
  卡片垫句有硬上限（`cardRatio` 可在 `/debug` 看），不让台词库抢麦。
- **每晚日记**：读 DSH 自己的会话日志，用 DeepSeek 写一篇按日期命名的 Markdown；
  标题与结尾都带日期；记录文档（账本）与日记分开，账本可手改。
- **21:00 切日**：21 点之后算第二天；定时那篇写刚刚结束的那一天。过点没写会自动补写。
- **设置页「大肥鱼的后台」**：日记设置、挂件状态、亲密度（折叠、默认关）、小鱼干（≤999）。

需要 `@linxin666/dsh-pet`（已声明为可选 peerDependency），不单独运行。

---

## 2026-10-24 改名（两步）

包名：`dsh-ai-waifu` → `dsh-pet-cuteness` → **`dsh-pet-cuteness-plugin`**（用户要求名字里必须留着 `plugin`；
npm 包名不能带空格，所以显示名写作 `dsh-pet-cuteness plugin`，包名写成连字符形式）。

路由前缀同步改成 `/api/dsh-pet-cuteness-plugin`；**上一代前缀全部保留为兼容别名**
（`/api/dsh-pet-cuteness`、`/api/dsh-ai-waifu`），因为用户浏览器里可能缓存着旧 bundle，
删别名就等于「设置页点了没反应」。数据文件（`plugin-data/` 下）与日记本路径一律没变。

设置页里那一页叫「大肥鱼的后台」（用户要求：别在侧边栏叫 AI 娘）。

---

## 2026-10-24 第二批：挂件联动 + 日记可配置

### 新功能
- **设置页最底部加「和挂件（鲸鱼娘）的联动」卡**：显示挂件装没装、开没开，能一键打开（`POST /pet/enable`）；
  下面挂一个**默认折叠**的「亲密度」编辑器（`+1 / +10 / +100 / -10 / 归零 / 直接填数字`），上限 999999999。
  折叠状态下**一个请求都不发**（有测试钉住），点开才读。
- **刷小鱼干**：同一张卡里写数量（上限 999，pet 自己的上限）。
- **日记执笔模型可配**：自动 / 官方 DeepSeek / 账号里任一条 DeepSeek；默认「自动」= 本机默认 DeepSeek 路由，
  换非 DeepSeek 会被打回并说明原因。
- **日记标题和结尾带日期**：标题 `# 2026年10月24日`、结尾 `—— 2026年10月24日`；
  frontmatter 的 `date:` 保持 ISO（程序要解析，两者不混）。

### 行为变更
- **每天 21:00 切日**：21:00 之前算当天，21:00 之后算第二天；21:00 定时那篇写「刚刚结束的那一天」
  （`2026-10-24 21:00` 触发 → 写 `2026-10-24`，不是 25 号）。
- **写入顺序**：先改记录文档（`AI娘日记记录.md`）再写实际日记文件；记录文档里有待办理的事，下次写之前先看。

### 修复
- 改挂件亲密度/小鱼干时：先备份 `pet.json.bak` → 原子写 → 让 pet 重载 → 回读核对，任一步不对就还原，
  不会把皮肤/名字/游戏数据写丢（`src/affinity-store.mjs` 的单测钉住「除目标字段外整份 JSON 不变」）。
- 设置页「刷新统计」超时给到 15s（宿主要 8s 冷扫），不再出现「她写了但没写完」。

### 文档
- `README.md` 新增「日记这件事，四个最常被问到的」：记录文档不是日记、不需要记忆插件、归档的会话照样进日记、21:00 切日。

---

## [0.1.0] - 2026-10-24

### 本轮改动一句话

把「AI 娘写日记」这件事彻底重做了一遍：日记的设置和记录不再散落在多个文件里，
而是收拢到**一份你能看懂、也能手改的 Markdown 记录文档**；设置页也重做了；
挂件气泡改成实时贴着桌面上的「二次元宠物（dsh-pet）」走。顺手修了几个实测出来的 bug。

### 1. 日记改用「记录文档」作为唯一状态源（最重要）

以前日记的设置（开关、文件夹、时间、执笔）和「今天写了没」「最近写了哪几篇」分散在几处 JSON
和目录扫描里，出问题你改都没法改。现在全部收进一份 Markdown：

- 文件名叫 **`AI娘日记记录.md`**，放在你选的那个「日记本文件夹」里（桌面上的 `小肥鱼的日记本`
  之类）。没选文件夹之前，它先暂住在 `~/.dsh/plugin-data/AI娘日记记录.md`。
- 插件只靠一个很小的**指针文件**记住它放哪了：
  `~/.dsh/plugin-data/dsh-ai-waifu-diary.json`，内容只有一行
  `{"schema":2,"docPath":"…记录文档的绝对路径…"}`。
- 插件写任何东西都遵守一条铁律：**先写记录文档，再动真实的日记文件**。这样哪怕写到一半崩了，
  你也不会看到「文件夹里多了半篇日记，但记录说没写」。
- 文档里有五段（详见 README「记录文档是什么」一节）：只有「一、设置」你该碰，其余四段是程序
  自己维护的，手改会被下一次写入覆盖，并且插件会认出来提示你。

### 2. 设置页重做（日记相关那一块）

- 重新排成了几张分区卡片：状态 / 她是谁 / 日记本 / 什么时候写 / 谁来写 / 今天 /
  最近写过的 / 记录文档是什么 / 出问题了怎么办。
- 异常状态不再丢一句英文，而是用大白话：
  - 日记本文件夹找不到了 → 黄色卡片，给你「更换文件夹 / 重新建一个」两个按钮；
  - 时间填错（比如 `25:00`、`9点`）→ 红字提示 4 秒，不偷偷改你的输入；
  - 正在写 → 灰字「她正在写…」；写失败 → 白话（含错误码）+「再试一次」；成功 → 绿色内联提示 4 秒，不弹 toast。
- 首屏不再傻等「扫一遍今天聊了什么」才出页面：打开设置页只读一份记录文档快照，
  今天的统计是「刷新统计」按钮才去算的（最多轮询 20 轮，每轮 1.5 秒）。
- 日记本被改名 / 挪走后，插件会在上一级目录里找带身份标记的本子，**自动认回**并温和提示
  「已自动认回：<新位置>」；如果你觉得认错了，点「不是我那个」就能否决，而且 10 分钟内不会再自动认。

### 3. 挂件气泡实时「跟手」（依赖 dsh-pet）

- 以前气泡每 5 秒读一次宠物的位置文件，宠物一拖、一走，气泡要等最多 5 秒才跟上来。
- 现在改成每帧直接量桌面上「二次元宠物（dsh-pet）」立绘的位置，位移超过 1 像素且间隔 ≥120ms
  才更新，气泡基本贴着宠物走。
- **前提：你装了 dsh-pet（桌面宠物）插件**。没装 dsh-pet 时：量不到立绘 → 退回读 `/pet` 接口
  （每 2 秒一次）→ 还读不到就落在屏幕右下角默认位置（距右边和下边各 20px、160×160）。
  气泡**永远不会消失、也绝不报错**，只是可能不贴着任何宠物。
- 页面切到后台（标签页隐藏）时停止测量，回到前台立刻重新对齐。

### 4. 修掉的 bug

- **台词关闭后还在空转**：以前关掉台词气泡后，后台仍每 400ms 打一次桥，白白耗连接。现在改成
  关闭后 3 秒起步、每次 ×1.8、封顶 15 秒的退避；打开时立刻 400ms 问一次。
- **桥请求一刀切 4 秒超时**：以前所有桥请求都只给 4 秒，写日记这种要 20–90 秒的请求会被误杀。
  现在分档：`/diary/write` 给 180 秒、`/diary/pick-dir` 给 300 秒、其余默认 4 秒；超时不静默，
  会明确告诉你「写了但没写完（超时），可以再试一次」。

### 迁移说明（老用户无感）

- 如果你之前用过老版本，老的设置文件 `dsh-ai-waifu-diary.json`（里面是 `enabled/dir/time/
  diarist/writtenDates`）会在第一次打开时被**自动迁移**进记录文档，并且原文件会被原样备份成
  `dsh-ai-waifu-diary.v1.json.bak`（只有一份，不删你的旧文件）。迁移过程不猜路径、不偷偷换你的
  日记本位置。
- 身份标记文件 `.dsh-ai-waifu-diary-root.json`（点开头，Finder 默认看不见）会被补进日记本文件夹，
  用来支持上面的「改名自动认回」。删掉它不影响已有的日记，只是以后再改名就得手动重选一次。

### 验证

- 标准自检（仓库根 `AI娘化插件/probe` 目录里跑）：`npm run verify`
  （= 素材同步检查 + 构建产物检查 + 全部测试，提交前必须全绿）。
- 构建产物与源码同步检查：`npm run build:check`（已验证通过）。
- 注：本轮交付时，整仓 `npm run verify` 因宿主半代码还在收尾（`index.js` 一个变量重复声明的语法错）
  暂时是红的，与本插件文档/浏览器半改动无关，待 maker-host 合并后恢复。

---

# 附录：改名前的开发期记录（0.5.x，未发布到 npm）

> 下面这份是项目还是 `dsh-ai-waifu` 时期的变更流水，版本号体系（0.5.x）与现在的
> 公开发布号（0.2.1 起）**不是一套**，只作历史留档。内容原样保留。
>
> ⚠️ 阅读时注意：这段历史里提到的 `docs/` 下那些文件（设计方案、审计报告、交接文档、
> 日记口气样张等）**已经从公开仓库移除**，因为它们属于内部工作记录、与代码和用户说明无关。
> 这里保留原文是为了不篡改历史，但那些链接指向的文件在仓库里已经不存在了。

本文件只记「已经落地并验证过」的事。没验证的不写。

## [0.5.2] - 2026-10-23

- 设置面板可见性：新增 `settings.section` 一条（id `ai-waifu-settings-page`，order 140，label「AI 娘」），
  用户从「设置」第一层就能直接进，不用再在插件列表里翻到详情页；`PluginSettings` 增加 `forceShow`，
  两处座位共用同一份 UI。
- 自绘挂件彻底删除：`WaifuArt` / `waifuEye` / `waifuMouth` / `WAIFU_*` / `exports.art` / 立绘测试全部移除，
  测试改为反向守门（出现 `WaifuArt` 或 `WAIFU_` 即失败）。右下角归 `@linxin666/dsh-pet`。
- 台词气泡：字号改为固定 `14px`（此前 `14 * bubbleScale`，scale=2 时 28px 装不下）、
  `maxWidth` 收为 `Math.min(340, 240 * scale)`；设置页选目录按钮在已选目录时显示「更改文件夹」。
- 设置页提速：读不到状态时用出厂值先渲染（不再被一个 `/state` 请求卡死）、2.5 s 后给提示、
  失败后释放 `flagStore.loading` 允许重试；长轮询 15 s→8 s、宠物位置 1.5 s→5 s、页面隐藏时不发请求。
- 日记：`GET /diary` 默认不算当天统计（`?today=1` 才算）+ 30 s 缓存，面板两段式加载。
- 日记口气第三版：禁短句成段、禁自我判断/概括、禁反讽留白、禁每段金句收尾，改用絮叨口语与小孩式比喻；
  样张 `docs/示例-日记-第三版.md`。
- **事故与修复**：上一轮删立绘色常量时误删了相邻的 `CLIENT_DEFAULT_FLAGS` 与 `CARD_ACCENT`，
  真机表现为 `ReferenceError: CLIENT_DEFAULT_FLAGS is not defined` → `dsh-ai-waifu: import failed`，
  整个浏览器半不加载。已恢复两个常量，并新增守门测试「模块级常量必须存在且先于引用」。
  插件条目同时从 loader 掉落（`unknown-plugin`），用 `set_bundle target:'dsh-ai-waifu'` 恢复。
- 基线：**333 tests / 333 pass / 0 fail**。

## [0.5.1] - 2026-10-23

### 设置页「正在读取开关状态……」卡住两分钟（用户实测）

- **根因**：整页 gate 在一个 `/state` fetch 上。而我们的常驻轮询（台词长轮询 15 s + 宠物位置 1.5 s）
  在浏览器里各占一条连接——HTTP/1.1 每个 host 只有 6 条，开两个窗口就能把设置页的请求挤到队尾。
  再加上 `flagStore.loading` 一旦失败/超时不会放掉，那一个 promise 会永久占位，之后永远不重试。
- **修法（四条一起）**：
  1. **乐观渲染**：读不到也用出厂值把界面画出来；`READ_SLOW_MS = 2500` 之后补一句
     「宿主那边还没回来，下面是出厂默认值」，点击开关会触发重试。
  2. **`flagStore.load()` 放掉 loading**：完成或失败都把 `loading` 置空，允许重试。
  3. **少占连接**：`LINES_POLL_WAIT_MS` 15000 → 8000，`PET_POLL_MS` 1500 → 5000。
  4. **后台标签页不轮询**：`document.hidden` 时只做 `HIDDEN_POLL_MS = 4000` 的空转心跳，切回来再继续。
- 实测：宿主侧 `/state` 连续三次 **0.01 / 0.00 / 0.00 s**，`/debug` 仍 `stage: ready`。
- 新增两条守门测试：「设置页不许被一个 fetch 卡死」「常驻轮询不许把连接池占满」。基线 **332**。

## [0.5.0] - 2026-10-23

### 删掉自绘形象（用户：「你把你画的插件形象给删掉」）

- 删除设置页那张 `WaifuArt` 立绘插图，连带 `WAIFU_*` 色常量、`waifuEye` / `waifuMouth`、
  `exports.art` 与 `tests/waifu-art.test.mjs`。右下角那位只归 dsh-pet，插件不再画任何形象。
- 测试反过来守：`client.js` 里出现 `WaifuArt` 或 `WAIFU_` 即失败。

### 语气再加强一档

- `VOICE_SECTION` 新增六条：浓度给足别收着（宁可过一点也不淡成白水）、句子要短要口语、
  **助手腔固定说法黑名单**（「建议您先」「需要注意的是」「综上所述」「希望对你有帮助」…
  一律换成她的说法）、情绪要露在字面上、不许端着排比（禁「首先/其次/最后」骨架）。
- `THINKING_VOICE_SECTION` 新增两条：心里反应要有起伏（咦？／啊——／原来是这样！）、
  思考的情绪浓度和回答一样不许收着。

### 日记设置读取变快（用户：「读取日记设置太慢了，加载的」）

- `GET /diary` 默认**不再**扫当天会话（要解压几百个日志，实测 **1.85 s**），只在 `?today=1` 时算；
  `diaryTodaySummary()` 加 30 秒缓存。
- 浏览器半改两段式：先拿配置（**0.00 s**）把面板画出来，统计单独再拉一次，副行显示「正在数今天的对话…」。
- 实测：`/diary` 0.00 s，`/diary?today=1` 1.85 s（首次），面板不再白等。

### 小修

- 「选文件夹」按钮：已经选过目录后文案变成「更改文件夹」。
- 台词气泡字号从 `14 × bubbleScale`（比例 2 时 28px，对话框装不下）改回固定 **14px**，
  最大宽度 `min(340, 240 × scale)`。
- 测试基线 **330**（删掉 5 条立绘测试）。

## [0.4.2] - 2026-10-23

### 设置面板挪到能看见的地方（用户：「在设置界面没看到你这个插件……怎么改？我一点都不知道」）

- 新增 `settings.section` 注册：**设置 → AI 娘**，第一层就能点开，不用再走「设置 → 插件 → 找到 dsh-ai-waifu → 打开详情」四层。
- `PluginSettings` 增加 `forceShow` 分支，与插件详情页那一份共用同一套 UI（语气 / 中文思考 / 日记面板 / 立绘说明）。
- 老的 `plugins.detail.section` 入口保留（`id: 'ai-waifu-settings'`），两个座位都能改。
- 新增测试「设置面板第一层有「AI 娘」一页」，断言 `slots.inject('settings.section'`、`id: 'ai-waifu-settings-page'`、`label: 'AI 娘'`、`forceShow`、`DiaryPanel` 都在。

### 日记口气第三版（用户：「这语气不像小女孩在写日记，像有个成年人在模仿鲁迅的文风」）

- `buildDiaryPrompt` 增加硬禁清单：一句一段往下砸、反讽/克制/留白、对自己下判断下概括、每段留一句意味深长的话。
- 正向要求改成小孩的写法：一句一句连着说、可以很长、可以重复、可以改口（「我是说……不对，我是说」）、情绪直接说、比喻只用家里见过的东西、口头语（呜/欸/咦/才不是/好耶）。
- 用户点名的那句直接当反例写进 prompt（✗ 成年人模仿鲁迅 / ✓ 那个小孩自己说的话），长度收紧到 300–700 字。
- 真机复跑：670 字，`docs/示例-日记-第三版.md`。
- 测试基线 **335**。

## [0.4.1] - 2026-10-23

### 改
- **日记口气重写**（用户 m02201：「语气还是太冰冷了……你现在这个日记就是工作日志复制过来转述了一下」）。
  `buildDiaryPrompt` 不再要求"总结今天"，改成"让一个小女孩把今天讲给日记本听"：先想我是谁（八九岁、怕被说不够聪明、被叫大肥鱼先抗议半句再认了）、今天哪几件小事有感觉、怎么讲给日记本听；
  八条硬要求里明确禁止成绩单式写法（"今天完成了 X，修复了 Y"）、待办式结尾（"需要你决定"）、清单/升华收尾（"总结""期待明天"）、文件名/路径/token/版本号；要求多用比喻但别每句都套、允许跑题再拐回来、结尾落在具体的、小小的感觉或一句傻话。
  摘要行也改了：`用户` → `主人`、`她` → `我`，并且**不再带 `（provider/model）`**（模型名一进日记就被原样抄进正文）。
- **执笔不许动手**：真机 timeout 暴露子代理默认带全套工具，收到「写日记」先去翻文件。
  提示词加第 9 条「不要再调用任何工具、不要读文件、不要写文件——你只有一个动作：把这篇日记写出来」。改完 64 秒出稿。
- 提示词守门测试加两条（`不要再调用任何工具`、`不要读文件`）。

### 产物
- `docs/示例-日记-新口气.md`（改后真机产物，1011 字）；旧版留作 `docs/示例-日记-旧口气.md`。

## [0.4.0] - 2026-10-23

日记功能（D1–D5 全部落地）：

- **读取层** `probe/src/diary-source.mjs`：扫 `$DSH_HOME/sessions`，只取当天 `user/message` 与 `assistant/message`，单条截 400 字、全天压缩到 12 万字符；按 `usage.outputTokens` 汇总出「今天哪个模型写得最多」。修掉两个真 bug：会话目录其实是**两层**（`<workspace>/<session>`）；宿主 Node v24 的 `zlib.zstdDecompressSync` **只解第一帧**，而会话日志是追加写多帧的 → 按魔数切帧逐帧解（症状是「96 个会话目录、今天 0 条记录」）。
- **执笔层** `probe/src/diary-writer.mjs`：拼启动请求、只认 DeepSeek 执笔、剥 markdown 围栏、四类硬校验（空／太短／太长／自我指认「作为 AI」）。
- **落盘层** `probe/src/diary-store.mjs`：`<日记本>/YYYY-MM-DD.md`，同名先写 `.bak` 再覆盖；备份失败就放弃这次写入（宁可这次不写，也不能盖掉旧日记）。
- **宿主接线**：`GET/POST /api/dsh-ai-waifu/diary`、`POST /diary/write`（起一次性子代理 → 从它自己的会话日志收正文）、`POST /diary/pick-dir`（借宿主的目录选择器）。写日记逻辑抽成 `writeDiaryNow(ctx)`，路由与定时器共用，**永不 throw**，全部回 `{ok:false, code, message}`。
- **定时**：`ctx.timer.interval` 每分钟比对配置里的 `HH:MM`，到点且当天没写过才写；`writtenDates` 台账保证同一天只写一次（休眠、改时间、手动写都不会重复）。
- **界面**：设置页新增「写日记」面板——开关、日记本文件夹（选文件夹按钮）、几点写、谁来写（自动＝当日 token 最多，也可指定）、现在就写。每个失败码都有中文话术（「写日记最难受的形态是没反应」）。
- 示例产物：`docs/示例-日记-旧口气.md`（旧 prompt 跑出来的一篇，1307 字，含 frontmatter 与 `.bak`；口气已被 0.4.1 重写，留作对照）。

测试基线：328 pass / 0 fail（新增 diary-source 24、diary-writer 17、diary-store 20、bridge-routes 15、DiaryPanel 1）。

## [0.3.0] - 2026-10-23

### 新增：日记层 D1–D3（纯逻辑已全绿，宿主接线与界面还没接）

需求来自用户：默认关闭；打开后指定一个文件夹当日记本；AI 根据当天的记忆写日记；
执笔默认是当日输出 token 最多的 AI，也可以手动指定；只支持 DeepSeek。

- `probe/src/diary-source.mjs`（D1 读取层）：扫 `$DSH_HOME/sessions/<workspace>/session-*/session.v4.jsonl.zstd`，
  解压后只取 `user/message` 与 `assistant/message`（**不读 `tool/result`**：噪音 + 隐私），
  单条截 400 字、全天 ≤12 万字符；按 `data.usage.outputTokens` + `message.source.{provider,model}`
  汇总出「当日输出 token 最多的 DeepSeek」，再拼成给执笔模型看的摘要。
  日界按本地时区左闭右开。解压直接用 Node 自带 `zlib.zstdDecompressSync`（Node v26），不引第三方依赖。
- `probe/src/diary-writer.mjs`（D2 执笔层）：`buildActivationRequest`（拼 `startActivation` 的 request 形状）、
  `checkDiaristSupported`（非 DeepSeek 明确拒绝，不偷偷换人）、`tidyDiaryBody`（拆围栏、去模型自加标题）、
  `validateDiaryBody`（空 / <80 字 / >8000 字 / 「作为 AI」自我指认 四类硬失败）、`renderDiaryFile`（frontmatter + 正文）。
- `probe/src/diary-store.mjs`（D3 落盘层）：配置形状 `{enabled,dir,time,diarist,writtenDates}`，
  非法时间回落 21:00、`writtenDates` 只留合法日期（当天幂等台账不能被脏数据污染）；
  **同名文件先写 `.bak` 再覆盖，备份失败就放弃这次写入**（宁可不写，也不能盖掉用户原来的日记）；
  列表按日期倒序、`*.bak` 不进列表。
- 测试：新增 `tests/diary-source.test.mjs`(21) / `tests/diary-writer.test.mjs`(17) / `tests/diary-store.test.mjs`(20)，
  基线 **309 pass / 0 fail**。

## [0.2.1] - 2026-10-22

### 修复：台词气泡不跟着挂件走

用户实测反馈（逐字）：「挂件可以移动，但是语言气泡并不跟着移动，且固定在右下角对话框上边一点点」。
根因：气泡挂在 `conversation.input.dock`（输入框上方的整宽槽），位置由输入框布局决定，
和 dsh-pet 那只鲸鱼娘没有任何关系——挂件被拖到哪儿，气泡都钉在原地。

改法（两层，因为**会话 id 只有 session 作用域给，贴合挂件只有 root 作用域做得到**）：

- `LinesSessionBridge`（留在 `conversation.input.dock`，渲染 null）：把 `sessionId` 递到模块变量，
  overlay 里的气泡才拿得到会话，不串台；
- `LinesBubbleOverlay`（新注册到 `shell.overlay`，id `ai-waifu-lines-bubble`，order 55）：
  1.5 秒轮询新路由 `GET /api/dsh-ai-waifu/pet`（读 `$DSH_HOME/pet.json` 的 `display`：
  `size/right/bottom/bubbleScale`），按「`bottom + size + 6`」贴在宠物头顶。拖一次挂件，气泡跟一次。

### 新增：颜文字

用户要求「台词和语气（即思考过程和回复里）可以加一些颜文字之类的」。分两处落地：

- **语气**：`src/persona-text.mjs` 的「声音」节和「思考口径」节各加一条颜文字规矩
  （一条回答最多一个、放语气最浓那句末尾、代码/命令/报错/路径/表格里一个都不许放；
  思考里最多一两个）。仍然是逐字节恒定段，不进任何随机。
- **台词**：`src/voice-lines.mjs` 新增 `KAOMOJI` 与 `decorateLine()`，约 35% 的台词在句尾挂一个。
  **用句子哈希决定挂不挂、挂哪个**，不用 `Math.random()`——同一句话永远同一个结果，
  刷新不跳、可单测；句子里已经有表情的不叠第二层；去重仍按原句算（颜文字不能骗过去重）。

### 设计

- 新增 `docs/设计方案-日记v1.md`：21:00 默认触发、可改时间、只支持 DeepSeek、
  默认执笔＝当日 outputTokens 最多的模型（可指定）。含数据来源口径、文件格式、
  失败路径、D1–D5 分阶段，以及三个要用户拍板的问题。

### 测试基线

`cd probe && npm run verify` → **251 pass / 0 fail**（新增颜文字 2 条、气泡跟随 2 条）。

## [0.2.0] - 2026-10-22

### 新增：台词层（把她的嘀咕放进会话框）

用户定的方向：「把 AI 在思维链里面的一些思考过程和语气词直接放到会话框里面」——
不另写台词库，直接摘模型**本来就会产生**的推理文字。零额外 token。

- 宿主半 `src/voice-lines.mjs`：`tidyLine` / `isSpeakable` / `scoreLine` / `splitCandidates` /
  `extractLines`（切句、去技术味、按语气词打分）+ `createLineFeed`（每会话环形缓冲 40 条、
  同句 20 分钟不重复、相邻推送间隔 ≥1.5 秒、长轮询最长 15 秒且永不 reject）。
- 宿主半订阅 `agent/assistant-stream`：只在 **agent 自己的 ctx** 上订阅（避免收到子代理的推理），
  把 `reasoning-delta` 增量拼成句子后入队；热重载时先拆旧监听器，否则同一句会入队两次。
- 新路由 `GET /api/dsh-ai-waifu/lines?sessionId=&cursor=&wait=`：`sameOrigin` 校验、
  开关关着立刻回空（不让浏览器白等 15 秒）。
- 浏览器半 `LineBubble`：注册到 `conversation.input.dock`（session 作用域，输入框上方），
  一次只冒一句、5 秒淡出、`pointerEvents:'none'`、失败静默重试。
- 输入框那排加第三颗胶囊「台词」，默认**开**（不花钱、不改提示词）；开关写盘 payload
  补上 `lines`（原来只发两个键，这颗胶囊会点了没反应的）。
- 存储版本 `v3 → v4`（新增 `lines`）。

### 修复

- `splitCandidates` 原来用 `split` 吃掉句末标点，「诶？」被切成一个「诶」再被长度下限砍掉——
  最像人嘀咕的那句恰好永远出不来。改成 lookbehind 切分，标点留在句尾。
- 单字语气词（嗯/诶/唔）现在放行：原来一律按 2 字下限丢掉。
- `tidyLine` 清掉落单引号（实跑里出现过 `"嗯` 这种半个引号开头的台词）。

### 测试基线

`cd probe && npm run verify` → **248 pass / 0 fail**（新增 `tests/voice-lines.test.mjs` 13 条，
`build-output.test.mjs` 加两条锁「台词气泡长轮询/不挡点击」「写盘 payload 必须带 lines」）。

## [0.1.0] - 2026-10-22

### 修复

- **语气（人设注入）在真实会话里完全不生效**：`apply(ctx)` 原来在插件加载那一刻
  `ctx.get('systemPrompt', false)`，而 App 重启时该服务尚未就绪，整个提示词层被静默跳过
  （`/debug` 的 `stage` 停在 `no-system-prompt`）。改为 `ctx.inject(['systemPrompt','sessionProjections'], …)`
  等宿主服务就绪后再注册。
- **插件热重载后既有会话永远拿不到人设段**：`agent/created` 只在建会话时发一次，
  重载会 dispose 掉旧监听器。新增对既有 agent 的补注册（`ctx.get('agents').list()`）。
- **热重载时旧段落拆不掉**（人设段注册在 agent.ctx 上，生命周期跟 agent 不跟插件）：
  新增跨实例段落登记表 `globalThis.__dshAiWaifuSections`，注册前先拆旧段。
- `POST /api/dsh-ai-waifu/session` 先取快照再写盘，响应里的 `effective`/`sources` 是改之前的状态。

### 新增

- 诊断路由 `GET /api/dsh-ai-waifu/debug`（`sameOrigin` 校验、只读）：`stage` / `stageError` /
  `attached[]` / `live[]`，排查「开了没效果」先看它。
- 立绘 `WaifuArt`（内联 SVG，六表情 pose）与配套测试 `tests/waifu-art.test.mjs`；
  预览图 `docs/preview-立绘六表情.png`。（自绘挂件方向已于同日废弃，见下方「决策」。）
- 接线测试 `tests/plugin-wiring.test.mjs`：用 mock 宿主真实挂载 `apply()` 并调用 `text()`，
  覆盖「热重载必须先拆旧段再注册」。

### 变更（砍挂件已落地，不只是决定）

- 2026-10-22：**砍掉自绘挂件**，改为兼容 `@linxin666/dsh-pet`，本插件只提供 voice-pack 台词层
  与语气/开关。`docs/设计方案v3.md` §四 已标注废弃。
- 浏览器半：删除 `Overlay` / `LiveWaifu` / `WaifuView` 三个组件与 `shell.overlay` 注册；
  不再内联台词库（`const LINES`）、台词引擎、气泡排布、拖拽模块，`client.js` 从 172 KB 降到
  约 40 KB。立绘 `WaifuArt` 保留，改为**插件详情页里的插图**（说明这只鲸鱼娘是 dsh-pet 画的）。
- 输入框那排从三颗胶囊改成两颗：**语气 / 中文思考**（「挂件」胶囊随挂件一起删除）。
- 宿主半：`widget` 这个 flag 从 `FLAG_KEYS` / `DEFAULT_ENABLED` / 会话表里彻底删除；
  存储版本 `v2 → v3`，启动时自动把旧的 `widget` 键清掉并落盘。
  旧版页面（缓存里的 client.js）再提交 `{widget:…}` 会被 **400 `retired-flag`** 拒绝，
  而不是静默接受假装成功。
- 写盘失败不再静默：`WRITE_FAILED` 文案 + 回滚到点击前状态 + 输入框显示「未保存」，
  设置页显示具体原因（code-auditor B1：以前是 `catch(() => {})`，界面永远显示「开」而宿主是「关」）。
- 调试：`/api/dsh-ai-waifu/state` 的 `value` 现为 `{version:3, defaults:{persona,thinking}, sessions, flags, sessionFlags}`
  （`widgetSource` 字段随 widget 一起删除）。

### 测试基线

`cd probe && npm run verify` → **232 pass / 0 fail**（0.2.0 之后是 248）。

