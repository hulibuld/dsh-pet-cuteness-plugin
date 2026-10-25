import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/* 构建产物冒烟测试。
   目的不是测业务逻辑（那些在各自文件里），而是确认三件事：
     1. client.js 能被浏览器的模块加载器吃下去（语法正确、CJS 包装正确）；
     2. 内联进去的纯逻辑真的可用（不是被 transform 弄坏了）；
     3. 台词库真的内联进来了（不是空壳）。 */

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

/** 在假浏览器环境里加载 client.js，返回它导出的模块。 */
function loadClient() {
  const code = readFileSync(CLIENT, 'utf8')
  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
  }
  let captured = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        captured = factory((name) => {
          if (name === 'react') return fakeReact
          throw new Error(`client.js require 了不该 require 的包：${name}`)
        })
      },
    },
  }
  new Function('window', code)(fakeWindow)
  assert.ok(captured, 'factory 没有被调用，说明 client.js 的包装坏了')
  return captured
}

test('client.js 能被加载，并导出 apply / inject', () => {
  const mod = loadClient()
  assert.equal(typeof mod.apply, 'function')
  assert.ok(Array.isArray(mod.inject), 'inject 必须是静态数组')
  assert.deepEqual(mod.inject, ['slots'])
})

/* 事故（2026-10-23 真机）：删立绘色常量时把相邻的 CLIENT_DEFAULT_FLAGS / CARD_ACCENT
   一起吞了。本地 330 条测试全绿，用户在真机刷新时才炸
   ReferenceError: CLIENT_DEFAULT_FLAGS is not defined → dsh-ai-waifu: import failed。
   教训：字符串断言查不出「常量定义没了但引用还在」，必须专门守这两行，并且要求定义
   出现在第一次引用之前。 */
test('浏览器半的模块级常量必须存在且先于引用', () => {
  const code = readFileSync(CLIENT, 'utf8')
  for (const decl of ['const CLIENT_DEFAULT_FLAGS = { persona: false, thinking: false }', 'const CARD_ACCENT = {']) {
    const at = code.indexOf(decl)
    assert.ok(at >= 0, `缺定义：${decl}`)
    const name = decl.slice('const '.length).split(' ')[0].split('=')[0].trim()
    const firstUse = code.search(new RegExp(`\\b${name}\\b`))
    assert.ok(firstUse <= at, `${name} 的第一次出现早于定义（说明定义被删/被挪到后面）`)
  }
})

test('client.js 只 require react，不碰任何 @deepseek-ai/dsh-client-*', () => {
  // 上面的 loader 会对任何非 react 的 require 抛错；跑到这里说明没碰。
  assert.doesNotThrow(() => loadClient())
})

test('内联的纯逻辑可用：normalizePersonaId', () => {
  const { core } = loadClient()
  assert.equal(core.normalizePersonaId('deepseek', 'deepseek-v4-pro'), 'deepseek')
  assert.equal(core.normalizePersonaId('anthropic', 'claude-sonnet-4'), 'claude')
  assert.equal(core.normalizePersonaId('nope', 'nope'), 'generic')
})

test('内联的纯逻辑可用：toggleFlag 能翻开关（浏览器半还剩的唯二能力之一）', () => {
  const { core } = loadClient()
  assert.deepEqual(core.toggleFlag({ persona: false, thinking: false, lines: true }, 'persona'), {
    persona: true,
    thinking: false,
    lines: true,
  })
  assert.match(core.describeFlags({ persona: true, thinking: false, lines: false }), /人设语气/)
})

test('台词引擎不再进浏览器半（挂件已砍，引擎与 1987 句留在宿主侧喂 voice-pack）', () => {
  const { core } = loadClient()
  assert.equal(core.createSpeechEngine, undefined, '台词引擎不该再被内联进 client.js')
  assert.equal(core.bucketFromUserMessage, undefined, '气泡分桶函数不该再被内联')
})

test('台词库不再内联进浏览器半：产物显著变小，且不含台词正文', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(!code.includes('诶？我在的。'), '台词正文不该再出现在 client.js 里')
  assert.ok(!code.includes('const LINES ='), '台词常量不该再被内联')
  // 砍掉台词库后产物约 60KB；2026-10 重做设置页（分区卡片 + 白话文案 + 一日志记录文档
  // 快照）与跟手气泡（rAF 采样）之后约 96KB。2026-10-24 又加了小鱼干（读/写/步进/白话
  // 错误码）、帮助卡四条问答和一组样式常量，涨到约 132KB。仍远小于含台词库的 172KB，
  // 所以阈值放到 150KB——这条守的是「别再内联台词库」，不是守具体体积。
  assert.ok(code.length < 150_000, `client.js 不该膨胀回台词库时代，现在是 ${code.length} 字节`)
})

test('自绘挂件不许回来（shell.overlay 只准放台词气泡，不准放角色）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  // 2026-10-22 决策：角色由 dsh-pet 出镜。shell.overlay 里只剩「贴着她头顶的台词气泡」，
  // 一旦 self-drawn 的 WaifuView / LiveWaifu / Overlay 回来，右下角就是两只角色、两套气泡。
  assert.ok(!code.includes('function Overlay'), '自绘挂件组件必须真的删掉，不是不注册而已')
  assert.ok(!code.includes('function WaifuView'), '自绘挂件视图不许回来')
  assert.ok(!code.includes('function LiveWaifu'), '接会话消息流的挂件不许回来')
  const overlayIds = [...code.matchAll(/slots\.register\(\s*\{\s*name: 'shell\.overlay',\s*id: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(overlayIds, ['ai-waifu-lines-bubble'], 'shell.overlay 里只准注册台词气泡这一个')
})

test('四个槽位都在：输入框开关 + 台词气泡 + 插件详情页 + 设置第一层', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes("id: 'ai-waifu-toggles'"), '输入框那颗开关必须还在')
  assert.ok(code.includes("id: 'ai-waifu-settings'"), '插件详情页必须还在')
  assert.ok(code.includes("id: 'ai-waifu-lines'"), '台词气泡必须注册')
  assert.ok(
    code.includes("slots.inject('conversation.input.dock'"),
    '台词必须挂在输入框上方的 dock，挂 shell.overlay 会串会话',
  )
  assert.match(code, /order:\s*40/, '输入框开关要有显式 order')
})

/* 用户原话：「在设置界面没看到你这个插件。所以，能不能改？怎么改？我一点都不知道」。
   日记目录/语气这些是随手要改的，埋在「设置 → 插件 → 找到它 → 详情」四层之下等于没有。
   所以必须另有一条 settings.section 注册，让「设置 → 大肥鱼的后台」直接能点开。 */
test('设置面板第一层有「大肥鱼的后台」一页（不许只藏在插件详情里）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(
    code.includes("slots.inject('settings.section'"),
    '必须注册到 settings.section，否则用户在设置里找不到',
  )
  assert.ok(code.includes("id: 'ai-waifu-settings-page'"), '设置页那一格的 id 必须是我们自己的')
  assert.ok(code.includes("name: 'settings.section'"), 'register 的 name 要与槽位一致')
  assert.match(code, /label: '大肥鱼的后台'/, '设置导航里显示的名字（2026-10-24 改名）')
  assert.ok(!/label: 'AI 娘化'/.test(code), '旧名字「AI 娘化」不许再出现在设置标签里')
  assert.ok(code.includes('function SettingsPage'), 'SettingsPage 包装组件必须在')
  assert.ok(
    code.includes('props.forceShow === true'),
    'settings.section 没有 subject，必须靠 forceShow 才画得出来',
  )
  assert.ok(code.includes('function DiaryPanel'), '设置页里要有日记面板')
  // 面板顶部那行小字：一句话说清这页是干什么的。
  assert.ok(code.includes('这是大肥鱼的后台；日记与挂件都在这一页管。'), '面板顶部要有一行小字说明')
})

test('输入框三颗胶囊：语气 + 中文思考 + 台词（没有「挂件」）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bar = code.slice(code.indexOf('function ToggleBar(props)'), code.indexOf('function PluginSettings(props)'))
  assert.ok(bar.includes("label: '语气'"), '要有语气胶囊')
  assert.ok(bar.includes("label: '中文思考'"), '要有中文思考胶囊')
  assert.ok(bar.includes("label: '台词'"), '要有台词胶囊')
  assert.ok(!bar.includes('toggleWidget'), '不许再有 toggleWidget')
  assert.ok(!bar.includes("'widget'"), 'ToggleBar 里不该再出现 widget')
})

test('写盘失败必须看得见（回滚 + 提示，不许静默 catch 成"看起来生效"）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes('WRITE_FAILED'), '要有统一的失败文案常量')
  assert.ok(code.includes('未保存'), '输入框那排要有可见的失败标记')
  const bar = code.slice(code.indexOf('function ToggleBar(props)'), code.indexOf('function PluginSettings(props)'))
  assert.ok(bar.includes('setState(before)'), '写失败必须回滚到点击前的状态')
  assert.ok(bar.includes('catch((error) =>'), 'catch 必须拿到 error 并记录，不能空 catch')
})

test('设置页保留立绘预览（好歹让用户看见她长什么样）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const settings = code.slice(code.indexOf('function PluginSettings(props)'))
  // 用户 2026-10-23：「你把你画的插件形象给删掉」。所以这条反过来了：
  // 自绘形象一律不许回来（挂件早就砍了，设置页那张插图也删了）。
  assert.ok(!settings.includes('WaifuArt'), '自绘立绘已按要求删除，不许回来')
  assert.ok(!settings.includes('WAIFU_'), '立绘的色常量也该一起删干净')
  assert.ok(settings.includes('dsh-pet'), '设置页要说明这只鲸鱼娘是 dsh-pet 画的')
})

