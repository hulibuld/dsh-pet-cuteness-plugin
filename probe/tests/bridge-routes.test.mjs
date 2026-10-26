import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 桥的 HTTP 路由守门。
   为什么必须单独测这一层：`/debug`、`/lines`、`/diary` 这些端点是"开关点了没反应"
   时唯一的可判定信号，而它们此前**一条测试都没有**（code-auditor E1）。
   两个真踩过的坑也在这一层：
     ① `webServer.register` 对同一个 (kind, path) 重复注册会抛错——写两条同 path 的
        entry 会把整个桥打断，而且是从第一个之后的全部 route 都注册不上；
     ② 请求体里出现不认识的字段必须**整单拒绝**，静默忽略等于让 UI 假装成功。 */

const DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-waifu-bridge-'))
mkdirSync(join(DSH_HOME, 'plugin-data'), { recursive: true })
process.env.DSH_HOME = DSH_HOME

const { apply, BRIDGE_PREFIX, BRIDGE_PREFIX_LEGACY, BRIDGE_PREFIXES, diaryRuntime, resetDiaryRuntime } = await import(
  '../index.js'
)
const { resetRecoveryCache, ensureDiaryMarker, DIARY_DOC_FILE } = await import('../src/diary-store.mjs')
const { appendRecentRow, formatStamp, patchTodaySection } = await import('../src/diary-doc.mjs')

