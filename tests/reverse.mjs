// dsh-mind 反向验证：逐个故意破坏关键机制，确认测试会红。
//
// ⚠️ 为什么必须有这个脚本（strand 与 psyche 都留了这条）：
//   **全绿不等于判据有效。** strand 曾经两次假绿：
//     一次是测试自己往 messages 里塞 assistant 消息（测的是假设，不是真实行为）；
//     一次是破坏 shrunk 判据后测试仍然全绿（死分支从来没跑过）。
//   psyche 的 README 也写着同一句：「全绿不等于判据有效」。
//
// 做法：把 lib/ 复制到临时目录，对副本做**定点破坏**，跑测试，期望它变红。
//      副本坏了不影响真源码（每次都从源码重新复制）。
//
// ⚠️ 2026-11-09 重建（旧版 30 个破坏点抓到 14、漏 16）：
//   旧清单的 11 个破坏点指向 lib/global.js / lib/segments/strand.js ——
//   那两个文件 2026-11-08 已整体搬到 dsh-strand，本包里不存在。
//   它们的判据归属也搬走了，**在这里测不到是正常的**，不算漏。
//   搬走的清单（到 dsh-strand 的反向验证里找）：
//     factsSig 值哈希 / trimTimeline 削超长 / 同 turn 只留一条 /
//     supersedes 标 stale / 指纹含 stale / 失效事实降级渲染 /
//     fact·timeline·thread 压一行 / 隔离防线（MIND_DIR）/ 推送水印
//   本版只保留**本包现存文件**上的破坏点，并补上 2026-11-09 新增机制的：
//     inbox 机器闸门 / fullEvery 语义 / 日记 pursuits 段 / 估算口径标注
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 每个破坏点：
 *   file   要改的文件（相对包根）
 *   find   要找的原文（必须**恰好命中一次**，否则说明源码变了，破坏点失效）
 *   repl   替换成什么
 *   why    这个破坏对应哪条判据
 */