test('构建产物不往 document.body 追加节点（DSH 官方红线）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(!code.includes('document.body.appendChild'), '不得往 body 追加节点')
  assert.ok(!code.includes('createPortal'), '不得使用 portal 逃出 slot')
})

test('卸载清理接口存在（否则重装第一天就是哑的）', () => {
  const mod = loadClient()
  assert.equal(typeof mod.clearLocalState, 'function', '必须导出 clearLocalState')
})

test('本地状态集中在单个键，便于一键清除', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes("const PREFS_KEY = 'dsh-ai-waifu'"), '偏好应集中在单键')
  assert.ok(code.includes('removeItem'), '清理必须真的 removeItem')
})

test('安装契约：双半都能加载（缺一条浏览器半会静默不加载）', async () => {
  // 工程评审 D2 的原话：缺 exports["./client"] 或 dsh.client →
  // 浏览器半根本不加载，**而且不报错**。于是 M0 第 3 项验收必挂，
  // 而人会去查 shell.overlay，查一周也查不出来。
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['scripts/check-manifest.mjs'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  })
  assert.match(out, /安装契约自检通过/)
})

test('台词气泡：长轮询、只冒一句、关掉就不再拉、并且贴着她头顶', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bubble = code.slice(code.indexOf('function LinesBubbleOverlay'), code.indexOf('function apply(ctx)'))
  assert.ok(bubble.length > 0, 'LinesBubbleOverlay 必须存在')
  assert.ok(bubble.includes("'/lines?sessionId='"), '要打 /lines 路由，并按 sessionId 分桶')
  assert.ok(bubble.includes('LINES_POLL_WAIT_MS'), '要用长轮询（不能 1 秒一次刷屏）')
  assert.ok(bubble.includes('value.enabled === false'), '关掉台词后要清空队列，不能继续攒')
  assert.ok(bubble.includes('.catch(() => {'), '网络失败必须静默：台词不能变成错误提示')
  assert.ok(bubble.includes("pointerEvents: 'none'"), '气泡只是看的，不许挡住挂件和输入框的点击')
  // 用户实测：拖完挂件要等最多 5 秒气泡才对齐。现在改成量 dsh-pet 的 DOM（rAF 采样）。
  assert.ok(bubble.includes('usePetAnchor'), '气泡要按帧量立绘位置，不能靠 5 秒一次的 /pet 猜测')
  assert.ok(bubble.includes('planOverlay('), '贴头算法复用 core.planOverlay（测试过的纯函数）')
  assert.ok(bubble.includes('anchor.position') || bubble.includes("position: 'fixed'"), 'overlay 里的气泡要用 fixed 定位才能贴着挂件')
})

test('气泡样式跟 dsh-pet 统一，且节奏加密（用户两次返工的守门）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bubble = code.slice(code.indexOf('function LinesBubbleOverlay'), code.indexOf('function apply(ctx)'))
  // 用户原话：「点击挂件出来的是蓝色的气泡，字体很大。思考出来的是灰色对话框，字也很小。」
  // → 不能再用宿主层色的灰底，要跟 dsh-pet 一致的蓝黑玻璃 + 亮字。
  assert.ok(bubble.includes('rgba(19,28,54,0.94)'), '底色要照 dsh-pet 的蓝黑玻璃，不许退回灰色层色')
  assert.ok(bubble.includes('#f4f7ff'), '字色要跟 dsh-pet 一样是亮色')
  assert.ok(bubble.includes('rgba(126,152,255,0.45)'), '要有那圈深蓝描边微光')
  assert.ok(
    bubble.includes('fontSize: 14'),
    '字号固定 14px：用户反馈跟着 bubbleScale 走会太大、对话框都装不下',
  )
  // 用户原话：「两个气泡间间隔的时间太久了」。
  assert.match(code, /const LINES_SHOW_MS = 3200/, '一句只活 3.2 秒（原 5 秒，太慢）')
  assert.match(code, /\}, 450\)/, '取下一句的间隔要收到 450ms')
  assert.match(code, /const LINES_QUEUE_MAX = 10/, '队列要能攒到 10 条，别刚攒两句就被裁')
})

test('气泡本体不许被父容器宽度卡死（每行 3 个字的根因）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bubble = code.slice(code.indexOf('function LinesBubbleOverlay'), code.indexOf('function apply(ctx)'))
  // 用户实测：一句 20 字台词被压成每行 2–3 个汉字。
  // 定位容器宽度 = 立绘矩形（几十到一百多 px），本体 absolute + left:50% 且没写 width
  // 就会走 shrink-to-fit，被父容器 clamp。必须有显式 max-content。
  assert.ok(bubble.includes("width: 'max-content'"), '气泡要按文字自然宽度排，不能靠父容器给宽度')
  assert.ok(bubble.includes("boxSizing: 'border-box'"), 'maxWidth 要把 padding 算进去，右边缘才不出视口')
  assert.ok(bubble.includes('viewport.w - 16'), '窄窗口下 maxWidth 还要按视口再夹一道')
  // 量尺寸必须在文案渲染之后（布局已完成），否则量到的是上一句的宽度。
  assert.ok(
    /\[text, anchor \? anchor\.level : 0\]/.test(bubble) || bubble.includes('node.offsetWidth'),
    '气泡尺寸要按文案重新量（offsetWidth/offsetHeight）',
  )
})

test('会话 id 通过桥组件递给气泡（overlay 拿不到 sessionId）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bridge = code.slice(code.indexOf('function LinesSessionBridge'), code.indexOf('function LinesBubbleOverlay'))
  assert.ok(bridge.length > 0, 'LinesSessionBridge 必须存在')
  assert.ok(bridge.includes('publishLinesSession'), '必须把 sessionId 发到模块变量')
  assert.ok(code.includes("ctx.slots.register(\n          {\n            name: 'conversation.input.dock'") ||
    code.includes("id: 'ai-waifu-lines'"), '桥组件要挂在 dock 槽（session 作用域）')
})

test('台词开关的写盘 payload 必须带上 lines（否则永远存不下去）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const bar = code.slice(code.indexOf('function ToggleBar(props)'), code.indexOf('function PluginSettings(props)'))
  assert.match(bar, /lines:\s*next\.lines === true/, '写会话状态时漏掉 lines 会让这颗胶囊点了没反应')
})

/* 用户实测：「点击设置『AI 娘』一栏加载的太慢了。『正在读取开关状态...』加载了
   两分钟还没开出来。」根因是整页 gate 在一个 fetch 上。现在改成乐观渲染。 */
test('设置页不许被一个 fetch 卡死（乐观渲染 + 超时提示）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(!code.includes('正在读取开关状态'), '那句 loading 文案是把整页堵住的老写法')
  assert.ok(
    code.includes('const defaults = state ? state.defaults : CLIENT_DEFAULT_FLAGS'),
    '读不到也要用出厂值把界面画出来',
  )
  assert.ok(code.includes('READ_SLOW_MS'), '要有超时提示的阈值')
  assert.ok(code.includes('宿主那边还没回来'), '读太慢要明说是桥的问题，不是插件坏了')
})

/* 连接池是「每个 host 6 条」，常驻长轮询会把设置页的 /state 挤到队尾。
   所以：长轮询窗口变短、宠物位置放宽、后台标签页不发请求。 */
test('常驻轮询不许把连接池占满', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes('LINES_POLL_WAIT_MS = 8000'), '长轮询窗口要短（15s 太长）')
  // 位置改成量 DOM 之后不再需要 5 秒一次的 /pet；只有量不到立绘时才兜底轮询，
  // 而且间隔 2000ms 是下限（测试还会断言 PE 兜底常量的具体值）。
  assert.ok(!code.includes('PET_POLL_MS = 5000'), '5 秒一次的 /pet 轮询必须删掉（气泡跟手靠量 DOM）')
  assert.ok(code.includes('PET_FALLBACK_POLL_MS = 2000'), '量不到立绘时退回 2 秒一次的 /pet 兜底')
  assert.ok(code.includes('HIDDEN_POLL_MS'), '要能在后台停掉轮询')
  assert.ok(code.includes('document.hidden'), '用 document.hidden 判断可见性')
  assert.ok(code.includes("addEventListener('visibilitychange'"), '页面切后台/回前台要立刻停/恢复采样')
})

test('设置页有日记面板：四个控件 + 失败必须说出来', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes('function DiaryPanel'), '日记面板必须真的存在')
  assert.ok(code.includes('pick-dir'), '选文件夹必须走宿主的目录选择器')
  assert.ok(
    code.includes("'更改文件夹'"),
    '用户说的：已经选过文件夹了，按钮字要变成「更改文件夹」',
  )
  assert.ok(code.includes("'/diary/write'"), '「现在就写」必须调写日记路由')
  assert.ok(code.includes('empty-day'), '空日子要有自己的话术，不能只说"失败"')
  assert.ok(code.includes('执笔只支持 DeepSeek 模型'), '不支持的非 DeepSeek 执笔要说清楚')
})

/* ── 2026-10 重做：从产物里抠出纯函数，直接断言行为 ─────────────────────
   重做把「/diary 首屏」「台词退避」「气泡定位」都做成了纯函数/常量。下面的测试
   不靠字符串猜实现，而是把 client.js 里的函数源码抠出来在沙箱里跑一遍。 */

