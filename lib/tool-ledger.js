/**
 * dsh-mind · 工具结果摘要层（tool ledger）
 *
 * CCG 六要素:
 *   功能名   给每次工具调用留一条**常驻摘要记录**，让原文滚出上下文后仍知道"这一步做过什么"
 *   生效条件 config.toolLedger.enabled && 有工具调用
 *   子功能   记录（工具名/成败/大小/一句话）/ 按会话保留 N 条 / 渲染成注入段 / 清理
 *   执行     record() · list() · render() · clearSession()
 *   验证方式 tests/regress.mjs 第 91 组（记录、上限、截断、失败标注、渲染、隔离）
 *   不适用条件 需要**改写**宿主的消息数组（那是宿主的地盘，本插件只记录不篡改）
 *
 * ⚠️ 这个模块最要紧的一条边界：**只记录，不篡改**。
 *
 *   起因是读 VCP 白皮书 §4.7「五类 user 数组」：
 *   它把工具返回拆成 同步/异步/摘要/通知栏/元信息，身份都是 user、生命周期完全不同，
 *   尤其"摘要数组只留时间戳和状态、Token 极低、长期保留"这一条，正是本机
 *   `AGENTS.md`「会话历史的体量纪律」那个病（单条 5 万字符工具输出永久留历史）的结构化解法。
 *
 *   但**我不做它那一层**：它改的是自己服务器的消息数组，而这里消息数组归宿主所有。
 *   在插件层改写 payload.messages 会把整条会话的因果链搞乱（谁改了什么无法追溯），
 *   那是本机红线里反复强调的"不碰别人的地盘"。
 *
 *   所以我抄的是**它的信息分层，不是它的修改权**：
 *   原文照旧由宿主管理，本模块额外维护一条"这一步做过什么"的账本。
 *   账本的价值在压缩后显现 —— 那时原文被遮蔽，账本是唯一还说得清"我查过什么"的东西。
 *
 * ⚠️ 为什么账本要落盘（不能只在内存）：
 *   它就是为「跨压缩」存在的。只放内存的话，重启就没了；
 *   而重启恰恰是压缩后最常见的情形（主人改配置后重启验证）。
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MIND_DIR, atomicWriteJson, readJson, oneLine, shortId } from './io.js'

export const LEDGER_PATH = () => join(MIND_DIR(), 'tool-ledger.json')

/** 默认每个会话留多少条。够覆盖一次压缩区间（本机实测一次压缩 300~1000 条事件，工具调用是其中少数）。 */
export const DEFAULT_MAX_ENTRIES = 60

/** 单条摘要的默认字符上限。 */
export const DEFAULT_SUMMARY_CHARS = 160

/**
 * 内存缓存 + 可选去抖写盘（2026-11-22 性能优化）：
 *   真机 tool-ledger.json 已达 423 KB（34 会话 / 1609 条）。
 *   原先每次工具调用 pre + post 各做 1 次 423 KB 同步 readFileSync + fsyncSync 写盘，
 *   并发 5 个工具即 10 次全量主线程 fsync。
 *   现在：① 内存缓存按 LEDGER_PATH() + stat(mtimeMs:size) 精准失效（测试切临时目录自动失效）；
 *         ② 紧凑 JSON 落盘（体积立减 ~40%）；
 *         ③ 高频路径传 deferMs > 0 时合批防抖写盘，render / sweep / flush / 卸载时立即落盘。
 */
let ledgerCache = { path: '', statKey: '', db: null, dirty: false, timer: null }

function currentStatKey(file) {
  try {
    if (!existsSync(file)) return 'missing'
    const st = statSync(file)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'err'
  }
}

function readAll() {
  const file = LEDGER_PATH()
  if (ledgerCache.db && ledgerCache.path === file) {
    if (ledgerCache.dirty) return ledgerCache.db
    if (currentStatKey(file) === ledgerCache.statKey) return ledgerCache.db
  }
  const raw = readJson(file, null)
  const db =
    !raw || typeof raw !== 'object' || typeof raw.sessions !== 'object' || raw.sessions === null
      ? { version: 1, sessions: {} }
      : { version: 1, sessions: raw.sessions }
  ledgerCache = { path: file, statKey: currentStatKey(file), db, dirty: false, timer: ledgerCache.timer }
  return db
}

