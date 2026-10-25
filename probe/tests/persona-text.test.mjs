import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolvePersonaOrder,
  buildStableSection,
  buildVolatileContext,
  buildQuirkHook,
  isMainAgent,
} from '../src/persona-text.mjs'

/* 这一组锁的是"人设不能打穿前缀缓存、不能污染子代理、不能猜 order"三条铁律。 */

const ANCHORS = { DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500 }
const lookup = (name) => ANCHORS[name]

test('order：读得到锚点时用 锚点+1', () => {
  assert.equal(resolvePersonaOrder(lookup), 1)
})

test('order：offset 可调，但仍须落在 (0,500)', () => {
  assert.equal(resolvePersonaOrder(lookup, 10), 10)
})

test('order：读不到就返回 null —— 绝不猜一个数字兜底', () => {
  assert.equal(resolvePersonaOrder(() => undefined), null)
  assert.equal(resolvePersonaOrder(() => NaN), null)
  assert.equal(resolvePersonaOrder(() => { throw new Error('boom') }), null)
})

test('order：越过 PLAN_POLICY 就拒绝（宿主重排表时的保护）', () => {
  const shifted = () => 499 // 499+1 = 500，撞上 PLAN_POLICY
  assert.equal(resolvePersonaOrder(shifted), null)
})

test('order：锚点变成负数时也拒绝', () => {
  const negative = () => -1 // -1+1 = 0，不满足 > 0
  assert.equal(resolvePersonaOrder(negative), null)
})

test('恒定段：同一输入必须逐字节相同（前缀缓存的前提）', () => {
  const input = { personaText: '你是蓝色大肥鱼。', quirk: '大白饭', personaId: 'deepseek' }
  assert.equal(buildStableSection(input), buildStableSection(input))
})

test('恒定段：多次调用不含时间/随机数', () => {
  const a = buildStableSection({ personaText: 'x', personaId: 'claude' })
  const b = buildStableSection({ personaText: 'x', personaId: 'claude' })
  assert.equal(a, b)
  // 不应出现时间戳形态的片段
  assert.doesNotMatch(a, /\d{10,}/)
})

test('回归：恒定段里不许出现 persona id（切模型=整段前缀全价重算）', () => {
  // 曾被工程评审打掉：persona id 是 provider/model 的函数，
  // 用户中途切模型 → persona 变 → 恒定段首字节变 → 整段前缀失效。
  // 自检信息应进日志，不该进提示词。
  const a = buildStableSection({ personaText: 'x', personaId: 'deepseek' })
  const b = buildStableSection({ personaText: 'x', personaId: 'claude' })
  assert.equal(a, b, '恒定段不能随 persona 变化')
  assert.doesNotMatch(a, /persona=/, '不得有自检行')
  assert.doesNotMatch(a, /deepseek/)
})

test('恒定段：包含不居高临下与给意见条款', () => {
  const text = buildStableSection({ personaText: 'x' })
  assert.match(text, /不居高临下/)
  assert.match(text, /给意见/)
})

test('回归：篇幅纪律不能把「写代码/解释」也压短（装萌宠不能把 AI 变笨）', () => {
  // lume 原版写的是「像发微信一样说话：1–3 句」，抄进常量段后会砍掉实际工作内容。
  const text = buildStableSection({ personaText: 'x' })
  assert.doesNotMatch(text, /1–3 句|1-3 句/, '不得把「1–3 句」写进恒定段')
  assert.match(text, /写代码/, '必须明确说明写代码/查资料时不压缩')
  assert.match(text, /闲聊/, '必须明确说明只有闲聊时才短')
})

test('回归：不能把「给意见」也禁掉', () => {
  const text = buildStableSection({ personaText: 'x' })
  assert.doesNotMatch(text, /不说「我建议」/, '禁的是未经请求的说教，不是专业判断')
  assert.match(text, /直接给出你的判断/, '问「怎么改」必须能回答')
})

test('回归：不得要求每次回答都加人设开场白', () => {
  const text = buildStableSection({ personaText: 'x' })
  assert.match(text, /不要在每次回答前加人设开场白/)
  assert.doesNotMatch(text, /第一句就必须是这个人会说的话/, '这条会逼出"好的呀"式开场，正事要多等一句')
})

test('走神钩子：三要素齐全（概率 / 条件 / 边界）', () => {
  const hook = buildQuirkHook('大白饭')
  assert.match(hook, /十次里有一次/) // 概率
  assert.match(hook, /脑子有余力/)   // 条件
  assert.match(hook, /不要在给用户的答复正文里提/) // 边界
})

test('走神钩子：没配 quirk 时返回空串，不留空段落', () => {
  assert.equal(buildQuirkHook(''), '')
  assert.equal(buildQuirkHook(undefined), '')
})

test('易变段当前为空（M1 不注入记忆），但接口存在', () => {
  assert.equal(buildVolatileContext(), '')
})

test('主会话判据 ①：origin === subagent 跳过', () => {
  assert.equal(isMainAgent({ session: { header: { origin: 'subagent' } } }), false)
})