/** 抠出顶层函数源码（到行首的 `}` 为止）。 */
function functionSource(code, name) {
  const start = code.indexOf('function ' + name + '(')
  assert.ok(start >= 0, 'client.js 里找不到 function ' + name)
  // client.js 整个视图被包在 factory 里（带缩进），所以结尾要按同缩进的 `}` 找，
  // 不能写死 `\n}`——那会一路找到文件末尾。
  const lineStart = code.lastIndexOf('\n', start) + 1
  const indent = code.slice(lineStart, start)
  const end = code.indexOf('\n' + indent + '}', start)
  assert.ok(end > start, 'function ' + name + ' 的结尾找不到')
  return code.slice(start, end + 2 + indent.length)
}

/** 抠出 `const NAME = { ... }` 对象字面量（数花括号，跳过字符串里的花括号）。 */
function extractBlock(code, marker) {
  const start = code.indexOf(marker)
  assert.ok(start >= 0, 'client.js 里找不到 ' + marker)
  const open = code.indexOf('{', start)
  let depth = 0
  let quote = ''
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return code.slice(start, i + 1)
    }
  }
  throw new Error(marker + ' 不闭合')
}

const PURE_CONSTANTS = [
  'LINES_POLL_MS',
  'LINES_OFF_RETRY_MS',
  'LINES_MAX_RETRY_MS',
  'LINES_ERR_RETRY_MS',
  'LINES_ERR_MAX_RETRY_MS',
  'LINES_UNAVAILABLE_RETRY_MS',
  'LINES_BACKOFF_FACTOR',
  'PET_DEFAULT_SIZE',
  'PET_DEFAULT_EDGE',
  'PET_FALLBACK_POLL_MS',
  'PET_ANCHOR_OFFSET_Y',
  'PET_SAMPLE_MIN_INTERVAL_MS',
  'PET_SAMPLE_MIN_DELTA_PX',
]

/** 把常量和一组纯函数装进 Function 沙箱执行，返回它们。 */
function loadPure(code, functions) {
  const parts = []
  const names = []
  for (const name of PURE_CONSTANTS) {
    const match = new RegExp('^[ \\t]*const ' + name + ' = ([0-9.]+)$', 'm').exec(code)
    if (match) {
      parts.push('const ' + name + ' = ' + match[1])
      names.push(name)
    }
  }
  for (const fn of functions) {
    parts.push(functionSource(code, fn))
    names.push(fn)
  }
  parts.push('return { ' + names.join(', ') + ' }')
  return new Function(parts.join('\n'))()
}

/** 文案/状态/解释器：COPY + 出厂配置 + 四个纯函数。 */
function loadUiPure(code) {
  const parts = [
    extractBlock(code, 'const COPY = {'),
    extractBlock(code, 'const FACTORY_DIARY_CONFIG = {'),
    functionSource(code, 'explain'),
    functionSource(code, 'truncateText'),
    functionSource(code, 'summaryOf'),
    functionSource(code, 'formatStamp'),
    'return { COPY: COPY, FACTORY_DIARY_CONFIG: FACTORY_DIARY_CONFIG, explain: explain, truncateText: truncateText, summaryOf: summaryOf, formatStamp: formatStamp }',
  ]
  return new Function(parts.join('\n'))()
}

const DOC_ERROR_CODES = [
  'write-failed',
  'bad-dir',
  'dir-move-failed',
  'pointer-write-failed',
  'bad-time',
  'bad-flags',
  'disabled',
  'no-dir',
  'empty-day',
  'no-diarist',
  'unsupported-diarist',
  'no-subagents',
  'no-parent',
  'timeout',
  'bad-body',
  'busy',
  'cancelled',
  'no-picker',
  'internal',
]

test('explain() 覆盖 docs/重做方案.md 的全部错误码，且都是中文白话', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const { COPY, explain } = loadUiPure(code)
  for (const code of DOC_ERROR_CODES) {
    const text = COPY.problem[code]
    assert.equal(typeof text, 'string', '缺错误码文案：' + code)
    assert.ok(text.length >= 4, code + ' 的文案太短，用户看不懂')
    assert.match(text, /[\u4e00-\u9fa5]/, code + ' 的文案不是中文')
    const rendered = explain(new Error(code))
    assert.ok(rendered.includes(text), code + ' 的解释里应包含白话文案')
    assert.ok(rendered.includes(code), code + ' 的解释里要带上码（方便用户报给我们）')
  }
  // 未知码也不许把英文异常直接甩给用户
  const unknown = explain(new Error('weird-code'))
  assert.ok(unknown.includes('weird-code') && /[\u4e00-\u9fa5]/.test(unknown), '未知码也要有中文兜底')
})

test('状态卡一句话：关着/没写/写过了/文件夹没了 不互相盖住', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const { summaryOf } = loadUiPure(code)
  const off = summaryOf({ enabled: false, dir: '/x', time: '21:00' }, null, {})
  assert.equal(off.tone, 'warn')
  assert.ok(off.text.includes('关着'))
  const notYet = summaryOf({ enabled: true, dir: '/x', dirState: 'ok', time: '21:00' }, { written: false }, {})
  assert.equal(notYet.tone, 'ok')
  assert.ok(notYet.text.includes('还没写') && notYet.text.includes('21:00'))
  const done = summaryOf({ enabled: true, dir: '/x', dirState: 'ok', time: '21:00' }, { written: true }, {})
  assert.ok(done.text.includes('写过了') && done.text.includes('不会再写'))
  const missing = summaryOf({ enabled: true, dir: '/x', dirState: 'missing' }, null, {})
  assert.equal(missing.tone, 'warn')
  assert.ok(missing.text.includes('找不到'))
  const writing = summaryOf({ enabled: true, dir: '/x', dirState: 'missing' }, null, { writing: true })
  assert.ok(writing.text.includes('正在写'), '写作中要压过"文件夹没了"（那是她写之前的事）')
  const fail = summaryOf({ enabled: true, dirState: 'ok' }, null, {}, true)
  assert.equal(fail.tone, 'fail')
})

test('时间输入：9:00 / 9：00 / 2100 都能存，25:00 / 9点 / abc 不发请求', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const { normalizeTimeInput } = loadPure(code, ['finiteOr', 'normalizeTimeInput'])
  assert.equal(normalizeTimeInput('9:00'), '09:00')
  assert.equal(normalizeTimeInput('9：00'), '09:00')
  assert.equal(normalizeTimeInput(' 21:00 '), '21:00')
  assert.equal(normalizeTimeInput('2100'), '21:00')
  assert.equal(normalizeTimeInput('930'), '09:30')
  assert.equal(normalizeTimeInput('0930'), '09:30')
  assert.equal(normalizeTimeInput(2100), '21:00')
  assert.equal(normalizeTimeInput('25:00'), null)
  assert.equal(normalizeTimeInput('9点'), null)
  assert.equal(normalizeTimeInput('abc'), null)
  assert.equal(normalizeTimeInput(''), null)
  assert.equal(normalizeTimeInput(null), null)
  assert.equal(normalizeTimeInput(undefined), null)
})

test('台词关闭不再 400ms 空转：退避到 ≥3000ms、封顶 15s，打开立刻恢复', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const { nextLinesDelay } = loadPure(code, ['finiteOr', 'nextLinesDelay'])
  assert.equal(nextLinesDelay({ enabled: true, lines: [] }, { off: 0, err: 0 }), 400)
  const state = { off: 0, err: 0 }
  const first = nextLinesDelay({ enabled: false }, state)
  assert.ok(first >= 3000, '关掉台词后的第一次重试至少 3 秒，实际 ' + first)
  const second = nextLinesDelay({ enabled: false }, state)
  assert.ok(second > first, '连续空转要继续退避')
  state.off = 15000
  assert.equal(nextLinesDelay({ enabled: false }, state), 15000, '退避要封顶，不能无限涨')
  assert.equal(nextLinesDelay({ enabled: true }, state), 400, '用户重新打开后台词要立刻恢复')
  assert.equal(nextLinesDelay({ enabled: true, unavailable: true }, state), 5000)
  assert.equal(nextLinesDelay({ error: true }, { off: 0, err: 0 }), 2000)
  assert.ok(nextLinesDelay({ error: true }, { off: 0, err: 6000 }) >= 2000, '网络错误也要退避')
  assert.equal(nextLinesDelay(null, { off: 0, err: 0 }), 5000, '路由没给值别贴着打')
})

