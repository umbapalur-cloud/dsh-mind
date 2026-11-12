/**
 * 反向验证：日记三层取数（2026-11-09）
 *
 * 目的不是"跑通"，而是证明**新判据真的有区分力**：
 *   - 旧行为（改前）：measure=0 + 投影空 → 静默 return，日志里什么都没有
 *   - 新行为（改后）：走字符估算兜底 → 打日志（估算 或 三层全失败）
 *
 * 判据红绿：
 *   ✅ 绿 = 能观测到「估算」或「三层取数全失败」字样
 *   ❌ 红 = 一条日志都没有（说明又回到静默）
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ⚠️ Windows 上动态 import 绝对路径必须是 file:// URL，
//   传 "E:\..." 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'e:'）。
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const libUrl = pathToFileURL(join(ROOT, 'lib', 'diary.js')).href

// ── 构造一个假的 agent.session：surface 有节点，eventAt 能取到带文本的事件 ──
function makeAgent({ seqCount = 10, textLen = 200 } = {}) {
  const seqs = Array.from({ length: seqCount }, (_, i) => i + 1)
  const events = new Map()
  for (const s of seqs) {
    events.set(s, {
      seq: s,
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'x'.repeat(textLen) }] },
    })
  }
  return {
    session: {
      id: 'probe-session',
      seq: seqCount,
      surface: { nodes: seqs },
      eventAt: (s) => events.get(Number(s)),
      requestHeader: () => ({ config: { contextWindow: 600000 } }),
    },
  }
}

// ── 假 tokenMeter ──
// measure 永远返回 0（复现真机的 pre-step 情形）
// contextPressure 存在但两个字段都是 undefined（复现宿主 usage-projection 的真实行为）
function makeMeter({ withContextPressure = true } = {}) {
  const m = {
    measure: () => ({ totalTokens: 0, surfaceTokens: 0, nodes: 0 }),
  }
  if (withContextPressure) {
    m.contextPressure = () => ({ contextWindow: 600000 }) // 既无 projectedTokens 也无 pressureTokens
  }
  return m
}

const dir = mkdtempSync(join(tmpdir(), 'mind-diary-probe-'))
process.env.MIND_DIR = dir

const diary = await import(libUrl)

function captureLog(fn) {
  // diary.js 的 log 写文件；这里直接读它写的日志文件
  const before = existsSync(join(dir, 'mind.log'))
    ? readFileSync(join(dir, 'mind.log'), 'utf8').length
    : 0
  let ret
  try {
    ret = fn()
  } catch (e) {
    ret = { __throw: String(e?.message ?? e) }
  }
  const after = existsSync(join(dir, 'mind.log'))
    ? readFileSync(join(dir, 'mind.log'), 'utf8')
    : ''
  const fresh = after.slice(before)
  return { ret, fresh }
}

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
}

const cfg = {
  diary: {
    enabled: true,
    pressureRatio: 0.62,
    contextWindow: 600000,
    injectMaxChars: 2000,
  },
}

// ── 用例 1：measure=0、投影空、session 有文本 → 应走估算 ──
{
  const agent = makeAgent({ seqCount: 10, textLen: 200 })
  const ctx = { tokenMeter: makeMeter() }
  const { ret, fresh } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: 'probe-1',
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now(),
      force: false,
      returnDetail: true,
    }),
  )
  check('用例1 有 detail 返回', ret && typeof ret === 'object', JSON.stringify(ret))
  check(
    '用例1 走了估算（日志含「估算」）',
    /估算/.test(fresh),
    fresh.trim() || '(无日志)',
  )
  check(
    '用例1 不再静默',
    fresh.trim().length > 0,
    `日志长度=${fresh.length}`,
  )
  // 10 节点 × 200 字符 = 2000 字符；2000/1.8 ≈ 1112 tokens；1112/600000 = 0.19%
  // 远低于 0.62 阈值 → 应该 below-threshold
  check(
    '用例1 压力低于阈值 → below-threshold',
    ret?.reason === 'below-threshold',
    String(ret?.reason),
  )
  check('用例1 报的压力是估算值而不是 0', Number(ret?.pressure) > 0, String(ret?.pressure))
}

// ── 用例 2：估算出来压力足够高 → 必须真写日记 ──
{
  // 200 节点 × 5000 字符 = 1,000,000 字符 → /1.8 ≈ 555k tokens → /600k = 92% > 62%
  const agent = makeAgent({ seqCount: 200, textLen: 5000 })
  const ctx = { tokenMeter: makeMeter() }
  const { ret, fresh } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: 'probe-2',
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now() + 3600_000,
      force: false,
      returnDetail: true,
    }),
  )
  check('用例2 估算压力过阈值 → 真的写了', ret?.wrote === true, JSON.stringify(ret))
  check('用例2 有文件路径', typeof ret?.path === 'string' && existsSync(ret.path), String(ret?.path))
  if (typeof ret?.path === 'string' && existsSync(ret.path)) {
    const body = readFileSync(ret.path, 'utf8')
    check('用例2 日记内容完整', body.includes('压缩前日记') && body.includes('给压缩后的自己'))
  }
}

// ── 用例 3：三层全失败（session 无 surface）→ 必须留痕，不许静默 ──
{
  const agent = { session: { id: 'empty', requestHeader: () => ({ config: { contextWindow: 600000 } }) } }
  const ctx = { tokenMeter: makeMeter() }
  const { ret, fresh } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: 'probe-3',
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now() + 7200_000,
      force: false,
      returnDetail: true,
    }),
  )
  check('用例3 三层全失败仍返回 detail', ret && typeof ret === 'object', JSON.stringify(ret))
  check('用例3 reason=zero-tokens', ret?.reason === 'zero-tokens', String(ret?.reason))
  check(
    '用例3 打出了「三层取数全失败」（关键：不再静默）',
    /三层取数全失败/.test(fresh),
    fresh.trim() || '(无日志)',
  )
  check('用例3 日志里带 contextPressure 诊断', /contextPressure=/.test(fresh), fresh.trim())
}

// ── 用例 4：没有 contextPressure 方法 → 也应留痕并说明原因 ──
{
  const agent = makeAgent({ seqCount: 5, textLen: 100 })
  const ctx = { tokenMeter: makeMeter({ withContextPressure: false }) }
  const { fresh } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: 'probe-4',
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now() + 10800_000,
      force: false,
      returnDetail: true,
    }),
  )
  check('用例4 无 contextPressure 时仍能估算', /估算/.test(fresh), fresh.trim() || '(无日志)')
}

// ── 用例 5：每会话首步必须打一条「日记取数诊断」（否则重启后无法判断新代码是否生效）──
{
  const agent = makeAgent({ seqCount: 5, textLen: 100 })
  const ctx = { tokenMeter: makeMeter() }
  const sid = 'probe-5-diag'
  const { fresh: fresh1 } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: sid,
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now() + 14400_000,
      force: false,
      returnDetail: true,
    }),
  )
  check(
    '用例5 首步打出「日记取数诊断」',
    /日记取数诊断/.test(fresh1),
    fresh1.trim() || '(无日志)',
  )
  check('用例5 诊断里带 via= 字段', /via=(measure|projection|estimate)/.test(fresh1), fresh1.trim())
  check('用例5 诊断里带 pressure= 百分比', /pressure=[\d.]+%/.test(fresh1), fresh1.trim())

  // 反向：同一会话第二步**不该**再打（否则每步刷屏，正是老代码踩过的坑）
  const { fresh: fresh2 } = captureLog(() =>
    diary.maybeWriteDiary(ctx, {
      sessionId: sid,
      agent,
      facts: [],
      timeline: [],
      others: {},
      config: cfg,
      now: Date.now() + 14400_500,
      force: false,
      returnDetail: true,
    }),
  )
  check(
    '用例5 反向：同会话第二步不再重复打诊断',
    !/日记取数诊断/.test(fresh2),
    fresh2.trim() || '(无日志，符合预期)',
  )
}

// ── 输出 ──
console.log('\n===== 反向验证：日记三层取数 =====\n')
let pass = 0
let fail = 0
for (const r of results) {
  const mark = r.ok ? '✅' : '❌'
  console.log(`${mark} ${r.name}${r.ok ? '' : `  <<< 实际: ${r.detail}`}`)
  if (r.ok) pass++
  else fail++
}
console.log(`\n合计 ${results.length} 项：绿 ${pass}，红 ${fail}\n`)

rmSync(dir, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
