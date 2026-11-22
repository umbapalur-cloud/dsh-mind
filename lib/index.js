/**
 * dsh-mind —— 自我觉知 + 经验库 + 压缩引擎（跨会话已拆出）
 *
 * CCG 六要素:
 *   功能名   dsh-mind：把经验库（规范）+ 自身状态（第一人称）合成一个插件，
 *            并接管上下文压缩（自己的摘要指令 + 压缩前日记 + 可逆存档）
 *   生效条件 装进 desktop profile，替代旧的 dsh-psyche
 *   子功能   两段渲染合并成一条注入 / 统一配置 / mind_* 工具 / 统一日志
 *            压缩引擎入口在 lib/compaction.js（`dsh-mind/compaction`）
 *   执行     唯一的 agent/pre-step handler；两段各自包 try/catch，单段失败只丢该段
 *   验证方式 tests/regress.mjs
 *   不适用条件 需要语义判断「哪句话重要」（本插件只做确定性规则）
 *
 * ⚠️⚠️ 2026-11-08 拆分（主人要求）：跨会话记忆已独立成 **dsh-strand** 插件。
 *
 * 拆分前本插件是三合一：跨会话脉络（第三人称）+ 经验库（规范）+ 自身状态（第一人称）。
 * 现在第一段搬走了。理由：**跨会话记忆是"数据"，自我觉知是"状态"** ——
 * 生命周期、开关时机、故障影响面完全不同。跨会话关掉了，自我觉知照常该跑；
 * 跨会话数据坏了，不该连累压缩日记。
 *
 * ## 拆分后本插件**不再有**的东西（别来这里找）
 *   ❌ global.json / facts / timeline / threads      → 在 dsh-strand
 *   ❌ notes/ 长内容外置                             → 在 dsh-strand
 *   ❌ 跨窗口投递 push / 回复同步 replySync           → 在 dsh-strand
 *   ❌ mind_remember / mind_recall / mind_forget / mind_keys → 变成 strand_*
 *
 * ## 拆分后本插件**仍然有**的
 *   ✅ psyche 段（自我觉知：注意力分散在哪几处）
 *   ✅ tacit 段（经验库自动命中）
 *   ✅ 压缩引擎（中文摘要 + 压缩前日记 + 可逆存档 + 主动压缩）
 *   ✅ mind_intend / mind_view / mind_windows / mind_status
 *   ✅ mind_expand / mind_search / mind_compress
 *
 * ## 两插件之间唯一的联系：**软依赖，只读文件**
 *   写压缩前日记时，本插件会尽力读一份 dsh-strand 的 facts/timeline 摘录
 *   （`lib/peer.js`）。读不到就留空 —— **绝不 import 对方的模块**，
 *   理由写在 peer.js 文件头（卸载即崩 / 版本锁死 / 循环依赖）。
 *
 * ⚠️ 六条必须守住的纪律（沿用整合前的血教训）：
 *   1. 注入消息必须带 id + role + content + source，缺了会写坏整个会话历史
 *   2. 绝不调用 resolveAgent/resume，只用 ctx.agents.get()/list()，拿不到就放过
 *   3. agent/pre-step 必须 await next()，否则吞掉其他插件的决策
 *   4. 任何失败都要静默降级 —— 注入挂了不能带崩主人的对话
 *   5. 一个状态只能有一个写入者
 *   6. 段级失败必须**大声**：装了却没注入，比不装更难查
 */

export const name = 'dsh-mind'
// psyche 段要 ctx.agents（列存活窗口）。投递已搬走，但窗口表还要用。
export const inject = ['agents']

import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { log, MIND_DIR, shortId } from './io.js'
import { readConfig, CONFIG_PATH } from './config.js'
import { Store, clearLegacyAlive, ALIVE_TTL_MS } from './state.js'
import { applyBudget, gapFor } from './budget.js'
import { makeInjectionMessage, insertAfterClaimed, isSelfMessage, looksMachine, textOf, KIND_INJECT } from './message.js'
import * as TacitSegment from './segments/tacit.js'
import * as PsycheSegment from './segments/psyche.js'
import { maybeWriteDiary, latestDiaryText } from './diary.js'
// ⚠️ 2026-11-08 拆分：`./notes.js` 的 import 已删除。
//   外置笔记是 **facts 的正文** 的外置存储（`externalize(fact.key)`），
//   而 facts 整块已搬到 dsh-strand。人拆走后这里只剩一个还写着
//   `readGlobal()` 的启动清理块 —— 那个符号已随 `global.js` 一起删掉，
//   于是每次启动都在日志里留一行 `readGlobal is not defined`。
//   留着它等于把一个**永久失败的清理任务**挂在启动路径上，
//   而且它扫的是 `~/.dsh/mind/notes`（旧的 facts 笔记目录），
//   在 facts 已搬家之后那里只会是历史残留 —— 清理它反而会误删数据。
//   归属：笔记目录 `~/.dsh/strand/notes`，清理逻辑在 dsh-strand/lib/index.js。
import { sweepArchives, listArchives } from './archive.js'
import * as Proactive from './proactive.js'
import { makeToolDefinitions } from './tools.js'
import { createToolRegistrar } from './tool-register.js'
import { readPeerGlobal } from './peer.js'
import * as Lifeline from './lifeline.js'
import * as ToolLedger from './tool-ledger.js'

/** mind-cli 的绝对路径（从本模块位置推，不写死开发机路径）。 */
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

/** Map 上界。`agent/disposed` 现版宿主会触发（2026-11-16 实测），但进程被杀时不发 —— 事件清理之外仍需上界兜底。 */
const MAP_MAX = 200

/**
 * 注入间隔的环境变量覆盖（测试用；用户也可按需调）。
 *
 * ⚠️ 这里必须是一个**函数**，不能在模块加载时算成常量（2026-11-03 测试抓到）：
 *   第一版写成模块级常量 `const GAP_ENV = (() => {...})()`，
 *   于是测试里中途改 `process.env.MIND_REFRESH_MS` **完全没效果** ——
 *   模块早就被 import 过、常量定死了，改环境变量对已经算好的值没有影响。
 *   后果很隐蔽：那条"间隔很大时不注入"的判据**永远测不到节流**，
 *   因为间隔一直是初始的 0。
 *   改成每次调用都读一次，代价是一次 Number() 转换，可忽略。
 */
