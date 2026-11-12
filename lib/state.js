/**
 * dsh-mind · 统一状态层
 *
 * CCG 六要素:
 *   功能名   mind 状态存储：一个窗口 = 一条记录，三段共用，唯一真源
 *   生效条件 被 lib/index.js 与 lib/segments/*.js 引用；host 进程内多窗口共享同一实例
 *   子功能   活窗口登记 / 工具动作 / 意图声明 / 追求条目 / 身份 / 落盘快照
 *   执行     内存 Map 为真源，磁盘只在关键点落快照
 *   验证方式 tests/regress.mjs（上界、TTL、原子写、并发写不丢、指纹敏感性）
 *   不适用条件 需要跨进程实时同步（那是网络，不是本模块）
 *
 * ⚠️ 这个文件是整合的核心价值所在。整合前：
 *     strand 在磁盘 sessions/*.json 里记 aliveUntil（TTL 5 分钟），
 *     psyche 在内存 Store 里记 aliveUntil（TTL 10 分钟），
 *     于是同一个问题「现在几个窗口在用」有两个答案。
 *   整合后只有一个 windows Map、一个 TTL、一个 liveWindows()。
 *
 * ⚠️ 为什么真源是内存而不是磁盘：
 *   多个窗口在**同一个 Host 进程**里。「此刻谁在干什么」本来就在同一块内存里，
 *   落盘再读回来只会引入三样坏东西：延迟、写坏、以及「磁盘上是旧快照」。
 *   磁盘只负责两件事：① 重启后还认得自己是谁（identity / pursuits / label）
 *   ② 出问题时能事后复盘。
 *
 * ⚠️ 为什么所有 Map 都要有上界：
 *   `agent/disposed` 在本机**从未触发过**（旧日志里 0 条），靠事件清理靠不住。
 *   任何只增不减的容器都会在长时间运行后变成内存泄漏。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { STATE_PATH, LEGACY, readJson, atomicWriteJson, log, oneLine, shortId } from './io.js'

// ─────────────────────────── 上界 ───────────────────────────

/** 同时登记的窗口上界。正常开不到 20 个窗口，超了丢最久没动静的。 */
export const MAX_WINDOWS = 32

/**
 * 活窗口 TTL：多久没动静就认为这个窗口关了。
 *
 * ⚠️ 取 5 分钟而不是 psyche 原来的 10 分钟：
 *   理由是"刷新点必须比 TTL 密"。所有会碰到窗口的事件（pre-step / inbox/claimed /
 *   tools/execute）每步都 touch，所以一个真在用着的窗口绝不会漏刷。
 *   TTL 越短，"当前共 N 个窗口在用"越准 —— 整合前实测 6 个窗口里 4 个是刚开的空窗口。
 */
export const ALIVE_TTL_MS = 5 * 60 * 1000

/** 追求条目上界。 */
export const MAX_PURSUITS = 24

/** 单个字段的字符上界，防止某条超长文本撑爆注入。 */
export const MAX_ACTIVITY_CHARS = 100
export const MAX_INTENT_CHARS = 160
export const MAX_PURSUIT_CHARS = 200
export const MAX_ANCHOR_CHARS = 60

/** 落盘节流：距上次落盘不足这么久就跳过（毫秒）。 */
export const SNAPSHOT_MIN_GAP_MS = 30 * 1000

// ─────────────────────────── Store ───────────────────────────