test('桥请求分档超时：写日记 180s、选目录 300s、其余 4s', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.match(code, /const BRIDGE_TIMEOUT_MS = 4000/)
  assert.match(code, /const DIARY_WRITE_TIMEOUT_MS = 180000/)
  assert.match(code, /const DIARY_PICK_TIMEOUT_MS = 300000/)
  assert.ok(code.includes("bridgeRequest('/diary/write', {}, { timeoutMs: DIARY_WRITE_TIMEOUT_MS })"))
  assert.ok(code.includes("bridgeRequest('/diary/pick-dir', {}, { timeoutMs: DIARY_PICK_TIMEOUT_MS })"))

  // 行为验证：看它到底给了 setTimeout 多少毫秒（不是只读字符串）。
  const constSrc = [
    'const BRIDGE_TIMEOUT_MS = 4000',
    'const DIARY_WRITE_TIMEOUT_MS = 180000',
    'const DIARY_PICK_TIMEOUT_MS = 300000',
  ].join('\n')
  const src = constSrc + '\n' + functionSource(code, 'bridgeRequest') + '\nreturn bridgeRequest'
  const timers = []
  class FakeAbortController {
    constructor() {
      this.signal = { aborted: false }
    }
    abort() {
      this.signal.aborted = true
    }
  }
  const bridge = new Function('BRIDGE', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', src)(
    '/api/dsh-ai-waifu',
    () => new Promise(() => {}),
    FakeAbortController,
    (fn, ms) => {
      timers.push(ms)
      return timers.length
    },
    () => {},
  )
  bridge('/lines?sessionId=s1')
  bridge('/diary', { enabled: true })
  bridge('/diary/write', {}, { timeoutMs: 180000 })
  bridge('/diary/pick-dir', {}, { timeoutMs: 300000 })
  bridge('/diary/reload', {}, { timeoutMs: 0 })
  assert.deepEqual(timers, [4000, 4000, 180000, 300000], '默认 4s；写日记/选目录必须放宽；0 表示不设超时')
})

test('气泡跟手：真实量 dsh-pet DOM、120ms 节流、量不到退回 2s /pet、后台不测', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const pet = loadPure(code, [
    'finiteOr',
    'anchorFromPetDisplay',
    'defaultPetAnchor',
    'pickPetAnchor',
    'shouldCommitAnchor',
    'hasTransformedAncestor',
  ])
  assert.ok(pet.PET_SAMPLE_MIN_INTERVAL_MS >= 50 && pet.PET_SAMPLE_MIN_INTERVAL_MS <= 150, '采样节流要在 50–150ms')
  assert.ok(pet.PET_FALLBACK_POLL_MS >= 2000, '量不到立绘时 /pet 轮询间隔不得低于 2s')

  const viewport = { w: 1000, h: 800 }
  const level1 = pet.pickPetAnchor({ sprite: { left: 100, top: 200, width: 160, height: 160 }, viewport })
  assert.equal(level1.level, 1)
  assert.deepEqual(level1.rect, { left: 100, top: 200, right: 260, bottom: 360, width: 160, height: 160 })
  const level2 = pet.pickPetAnchor({ petDisplay: { visible: true, size: 160, right: 20, bottom: 20 }, viewport })
  assert.equal(level2.level, 2)
  assert.equal(level2.rect.left, 1000 - 20 - 160, '/pet 的 right 是"离右边多少"，要换算成 left')
  assert.equal(level2.rect.top, 800 - 20 - 160)
  assert.equal(pet.pickPetAnchor({ petDisplay: { visible: false }, viewport }).level, 3, '她自己藏起来时别在原地冒气泡')
  assert.equal(pet.pickPetAnchor({}).level, 3, '什么都量不到也要给一个默认位置')
  assert.equal(pet.pickPetAnchor({ viewport }).rect.left, 1000 - 20 - 160)
  assert.equal(pet.pickPetAnchor({}).rect.left, 1280 - 20 - 160, '连视口都读不到时用 1280×800 出厂值')

  // 节流：≥120ms 且位移 >1px 才提交
  assert.equal(pet.shouldCommitAnchor(null, { left: 1, top: 1 }, 0, 1000), true)
  assert.equal(pet.shouldCommitAnchor({ left: 0, top: 0 }, { left: 3, top: 0 }, 900, 1000), false, '不到 120ms 不提交')
  assert.equal(pet.shouldCommitAnchor({ left: 0, top: 0 }, { left: 1, top: 1 }, 500, 1000), false, '位移 ≤1px 不提交')
  assert.equal(pet.shouldCommitAnchor({ left: 0, top: 0 }, { left: 3, top: 0 }, 500, 1000), true)
  assert.equal(pet.shouldCommitAnchor(null, null, 0, 1000), false)

  // 量 DOM 的入口与真实选择器
  assert.ok(code.includes("div[data-dsh-pet-root]"), '容器必须是 dsh-pet 挂在 body 下的根节点')
  assert.ok(code.includes('[class*="spriteWrap"]'), '立绘类名带 CSS Modules 哈希，只能用子串选')
  assert.ok(code.includes('getBoundingClientRect()'), '位置必须来自真实 rect，不是 pet.json 猜的')
  const anchorHook = code.slice(code.indexOf('function usePetAnchor'), code.indexOf('function LinesBubbleOverlay'))
  assert.ok(anchorHook.includes("document.addEventListener('visibilitychange'") || anchorHook.includes("addEventListener('visibilitychange'"), '切后台要停 rAF/轮询')
  assert.ok(anchorHook.includes('document.hidden'), '页面隐藏时不采样')
  assert.ok(anchorHook.includes('requestAnimationFrame'), '跟手要按帧采样（拖动的补间在 dsh-pet 自己的 rAF 里）')
  assert.ok(anchorHook.includes("BRIDGE + '/pet'"), '量不到立绘要退回 /pet')
  assert.ok(anchorHook.includes('PET_FALLBACK_POLL_MS'), '兜底轮询用 2s 常量')
})

test('设置页：日记分区卡片化 + 文件夹丢失的白话警告与重选入口', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes('function DiaryCard'), '分区要有卡片容器')
  assert.ok(code.includes("role: 'status'"), '状态卡要让读屏器读出来')
  assert.ok(code.includes("'aria-live': 'polite'"))
  assert.ok(code.includes('上次用的日记本文件夹找不到了'), '文件夹没了要说人话')
  assert.ok(code.includes('更换文件夹'), '要有重选文件夹入口')
  assert.ok(code.includes('重新建一个'), '要有原地重建入口（不删用户原来的东西）')
  assert.ok(code.includes('日记本被改名了，已自动认回'), '自动认回要温和提示，不是报错')
  assert.ok(code.includes('不是我那个'), '认回提示要能拒绝，进入重选流程')
  assert.ok(code.includes('dirRecovered'), '要读宿主给的 dirRecovered')
  assert.ok(code.includes('const config = (snap && snap.config) || FACTORY_DIARY_CONFIG'), '读不到也要用出厂值先画出来')
  assert.ok(!code.includes('正在读取开关状态'), '不许再把整页 gate 在 loading 文案上')
})

/* ─── 真渲染冒烟：迷你 React 运行时把设置页渲染一遍 ──────────────────────
   为什么要这么麻烦：字符串断言查不出「组件渲染时抛错」。宿主对渲染期抛错的处罚是
   退役整条 entry——界面一片哑，而且不报错。所以这里实现 client.js 用到的 5 个 hook，
   把 settings.section 真正调一遍，同时能数清首屏打了几个请求。 */
function createHookRuntime() {
  const store = new Map()
  let current = null
  let index = 0
  let dirty = false
  let collect = null
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i])
  const slot = (path) => {
    let s = store.get(path)
    if (!s) {
      s = { states: [], refs: [], effects: [], callbacks: [] }
      store.set(path, s)
    }
    return s
  }
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      const flat = []
      const push = (c) => {
        if (c === null || c === undefined || c === false || c === true) return
        if (Array.isArray(c)) c.forEach(push)
        else flat.push(c)
      }
      push(children)
      return { type, props: Object.assign({}, props, flat.length ? { children: flat.length === 1 ? flat[0] : flat } : {}) }
    },
    useState(initial) {
      const i = index
      index += 1
      const s = current
      if (!(i in s.states)) s.states[i] = typeof initial === 'function' ? initial() : initial
      return [
        s.states[i],
        (next) => {
          const value = typeof next === 'function' ? next(s.states[i]) : next
          if (value === s.states[i]) return
          s.states[i] = value
          dirty = true
        },
      ]
    },
    useRef(initial) {
      const i = index
      index += 1
      if (!current.refs[i]) current.refs[i] = { current: initial }
      return current.refs[i]
    },
    useCallback(fn, deps) {
      const i = index
      index += 1
      const prev = current.callbacks[i]
      if (!prev || !same(prev.deps, deps)) current.callbacks[i] = { fn, deps }
      return current.callbacks[i].fn
    },
    useEffect(fn, deps) {
      const i = index
      index += 1
      const prev = current.effects[i]
      if (prev && same(prev.deps, deps)) return
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      current.effects[i] = { deps, fn, cleanup: undefined, fresh: true }
    },
    useMemo(fn, deps) {
      return React.useCallback(fn, deps)()
    },
  }
  const render = (node, path) => {
    if (node === null || node === undefined || node === false || node === true) return
    if (Array.isArray(node)) {
      node.forEach((child, i) => render(child, path + '.' + i))
      return
    }
    if (typeof node === 'string' || typeof node === 'number') return
    if (collect) collect(node)
    if (typeof node.type === 'function') {
      const prev = current
      const prevIndex = index
      current = slot(path)
      index = 0
      let out
      try {
        out = node.type(node.props || {})
      } catch (error) {
        throw new Error('渲染 ' + (node.type.name || '组件') + ' 时抛错：' + error.message)
      } finally {
        current = prev
        index = prevIndex
      }
      render(out, path + '/' + (node.type.name || 'fmt'))
      return
    }
    if (node.props) render(node.props.children, path + '>' + String(node.type))
  }
  const flushEffects = () => {
    for (const s of store.values()) {
      for (const effect of s.effects) {
        if (!effect || !effect.fresh) continue
        effect.fresh = false
        const cleanup = effect.fn()
        if (typeof cleanup === 'function') effect.cleanup = cleanup
      }
    }
  }
  return {
    React,
    mount(Component, props, path, onNode) {
      collect = onNode || null
      slot(path)
      for (let pass = 0; pass < 12; pass += 1) {
        dirty = false
        render({ type: Component, props }, path)
        flushEffects()
        if (!dirty) break
      }
      collect = null
    },
  }
}

