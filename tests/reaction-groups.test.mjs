import test from 'node:test'
import assert from 'node:assert/strict'
import {
  REACTION_GROUPS,
  defaultReactionSettings,
  normalizeReactionSettings,
  isBucketEnabled,
} from '../src/reaction-groups.mjs'

/* 反应分组：让用户能关掉烦人的触发。核心断言是"每组至少留一个"与"未登记即静默"。 */

test('默认设置覆盖全部分组', () => {
  const d = defaultReactionSettings()
  for (const g of REACTION_GROUPS) {
    assert.ok(Array.isArray(d[g.id]), `分组 ${g.id} 缺默认值`)
    assert.ok(d[g.id].length > 0)
  }
})

test('working 默认关闭（工具调用太频繁，会刷屏）', () => {
  const d = defaultReactionSettings()
  assert.ok(!d.work.includes('working'), 'working 应默认关')
  assert.ok(d.work.includes('thinking'), 'thinking 应默认开')
})

test('归一化：踢掉不认识的值', () => {
  const out = normalizeReactionSettings({ click: ['click', 'nonsense'] })
  assert.deepEqual([...out.click], ['click'])
})

test('归一化：非法输入回落默认', () => {
  const out = normalizeReactionSettings(null)
  assert.deepEqual([...out.click], [...defaultReactionSettings().click])
})

test('归一化：某组被清空时回落该组默认（不允许全关）', () => {
  const out = normalizeReactionSettings({ click: [] })
  assert.ok(out.click.length > 0, '整组清空应回落默认，而不是变成静音')
})

test('isBucketEnabled：尊重用户关闭', () => {
  const settings = normalizeReactionSettings({ work: ['thinking'] })
  assert.equal(isBucketEnabled(settings, 'thinking'), true)
  assert.equal(isBucketEnabled(settings, 'done'), false)
})

test('isBucketEnabled：未登记的桶一律静默', () => {
  const settings = defaultReactionSettings()
  assert.equal(isBucketEnabled(settings, 'some-new-bucket'), false)
})

test('每个分组的 option id 唯一（防止登记冲突）', () => {
  const seen = new Set()
  for (const g of REACTION_GROUPS) {
    for (const o of g.options) {
      assert.ok(!seen.has(o.id), `option id 重复：${o.id}`)
      seen.add(o.id)
    }
  }
})