/**
 * 取一条追求条目的「主题短语」，用于判断两句话是不是说的同一件事。
 *
 * ## 为什么不能"取前 N 个字符"（2026-11-03 实测推翻第一版）
 *
 * 第一版做法：归一化后取前 24 字符比较。真机数据一测就崩：
 *
 *   「主线：重建 bili 运行环境（<work>\bili-venv）。进展：根因已定位…」
 *   → 前 24 字符 = 「主线重建bili运行环境(<work>\」   ← 路径把名额吃光了
 *   「主线：重建 bili 运行环境。又更新了一次」
 *   → 前 24 字符 = 「主线重建bili运行环境又更新了一次」  ← 完全不同的后缀
 *
 *   两条说的明明是同一件事，却因为**路径占位**而判成不同。
 *   把阈值调大也救不了：路径可能很长，而且长度不固定。
 *
 * ## 现在的做法：先砍掉"进展段"，再比主题段
 *
 *   人写这类摘要的形态高度固定：`<主题>（<括号补充>）。<进展说明>`
 *   所以判据分三步：
 *     ① 砍掉「进展/根因/现状/下一步/结论」等标记之后的一切
 *     ② 砍掉括号内容（路径通常在里面）
 *     ③ 归一化空白与标点后比较（此时剩下的就是纯主题）
 *
 *   ⚠️ 砍得激进是**刻意的**：错并（两件事并成一条）的代价，
 *   比"同一件事显示成四条"轻得多 —— 后者会让模型高估自己的工作面。
 *   而且合并保留原 id，`closePursuit` 仍能精确关闭。
 */
const PROGRESS_MARKERS = [
  '进展',
  '根因',
  '现状',
  '下一步',
  '结论',
  '当前',
  '已更正',
  '已定案',
  '定案',
  '更新',
  '卡点',
]

export const THEME_MIN = 6

export function themeOf(text) {
  let t = String(text ?? '')

  // ① 砍掉第一个「进展类标记」之后的一切
  let cut = t.length
  for (const m of PROGRESS_MARKERS) {
    const i = t.indexOf(m)
    if (i > 0 && i < cut) cut = i
  }
  t = t.slice(0, cut)

  // ② 砍掉括号内容（路径通常在里面），中英文括号都处理
  t = t.replace(/[（(][^）)]*[）)]/g, '')

  // ③ 归一化
  t = t
    .replace(/\s+/g, '')
    .replace(/[：:；;，,。.、·—\-–【】\[\]「」『』]/g, '')
    .toLowerCase()

  return t
}

/**
 * 判断两段文本是不是在说同一件事。
 *
 * ⚠️ 不能只比 `themeOf(a) === themeOf(b)`：短的那句常常是长的那句的前缀
 *   （「写一个报告」 vs 「写一个报告，进展到一半」），长度不同就不相等。
 *   正确判据：**短的是长的前缀**，且短的不低于 THEME_MIN。
 */
export function sameTheme(a, b) {
  const ta = themeOf(a)
  const tb = themeOf(b)
  if (!ta || !tb) return false
  const shorter = ta.length <= tb.length ? ta : tb
  const longer = ta.length <= tb.length ? tb : ta
  if (shorter.length < THEME_MIN) return false
  return longer.startsWith(shorter)
}

export class Store {
  constructor() {
    this.windows = new Map()
    this.pursuits = []
    this.identity = { name: '星', address: '主人', since: new Date().toISOString() }
    this.lastSnapshotAt = 0
    this.dirty = false
    this._actSeq = 0
    this._labelCache = {}
    /** 最近一次注入（跨重启保留）。null 表示本机从未注入过。 */
    this.lastInject = null
    this._loadPersistent()
  }

  // ── 持久化 ──

  _loadPersistent() {
    // ① 新位置
    const main = readJson(STATE_PATH(), null)
    if (main && typeof main === 'object') {
      this._applySnapshot(main)
      return
    }
    // ② 旧 psyche/self.json 兼容（首次跑的时候帮主人把身份与追求搬过来）
    //
    // ⚠️ **MIND_DIR 被显式设置时绝不读旧位置**（与 global.js 同一条判据）：
    //   测试把 MIND_DIR 指到临时目录，若这里仍去读 ~/.dsh/psyche/self.json，
    //   测试就会拿到主人在用的真实身份与追求 —— 既污染断言，也等于"测试碰生产数据"。
    if (process.env.MIND_DIR) return
    try {
      const legacyPath = LEGACY.psycheSelf()
      if (existsSync(legacyPath)) {
        const old = readJson(legacyPath, null)
        if (old && typeof old === 'object') {
          this._applySnapshot(old)
          log('已从旧 psyche/self.json 载入 identity/pursuits（下次落盘即迁到 mind/state.json）')
          this.dirty = true
        }
      }
    } catch {
      /* 兼容路径失败不影响启动 */
    }
  }

