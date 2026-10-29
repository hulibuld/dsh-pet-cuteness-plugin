import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { decidePersona } from '../index.js'
import { resolvePersonaOrder, buildStableSection, isMainAgent } from '../src/persona-text.mjs'
import { matchByCardRules } from '../src/persona-card.mjs'

/* 探针接线层的测试：只测"接线决策"，不重复测纯函数（那边有自己的文件）。 */

const CARDS = [
  { id: 'deepseek', match: { provider: ['deepseek'], model: ['deepseek', 'v4'] } },
  { id: 'claude', match: { provider: ['anthropic', 'claude'], model: ['claude', 'sonnet'] } },
  { id: 'generic' },
]

test('接线：卡规则优先于硬编码表（加模型只改数据不改代码）', () => {
  const out = decidePersona({
    cards: CARDS,
    selection: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    options: undefined,
  })
  assert.equal(out.personaId, 'deepseek')
  assert.match(out.source, /cardRule/)
})

test('接线：卡规则未命中时回落到硬编码表', () => {
  // provider 与 model 都不在卡里，但硬编码表认识 gpt
  const out = decidePersona({
    cards: CARDS,
    selection: { provider: 'openai', model: 'gpt-5' },
    options: undefined,
  })
  assert.equal(out.personaId, 'gpt')
  assert.doesNotMatch(out.source, /cardRule/)
})

test('接线：两者都认不出时 generic', () => {
  const out = decidePersona({
    cards: CARDS,
    selection: { provider: 'some-vendor', model: 'mystery-1' },
    options: undefined,
  })
  assert.equal(out.personaId, 'generic')
})

test('接线：投影为空时用 agent.options（并标明来源）', () => {
  const out = decidePersona({
    cards: CARDS,
    selection: undefined,
    options: { provider: 'anthropic', model: 'claude-sonnet-4' },
  })
  assert.equal(out.personaId, 'claude')
  assert.equal(out.source.startsWith('agent.options'), true)
})

test('接线：没有卡片数据时仍能工作（素材坏了不该拖垮插件）', () => {
  const out = decidePersona({
    cards: [],
    selection: { provider: 'deepseek', model: 'deepseek-chat' },
    options: undefined,
  })
  assert.equal(out.personaId, 'deepseek') // 硬编码表兜住了
})

test('matchByCardRules 不是贪婪匹配：不同角色不会互相抢', () => {
  const out = matchByCardRules(CARDS, 'anthropic', 'claude-sonnet-4')
  assert.equal(out, 'claude')
})

test('顺序：读不到就不注册（不猜数字）', () => {
  assert.equal(resolvePersonaOrder(() => undefined), null)
  assert.equal(resolvePersonaOrder(() => NaN), null)
  assert.equal(resolvePersonaOrder(() => '0'), null)
  assert.equal(resolvePersonaOrder(() => { throw new Error('unknown name') }), null)
})

test('顺序：(0,500) 开区间两侧越界都拒绝', () => {
  assert.equal(resolvePersonaOrder(() => -1), null)  // -1+1 = 0，不满足 > 0
  assert.equal(resolvePersonaOrder(() => 499), null) // 499+1 = 500，撞上 PLAN_POLICY
  assert.equal(resolvePersonaOrder(() => 0), 1)     // 正常落点
  assert.equal(resolvePersonaOrder(() => 0, 10), 10) // 社区惯例的 +10 也合法
})

test('段落：同一张卡逐字节稳定（前缀缓存前提）', () => {
  const a = buildStableSection({ personaText: 'x', quirk: '大白饭', personaId: 'deepseek' })
  const b = buildStableSection({ personaText: 'x', quirk: '大白饭', personaId: 'deepseek' })
  assert.equal(a, b)
})

test('回归：恒定段不随 persona 变化（否则切模型就打穿缓存）', () => {
  assert.equal(
    buildStableSection({ personaText: 'x', personaId: 'a' }),
    buildStableSection({ personaText: 'x', personaId: 'b' }),
  )
})

test('子代理判据：只看 origin（字面量类型，一条就够）', () => {
  assert.equal(isMainAgent({ session: { header: { origin: 'subagent' } } }), false)
  assert.equal(isMainAgent({ session: { header: {} } }), true)
})

test('回归：fork 会话不误伤（宿主 fork 只写 parentSession）', () => {
  assert.equal(isMainAgent({ session: { header: { parentSession: 'x', isSeeded: true } } }), true)
})

test('回归：读不到 header 时不注册', () => {
  assert.equal(isMainAgent(undefined), false)
})

test('回归：中文思考条款不能被子代理判据关掉（否则子代理全英文思考）', () => {
  // 工程评审 D12：人设段落走 agent.ctx + 跳过子代理；
  // 如果中文思考也塞进那段，结果就是主会话中文、子代理英文——
  // 而子代理正是产出代码评审和调研结论的那批。
  // 现在它单独注册在全局 ctx，所以 index.js 里必须出现这个 section 名。
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("name: 'ai-waifu:thinking-language'"), '中文思考条款应独立注册')
  assert.ok(src.includes('THINKING_LANGUAGE_SECTION'), '应引用共享常量')
  // 人设段必须关掉它，避免重复注入
  assert.ok(src.includes('thinkingLanguage: false'), '人设段应关掉中文思考条款')
})

test('回归：段落注册必须同时拿到自己的 disposer（两个拥有者）', () => {
  // 注册在 agent.ctx 上，disposer 属于 agent fiber；插件被停用时
  // 段落会留在系统提示词里，直到会话销毁。所以要在插件自己的 effect 里握住它。
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /agentCtx\.effect\(/, '人设段必须包在 agentCtx.effect 里')
  assert.match(src, /ctx\.effect\(/, '插件层也要有 effect 拿住生命周期')
})
