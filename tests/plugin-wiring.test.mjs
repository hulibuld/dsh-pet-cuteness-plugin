import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { THINKING_LANGUAGE_SECTION } from '../src/persona-text.mjs'

/* 接线层的守门：`apply()` 挂上去的段落，其 `text()` 会被宿主在每个 model step 调用。
   这里每一条都对应 2026-10-22 真实发生过的故障——`text()` 里读了未声明的 `DEBUG`，
   抛 `ReferenceError`，于是不是启动报一次，而是**每一步都报**，提示词组装整体失败。

   为什么这些用例不能并进纯逻辑测试：`DEBUG is not defined` 这类错误只存在于
   `index.js` 的接线闭包里，`src/` 的单测永远碰不到它。 */

const SESSION_ON = 'test-session'
const SESSION_OFF = 'off-session'

/**
 * 开关状态落到临时 DSH_HOME，避免污染真实 `~/.dsh`。
 *
 * 必须**在 import 之前**设好：`DATA_DIR` 在模块加载期求值（index.js 顶层）。
 * 也正因为 ESM 会缓存模块，这个文件里所有用例共用同一份种子数据，
 * 所以两个会话一次写全，而不是每个用例各写一次（那样第二个用例会读到第一份缓存）。
 */
const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-waifu-test-'))
mkdirSync(join(DSH_HOME, 'plugin-data'), { recursive: true })
writeFileSync(
  join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu.json'),
  JSON.stringify({
    version: 2,
    defaults: { widget: false, persona: false, thinking: false },
    sessions: {
      [SESSION_ON]: { persona: true, thinking: true },
      [SESSION_OFF]: { persona: false, thinking: false },
    },
  }),
  'utf8',
)
process.env.DSH_HOME = DSH_HOME

const { apply } = await import('../index.js')

/** 造一个最小可用的宿主 ctx；只实现插件真正用到的那几个面。 */
function mountPlugin({ sessionId = SESSION_ON, pet = null } = {}) {
  const sections = new Map()

  const prompt = {
    section(spec) {
      sections.set(spec.name, spec)
      return () => sections.delete(spec.name)
    },
    getSectionOrder(name) {
      if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 10
      return sections.get(name)?.order
    },
  }

  function makeAgentCtx() {
    return {
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : undefined
      },
      get(name) {
        return name === 'systemPrompt' ? prompt : false
      },
    }
  }

  const agent = {
    id: sessionId,
    session: { id: sessionId, header: {} },
    options: { provider: 'deepseek', model: 'deepseek-v4' },
    get ctx() {
      return makeAgentCtx()
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'systemPrompt') return prompt
      if (name === 'agents') return { list: () => [agent] }
      if (name === 'pet') return pet || false
      return false
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    on() {
      return () => {}
    },
    inject(_names, run) {
      run(ctx)
    },
  }

  return { ctx, sections }
}

test('人设段 text() 不抛错，且开启时返回非空正文', () => {
  const { ctx, sections } = mountPlugin()

  apply(ctx)

  const persona = sections.get('ai-waifu:persona')
  assert.ok(persona, '人设段必须注册成功')
  assert.equal(persona.order, 11, 'order 应紧贴 DEPLOYMENT_PERSONA_PREFIX 之后')

  // 回归点：宿主每步都会调用它，一旦抛错整段提示词组装就失败。
  let text
  assert.doesNotThrow(() => {
    text = persona.text({})
  }, 'text() 绝不能抛错')
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0, '开启时人设正文不能为空')

  // 同一次求值必须可重复：宿主每步都调，不能有副作用累积。
  assert.equal(persona.text({}), text)
})

test('关闭时 text() 返回空串而不是抛错或返回 undefined', () => {
  const { ctx, sections } = mountPlugin({ sessionId: SESSION_OFF })

  apply(ctx)

  const persona = sections.get('ai-waifu:persona')
  assert.ok(persona)
  let text
  assert.doesNotThrow(() => {
    text = persona.text({})
  })
  assert.equal(text, '')
})

test('会话级中文思考段求值不抛错且内容正确', () => {
  const { ctx, sections } = mountPlugin()

  apply(ctx)

  const thinking = sections.get('ai-waifu:thinking-language')
  assert.ok(thinking, '中文思考段必须注册成功')
  let text
  assert.doesNotThrow(() => {
    text = thinking.text({})
  })
  assert.equal(text, THINKING_LANGUAGE_SECTION)
})

test('子代理不挂人设段（人设不得污染子代理）', () => {
  const { ctx, sections } = mountPlugin()

  // 把既有 agent 换成子代理：header.origin === 'subagent'
  const subAgent = {
    id: 'sub-1',
    session: { id: 'sub-1', header: { origin: 'subagent' } },
    options: { provider: 'deepseek', model: 'deepseek-v4' },
    get ctx() {
      return { effect: (fn) => fn(), get: () => false }
    },
  }
  const originalGet = ctx.get
  ctx.get = (name) => (name === 'agents' ? { list: () => [subAgent] } : originalGet(name))

  apply(ctx)

  assert.equal(sections.get('ai-waifu:persona'), undefined, '子代理不应拿到人设段')
})