const BREAKS = [
  {
    name: '去掉「自身注入不采集」闸门',
    file: 'lib/message.js',
    find: `export function isSelfMessage(message) {`,
    repl: `export function isSelfMessage(message) {\n  if (message) return false // BROKEN`,
    why: '第72组「kind 闸门/水印闸门」必须红 —— 否则投递会被记成主人的话，自我放大',
  },
  {
    name: '机器播报过滤失效（goal_round 会进状态层）',
    file: 'lib/message.js',
    find: `export function looksMachine(t) {`,
    repl: `export function looksMachine(t) {\n  if (t) return false // BROKEN`,
    why: '第72组「机器闸门」必须红 —— 2026-11-03 共享层污染的同源入口',
  },
  {
    name: 'inbox 采集不挂机器闸门（只挡 isSelfMessage）',
    file: 'lib/index.js',
    find: `      if (looksMachine(textOf(message))) return`,
    repl: `      // BROKEN: 不挡机器播报`,
    why: '第72组「机器闸门」必须红 —— 函数活着但没接上，等于没有',
  },
  {
    name: '去掉经验的条件求值（一律 true）',
    file: 'lib/segments/tacit.js',
    find: `  return false\n}\n\n/** 命中质量`,
    repl: `  return true // BROKEN\n}\n\n/** 命中质量`,
    why: '第22组「不认识的写法 → false」必须红 —— 否则会照猜动手',
  },
  {
    name: '增量渲染不报别处的用户发言',
    file: 'lib/segments/psyche.js',
    find: `    if (curUserAt > (prev.lastUserAt ?? 0) && w.lastUserText) {`,
    repl: `    if (false && curUserAt > (prev.lastUserAt ?? 0) && w.lastUserText) { // BROKEN`,
    why: '第34组「增量表达了别处的用户发言」必须红 —— 这是「切窗口后看不到别处说话」的真因',
  },
  {
    name: '快照把自己也收进去',
    file: 'lib/segments/psyche.js',
    find: `    if (w.id === selfId) continue`,
    repl: `    // BROKEN: 不再跳过自己`,
    why: '第34组「快照不含自己」必须红 —— 否则每步报一次自己的死讯',
  },
  {
    name: '活动 seq 改成用时间戳（同毫秒会撞）',
    file: 'lib/state.js',
    find: `    this._actSeq += 1`,
    repl: `    this._actSeq = now // BROKEN: 用时间戳当 seq`,
    why: '第31组「同毫秒两次动作 seq 不同」必须红 —— 用 at 判增量会永久漏报第二条',
  },
  {
    name: 'aliveUntil 落盘（旧进程的活着对新进程是谎言）',
    file: 'lib/state.js',
    find: `          turns: w.turns ?? 0,`,
    repl: `          turns: w.turns ?? 0, aliveUntil: w.aliveUntil, // BROKEN`,
    why: '第19组「落盘不含 aliveUntil」必须红',
  },
  {
    name: '预算总上限失效',
    file: 'lib/budget.js',
    find: `  if (typeof cap === 'number' && cap > 0 && total > cap) {`,
    repl: `  if (false) { // BROKEN`,
    why: '第35组「总上限生效」必须红',
  },
  {
    name: '插入位置按引用比对（退化到末尾）',
    file: 'lib/message.js',
    find: `  const claimedIds = new Set((claimedMessages ?? []).map((m) => m?.id).filter(Boolean))`,
    repl: `  const claimedIds = new Set() // BROKEN: 永不命中，插到末尾`,
    why: '第9组「注入在用户消息之后」必须红',
  },
  {
    name: '空串不再挡住「关闭追求」',
    file: 'lib/state.js',
    find: `    if (!key) return null`,
    repl: `    // BROKEN: 不挡空串`,
    why: '第31组「空串不能关」必须红 —— p.text.includes(\'\') 恒为 true 会误关第一条',
  },
  {
    name: '三段分别注入（回到整合前的形态）',
    file: 'lib/index.js',
    find: `      const text = [segments.psyche, segments.diary, segments.tacit].filter(Boolean).join('\\n\\n')`,
    repl: `      const text = segments.tacit // BROKEN: 丢掉另外两段`,
    why: '第39/40组「两段水印都在同一条消息里」必须红',
  },
  {
    name: '删掉「大输出纪律」的信号（回到 47% 经验永不自启）',
    file: 'lib/segments/tacit.js',
    find: `    path: 'task.large-output',`,
    repl: `    path: 'task.never-used-large-output', // BROKEN`,
    why: '第43组「★ 没有永不自启的经验」必须红 —— 这是第二阶段的核心修复',
  },
  {
    name: '多信号退化成单信号（并集丢失）',
    file: 'lib/segments/tacit.js',
    find: `      if (ctx !== undefined) out.push({ path: rule.path, context: ctx })`,
    repl: `      if (ctx !== undefined) { out.push({ path: rule.path, context: ctx }); break } // BROKEN: 单信号`,
    why: '第43组「★ 一句话能推出多条信号」必须红',
  },
  {
    name: '节流退回渲染之后（每步白渲染）',
    file: 'lib/index.js',
    find: `      const estimatedGap = gapFor(lastChars || 2000, gapEnvOverride())\n      if (!isFirst && !compacted && now - last < estimatedGap) return decision`,
    repl: `      const estimatedGap = 0 // BROKEN: 不在渲染前节流\n      if (false) return decision`,
    why: '第46组「★ 源码里第一道节流在渲染之前」必须红 —— 真机实测白干 53 遍',
  },
  {
    name: '追求条目不做主题去重（回到"一件事显示成四件"）',
    file: 'lib/state.js',
    find: `    const same = this.pursuits.find((p) => !p.closedAt && sameTheme(p.text, t))`,
    repl: `    const same = undefined // BROKEN: 不做主题去重`,
    why: '第47组「★ 同一主题的不同进展不新增条目」必须红 —— 真机实测 4 条其实是 2 件事',
  },
  {
    name: '主题比较忽略"短的是长的前缀"这条',
    file: 'lib/state.js',
    find: `  return longer.startsWith(shorter)`,
    repl: `  return longer === shorter // BROKEN: 只比完全相等`,
    why: '第47组「★ 短句是长句前缀 → 同一件事」必须红',
  },
  {
    name: '超短句也参与合并（把一切并成一条）',
    file: 'lib/state.js',
    find: `  if (shorter.length < THEME_MIN) return false`,
    repl: `  // BROKEN: 不设最短限制`,
    why: '第47组「★ 超短句（<8字符）不参与合并」必须红',
  },
  {
    // ⚠️ 这个破坏点对应 2026-11-03 女仆自己造成的一次**真实数据事故**：
    //   写调试脚本时忘了设 MIND_DIR，`new Store()` + `addPursuit()` 就把
    //   主人 4 条追求写成了 1 条，靠备份才救回来。
    //   修法是 snapshot() 默认不写盘，必须显式 allowPersist。
    name: 'snapshot 默认就写盘（调试脚本会写坏真实数据）',
    file: 'lib/state.js',
    find: `    if (this.allowPersist !== true) return false`,
    repl: `    // BROKEN: 默认允许写盘`,
    why: '第19组「★ 未打开 allowPersist 时不写盘」必须红',
  },
  // ── 2026-11-09 新增机制的破坏点 ──
  {
    name: 'fullEvery 语义回退（=1 时第二步仍走增量）',
    file: 'lib/index.js',
    find: `      const dueFull = !ds || ds.fullCount >= Math.max(0, config.inject.fullEvery - 1) || compacted`,
    repl: `      const dueFull = !ds || ds.fullCount >= config.inject.fullEvery || compacted // BROKEN`,
    why: '第72组必须红 —— fullEvery=1 却不每步全量，本窗口 lastUserText 观测不到',
  },
  {
    name: '日记丢掉 pursuits 段（压缩后不知道在追什么）',
    file: 'lib/diary.js',
    find: `  const openPursuits = (Array.isArray(pursuits) ? pursuits : []).filter((p) => p && !p.closedAt)`,
    repl: `  const openPursuits = [] // BROKEN: 永远没有追求段`,
    why: '第73组「日记含我在追什么」必须红',
  },
  {
    name: '日记把已关闭的追求也写进去',
    file: 'lib/diary.js',
    find: `  const openPursuits = (Array.isArray(pursuits) ? pursuits : []).filter((p) => p && !p.closedAt)`,
    repl: `  const openPursuits = (Array.isArray(pursuits) ? pursuits : []) // BROKEN: 不过滤 closedAt`,
    why: '第73组「已关闭的追求不出现」必须红',
  },
  {
    name: '估算口径不标注（把估算伪装成实测）',
    file: 'lib/diary.js',
    find: `  const srcNote = source === 'estimate' ? '，字符估算，非精确值' : source === 'projection' ? '，投影值' : ''`,
    repl: `  const srcNote = '' // BROKEN: 不标口径`,
    why: '第73组「估算来源标注非精确值」必须红',
  },
  {
    name: 'pre-step 不把 pursuits 传给日记',
    file: 'lib/index.js',
    find: `            pursuits: store.openPursuits(),`,
    repl: `            // BROKEN: 不传 pursuits`,
    why: '源码级判据必须红 —— 传参断了，函数再对也写不出追求段',
  },
  {
    name: 'BOM 不剥（Windows 写的配置静默回退默认全开）',
    file: 'lib/config.js',
    find: `      const raw = readFileSync(CONFIG_PATH(), 'utf8').replace(/^﻿/, '')`,
    repl: `      const raw = readFileSync(CONFIG_PATH(), 'utf8') // BROKEN: 不剥 BOM`,
    why: '第48组「带 BOM 的配置仍能读到值」必须红 —— 真机 07:49:50 主人的全关配置被静默打开',
  },
  {
    name: '热加载日志访问已拆走的 strand 段（抛 TypeError 谎称用旧配置）',
    file: 'lib/index.js',
    find: "          `tacit=${next.tacit.enabled}/${next.tacit.inject} ` +",
    repl: "          `strand=${next.strand.enabled}/${next.strand.inject} tacit=${next.tacit.enabled}/${next.tacit.inject} ` + // BROKEN",
    why: '第48组「热加载日志行不再访问 next.strand」必须红',
  },
  // ── 2026-11-12 新增：B 档（第一人称摘要）与死开关修复的破坏点 ──
  {
    name: '去掉「全篇第一人称」硬规则',
    file: 'lib/compaction.js',
    find: `- **全篇第一人称**。任何一处写成「助手/该模型/它」都算违规，必须改成「我」或「女仆」。`,
    repl: `- （BROKEN: 去掉了第一人称要求）`,
    why: '第74组「压缩指令要求第一人称」必须红 —— 否则第三人称流水账会回来',
  },
  {
    // ⚠️ 2026-11-12 第一次写错了：只删「- **证据分级**：」这一行标题，
    //   下面三条分级条款还在 → **功能其实没被破坏** → 测试全绿是**正确结果**，
    //   不是判据没区分力。破坏点必须破坏「功能」，不是破坏「标题」。
    //   所以这里删掉**整段**（标题 + 三条分级 + 三者不许混写）。
    name: '证据分级整段删除（三档可信度不再区分）',
    file: 'lib/compaction.js',
    find: `- **证据分级**（这是本便条最重要的质量要求）：`,
    repl: `- （BROKEN: 整段分级被删）`,
    why: '第74组「三档分级各自带判定条件」必须红 —— 否则推断会被写成已验证',
    multi: [
      `  - 写「已验证 / 已确认」之前，必须能指出**具体的工具输出或文件行号**；`,
      `  - 只记得「大概是这样」的，写「⚠️ 记不清，需重查」；`,
      `  - 你**推断**出来、但从没实际验证过的，写「⚠️ 女仆的推断，未验证」；`,
      `  - 三者不许混写，不许把推断写成已验证。`,
    ],
    // ⚠️ 源码是 CRLF，而这里的模板字符串是 LF —— 直接整行匹配会 miss。
    //   所以 multi 每项只匹配**行内容**，由下面按行删除（见 multiLine: true）。
    multiLine: true,
  },
  {
    name: 'summarizationProvider 从缺省里删掉（死开关复发）',
    file: 'lib/config.js',
    find: `  summarizationProvider: '',\n  summarizationModel: '',\n`,
    repl: ``, // BROKEN: 键没了 → mergeKnown 会丢弃配置值
    why: '第36组「写进配置的 summarizationProvider 能读出来」必须红 —— 2026-11-12 修的真事故',
  },
]

