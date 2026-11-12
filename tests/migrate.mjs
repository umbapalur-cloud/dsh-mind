// dsh-mind 数据迁移：把旧插件的数据搬到 ~/.dsh/mind
//
// 用法:
//   node tests/migrate.mjs --dry-run    只看会做什么，不动任何文件
//   node tests/migrate.mjs              真迁移（先备份，再搬，最后对账）
//
// ⚠️ 三条硬纪律：
//   1. **先备份再动手**，备份路径写进输出，可回滚
//   2. **幂等**：已迁移过就跳过，不重复搬、不覆盖新数据
//   3. **对账**：搬完必须数条数，条数不对就报错并告诉主人怎么回滚
//
// ⚠️ 为什么迁移必须显式跑、不能藏在插件启动里：
//   插件启动时自动搬数据，主人就看不到"到底搬了什么、搬丢没有"。
//   这一步是**一次性的资产搬迁**，必须有一次对账的机会。
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry-run')

const HOME = homedir()
const OLD_STRAND_GLOBAL = join(HOME, '.dsh', 'strand', 'global.json')
const OLD_PSYCHE_SELF = join(HOME, '.dsh', 'psyche', 'self.json')
const NEW_DIR = join(HOME, '.dsh', 'mind')
const NEW_GLOBAL = join(NEW_DIR, 'global.json')
const NEW_STATE = join(NEW_DIR, 'state.json')
const BACKUP_DIR = join(HOME, '.dsh', 'mind-migration-backup', new Date().toISOString().replace(/[:.]/g, '-'))

const log = (s) => console.log(DRY ? `[预览] ${s}` : s)

console.log('══ dsh-mind 数据迁移 ══')
console.log(`模式：${DRY ? '预览（不动任何文件）' : '真迁移'}`)
console.log(`旧数据：${OLD_STRAND_GLOBAL}`)
console.log(`         ${OLD_PSYCHE_SELF}`)
console.log(`新位置：${NEW_DIR}\n`)

// ── 1. 读旧数据 ──
let oldGlobal = null
let oldSelf = null

if (existsSync(OLD_STRAND_GLOBAL)) {
  try {
    oldGlobal = JSON.parse(readFileSync(OLD_STRAND_GLOBAL, 'utf8'))
    console.log(
      `✅ 读到旧 strand/global.json：facts ${oldGlobal.facts?.length ?? 0} 条，` +
        `timeline ${oldGlobal.timeline?.length ?? 0} 条，threads ${oldGlobal.threads?.length ?? 0} 条`,
    )
  } catch (e) {
    console.log(`❌ 旧 global.json 解析失败：${e.message}`)
  }
} else {
  console.log('⚠️  旧 strand/global.json 不存在（可能已经从没跑过 strand）')
}

if (existsSync(OLD_PSYCHE_SELF)) {
  try {
    oldSelf = JSON.parse(readFileSync(OLD_PSYCHE_SELF, 'utf8'))
    console.log(
      `✅ 读到旧 psyche/self.json：identity=${oldSelf.identity?.name ?? '?'}，` +
        `pursuits ${(oldSelf.pursuits ?? []).filter((p) => !p.closedAt).length} 条未结 / ${oldSelf.pursuits?.length ?? 0} 条总`,
    )
  } catch (e) {
    console.log(`❌ 旧 self.json 解析失败：${e.message}`)
  }
} else {
  console.log('⚠️  旧 psyche/self.json 不存在')
}

if (!oldGlobal && !oldSelf) {
  console.log('\n没有可迁移的数据，结束（不需要迁移也能用，插件会从空库开始）')
  process.exit(0)
}

// ── 2. 检查新位置是否已有数据 ──
if (existsSync(NEW_GLOBAL)) {
  const cur = JSON.parse(readFileSync(NEW_GLOBAL, 'utf8'))
  console.log(
    `\n⚠️  新位置已有 global.json：facts ${cur.facts?.length ?? 0} 条，` +
      `timeline ${cur.timeline?.length ?? 0} 条 —— **不会覆盖**（迁移是幂等的）`,
  )
  console.log('   如需重迁：先删掉 ' + NEW_GLOBAL + ' 再跑本脚本')
  process.exit(0)
}

// ── 3. 备份 ──
if (!DRY) {
  mkdirSync(BACKUP_DIR, { recursive: true })
  if (existsSync(OLD_STRAND_GLOBAL)) copyFileSync(OLD_STRAND_GLOBAL, join(BACKUP_DIR, 'strand-global.json'))
  if (existsSync(OLD_PSYCHE_SELF)) copyFileSync(OLD_PSYCHE_SELF, join(BACKUP_DIR, 'psyche-self.json'))
  console.log(`\n✅ 已备份到：${BACKUP_DIR}`)
} else {
  console.log(`\n[预览] 会备份到：${BACKUP_DIR}`)
}