test('热重载：同一个 agent 再 apply 一次，必须先拆旧段再注册（新代码必须盖得上去）', () => {
  /* 这一条对应 2026-10-22 实测到的静默故障：
     人设段注册在 **agent** 的 ctx 上，插件热重载不回收它；宿主规则是
     "同一层重复注册同名段会 throw"。于是重载之后新实例抛错、被 catch 吞掉，
     真正生效的还是上一版注册的旧段 —— 代码改了，跑的却是旧代码，
     而 /debug 只显示 attached 0 个，看不出为什么。

     注意 mock 必须分成两层（宿主就是这么分的）：
       插件 ctx 上的段 → 热重载时回收；agent ctx 上的段 → 不回收（坑在这里）。
     如果把两层混成一个 Map，agent 层的同名遮蔽段会撞上全局段的同名注册，
     测出来的东西就全是 mock 自己的假故障。 */
  const globalSections = new Map()
  const agentSections = new Map()
  const layer = (store) => ({
    section(spec) {
      if (store.has(spec.name)) throw new Error('duplicate section in layer: ' + spec.name)
      store.set(spec.name, spec)
      return () => store.delete(spec.name)
    },
    getSectionOrder(name) {
      if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 10
      const own = store.get(name) ?? globalSections.get(name) ?? agentSections.get(name)
      return own?.order
    },
  })
  const globalPrompt = layer(globalSections)
  const agentPrompt = layer(agentSections)

  const agentCtx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    get: (name) => (name === 'systemPrompt' ? agentPrompt : false),
  }
  const agent = {
    id: 'reload-agent',
    session: { id: 'reload-agent', header: {} },
    options: { provider: 'deepseek', model: 'deepseek-v4' },
    ctx: agentCtx,
  }

  const makeCtx = () => {
    const disposers = []
    const self = {
      logger: { info() {}, warn() {} },
      get(name) {
        if (name === 'systemPrompt') return globalPrompt
        if (name === 'agents') return { list: () => [agent] }
        return false
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') {
          disposers.push(dispose)
          return dispose
        }
        return undefined
      },
      on() {
        return () => {}
      },
      inject(_names, run) {
        run(self)
      },
      /** 宿主卸载插件：只回收插件 ctx 上的注册。 */
      dispose() {
        while (disposers.length) {
          try {
            disposers.pop()()
          } catch {
            /* ignore */
          }
        }
      },
    }
    return self
  }

  const firstCtx = makeCtx()
  apply(firstCtx)
  const first = agentSections.get('ai-waifu:persona')
  assert.ok(first, '第一次注册必须成功（人设段落在 agent 层）')
  assert.ok(globalSections.get('ai-waifu:thinking-language'), '全局兜底段落在插件层')

  firstCtx.dispose() // 插件被卸载
  assert.equal(globalSections.get('ai-waifu:thinking-language'), undefined, '插件层段必须被回收')
  assert.ok(agentSections.get('ai-waifu:persona'), 'agent 层段不随插件卸载消失（这正是坑）')

  assert.doesNotThrow(
    () => apply(makeCtx()),
    '重载后不允许因同名段抛错（这条失败说明 SECTION_REGISTRY 没生效）',
  )
  const second = agentSections.get('ai-waifu:persona')
  assert.ok(second, '重载后必须重新注册上人设段')
  assert.notEqual(second, first, '生效的必须是新一代段落对象，不能还是上一版')
  assert.equal(agentSections.size, 2, 'agent 层只该有 1 份人设段 + 1 份思考遮蔽段，不能堆叠')
})

test('挂件面板按钮：装了 dsh-pet 就注册一个「写日记」，没装就什么都不做', () => {
  /* dsh-pet 0.4.11 的官方扩展点 `ctx.pet.registerPanelAction`。
     两条都要守住：①装了挂件 → 注册的参数能被官方校验器接受（id 语法、label ≤24、title ≤80、
     onSelect 是函数）；②没装挂件 → 不注册也不抛错（不然没装挂件的用户启动就报错）。 */
  const registered = []
  const disposed = []
  const pet = {
    registerPanelAction(spec) {
      registered.push(spec)
      return () => disposed.push(spec.id)
    },
  }

  const { ctx } = mountPlugin({ pet })
  apply(ctx)

  assert.equal(registered.length, 1, '应该刚好注册一个按钮')
  const spec = registered[0]
  assert.equal(spec.id, 'cuteness-diary-write')
  assert.match(spec.id, /^[a-z0-9][a-z0-9._-]{0,63}$/, 'id 要过 dsh-pet 的 id 语法')
  assert.equal(spec.label, '写日记')
  assert.ok(spec.label.length <= 24, 'label 上限 24 字')
  assert.ok(typeof spec.title === 'string' && spec.title.length <= 80, 'title 上限 80 字')
  assert.equal(typeof spec.order, 'number')
  assert.equal(typeof spec.onSelect, 'function')

  // 没装挂件：注册面根本不存在，apply 也不能抛错
  const bare = mountPlugin()
  assert.doesNotThrow(() => apply(bare.ctx), '没装挂件时 apply 不能抛错')
  assert.equal(registered.length, 1, '没装挂件时不应该多注册一次')
})

test('挂件面板按钮被点：走真的写日记入口，返回结构化结果而不是抛错', async () => {
  /* 点击是官方 `POST /api/pet/panel-action` 派发过来的，宿主只看 ok/失败，
     所以 onSelect 必须自己把异常收干净——抛出去会让宿主记一条「panel-action-failed」。 */
  const registered = []
  const pet = { registerPanelAction(spec) { registered.push(spec); return () => {} } }

  const { ctx } = mountPlugin({ pet })
  apply(ctx)
  const spec = registered[0]

  const result = await spec.onSelect()
  assert.equal(typeof result, 'object')
  assert.notEqual(result, null)
  assert.equal(result.ok, false, '测试环境没配日记本，应当明确回失败而不是假装成功')
  assert.equal(typeof result.code, 'string')
  assert.ok(result.code.length > 0, '失败要带机器可读的 code')
})
