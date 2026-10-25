#!/usr/bin/env node
/**
 * 把上游真源的素材同步进 `probe/data/`（探针是安装根，素材必须随包走）。
 *
 * 为什么需要这一步：`probe/` 是 bundle 的安装目录，装进 profile 之后
 * `../data/` 根本不存在。所以探针包内必须有自己的副本。
 * 但**真源只有一个**（`../data/personas/personas.zh.json`，由 tools/merge.py 生成），
 * 这个脚本负责把后者复制到前者，并在内容不一致时打印摘要。
 *
 * 用法：
 *   node scripts/sync-data.mjs           # 同步
 *   node scripts/sync-data.mjs --check   # 只校验是否同步（CI 用）
 */

import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, '..', 'data', 'personas', 'personas.zh.json')
const DST = join(ROOT, 'data', 'personas.zh.json')

const checkOnly = process.argv.includes('--check')

let srcText
try {
  srcText = readFileSync(SRC, 'utf8')
} catch (error) {
  console.error(`读不到上游真源 ${SRC}\n${error.message}`)
  process.exit(1)
}

if (checkOnly) {
  let dstText = ''
  try {
    dstText = readFileSync(DST, 'utf8')
  } catch {
    console.error('probe/data/personas.zh.json 不存在；请先跑 node scripts/sync-data.mjs')
    process.exit(1)
  }
  if (dstText !== srcText) {
    console.error('probe/data 与上游真源不同步，请跑 node scripts/sync-data.mjs 后重新构建')
    process.exit(1)
  }
  console.log('probe/data 与上游真源同步 ✔')
} else {
  copyFileSync(SRC, DST)
  const doc = JSON.parse(srcText)
  const total = (doc.personas ?? []).reduce(
    (n, c) => n + Object.values(c.lines ?? {}).reduce((m, v) => m + v.length, 0),
    0,
  )
  console.log(`已同步：${doc.personas?.length ?? 0} 张卡 / ${total} 句 → probe/data/personas.zh.json`)
}