/** 在假浏览器里真渲染 settings.section，返回请求记录与所有 vnode。 */
async function renderSettingsPage(options) {
  const opts = options || {}
  const code = readFileSync(CLIENT, 'utf8')
  const runtime = createHookRuntime()
  const requests = []
  const vnodes = []
  const timers = []
  const registered = {}
  const saved = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  const realSetTimeout = globalThis.setTimeout
  let latest = []
  let factory = null
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ factory: fn }) => {
        factory = fn
      },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 900,
    innerHeight: 800,
    localStorage: {
      data: {},
      getItem(key) {
        return key in this.data ? this.data[key] : null
      },
      setItem(key, value) {
        this.data[key] = String(value)
      },
      removeItem(key) {
        delete this.data[key]
      },
    },
  }
  globalThis.window = fakeWindow
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
  }
  globalThis.fetch = (url, init) => {
    requests.push(String(url) + ' ' + String((init && init.method) || 'GET'))
    // /pet 与 /pet/affinity 的替身：亲密度那一块要能断言「默认零 IO」「展开才读」「超限被夹住」。
    if (typeof opts.pet === 'function' && String(url).includes('/pet')) {
      return opts.pet(String(url), init)
    }
    if (String(url).includes('/diary')) {
      if (typeof opts.diary === 'function') return opts.diary(String(url))
      return new Promise(() => {})
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: {} }) })
  }
  try {
    // 记下所有 setTimeout 的时长：15000 = 统计请求自己的超时，1500 = scanning 追问节奏。
    globalThis.setTimeout = (fn, delay) => {
      timers.push(Number(delay) || 0)
      return realSetTimeout(fn, delay)
    }
    new Function('window', code)(fakeWindow)
    assert.ok(factory, 'client.js 的模块包装坏了')
    const api = factory((name) => {
      if (name === 'react') return runtime.React
      throw new Error('client.js require 了不该 require 的包：' + name)
    })
    api.apply({
      effect(fn) {
        fn()
      },
      slots: {
        inject(name, fn) {
          fn()
        },
        register(meta, Component) {
          registered[meta.name] = Component
        },
      },
    })
    const page = registered['settings.section']
    assert.ok(page, '没注册 settings.section')
    const mountPage = () => {
      latest = []
      runtime.mount(page, {}, 'settings', (node) => {
        vnodes.push(node)
        latest.push(node)
      })
    }
    mountPage()
    // 让快照/请求的 promise 落地，再渲染一轮（模拟 React 的异步 setState）。
    await new Promise((resolve) => realSetTimeout(resolve, 0))
    mountPage()
    // 需要等后台重试（例如两次统计失败留灰字）时给一段真实等待，再补渲染一轮。
    if (opts.settleMs > 0) {
      await new Promise((resolve) => realSetTimeout(resolve, opts.settleMs))
      mountPage()
      await new Promise((resolve) => realSetTimeout(resolve, 0))
    }
    const click = async (label, pick) => {
      const clickable = latest.filter((node) => node && node.props && typeof node.props.onClick === 'function')
      // 优先点真正的 button：外层容器也有 onClick 时，不能点到「行」上去。
      const buttons = clickable.filter((node) => node.type === 'button')
      const hits = buttons.filter((node) => flatText([node]).includes(label))
      // 同一页里会有两个「+100」「写成这个数」（亲密度一个、小鱼干一个），
      // 默认点最后一个（排在下面的小鱼干），要上面那个就传 'first'。
      const pool = hits.length ? hits : clickable.filter((node) => flatText([node]).includes(label))
      const hit = pick === 'first' ? pool[0] : pool[pool.length - 1]
      assert.ok(hit, '页面上找不到可点的「' + label + '」')
      hit.props.onClick({})
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      mountPage()
      await new Promise((resolve) => realSetTimeout(resolve, 0))
      return hit
    }
    const settle = async (ms) => {
      await new Promise((resolve) => realSetTimeout(resolve, ms))
      mountPage()
      await new Promise((resolve) => realSetTimeout(resolve, 0))
    }
    const dispose = () => {
      globalThis.setTimeout = realSetTimeout
      globalThis.window = saved.window
      globalThis.document = saved.document
      globalThis.fetch = saved.fetch
    }
    const latestText = () => flatText(latest)
    return { vnodes, requests, timers, click, settle, dispose, latestText }
  } finally {
    // 手动模式（opts.manualRestore）：点击/等待发生在 return 之后，假 fetch 与 setTimeout
    // 必须留到用例结束，由 dispose() 收；否则点在真实 Node fetch 上，请求一条都记不到。
    if (opts.manualRestore !== true) {
      globalThis.setTimeout = realSetTimeout
      globalThis.window = saved.window
      globalThis.document = saved.document
      globalThis.fetch = saved.fetch
    }
  }
}

function flatText(nodes) {
  const textOf = (node) => {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join('')
    return textOf(node.props && node.props.children)
  }
  return nodes.map(textOf).join('\n')
}

test('设置页真渲染：首屏只发一次 /diary，缺文件夹有白话警告与重选入口', async () => {
  // 场景一：宿主很慢（/diary 永不返回）。页面必须照样画出来，且只打一次 /diary。
  const slow = await renderSettingsPage({})
  const diaryCalls = slow.requests.filter((line) => line.includes('/diary '))
  assert.equal(diaryCalls.length, 1, '首屏只许打一次 /diary，实际：' + slow.requests.join(' | '))
  assert.ok(!slow.requests.some((line) => line.includes('/diary?today=1')), '不许再有阻塞式 /diary?today=1')
  // 状态卡要在，但不能把"还没读到"说成"日记关着"（体感审 F11）：
  // 读到之前显示「正在读设置…」，读到之后才是那三句之一。
  const slowText = flatText(slow.vnodes)
  assert.match(slowText, /正在读设置…/, '宿主没回来时状态卡要说「正在读设置…」，不许冒充「日记关着」')
  assert.ok(!/日记关着/.test(slowText), '还没读到设置时，任何地方都不许出现「日记关着」')
  assert.match(slowText, /下面是出厂值，正在读取你的日记设置/, '读设置期间要说明下面是出厂值，别把默认值当成真读到')
  assert.match(slowText, /她是谁|日记本/, '宿主没回来也要把整页画出来（乐观渲染）')

  // 场景二：宿主返回「文件夹没了」。卡片要给出白话解释和两个动作。
  const gone = await renderSettingsPage({
    diary: () =>
      Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            value: {
              schema: 2,
              now: '2026-10-24T12:00:00.000Z',
              doc: { path: '/tmp/gone/AI娘日记记录.md', exists: true, size: 900, mtime: '2026-10-24T11:00:00.000Z', warnings: [] },
              config: {
                enabled: true,
                dir: '/tmp/gone',
                dirState: 'missing',
                dirMessage: '这个文件夹找不到了',
                time: '21:00',
                timeValid: true,
                diarist: 'auto',
                autoCreate: true,
              },
              today: {
                label: '2026-10-24',
                state: 'ready',
                scannedAt: '2026-10-24T11:30:00.000Z',
                sessions: 3,
                kept: 41,
                outputTokens: 12034,
                empty: false,
                written: false,
                diarist: { key: 'deepseek-chat' },
              },
              recent: [],
              failure: null,
              pending: 0,
              busy: { writing: false, picking: false },
              dirRecovered: null,
            },
          }),
      }),
  })
  const text = flatText(gone.vnodes)
  assert.ok(text.includes('上次用的日记本文件夹找不到了'), '缺文件夹要给白话警告，实际：' + text.slice(0, 200))
  assert.ok(text.includes('更换文件夹'), '缺文件夹时要给「更换文件夹」入口')
  assert.ok(text.includes('重新建一个'), '缺文件夹时要给「重新建一个」入口')
  assert.ok(text.includes('3 段对话') && text.includes('12034 字'), '今日统计来自快照，不再二次扫日志')
})

