/**
 * 亲密度纯文本层的单测。
 *
 * 这一层为什么要单独测：它动的是 **dsh-pet 的真实状态文件**（`~/.dsh/pet.json`），
 * 里面除了亲密度还有用户的皮肤、名字、投喂统计。一旦「读-改-写」写成「读一部分、
 * 写一份新的」，用户攒的名字和皮肤就全没了——而且不会报错，只会静默丢数据。
 * 所以这里把三件事钉死：① 只动 points；② 越界要夹住；③ 空输入不许当 0。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  AFFINITY_MAX,
  TREATS_MAX,
  backupPathFor,
  clampPoints,
  clampTreats,
  readPoints,
  readTreats,
  readTreatsFromPetJson,
  sameExceptPoints,
  sameExceptTreats,
  verifyPoints,
  verifyTreats,
  withPoints,
  writeTreatsToPetJson,
} from '../src/affinity-store.mjs'

const sample = () =>
  JSON.stringify(
    {
      petId: 'whale-girl',
      names: ['小肥鱼', '锦鲤'],
      skins: { current: 'default', owned: ['default', 'rain'] },
      affinity: { points: 304, lastPetAt: 1792819102112, pets: 25, feeds: 15, turns: 204 },
      treats: { small: 3 },
      display: { visible: true, size: 160, right: 56, bottom: 555, bubbleScale: 1 },
      gameplay: { autoPat: true },
    },
    null,
    2,
  )

test('clampPoints：越界夹住，上限就是 pet 自己的上限', () => {
  assert.deepEqual(clampPoints(AFFINITY_MAX + 1), { ok: true, points: AFFINITY_MAX })
  assert.deepEqual(clampPoints(-1), { ok: true, points: 0 })
  assert.deepEqual(clampPoints(0), { ok: true, points: 0 })
  assert.deepEqual(clampPoints(AFFINITY_MAX), { ok: true, points: AFFINITY_MAX })
  assert.deepEqual(clampPoints(12.6), { ok: true, points: 13 })
})

test('clampPoints：空输入与非数字不许被当成 0（那是「静默清空用户点数」）', () => {
  assert.deepEqual(clampPoints(''), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints('   '), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints('abc'), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints(null), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints(undefined), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints(true), { ok: false, code: 'bad-points' })
  assert.deepEqual(clampPoints(Number.NaN), { ok: false, code: 'bad-points' })
})

test('withPoints：只动 affinity.points，其余键逐个保留', () => {
  const before = JSON.parse(sample())
  const next = withPoints(sample(), 999)
  assert.equal(next.ok, true)
  assert.equal(next.before, 304)
  const after = JSON.parse(next.text)

  assert.equal(after.affinity.points, 999)
  assert.equal(after.affinity.turns, 204, '互动统计不许被冲掉')
  assert.equal(after.affinity.pets, 25)
  assert.deepEqual(after.names, ['小肥鱼', '锦鲤'], '名字是用户资产')
  assert.deepEqual(after.skins, before.skins)
  assert.deepEqual(after.treats, before.treats)
  assert.deepEqual(after.display, before.display)
  assert.deepEqual(after.gameplay, before.gameplay)

  // 递归比较：除 points 外必须完全一致（缩进被规范化不算差异）
  assert.deepEqual(sameExceptPoints(before, after), { ok: true })
})

test('sameExceptPoints：有人真动了别的键时必须报出来', () => {
  const before = JSON.parse(sample())
  const after = JSON.parse(sample())
  after.display.right = 0
  const result = sameExceptPoints(before, after)
  assert.equal(result.ok, false)
  assert.deepEqual(result.keys, ['display'])
})

test('readPoints：坏 JSON 与缺 affinity 要分开报，不能都当 0', () => {
  assert.deepEqual(readPoints('{ 坏掉的'), { ok: false, code: 'bad-json' })
  assert.deepEqual(readPoints('[]'), { ok: false, code: 'bad-json' })
  assert.deepEqual(readPoints('{"petId":"x"}'), { ok: false, code: 'no-affinity' })
  const ok = readPoints(sample())
  assert.equal(ok.ok, true)
  assert.equal(ok.points, 304)
})

test('withPoints：坏 JSON 不产生新文本（避免把半截文件写回去）', () => {
  const result = withPoints('{ 坏掉的', 500)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'bad-json')
  assert.equal(result.text, undefined)
})

test('verifyPoints：写进去又对不上要判失败', () => {
  assert.deepEqual(verifyPoints(sample(), 304), { ok: true, points: 304 })
  const mismatch = verifyPoints(sample(), 305)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'mismatch')
  assert.equal(mismatch.actual, 304)
})

test('backupPathFor：备份就放在原文件旁边', () => {
  assert.equal(backupPathFor('/Users/x/.dsh/pet.json'), '/Users/x/.dsh/pet.json.bak')
})

test('安装纪律：cordis.patch.yml 里不许出现 `id: pet`（重复挂载会出两个挂件）', async () => {
  // dsh-pet 的补丁层对「无 id 的 insert」只做 data.push，不去重也不警告。
  // 我们若在自己的 patch 里帮用户塞一行 pet，就会出现 [{id:pet},{id:ai-waifu},{id:pet}]，
  // 两个 PetService 同时写 pet.json 互相覆盖。这条断言就是为了防止它被"顺手加回来"。
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const text = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8')
  const hits = text.split('\n').filter((line) => /^\s*-?\s*id:\s*pet\s*$/.test(line))
  assert.equal(hits.length, 0, 'cordis.patch.yml 里出现了 `id: pet`：挂件只能由用户自己装，我们不许代挂')
})

/**
 * 真机形状（用户 2026-10-24 实测）：`treats` 不是数字，是
 * `{treats, lastTreatGrantAt, turnsAtLastTreatGrant}`。这里的重点是「只动 treats.treats，
 * 另两个字段和键序原样」——它们记录的是挂件自己的投喂节奏，被我们覆盖等于帮她刷投喂。
 */