/** 造一个带 webServer 的宿主：把注册到的路由收起来，重复 (kind,path) 就抛错（和真宿主一致）。 */
function mountWithWebServer(options = {}) {
  const routes = new Map()
  const webServer = {
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route: ${key}`)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    getOrigin() {
      return 'http://127.0.0.1:1'
    },
  }

  const sections = new Map()
  const prompt = {
    section(spec) {
      if (sections.has(spec.name)) throw new Error('duplicate section: ' + spec.name)
      sections.set(spec.name, spec)
      return () => sections.delete(spec.name)
    },
    getSectionOrder(name) {
      if (name === 'DEPLOYMENT_PERSONA_PREFIX') return 10
      return sections.get(name)?.order
    },
  }
  const projections = { snapshot: () => ({ modelSelection: { provider: 'deepseek', model: 'deepseek-v4' } }) }

  const agentCtx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    get(name) {
      if (name === 'systemPrompt') return prompt
      if (name === 'sessionProjections') return projections
      return false
    },
    on: () => () => {},
  }
  const agent = {
    id: 's1',
    session: { id: 's1', header: {} },
    options: { provider: 'deepseek', model: 'deepseek-v4' },
    get ctx() {
      return agentCtx
    },
  }

  // 宿主的 timer：`interval(cb, delay)` 返回取消函数。日记定时器靠它每分钟看一眼。
  const intervals = []
  const timer = {
    interval(callback, delay) {
      intervals.push({ callback, delay })
      return () => {}
    },
  }

  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    get(name) {
      if (name === 'systemPrompt') return prompt
      if (name === 'sessionProjections') return projections
      if (name === 'agents') return { list: () => [agent] }
      if (name === 'webServer') return webServer
      if (name === 'timer') return timer
      // 挂件服务与插件管理器是可选的：默认没有（`installed:false` → 路由回 no-pet），
      // 传进来就能测「真有条目时的读写」，不用去碰用户真实的 ~/.dsh。
      if (name === 'pet' && options.pet) return options.pet
      if (name === 'loader' && options.loader) return options.loader
      if (name === 'pluginManager' && options.pluginManager) return options.pluginManager
      return false
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : undefined
    },
    on: () => () => {},
    inject(_names, run) {
      run(ctx)
    },
  }

  apply(ctx)
  return { routes, ctx, intervals }
}

/** 假 req：`readJsonBody` 要监听 data/end，所以用 microtask 按挂载顺序补发事件。 */
function makeReq({ method = 'GET', url = '/', body, host = '127.0.0.1:55813' } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host },
    on(event, callback) {
      listeners.set(event, callback)
      if (event === 'data' && body !== undefined) {
        queueMicrotask(() => callback(Buffer.from(JSON.stringify(body), 'utf8')))
      }
      if (event === 'end') {
        queueMicrotask(() => callback())
      }
      return req
    },
  }
  return req
}

/** 假 res：收状态码与 body。 */
function makeRes() {
  const res = {
    status: 0,
    payload: undefined,
    writeHead(status) {
      res.status = status
      return res
    },
    end(text) {
      res.payload = text ? JSON.parse(text) : undefined
    },
  }
  return res
}

const call = (route, options) => {
  const res = makeRes()
  return Promise.resolve(route.handler(makeReq(options), res)).then(() => res)
}

/* ---------------- 路由表本身 ---------------- */

test('所有路由的 (kind,path) 唯一，且该有的都在（新前缀 + 旧别名各一套）', () => {
  const { routes } = mountWithWebServer()
  const paths = [...routes.keys()].map((key) => key.split(' ')[1]).sort()
  const suffixes = [
    '/debug',
    '/defaults',
    '/diary',
    '/diary/pick-dir',
    '/diary/reject-dir',
    '/diary/reload',
    '/diary/today',
    '/diary/write',
    '/lines',
    '/pet',
    // 亲密度（2026-10-24 加）：读写共用一条路由，按 req.method 分派——
    // 同 path 注册两条会被 webServer 判重复（见下一条测试）。
    '/pet/affinity',
    '/pet/enable',
    // 小鱼干（2026-10-24 用户新需求「可以刷小鱼干，最多 999 个」）：同样是一条路由分 GET/POST。
    '/pet/treats',
    '/session',
    '/state',
  ]
  // 2026-10-24 改名：同一批 handler 挂在新前缀和旧前缀两个前缀下，所以是两套。
  const expected = BRIDGE_PREFIXES.flatMap((prefix) => suffixes.map((suffix) => prefix + suffix)).sort()
  assert.deepEqual(paths, expected)
  assert.equal(paths.length, suffixes.length * BRIDGE_PREFIXES.length)
})

test('日记的读和写共用一条路由（同 path 注册两条会抛 duplicate）', () => {
  const { routes } = mountWithWebServer()
  const keys = [...routes.keys()].filter((key) => key.endsWith('/diary'))
  // 每个前缀只能有一条 /diary（读 + 写按 method 分派）。
  assert.equal(keys.length, BRIDGE_PREFIXES.length)
})

test('兼容别名：旧前缀 /api/dsh-ai-waifu/* 仍然可用（缓存着旧 bundle 的页面不至于点了没反应）', async () => {
  const { routes } = mountWithWebServer()
  // 「在注册表里」还不够，得真调一次旧前缀的 handler：旧页面打的就是这条 URL，
  // handler 内部若按前缀做判断，这里会露出来。
  const legacyState = routes.get(`exact ${BRIDGE_PREFIX_LEGACY}/state`)
  assert.ok(legacyState, '旧前缀 /state 必须还注册着')
  const legacy = await call(legacyState, { url: `${BRIDGE_PREFIX_LEGACY}/state` })
  assert.equal(legacy.status, 200, '旧前缀要能正常回 200')
  assert.equal(legacy.payload.ok, true)

  // 新旧前缀是同一批 handler（不是两份实现），返回体必须一样。
  const fresh = await call(routes.get(`exact ${BRIDGE_PREFIX}/state`), { url: `${BRIDGE_PREFIX}/state` })
  assert.deepEqual(legacy.payload.value, fresh.payload.value, '新旧前缀必须给出同一份状态')

  // 写通道也一样：旧前缀的 POST /session 要能落到同一个 handler 上。
  const legacySession = routes.get(`exact ${BRIDGE_PREFIX_LEGACY}/session`)
  assert.equal(typeof legacySession?.handler, 'function', '旧前缀 /session 必须还注册着')
})

/* ---------------- 同源校验 ---------------- */

test('旧页面把 widget 一起提交时：吞掉它、照写其余键（否则"点了没反应"）', async () => {
  /* 真实故障复盘：用户页面还跑着旧构建，提交会话开关时把 widget 一起带上。
     原来「见到已删除的键就整单拒绝」，于是同一单里本来该生效的 persona 也一起没了，
     用户看到的就是「语气和中文思考都失效了」。现在必须：widget 丢掉、其余照写、
     并在响应里如实回 ignored。 */
  const { routes } = mountWithWebServer()
  const route = [...routes.values()].find((r) => r.path === `${BRIDGE_PREFIX}/session`)
  const res = await call(route, {
    method: 'POST',
    url: `${BRIDGE_PREFIX}/session`,
    body: { sessionId: 's1', flags: { persona: true, thinking: true, widget: false } },
  })
  assert.equal(res.status, 200, '带 widget 不该整单失败')
  assert.deepEqual(res.payload.value.effective.persona, true, 'persona 必须真的写进去')
  assert.deepEqual(res.payload.value.effective.thinking, true)
  assert.deepEqual(res.payload.value.ignored, ['widget'], '丢掉了什么要让页面看得见')
})

test('POST /defaults：旧页面带的 widget 也一样吞掉，不拖累 persona', async () => {
  const { routes } = mountWithWebServer()
  const route = [...routes.values()].find((r) => r.path === `${BRIDGE_PREFIX}/defaults`)
  const res = await call(route, {
    method: 'POST',
    url: `${BRIDGE_PREFIX}/defaults`,
    body: { widget: true, persona: true },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.value.ignored, ['widget'])
})

test('非回环来源且 Origin 与 Host 不一致：一律 403', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { url: BRIDGE_PREFIX + '/diary', host: '10.0.0.5:80' })
  assert.equal(res.status, 403)
})

test('回环来源放行（局域网部署才需要看 Origin）', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { url: BRIDGE_PREFIX + '/diary?today=0', host: '127.0.0.1:55813' })
  assert.equal(res.status, 200)
})

/* ---------------- 日记 ---------------- */

test('GET /diary：只读一次记录文档，默认不扫会话日志（?today=1 才扫）', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  resetDiaryRuntime()
  const res = await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.value.config.time, '21:00')
  // 契约（t4/F5）：today 永不为 null。没算过就是一个 stale 占位——**但依然一次统计都没算**
  assert.equal(res.payload.value.today.state, 'unknown', '默认路径不算今日统计，回 unknown 占位')
  assert.equal(res.payload.value.today.stale, true)
  assert.equal(res.payload.value.today.scannedAt, null)
  assert.equal(res.payload.value.today.sessions, 0)
  assert.deepEqual(res.payload.value.recent, [], '最近日记来自记录文档，不再 readdir 日记本')
  assert.equal(res.payload.value.doc.path.endsWith('AI娘日记记录.md'), true)
  assert.equal(diaryRuntime.docReads, 1, '一条 GET 只许读一次记录文档')
  assert.equal(diaryRuntime.todayScans, 0, '默认 GET 一次 collectDay 都不许调')
  assert.equal(diaryRuntime.dirScans, 0, '默认 GET 不许 readdir 日记本')
})

test('POST /diary：不认识的字段整单拒绝（不静默忽略）', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, 乱写: 1 } })
  assert.equal(res.status, 400)
  assert.match(res.payload.reason, /不认识/)
})

test('POST /diary：目录不存在就拒（打错一个字母不能变成"设置成功"）', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { dir: '/nope/not-here' } })
  assert.equal(res.status, 400)
  assert.match(res.payload.reason, /不存在/)
})

test('POST /diary：autoCreate:true 真的把目录建出来（用户"重新建一个"的主出路）', async () => {
  /* 实测故障（T16-F1）：被确认的日记本被改名/删掉后，设置页给出「重新建一个」，
     客户端发的正是 {dir: 旧路径, autoCreate: true}。宿主在 validate 阶段就把不存在的目录拒了，
     所以那条出路永远 400——用户点了没反应，但这次错码从 bad-dir 变成了 bad-flags。 */
  const parent = mkdtempSync(join(tmpdir(), 'dsh-waifu-mk-'))
  const target = join(parent, '新建的本子')
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)

  const res = await call(route, {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary',
    body: { dir: target, autoCreate: true },
  })
  assert.equal(res.status, 200, `autoCreate 建目录必须成功，实际 ${res.status} ${res.payload?.reason ?? ''}`)
  assert.equal(existsSync(target), true, '磁盘上必须真的有这个目录')
  assert.equal(res.payload.value.config.dir, target)
  assert.equal(existsSync(join(target, 'AI娘日记记录.md')), true)
  assert.equal(existsSync(join(target, '.dsh-ai-waifu-diary-root.json')), true, '新建的本子当场打身份标记')
})

test('POST /diary：autoCreate:true 但父目录不存在 → bad-dir，且绝不凭空建目录', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-waifu-mk-'))
  const target = join(parent, 'no-such-parent', '本子')
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary',
    body: { dir: target, autoCreate: true },
  })
  assert.equal(res.status, 400)
  assert.equal(res.payload.code, 'bad-dir', '建不出来必须回 bad-dir（不是 bad-flags）')
  assert.equal(existsSync(join(parent, 'no-such-parent')), false, '打错一个字母不许在磁盘上长目录')
})

test('POST /diary：autoCreate:false 与缺省都不建目录（默认是保守的一方）', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'dsh-waifu-mk-'))
  const target = join(parent, '不该被建出来')
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)

  const off = await call(route, {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary',
    body: { dir: target, autoCreate: false },
  })
  assert.equal(off.status, 400)
  assert.equal(existsSync(target), false)

  const absent = await call(route, {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary',
    body: { dir: target },
  })
  assert.equal(absent.status, 400)
  assert.equal(existsSync(target), false, '没勾「自动新建」就一个目录都不许长')
})

test('POST /diary：合法设置写盘，GET 能读回来（两个请求之间不靠内存）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-waifu-diary-'))
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)

  const wrote = await call(route, {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary',
    body: { enabled: true, dir, time: '22:30' },
  })
  assert.equal(wrote.status, 200)
  assert.equal(wrote.payload.value.config.enabled, true)
  assert.equal(wrote.payload.value.config.dir, dir)
  assert.equal(wrote.payload.value.config.time, '22:30')

  // 磁盘上现在只有一份「指针」，配置本体在记录文档里（人可读、可手改）
  const configFile = join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu-diary.json')
  assert.equal(existsSync(configFile), true, '指针必须真的落到 plugin-data')
  const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
  assert.equal(onDisk.schema, 2)
  assert.equal(onDisk.docPath, join(dir, 'AI娘日记记录.md'))
  const docText = readFileSync(onDisk.docPath, 'utf8')
  assert.match(docText, /一、设置/)
  assert.match(docText, /打开日记：是/)
  assert.equal(docText.includes('日记本文件夹：' + dir), true, '记录文档里要写清用户选的路径')
  assert.equal(wrote.payload.value.dirMarker, 'present', '确认目录当场就打身份标记')
  const meta = (await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })).payload.value.doc
  assert.deepEqual(meta.sections, ['config', 'today', 'recent', 'failure', 'pending'], '四段 + 待办理都要在')

  const read = await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })
  assert.equal(read.payload.value.config.dir, dir)
  assert.equal(read.payload.value.config.time, '22:30')
  assert.equal(read.payload.value.corrupted, false)
})

test('POST /diary：时间格式不对就拒', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { time: '9:5' } })
  assert.equal(res.status, 400)
})

test('GET /diary：别的 method 一律 405', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const res = await call(route, { method: 'DELETE', url: BRIDGE_PREFIX + '/diary' })
  assert.equal(res.status, 405)
})

/* ---------------- 记录文档：改名认回 / 去慢路径 ---------------- */

/** 把「本子最后手动指定」改成很久以前：模拟"用户十几分钟前选的，然后去 Finder 里改了名"。 */
function ageManualPick(docPath, stamp = '2026-10-20 09:00:00') {
  const text = readFileSync(docPath, 'utf8')
  const next = text.replace(/(本子最后手动指定：).*/g, `$1${stamp}`)
  assert.notEqual(next, text, '记录文档里应该有「本子最后手动指定」这一行')
  writeFileSync(docPath, next)
}

test('文件夹改名之后能自己认回来：身份标记 + 文档留一行「已自动认回」+ 指针跟过去', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-rename-'))
  const before = join(root, '小肥鱼的日记本')
  mkdirSync(before, { recursive: true })
  writeFileSync(join(before, '2026-10-20.md'), '---\ndate: 2026-10-20\n---\n今天也在。\n')

  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  const wrote = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir: before } })
  assert.equal(wrote.status, 200, JSON.stringify(wrote.payload))

  // 确认过的日记本要打上身份标记（用户原话：「连改文件夹名字都不行吗？」）
  const marker = join(before, '.dsh-ai-waifu-diary-root.json')
  assert.equal(existsSync(marker), true, '确认目录后必须打身份标记')
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).plugin, 'dsh-ai-waifu')

  // 「三、最近的日记」里先有一行（模拟以前写过），改名后这一行也得跟着改前缀
  const docPath = join(before, 'AI娘日记记录.md')
  writeFileSync(docPath, appendRecentRow(readFileSync(docPath, 'utf8'), {
    label: '2026-10-20',
    title: '今天也在',
    chars: 5,
    diarist: '自动',
    file: join(before, '2026-10-20.md'),
  }))
  ageManualPick(docPath)

  // 用户在 Finder 里把文件夹改了名
  const after = join(root, '小肥鱼的日记本 2')
  renameSync(before, after)
  resetRecoveryCache()

  const read = await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })
  assert.equal(read.payload.value.config.dir, after, '路径要自动修正到新名字')
  assert.equal(read.payload.value.config.dirState, 'ok')
  assert.equal(read.payload.value.dirRecovered.to, after)
  assert.equal(read.payload.value.warnings.some((line) => line.includes('认回')), true)

  const docText = readFileSync(join(after, 'AI娘日记记录.md'), 'utf8')
  assert.equal(docText.includes('已自动认回：' + after), true, '记录文档里要留一行「已自动认回：<新路径>」')
  assert.equal(read.payload.value.recent[0].file, join(after, '2026-10-20.md'), '最近日记的路径要跟着换前缀')
  assert.equal(existsSync(join(after, '.dsh-ai-waifu-diary-root.json')), true, '标记文件跟着文件夹一起搬')

  const pointer = JSON.parse(readFileSync(join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu-diary.json'), 'utf8'))
  assert.equal(pointer.docPath, join(after, 'AI娘日记记录.md'), '指针也要跟着改，否则下次又从旧路径找')
})

test('刚手动选完十分钟内改名：不自动认回（只报找不到，让用户自己处理）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-recent-'))
  const dir = join(root, '本子')
  mkdirSync(dir, { recursive: true })

  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir } })

  // 刚选完就改名：这是最容易"选错本子"的时机，不能自作聪明
  renameSync(dir, join(root, '本子2'))
  resetRecoveryCache()

  const read = await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })
  assert.equal(read.payload.value.config.dir, dir, '十分钟内不改配置')
  assert.equal(read.payload.value.config.dirState, 'missing')
  assert.equal(read.payload.value.dirRecovered, null)
  assert.deepEqual(read.payload.value.dirSuggestions, [])
})

test('POST /diary/reject-dir：说过「不是我那个」的候选只当建议，不自动认回', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-reject-'))
  const mine = join(root, '我的本子')
  const other = join(root, '别人的日记')
  mkdirSync(mine, { recursive: true })
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, '2026-10-21.md'), '---\ndate: 2026-10-21\n---\n不是她要的。\n')
  // 别人那个本子也是"被确认过的日记本"：有身份标记、有自己的记录文档
  ensureDiaryMarker({ dir: other })
  writeFileSync(join(other, DIARY_DOC_FILE), '# 别人的日记本记录\n')

  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir: mine } })

  // 把另一个带标记的日记本记成「不是我那个」
  const removed = await call(routes.get(`exact ${BRIDGE_PREFIX}/diary/reject-dir`), {
    method: 'POST',
    url: BRIDGE_PREFIX + '/diary/reject-dir',
    body: { to: other },
  })
  assert.equal(removed.status, 200, JSON.stringify(removed.payload))
  const docText = readFileSync(join(mine, 'AI娘日记记录.md'), 'utf8')
  assert.equal(docText.includes('不自动认回：' + other), true)

  ageManualPick(join(mine, 'AI娘日记记录.md'))
  // 自己的本子被搬到别处（不在原父目录里了），原父目录只剩「不是我那个」
  renameSync(mine, join(mkdtempSync(join(tmpdir(), 'dsh-waifu-elsewhere-')), '我的本子'))
  resetRecoveryCache()

  const read = await call(route, { url: `${BRIDGE_PREFIX}/diary?today=0` })
  assert.equal(read.payload.value.config.dir, mine, '被拒绝过的候选不许自动认回')
  assert.equal(read.payload.value.dirRecovered, null)
  assert.equal(read.payload.value.dirSuggestions[0]?.dir, other, '但可以作为建议给出来，让用户点「用它」')
})

test('GET /diary/today：今日统计单独一条，返回 label/sessions（首屏不再等它）', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary/today`)
  const res = await call(route, { url: `${BRIDGE_PREFIX}/diary/today` })
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, true)
  assert.equal(typeof res.payload.value.label, 'string')
  assert.equal('sessions' in res.payload.value, true)
})