test('体验修复：统计超时单独给足、认回横幅按方案落地、「不是我那个」真的通知宿主', () => {
  const code = readFileSync(CLIENT, 'utf8')
  // F2：统计走 15s 专用超时，不再用 4s 默认值把自己 abort 掉。
  // （调用点用不用 GET 由下面的点击级用例保证，这里只钉住超时常量本身。）
  assert.ok(code.includes('const DIARY_STATS_TIMEOUT_MS = 15000'), '统计超时 ≥12s（宿主 8s 才回 scanning）')
  // F3：超时文案分场景，写日记那句不许串到读设置/统计上。
  assert.ok(code.includes('function explain(error, scene)'), 'explain 要能按场景挑超时文案')
  for (const scene of ['read', 'save', 'stats', 'pick', 'reload', 'write']) {
    assert.ok(code.includes(scene + ':'), '缺少超时场景文案：' + scene)
  }
  // F5/S1a：淡绿 + 绿条 + 两句解释 + 「知道了」，且「不是我那个」真的打 reject-dir。
  assert.ok(code.includes("borderLeft: '3px solid #2fb344'"), '认回横幅要淡绿左边绿条')
  assert.ok(code.includes("bridgeRequest('/diary/reject-dir', { to: to }"), '「不是我那个」必须通知宿主')
  assert.ok(code.includes('ai-waifu-recover-dismissed'), '「知道了」只记 localStorage，不发请求')
  assert.ok(code.includes('COPY.recovered.know'), '缺少「知道了」次按钮')
  // F11/S1b：疑似本子建议 + 身份标记灰字。
  assert.ok(code.includes('snap.dirSuggestions'), '要渲染 dirSuggestions')
  assert.ok(code.includes("COPY.recovered.useIt"), '建议行要有「用它」')
  assert.ok(code.includes("props.dirMarker !== 'present'"), '缺身份标记时要有灰字提示')
  // F8：失败行白话优先，技术串降级到 title/折叠。
  assert.ok(code.includes('const failurePlain = failure'), '失败行要先用 COPY.problem[code]')
  assert.ok(code.includes("'技术细节'"), '技术细节要收进折叠区')
  // F4：先判节流再取样式。
  const commitAt = code.indexOf('const commit = (result, now) => {')
  const frameAt = code.indexOf('const frame = resolveFrame()', commitAt)
  const throttleAt = code.indexOf('shouldCommitAnchor(prev.rect', commitAt)
  assert.ok(commitAt > 0 && throttleAt > commitAt && frameAt > throttleAt, 'commit() 必须先判节流再取样式')
  // 台词重开：写盘成功后清退避并叫醒定时器。
  assert.ok(code.includes('linesControl.reset()'))
  assert.ok(code.includes('linesControl.wake = wake'))
})

// ---- 点击级行为用例（t19 / t14-F2-F3）：不再只查源码字符串，真的点一下看请求 ----

function diarySnapshot(overrides) {
  const base = {
    schema: 2,
    now: '2026-10-24T12:00:00.000Z',
    doc: { path: '/tmp/ok/AI娘日记记录.md', exists: true, size: 900, mtime: '2026-10-24T11:00:00.000Z', warnings: [] },
    config: {
      enabled: true,
      dir: '/tmp/ok',
      dirState: 'ok',
      dirMessage: '',
      time: '21:00',
      timeValid: true,
      diarist: 'auto',
      autoCreate: true,
    },
    today: {
      label: '2026-10-24',
      state: 'ready',
      stale: false,
      scannedAt: '2026-10-24T11:30:00.000Z',
      sessions: 3,
      kept: 41,
      outputTokens: 12034,
      empty: false,
      written: false,
      diarist: { key: 'deepseek-chat' },
      topUsage: [],
    },
    recent: [],
    failure: null,
    pending: 0,
    busy: { writing: false, picking: false },
    dirRecovered: null,
    dirSuggestions: [],
    dirMarker: 'present',
  }
  return Object.assign(base, overrides || {})
}

function diaryResponse(value) {
  return { json: () => Promise.resolve({ ok: true, value: value }) }
}

function staleSnapshot(extra) {
  const base = diarySnapshot(extra)
  return Object.assign({}, base, { today: Object.assign({}, base.today, { stale: true }) })
}

test('点「刷新统计」：必须是 GET、给 15 秒、scanning 后 1500ms 追问，页面上不出现「内部出错了」', async () => {
  const snap = staleSnapshot()
  let refreshCalls = 0
  const page = await renderSettingsPage({
    manualRestore: true,
    diary: (url) => {
      if (url.includes('/diary/today?refresh=1')) {
        refreshCalls += 1
        const today =
          refreshCalls === 1
            ? Object.assign({}, snap.today, { state: 'scanning', stale: true })
            : Object.assign({}, snap.today, { state: 'ready', stale: false })
        return Promise.resolve(diaryResponse(today))
      }
      if (url.includes('/diary/today')) {
        return Promise.resolve(diaryResponse(Object.assign({}, snap.today, { stale: false })))
      }
      return Promise.resolve(diaryResponse(snap))
    },
  })
  await page.settle(50)
  await page.click('刷新统计')
  const refresh = page.requests.filter((line) => line.includes('/diary/today?refresh=1'))
  assert.ok(refresh.length >= 1, '点「刷新统计」必须真的打 /diary/today?refresh=1')
  for (const line of refresh) assert.match(line, / GET$/, '刷新统计必须是 GET（POST 会被 405 成「内部出错了」）：' + line)
  assert.ok(page.timers.includes(15000), '统计请求要自带 15000ms 超时，实际计时器：' + page.timers.join(','))
  await page.settle(1600)
  const after = page.requests.filter((line) => line.includes('/diary/today?refresh=1'))
  assert.ok(after.length >= 2, 'scanning 之后要每 1500ms 追问一次，实际次数：' + after.length)
  assert.ok(page.timers.includes(1500), '追问节奏应为 1500ms')
  assert.ok(!/（internal）|（timeout）/.test(flatText(page.vnodes)), '统计请求不许把自己 abort 成 timeout/internal，页面上不能出现这类码')
})

test('点「不是我那个」：真的 POST /diary/reject-dir，并把宿主返回的快照贴回界面', async () => {
  const before = diarySnapshot({
    dirRecovered: { from: '/tmp/old', to: '/tmp/ok', at: '2026-10-24T11:00:00.000Z', persisted: true },
  })
  const after = diarySnapshot()
  let rejected = false
  const page = await renderSettingsPage({
    manualRestore: true,
    diary: (url) => {
      if (url.includes('/diary/reject-dir')) rejected = true
      return Promise.resolve(diaryResponse(rejected ? after : before))
    },
  })
  await page.settle(50)
  assert.ok(flatText(page.vnodes).includes('日记本被改名了，已自动认回'), '认回横幅要先画出来')
  await page.click('不是我那个')
  const rejects = page.requests.filter((line) => line.includes('/diary/reject-dir'))
  assert.ok(rejects.length >= 1, '「不是我那个」必须真的通知宿主，实际请求：' + page.requests.join(' | '))
  assert.match(rejects[0], / POST$/, 'reject-dir 是写操作，必须是 POST')
  assert.ok(!page.latestText().includes('日记本被改名了，已自动认回'), '认回被否掉后横幅要消失')
})

test('点「用它」（疑似日记本建议）：POST /diary 带上那个目录，再画成正常状态', async () => {
  const before = diarySnapshot({
    config: Object.assign({}, diarySnapshot().config, { dir: '/tmp/gone', dirState: 'missing', dirMessage: '这个文件夹找不到了' }),
    dirSuggestions: [{ dir: '/tmp/sug', reason: '看着像日记本' }],
  })
  const after = diarySnapshot()
  const page = await renderSettingsPage({
    manualRestore: true,
    diary: () => Promise.resolve(diaryResponse(before)),
  })
  await page.settle(50)
  assert.ok(flatText(page.vnodes).includes('用它'), '疑似的本子要给「用它」入口')
  await page.click('用它')
  const posts = page.requests.filter((line) => line.endsWith('/diary POST'))
  assert.ok(posts.length >= 1, '点「用它」要 POST /diary 换目录，实际请求：' + page.requests.join(' | '))
})

test('今日统计连拉两次失败：不再偷偷重试，留一行灰字让用户自己点「刷新统计」', async () => {
  const snap = staleSnapshot()
  const page = await renderSettingsPage({
    manualRestore: true,
    diary: (url) => {
      if (url.includes('/diary/today')) {
        return Promise.resolve({ json: () => Promise.resolve({ ok: false, code: 'internal', reason: 'boom' }) })
      }
      return Promise.resolve(diaryResponse(snap))
    },
    settleMs: 2000,
  })
  const text = flatText(page.vnodes)
  assert.ok(text.includes('统计没拉下来，点「刷新统计」再试一次'), '两次失败后要留一行灰字，实际：' + text.slice(0, 300))
  assert.ok(!/（internal）/.test(text), '灰字是白话，不许把 internal 码怼成红字（帮助区的码表不算）')
  const tries = page.requests.filter((line) => line.includes('/diary/today') && !line.includes('refresh=1'))
  assert.ok(tries.length <= 2, '最多自动试两次，实际：' + tries.length)
})

/**
 * 在假浏览器里真挂「台词气泡」那两层：
 *   conversation.input.dock → LinesSessionBridge（把 sessionId 递到模块变量）
 *   shell.overlay           → LinesBubbleOverlay（气泡本体）
 * 用来复现「切会话后气泡还吐上一场的句子」。
 */
