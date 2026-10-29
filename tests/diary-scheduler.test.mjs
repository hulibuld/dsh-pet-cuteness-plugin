import assert from 'node:assert/strict'
import test from 'node:test'

const mod = await import('../index.js')

/** 造一个「本地某天某时某分」的 Date（用本地时间构造，避免时区坑）。 */
function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0)
}

test('dueDiaryLabel：过了 21:00 就该写今天这一篇', () => {
  const due = mod.dueDiaryLabel(at(2026, 10, 24, 21, 0), '21:00')
  assert.equal(due.label, '2026-10-24')
})

test('dueDiaryLabel：21:05 还没写也要认账（这就是「快 22 点没自动写」的补写入口）', () => {
  const due = mod.dueDiaryLabel(at(2026, 10, 24, 21, 58), '21:00')
  assert.equal(due.label, '2026-10-24')
})

test('dueDiaryLabel：还没到点时，指的是昨天那一篇（窗口已结束）', () => {
  const due = mod.dueDiaryLabel(at(2026, 10, 24, 20, 59), '21:00')
  assert.equal(due.label, '2026-10-23')
  assert.equal(due.end, at(2026, 10, 23, 21, 0).getTime())
})

test('dueDiaryLabel：写作时刻可配，23:30 写就按 23:30 切', () => {
  assert.equal(mod.dueDiaryLabel(at(2026, 10, 24, 23, 10), '23:30').label, '2026-10-23')
  assert.equal(mod.dueDiaryLabel(at(2026, 10, 24, 23, 40), '23:30').label, '2026-10-24')
})

test('diaryWindowFor：标签 D 的窗口是 [D-1 21:00, D 21:00)', () => {
  const w = mod.diaryWindowFor('2026-10-24', '21:00')
  assert.equal(w.end, at(2026, 10, 24, 21, 0).getTime())
  assert.equal(w.start, at(2026, 10, 23, 21, 0).getTime())
  assert.equal(w.end - w.start, 24 * 3600 * 1000)
})

test('diaryWindowFor：标签不合法时返回 null（不猜）', () => {
  assert.equal(mod.diaryWindowFor('2026/10/24', '21:00'), null)
  assert.equal(mod.diaryWindowFor('', '21:00'), null)
})
