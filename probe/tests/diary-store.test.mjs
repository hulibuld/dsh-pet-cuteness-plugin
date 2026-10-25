import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_DIARY_CONFIG,
  DIARY_MARKER_FILE,
  backupPathFor,
  commitDiaryWrite,
  diaryPath,
  ensureDiaryMarker,
  firstSentences,
  formatStamp,
  isWithinScanRoot,
  listDiaryFiles,
  listMarkerDirs,
  normalizeDiaryConfig,
  parseDiaryConfig,
  parseDiaryDoc,
  readDiaryMarker,
  recoverDiaryDir,
  resetRecoveryCache,
  serializeDiaryConfig,
  stripFrontmatter,
  validateDiaryPatch,
  writeDiaryFile,
  DIARY_DOC_FILE,
} from '../src/diary-store.mjs'

import { renderDiaryDoc } from '../src/diary-doc.mjs'

const tempRoot = (prefix) => mkdtempSync(join(tmpdir(), prefix))

/* ---------------- 配置归一 ---------------- */

test('normalizeDiaryConfig：出厂默认是关闭 + 21:00 + 无目录', () => {
  const config = normalizeDiaryConfig(undefined)
  assert.equal(config.enabled, false)
  assert.equal(config.dir, '')
  assert.equal(config.time, '21:00')
  assert.equal(config.diarist, '')
  assert.deepEqual(config.writtenDates, {})
  assert.equal(DEFAULT_DIARY_CONFIG.time, '21:00')
})

test('normalizeDiaryConfig：非法时间回落 21:00，别把 25:99 当成配置', () => {
  assert.equal(normalizeDiaryConfig({ time: '25:99' }).time, '21:00')
  assert.equal(normalizeDiaryConfig({ time: '9:05' }).time, '21:00')
  assert.equal(normalizeDiaryConfig({ time: '00:00' }).time, '00:00')
  assert.equal(normalizeDiaryConfig({ time: '23:59' }).time, '23:59')
})

test('normalizeDiaryConfig：writtenDates 只留 true 的合法日期（幂等台账不能被污染）', () => {
  const config = normalizeDiaryConfig({
    writtenDates: { '2026-10-22': true, '2026-10-23': false, bad: true, '2026/10/22': true },
  })
  assert.deepEqual(config.writtenDates, { '2026-10-22': true })
})

test('parseDiaryConfig：坏 JSON 回落默认值并标记 corrupted', () => {
  assert.equal(parseDiaryConfig('{ 坏').corrupted, true)
  assert.equal(parseDiaryConfig('{ 坏').config.enabled, false)
  assert.equal(parseDiaryConfig('').corrupted, false)
  const good = parseDiaryConfig(JSON.stringify({ enabled: true, dir: '/tmp/diary', time: '22:30' }))
  assert.equal(good.corrupted, false)
  assert.equal(good.config.enabled, true)
  assert.equal(good.config.time, '22:30')
})

test('serializeDiaryConfig：写出去能再读回来，字段不丢', () => {
  const original = { enabled: true, dir: '/tmp/d', time: '21:30', diarist: 'raccoon/m', writtenDates: { '2026-10-22': true } }
  const round = parseDiaryConfig(serializeDiaryConfig(original)).config
  assert.deepEqual(round, normalizeDiaryConfig(original))
})

/* ---------------- 变更校验 ---------------- */

test('validateDiaryPatch：只认四个字段，多余字段整单拒绝', () => {
  const result = validateDiaryPatch({ enabled: true, 犯规: 1 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /不认识的字段/)
})

test('validateDiaryPatch：类型不对就拒（enabled 必须布尔、dir 必须字符串）', () => {
  assert.equal(validateDiaryPatch({ enabled: 'yes' }).ok, false)
  assert.equal(validateDiaryPatch({ dir: 42 }).ok, false)
  assert.equal(validateDiaryPatch({ time: '9:5' }).ok, false)
  assert.equal(validateDiaryPatch({ diarist: null }).ok, false)
  assert.equal(validateDiaryPatch(null).ok, false)
})

test('validateDiaryPatch：目录不存在要拒绝，空串表示"清掉目录"', () => {
  const missing = validateDiaryPatch({ dir: '/nope' }, { isDirectory: () => false })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在/)
  const cleared = validateDiaryPatch({ dir: '   ' }, { isDirectory: () => false })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.config.dir, '')
})