test('POST /diary/write：拒绝时也带 elapsedMs（宿主不设短超时，浏览器半不必猜）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-write-'))
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir: root } })
  const write = routes.get(`exact ${BRIDGE_PREFIX}/diary/write`)
  const res = await call(write, { method: 'POST', url: BRIDGE_PREFIX + '/diary/write', body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.payload.ok, false)
  assert.equal(typeof res.payload.code, 'string')
  assert.equal(typeof res.payload.elapsedMs, 'number', '耗时必须回传，页面才敢等 90 秒')
})

test('换本子成功：记录文档的 .bak 跟着走，旧目录连身份标记都不留（不留空壳自称日记本）', async () => {
  /* T16-F3 实测：搬完旧目录还剩 AI娘日记记录.md.bak 与 .dsh-ai-waifu-diary-root.json。
     前者是"搬本子只搬一半"，后者更糟——一个被搬空的目录还自称是这本日记，
     下次认回扫描会把它当候选（这次靠证据闸门才没认错）。 */
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-move-'))
  const before = join(root, '旧本子')
  const after = join(root, '新本子')
  mkdirSync(before, { recursive: true })
  mkdirSync(after, { recursive: true })
  writeFileSync(join(before, '2026-10-20.md'), '---\ndate: 2026-10-20\n---\n今天也在。\n')

  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  assert.equal((await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir: before } })).status, 200)
  // 再改一次设置：第二次原子写才会留下 .bak（第一份没有旧文本可备份）
  assert.equal((await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { time: '22:30' } })).status, 200)
  assert.equal(existsSync(join(before, 'AI娘日记记录.md.bak')), true, '前置：旧目录里应该有一份 .bak')

  const moved = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { dir: after } })
  assert.equal(moved.status, 200, JSON.stringify(moved.payload))
  assert.equal(moved.payload.value.applied.dirMoved.moved, 1, '日记正文应该搬过去')
  assert.equal(moved.payload.value.applied.dirMoved.backupMoved, true, '记录文档的 .bak 也要搬')

  assert.equal(existsSync(join(after, 'AI娘日记记录.md')), true)
  assert.equal(existsSync(join(after, 'AI娘日记记录.md.bak')), true, '新目录要有 .bak')
  assert.equal(existsSync(join(after, '2026-10-20.md')), true)
  assert.equal(existsSync(join(after, '.dsh-ai-waifu-diary-root.json')), true, '新本子当场打标记')

  assert.equal(existsSync(join(before, 'AI娘日记记录.md')), false, '旧目录不许留记录文档')
  assert.equal(existsSync(join(before, 'AI娘日记记录.md.bak')), false, '旧目录不许留 .bak')
  assert.equal(existsSync(join(before, '.dsh-ai-waifu-diary-root.json')), false, '旧目录不许再自称是这本日记')
})