test('主会话判据 ②：delegationDepth > 0 跳过', () => {
  assert.equal(
    isMainAgent({ session: { header: { delegationDepth: 1 } } }),
    false,
    '深度 >0 是子代理',
  )
  assert.equal(
    isMainAgent({ session: { header: { delegationDepth: 0 } } }),
    true,
    '深度 0 不构成子代理',
  )
})

test('主会话判据 ③：有 parentSession 且非 fork 播种 → 跳过', () => {
  // 子代理原文：{ parentSession, isSeeded, origin: 'subagent', delegationDepth }
  // 去掉 origin 后仍应被 parentSession 拦住，证明第三重判据独立生效。
  assert.equal(
    isMainAgent({ session: { header: { parentSession: 'parent-abc' } } }),
    false,
    '有父会话就要跳过',
  )
})

test('回归：用户 fork 出来的会话必须被当作主会话（fork 写 isSeeded: true）', () => {
  // 宿主 fork 原文：meta: { parentSession: source.header.id, isSeeded: true }
  // —— 不写 origin、不写 delegationDepth。
  // 若只看 parentSession 会把用户 fork 的主会话当子代理跳掉，
  // 症状是「fork 之后她突然变回普通助手」。
  const forked = { session: { header: { parentSession: 'parent-abc', isSeeded: true } } }
  assert.equal(isMainAgent(forked), true, 'fork 会话必须挂人设')
})

test('子代理即使 isSeeded: true 也被 origin 拦下（三重判据不互相放水）', () => {
  const child = {
    session: {
      header: {
        parentSession: 'parent-abc',
        isSeeded: true,
        origin: 'subagent',
        delegationDepth: 1,
      },
    },
  }
  assert.equal(isMainAgent(child), false)
})

test('主会话判据：普通会话通过', () => {
  assert.equal(isMainAgent({ session: { header: {} } }), true)
  assert.equal(isMainAgent({ session: { header: { cwd: '/x' } } }), true)
  assert.equal(isMainAgent({ session: { header: { isSeeded: false } } }), true)
})

test('主会话判据：读不到 header 时不注册（宁可不挂，不要挂错）', () => {
  // 反过来的失败模式（挂到子代理上）是会被截图嘲笑的；不挂只是"这个会话没人格"。
  assert.equal(isMainAgent(undefined), false)
  assert.equal(isMainAgent({}), false)
  assert.equal(isMainAgent({ session: {} }), false)
})

test('回归：声音条款必须在恒定段最前（语气强度返工的守门断言）', () => {
  // 用户实测反馈「语气一点作用都没有」。根因是六条纪律里五条是"不要"，
  // 净效应在教模型收敛个性。声音条款把"有颜色"设成默认状态。
  const text = buildStableSection({ personaText: 'x' })
  const voiceAt = text.indexOf('## 声音')
  assert.ok(voiceAt >= 0, '缺声音条款')
  assert.equal(voiceAt, 0, '声音条款必须排在最前，否则模型先读卡片再演戏，语气会散')
  assert.match(text, /默认有颜色/)
  assert.match(text, /任何助手都能说出口/, '缺自检条款：抹掉人设后若还是通用助手腔就该重写')
})

test('回归：声音条款不得含 persona 可变内容（缓存）', () => {
  const a = buildStableSection({ personaText: 'x' })
  assert.doesNotMatch(a, /\d{10,}/)
  assert.doesNotMatch(a, /provider|model=/, '不得写死模型名')
})

// ── 2026-10-21 用户实测返工：思考里也必须是这个人 ────────────────────────
// 原话：「语气只出现在对话里面，思考里没有。这是不可以接受的。
//         思考要类似于那种八九岁心性的无忧无虑的小女孩」

test('思考口径：恒定段里必须包含「思考也要是她」的条款', () => {
  const text = buildStableSection({ personaText: 'x' })
  assert.ok(text.includes('## 思考口径'), '缺了思考口径这一节，模型会退化成「回答像她、思考像助手」')
  assert.ok(text.includes('八九岁'), '心性基调要写死，否则模型自己脑补成「小一号的助手」')
  assert.ok(text.includes('不是另一个人在写报告'), '必须明确否掉「思考=审查报告」这个默认行为')
})

test('思考口径：不许把「八九岁心性」写成「八岁智力」', () => {
  const text = buildStableSection({ personaText: 'x' })
  assert.ok(text.includes('八九岁是**心性**，不是智力'), '必须挡住「为了萌而降智」的误读')
  assert.ok(text.includes('一个都不能漏'), '该做的检查不能因为人设而减少')
})

test('思考口径可以单独关掉（不影响回答语气）', () => {
  const withVoice = buildStableSection({ personaText: 'x', thinkingVoice: true })
  const without = buildStableSection({ personaText: 'x', thinkingVoice: false })
  assert.ok(withVoice.includes('## 思考口径'))
  assert.ok(!without.includes('## 思考口径'))
  // 关掉思考口径不能连声音条款一起关掉。
  assert.ok(without.includes('## 声音'))
})

test('思考口径段逐字节恒定（不吃前缀缓存）', () => {
  assert.equal(buildStableSection({ personaText: 'x' }), buildStableSection({ personaText: 'x' }))
})
