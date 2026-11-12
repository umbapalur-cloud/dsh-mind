/**
 * dsh-mind · 压缩前日记
 *
 * CCG 六要素:
 *   功能名   在被压缩之前，把「此刻是谁、在追什么、不能忘什么」亲手写进磁盘
 *   生效条件 lib/index.js 的 agent/pre-step 每步调用，压力越过阈值才写
 *   子功能   压力判定 / 按会话限流 / 写 markdown / 供注入段引用最新一篇
 *   执行     maybeWriteDiary(ctx, agent, sessionId, config) → 写了返回路径，否则 null
 *   验证方式 tests/regress.mjs 日记组（阈值、限流、内容非空、路径可读）
 *   不适用条件 需要读到 tokenMeter（拿不到就静默跳过，绝不带崩主流程）
 *
 * ⚠️ 为什么必须"提前写"而不是"拦截压缩"（2026-11-05 设计决定）：
 *   压缩由 dsh-compaction-basic 在它自己的 agent/pre-step listener 里执行，
 *   listener 之间**没有顺序保证**。想"在压缩前一刻插一脚"是不可靠的承诺。
 *   改成：压力到阈值就写（压缩阈值是 80%），等压缩真发生时，
 *   日记早已在盘上。**提前写，而不是拦截。**
 *   （阈值 2026-11-06 由 0.7 调为 0.62，原因见 config.js 的 diary 段注释。）
 *
 * ⚠️ 为什么写到磁盘而不是写进上下文：
 *   上下文里的东西会被压缩遮蔽。写进磁盘的不会 —— 这正是"抗压缩"的全部意义。
 *   日记是压缩够不着的地方，也是压缩后的自己能重新长回来的种子。
 */