test('validateDiaryPatch：合法变更原样回传', () => {
  const result = validateDiaryPatch(
    { enabled: true, dir: '/tmp/diary', time: '22:15', diarist: 'raccoon/sn-deepseek-v4-1-flash-1017' },
    { isDirectory: () => true },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.config, {
    enabled: true,
    dir: '/tmp/diary',
    time: '22:15',
    diarist: 'raccoon/sn-deepseek-v4-1-flash-1017',
  })
})

/* ---------------- 路径 ---------------- */

test('diaryPath：拼成 <目录>/<日期>.md；没目录或日期非法要抛', () => {
  assert.equal(diaryPath('/tmp/diary', '2026-10-22'), '/tmp/diary/2026-10-22.md')
  assert.throws(() => diaryPath('', '2026-10-22'), /日记本目录/)
  assert.throws(() => diaryPath('/tmp/diary', '../x'), /不合法/)
})

test('backupPathFor：备份就是加 .bak', () => {
  assert.equal(backupPathFor('/tmp/diary/2026-10-22.md'), '/tmp/diary/2026-10-22.md.bak')
})

/* ---------------- 写入 ---------------- */

function fakeIo({ exists = false, copyThrows = false, writeThrows = false } = {}) {
  const calls = { mkdir: [], copy: [], write: [] }
  return {
    calls,
    io: {
      exists: () => exists,
      mkdir: (path) => calls.mkdir.push(path),
      copy: (from, to) => {
        if (copyThrows) throw new Error('copy 坏了')
        calls.copy.push([from, to])
      },
      write: (path, content) => {
        if (writeThrows) throw new Error('write 坏了')
        calls.write.push([path, content])
      },
    },
  }
}

test('writeDiaryFile：目录不存在时先建目录，再写文件', () => {
  const { io, calls } = fakeIo({ exists: false })
  const result = writeDiaryFile({ dir: '/tmp/diary', label: '2026-10-22', content: '正文', io })
  assert.equal(result.ok, true)
  assert.equal(result.file, '/tmp/diary/2026-10-22.md')
  assert.equal(result.backup, undefined)
  assert.deepEqual(calls.mkdir, ['/tmp/diary'])
  assert.deepEqual(calls.copy, [])
  assert.equal(calls.write.length, 1)
})

test('writeDiaryFile：同名已存在时先备份再覆盖', () => {
  const { io, calls } = fakeIo({ exists: true })
  const result = writeDiaryFile({ dir: '/tmp/diary', label: '2026-10-22', content: '新正文', io })
  assert.equal(result.ok, true)
  assert.equal(result.backup, '/tmp/diary/2026-10-22.md.bak')
  assert.deepEqual(calls.copy, [['/tmp/diary/2026-10-22.md', '/tmp/diary/2026-10-22.md.bak']])
  assert.deepEqual(calls.write, [['/tmp/diary/2026-10-22.md', '新正文']])
})

test('writeDiaryFile：备份失败就不要写——绝不能用新内容盖掉旧日记', () => {
  const { io, calls } = fakeIo({ exists: true, copyThrows: true })
  const result = writeDiaryFile({ dir: '/tmp/diary', label: '2026-10-22', content: '新', io })
  assert.equal(result.ok, false)
  assert.match(result.reason, /备份失败/)
  assert.equal(calls.write.length, 0)
})

test('writeDiaryFile：写入失败要把原因带出来，不许静默', () => {
  const { io } = fakeIo({ exists: false, writeThrows: true })
  const result = writeDiaryFile({ dir: '/tmp/diary', label: '2026-10-22', content: '新', io })
  assert.equal(result.ok, false)
  assert.match(result.reason, /写不进去/)
})

