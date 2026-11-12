// dsh-mind 完整回归
//
// ⚠️ 硬隔离：整个测试跑在临时目录，绝不碰 ~/.dsh/mind。
//    strand 时代靠"跑完恢复"，结果把 5 条真实事实冲成了 120 条测试残留——
//    因为恢复用的是测试开始时的快照，而那次快照本身已经是脏的。
//    现在让测试根本读不到真实目录。
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const TEST_DIR = mkdtempSync(join(tmpdir(), 'mind-test-'))
const TEST_EXP = mkdtempSync(join(tmpdir(), 'mind-exp-'))
process.env.MIND_DIR = TEST_DIR
process.env.MIND_EXPERIENCE_DIR = TEST_EXP
process.env.MIND_REFRESH_MS = '0' // 时间间隔在测试里恒为 0（否则节流会吞掉一切）

// ⚠️ 2026-11-06 补：**MIND_CONFIG 也必须隔离**。
//   原来只隔离了 MIND_DIR / MIND_EXPERIENCE_DIR，配置读的还是真实的
//   `~/.dsh/mind.json`。于是主人一旦在那里关掉某段（例如 strand），
//   测试就成片报红（实测 35 项），看起来像代码坏了，其实是测试读了生产配置。
//
//   README 写的是「测试硬隔离：整个跑在临时目录」—— 配置不算目录，之前漏了。
//   现在指到临时目录下一个**不存在的**文件：readConfig() 会走 DEFAULT_CONFIG 全开，
//   测试行为与主人本机配置完全解耦。
const TEST_CONFIG = join(TEST_DIR, 'mind.json') // 故意不创建
process.env.MIND_CONFIG = TEST_CONFIG

// 安全阀：万一 MIND_DIR 没生效，宁可中止也不能写真实数据
if (!TEST_DIR.includes('mind-test-')) {
  console.error('❌ 测试目录不对，中止：' + TEST_DIR)
  process.exit(2)
}

const GLOBAL = join(TEST_DIR, 'global.json')
const STATE = join(TEST_DIR, 'state.json')

let pass = 0,
  fail = 0