/** 立刻将脏账本以紧凑原子 JSON 写回磁盘。 */
export function flush() {
  if (ledgerCache.timer) {
    clearTimeout(ledgerCache.timer)
    ledgerCache.timer = null
  }
  if (!ledgerCache.dirty || !ledgerCache.db || !ledgerCache.path) return { ok: true, skipped: true }
  const targetPath = ledgerCache.path
  try {
    atomicWriteJson(targetPath, { version: 1, sessions: ledgerCache.db.sessions }, { compact: true })
    ledgerCache.dirty = false
    ledgerCache.statKey = currentStatKey(targetPath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

function persistDb(db, deferMs = 0) {
  const file = LEDGER_PATH()
  if (ledgerCache.path && ledgerCache.path !== file && ledgerCache.dirty) {
    flush()
  }
  ledgerCache.path = file
  ledgerCache.db = db
  ledgerCache.dirty = true

  if (deferMs > 0) {
    if (!ledgerCache.timer) {
      ledgerCache.timer = setTimeout(() => {
        ledgerCache.timer = null
        flush()
      }, deferMs)
      if (typeof ledgerCache.timer.unref === 'function') ledgerCache.timer.unref()
    }
    return { ok: true, deferred: true }
  }
  return flush()
}

/**
 * 从工具结果里推断「成没成」。
 *
 * ⚠️ 为什么要推断而不是信返回值：
 *   工具返回的形状各家自定（有的是 {ok:false}，有的是抛异常，有的返回一段文本）。
 *   这里只做**保守**判断：只有明确看到失败标记才标失败；
 *   明确看到成功标记才标成功；其余一律 unknown ——
 *   把不确定说成成功，比说成未知危险得多（那正是「结论必须绑定实测」的反面）。
 *
 * ⚠️ 2026-11-16 重启后真机发现的第一处漏判（已修）：
 *   宿主 `tools/post-execute` 传下来的 `result` 用的是 **`isError: boolean`**
 *   （取证：asar `dsh-tools/lib/pipeline.js:732 createSuccessResult` → `isError:false`；
 *    `:743` 失败路径 → `isError:true`），而本函数原来只认 `ok` / `error`，
 *   于是**每一条真实工具结果都被判成 unknown**。
 *   表现就是账本里全是「· pwsh (3406字)」而没有 ✅/❌ —— 看着像"工具都没成"。
 *
 *   宿主还有 `error: {message, code, info}` 嵌套对象（见 pipeline.js:226/674），
 *   所以 `result.error` 非空同样要判 failed。
 */
export function outcomeOf(result) {
  try {
    if (result === null || result === undefined) return 'unknown'
    if (typeof result === 'object') {
      // ① 宿主原生形状：isError 布尔（最高优先级，这是 post-execute 直接给的那个）
      if (result.isError === true) return 'failed'
      if (result.isError === false) return 'ok'
      // ② 插件/工具自定义的 ok 形状
      if (result.ok === false) return 'failed'
      if (result.ok === true) return 'ok'
      // ③ 错误字段（宿主的 error 是对象，有的工具是字符串）
      if (result.error) return 'failed'
      if (Array.isArray(result.content)) {
        // 宿主风格：content 数组里塞文本
        const t = result.content.map((c) => c?.text ?? '').join(' ')
        return /失败|错误|异常|error|failed/i.test(t) ? 'failed' : 'unknown'
      }
      return 'unknown'
    }
    const t = String(result)
    if (/失败|错误|异常|\berror\b|failed/i.test(t)) return 'failed'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/** 结果的大致字符数（不精确，用于标注"这条很大"）。 */
export function sizeOf(result) {
  try {
    if (typeof result === 'string') return result.length
    if (result && typeof result === 'object') return JSON.stringify(result).length
    return String(result ?? '').length
  } catch {
    return 0
  }
}

/**
 * 从工具入参里确定性提取「这一步在干什么」的一句话（2026-11-16 体检 A2 修）。
 *
 * ⚠️ 血证：账本的设计承诺是「工具名 + 成败 + 大小 + **一句话**」，
 *   但 pre 记账不传 summary、settle 只补成败 —— 真机 35 条 summary 全空。
 *   压缩后账本只答得出「调过 pwsh、成了」，答不出「查的是什么」，
 *   宣称要解决的问题只解决了一半。
 *
 * ⚠️ 为什么从 arguments 提取而不是从 result 提取：
 *   入参是**意图**（description/file_path/pattern），结果是数据。
 *   意图短且稳定，结果可能 5 万字符 —— 从结果里抽句子既贵又容易抽到噪声。
 *   而且入参在 pre-execute 就有，不用等结果。
 *
 * ⚠️ 提取顺序 = 信息密度顺序（确定性字段表，不做语义猜测）：
 *   description（pwsh 自带的人话说明）> file_path > pattern > query >
 *   url > name > prompt 首行。取到第一个非空就停。
 *   反例：❌ 把整个 arguments JSON.stringify 塞进去 —— 那是第二个上下文炸弹。
 *
 * @param {string} tool 工具名（用于给路径类字段加动词）
 * @param {object} args 工具入参
 * @param {number} maxChars 摘要上限
 * @returns {string} 一句话；提取不到返回 ''（宁可空着也不编）
 */
export function summarizeArgs(tool, args, maxChars = DEFAULT_SUMMARY_CHARS) {
  try {
    if (!args || typeof args !== 'object') return ''
    const cap = Math.max(40, Math.min(400, Number(maxChars) || DEFAULT_SUMMARY_CHARS))
    const t = String(tool ?? '')
    const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')

    // ① 自带人话说明的（pwsh.description 等）
    const desc = pick(args.description)
    if (desc) return oneLine(desc, cap)

    // ② 文件类：动词 + 路径（路径保尾部两段，全路径太长且盘符无信息量）
    const fp = pick(args.file_path) || pick(args.path)
    if (fp) {
      const tail = fp.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
      const verb = /^(read|glob)$/.test(t) ? '查看' : /^(edit|write)$/.test(t) ? '改写' : ''
      return oneLine(`${verb} ${tail || fp}`.trim(), cap)
    }

    // ③ 检索类：模式/关键词本身就是最好的一句话
    const pat = pick(args.pattern) || pick(args.query)
    if (pat) return oneLine(`${t === 'grep' ? '搜' : '查'} ${pat}`, cap)
    if (Array.isArray(args.queries) && args.queries.length) {
      return oneLine(`搜 ${args.queries.filter((q) => typeof q === 'string').join(' / ')}`, cap)
    }

    // ④ 其它常见锚点
    const url = pick(args.url)
    if (url) return oneLine(url, cap)
    const name = pick(args.name)
    if (name) return oneLine(name, cap)
    const prompt = pick(args.prompt)
    if (prompt) return oneLine(prompt.split('\n')[0], cap)

    return ''
  } catch {
    return ''
  }
}

/**
 * 记一条。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.tool    工具名
 * @param {any}    opts.result  工具返回值（用于判成败与大小）
 * @param {string} [opts.summary] 一句话说明（省略则用工具名占位）
 * @param {number} [opts.maxEntries]
 * @param {number} [opts.summaryChars]
 * @param {boolean} [opts.pending] 为 true 时记成「已发起、结果未知」
 */
export function record({
  sessionId,
  tool,
  result,
  summary = '',
  now = Date.now(),
  maxEntries = DEFAULT_MAX_ENTRIES,
  summaryChars = DEFAULT_SUMMARY_CHARS,
  pending = false,
  callId = null,
  deferMs = 0,
}) {
  const sid = String(sessionId ?? '')
  if (!sid || !tool) return { ok: false, error: 'sessionId 与 tool 都不能为空' }

  const db = readAll()
  const arr = Array.isArray(db.sessions[sid]) ? db.sessions[sid] : []

  const entry = {
    at: now,
    tool: String(tool),
    // ⚠️ callId 是宿主给的单次调用唯一 id（取证：asar `dsh-tools/lib/pipeline.js:296`
    //   `const callId = exec.callId`）。它是**并发下唯一可靠的配对键**：
    //   模型一步里并发调两个同名工具（很常见，本项目自己就常并发 pwsh）
    //   时，只按工具名配会把 A 的结果补到 B 的上，而且**不会报错**。
    ...(callId ? { callId: String(callId) } : {}),
    outcome: pending ? 'pending' : outcomeOf(result),
    chars: sizeOf(result),
    summary: oneLine(summary || '', Math.max(40, Math.min(400, summaryChars))),
  }

  // ⚠️ 同一步内多次调用同一个工具（并发很常见）：各自都留，不合并。
  //   合并会丢掉"调了几次"这个信号，而"反复调同一个工具"本身就是重要线索
  //   （往往意味着前几次失败了，或结果没拿到）。
  arr.push(entry)

  // 超上限 → 从最老的丢。不按时间过滤（按条数更可预测）。
  const cap = Math.max(5, Math.min(500, Number(maxEntries) || DEFAULT_MAX_ENTRIES))
  const kept = arr.slice(-cap)
  db.sessions[sid] = kept

  const w = persistDb(db, deferMs)
  if (!w.ok) return { ok: false, error: w.error, entry }
  return { ok: true, kept: kept.length, entry }
}

/**
 * 把「最近一条 pending 的同名工具」补成真实结果。
 *
 * ⚠️ 为什么要有这一步（2026-11-16 设计修正）：
 *   第一版想的是「有 post-execute 就用它、没有就用 pre-execute 记一条"发起"」，
 *   但**启动时根本不知道宿主发不发那个事件** —— `sawPost` 在注册那一刻恒为 false，
 *   于是会先记一堆 pre、等 post 到了再记一遍，账本里每条都重复两次。
 *
 *   现在的做法是「先记 pending，结果到了就**就地补全同一条**」：
 *     · 宿主有 post-execute → pending 被补成 ok/failed，账本干净且带成败
 *     · 宿主没有 → 条目永久留在 pending，README 与 mind_status 都能从这一状态
 *       直接看出"这个宿主没发 post-execute"，**故障可见，不会伪装成正常**
 *
 * ⚠️ 配对优先级（2026-11-16 重启后真机发现并发串行问题后改）：
 *   ① 有 callId → **只按 callId 配**。模型一步里并发两个同名工具是常态
 *      （本项目自己就常同时起两个 pwsh），只按工具名配会把 A 的结果补到 B 上，
 *      而且不报错 —— 那比漏记危险得多（会写出一条"成功"的假记录）。
 *   ② 没有 callId（老宿主/其他来源）→ 退回"最后一条同名 pending"。
 */
export function settle({ sessionId, tool, result, now = Date.now(), callId = null, deferMs = 0 }) {
  const sid = String(sessionId ?? '')
  if (!sid || !tool) return { ok: false, error: 'sessionId 与 tool 都不能为空' }

  const db = readAll()
  const arr = Array.isArray(db.sessions[sid]) ? db.sessions[sid] : []
  let idx = -1

  if (callId) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]?.callId === String(callId)) {
        idx = i
        break
      }
    }
    // callId 对不上时**不要**退回按名配 —— 那正是要避免的错配。
    if (idx < 0) return { ok: false, error: `callId ${callId} 没有对应的账本条目`, missing: true }
  } else {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i]?.tool === String(tool) && arr[i]?.outcome === 'pending') {
        idx = i
        break
      }
    }
    if (idx < 0) return { ok: false, error: '没有找到可补全的 pending 条目', missing: true }
  }

  arr[idx] = {
    ...arr[idx],
    outcome: outcomeOf(result),
    chars: sizeOf(result),
    settledAt: now,
  }
  db.sessions[sid] = arr
  const w = persistDb(db, deferMs)
  if (!w.ok) return { ok: false, error: w.error }
  return { ok: true, entry: arr[idx] }
}

