#!/usr/bin/env node
/**
 * dsh-mind 装前/重启前自检 —— 一次跑完所有"能静态查出来"的坑
 *
 * 用法：node tests/preflight.mjs
 *
 * ⚠️ 为什么需要它（2026-11-03 血教训，见 AGENTS.md「runtime_wiped_rootcause」）：
 *   DSH 升级会清空 resources/runtime，导致必需插件缺文件 → Host 致命崩溃，
 *   而且**每次版本切换必复发**。这类事故的共同点是：
 *   静态就能查出来的东西（文件在不在、能不能 import、依赖能不能解析），
 *   却等到启动失败才发现。
 *   本脚本把能查的全查一遍，重启前 3 秒跑完，别拿重启当探测手段。
 *
 * 输出：每条一行 ✅ / ❌ / ⚠️，末尾给总判定与退出码。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
// ⚠️ 路径从环境推导，**不写死用户名** —— 打包分发时不能带出本机身份。
//   可用 DSH_HOME 覆盖（默认 ~/.dsh）。
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', process.env.DSH_PROFILE || 'desktop')

let bad = 0
let warn = 0
const P = (ok, name, extra = '') => {
  if (ok === true) console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`)
  else if (ok === 'warn') {
    warn++
    console.log(`  ⚠️  ${name}${extra ? '  ' + extra : ''}`)
  } else {
    bad++
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`)
  }
}

console.log('══ dsh-mind 重启前自检 ══\n')

// ── 1. 包结构 ──
console.log('【1】包结构')
// ⚠️ 2026-11-09 校正：lib/global.js 与 lib/segments/strand.js 已随 facts
//   搬到 dsh-strand（2026-11-08 拆分），本包不再包含它们。
//   旧清单没跟着拆，自检必红两条 —— 那不是包坏了，是清单过期。
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/io.js',
  'lib/config.js',
  'lib/state.js',
  'lib/message.js',
  'lib/budget.js',
  'lib/tools.js',
  'lib/cli.mjs',
  'lib/diary.js',
  'lib/compaction.js',
  'lib/peer.js',
  'lib/segments/tacit.js',
  'lib/segments/psyche.js',
]
for (const f of REQUIRED) P(existsSync(join(ROOT, f)), f)

// ── 2. 语法 ──
console.log('\n【2】语法检查（node --check）')
const jsFiles = []
function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (n.endsWith('.js') || n.endsWith('.mjs')) jsFiles.push(p)
  }
}
walk(join(ROOT, 'lib'))
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  P(r.status === 0, f.replace(ROOT + '\\', ''), r.status !== 0 ? (r.stderr ?? '').split('\n').slice(0, 2).join(' ') : '')
}

// ── 3. 能否 import ──
console.log('\n【3】模块能否 import')
const r3 = spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file:///' + join(ROOT, 'lib', 'index.js').replace(/\\/g, '/'))}).then(m=>console.log('OK:'+Object.keys(m).length)).catch(e=>{console.error('FAIL:'+e.message);process.exit(1)})`], { encoding: 'utf8' })
P(r3.status === 0, 'lib/index.js 可 import', (r3.stdout ?? r3.stderr ?? '').trim().slice(0, 80))

// ── 4. package.json 完整性 ──
console.log('\n【4】package.json')
try {
  const raw = readFileSync(join(ROOT, 'package.json'), 'utf8')
  P(raw.charCodeAt(0) !== 0xfeff, '无 BOM')
  const pkg = JSON.parse(raw)
  P(pkg.name === 'dsh-mind', 'name 正确', pkg.name)
  P(pkg.type === 'module', 'type=module')
  P(!!pkg.dsh?.bundle?.patch, 'dsh.bundle.patch 指向存在')
  P(existsSync(join(ROOT, pkg.dsh?.bundle?.patch ?? '')), 'patch 文件真的在')
  P(!!pkg.engines?.dsh, 'engines.dsh 存在（版本声明走 engines，不走 peer 的 "*"）', pkg.engines?.dsh)
  // ⚠️ 2026-11-06 修（这条断言原来是错的，害人事故的间接原因之一）：
  //   原断言写的是「没有 peerDependencies（避免 "*" 陷阱）」—— 把两件不相干的事混成一件：
  //     · 版本约束不该用 "*"（对，应该写 engines）
  //     · 但 peerDependencies 的**键名**是宿主的映射开关（错，必须留）
  //
  //   宿主规则（asar 的 app-boot/lib/worker/profile-resolution-bootstrap.js:468）：
  //     `readPeerNames(插件目录).has(name)` 为真时，才把裸包名
  //     `@deepseek-ai/*` 重定向到安装目录里的宿主副本。
  //   所以链接插件（junction / link:）**必须**把要用的宿主包写进 peerDependencies，
  //   否则 `import '@deepseek-ai/dsh-compaction-basic'` 直接 ERR_MODULE_NOT_FOUND。
  //
  //   血证（2026-11-06 21:00-21:16）：脱敏打包时按旧断言把 peerDependencies 整个删了，
  //   结果 dsh-mind/compaction 解析失败 → preset-cordis 挂载失败 → 新建会话全部不可用，
  //   现场只留下二十来个 163 字节的空壳会话文件。
  //
  //   正确判据：**真实 import 的宿主包必须都声明为 peer**；版本写法不要求 "*"。
  const HOST_PEERS = ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-llm']
  const peerKeys = new Set(Object.keys(pkg.peerDependencies ?? {}))
  for (const h of HOST_PEERS) {
    P(peerKeys.has(h), `${h} 已声明为 peer（否则宿主不映射，import 必失败）`)
  }
} catch (e) {
  P(false, 'package.json 可解析', e.message)
}

// ── 5. profile 接入 ──
console.log('\n【5】profile 接入')
try {
  const pkgRaw = readFileSync(join(PROFILE, 'package.json'), 'utf8')
  P(pkgRaw.charCodeAt(0) !== 0xfeff, 'profile package.json 无 BOM')
  const pkg = JSON.parse(pkgRaw)
  const bundles = pkg.dsh?.profile?.bundles ?? []
  P(bundles.includes('dsh-mind'), 'bundles 含 dsh-mind')
  P(!bundles.includes('dsh-memory-hub'), 'bundles 不含 dsh-memory-hub')
  P(!bundles.includes('dsh-psyche'), 'bundles 不含 dsh-psyche')
  P('dsh-mind' in (pkg.dependencies ?? {}), 'dependencies 含 dsh-mind', pkg.dependencies?.['dsh-mind'])

  const jn = join(PROFILE, 'node_modules', 'dsh-mind')
  P(existsSync(jn), 'node_modules/dsh-mind 存在')
  P(existsSync(join(jn, 'package.json')), 'junction 能读到 package.json')

  // 不能有残留的旧 junction
  // ⚠️ 2026-11-09 校正：dsh-strand 是现役插件（拆分后的新家），
  //   它的 junction 是**合法接入**，不是残留。从残留名单里移除。
  for (const old of ['dsh-tacit', 'dsh-psyche', 'dsh-memory-hub']) {
    P(!existsSync(join(PROFILE, 'node_modules', old)), `node_modules 无残留 ${old}`)
  }
} catch (e) {
  P(false, 'profile 检查', e.message)
}

// ── 6. 数据文件 ──
console.log('\n【6】数据')
const MIND = process.env.MIND_DIR || join(DSH_HOME, 'mind')
// ⚠️ 2026-11-09 校正：global.json（facts/timeline/threads）已搬到
//   ~/.dsh/strand/global.json，由 dsh-strand 写。本插件只读不写（peer.js），
//   所以这里查的是**对端**的文件；对端没装/没跑过时给提醒而不是失败。
const STRAND_GLOBAL = join(DSH_HOME, 'strand', 'global.json')
try {
  const g = JSON.parse(readFileSync(STRAND_GLOBAL, 'utf8'))
  P(Array.isArray(g.facts), 'strand global.json facts 是数组（对端）', `${g.facts.length} 条`)
  P(Array.isArray(g.timeline), 'strand global.json timeline 是数组（对端）', `${g.timeline.length} 条`)
  P(Array.isArray(g.threads), 'strand global.json threads 是数组（对端）', `${g.threads.length} 条`)
} catch (e) {
  P('warn', 'strand global.json 不可读（dsh-strand 未运行？日记会少两节）', e.message)
}
try {
  const s = JSON.parse(readFileSync(join(MIND, 'state.json'), 'utf8'))
  P(!!s.identity?.name, 'state.json identity 完整', s.identity?.name)
  // ⚠️ aliveUntil 绝不能落盘（旧进程的"活着"对新进程是谎言）
  const hasAlive = JSON.stringify(s.windows ?? {}).includes('aliveUntil')
  P(!hasAlive, 'state.json 不含 aliveUntil')
} catch (e) {
  P('warn', 'state.json 还不可读（首次启动会自己建）', e.message)
}

// 经验库
const EXP = process.env.MIND_EXPERIENCE_DIR || join(DSH_HOME, 'tacit', 'experiences')
if (existsSync(EXP)) {
  const n = readdirSync(EXP).filter((f) => f.endsWith('.md')).length
  P(true, '经验库可读', `${n} 个 .md`)
} else {
  P('warn', '经验库目录不存在', EXP)
}

// ── 7. 旧目录已退役 ──
console.log('\n【7】旧目录退役')
// ⚠️ 从包所在目录推导，不写死本机绝对路径（打包分发不能带出本机布局）。
//   可以用 MIND_SIBLING_DIR 指定这三个旧插件的兄弟目录。
// ⚠️ 2026-11-09 校正：dsh-strand **不再是退役对象** —— 2026-11-08 拆分后
//   它是现役插件（facts/timeline/threads 的新家），这里改为检查它**存在**。
//   旧清单把它列进退役名单，自检必红一条 —— 那是清单过期，不是环境坏了。
const SIBLING_DIR = process.env.MIND_SIBLING_DIR || join(ROOT, '..')
P(existsSync(join(SIBLING_DIR, 'dsh-strand', 'lib', 'global.js')), 'dsh-strand 现役（facts 的新家）')
for (const d of ['dsh-tacit', 'dsh-psyche', 'dsh-memory-hub']) {
  const alive = existsSync(join(SIBLING_DIR, d))
  const retired = existsSync(join(SIBLING_DIR, `${d}.retired`))
  P(!alive && retired, `${d} 已退役`, alive ? '原名还在' : retired ? '.retired 存在' : '两个都没有')
}

// ── 8. 配置自洽 ──
console.log('\n【8】配置自洽')
try {
  // ⚠️ 2026-11-09 校正：budget.strand 已随段搬走（undefined），旧算式
  //   undefined+1200+1200=NaN → 必红。现在的三段是 psyche/diary/tacit。
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file:///' + join(ROOT, 'lib', 'config.js').replace(/\\/g, '/'))}).then(m=>{const c=m.DEFAULT_CONFIG;const sum=c.budget.psyche+c.budget.diary+c.budget.tacit;console.log(JSON.stringify({t:c.budget.total,s:sum,ok:c.budget.total>=sum}))})`], { encoding: 'utf8' })
  const o = JSON.parse(r.stdout)
  P(o.ok, `总预算 ${o.t} ≥ 三段之和 ${o.s}（psyche+diary+tacit）`)
} catch (e) {
  P(false, '配置检查', e.message)
}

// ── 汇总 ──
console.log('\n' + '='.repeat(50))
if (bad === 0) {
  console.log(`✅ 自检通过（${warn} 个提醒）—— 可以重启`)
  console.log('='.repeat(50))
  process.exit(0)
} else {
  console.log(`❌ 有 ${bad} 项失败、${warn} 项提醒 —— **先别重启**，修完再跑一次`)
  console.log('='.repeat(50))
  process.exit(1)
}