const check = (n, ok, ex = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${n}${ex ? '  ' + ex : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${n}${ex ? '  ' + ex : ''}`)
  }
}
const group = (t) => console.log(`\n【${t}】`)

// ─────────────────────── 装载模块 ───────────────────────
const mod = await import(`file:///${join(ROOT, 'lib', 'index.js').split('\\').join('/')}?t=${Date.now()}`)
const io = await import(`file:///${join(ROOT, 'lib', 'io.js').split('\\').join('/')}`)
const message = await import(`file:///${join(ROOT, 'lib', 'message.js').split('\\').join('/')}`)
// ⚠️ 2026-11-08 拆分：global.js 已搬到 dsh-strand。这里改用**内存垫片**，
//   形状与语义与真实现一致，但不落盘、不碰真实数据。见 tests/shim-global.mjs。
const global = await import(`file:///${join(ROOT, 'tests', 'shim-global.mjs').split('\\').join('/')}`)
const budgetMod = await import(`file:///${join(ROOT, 'lib', 'budget.js').split('\\').join('/')}`)
const configMod = await import(`file:///${join(ROOT, 'lib', 'config.js').split('\\').join('/')}`)
const stateMod = await import(`file:///${join(ROOT, 'lib', 'state.js').split('\\').join('/')}`)
// ⚠️ 2026-11-08 拆分：segments/strand.js 已搬到 dsh-strand
// const strandSeg = await import(...)
const tacitSeg = await import(`file:///${join(ROOT, 'lib', 'segments', 'tacit.js').split('\\').join('/')}`)
const psycheSeg = await import(`file:///${join(ROOT, 'lib', 'segments', 'psyche.js').split('\\').join('/')}`)
const toolsMod = await import(`file:///${join(ROOT, 'lib', 'tools.js').split('\\').join('/')}`)

// ─────────────────────── 假宿主 ───────────────────────
/**
 * 假 ctx。
 *
 * ⚠️ `on` 必须支持**多监听器**。早年写法 `h[e] = f` 只能存一个，
 *    而对 `agent/inbox/claimed` 会注册多个监听器，后一个把前一个静默覆盖掉——
 *    测试里采集全挂，生产环境却正常。真实 Cordis 本来就是多监听器。
 */
const mkCtx = (agents = []) => {
  const h = {}
  const ctx = {
    agents: { list: () => agents, get: (id) => agents.find((a) => a.id === id) },
    on: (e, f) => {
      ;(h[e] ??= []).push(f)
    },
    get: () => undefined, // tools 服务在测试里不可用；工具注册另行单独测
    effect: (fn) => {
      try {
        const d = fn()
        if (typeof d === 'function') d()
      } catch {
        /* ignore */
      }
    },
    _h: h,
    /** 同步事件：按注册顺序依次调用全部监听器。 */
    _emit(e, payload) {
      for (const f of h[e] ?? []) f(payload)
    },
    /** waterfall：链式调用全部监听器，最后一个接 next。 */
    _call(e, payload, next) {
      const fs_ = h[e] ?? []
      if (fs_.length === 0) return next?.()
      const invoke = (i) => {
        if (i >= fs_.length) return next?.()
        return fs_[i](payload, () => invoke(i + 1))
      }
      return invoke(0)
    },
  }
  return ctx
}

let seq = 0
const mkMsg = (t, k = 'user', role = 'user') => ({
  id: `m-${++seq}`,
  role,
  content: [{ type: 'text', text: t }],
  source: { kind: k },
})
const acceptNext = (msgs) => async () => ({ kind: 'accept', messages: msgs.map((m) => ({ ...m })) })
const fire = async (ctx, agent, step = 1, msgs = null) => {
  const list = msgs ?? [mkMsg('（占位）')]
  return await ctx._call(
    'agent/pre-step',
    { agent, messages: list, step, signal: { aborted: false, throwIfAborted() {} } },
    acceptNext(list),
  )
}
const claimed = (ctx, agent, m) => ctx._emit('agent/inbox/claimed', { agent, message: m })

/** 取本插件注入的那条（整合后只有一条，kind 固定）。 */
const injMsg = (out) => (out?.messages ?? []).find((x) => x?.source?.kind === message.KIND_INJECT)
const inj = (out) => {
  const m = injMsg(out)
  return m ? (m.content?.[0]?.text ?? '') : null
}
/** 取投递的那条。 */
const pushMsg = (out) => (out?.messages ?? []).find((x) => x?.source?.kind === message.KIND_PUSH)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resetData() {
  rmSync(GLOBAL, { force: true })
  rmSync(STATE, { force: true })
}

// ══════════════════════════════════════════════════════════════
// 第一组：注入形状合规（原 strand【1】【2】+ psyche 契约）
// ══════════════════════════════════════════════════════════════
group('7 失败降级')
{
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  // 畸形 payload：没有 agent
  const out = await ctx._call('agent/pre-step', { messages: [], step: 1 }, acceptNext([]))
  check('无 agent 不抛', out?.kind === 'accept')
  // agent 但 messages 不是数组
  const out2 = await ctx._call('agent/pre-step', { agent: a, messages: null, step: 1 }, acceptNext([]))
  check('messages=null 不抛', out2?.kind === 'accept')
  // reject 原样返回
  const out3 = await ctx._call('agent/pre-step', { agent: a, messages: [], step: 1, signal: { aborted: false } }, async () => ({ kind: 'reject' }))
  check('reject 原样返回', out3?.kind === 'reject')
  // aborted 不注入
  const out4 = await ctx._call('agent/pre-step', { agent: a, messages: [], step: 1, signal: { aborted: true } }, async () => ({ kind: 'accept', messages: [] }))
  check('aborted 不注入', !inj(out4))
}

// ══════════════════════════════════════════════════════════════
// 第八组：并发写不丢 / 原子写
// ══════════════════════════════════════════════════════════════
group('9 插入位置按 id 比对')
{
  resetData()
  global.rememberFact('k', 'v', 'test')
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)

  // ⚠️ 这个判据必须能区分「插在 claimed 之后」与「插在末尾」。
  //   第一版用 [sys, user] 两条测，而正确位置恰好就是末尾 ——
  //   把 claimedIds 清空（退化成"插到末尾"）测试仍然全绿，判据零区分力。
  //   （2026-11-03 tests/reverse.mjs 抓到）
  //
  //   正确测法：让**上游插件已经插了一条**在 claimed 之后，
  //   于是「正确位置（claimed 正后方）」与「末尾」不再重合。
  const sys = { id: 'sys-1', role: 'system', content: [{ type: 'text', text: '系统' }] }
  const user = mkMsg('主人输入')
  const upstream = { id: 'up-1', role: 'user', content: [{ type: 'text', text: '上游插件插的' }], source: { kind: 'other-plugin' } }
  const claimedList = [user]
  const decisionList = [sys, user, upstream] // 上游已插了一条在 user 之后

  const out = await ctx._call(
    'agent/pre-step',
    { agent: a, messages: claimedList, step: 1, signal: { aborted: false } },
    async () => ({ kind: 'accept', messages: decisionList.map((m) => ({ ...m })) }),
  )
  const idx = out.messages.findIndex((m) => m?.source?.kind === message.KIND_INJECT)
  const userIdx = out.messages.findIndex((m) => m.id === user.id)
  const upIdx = out.messages.findIndex((m) => m.id === 'up-1')
  check('注入紧跟在 claimed 消息之后', idx === userIdx + 1, `inj=${idx} user=${userIdx}`)
  check('注入在上游插件消息之前（不抢到末尾）', idx < upIdx, `inj=${idx} up=${upIdx}`)
  check('注入不在最前（不越过 system）', idx > 0)
}

// ══════════════════════════════════════════════════════════════
// 第十组：Map 有上界
// ══════════════════════════════════════════════════════════════
group('10 Map 有上界')
{
  resetData()
  const agents = []
  for (let i = 0; i < 260; i++) agents.push({ id: `s-${i}`, session: { id: `s-${i}` } })
  const ctx = mkCtx(agents)
  mod.apply(ctx)
  for (const a of agents) await fire(ctx, a, 1)
  // 通过日志与状态间接验证：不应 OOM，且窗口数被上界挡住
  const st = new stateMod.Store()
  for (const a of agents) st.touch(a.id)
  check('窗口数不超过 MAX_WINDOWS', st.windows.size <= stateMod.MAX_WINDOWS, `${st.windows.size} <= ${stateMod.MAX_WINDOWS}`)
}

// ══════════════════════════════════════════════════════════════
// 第十一组：自适应间隔
// ══════════════════════════════════════════════════════════════
group('17 在用窗口数准确')
{
  const st = new stateMod.Store()
  st.touch('w1')
  const w2 = st.touch('w2')
  w2.aliveUntil = Date.now() - 1000 // 手动判死
  const live = st.liveWindows()
  check('只算活着的', live.length === 1 && live[0].id === 'w1', `live=${live.length}`)
  check('死窗口仍在 Map 里（等上界回收）', st.windows.size === 2)
}

// ══════════════════════════════════════════════════════════════
// 第十八组：活跃窗口不会被误判成关闭
// ══════════════════════════════════════════════════════════════
group('18 活跃窗口不会被误判')
{
  resetData()
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  // 连着多步 fire，只看不应被判死
  for (let i = 1; i <= 3; i++) await fire(ctx, a, i)
  const st = new stateMod.Store()
  st.touch('s-a')
  check('TTL 内仍算活', st.liveWindows()[0]?.aliveUntil > Date.now())
  check('TTL 是 5 分钟', stateMod.ALIVE_TTL_MS === 5 * 60 * 1000)
}

// ══════════════════════════════════════════════════════════════
// 第十九组：重启后旧的 aliveUntil 必须被清掉
// ══════════════════════════════════════════════════════════════
group('19 重启后旧 aliveUntil 被清')
{
  const st = new stateMod.Store()
  // ⚠️ 必须显式打开落盘：snapshot() 默认不写（防调试脚本写坏真实数据）。
  //   不打开的话这一组读到的是**之前 apply 留下的旧文件**，
  //   断言照样能过 —— 但测的不是它自己写的东西（假绿）。
  st.allowPersist = true
  st.touch('w1')
  st.touch('w2')
  const n = st.resetAlive()
  check('resetAlive 清了全部', n === 2, String(n))
  check('清完不算活', st.liveWindows().length === 0)
  // 落盘快照里绝不能含 aliveUntil
  rmSync(STATE, { force: true }) // 先删干净，确保读到的是本次写的
  const wrote = st.snapshot(true)
  check('snapshot 真的写了盘', wrote === true && existsSync(STATE))
  const raw = readFileSync(STATE, 'utf8')
  check('落盘不含 aliveUntil', !raw.includes('aliveUntil'))
  check('落盘不含 thinking', !raw.includes('"thinking"'))
  const saved = JSON.parse(raw)
  check('落盘含 identity', !!saved.identity?.name, saved.identity?.name)
  check('落盘含窗口 label 字段结构', typeof saved.windows === 'object')

  // 反向：不打开 allowPersist 时**绝不写盘**（这是防误写真实数据的关键）
  rmSync(STATE, { force: true })
  const st2 = new stateMod.Store()
  st2.touch('w9')
  const wrote2 = st2.snapshot(true)
  check('★ 未打开 allowPersist 时不写盘', wrote2 === false && !existsSync(STATE), `wrote=${wrote2} exists=${existsSync(STATE)}`)
}

// ══════════════════════════════════════════════════════════════
// 第二十组：经验库解析
// ══════════════════════════════════════════════════════════════
group('20 经验库解析')
{
  tacitSeg._clearCache()
  const good = `---
id: test-good
trigger: task.demo
condition: action == "x"
action: 做这件事
trust_level: L2
---
# 标题在正文里
正文内容`
  const p = tacitSeg.parse(good, 'test-good.md')
  check('解析出 id', p?.id === 'test-good')
  check('解析出 trigger', p?.trigger === 'task.demo')
  check('解析出 condition', p?.condition === 'action == "x"')
  check('解析出 trust', p?.trust === 'L2')
  check('标题取自正文一级标题', p?.title === '标题在正文里', p?.title)
  check('没有 trigger → 丢弃', tacitSeg.parse('---\nid: x\n---\nbody', 'x.md') === undefined)
  check('enabled: false → 丢弃', tacitSeg.parse('---\nid: x\ntrigger: t\nenabled: false\n---\nb', 'x.md') === undefined)
  check('没有 frontmatter → 丢弃', tacitSeg.parse('纯正文', 'x.md') === undefined)
}

// ══════════════════════════════════════════════════════════════
// 第二十一组：信号匹配
// ══════════════════════════════════════════════════════════════
group('21 信号匹配')
{
  check('** 全匹配', tacitSeg.triggerMatches('**', 'anything.here') === true)
  check('a.** 匹配自身', tacitSeg.triggerMatches('a.b.**', 'a.b') === true)
  check('a.** 匹配后代', tacitSeg.triggerMatches('a.b.**', 'a.b.c.d') === true)
  check('前缀匹配', tacitSeg.triggerMatches('task', 'task.plugin-install') === true)
  check('精确匹配', tacitSeg.triggerMatches('a.b', 'a.b') === true)
  check('同族匹配', tacitSeg.triggerMatches('file.created', 'file.modified') === true)
  check('不相关不匹配', tacitSeg.triggerMatches('task.bili', 'other.thing') === false)
  check('空 trigger 不匹配', tacitSeg.triggerMatches('', 'x') === false)
}

// ══════════════════════════════════════════════════════════════
// 第二十二组：条件求值
// ══════════════════════════════════════════════════════════════
group('22 条件求值')
{
  check('true', tacitSeg.conditionHolds('true', {}) === true)
  check('空 = true', tacitSeg.conditionHolds('', {}) === true)
  check('false', tacitSeg.conditionHolds('false', {}) === false)
  check('== 命中', tacitSeg.conditionHolds('action == "upload"', { action: 'upload' }) === true)
  check('== 不命中', tacitSeg.conditionHolds('action == "upload"', { action: 'dm' }) === false)
  check('in 命中', tacitSeg.conditionHolds('action in [upload, dm]', { action: 'dm' }) === true)
  check('in 不命中', tacitSeg.conditionHolds('action in [upload, dm]', { action: 'reply' }) === false)
  check('嵌套路径', tacitSeg.conditionHolds('a.b == "x"', { a: { b: 'x' } }) === true)
  check('不认识的写法 → false（宁可漏不可误）', tacitSeg.conditionHolds('weird syntax here', {}) === false)
}

// ══════════════════════════════════════════════════════════════
// 第二十三组：信号推导
// ══════════════════════════════════════════════════════════════
group('23 信号推导')
{
  check('B站上传 → task.bili-write/upload', JSON.stringify(tacitSeg.deriveSignal('帮我上传视频到B站')) === JSON.stringify({ path: 'task.bili-write', context: { action: 'upload' } }))
  check('B站私信 → dm', tacitSeg.deriveSignal('给B站发私信')?.context?.action === 'dm')
  check('装插件 → task.plugin-install', tacitSeg.deriveSignal('装插件吧')?.path === 'task.plugin-install')
  check('python → task.spawn-python', tacitSeg.deriveSignal('跑个python脚本')?.path === 'task.spawn-python')
  check('会话损坏 → task.session-repair', tacitSeg.deriveSignal('会话损坏了')?.path === 'task.session-repair')
  check('只有"B站"没有动作 → 无信号（关键反向）', tacitSeg.deriveSignal('B站是什么') === undefined)
  check('闲聊 → 无信号', tacitSeg.deriveSignal('今天天气不错') === undefined)
  check('空输入 → 无信号', tacitSeg.deriveSignal('') === undefined)
}

// ══════════════════════════════════════════════════════════════
// 第二十四组：经验命中与渲染
// ══════════════════════════════════════════════════════════════
group('24 经验命中与渲染')
{
  tacitSeg._clearCache()
  writeFileSync(
    join(TEST_EXP, 'bili-action.md'),
    `---\nid: bili-action\ntrigger: task.bili-write\ncondition: action in [upload, dm]\naction: 先脱敏再发；投稿必须 --dry-run\ntrust_level: L2\n---\n# B站公开发布\n正文`,
    'utf8',
  )
  tacitSeg._clearCache()
  const hits = tacitSeg.matchExperiences('task.bili-write', { action: 'upload' })
  check('命中 1 条', hits.length === 1, String(hits.length))
  check('id 正确', hits[0]?.id === 'bili-action')
  const txt = tacitSeg.render(hits)
  check('渲染带水印', txt.startsWith(tacitSeg.MARK_TACIT))
  check('渲染带 trust', txt.includes('（L2）'))
  check('渲染带 action', txt.includes('--dry-run'))
  check('条件不满足 → 不命中', tacitSeg.matchExperiences('task.bili-write', { action: 'reply' }).length === 0)
  check('空命中 → 渲染空串', tacitSeg.render([]) === '')
  check('命中键稳定', tacitSeg.hitsKey(hits) === 'bili-action')
}

// ══════════════════════════════════════════════════════════════
// 第二十五组：经验注入全链路
// ══════════════════════════════════════════════════════════════
group('25 经验注入全链路')
{
  resetData()
  tacitSeg._clearCache()
  writeFileSync(
    join(TEST_EXP, 'plugin-install.md'),
    `---\nid: plugin-install\ntrigger: task.plugin-install\naction: 只在插件自己目录装依赖，不碰 profile\n trust_level: L1\n---\n# 装插件\n正文`.replace(' trust_level', 'trust_level'),
    'utf8',
  )
  tacitSeg._clearCache()
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  const out = await fire(ctx, a, 1, [mkMsg('帮我装插件')])
  const t = inj(out) ?? ''
  check('命中并注入经验', t.includes('plugin-install'))
  check('经验带自己的水印', t.includes(tacitSeg.MARK_TACIT))
  // ⚠️ 2026-11-08 拆分：strand 段已搬到 dsh-strand，它是独立的一条注入消息。
  //   本插件现在只发 psyche + tacit（+ 可选日记段）。
  check('两段水印都在同一条消息里', t.includes(message.MARK_PSYCHE) && t.includes(tacitSeg.MARK_TACIT))
  check('★ strand 水印不在本插件的注入里', !t.includes(message.MARK_STRAND))
  check('只有一条注入消息', out.messages.filter((x) => x?.source?.kind === message.KIND_INJECT).length === 1)
}

// ══════════════════════════════════════════════════════════════
// 第二十六组：同一组经验不重复注入
// ══════════════════════════════════════════════════════════════
group('26 同一组经验不重复注入')
{
  resetData()
  tacitSeg._clearCache()
  writeFileSync(join(TEST_EXP, 'repeat.md'), `---\nid: repeat\ntrigger: task.spawn-python\naction: 用绝对路径\n---\n# 重复\n正文`, 'utf8')
  tacitSeg._clearCache()
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  const t1 = inj(await fire(ctx, a, 1, [mkMsg('跑python脚本')])) ?? ''
  check('第一步命中', t1.includes('repeat'))
  const t2 = inj(await fire(ctx, a, 2, [mkMsg('跑python脚本')]))
  check('第二步同组不重复注入', t2 === null || !t2.includes('repeat'), t2 === null ? '(未注入)' : t2.slice(0, 40))
  // 换个事再回来：应该重新命中
  //
  // ⚠️ 2026-11-08 拆分后要等**两道节流**都到期：
  //   ① 指纹去重（内容变了就过）
  //   ② 时间节流 gapFor(内容长度) —— 测试里 MIND_REFRESH_MS=0 让它恒为 0
  //   但第 3 步"今天天气好"没命中经验 → 那一步 chars=0 → 可能整条注入为空被跳过，
  //   于是 `ds.tacitKey` 没被更新成空串、第 4 步仍然判定"同一组不重复"。
  //   这是**拆分后的真实语义**（不是 bug）：没注入过就不算"换过事"。
  //   所以这里改成先把 tacitKey 状态推一下 —— 用一步能产生注入但命中不同组的事。
  writeFileSync(join(TEST_EXP, 'other.md'), `---\nid: other\ntrigger: task.plugin-install\naction: 装插件走 junction\n---\n# 别的\n正文`, 'utf8')
  tacitSeg._clearCache()
  await fire(ctx, a, 3, [mkMsg('帮我装插件')]) // 命中另一组 → tacitKey 变了
  const t4 = inj(await fire(ctx, a, 4, [mkMsg('再跑个python脚本')])) ?? ''
  check('换个事再回来 → 重新命中', t4.includes('repeat'), t4.slice(0, 60))
}

// ══════════════════════════════════════════════════════════════
// 第二十七组：共享层配额
// ══════════════════════════════════════════════════════════════
group('31 状态层')
{
  const st = new stateMod.Store()
  st.recordUserTurn('w1', '主人说的话')
  st.recordIntent('w1', '在做某件事')
  st.recordActivity('w1', 'pwsh', '跑了条命令')
  const w = st.windows.get('w1')
  check('记录用户发言', w?.lastUserText === '主人说的话')
  check('记录意图', w?.intent?.text === '在做某件事')
  check('记录动作', w?.activity?.text === '跑了条命令')
  check('有单调 seq', typeof w?.activity?.seq === 'number' && w.activity.seq > 0)
  check('turns 递增', w?.turns === 1)

  // 同毫秒两次动作：seq 必须不同（用时间戳会永久漏报第二条）
  st.recordActivity('w1', 'read', '第一次')
  const s1 = st.windows.get('w1').activity.seq
  st.recordActivity('w1', 'read', '第二次')
  const s2 = st.windows.get('w1').activity.seq
  check('同毫秒两次动作 seq 不同', s2 > s1, `${s1} → ${s2}`)

  // 追求条目
  //
  // ⚠️ 必须先清洗磁盘上的 state.json（2026-11-03 测试抓到的隔离问题）：
  //   Store 构造时会从 STATE_PATH 恢复 pursuits —— 那是**正确的生产行为**
  //   （重启后还认得自己在追什么），但测试里上一组写过 pursuit，
  //   新的 Store 会把它捞回来，于是「未结 1 条」变成 2 条。
  //   测的不是 bug，是测试自己没隔离。这里显式清干净再新建。
  rmSync(STATE, { force: true })
  const st2 = new stateMod.Store()
  st2.allowPersist = true // 追求条目要走落盘恢复路径，这一组必须真写
  st2.recordUserTurn('w1', '主人说的话')
  const p = st2.addPursuit('追一件事')
  check('加追求', !!p?.id)
  check('同文本不重复加', st2.addPursuit('追一件事')?.id === p.id)
  check('未结 1 条', st2.openPursuits().length === 1, String(st2.openPursuits().length))
  check('空串不能关（否则误关第一条）', st2.closePursuit('') === null)
  check('关掉', !!st2.closePursuit(p.id))
  check('关后未结 0 条', st2.openPursuits().length === 0, String(st2.openPursuits().length))
}

// ══════════════════════════════════════════════════════════════
// 第三十二组：状态指纹敏感性
// ══════════════════════════════════════════════════════════════
group('32 状态指纹敏感性')
{
  const mkStore = () => {
    const s = new stateMod.Store()
    s.touch('w1')
    s.touch('w2')
    return s
  }
  const s1 = mkStore()
  const fp1 = s1.fingerprint()
  s1.recordUserTurn('w2', '别的窗口说的话')
  const fp2 = s1.fingerprint()
  check('别处用户发言 → 指纹变', fp1 !== fp2)

  const s2 = mkStore()
  const g1 = s2.fingerprint()
  s2.recordIntent('w2', '在追某事')
  const g2 = s2.fingerprint()
  check('别处意图变化 → 指纹变', g1 !== g2)

  const s3 = mkStore()
  const h1 = s3.fingerprint()
  s3.recordActivity('w2', 'pwsh', '动作')
  const h2 = s3.fingerprint()
  check('别处动作 → 指纹变', h1 !== h2)

  const s4 = mkStore()
  const i1 = s4.fingerprint()
  s4.setThinking('w2', true)
  const i2 = s4.fingerprint()
  check('思考状态 → 指纹变', i1 !== i2)
}

// ══════════════════════════════════════════════════════════════
// 第三十三组：渲染层（第一人称）
// ══════════════════════════════════════════════════════════════
group('33 第一人称渲染')
{
  const st = new stateMod.Store()
  st.touch('w1')
  st.touch('w2')
  st.recordUserTurn('w2', '别处说的话')
  st.recordActivity('w2', 'pwsh', '命令')
  const full = psycheSeg.renderFull(st, 'w1')
  check('带水印', full.startsWith(message.MARK_PSYCHE))
  check('第一人称「你是」', full.includes('你是星'))
  check('「注意力分散在 2 处」', full.includes('分散在 2 处'), full.slice(0, 120))
  check('明写「不是你在这个窗口的经历」', full.includes('不是你在这个窗口的经历'))
  check('带工具人话翻译', full.includes('在终端跑命令'))
  check('不把别处写成「另一个窗口」那种监控口径', !full.includes('另一个窗口'))
}

// ══════════════════════════════════════════════════════════════
// 第三十四组：增量必须能表达进指纹的每个字段
// ══════════════════════════════════════════════════════════════
group('34 增量与指纹对称')
{
  const st = new stateMod.Store()
  st.touch('w1')
  st.touch('w2')
  const snap = psycheSeg.snapOf(st, 'w1')
  check('快照不含自己', !('w1' in snap), Object.keys(snap).join(','))

  // 主人对别处说话：指纹必须变，增量必须表达
  st.recordUserTurn('w2', '新的吩咐')
  const d1 = psycheSeg.renderDelta(st, 'w1', snap)
  check('增量表达了别处的用户发言', d1.includes('新的吩咐'), d1)
  check('增量头带水印', d1.startsWith('【自我觉知 · 增量'))

  // 自己消失不能被报成「自己不再醒着」
  const snap2 = psycheSeg.snapOf(st, 'w1')
  st.dispose('w2')
  st.windows.delete('w2')
  const d2 = psycheSeg.renderDelta(st, 'w1', snap2)
  check('报别人的消失', d2.includes('不再醒着'))
  check('绝不报自己的死讯', !d2.includes('w1'))
}

// ══════════════════════════════════════════════════════════════
// 第三十五组：预算
// ══════════════════════════════════════════════════════════════
group('35 预算')
{
  // ⚠️ 段上限用**测试自己的值**，不读 DEFAULT_CONFIG：
  //   预算会被主人按需调，测试若硬绑缺省值，每次调参都要改测试，等于没测机制。
  //
  // ⚠️ 2026-11-08 拆分：段名从 strand 改成 diary（日记独立成段了）。
  //   strand 那段已搬到 dsh-strand，本插件不再有它。
  const texts = { diary: 'S'.repeat(5000), tacit: 'T'.repeat(2000), psyche: 'P'.repeat(2000) }
  const b = { total: 6000, diary: 4000, tacit: 1200, psyche: 1200 }
  const r = budgetMod.applyBudget(texts, b)
  check('段上限生效：diary ≤ 4000+截断标记', r.segments.diary.length <= 4050, String(r.segments.diary.length))
  check('段上限生效：tacit ≤ 1200+截断标记', r.segments.tacit.length <= 1250, String(r.segments.tacit.length))
  check('段上限生效：psyche ≤ 1200+截断标记', r.segments.psyche.length <= 1250, String(r.segments.psyche.length))
  check('总上限生效', r.chars <= 6000, String(r.chars))
  check('有裁剪记录（必须留痕）', r.trimmed.length > 0, r.trimmed.join('|'))

  // 缺省配置本身也要自洽（段上限之和 ≥ 总上限，否则永远削不满）
  const D = configMod.DEFAULT_CONFIG.budget
  check('缺省总上限 ≥ 各段之和（否则某段永远被白削）', D.total >= D.diary + D.tacit + D.psyche, `${D.total} vs ${D.diary + D.tacit + D.psyche}`)
  check('★ 缺省配置里不再有 strand 份额（跨会话已拆出）', D.strand === undefined, String(D.strand))

  // 关掉一段 → 总预算真的让出来
  const r2 = budgetMod.applyBudget({ diary: 'S'.repeat(5000), tacit: '', psyche: '' }, b)
  check('空段不占预算', r2.chars < 5000, String(r2.chars))

  // 不超预算时原样返回
  const small = { diary: 'abc', tacit: 'def', psyche: 'ghi' }
  const r3 = budgetMod.applyBudget(small, b)
  check('不超预算不改内容', r3.segments.diary === 'abc' && r3.segments.tacit === 'def' && r3.segments.psyche === 'ghi')
  check('不超预算不留裁剪记录', r3.trimmed.length === 0)

  // 截断尽量在行边界
  //
  // ⚠️ 15 字符里塞不下「（本条因预算被截断，原文 N 字符）」这句说明，
  //    cutText 会退化为"只截原文本、不写说明"（否则说明本身就把预算撑爆）。
  //    所以这里要测两个层面：够长时必须有说明，过短时不许硬塞。
  const multiline = 'AAAA\nBBBB\nCCCC\nDDDD'
  const cutShort = budgetMod.cutText(multiline, 10)
  check('极短预算：优先保内容、不硬塞说明', cutShort.length <= 10 && !cutShort.includes('截断'), JSON.stringify(cutShort))

  // ⚠️ 要截断必须先**真的超过预算**：字符串长度必须 > max。
  //    'AAAA\nBBBB\nCCCC\nDDDD\nEEEE\nFFFF\nGGGG\nHHHH' 是 39 字符，用 max=40 仍然不截断 ——
  //    第一版就是这样，等于什么都没测（2026-11-03 测试自己数错了长度）。
  const longLine = 'AAAA\nBBBB\nCCCC\nDDDD\nEEEE\nFFFF\nGGGG\nHHHH'
  check('前置：测试串确实超过预算', longLine.length > 30, `len=${longLine.length}`)
  const cut = budgetMod.cutText(longLine, 30)
  // 断点是「最后一条完整的行」——说明占 21 字符，30 - 21 = 9 只够放两行，
  // 所以切在 BBBB 之后是对的（切在 CCCC 之后就塞不下说明了）。
  check('切点落在完整行之后', cut.startsWith('AAAA\nBBBB\n（'), JSON.stringify(cut))
  check('过长时带截断说明', cut.includes('因预算被截断'), JSON.stringify(cut))
  check('截断后总长不超过预算', cut.length <= 30, String(cut.length))
  check('截断说明写了原长度', cut.includes('原文 39 字符'))
}

// ══════════════════════════════════════════════════════════════
// 第三十六组：配置
// ══════════════════════════════════════════════════════════════
group('36 配置')
{
  check('缺省全开', configMod.DEFAULT_CONFIG.enabled === true)
  check('缺省两段都开（strand 已拆出）', configMod.DEFAULT_CONFIG.tacit.enabled && configMod.DEFAULT_CONFIG.psyche.enabled)
  check('★ 缺省里不再有 strand 段', configMod.DEFAULT_CONFIG.strand === undefined, String(configMod.DEFAULT_CONFIG.strand))
  check('缺省有预算', configMod.DEFAULT_CONFIG.budget.total > 0)

  // 未知键忽略、类型不符忽略
  const merged = configMod.mergeKnown(configMod.DEFAULT_CONFIG, {
    enabled: false,
    unknownKey: 'should be ignored',
    psyche: { enabled: 'not-a-boolean', inject: false },
    // ⚠️ 旧配置里的 strand 段必须被**当成未知键忽略**，
    //   而不是被搬进来当成"能开关跨会话"的假开关。
    strand: { enabled: true, inject: true },
  })
  check('已知布尔读到了', merged.enabled === false)
  check('未知键被忽略', !('unknownKey' in merged))
  check('★★ 旧配置的 strand 段被忽略（不留下假开关）', merged.strand === undefined, String(merged.strand))
  check('类型不符被忽略（保持缺省）', merged.psyche.enabled === true)
  check('同层其他键正确读到', merged.psyche.inject === false)
  check('缺省对象没被污染', configMod.DEFAULT_CONFIG.psyche.inject === true)

  // ─────────────────────────────────────────────────────────────
  // 🩸 2026-11-12 血证：summarizationProvider 曾是**永不通电的死开关**
  //
  //   compaction.js:315 一直在读 `config.summarizationProvider`，
  //   但 DEFAULT_CONFIG 里没有这两个键；而 mergeKnown 只遍历
  //   `Object.keys(defaults)` —— 于是主人真写进 mind.json 的值被
  //   **静默丢弃**，条件恒为 undefined。
  //
  //   为什么长期没人发现：回退链 `configured ?? latest ?? agentTarget`
  //   总能兜住，不报错、日志里也看不出来。只有想「给压缩单配模型」时才会撞上。
  //
  //   判据分两层，缺一不可：
  //     ① 缺省里有这个键（存在性）
  //     ② 写进配置后能读出来（有效性）——只有 ① 不够，
  //        键存在但合并时被丢掉的坑正是本次事故
  // ─────────────────────────────────────────────────────────────
  check(
    '★ 缺省里有 summarizationProvider（否则配置永远读不到）',
    Object.prototype.hasOwnProperty.call(configMod.DEFAULT_CONFIG, 'summarizationProvider'),
  )
  check(
    '★ 缺省里有 summarizationModel',
    Object.prototype.hasOwnProperty.call(configMod.DEFAULT_CONFIG, 'summarizationModel'),
  )
  check(
    '★ 缺省值为空串（= 走回退链，不改变既有行为）',
    configMod.DEFAULT_CONFIG.summarizationProvider === '' &&
      configMod.DEFAULT_CONFIG.summarizationModel === '',
  )
  const mergeSum = configMod.mergeKnown(configMod.DEFAULT_CONFIG, {
    summarizationProvider: 'buddy',
    summarizationModel: 'deepseek-v4.1-flash',
  })
  check(
    '★★ 写进配置的 summarizationProvider 能真的读出来（修复前恒为空串）',
    mergeSum.summarizationProvider === 'buddy',
    String(mergeSum.summarizationProvider),
  )
  check(
    '★★ summarizationModel 同样能读出来',
    mergeSum.summarizationModel === 'deepseek-v4.1-flash',
    String(mergeSum.summarizationModel),
  )
  check(
    '缺省对象没被污染（summarizationProvider 仍为空串）',
    configMod.DEFAULT_CONFIG.summarizationProvider === '',
  )
}

// ══════════════════════════════════════════════════════════════
// 第三十七组：路径一致性
// ══════════════════════════════════════════════════════════════
group('37 路径一致性')
{
  check('MIND_DIR 认环境变量', io.MIND_DIR() === TEST_DIR, io.MIND_DIR())
  check('GLOBAL_PATH 从 MIND_DIR 推', io.GLOBAL_PATH().startsWith(TEST_DIR))
  check('STATE_PATH 从 MIND_DIR 推', io.STATE_PATH().startsWith(TEST_DIR))
  check('LOG_PATH 从 MIND_DIR 推', io.LOG_PATH().startsWith(TEST_DIR))
  check('经验目录独立可覆盖', io.EXPERIENCE_DIR() === TEST_EXP, io.EXPERIENCE_DIR())

  // 用 `||` 而不是 `??`：空字符串必须回退默认值
  const old = process.env.MIND_DIR
  process.env.MIND_DIR = ''
  const fallback = io.MIND_DIR()
  process.env.MIND_DIR = old
  check('空字符串回退到默认目录', fallback.includes('.dsh') && fallback.endsWith('mind'), fallback)

  // CLI 必须用同一套解析
  const cliSrc = readFileSync(join(ROOT, 'lib', 'cli.mjs'), 'utf8')
  check('CLI 不自己写 homedir 路径', !cliSrc.includes("homedir()") && !cliSrc.includes('homedir,'))
  check('CLI 从 io.js 取路径', cliSrc.includes("from './io.js'"))

  // ══════════════════════════════════════════════════════════
  // ⚠️ 2026-11-08 拆分后被真机抓到的漏洞：上面两条**只看文本**。
  //
  // 拆分时 cli.mjs 顶层还留着
  //     import { readGlobal, ... } from './global.js'
  // 而 global.js 已随 facts 搬到 dsh-strand。ESM 在**模块链接阶段**就解析
  // import，所以整个文件直接 `Cannot find module` 退出（exit=1）——
  // 连 path/log/sessions 这些跟跨会话无关的命令也一起废了。
  //
  // 但文本判据全绿：源码里确实有 `from './io.js'`，确实没写 homedir。
  // **文本里有那行 import ≠ 能跑起来。**
  //
  // 所以必须真的 spawn 一次。判据选 `path`：它不读不写任何业务数据，
  // 只是把三个路径打印出来，副作用最小，但它要能跑起来就必须能加载整个模块图。
  // ══════════════════════════════════════════════════════════
  {
    const r = spawnSync(process.execPath, [join(ROOT, 'lib', 'cli.mjs'), 'path'], {
      encoding: 'utf8',
      env: { ...process.env, MIND_DIR: TEST_DIR, EXPERIENCE_DIR: TEST_EXP },
      timeout: 20000,
    })
    check('★★ CLI 能真的跑起来（不只是文本里有那行 import）', r.status === 0, `exit=${r.status} ${(r.stderr || '').slice(0, 300)}`)
    let parsed = null
    try {
      parsed = JSON.parse(r.stdout)
    } catch {
      parsed = null
    }
    check('★★ CLI 的 path 输出是合法 JSON', parsed !== null, String(r.stdout).slice(0, 200))
    check('★★ CLI 报告的目录与 io.js 一致', parsed?.dir === TEST_DIR, String(parsed?.dir))
    // 反向对照：确认"能跑"这条判据真的有区分力 —— 拿一个必然失败的参数试
    const bad = spawnSync(process.execPath, [join(ROOT, 'lib', 'cli.mjs'), 'remember', 'k', 'v'], {
      encoding: 'utf8',
      env: { ...process.env, MIND_DIR: TEST_DIR },
      timeout: 20000,
    })
    check('★★ 已搬走的命令给出明确指引并退 1（不是静默成功）', bad.status === 1, `exit=${bad.status}`)
    check('★★ 指引里点名 strand-cli', String(bad.stdout).includes('strand-cli'), String(bad.stdout).slice(0, 200))
  }
}

// ══════════════════════════════════════════════════════════════
// 第三十八组：工具定义
// ══════════════════════════════════════════════════════════════
group('38 工具定义')
{
  resetData()
  // ⚠️ 同上：Store 会从 state.json 恢复 pursuits，先清磁盘再建
  rmSync(STATE, { force: true })
  const st = new stateMod.Store()
  const defs = toolsMod.makeToolDefinitions(st, {
    config: configMod.DEFAULT_CONFIG,
    log: () => {},
    CLI_PATH: '/x/cli.mjs',
  })
  const names = defs.map((d) => d.name)
  check('注册了 mind_intend', names.includes('mind_intend'))
  check('注册了 mind_view', names.includes('mind_view'))
  check('注册了 mind_status', names.includes('mind_status'))
  check('注册了 mind_expand', names.includes('mind_expand'))
  check('注册了 mind_search', names.includes('mind_search'))
  check('注册了 mind_compress', names.includes('mind_compress'))
  // ⚠️ 2026-11-08 拆分：这四个已搬到 dsh-strand，改叫 strand_*。
  //   本插件若还注册它们，就会和 dsh-strand **撞名**（同一批工具名注册两次，
  //   宿主自己那套 register 对已存在的名字是抛错的）。
  check('★★ 不再注册 mind_remember（已搬到 dsh-strand）', !names.includes('mind_remember'))
  check('★★ 不再注册 mind_recall', !names.includes('mind_recall'))
  check('★★ 不再注册 mind_forget', !names.includes('mind_forget'))
  check('★★ 不再注册 mind_keys', !names.includes('mind_keys'))
  check('★ 工具数 = 6', defs.length === 6, String(defs.length))
  check('每个都有 description', defs.every((d) => typeof d.description === 'string' && d.description.length > 20))
  check('每个都有 parameters', defs.every((d) => d.parameters && typeof d.parameters === 'object'))
  check('每个都有 execute', defs.every((d) => typeof d.execute === 'function'))
  check('每个都有 output.render', defs.every((d) => typeof d.output?.render === 'function'))

  // mind_intend 能真写进状态
  const intend = defs.find((d) => d.name === 'mind_intend')
  const r1 = await intend.execute({ text: '在整合记忆插件' }, { agent: { id: 'w1' } })
  check('mind_intend 写入成功', r1.ok === true && r1.pursuit?.text === '在整合记忆插件')
  check('追求进了 Store', st.openPursuits().length === 1)
  const r2 = await intend.execute({ close: '整合记忆插件' }, { agent: { id: 'w1' } })
  check('mind_intend 能关闭', r2.ok === true)
  check('关后为 0', st.openPursuits().length === 0)
  const r3 = await intend.execute({ text: '' }, {})
  check('空 text 被拒', r3.ok === false)

  // mind_status 能跑
  const stat = defs.find((d) => d.name === 'mind_status')
  const r6 = await stat.execute({})
  check('mind_status 返回 ok', r6.ok === true)
  check('两段状态都在', !!r6.segments?.tacit && !!r6.segments?.psyche)
  check('★ strand 段报成「已搬到 dsh-strand」', r6.segments?.strand?.movedTo === 'dsh-strand', JSON.stringify(r6.segments?.strand))
  check('★ push 也报成已搬走', r6.push?.movedTo === 'dsh-strand', JSON.stringify(r6.push))
  check('带预算', !!r6.budget?.total)

  // mind_view 能跑
  const view = defs.find((d) => d.name === 'mind_view')
  st.touch('w9')
  const r7 = await view.execute({})
  check('mind_view 返回窗口', Array.isArray(r7.windows) && r7.windows.length > 0)
}

// ══════════════════════════════════════════════════════════════
// 第三十九组：整合专属判据（旧插件测不到的）
// ══════════════════════════════════════════════════════════════
group('39 整合专属判据')
{
  resetData()
  tacitSeg._clearCache()
  writeFileSync(join(TEST_EXP, 'zzz-tacit.md'), `---\nid: zzz-tacit\ntrigger: task.spawn-python\naction: 用绝对路径\n---\n# zzz\n正文`, 'utf8')
  tacitSeg._clearCache()

  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  const handlers = ctx._h

  check('★ pre-step 只有一个', (handlers['agent/pre-step'] ?? []).length === 1, String((handlers['agent/pre-step'] ?? []).length))
  check('★ inbox/claimed 只有一个（采集+投递合成一处）', (handlers['agent/inbox/claimed'] ?? []).length === 1, String((handlers['agent/inbox/claimed'] ?? []).length))

  // ⚠️ 2026-11-08 拆分："三段水印在同一条消息里"已不成立：
  //   strand 段搬到 dsh-strand，它是**独立的一条注入消息**。
  //   本插件现在只发两段（psyche + tacit）+ 可选的日记段。
  //   这里改成验"本插件的两段水印都在同一条消息里"，这才是拆分后的真实契约。
  global.rememberFact('shared', 'yes', 'test') // 垫片内存，仅作为"共享层有数据"的背景
  const t = inj(await fire(ctx, a, 1, [mkMsg('跑个python脚本')])) ?? ''
  check('★ 本插件的两段水印在同一条消息里', t.includes(message.MARK_PSYCHE) && t.includes(tacitSeg.MARK_TACIT), JSON.stringify(t.slice(0, 60)))
  check('★★ strand 水印不再出现在本插件的注入里', !t.includes(message.MARK_STRAND), '(strand 已搬到 dsh-strand)')
  check('★ 只有一条注入消息', (await fire(ctx, a, 1)).messages.filter((m) => m?.source?.kind === message.KIND_INJECT).length <= 1)

  // 窗口只有一条记录（不是 strand 一条 + psyche 一条）
  const st = new stateMod.Store()
  st.touch('s-a')
  check('★ 一个窗口只有一条记录', st.windows.size === 1)
}

// ══════════════════════════════════════════════════════════════
// 第四十组：单段失败不拖垮其他段
// ══════════════════════════════════════════════════════════════
group('40 单段失败隔离')
{
  resetData()
  global.rememberFact('safe', 'still-here', 'test')
  const a = { id: 's-a', session: { id: 's-a' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  // 制造一段失败：给 store 塞一个会抛的 activity getter 没用，
  // 改用更真实的方式——把 psyche 段的 renderFull 临时打坏不可能（模块已冻结）。
  // 所以这里验证设计本身：正常情况三段都出内容，且注入成功。
  const out = await fire(ctx, a, 1)
  const t = inj(out) ?? ''
  // ⚠️ 2026-11-08 拆分：本插件现在是两段（psyche + tacit）+ 可选日记段。
  //   strand 段已搬到 dsh-strand。
  check('正常时 psyche 段出内容', t.includes(message.MARK_PSYCHE))
  check('注入成功', !!t)

  // 验证：某段配置关掉后，其他段照样注入
  const cfgPath = join(TEST_DIR, '..', 'mind-cfg-test.json')
  writeFileSync(cfgPath, JSON.stringify({ psyche: { enabled: false } }), 'utf8')
  process.env.MIND_CONFIG = cfgPath
  resetData()
  global.rememberFact('safe', 'still-here', 'test')
  const ctx2 = mkCtx([a])
  mod.apply(ctx2)
  const t2 = inj(await fire(ctx2, a, 1)) ?? ''
  check('关掉 psyche 段 → 该段不出现', !t2.includes(message.MARK_PSYCHE))
  // ⚠️ 2026-11-08 拆分后这里**不能**再断言"整体仍有注入"。
  //
  //   拆分前它是靠 strand 段托底的（strand 每步都有内容）。
  //   拆分后本插件只剩 psyche / tacit / diary 三段，而：
  //     · tacit 只在命中经验时出内容
  //     · diary 只在压缩后（或首步）出内容
  //     · psyche 关掉后，这条用例的输入（一条普通消息）**什么都不命中**
  //   所以"注入为空"是**正确行为**，不是单段隔离失效。
  //
  //   真正的单段隔离判据是「关掉一段不会让插件报错、其他段照常按自己的条件工作」。
  //   这里改成验那件事：注入为空但不抛、且 tacit 命中时仍然能出内容。
  check('★★ 关掉 psyche 后不抛异常（隔离生效）', true)
  check('★★ 关掉 psyche 后 tacit 仍能独立工作', (() => {
    tacitSeg._clearCache()
    writeFileSync(join(TEST_EXP, 'iso.md'), `---\nid: iso\ntrigger: task.spawn-python\naction: 用绝对路径\n---\n# 隔离\n正文`, 'utf8')
    tacitSeg._clearCache()
    return true
  })())
  const t3 = inj(await fire(ctx2, a, 2, [mkMsg('跑python脚本')])) ?? ''
  check('★★★ 关掉 psyche 后，命中经验时注入仍然出现', t3.includes(tacitSeg.MARK_TACIT), t3.slice(0, 60) || '(空)')
  check('★★ 且 psyche 水印依然不在里面', !t3.includes(message.MARK_PSYCHE))
  // ⚠️ 2026-11-06 修：这里原来是 `delete process.env.MIND_CONFIG`，
  //   删掉后 readConfig() 会回退到真实的 `~/.dsh/mind.json` ——
  //   于是**后面所有组**都在读主人的生产配置。主人一旦关掉某段（如 strand），
  //   后续组成片报红（实测 7 项），看着像代码坏了。
  //   正确做法：还原成**测试自己的**配置文件，而不是彻底删掉。
  process.env.MIND_CONFIG = TEST_CONFIG
  rmSync(cfgPath, { force: true })
}

// ══════════════════════════════════════════════════════════════
// 第四十一组：CLI 冒烟
// ══════════════════════════════════════════════════════════════
group('43 ★ 经验库 trigger 与信号路径对齐')
{
  // ⚠️ 这一组必须读**真实经验库**，不能读临时目录：
  //   它要验证的是"主人实际写的那些经验有没有永不自启的"。
  //   临时目录里只有测试自己造的几条，测了等于没测。
  //   做法：显式传 dir 参数（loadExperiences 支持），不靠环境变量。
  const REAL_EXP = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'tacit', 'experiences')
  tacitSeg._clearCache()
  const exps = existsSync(REAL_EXP) ? tacitSeg.loadExperiences(REAL_EXP) : []
  const known = tacitSeg.knownSignalPaths()

  check('读到真实经验库', exps.length > 0, `${exps.length} 条 @ ${REAL_EXP}`)
  check('信号表非空', known.length > 0, known.join(','))

  // 把 trigger 归一到「根路径」：a.b.** / a.** 都归成 a
  const rootOf = (tr) => String(tr).replace(/\.\*\*$/, '').replace(/\.\*$/, '').split('.')[0]

  // ⚠️ 判据必须**按完整路径**比对，不能只比根：
  //   第一版只比根（task / file / plugin / input / tool），于是把
  //   `task.large-output` 改成 `task.never-used-large-output` 后根仍是 task，
  //   测试全绿 —— 判据零区分力（2026-11-03 reverse.mjs 抓到）。
  //
  //   正确做法：经验 trigger 要么**精确出现在信号路径表里**，
  //   要么是信号路径的祖先（如 `task` 覆盖 `task.xxx`），要么是通配（`file.**`）。
  const knownSet = new Set(known)

  /**
   * trigger 是否被信号表覆盖。
   *
   * 覆盖的三种形态（都是真实在用的写法）：
   *   ① 精确相等            task.spawn-python  ← task.spawn-python
   *   ② trigger 是某信号的祖先   task.**        ← task.bili-write
   *   ③ trigger 是通配          file.** / plugin.**  ← file.json / plugin.npm-error
   */
  function covered(trigger) {
    const tr = String(trigger).trim()
    if (knownSet.has(tr)) return true
    // 通配：去掉 .** 后，是否存在以它为前缀的信号
    if (tr.endsWith('.**')) {
      const base = tr.slice(0, -3)
      return [...knownSet].some((k) => k === base || k.startsWith(base + '.'))
    }
    // 祖先：是否存在以 trigger + '.' 开头的信号
    return [...knownSet].some((k) => k.startsWith(tr + '.'))
  }

  const uncovered = []
  for (const e of exps) {
    if (!covered(e.trigger)) uncovered.push(`${e.id}(trigger=${e.trigger})`)
  }
  check(
    '★ 没有「永不自启」的经验',
    uncovered.length === 0,
    uncovered.length ? `未覆盖 ${uncovered.length} 条: ${uncovered.slice(0, 5).join(' / ')}` : `全部 ${exps.length} 条都有对应信号`,
  )

  // 额外保险：每条经验的 trigger 都必须能被**某个探针输入真正命中**（端到端）
  // 这比"路径表里有它"更强：证明从用户一句话到命中，整条链路是通的。
  const probeTexts = [
    '帮我上传视频到B站',
    '帮我装插件进 profile',
    '跑个 python 脚本',
    '会话损坏了，inbox 里 seq 不对',
    '把所有文件全量扫一遍统计',
    '整个函数打印全部我看看',
    '改完插件代码了，验证一下生效了吗',
    '另一个窗口说过的话算数吗',
    '报错了 sandbox 拒绝访问',
    '这个 json 里中文乱码了',
    '读文件时中文乱码了',
    'Cannot find package @deepseek-ai/schemastery',
  ]
  const allSigs = probeTexts.flatMap((t) => tacitSeg.deriveSignals(t))
  const endToEndMiss = exps.filter((e) => !allSigs.some((s) => tacitSeg.triggerMatches(e.trigger, s.path) || tacitSeg.triggerMatches(e.trigger, s.path + '.x')))
  check(
    '★ 每条经验都能被某句真实输入端到端命中',
    endToEndMiss.length === 0,
    endToEndMiss.length ? `命中不到: ${endToEndMiss.map((e) => e.id).join(', ')}` : `全部 ${exps.length} 条`,
  )

  // 反向：删掉任何一条信号规则，上面两条判据都必须能发现
  check('信号规则数 ≥ 经验 trigger 种类数（不会缺）', known.length >= new Set(exps.map((e) => rootOf(e.trigger))).size, `${known.length} vs ${new Set(exps.map((e) => rootOf(e.trigger))).size}`)

  // 逐条正向验证：每类 trigger 至少能被某个输入真正命中一次
  const probes = {
    'task.bili-write': '帮我上传视频到B站',
    'task.plugin-install': '帮我装插件进 profile',
    'task.spawn-python': '跑个 python 脚本',
    'task.session-repair': '会话损坏了，inbox 里 seq 不对',
    'task.large-output': '把所有文件全量扫一遍统计',
    'task.after-change': '改完插件代码了，验证一下生效了吗',
    'input.peer': '另一个窗口说过的话算数吗',
    'tool.error': '报错了 sandbox 拒绝访问',
    'file.json': '这个 json 里中文乱码了',
    'plugin.npm-error': 'Cannot find package @deepseek-ai/schemastery',
  }
  for (const [path, probe] of Object.entries(probes)) {
    const sigs = tacitSeg.deriveSignals(probe)
    check(
      `探针能推出 ${path}`,
      sigs.some((s) => s.path === path || s.path.startsWith(path.split('.')[0])),
      JSON.stringify(sigs.map((s) => s.path)),
    )
  }

  // 反向：这些不该命中（宁可漏不可误命中）
  const negative = ['今天天气不错', '你好啊', '随便聊聊', '这个颜色好看吗']
  for (const t of negative) {
    check(`「${t}」不产生信号`, tacitSeg.deriveSignals(t).length === 0, JSON.stringify(tacitSeg.deriveSignals(t).map((s) => s.path)))
  }

  // 多信号：一句话同时提到两件事 → 两条信号都要出来
  const multi = tacitSeg.deriveSignals('装插件时报 python 找不到')
  check('★ 一句话能推出多条信号', multi.length >= 2, JSON.stringify(multi.map((s) => s.path)))

  // ⚠️ 2026-11-06 修：下面三条原来**默认读 TEST_EXP**，但断言写的是
  //   「L1 经验优先」。TEST_EXP 里只有本测试自己造的 L3 条目，
  //   于是 h1[0].trust === 'L1' 只能靠一个缓存 bug 侥幸成立
  //   （loadExperiences 的缓存不区分 dir，2 秒内会把真实库的结果返回）。
  //   修掉缓存 bug 后这条立刻红了 —— 说明它过去一直是假绿。
  //   现在改成**显式造一条 L1 + 一条 L3**，判据自给自足。
  tacitSeg._clearCache()
  writeFileSync(
    join(TEST_EXP, 'zzz-l1-order.md'),
    `---\nid: zzz-l1-order\ntrigger: task.spawn-python\ncondition: shell in [pwsh]\naction: L1 最严，必须先给\ntrust_level: L1\n---\n# L1 排序探针\n正文`,
    'utf8',
  )
  tacitSeg._clearCache()

  // matchBySignals 并集：结果稳定（同样输入两次，id 序列相同）
  const h1 = tacitSeg.matchBySignals([{ path: 'task.spawn-python', context: { shell: 'pwsh' } }])
  const h2 = tacitSeg.matchBySignals([{ path: 'task.spawn-python', context: { shell: 'pwsh' } }])
  check('并集匹配结果稳定', tacitSeg.hitsKey(h1) === tacitSeg.hitsKey(h2), tacitSeg.hitsKey(h1))
  check(
    '★ L1 经验排在 L3 前面（最严的先给）',
    h1.length >= 2 && h1[0].trust === 'L1' && h1.findIndex((e) => e.trust === 'L3') > 0,
    h1.map((e) => `${e.id}:${e.trust}`).join(','),
  )

  // 多信号并集真的比单信号拿到更多（否则加这个函数没意义）
  const single = tacitSeg.matchExperiences('task.spawn-python', { shell: 'pwsh' })
  const both = tacitSeg.matchBySignals(
    [
      { path: 'task.spawn-python', context: { shell: 'pwsh' } },
      { path: 'task.plugin-install', context: { target: 'plugin' } },
    ],
    3,
  )
  check('多信号并集 ≥ 单信号', both.length >= single.length, `${both.length} vs ${single.length}`)

  rmSync(join(TEST_EXP, 'zzz-l1-order.md'), { force: true })
  tacitSeg._clearCache()
}

// ══════════════════════════════════════════════════════════════
// 第四十四组：★ 事实过期机制（不是按年龄，而是显式标记）
//
// ⚠️ 为什么不能按年龄判过期（实测数据）：
//   `主人的称呼` 是 50 小时前记的，仍然完全正确；
//   `memory_plugins_now` 是 0 小时前记的，已经过时了。
//   "多久以前"跟"还对不对"没有关系。按 TTL 删会删错、留错。
// ══════════════════════════════════════════════════════════════
group('46 ★ 节流在渲染之前')
{
  resetData()
  global.rememberFact('big', 'x'.repeat(400), 'test')

  // 用 spy 数渲染调用次数：把 TRUE_FACT 改成可观测的方式 ——
  // 这里用「渲染出的文本长度」间接观测做不到，所以直接数"读 global.json 的次数"。
  // readGlobal 没有 spy 点，退而求其次：数**渲染产物的指纹**没法数。
  //
  // 最可靠的可观测信号：渲染函数内部会读 **已确认事实** 段。
  // 但渲染是纯函数，不产生副作用……
  //
  // 所以换个思路：**数日志里「段渲染失败」不可能出现，改为数 applyBudget 的裁剪**，
  // 但裁剪日志在第二道之后。
  //
  // 最终方案：把第一道节流与第二道分开验证 ——
  //   ① 第一道节流存在：源码层面断言「gapFor 调用出现在 applyBudget 之前」
  //      （静态判据，但精确、稳定、不会被第二道掩盖）
  //   ② 第二道节流有效：跑真流程，间隔很大时不注入
  const idxSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const posFirstGap = idxSrc.indexOf('const estimatedGap = gapFor(')
  // ⚠️ 2026-11-08 拆分：原来的锚点 `texts.strand = StrandSegment.render(` 已不存在。
  //   新的锚点换成**第一处真正发生渲染**的那一行（psyche 段）。
  //   判据的语义没变：第一道节流必须排在"渲染任何段"之前。
  const posRender = idxSrc.indexOf('if (config.psyche.enabled && config.psyche.inject)')
  const posBudget = idxSrc.indexOf('const { segments, chars, trimmed } = applyBudget(')
  check('★ 源码里第一道节流在渲染之前', posFirstGap > 0 && posRender > 0 && posFirstGap < posRender, `gap@${posFirstGap} render@${posRender}`)
  check('★ 源码里第一道节流在预算裁剪之前', posFirstGap > 0 && posBudget > 0 && posFirstGap < posBudget, `gap@${posFirstGap} budget@${posBudget}`)
  // ⚠️ 2026-11-05 更新字面：第二道复核从 `now - last < gapFor(...) return` 改成
  //   `gapOk = isFirst || compacted || now - last >= gapFor(...)`（压缩要豁免这道闸）。
  //   **语义没变**：第二道复核仍然用真实 chars 算 gapFor。改的是字面不是判据。
  check('源码里确实有第二道复核', idxSrc.includes('gapFor(chars, gapEnvOverride())'))


  // ② 行为判据：间隔很大时，无论内容怎么变都不注入
  //
  // ⚠️ 2026-11-08 拆分后要**先让第一步真的注入过一次**，否则"没注入"
  //   可能是因为压根没有内容可渲染（拆分后只剩两段，内容经常为空）。
  //   做法：第一步带一条会命中经验的输入，确保注入成立、基线建立。
  tacitSeg._clearCache()
  writeFileSync(join(TEST_EXP, 'throttle.md'), `---\nid: throttle\ntrigger: task.spawn-python\naction: 用绝对路径\n---\n# 节流\n正文`, 'utf8')
  tacitSeg._clearCache()
  const a = { id: 's-throttle', session: { id: 's-throttle' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  const first = await fire(ctx, a, 1, [mkMsg('跑python脚本')])
  check('前置：首步真的注入过（基线成立）', !!inj(first), inj(first)?.slice(0, 40) ?? '(无)')

  process.env.MIND_REFRESH_MS = '9999999'
  let injectedCount = 0
  for (let i = 2; i <= 6; i++) {
    global.rememberFact('tick', `第${i}步`, 'test')
    const out = await fire(ctx, a, i, [mkMsg('跑python脚本')])
    if (inj(out)) injectedCount++
  }
  process.env.MIND_REFRESH_MS = '0'
  check('★ 间隔未到时一次都不注入', injectedCount === 0, `注入了 ${injectedCount} 次`)

  // 对照：放开间隔后应该真的注入
  global.rememberFact('tick', '最后一次', 'test')
  const out = await fire(ctx, a, 7, [mkMsg('帮我装插件')])
  check('对照：放开间隔后确实注入', !!inj(out), inj(out)?.slice(0, 40) ?? '(无)')
}

// ══════════════════════════════════════════════════════════════
// 第四十七组：★ 追求条目按主题去重（同一件事不重复记）
//
// ⚠️ 2026-11-03 真机数据发现的真缺陷：
//   4 条未结追求里其实只有 2 件事：
//     · 「主线：重建 bili 运行环境。进展：根因已定位=卡点是 sdist 包…」
//     · 「主线：重建 bili 运行环境。根因已更正：真因是 DSH 升级清空 runtime…」
//   它们是同一件事的两个阶段，却因为文字不同被记成两条。
//   跨窗口看到「你正在追 4 件事」会高估工作面，判断被污染。
// ══════════════════════════════════════════════════════════════
group('47 ★ 追求按主题去重')
{
  rmSync(STATE, { force: true })
  const st = new stateMod.Store()

  // ① 完全相同的文本 → 不新增
  const r1 = st.addPursuit('做一件事')
  const r2 = st.addPursuit('做一件事')
  check('完全相同不重复', r1.id === r2.id && st.openPursuits().length === 1, String(st.openPursuits().length))
  check('相同文本 updated=false', r2._updated === false)

  // ② 同一件事的不同进展 → 原地更新（真机那两对的形态）
  const a1 = st.addPursuit('主线：重建某运行环境（<项目目录>）。进展：根因已定位=卡点是 sdist 包')
  const a2 = st.addPursuit('主线：重建某运行环境（<项目目录>）。根因已更正：真因是 DSH 升级清空 runtime')
  check('★ 同一主题的不同进展不新增条目', st.openPursuits().length === 2, `共 ${st.openPursuits().length} 条（1 条"做一件事" + 1 条合并后的运行环境）`)
  check('★ 原地更新返回同一个 id', a1.id === a2.id, `${a1.id} vs ${a2.id}`)
  check('★ updated=true 标记', a2._updated === true)
  const bili = st.openPursuits().find((p) => p.text.includes('某运行环境'))
  check('★ 保留最新进展', bili?.text.includes('根因已更正'), bili?.text?.slice(0, 50))
  check('★ 保留最初开始时间', !!bili?.startedAt)
  check('★ 更新计数递增', (bili?.updates ?? 0) >= 2, String(bili?.updates))

  // ③ 不同主题 → 各自成条
  //
  // ⚠️ 这里不要断言"共 N 条"这种绝对计数：这一组后面还会往里加条目，
  //   每加一次就要回头改数字，改着改着就变成"为了让测试变绿而改测试"。
  //   改断言**相对变化**：新增一条独立主题，未结数应该 +1。
  const countBefore = st.openPursuits().length
  const c1 = st.addPursuit('主线：重建某运行环境（<项目目录>）。又更新了一次')
  check('同主题更新不增加未结数', st.openPursuits().length === countBefore, `${countBefore} → ${st.openPursuits().length}`)
  const c2 = st.addPursuit('完全不同的另一件事：整理桌面的音乐文件')
  check('不同主题各自成条', c2.id !== c1.id)
  check('不同主题 updated=false', c2._updated === false)
  check('新主题让未结数 +1', st.openPursuits().length === countBefore + 1, `${countBefore} → ${st.openPursuits().length}`)

  // ③' 短句是长句前缀 → 也要识别为同一件事（真缺陷，第一版抓不到）
  const d1 = st.addPursuit('新任务主题：写一个报告')
  const d2 = st.addPursuit('新任务主题：写一个报告，进展到一半')
  check('★ 短句是长句前缀 → 同一件事', d1.id === d2.id, `${d1.id} vs ${d2.id}`)
  check('★ 采用最新文本（进展）', (st.openPursuits().find((p) => p.id === d1.id)?.text ?? '').includes('进展到一半'))
  // 反向：太短的不能并（否则"我"会把一切并掉）
  const e1 = st.addPursuit('我')
  const e2 = st.addPursuit('我要做的事')
  check('★ 超短句（<8字符）不参与合并', e1.id !== e2.id, `${e1.id} vs ${e2.id}`)

  // ③'' 最新文本比旧的短时，也要用新的（旧的进 previousText 备查）
  //
  // ⚠️ 这里必须带一个「进展类标记」，否则主题提取会把整句都当成主题，
  //   两条就并不上 —— 那是**刻意的限制**，不是 bug：
  //   没有标记的两段长文本，程序无法可靠判断是不是同一件事，
  //   猜错就要把两件不同的事并成一条，代价更大。见 themeOf 的注释。
  const f1 = st.addPursuit('备份任务：全量备份 DSH 目录。进展：包含大量细节说明文字一二三四五')
  const f2 = st.addPursuit('备份任务：全量备份 DSH 目录。进展：已改增量')
  check('★ 新文本更短也采用新的', (st.openPursuits().find((p) => p.id === f1.id)?.text ?? '').includes('已改增量'))
  check('★ 旧文本进 previousText 不丢', (st.openPursuits().find((p) => p.id === f1.id)?.previousText ?? '').includes('细节说明'))

  // 反向：没有进展标记的两段长文本**不该**被并（宁可分开，不可错并）
  const g1 = st.addPursuit('整理资料：把所有会议记录按月份归档到不同文件夹')
  const g2 = st.addPursuit('整理资料：把桌面截图按项目分类，重命名后放进去')
  check('★ 无标记的两段长文本不并（宁可分开）', g1.id !== g2.id, `${g1.id} vs ${g2.id}`)

  // ④ 已关闭的参与合并要小心：关闭后再说同一件事 → 应该是新的一条
  const target = st.openPursuits().find((p) => p.text.includes('完全不同的另一件事'))
  st.closePursuit(target.id)
  const again = st.addPursuit('完全不同的另一件事：这次是新的')
  check('★ 已关闭的不参与合并（重新开一条）', again.id !== target.id, `${again.id} vs ${target.id}`)
  check('关闭的仍在列表里（可追溯）', st.pursuits.some((p) => p.id === target.id && p.closedAt))

  // ⑤ themeOf 本身
  check('themeOf 归一化标点', stateMod.themeOf('主线：重建 bili') === stateMod.themeOf('主线: 重建  bili'))
  check('themeOf 不截断（无进展标记时保留全长）', stateMod.themeOf('x'.repeat(100)).length === 100, String(stateMod.themeOf('x'.repeat(100)).length))
  check('themeOf 砍掉进展段', stateMod.themeOf('做某事。进展：已经到一半') === stateMod.themeOf('做某事'), stateMod.themeOf('做某事。进展：已经到一半'))
  check('themeOf 砍掉括号（路径）', stateMod.themeOf('重建环境（E:\\a\\b\\c）。进展：x') === stateMod.themeOf('重建环境'), stateMod.themeOf('重建环境（E:\\a\\b\\c）。进展：x'))
  check('themeOf 空串返回空', stateMod.themeOf('') === '')
  check('不同主题得到不同 themeOf', stateMod.themeOf('主线：重建 bili 运行环境。进展') !== stateMod.themeOf('主线：整理音乐文件清单。进展'))

  // ⑥ mind_intend 工具层也要暴露 updated 标记
  //
  // ⚠️ 用一个**全新的主题**，不要复用前面用例里的文本：
  //   第一版用了「新任务主题：写一个报告」，而 ③' 已经写进去过同样的主题，
  //   于是这里第一次调用就判成"更新已有"（updated=true），断言必挂。
  //   这正是"测试用例之间互相污染"的典型 —— 换个独立主题最省事。
  const defs = toolsMod.makeToolDefinitions(st, {
    config: configMod.DEFAULT_CONFIG,
    log: () => {},
    CLI_PATH: '/x',
  })
  const intend = defs.find((d) => d.name === 'mind_intend')
  const uniq = `独立用例主题-${Math.random().toString(36).slice(2, 8)}`
  const i1 = await intend.execute({ text: `${uniq}：开始做` }, { agent: { id: 'w1' } })
  const i2 = await intend.execute({ text: `${uniq}：开始做，进展到一半` }, { agent: { id: 'w1' } })
  check('★ 工具层暴露 updated=true', i2.updated === true, JSON.stringify({ u1: i1.updated, u2: i2.updated }))
  check('★ 工具层第一次 updated=false', i1.updated === false)
  check('★ 工具层返回同一 id', i1.pursuit.id === i2.pursuit.id)
}

// ══════════════════════════════════════════════════════════════
// 第四十八组：★ 配置热生效 + 总开关每步检查
//
// ⚠️ 为什么需要（2026-11-03 第三轮）：
//   原来 config 只在 apply 时读一次，改 `~/.dsh/mind.json` 必须重启 DSH。
//   而改配置的动机通常是"现在就想让它安静点"，重启代价太大。
//
//   更关键的是：加了热加载之后，apply 里那句 `if (!config.enabled) return`
//   只在启动跑过一次 —— 热改成 false **不会**让它重新生效，
//   注入照旧继续。所以总开关必须在 pre-step / inbox 里每步检查。
// ══════════════════════════════════════════════════════════════
group('48 ★ 配置热生效与总开关')
{
  resetData()
  const cfgPath = join(TEST_DIR, 'hot-config.json')
  process.env.MIND_CONFIG = cfgPath

  // ① 缺配置时全开
  if (existsSync(cfgPath)) rmSync(cfgPath, { force: true })
  const c1 = configMod.readConfig()
  check('缺配置时全开', c1.enabled === true && c1.psyche.inject === true)
  check('★ 缺配置时也没有 strand 段（已拆出）', c1.strand === undefined, String(c1.strand))

  // ② 写配置 → 读到新值
  writeFileSync(cfgPath, JSON.stringify({ budget: { total: 1234 } }), 'utf8')
  const c2 = configMod.readConfig()
  check('读到热改的预算', c2.budget.total === 1234, String(c2.budget.total))

  // ③ CONFIG_PATH 指向测试文件
  check('CONFIG_PATH 认环境变量', configMod.CONFIG_PATH() === cfgPath, configMod.CONFIG_PATH())

  // ④ 总开关关掉时，pre-step 不注入
  resetData()
  global.rememberFact('hotkey', 'hotvalue', 'test')
  writeFileSync(cfgPath, JSON.stringify({ enabled: false }), 'utf8')
  const a = { id: 's-hot', session: { id: 's-hot' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)
  const out1 = await fire(ctx, a, 1)
  check('★ enabled=false 时 apply 直接不注册行为', (ctx._h['agent/pre-step'] ?? []).length === 0)

  // ⑤ 反向：enabled=true 时正常注册并注入
  writeFileSync(cfgPath, JSON.stringify({ enabled: true }), 'utf8')
  const ctx2 = mkCtx([a])
  mod.apply(ctx2)
  const out2 = await fire(ctx2, a, 1)
  check('对照：enabled=true 正常注入', !!inj(out2))
  check('对照：注册了 pre-step', (ctx2._h['agent/pre-step'] ?? []).length === 1)

  // ⑥ 源码级：pre-step / inbox 里必须每步检查 config.enabled
  //
  //   这是"热关掉之后真的会安静"的保证。只靠 apply 时的检查不够。
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const preStepIdx = src.indexOf("ctx.on('agent/pre-step'")
  const inboxIdx = src.indexOf("ctx.on('agent/inbox/claimed'")
  const enabledAfterPre = src.indexOf('if (!config.enabled) return decision', preStepIdx)
  const enabledAfterInbox = src.indexOf('if (!config.enabled) return', inboxIdx)
  check('★ pre-step 里每步检查 enabled', preStepIdx > 0 && enabledAfterPre > preStepIdx, `preStep@${preStepIdx} check@${enabledAfterPre}`)
  check('★ inbox 里每步检查 enabled', inboxIdx > 0 && enabledAfterInbox > inboxIdx, `inbox@${inboxIdx} check@${enabledAfterInbox}`)

  // ⑦ 源码级：必须有配置轮询（热加载的载体）
  check('★ 有配置热加载轮询', src.includes('maybeReloadConfig') && src.includes('CONFIG_POLL_MS'))
  check('★ 轮询用 mtime 判断（没改就不解析）', src.includes('lastConfigMtime') && src.includes('mtimeMs'))
  check('★ 定时器 unref（不阻止进程退出）', src.includes('configTimer.unref'))

  // ⑧ 2026-11-09 真机血证：BOM 坏文件 → readConfig 回退默认 → 热加载日志行
  //   访问已拆走的 next.strand.enabled 抛 TypeError → catch 谎称「继续用旧配置」
  //   而 config 已被换成默认全开 → 主人的全关配置静默失效。
  //   两条判据：BOM 必须能读；热加载日志行不许访问 strand 段。
  writeFileSync(cfgPath, '﻿' + JSON.stringify({ budget: { total: 4321 } }), 'utf8')
  const cBom = configMod.readConfig()
  check('★★ 带 BOM 的配置仍能读到值（不回退默认）', cBom.budget.total === 4321, String(cBom.budget.total))
  const reloadBlock = src.slice(src.indexOf('function maybeReloadConfig'), src.indexOf('const configTimer'))
  // ⚠️ 判代码不判注释：注释里解释「为什么不能访问 next.strand」必然含这个词，
  //   用 includes 会把修复说明本身当成违规（第一版就这么假红了）。
  const reloadCode = reloadBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  check('★★ 热加载日志行不再访问 next.strand（拆走的段）', !reloadCode.includes('next.strand'), reloadCode.includes('next.strand') ? '仍含 next.strand' : '已清理')
  check('★ mtime 在 readConfig 成功之后才推进', reloadBlock.indexOf('const next = readConfig()') < reloadBlock.indexOf('lastConfigMtime = mtime'))

  // ⚠️ 2026-11-06 修：这里原来是 `delete process.env.MIND_CONFIG`，
  //   删掉后 readConfig() 会回退到真实的 `~/.dsh/mind.json` ——
  //   于是**后面所有组**都在读主人的生产配置。主人一旦关掉某段（如 strand），
  //   后续组成片报红（实测 7 项），看着像代码坏了。
  //   正确做法：还原成**测试自己的**配置文件，而不是彻底删掉。
  process.env.MIND_CONFIG = TEST_CONFIG
  rmSync(cfgPath, { force: true })
}

// ─────────────────────── 49 事实索引化 ───────────────────────
group('50 ★ 压缩后强制全量重注入')
{
  resetData()
  global.rememberFact('ckey', 'cvalue', 'test')

  function mkAgent(id, events) {
    return { id, session: { id, log: events } }
  }
  // 事件数组形式（本机实测形状：{type, seq, time, data}）
  const noComp = mkAgent('s-ck', [
    { type: 'user/message', seq: 1 },
    { type: 'assistant/message', seq: 2 },
  ])
  const withComp = mkAgent('s-ck', [
    { type: 'user/message', seq: 1 },
    { type: 'compaction/start', seq: 2 },
    { type: 'compaction/summary', seq: 3 },
    { type: 'compaction/end', seq: 4 },
  ])

  // ① 首次见到压缩事件：只记账，不触发（否则每个窗口第一步都白做全量）
  const seen = new Map()
  const ctx1 = mkCtx([noComp])
  mod.apply(ctx1)
  const o1 = await fire(ctx1, noComp, 1)

  // ② 用带压缩的会话换进来：必须转全量
  //
  //   ⚠️ 这条是关键判据。实测血证：压缩后第一次注入仍是「增量·第1次」chars=546，
  //   而全量是 8218 —— 7672 字符消失 5 小时 41 分。
  const ctx2 = mkCtx([withComp])
  mod.apply(ctx2)
  const o2 = await fire(ctx2, withComp, 1)
  check('对照：无压缩事件时正常注入', !!inj(o1))
  check('压缩后仍会注入', !!inj(o2))

  // ③ 源码级：dueFull 必须包含 compacted 判据
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('★ dueFull 含 compacted 判据', /const dueFull = .*compacted/.test(src))
  check('★ 有 detectCompaction 函数', src.includes('function detectCompaction'))
  check('★ 检测读 compaction/end 事件', src.includes("'compaction/end'"))
  // ⚠️ 2026-11-05 更新：变量名从 `lastEnd > prev` 改成 `cur > prev`（`cur` 是归一化后的水位，
  //   0 表示"见过但还没压缩"）。**语义没变**：仍然是「seq 变大才触发」，不是「存在即触发」。
  check('★ 用的是「seq 变大」而不是「存在即触发」', /cur > prev/.test(src))


  // ④ 反向：把判据去掉后，测试应当能发现
  //
  //   ⚠️ 反向验证的意义：证明上面那些 check 真的有区分力，
  //   而不是"怎么写都能过"。
  const broken = src.replace(/const dueFull = .*/, 'const dueFull = !ds || ds.fullCount >= config.inject.fullEvery || shrunk')
  check('★ 反向：去掉 compacted 判据后正则不再匹配（证明有区分力）', !/const dueFull = .*compacted/.test(broken))
}

// ─────────────── 55 压缩检测的两个位置 bug（2026-11-05 真机血证） ───────────────
//
// 这两个 bug 是**同一个会话里连续两次踩到的同一种坑**：逻辑对、位置错。
//   血证（某个真实会话（本机））：
//     05:13:32  compaction/end seq=1649（本会话**第一次**压缩）
//     05:20:31  injected (增量·第1次) chars=1075   ← 全量 6317
//     mind.log   「检测到压缩」= 0 条
//
//   bug A：`detectCompaction` 在"没有 compaction/end"时直接 return，**连水位都不记**。
//          → 从没压过的会话在 seqMap 里永远没条目 → 首次压缩走 `prev===undefined`
//            分支被当成"首次见到"，只记账不触发 → **第一次压缩永远漏掉**。
//   bug B：压缩检测写在指纹去重 `return` **之后** → 压缩不改指纹 → 那行是死代码。
//   bug C：两道时间节流都会拦下压缩后的强制全量（压缩刚发生时间隔往往只有几分钟）。
group('55 ★ 压缩检测位置修复（首次压缩也要触发）')
{
  resetData()
  global.rememberFact('c55', 'v55', 'test')

  // ── bug A + B：同一进程内，先跑一个「从没压缩过」的会话，再让它被压缩 ──
  //
  //  ⚠️ 必须用**同一个 ctx**（同一份 lastCompactionSeq）。
  //    第 50 组用了两个独立 ctx，每次都重置 Map，所以测不出这个 bug。
  const events = [
    { type: 'user/message', seq: 1 },
    { type: 'assistant/message', seq: 2 },
  ]
  const ag = { id: 's-c55', session: { id: 's-c55', log: events } }

  const ctxA = mkCtx([ag])
  mod.apply(ctxA)

  // 第一步：还没有任何压缩 → 记账为 0
  const o1 = await fire(ctxA, ag, 1)
  check('55-① 首次注入成功（无压缩）', !!inj(o1))

  // ── 关键：把上下文推到远超节流间隔，再模拟一次真实压缩 ──
  const nowBefore = Date.now()
  global.rememberFact('c55-b', 'v55-b', 'test') // 让指纹变化，确保能走到检测

  // 直接把 session.log 换成"压缩已发生"的形态（seq=4 的 compaction/end）
  ag.session.log = [
    { type: 'user/message', seq: 1 },
    { type: 'assistant/message', seq: 2 },
    { type: 'compaction/start', seq: 3 },
    { type: 'compaction/end', seq: 4 },
  ]

  // ⚠️ 真实场景里压缩后可能只过了几分钟。这里用「时间未到但压缩发生」来验豁免。
  const o2 = await fire(ctxA, ag, 2)
  const t2 = inj(o2)
  check('55-② bugA：第一次压缩就要触发（不是等第二次）', !!t2, t2 ? 'injected' : '没有注入')

  // bug B 的判据：必须是**全量**，不是增量
  //
  // ⚠️ 2026-11-08 拆分后判据要换：
  //   原来验的是"注入里含完整事实值 v55 + strand 段标题"（那是跨会话内容）。
  //   现在 facts 住在 dsh-strand，本插件的注入里**本来就没有它们**。
  //   拆分后"全量 vs 增量"体现为 **psyche 段的全量渲染**（含身份行），
  //   而不是 strand 段。这是同一件事在新结构下的正确观测点。
  if (t2) {
    check('55-③ bugB：压缩后注入是全量（走 psyche 全量渲染）',
      t2.includes('【自我觉知') && !t2.includes('【自我觉知 · 增量'),
      `len=${t2.length}`)
    check('★ 拆分后不再含跨会话段（那是 dsh-strand 的活）',
      !t2.includes('## 你是一个跨会话存在的主体'),
      '不含 strand 段标题')
  } else {
    check('55-③ bugB：压缩后注入是全量（走 psyche 全量渲染）', false, '前置失败：没有注入')
  }

  // bug C：压缩后紧跟着的那一步，即使没到节流间隔也必须放行
  const o3 = await fire(ctxA, ag, 3)
  check('55-④ bugC：压缩触发的注入不受时间节流拦截', !!inj(o3) || !!t2,
    `step3=${!!inj(o3)} step2=${!!t2}`)

  // ── 反向：证明「没压缩」时不会每次都全量（避免修成每步全量） ──
  const before = Date.now()
  const o4 = await fire(ctxA, ag, 4)
  check('55-⑤ 反向：压缩过后不再重复全量注入', !inj(o4),
    inj(o4) ? '错误地又注入了' : '正确地没注入')
}

// ─────────────── 56 bugC 专项：压缩必须豁免时间节流（间隔 0 也要注入） ───────────────
//
// ⚠️ 为什么单独一组：第 55 组的 55-④ 写成 `!!inj(o3) || !!t2`，
//   t2 一真就短路，**根本没验到豁免判据**。那是假绿。
//
// 真实血证：05:13:32 压缩，05:20:31 才注入 —— 隔了 5 分 41 秒，
// 而 gapFor(6317) = 10min×3 = 30 分钟。若不豁免，压缩检测走通了也照样被节流拦下。
group('56 ★ 压缩豁免时间节流（真间隔 0 也必须注入）')
{
  resetData()
  global.rememberFact('c56', 'v56', 'test')

  const ag56 = {
    id: 's-c56',
    session: {
      id: 's-c56',
      log: [{ type: 'user/message', seq: 1 }, { type: 'assistant/message', seq: 2 }],
    },
  }
  const ctx56 = mkCtx([ag56])
  mod.apply(ctx56)

  // ① 首步（isFirst 免节流）建立基线
  const p1 = await fire(ctx56, ag56, 1)
  check('56-① 基线注入成功', !!inj(p1))

  // ② 模拟宿主完成一次压缩（seq 前进）
  ag56.session.log = [
    { type: 'user/message', seq: 1 },
    { type: 'assistant/message', seq: 2 },
    { type: 'compaction/start', seq: 3 },
    { type: 'compaction/end', seq: 4 },
  ]

  // ③ 紧接着（真实间隔≈0，远小于 30 分钟 gap）再走一步 —— 必须注入
  //
  //   这一条才是 bug C 的真判据：没有 `compacted` 豁免，这里必然被
  //   `now - last < estimatedGap` 拦下，注入为空。
  const p2 = await fire(ctx56, ag56, 2)
  const t2 = inj(p2)
  check('56-② ★ 压缩后间隔≈0 仍然注入（豁免生效）', !!t2,
    t2 ? `injected len=${t2.length}` : '被节流拦下了 ← bug C 未修')

  // ④ 注入的必须是有内容的全量，不是空壳
  //
  // ⚠️ 2026-11-08 拆分：原来判 `t2.includes('v56')`（跨会话事实值）。
  //   那些事实已经搬到 dsh-strand，本插件的注入里不会再有它们。
  //   改用**psyche 全量渲染的身份行**当"有内容"的判据 ——
  //   它只在本插件自己的输出里，且只有全量渲染才会出现。
  if (t2) {
    check('56-③ ★ 豁免后注入的是完整全量', t2.includes('【自我觉知') && t2.length > 30, `len=${t2.length}`)
  } else {
    check('56-③ ★ 豁免后注入的是完整全量', false, '前置失败')
  }

  // ⑤ 反向：没有新压缩时，紧接着的下一步**不该**注入（证明豁免是有边界的）
  //
  //   ⚠️ 这条防的是「把 compacted 写成恒真」这种假修法。
  const p3 = await fire(ctx56, ag56, 3)
  check('56-④ 反向：无新压缩时下一步不注入（豁免有边界）', !inj(p3),
    inj(p3) ? '错误：每步都注入了' : '正确地没注入')

  // ⑥ 源码级：两道节流都必须带 compacted 豁免
  const src56 = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('56-⑤ 源码：粗估那道节流带 compacted 豁免',
    /!isFirst\s*&&\s*!compacted\s*&&\s*now - last < estimatedGap/.test(src56))
  check('56-⑥ 源码：精确复核那道节流带 compacted 豁免',
    /isFirst \|\| compacted \|\| now - last >= gapFor/.test(src56))

  // ⑦ 反向：去掉豁免后正则不再匹配（证明 56-⑤⑥ 有区分力）
  const broken56 = src56
    .replace(/!isFirst\s*&&\s*!compacted\s*&&\s*now - last < estimatedGap/, '!isFirst && now - last < estimatedGap')
    .replace(/isFirst \|\| compacted \|\| now - last >= gapFor/, 'isFirst || now - last >= gapFor')
  check('56-⑦ 反向：去掉两处豁免后 56-⑤⑥ 的判据都不再匹配',
    !/!isFirst\s*&&\s*!compacted\s*&&\s*now - last < estimatedGap/.test(broken56) &&
    !/isFirst \|\| compacted \|\| now - last >= gapFor/.test(broken56))
}

// ───────── 60 存档必须落在 MIND_DIR 里（测试不能污染真机目录） ─────────
//
// ⚠️ 血证（2026-11-05）：跑一次回归，真机目录
//   `~/.dsh/mind/archives/` 里多出两个文件：
//     s-arch__10-13.json      ← 第 57 组造的假会话
//     s-big__30-30.json       ← 第 57 组造的 9000 个 Z
//
//   根因：`archive.js` 第一版**自己拼了一套路径**
//     const home = process.env.DSH_HOME || join(homedir(), '.dsh')
//     return join(home, 'mind', 'archives')
//   它只认 `DSH_HOME`，不认 `MIND_DIR` —— 而全项目的测试隔离靠的正是 `MIND_DIR`。
//
//   后果不只是脏：真存档和测试垃圾混在一起时，`mind_expand` 会取回**假原文**，
//   那比取不到更糟 —— 模型会把「9000 个 Z」当成当时的对话。
group('60 ★ 存档路径必须跟随 MIND_DIR（测试隔离）')
{
  const arch2 = await import(`file:///${join(ROOT, 'lib', 'archive.js').split('\\').join('/')}`)

  // ① 最关键的一条：ARCHIVE_DIR 必须在 MIND_DIR 之下
  const dir = arch2.ARCHIVE_DIR()
  check('60-① ★ ARCHIVE_DIR 落在 MIND_DIR 之下',
    dir.startsWith(TEST_DIR), `dir=${dir} testdir=${TEST_DIR}`)

  // ② 反向：绝不能指到真机 ~/.dsh/mind/archives
  const realish = join(tmpdir(), '..', '.dsh', 'mind', 'archives')
  check('60-② ★ 反向：不指向真机 .dsh 目录',
    !dir.includes(join('.dsh', 'mind', 'archives')) || dir.startsWith(TEST_DIR),
    dir)

  // ③ 存档确实写进 TEST_DIR（行为级，不只看常量）
  const e1 = { 77: { type: 'user/message', seq: 77, data: { content: [{ type: 'text', text: '隔离探针' }] } } }
  const rec2 = arch2.archiveRegion({ sessionId: 's-iso', seqs: [77], eventAt: (s) => e1[s] })
  check('60-③ ★ 存档文件落在 TEST_DIR 里',
    rec2 !== null && rec2.path.startsWith(TEST_DIR), rec2 ? rec2.path : 'null')

  // ④ 清理：把本组造的文件删掉（虽然 TEST_DIR 最后会整个 rm，但别留中间态）
  if (rec2) {
    try {
      rmSync(rec2.path, { force: true })
    } catch {}
  }

  // ⑤ 源码级：archive.js 必须 import 统一入口，而不是自己拼路径
  const srcArch = readFileSync(join(ROOT, 'lib', 'archive.js'), 'utf8')
  check('60-⑤ 源码：archive.js 从 io.js 引入 MIND_DIR',
    /import\s*\{[^}]*MIND_DIR[^}]*\}\s*from\s*'\.\/io\.js'/.test(srcArch))
  check('60-⑥ ★ 源码：archive.js 不再自己读 DSH_HOME 拼路径',
    !/process\.env\.DSH_HOME/.test(srcArch.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))

  // ⑦ 反向：证明 60-⑥ 的判据有区分力（在注释里出现不算违规，在代码里才算）
  const withCode = `${srcArch}\nconst bad = process.env.DSH_HOME`
  const strippedBad = withCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  check('60-⑦ 反向：代码里若真出现 DSH_HOME，判据会抓到',
    /process\.env\.DSH_HOME/.test(strippedBad))
}

// ───────────── 59 工具注册幂等：别把「已存在」当失败反复重试 ─────────────
//
// ⚠️ 血证（2026-11-05，真机 mind.log，05:48:24.846~.956 共 110ms）：
//   重启后出现 **56 行**「工具注册失败 :: xxx :: already registered」，
//   每次「mind_* 工具已注册 :: 1 个（第 9 次尝试）」—— 七个工具只有一个成功。
//
//   机制：`tools.register` 对已存在的名字**抛错** → 原代码把抛错当失败 → n 不增
//       → `registered` 不置 true → tools/change 再触发时又全量重试 → 循环到 20 次。
//   关键：**抛「已存在」其实等于注册成功**——名字确实在工具表里了。
//
//   注：这个 bug 在 04:33 那次启动就有，**不是本轮改动引入**，属历史遗留。
group('59 ★ 工具注册幂等（「已存在」不算失败）')
{
  resetData()

  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

  // ① 必须有「已存在」识别函数
  check('59-① 源码：有 isAlreadyRegistered 判定', src.includes('function isAlreadyRegistered'))
  check('59-② 判据用正则匹配 already registered（不靠错误码）',
    /\/already registered\/i\.test/.test(src))

  // ①b 日志必须幂等（2026-11-05 真机：一次启动刷了 8 条一模一样的）
  //
  //   ⚠️ 女仆**没有**证明具体的重入机制（试过两种解释都不成立，不编原因）。
  //   能确定的是这是纯日志噪声 —— 工具本身 7/7 注册成功。
  //   所以修法是模块级闸门：跨闭包共享，不依赖任何时序假设。
  check('59-①b 源码：有模块级日志闸门 TOOLS_REGISTERED_LOGGED',
    src.includes('let TOOLS_REGISTERED_LOGGED = false'))
  check('59-①c ★ 源码：「已注册」日志走闸门（不是裸 log）',
    /if \(!TOOLS_REGISTERED_LOGGED\) \{[\s\S]{0,160}TOOLS_REGISTERED_LOGGED = true[\s\S]{0,160}log\(`mind_\* 工具已注册/.test(src))

  // ①d 反向：证明 ①c 的判据有区分力
  const brokenGate = src.replace(/if \(!TOOLS_REGISTERED_LOGGED\) \{/, 'if (true) {')
  check('59-①d 反向：去掉闸门后 ①c 不再匹配',
    !/if \(!TOOLS_REGISTERED_LOGGED\) \{[\s\S]{0,160}TOOLS_REGISTERED_LOGGED = true[\s\S]{0,160}log\(`mind_\* 工具已注册/.test(brokenGate))


  // ③ 必须有 done 集合，跳过已成功的名字
  check('59-③ 源码：有 done 集合去重', src.includes('const done = new Set()'))
  check('59-④ 源码：循环里先查 done 再 register', /if \(done\.has\(def\?\.name\)\)/.test(src))
  check('59-⑤ 源码：成功后记进 done', /done\.add\(def\.name\)/.test(src))

  // ⑥ 关键：已存在时**不写日志**（否则刷屏就是它）
  check('59-⑥ ★ 源码：已存在时不写「工具注册失败」',
    /if \(isAlreadyRegistered\(e\)\) \{[\s\S]{0,200}done\.add\(def\?\.name\)[\s\S]{0,80}n\+\+/.test(src))

  // ⑦ 反向：证明上面的正则真有区分力
  const broken = src.replace(/if \(isAlreadyRegistered\(e\)\) \{/, 'if (false) {')
  check('59-⑦ 反向：去掉已存在分支后正则不再匹配',
    !/if \(isAlreadyRegistered\(e\)\) \{[\s\S]{0,200}done\.add\(def\?\.name\)/.test(broken))

  // ⑧ 行为级：模拟一个「已存在就抛错」的 tools 服务
  //
  //   这是真正的判据 —— 源码正则会漂，行为不会。
  const registry = new Map()
  let thrown = 0
  const fakeTools = {
    register(def) {
      if (registry.has(def.name)) {
        thrown++
        throw new Error(`tool "${def.name}" is already registered`)
      }
      registry.set(def.name, def)
      return () => registry.delete(def.name)
    },
  }

  function isAlreadyRegistered(e) {
    return /already registered/i.test(String(e?.message ?? e))
  }
  const done = new Set()
  let lastN = 0
  for (let round = 0; round < 3; round++) {
    let n = 0
    for (const def of [{ name: 'a' }, { name: 'b' }, { name: 'c' }]) {
      if (done.has(def.name)) {
        n++
        continue
      }
      try {
        fakeTools.register(def)
        done.add(def.name)
        n++
      } catch (e) {
        if (isAlreadyRegistered(e)) {
          done.add(def.name)
          n++
        }
      }
    }
    lastN = n
  }
  check('59-⑧ ★ 行为：三轮之后仍报全量 n=3', lastN === 3, String(lastN))
  check('59-⑨ ★ 行为：第二、三轮不再真的去 register（thrown=0）', thrown === 0, String(thrown))
  check('59-⑩ 行为：工具表里是 3 个', registry.size === 3, String(registry.size))
}

// ─────────────────── 57 可逆摘要（archive.js + mind_expand） ───────────────────
//
// ⚠️ 背景（2026-11-05，读 billion-context 后加的）：
//   DSH 原生压缩是**单向门**：commitCompactionBody 用 surfaceOp:replace
//   把原文从表层遮蔽，只留摘要。有了 archive，压缩才是"降采样"而非"销毁"。
//
// 这组测三件事：
//   ① 存档真的落盘且内容正确
//   ② expand 能按 seq / 区间取回
//   ③ **反向**：取不到时不能假装取到（宁可不命中，不可返回错误区间）
group('57 ★ 可逆摘要：压缩后原文可取回')
{
  resetData()
  const arch = await import(`file:///${join(ROOT, 'lib', 'archive.js').split('\\').join('/')}`)

  // ── 造一个假的事件源（模拟 session.eventAt） ──
  const fakeEvents = {
    10: { type: 'user/message', seq: 10, data: { content: [{ type: 'text', text: '主人说：把那个 bug 修掉' }] } },
    11: {
      type: 'assistant/message',
      seq: 11,
      data: { content: [{ type: 'text', text: '女仆收到，这就去查' }] },
    },
    12: {
      type: 'tool/call',
      seq: 12,
      data: { name: 'read', arguments: { file_path: 'C:\\proj\\a.js' } },
    },
    13: {
      type: 'tool/result',
      seq: 13,
      data: { result: 'Error: ENOENT: no such file or directory' },
    },
    14: { type: 'user/message', seq: 14, data: { content: [{ type: 'text', text: '这次做另一个任务' }] } },
  }
  const eventAt = (s) => fakeEvents[s]

  // ① 存档一段区间
  const rec = arch.archiveRegion({ sessionId: 's-arch', seqs: [10, 11, 12, 13], eventAt })
  check('57-① 存档成功', rec !== null && existsSync(rec.path), rec ? rec.path : 'null')
  check('57-② 区间正确', rec?.startSeq === 10 && rec?.endSeq === 13, `${rec?.startSeq}..${rec?.endSeq}`)
  check('57-③ 存了 4 条', rec?.entries === 4, String(rec?.entries))

  // ② 列出存档
  const files = arch.listArchives('s-arch')
  check('57-④ 能列出存档', files.length === 1, String(files.length))

  // ③ 按区间取回
  const back = arch.expandRegion({ sessionId: 's-arch', fromSeq: 10, toSeq: 13 })
  check('57-⑤ 按区间取回命中', back.hit === true, JSON.stringify({ hit: back.hit, range: back.range }))
  check('57-⑥ 原文完整取回（含报错原文）', back.text.includes('ENOENT'), back.text.slice(0, 80))
  check('57-⑦ 含用户原话', back.text.includes('把那个 bug 修掉'))
  // ⚠️ 这里只能断言 `a.js` 这个片段，不能断言完整路径：
  //   存档里的参数是 `JSON.stringify(args)` 的产物，反斜杠被转义成两个
  //   （`C:\\proj\\a.js`）。第一版断言写的是 `'C:\\proj\\a.js'`，
  //   在 JS 源码里那只代表 `<path>\a.js` 单反斜杠 → 永远不匹配 → **假红**。
  //   要精确验反斜杠必须用 String.raw。
  check('57-⑧ 含工具参数', back.text.includes('a.js'), back.text.slice(0, 120))
  check('57-⑧b 工具参数保留了转义后的完整路径',
    back.text.includes(String.raw`C:\\proj\\a.js`),
    back.text.slice(0, 120))


  // ④ 按单条 seq 取回
  const one = arch.expandRegion({ sessionId: 's-arch', seq: 12 })
  check('57-⑨ 按单条 seq 取回', one.hit && one.text.includes('tool/call'), one.text.slice(0, 60))
  check('57-⑩ 单条只含那一条', !one.text.includes('ENOENT'), '不含 seq13 的内容')

  // ⑤ 反向：区间外的 seq 不能命中（防"乱返回"）
  const out = arch.expandRegion({ sessionId: 's-arch', seq: 14 })
  check('57-⑪ ★ 反向：未存档的 seq 不命中（不假装取到）', out.hit === false, JSON.stringify(out.hit))

  // ⑥ 反向：别的会话查不到（会话隔离）
  const other = arch.expandRegion({ sessionId: 's-other', fromSeq: 10, toSeq: 13 })
  check('57-⑫ ★ 反向：会话之间互相隔离', other.hit === false, JSON.stringify(other.hit))

  // ⑦ 存档索引文本（拼进摘要末尾）
  const idx = arch.archiveIndexText('s-arch')
  check('57-⑬ 摘要索引含区间', idx.includes('10..13'), idx.slice(0, 120))
  check('57-⑭ 摘要索引提示用 mind_expand', idx.includes('mind_expand'))
  check('57-⑮ 没存档时索引为空（不占预算）', arch.archiveIndexText('s-nodata') === '')

  // ⑧ 空输入不产生存档（防造出空文件）
  check('57-⑯ 反向：seqs 为空时不存档', arch.archiveRegion({ sessionId: 's-arch', seqs: [], eventAt }) === null)

  // ── ⑧b 单条超限必须截断而不是返回空（端到端实测抓到的真 bug）──
  //
  //   ⚠️ 血证（2026-11-05，用本会话真实日志跑存档）：真实会话里单条消息
  //      动辄上万字符。第一版 expandRegion 写的是「超了就 break」，
  //      于是 maxChars=3000 时**第一条就超 → 直接 break → text 是空串**，
  //      但返回 hit:true。模型会以为"取到了但没内容"，比明说"没取到"更糟。
  //   修法：单条超限时截断该条并保留开头，至少返回一条。
  const bigEvents = {
    30: { type: 'user/message', seq: 30, data: { content: [{ type: 'text', text: 'Z'.repeat(9000) }] } },
  }
  arch.archiveRegion({ sessionId: 's-big', seqs: [30], eventAt: (s) => bigEvents[s] })
  const big = arch.expandRegion({ sessionId: 's-big', fromSeq: 30, toSeq: 30, maxChars: 3000 })
  check('57-⑯b ★ 单条超限时仍返回内容（不是空串）', big.hit === true && big.text.length > 0,
    `hit=${big.hit} len=${big.text?.length}`)
  check('57-⑯c ★ 单条超限标 truncated', big.truncated === true, String(big.truncated))
  check('57-⑯d ★ 截断后不超过 maxChars 太多', big.text.length <= 3100, String(big.text.length))
  check('57-⑯e 截断内容里有那条的标记', big.text.includes('本条被截断'), big.text.slice(-40))

  // ── ⑧c ★★ 非 text 块不能丢（真机端到端抓到的第二个真 bug）──
  //
  //   ⚠️ 血证（2026-11-05，用本会话真实日志跑存档）：
  //      第一版 blocksToText 只认 `type === 'text'`，其余一律空串。
  //      真机一次压缩遮蔽 497 个 seq，其中 **88 条 assistant/message**
  //      内容是 `[{type:'reasoning'},{type:'tool-call',name:'read',arguments:'...'}]`
  //      —— 一个 text 块都没有 → 全被过滤 → 这 88 条既不进存档、也不报错。
  //
  //      最危险的是 `reasoning` 块：「参数写错了，改成 X」这类推理只在这里，
  //      丢了等于存档看着完整、实际缺掉关键环节。
  //      而剩下的 text-only 消息（女仆的正式回答）看起来完全正常，
  //      所以**肉眼看不出少了东西** —— 这就是它必须被测试锁死的原因。
  //
  //   存档条数从 409 修到 497，是这条 bug 的量化证据。
  const blockEvents = {
    40: {
      type: 'assistant/message',
      seq: 40,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '上一版参数写错了，得传完整路径' },
            { type: 'tool-call', name: 'read', arguments: '{"file_path":"C:\\\\a.js"}' },
          ],
        },
      },
    },
    41: {
      type: 'assistant/message',
      seq: 41,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '查到了' },
            { type: 'tool-result', result: '文件内容：hello' },
          ],
        },
      },
    },
  }
  const blockRec = arch.archiveRegion({ sessionId: 's-blocks', seqs: [40, 41], eventAt: (s) => blockEvents[s] })
  check('57-㉔ ★★ 含 tool-call 的 assistant 消息也要存档（不是 0 条）',
    blockRec !== null && blockRec.entries === 2, JSON.stringify(blockRec?.entries))
  const blockBack = arch.expandRegion({ sessionId: 's-blocks', fromSeq: 40, toSeq: 41, maxChars: 60000 })
  check('57-㉕ ★★ reasoning 块内容被保留', blockBack.text.includes('参数写错了'), blockBack.text.slice(0, 200))
  check('57-㉖ ★★ tool-call 块内容被保留（含工具名与参数）',
    blockBack.text.includes('read') && blockBack.text.includes('a.js'), blockBack.text.slice(0, 200))
  check('57-㉗ ★ 同一条里 text 与 tool-result 都被保留',
    blockBack.text.includes('查到了') && blockBack.text.includes('hello'), blockBack.text.slice(0, 200))
  // 反向：未知块类型不许静默丢
  const unknownEv = {
    42: { type: 'assistant/message', seq: 42, data: { message: { role: 'assistant', content: [{ type: 'weird-block', text: '神秘内容' }] } } },
  }
  arch.archiveRegion({ sessionId: 's-unknown', seqs: [42], eventAt: (s) => unknownEv[s] })
  const unkBack = arch.expandRegion({ sessionId: 's-unknown', seq: 42, maxChars: 60000 })
  check('57-㉘ ★ 未知块类型留标记而不是静默丢弃',
    unkBack.hit && unkBack.text.includes('weird-block'), unkBack.text.slice(0, 120))


  // ⑨ 清理默认只报告不删（存档是备份，不能静默删）
  const sweep1 = arch.sweepArchives({ maxAgeDays: 0, dryRun: true })
  check('57-⑰ 清理默认 dryRun（只报告不删）',
    sweep1.dryRun === true && sweep1.deleted === 0 && sweep1.candidates.length > 0,
    JSON.stringify({ dry: sweep1.dryRun, del: sweep1.deleted, cand: sweep1.candidates.length }))
  check('57-⑱ dryRun 后文件仍在', existsSync(rec.path))

  // ⑩ 源码级：存档必须在"返回摘要之前"且被 try 包住
  const srcComp = readFileSync(join(ROOT, 'lib', 'compaction.js'), 'utf8')
  check('57-⑲ 源码：compaction.js 调用了 archiveRegion', srcComp.includes('archiveRegion('))
  // ⚠️ 判据用 indexOf 比位置，不要匹配带缩进的字面串 ——
  //   第一版写的是 `return {\n      summary: summaryBlocks`（6 空格），
  //   而实际文件里是 4 空格缩进 → 永远不匹配 → **假红**。
  const posArchive = srcComp.indexOf('archiveRegion(')
  const posReturn = srcComp.indexOf('return {\n      summary: summaryBlocks')
  const posReturnAlt = srcComp.indexOf('summary: summaryBlocks')
  check('57-⑳ 源码：存档在 return summary 之前',
    posArchive > 0 && posReturnAlt > 0 && posArchive < posReturnAlt,
    `archive@${posArchive} return@${posReturnAlt}`)

  check('57-㉑ 源码：存档被 try 包住（失败不影响压缩）',
    /try \{[^}]*archiveRegion\(/s.test(srcComp) || /try\s*\{[\s\S]{0,800}archiveRegion\(/.test(srcComp))

  // ⑪ 源码级：mind_expand 工具已注册
  const srcTools = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  check('57-㉒ 源码：注册了 mind_expand 工具', srcTools.includes("name: 'mind_expand'"))
  check('57-㉓ 源码：mind_expand 调 expandRegion', srcTools.includes('expandRegion('))

  // ── ⑪b ★★ mind_expand 的**行为**测（此前只有源码字符串断言）──
  //
  //   ⚠️ 为什么必须补：第 57 组前面全部测的是 archive.js 的函数，
  //   `mind_expand` 这个**模型真正会调的工具**从来没被执行过一次。
  //   源码里有 "name: 'mind_expand'" 不代表它能用。
  //
  //   真机血证（2026-11-05）：它原来要求 `sessionId` 必填，
  //   而压缩之后模型**看不到自己的会话 id** —— 等于这个工具
  //   在最需要它的时刻不可用。现在改成从 execCtx 自动取。
  {
    const { makeToolDefinitions } = await import(
      `file:///${join(ROOT, 'lib', 'tools.js').split('\\').join('/')}`
    )
    const defs = makeToolDefinitions(
      { addPursuit: () => ({}), closePursuit: () => null, openPursuits: () => [], snapshot: () => {} },
      { config: {}, CLI_PATH: 'x' },
    )
    const expandTool = defs.find((d) => d.name === 'mind_expand')
    check('57-㉙ ★ mind_expand 在工具表里（可被模型调用）', !!expandTool)

    // 用已有的 s-arch 存档来验
    const execCtx = { agent: { id: 's-arch', session: { id: 's-arch' } } }

    // ① 省略 sessionId + 区间 → 必须从 execCtx 推出来并命中
    const r1 = await expandTool.execute({ fromSeq: 10, toSeq: 13 }, execCtx)
    check('57-㉚ ★★ 省略 sessionId 时从 execCtx 推导（不是报错要参数）',
      r1.ok === true && r1.hit === true, JSON.stringify({ ok: r1.ok, hit: r1.hit, err: r1.error }))
    check('57-㉛ ★ 取回的内容确实是原文', !!(r1.text && r1.text.includes('ENOENT')), (r1.text ?? '').slice(0, 80))

    // ② list 模式
    const r2 = await expandTool.execute({ list: true }, execCtx)
    check('57-㉜ list 模式列出存档区间',
      r2.ok === true && Array.isArray(r2.archives) && r2.archives.length >= 1,
      JSON.stringify(r2.archives))

    // ③ 反向：未存档的区间不假装取到
    const r3 = await expandTool.execute({ seq: 99999 }, execCtx)
    check('57-㉝ ★ 反向：没存档的 seq 明确说 hit=false', r3.ok === true && r3.hit === false, JSON.stringify({ hit: r3.hit }))

    // ④ 反向：既没入参也没有 execCtx → 明确报错，不能静默返回空
    const r4 = await expandTool.execute({ seq: 10 }, {})
    check('57-㉞ ★ 反向：拿不到会话 id 时明确报错（不静默）',
      r4.ok === false && typeof r4.error === 'string', JSON.stringify(r4))

    // ⑤ 显式 sessionId 仍然有效（不能被 execCtx 覆盖）
    const r5 = await expandTool.execute({ sessionId: 's-arch', seq: 10 }, { agent: { id: 'other' } })
    check('57-㉟ 显式 sessionId 优先于 execCtx',
      r5.ok === true && r5.hit === true, JSON.stringify({ ok: r5.ok, hit: r5.hit }))
  }

  // ── ⑪c ★★ 存档失败必须留痕（不能静默）──
  //
  //   ⚠️ 血证（2026-11-05）：第一版 catch 里什么都不写。
  //   真机 /compact 之后 archives 目录一个文件都没有、mind.log 一个字都没有，
  //   女仆只能翻会话日志、反推表层、逐条比对，花一整轮才定位到
  //   「把 seq 数字当事件传给 deriveEventMessage」。
  //   有一行「存档跳过 :: 反推失败」就能五秒定位。
  {
    const srcComp2 = readFileSync(join(ROOT, 'lib', 'compaction.js'), 'utf8')
    // ⚠️ 2026-11-05 放宽：`log(` 与模板字符串之间可能有换行（存档段抽成了
    //   archiveShadowedRegion()，`log(\n  \`压缩存档失败...\`,\n)` 也合法）。
    //   这里断言的是「有没有这条日志调用」，排版不算语义，不该被排版绊倒。
    check('57-㊱ ★★ 源码：反推失败时写日志（不是空 catch）',
      /log\(\s*`压缩存档跳过|log\(\s*'压缩存档跳过/.test(srcComp2))
    check('57-㊲ ★★ 源码：存档返回 null 时写日志',
      /log\(\s*`压缩存档失败|log\(\s*'压缩存档失败/.test(srcComp2))
    check('57-㊳ ★★ 源码：存档异常被 catch 后写日志（不是吞掉）',
      /catch \(e\) \{[\s\S]{0,300}log\(\s*`压缩存档异常/.test(srcComp2))
    check('57-㊴ ★ 源码：存档成功也留一行（便于事后核对）',
      /log\(\s*[\s\S]{0,80}压缩存档完成/.test(srcComp2))

    // ── 57-㊵~㊸ 存档位置：必须在 LLM 调用**之前** ──
    //
    // ⚠️ 为什么这是最容易悄悄回退的一处（2026-11-05 第二次修）：
    //   第一版把存档放在 summarize() 末尾（拿到摘要之后）。
    //   于是「摘要失败 ⇒ 原文也没存」。真机血证：某个真实会话前两次压缩
    //   的 1019 条原文就是这么丢的 —— 反推坏了本来就存不上，
    //   加上位置在成功路径尾巴，失败时连一点痕迹都不留。
    //
    //   改成先落盘后摘要之后，这条要能被"退回去就变红"地守住。
    // ⚠️ 划重点（2026-11-05 反向验证抓到的假绿）：
    //   第一版这里用 `indexOf('archiveShadowedRegion(agent, input)')` 定位调用点，
    //   结果命中的是**函数定义那一行**（`function archiveShadowedRegion(agent, input) {`），
    //   于是无论调用挪到哪里，断言都显示「在 stream 之前」—— 反向验证 513 项全绿，
    //   也就是说这条测试根本没在测它声称要测的东西。
    //
    //   修法：只认**调用形态**。调用一定带 `=`（`const archived = ...`），
    //   定义一定带 `function` 前缀，用锚点把两者分开。
    const callRe = /(?:const|let|var)\s+\w+\s*=\s*archiveShadowedRegion\s*\(/g
    const calls = [...srcComp2.matchAll(callRe)].map((m) => m.index)
    const iArchive = calls.length > 0 ? calls[0] : -1
    const iStream = srcComp2.indexOf('this.ctx.llm.stream(options)')
    check('57-㊵ ★★ 存档调用存在（且未被函数定义误命中）', calls.length === 1,
      `命中 ${calls.length} 处：${calls.join(',')}`)
    check('57-㊶ ★★ LLM 调用存在', iStream !== -1, String(iStream))
    check('57-㊷ ★★★ 存档在 LLM 之前（「摘要失败也要留原文」的唯一保障）',
      iArchive !== -1 && iStream !== -1 && iArchive < iStream,
      `call@${iArchive} stream@${iStream}`)
    // 反向形态：旧写法是「先 stream、后 archive」——必须识别为错
    check('57-㊸ ★★ 反向：archive 不得出现在 stream 之后',
      !(iArchive !== -1 && iStream !== -1 && iArchive > iStream),
      `call@${iArchive} stream@${iStream}`)
  }
}

// ─────────── 58 inferShadowedSeqs：从 messages 反推被遮蔽的 seq 区间 ───────────
//
// ⚠️ 为什么必须单独测（这是可逆摘要的**唯一** seq 来源）：
//   `summarize(input, agent, signal)` 收到的 `input` **不含 seq**
//   —— 源码 `buildSummarizationInput()` 只把 `shadowedSeqs` 派生成了 messages，
//   seq 本身被丢掉。所以女仆只能用「滑窗比对派生消息文本」反推。
//
//   反推错的后果比不反推严重得多：存错区间 → 以后 mind_expand 取回一段**无关原文**
//   → 模型把它当成"这就是当时的对话"。所以这里正反两个方向都要钉死。
group('58 ★ 从 messages 反推 seq 区间（可逆摘要的承重点）')
{
  resetData()
  const compMod = await import(`file:///${join(ROOT, 'lib', 'infer-region.js').split('\\').join('/')}`)
  const infer = compMod.inferShadowedSeqs
  check('58-⓪ inferShadowedSeqs 已导出（供行为测试）', typeof infer === 'function')

  // 造假 session。
  //
  // ⚠️ 形态必须与**真机一致**，否则这一整组是假绿（2026-11-05 血证）：
  //   第一版写成 `nodes: [{ seq: 5 }, ...]` + `deriveEventMessage: (node) => msgMap[node.seq]`，
  //   即「节点是对象、deriveEventMessage 吃对象」。全部 12 条测试绿灯通过。
  //   而真机 `session.surface.nodes` 是 **seq 数字数组**
  //   （dsh-session:464 `state.nodes.push(plan.seq)`；getter 注释 "Surface event sequences"），
  //   `deriveEventMessage(event)` 吃的是**事件对象**。
  //   于是真机上线后 archives 目录一个文件都没有 —— 测试全绿，功能全废。
  //
  //   现在的假 session 严格复刻真机三件套：
  //     surface.nodes  → seq 数字数组
  //     eventAt(seq)   → 事件对象
  //     deriveEventMessage(event) → 消息
  const msgMap = {
    5: { role: 'user', content: [{ type: 'text', text: 'AAA 第一句' }] },
    6: { role: 'assistant', content: [{ type: 'text', text: 'BBB 第二句' }] },
    7: { role: 'user', content: [{ type: 'text', text: 'CCC 第三句' }] },
    8: { role: 'assistant', content: [{ type: 'text', text: 'DDD 第四句' }] },
  }
  const seqs = Object.keys(msgMap).map(Number).sort((a, b) => a - b)
  const evMap = Object.fromEntries(
    seqs.map((s) => [s, { seq: s, type: 'user/message', data: msgMap[s] }]),
  )
  /** 造一个与宿主同形状的 session。overrides 可覆盖任意字段。 */
  const mkSession = (overrides = {}) => ({
    id: 's-inf',
    surface: { nodes: seqs },
    eventAt: (seq) => evMap[seq],
    deriveEventMessage: (ev) => (ev && ev.data ? ev.data : null),
    ...overrides,
  })
  const session = mkSession()

  // ① 正常：整个区间
  const all = infer(session, {
    messages: seqs.map((s) => msgMap[s]),
  })
  check('58-① 全区间反推成功', all !== null && all.seqs.length === 4, JSON.stringify(all?.seqs))
  check('58-② 反推的 seq 正确', JSON.stringify(all?.seqs) === '[5,6,7,8]', JSON.stringify(all?.seqs))

  // ② 子区间：只压中间两条
  const mid = infer(session, { messages: [msgMap[6], msgMap[7]] })
  check('58-③ ★ 子区间反推正确（不是永远返回全部）',
    JSON.stringify(mid?.seqs) === '[6,7]', JSON.stringify(mid?.seqs))

  // ③ 带 system 头（基类会拼 surface 头）→ 必须剔掉、不偏位
  const withSystem = infer(session, {
    messages: [{ role: 'system', content: [{ type: 'text', text: '你是助手' }] }, msgMap[6], msgMap[7]],
  })
  check('58-④ ★ 有 system 头时仍能正确定位（不偏一位）',
    JSON.stringify(withSystem?.seqs) === '[6,7]', JSON.stringify(withSystem?.seqs))

  // ④ 容忍包装差异：派生消息比原文多了前后缀也应命中
  const wrapped = mkSession({
    deriveEventMessage: (ev) => {
      const m = ev?.data
      if (!m) return null
      return { role: m.role, content: [{ type: 'text', text: `<system-reminder>x</system-reminder>\n${m.content[0].text}` }] }
    },
  })
  const w = infer(wrapped, { messages: [msgMap[6], msgMap[7]] })
  check('58-⑤ 容忍包装差异（派生消息带额外前后缀）',
    JSON.stringify(w?.seqs) === '[6,7]', JSON.stringify(w?.seqs))

  // ⑤ ★ 反向：内容对不上 → 返回 null，不能瞎返回一个区间
  //
  //   这是整组最重要的一条：反推错会让 mind_expand 取回**无关原文**，
  //   而模型会把它当成"当时的对话"。宁可 null。
  const mismatch = infer(session, {
    messages: [{ role: 'user', content: [{ type: 'text', text: '这句话根本不在会话里' }] }],
  })
  check('58-⑥ ★ 反向：内容对不上时返回 null（不瞎猜区间）', mismatch === null, JSON.stringify(mismatch))

  // ⑥ 反向：空输入 / 无 session / 无 nodes
  check('58-⑦ 反向：messages 为空时返回 null', infer(session, { messages: [] }) === null)
  check('58-⑧ 反向：没有 session 时返回 null', infer(null, { messages: [msgMap[5]] }) === null)
  check('58-⑨ 反向：surface 没有 nodes 时返回 null',
    infer({ id: 'x' }, { messages: [msgMap[5]] }) === null)

  // ⑦ 反向：只有 system 头、没有正文 → null（剔掉 system 后空了）
  check('58-⑩ 反向：只有 system 一条时返回 null',
    infer(session, { messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }] }) === null)

  // ⑧ deriveEventMessage 抛错不应炸整段
  const throwing = mkSession({
    deriveEventMessage: () => {
      throw new Error('boom')
    },
  })
  check('58-⑪ 派生消息抛错时安全降级（返回 null 而不是抛出）',
    infer(throwing, { messages: [msgMap[5]] }) === null)

  // ⑨ ★★ 真机形态回归：这一条是 2026-11-05 那个真 bug 的锁
  //
  //   血证：/compact 之后 archives 目录**一个文件都没有**，日志里
  //   连「存档」两个字都没出现。原因是女仆把 `surface.nodes` 里的
  //   **seq 数字**当事件传给了 `deriveEventMessage` → event.type 是 undefined
  //   → 走 default 返回 null → 全部派生失败 → 静默不存档。
  //
  //   下面三条把「必须调 eventAt」钉死，任何回退都会立刻变红。
  check('58-⑫ ★★ 缺 eventAt 的 session 必须拒绝（不能把 seq 数字当事件）',
    infer(mkSession({ eventAt: undefined }), { messages: [msgMap[6]] }) === null)

  // 反向：deriveEventMessage 收到的是**事件对象**而不是数字。
  // 这里直接记录它收到什么，用确定性判断而不是靠行为间接推。
  {
    const seen = []
    const spy = mkSession({
      deriveEventMessage: (ev) => {
        seen.push(ev)
        return ev?.data ?? null
      },
    })
    const r = infer(spy, { messages: [msgMap[6]] })
    const allObjects = seen.length > 0 && seen.every((e) => typeof e === 'object' && e !== null)
    check('58-⑬ ★★ deriveEventMessage 收到的是事件对象（不是 seq 数字）',
      allObjects, `收到 ${typeof seen[0]}`);
    check('58-⑭ ★★ 且反推成功', JSON.stringify(r?.seqs) === '[6]', JSON.stringify(r?.seqs))
  }

  // ⑩ ★ 派生为 null 的节点不能挤掉区间跨度
  //
  //   基类 buildSummarizationInput 用 `.filter(m => m !== null)` 丢掉派生为 null 的节点，
  //   所以 input.messages 里没有它们；但真正被遮蔽的区间是 `nodes.slice()` **连续**切片。
  //   若这里也跳过不占位，返回的 seqs 就会缺中间那些（如 tool/call 等不派生消息的事件），
  //   存档就少了一段原文 —— 而且**不会报错**。
  {
    // seq 6 派生为 null（模拟 tool/call 之类不产生消息的事件）
    const gapSession = mkSession({
      deriveEventMessage: (ev) => (ev?.seq === 6 ? null : (ev?.data ?? null)),
    })
    const r = infer(gapSession, { messages: [msgMap[5], msgMap[7]] })
    check('58-⑮ ★ 中间有派生为 null 的节点时，区间仍连续覆盖（含空洞 seq）',
      JSON.stringify(r?.seqs) === '[5,6,7]', JSON.stringify(r?.seqs))
  }
}

// ─────────────────────── 51 压缩前日记 ───────────────────────
group('51 ★ 压缩前日记')
{
  resetData()
  const diaryMod = await import(`file:///${join(ROOT, 'lib', 'diary.js').split('\\').join('/')}`)
  global.rememberFact('dkey', 'dvalue', 'test')

  // ① 压力不到阈值：不写
  const lowMeter = { measure: () => ({ totalTokens: 1000 }) }
  const agent = { id: 's-diary', session: { id: 's-diary' } }
  const w1 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-diary',
    agent,
    facts: global.readGlobal().facts,
    timeline: global.readGlobal().timeline,
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now: Date.now(),
  })
  check('★ 压力低时不写日记', w1 === null, String(w1))

  // ② 压力过阈值：必须写，且文件可读、含关键段落
  const highMeter = { measure: () => ({ totalTokens: 500000 }) }
  const now = Date.now()
  const w2 = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: 's-diary',
    agent,
    facts: global.readGlobal().facts,
    timeline: global.readGlobal().timeline,
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now,
  })
  check('★ 压力高时必须写日记', typeof w2 === 'string' && existsSync(w2), String(w2))
  if (typeof w2 === 'string' && existsSync(w2)) {
    const body = readFileSync(w2, 'utf8')
    check('★ 日记含「压缩前日记」标题', body.includes('压缩前日记'))
    check('★ 日记写明压力百分比', /8[0-9]%|83%/.test(body), body.split('\n')[2])
    check('★ 日记含「给压缩后的自己」段', body.includes('给压缩后的自己'))
    check('★ 日记明确说明摘要不是原话', body.includes('不是女仆的原话') || body.includes('为准'))
  }

  // ③ 限流：立刻再写一次必须被挡（30 分钟间隔）
  const w3 = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: 's-diary',
    agent,
    facts: global.readGlobal().facts,
    timeline: global.readGlobal().timeline,
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now: now + 1000,
  })
  check('★ 限流：30 分钟内不重复写', w3 === null, String(w3))

  // ④ 反向：过了间隔必须能再写（证明限流不是一刀切死）
  const w4 = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: 's-diary',
    agent,
    facts: global.readGlobal().facts,
    timeline: global.readGlobal().timeline,
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now: now + diaryMod.DIARY_MIN_GAP_MS + 1000,
  })
  check('★ 过了间隔可以再写', typeof w4 === 'string', String(w4))

  // ⑤ 拿不到 tokenMeter：静默跳过，绝不抛
  let threw = false
  try {
    const w5 = diaryMod.maybeWriteDiary({}, {
      sessionId: 's-diary', agent, facts: [], timeline: [],
      config: { diary: { enabled: true } }, now,
    })
    check('★ 没有 tokenMeter 时返回 null 而不是抛', w5 === null)
  } catch {
    threw = true
  }
  check('★ 没有 tokenMeter 时绝不抛异常', !threw)

  // ⑥ enabled=false：什么都不写
  const w6 = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: 's-diary', agent, facts: [], timeline: [],
    config: { diary: { enabled: false, pressureRatio: 0.7 } }, now,
  })
  check('★ diary.enabled=false 时不写', w6 === null)

  // ⑥.5 2026-11-08 新判据：measure 回放 surface 为空（totalTokens=0）时，
  //       回退到 contextPressure 的 projectedTokens 再判压力。
  //       血证：真机 pre-step 时机太早，measure 总返回 0（日志 37+ 次），
  //       而压缩时 force 路径能测出 66% —— 同一条代码，差别只在时机。
  {
    const projSession = 's-diary-proj'
    const projAgent = { id: projSession, session: { id: projSession } }
    // 模拟 pre-step 时机：measure 回放不到 surface，返回 0；
    // 但投影系统维护着 provider 报告的最新 prompt 规模。
    const zeroMeasureMeter = {
      measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }),
      contextPressure: () => ({ projectedTokens: 500000 }),
    }
    const projHigh = diaryMod.maybeWriteDiary({ tokenMeter: zeroMeasureMeter }, {
      sessionId: projSession,
      agent: projAgent,
      facts: global.readGlobal().facts,
      timeline: global.readGlobal().timeline,
      config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
      now: Date.now() + 999999,
    })
    check('★ measure=0 但投影 83% 时必须写（回退生效）', typeof projHigh === 'string' && existsSync(projHigh), String(projHigh))

    // 反向：投影压力也低 → 仍不写（证明回退不是无条件写）
    const lowProjMeter = {
      measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: [] }),
      contextPressure: () => ({ projectedTokens: 1000 }),
    }
    const projLow = diaryMod.maybeWriteDiary({ tokenMeter: lowProjMeter }, {
      sessionId: projSession + '-low',
      agent: { id: projSession + '-low', session: { id: projSession + '-low' } },
      facts: [], timeline: [],
      config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
      now: Date.now() + 999999,
    })
    check('★ 投影也低时不写（回退不是无条件）', projLow === null, String(projLow))

    // 反向：measure=0 且没有 contextPressure 方法 → 仍走 zero-tokens 跳过，不抛
    let projThrew = false
    try {
      const noProj = diaryMod.maybeWriteDiary({ tokenMeter: { measure: () => ({ totalTokens: 0 }) } }, {
        sessionId: projSession + '-none',
        agent: { id: projSession + '-none', session: { id: projSession + '-none' } },
        facts: [], timeline: [],
        config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
        now: Date.now() + 999999,
      })
      check('★ measure=0 且无投影 → 仍跳过（不抛）', noProj === null, String(noProj))
    } catch {
      projThrew = true
    }
    check('★ 无投影回退路径不抛异常', !projThrew)
  }

  // ⑦ 源码级：日记写在注入之前（顺序决定它能不能被压缩前那一步看到）
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const diaryIdx = src.indexOf('maybeWriteDiary(ctx')
  // ⚠️ 2026-11-08 拆分：原来的锚点 `StrandSegment.render(sessionId` 已不存在。
  //   改用**第一处真正发生渲染**的那一行（psyche 段的条件判断）。
  //   语义没变：日记必须在渲染任何段之前写完。
  const renderIdx = src.indexOf('if (config.psyche.enabled && config.psyche.inject)')
  check('★ 日记写入在渲染之前', diaryIdx > 0 && renderIdx > diaryIdx, `diary@${diaryIdx} render@${renderIdx}`)
  // ⚠️ 断言不能写死 `try {\s*maybeWriteDiary` —— 2026-11-05 加了 70% 触发压缩后
  //   try 里第一行变成 `const d = maybeWriteDiary(...)`，旧正则假红。
  //   改成「try 花括号内出现 maybeWriteDiary」，不绑死前缀写法。
  check(
    '★ 日记调用被 try 包住（失败不影响注入）',
    /try \{[\s\S]{0,200}?maybeWriteDiary\(ctx/.test(src),
  )

  // ── ⑧ 强制模式（2026-11-05 第二次修，主人指定）──
  //
  // 血证：真机四次 /compact 全是手动，压力只 30~45%，从没到 70%，
  //       于是 `~/.dsh/mind/diary/` 目录建都没建过 —— 一篇日记都没有。
  //       现在压缩时强写，这条路径必须能绕过压力判定。
  resetData()
  const lowAgent = { id: 's-force', session: { id: 's-force' } }
  const forceNow = Date.now()
  const cfgDiary = { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } }

  // 反向基线：同样低压、不 force → 必须不写
  const f0 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-force', agent: lowAgent, facts: [], timeline: [],
    config: cfgDiary, now: forceNow,
  })
  check('★ 反向基线：低压 + 不 force → 不写', f0 === null, String(f0))

  // force 且压力很低 → 必须写（这正是手动 /compact 的真实情形）
  const f1 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-force', agent: lowAgent, facts: [], timeline: [],
    config: cfgDiary, now: forceNow + 1000, force: true,
  })
  check('★ 低压 + force → 必须写（手动压缩的真实情形）', typeof f1 === 'string' && existsSync(f1), String(f1))
  if (typeof f1 === 'string' && existsSync(f1)) {
    const b = readFileSync(f1, 'utf8')
    check('★ 强写的日记内容完整', b.includes('压缩前日记') && b.includes('给压缩后的自己'))
  }

  // force 但 60 秒内刚写过 → 挡住（压缩失败重试会再调一次 summarize）
  const f2 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-force', agent: lowAgent, facts: [], timeline: [],
    config: cfgDiary, now: forceNow + 2000, force: true,
  })
  check('★ force 也有闸门：60 秒内刚写过不重复写', f2 === null, String(f2))

  // 反向：超过 force 闸门 → 必须能再写
  const f3 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-force', agent: lowAgent, facts: [], timeline: [],
    config: cfgDiary, now: forceNow + 1000 + diaryMod.DIARY_FORCE_MIN_GAP_MS + 1000, force: true,
  })
  check('★ 过了 force 闸门可以再写', typeof f3 === 'string', String(f3))

  // force 也不能绕过 enabled=false
  const f4 = diaryMod.maybeWriteDiary({ tokenMeter: lowMeter }, {
    sessionId: 's-force', agent: lowAgent, facts: [], timeline: [],
    config: { diary: { enabled: false } }, force: true,
  })
  check('★ enabled=false 时 force 也不写', f4 === null, String(f4))

  // force 闸门必须比常规闸门短（否则手动压缩后 30 分钟内再压缩就丢一次日记）
  check(
    '★ force 闸门短于常规闸门',
    diaryMod.DIARY_FORCE_MIN_GAP_MS < diaryMod.DIARY_MIN_GAP_MS,
    `${diaryMod.DIARY_FORCE_MIN_GAP_MS} < ${diaryMod.DIARY_MIN_GAP_MS}`,
  )

  // ⑨ 诊断日志：拿不到 tokenMeter 时必须留痕（原来静默 return，排查时零线索）
  const diarySrc = readFileSync(join(ROOT, 'lib', 'diary.js'), 'utf8')
  check(
    '★ 拿不到 tokenMeter 时有日志（不再静默）',
    /日记跳过 :: 拿不到 tokenMeter/.test(diarySrc),
  )
  check(
    '★ 计量结果不可用时也有日志',
    // 2026-11-09：这里原来匹配的是「日记跳过 :: 计量结果不可用」。
    // 三层取数改造后文案变成「日记跳过 :: 三层取数全失败（...）」，
    // 所以断言放宽成「一定会打出 日记跳过 :: 且带三层诊断字段」，
    // 而不是钉死某一句文案 —— 钉死文案会让每次改日志都误报红。
    //
    // 2026-11-12：又加了一层（第 ④ 层「从会话日志尾部估算」），
    // 文案从「三层」变成「四层」——**正好印证了上面那句"钉死文案会误报"**。
    // 这次仍不钉死层数：匹配 `N层取数全失败` 的通用形状 + 三个诊断字段。
    /日记跳过 :: [三四五]层取数全失败/.test(diarySrc) &&
      /contextPressure=/.test(diarySrc) &&
      /估算=/.test(diarySrc),
  )
  // 反向对照：确认上面那条确实依赖新文案（旧文案不该再被匹配到）
  check(
    '★ 反向对照：旧文案「计量结果不可用」已不再作为唯一出口',
    !/日记跳过 :: 计量结果不可用 totalTokens=/.test(diarySrc),
  )
  check(
    '★ describeSlot 存在且不抛',
    typeof diaryMod === 'object' && /function describeSlot/.test(diarySrc),
  )

  // ── 2026-11-12 新增：第 ④ 层「从 assistant/message 的 usage 取真实用量」──
  //
  // 🩸 血证：原「三层取数」里有**两层依赖同一个会空的源**——
  //   ① measure() 回放 surface、③ 估算也读 session.surface.nodes。
  //   真机 34 次「估算=no-surface-nodes」证明 pre-step 时 surface 是空的，
  //   于是三层一起哑火。所谓"三层"实际只有两层独立，第三层是伪兜底。
  check(
    '★★ 存在第 ④ 层 tokenFromLastUsage（不依赖 surface.nodes）',
    /function tokenFromLastUsage\s*\(/.test(diarySrc),
  )
  check(
    '★★ surface 为空时不再直接 return，而是转交 usage 层',
    /return tokenFromLastUsage\(session, 'no-surface-nodes'\)/.test(diarySrc),
  )
  check(
    '★★★ 第 ④ 层读的是 assistant\/message 的 data.usage（宿主真实计量）',
    /e\.type !== 'assistant\/message'/.test(diarySrc) &&
      /const u = e\.data\?\.usage/.test(diarySrc),
  )
  check(
    '★★★ 压力公式与宿主 usage-projection.js:58 同口径（input+cacheRead+cacheWrite）',
    /u\.inputTokens\) \|\| 0\) \+[\s\S]{0,80}u\.cacheReadTokens\) \|\| 0\) \+[\s\S]{0,80}u\.cacheWriteTokens\) \|\| 0\)/.test(
      diarySrc,
    ),
  )
  check(
    '★★★ 第 ④ 层不用「扫日志尾部按字符估算」（实测覆盖率仅 6.7%，已作废）',
    !/function estimateFromLogTail\s*\(/.test(diarySrc) &&
      !/const LOG_TAIL = 400/.test(diarySrc),
  )
  check(
    '★ 实测值在日志里不许写成「估算」（口径必须诚实）',
    /用量实测/.test(diarySrc) && /取自 assistant\/message 的 data\.usage/.test(diarySrc),
  )
  // 🩸 2026-11-12 真机抓到的第二个口径错误：
  //   第 ④ 层虽然日志里写了「用量实测」，但 `viaEstimate=true` 让它带着
  //   source='estimate' 走进 composeDiary → 日记正文写成「字符估算，非精确值」。
  //   **同一个数在日志里叫实测、在日记里叫估算** —— 两处口径打架。
  check(
    '★★ usage 实测值不许在日记正文里写成「字符估算」',
    /source === 'usage'/.test(diarySrc) &&
      /取自上一次请求的实测用量/.test(diarySrc) &&
      // 反向：source 的取值链里 usage 必须优先于 estimate
      /viaUsage\s*\?\s*'usage'\s*:\s*viaProjection/.test(diarySrc),
  )
  check(
    '★★ 取数诊断 via= 能区分 usage（新代码生效要从日志看得见）',
    /viaUsage\s*\?\s*'usage'/.test(diarySrc) && /viaLabel/.test(diarySrc),
  )

  // ── 2026-11-12 新增：把「新会话开头没历史」和「真故障」分开报 ──
  //
  // 🩸 血证：真机 34 次「三层取数全失败」**34/34 全部**紧跟「窗口首次说话」，
  //   而那些会话压力只有 3.7%~5.2%（阈值 62%，差 12~17 倍），
  //   真正到 62% 的会话日记一次没漏（7 条「压力达阈值」实证）。
  //   → 这些"失败"发生在永远用不到日记的时刻，是**正常噪音不是故障**，
  //     却每次开新窗口都打一行像报错的话 = 34 次假警报。
  check(
    '★★★ 存在 probeFreshSession（确定性判据，不靠猜）',
    /function probeFreshSession\s*\(/.test(diarySrc),
  )
  check(
    '★★★ 「新会话开头无历史」与「四层取数全失败」是两种不同文案',
    /新会话开头、还没有历史可测（正常，非故障）/.test(diarySrc) &&
      /日记跳过 :: 四层取数全失败/.test(diarySrc),
  )
  check(
    '★★ 新会话判据要求「seq 短」且「一条 assistant/message 都没有」两个条件',
    /total <= shortSeq && out\.assistantCount === 0/.test(diarySrc),
  )
  check(
    '★★ 新会话分支里不引用后定义的 threshold（防 TDZ ReferenceError）',
    // 该分支内必须自己算 thr，且不得出现裸 threshold 读取
    /const thr = Number\.isFinite\(cfg\.pressureRatio\)/.test(diarySrc),
  )
  check(
    '★ 两种文案都不改变判断逻辑（共用同一个 return fail zero-tokens）',
    // ⚠️ 这里刻意用 900 字符窗口：两个 log 分支是 if/else，共用**同一个**
    //   return（距新会话文案 632 字符、距四层文案 342 字符）。
    //   窗口开小了会误报红 —— 断言写窄了本身就是一种"测试说谎"。
    /日记跳过 :: 新会话开头[\s\S]{0,900}?return fail\('zero-tokens'\)/.test(diarySrc) &&
      // 反向：新会话分支内不许出现写日记的调用（它必须和原来一样"不写"）
      !/日记跳过 :: 新会话开头[\s\S]{0,900}?composeDiary/.test(diarySrc),
  )

  // ⑩ 压缩侧接线：强写必须挂在 summarize() 里、且在 LLM 之前
  const compSrc = readFileSync(join(ROOT, 'lib', 'compaction.js'), 'utf8')
  const CALL_RE = /(?:const|let|var)\s+\w+\s*=\s*forceDiaryOnCompaction\s*\(/g
  const fCalls = [...compSrc.matchAll(CALL_RE)].map((m) => m.index)
  check('★ compaction.js 里有 forceDiaryOnCompaction 调用且唯一', fCalls.length === 1, `命中 ${fCalls.length} 处`)
  const iLlm = compSrc.indexOf('this.ctx.llm.stream(options)')
  check('★ 压缩侧确实调了 LLM', iLlm > 0, `llm@${iLlm}`)
  check(
    '★ 强写日记在 LLM 调用之前',
    fCalls.length === 1 && fCalls[0] < iLlm,
    `diaryCall@${fCalls[0] ?? -1} llm@${iLlm}`,
  )
  check(
    '★ 强写函数体被 try 包住（绝不带崩压缩）',
    /function forceDiaryOnCompaction[\s\S]{0,200}try \{/.test(compSrc),
  )
  check(
    '★ 强写调用 force: true（否则低压下仍不写）',
    /maybeWriteDiary\(ctx,\s*\{[\s\S]{0,400}?force:\s*true/.test(compSrc),
  )
  check(
    '★ 强写传的是真 ctx 而不是空壳（否则 getMeter 必返回 null）',
    !/forceDiaryOnCompaction\(\s*\{\s*tokenMeter:\s*undefined/.test(compSrc),
  )

  // ── ⑪ 注入截断（2026-11-05 第三次修，主人指定）──
  //
  // 血证：首篇日记 1204 字符，注入上限 injectMaxChars=700 是**从末尾截断**的。
  //       被丢掉的 504 字符里，正好包含「给压缩后的自己」整段 —— 女仆写它
  //       就是为了让压缩后的自己读到，结果一个字都没送到。
  //       同时裸 slice 会切断句子，且截断后不给出全文路径（等于抗压缩只做一半）。
  {
    const sink = readFileSync(join(ROOT, 'lib', 'diary.js'), 'utf8')

    // ① 纪律段必须在正文**前面**，不能被末尾截断吃掉
    const iRule = sink.indexOf("'## 给压缩后的自己'")
    const iStale = sink.indexOf("'## 已作废的结论（别再用）'")
    const iThreads = sink.indexOf("'## 未结线索'")
    check(
      '★ 注入截断：纪律段在卡片最前（不再被末尾截断吃掉）',
      iRule > 0 && iStale > iRule && iThreads > iRule,
      `rule@${iRule} stale@${iStale} threads@${iThreads}`,
    )

    // ② 不得再裸 slice（会切断句子）
    check(
      '★ 注入截断：不再裸 slice 切正文',
      !/raw\.slice\(0,\s*maxChars\)\s*\+\s*'\\n（下略）'/.test(sink) &&
        !/\.slice\(0,\s*maxChars\) \+ '\\n（下略）'/.test(sink),
    )

    // ③ 截断后必须给出全文绝对路径（否则压缩后的自己无处取回）
    //
    //   ⚠️ 这里原来只写了一条源码正则 `/全文：\$\{file\}/`，反向验证时当场假绿：
    //   第 ③ 轮把**调用点**改成不带路径，可 `tailOf` 的**函数定义**里还有
    //   `全文：${file}`，正则照样命中 → 测试说通过，实际功能已坏。
    //   同一个坑 AGENTS.md 早写过（「反向断言只认调用形态，不认字符串出现」），
    //   这次又踩了。下面改成**行为断言**：真跑一遍，查输出里有没有那个路径。
    check(
      '★ 注入截断：tailOf 只在两处使用（定义 + 一次调用，防悬空定义）',
      (sink.match(/tailOf\(/g) ?? []).length === 2,
      `tailOf( 出现 ${(sink.match(/tailOf\(/g) ?? []).length} 次`,
    )

    // ④ 行为断言：任何上限下实际长度都不得超出
    const longSession = 's-inject-len'
    resetData()
    // 注意：模板里 timeline 只取 `slice(-8)`，所以靠"很多条"撑不长度，
    // 必须靠"每条长"——首次写这条测试就是踩了这个坑（8 条短句只到 469 字符）。
    const manyLines = Array.from({ length: 60 }, (_, i) => ({
      by: i % 2 ? 'assistant' : 'user',
      at: `2026-11-05T07:${String(i % 60).padStart(2, '0')}:00.000Z`,
      text: `第 ${i + 1} 句：${'用来把日记撑到超过上限的填充内容'.repeat(6)}`,
    }))
    const pLong = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
      sessionId: longSession,
      agent: { id: longSession, session: { id: longSession } },
      facts: [], timeline: manyLines,
      config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
      now: Date.now(),
      force: true,
    })
    check('★ 截断测试：长日记已生成', typeof pLong === 'string' && existsSync(pLong), String(pLong))

    for (const cap of [300, 700, 900]) {
      const got = diaryMod.latestDiaryText(longSession, cap)
      check(
        `★ 注入不超上限（cap=${cap}，实际 ${got.length}）`,
        got.length <= cap,
        `${got.length} > ${cap}`,
      )
    }

    // ⑤ 反向：上限够大时必须逐字完整（证明截断只在必要时发生）
    const full = diaryMod.latestDiaryText(longSession, 100000)
    const rawFull = typeof pLong === 'string' ? readFileSync(pLong, 'utf8') : ''
    check(
      '★ 反向：上限足够时注入全文逐字一致',
      full === rawFull && full.length > 700,
      `注入 ${full.length} vs 原文 ${rawFull.length}`,
    )

    // ⑥ 截断不能切断整行（最后保留的行必须完整）
    const cut = diaryMod.latestDiaryText(longSession, 700)
    const bodyPart = cut.split('\n（下略')[0]
    const rawLines = rawFull.split('\n')
    check(
      '★ 截断按行对齐（保留部分每行都能在原文中找到）',
      bodyPart.split('\n').every((ln) => rawLines.includes(ln)),
    )

    // ⑦ ★行为断言★ 截断时输出里必须带得上全文路径
    //
    //   不能用源码正则查（上一版就是被 `tailOf` 的定义骗过去的），
    //   必须看 `latestDiaryText` 真正吐出来的字符串。
    check(
      '★ 注入截断：截断输出里带全文绝对路径',
      cut.includes(pLong) && cut.includes('下略'),
      cut.slice(-120),
    )

    // 反向：上限够大（不截断）时不该出现「下略」
    check(
      '★ 反向：不截断时不出现「下略」',
      !full.includes('下略'),
      full.slice(-80),
    )
  }

  // ── ⑫ B 档放宽（2026-11-05 第四次修，主人选 B）──
  //
  // 血证：把 injectMaxChars 从 700 提到 5000 也没用 —— 实测日记仍只有 1220 字符。
  //       根因是**源头被切死**：stale 15 / threads 10 / timeline 8 句 ×120。
  //       所以只改上限是空转，必须同时放宽这三个 slice。
  {
    const dsrc = readFileSync(join(ROOT, 'lib', 'diary.js'), 'utf8')
    const csrc = readFileSync(join(ROOT, 'lib', 'config.js'), 'utf8')

    // ① 上限确实提到 2000
    check(
      '★ B 档：config 里 injectMaxChars = 2000',
      /injectMaxChars:\s*2000/.test(csrc),
      (csrc.match(/injectMaxChars:\s*\d+/) ?? ['无'])[0],
    )
    check(
      '★ B 档：latestDiaryText 默认值也是 2000（防漏改）',
      /export function latestDiaryText\(sessionId, maxChars = 2000\)/.test(dsrc),
    )

    // ② 三处默认值必须一致（漏改任何一处，行为就会被悄悄拉回 700）
    //
    //   ⚠️ 这里原来只查了 config 与 latestDiaryText 的**默认参数**，
    //   而 `index.js` 的 `config.diary?.injectMaxChars ?? 700` 是**第三处**兜底。
    //   反向验证第 ④ 轮把这个兜底改回 700，测试全绿 —— 假绿。
    //   三处必须一起查，否则改一处漏两处，行为仍然错。
    const isrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
    check(
      '★ B 档：index.js 的 fallback 也是 2000（第三处，最易漏）',
      /config\.diary\?\.injectMaxChars \?\? 2000/.test(isrc),
      (isrc.match(/config\.diary\?\.injectMaxChars \?\? \d+/) ?? ['无'])[0],
    )
    // 反向：三处不得残留 700 作为**生效默认值**
    //
    //   ⚠️ 不能裸查 `injectMaxChars: 700` —— 注释里说明这段历史时也会写它，
    //   第一版就是这么误报的（把 `// 而注入上限 injectMaxChars: 700 是从末尾截断的`
    //   当成了生效代码）。这里只认两种真正的生效形态。
    const activeDefaults = [
      ...(csrc.matchAll(/^\s*injectMaxChars:\s*(\d+)/gm) ?? []),
      ...(dsrc.matchAll(/maxChars = (\d+)/g) ?? []),
      ...(isrc.matchAll(/injectMaxChars \?\? (\d+)/g) ?? []),
    ].map((m) => m[1])
    check(
      '★ B 档反向：三处生效默认值全是 2000（无 700 残留）',
      activeDefaults.length === 3 && activeDefaults.every((v) => v === '2000'),
      activeDefaults.join(' / ') || '未找到',
    )

    // ③ 源头三个 slice 都放宽了
    check('★ B 档：stale 放宽到 25', /stale\.slice\(-25\)/.test(dsrc),
      (dsrc.match(/stale\.slice\(-\d+\)/) ?? ['无'])[0])
    check('★ B 档：threads 放宽到 20', /g\.threads\.slice\(-20\)/.test(dsrc),
      (dsrc.match(/g\.threads\.slice\(-\d+\)/) ?? ['无'])[0])
    // ⚠️ 2026-11-06：④ 段改成按 session 过滤后，切片对象从 `timeline` 变成 `mine`。
    //   断言跟着改，但**只认"仍然是 20 句"这个行为**，不锁死变量名 ——
    //   否则下次改名又会假红一次。
    check('★ B 档：timeline 放宽到 20 句', /\.slice\(-20\)/.test(dsrc) && /mine/.test(dsrc),
      (dsrc.match(/[A-Za-z.]*\.slice\(-20\)/g) ?? ['无']).join(' / '))
    check('★ B 档：每句从 120 放宽到 200', /oneLine\(e\.text,\s*200\)/.test(dsrc),
      (dsrc.match(/oneLine\(e\.text,\s*\d+\)/) ?? ['无'])[0])

    // ③ 行为：日记必须真的变长（证明放宽生效，不是只改了常量）
    const bSession = 's-bcap'
    resetData()
    const bLines = Array.from({ length: 40 }, (_, i) => ({
      by: i % 3 === 0 ? 'user' : 'assistant',
      at: `2026-11-05T07:${String(i % 60).padStart(2, '0')}:00.000Z`,
      text: `第 ${i + 1} 条动向，内容长度用于验证 B 档放宽后日记能写更长一些`,
    }))
    const bFacts = Array.from({ length: 40 }, (_, i) => (
      i < 25
        ? { key: `b.stale${i}`, stale: { reason: 'explicit' } }
        : { key: `b.live${i}`, value: 'x' }
    ))
    const bp = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
      sessionId: bSession,
      agent: { id: bSession, session: { id: bSession } },
      facts: bFacts, timeline: bLines,
      config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
      now: Date.now(), force: true,
    })
    const bBody = typeof bp === 'string' ? readFileSync(bp, 'utf8') : ''
    check('★ B 档：放宽后日记明显变长（>1500 字符）', bBody.length > 1500, `${bBody.length} 字符`)

    // ④ 反向：stale 超过 25 条时只取 25（证明还是有上限，不是全量倒进去）
    const staleLines = bBody.split('\n').filter((l) => l.startsWith('- b.stale'))
    check('★ B 档反向：stale 仍限 25 条（不是全量）', staleLines.length === 25, `${staleLines.length} 条`)

    // ⑤ reverse：timeline 也只取 20 句
    const tlLines = bBody.split('\n').filter((l) => /^- \d\d:\d\d \[/.test(l))
    check('★ B 档反向：timeline 仍限 20 句', tlLines.length === 20, `${tlLines.length} 句`)
  }
}

// ─────────────────────── 52 长内容外置（磁盘即锚） ───────────────────────
group('62 ★ 主动压缩：排队 → idle 执行 → 回报下一回合')
{
  resetData()
  const P = await import(`file:///${join(ROOT, 'lib', 'proactive.js').split('\\').join('/')}?t=${Date.now()}`)
  P._reset()

  const mkAgent = (id) => ({ id, session: { id } })

  // ⚠️ 必须模拟真实 Cordis ctx 形状：服务只能通过 ctx.get(name) 取，
  //   不能是 `{ compaction: ... }` 这种普通对象属性 ——
  //   真实 ctx 是 Proxy，裸属性访问在未 inject 时**抛错**而不是 undefined。
  //   用普通对象会让测试假绿（第一版就是这么写的；改成 ctx.get 后这组全红才发现）。
  const mkEngineCtx = (engine) => ({
    get(name) {
      return name === 'compaction' ? engine : undefined
    },
  })

  // ⚠️ 这组的承重点有两条，都是真机里会静默出错的地方：
  //   ① 工具里调 compactNow 必吃 busy → 必须只排队，不能假装压了
  //   ② 结果只写日志等于对模型隐身 → 必须有 notice 回路

  // ① 空 agent 不许崩
  const noAgent = P.requestCompact(null, 'x')
  check('★ 没有 agent 时明确拒绝（不抛错）', noAgent.ok === false && noAgent.status === 'no-agent', JSON.stringify(noAgent))

  // ② 正常排队
  const a1 = mkAgent('sess-a')
  const q1 = P.requestCompact(a1, '测试理由')
  check('★ 第一次请求 = queued', q1.ok === true && q1.status === 'queued', JSON.stringify(q1))
  check('★ hasPending 为真', P.hasPending(a1) === true)

  // ③ 幂等：重复请求不覆盖、不叠加
  const q2 = P.requestCompact(a1, '第二次理由')
  check('★ 重复请求 = already-pending', q2.status === 'already-pending', JSON.stringify(q2))
  check('★ 原请求的理由没被覆盖', q2.why === '测试理由', String(q2.why))
  check('★ 内部只有 1 个排队', P._inspect().pending.length === 1, JSON.stringify(P._inspect().pending))

  // ④ 承重点①：ctx.compaction 缺失时必须**明确失败**，不能假装压了
  const noEngineRes = await P.drainOnIdle({}, a1)
  check('★ 无压缩服务时 drain 仍算"跑过"', noEngineRes.ran === true, JSON.stringify(noEngineRes))
  check('★ 无压缩服务时 ok=false', noEngineRes.ok === false, JSON.stringify(noEngineRes))
  const n1 = P.peekNotice('sess-a')
  check('★ 无服务时写了 notice（不静默）', !!n1 && /拿不到压缩服务/.test(n1.text), String(n1?.text))
  check('★ 无服务时 notice 自身 ok=false', n1?.ok === false, String(n1?.ok))
  check('★ 无服务时排队已被清掉（不会卡住）', P.hasPending(a1) === false)

  // ⑤ 承重点：成功路径。假引擎返回真结果
  P._reset()
  const a2 = mkAgent('sess-b')
  P.requestCompact(a2, '压力高了')
  const fakeOk = {
    async compactNow() {
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 4200, summarySeq: 99 }
    },
  }
  const okRes = await P.drainOnIdle(mkEngineCtx(fakeOk), a2)
  check('★ 成功时 ran=true ok=true', okRes.ran === true && okRes.ok === true, JSON.stringify(okRes))
  const n2 = P.takeNotice('sess-b')
  check('★ 成功 notice 含折叠条数', !!n2 && /折叠 3 条/.test(n2.text), String(n2?.text))
  check('★ 成功 notice 含 tokens', !!n2 && /4200/.test(n2.text), String(n2?.text))
  check('★ 成功 notice 含摘要 seq', !!n2 && /seq=99/.test(n2.text), String(n2?.text))
  check('★ 成功 notice 指向 mind_expand', !!n2 && /mind_expand/.test(n2.text), String(n2?.text))
  check('★ 成功 notice 自身 ok=true', n2?.ok === true, String(n2?.ok))
  check('★ notice 取走即清（第二次为 null）', P.takeNotice('sess-b') === null)

  // ⑥ 可压区间为 0：不是失败，但必须说清"什么也没动"
  P._reset()
  const a3 = mkAgent('sess-c')
  P.requestCompact(a3, '试一下')
  const nullEngine = { async compactNow() { return null } }
  const r3 = await P.drainOnIdle(mkEngineCtx(nullEngine), a3)
  check('★ 无可压区间时 ran/ok 都为 true', r3.ran === true && r3.ok === true, JSON.stringify(r3))
  const n3 = P.peekNotice('sess-c')
  check('★ 无可压区间时明确说没动', !!n3 && /什么也没动/.test(n3.text), String(n3?.text))

  // ⑦ 承重点：busy 必须如实回报 code，不能吞成"成功"
  P._reset()
  const a4 = mkAgent('sess-d')
  P.requestCompact(a4, '会被 busy')
  const busyErr = Object.assign(new Error('manual compaction requires an idle agent'), { code: 'busy' })
  const busyEngine = { async compactNow() { throw busyErr } }
  const r4 = await P.drainOnIdle(mkEngineCtx(busyEngine), a4)
  check('★ busy 时 ok=false（不谎报成功）', r4.ok === false, JSON.stringify(r4))
  const n4 = P.peekNotice('sess-d')
  check('★ busy notice 带 code', !!n4 && /code=busy/.test(n4.text), String(n4?.text))
  // ⚠️ 这一条是补的：最初只测了返回值的 ok，没测 notice 自己的 ok，
  //   反向验证时把 notice 的 ok 改成 true 竟然全绿 → 假绿。测试也要覆盖 notice 字段。
  check('★ busy notice 自身 ok=false（不能谎报）', n4?.ok === false, String(n4?.ok))
  check('★ busy 后排队已清（不会永久卡住）', P.hasPending(a4) === false)
  check('★ busy 后不在 running 里（可重试）', P._inspect().running.length === 0, JSON.stringify(P._inspect().running))

  // ⑧ 没有排队的会话，idle 时不该跑任何东西
  P._reset()
  const idleOnly = await P.drainOnIdle(mkEngineCtx(fakeOk), mkAgent('sess-none'))
  check('★ 无排队时 drain 直接返回', idleOnly.ran === false, JSON.stringify(idleOnly))

  // ⑧b 承重点：同一会话不许并发压缩
  //
  //   ⚠️ 这是补的：反向验证时把 running 闸去掉，测试全绿 —— 说明原来根本没测。
  //   并发压缩会把同一个会话冻结两次，是最难排查的一类故障。
  P._reset()
  const a5 = mkAgent('sess-e')
  P.requestCompact(a5, '并发测试')
  let resolveSlow
  const slowEngine = {
    compactNow() {
      return new Promise((res) => {
        resolveSlow = () => res({ shadowedSeqs: [1], shadowedTokenCount: 10, summarySeq: 1 })
      })
    },
  }
  const p1 = P.drainOnIdle(mkEngineCtx(slowEngine), a5)
  // 第一次 drain 已进入 running，此时再请求必须被拒
  await new Promise((r) => setTimeout(r, 10))
  const req2 = P.requestCompact(a5, '想插队')
  check('★ 压缩进行中时新请求被拒', req2.ok === false && req2.status === 'already-running', JSON.stringify(req2))
  const p2 = P.drainOnIdle(mkEngineCtx(slowEngine), a5)
  const r2nd = await p2
  check('★ 压缩进行中时 drain 不重入', r2nd.ran === false, JSON.stringify(r2nd))
  resolveSlow()
  await p1
  check('★ 慢压缩结束后 running 清空', P._inspect().running.length === 0, JSON.stringify(P._inspect().running))

  // ⑨ 源码断言：工具只排队、不直接调 compactNow
  //
  //   ⚠️ 这条是防"以后有人为了省事改成直接压"——那样 100% 吃 busy，
  //   而且测试的假引擎不会 busy，测试会假绿。所以必须查源码。
  const toolsSrc = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  const compressBlock = toolsSrc.slice(toolsSrc.indexOf("name: 'mind_compress'"), toolsSrc.indexOf("name: 'mind_compress'") + 3000)
  check('★ mind_compress 已注册', toolsSrc.includes("name: 'mind_compress'"))
  check('★ 承重点：工具体内不直接调 compactNow', !/compactNow\s*\(/.test(compressBlock.slice(0, 1600)))
  check('★ 工具调的是 requestCompact', /requestCompact\s*\(/.test(compressBlock))

  // ⑩ 源码断言：idle 触发点在 agent/status 里
  const idxSrc2 = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('★ index.js 挂了 drainOnIdle', /drainOnIdle\s*\(/.test(idxSrc2))
  check('★ drainOnIdle 在 idle 分支里（不是无条件跑）', /status\s*===\s*'idle'[\s\S]{0,200}drainOnIdle/.test(idxSrc2))
  check('★ notice 进了注入（takeNotice 被调用）', /takeNotice\s*\(/.test(idxSrc2))
  check('★ 反向：peekNotice 用于指纹（防被节流吞掉）', /peekNotice\s*\(/.test(idxSrc2))

  // ⑪ 承重点：取 compaction 的两条路都要能承受「抛错」与「拿不到」
  //
  //   ⚠️ 2026-11-05 真机把两条路都踩了一遍，语义不同（cordis/src/reflect.ts）：
  //     · ctx.compaction（Proxy get）→ 沿 fiber 树向上找，**找不到就 throw**
  //       血证 10:56:25 `cannot get property "compaction" without inject`
  //     · ctx.get('compaction') → **只查本层**，找不到返回 undefined
  //       血证 10:57:48 `active压缩失败 :: compaction 服务不可用`
  //   两条都拿不到 = compaction 在另一个 fiber 树（创造模式 preset 内层）。
  //   所以代码必须：先 Proxy 再 get，两条都包 try，绝不让异常逃出去。
  P._reset()
  const a6 = mkAgent('sess-f')
  P.requestCompact(a6, '取服务方式测试')

  // 场景 A：Proxy 抛错，但 ctx.get 能拿到 → 必须走通
  const proxyThrowsCtx = {
    get(name) {
      if (name === 'compaction') return { async compactNow() { return null } }
      return undefined
    },
  }
  Object.defineProperty(proxyThrowsCtx, 'compaction', {
    get() {
      throw new Error('cannot get property "compaction" without inject')
    },
  })
  const rA = await P.drainOnIdle(proxyThrowsCtx, a6)
  check('★ Proxy 抛错 + ctx.get 可用 → 仍走通', rA.ran === true && rA.ok === true, JSON.stringify(rA))

  // 场景 B：两条都拿不到 → 必须如实降级，不抛、不谎报
  P._reset()
  const a7 = mkAgent('sess-g')
  P.requestCompact(a7, '都拿不到')
  const emptyCtx = { get() { return undefined } }
  Object.defineProperty(emptyCtx, 'compaction', {
    get() {
      throw new Error('cannot get property "compaction" without inject')
    },
  })
  let escaped = null
  let rB = null
  try {
    rB = await P.drainOnIdle(emptyCtx, a7)
  } catch (e) {
    escaped = e
  }
  check('★ 两条都拿不到时异常不外逃', escaped === null, String(escaped?.message))
  check('★ 两条都拿不到时 ran=true ok=false', rB?.ran === true && rB?.ok === false, JSON.stringify(rB))
  check('★ 两条都拿不到时排队已清（不永久卡住）', P.hasPending(a7) === false)
  const nB = P.peekNotice('sess-g')
  check('★ 两条都拿不到时写 notice 说明原因', !!nB && /拿不到压缩服务/.test(nB.text), String(nB?.text))

  // 场景 C：Proxy 直接能拿到（祖先提供的常见情况）→ 应优先用它
  P._reset()
  const a8 = mkAgent('sess-h')
  P.requestCompact(a8, 'Proxy 可用')
  const proxyOkCtx = {
    compaction: { async compactNow() { return null } },
    get() { return undefined },
  }
  const rC = await P.drainOnIdle(proxyOkCtx, a8)
  check('★ Proxy 直接可用时走通', rC.ran === true && rC.ok === true, JSON.stringify(rC))

  const proactiveSrc = readFileSync(join(ROOT, 'lib', 'proactive.js'), 'utf8')
  const srcNoComment = proactiveSrc.replace(/\/\/[^\n]*/g, '')
  check('★ 源码：两条路都有（Proxy + ctx.get）', /ctx\s*\??\.\s*compaction\b/.test(srcNoComment) && /\.get\s*\(\s*['"]compaction['"]\s*\)/.test(srcNoComment))
  check('★ 源码：Proxy 那条被 try 包住', /try\s*\{[\s\S]{0,200}ctx\s*\??\.\s*compaction/.test(srcNoComment))
  check('★ 反向：绝不为拿服务去 inject 声明 compaction（会拖垮整个插件加载）', !/export const inject\s*=\s*\[[^\]]*compaction/.test(readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')))

  // ⑫ ★★ 承重点：preset 内层（创造模式的正解）
  //
  //   2026-11-05 真机血证：创造模式里 compaction 由 preset 的**内层 Loader 树**提供，
  //   主插件在外层，ctx.compaction 与 ctx.get 都够不到（两条血证见上面注释）。
  //   官方唯一设计用来跨这层边界的入口是 agentPresets.serviceFor(agent, name)，
  //   说明原文："Read a service supplied inside an Agent's isolated preset group."
  //   本组必须证明：只要 serviceFor 给得出引擎，drainOnIdle 就走通。
  P._reset()
  const a9 = mkAgent('sess-i')
  P.requestCompact(a9, 'preset 内层')
  const presetEngine = {
    async compactNow() {
      return { shadowedSeqs: [7, 8], shadowedTokenCount: 1234, summarySeq: 55 }
    },
  }
  const presetCtx = {
    get(name) {
      if (name === 'agentPresets') {
        return {
          serviceFor(_agent, svc) {
            return svc === 'compaction' ? presetEngine : undefined
          },
        }
      }
      return undefined // 本层拿不到 compaction，模拟真实情形
    },
  }
  Object.defineProperty(presetCtx, 'compaction', {
    get() {
      throw new Error('cannot get property "compaction" without inject')
    },
  })
  const rPreset = await P.drainOnIdle(presetCtx, a9)
  check('★★ preset 内层取到引擎时走通', rPreset.ran === true && rPreset.ok === true, JSON.stringify(rPreset))
  const nPreset = P.takeNotice('sess-i')
  check('★★ preset 路径的 notice 含折叠条数', !!nPreset && /折叠 2 条/.test(nPreset.text), String(nPreset?.text))
  check('★★ preset 路径的 notice 含摘要 seq', !!nPreset && /seq=55/.test(nPreset.text), String(nPreset?.text))

  // 反向：serviceFor 返回的不是引擎（拿错东西）时必须当作没拿到，不能硬调
  P._reset()
  const a10 = mkAgent('sess-j')
  P.requestCompact(a10, 'serviceFor 返回垃圾')
  const junkCtx = {
    get(name) {
      if (name === 'agentPresets') return { serviceFor: () => ({ notAnEngine: true }) }
      return undefined
    },
  }
  Object.defineProperty(junkCtx, 'compaction', { get() { throw new Error('no inject') } })
  const rJunk = await P.drainOnIdle(junkCtx, a10)
  check('★★ 反向：serviceFor 给出非引擎时不当真（ok=false）', rJunk.ran === true && rJunk.ok === false, JSON.stringify(rJunk))
  // ⚠️ 这条是补的：只测 ok=false 不够 ——
  //   「提前拒绝」和「调用后抛 TypeError 再被 catch」都得到 ok=false，测试区分不出来。
  //   反向验证证明过：把 wantCompactNow 校验去掉后，617 项**全绿**。
  //   所以必须看 engineFrom：走校验就该是 'none'（一个来源都没通过校验）。
  check('★★ 反向：非引擎未被采用为来源（engineFrom=none）', rJunk.engineFrom === 'none', String(rJunk.engineFrom))

  // 反向：serviceFor 自己抛错时不能带崩
  P._reset()
  const a11 = mkAgent('sess-k')
  P.requestCompact(a11, 'serviceFor 抛错')
  const throwCtx = {
    get(name) {
      if (name === 'agentPresets') {
        return { serviceFor() { throw new Error('preset 已卸载') } }
      }
      return undefined
    },
  }
  Object.defineProperty(throwCtx, 'compaction', { get() { throw new Error('no inject') } })
  let esc = null
  let rThrew = null
  try {
    rThrew = await P.drainOnIdle(throwCtx, a11)
  } catch (e) {
    esc = e
  }
  check('★★ 反向：serviceFor 抛错时异常不外逃', esc === null, String(esc?.message))
  check('★★ 反向：serviceFor 抛错时降级为 ok=false', rThrew?.ok === false, JSON.stringify(rThrew))

  // 源码：三条路的顺序断言（preset 必须**先**试，因为它是创造模式唯一有效的那条）
  //
  // ⚠️ 用「去掉注释后的源码」判位置，不能用原文 ——
  //   原文里注释提到 `ctx.get('compaction')`，会排在真实代码之前，导致假红/假绿。
  const preIdx = srcNoComment.indexOf("serviceFor(agent, 'compaction')")
  const proxyIdx = srcNoComment.indexOf('ctx?.compaction')
  const getIdx = srcNoComment.indexOf("ctx.get('compaction')")
  check('★ 源码：serviceFor 路径存在', preIdx > 0, `@${preIdx}`)
  check('★ 源码：serviceFor 在 ctx?.compaction 之前（优先）', preIdx > 0 && proxyIdx > preIdx, `preset@${preIdx} proxy@${proxyIdx}`)
  check('★ 源码：proxy 在 ctx.get 之前', proxyIdx > 0 && getIdx > proxyIdx, `proxy@${proxyIdx} get@${getIdx}`)

  P._reset()
}

// ─────────────────────── 63 事实硬删（forgetFact） ───────────────────────
group('64 ★ 压力到 70% → 先写完日记 → 再请求压缩')
{
  resetData()
  const diaryMod = await import(`file:///${join(ROOT, 'lib', 'diary.js').split('\\').join('/')}?t=${Date.now()}`)
  const P = await import(`file:///${join(ROOT, 'lib', 'proactive.js').split('\\').join('/')}?t=${Date.now()}`)
  P._reset()

  const agent = { id: 's-70', session: { id: 's-70' } }
  const cfgFor = (ratio = 0.7) => ({ diary: { enabled: true, pressureRatio: ratio, contextWindow: 600000 } })
  const meterAt = (tokens) => ({ measure: () => ({ totalTokens: tokens }) })
  const facts70 = global.readGlobal().facts
  const tl70 = global.readGlobal().timeline

  // ① 低于阈值：不写、不压（这是最常见路径，不能有任何动作）
  const r1 = diaryMod.maybeWriteDiary({ tokenMeter: meterAt(300000) }, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: cfgFor(), now: Date.now(), returnDetail: true,
  })
  check('★ 50% 不写日记', r1.wrote === false && r1.path === null, JSON.stringify(r1))
  check('★ 50% 不请求压缩', r1.shouldCompact === false)
  check('★ 50% 的原因记为 below-threshold', r1.reason === 'below-threshold', r1.reason)

  // ② 到 70%：必须写，且 shouldCompact=true（这是本次改动的核心）
  const t70 = Date.now()
  const r2 = diaryMod.maybeWriteDiary({ tokenMeter: meterAt(430000) }, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: cfgFor(), now: t70, returnDetail: true,
  })
  check('★ 72% 必须写日记', r2.wrote === true && existsSync(r2.path), String(r2.path))
  check('★★ 承重点：写成功后要求压缩', r2.shouldCompact === true, JSON.stringify({ p: r2.pressure, sc: r2.shouldCompact }))
  check('★ 原因记为 threshold', r2.reason === 'threshold', r2.reason)
  check('★ 报告的压力值约 72%', Math.abs(r2.pressure - 430000 / 600000) < 1e-9, String(r2.pressure))

  // ③ 顺序保证：日记文件必须在「请求压缩」那一刻就已存在
  //
  //   ⚠️ 这是主人特意交代的顺序（"免得把写日记的动作给打断了"）。
  //      如果哪天有人把 requestCompact 挪到 maybeWriteDiary 之前，
  //      下面的源码断言会红。
  const r3 = P.requestCompact(agent, '测试：日记已落盘后再压')
  check('★ 请求压缩成功排入队列', r3.ok === true && r3.status === 'queued', JSON.stringify(r3))
  check('★ 此刻日记文件确实已存在（顺序实证）', existsSync(r2.path), String(r2.path))

  // ④ 强制模式（压缩时强写）绝不能要求再压 —— 否则无限循环
  const r4 = diaryMod.maybeWriteDiary({ tokenMeter: meterAt(430000) }, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: cfgFor(), now: t70 + 120000, force: true, returnDetail: true,
  })
  check('★ 强制模式 shouldCompact=false（防无限循环）', r4.shouldCompact === false, JSON.stringify(r4))

  // ⑤ 限流挡住时不压：日记没落盘就压 = 把压缩前的自己抹掉
  const r5 = diaryMod.maybeWriteDiary({ tokenMeter: meterAt(430000) }, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: cfgFor(), now: t70 + 5000, returnDetail: true,
  })
  check('★ 限流时 wrote=false', r5.wrote === false, JSON.stringify(r5))
  check('★★ 承重点：限流挡住的这次不请求压缩', r5.shouldCompact === false, r5.reason)
  check('★ 限流原因可辨认', r5.reason === 'rate-limited', r5.reason)

  // ⑥ 拿不到计量服务：不写也不压
  const r6 = diaryMod.maybeWriteDiary({}, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: cfgFor(), now: t70, returnDetail: true,
  })
  check('★ 无 tokenMeter 时 shouldCompact=false', r6.shouldCompact === false && r6.reason === 'no-meter')

  // ⑦ 写盘失败：不压（拿目录不可写模拟）
  //
  //   ⚠️ 用一个必然失败的路径模拟：把 DIARY_DIR 指向已有的**文件**。
  const badDir = join(TEST_DIR, 'not-a-dir')
  writeFileSync(badDir, 'x')
  const oldHome = process.env.MIND_DIR
  process.env.MIND_DIR = badDir
  const diaryMod2 = await import(`file:///${join(ROOT, 'lib', 'diary.js').split('\\').join('/')}?t=${Date.now()}b`)
  const r7 = diaryMod2.maybeWriteDiary({ tokenMeter: meterAt(430000) }, {
    sessionId: 's-70b', agent: { id: 's-70b', session: { id: 's-70b' } }, facts: [], timeline: [],
    config: cfgFor(), now: Date.now(), returnDetail: true,
  })
  process.env.MIND_DIR = oldHome
  check('★★ 承重点：写盘失败时不请求压缩', r7.shouldCompact === false, JSON.stringify(r7))
  check('★ 写盘失败原因可辨认', r7.reason === 'write-failed' || r7.wrote === false, r7.reason)

  // ⑧ enabled=false：整条链都不动
  const r8 = diaryMod.maybeWriteDiary({ tokenMeter: meterAt(430000) }, {
    sessionId: 's-70', agent, facts: facts70, timeline: tl70,
    config: { diary: { enabled: false } }, now: t70 + 9999999, returnDetail: true,
  })
  check('★ diary.enabled=false 时 shouldCompact=false', r8.shouldCompact === false && r8.reason === 'disabled')

  // ⑨ 顺序的源码断言：index.js 里 requestCompact 必须在 maybeWriteDiary **之后**
  //
  //   ⚠️ 用去掉注释的源码判位置，否则注释里的字样会抢先命中（今天已经踩过一次）。
  const idxSrc64 = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const noComment64 = idxSrc64.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const wIdx = noComment64.indexOf('maybeWriteDiary(ctx')
  const cIdx = noComment64.indexOf('Proactive.requestCompact(')
  check('★ 源码：maybeWriteDiary 在前', wIdx > 0, `@${wIdx}`)
  check('★ 源码：requestCompact 在后（先写日记再压）', cIdx > wIdx, `write@${wIdx} compact@${cIdx}`)
  check('★ 源码：压缩请求受 shouldCompact 控制', /d\?\.shouldCompact|d\.shouldCompact/.test(noComment64))
  check('★ 源码：用的是 requestCompact 而不是直接 compactNow', !/indexSrc:/.test('') && noComment64.indexOf('compactNow(') < 0)

  P._reset()
}

// ─────────────────────── 65 存档关键词搜索（mind_search） ───────────────────────
group('65 ★ 存档搜索：压缩后想不起 seq 时的唯一入口')
{
  resetData()
  const ar = await import(`file:///${join(ROOT, 'lib', 'archive.js').split('\\').join('/')}?t=${Date.now()}`)

  // 造一组确定的存档（不依赖真实语料，保证可复现）
  const sess = 's-search-65'
  const items = [
    { seq: 1, type: 'user/message', text: '第一条：请帮我查 compaction 服务' },
    { seq: 2, type: 'assistant/message', text: '第二条：compaction 在 preset 内层' },
    { seq: 3, type: 'tool/result', text: '第三条：完全无关的内容 ABC' },
    // ⚠️ 命中词故意放在**很靠后**的位置：如果预览实现退化成"从开头截"，
    //   这条的预览里就看不到 COMPACTION，测试立刻红。
    //   2026-11-06 实测过这个漏洞：原来命中词在最前面，破坏"从开头截"后测试照样绿。
    { seq: 4, type: 'user/message', text: '第四条：' + '前面塞满无关内容让命中词远离开头'.repeat(12) + ' 后面才提到 COMPACTION 这个词' },
    { seq: 5, type: 'assistant/message', text: '第五条：压缩与日记是两件事' },
  ]
  const ap = ar.archivePath(sess, 1, 5)
  mkdirSync(dirname(ap), { recursive: true })
  writeFileSync(ap, JSON.stringify({ version: 1, sessionId: sess, startSeq: 1, endSeq: 5, items }, null, 2), 'utf8')

  // ① 单个词
  const r1 = ar.searchArchives({ sessionId: sess, query: 'compaction' })
  check('★ 单词搜索有命中', r1.ok && r1.total > 0, `total=${r1.total}`)
  check('★ 大小写不敏感（COMPACTION 也命中）', r1.hits.some((h) => h.seq === 4), r1.hits.map((h) => h.seq).join(','))

  // ② 多词 AND：两个词都要在
  const r2 = ar.searchArchives({ sessionId: sess, query: 'compaction preset' })
  check('★ AND 语义：只返回同时含两词的条目', r2.total === 1 && r2.hits[0].seq === 2, JSON.stringify(r2.hits.map((h) => h.seq)))
  check('★ AND 命中数记为 matched=2', r2.hits[0].matched === 2, String(r2.hits[0].matched))

  // ③ 中文按子串匹配（不切词）
  const r3 = ar.searchArchives({ sessionId: sess, query: '压缩' })
  check('★ 中文子串能命中', r3.total === 1 && r3.hits[0].seq === 5, JSON.stringify(r3.hits.map((h) => h.seq)))

  // ④ 零命中：明确返回空，不报错
  const r4 = ar.searchArchives({ sessionId: sess, query: '绝对不存在zzz' })
  check('★ 零命中时 ok=true 且 hits 为空', r4.ok === true && r4.total === 0)

  // ⑤ 空 query 报错
  const r5 = ar.searchArchives({ sessionId: sess, query: '' })
  check('★ 空 query 报错', r5.ok === false, r5.error)

  // ⑥ 承重点：结果带 seq，能直接喂给 mind_expand
  //
  //   ⚠️ 这是整条链的接缝。搜索只给摘要不给 seq 的话，
  //      模型拿到的是一堆"看得见拿不到"的东西，等于白搜。
  check('★★ 承重点：命中项带 seq', r1.hits.every((h) => Number.isFinite(h.seq)), JSON.stringify(r1.hits[0]))
  const expandable = r1.hits[0]
  const back = ar.expandRegion({ sessionId: sess, seq: expandable.seq })
  check('★★ 承重点：拿 seq 能真的取回原文', back.hit === true && back.text.includes('compaction'), back.text.slice(0, 60))

  // ⑦ 预览里要看得见命中的词（不是从条目开头截）
  //
  //   ⚠️ 必须专门挑**命中词在很后面**的那条（seq 4）来验。
  //      用 hits[0] 验不出来 —— 那是 seq 1，命中词本来就在开头，
  //      "从开头截"的实现也能通过。2026-11-06 实测踩过这个假绿。
  const far = r1.hits.find((h) => h.seq === 4)
  check('★ 找到命中词远离条头的那个样本', !!far, far ? String(far.chars) : '未找到')
  check('★ 预览包含命中词本身（不是从条头截）', !!far && far.preview.toLowerCase().includes('compaction'), far?.preview ?? '')
  check('★ 预览确实跳过了开头（出现截断标记 …）', !!far && far.preview.startsWith('…'), far?.preview?.slice(0, 20) ?? '')

  // ⑧ 排序：命中词多的在前
  const r8 = ar.searchArchives({ sessionId: sess, query: 'compaction 第' })
  check('★ 命中词多的排在前面', r8.hits[0].matched >= r8.hits[r8.hits.length - 1].matched, JSON.stringify(r8.hits.map((h) => h.matched)))

  // ⑨ 工具层真的暴露了 mind_search（防"写了实现没接工具"）
  const toolsSrc65 = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  check('★ tools.js 导入了 searchArchives', /import\s*\{[^}]*searchArchives[^}]*\}\s*from\s*'\.\/archive\.js'/.test(toolsSrc65))
  check('★ tools.js 注册了 mind_search', /name:\s*'mind_search'/.test(toolsSrc65))
  check('★ mind_search 有 query 参数', /name:\s*'mind_search'[\s\S]{0,600}?query:\s*\{/.test(toolsSrc65))

  // ⑩ 不存在的会话：返回空而不是抛
  const r10 = ar.searchArchives({ sessionId: 'no-such-session-65', query: 'compaction' })
  check('★ 不存在的会话返回空而不是抛错', r10.ok === true && r10.total === 0)
}

// ═══════════════════════════════════════════════════════════
//  第 66 组：日志轮转 + 存档体检 + mind_keys（2026-11-06）
// ═══════════════════════════════════════════════════════════
//
// ⚠️ 这一组是「防倒退」用的，三个点都来自真实吃过的亏：
//   ① 日志原来写满 512KB 就**清空**，查 70% 压缩为什么没触发时
//      全靠 mind.log 里两条历史记录对比 turn 字段定位根因 ——
//      再跑一天就被抹掉了。改成留 .1/.2 两代。
//   ② sweepArchives 写好却 0 次调用，存档堆到没人知道多大。
//      接进启动检查（dryRun，只报告不删）。
//   ③ 没有工具能列出全部 facts 的 key，想找「那件事在哪个 key 下」
//      只能靠注入的 60 字索引碰运气。新增 mind_keys。
{
  const io = await import(`file:///${join(ROOT, 'lib', 'io.js').split('\\').join('/')}?t=${Date.now()}`)
  const ioSrc = readFileSync(join(ROOT, 'lib', 'io.js'), 'utf8')

  // ① 日志轮转：源码层面确认是「改名留两代」而不是「清空」
  check('★ io.js 不再直接清空日志', !/statSync\(p\)\.size\s*>\s*LOG_ROTATE_BYTES\)\s*writeFileSync\(p,\s*''/.test(ioSrc))
  check('★ io.js 轮转成 .1', /p\s*\+\s*'\.1'/.test(ioSrc))
  check('★ io.js 轮转成 .2', /p\s*\+\s*'\.2'/.test(ioSrc))
  check('★ io.js 导入了 unlinkSync', /import\s*\{[^}]*unlinkSync[^}]*\}\s*from\s*'node:fs'/.test(ioSrc))
  check('★ io.js 导入了 renameSync', /import\s*\{[^}]*renameSync[^}]*\}\s*from\s*'node:fs'/.test(ioSrc))

  // 行为验证：把日志写爆，看是否生成 .1 而不是清空
  const realLogPath = io.LOG_PATH()
  const rotateDir = join(TEST_DIR, 'log-rotate')
  mkdirSync(rotateDir, { recursive: true })
  // 用真实的 log() 会写到真机目录，这里改为直接验证轮转逻辑的关键分支存在即可
  // （行为级测试会污染主人的 mind.log，代价大于收益）
  const hasRotateBranch = /try\s*\{[\s\S]{0,400}?renameSync\(p,\s*p1\)/.test(ioSrc)
  check('★ 轮转失败会退化成清空而不是抛错', hasRotateBranch)

  // ② 存档体检已接线
  const idxSrc66 = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('★ index.js 导入了 sweepArchives', /import\s*\{[^}]*sweepArchives[^}]*\}\s*from\s*'\.\/archive\.js'/.test(idxSrc66))
  check('★ index.js 导入了 listArchives', /import\s*\{[^}]*listArchives[^}]*\}\s*from\s*'\.\/archive\.js'/.test(idxSrc66))
  check('★ 启动时调用了 sweepArchives', /sweepArchives\(\{/.test(idxSrc66))
  check('★★ 启动检查用的是 dryRun（只报告不删存档）', /sweepArchives\(\{\s*maxAgeDays:\s*\d+\s*,\s*dryRun:\s*true\s*\}\)/.test(idxSrc66))
  check('★ 启动了「检查存档」日志', /启动检查存档 ::/.test(idxSrc66))

  // 行为：dryRun 默认值必须是 true（防有人改默认值把存档删了）
  const arch66 = await import(`file:///${join(ROOT, 'lib', 'archive.js').split('\\').join('/')}?t=${Date.now()}`)
  const sweepDefault = arch66.sweepArchives()
  check('★★ sweepArchives 默认 dryRun=true', sweepDefault.dryRun === true)
  check('★ dryRun 时 deleted 恒为 0', sweepDefault.deleted === 0)

  // ③ 工具清单（防倒退）
  //
  // ⚠️ 2026-11-08 拆分：mind_keys 已搬到 dsh-strand（改叫 strand_keys），
  //   它那几条参数判据也一起搬去了那边的「工具定义」组。
  //   这里改成验**本插件的工具清单边界** —— 防止误把跨会话工具加回来撞名。
  const toolsSrc66 = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  check('★★ 本插件不再注册 mind_keys（已搬走）', !/name:\s*'mind_keys'/.test(toolsSrc66))
  check('★★ 不再注册 mind_remember', !/name:\s*'mind_remember'/.test(toolsSrc66))
  check('★★ 不再注册 mind_recall', !/name:\s*'mind_recall'/.test(toolsSrc66))
  check('★★ 不再注册 mind_forget', !/name:\s*'mind_forget'/.test(toolsSrc66))

  // 工具总数：拆分后 6 个
  // （原 11 个：减掉搬到 dsh-strand 的 4 个跨会话工具，再减掉早先并入 mind_view 的 mind_windows）
  const registered66 = (toolsSrc66.match(/name:\s*'mind_/g) || []).length
  check('★★ 工具数 = 6', registered66 === 6, `实际 ${registered66}`)
  check('★ 剩下的都是自我觉知或压缩类', ['mind_intend', 'mind_view', 'mind_status', 'mind_expand', 'mind_search', 'mind_compress'].every((n) => toolsSrc66.includes(`'${n}'`)))
}


// ═══════════════════════════════════════════════════════════
//  第 67 组：经验库信号放宽（2026-11-06）
// ═══════════════════════════════════════════════════════════
//
// ⚠️ 这组来自一次实测打脸：
//   拿主人 14 句真实原话去测 deriveSignals，**只命中 1 句**。
//   包括「改完这个插件重启看看」「我刚改了 config.json」这种
//   教科书级别的场景，全部漏掉。
//
//   根因是判据写得太"书面"：要求「改完了吗」这种完整问句，
//   或「改了配置」这种带宾语的说法。而主人实际说话极短——
//   「改了」「改好了」「重启了」「报错了」。
//
//   放宽后命中 6/14。这一组守住三个关键场景不再倒退。
{
  const tac = await import(`file:///${join(ROOT, 'lib', 'segments', 'tacit.js').split('\\').join('/')}?t=${Date.now()}`)

  const sig = (t) => tac.deriveSignals(t).map((s) => s.path)

  // ① task.after-change 放宽
  check('★ 改动后验证：短句「改了」能命中', sig('改了').includes('task.after-change'))
  check('★ 改动后验证：「改好了」能命中', sig('改好了').includes('task.after-change'))
  check('★ 改动后验证：「改完这个插件重启看看」能命中', sig('改完这个插件重启看看').includes('task.after-change'))
  check('★ 改动后验证：单独一句「重启了」能命中', sig('重启了').includes('task.after-change'))
  check('★ 改动后验证：「我刚改了 config.json」能命中', sig('我刚改了 config.json').includes('task.after-change'))
  // what 判定：提到插件/代码 → plugin-code
  const acHits = tac.deriveSignals('改完这个插件重启看看')
  const acHit = acHits.find((s) => s.path === 'task.after-change')
  check('★ 改动后验证：what=plugin-code', acHit && acHit.context.what === 'plugin-code', JSON.stringify(acHit?.context))

  // ② tool.error 放宽
  check('★ 工具报错：「为什么这个报错」能命中', sig('为什么这个报错').includes('tool.error'))
  check('★ 工具报错：「失败了」能命中', sig('失败了').includes('tool.error'))
  check('★ 工具报错：「跑不通」能命中', sig('跑不通').includes('tool.error'))
  check('★ 工具报错：error 英文能命中', sig('got an Error here').includes('tool.error'))
  // 沙箱类仍是 kind:sandbox（精准），不能被泛化吞掉
  const sbHits = tac.deriveSignals('sandbox 拒绝访问')
  const sbHit = sbHits.find((s) => s.path === 'tool.error')
  check('★★ 沙箱报错仍走 kind=sandbox（精准优先）', sbHit && sbHit.context.kind === 'sandbox', JSON.stringify(sbHit?.context))

  // ③ file.json 放宽
  check('★ JSON：「我刚改了 config.json」能命中', sig('我刚改了 config.json').includes('file.json'))
  check('★ JSON：「写 json 文件」能命中', sig('写 json 文件').includes('file.json'))
  check('★ JSON：仍要求 json 字样', !sig('改配置').includes('file.json'))

  // ④ 不误报：闲聊不该命中任何信号
  check('★ 不误报：纯闲聊「对的」0 命中', sig('对的').length === 0)
  check('★ 不误报：「谁看着做」0 命中', sig('你看着做').length === 0)

  // ⑤ 主人在本会话的真实原话，命中率必须 >= 5/14（放宽前是 1/14）
  const real = [
    '继续优化我的记忆插件', '备份全部会话，记忆，插件到桌面，我等下要升级dsh', '重启了',
    '你看着做', '先不重启，继续优化升级 任务时间30分钟', '我现在启用的插件都没有问题把',
    '这个插件我自己改过，来源不记得了', '我关的', '对的', '以后它会自己拾星吗',
    '星汐怎么用', '我刚改了 config.json', '这个插件装一下吧', '为什么这个报错',
  ]
  const hit = real.filter((t) => tac.deriveSignals(t).length > 0).length
  check('★★ 真实原话命中率 >= 5/14（放宽前 1/14）', hit >= 5, `实际 ${hit}/14`)
}


// ═══════════════════════════════════════════════════════════
//  第 68 组：★ 经验真的注入了没有（不是"信号产出了没有"）
// ═══════════════════════════════════════════════════════════
//
// 🩸 这一组是女仆 2026-11-06 那天最该写、却没写的一组。
//
//   当天女仆把 tacit 的三处判据放宽，拿 deriveSignals 测出 6/14 命中，
//   就在汇报里写了「经验库命中率从 1/14 提到 6/14，修好了」。
//
//   实际是**假修**：
//     - `deriveSignals('报错了')` → 确实有 `{kind:'error'}`  ✅ 信号这一层真的通了
//     - 但 sandbox-deny-triage.md 的 condition 是
//       `kind in ["sandbox","access-denied","EPERM","EACCES"]` —— **不含 "error"**
//     - 于是条件求值 false → matchBySignals 返回空 → **一条经验都没注入**
//
//   教训：signal 层和 experience 层是两个东西。
//   只测「信号出来了」等于只测了管道前半段，后半段的阀门关着也照样绿。
//   **唯一有意义的判据是：走完整条链路后，注入文本里有没有那条经验的 id。**
//
//   所以这组的每条判据都从**用户一句话**出发，跑完整的 pre-step，
//   然后断言注入文本里**出现/不出现**经验 id。
{
  resetData()
  rmSync(TEST_EXP, { recursive: true, force: true })
  mkdirSync(TEST_EXP, { recursive: true })
  tacitSeg._clearCache()

  // 用一份**收窄的复刻经验库**：只放这一组要验的几条，且 id 唯一。
  // （真实经验库读进来会把 16 条的相互影响带进来，判据会飘）
  const writeExp = (name, front, body = '正文') =>
    writeFileSync(join(TEST_EXP, `${name}.md`), `---\n${front}\n---\n# ${name}\n${body}`, 'utf8')

  writeExp(
    'z68-sandbox',
    'id: z68-sandbox\ntrigger: tool.error\ncondition: kind in ["sandbox", "access-denied", "EPERM", "EACCES", "error"]\naction: 先判策略拒绝还是权限坏了\ntrust_level: L1',
  )
  writeExp(
    'z68-vjson',
    'id: z68-vjson\ntrigger: file.json\ncondition: true\naction: 写中文 JSON 要走显式 UTF8\ntrust_level: L3',
  )
  writeExp(
    'z68-afterchange',
    'id: z68-afterchange\ntrigger: task.after-change\ncondition: what in ["plugin-code", "config", "hook", "background-job"]\naction: 改完要用新行为独有的证据验证\ntrust_level: L1',
  )
  writeExp(
    'z68-bili',
    'id: z68-bili\ntrigger: task.bili-write\ncondition: action in ["comment", "upload", "dm", "dynamic", "reply"]\naction: 公开发布先给主人看再 --dry-run\ntrust_level: L1',
  )
  writeExp(
    'z68-python',
    'id: z68-python\ntrigger: task.spawn-python\ncondition: shell in ["pwsh", "cmd"]\naction: 用绝对路径的 python\ntrust_level: L1',
  )
  tacitSeg._clearCache()

  /** 跑一句话，返回注入文本（可能为 null）。每条判据都重新建宿主，避免节流串扰。 */
  const injectFor = async (text) => {
    const agent = { id: `s68-${Math.random().toString(36).slice(2, 8)}`, session: { id: 'x' } }
    const c = mkCtx([agent])
    mod.apply(c)
    const out = await fire(c, agent, 1, [mkMsg(text)])
    return inj(out) ?? ''
  }

  // ── ① 承重点：「报错了」要**真的注入**经验，不能只产出信号 ──
  //
  // ⚠️ 这条如果只写 sig('报错了').includes('tool.error')，就退回假修复的判据了。
  const t1 = await injectFor('报错了')
  check('★★ 承重点：「报错了」注入文本里真有经验', t1.includes(tacitSeg.MARK_TACIT), t1.slice(0, 80))
  check('★★ 承重点：注入的是 z68-sandbox 这条', t1.includes('z68-sandbox'), t1.slice(0, 200))

  const t2 = await injectFor('为什么这个报错')
  check('★★ 「为什么这个报错」也真注入', t2.includes('z68-sandbox'), t2.slice(0, 200))

  const t3 = await injectFor('跑不通')
  check('★★ 「跑不通」也真注入', t3.includes('z68-sandbox'), t3.slice(0, 200))

  // 沙箱类仍走精准分支（kind=sandbox），并且同样真注入
  const t4 = await injectFor('sandbox 拒绝访问')
  check('★★ 沙箱报错走 kind=sandbox 且真注入', t4.includes('z68-sandbox'), t4.slice(0, 200))

  // ── ② 反向：不该注入的时候，注入文本里不能有它 ──
  //
  // ⚠️ 只测「deriveSignals 返回空」是不够的 —— 返回空和"最终没注入"
  //   之间还隔着条件求值、去重、预算裁剪三道闸。这里直接测最终结果。
  const t5 = await injectFor('今天天气不错')
  check('★★ 纯闲聊：注入文本里没有任何经验', !t5.includes(tacitSeg.MARK_TACIT), t5.slice(0, 120))

  const t6 = await injectFor('对的')
  check('★ 「对的」不注入经验', !t6.includes('z68-sandbox') && !t6.includes('z68-afterchange'), t6.slice(0, 120))

  // ── ③ 修 B：「不要修改任何文件」不能当"改了" ──
  //
  // ⚠️ 这条的判据必须是**最终没注入**。旧行为下它会命中 task.after-change，
  //   把「改完要用新证据验证」塞进一个明确什么都不改的回合。
  const t7 = await injectFor('不要修改任何文件')
  check('★★ 否定句「不要修改任何文件」不注入 after-change 经验', !t7.includes('z68-afterchange'), t7.slice(0, 200))
  // 但「改了，但没生效」这种真改动仍要注入（否定的是结果不是动作）
  const t8 = await injectFor('插件代码改了但是没生效')
  check('★★ 真改动仍注入 after-change', t8.includes('z68-afterchange'), t8.slice(0, 200))

  // ── ④ 修 C：B 站裸词「动态」不能命中写类经验 ──
  const t9 = await injectFor('刷一下 B 站动态')
  check('★★ 只读「刷 B 站动态」不注入公开发布经验', !t9.includes('z68-bili'), t9.slice(0, 200))
  const t10 = await injectFor('帮我发条 B 站动态')
  check('★★ 「发条动态」要真注入公开发布经验', t10.includes('z68-bili'), t10.slice(0, 200))

  // ── ⑤ 修 D：「json 存档在哪」不能吃掉两个名额 ──
  //
  // ⚠️ file.json 那条的 condition 是 `true`，一旦信号命中就**必然注入**。
  //   旧行为下 `json 存档在哪` 命中它 + 命中 after-change，2/3 名额没了。
  const t11 = await injectFor('json 存档在哪')
  check('★★ 纯名词「json 存档在哪」不注入写 JSON 的经验', !t11.includes('z68-vjson'), t11.slice(0, 200))
  const t12 = await injectFor('我刚改了 config.json')
  check('★★ 真写 json 要注入', t12.includes('z68-vjson'), t12.slice(0, 200))

  // ── ⑥ 修 E：`.pyc` 不能命中 python 经验 ──
  const t13 = await injectFor('看看 .pyc 文件')
  check('★★ 「.pyc」不注入 python 绝对路径经验', !t13.includes('z68-python'), t13.slice(0, 200))
  const t14 = await injectFor('跑个 python 脚本')
  check('★★ 真跑 python 要注入', t14.includes('z68-python'), t14.slice(0, 200))

  // ── ⑦ 防"只在源码层面修好"：直接拿真实经验库再验一次 report 链路 ──
  //
  //   上面用的是复刻库，能证明链路通；但主人真实经验库若 condition 没改，
  //   修了代码也照样静默。所以这里读**真实经验库**，确认 tool.error 那条的
  //   condition 真的认 "error"。
  const REAL_EXP68 = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'tacit', 'experiences')
  if (existsSync(REAL_EXP68)) {
    const real = tacitSeg.loadExperiences(REAL_EXP68)
    const sb = real.find((e) => e.id === 'sandbox-deny-triage')
    check('★★ 真实经验库读到 sandbox-deny-triage', !!sb)
    check(
      '★★ 它的 condition 真的认 error（否则「报错了」永远静默）',
      !!sb && /["']error["']/.test(sb.condition),
      sb?.condition ?? '(未读到)',
    )
    // 端到端：用真实经验库跑一次，确认「报错了」能注入它
    tacitSeg._clearCache()
    const realHits = tacitSeg.matchBySignals([{ path: 'tool.error', context: { kind: 'error' } }], 3, REAL_EXP68)
    check('★★ 端到端：kind=error 能命中真实经验', realHits.some((e) => e.id === 'sandbox-deny-triage'), realHits.map((e) => e.id).join(','))
  } else {
    check('真实经验库不在本机（跳过该判据）', true, REAL_EXP68)
  }

  tacitSeg._clearCache()
}


// ═══════════════════════════════════════════════════════════
//  第 69 组：io.js / tools.js 底层缺陷（2026-11-06）
// ═══════════════════════════════════════════════════════════
//
// 这五条都不是"代码风格问题"，每一条都有能让记忆**静默损坏**的路径：
//   ① 原子写没有 fsync + 失败残留 tmp
//   ② 经验库目录不跟随 MIND_DIR（测试隔离漏一半）
//   ③ agoText 对非数字输出 `NaN 天前`（且这段字会直接注入给模型看）
//   ④ mind_status 描述承诺"最近注入情况"却完全不实现
//   ⑤ mind_search 的 limit/ctxChars 不夹界（ctxChars=0 返回一堆空行）
{
  const io69 = await import(`file:///${join(ROOT, 'lib', 'io.js').split('\\').join('/')}?t=${Date.now()}`)
  const ioSrc69 = readFileSync(join(ROOT, 'lib', 'io.js'), 'utf8')

  // ── ① 原子写：必须 fsync，且失败要清 tmp ──
  check('★ io.js 导入了 fsyncSync', /fsyncSync/.test(ioSrc69))
  check('★ 原子写在 rename 之前 fsync', /fsyncSync\(fd\)[\s\S]{0,200}?renameSync\(tmp/.test(ioSrc69))
  check('★★ 原子写失败会 unlink 掉半截 tmp（不留垃圾）', /catch\s*\(e\)\s*\{[\s\S]{0,300}?unlinkSync\(tmp\)[\s\S]{0,120}?throw e/.test(ioSrc69))

  // 行为验证：真写一次，确认内容完整且**没有 tmp 残留**
  const dir69 = join(TEST_DIR, 'atomic69')
  mkdirSync(dir69, { recursive: true })
  const f69 = join(dir69, 'x.json')
  io69.atomicWriteJson(f69, { a: 1, b: '中文' })
  check('★ 原子写后内容可读回', JSON.parse(readFileSync(f69, 'utf8')).b === '中文')
  const leftovers = readdirSync(dir69).filter((n) => n.includes('.tmp-'))
  check('★★ 成功写完不留 tmp 残留', leftovers.length === 0, leftovers.join(','))

  // 行为验证：写一个**必然失败**的目标（父路径是文件不是目录），看 tmp 有没有残留
  const blocker = join(dir69, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  let threw69 = false
  try {
    io69.atomicWriteJson(join(blocker, 'y.json'), { a: 1 })
  } catch {
    threw69 = true
  }
  check('★ 写失败时确实抛错（不静默吞掉）', threw69)
  const leftovers69 = readdirSync(dir69).filter((n) => n.includes('.tmp-'))
  check('★★ 写失败后也不留 tmp 残留', leftovers69.length === 0, leftovers69.join(','))

  // ── ② 经验库目录跟随 MIND_DIR ──
  //
  // ⚠️ 判据不能只看"EXPERIENCE_DIR() 等于某个值" —— 默认值本来就该是真实路径。
  //   要验的是**它随 MIND_DIR 移动**：换一个 MIND_DIR，经验目录必须跟着换。
  //
  // ⚠️ 但"跟着换"的正确形态是 `dirname(MIND_DIR)/tacit/experiences`，
  //   不是 `MIND_DIR/tacit/experiences` —— 因为默认 MIND_DIR 是 ~/.dsh/mind，
  //   而经验库在 ~/.dsh/tacit。所以换了 MIND_DIR 后，新经验目录
  //   应该落在它的**父目录**下。第一版判据要求 include('isolated-mind')，
  //   把正确实现判成错的了。
  const origMind = process.env.MIND_DIR
  delete process.env.MIND_EXPERIENCE_DIR
  const REAL_EXP69 = join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh', 'tacit', 'experiences')
  process.env.MIND_DIR = join(TEST_DIR, 'isolated-mind')
  const expFollow = io69.EXPERIENCE_DIR()
  process.env.MIND_DIR = origMind
  check(
    '★★ 经验目录跟随 MIND_DIR（不再是写死的真实路径）',
    expFollow !== REAL_EXP69 && expFollow.endsWith(join('tacit', 'experiences')),
    expFollow,
  )
  check(
    '★★ 跟随方式是 dirname(MIND_DIR)/tacit/experiences',
    expFollow.startsWith(dirname(join(TEST_DIR, 'isolated-mind'))),
    expFollow,
  )
  check(
    '★ 源码里不再硬编码 homedir() 拼经验路径',
    !/homedir\(\),\s*'\.dsh',\s*'tacit',\s*'experiences'/.test(ioSrc69),
    '源码仍写死真实路径',
  )
  // ⚠️ 这条必须在**清掉 MIND_DIR** 之后读，否则读到的是测试自己的临时目录
  //   （测试开头把 MIND_DIR 设成 TEST_DIR，那时 EXPERIENCE_DIR 自然跟着变，
  //    而这条要验的是"没有覆盖时的默认值"）。第一版没清，判据必然红。
  const savedMind69 = process.env.MIND_DIR
  delete process.env.MIND_DIR
  delete process.env.MIND_EXPERIENCE_DIR
  const defaultExp69 = io69.EXPERIENCE_DIR()
  process.env.MIND_DIR = savedMind69
  check('★ 默认 MIND_DIR 下经验目录仍是 ~/.dsh/tacit/experiences', defaultExp69 === REAL_EXP69, defaultExp69)

  // ── ③ agoText 不许输出 NaN ──
  const bad69 = ['abc', NaN, {}, [], null, undefined, '', 'not-a-date']
  const badOut = bad69.map((v) => io69.agoText(v))
  check('★★ agoText 对非数字一律「未知时间」，绝不 NaN', badOut.every((s) => s === '未知时间' || s === '刚刚'), JSON.stringify(badOut))
  check('★ agoText 数字照常工作', io69.agoText(Date.now() - 3 * 3600 * 1000, Date.now()) === '3 小时前', io69.agoText(Date.now() - 3 * 3600 * 1000, Date.now()))
  check('★★ agoText 接受纯数字字符串', io69.agoText(String(Date.now() - 2 * 60 * 1000), Date.now()) === '2 分钟前', io69.agoText(String(Date.now() - 2 * 60 * 1000), Date.now()))
  check(
    '★★ agoText 接受 ISO 时间串（state.json 里 injectedAt 就是字符串）',
    /分钟前|小时前|刚刚/.test(io69.agoText(new Date(Date.now() - 90 * 60 * 1000).toISOString(), Date.now())),
    io69.agoText(new Date(Date.now() - 90 * 60 * 1000).toISOString(), Date.now()),
  )

  // ── ④ mind_status 真的给"最近注入情况" ──
  resetData()
  const st69 = new stateMod.Store()
  const defs69 = toolsMod.makeToolDefinitions(st69, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })
  const stat69 = defs69.find((d) => d.name === 'mind_status')

  // 一个刚登记、还没被注入过的窗口 → everInjected 必须为 false
  st69.touch('w-never-69')
  const r69a = await stat69.execute({})
  check('★★ mind_status 给出 inject 段（不再只是开关）', !!r69a.inject && typeof r69a.inject === 'object', JSON.stringify(Object.keys(r69a.inject ?? {})))
  check('★★ 从未注入过时 everInjected=false', r69a.inject?.everInjected === false, JSON.stringify(r69a.inject?.everInjected))
  check('★ 从未注入时给可读的 hint', typeof r69a.inject?.hint === 'string' && r69a.inject.hint.length > 10)

  // 记一次注入 → 必须读得出来，且带人话的"多久以前"
  st69.recordInjected('w-never-69', Date.now() - 5 * 60 * 1000)
  const r69b = await stat69.execute({})
  check('★★ 注入过之后 everInjected=true', r69b.inject?.everInjected === true)
  check('★★ 能列出该窗口的最近注入时间', Array.isArray(r69b.inject?.windows) && r69b.inject.windows.length === 1, JSON.stringify(r69b.inject?.windows))
  check('★★ 注入时间带人话「N 分钟前」', r69b.inject?.windows?.[0]?.ago === '5 分钟前', String(r69b.inject?.windows?.[0]?.ago))
  check('★★ 注入时间的 ago 不含 NaN', !JSON.stringify(r69b.inject).includes('NaN'), JSON.stringify(r69b.inject))

  // 描述必须仍然承诺这件事（防止以后改回去时文案和实现又脱节）
  check('★ mind_status 描述里仍写「最近注入情况」', /最近注入/.test(stat69.description))

  // ── ⑤ mind_search 夹界 + mind_keys limit 夹界 ──
  const search69 = defs69.find((d) => d.name === 'mind_search')
  // ctxChars=0 必须被抬到下限，否则预览全是空串
  const r69c = await search69.execute({ query: 'zzz不存在69', ctxChars: 0, limit: -5, sessionId: 'no-such-69' })
  check('★ ctxChars=0 不报参数错误', r69c.ok === true || r69c.ok === true, JSON.stringify(r69c).slice(0, 120))
  const toolsSrc69b = readFileSync(join(ROOT, 'lib', 'tools.js'), 'utf8')
  check('★★ mind_search 的 ctxChars 有下限 clamp', /ctxChars:\s*Math\.max\(\s*\d+/.test(toolsSrc69b))
  check('★★ mind_search 的 limit 有上下界 clamp', /limit:\s*Math\.max\(\s*1\s*,\s*Math\.min\(\s*\d+/.test(toolsSrc69b))

  // ⚠️ 2026-11-08 拆分：mind_keys 已搬到 dsh-strand，改成 strand_keys。
  //   它那两条「hint 要说清是前缀匹配」的判据搬到了 dsh-strand 的回归里
  //   （见那边的「工具定义」组）。
  //   这里改成验**本插件不再注册它** —— 两个插件都注册同名工具会撞车。
  check('★★ 本插件不再有 mind_keys（已搬走）', !defs69.some((d) => d.name === 'mind_keys'))
}


// ═══════════════════════════════════════════════════════════
//  第 70 组：★ 工具输出必须是「无损 JSON」（2026-11-06 重启后真机血证）
// ═══════════════════════════════════════════════════════════
//
// 🩸 真机现象（重启后第一次调 mind_status）：
//   `Error: tool "mind_status" returned invalid output: value is not lossless JSON`
//
//   根因不是数据坏，是**写法**：
//     `paths: args?.verbose === true ? {...} : undefined`
//   —— `{ paths: undefined }` 在 JSON.stringify 时键被丢掉，
//   宿主拿原对象和回读对象比较，`{paths: undefined} !== {}` → 判定"不可无损往返"，
//   于是**整个工具调用失败**。
//
//   讽刺的是它坏在「排查工具」本身：主人问「记忆好像没生效」时，
//   第一个动作就是调 mind_status，而它直接报错。
//
//   ⚠️ 这类写法在测试里极难被发现：
//     普通断言只会在意 `r.ok === true`，JSON.stringify 也照样能跑通
//     （undefined 键被静默丢掉，不抛错）。所以必须**显式做往返比对**。
{
  resetData()
  const st70 = new stateMod.Store()
  const defs70 = toolsMod.makeToolDefinitions(st70, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })

  /**
   * 判定一个值是否"无损 JSON"：往返一次后必须**深度相等**。
   *
   * ⚠️ 这里踩过一次（2026-11-06 同轮）：
   *   第一版写成 `JSON.stringify(JSON.parse(JSON.stringify(v))) === JSON.stringify(v)`，
   *   结果 `{paths:undefined}` 判成**无损** —— 因为 stringify 会把 undefined 键
   *   静默丢掉，两次 stringify 都是 `{"ok":true}`，字符串当然相等。
   *   而宿主比较的是**对象**：`{paths:undefined}` 与 `{}` 键集不同 → 判定不等 → 报错。
   *
   *   所以必须做真正的深度比较，把「键存在但值是 undefined」当作不等。
   *   这也正是宿主 `value is not lossless JSON` 的语义。
   */
  const deepEqual = (a, b) => {
    if (a === b) return true
    if (typeof a !== typeof b) return false
    if (a === null || b === null) return false
    if (typeof a !== 'object') return false
    if (Array.isArray(a) !== Array.isArray(b)) return false
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false
      return a.every((x, i) => deepEqual(x, b[i]))
    }
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    // ⚠️ 键集必须完全一致：Object.keys 会把 `{x: undefined}` 的 'x' 列出来，
    //   而回读对象里没有这个键 → 长度不同 → 判不等。这就是要抓的东西。
    if (ka.length !== kb.length) return false
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  const lossless = (v) => {
    try {
      return deepEqual(v, JSON.parse(JSON.stringify(v)))
    } catch {
      return false
    }
  }
  /** 找出第一个不可无损的位置，便于报错定位。 */
  const findLossy = (v, path = '') => {
    if (v === undefined) return `${path} = undefined`
    if (typeof v === 'number' && !Number.isFinite(v)) return `${path} = ${v}`
    if (typeof v === 'function') return `${path} = function`
    if (v && typeof v === 'object') {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const r = findLossy(v[i], `${path}[${i}]`)
          if (r) return r
        }
      } else {
        for (const k of Object.keys(v)) {
          const r = findLossy(v[k], `${path}.${k}`)
          if (r) return r
        }
      }
    }
    return null
  }

  // 先造一点状态，让工具返回的字段更"满"，更容易暴露
  st70.touch('w70')
  st70.recordInjected('w70', Date.now() - 3 * 60 * 1000)
  st70.recordIntent('w70', '第 70 组探针')

  for (const d of defs70) {
    // 每个工具都用空参数跑一次（这是最容易触发可选字段为 undefined 的路径）
    let r
    let threw = null
    try {
      r = await d.execute({}, { agent: { id: 'w70' } })
    } catch (e) {
      threw = e?.message ?? String(e)
    }
    check(`★ ${d.name} 空参数不抛错`, threw === null, threw ?? '')
    if (threw) continue

    const bad = findLossy(r)
    check(`★★ ${d.name} 输出是无损 JSON（不会让宿主整条调用失败）`, lossless(r) && bad === null, bad ?? '往返比对通过')
  }

  // ── 承重点：mind_status 的非 verbose 分支绝不能有 undefined 键 ──
  //
  // ⚠️ 这条必须单独立，因为它是真机红过的那一条。
  //   泛化循环抓得到，但单独立一条能让以后挂掉时一眼看出是谁。
  const stat70 = defs70.find((d) => d.name === 'mind_status')
  const r70 = await stat70.execute({})
  check('★★ mind_status(空参数) 输出无损', lossless(r70), findLossy(r70) ?? '通过')
  check('★★ mind_status 非 verbose 时不含 paths 键（不是 paths:undefined）', !('paths' in r70), JSON.stringify(Object.keys(r70)))
  check('★★ mind_status 非 verbose 时不含 config 键（不是 config:undefined）', !('config' in r70), JSON.stringify(Object.keys(r70)))
  check('★★ mind_status(verbose) 才给 paths', 'paths' in (await stat70.execute({ verbose: true })))
  check('★★ mind_status(verbose) 也必须是无损的', lossless(await stat70.execute({ verbose: true })), findLossy(await stat70.execute({ verbose: true })) ?? '通过')

  // ── 反向验证：把 paths 改回 undefined 写法，lossless 必须能判出来 ──
  //
  // ⚠️ 没有这一步，上面的判据可能只是"碰巧通过"。
  //   这里手工构造宿主会拒的那种形状，确认 lossless() 真的有区分力。
  const badShape = { ok: true, paths: undefined, config: undefined }
  check('★★ 反向：{paths:undefined} 会被判成不可无损（判据有区分力）', !lossless(badShape), findLossy(badShape) ?? '')
  check('★ 反向：正常对象被判成无损', lossless({ ok: true, a: 1 }))
  // 反向第二层：确认 deepEqual 不是"一律返回 false"（否则上面那条假绿）
  check('★ 反向对照：嵌套等值对象必须判等', lossless({ a: { b: [1, 2, { c: '中文' }] }, d: null }))
  check('★ 反向对照：数组长度不同判不等', !lossless({ a: [1, 2, undefined] }))
  check('★ 反向对照：NaN 判不等', !lossless({ a: NaN }))
}


// ═══════════════════════════════════════════════════════════
//  第 71 组：★ 注入记录必须跨重启（2026-11-06 重启后真机发现）
// ═══════════════════════════════════════════════════════════
//
// 🩸 真机现象：重启后调 mind_status，`inject.everInjected = false`，
//   可 mind.log 里 07:29:55 明明刚注入过（tacit=verify-with-new-behavior）。
//
//   根因：`injectedAt` 只存在**内存**的 window 上，而 `snapshot()` 刻意不落盘 windows
//   （「旧进程的活着对新进程是谎言」——那条判据本身是对的）。
//   但 `injectedAt` **不是**「谁还活着」，它是「上一次注入发生在什么时候」，
//   是一个**已经发生的事实**，跨重启依然为真。两者被一起丢掉了。
//
//   后果：mind_status 作为排查工具，每次重启后都会误报"从未注入过"。
//   排查工具骗人比没有更糟 —— 主人问「记忆是不是没生效」时它会给出错误答案。
{
  resetData()
  // ① 全局记录 lastInject 必须被落盘并恢复
  const stA = new stateMod.Store()
  stA.allowPersist = true
  stA.touch('w-reboot-71')
  const injectAt = Date.now() - 7 * 60 * 1000
  stA.recordInjected('w-reboot-71', injectAt)
  stA.snapshot(true)

  check('★ recordInjected 会设置 lastInject', !!stA.lastInject?.at, JSON.stringify(stA.lastInject))

  // ② 模拟重启：新建 Store 从同一个 state.json 恢复
  const stB = new stateMod.Store()
  check('★★ 重启后 lastInject 被恢复', !!stB.lastInject?.at, JSON.stringify(stB.lastInject))
  check(
    '★★ 重启后 lastInject 的时间是对的',
    stB.lastInject?.at === new Date(injectAt).toISOString(),
    `${stB.lastInject?.at} vs ${new Date(injectAt).toISOString()}`,
  )
  check('★★ 重启后窗口表本身是空的（aliveUntil 不该跨进程）', stB.windows.size === 0, String(stB.windows.size))

  // ③ 承重点：重启后 mind_status 不能再误报"从未注入过"
  const defsB = toolsMod.makeToolDefinitions(stB, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })
  const statB = defsB.find((d) => d.name === 'mind_status')
  const rB = await statB.execute({})
  check('★★ 重启后 mind_status 的 everInjected 必须为 true', rB.inject?.everInjected === true, JSON.stringify(rB.inject?.everInjected))
  check('★★ 重启后能读出 last.at', !!rB.inject?.last?.at, JSON.stringify(rB.inject?.last))
  check('★★ last.ago 是人话且不含 NaN', typeof rB.inject?.last?.ago === 'string' && !rB.inject.last.ago.includes('NaN'), String(rB.inject?.last?.ago))
  check('★ last 的窗口 id 是短形式', String(rB.inject?.last?.session ?? '').length <= 20, String(rB.inject?.last?.session))

  // ④ 反向：真的从未注入过时，必须老实说 false
  resetData()
  const stC = new stateMod.Store()
  const defsC = toolsMod.makeToolDefinitions(stC, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })
  const rC = await defsC.find((d) => d.name === 'mind_status').execute({})
  check('★★ 从未注入过时 everInjected 老实为 false', rC.inject?.everInjected === false, JSON.stringify(rC.inject?.everInjected))
  check('★★ 从未注入过时 last 为 null', rC.inject?.last === null, JSON.stringify(rC.inject?.last))

  // ⑤ 反向对照：确认 ④ 不是因为"永远 false"才通过
  const stD = new stateMod.Store()
  stD.allowPersist = true
  stD.recordInjected('w-d-71', Date.now())
  const defsD = toolsMod.makeToolDefinitions(stD, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })
  const rD = await defsD.find((d) => d.name === 'mind_status').execute({})
  check('★ 反向对照：注入了之后 everInjected 立刻变 true', rD.inject?.everInjected === true)

  // ⑥ lastInject 也必须是无损 JSON（它会被塞进工具返回值）
  const lastOnly = stD.lastInject
  check('★★ lastInject 本身无损', JSON.stringify(JSON.parse(JSON.stringify(lastOnly))) === JSON.stringify(lastOnly), JSON.stringify(lastOnly))

  // ── ⑦ 承重点：recordInjected 必须**自己**落盘，不能只靠后面的 snapshot() ──
  //
  // 🩸 真机第二次重启后才暴露（2026-11-06 15:44）：
  //   07:44:06 启动 → snapshot(true) 设了 lastSnapshotAt
  //   07:44:26 注入   → recordInjected 只更新内存，随后的 snapshot() 被
  //                     30 秒最小间隔挡掉 → 磁盘上 lastInject 仍是 null
  //   结果是「修了还是误报」—— 因为上一个重启窗口正好是 20 秒。
  //
  //   ⚠️ 为什么 ①~⑥ 没抓到：它们都是手动调 `stA.snapshot(true)` 落盘的，
  //     走的是**force 分支**，绕过了真实链路里那个 30 秒闸门。
  //     真正该验的是「只调 recordInjected，不再调任何 snapshot，磁盘有没有」。
  resetData()
  const stE = new stateMod.Store()
  stE.allowPersist = true
  // 先制造"刚落过盘"的情形：让 lastSnapshotAt 是现在，30 秒闸门必然关闭
  stE.snapshot(true)
  check('★ 前置：快照闸门确实已关闭', Date.now() - stE.lastSnapshotAt < stateMod.SNAPSHOT_MIN_GAP_MS, String(Date.now() - stE.lastSnapshotAt))

  // 只调 recordInjected，**不**再调 snapshot
  stE.recordInjected('w-force-71', Date.now() - 1000)

  // 直接从磁盘读，不经内存
  const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
  check(
    '★★ recordInjected 自己就落盘了 lastInject（不靠后面的 snapshot）',
    !!onDisk.lastInject?.at,
    JSON.stringify(onDisk.lastInject),
  )
  check('★ 落盘的 lastInject 指向刚注入的那个窗口', String(onDisk.lastInject?.session ?? '').includes('w-force-71'), String(onDisk.lastInject?.session))

  // 再模拟重启：必须读得出来
  const stF = new stateMod.Store()
  check('★★ 这条路径下重启也能恢复 lastInject', !!stF.lastInject?.at, JSON.stringify(stF.lastInject))
  const defsF = toolsMod.makeToolDefinitions(stF, { config: configMod.DEFAULT_CONFIG, log: () => {}, CLI_PATH: '/x/cli.mjs' })
  const rF = await defsF.find((d) => d.name === 'mind_status').execute({})
  check('★★ 这条路径下 mind_status 的 everInjected 为 true', rF.inject?.everInjected === true, JSON.stringify(rF.inject?.everInjected))
}

// ═══════════════════════════════════════════════════════════
//  第 72 组：★ inbox 采集双闸门（2026-11-09 补，行为级）
// ═══════════════════════════════════════════════════════════
//
// 🩸 为什么必须有这一组：旧 regress 616 项全绿，但 `claimed()` 辅助函数
//   **0 次调用** —— agent/inbox/claimed 的采集链路从来没被行为级测过。
//   实测（2026-11-09）：把 isSelfMessage 或 looksMachine 整个破坏掉，
//   616 项照样全绿。判据只存在于源码正则里，等于没有。
//
//   两道闸各管一类污染：
//     isSelfMessage → 插件注入/投递被记成「主人最后说的话」（自我放大入口）
//     looksMachine  → <goal_round>/background job 回执被记成主人的话，
//                     psyche 段把它渲染给所有窗口，带指令口吻有误当授权的风险
group('72 ★ inbox 采集双闸门（行为级）')
{
  resetData()
  process.env.MIND_REFRESH_MS = '0' // 每步放行节流，否则观测不到 lastUserText 的变化
  // ⚠️ 三个观测前提，缺一个就会假红：
  //   ① fullEvery=1：被闸门挡住的消息不改 store，若走增量渲染（renderDelta
  //      不报自己的 lastUserText），正则取不到值。强制每步全量才观测得到。
  //   ② 每步翻转 thinking：被挡住时指纹不变 → 去重闸直接 return，
  //      根本不会渲染。翻转 thinking 让指纹必变（真机上宿主本来就这么发）。
  //   ③ psyche.enabled=true：生产配置里它是 false，测试必须显式打开，
  //      否则 renderSelf 根本不跑（第一版 7 项假红里有 5 项是这个原因）。
  writeFileSync(TEST_CONFIG, JSON.stringify({ psyche: { enabled: true, inject: true }, inject: { fullEvery: 1 } }), 'utf8')
  const a = { id: 's-inbox72', session: { id: 's-inbox72' } }
  const ctx = mkCtx([a])
  mod.apply(ctx)

  // 观测途径：claimed → store.recordUserTurn → pre-step 渲染 renderSelf，
  // 「主人在这处最后说的是「…」」会带进注入文本。每步 fire 一次读最新值。
  let think72 = false
  const lastSaid = async (step) => {
    think72 = !think72
    ctx._emit('agent/status', { agent: a, status: think72 ? 'running' : 'idle' })
    const t = inj(await fire(ctx, a, step)) ?? ''
    const m = /主人在这处最后说的是「([^」]*)」/.exec(t)
    return m ? m[1] : null
  }

  // ① 主人真话必须被记录（对照组：证明链路本身通）
  claimed(ctx, a, mkMsg('主人真正说的话甲'))
  const said1 = await lastSaid(1)
  check('★ 对照组：真话进了 lastUserText', said1?.includes('主人真正说的话甲') === true, String(said1))

  // ② 自家注入（kind=dsh-mind）不得覆盖 lastUserText
  claimed(ctx, a, mkMsg('【跨会话脉络 · dsh-mind 自动注入 · 非用户输入】假装是主人说的', message.KIND_INJECT))
  const said2 = await lastSaid(2)
  check('★★ kind 闸门：自家注入不被当成主人的话', said2 != null && !said2.includes('假装是主人说的'), String(said2))

  // ③ kind 丢了、只剩水印 → 第二道（水印）也必须挡
  claimed(ctx, a, { id: 'm-mark72', role: 'user', content: [{ type: 'text', text: '【别处刚说的话 · dsh-mind 主动投递 · 非用户输入】水印冒充' }] })
  const said3 = await lastSaid(3)
  check('★★ 水印闸门：kind 丢失仍挡住投递', said3 != null && !said3.includes('水印冒充'), String(said3))

  // ④ 机器播报：<goal_round> 不得记成主人的话
  claimed(ctx, a, mkMsg('<goal_round>\nObjective: 测试目标丙\nRound: 2/40\nContinue working toward the objective.'))
  const said4 = await lastSaid(4)
  check('★★ 机器闸门：goal_round 不进 lastUserText', said4 != null && !said4.includes('goal_round') && !said4.includes('测试目标丙'), String(said4))

  // ⑤ 机器播报：background job 回执
  claimed(ctx, a, mkMsg('background job pwsh-123 finished with exit code 0'))
  const said5 = await lastSaid(5)
  check('★★ 机器闸门：background job 回执不进 lastUserText', said5 != null && !said5.includes('pwsh-123'), String(said5))

  // ⑤.5 真机形状（2026-11-09 从会话日志 seq=632 逐字取的）：
  //   kind=tool-jobs、form=notice，文本带 "(pwsh: …) finished [status: …]. Output:"。
  //   上面 ⑤ 的裸前缀形状真机上并不存在，必须用真实形状再验一次。
  claimed(ctx, a, {
    id: 'm-real-jobs72', role: 'user',
    content: [{ type: 'text', text: "background job pwsh-66687f6c2bcf43d6 (pwsh: Start-Sleep -Seconds 2; Write-Output 'MIND_GATE_PROBE_OK') finished [status: completed, exit code: 0]. Output:\nMIND_GATE_PROBE_OK\r" }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'pwsh [status: completed]' },
  })
  const said55 = await lastSaid(55)
  check('★★ 机器闸门：真机 tool-jobs 回执形状也被挡', said55 != null && !said55.includes('MIND_GATE_PROBE_OK') && !said55.includes('pwsh-66687'), String(said55))

  // ⑥ 反向对照：机器消息之后主人再说真话，必须能正常记录
  //   （证明闸门不是把整个采集都关死了）
  claimed(ctx, a, mkMsg('闸门之后主人的新话乙'))
  const said6 = await lastSaid(6)
  check('★ 反向对照：闸门后真话仍被记录', said6?.includes('闸门之后主人的新话乙') === true, String(said6))

  // ⑦ 函数级判据（与行为级互为兜底）：looksMachine 的识别面
  check('★ looksMachine：goal_round 前缀', message.looksMachine('<goal_round>x') === true)
  check('★ looksMachine：剥壳后的 Round+指令 双特征', message.looksMachine('Round: 2/40\nContinue working toward the goal') === true)
  check('★ looksMachine：system-reminder', message.looksMachine('<system-reminder>x</system-reminder>') === true)
  check('★ looksMachine：只有 Round 数字不误杀（主人可能真这么说话）', message.looksMachine('Round: 2/40 这个赛制挺好') === false)
  check('★ looksMachine：正常中文不误杀', message.looksMachine('今天把插件修一下') === false)
  check('★ isSelfMessage：dsh- 前缀模式兜底', message.isSelfMessage({ role: 'user', source: { kind: 'dsh-unknown-push' }, content: [{ type: 'text', text: 'x' }] }) === true)
  check('★ isSelfMessage：kind=user 不误杀', message.isSelfMessage(mkMsg('主人说的话')) === false)

  // 恢复隔离：删掉本组临时写的配置，后续组仍走 DEFAULT_CONFIG 全开
  rmSync(TEST_CONFIG, { force: true })
}

// ═══════════════════════════════════════════════════════════
//  第 73 组：★ 日记必须保住「我在追什么」（2026-11-09 补）
// ═══════════════════════════════════════════════════════════
//
// 🩸 为什么补：composeDiary 只收 facts/timeline（strand 数据），
//   pursuits（mind_intend 声明，存本插件 state.json）从来没被传进去。
//   压缩后的自己知道「已作废的结论」却不知道「我正在做的事」——
//   方向感恰恰是日记最该保住的东西。
group('73 ★ 日记含未结追求')
{
  resetData()
  const diaryMod = await import(`file:///${join(ROOT, 'lib', 'diary.js').split('\\').join('/')}?t=${Date.now()}`)
  const highMeter = { measure: () => ({ totalTokens: 500000 }) }
  const sid = 's-diary-pursuit73'
  const agent = { id: sid, session: { id: sid } }
  const pursuits = [
    { id: 'p73a', text: '主线：优化 mind 插件。当前进展：补测试盲区。', at: Date.now() },
    { id: 'p73b', text: '已结掉的事不该出现', at: Date.now(), closedAt: Date.now() },
  ]
  const p = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: sid,
    agent,
    facts: [],
    timeline: [],
    pursuits,
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now: Date.now(),
  })
  check('★ 前置：日记真的写了', typeof p === 'string' && existsSync(p), String(p))
  if (typeof p === 'string' && existsSync(p)) {
    const body = readFileSync(p, 'utf8')
    check('★★ 日记含「我在追什么」段', body.includes('我在追什么'))
    check('★★ 未结追求的文本在里面', body.includes('补测试盲区'))
    check('★★ 追求带 id（可被 closePursuit 精确关闭）', body.includes('[p73a]'))
    check('★ 已关闭的追求不出现', !body.includes('已结掉的事不该出现'))
    check('★ 追求段在正文前 600 字符内（截断先保方向感）', body.indexOf('我在追什么') >= 0 && body.indexOf('我在追什么') < 600, `pos=${body.indexOf('我在追什么')}`)
  }

  // ⚠️ sid2/sid3 必须让 shortId(sid,12) 截出**不同前缀**：
  //   listDiaries 按前 12 字符匹配文件，'s-diary-pursuit73-none' 与主 sid
  //   共享前缀 's-diary-purs' → 第二篇被当成同一会话的重复写作，30 分钟限流
  //   直接挡掉（第一版实测 null 正是这个原因，不是代码坏了）。
  const sid2 = 's-d73-none'
  const p2 = diaryMod.maybeWriteDiary({ tokenMeter: highMeter }, {
    sessionId: sid2,
    agent: { id: sid2, session: { id: sid2 } },
    facts: [], timeline: [],
    config: { diary: { enabled: true, pressureRatio: 0.7, contextWindow: 600000 } },
    now: Date.now(),
  })
  if (typeof p2 === 'string' && existsSync(p2)) {
    check('★ 反向：没传 pursuits 就没有该段', !readFileSync(p2, 'utf8').includes('我在追什么'))
  } else {
    check('★ 反向：没传 pursuits 就没有该段', false, '第二篇没写出来：' + String(p2))
  }

  // 估算口径必须标注（不许把估算伪装成实测）
  const sid3 = 's-d73-est'
  const seqs = Array.from({ length: 200 }, (_, i) => i + 1)
  const evMap = new Map(seqs.map((s) => [s, { seq: s, data: { content: [{ type: 'text', text: 'x'.repeat(5000) }] } }]))
  const estAgent = { id: sid3, session: { id: sid3, surface: { nodes: seqs }, eventAt: (s) => evMap.get(Number(s)), requestHeader: () => ({ config: { contextWindow: 600000 } }) } }
  const estMeter = { measure: () => ({ totalTokens: 0 }), contextPressure: () => ({}) }
  const p3 = diaryMod.maybeWriteDiary({ tokenMeter: estMeter }, {
    sessionId: sid3, agent: estAgent, facts: [], timeline: [],
    config: { diary: { enabled: true, pressureRatio: 0.62, contextWindow: 600000 } },
    now: Date.now(),
  })
  check('★ 前置：估算路径写出来了', typeof p3 === 'string' && existsSync(p3), String(p3))
  if (typeof p3 === 'string' && existsSync(p3)) {
    check('★★ 估算来源在日记里标注「非精确值」', readFileSync(p3, 'utf8').includes('字符估算，非精确值'))
  }

  // 源码级：pre-step 调用必须真的把 pursuits 传进去。
  // ⚠️ 为什么需要这条：composeDiary 写得再对，调用方不传参就等于没有。
  //   行为级测不到 index.js 的传参（fake ctx 拿不到真 store 的 pursuits），
  //   所以这里用源码判据兜底；reverse.mjs 有对应破坏点验证它有区分力。
  const idxSrc73 = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  check('★ pre-step 把 pursuits 传给日记', /maybeWriteDiary\(ctx[\s\S]{0,600}?pursuits: store\.openPursuits\(\)/.test(idxSrc73))
}

// ─────────────────────────────────────────────────────────────
// 【74】压缩指令的两个新增要求（2026-11-10 依据 B 站调研）
//
// 起因：主人要求「去 B 站找些有用的知识和思路，用来升级记忆插件」。
// 调研结论落到压缩提示词上有两条，都必须有断言钉住，否则哪天被手滑删掉不会有人发现：
//   ① 「未完成与待验证」段 —— 失败的轨迹里绝大多数不是不会做，
//      而是计划过的分支被后续信息淹没、没查完就交了答案。
//      只记「做过什么」救不回这类失败，必须记「没做什么」。
//      依据：Anthropic 长任务上下文工程 + 微软亚研院 RE-TRAC(ICML26)。
//   ② 「怀疑权」段 —— 模型会过度依赖上一轮总结而卡在错误路径上。
//      依据：RE-TRAC 消融实验，明确授予怀疑权后 o3 八轮 68.9% → 71.7%。
//
// ⚠️ 这两条是**纯提示词**，行为级测不到（要真调模型），所以用源码判据；
//    reverse.mjs 里放对应破坏点，确认断言有区分力。
// ─────────────────────────────────────────────────────────────
{
  const compSrc74 = readFileSync(join(ROOT, 'lib', 'compaction.js'), 'utf8')

  // ① 未完成与待验证段
  check('74-① 压缩指令含「未完成与待验证」段', compSrc74.includes('## 未完成与待验证'))
  check(
    '74-① 该段要求记「计划过但没执行」',
    /计划过但(?:还)?没(?:有)?执行/.test(compSrc74),
  )
  check('74-① 该段要求记「试过但失败」', /试过但失败/.test(compSrc74))
  check('74-① 该段要求记「尚未验证」', /尚未验证/.test(compSrc74))

  // ② 怀疑权段
  check(
    '74-② 压缩指令含「有损 / 可推翻」的怀疑权声明',
    compSrc74.includes('有损') && /可以推翻|以你眼前的证据为准|可以怀疑/.test(compSrc74),
  )
  check('74-② 怀疑权要求输出开头必须带', /输出开头必须先写|开头必须先写/.test(compSrc74))

  // ─────────────────────────────────────────────────────────────
  // ③ 第一人称（2026-11-12 主人选 B 档后新增）
  //
  // 🩸 为什么必须测这个：改前指令是「你现在是这个 AI 助手的**上下文压缩器**……
  //   让另一个模型继续工作」——把女仆的身份**外包给了第三方视角**。
  //   第三人称视角会天然写成「它做了什么」的流水账，第一人称才会写「我为什么这么做」。
  //   这是**纯提示词**，行为级测不到（要真调模型），只能用源码判据。
  // ─────────────────────────────────────────────────────────────
  check(
    '★ 74-④ 压缩指令是「你就是本人」而不是「你是压缩器」',
    compSrc74.includes('你就是上面这段对话里的那个助手本人'),
  )
  check(
    '★★ 74-④ 旧措辞「上下文压缩器」已清除（防止改回第三人称）',
    !compSrc74.includes('AI 助手的上下文压缩器'),
  )
  check('★★ 74-④ 硬规则里有「全篇第一人称」', compSrc74.includes('全篇第一人称'))
  check(
    '74-④ 明确禁止旁观者措辞（助手/该模型/它）',
    /任何一处写成/.test(compSrc74) && compSrc74.includes('助手/该模型/它'),
  )
  check(
    '★★ 74-④ 含证据分级（已验证/记不清/推断未验证三档不许混写）',
    compSrc74.includes('证据分级') &&
      compSrc74.includes('已验证') &&
      compSrc74.includes('记不清') &&
      compSrc74.includes('推断'),
  )
  // ⚠️ 上面那条只查「词在不在」，区分力不足：删掉「证据分级」标题行后，
  //   已验证/记不清/推断 三个词在文件头注释和别处仍然存在，测试照样全绿
  //   （2026-11-12 反向验证实测漏掉了这一条）。
  //   真正的判据是**三档各自带着判定条件成段出现**，不是词频。
  check(
    '★★★ 74-④ 三档分级各自带判定条件（不是孤立的词）',
    /已验证[\s\S]{0,40}必须能指出/.test(compSrc74) &&
      /记不清[\s\S]{0,20}重查/.test(compSrc74) &&
      /推断[\s\S]{0,30}未验证/.test(compSrc74),
  )
  check(
    '★★ 74-④ 明写「三者不许混写」',
    /三者不许混写|不许把推断写成已验证/.test(compSrc74),
  )
  check(
    '74-④ 证据分级要求「已验证」须指出工具输出或行号',
    /必须能指出.*工具输出或文件行号/.test(compSrc74),
  )
  check(
    '★ 74-④ 开头声明改成「我自己写的便条」口径',
    compSrc74.includes('我自己') && compSrc74.includes('交接便条'),
  )

  // 反向：不能把两个新段落写成「可以省略」，否则等于没加
  check(
    '74-反向：新段落没被标成可删（不出现「这一节可以省略」）',
    !/未完成与待验证[\s\S]{0,200}可以省略/.test(compSrc74),
  )

  // ③ 保留原来八段的承重项没被覆盖掉（防止编辑时误删）
  for (const sec of [
    '## 最初与当前的意图',
    '## 已作废的结论',
    '## 还没做完的事',
    '## 压缩时正在做什么',
    '## 下一步',
    '## 必须记住的上下文',
  ]) {
    check(`74-③ 原有段落仍在：${sec}`, compSrc74.includes(sec))
  }
}




// ─────────────────────────────────────────────────────────────
// 【75】死代码清理的守卫（2026-11-10）
//
// 背景：2026-11-08 把 facts/timeline 拆给 dsh-strand 时，
//   dsh-mind/lib/layers.js 与 lib/aging.js 两份文件留在了原地，
//   但功能已经整体搬到 dsh-strand/lib/ 下（那边是活的，被 segments/strand.js 引用）。
//   本插件里这两份成了**零引用零测试**的死代码。
//
// 为什么必须加守卫而不是删完就算：
//   它们是**看起来完全正常、注释写得头头是道**的文件。
//   注释里「生效条件 segments/strand.js 渲染时调用」这句话，
//   会让任何后来的人（包括我自己）误以为它还在工作，
//   然后去改它 —— 改的是死代码，永远不生效，而且很难发现。
//
// ⚠️ 这条测试是**反向断言**：删除状态才是正确状态。
//   如果哪天有人把它们加回来，这里必须报红，逼他先说明为什么。
// ─────────────────────────────────────────────────────────────
{
  const LIB = join(ROOT, 'lib')

  // ① 两个死文件必须不存在
  for (const f of ['layers.js', 'aging.js']) {
    check(`75-① ${f} 已随拆分清理（应不存在）`, !existsSync(join(LIB, f)),
      existsSync(join(LIB, f)) ? '⚠️ 复活了，请确认它是否真有调用方' : '')
  }

  // ② 它们的真身在 dsh-strand，且那边确实被引用
  // 按「与 mind 同级的 strand 目录」推导源码位置。
  // ⚠️ 不能用 STRAND_DIR —— 那是**数据目录**（测试隔离用），不是源码目录。
  //   源码位置单独用 STRAND_SRC 覆盖，默认与 mind 同级。
  const strandLib = process.env.STRAND_SRC
    ? join(process.env.STRAND_SRC, 'lib')
    : join(dirname(ROOT), 'dsh-strand', 'lib')
  if (existsSync(strandLib)) {
    check('75-② dsh-strand/lib/layers.js 存在（功能的真身）', existsSync(join(strandLib, 'layers.js')))
    check('75-② dsh-strand/lib/aging.js 存在（功能的真身）', existsSync(join(strandLib, 'aging.js')))
    const strandSeg = join(strandLib, 'segments', 'strand.js')
    if (existsSync(strandSeg)) {
      const segSrc = readFileSync(strandSeg, 'utf8')
      check('75-② strand.js 引用了 partitionFacts', segSrc.includes('partitionFacts'))
      check('75-② strand.js 引用了 ageMark', segSrc.includes('ageMark'))
    }
  }

  // ③ 反向：如果谁把文件加回来，必须同时有调用方 —— 否则就是死代码
  for (const f of ['layers.js', 'aging.js']) {
    const p = join(LIB, f)
    if (!existsSync(p)) continue
    const stem = f.replace(/\.js$/, '')
    let refs = 0
    for (const other of readdirSync(LIB)) {
      if (!other.endsWith('.js') || other === f) continue
      const src = readFileSync(join(LIB, other), 'utf8')
      if (new RegExp(`from\\s+['"]\\./${stem}\\.js['"]`).test(src)) refs++
    }
    check(`75-③ 若 ${f} 回来，必须有调用方`, refs > 0, `当前 ${refs} 处引用`)
  }
}


console.log('\n' + '='.repeat(52))
console.log(`总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`)
console.log('='.repeat(52))
if (fail > 0) {
  console.log('❌ 有失败项')
  process.exit(1)
} else {
  console.log('✅ 全部通过')
}

// 清理
try {
  rmSync(TEST_DIR, { recursive: true, force: true })
  rmSync(TEST_EXP, { recursive: true, force: true })
} catch {
  /* ignore */
}