/** 取某会话的账本（正序，老的在前）。 */
export function list(sessionId) {
  const db = readAll()
  const arr = db.sessions[String(sessionId ?? '')]
  return Array.isArray(arr) ? arr : []
}

/**
 * 渲染成注入段。
 *
 * ⚠️ 只在有内容时渲染，且**从最近往前取**：
 *   压缩后的自己最需要知道的是"刚才做过什么"，不是"前天做过什么"。
 *
 * ⚠️ 为什么不渲染成功的大结果内容：
 *   那样这一段会立刻变成第二个上下文炸弹，等于把要解决的问题搬了个家。
 *   这里只给「工具名 + 成败 + 大小」，具体内容让它去 mind_search / mind_expand。
 *
 * ⚠️ 2026-11-16 重启后真机看到的第一版渲染效果，暴露了两个问题，这一版按它们改：
 *
 *   ① **流水账太长**：26 行里 8 条是 `· · ·`（outcome=unknown），
 *      而 unknown 的意思是"不知道成没成"——它**不携带任何结论**，
 *      却和 ✅/❌ 一样占一整行。真机上它占了三分之一的篇幅。
 *      改法：unknown 不逐行列出，只折成一行「另有 N 次调用未能判定成败」。
 *      这不是丢信息 —— pending / unknown 的**条数**本身就是重要信号
 *      （大量 unknown 说明判定逻辑有问题），所以数量必须留，行必须在。
 *
 *   ② **"最近"名不副实**：13:39 的实现细节和 13:42 的混在一起，
 *      而模型此刻真正需要的是**尾部几行**。改法：从最后往前收集，
 *      一旦当前行收集到足够数量就停（仍是最近优先）。
 *
 *   白皮书 §4.7 对"摘要数组"的定义正是这样：**只留时间戳和状态**，
 *   不是把流程复述一遍。第一版理解成了"把每次调用都列出来"，那是日志，不是摘要。
 */