test('换本子失败：新目录里不许留一份没人引用的记录文档（第二个真源）', async (t) => {
  /* T16-F4 实测：dir-move-failed 只把指针写回旧文档，没删刚写到目标目录的那份。
     结果目标目录多一份孤儿文档，下次再选中它就会被当成"既有文档"，§三 还可能被 rebase 进去。
     这里制造一次"只有 rename 失败"的真实搬失败：把旧日记文件设成不可变（macOS chflags uchg），
     目录仍可写，所以配置文档照常写、失败只发生在搬运那一步。 */
  if (process.platform !== 'darwin') return t.skip('chflags 只有 macOS 有')
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-movefail-'))
  const before = join(root, '旧本子')
  const after = join(root, '新本子')
  mkdirSync(before, { recursive: true })
  mkdirSync(after, { recursive: true })
  const diaryFile = join(before, '2026-10-20.md')
  writeFileSync(diaryFile, '---\ndate: 2026-10-20\n---\n今天也在。\n')

  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/diary`)
  assert.equal((await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { enabled: true, dir: before } })).status, 200)

  execFileSync('chflags', ['uchg', diaryFile])
  let failed
  try {
    failed = await call(route, { method: 'POST', url: BRIDGE_PREFIX + '/diary', body: { dir: after } })
  } finally {
    try {
      execFileSync('chflags', ['nouchg', diaryFile])
    } catch {
      /* 已经搬走/删掉就算了 */
    }
  }
  // 契约：只有 bad-dir 用 400，其余失败走 200 + ok:false（浏览器半只看 ok）
  assert.equal(failed.status, 200, JSON.stringify(failed.payload))
  assert.equal(failed.payload.ok, false)
  assert.equal(failed.payload.code, 'dir-move-failed', JSON.stringify(failed.payload))
  assert.equal(existsSync(join(after, 'AI娘日记记录.md')), false, '失败后目标目录不许留孤儿文档')
  const pointer = JSON.parse(readFileSync(join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu-diary.json'), 'utf8'))
  assert.equal(pointer.docPath, join(before, 'AI娘日记记录.md'), '指针必须回到旧文档')
})

test('迁移：老的 dsh-ai-waifu-diary.json 字段搬进记录文档，旧文件逐字留一份备份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-waifu-legacy-'))
  writeFileSync(join(dir, '2026-10-22.md'), '---\ndate: 2026-10-22\n---\n旧日记。\n')
  const configFile = join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu-diary.json')
  const legacy = {
    enabled: true,
    dir,
    time: '21:30',
    diarist: 'deepseek/deepseek-v4',
    writtenDates: { '2026-10-22': true, '2026-10-23': true },
  }
  const legacyRaw = JSON.stringify(legacy, null, 2)
  writeFileSync(configFile, legacyRaw)

  const { routes } = mountWithWebServer()
  const res = await call(routes.get(`exact ${BRIDGE_PREFIX}/diary`), { url: `${BRIDGE_PREFIX}/diary?today=0` })
  const value = res.payload.value
  assert.equal(value.config.enabled, true, '老配置的开关要迁过来')
  assert.equal(value.config.time, '21:30')
  assert.equal(value.config.diarist, 'deepseek/deepseek-v4')
  assert.equal(value.config.dir, dir)
  assert.equal(value.migrated.writtenDates, 2)
  assert.equal(value.migrated.from, 'v1-json', '契约：migrated 要说明"从哪来的"')
  assert.equal(value.corrupted, false)

  const docText = readFileSync(join(dir, 'AI娘日记记录.md'), 'utf8')
  assert.equal(docText.includes('每天几点写：21:30'), true)
  assert.equal(docText.includes('谁来写：deepseek/deepseek-v4'), true)
  // 2026-10-23 的文件已经不在：不往「三、最近的日记」里写（点开是空的，比少一行难解释）
  assert.deepEqual(value.recent.map((row) => row.label), ['2026-10-22'])

  const pointer = JSON.parse(readFileSync(configFile, 'utf8'))
  assert.equal(pointer.schema, 2)
  assert.equal(pointer.docPath, join(dir, 'AI娘日记记录.md'))
  const backup = join(DSH_HOME, 'plugin-data', 'dsh-ai-waifu-diary.v1.json.bak')
  assert.equal(readFileSync(backup, 'utf8'), legacyRaw, '旧文件要逐字留一份，迁移出问题能自己捡回来')
})

test('写日记这条路不许设短超时（20-90 秒是正常的，4 秒只是浏览器半的首屏）', async () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(source.includes('const DIARY_WRITE_TIMEOUT_MS = 120000'), true, '等执笔的上限得是两分钟级')
  const writeBlock = source.slice(source.indexOf('path: `${BRIDGE_PREFIX}/diary/write`'), source.indexOf('path: `${BRIDGE_PREFIX}/lines`'))
  assert.equal(writeBlock.includes('Promise.race'), false, '路由本身不许再套一层竞速超时')
  assert.equal(/setTimeout\([^)]*reject/.test(writeBlock), false)
})

/* ---------------- 台词 ---------------- */

test('GET /lines：缺 sessionId 400；开关关着时立刻回空并标记 enabled:false', async () => {
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/lines`)
  const missing = await call(route, { url: `${BRIDGE_PREFIX}/lines` })
  assert.equal(missing.status, 400)

  // 出厂 lines 默认是开的；这里显式关掉再问，确认不会让浏览器白等 15 秒
  const patch = await call(routes.get(`exact ${BRIDGE_PREFIX}/session`), {
    method: 'POST',
    url: BRIDGE_PREFIX + '/session',
    body: { sessionId: 's-off', flags: { lines: false } },
  })
  assert.equal(patch.status, 200)

  const res = await call(route, { url: `${BRIDGE_PREFIX}/lines?sessionId=s-off&wait=15000` })
  assert.equal(res.status, 200)
  assert.equal(res.payload.value.enabled, false)
  assert.deepEqual(res.payload.value.lines, [])
})