import { join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { MIND_DIR, log, shortId, oneLine } from './io.js'
import { readPeerGlobal } from './peer.js'

export const DIARY_DIR = () => join(MIND_DIR(), 'diary')

/** 同一会话两次日记的最小间隔，防止压力在阈值附近抖动时刷屏。 */
export const DIARY_MIN_GAP_MS = 30 * 60 * 1000

/** 会话内最多保留几篇，防止无限增长。 */
export const DIARY_MAX_PER_SESSION = 6

/**
 * 强制模式（压缩发生时）两次写作的最小间隔。
 *
 * ⚠️ 为什么不是 0：`summarizeCompaction` 失败会 `recover` + **重试同一区间**，
 *   重试会再走一次 `summarize()`。60 秒足够把重试挡掉，又不至于把
 *   "两次真的压缩"误判成一次（真机最快的一次压缩间隔是 15 分钟）。
 */
export const DIARY_FORCE_MIN_GAP_MS = 60 * 1000

/**
 * 已经打过「日记取数诊断」的会话。
 *
 * ⚠️ 为什么要这个：日记的 `below-threshold` 是**正常路径**，每步都会走，
 *   所以不能每步打日志（老代码注释里写着「实测刷了 55 次」的教训）。
 *   但完全不打，会让「新代码生效没有」在重启后无法判断 ——
 *   2026-11-09 真机验证时就是卡在这里：改完重启，日志一条新文案都没有，
 *   只能靠读代码猜是哪条分支。
 *
 *   折中：每会话**第一次**调用时打一条取数诊断，之后安静。
 *   重启后第一句话就能看到它，成本是每会话一行。
 */
const DIAG_LOGGED = new Set()

/**
 * 拿 token 计量服务。
 *
 * ⚠️ 为什么这么啰嗦（三种取法依次尝试）：
 *   dsh-mind 的 inject 只声明了 ['agents']，tokenMeter 是**可选**服务。
 *   声明进 inject 会让"没有该服务就不激活"——那会把整个记忆插件拖下水。
 *   所以改成运行时试探：拿不到就静默跳过日记，其余功能照常。
 */
function getMeter(ctx) {
  try {
    if (ctx?.tokenMeter) return ctx.tokenMeter
  } catch {
    /* 未注入时会抛，继续往下试 */
  }
  try {
    if (typeof ctx?.get === 'function') {
      const m = ctx.get('tokenMeter')
      if (m) return m
    }
  } catch {
    /* 同上 */
  }
  return null
}

/**
 * 把某个服务槽位的状态描述成一行，**只给日志用，绝不往外抛**。
 *
 * ⚠️ 为什么要这个函数：`ctx.tokenMeter` 在未注入时会 **抛**（不是返回 undefined），
 *   直接在日志模板里拼 `ctx.tokenMeter` 会让"诊断日志自己把流程带崩"。
 *   这里逐次 try 包住，任何异常都折成字符串。
 */
function describeSlot(ctx, key) {
  try {
    const v = ctx?.[key]
    return v ? typeof v : 'undefined'
  } catch (e) {
    return `throws(${e?.name ?? 'Error'})`
  }
}

/**
 * 试着拿 contextPressure 投影，**把失败原因一起带出来**。
 *
 * ⚠️ 单独抽函数的原因（2026-11-09）：原来的写法是两个 if 分支，
 *   两个都不满足时**什么都不打** —— 于是"回退失败"和"回退没被调用"
 *   在日志里长得一模一样，这正是上一轮误判「已修」的直接原因。
 *
 * 现在无论成功失败都返回可描述的结构，调用方一定会把它写进日志。
 *
 * @returns {{available:boolean, cp:object|null, error:string|null}}
 */
function probeContextPressure(meter, agent) {
  const out = { available: false, cp: null, error: null }
  try {
    if (typeof meter?.contextPressure !== 'function') {
      out.error = 'not-a-function'
      return out
    }
    const cp = meter.contextPressure(agent?.session)
    out.available = true
    out.cp = cp ?? null
    return out
  } catch (e) {
    out.error = `${e?.name ?? 'Error'}: ${e?.message ?? e}`
    return out
  }
}

/** 把 probeContextPressure 的结果折成一行，只给日志用。 */
function describeContextPressure(info) {
  if (!info) return 'unknown'
  if (info.error) return `error(${info.error})`
  if (!info.cp) return 'null'
  const p = info.cp.projectedTokens
  const q = info.cp.pressureTokens
  return `projected=${p === undefined ? 'undef' : p},pressure=${q === undefined ? 'undef' : q}`
}

/**
 * 按字符数**估算**上下文 token 数 —— 三层取数里的兜底层。
 *
 * ⚠️ 这是估算，不是测量。日志里必须带「估算」字样，不得伪装成实测值。
 *
 * 为什么必须有这一层：日记唯一的价值是「压缩前留个念」。
 * 它可以因为「没到阈值」而不写，但**不该因为测不出压力就一整天不写** ——
 * 真机现状就是后者（mind.log 里 47 次「日记跳过」，「改用投影」0 次）。
 * 宁可压力估高、早写一篇，也比空手被压缩强。
 *
 * 估算口径刻意**偏保守**（容易高估 → 更早触发）：
 *   一次请求的 token ≈ 字符数 / charsPerToken
 *   - 英文约 4 字符/token
 *   - 中文约 1.2-1.5 字符/token
 *   混排取 1.8 作为分母，得到比真实中文更大的 token 数。
 *
 * ⚠️ 已知的**不精确之处**（写在这里是为了后来人别拿它当准数）：
 *   ① 只统计 surface 上可见节点的文本，图片/工具结构化内容按 0 计；
 *   ② 没算系统提示词与工具定义的固定开销（通常几千 token，这里漏掉 → 偏低）；
 *   ③ 没算本轮尚未落盘的用户输入（pre-step 时它还在 payload 里）。
 *   ②③让它偏低，①让它偏低，而 charsPerToken=1.8 让它偏高。
 *   净效果无法先验确定，所以它只报数字与口径，**不宣称准确**。
 *
 * @returns {{tokens:number, chars:number, nodes:number, reason:string}}
 */
function estimateTokensFromSession(agent, { charsPerToken = 1.8 } = {}) {
  const empty = (reason) => ({ tokens: 0, chars: 0, nodes: 0, reason })

  const session = agent?.session
  if (!session) return empty('no-session')

  const per = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : 1.8

  // ── 取所有可见节点的文本长度 ──
  //
  // ⚠️ surface.nodes 存的是 **seq 数字**（dsh-session 里 state.nodes.push(plan.seq)），
  //   不是消息对象本身，所以要再用 eventAt(seq) 取事件。这条路径在
  //   infer-region.js:62 与 index.js:136 都已确认存在，不是猜的。
  let nodes = 0
  let chars = 0
  let seqs = null
  try {
    seqs = session?.surface?.nodes
    // 🩸 2026-11-12 修：surface 空了**不再直接 return**，交给下面第 ④ 层走日志尾巴。
    if (!Array.isArray(seqs) || seqs.length === 0) {
      return tokenFromLastUsage(session, 'no-surface-nodes')
    }
    if (typeof session.eventAt !== 'function') return empty('no-eventAt')

    // 太长的会话不必全扫：估算要的是「量级」，尾部 400 个节点足够，
    // 而且 pre-step 是每步都跑的，全扫会把这里变成瓶颈。
    const TAIL = 400
    const from = Math.max(0, seqs.length - TAIL)
    for (let i = from; i < seqs.length; i++) {
      const seq = seqs[i]
      if (!Number.isFinite(Number(seq))) continue
      let e
      try {
        e = session.eventAt(Number(seq))
      } catch {
        continue
      }
      if (!e) continue
      const t = textLengthOfEvent(e)
      if (t > 0) {
        nodes++
        chars += t
      }
    }
  } catch (e) {
    return empty(`throw(${e?.name ?? 'Error'})`)
  }

  if (chars <= 0) return empty('no-text')
  return {
    tokens: Math.ceil(chars / per),
    chars,
    nodes,
    reason: 'ok',
  }
}

/**
 * 第 ④ 层：**从最后一条 assistant/message 的提供方 usage 取真实 token 数**。
 *
 * 🩸 2026-11-12 为什么必须加这一层（真机血证）：
 *   原「三层取数」里**有两层依赖同一个会空的源**：
 *     ① measure() 靠回放 surface
 *     ③ estimateTokensFromSession 也读 session.surface.nodes
 *   真机 34 次「估算=no-surface-nodes」证明 pre-step 时 surface 是**空数组**，
 *   于是三层一起哑火 —— 所谓"三层"实际只有"两层独立"，第三层是**伪兜底**。
 *
 * ⚠️ 为什么不用「扫日志尾部按字符估算」（女仆中途试过，已作废）：
 *   实测本机会话 3370 条事件里，尾部 400 条只覆盖 **6.7%** 的字符量
 *   （字符分布太均匀，单条 tool/result 动辄 3 万字符散落全程）。
 *   要覆盖 90% 得从 idx 142 扫起 = 几乎全扫 3228 条。
 *   而 `maybeWriteDiary` 是**每轮 pre-step 都调**的，全扫会变成瓶颈。
 *   → 结论：**扫描这条路根本不成立**，无论尾部多大都测不准。
 *   （这正是女仆本次差点犯的第二个错：修成"能取到数但严重低估"。）
 *
 * ✅ 本层用的是**宿主自己记录的提供方真实用量**，不是估算：
 *   `assistant/message` 事件的 `data.usage` 携带该次请求的精确用量，
 *   按宿主的 `pressureFrom` 公式（usage-projection.js:58）：
 *     pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens
 *   真机实测：seq=3366 的那条 usage = {input:886, cacheRead:53376} → 54262 tokens
 *   → 窗口 600000 时压力 9.0%，**和宿主自己算的完全一致**。
 *
 * ⚠️ 语义差异（必须写清，不能糊弄）：
 *   这算的是「**上一次请求**的 prompt 规模」，不是「下一次将花费多少」。
 *   与 `measure()` 的 `totalTokens`（当前 surface 全量）相比，
 *   **本层总是偏小**（少算了上一次请求之后新产生的输出）。
 *   实测：本会话 measure=74829 vs usage=54262，差 20567（27.5%），
 *   那 20567 正是那次请求之后新产生的工具输出 —— **方向确认：只低估、不高估**。
 *
 *   为什么这个偏差可以接受：
 *     ① 日记的用途是「快到阈值时留个念」，不是精确计费；
 *     ② 偏小 → 晚写 → 但它**总比完全不写强**（现状是 34 次完全不写）；
 *     ③ 阈值 62%，而实测偏小幅度约 27% → 实际会拖到 ~85% 才写，
 *        仍早于压缩（压缩通常在 ~90%+ 才触发），**来得及**。
 *
 * ⚠️ 若未来发现"日记总是晚了一拍"，第一嫌疑就是这层偏低 —— 见上面 ③。
 *
 *   日志里必须标 `usage` 而不是 `estimate`，因为它是**实测值**。
 *
 * ⚠️ 只从尾部倒扫，找到第一条带 usage 的就返回：正常一次命中，
 *   最坏情况退化成扫尾部若干条，成本可接受。
 *
 * @param {object} session - agent.session
 * @param {string} why - 为什么走到这一层（写进 reason，便于日志排查）
 * @returns {{tokens:number, chars:number, nodes:number, reason:string}}
 */
function tokenFromLastUsage(session, why) {
  const empty = (reason) => ({ tokens: 0, chars: 0, nodes: 0, reason })

  const total = Number(session?.seq)
  if (!Number.isFinite(total) || total <= 0) return empty(`${why}|no-seq`)
  if (typeof session.eventAt !== 'function') return empty(`${why}|no-eventAt`)

  // 只倒扫尾部 USAGE_SCAN 条：正常几步之内就能命中，不必全扫。
  const USAGE_SCAN = 120
  const from = Math.max(0, total - USAGE_SCAN)

  for (let s = total; s >= from; s--) {
    let e
    try {
      e = session.eventAt(s)
    } catch {
      continue
    }
    if (!e) continue
    if (e.type !== 'assistant/message') continue
    const u = e.data?.usage
    if (!u) continue
    // 与宿主 usage-projection.js:58 的 pressureFrom 完全同口径
    const tokens =
      (Number(u.inputTokens) || 0) +
      (Number(u.cacheReadTokens) || 0) +
      (Number(u.cacheWriteTokens) || 0)
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    return {
      tokens,
      chars: 0, // 这一层没有字符数概念，留 0 以免调用方误用
      nodes: 1,
      reason: `${why}|usage@seq${e.seq}`,
    }
  }
  return empty(`${why}|no-usage-in-tail`)
}

/**
 * 模型可见的 surface 事件类型（来自 dsh-session README「会话投影」节）。
 *
 * ⚠️ 必须白名单而不是黑名单：日志里有大量只读事件（stream、attempt、
 *   request/header、compaction/end…），把它们算进上下文规模会严重高估压力，
 *   导致日记提前写、写得太频繁。
 */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * 判断这次取数失败是不是「**新会话开了头、压根没东西可测**」这种正常情况。
 *
 * 🩸 2026-11-12 为什么需要这个判断（一天内第二次同类误判）：
 *   真机日志里 34 次「三层取数全失败」全部紧跟在「窗口首次说话」之后
 *   （**34/34，无一例外**）。女仆先把它当成了「压缩前拉不出日记」的致命 bug，
 *   查下去才发现：
 *     · 那些会话测出来的压力是 **3.7% ~ 5.2%**，阈值 62% —— 差 12~17 倍；
 *     · 而真正长到 62% 以上的会话，日记**一次没漏**（有 7 条「压力达阈值」实证）。
 *   也就是说：这些"失败"发生在**永远用不到日记的时刻**，
 *   本质是「新会话第一句话时，日志里连一条 assistant/message 都没有」，
 *   不是故障。可它每次都打一行像报错的话 → 制造了 34 次假警报。
 *
 * 判据（两条同时成立才算「正常无历史」）：
 *   ① 会话日志还很短（没积累出可测的内容）
 *   ② 里面一条 assistant/message 都没有（没发生过一次请求，自然没有 usage）
 *
 * ⚠️ 为什么用这两个判据而不是只看 seq 小：
 *   只看 seq 会在「刚恢复的长会话」上误判；只看没有 assistant/message
 *   会在「会话刚开但已经灌了很长上下文」的极端情况上误判。
 *   两条一起要求，才够精确。
 *
 * ⚠️ 判据必须**确定性**（数事件），不能用模型推断 —— 见 AGENTS.md「能写死成
 *   确定性判断的，绝不交给模型」。
 *
 * @param {object} session - agent.session
 * @param {number} shortSeq - 认为"日志还很短"的阈值
 * @returns {{isFresh:boolean, seq:number, assistantCount:number, userCount:number}}
 */
function probeFreshSession(session, shortSeq = 40) {
  const out = { isFresh: false, seq: 0, assistantCount: 0, userCount: 0 }
  try {
    const total = Number(session?.seq)
    if (!Number.isFinite(total) || total <= 0) return out
    out.seq = total
    if (typeof session.eventAt !== 'function') return out

    const from = Math.max(0, total - 200)
    for (let s = from; s <= total; s++) {
      let e
      try {
        e = session.eventAt(s)
      } catch {
        continue
      }
      if (!e) continue
      if (e.type === 'assistant/message') out.assistantCount++
      else if (e.type === 'user/message') out.userCount++
    }
    // 两条判据同时成立才算「新会话开头」
    out.isFresh = total <= shortSeq && out.assistantCount === 0
  } catch {
    /* 探测失败就当不是新会话，走原本的报错文案（宁可多喊一声） */
  }
  return out
}

/**
 * 从一条会话事件里取「它能贡献多少字符」。
 *
 * ⚠️ 字段名不能猜：本机历史上有一次「按 data.message.content 读，
 *   真实字段是 data.content，942 条全读成 0」的血证（AGENTS.md 记过）。
 *   所以这里**多种形状都试**，取到第一个正数就返回，而不是赌一种。
 */
function textLengthOfEvent(e) {
  const candidates = [
    e?.content,
    e?.text,
    e?.data?.content,
    e?.data?.text,
    e?.data?.message?.content,
    e?.message?.content,
  ]
  for (const c of candidates) {
    const len = textLengthOf(c)
    if (len > 0) return len
  }
  return 0
}

/** content 可能是字符串、也可能是 [{type:'text',text:'...'}] 数组。 */
function textLengthOf(c) {
  if (!c) return 0
  if (typeof c === 'string') return c.length
  if (Array.isArray(c)) {
    let n = 0
    for (const part of c) {
      if (typeof part === 'string') n += part.length
      else if (typeof part?.text === 'string') n += part.text.length
    }
    return n
  }
  if (typeof c?.text === 'string') return c.text.length
  return 0
}

/**
 * 拿上下文窗口大小。
 *
 * ⚠️ 为什么不能只用配置里写死的数字：
 *   主人调过窗口（400k → 600k），未来还会调。写死会让阈值悄悄失准。
 *   优先从会话的请求头拿真实值，拿不到才回退配置。
 */
function resolveWindow(agent, fallback) {
  try {
    const cfg = agent?.session?.requestHeader?.()?.config
    const w = cfg?.contextWindow ?? cfg?.maxInputTokens ?? cfg?.model?.contextWindow
    if (Number.isFinite(w) && w > 0) return w
  } catch {
    /* 拿不到就用配置 */
  }
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 600000
}

function ensureDir(p) {
  try {
    mkdirSync(p, { recursive: true })
  } catch {
    /* 建目录失败由后续写文件兜住 */
  }
}

/** 列出某会话已有的日记文件（按时间正序）。 */
export function listDiaries(sessionId) {
  const dir = DIARY_DIR()
  try {
    if (!existsSync(dir)) return []
    const prefix = shortId(sessionId, 12).replace(/…$/, '')
    return readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.md'))
      .sort()
      .map((n) => join(dir, n))
  } catch {
    return []
  }
}

/**
 * 取最新一篇日记的正文（给注入段用）。读不到返回空串。
 *
 * ⚠️ 2026-11-05 第三次修（主人指定）：原来是裸的 `raw.slice(0, maxChars)`。
 *   两个毛病，都是真机上撞到的：
 *
 *   ① **切断在句子中间**。1204 字符的文件砍到 700，正好落在
 *      "07:16 " 这个小标题半截上，读起来像话没说完。
 *      改成按行累加到上限，宁可少几个字也不切断一句。
 *
 *   ② **截断后不告诉人去哪找全文**。原样只有一个「（下略）」——
 *      压缩后的女仆看到这仨字，既不知道还剩多少，也不知道路径。
 *      这等于把「抗压缩」做成了「抗一半」。
 *      改成截断时把**绝对路径**一起送出去，那一句就是重新长回来的入口。
 */
export function latestDiaryText(sessionId, maxChars = 2000) {
  const all = listDiaries(sessionId)
  if (!all.length) return ''
  const file = all[all.length - 1]
  try {
    const raw = readFileSync(file, 'utf8')
    if (raw.length <= maxChars) return raw

    // 尾部那一行的开销必须先预留，否则"上限 700"会实际送出 775 字符
    // （第一次实测就是这么超出 75 的：正文按 700 累加，尾巴又加了 75）
    const tailOf = (n) => `\n（下略 ${n} 字符 · 全文：${file}）`
    const budget = maxChars - tailOf(raw.length).length

    // 按行累加，不切断整行
    const lines = raw.split('\n')
    const kept = []
    let used = 0
    for (const ln of lines) {
      const cost = ln.length + 1 // +1 是换行
      if (used + cost > budget) break
      kept.push(ln)
      used += cost
    }

    // 一行都放不下（上限被调得极小）→ 退化为不列全文路径，只给硬截断
    if (!kept.length) return raw.slice(0, maxChars)

    const head = kept.join('\n')
    const rest = raw.length - head.length
    return head + tailOf(rest)
  } catch {
    return ''
  }
}

/**
 * 拼一篇日记的正文。
 *
 * ⚠️ 内容取舍原则：只写「压缩后最需要、而摘要最可能丢」的东西。
 *   摘要模型会保留待办与文件路径，但**几乎一定会丢掉"我为什么这么做"和
 *   "哪些结论已被推翻"**。所以这两块放在最前面。
 */
function composeDiary({ sessionId, now, pressure, windowTokens, totalTokens, facts, timeline, others, pursuits, source }) {
  const lines = []
  const time = new Date(now).toISOString().replace('T', ' ').slice(0, 19)

  lines.push(`# 压缩前日记 · ${time} UTC`)
  lines.push('')
  // ⚠️ 2026-11-09 补：压力数字必须带口径。三层取数（measure/投影/字符估算）
  //   的可信度完全不同，不标注的话估算值会被压缩后的自己当成实测值引用。
  //
  // 🩸 2026-11-12 修：原来只有 estimate/projection 两种标注，第 ④ 层（取自
  //   assistant/message 的 data.usage）被 `viaEstimate=true` 归进了 estimate，
  //   于是**实测值在日记里被写成「字符估算，非精确值」** —— 违反本插件
  //   「实测不许伪装成估算」的规矩（反方向也一样：估算不许伪装成实测）。
  //   现在三种口径各自标注，互不冒充。
  const srcNote =
    source === 'usage'
      ? '，取自上一次请求的实测用量'
      : source === 'estimate'
        ? '，字符估算，非精确值'
        : source === 'projection'
          ? '，投影值'
          : ''
  lines.push(`> 女仆在被压缩前亲手写的。窗口 ${Math.round(totalTokens / 1000)}k / ${Math.round(windowTokens / 1000)}k（${Math.round(pressure * 100)}%${srcNote}）。`)
  lines.push('')

  // ① 硬约束：这是给"压缩后的自己"的纪律，不是给主人的
  //
  // ⚠️ 2026-11-05 第三次修（主人指定）：这一段原来放在**文件末尾**，
  //   而注入上限 `injectMaxChars: 700` 是从**末尾**截断的。
  //   真机实测：首篇日记 1204 字符，注入只送到前 700 ——
  //   被丢掉的 504 字符里，正好包含这一整段。
  //   女仆写它就是为了让压缩后的自己读到，结果一个字都没送到。
  //
  //   同时把措辞压短：原版约 230 字符，每篇一字不差地重复，
  //   吃掉三分之一预算，挤掉真正有用的会话内容。语义不变，字数减半。
  lines.push('## 给压缩后的自己')
  // ⚠️ 2026-11-12 主人选 B 后修正措辞。原来是「下面是女仆亲手写的；摘要是别人写的」——
  //   两处都不准确：
  //     ① 这篇日记不是「压缩前一刻坐下来写的」，是**代码按模板拼装**的
  //        （本文件里没有任何 llm/stream 调用，grep 命中 0）。数据确实是女仆
  //        平时用 mind_intend 等工具一步步登记的，但拼装是机械的。
  //     ② B 档之后摘要也归女仆写，不再是「别人写的」——那句会与实际相矛盾。
  //   现在改成「怎么来的」+「所以该信到哪一步」，把可信度说清楚而不是打包票。
  lines.push(
    '- 这篇日记是**代码按模板拼的**（数据是女仆平时登记的，不是压缩前现写的）；' +
      '摘要则是**同一个我**压缩时写的，两份都可能出错。',
  )
  lines.push('- 两份**冲突时以本文为准**：本文只抄原话与登记项，比摘要少一层转述。')
  lines.push('- 人格与纪律在 `~/.dsh/AGENTS.md`（user 消息，压缩会遮蔽它）——需要时重读。')
  lines.push('- 交付前绑定本轮实测输出；「应该」「上次是这样」不算证据。')
  lines.push('')

  // ①.5 我在追什么 —— 日记最该保住的东西（2026-11-09 补）
  //
  // ⚠️ 为什么以前没有：pursuits 存在本插件的 state.json（mind_intend 声明），
  //   而 composeDiary 只收 facts/timeline（strand 的数据）—— 调用方从来没传。
  //   于是压缩后的自己知道"已作废的结论"，却不知道"我正在做的事"，
  //   方向感恰恰是最容易在压缩里丢的。放在最前面，截断也先保它。
  const openPursuits = (Array.isArray(pursuits) ? pursuits : []).filter((p) => p && !p.closedAt)
  if (openPursuits.length) {
    lines.push('## 我在追什么（mind_intend 的未结声明）')
    for (const p of openPursuits.slice(-8)) {
      lines.push(`- [${p.id ?? '?'}] ${oneLine(p.text, 240)}`)
    }
    lines.push('')
  }

  // ② 什么已经不作数了 —— 摘要最容易丢这个，也最容易害人
  //
  // ⚠️ 2026-11-05 第四次修（主人选 B 档）：条数上限原来是 15/10/8，
  //   实测日记只有 1220 字符，就算把 injectMaxChars 放到 5000 也长不出来 ——
  //   **源头被切死了，改上限是空转**。strand 段还有 2470 字符余量，放宽源头即可。
  //   新值经实测：stale 25 + threads 20 + timeline 20 句，日记约 2000~2500 字符，
  //   strand 峰值约 8500，仍在 9000 红线内。
  const stale = (facts ?? []).filter((f) => f?.stale)
  if (stale.length) {
    lines.push('## 已作废的结论（别再用）')
    for (const f of stale.slice(-25)) {
      const why = f.stale?.reason === 'superseded' ? `被 ${f.stale.by} 取代` : '已显式作废'
      lines.push(`- ${f.key}（${why}）`)
    }
    lines.push('')
  }

  // ③ 还没做完的事
  //
  // ⚠️ 2026-11-08 拆分：threads 现在住在 dsh-strand 的 global.json 里。
  //   原来这里是 `readGlobal()`（本插件的 global.js），拆分后那个文件不在了。
  //   改成走 peer 软依赖：读不到就跳过这一节（**降级而非崩溃**）。
  //   刻意不 import 对方模块，理由见 peer.js 文件头。
  const g = { threads: [] }
  try {
    Object.assign(g, readPeerGlobal())
  } catch {
    /* 读不到就跳过 */
  }
  if (Array.isArray(g.threads) && g.threads.length) {
    lines.push('## 未结线索')
    for (const t of g.threads.slice(-20)) lines.push(`- [${t.id}] ${oneLine(t.text, 200)}`)
    lines.push('')
  }

  // ④ 最近在做什么 —— **只取本窗口**
  //
  // ⚠️ 每行从 120 放宽到 200（2026-11-05 第四次修）：实测最近 20 条里
  //   有 5 条原文正好卡在 120，是被截断的，读起来"话没说完"——
  //   而主人那句「b」「改」本身只有一两个字，不是 bug，是原话就短。
  //   放宽到 200 后该段实测仍只 1351 字符（多数条目本身就很短），几乎不涨预算。
  //
  // 🩸 2026-11-06 修（主人指定 A 方案）：**必须按 session 过滤**。
  //   原来 timeline 不过滤就整段倒进来，而 timeline 是**共享层**，
  //   混着所有窗口的发言。真机症状：日记里出现一串 Qwen4 发布时间的追问，
  //   女仆读了自己写的日记，把**别的窗口的任务**当成本窗口的语境，
  //   还据此去"回忆"那段结论 —— 主人当场指出「Qwen4 是其他窗口的任务，干扰到你了」。
  //
  //   契约：`session` 字段缺失的条目当作本窗口（strand 迁移过来的旧数据没有该字段，
  //   而它们确实是这个窗口的祖先）。有字段且不等于本窗口的 → 归到 ⑤。
  const allEntries = Array.isArray(timeline) ? timeline : []
  const sid = String(sessionId ?? '')
  const mine = allEntries.filter((e) => !e?.session || String(e.session) === sid)
  const otherEntries = allEntries.filter((e) => e?.session && String(e.session) !== sid)

  if (mine.length) {
    lines.push('## 压缩前最后几句对话（本窗口）')
    for (const e of mine.slice(-20)) {
      // by: 'assistant' = 女仆的回复；'auto' = 主人输入（字段名叫 auto，语义是"自动采集的用户输入"）
      const who = e.by === 'assistant' ? '助手' : '主人'
      lines.push(`- ${String(e.at).slice(11, 16)} [${who}] ${oneLine(e.text, 200)}`)
    }
    lines.push('')
  }

  // ⑤ 其它窗口（**不是本窗口的语境**，只供参考）
  //
  // ⚠️ 2026-11-06 新增这一段（主人指定）：原来别窗口的活动只出现在
  //   「同时开着的别的窗口」里，而且是 `liveWindows` 的活口摘要（常常是「（无动静）」），
  //   真实发言反而混进了 ④。现在两边各归各位：
  //     ④ = 我的语境（压缩后要接上的是它）
  //     ⑤ = 别窗口在忙什么（知道就行，**别当自己的事**）
  const otherLines = []
  if (otherEntries.length) {
    for (const e of otherEntries.slice(-10)) {
      const who = e.by === 'assistant' ? '助手' : '主人'
      otherLines.push(
        `- [${shortId(e.session, 8)}] ${String(e.at).slice(11, 16)} [${who}] ${oneLine(e.text, 160)}`,
      )
    }
  }
  if (Array.isArray(others) && others.length) {
    for (const o of others.slice(0, 5)) {
      const act = o.activity?.text ?? o.intent?.text
      if (!act) continue // 「（无动静）」没有信息量，不占行
      otherLines.push(`- [${shortId(o.id, 8)}] ${oneLine(act, 80)}`)
    }
  }
  if (otherLines.length) {
    lines.push('## 别的窗口在忙什么（不是本窗口的事）')
    lines.push(...otherLines)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * 写一篇日记。
 *
 * @param {object} opts
 * @param {boolean} [opts.force]
 *   ⚠️ 2026-11-05 第二次修（主人指定）：`force=true` 时**不看压力**，直接写。
 *
 *   为什么必须加这条路径：原设计只在「压力到 70%」时写，
 *   而主人的压缩全是手打 `/compact`（会话日志里 4 次 compaction/start
 *   的 sourceCommandId 全部来自 `command/run name="compact" source={"kind":"user"}`）。
 *   手动压缩时压力只有 30~45%，**永远够不到 70%** ——
 *   于是真机跑了一整天，`diary/` 目录连建都没建过。
 *
 *   压缩引擎的 `summarize()` 是「压缩已确定发生」的唯一可靠信号，
 *   在那一刻强写，不再靠压力猜。
 *
 * @param {boolean} [opts.returnDetail]
 *   2026-11-05 第三次改（主人指定「到 70% 写完日记再压缩」）：
 *   传 true 时返回结构化结果而不是裸路径，让调用方能判断
 *   「这次是不是因为压力达阈值而写的」→ 是的话就接着发起压缩。
 *
 *   为什么要这个标志而不是让调用方自己算压力：
 *   限流、写盘失败、并发写这些分支全在本函数里，调用方重算一遍必然走偏
 *   （例如：压力到了但 30 分钟限流挡住 → 不该压缩，因为日记没写新的）。
 *
 *   ⚠️ 强制模式（force，压缩时强写）**永远不返回 shouldCompact=true**：
 *   它本身就是压缩触发的，再请求一次就是无限循环。
 *
 * @returns {string|null|{wrote:boolean, path:string|null, pressure:number, shouldCompact:boolean, reason:string}}
 */
export function maybeWriteDiary(
  ctx,
  { sessionId, agent, facts, timeline, others, pursuits, config, now = Date.now(), force = false, returnDetail = false },
) {
  // 统一出口：所有 return 都过这里，保证结构一致。
  // ⚠️ 早期写法是各处直接 `return null`，加 detail 模式后容易漏掉某条分支
  //   返回裸 null，调用方 `r.wrote` 直接抛 TypeError。
  const fail = (reason, pressure = 0) =>
    returnDetail ? { wrote: false, path: null, pressure, shouldCompact: false, reason } : null

  const cfg = config?.diary ?? {}
  if (cfg.enabled === false) return fail('disabled')

  const meter = getMeter(ctx)
  if (!meter || typeof meter.measure !== 'function') {
    // ⚠️ 原来这里静默 return。真机上"日记从没写过"排查时，
    //   日志里一条痕迹都没有，无法区分是"没到阈值"还是"拿不到计量服务"。
    //   静默 return 让一个可能的真 bug 藏了整整一天。
    log(
      `日记跳过 :: 拿不到 tokenMeter` +
        `（ctx.tokenMeter=${describeSlot(ctx, 'tokenMeter')}，ctx.get=${typeof ctx?.get}）` +
        (force ? '［强制模式］' : ''),
    )
    return fail('no-meter')
  }

  let measurement
  try {
    measurement = meter.measure(agent.session)
  } catch (e) {
    log(`日记：measure 失败（继续尝试投影） :: ${e?.message ?? e}`)
    measurement = null
  }

  let totalTokens = Number(measurement?.totalTokens)
  let viaProjection = false
  let viaEstimate = false
  let viaUsage = false

  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    // ⚠️ 2026-11-08 真 bug：pre-step 时机太早，measure 回放的 surface 是空的
    //   （真机日志 37+ 次「totalTokens=0」，而压缩时 force 路径能测出 66%）。
    //   根因：measure() 靠回放当前 surface，而 pre-step 时当前轮事件尚未落盘，
    //   surface 为空 → 走 kind:none 分支 → totalTokens=0。
    //   回退到 contextPressure 的投影：它读 provider 报告的最新 prompt 规模，
    //   由投影系统在事件提交时增量维护，不依赖 surface 回放，pre-step 也能拿到值。
    //   projectedTokens = 下一个请求将花费多少（prompt 侧），
    //   比 pressureTokens（上一个请求）更贴合「会不会触发压缩」。
    //
    // 🩸 2026-11-09 血证：这段回退**从未生效过**。真机日志 47 条「日记跳过」，
    //   「改用投影」**0 条**。查宿主 dsh-token-meter 源码才知：
    //     usage-projection.js:58  pressureFrom = input + cacheRead + cacheWrite
    //     usage-projection.js:183 pressureTokens === undefined || sampledSurfaceTokens === undefined
    //                              ? {}   // ← 两个都缺就整个字段不给
    //                              : { projectedTokens: ... }
    //   即 projectedTokens 要求「已经有至少一次 usage 样本」才算得出来，
    //   而 pre-step 恰恰是第一次请求之前 —— 所以两个值都是 undefined，
    //   回退必然失败。上一轮「已修」是按代码推理认为修好了，没有验证日志。
    //
    // 现在三层：① 投影 ② 字符估算兜底 ③ 失败必须留痕（不再静默）。
    const cpInfo = probeContextPressure(meter, agent)
    const proj = Number(cpInfo.cp?.projectedTokens)
    const pres = Number(cpInfo.cp?.pressureTokens)
    if (Number.isFinite(proj) && proj > 0) {
      totalTokens = proj
      viaProjection = true
      log(`日记：measure 回放不到 surface，改用投影 projectedTokens=${proj}`)
    } else if (Number.isFinite(pres) && pres > 0) {
      totalTokens = pres
      viaProjection = true
      log(`日记：measure 回放不到 surface，改用投影 pressureTokens=${pres}`)
    } else {
      // ── 兜底：按字符数粗估 ──
      //
      // ⚠️ 为什么要有这一层：日记的目的是「压缩前留个念」，它宁可压力估偏，
      //   也不该因为测不出压力就整天不写 —— 现在就是后者（47 次全跳过）。
      //   估算口径刻意**偏保守**（宁可高估压力，早写总比不写好）：
      //   一次请求的 token ≈ 字符数 / 1.8（英文约 4 字符/token，
      //   中文约 1.2-1.5 字符/token，混排取偏小分母得到更大的 token 数）。
      //
      // ⚠️ 这是**估算**不是测量，日志里必须写 `估算` 字样，不许伪装成实测。
      const est = estimateTokensFromSession(agent, { charsPerToken: 1.8 })
      if (est.tokens > 0) {
        totalTokens = est.tokens
        // ⚠️ 三种来源必须区分清楚，否则下次排查分不清"谁救的场"：
        //   `|usage@seqN`  = 第 ④ 层，取自宿主记录的**提供方真实用量**（不是估算！）
        //   `|log-tail`    = 已作废的扫日志方案（保留分支以防历史配置命中）
        //   其它           = 第 ③ 层，按字符数估算
        const reason = String(est.reason)
        const isUsage = reason.includes('usage@')
        if (isUsage) {
          viaUsage = true
        } else {
          viaEstimate = true
        }
        const layer = isUsage ? '用量实测' : reason.includes('log-tail') ? '日志尾巴估算' : '字符估算'
        // 实测值不许写"估算"，口径必须诚实。
        const kind = isUsage ? '实测量' : '估算'
        log(
          `日记：投影不可用（contextPressure=${describeContextPressure(cpInfo)}），` +
            `改用${layer} ${kind} tokens≈${est.tokens}（reason=${reason}，` +
            `${isUsage ? '取自 assistant/message 的 data.usage' : '保守估'}）`,
        )
      } else {
        // ── 第⑤层：必须留痕，但**要留对标** ──
        //
        // ⚠️ 原来这里无声通过：回退的 try 里两个分支都不满足就什么都不打，
        //   于是「日记为什么没写」在日志里查不出来（本文件 :352 那次教训同源）。
        //
        // 🩸 2026-11-12 改：原本文案是「四层取数全失败」，把**正常情况**也
        //   报成了失败。真相是这 34 次全是「新会话第一句话、日志里还没有任何
        //   assistant/message」——压力 3.7%~5.2%，离 62% 阈值差十几倍，
        //   永远用不到日记。它每次都打一行像报错的话 → 34 次假警报。
        //
        //   现在分两种文案，**判据是数事件（确定性），不是猜**：
        //     · 新会话开头、没有历史     → 「无历史可测，正常跳过」+ 不打 ⚠️ 字样
        //     · 有历史却仍然测不出来     → 「四层取数全失败」← 这才是真故障
        //
        //   ⚠️ 关键：只是**改文案 + 分流**，判断逻辑（返回 fail）完全没动。
        //     两边的行为都是「不写日记」，变的只是"日志说了实话没有"。
        const fresh = probeFreshSession(agent?.session)
        if (fresh.isFresh) {
          // ⚠️ 这里不能引用 `threshold` —— 它定义在下面（:857），此时还是 TDZ，
          //   直接读会抛 ReferenceError。所以就地按同一口径算一遍。
          const thr = Number.isFinite(cfg.pressureRatio) ? cfg.pressureRatio : 0.62
          log(
            `日记跳过 :: 新会话开头、还没有历史可测（正常，非故障）` +
              `（session.seq=${fresh.seq}，assistant/message=${fresh.assistantCount}，` +
              `user/message=${fresh.userCount}；` +
              `压力远低于 ${(thr * 100).toFixed(0)}% 阈值，此时不需要日记）`,
          )
        } else {
          log(
            `日记跳过 :: 四层取数全失败` +
              `（measure.totalTokens=${measurement?.totalTokens}，` +
              `contextPressure=${describeContextPressure(cpInfo)}，` +
              `估算=${est.reason}，session.seq=${fresh.seq || (agent?.session?.seq ?? 'n/a')}，` +
              `assistant/message=${fresh.assistantCount}）`,
          )
        }
        return fail('zero-tokens')
      }
    }
  }

  const windowTokens = resolveWindow(agent, cfg.contextWindow)
  const pressure = totalTokens / windowTokens
  // 回退值与 config.js 的 diary.pressureRatio 保持一致（2026-11-06 改 0.7 → 0.62）。
  // ⚠️ 两处不同步就会出现「配置写 0.62、实际按 0.7 跑」这种难查的偏差。
  const threshold = Number.isFinite(cfg.pressureRatio) ? cfg.pressureRatio : 0.62

  // ── 诊断：每会话**只打一次**取数结果 ──
  //
  // ⚠️ 2026-11-09 加这条的原因（真机验证时踩到的盲区）：
  //   修完三层取数、重启后，日志里**一条新文案都没有**。
  //   查下来是压力低于 62% → 走下面 `below-threshold` 静默 return。
  //   这个分支本身是**对的**（每步都打会把日志刷爆），
  //   但它导致「新代码到底生效没有」无法从日志判断 ——
  //   重启后的验证因此卡住，只能靠读代码猜。
  //
  //   对策：每次会话第一次调用时，**无论走哪个分支**都留一条取数诊断。
  //   这样重启后第一句话就能看到「新代码跑到了哪一层、拿到了什么值」，
  //   而后续步骤仍然安静。用模块级 Set 保证只打一次，重启即重置。
  if (!DIAG_LOGGED.has(sessionId)) {
    DIAG_LOGGED.add(sessionId)
    // ⚠️ via 必须能区分 usage：否则重启后看到 `via=estimate` 会误以为
    //   还在用字符估算，实际是 usage 实测 —— 那就成了"新代码生效了却看不出来"。
    const viaLabel = viaUsage
      ? 'usage'
      : viaProjection
        ? 'projection'
        : viaEstimate
          ? 'estimate'
          : 'measure'
    log(
      `日记取数诊断 :: ${sessionId.slice(0, 6)}… ` +
        `measure=${measurement?.totalTokens ?? 'n/a'} ` +
        `via=${viaLabel} ` +
        `total=${totalTokens} window=${windowTokens} ` +
        `pressure=${(pressure * 100).toFixed(1)}% threshold=${(threshold * 100).toFixed(0)}%` +
        (force ? '［强制］' : ''),
    )
  }

  if (!force && pressure < threshold) {
    // 压力没到阈值是**正常路径**，每步都会走，不能刷日志。
    return fail('below-threshold', pressure)
  }

  // ── 限流：同一会话按时间间隔 ──
  //
  // ⚠️ 强制模式（压缩时强写）用**更短**的闸门，而不是完全绕过：
  //   `summarizeCompaction` 失败后会 `recover` 并**重试同一区间**，
  //   那时会再调一次 `summarize()` → 再调一次本函数。
  //   如果 force 完全无视限流，重试就会写出两篇几乎一样的日记。
  //   60 秒足够区分"同一次压缩的重试"和"两次真的压缩"。
  const minGap = force ? DIARY_FORCE_MIN_GAP_MS : DIARY_MIN_GAP_MS
  const existing = listDiaries(sessionId)
  if (existing.length) {
    try {
      const lastMtime = statSync(existing[existing.length - 1]).mtimeMs
      if (now - lastMtime < minGap) {
        if (force) {
          log(
            `日记跳过 :: 压缩强写但 ${Math.round((now - lastMtime) / 1000)} 秒前刚写过` +
              `（判断为同一次压缩的重试）`,
          )
        }
        return fail('rate-limited', pressure)
      }
    } catch {
      /* 读不到就当没有，继续写 */
    }
  }
  if (existing.length >= DIARY_MAX_PER_SESSION) {
    // 超上限：删最旧的一篇，保留最近的
    //
    // ⚠️ 这里原来是 `require('node:fs')` —— ESM 模块里没有 require，
    //   会抛 ReferenceError。虽然被 try 吞掉了不影响主流程，但等于**这条清理从来没生效过**。
    //   已改成顶部 import 的 unlinkSync。
    try {
      unlinkSync(existing[0])
    } catch (e) {
      log(`日记：清理最旧一篇失败（不影响继续写） :: ${e?.message ?? e}`)
    }
  }

  const body = composeDiary({
    sessionId, now, pressure, windowTokens, totalTokens, facts, timeline, others, pursuits,
    // ⚠️ usage 必须排在 estimate 前面：否则实测值会被日记写成「字符估算」。
    source: viaUsage
      ? 'usage'
      : viaProjection
        ? 'projection'
        : viaEstimate
          ? 'estimate'
          : 'measure',
  })
  const dir = DIARY_DIR()
  ensureDir(dir)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const prefix = shortId(sessionId, 12).replace(/…$/, '')
  const path = join(dir, `${prefix}-${stamp}.md`)

  try {
    writeFileSync(path, body, 'utf8')
    log(
      `压缩前日记已写 :: ${shortId(sessionId, 6)} ${Math.round(pressure * 100)}%` +
        `${force ? '（压缩时强写）' : '（压力达阈值）'} → ${path}`,
    )
    // ── 关键：写完才说「可以压缩」 ──
    //
    // 主人 2026-11-05 定的顺序：**到 70% → 先写完日记 → 再压缩**，
    // 这样压缩永远不会打断写日记这个动作。
    //
    // ⚠️ force（压缩时强写）一律 shouldCompact=false：
    //   这条路径本身就是压缩流程内部调进来的，再请求一次压缩 = 无限循环。
    const shouldCompact = !force && pressure >= threshold
    return returnDetail
      ? { wrote: true, path, pressure, shouldCompact, reason: shouldCompact ? 'threshold' : 'forced' }
      : path
  } catch (e) {
    log(`压缩前日记写入失败 :: ${e?.message ?? e}`)
    return fail('write-failed', pressure)
  }
}
