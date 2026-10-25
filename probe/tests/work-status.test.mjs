import test from 'node:test'
import assert from 'node:assert/strict'
import {
  reduceWorkStatus,
  turnEndState,
  completedState,
  goalUpdateAction,
  poseOf,
} from '../src/work-status.mjs'

/* 移植自 PC2005-cloud/dsh-pet 的六档归约。这些断言锁的是三条"踩过坑才知道"的语义。 */

test('turn/start → thinking', () => {
  assert.equal(reduceWorkStatus({ type: 'turn/start', data: {} }), 'thinking')
})

test('tool/call → working，但 ask_user_question → waiting', () => {
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'bash' } }), 'working')
  assert.equal(reduceWorkStatus({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting')
})

test('turn/end completed（普通轮）→ success', () => {
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'success')
})

test('回归：turn/end aborted 必须返回 null，不能残留 working', () => {
  // 这就是"回合被打断后永远卡在 working"那个 bug 的守门断言。
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null)
  assert.equal(reduceWorkStatus({ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }), null)
})

test('turn/end blocked → waiting（等用户确认）', () => {
  assert.equal(turnEndState('blocked'), 'waiting')
})

test('错误系结束原因 → error', () => {
  for (const kind of ['error', 'max-tokens', 'timeout']) {
    assert.equal(turnEndState(kind), 'error', kind)
  }
})

test('回归：goal 续跑轮的中间完成只能算 result，不能庆祝', () => {
  assert.equal(completedState({ goalRound: true, closing: null }), 'result')
  assert.equal(completedState({ goalRound: true, closing: 'complete' }), 'success')
  assert.equal(completedState({ goalRound: true, closing: 'blocked' }), 'error')
  assert.equal(completedState(undefined), 'success')
})

test('update_goal 参数解析：只认 complete / blocked', () => {
  assert.equal(goalUpdateAction('{"action":"complete"}'), 'complete')
  assert.equal(goalUpdateAction('{"action":"blocked"}'), 'blocked')
  assert.equal(goalUpdateAction('{"action":"edit"}'), null)
  assert.equal(goalUpdateAction('not json'), null)
  assert.equal(goalUpdateAction(''), null)
})

test('字段名是 type 不是 kind（历史 bug 的守门断言）', () => {
  // 用 kind 传事件应该完全不匹配
  assert.equal(reduceWorkStatus({ kind: 'turn/start', data: {} }), null)
})

test('未知事件类型返回 null，不抛错', () => {
  assert.equal(reduceWorkStatus({ type: 'session/title', data: {} }), null)
  assert.equal(reduceWorkStatus(undefined), null)
  assert.equal(reduceWorkStatus(null), null)
})

test('六档全部能映射到表情，未知回落 idle', () => {
  for (const s of ['thinking', 'working', 'waiting', 'result', 'success', 'error']) {
    assert.notEqual(poseOf(s), undefined)
    assert.notEqual(poseOf(s), '')
  }
  assert.equal(poseOf('nonsense'), 'idle')
  assert.equal(poseOf(null), 'idle')
})
