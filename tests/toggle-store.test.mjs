import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STORE_VERSION,
  normalizeStore,
  emptyStore,
  withDefaults,
  withSessionFlags,
  withPrunedSessions,
  serializeStore,
  parseStore,
} from '../src/toggle-store.mjs'
import { DEFAULT_ENABLED } from '../src/toggle-state.mjs'

/* 存储层的守门：读坏文件、写失败、字段漂移都不能让插件崩。
   这里的每一条都对应一个真实会发生的场景（用户手改文件 / 磁盘满 / 升级后旧文件）。 */

test('空存储：语气与思考关、台词开，无会话记录', () => {
  const store = emptyStore()
  assert.equal(store.version, STORE_VERSION)
  assert.deepEqual(store.defaults, { ...DEFAULT_ENABLED })
  assert.deepEqual(store.sessions, {})
})

test('读坏数据一律不抛错', () => {
  for (const bad of [null, undefined, 'x', 42, [], true, { sessions: 'nope' }]) {
    assert.doesNotThrow(() => normalizeStore(bad))
    const store = normalizeStore(bad)
    assert.deepEqual(store.defaults, { ...DEFAULT_ENABLED }, '坏输入必须回落出厂值')
  }
})

test('归一化：未知字段被丢掉（widget 也算未知）', () => {
  const store = normalizeStore({
    version: 99,
    defaults: { widget: true, 乱入: true },
    sessions: { s1: { persona: true, 也乱入: 1 }, '': { widget: true } },
  })
  assert.deepEqual(Object.keys(store.defaults).sort(), ['lines', 'persona', 'thinking'])
  assert.equal('widget' in store.defaults, false, 'v3 起 widget 从 defaults 里删掉')
  assert.deepEqual(Object.keys(store.sessions), ['s1'], '空 sessionId 必须丢掉')
  assert.equal(store.version, STORE_VERSION, '版本号归一到当前版本')
})

test('改默认值：不动已有会话（用户正在工作，不能被掀翻）', () => {
  let store = emptyStore()
  store = withSessionFlags(store, 's1', { persona: false, thinking: false, lines: false })
  store = withDefaults(store, { persona: true, thinking: true })
  assert.deepEqual(store.defaults, { persona: true, thinking: true, lines: true })
  assert.deepEqual(
    store.sessions.s1,
    { persona: false, thinking: false, lines: false },
    '已有会话必须保持不变',
  )
})

test('改会话状态：不影响默认值与其它会话', () => {
  const store = withDefaults(emptyStore(), { persona: true, thinking: true })
  const next = withSessionFlags(store, 'a', { persona: true, thinking: false, lines: false })
  assert.deepEqual(next.defaults, { persona: true, thinking: true, lines: true })
  assert.deepEqual(next.sessions.a, { persona: true, thinking: false, lines: false })
  assert.equal(store.sessions.a, undefined, '不得修改入参')
})

test('清理会话：只留活着的', () => {
  let store = emptyStore()
  store = withSessionFlags(store, 'alive', { persona: false, thinking: false })
  store = withSessionFlags(store, 'dead', { persona: true, thinking: true })
  const pruned = withPrunedSessions(store, ['alive'])
  assert.deepEqual(Object.keys(pruned.sessions), ['alive'])
})

test('序列化：同一份状态产出逐字节相同的文本（热重载不抖动）', () => {
  let store = emptyStore()
  store = withSessionFlags(store, 'b', { thinking: true })
  store = withSessionFlags(store, 'a', { persona: true })
  const one = serializeStore(store)
  const two = serializeStore(store)
  assert.equal(one, two)
  // 键名排序：a 在 b 前
  assert.ok(one.indexOf('"a"') < one.indexOf('"b"'))
  assert.ok(one.endsWith('\n'), '文件末尾要有换行（编辑器友好）')
})

test('往返：序列化后能原样解析回来', () => {
  let store = emptyStore()
  store = withDefaults(store, { persona: false, thinking: true })
  store = withSessionFlags(store, 's1', { persona: true, thinking: false, lines: false })
  const parsed = parseStore(serializeStore(store))
  assert.deepEqual(parsed, {
    version: store.version,
    defaults: store.defaults,
    sessions: { s1: { persona: true, thinking: false, lines: false } },
  })
})

test('迁移：v1 文件里的 widget 一律被删掉，其余默认值原样保留', () => {
  const v1 = JSON.stringify({
    version: 1,
    defaults: { widget: false, persona: true, thinking: true },
    sessions: { s1: { widget: false, persona: false, thinking: false } },
  })
  const out = parseStore(v1)
  assert.equal(out.version, STORE_VERSION)
  assert.equal('widget' in out.defaults, false, 'v3 起 widget 从 defaults 里删掉')
  assert.equal(out.defaults.persona, true, '其余默认值原样保留')
  assert.deepEqual(
    out.sessions.s1,
    { persona: false, thinking: false, lines: true },
    '会话条目不再携带 widget；缺失的 lines 回落出厂值（开）',
  )
})

test('迁移：v2 文件里的 widget 同样删掉（用户的挂件开关随能力一起退休）', () => {
  const v2 = JSON.stringify({ version: 2, defaults: { widget: false, persona: true, thinking: false }, sessions: {} })
  const out = parseStore(v2)
  assert.equal(out.version, STORE_VERSION)
  assert.equal('widget' in out.defaults, false)
  assert.equal(out.defaults.persona, true, '用户真正设过的默认值必须留住')
})

test('解析坏文本返回 null（调用方回落空存储，不是抛错）', () => {
  for (const bad of ['', '  ', 'not json', '{', '[]', 'null', '{"a":1}']) {
    assert.doesNotThrow(() => parseStore(bad))
    const out = parseStore(bad)
    // '[]' / '{"a":1}' 是合法 JSON 但没有我们的字段 → 归一化成空存储，不算失败
    assert.ok(out === null || typeof out === 'object')
  }
  assert.equal(parseStore('not json'), null)
  assert.equal(parseStore(''), null)
})

test('解析合法但缺字段的 JSON：补全成完整快照', () => {
  const out = parseStore('{"version":1}')
  assert.deepEqual(out.defaults, { ...DEFAULT_ENABLED })
  assert.deepEqual(out.sessions, {})
})