async function renderLinesBubble() {
  const code = readFileSync(CLIENT, 'utf8')
  const runtime = createHookRuntime()
  const requests = []
  const registered = {}
  let factory = null
  let latest = []
  let alive = true
  const intervals = []
  const timeouts = []
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    fetch: globalThis.fetch,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }
  const fakeWindow = {
    __ModuleLoader__: {
      load: ({ factory: fn }) => {
        factory = fn
      },
    },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 900,
    innerHeight: 800,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  }
  globalThis.window = fakeWindow
  globalThis.document = {
    hidden: false,
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null
    },
  }
  globalThis.requestAnimationFrame = (fn) => (alive ? saved.raf ? saved.raf(() => alive && fn(Date.now())) : 0 : 0)
  globalThis.cancelAnimationFrame = (id) => {
    if (saved.caf) saved.caf(id)
    else saved.clearInterval(id)
  }
  // 480ms 的队列定时器会一直跑：记下来，dispose 时清掉，否则测试进程收不了尾。
  globalThis.setInterval = (fn, ms) => {
    const id = saved.setInterval(fn, ms)
    intervals.push(id)
    return id
  }
  globalThis.clearInterval = (id) => saved.clearInterval(id)
  // 长轮询/涨幅退避都是 setTimeout 串起来的：记下来，dispose 时统一清掉，别让
  // 「测试跑完但进程永不退出」这种假绿/假红出现。
  globalThis.setTimeout = (fn, ms) => {
    const id = saved.setTimeout(fn, ms)
    timeouts.push(id)
    return id
  }
  globalThis.clearTimeout = (id) => saved.clearTimeout(id)
  globalThis.fetch = (url, init) => {
    const u = String(url)
    requests.push(u + ' ' + String((init && init.method) || 'GET'))
    if (!alive) return new Promise(() => {})
    if (u.includes('/lines')) {
      const m = /sessionId=([^&]+)/.exec(u)
      const sid = m ? decodeURIComponent(m[1]) : ''
      const texts = sid === 'B' ? ['B1', 'B2'] : ['A1', 'A2', 'A3', 'A4', 'A5']
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            value: { cursor: 9, enabled: true, lines: texts.map((t) => ({ id: t, text: t, at: 0 })) },
          }),
      })
    }
    if (u.includes('/pet')) {
      return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { visible: true, size: 160, right: 20, bottom: 20, bubbleScale: 1 } }) })
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: {} }) })
  }
  new Function('window', code)(fakeWindow)
  if (!factory) throw new Error('client.js 的模块包装坏了')
  const api = factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error('client.js require 了不该 require 的包：' + name)
  })
  api.apply({
    effect(fn) {
      fn()
    },
    slots: {
      inject(name, fn) {
        fn()
      },
      register(meta, Component) {
        registered[meta.name] = Component
      },
    },
  })
  const dock = registered['conversation.input.dock']
  const overlay = registered['shell.overlay']
  if (!dock || !overlay) throw new Error('台词气泡的两个槽没注册上')
  const mountDock = (sessionId) => runtime.mount(dock, { sessionId }, 'dock', (node) => node)
  const mountOverlay = () => {
    latest = []
    runtime.mount(overlay, {}, 'overlay', (node) => latest.push(node))
  }
  const text = () => flatText(latest)
  return {
    session(sessionId) {
      mountDock(sessionId)
    },
    mountOverlay,
    text,
    requests,
    async tick(ms) {
      const wait = (n) => new Promise((resolve) => saved.setTimeout(resolve, n))
      await wait(ms)
      // 多挂两轮：锚点（/pet + 记账）与台词都是异步落 state 的，只渲染一次会读到空。
      mountOverlay()
      await wait(20)
      mountOverlay()
      await wait(20)
      mountOverlay()
    },
    dispose() {
      alive = false
      for (const id of intervals) saved.clearInterval(id)
      for (const id of timeouts) saved.clearTimeout(id)
      globalThis.window = saved.window
      globalThis.document = saved.document
      globalThis.fetch = saved.fetch
      globalThis.requestAnimationFrame = saved.raf
      globalThis.cancelAnimationFrame = saved.caf
      globalThis.setInterval = saved.setInterval
      globalThis.clearInterval = saved.clearInterval
      globalThis.setTimeout = saved.setTimeout
      globalThis.clearTimeout = saved.clearTimeout
    },
  }
}

test('切会话：气泡第一屏就是新会话的话，不搬上一场的句子', async () => {
  const probe = await renderLinesBubble()
  try {
    // 会话 A：宿主一次给 5 句，队列会压住 A2–A5。
    probe.session('A')
    probe.mountOverlay()
    await probe.tick(900)
    assert.match(probe.text(), /A1/, 'A 会话要先吐话，实际：' + JSON.stringify(probe.text()) + '｜请求：' + probe.requests.join(' | '))
    // 这时切到 B：旧实现里 queueRef 还排着 A2–A5，游标也还是旧的。
    const aFrame = probe.text()
    probe.session('B')
    probe.mountOverlay()
    await probe.tick(900)
    const first = probe.text()
    assert.match(aFrame, /A1/, '切走之前屏幕上应是 A 的话，实际：' + JSON.stringify(aFrame))
    assert.match(first, /B1/, '切到 B 后的第一屏必须是 B 的话，实际：' + JSON.stringify(first) + '｜请求：' + probe.requests.join(' | '))
    assert.ok(!/A[0-9]/.test(first), '切到 B 后不许再吐 A 的句子，实际：' + JSON.stringify(first))
    const bCalls = probe.requests.filter((line) => line.includes('sessionId=B'))
    assert.ok(bCalls.length > 0, '切会话后必须立刻问一次新会话，实际：' + probe.requests.join(' | '))
    assert.match(
      bCalls[0],
      /cursor=0/,
      '新会话的第一次请求必须 cursor=0（否则宿主按旧游标分页只会空转），实际：' + bCalls.join(' | ')
    )
    // 切回 A 也不许串台。
    probe.session('A')
    probe.mountOverlay()
    await probe.tick(900)
    const back = probe.text()
    assert.match(back, /A[0-9]/, '切回 A 要重新吐 A 的话，实际：' + JSON.stringify(back))
    assert.ok(!/B[0-9]/.test(back), '切回 A 不许残留 B 的句子，实际：' + JSON.stringify(back))
  } finally {
    probe.dispose()
  }
})

test('切会话的重置不许被删掉（游标/队列/那句话说清都在，且排在长轮询之前）', () => {
  const code = readFileSync(CLIENT, 'utf8')
  const resetAt = code.indexOf('cursorRef.current = 0')
  assert.ok(resetAt > 0, '切会话时必须把游标归零（cursorRef.current = 0），否则新会话带着旧游标空转')
  const pollAt = code.indexOf("'/lines?sessionId='")
  assert.ok(pollAt > resetAt, '重置必须排在长轮询 effect 之前：React 先跑 cleanup 再按声明顺序跑 effect，重置先落地，新会话才用 cursor=0 发第一次请求')
  const block = code.slice(resetAt - 1200, pollAt)
  assert.match(block, /queueRef\.current = \[\]/, '切会话时必须清空待播队列（否则旧会话剩 4–5 句，用户看到的就是「要等 4 到 5 条」）')
  assert.match(block, /setText\(''\)/, '切会话时必须把正在显示的那句清掉')
  assert.match(block, /backoffRef\.current\.(off|err) = 0/, '切会话时退避要归零，不能继承上一场攒下的长等待')
  assert.match(block, /\}, \[sessionId\]\)/, '上述重置要挂在 [sessionId] 上')
  // 上一场的 in-flight 回包不许污染新会话：三处 stopped 守卫（回包、收尾、入队前）都在。
  const stoppedGuards = (code.match(/if \(stopped\) return/g) || []).length
  assert.ok(stoppedGuards >= 3, 'stopped 守卫要覆盖回包处理与后续调度，实际只有 ' + stoppedGuards + ' 处')
})

/* ---------------- 与 dsh-pet 的联动：亲密度（2026-10-24 加） ---------------- */

const SRC_BUILD = join(HERE, '..', 'scripts', 'build-client.mjs')

test('亲密度上限是本地常量 999999（六位数，用户要求）', () => {
  // 2026-10-24 用户把上限改成六位数。宿主 src/affinity-store.mjs 是另一批人在并行改，
  // 所以这里不再读宿主文件做「两边相等」的断言——那等于把自己的构建绑在别人的文件上。
  const client = readFileSync(SRC_BUILD, 'utf8')
  const clientMax = /const AFFINITY_MAX = (\d+)/.exec(client)
  assert.ok(clientMax, 'build-client.mjs 里找不到 AFFINITY_MAX')
  assert.equal(clientMax[1], '999999', '界面上限是 999999（六位数）')
  // 注释要写清为什么是六位数，免得下一个人当成笔误「修」回九位。
  assert.match(client, /用户要求上限六位数/, 'AFFINITY_MAX 旁边要写清为什么是六位数')
})

function jsonResponse(value) {
  return Promise.resolve({ json: () => Promise.resolve(value) })
}

/** 亲密度/小鱼干两个输入框按 aria-label 认；vnodes 跨轮累积，取最新的那个。 */
function latestInput(page, keyword) {
  return collectInputs([].concat(page.vnodes))
    .filter((node) => String((node.props && node.props['aria-label']) || '').includes(keyword))
    .pop()
}

test('设置页：默认收起时对 /pet/affinity、/pet/treats 零 IO；点开才读，显示点数与上限', async () => {
  let affinityReads = 0
  let treatsReads = 0
  const page = await renderSettingsPage({
    manualRestore: true,
    pet: (url) => {
      if (url.includes('/pet/affinity')) {
        affinityReads += 1
        return jsonResponse({ ok: true, value: { points: 1234, max: 999999 } })
      }
      if (url.includes('/pet/treats')) {
        treatsReads += 1
        return jsonResponse({ ok: true, value: { treats: 10, max: 999 } })
      }
      return jsonResponse({ ok: true, value: { installed: true, enabled: true } })
    },
  })
  await page.settle(50)
  // 默认收起：亲密度和小鱼干一个请求都不许发（用户要求「默认关，不展开不花 IO」）。
  assert.equal(affinityReads, 0, '默认收起时不许请求 /pet/affinity，实际发了 ' + affinityReads + ' 次')
  assert.equal(treatsReads, 0, '默认收起时不许请求 /pet/treats，实际发了 ' + treatsReads + ' 次')
  assert.ok(!page.requests.some((line) => line.includes('/pet/affinity')), '默认收起时 requests 里不许出现 /pet/affinity')
  assert.match(page.latestText(), /亲密度（默认收起，想改就点这里）/, '要给一个默认收起的入口')

  await page.click('亲密度')
  assert.equal(affinityReads, 1, '点开后才拉一次亲密度，实际 ' + affinityReads + ' 次')
  const text = page.latestText()
  assert.match(text, /现在是 1234/, '要点数')
  assert.match(text, /\/ 999999/, '上限要跟着常量走（六位数）')
  assert.match(text, /六位数/, '要说明这是界面上的六位数上限，免得用户以为是 bug')
  // 小鱼干跟亲密度同一个开合：展开也同样只在展开后读一次。
  assert.equal(treatsReads, 1, '展开后要读一次小鱼干，实际 ' + treatsReads + ' 次')
  assert.match(text, /现在有 10/, '要显示小鱼干数量')
  assert.match(text, /\/ 999/, '小鱼干上限是 999')
  page.dispose()
})

