/**
 * 共用原语（src/ui.mjs）的守门测试。
 *
 * 用户 2026-10-31 的返工意见（逐字）：「新增 client/src/ui.js 共用原语」，
 * 给了三层清单：色板（C.text / C.bg1 / C.accent / C.border2 …，每个带深色备用值）、
 * 标度（字号 15/13/11.5，间距 6/10/16/24，圆角四档）、组件（Card / Button / Switch /
 * Input / Select / Badge / Note / Field / PageHeader / Page），用法是
 * `makePrimitives(React.createElement)` 返回一整套。
 *
 * 这里守三件事：
 *   1. 清单里的数字不许漂（漂了就是"同一个次要文字又出现四种灰度"的开端）；
 *   2. 色板每一项都必须带宿主变量 + 兜底（只有兜底 = 换主题不跟随；只有变量 = 旧宿主变透明）；
 *   3. 十个组件都在，且建出来的节点类型/无障碍属性对得上。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'client.js')

const mod = await import('../src/ui.mjs')

/** 最小的 createElement 替身：把树变成可断言的普通对象。 */
const h = (type, props, ...children) => ({
  type,
  props: props && typeof props === 'object' ? props : {},
  children: children.flat().filter((c) => c !== null && c !== undefined),
})

test('标度：字号三档、间距四档、圆角四档，数字与用户给的一致', () => {
  assert.deepEqual(
    [mod.UI_FONT.lg, mod.UI_FONT.md, mod.UI_FONT.sm],
    [15, 13, 11.5],
    '字号三档必须是 15 / 13 / 11.5',
  )
  assert.deepEqual(
    [mod.UI_SPACE.s, mod.UI_SPACE.m, mod.UI_SPACE.l, mod.UI_SPACE.xl],
    [6, 10, 16, 24],
    '间距四档必须是 6 / 10 / 16 / 24',
  )
  const radii = [mod.UI_RADIUS.xs, mod.UI_RADIUS.sm, mod.UI_RADIUS.md, mod.UI_RADIUS.pill]
  assert.equal(radii.length, 4, '圆角要四档')
  assert.ok(radii.every((n) => typeof n === 'number' && n > 0), '圆角都是正数')
})

test('色板：每项都带宿主变量 + 兜底，深浅两套兜底不同', () => {
  const dark = mod.palette(true)
  const light = mod.palette(false)
  for (const key of ['text', 'sub', 'faint', 'bg1', 'bg2', 'border', 'border2', 'accent', 'accentSoft', 'ok', 'warn', 'error']) {
    assert.equal(typeof dark[key], 'string', `深色色板缺 ${key}`)
    assert.ok(dark[key].startsWith('var(--dsw-alias-'), `${key} 必须走宿主变量，不能写死颜色`)
    assert.ok(dark[key].includes(', '), `${key} 必须带兜底值（var(--x, 兜底)）`)
    assert.ok(dark[key].endsWith(')'), `${key} 的括号要闭合`)
  }
  assert.notEqual(dark.text, light.text, '深浅两套兜底不能一样，否则换主题等于没换')
  assert.notEqual(dark.border2, light.border2)
})

test('主题判定：宿主属性优先，其次 class，最后系统偏好，都不给就按深色', () => {
  const mk = (attr, cls, prefers) => ({
    document: { documentElement: { getAttribute: () => attr, className: cls } },
    matchMedia: () => ({ matches: prefers }),
  })
  assert.equal(mod.isDarkTheme(mk('dark', '', false)), true, 'data-theme=dark 优先')
  assert.equal(mod.isDarkTheme(mk('light', '', true)), false, 'data-theme=light 优先')
  assert.equal(mod.isDarkTheme(mk(null, 'theme-dark x', false)), true, 'class 里有 dark')
  assert.equal(mod.isDarkTheme(mk(null, 'theme-light', true)), false, 'class 里有 light')
  assert.equal(mod.isDarkTheme(mk(null, '', false)), false, '只剩系统偏好时听它的')
  assert.equal(mod.isDarkTheme({}), true, '什么都没有就按深色兜底')
})