// ── 4. 迁移 global.json ──
if (oldGlobal) {
  const normalized = {
    version: 2,
    updatedAt: new Date().toISOString(),
    facts: Array.isArray(oldGlobal.facts) ? oldGlobal.facts : [],
    timeline: Array.isArray(oldGlobal.timeline) ? oldGlobal.timeline : [],
    threads: Array.isArray(oldGlobal.threads) ? oldGlobal.threads : [],
  }
  if (DRY) {
    console.log(
      `[预览] 会写 ${NEW_GLOBAL}：facts ${normalized.facts.length} / timeline ${normalized.timeline.length} / threads ${normalized.threads.length}`,
    )
  } else {
    mkdirSync(NEW_DIR, { recursive: true })
    writeFileSync(NEW_GLOBAL, JSON.stringify(normalized, null, 2), 'utf8')
    console.log(`✅ 已写 ${NEW_GLOBAL}`)
  }
}

// ── 5. 迁移 self.json（identity + pursuits 进 state.json） ──
if (oldSelf) {
  const state = {
    version: 1,
    savedAt: new Date().toISOString(),
    identity: oldSelf.identity ?? { name: '星', address: '主人', since: new Date().toISOString() },
    pursuits: Array.isArray(oldSelf.pursuits) ? oldSelf.pursuits : [],
    // windows 不迁：旧进程的窗口对新进程无意义（aliveUntil 是谎言）
    windows: {},
  }
  if (DRY) {
    console.log(`[预览] 会写 ${NEW_STATE}：identity=${state.identity?.name}，pursuits ${state.pursuits.length} 条`)
  } else {
    mkdirSync(NEW_DIR, { recursive: true })
    writeFileSync(NEW_STATE, JSON.stringify(state, null, 2), 'utf8')
    console.log(`✅ 已写 ${NEW_STATE}`)
  }
}

// ── 6. 对账 ──
if (!DRY) {
  console.log('\n── 对账 ──')
  let ok = true

  if (oldGlobal) {
    const got = JSON.parse(readFileSync(NEW_GLOBAL, 'utf8'))
    const checks = [
      ['facts', oldGlobal.facts?.length ?? 0, got.facts?.length ?? 0],
      ['timeline', oldGlobal.timeline?.length ?? 0, got.timeline?.length ?? 0],
      ['threads', oldGlobal.threads?.length ?? 0, got.threads?.length ?? 0],
    ]
    for (const [name, want, have] of checks) {
      const match = want === have
      console.log(`  ${match ? '✅' : '❌'} ${name}: ${want} → ${have}`)
      if (!match) ok = false
    }
  }

  if (oldSelf) {
    const got = JSON.parse(readFileSync(NEW_STATE, 'utf8'))
    const wantP = (oldSelf.pursuits ?? []).length
    const haveP = (got.pursuits ?? []).length
    console.log(`  ${wantP === haveP ? '✅' : '❌'} pursuits: ${wantP} → ${haveP}`)
    if (wantP !== haveP) ok = false
    const wantName = oldSelf.identity?.name
    console.log(`  ${got.identity?.name === wantName ? '✅' : '❌'} identity.name: ${wantName} → ${got.identity?.name}`)
    if (got.identity?.name !== wantName) ok = false
  }

  // 经验库不需要搬（路径保持不变），但确认一下它在
  const expDir = join(HOME, '.dsh', 'tacit', 'experiences')
  if (existsSync(expDir)) {
    const n = readdirSync(expDir).filter((f) => f.endsWith('.md')).length
    console.log(`  ✅ 经验库原地未动：${expDir}（${n} 个 .md）`)
  } else {
    console.log(`  ⚠️  经验库目录不存在：${expDir}`)
  }

  console.log('')
  if (ok) {
    console.log('✅ 对账通过 —— 迁移完成')
    console.log(`\n回滚方式：把 ${BACKUP_DIR} 里的两个文件拷回原位置即可`)
  } else {
    console.log('❌ 对账不一致 —— 请先不要启动新插件')
    console.log(`   回滚：把 ${BACKUP_DIR} 里的文件拷回原位置`)
    process.exit(1)
  }
} else {
  console.log('\n[预览] 未做任何改动。确认无误后去掉 --dry-run 再跑一次。')
}