export function render(sessionId, maxChars = 900, opts = {}) {
  const arr = list(sessionId)
  if (!arr.length) return ''

  const bigThreshold = Number.isFinite(Number(opts?.bigResultChars)) && Number(opts.bigResultChars) > 0
    ? Number(opts.bigResultChars)
    : 0
  const head = '### 最近的工具调用记录（原文可能已被压缩遮蔽）'
  const lines = []
  let used = 0
  let unknownCount = 0

  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    // 没有结论的条目只计数、不占行（见上面 ①）
    if (e.outcome !== 'ok' && e.outcome !== 'failed') {
      unknownCount++
      continue
    }
    const hhmm = new Date(e.at).toTimeString().slice(0, 5)
    const mark = e.outcome === 'failed' ? '❌' : '✅'
    const size = e.chars >= 1000 ? `${Math.round(e.chars / 1000)}k` : `${e.chars}`
    const bigTag = bigThreshold > 0 && e.chars >= bigThreshold ? ' [大输出]' : ''
    const tail = e.summary ? ` ${e.summary}` : ''
    const line = `- ${hhmm} ${mark} ${e.tool} (${size} 字${bigTag})${tail}`
    if (used + line.length + 1 > maxChars - head.length - 80) break
    lines.unshift(line)
    used += line.length + 1
  }

  // 全部都是 unknown 时也要给出内容，否则这一段会变成只有标题的空段
  if (!lines.length) {
    if (!unknownCount) return ''
    return `${head}\n- 共 ${unknownCount} 次调用，**均未能判定成败**（工具结果里没有 isError/ok/error 标记）。`
  }

  let foot = ''
  if (unknownCount > 0) {
    foot = `\n- （另有 ${unknownCount} 次调用未能判定成败，未列出）`
  }
  // 被 maxChars 挤掉的那些也要说清楚，不能让人以为账本只有这几条
  const omitted = arr.length - lines.length - unknownCount
  if (omitted > 0) {
    // ⚠️ 2026-11-16 体检 A2 修：原来这里写「用 mind_search 搜关键词」——
    //   指错了路：mind_search 搜的是**压缩存档原文**（archive.js），
    //   账本条目不在存档里。账本没有对外查询工具，如实说省略即可，
    //   不许给一条走不通的指引。
    foot += `\n- （更早的 ${omitted} 条已省略）`
  }
  return `${head}\n${lines.join('\n')}${foot}`
}