const petWithTreats = () =>
  JSON.stringify(
    {
      petId: 'whale-girl',
      names: ['小肥鱼'],
      affinity: { points: 304, pets: 25 },
      treats: { treats: 1, lastTreatGrantAt: 1792819102112, turnsAtLastTreatGrant: 204 },
      display: { visible: true, size: 160 },
      gameplay: { autoPat: true },
    },
    null,
    2,
  ) + '\n'

test('TREATS_MAX：上限是用户口径的 999（不是亲密度那个 999999999）', () => {
  assert.equal(TREATS_MAX, 999)
  assert.notEqual(TREATS_MAX, AFFINITY_MAX)
})

test('clampTreats：越界夹住，非整数取整，空输入不许当 0', () => {
  assert.deepEqual(clampTreats(1000), { ok: true, treats: 999 })
  assert.deepEqual(clampTreats(999), { ok: true, treats: 999 })
  assert.deepEqual(clampTreats(-5), { ok: true, treats: 0 })
  assert.deepEqual(clampTreats(3.6), { ok: true, treats: 4 })
  assert.deepEqual(clampTreats(0), { ok: true, treats: 0 })
  assert.deepEqual(clampTreats('12'), { ok: true, treats: 12 })
  for (const bad of [undefined, null, true, false, '', '  ', 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    assert.deepEqual(clampTreats(bad), { ok: false, code: 'bad-treats' }, `${String(bad)} 不该被当成合法数量`)
  }
})

test('readTreats：吃对象形状也吃扁平数字，读不懂就报错不抛', () => {
  const objectShape = readTreats(petWithTreats())
  assert.equal(objectShape.ok, true)
  assert.equal(objectShape.treats, 1)
  assert.equal(objectShape.json.treats.lastTreatGrantAt, 1792819102112)

  assert.equal(readTreats(JSON.stringify({ treats: 7 })).treats, 7, '扁平形状（老文件）也要能读')
  assert.equal(readTreats(JSON.stringify({ petId: 'x' })).treats, 0, '没有 treats 字段当 0，不报错')
  assert.deepEqual(readTreats('{坏 json'), { ok: false, code: 'bad-json' })
  assert.deepEqual(readTreats('[]'), { ok: false, code: 'bad-json' })

  // 两个名字指向同一份实现
  assert.equal(readTreatsFromPetJson, readTreats)
})

test('writeTreatsToPetJson：只改 treats.treats，其余字段与键序原样保留', () => {
  const before = petWithTreats()
  const written = writeTreatsToPetJson(before, 999)
  assert.equal(written.ok, true)
  assert.equal(written.before, 1)

  const after = JSON.parse(written.text)
  assert.equal(after.treats.treats, 999)
  assert.equal(after.treats.lastTreatGrantAt, 1792819102112, '投喂时间戳不许被我们改掉')
  assert.equal(after.treats.turnsAtLastTreatGrant, 204)
  assert.deepEqual(Object.keys(after), Object.keys(JSON.parse(before)), '顶层键序不许变')
  assert.deepEqual(Object.keys(after.treats), Object.keys(JSON.parse(before).treats), 'treats 里的键序不许变')
  assert.deepEqual(after.names, ['小肥鱼'])
  assert.deepEqual(after.display, { visible: true, size: 160 })
  assert.deepEqual(sameExceptTreats(JSON.parse(before), after), { ok: true })
  // 写完之后回读必须对得上
  assert.deepEqual(verifyTreats(written.text, 999), { ok: true, treats: 999 })
})

test('writeTreatsToPetJson：扁平形状也只改那一个数字', () => {
  const written = writeTreatsToPetJson(JSON.stringify({ petId: 'x', treats: 3 }, null, 2), 5)
  assert.equal(written.ok, true)
  const after = JSON.parse(written.text)
  assert.equal(after.treats, 5)
  assert.equal(after.petId, 'x')
})

test('verifyTreats：回读对不上就是 verify-failed（不是 mismatch）', () => {
  assert.deepEqual(verifyTreats(petWithTreats(), 1), { ok: true, treats: 1 })
  const mismatch = verifyTreats(petWithTreats(), 2)
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.code, 'verify-failed')
  assert.equal(mismatch.actual, 1)
  assert.deepEqual(verifyTreats('坏 json', 1), { ok: false, code: 'bad-json' })
})

test('sameExceptTreats：别的键被动过就要报出来', () => {
  const before = JSON.parse(petWithTreats())
  const after = JSON.parse(petWithTreats())
  after.treats.treats = 9
  assert.deepEqual(sameExceptTreats(before, after), { ok: true })
  after.treats.lastTreatGrantAt = 0
  assert.equal(sameExceptTreats(before, after).ok, false)
})