test('writeDiaryFile：日期非法时直接失败，不建目录不写盘', () => {
  const { io, calls } = fakeIo()
  const result = writeDiaryFile({ dir: '/tmp/diary', label: 'x', content: '新', io })
  assert.equal(result.ok, false)
  assert.match(result.reason, /不合法/)
  assert.equal(calls.mkdir.length, 0)
  assert.equal(calls.write.length, 0)
})

/* ---------------- 列表与摘要 ---------------- */

test('listDiaryFiles：按日期倒序、只认 YYYY-MM-DD.md、跳过 .bak', () => {
  const files = ['2026-10-01.md', '2026-10-22.md', '2026-10-22.md.bak', 'notes.txt', '2026-9-1.md']
  const io = {
    readdir: () => files,
    read: (path) => (path.endsWith('2026-10-22.md') ? '---\ndate: 2026-10-22\n---\n# 2026-10-22\n\n今天装好了台词层。' : '# x\n旧的一天。'),
  }
  const list = listDiaryFiles({ dir: '/tmp/diary', io, limit: 5 })
  assert.deepEqual(list.map((item) => item.label), ['2026-10-22', '2026-10-01'])
  assert.match(list[0].summary, /今天装好了台词层/)
  assert.equal(list[0].file, '/tmp/diary/2026-10-22.md')
})

test('listDiaryFiles：目录读不到时返回空数组，不抛错', () => {
  const io = { readdir: () => { throw new Error('ENOENT') }, read: () => '' }
  assert.deepEqual(listDiaryFiles({ dir: '/nope', io }), [])
  assert.deepEqual(listDiaryFiles({ dir: '', io }), [])
})

test('listDiaryFiles：limit 生效，单篇读失败不影响整张表', () => {
  const io = {
    readdir: () => ['2026-10-20.md', '2026-10-21.md', '2026-10-22.md'],
    read: (path) => {
      if (path.endsWith('2026-10-22.md')) throw new Error('坏文件')
      return '# x\n内容'
    },
  }
  const list = listDiaryFiles({ dir: '/tmp/d', io, limit: 2 })
  assert.equal(list.length, 2)
  assert.equal(list[0].label, '2026-10-22')
  assert.equal(list[0].summary, '')
  assert.equal(list[1].label, '2026-10-21')
})

test('stripFrontmatter / firstSentences：摘要不含 frontmatter，超长加省略号', () => {
  assert.equal(stripFrontmatter('---\ndate: x\n---\n正文'), '正文')
  assert.equal(stripFrontmatter('正文'), '正文')
  assert.equal(firstSentences('# 标题\n\n你好\n世界', 60), '你好 世界')
  assert.equal(firstSentences('字'.repeat(80), 10).endsWith('…'), true)
  assert.equal(firstSentences(null), '')
})

/* ---------------- 身份标记：文件夹改名之后能自己认回来 ---------------- */

test('ensureDiaryMarker：首次打标给全字段（含 plugin），第二次一个字都不写', () => {
  const dir = tempRoot('dsh-waifu-marker-')
  const first = ensureDiaryMarker({ dir, now: Date.parse('2026-10-24T10:00:00+08:00') })
  assert.equal(first.ok, true)
  assert.equal(first.written, 'created')
  const raw = JSON.parse(readFileSync(join(dir, DIARY_MARKER_FILE), 'utf8'))
  assert.equal(raw.plugin, 'dsh-ai-waifu')
  assert.match(raw.purpose, /日记本/)
  assert.equal(raw.createdAt, '2026-10-24')

  // 再确认一次不该改任何东西（改 mtime 会让用户以为文件被动过）
  const mtime = readFileSync(join(dir, DIARY_MARKER_FILE), 'utf8')
  const second = ensureDiaryMarker({ dir, now: Date.parse('2026-10-26T10:00:00+08:00') })
  assert.equal(second.written, 'unchanged')
  assert.equal(readFileSync(join(dir, DIARY_MARKER_FILE), 'utf8'), mtime)
})