test('GET /lines：开着的形状被钉死（enabled:true / lines 数组 / cursor 数字 / 键集合）', async () => {
  /* 客户端 400ms 快问节奏完全依赖 enabled === true 与 cursor 是数字。
     名字一改，浏览器半就静默退化成 5000ms 兜底——本轮"台词冒出来慢"就是这么来的。 */
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/lines`)
  await call(routes.get(`exact ${BRIDGE_PREFIX}/session`), {
    method: 'POST',
    url: BRIDGE_PREFIX + '/session',
    body: { sessionId: 's-on', flags: { lines: true } },
  })
  const res = await call(route, { url: `${BRIDGE_PREFIX}/lines?sessionId=s-on&cursor=0` })
  assert.equal(res.status, 200)
  assert.equal(res.payload.value.enabled, true)
  assert.ok(Array.isArray(res.payload.value.lines), 'lines 必须是数组')
  assert.equal(typeof res.payload.value.cursor, 'number', 'cursor 必须是数字')
  const keys = Object.keys(res.payload.value)
  for (const key of keys) {
    assert.ok(['cursor', 'lines', 'enabled', 'unavailable'].includes(key), `冒出来的新键：${key}`)
  }
})

/* ---------------- 会话目录扫描 ---------------- */

test('会话目录是两层的（<workspace>/session-<id>），只扫一层会静默拿到 0 条', async () => {
  const { listAllSessionDirs } = await import('../index.js')
  const root = mkdtempSync(join(tmpdir(), 'dsh-waifu-sessions-'))
  mkdirSync(join(root, '--ws-a--', 'session-abc'), { recursive: true })
  mkdirSync(join(root, '--ws-a--', 'session-def'), { recursive: true })
  mkdirSync(join(root, '--ws-b--', 'session-ghi'), { recursive: true })
  mkdirSync(join(root, '--ws-b--', 'not-a-session'), { recursive: true })
  writeFileSync(join(root, '--ws-a--', 'session-abc', 'session.v4.jsonl.zstd'), '')

  const dirs = listAllSessionDirs(root).sort()
  assert.deepEqual(dirs, ['--ws-a--/session-abc', '--ws-a--/session-def', '--ws-b--/not-a-session', '--ws-b--/session-ghi'])
})

test('会话目录不存在时返回空数组，不抛错', async () => {
  const { listAllSessionDirs } = await import('../index.js')
  assert.deepEqual(listAllSessionDirs('/definitely/not/here'), [])
})

/* ---------------- 日记定时 ---------------- */

test('日记定时器挂上了，且每分钟只做一次「到点了吗」的判断', () => {
  const { intervals } = mountWithWebServer()
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].delay, 60000)
})

test('定时回调在日记关着的时候什么都不做（不乱起子代理）', () => {
  const { intervals } = mountWithWebServer()
  // 出厂默认 enabled:false，回调跑一次不应抛错
  assert.doesNotThrow(() => intervals[0].callback())
})

test('GET /debug：lines 段必须带"拒绝原因账本"和卡片比例（否则台词不冒只能靠猜）', async () => {
  /* 2026-10-24 用户报「气泡全是台词库」。当时 /debug 只有一个 pushed 总数，
     谁也说不清几千个推理帧死在哪一档；也没有任何字段能看出卡片有没有被压住。
     这条断言守的是"下一次再出同样的 bug，一眼就能归因"。 */
  const { routes } = mountWithWebServer()
  const route = routes.get(`exact ${BRIDGE_PREFIX}/debug`)
  const res = await call(route, { url: `${BRIDGE_PREFIX}/debug` })
  assert.equal(res.status, 200)
  const lines = res.payload.value.lines
  for (const key of ['tooShort', 'tooLong', 'technical', 'dup', 'perStep', 'noBoundary', 'gap', 'other']) {
    assert.equal(typeof lines.rejected[key], 'number', `缺拒绝原因：${key}`)
  }
  assert.equal(typeof lines.cardCapped, 'number', '卡片被闸门挡了几次必须可见')
  assert.equal(typeof lines.cardRatio, 'number', '卡片/思考比例必须可见')
  assert.equal(typeof lines.pushed, 'number')
  assert.equal(typeof lines.card, 'number')
})

/* ---------------- 小鱼干（/pet/treats） ---------------- */

// pet.json 在 DSH_HOME 根上（挂件自己的状态文件），不是 plugin-data 里。
const PET_FILE = join(DSH_HOME, 'pet.json')
const petText = (treats = 1) =>
  JSON.stringify(
    {
      petId: 'whale-girl',
      names: ['小肥鱼'],
      affinity: { points: 304, pets: 25 },
      treats: { treats, lastTreatGrantAt: 1792819102112, turnsAtLastTreatGrant: 204 },
      display: { visible: true, size: 160 },
    },
    null,
    2,
  ) + '\n'
const hasPet = { isEnabled: () => true }

test.after(() => {
  try {
    unlinkSync(PET_FILE)
  } catch {
    /* 本来就没建 */
  }
})

test('/pet/treats：新旧两个前缀各注册一条，GET/POST 都接，别的方方法 405', async () => {
  const { routes } = mountWithWebServer()
  for (const prefix of BRIDGE_PREFIXES) {
    const route = routes.get(`exact ${prefix}/pet/treats`)
    assert.ok(route, `${prefix}/pet/treats 没注册：界面点了会 404`)
    // 注册成 POST 专用就接不到 GET；这里两种方法都必须被「认领」（不该 405）。
    for (const method of ['GET', 'POST']) {
      const res = await call(route, { method, url: `${prefix}/pet/treats`, body: method === 'POST' ? { treats: 1 } : undefined })
      assert.notEqual(res.status, 405, `${method} ${prefix}/pet/treats 认领不了 ${method}`)
    }
    const put = await call(route, { method: 'PUT', url: `${prefix}/pet/treats` })
    assert.equal(put.status, 405)
    assert.equal(put.payload.code, 'method')
  }
})

test('/pet/treats：没装挂件（或没有 pet.json）时两条方法都回 no-pet，不崩', async () => {
  try {
    unlinkSync(PET_FILE)
  } catch {
    /* 没文件才是这里要的状态 */
  }
  const noPet = mountWithWebServer()
  for (const prefix of BRIDGE_PREFIXES) {
    const route = noPet.routes.get(`exact ${prefix}/pet/treats`)
    const get = await call(route, { method: 'GET', url: `${prefix}/pet/treats` })
    assert.equal(get.payload.ok, false)
    assert.equal(get.payload.code, 'no-pet')
    const post = await call(route, { method: 'POST', url: `${prefix}/pet/treats`, body: { treats: 5 } })
    assert.equal(post.payload.ok, false)
    assert.equal(post.payload.code, 'no-pet')
  }
})

test('GET /pet/treats：读出现有数量，并带上限 999', async () => {
  writeFileSync(PET_FILE, petText(7), 'utf8')
  const { routes } = mountWithWebServer({ pet: hasPet })
  for (const prefix of BRIDGE_PREFIXES) {
    const route = routes.get(`exact ${prefix}/pet/treats`)
    const res = await call(route, { method: 'GET', url: `${prefix}/pet/treats` })
    assert.equal(res.status, 200)
    assert.deepEqual(res.payload, { ok: true, value: { treats: 7, max: 999 } })
  }
})

test('POST /pet/treats：夹到上限、只改那一个数字、其余字段原样', async () => {
  const before = petText(1)
  writeFileSync(PET_FILE, before, 'utf8')
  const { routes } = mountWithWebServer({ pet: hasPet, pluginManager: { reload: async () => ['pet'] } })
  const route = routes.get(`exact ${BRIDGE_PREFIX}/pet/treats`)

  const over = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: 1000 } })
  assert.equal(over.payload.ok, true)
  assert.equal(over.payload.value.treats, 999, '超过 999 一律夹到 999')
  // 这个用例没有挂件服务、读不到内存：文件写成了，但只能老实说「重启后生效」，
  // 不许假装已经热生效（2026-10-26 真事故就是"报成功、其实没生效"）。
  assert.equal(over.payload.value.applied, 'pending-restart')

  const after = JSON.parse(readFileSync(PET_FILE, 'utf8'))
  assert.equal(after.treats.treats, 999)
  assert.equal(after.treats.lastTreatGrantAt, 1792819102112, '投喂时间戳不许被我们改掉')
  assert.equal(after.treats.turnsAtLastTreatGrant, 204)
  assert.deepEqual(after.names, ['小肥鱼'])

  const negative = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: -5 } })
  assert.equal(negative.payload.value.treats, 0)
  const decimal = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: 3.6 } })
  assert.equal(decimal.payload.value.treats, 4, '非整数按 Math.round')
})

test('POST /pet/treats：上限跟挂件走（它只许 20 个就按 20 夹），并让它重载后验到生效', async () => {
  writeFileSync(PET_FILE, petText(3), 'utf8')
  // 模拟真挂件：内存里只允许囤 20 个；restart 之后从文件重新读，内存值就变成新的那一个。
  let live = { stocked: 3, max: 20 }
  let restarted = 0
  const pet = {
    isEnabled: () => true,
    state: () => ({ treats: { stocked: live.stocked, max: live.max }, affinity: { points: 415 } }),
  }
  const loader = {
    entries: () => [
      {
        options: { id: 'pet' },
        fiber: {
          restart: async () => {
            restarted += 1
            const text = JSON.parse(readFileSync(PET_FILE, 'utf8'))
            live = { stocked: text.treats.treats, max: 20 }
          },
        },
      },
    ],
  }
  const { routes } = mountWithWebServer({ pet, loader })
  const route = routes.get(`exact ${BRIDGE_PREFIX}/pet/treats`)

  const res = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: 999 } })
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.value.treats, 20, '999 要夹到挂件自己的上限 20')
  assert.equal(res.payload.value.applied, 'reloaded', '内存没接住时要重载挂件再验')
  assert.equal(restarted >= 1, true, '必须真的调过 fiber.restart')
})

test('POST /pet/affinity：直接改挂件内存并让它存盘（不用重载、不闪）', async () => {
  writeFileSync(PET_FILE, petText(1), 'utf8')
  // 假挂件：ledger.snapshot 就是它的内存真相，flush() 会把快照写回 pet.json。
  const snapshot = { affinity: { points: 415 }, treats: { treats: 1, lastTreatGrantAt: 1, turnsAtLastTreatGrant: 2 } }
  let flushes = 0
  const pet = {
    isEnabled: () => true,
    ledger: { snapshot },
    state: () => ({ affinity: { points: snapshot.affinity.points }, treats: { stocked: snapshot.treats.treats, max: 20 } }),
    flush: () => {
      flushes += 1
      writeFileSync(PET_FILE, JSON.stringify({ affinity: snapshot.affinity, treats: snapshot.treats }), 'utf8')
    },
  }
  const { routes } = mountWithWebServer({ pet })
  const route = routes.get(`exact ${BRIDGE_PREFIX}/pet/affinity`)
  const res = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/affinity`, body: { points: 5000 } })
  assert.equal(res.payload.ok, true)
  assert.equal(res.payload.value.points, 5000)
  assert.equal(res.payload.value.applied, 'live', '内存改成功就不用重载挂件')
  assert.equal(snapshot.affinity.points, 5000, '挂件内存必须真的变成新值')
  assert.equal(flushes >= 1, true, '改完要让它自己存一次盘，否则下次 flush 会盖回去')
})

