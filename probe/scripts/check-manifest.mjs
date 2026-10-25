#!/usr/bin/env node
/**
 * 安装契约自检：在「装上之后才发现浏览器半根本没加载」之前把错误拦住。
 *
 * 为什么需要这个脚本（工程评审 D2 的原话）：
 *   缺 `exports["./client"]` 或 `dsh.client` → **浏览器半根本不加载，而且不报错**。
 *   于是 M0 的第 3 项验收（右下角挂件出现）必挂，而人会去查 `shell.overlay`，
 *   查一周也查不出来——因为问题根本不在那儿。
 *
 * 这个脚本检查的是「包能不能被装成双半插件」，不是「代码对不对」。
 * 代码对不对由 tests/ 负责。
 *
 * 用法：
 *   node scripts/check-manifest.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const errors = []
const warnings = []
const ok = []

function check(condition, message, hint) {
  if (condition) ok.push(message)
  else errors.push(hint ? `${message} —— ${hint}` : message)
}

let pkg
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`✖ 读不到 package.json：${error.message}`)
  process.exit(1)
}

// ── 宿主半 ─────────────────────────────────────────────────────────
check(typeof pkg.name === 'string' && pkg.name.length > 0, 'name 存在')
check(pkg.type === 'module', 'type: module')
check(typeof pkg.main === 'string', 'main 指向宿主半入口')
check(existsSync(join(ROOT, pkg.main ?? '')), `main 文件实际存在（${pkg.main}）`)
check(pkg.dsh?.bundle?.patch !== undefined, 'dsh.bundle.patch 存在', '没有它这一行挂不进 profile')

// patch 里声明的行 name 必须等于包名，否则 dump-config 报 `patch: entry not found`
if (pkg.dsh?.bundle?.patch) {
  const patchPath = join(ROOT, pkg.dsh.bundle.patch)
  check(existsSync(patchPath), `patch 文件存在（${pkg.dsh.bundle.patch}）`)
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    check(patch.includes(pkg.name), `patch 里引用了包名 ${pkg.name}`, '行里的 name 必须与 package.json 的 name 一致')
  }
}

// ── 浏览器半（这一组是 D2 的核心） ─────────────────────────────────
check(pkg.exports?.['./client'] !== undefined, 'exports["./client"] 存在', '缺它 → 浏览器半静默不加载')
if (pkg.exports?.['./client']) {
  const clientPath = join(ROOT, pkg.exports['./client'])
  check(existsSync(clientPath), `client 文件实际存在（${pkg.exports['./client']}）`)
  if (existsSync(clientPath)) {
    const client = readFileSync(clientPath, 'utf8')
    check(client.includes('__ModuleLoader__'), 'client.js 用 __ModuleLoader__.load 注册', '浏览器半必须是这个形状')
    // 红线：UI 插件不得 require 任何 Harness Client 包
    const badRequire = /require\(['"]@deepseek-ai\/dsh-client-[^'"]+['"]\)/.exec(client)
    check(badRequire === null, 'client.js 不 require 任何 @deepseek-ai/dsh-client-*', badRequire ? `发现 ${badRequire[0]}` : '')
  }
}
check(pkg.dsh?.client !== undefined, 'dsh.client 存在', '缺它 → 浏览器半静默不加载')
check(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform = web')
check(Array.isArray(pkg.dsh?.client?.inject), 'dsh.client.inject 是静态数组', '它填的是客户端模块 id，不是宿主服务名')

// ── 依赖卫生 ───────────────────────────────────────────────────────
const deps = Object.keys(pkg.dependencies ?? {})
const sharedInDeps = deps.filter((d) => d.startsWith('@deepseek-ai/dsh') || d === '@deepseek-ai/cordis')
check(sharedInDeps.length === 0, '共享 dsh 包不在 dependencies 里', sharedInDeps.length ? `发现 ${sharedInDeps.join(', ')}` : '')

const peers = pkg.peerDependencies ?? {}
check(Object.keys(peers).length > 0, 'peerDependencies 非空')

// ── 展示元数据 ─────────────────────────────────────────────────────
check(pkg.exports?.['./icon'] !== undefined, 'exports["./icon"] 存在', '插件页会没有图标')
const zh = join(ROOT, 'locale', 'zh.json')
const en = join(ROOT, 'locale', 'en.json')
check(existsSync(zh), 'locale/zh.json 存在')
check(existsSync(en), 'locale/en.json 存在')
for (const [label, file] of [['zh', zh], ['en', en]]) {
  if (!existsSync(file)) continue
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    check(typeof doc.meta?.title === 'string', `locale/${label}.json 有 meta.title`)
    check(typeof doc.meta?.description === 'string', `locale/${label}.json 有 meta.description`)
  } catch (error) {
    errors.push(`locale/${label}.json 不是合法 JSON：${error.message}`)
  }
}

// ── 素材 ───────────────────────────────────────────────────────────
check(existsSync(join(ROOT, 'data', 'personas.zh.json')), 'probe/data/personas.zh.json 存在', '装进 profile 后包外的东西不存在')

// ── 输出 ───────────────────────────────────────────────────────────
for (const line of ok) console.log(`  ✔ ${line}`)
for (const line of warnings) console.log(`  ⚠ ${line}`)
if (errors.length > 0) {
  console.error('\n✖ 安装契约自检未通过：')
  for (const line of errors) console.error(`  - ${line}`)
  process.exit(1)
}
console.log('\n✔ 安装契约自检通过（双半都能加载）')