/**
 * 清掉某个会话的账本。
 *
 * ⚠️ 2026-11-16 晚设计修正：**不要挂在 agent/disposed 上** ——
 *   本宿主里同一 session 的 agent 每次重启都会 disposed 再 created
 *   （真机：19:35:49 disposed 80e900… → 19:36:09 同 id created）。
 *   账本按 session 存、为跨重启服务，disposed 即清等于每次重启抹掉历史。
 *   本函数保留给**显式**清理场景（CLI/测试/未来真正的 session 删除事件）；
 *   常规清理走 sweepSessions（按格内最后动静的龄期）。
 */
export function clearSession(sessionId) {
  const sid = String(sessionId ?? '')
  if (!sid) return { ok: false }
  const db = readAll()
  if (!(sid in db.sessions)) return { ok: true, removed: 0 }
  delete db.sessions[sid]
  const w = persistDb(db, 0)
  if (!w.ok) return { ok: false }
  return { ok: true, removed: 1 }
}

/**
 * 清掉「早已死掉」的会话账本（2026-11-16 体检 A5 修）。
 *
 * ⚠️ 血证：clearSession 写好之后**全库没有任何调用方** ——
 *   agent/disposed 处理器只清内存 Map，不清账本。会话开一个多一格，
 *   只进不出：真机半天从 2 格涨到 6 格。单会话 60 条兜住了格内，
 *   兜不住格数。
 *
 * ⚠️ 为什么按龄期清而不是挂在 disposed 上（2026-11-16 晚验收时定）：
 *   第一版把 clearSession 挂进 agent/disposed，重启验收时发现**本宿主的
 *   agent 与 session 不是一对一**：每次重启，同一 session 的 agent 都会
 *   disposed 再 created（真机日志 19:35:49 → 19:36:09，同一个 80e900…）。
 *   照那一版，每次重启都会把当前会话的账本抹掉 —— 恰好毁掉账本
 *   「跨压缩/跨重启存活」的立身之本。所以清理只走这里：
 *     · 判据 = 格内最后一条动静距今超过 maxAgeMs（默认 7 天）
 *     · 活会话（含刚重启回来的）绝不动
 *   反例：❌ disposed 即清 —— 重启被误当成会话死亡。
 *   反例：❌ 按会话数上限清最老的 —— 会把还活着的长会话误杀。
 *
 * ⚠️ 2026-11-17 修（隔离实测：宿主 agents.list 里明确存在的会话，8 天前的账本仍被删）。
 *
 * 原判据只看"7 天没调工具"，但"没调工具"不等于"会话死了"：
 * 一个长期开着、最近一周只是在聊天的会话，账本会被静默清空。
 * 现在多加一道**确定性豁免**：调用方把宿主的活跃 agent 集合传进来，
 * 里面有的 session 一律不删。默认参数保持向后兼容（不传 = 只按龄期）。
 *
 * @param {number} maxAgeMs 最后一条记录距今超过它才清（默认 7 天）
 * @param {number} now 当前时间
 * @param {{liveSessions?: Iterable<string>}} [opts] 活跃会话 id 集合（宿主 agents.list 推出来）
 * @returns {{ok:boolean, removed:number, kept:number, exempt:number}}
 */