function gapEnvOverride() {
  const raw = Number(process.env.MIND_REFRESH_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : null
}

/**
 * 检测本会话自上次记录以来是否发生过压缩。
 *
 * ⚠️ 判据取「日志尾部出现比上次更大的 compaction/end seq」，而不是扫全量：
 *   会话日志可达上万条，每步全扫会把 pre-step 变成瓶颈。
 *   压缩总在尾部附近发生，取尾部足够。
 *
 * ⚠️ 三条取数路径依次尝试，全都失败就返回 false（**宁可漏一次全量，不可误判**）：
 *   ① agent.session.log 数组（本机实测存在，collectReplies 已在用）
 *   ② session.eventAt(seq)（新版 API）
 *   ③ 什么都不给 → false
 *
 * ⚠️ 为什么不用派生消息里有没有 <compacted-summary> 来判：
 *   那是"压缩已生效"的间接证据，但要遍历所有消息取文本，比只看尾部事件贵得多，
 *   而且摘要块会一直留在历史里 → 会导致**每次都判成压缩**，反而变成每步全量注入。
 */
function detectCompaction(agent, sessionId, seqMap, scanTail = 300) {
  const session = agent?.session
  if (!session) return false

  let lastEnd = null

  // ① 旧路径：session.log 是事件数组
  const arr = session.log
  if (Array.isArray(arr) && arr.length) {
    const from = Math.max(0, arr.length - scanTail)
    for (let i = arr.length - 1; i >= from; i--) {
      const e = arr[i]
      if (e?.type === 'compaction/end') {
        lastEnd = Number(e.seq)
        break
      }
    }
  }

  // ② 新路径：按 seq 读单个事件
  if (lastEnd === null && typeof session.eventAt === 'function' && Number.isFinite(session.seq)) {
    const total = Number(session.seq)
    for (let s = total; s > Math.max(0, total - scanTail); s--) {
      try {
        const e = session.eventAt(s)
        if (e?.type === 'compaction/end') {
          lastEnd = Number(e.seq)
          break
        }
      } catch {
        break
      }
    }
  }

  // ── 水位统一用「数字」，0 表示「见过、但当时还没有任何压缩」 ──
  //
  // ⚠️ 2026-11-05 真机修的真 bug：原写法 `if (!Number.isFinite(lastEnd)) return false`
  //   直接返回，**连水位都不记**。于是「从来没压缩过的会话」在 seqMap 里永远没有条目；
  //   等它第一次真被压缩时，`prev === undefined` 会走「首次见到」分支 → 只记账不触发
  //   → **第一次压缩永远漏掉**，要等第二次才生效。
  //
  //   血证（某个真实会话（本机））：
  //     05:13:32  compaction/end seq=1649（本会话第一次压缩）
  //     05:20:31  injected (增量·第1次) chars=1075   ← 全量是 6317
  //     mind.log 里「检测到压缩」= 0 条
  //
  //   现在改成：没压缩也记 0。压缩发生时 1649 > 0 → 立刻触发。
  const cur = Number.isFinite(lastEnd) ? lastEnd : 0

  const prev = seqMap.get(sessionId)
  if (prev === undefined) {
    // 首次见到：只记账，不触发（否则每个窗口第一步都会白做一次全量）
    // ⚠️ 记的是 cur（可能是 0），不是「跳过不记」—— 见上面的血证。
    seqMap.set(sessionId, cur)
    return false
  }
  if (cur > prev) {
    seqMap.set(sessionId, cur)
    return true
  }
  return false
}

/**
 * 读当前会话「已见到的最大 compaction/end seq」，只读不记账。
 *
 * 用途：把它放进注入指纹。压缩会让 seq 变大 → 指纹必变 → 强制走全量，
 * 且**只在压缩那一次**变（之后稳定），不会每步重复触发。
 */
export function currentCompactionSeq(seqMap, sessionId) {
  return seqMap.get(sessionId) ?? 0
}

/**
 * 「工具已注册」这条日志是否已经写过。
 *
 * ⚠️ 为什么是**模块级**而不是 apply 里的局部变量（2026-11-05 真机取证后定）：
 *   局部变量 `registered` 在真机上挡不住重复打印 —— 一次启动出现 8 条一模一样的
 *   「已注册 7 个（第 9 次尝试）」，全在 13ms 内。
 *   女仆没能证明具体是哪种重入（不编原因），但能确定这是**纯日志噪声**：
 *   工具本身 7/7 全部注册成功（真机实测）。
 *   模块级标记跨闭包共享，不依赖任何时序假设 —— 机制再怪，日志也只有一行。
 */
let TOOLS_REGISTERED_LOGGED = false

export function apply(ctx) {
  let config = readConfig()
  log(`APPLY-CALLED :: pid=${process.pid} dir=${MIND_DIR()} enabled=${config.enabled}`)

  if (!config.enabled) {
    log('mind 已按配置关闭（enabled=false），不注册任何行为')
    return
  }

  // ── 配置热生效（2026-11-03 第三轮加） ──
  //
  // ⚠️ 为什么必须做：原来 config 只在 apply 时读一次，改 `~/.dsh/mind.json`
  //   **必须重启 DSH 才生效**。而这是个"调预算 / 关某一段"的开关，
  //   主人改配置的动机通常正是"现在就想让它别那么吵"，重启的代价太大。
  //   旧插件 dsh-wake 用 60 秒轮询解决了同一问题（成熟形态），这里沿用。
  //
  // ⚠️ 轮询的代价：每 15 秒 stat 一次小文件，比一次工具调用便宜几个数量级。
  //   而且只在 mtime 变了才真解析 —— 没改配置时开销几乎为零。
  //
  // ⚠️ 不能因为热生效就"每次都读"：readConfig 会做逐层合并，
  //   每分钟在 pre-step 里跑几十次是浪费。所以用 mtime 判变更。
  const CONFIG_POLL_MS = 15 * 1000
  let lastConfigMtime = 0
  try {
    const p = CONFIG_PATH()
    lastConfigMtime = existsSync(p) ? statSync(p).mtimeMs : 0
  } catch {
    lastConfigMtime = 0
  }

  function maybeReloadConfig() {
    try {
      const p = CONFIG_PATH()
      const mtime = existsSync(p) ? statSync(p).mtimeMs : 0
      if (mtime === lastConfigMtime) return false
      const next = readConfig()
      /**
       * ⚠️ 2026-11-17 修（隔离实测：坏 JSON 热加载把已关闭的 psyche 重新打开）。
       *
       * readConfig 在解析失败时会**返回默认值**（默认全开）。原实现把返回值当成
       * 新配置直接采用，于是主人明确关掉的功能被一次编辑器中间态打开，
       * 日志还写着「配置已热加载 :: enabled=true」——看起来一切正常。
       *
       * 现在：配置损坏时**不采用**，保持上一次有效配置。
       *   也不推进 lastConfigMtime —— 这样文件被修好后（mtime 再变）仍会重试；
       *   但如果主人保存后 mtime 恰好没变，下一次文件变动前我们会一直用旧配置，
       *   这是比"悄悄打开已关功能"明显更安全的方向。
       */
      if (next.__corrupted === true) {
        log(`配置热加载被拒绝 :: 文件损坏（${next.__corruptReason ?? 'unknown'}），继续使用上一次有效配置`)
        return false
      }
      // ⚠️ 2026-11-09 真机修（顺序问题）：lastConfigMtime 必须在**确认新配置
      //   可用之后**才推进。原来先推进再读，读失败（如 BOM）后 mtime 已记成
      //   坏文件的 → 文件修好但 mtime 没变的话永远不再重试；而 catch 里
      //   「继续用旧配置」也要求 config 真的没被换掉 —— 所以赋值放在日志前、
      //   日志行本身不许抛（见下）。
      const prev = config
      config = next
      lastConfigMtime = mtime
      log(
        `配置已热加载 :: enabled=${next.enabled} ` +
          // ⚠️ 2026-11-09 真机修：strand 段 11-08 已搬去 dsh-strand，
          //   DEFAULT_CONFIG 里没有这个键 → next.strand undefined → 抛 TypeError。
          //   更毒的是 :240 已把 config 换成新的，抛在日志行 → catch 说「继续用
          //   旧配置」是谎话；且 lastConfigMtime 已推进，文件不再改就**永远不再重试**
          //   —— 一次 BOM 坏文件把热加载永久卡死（真机 07:49:50 实测）。
          //   现在：只报现存段；日志行绝不访问可能缺席的键。
          `tacit=${next.tacit.enabled}/${next.tacit.inject} ` +
          `psyche=${next.psyche.enabled}/${next.psyche.inject} budget.total=${next.budget.total}` +
          (prev.enabled !== next.enabled ? '（总开关变了，需重启才完全生效）' : ''),
      )
      return true
    } catch (e) {
      log(`配置热加载失败（继续用旧配置） :: ${e?.message ?? e}`)
      return false
    }
  }

  const configTimer = setInterval(maybeReloadConfig, CONFIG_POLL_MS)
  if (typeof configTimer.unref === 'function') configTimer.unref()
  ctx.effect?.(() => () => clearInterval(configTimer))

  const store = new Store()
  // ⚠️ 显式打开落盘（这个开关默认关着，见 state.js snapshot() 的注释）。
  //   只有插件本体才该写主人的真实数据；调试脚本/测试默认写不进去 ——
  //   2026-11-03 女仆调试时忘了设 MIND_DIR，把主人 4 条追求写成了 1 条，
  //   靠备份才救回来。这个开关让同类错误的方向变成"少写一次盘"而不是"写坏数据"。
  store.allowPersist = true

  // 新进程不认识旧进程的窗口。
  store.resetAlive()
  const legacyCleared = clearLegacyAlive()
  log(`启动清理 :: 内存窗口 ${store.windows.size} 个，旧 strand 遗留文件 ${legacyCleared} 个`)

  // ── 每窗口的注入记账 ──
  /** sessionId → 上次注入时间（毫秒） */
  const lastInjectAt = new Map()
  /** sessionId → 上次注入时的「状态指纹 + 压缩水位」，用于"没变就不重复注入" */
  const lastFingerprint = new Map()
  /** sessionId → { fullCount, psycheSnap, tacitKey, lastInjectAt } */
  const deltaState = new Map()
  /** sessionId → 上次注入的字符数（用于在渲染前估间隔，省掉无用的渲染） */
  const lastCharsInjected = new Map()
  /**
   * sessionId → 已见过的最大 compaction/end seq。
   *
   * ⚠️ 这个 Map 是 P1-a 修复的核心。压缩会把之前的注入消息从表层遮蔽掉，
   *   但内存里的 deltaState 仍以为"已经给过了" → 旧内容永远不再重发。
   *   记下压缩水位，一旦发现新的 compaction/end 就强制转全量。
   */
  const lastCompactionSeq = new Map()

  function trimMaps() {
    if (lastInjectAt.size > MAP_MAX) {
      for (const k of lastInjectAt.keys()) {
        if (lastInjectAt.size <= MAP_MAX) break
        lastInjectAt.delete(k)
        lastFingerprint.delete(k)
        deltaState.delete(k)
        lastCharsInjected.delete(k)
        lastCompactionSeq.delete(k)
      }
    }
    // 未曾注入过的会话也可能写入 lastCompactionSeq，独立裁剪防止长期运行无界增长
    if (lastCompactionSeq.size > MAP_MAX * 2) {
      for (const k of lastCompactionSeq.keys()) {
        if (lastCompactionSeq.size <= MAP_MAX) break
        if (!lastInjectAt.has(k)) lastCompactionSeq.delete(k)
      }
    }
  }

  // ─────────────────── 通道①：工具动作（psyche 段） ───────────────────
  //
  // 为什么要挂在 tools/pre-execute 而不是等 agent 自己说：
  //   模型不会主动汇报每一步动作。而工具调用是**宿主强制发生**的信号。
  //
  // ⚠️ 两个事件都注册，互为兜底：psyche 时代实测只注册 tools/pre-execute
  //   会**一条动作都采不到**（agent-scoped 派发下不一定送到 root 监听器）。
  //   判据：宁可记两遍（内容相同，后到覆盖先到），不能不记。
  let activityLoggedOnce = false
  function collectToolActivity(exec) {
    try {
      // 实时读热加载配置：启动关→热开 或 启动开→热关 都立刻生效
      if (!config.enabled || !config.psyche?.enabled || !config.psyche?.collectTools) return
      const id = exec?.agent?.id ?? exec?.agent?.session?.id
      if (!id || !exec?.name) return
      const before = store.windows.get(id)?.activity?.seq ?? 0
      const tgt = PsycheSegment.activityTarget(exec.name, exec.arguments)
      store.recordActivity(id, exec.name, tgt || PsycheSegment.humanTool(exec.name))
      const after = store.windows.get(id)?.activity?.seq ?? 0
      if (after !== before && !activityLoggedOnce) {
        activityLoggedOnce = true
        log(`activity 通道已确认工作 :: 首个动作=${exec.name}`)
      }
    } catch (e) {
      log(`activity 采集失败（已放行） :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
    }
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    collectToolActivity(exec)
    return next()
  })
  ctx.on('tools/execute', async (exec, next) => {
    collectToolActivity(exec)
    return next()
  })
  if (config.psyche.enabled && config.psyche.collectTools) {
    log('activity 通道已注册 :: tools/pre-execute + tools/execute（互为兜底）')
  }

  // ─────────────────── 通道①b：工具结果账本（tool ledger） ───────────────────
  {
    const sid = (exec) => exec?.agent?.id ?? exec?.agent?.session?.id ?? null
    const cid = (exec) => exec?.callId ?? exec?.rootCallId ?? null
    const skip = (exec) => /^mind_/.test(String(exec?.name ?? ''))

    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (config.enabled && config.toolLedger?.enabled && !skip(exec) && sid(exec)) {
          const cur = config.toolLedger
          const r = ToolLedger.record({
            sessionId: sid(exec),
            tool: exec.name,
            result: null,
            pending: true,
            callId: cid(exec),
            summary: ToolLedger.summarizeArgs(exec.name, exec.arguments, cur.summaryMaxChars),
            maxEntries: cur.maxEntries,
            summaryChars: cur.summaryMaxChars,
            deferMs: 1200,
          })
          if (r.ok === false && r.error) log(`工具账本写入失败（已放行） :: ${r.error}`)
        }
      } catch (e) {
        log(`工具账本异常（已放行） :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
      }
      return next()
    })

    ctx.on('tools/post-execute', async (exec, result, next) => {
      try {
        if (config.enabled && config.toolLedger?.enabled && !skip(exec) && sid(exec)) {
          const r = ToolLedger.settle({ sessionId: sid(exec), tool: exec.name, result, callId: cid(exec), deferMs: 1200 })
          if (r.missing) log(`工具账本 :: post-execute 到达但没有对应 pending（${exec.name}）`)
          else if (r.ok === false && r.error) log(`工具账本补全失败（已放行） :: ${r.error}`)
        }
      } catch (e) {
        log(`工具账本补全异常（已放行） :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
      }
      return typeof next === 'function' ? next() : { kind: 'accept' }
    })

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => ToolLedger.flush())
    }
    if (config.toolLedger?.enabled) {
      log('工具账本已注册 :: tools/pre-execute（pending）+ tools/post-execute（补成成败）')
    }
  }

  // ─────────────────── 通道②：主人说话（状态层） ───────────────────
  //
  // ⚠️ 2026-11-08 拆分后**只剩状态层**这一件事：
  //   ① 状态层：注意力被拉到这里（psyche 段用）
  //   删掉的两件已搬到 dsh-strand：
  //     ② 共享层 timeline 采集（那是跨会话记忆的数据）
  //     ③ 统一投递 push（那是跨窗口的事）
  //   本插件不再写任何跨会话数据 —— 一个状态只能有一个写入者。
  ctx.on('agent/inbox/claimed', ({ agent, message } = {}) => {
    try {
      // ⚠️ 总开关每步都看（同 pre-step 的理由）：热关掉之后不该再采集。
      if (!config.enabled) return

      const sessionId = agent?.id ?? agent?.session?.id
      if (!sessionId || !message) return

      // ⚠️ 仍然要判 isSelfMessage：dsh-strand 的注入（含投递）会流经这里。
      //   不挡的话，会把别的插件的注入当成主人说的话记进"主人最后说了什么"，
      //   于是 psyche 段会显示「主人在这处最后说的是「【跨会话脉络…】」」。
      if (isSelfMessage(message)) return
      // ⚠️ 2026-11-09 补第二道闸：机器播报（<goal_round> 续跑、background job
      //   回执、<system-reminder> 等）role 也是 user，但**不是主人说的话**。
      //   只挡 isSelfMessage 时它们会进 lastUserText，被 psyche 段渲染成
      //   「主人最后说的是 <goal_round>…」——那段带指令口吻（"Continue working
      //   toward..."），别的窗口看到有被当成新授权的风险。这正是 message.js
      //   里 looksMachine 注释记录的 2026-11-03 共享层污染，同一个入口在
      //   状态层还开着。判据必须行为级可测：tests/regress.mjs 第 72 组。
      if (looksMachine(textOf(message))) return
      const raw = textOf(message)
      if (!raw) return

      const isFirstForWindow = !store.windows.get(sessionId)?.lastUserAt
      store.recordUserTurn(sessionId, raw)

      if (isFirstForWindow) log(`窗口首次说话 :: ${shortId(sessionId, 6)} :: ${raw.slice(0, 40)}`)
    } catch (e) {
      log(`inbox 采集失败 :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
    }
  })

  // ─────────────────── 通道③：思考状态（psyche 段） ───────────────────
  ctx.on('agent/status', ({ agent, status } = {}) => {
    try {
      const id = agent?.id ?? agent?.session?.id
      if (!id) return
      store.setThinking(id, status === 'running')

      // ── 主动压缩：turn 关闭、agent 转 idle 时把排队的压缩真正执行掉 ──
      //
      // ⚠️ 这里是**唯一**能调 compactNow 的时机。理由见 lib/proactive.js 顶部注释：
      //   工具执行时 turn 未关，compactNow 必吃 busy。
      // ⚠️ 不 await：agent/status 是 emit 类监听器，阻塞它会拖慢宿主的状态机。
      //   drainOnIdle 自己吞掉全部异常并写 notice，不会漏成 unhandled rejection。
      if (status === 'idle' && Proactive.hasPending(agent)) {
        Proactive.drainOnIdle(ctx, agent).catch((e) =>
          log(`主动压缩 drain 异常 :: ${e?.message ?? e}`),
        )
      }
    } catch (e) {
      log(`status 采集失败 :: ${e?.message ?? e}`)
    }
  })

  // ─────────────────── 生命周期 ───────────────────
  ctx.on('agent/created', ({ agent } = {}) => {
    try {
      const id = agent?.id ?? agent?.session?.id
      if (!id) return
      store.touch(id)
      store.snapshot()
      log(`agent created :: ${shortId(id, 6)}`)
    } catch (e) {
      log(`agent/created 处理失败 :: ${e?.message ?? e}`)
    }
  })

  ctx.on('agent/disposed', ({ agent } = {}) => {
    try {
      const id = agent?.id ?? agent?.session?.id
      if (!id) return
      store.dispose(id)
      lastInjectAt.delete(id)
      lastFingerprint.delete(id)
      deltaState.delete(id)
      lastCharsInjected.delete(id)
      lastCompactionSeq.delete(id)
      store.snapshot()
      // ⚠️ 2026-11-16 体检 A5 修：clearSession 写好后一直没人调 ——
      //   账本按会话累格、只进不出（真机半天 2 格→6 格）。
      //
      // ⚠️ 但**不能**在 disposed 里直接清（2026-11-16 重启验收时的设计修正）：
      //   本宿主里 agent 与 session 不是一对一 —— 每次重启，同一 session 的
      //   agent 都会 disposed 再 created（真机日志：19:35:49 disposed 80e900…，
      //   19:36:09 同一 id 又 created）。账本按 **session** 存、为跨压缩/跨重启
      //   服务，disposed 时清等于每次重启把最有用的历史抹掉。
      //   所以这里只留痕；真正的清理交给启动时 sweepSessions（7 天无动静才清）。
      log(`agent disposed :: ${shortId(id, 6)}`)
    } catch {
      /* 忽略 */
    }
  })

  // ⚠️ 2026-11-08 拆分：跨窗口投递（pushToPeers）已整体搬到 dsh-strand。
  //   本插件不再向任何窗口 inject 消息 —— 它只回答"我是谁、我在哪"，
  //   不再回答"别处说了什么"。见文件头职责边界表。

  // ─────────────────── 唯一的 pre-step ───────────────────
  //
  // ⚠️ 整合前这里有三个独立的 agent/pre-step handler（strand、tacit、psyche），
  //   外加 memory-hub 用 ctx 代理把它们链起来。整合后只有一个：
  //   一次 next()、一次读盘、一次指纹、一条消息、一个预算。
  ctx.on('agent/pre-step', async (payload, next) => {
    // 必须先拿默认决策，否则吞掉其他插件的修改。
    const decision = await next()

    try {
      // ⚠️ 总开关必须每步都看（2026-11-03 第三轮补）：
      //   `config` 现在会热加载，但 apply 里那句 `if (!config.enabled) return`
      //   只在启动时执行过一次 —— 热改成 false 之后它**不会**重新生效，
      //   注入照旧继续。加了这一行，关掉总开关才能真正安静下来
      //   （仍然需要重启才能彻底卸载，但至少不再注入/不再写共享层）。
      if (!config.enabled) return decision

      const agent = payload?.agent
      const sessionId = agent?.id ?? agent?.session?.id
      if (!sessionId) return decision
      if (payload?.signal?.aborted) return decision
      if (decision?.kind === 'reject') return decision

      // 每步续期「活着」—— 必须放在任何 return 之前。
      // 否则一个窗口只要不触发注入（内容没变、没到间隔），就会被判成死，
      // 于是别的窗口看到「当前共 1 个窗口在用」，明明它还开着。
      store.touch(sessionId)

      // ⚠️ 2026-11-08 拆分：回复同步（collectReplies）已搬到 dsh-strand。
      //   它写的是共享层 timeline，属于跨会话数据，本插件不再碰。

      const now = Date.now()
      const last = lastInjectAt.get(sessionId) ?? 0
      const isFirst = last === 0

      // ── 内容变没变：算一个指纹 ──
      //
      // ⚠️ 判据：凡是会被渲染进注入块的字段，都必须进指纹。
      //   拆分后本插件只剩两段（psyche 状态 + tacit 经验），
      //   共享层那一段的指纹由 dsh-strand 自己管。
      const sFp = store.fingerprint()

      // tacit 的命中集合由本轮用户输入决定
      //
      // ⚠️ 用 deriveSignals（复数）而不是 deriveSignal：一句话里可能同时提到多件事
      //   （"装插件时报 python 找不到"），只取第一条会漏掉另一条对应的经验。
      let tacitHits = []
      let tacitSig
      let userText = ''
      try {
        userText = (payload?.messages ?? decision.messages ?? [])
          .filter((m) => m?.role === 'user' && !isSelfMessage(m))
          .slice(-2)
          .map((m) => textOf(m))
          .join('\n')
      } catch {
        userText = ''
      }
      if (config.tacit.enabled && config.tacit.inject && userText) {
        const signals = TacitSegment.deriveSignals(userText)
        tacitSig = signals[0]
        if (signals.length > 0) tacitHits = TacitSegment.matchBySignals(signals)
      }
      const tacitKey = TacitSegment.hitsKey(tacitHits)

      const composite = `${sFp}|${tacitKey}`

      const compacted = detectCompaction(agent, sessionId, lastCompactionSeq)
      const compSeq = currentCompactionSeq(lastCompactionSeq, sessionId)

      // ── 压缩前日记 + 到阈值就自己压（2026-11-22 提到指纹去重之前）──
      //
      // ⚠️ 为什么移到指纹去重之前：
      //   当 psyche.collectTools=false 时，模型在单个用户回合内连续跑 20~50 步工具调用，
      //   store.fingerprint() 完全不变 → 旧实现直接 early return，完全错过 62% 压力阈值！
      //   配合 maybeWriteDiary 的惰性 getPeer，未到阈值时零磁盘读，无性能负担。
      if (config.diary?.enabled !== false) {
        try {
          const d = maybeWriteDiary(ctx, {
            sessionId,
            agent,
            getPeer: () => readPeerGlobal(),
            others: store.liveWindows(now),
            pursuits: store.openPursuits(),
            config,
            now,
            returnDetail: true,
          })
          if (d?.shouldCompact) {
            const req = Proactive.requestCompact(agent, `上下文压力达 ${Math.round(d.pressure * 100)}%（日记已先落盘）`)
            log(
              `达到阈值，日记已落盘，请求压缩 :: ${shortId(sessionId, 6)} ` +
                `${Math.round(d.pressure * 100)}% → ${req.status}`,
            )
          }
        } catch (e) {
          log(`日记/压缩流程异常（已降级跳过） :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
        }
      }

      const notice = Proactive.peekNotice(sessionId)
      let lifelineDueInfo = { due: false, reason: 'disabled' }
      let lifelineDue = false
      try {
        if (config.lifeline?.enabled && config.lifeline?.inject) {
          lifelineDueInfo = Lifeline.rebuildDue(config.lifeline?.rebuildEveryMs, now)
          lifelineDue = lifelineDueInfo.due === true
        }
      } catch {
        lifelineDue = false
      }
      const compositeC = `${composite}|c${compSeq}${notice ? `|n${notice.at}` : ''}${lifelineDue ? '|L1' : ''}`

      if (!isFirst && lastFingerprint.get(sessionId) === compositeC) return decision

      // ── 决定全量还是增量 ──
      const ds = deltaState.get(sessionId)
      const dueFull = !ds || ds.fullCount >= Math.max(0, config.inject.fullEvery - 1) || compacted
      const useDelta = !isFirst && !dueFull

      if (compacted && ds) {
        log(`检测到压缩，强制全量重注入 :: ${shortId(sessionId, 6)}（compaction 后首次）`)
      }

      // ── 先判断"要不要注入"，再决定"渲染什么" ──
      // notice（主动压缩回报）同样豁免两道时间节流闸，避免失败/无区间回报被延迟 10~30 分钟
      const lastChars = lastCharsInjected.get(sessionId) ?? 0
      const estimatedGap = gapFor(lastChars || 2000, gapEnvOverride())
      if (!notice && !isFirst && !compacted && now - last < estimatedGap) return decision

      const texts = { lifeline: '', diary: '', psyche: '', tacit: '', ledger: '' }
      const segErrors = []

      // ── 月度生命索引：常驻时间骨架（增量步未变化时跳过复读，并盘活 relevantLimit）──
      let fullLifelineText = ''
      if (config.lifeline?.enabled && config.lifeline?.inject) {
        try {
          const idxChars = config.lifeline?.maxChars ?? config.budget?.lifeline ?? 1300
          if (lifelineDue) {
            const r = Lifeline.rebuild()
            if (r.ok && r.months > 0) {
              log(`生命索引已重建 :: ${r.months} 个月（扫 ${r.scanned} 篇日记，原因 ${lifelineDueInfo.reason}）`)
            } else if (!r.ok) {
              segErrors.push(`lifeline-rebuild:${r.error ?? 'unknown'}`)
            }
          }
          fullLifelineText = Lifeline.renderIndex(idxChars)
          const sameAsLast = useDelta && !lifelineDue && fullLifelineText && ds?.lifelineText === fullLifelineText
          if (!sameAsLast) {
            texts.lifeline = fullLifelineText
          } else if (userText && (config.lifeline?.relevantLimit ?? 2) > 0) {
            const rel = Lifeline.pickRelevant(userText, config.lifeline?.relevantLimit ?? 2)
            if (rel.length > 0) {
              texts.lifeline =
                '### 相关历史月份提示（按需展开）\n' +
                rel.map((m) => `- ${m.headline} → \`mind_lifeline {ym:"${m.ym}"}\``).join('\n')
            }
          }
        } catch (e) {
          segErrors.push(`lifeline:${e?.message ?? e}`)
        }
      }

      // ── 压缩前日记：只在压缩后（或首步）注入一次 ──
      try {
        if (compacted || isFirst) {
          texts.diary = latestDiaryText(sessionId, config.diary?.injectMaxChars ?? 2000)
          if (texts.diary) {
            texts.diary = '### 压缩前日记（上下文快满时记录）\n\n' + texts.diary.trim()
          }
        }
      } catch (e) {
        log(`日记注入读取失败（跳过） :: ${e?.message ?? e}`)
      }

      // ── 工具结果账本：只在压缩后（或首步）带一次 ──
      if (config.toolLedger?.enabled && (compacted || isFirst)) {
        try {
          ToolLedger.flush()
          texts.ledger = ToolLedger.render(sessionId, config.budget?.ledger ?? 900, {
            bigResultChars: config.toolLedger?.bigResultChars,
          })
        } catch (e) {
          segErrors.push(`ledger:${e?.message ?? e}`)
        }
      }

      if (config.psyche.enabled && config.psyche.inject) {
        try {
          texts.psyche = useDelta && ds?.psycheSnap
            ? PsycheSegment.renderDelta(store, sessionId, ds.psycheSnap, now)
            : PsycheSegment.renderFull(store, sessionId, now, config.budget.psyche)
        } catch (e) {
          segErrors.push(`psyche:${e?.message ?? e}`)
        }
      }

      if (tacitHits.length > 0) {
        try {
          texts.tacit = ds?.tacitKey === tacitKey ? '' : TacitSegment.render(tacitHits, config.budget.tacit)
        } catch (e) {
          segErrors.push(`tacit:${e?.message ?? e}`)
        }
      }

      if (segErrors.length > 0) log(`段渲染失败（已跳过该段） :: ${segErrors.join(' | ')}`)

      // ── 预算 ──
      const { segments, chars, trimmed } = applyBudget(texts, config.budget)
      const text = [segments.lifeline, segments.psyche, segments.diary, segments.ledger, segments.tacit].filter(Boolean).join('\n\n')

      // ── 时间节流（精确复核）—— 必须在 takeNotice 之前，防止节流吞掉一次性通知！ ──
      const gapOk = !!notice || isFirst || compacted || now - last >= gapFor(chars, gapEnvOverride())
      if (!gapOk) {
        return decision
      }

      // 已过全部节流闸、确定要注入时才消费一次性 notice
      const noticeNow = Proactive.takeNotice(sessionId)
      const finalText = noticeNow
        ? `### 主动压缩结果（dsh-mind 回报，非用户输入）\n- ${noticeNow.text}\n\n${text}`
        : text

      if (!finalText) {
        lastFingerprint.set(sessionId, compositeC)
        return decision
      }

      if (trimmed.length > 0) log(`预算裁剪 :: ${trimmed.join(' | ')}`)

      const msg = makeInjectionMessage(finalText, KIND_INJECT, 'mind-context')
      const entered = insertAfterClaimed(decision.messages, payload?.messages, msg)

      // ── 记账 ──
      lastInjectAt.set(sessionId, now)
      lastFingerprint.set(sessionId, compositeC)
      lastCharsInjected.set(sessionId, chars)
      store.recordInjected(sessionId, now)
      store.snapshot()

      deltaState.set(sessionId, {
        fullCount: useDelta ? (ds?.fullCount ?? 0) + 1 : 0,
        psycheSnap: PsycheSegment.snapOf(store, sessionId, now),
        tacitKey,
        lifelineText: fullLifelineText || ds?.lifelineText || '',
        lastInjectAt: now,
      })
      trimMaps()

      log(
        `injected :: ${shortId(sessionId, 6)} ${isFirst ? '(首步·全量)' : useDelta ? `(增量·第${(ds?.fullCount ?? 0) + 1}次)` : '(刷新·全量)'}` +
          ` chars=${finalText.length} [life=${segments.lifeline.length} psy=${segments.psyche.length} dia=${segments.diary.length} led=${segments.ledger.length} tac=${segments.tacit.length}]` +
          (tacitHits.length ? ` tacit=${tacitKey}` : ''),
      )

      return { ...decision, messages: entered }
    } catch (e) {
      // 注入失败绝不能带崩主人的对话。但自家 bug 要留痕（带上 stack）。
      log(`pre-step FAILED（已降级为直通） :: ${e?.stack ?? e}`)
      return decision
    }
  })

  // ─────────────────── 工具注册（延迟重试） ───────────────────
  //
  // ⚠️ 整合前 memory-hub 的 memory_status 工具**从未注册成功**：
  //   它在 apply 时机调 ctx.get('tools')，拿到 undefined 就永久跳过（日志里 6 次）。
  //   psyche 的做法是对的：挂 tools/change + 轮询重试。整合后沿用 psyche 的。
  //
  // ⚠️ 2026-11-05 真机发现的噪声 bug（本文件历史遗留，不是本轮改动引入）：
  //   重启后 mind.log 里出现 **56 行**「工具注册失败 :: xxx :: already registered」，
  //   每次「mind_* 工具已注册 :: 1 个（第 9 次尝试）」—— 七个工具只有**一个**成功，
  //   其余六个全是「已存在」。
  //
  //   取证（session f70872b0，05:48:24.846~.956 共 110ms）：
  //     - `APPLY-CALLED` 只有 1 次 → 不是 apply 被调多次
  //     - 「tools 服务尚未就绪」1 次 → 走的是延迟注册分支
  //     - 于是 `ctx.on('tools/change')` 每被触发一次就全量重试一遍
  //     - 而 tools.register 对已存在的名字**抛错**，抛错 → n 不增 → registered 不置 true
  //       → 下一轮又全量重试 → 无限循环到 MAX_ATTEMPTS
  //
  //   关键洞察：**抛「已存在」其实等于注册成功**（那个名字确实在工具表里了）。
  //   原代码把它当失败，于是同一批工具被反复尝试 20 次，其中只有第一次真正生效。
  //
  //   修法：把「已存在」当成成功记账；并且用 `done` 集合跳过已成功过的名字。
  //   这样一轮之后 n 就等于全部，循环自然结束，日志也只剩一行。
  if (config.tools) {
    // ── 2026-11-20 重构 ─────────────────────────────────────
    //
    // 原来这一大段内联在 apply 闭包里，测试只能靠正则读源码或重写副本，
    // 而那两个做法都测不到真代码（详见 lib/tool-register.js 文件头的说明）。
    // 现在逻辑全在 lib/tool-register.js，这里只负责接线。
    //
    // 本轮修掉的两个 bug：
    //   ① `n > 0` 就置完成 → 部分注册失败的工具永久缺失（现在要求 done 覆盖全部名字）
    //   ② `tools` 未就绪也消耗 attempts → 10 秒后永久放弃且无日志
    //      （现在未就绪单独计数，且放弃时明确写出缺失名单）
    const registrar = createToolRegistrar({
      ctx,
      log,
      makeDefinitions: () =>
        makeToolDefinitions(store, {
          config,
          getConfig: () => config,
          log,
          CLI_PATH,
          getNeuralMemory: () => (typeof ctx.get === 'function' ? ctx.get('neural-memory') : null),
        }),
      // 「全部注册完成」这条日志仍走模块级闸门，理由见 TOOLS_REGISTERED_LOGGED 的注释。
      logCompleted: (n, total, attempts) => {
        if (TOOLS_REGISTERED_LOGGED) return
        TOOLS_REGISTERED_LOGGED = true
        log(`mind_* 工具已注册 :: ${n}/${total} 个（第 ${attempts} 次尝试）`)
      },
    })

    // start() 内部先 tick() 一轮：宿主 tools 通常早已就绪，这一次就能注册完。
    registrar.start({ pollMs: 500 })

    const after = registrar.state()
    if (after.status === 'not-ready') {
      log('tools 服务尚未就绪，改延迟注册（tools/change 或轮询时重试）')
    }
  }

  // ─────────────────── 启动扫描 ───────────────────
  try {
    const live = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
    log(`plugin loaded :: 当前活跃 agent ${live.length} 个`)
    for (const a of live) {
      const id = a?.id ?? a?.session?.id
      if (!id) continue
      store.touch(id)
    }
    store.snapshot(true)
  } catch (e) {
    log(`启动扫描失败 :: ${e?.message ?? e}`)
  }

  // ─────────────────── 启动清理：孤儿外置笔记（已随 facts 搬到 dsh-strand） ───────────────────
  //
  // ⚠️ 2026-11-08 拆分后**整块删除**，不是"暂时注释掉"。
  //
  //   旧逻辑：读本插件的 global.json，拿全部 facts 的 key 去扫 `~/.dsh/mind/notes`，
  //          把不在 key 集合里的笔记当孤儿删掉。
  //
  //   为什么必须走：
  //     ① 它调用的 `readGlobal()` 属于 `global.js`，那个文件已随 facts 搬到
  //        dsh-strand。启动日志留下 `启动清理笔记失败 :: readGlobal is not defined`
  //        —— 一条**每次启动都必定失败**的后台任务，永久污染日志。
  //     ② 它扫的目录 `~/.dsh/mind/notes` 已经不是活跃数据区。facts 与它们的
  //        外置正文都搬到了 `~/.dsh/strand/notes`（46 个）。继续跑等于拿旧目录
  //        做"孤儿判定"，判对了也没有收益，判错了就是删历史数据。
  //     ③ 新家的清理逻辑在 `dsh-strand/lib/index.js` 的「启动清理：孤儿外置笔记」，
  //        它读的是 `~/.dsh/strand/global.json`（72 facts），与本插件无关。
  //
  //   保留说明而不留桩：空 try/catch 会让人以为"这里有清理、只是没孤儿"，
  //   那正是上面 ② 那条注释当年反对的"两种状况长得一样"。
  //
  //   ⚠️ `~/.dsh/mind/notes` 目录与其中的 46 个旧笔记**原样保留不删**，
  //      它们是迁移前的快照，回滚时要用。

  // ─────────────────── 启动清理：过期存档（只报告，不删） ───────────────────
  //
  // ⚠️ 为什么默认 dryRun（2026-11-06 接线时定的）：
  //   存档是「被压缩遮蔽的原文」的**唯一备份**。删了就是永久损失。
  //   所以这里**只统计、只写日志**，绝不自动删除任何文件。
  //   要真删必须由人显式调用 sweepArchives({dryRun:false})。
  //
  // ⚠️ 为什么要接这个（此前 sweepArchives 写好却 0 次调用）：
  //   存档会一直堆（当时 8 个约 2 MB）。不报告的话，等到几十上百个、
  //   占了几个 GB 都没人知道 —— 磁盘被吃掉的典型路径就是「没人看的自动产物」。
  //   每次启动写一行「有几个、多大、最老的多久」，成本一行日志，
  //   换来「需要时随时能看到」，比定时扫更省。
  try {
    const swept = sweepArchives({ maxAgeDays: 90, dryRun: true })
    const files = listArchives(null)
    const totalBytes = files.reduce((n, f) => n + (f.bytes || 0), 0)
    log(
      `启动检查存档 :: ${files.length} 个 / ${(totalBytes / 1024 / 1024).toFixed(1)} MB` +
        `，超过 90 天的 ${swept.candidates.length} 个（仅报告，不删）`,
    )
  } catch (e) {
    log(`启动检查存档失败（不影响运行） :: ${e?.message ?? e}`)
  }

  // ─────────────────── 启动清理：死会话的账本格（2026-11-16 体检 A5） ───────────────────
  //
  // ⚠️ 与上面的存档清理性质不同，这里**真删**：
  //   存档是原文的唯一备份，删了就没了 → 只报告；
  //   账本只是「调过什么工具」的流水索引，原文另有存档兜着。
  //   判据：该格最后一条动静距今超过 7 天才清（活会话绝不动）。
  //
  // ⚠️ 为什么只在这里清、不挂 agent/disposed（2026-11-16 晚验收修正）：
  //   本宿主同一 session 的 agent 每次重启都 disposed 再 created，
  //   disposed 即清会把刚重启回来的会话历史一起抹掉。详见 sweepSessions 注释。
  if (config.toolLedger?.enabled) {
    try {
      /**
       * ⚠️ 2026-11-17 修：必须把宿主的**活跃会话集合**传进去。
       *
       * 原实现只按"7 天没调工具"判死，隔离实测发现：
       * 一个明确还在 ctx.agents.list() 里的会话，其 8 天前的账本照样被删——
       * "最近没调工具"被当成了"会话已经死了"。
       * 现在活会话一律豁免（见 sweepSessions 的 liveSessions 参数）。
       */
      const liveSessions = []
      try {
        const list = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
        for (const a of list) {
          const id = a?.id ?? a?.session?.id
          if (id) liveSessions.push(String(id))
        }
      } catch {
        /* 宿主没提供 agents.list 时退回纯龄期判据 */
      }
      const r = ToolLedger.sweepSessions(undefined, Date.now(), { liveSessions })
      if (r.removed > 0) log(`启动清理账本 :: 清掉 ${r.removed} 个 7 天无动静的会话格，保留 ${r.kept} 个`)
      if (r.exempt > 0) log(`启动清理账本 :: 豁免 ${r.exempt} 个仍活跃的会话格`)
    } catch (e) {
      log(`启动清理账本失败（不影响运行） :: ${e?.message ?? e}`)
    }
  }

  log(`dsh-mind 已加载 :: config=${JSON.stringify(config)}`)
}

// ⚠️ 2026-11-08 拆分：`readGlobal` / `appendTimeline` / `REPLY_PER_TURN` 的再导出
//   已删除 —— 那些符号现在住在 dsh-strand，本插件 import 都不断了。
//   留着再导出会让外部代码（测试/别的插件）以为这里还能拿到它们，
//   而实际会在 `import` 阶段就报 `does not provide an export named`。
//   要跨会话数据：`import 'dsh-strand'` 或直接读它的 global.json（见 peer.js）。
export { applyBudget, gapFor, Store }
export const ALIVE_TTL = ALIVE_TTL_MS