  _applySnapshot(raw) {
    try {
      if (raw?.identity && typeof raw.identity === 'object') {
        this.identity = { ...this.identity, ...raw.identity }
      }
      if (Array.isArray(raw?.pursuits)) {
        this.pursuits = raw.pursuits.filter((x) => x && typeof x.text === 'string').slice(-MAX_PURSUITS)
      }
      // ⚠️ lastInject 是**已发生的事实**，跨重启依然为真，必须恢复。
      //   与 windows 不同：windows 是"谁还活着"（重启后全是谎言），
      //   而"上一次注入发生在 07:29:55"重启后照样成立。
      if (raw?.lastInject && typeof raw.lastInject === 'object' && raw.lastInject.at) {
        this.lastInject = { at: String(raw.lastInject.at), session: String(raw.lastInject.session ?? '') }
      }
      // windows 不作为真源恢复：重启后旧进程的窗口都已不存在，
      // 恢复它们会让模型以为"还有同伴在等它说话"。只保留 label 作参考。
      if (raw?.windows && typeof raw.windows === 'object') {
        for (const [id, w] of Object.entries(raw.windows)) {
          if (w?.label) this._labelCache[id] = w.label
        }
      }
    } catch (e) {
      log(`持久层解析失败（已忽略） :: ${e?.message ?? e}`)
    }
  }