export function sweepSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000, now = Date.now(), opts = {}) {
  const db = readAll()
  const sids = Object.keys(db.sessions)
  const live = new Set()
  try {
    for (const s of opts?.liveSessions ?? []) {
      if (typeof s === 'string' && s) live.add(s)
    }
  } catch {
    /* 活跃集合拿不到就退回纯龄期判据 */
  }
  let removed = 0
  let exempt = 0
  for (const sid of sids) {
    if (live.has(sid)) {
      exempt++
      continue
    }
    const arr = Array.isArray(db.sessions[sid]) ? db.sessions[sid] : []
    const last = arr.length ? Math.max(...arr.map((e) => Number(e?.settledAt ?? e?.at ?? 0))) : 0
    if (now - last > maxAgeMs) {
      delete db.sessions[sid]
      removed++
    }
  }
  if (removed > 0) {
    const w = persistDb(db, 0)
    if (!w.ok) return { ok: false, removed: 0, kept: sids.length, exempt }
  }
  return { ok: true, removed, kept: sids.length - removed, exempt }
}

/** 账本文件的大致概况（给 mind_status 用）。 */
export function stats() {
  const db = readAll()
  const sessions = Object.keys(db.sessions)
  let entries = 0
  let bytes = 0
  let pending = 0
  let failed = 0
  for (const s of sessions) {
    const arr = Array.isArray(db.sessions[s]) ? db.sessions[s] : []
    entries += arr.length
    for (const e of arr) {
      if (e?.outcome === 'pending') pending++
      if (e?.outcome === 'failed') failed++
    }
  }
  try {
    const p = LEDGER_PATH()
    if (existsSync(p)) bytes = statSync(p).size
  } catch {
    /* 读不到就报 0，不编数字 */
  }
  return { sessions: sessions.length, entries, pending, failed, bytes, path: LEDGER_PATH() }
}

export { shortId }