test('设置页：亲密度输入只收六个数字（1234567 → 123456），body 里 points 不超过 999999', async () => {
  const bodies = []
  const page = await renderSettingsPage({
    manualRestore: true,
    pet: (url, init) => {
      if (url.includes('/pet/affinity')) {
        if (String((init && init.method) || 'GET') === 'POST') {
          bodies.push(String((init && init.body) || ''))
          return jsonResponse({ ok: true, value: { points: 123456, applied: 'pending-restart' } })
        }
        return jsonResponse({ ok: true, value: { points: 10, max: 999999 } })
      }
      if (url.includes('/pet/treats')) return jsonResponse({ ok: true, value: { treats: 10, max: 999 } })
      return jsonResponse({ ok: true, value: { installed: true, enabled: true } })
    },
  })
  await page.settle(50)
  await page.click('亲密度')
  // 插槽运行时没有真实 DOM，直接把 7 位数塞进 onChange：过滤后只该剩前六位。
  const input = latestInput(page, '亲密度')
  assert.ok(input, '亲密度编辑区要有一个可输入的框')
  assert.equal(input.props.maxLength, 6, '输入框要声明 maxLength 6')
  input.props.onChange({ target: { value: '1234567' } })
  await page.settle(10)
  const filtered = latestInput(page, '亲密度')
  assert.equal(String(filtered.props.value), '123456', 'onChange 里只该留前六位，实际 ' + filtered.props.value)
  // 带字母的粘贴也要当场剔掉（不留非法字符）。
  filtered.props.onChange({ target: { value: '12a34b56' } })
  await page.settle(10)
  assert.equal(String(latestInput(page, '亲密度').props.value), '123456', '非数字字符不许进输入框')

  await page.click('写成这个数', 'first')
  assert.equal(bodies.length, 1, '要发一次写入请求，实际 ' + bodies.length)
  const body = JSON.parse(bodies[0])
  assert.equal(body.points, 123456, '写进去的就是过滤后的六位数，实际 body：' + bodies[0])
  assert.ok(body.points <= 999999, '不许把超过 999999 的值丢给宿主，实际 ' + body.points)
  assert.match(page.latestText(), /重启 App 后生效/, 'reload 不可用时要如实说「重启后生效」，不许说「已改好」')
  assert.match(page.latestText(), /pet\.json\.bak/, '要说明改之前会先备份一份')
  page.dispose()
})

test('设置页：小鱼干展开后 +100 从 10 到 110；输入 1200 发出去的是 999', async () => {
  const bodies = []
  const page = await renderSettingsPage({
    manualRestore: true,
    pet: (url, init) => {
      if (url.includes('/pet/treats')) {
        if (String((init && init.method) || 'GET') === 'POST') {
          const raw = String((init && init.body) || '')
          bodies.push(raw)
          const sent = Number((JSON.parse(raw) || {}).treats)
          return jsonResponse({ ok: true, value: { treats: sent, applied: 'ok' } })
        }
        return jsonResponse({ ok: true, value: { treats: 10, max: 999 } })
      }
      if (url.includes('/pet/affinity')) return jsonResponse({ ok: true, value: { points: 10, max: 999999 } })
      return jsonResponse({ ok: true, value: { installed: true, enabled: true } })
    },
  })
  await page.settle(50)
  await page.click('亲密度')
  assert.match(page.latestText(), /现在有 10/, '点开后先显示当前小鱼干')

  // 排在后面的 +100 是小鱼干那排（亲密度那排在它上面，默认点最后一个）。
  await page.click('+100')
  assert.equal(bodies.length, 1, '点 +100 要发一次写入请求')
  assert.equal(JSON.parse(bodies[0]).treats, 110, '+100 要按「现在 + 增量」算，实际 body：' + bodies[0])
  assert.match(page.latestText(), /现在有 110/, '点完要立刻显示 110')

  const input = latestInput(page, '小鱼干')
  assert.ok(input, '小鱼干要有一个可输入的框')
  assert.equal(input.props.maxLength, 3, '小鱼干输入框要声明 maxLength 3')
  input.props.onChange({ target: { value: '1200' } })
  await page.settle(10)
  await page.click('写成这个数')
  assert.equal(bodies.length, 2, '要再发一次写入请求')
  assert.equal(JSON.parse(bodies[1]).treats, 999, '超 999 要在本地夹住，实际 body：' + bodies[1])
  assert.match(page.latestText(), /现在有 999/, '界面上要显示夹住之后的值')
  assert.match(page.latestText(), /pet\.json\.bak/, '小鱼干也要说明会先备份、失败会还原')
  page.dispose()
})

test('设置页：小鱼干写失败（reload-unavailable）要说清「这次什么都没写入」', async () => {
  const page = await renderSettingsPage({
    manualRestore: true,
    pet: (url, init) => {
      if (url.includes('/pet/treats')) {
        if (String((init && init.method) || 'GET') === 'POST') {
          return jsonResponse({ ok: false, error: { code: 'reload-unavailable' } })
        }
        return jsonResponse({ ok: true, value: { treats: 10, max: 999 } })
      }
      if (url.includes('/pet/affinity')) return jsonResponse({ ok: true, value: { points: 10, max: 999999 } })
      return jsonResponse({ ok: true, value: { installed: true, enabled: true } })
    },
  })
  await page.settle(50)
  await page.click('亲密度')
  await page.click('+1')
  const text = page.latestText()
  assert.match(text, /什么都没写入/, 'reload-unavailable 要说明这次什么都没写入，实际：' + text.slice(-200))
  assert.match(text, /重载状态/, '要说明挂件没在重载状态')
  assert.match(text, /现在有 10/, '写失败了数字不许变（还是 10）')
  page.dispose()
})

/** 把渲染树里所有带 onChange 的节点摊平（插槽运行时没 DOM，只能这么取输入框）。 */
function collectInputs(nodes, out) {
  const acc = out || []
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue
    if (node.props && typeof node.props.onChange === 'function') acc.push(node)
    if (node.props && node.props.children) collectInputs([].concat(node.props.children), acc)
  }
  return acc
}

/* ---------------- 台词拉取的自我修复（2026-10-25 用户实测「几分钟后停住」） ---------------- */

test('台词长轮询带三道自我修复：过期游标、fetch 兜底超时、循环看门狗', () => {
  const src = readFileSync(new URL('../scripts/build-client.mjs', import.meta.url), 'utf8')
  // ① 兜底超时：长轮询最多等 8 秒，挂住就 abort，否则永不排下一次。
  assert.match(src, /LINES_POLL_WAIT_MS \+ 5000/)
  assert.match(src, /controller\.abort\(\)/)
  // ② 超时/中断后把游标退回 0，重下一次 poll 能重新对齐。
  assert.match(src, /cursorRef\.current = 0/)
  // ③ 看门狗：循环自己死了（定时器没排上）也能被拉起来。
  assert.match(src, /const LINES_WATCHDOG_MS = 25000/)
  assert.match(src, /const watchdog = setInterval/)
  assert.match(src, /clearInterval\(watchdog\)/)
})

test('设置页：/pet 已捎带亲密度与小鱼干时，点开必须直接显示（曾经永远停在「正在读」）', async () => {
  let affinityReads = 0
  let treatsReads = 0
  const page = await renderSettingsPage({
    manualRestore: true,
    pet: (url) => {
      if (url.includes('/pet/affinity')) {
        affinityReads += 1
        return jsonResponse({ ok: true, value: { points: 1, max: 999999 } })
      }
      if (url.includes('/pet/treats')) {
        treatsReads += 1
        return jsonResponse({ ok: true, value: { treats: 1, max: 999 } })
      }
      // 新版 /pet 会把两串数字一起带回来——正是这条路径曾经让「展开」什么都不读。
      return jsonResponse({
        ok: true,
        value: {
          installed: true,
          enabled: true,
          affinity: { points: 4321, max: 999999999 },
          treats: { treats: 7, max: 999 },
        },
      })
    },
  })
  await page.settle(50)
  assert.equal(affinityReads, 0, '收起态不许读')
  assert.equal(treatsReads, 0, '收起态不许读')
  await page.click('亲密度')
  const text = page.latestText()
  assert.match(text, /现在是 4321/, '/pet 里带来的点数必须直接显示，不能停在「正在读」')
  assert.match(text, /现在有 7/, '/pet 里带来的小鱼干也必须直接显示')
  assert.doesNotMatch(text, /正在读她和挂件的状态/, '不许永远停在读取中')
  assert.equal(affinityReads, 0, '已经有现成数据就不该再多打一次 /pet/affinity')
  page.dispose()
})