  /**
   * 落盘快照。
   *
   * ⚠️ aliveUntil / thinking **不落盘**：旧进程的"活着"对新进程是谎言。
   *   这是 strand 用真机数据换来的结论（磁盘上有个 aliveUntil 比当前时间还晚
   *   295 秒的记录，对应窗口其实早关了）。
   *
   * ⚠️ 防"脚本误写真实数据"（2026-11-03 女仆自己踩到的真事故）：
   *   写调试脚本时 `new Store()` + `addPursuit()` 会因为 addPursuit 内部调 snapshot()
   *   而**把调试数据落进真实 state.json**，覆盖主人 4 条追求为 1 条。
   *   靠"记得设 MIND_DIR"是不可靠的（那次就是忘了）。
   *   所以这里加一道**显式开关**：只有插件自己（index.js）调 apply 时才会打开写盘，
   *   调试脚本/测试**默认不写盘**，必须显式 `store.allowPersist = true`。
   *   这样错误方向是"少写一次盘"，而不是"写坏主人数据"。
   */
  snapshot(force = false) {
    // 默认禁止落盘，必须显式打开（见上方注释）
    if (this.allowPersist !== true) return false
    const now = Date.now()
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_MIN_GAP_MS) return false
    try {
      const windows = {}
      for (const [id, w] of this.windows) {
        windows[id] = {
          label: w.label ?? null,
          createdAt: w.createdAt ?? null,
          lastSeenAt: w.lastSeenAt ?? null,
          activity: w.activity ? { text: w.activity.text, tool: w.activity.tool, at: w.activity.at } : null,
          intent: w.intent ? { text: w.intent.text, at: w.intent.at } : null,
          turns: w.turns ?? 0,
          // 注意：不含 aliveUntil / thinking —— 进程内状态，跨进程无意义
        }
      }
      atomicWriteJson(STATE_PATH(), {
        version: 1,
        savedAt: new Date().toISOString(),
        identity: this.identity,
        pursuits: this.pursuits,
        windows,
        // ⚠️ 必须落盘的唯一"窗口态"字段：它不是"谁还活着"（那个不能落盘），
        //   而是"上一次注入发生在什么时候"——一个**已经发生的事实**，
        //   跨重启依然为真。mind_status 靠它回答"记忆到底注进去没有"。
        lastInject: this.lastInject ?? null,
      })
      this.lastSnapshotAt = now
      this.dirty = false
      return true
    } catch (e) {
      log(`落盘失败（不影响运行） :: ${e?.message ?? e}`)
      return false
    }
  }

  // ── 窗口登记 ──

  /** 取（必要时创建）一个窗口状态。 */
  window(id) {
    if (!id) return undefined
    let w = this.windows.get(id)
    if (!w) {
      if (this.windows.size >= MAX_WINDOWS) {
        let oldestId = null
        let oldest = Infinity
        for (const [k, v] of this.windows) {
          const t = v.lastSeenAt ?? 0
          if (t < oldest) {
            oldest = t
            oldestId = k
          }
        }
        if (oldestId) {
          this.windows.delete(oldestId)
          log(`窗口上界：丢弃最久未动的 ${shortId(oldestId)}`)
        }
      }
      w = {
        id,
        label: this._labelCache?.[id] ?? null,
        createdAt: new Date().toISOString(),
        lastSeenAt: Date.now(),
        aliveUntil: 0,
        activity: null,
        intent: null,
        thinking: false,
        lastUserAt: 0,
        lastUserText: null,
        injectedAt: null,
        turns: 0,
      }
      this.windows.set(id, w)
    }
    return w
  }

  /** 打「活着」标记并续期。任何事件都应调用。 */
  touch(id, now = Date.now()) {
    const w = this.window(id)
    if (!w) return undefined
    w.lastSeenAt = now
    w.aliveUntil = now + ALIVE_TTL_MS
    return w
  }

  /**
   * 清掉所有 aliveUntil。启动时必须调用：新进程不认识旧进程的窗口。
   *
   * ⚠️ 整合后这个函数只对内存生效（磁盘本来就不存 aliveUntil），
   *   所以它同时是"清理旧版 strand 遗留磁盘标记"的入口 —— 见 clearLegacyAlive()。
   */
  resetAlive() {
    let n = 0
    for (const w of this.windows.values()) {
      if (w.aliveUntil) {
        w.aliveUntil = 0
        n++
      }
    }
    return n
  }

  /** 当前真正在用的窗口（TTL 内），按最近活跃排序。 */
  liveWindows(now = Date.now()) {
    const out = []
    for (const w of this.windows.values()) {
      if (w.aliveUntil > now) out.push(w)
    }
    return out.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
  }

  /** 窗口销毁：立刻摘掉，不等 TTL。 */
  dispose(id) {
    const w = this.windows.get(id)
    if (!w) return
    w.aliveUntil = 0
    w.thinking = false
    this.dirty = true
  }

  // ── 采集通道 ──

  /**
   * 通道①：工具动作 —— 「正在做什么」的最细粒度信号。
   *
   * ⚠️ seq 是必需的，不能用时间戳单独判"有没有新动作"：
   *   同一毫秒内连续两次工具调用（模型一步里并发调多个工具很常见）
   *   时间戳相等，`cur > prev` 恒为 false → 第二条动作永久漏报。
   */
  recordActivity(id, toolName, summary, now = Date.now()) {
    const w = this.touch(id, now)
    if (!w) return
    this._actSeq += 1
    w.activity = {
      tool: String(toolName ?? ''),
      text: oneLine(summary, MAX_ACTIVITY_CHARS),
      at: now,
      seq: this._actSeq,
    }
    this.dirty = true
  }

  /** 通道②：模型主动声明 —— 「我在追什么」。这是主体连续的关键：能自己说。 */
  recordIntent(id, text, now = Date.now()) {
    const w = this.touch(id, now)
    if (!w) return
    w.intent = { text: oneLine(text, MAX_INTENT_CHARS), at: now }
    this.dirty = true
  }

  /** 通道③：主人对这个窗口说话 —— 注意力被拉到这里。 */
  recordUserTurn(id, text, now = Date.now()) {
    const w = this.touch(id, now)
    if (!w) return
    w.lastUserAt = now
    w.lastUserText = text ? oneLine(text, MAX_ANCHOR_CHARS) : null
    w.turns = (w.turns ?? 0) + 1
    if (!w.label && text) w.label = oneLine(text, 24)
    this.dirty = true
  }

  /** 思考状态。 */
  setThinking(id, thinking, now = Date.now()) {
    const w = this.touch(id, now)
    if (!w) return
    w.thinking = !!thinking
    this.dirty = true
  }

  /**
   * 记录「这个窗口最近一次被注入」。
   *
   * ⚠️ 2026-11-06 补：必须同时更新一个**跨重启**的全局记录 `lastInject`。
   *   原因：windows 是内存态、不落盘（见 snapshot 注释），重启后整张表是空的。
   *   而 `mind_status` 的 inject 段要回答「记忆到底注进去没有」——
   *   如果只看内存里的 injectedAt，**每次重启后都会误报"从未注入过"**，
   *   这正是排查工具最不能骗人的地方（它坏起来比没有还糟）。
   */
  recordInjected(id, now = Date.now()) {
    const w = this.window(id)
    if (w) w.injectedAt = new Date(now).toISOString()
    this.lastInject = { at: new Date(now).toISOString(), session: String(id ?? '') }
    this.dirty = true
    // ⚠️ 必须**立刻强制落盘**（2026-11-06 第二次重启后才暴露）：
    //   普通 snapshot() 有 30 秒最小间隔（SNAPSHOT_MIN_GAP_MS），而「首次注入」
    //   通常发生在 agent created 之后十几二十秒 —— 正好被间隔挡住，于是：
    //     注入发生了、内存里 lastInject 有了、**磁盘上没有**。
    //   下次重启读回来 still null → mind_status 又误报「从未注入过」。
    //   真机证据：07:44:06 启动（snapshot 记了 lastSnapshotAt），
    //   07:44:26 注入 → snapshot() 被 20 秒间隔挡掉 → state.json 里 lastInject=null。
    //
    //   lastInject 是**低频事件**（一次注入一行），强制落盘的成本可忽略，
    //   而"排查工具撒谎"的代价极高。所以这一处破例用 force=true。
    this.snapshot(true)
  }

  // ── 追求条目（跨窗口的「我们在追什么」） ──

  /**
   * 声明一条追求（「我在追什么」）。
   *
   * ## 同一件事只留一条（2026-11-03 真机数据发现的问题）
   *
   * ⚠️ 原实现只在 `p.text === t`（**完全相等**）时才去重。
   *   但实际用法是「同一件事，进展不同」：
   *     - 「主线：重建 bili 运行环境。进展：根因已定位=卡点是 sdist 包...」
   *     - 「主线：重建 bili 运行环境。根因已更正：真因是 DSH 升级清空 runtime...」
   *   这两条**说的是同一件事**，却因为文字不同被当成两条独立追求。
   *   真机实测：4 条未结追求里,其实只有 **2 件事** ——
   *   跨窗口看到「你正在追 4 件事」会高估自己的工作面，判断被污染。
   *
   * 判据：**开头的「主题短语」相同就视为同一件事**，原地更新为最新进展。
   *   · 主题短语 = 归一化后取前 N 个字符（去掉标点/空白差异）
   *   · 为什么取前缀而不是算相似度：确定性、可复现、不需要额外依赖；
   *     而"同一件事"的不同进展，开头几乎必然相同（人写摘要的习惯）。
   *   · 风险与兜底：两条真正不同的事若前缀恰好相同，会被错并。
   *     所以阈值取 24 字符（够长，能区分"主线：重建 bili 运行环境"这类主题），
   *     且**保留原 id**，`closePursuit` 仍能按 id 精确关闭。
   *
   * @returns {{pursuit: object, updated: boolean}}
   */
  addPursuit(text, by = null, now = Date.now()) {
    const t = oneLine(text, MAX_PURSUIT_CHARS)
    if (!t) return null

    // ① 完全相等 → 不动
    const exact = this.pursuits.find((p) => p.text === t && !p.closedAt)
    if (exact) return { ...exact, _updated: false }

    // ② 同一主题 → 原地更新为最新进展（保留 id 与起始时间）
    const same = this.pursuits.find((p) => !p.closedAt && sameTheme(p.text, t))
    if (same) {
      // ⚠️ 语义：**最新的一次声明就是当前进展**，直接采用新文本。
      //   第一版想"保留更长的那份"以免丢信息，但那条规则是错的 ——
      //   实测：旧文本「…进展：根因已定位=卡点是 sdist 包…」（更长）
      //        新文本「…根因已更正：真因是 DSH 升级清空 runtime…」（更短但更新）
      //   "最长优先"会把**已被推翻的旧结论**留在外面，正好留错了。
      //   现在的做法：用新的；旧的挪到 previousText 里备查（不丢，但不当作现况）。
      if (same.text !== t) same.previousText = same.text
      same.text = t
      same.at = now // 最近一次更新
      same.startedAt = same.startedAt ?? same.at // 保留最初开始时间
      same.updates = (same.updates ?? 1) + 1
      if (by) same.by = by
      this.dirty = true
      this.snapshot()
      return { ...same, _updated: true }
    }

    // ③ 新的一件
    const rec = {
      id: Math.random().toString(36).slice(2, 10),
      text: t,
      at: now,
      startedAt: now,
      by,
      updates: 1,
    }
    this.pursuits.push(rec)
    if (this.pursuits.length > MAX_PURSUITS) this.pursuits = this.pursuits.slice(-MAX_PURSUITS)
    this.dirty = true
    this.snapshot()
    return { ...rec, _updated: false }
  }

  closePursuit(idOrMatch, now = Date.now()) {
    const key = String(idOrMatch ?? '').trim()
    // ⚠️ 空串必须挡掉：''.includes 恒为 true 的对称面是 p.text.includes('') 也恒为 true
    //   → 会误关第一条未结追求。
    if (!key) return null
    for (const p of this.pursuits) {
      if (p.closedAt) continue
      if (p.id === key || p.text.includes(key)) {
        p.closedAt = now
        this.dirty = true
        this.snapshot()
        return p
      }
    }
    return null
  }

  openPursuits() {
    return this.pursuits.filter((p) => !p.closedAt)
  }

  /**
   * 状态指纹：判断「自我状态变没变」。
   *
   * ⚠️ 判据：**凡是会被渲染进注入块的字段，都必须进指纹**。
   *   否则「字段变了 → 指纹没变 → 判断为没必要注入 → 静默丢失」。
   *   2026-11-03 实测抓到过：第一版只算 activity.seq 与 intent，
   *   于是「主人对另一处说了新话」完全不在指纹里，那处永远看不到。
   *
   * ⚠️ 整合后额外把共享层（global）的指纹也拼进来 —— 见 fingerprintGlobal()。
   *   因为整合后只有一条注入，任何一段变了都必须让整体判为"要注入"。
   */
  fingerprint() {
    const parts = []
    for (const w of this.liveWindows()) {
      parts.push([
        shortId(w.id),
        w.activity?.seq ?? 0,
        w.activity?.text?.slice(0, 24) ?? '',
        w.intent?.text?.slice(0, 24) ?? '',
        w.lastUserAt ?? 0,
        w.lastUserText?.slice(0, 24) ?? '',
        w.thinking ? 'R' : 'I',
      ].join('~'))
    }
    parts.push(`P${this.openPursuits().length}`)
    return parts.join('|')
  }
}