test('ensureDiaryMarker：只补缺字段，已有的字段与自定义字段都不许被抹掉', () => {
  const dir = tempRoot('dsh-waifu-marker2-')
  writeFileSync(
    join(dir, DIARY_MARKER_FILE),
    JSON.stringify({ plugin: 'dsh-ai-waifu', note: '我自己写的备注', createdAt: '2026-01-01' }),
  )
  const result = ensureDiaryMarker({ dir, now: Date.parse('2026-10-24T10:00:00+08:00') })
  assert.equal(result.written, 'patched')
  const raw = JSON.parse(readFileSync(join(dir, DIARY_MARKER_FILE), 'utf8'))
  assert.equal(raw.note, '我自己写的备注', '不认识的字段属于用户，必须原样留着')
  assert.equal(raw.createdAt, '2026-01-01', '已有字段不覆盖')
  assert.equal(typeof raw.purpose, 'string')
})

test('readDiaryMarker：坏 JSON、别人的 plugin 一律不算日记本', () => {
  const dir = tempRoot('dsh-waifu-marker3-')
  writeFileSync(join(dir, DIARY_MARKER_FILE), '{ 这不是 json')
  assert.equal(readDiaryMarker(dir), null)

  writeFileSync(join(dir, DIARY_MARKER_FILE), JSON.stringify({ plugin: 'other-plugin' }))
  assert.equal(readDiaryMarker(dir), null)

  writeFileSync(join(dir, DIARY_MARKER_FILE), JSON.stringify({ plugin: ' DSH-AI-WAIFU ' }))
  assert.equal(readDiaryMarker(dir)?.plugin, ' DSH-AI-WAIFU ', '大小写和空格不该让本子认不回来')
})

test('ensureDiaryMarker：写不进去也不抛，只回 ok:false + 原因（不能连累"确认目录"）', () => {
  const result = ensureDiaryMarker({
    dir: '/tmp/whatever',
    io: {
      exists: () => false,
      mkdir: () => {},
      write: () => {
        throw new Error('EACCES: permission denied')
      },
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.written, 'failed')
  assert.match(result.reason, /EACCES/)
})

test('listMarkerDirs：跳过点开头、跳过没有标记、跳过不可写的目录', () => {
  const parent = tempRoot('dsh-waifu-scan-')
  mkdirSync(join(parent, '本子A'))
  ensureDiaryMarker({ dir: join(parent, '本子A') })
  mkdirSync(join(parent, '.隐藏的本子'))
  ensureDiaryMarker({ dir: join(parent, '.隐藏的本子') })
  mkdirSync(join(parent, '没有标记的杂物间'))
  mkdirSync(join(parent, '备份盘上的本子'))
  ensureDiaryMarker({ dir: join(parent, '备份盘上的本子') })

  const io = {
    access: (path) => {
      if (path.endsWith('备份盘上的本子')) throw new Error('EACCES')
    },
  }
  const listing = listMarkerDirs(parent, { io })
  assert.deepEqual(listing.dirs, [join(parent, '本子A')])
  assert.equal(listing.truncated, false)
})

test('isWithinScanRoot：只许扫"具体的三级以上目录"，根与家目录一律不许', () => {
  for (const path of ['/', '/Users', '/Volumes', '/home', '/private', '/tmp', 'relative/x', 'C:\\']) {
    assert.equal(isWithinScanRoot(path), false, `${path} 不该被扫`)
  }
  assert.equal(isWithinScanRoot('/Users/someone'), false, '家目录本身不许扫')
  assert.equal(isWithinScanRoot('/Users/someone/Desktop'), true)
  assert.equal(isWithinScanRoot('/Users/someone/Desktop/'), true)
})

test('recoverDiaryDir：改名之后靠身份标记认回，并把候选人报出来', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-recover-')
  const before = join(root, '小肥鱼的日记本')
  mkdirSync(before, { recursive: true })
  writeFileSync(join(before, '2026-10-20.md'), '# 十月二十\n\n今天也在。\n')
  writeFileSync(join(before, DIARY_DOC_FILE), '# AI娘日记记录\n')
  ensureDiaryMarker({ dir: before })
  const after = join(root, '小肥鱼的日记本（改名了）')
  renameSync(before, after)

  const result = recoverDiaryDir({
    dir: before,
    recent: [{ label: '2026-10-20', file: join(before, '2026-10-20.md') }],
    now: Date.now(),
  })
  assert.equal(result.ok, true)
  assert.equal(result.dir, after)
  assert.equal(result.from, before)
  assert.deepEqual(result.candidates, [after])
})

test('recoverDiaryDir：用户十分钟内手动指定过本子 → 抑制，且一次 readdir 都不发', () => {
  resetRecoveryCache()
  const reads = []
  const io = {
    readdir: () => {
      reads.push(1)
      return []
    },
  }
  const result = recoverDiaryDir({
    dir: '/Users/someone/Desktop/旧本子',
    manualAt: formatStamp(Date.now() - 60_000),
    io,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'suppressed')
  assert.equal(reads.length, 0, '抑制窗内连目录都不许读')
})

test('recoverDiaryDir：120 秒内同一目录不重复扫（设置页轮询不许打爆磁盘）', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-cache-')
  const before = join(root, '旧名')
  const after = join(root, '新名')
  mkdirSync(after, { recursive: true })
  writeFileSync(join(after, DIARY_DOC_FILE), '# AI娘日记记录\n')
  ensureDiaryMarker({ dir: after })

  let reads = 0
  const io = { readdir: (path, options) => {
    reads += 1
    return readdirSync(path, options)
  } }

  const first = recoverDiaryDir({ dir: before, io })
  assert.equal(first.ok, true)
  assert.equal(reads, 1)

  const second = recoverDiaryDir({ dir: before, io })
  assert.equal(second.ok, true)
  assert.equal(second.cached, true)
  assert.equal(reads, 1, '缓存命中时不许再 readdir')

  resetRecoveryCache()
  const third = recoverDiaryDir({ dir: before, io })
  assert.equal(third.ok, true)
  assert.equal(reads, 2, '清了缓存才重扫')
})

test('recoverDiaryDir：只有身份标记、没有日记也没有记录文档的空壳不算候选', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-empty-')
  const shell = join(root, '空壳本子')
  mkdirSync(shell, { recursive: true })
  ensureDiaryMarker({ dir: shell })

  const result = recoverDiaryDir({ dir: join(root, '旧名'), recent: [{ label: '2026-10-20' }] })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-evidence')
})