test('POST /pet/treats：body 不合法一律整单拒绝（bad-body / bad-treats）', async () => {
  writeFileSync(PET_FILE, petText(2), 'utf8')
  const { routes } = mountWithWebServer({ pet: hasPet, pluginManager: { reload: async () => ['pet'] } })
  const route = routes.get(`exact ${BRIDGE_PREFIX}/pet/treats`)

  const extra = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: 3, points: 1 } })
  assert.equal(extra.payload.code, 'bad-body', '夹带别的字段要整单拒绝')
  const empty = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: {} })
  assert.equal(empty.payload.code, 'bad-body')

  for (const bad of ['abc', true, null]) {
    const res = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: bad } })
    assert.equal(res.payload.ok, false)
    assert.equal(res.payload.code, 'bad-treats', `${String(bad)} 应该被拒`)
  }
  // 被拒之后文件不许被动过
  assert.equal(JSON.parse(readFileSync(PET_FILE, 'utf8')).treats.treats, 2)
})

test('POST /pet/treats：回读对不上就回滚并回 verify-failed（失败信封和 /pet/affinity 同构）', async () => {
  const original = petText(1)
  writeFileSync(PET_FILE, original, 'utf8')
  // 模拟「重载了但挂件没接住」：内存始终是旧值 → 必须回滚文件并报 verify-failed。
  // 这条是 2026-10-26 那次事故的回归测试：以前只比文件，会出现"报成功、其实没生效"。
  const stubborn = {
    isEnabled: () => true,
    state: () => ({ treats: { stocked: 1, max: 20 } }),
  }
  const { routes } = mountWithWebServer({
    pet: stubborn,
    loader: { entries: () => [{ options: { id: 'pet' }, fiber: { restart: async () => {} } }] },
  })
  const route = routes.get(`exact ${BRIDGE_PREFIX}/pet/treats`)
  const res = await call(route, { method: 'POST', url: `${BRIDGE_PREFIX}/pet/treats`, body: { treats: 20 } })
  assert.equal(res.payload.ok, false)
  assert.equal(res.payload.code, 'verify-failed')
  assert.equal(typeof res.payload.message, 'string')
  assert.equal(readFileSync(PET_FILE, 'utf8'), original, '失败后必须还原成原文')
})

test('GET /pet：装上挂件时顺带给 affinity 与 treats（一次读盘），读不到就是 null', async () => {
  writeFileSync(PET_FILE, petText(5), 'utf8')
  const installed = mountWithWebServer({ pet: hasPet })
  const route = installed.routes.get(`exact ${BRIDGE_PREFIX}/pet`)
  const res = await call(route, { method: 'GET', url: `${BRIDGE_PREFIX}/pet` })
  assert.equal(res.payload.value.affinity.points, 304)
  assert.equal(res.payload.value.affinity.max, 999999999)
  assert.deepEqual(res.payload.value.treats, { treats: 5, max: 999 })

  unlinkSync(PET_FILE)
  const res2 = await call(route, { method: 'GET', url: `${BRIDGE_PREFIX}/pet` })
  assert.equal(res2.payload.ok, true, '没有 pet.json 也不许报错：这是 2 秒一次的兜底轮询')
  assert.equal(res2.payload.value.affinity, null)
  assert.equal(res2.payload.value.treats, null)
})
