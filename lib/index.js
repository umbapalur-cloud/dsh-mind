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
import { readPeerGlobal } from './peer.js'

/** mind-cli 的绝对路径（从本模块位置推，不写死开发机路径）。 */
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs')

/** Map 上界。`agent/disposed` 在本机从未触发过，不能指望事件清理。 */
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
    if (lastInjectAt.size <= MAP_MAX) return
    for (const k of lastInjectAt.keys()) {
      if (lastInjectAt.size <= MAP_MAX) break
      lastInjectAt.delete(k)
      lastFingerprint.delete(k)
      deltaState.delete(k)
      lastCharsInjected.delete(k)
      lastCompactionSeq.delete(k)
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
  if (config.psyche.enabled && config.psyche.collectTools) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      collectToolActivity(exec)
      return next()
    })
    ctx.on('tools/execute', async (exec, next) => {
      collectToolActivity(exec)
      return next()
    })
    log('activity 通道已注册 :: tools/pre-execute + tools/execute（互为兜底）')
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
      if (config.tacit.enabled && config.tacit.inject) {
        const userText = (payload?.messages ?? [])
          .filter((m) => m?.role === 'user' && !isSelfMessage(m))
          .map((m) => textOf(m))
          .join('\n')
        if (userText) {
          const signals = TacitSegment.deriveSignals(userText)
          tacitSig = signals[0]
          if (signals.length > 0) tacitHits = TacitSegment.matchBySignals(signals)
        }
      }
      const tacitKey = TacitSegment.hitsKey(tacitHits)

      const composite = `${sFp}|${tacitKey}`

      // ⚠️ 压缩检测**必须在指纹去重之前**（2026-11-05 真机修的第二个 bug）。
      //
      //   原顺序是「指纹去重 return → 再检测压缩」，而压缩**不改指纹**：
      //   global.json 没动、store 没动，composite 一模一样 → :491 直接 return，
      //   压缩检测那行**永远走不到**。上一轮加的 `compacted` 判据等于死代码。
      //
      //   血证（某个真实会话（本机））：压缩后 7 分钟，mind.log 里
      //   「检测到压缩」0 条，注入仍是「增量·第1次」chars=1075（全量 6317）。
      //
      //   现在的做法：先检测压缩，把它并进指纹。
      //   压缩让 seq 从 0 变 1649 → composite 必变 → 不会走进下面的 return；
      //   之后 seq 稳定在同一个值 → 指纹恢复稳定 → 不会每步都全量。
      const compacted = detectCompaction(agent, sessionId, lastCompactionSeq)
      const compSeq = currentCompactionSeq(lastCompactionSeq, sessionId)
      // ── 主动压缩结果必须让模型看见（D 项） ──
      //
      // ⚠️ 为什么算进指纹：notice 是"取走即清"的一次性消息，
      //   取走本身就改变了要注入的内容 —— 不并进指纹的话，
      //   如果这一轮恰好被后面的节流闸挡住，notice 已经没了、
      //   又没注入出去，模型永远不知道压缩成没成。并进指纹等于给它开绿灯。
      const notice = Proactive.peekNotice(sessionId)
      const compositeC = `${composite}|c${compSeq}${notice ? `|n${notice.at}` : ''}`

      if (!isFirst && lastFingerprint.get(sessionId) === compositeC) return decision

      // ── 决定全量还是增量 ──
      const ds = deltaState.get(sessionId)

      // ⚠️ 2026-11-08 拆分后没有"共享层被裁剪"这件事了 —— timeline 在 dsh-strand。
      //   原来 `shrunk` 判据盯的是 timeline 长度回退，现在由对方自己管。
      //   本插件仍然保留 `fullEvery` 周期性全量纠偏（psyche 状态可能漏增量）。
      //
      // ⚠️ 压缩检测已在上面（指纹去重之前）做过，这里直接复用 `compacted`。
      //   上一轮的 P1-a 修复把这段放在指纹之后 → 永远是死代码，见上面的血证。
      // ⚠️ 2026-11-09 行为级测试（第 72 组）实测修：`fullEvery: 1` 并不等于
      //   "每步全量" —— `>=` 在第一次增量（fullCount=1）就满足，于是第二步
      //   又回到增量，而 renderDelta 只报**别处**的变化，本窗口的 lastUserText
      //   根本不在增量里。语义上 "每 1 次就该全量" 应当是 `>= fullEvery - 1`
      //   （即 fullEvery=1 → 0 次增量后立刻全量）。默认值 6 的行为只从
      //   "第 6 次增量后全量" 变成 "第 5 次后全量"，纠偏更勤一点，方向安全。
      const dueFull = !ds || ds.fullCount >= Math.max(0, config.inject.fullEvery - 1) || compacted
      const useDelta = !isFirst && !dueFull

      if (compacted && ds) {
        log(`检测到压缩，强制全量重注入 :: ${shortId(sessionId, 6)}（compaction 后首次）`)
      }

      // ── 压缩前日记 + 到阈值就自己压（2026-11-05 主人指定）──
      //
      // ## 主人定的顺序（原话）
      //   「到了70%以后，写完日记再压缩，免得把写日记的动作给打断了。」
      //   「压缩完以后，用了一段时间，上下文又到了70%，就再写一次日记，再压缩一次。」
      //
      // ## 所以这三步是一条链，顺序不能换
      //   ① 压力到阈值 → ② 写日记落盘 → ③ 日记写成功了才发起压缩
      //
      // ⚠️ 阈值 70% → 62%（2026-11-06 主人指定）：
      //   主人原话是 70%，但真机实测 70% 一次都没轮到过 ——
      //   profile 的 `context-lock` 把上限锁在 406464 tokens（≈68%），
      //   宿主先撞线压缩，dsh-mind 的 70%（≈420000）永远慢一步。
      //   上面两段原话保留不改，是为了让后来人知道主人最初的要求是什么；
      //   实际生效值看 config.js 的 `diary.pressureRatio`（现为 0.62）。
      //
      // ⚠️ 为什么压缩放在日记**之后**：压缩会把上下文换掉。
      //   如果先压，日记是在"压缩后的我"视角下写的，本来要保的东西已经丢了。
      //   这个顺序是主人特意交代的，不是随手排的。
      //
      // ⚠️ 为什么用 requestCompact（排队）而不是直接 compactNow：
      //   pre-step 发生在 turn 之内，`compactNow` 第一句就检查 openTurn 并抛 busy
      //   （见 lib/proactive.js 顶部注释）。所以这里只能**登记意图**，
      //   真正的压缩由 agent/status → idle 触发 —— 同一条已验通的链路。
      //
      // ⚠️ 为什么只在「日记真的写成功了」才压：
      //   限流挡住、写盘失败、拿不到计量 → 日记没落盘就压缩，等于把
      //   "压缩前的自己"直接抹掉。宁可这一步不压，等下一轮。
      //
      // ⚠️ 绝不抛：日记与压缩都是附带功能，任何失败都不能影响主人的对话。
      //
      // ⚠️ 2026-11-08 拆分：facts / timeline 现在住在 dsh-strand。
      //   这里用**软依赖**读取 —— 读不到就留空，绝不 import 对方模块
      //   （理由见 lib/peer.js 文件头：卸载即崩 / 版本锁死 / 循环依赖）。
      //   退化的后果只是日记里少两节，日记本身照写。
      if (config.diary?.enabled !== false) {
        try {
          const peer = readPeerGlobal()
          const d = maybeWriteDiary(ctx, {
            sessionId,
            agent,
            facts: peer.facts,
            timeline: peer.timeline,
            others: store.liveWindows(now),
            // ⚠️ 2026-11-09 补：把「我在追什么」传给日记。
            //   pursuits 是 mind_intend 声明的跨窗口追求，存在本插件的 state.json，
            //   不在 peer（strand）里 —— 之前不传，日记就永远没有这一段，
            //   压缩后的自己不知道自己在追什么，恰恰丢了日记最该保住的东西。
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

      // ── 先判断"要不要注入"，再决定"渲染什么" ──
      //
      // ⚠️ 这个顺序很重要（2026-11-03 真机日志发现的性能问题）：
      //   原写法是「渲染三段 → 预算裁剪 → 时间节流判断」，
      //   于是**每一步**都要读一遍 24KB 的 global.json、拼 8600 字符、跑一遍裁剪，
      //   然后才因为"没到间隔"直接 return。
      //   真机实测：注入只有 2 次，`预算裁剪` 日志却刷了 **55 次** —— 白干了 53 遍。
      //
      //   现在改成两段式：
      //     ① 用上次的字符数估间隔（内容变化通常不大，估得够准）
      //     ② 通过后再渲染；渲染完拿到真实长度，若跨了档位再复核一次
      //   这样既省掉无用的渲染，也不会因为估错而漏注入或多注入。
      // ⚠️ `compacted` 同样豁免这道粗估闸 —— 理由同下面的精确复核闸。
      const lastChars = lastCharsInjected.get(sessionId) ?? 0
      const estimatedGap = gapFor(lastChars || 2000, gapEnvOverride())
      if (!isFirst && !compacted && now - last < estimatedGap) return decision

      // ── 逐段渲染（每段独立 try：单段失败只丢该段） ──
      //
      // ⚠️ 2026-11-08 拆分：原来的三段（strand / tacit / psyche）变成两段 + 日记。
      //   `strand` 那一段整个搬去了 dsh-strand；它原来还兼任「日记注入」的载体，
      //   现在日记独立成 `diary` 一段 —— 因为日记本来就该在**压缩发生后**被看见，
      //   和"别的窗口说了什么"没有关系，捆绑在一起只是整合时的历史偶然。
      const texts = { diary: '', tacit: '', psyche: '' }
      const segErrors = []

      // ── 压缩前日记：只在压缩后（或首步）注入一次 ──
      //
      // ⚠️ 为什么不每步都带：日记约 2000 字符，每步都发会把刚省下的预算又吃回去。
      //   它真正的用武之地是「压缩把上文抹掉之后」—— 那时候它就是重建的种子。
      //
      // ⚠️ 为什么现在独立成段（而不是原来寄生在 strand 段里）：
      //   拆分后 strand 段不在了，而日记必须保留 —— 它是主人 2026-11-05 亲自定的
      //   「压缩前先写日记」那条链的**产物**，是压缩后重建的唯一依据。
      try {
        if (compacted || isFirst) {
          texts.diary = latestDiaryText(sessionId, config.diary?.injectMaxChars ?? 2000)
          if (texts.diary) {
            texts.diary = '### 压缩前日记（女仆在上下文快满时亲手写的）\n\n' + texts.diary.trim()
          }
        }
      } catch (e) {
        log(`日记注入读取失败（跳过） :: ${e?.message ?? e}`)
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
          // 同一组经验不重复注入：连做十步只进一次，换个事再回来才重新进。
          texts.tacit = ds?.tacitKey === tacitKey ? '' : TacitSegment.render(tacitHits, config.budget.tacit)
        } catch (e) {
          segErrors.push(`tacit:${e?.message ?? e}`)
        }
      }

      if (segErrors.length > 0) log(`段渲染失败（已跳过该段） :: ${segErrors.join(' | ')}`)

      // ── 预算 ──
      const { segments, chars, trimmed } = applyBudget(texts, config.budget)
      // ⚠️ 裁剪日志只在**真要注入**时才写（原来写在节流之前，刷屏 55 次）。
      //   留痕是必须的（"某段被削了"这件事必须可见），但只该在真的发生时出现。

      const text = [segments.psyche, segments.diary, segments.tacit].filter(Boolean).join('\n\n')

      // ── 主动压缩结果：取走即清，拼到最前面（模型先看到"刚发生了什么"）──
      //
      // ⚠️ 取走的位置必须在这里：已经过了全部节流闸、确定要注入。
      //   更早取走则若被节流挡住，这条通知就永久丢了（已经 delete 掉）。
      const noticeNow = Proactive.takeNotice(sessionId)
      const finalText = noticeNow
        ? `### 主动压缩结果（dsh-mind 回报，非用户输入）\n- ${noticeNow.text}\n\n${text}`
        : text

      if (!finalText) {
        lastFingerprint.set(sessionId, compositeC)
        return decision
      }

      // ── 时间节流（精确复核） ──
      //
      // ⚠️ 上面用 lastChars 估过一次间隔，这里用**真实字符数**复核。
      //   为什么两道都要：估计值可能偏低（内容涨了），漏过第一道但这里能补上；
      //   也可能偏高（内容缩了），第一道挡住但实际该注入 ——
      //   那种情况按"多等一会儿"处理，不追（宁可少注入，不可超预算烧 token）。
      //
      // ⚠️ 但 `compacted` 必须**豁免**这道闸（2026-11-05 第三个发现）：
      //   压缩刚发生时，距上次注入常常只有几分钟（本次血证：5 分 41 秒），
      //   而全量的间隔要求是 30 分钟（gapFor(6317) = 10min×3）。
      //   若不放行，压缩检测走通了也会被节流拦下 → **又一次静默全量丢失**。
      //   放行是安全的：压缩每次只触发一次（seq 变了才触发），不是每步。
      const gapOk = isFirst || compacted || now - last >= gapFor(chars, gapEnvOverride())
      if (!gapOk) {
        // ⚠️ 这里**不能**记指纹：记了就等于"我说过全量了"，而实际没发出去。
        //   不记 → 下一轮继续尝试，直到节流到期。宁可晚几分钟，不可谎报。
        return decision
      }

      // 裁剪必须留痕（"某段被削了"这件事要可见），但只在真要注入时写
      if (trimmed.length > 0) log(`预算裁剪 :: ${trimmed.join(' | ')}`)

      const msg = makeInjectionMessage(finalText, KIND_INJECT, 'mind-context')
      const entered = insertAfterClaimed(decision.messages, payload?.messages, msg)

      // ── 记账 ──
      lastInjectAt.set(sessionId, now)
      lastFingerprint.set(sessionId, compositeC)
      lastCharsInjected.set(sessionId, chars)
      store.recordInjected(sessionId, now)
      store.snapshot()

      // ⚠️ 2026-11-08 拆分：deltaState 不再记 timelineCount / factSnapshot ——
      //   那两个字段是给"跨会话增量渲染"用的，那段已搬到 dsh-strand。
      //   本插件现在只记状态段与经验段的东西。
      deltaState.set(sessionId, {
        fullCount: useDelta ? (ds?.fullCount ?? 0) + 1 : 0,
        psycheSnap: PsycheSegment.snapOf(store, sessionId, now),
        tacitKey,
        lastInjectAt: now,
      })
      trimMaps()

      log(
        `injected :: ${shortId(sessionId, 6)} ${isFirst ? '(首步·全量)' : useDelta ? `(增量·第${(ds?.fullCount ?? 0) + 1}次)` : '(刷新·全量)'}` +
          ` chars=${finalText.length} [psy=${segments.psyche.length} dia=${segments.diary.length} tac=${segments.tacit.length}]` +
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
    let registered = false
    let attempts = 0
    const MAX_ATTEMPTS = 20
    /** 已经确认可用的工具名。跨重试共享，避免重复 register 刷屏。 */
    const done = new Set()

    /** 「已存在」不算失败 —— 名字在工具表里，目标已达成。 */
    function isAlreadyRegistered(e) {
      return /already registered/i.test(String(e?.message ?? e))
    }

    function tryRegisterTools() {
      if (registered || attempts >= MAX_ATTEMPTS) return
      attempts++
      try {
        const tools = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools
        if (!tools?.register) return // 还不可用，等下次
        let n = 0
        for (const def of makeToolDefinitions(store, { config, log, CLI_PATH })) {
          if (done.has(def?.name)) {
            n++
            continue
          }
          try {
            const dispose = tools.register(def)
            if (typeof ctx.effect === 'function' && typeof dispose === 'function') ctx.effect(() => dispose)
            done.add(def.name)
            n++
          } catch (e) {
            if (isAlreadyRegistered(e)) {
              // 已经是可用状态，记账但**不刷日志**
              done.add(def?.name)
              n++
            } else {
              log(`工具注册失败 :: ${def?.name} :: ${e?.message ?? e}`)
            }
          }
        }
        if (n > 0) {
          // ⚠️ 日志幂等（2026-11-05 第三次修）。
          //
          //   现象：一次启动出现 **8 条一模一样**的
          //     「mind_* 工具已注册 :: 7 个（第 9 次尝试）」，
          //   全挤在 06:08:12.896~.909 这 13ms 内，且 `attempts` 全是 9。
          //
          //   已取证的事实：
          //     - `APPLY-CALLED` 只有 1 条 → 不是 apply 被调多次（至少不是每次都打了日志）
          //     - `attempts` 全是 9 → 前 8 次因 tools 未就绪 return 掉了
          //     - 工具本身注册正确：7/7（真机实测）
          //
          //   ⚠️ **未取证**：为什么同一个闭包里 `registered = true` 之后还能再进来。
          //     女仆试过两种解释都不成立，所以**不编原因**。
          //
          //   能确定的是：这是**纯日志噪声**，功能没问题。
          //   因此用模块级标记做闸门 —— 它跨闭包共享，不依赖任何时序假设。
          if (!TOOLS_REGISTERED_LOGGED) {
            TOOLS_REGISTERED_LOGGED = true
            log(`mind_* 工具已注册 :: ${n} 个（第 ${attempts} 次尝试）`)
          }
          registered = true
        }
      } catch (e) {
        log(`tools 注册异常 :: ${e?.message ?? e}`)
      }
    }

    tryRegisterTools()
    if (!registered) {
      log('tools 服务尚未就绪，改延迟注册（tools/change 或轮询时重试）')
      ctx.on('tools/change', () => tryRegisterTools())
      const timer = setInterval(() => {
        tryRegisterTools()
        if (registered || attempts >= MAX_ATTEMPTS) clearInterval(timer)
      }, 500)
      // 不要让定时器阻止进程退出
      if (typeof timer.unref === 'function') timer.unref()
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

  log(`dsh-mind 已加载 :: config=${JSON.stringify(config)}`)
}

// ⚠️ 2026-11-08 拆分：`readGlobal` / `appendTimeline` / `REPLY_PER_TURN` 的再导出
//   已删除 —— 那些符号现在住在 dsh-strand，本插件 import 都不断了。
//   留着再导出会让外部代码（测试/别的插件）以为这里还能拿到它们，
//   而实际会在 `import` 阶段就报 `does not provide an export named`。
//   要跨会话数据：`import 'dsh-strand'` 或直接读它的 global.json（见 peer.js）。
export { applyBudget, gapFor, Store }
export const ALIVE_TTL = ALIVE_TTL_MS