// ─────────────────── 旧版 strand 遗留标记清理 ───────────────────

/**
 * 清理旧 dsh-strand 落在磁盘上的 aliveUntil。
 *
 * ⚠️ 为什么整合后还要做：
 *   主人机器上 `~/.dsh/strand/sessions/*.json` 里还留着旧版写的 aliveUntil。
 *   旧版插件不再加载了，那些文件永远不会被清理；万一将来有人（或 CLI）
 *   去读它们做诊断，会看到一堆"还活着的窗口"。清一次，一次性了结。
 *
 * 失败不抛：这是清理动作，坏了也不该拦住插件启动。
 */
export function clearLegacyAlive() {
  let n = 0
  try {
    const dir = join(homedir(), '.dsh', 'strand', 'sessions')
    if (!existsSync(dir)) return 0
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const p = join(dir, name)
      try {
        const rec = readJson(p, null)
        if (!rec || typeof rec !== 'object') continue
        if (!('aliveUntil' in rec)) continue
        delete rec.aliveUntil
        atomicWriteJson(p, rec)
        n++
      } catch {
        /* 单个失败不影响其他 */
      }
    }
    if (n > 0) log(`已清理旧 strand 遗留的 aliveUntil :: ${n} 个会话文件`)
  } catch {
    /* 整个目录读不到就算了 */
  }
  return n
}
