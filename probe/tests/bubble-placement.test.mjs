import test from 'node:test'
import assert from 'node:assert/strict'
import { planOverlay } from '../src/bubble-placement.mjs'

/* 移植自 vlln/whale-girl 的几何算法。这些用例的价值在于：
   几何符号错误在浏览器里只表现为"气泡有点歪"，肉眼几乎发现不了，
   所以必须用数值断言守住。 */

const VW = 1200
const VH = 800
const PET = { width: 110, height: 110 }

/** 造一个"角色落在视口某处"的矩形。 */
const petAt = (left, top) => ({ ...PET, left, top, bottom: top + PET.height, right: left + PET.width })

const place = (rect, size, above, offsetY = 12) =>
  planOverlay({ rect, viewport: { w: VW, h: VH }, size, above, offsetY })

test('中部空间充足：请求上方就放上方，水平不动', () => {
  const p = place(petAt(545, 400), { w: 200, h: 36 }, true)
  assert.equal(p.up, true)
  assert.equal(p.top, '-12px')
  assert.equal(p.transform, 'translate(-50%, -100%)')
  assert.equal(p.left, '50%')
})

test('上方空间不足且下方更宽裕：翻面到下方', () => {
  const p = place(petAt(545, 4), { w: 200, h: 36 }, true)
  assert.equal(p.up, false)
  assert.equal(p.top, 'calc(100% + 12px)')
  assert.equal(p.transform, 'translateX(-50%)')
})

test('右侧越界：向左平移回视口内', () => {
  const p = place(petAt(1120, 400), { w: 200, h: 36 }, true)
  const m = /calc\(50% ([+-]) (\d+)px\)/.exec(p.left)
  assert.ok(m, `应产生位移表达式，实际是 ${p.left}`)
  assert.equal(m[1], '-')
})

test('左侧越界：向右平移回视口内', () => {
  const p = place(petAt(0, 400), { w: 200, h: 36 }, true)
  const m = /calc\(50% ([+-]) (\d+)px\)/.exec(p.left)
  assert.ok(m, `应产生位移表达式，实际是 ${p.left}`)
  assert.equal(m[1], '+')
})

test('锚点很窄、气泡很宽：位移按气泡自然宽度算，不被锚点宽度 clamp', () => {
  // 用户实测的「每行 3 个字」修好后会出现的几何：立绘只有 110px 宽，
  // 气泡自然宽度可以到 320px。居中/推回必须用 320 算，而不是用锚点宽度算。
  const rect = { left: 1100, width: 110, top: 400, bottom: 510, right: 1210 }
  const p = planOverlay({ rect, viewport: { w: VW, h: VH }, size: { w: 320, h: 36 }, above: true, offsetY: 6 })
  // 锚点中心 1155；右边界 = 1155 + 160 = 1315 超出 1200 - 8 = 1192 → 左移 123px
  assert.equal(p.left, 'calc(50% - 123px)')
  assert.equal(p.up, true)
})

test('比视口还宽：以视口居中，不是以角色居中', () => {
  const p = place(petAt(1000, 400), { w: VW + 200, h: 36 }, true)
  // 角色中心 1055，视口中心 600 → 需要向左位移 455
  assert.match(p.left, /calc\(50% - 455px\)/)
})

test('回归：offsetY 必须计入纵向可用空间（原 issue 的 5px 裁切）', () => {
  // 构造一个"只比 size.h 会判为放得下、算上 offsetY 其实放不下"的位置：
  // rect.top = margin + offsetY + size.h - 1 = 8 + 12 + 36 - 1 = 55
  const rect = petAt(545, 55)
  const size = { w: 200, h: 36 }
  const p = place(rect, size, true, 12)
  assert.equal(p.up, false, '上方实际放不下（缺 1px），应翻面到下方')
})

test('两侧都不足时取更宽裕的一侧', () => {
  // 视口 800 高，角色贴在底部附近，上方很宽裕、下方很窄
  const rect = { ...PET, left: 545, top: 700, bottom: 700 + PET.height, right: 545 + PET.width }
  const p = place(rect, { w: 200, h: 36 }, false, 12)
  assert.equal(p.up, true, '请求下方但下方不够、上方更宽裕 → 翻到上方')
})