console.log('══ dsh-mind 反向验证 ══\n')

// 先确认基线是绿的
const base = spawnSync(process.execPath, [join(HERE, 'regress.mjs')], { encoding: 'utf8' })
const baseOk = /全部通过/.test(base.stdout ?? '')
console.log(`基线：${baseOk ? '✅ 全绿' : '❌ 已经红了，反向验证无意义'}\n`)
if (!baseOk) {
  console.log(base.stdout?.slice(-2000) ?? base.stderr?.slice(-2000))
  process.exit(1)
}

let caught = 0
let missed = 0
const missedList = []

for (const b of BREAKS) {
  const tmp = mkdtempSync(join(tmpdir(), 'mind-rev-'))
  try {
    // 复制整个包（lib + tests），在副本里破坏 —— 绝不碰真源码
    cpSync(join(ROOT, 'lib'), join(tmp, 'lib'), { recursive: true })
    cpSync(join(ROOT, 'tests'), join(tmp, 'tests'), { recursive: true })
    cpSync(join(ROOT, 'package.json'), join(tmp, 'package.json'))

    const f = join(tmp, b.file)
    if (!existsSync(f)) {
      console.log(`⚠️  ${b.name} —— 文件不存在，跳过`)
      missed++
      missedList.push(`${b.name}（文件不存在）`)
      continue
    }
    const src = readFileSync(f, 'utf8')
    const hits = src.split(b.find).length - 1
    if (hits !== 1) {
      // 破坏点失配 = 源码变了，这个破坏点已经测不到东西
      console.log(`⚠️  ${b.name} —— 锚点命中 ${hits} 次（应为 1），破坏点已失效`)
      missed++
      missedList.push(`${b.name}（锚点失配 ${hits} 次）`)
      continue
    }
    writeFileSync(f, src.replace(b.find, b.repl), 'utf8')

    // ⚠️ 2026-11-12 补：`multi` = 主锚点替换之外**还要一起删掉**的其他片段。
    //   动机：有些功能的"标题行"和"实际条款"是分开的，只删标题行等于没破坏功能
    //   （证据分级那次就是这样，测试全绿是正确结果，却被误报成"判据没区分力"）。
    //   每段都必须**恰好命中一次**，否则说明源码变了、破坏点已失效。
    if (Array.isArray(b.multi)) {
      let body = readFileSync(f, 'utf8')
      let multiBad = null
      // ⚠️ multiLine=true：按**整行内容**删，不依赖行尾是 LF 还是 CRLF。
      //   踩过的坑：源码是 CRLF，模板字符串写 `...；\n` 会 miss；
      //   改成按行比对 + 删整行，两种换行都能处理。
      const lines = body.split(/\r?\n/)
      for (const frag of b.multi) {
        const idxs = lines.map((l, i) => (l === frag ? i : -1)).filter((i) => i >= 0)
        if (idxs.length !== 1) {
          multiBad = `multi 行命中 ${idxs.length} 次（应为 1）：${frag.slice(0, 40)}…`
          break
        }
        lines[idxs[0]] = null // 标记待删
      }
      if (multiBad) {
        console.log(`⚠️  ${b.name} —— ${multiBad}`)
        missed++
        missedList.push(`${b.name}（${multiBad}）`)
        continue
      }
      body = lines.filter((l) => l !== null).join('\r\n')
      writeFileSync(f, body, 'utf8')
    }

    const r = spawnSync(process.execPath, [join(tmp, 'tests', 'regress.mjs')], { encoding: 'utf8' })
    const red = r.status !== 0
    const m = /总计 (\d+) 项：通过 (\d+)，失败 (\d+)/.exec(r.stdout ?? '')
    const fails = m ? Number(m[3]) : -1

    if (red) {
      caught++
      console.log(`✅ ${b.name}`)
      console.log(`     变红：失败 ${fails} 项 → ${b.why}`)
    } else {
      missed++
      missedList.push(b.name)
      console.log(`❌ ${b.name}`)
      console.log(`     **破坏后仍然全绿** —— 该判据没有区分力：${b.why}`)
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

console.log('\n' + '='.repeat(52))
console.log(`破坏点 ${BREAKS.length} 个：抓到 ${caught}，漏掉 ${missed}`)
if (missed > 0) {
  console.log('\n漏掉的（判据需要加强）：')
  for (const n of missedList) console.log(`  - ${n}`)
}
console.log('='.repeat(52))

if (missed > 0) {
  console.log('\n⚠️ 有破坏点没被抓到，说明对应判据没有区分力')
  process.exit(1)
} else {
  console.log('\n✅ 每个破坏点都能让测试变红 —— 判据有区分力')
}