test('makePrimitives：没有 createElement 就明确报错，不许静默降级', () => {
  assert.throws(() => mod.makePrimitives(undefined), /createElement/)
  const U = mod.makePrimitives(h)
  assert.equal(U.dark, true, '默认深色')
  assert.equal(U.C.text, mod.palette(true).text, 'C 就是色板本身')
})

test('十个组件都在，且节点类型与无障碍属性对得上', () => {
  const U = mod.makePrimitives(h, { dark: true })
  for (const name of ['Page', 'PageHeader', 'Card', 'Button', 'Switch', 'Input', 'Select', 'Badge', 'Note', 'Field']) {
    assert.equal(typeof U[name], 'function', `缺组件 ${name}`)
  }

  const card = U.Card({ title: '标题', children: '内容' })
  assert.equal(card.type, 'section', '卡片是 section')
  assert.equal(card.children[0].props.style.fontSize, mod.UI_FONT.md, '卡片标题用 13 号')
  assert.equal(card.props.style.borderRadius, mod.UI_RADIUS.md, '卡片圆角用 md 档')

  const btn = U.Button({ children: '保存', variant: 'primary', disabled: true })
  assert.equal(btn.type, 'button')
  assert.equal(btn.props.type, 'button', '默认 type=button，别在表单里触发提交')
  assert.equal(btn.props.disabled, true)
  assert.equal(btn.props.style.color, '#fff', '主按钮文字是白色')

  const sw = U.Switch({ checked: true, label: '开启' })
  assert.equal(sw.props.role, 'switch', '开关要用 role=switch')
  assert.equal(sw.props['aria-checked'], 'true')
  assert.equal(U.Switch({ checked: false }).props['aria-checked'], 'false')

  assert.equal(U.Input({ value: '3', ariaLabel: '数量' }).type, 'input')
  assert.equal(U.Input({ value: '3' }).props.value, '3')
  assert.equal(U.Input({}).props.value, '', '空值不许渲染成 undefined')

  const sel = U.Select({ value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] })
  assert.equal(sel.type, 'select')
  assert.equal(sel.children.length, 2)

  assert.equal(U.Badge({ children: '已开' }).type, 'span')
  assert.equal(U.Note({ children: '说明' }).props.role, undefined)
  assert.equal(U.Note({ children: '出错了', tone: 'error' }).props.role, 'alert', '错误行要能被读屏器念出来')

  const field = U.Field({ label: '目录', hint: '点右边选', children: '控件' })
  assert.equal(field.type, 'div')
  assert.equal(field.children[0].type, 'label', 'Field 左边是 label')
})

test('传进来的 style 只能覆盖，不能把基础样式整段顶掉', () => {
  const U = mod.makePrimitives(h)
  const card = U.Card({ title: 't', style: { marginTop: 99 } })
  assert.equal(card.props.style.marginTop, 99, '外部样式生效')
  assert.ok(card.props.style.border, '但边框还在（不是整段替换）')
  assert.equal(card.props.style.borderRadius, mod.UI_RADIUS.md)
})

test('构建产物里确实内联了原语层，并且设置页真的在用它', () => {
  const code = readFileSync(CLIENT, 'utf8')
  assert.ok(code.includes('function makePrimitives('), '构建期要把 src/ui.mjs 内联进 client.js')
  assert.ok(code.includes('const UI = makePrimitives(h)'), '展示层要造一整套原语')
  assert.ok(code.includes('UI.Card'), '卡片要走原语，不许每个卡片自己写内联样式')
  assert.ok(code.includes('UI.PageHeader'), '页头要走原语')
  assert.equal(code.split('export ').length, 1, '产物里不许残留 export')
})
