import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FLAG_KEYS,
  MASTER_KEYS,
  DEFAULT_ENABLED,
  normalizeFlags,
  masterState,
  toggleMaster,
  toggleFlag,
  describeFlags,
  flagsForSession,
  setFlagsForSession,
  pruneSessions,
  isFlagKey,
} from '../src/toggle-state.mjs'

/* 这一组锁的是「开关不能把用户搞糊涂」：
     1. 三项：persona（人设语气）/ thinking（中文思考）/ lines（台词）。
        语气与思考默认关（会改写每次请求的提示词，费钱）；
        台词默认开（只读模型自己的推理流，零成本，且"什么都不出"正是用户抱怨的观感）。
        2026-10-22 起 `widget` 已被删除（挂件改由 dsh-pet 出镜），所以本文件里
        任何 widget 断言都必须是"它不存在"，而不是"它默认开"。
     2. 主开关只管语气与思考（MASTER_KEYS）：台词出厂就开，算进主开关会让
        「全部关闭」这个词永远不出现。
     3. 主开关的"部分开启"不能表现成"关"（点一下把另一项也关掉 = 反直觉）；
     4. 存储里任何脏数据都必须回落，不许抛错（抛错会让整条 entry 退役）。 */

/** 一份完整的出厂 flags（省得每条断言都写三行）。 */
const OFF = { persona: false, thinking: false, lines: true }

test('出厂默认：语气与思考关、台词开，且默认值里没有 widget', () => {
  assert.deepEqual({ ...DEFAULT_ENABLED }, OFF)
  assert.deepEqual(normalizeFlags(undefined), OFF)
  assert.equal('widget' in DEFAULT_ENABLED, false, 'widget 已删除，不许再出现在默认值里')
  assert.deepEqual([...FLAG_KEYS], ['persona', 'thinking', 'lines'])
})

test('normalizeFlags：只认真布尔，字符串 "false" 不许被当成开启', () => {
  const base = { persona: false, thinking: false, lines: false }
  const out = normalizeFlags({ persona: 'false', thinking: 1, lines: 'true' }, base)
  assert.deepEqual(out, base)
})

test('normalizeFlags：未知键忽略（含已删除的 widget），缺失键回落', () => {
  const out = normalizeFlags({ persona: true, widget: true, 未知: true })
  assert.deepEqual(out, { persona: true, thinking: false, lines: true })
  assert.deepEqual(Object.keys(out).sort(), [...FLAG_KEYS].sort())
  assert.equal('widget' in out, false, '旧文件里的 widget 必须被丢掉，不能复活')
})

test('normalizeFlags：脏输入不抛错（null / 数组 / 字符串 / 数字）', () => {
  for (const bad of [null, [], 'x', 42, true]) {
    assert.doesNotThrow(() => normalizeFlags(bad))
  }
})

test('主开关只看语气与思考：台词开着不算「部分开启」', () => {
  assert.deepEqual([...MASTER_KEYS], ['persona', 'thinking'])
  // 出厂状态（台词开、另两项关）必须是"全关"，否则主开关永远显示"部分"。
  assert.equal(masterState(OFF), 'off')
  assert.equal(masterState({ persona: true, thinking: true, lines: false }), 'on')
  assert.equal(masterState({ persona: true, thinking: false, lines: false }), 'partial')
})

test('主开关：全开 → 全关（台词不受影响，它不归主开关管）', () => {
  const next = toggleMaster({ persona: true, thinking: true, lines: true })
  assert.deepEqual(next, { persona: false, thinking: false })
})

test('主开关：全关 → 全开', () => {
  const next = toggleMaster({ persona: false, thinking: false, lines: true })
  assert.deepEqual(next, { persona: true, thinking: true })
})

test('主开关：部分 → 全开（不是全关，否则会把用户已在用的那一项关掉）', () => {
  const next = toggleMaster({ persona: false, thinking: true, lines: false })
  assert.deepEqual(next, { persona: true, thinking: true })
})