test('recoverDiaryDir：两个候选都像时取名字最接近旧名字的那个', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-rank-')
  const a = join(root, '日记本 备份')
  const b = join(root, '小肥鱼的日记本')
  for (const dir of [a, b]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, DIARY_DOC_FILE), '# AI娘日记记录\n')
    ensureDiaryMarker({ dir })
  }
  const result = recoverDiaryDir({ dir: join(root, '小肥鱼的日记本x') })
  assert.equal(result.ok, true)
  assert.equal(result.dir, b)
})

test('recoverDiaryDir：说过「不是我那个」的候选不自动认回，只作为建议给出来', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-reject-')
  const other = join(root, '别人的本子')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, DIARY_DOC_FILE), '# AI娘日记记录\n')
  ensureDiaryMarker({ dir: other })

  const result = recoverDiaryDir({
    dir: join(root, '走丢的本子'),
    rejected: [other],
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'rejected')
  assert.deepEqual(result.suggestions.map((item) => item.dir), [other])
})

test('recoverDiaryDir：文档丢了只能重建时，必须候选自己写着旧路径才认（别认成邻居的本子）', () => {
  resetRecoveryCache()
  const root = tempRoot('dsh-waifu-claim-')
  const mine = join(root, '我的本子')
  const other = join(root, '别人的日记')
  for (const dir of [other]) {
    mkdirSync(dir, { recursive: true })
    ensureDiaryMarker({ dir })
    writeFileSync(join(dir, DIARY_DOC_FILE), '# 别人的记录\n')
  }
  // 邻居没有"写着旧路径"的文档 → 只给建议，不认回
  const picky = recoverDiaryDir({ dir: mine, requireClaim: true })
  assert.equal(picky.ok, false)
  assert.equal(picky.reason, 'no-evidence')
  assert.deepEqual(picky.suggestions.map((item) => item.dir), [other])

  // 真被改名的那本：它自己的文档里写的还是旧路径 → 认回
  writeFileSync(join(other, DIARY_DOC_FILE), renderDiaryDoc({
    config: { dir: mine, schema: 2, updatedAt: formatStamp() },
    today: null,
    recent: [],
    failure: null,
    pending: null,
  }))
  resetRecoveryCache()
  const found = recoverDiaryDir({ dir: mine, requireClaim: true })
  assert.equal(found.ok, true)
  assert.equal(found.dir, other)
})

test('recoverDiaryDir：父目录是 /Users 这种"一扫就全机"的根 → 直接拒绝，不扫', () => {
  resetRecoveryCache()
  const reads = []
  const io = {
    readdir: () => {
      reads.push(1)
      return []
    },
  }
  const result = recoverDiaryDir({ dir: '/Users/走丢的本子', io })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'scan-root')
  assert.equal(reads.length, 0)
})

/* ---------------- 写日记的提交顺序：先文档、再实际路径 ---------------- */

const sampleToday = {
  label: '2026-10-24',
  sessions: 3,
  kept: 20,
  outputTokens: 1200,
  diarist: 'deepseek/deepseek-v4',
  topUsage: [{ key: 'deepseek/deepseek-v4', outputTokens: 1200 }],
  written: false,
}

const sampleRow = (dir, label = '2026-10-24') => ({
  label,
  chars: 2,
  diarist: 'deepseek/deepseek-v4',
  summary: '晚安',
  file: join(dir, `${label}.md`),
})

test('commitDiaryWrite：先原子写记录文档（带「待办理」），再落日记文件，最后收尾清标记', () => {
  const dir = tempRoot('dsh-waifu-commit-')
  const docFile = join(dir, DIARY_DOC_FILE)
  const wrote = commitDiaryWrite({
    docFile,
    docText: '',
    dir,
    label: '2026-10-24',
    content: '---\ndate: 2026-10-24\n---\n晚安。',
    today: sampleToday,
    row: sampleRow(dir),
  })
  assert.equal(wrote.ok, true)
  assert.equal(wrote.file, join(dir, '2026-10-24.md'))
  assert.equal(readFileSync(wrote.file, 'utf8').includes('晚安'), true)
  assert.equal(existsSync(`${docFile}.bak`), true, '记录文档改之前要留一份 .bak')

  const doc = parseDiaryDoc(readFileSync(docFile, 'utf8'))
  assert.equal(doc.today.written, true, '「今日：写过」要同步成是')
  assert.equal(doc.today.label, '2026-10-24')
  assert.equal(doc.recent[0].label, '2026-10-24', '「三、最近日记」要加一行')
  assert.equal(doc.pending, null, '「待办理」要清掉——写完了就不该留着')
})

test('commitDiaryWrite：日记文件写不进去时，把原因写进「四」并清「待办理」，不报假成功', () => {
  const root = tempRoot('dsh-waifu-commit-fail-')
  const docFile = join(root, DIARY_DOC_FILE)
  // 把"日记本"做成一个文件：mkdir/writeFile 都会失败，模拟真机上最常见的写不进去
  const notADir = join(root, '本来是文件夹的位置')
  writeFileSync(notADir, 'not a directory')

  const wrote = commitDiaryWrite({
    docFile,
    docText: '',
    dir: notADir,
    label: '2026-10-24',
    content: '---\ndate: 2026-10-24\n---\n晚安。',
    today: sampleToday,
    row: sampleRow(notADir),
    failureHint: '点「现在就写」再试一次',
  })
  assert.equal(wrote.ok, false)
  assert.equal(wrote.code, 'write-failed')
  assert.equal(wrote.stage, 'file')
  assert.equal(wrote.docRolledBack, true, '失败要把文档改回去（或标记失败）')

  const doc = parseDiaryDoc(readFileSync(docFile, 'utf8'))
  assert.equal(doc.failure?.code, 'write-failed', '「最近失败」要留下原因')
  assert.match(doc.failure?.reason ?? '', /E|不是|请求|权限|目录/i)
  assert.equal(doc.pending, null, '失败了也不许留「待办理」——它会让人以为还在写')
  assert.equal(doc.today.written, false)
})