test('单项开关：只翻自己，不连坐', () => {
  const before = { persona: true, thinking: true, lines: true }
  const next = toggleFlag(before, 'thinking')
  assert.deepEqual(next, { persona: true, thinking: false, lines: true })
  assert.equal(before.thinking, true, '不得修改入参')
})

test('单项开关：台词也能单独关掉（关掉后不再显示气泡）', () => {
  const next = toggleFlag(OFF, 'lines')
  assert.deepEqual(next, { persona: false, thinking: false, lines: false })
})

test('单项开关：非法 key 原样返回；widget 已经是非法 key', () => {
  const before = { ...OFF }
  assert.deepEqual(toggleFlag(before, '不存在的'), before)
  assert.equal(isFlagKey('persona'), true)
  assert.equal(isFlagKey('lines'), true)
  assert.equal(isFlagKey('nope'), false)
  assert.equal(isFlagKey('widget'), false, 'widget 已删除：它不能再是一个可切换的键')
})

test('describeFlags：三种状态都能说人话（读屏器要能听懂）', () => {
  assert.match(describeFlags({ persona: false, thinking: false, lines: false }), /全部关闭/)
  assert.match(describeFlags({ persona: true, thinking: true, lines: true }), /全部开启/)
  // 出厂状态：台词开着 → 摘要里必须说出台词，不能假装"全部关闭"。
  assert.match(describeFlags(OFF), /台词/)
  const partial = describeFlags({ persona: false, thinking: true, lines: false })
  assert.match(partial, /中文思考/)
  assert.doesNotMatch(partial, /全部/)
  assert.doesNotMatch(partial, /挂件/, '挂件已删除，摘要里不该再出现它')
})

test('按会话存：没有记录的会话回落到默认值（设置页决定）', () => {
  const store = {}
  assert.deepEqual(flagsForSession(store, 's1', { persona: false, thinking: true, lines: false }), {
    persona: false,
    thinking: true,
    lines: false,
  })
})

test('按会话存：会话条目能覆盖三项；旧条目残留的 widget 被忽略', () => {
  const store = { s1: { widget: false, persona: true, thinking: false, lines: false } }
  const out = flagsForSession(store, 's1', { persona: false, thinking: true, lines: true })
  assert.deepEqual(out, { persona: true, thinking: false, lines: false })
  assert.equal('widget' in out, false, '残留的 widget 不许进入生效值')
})

test('按会话存：写回是纯函数，不改入参', () => {
  const store = { s1: { persona: true, thinking: true, lines: true } }
  const next = setFlagsForSession(store, 's2', { persona: true, thinking: false, lines: false })
  assert.deepEqual(store, { s1: { persona: true, thinking: true, lines: true } })
  assert.deepEqual(next.s2, { persona: true, thinking: false, lines: false })
})

test('按会话存：没有 sessionId 时回落默认，不写脏键', () => {
  assert.deepEqual(flagsForSession({}, undefined, DEFAULT_ENABLED), OFF)
  assert.deepEqual(setFlagsForSession({}, '', { persona: true }), {})
})

test('清理：只保留还活着的会话，且归一化旧值', () => {
  const store = {
    alive: { widget: true, persona: false, thinking: false, lines: true },
    dead: { widget: true, persona: true, thinking: true, lines: true },
    dirty: { widget: 'yes' },
  }
  // 注意：这三个条目里带 widget 是有意的——它们代表 v2 时代留在磁盘上的脏数据，
  // 清理时 widget 必须被丢掉，只留三项。
  const out = pruneSessions(store, ['alive', 'dirty'])
  assert.deepEqual(Object.keys(out).sort(), ['alive', 'dirty'])
  assert.deepEqual(out.alive, { persona: false, thinking: false, lines: true })
  assert.deepEqual(
    out.dirty,
    { persona: false, thinking: false, lines: true },
    '脏值要归一化到出厂默认',
  )
})

test('主开关全关之后，每一项都不能残留在开的状态', () => {
  let flags = { persona: true, thinking: true, lines: true }
  flags = { ...flags, ...toggleMaster(flags) }
  assert.equal(flags.persona, false)
  assert.equal(flags.thinking, false)
  assert.equal(flags.lines, true, '台词不归主开关管，不该被连带关掉')
})
