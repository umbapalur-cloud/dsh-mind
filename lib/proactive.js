// dsh-mind · 主动压缩（P?/D 项）
//
// 功能名  让「我」自己决定什么时候折哪段，而不是等宿主在 80% 时一刀切。
// 子功能  登记压缩意图 → 等 agent 空闲 → 执行 → 把结果带给下一回合
// 执行    requestCompact(agent, why) / drainOnIdle(agent) / takeNotice(sessionId)
// 验证方式 tests/regress.mjs 第 62 组（排队、幂等、busy 降级、结果不丢、反向）
//
// ⚠️⚠️ 为什么不能「在工具里直接压」——这是本模块存在的唯一理由：
//   `compactNow()` 走 `compactSurfaceRegion({owner:null})`，那里第一句就是
//   `if (entryState.openTurn !== null) throw new ManualCompactionError('busy', ...)`
//   （实现在 tools/_extract-compactbasic/lib/index.js:457）。
//   而**工具调用永远发生在 turn 之内** —— 所以从工具里调 compactNow，100% 吃 busy。
//   这不是权限问题、不是配置问题，是时序问题，改配置无解。
//
//   唯一可行路径：工具只**登记意图**，真正的压缩延迟到 turn 关闭、agent 变 idle 时
//   由 `agent/status`(status==='idle') 触发。结果写进 notices，下一回合由注入带出来。
//
// ⚠️ 为什么结果要「带出来」而不是只写日志：
//   压缩会把上下文换掉，模型自己**看不到**「我刚才请求了压缩、它成没成」。
//   只写 mind.log 等于对模型隐身，下一次它会重复请求（烧 LLM 调用）。
//   notices 是这条链的回路。

import { log, shortId } from './io.js'

/** sessionId → {why, at, requestedBy} */
const pending = new Map()
/** sessionId → {ok, text, at} —— 待下一回合带给模型的结果 */
const notices = new Map()
/** sessionId → 正在跑（防同一会话并发压缩） */
const running = new Set()

/** 同一会话最多排几个请求。多于此说明模型在刷，直接丢。 */
const MAX_PENDING_PER_SESSION = 1
/** notice 保留上限，防内存里堆 */
const MAX_NOTICES = 32

/**
 * 登记一次主动压缩意图。
 *
 * ⚠️ 幂等：同一会话已有排队时直接返回 already-pending，
 *   不覆盖原请求 —— 覆盖会让「谁先要的」这个信息消失。
 *
 * @returns {{ok:boolean, status:'queued'|'already-pending'|'already-running'|'no-agent', why?:string}}
 */
export function requestCompact(agent, why = '模型主动请求') {
  const id = agent?.id ?? agent?.session?.id
  if (!id) return { ok: false, status: 'no-agent' }
  if (running.has(id)) return { ok: false, status: 'already-running' }
  if (pending.has(id)) return { ok: true, status: 'already-pending', why: pending.get(id).why }

  // 上限：只留一个。超出说明有东西在循环请求，直接拒第二个并留痕。
  if (pending.size > MAX_PENDING_PER_SESSION * MAX_NOTICES) {
    log(`主动压缩拒绝 :: 排队过多 ${pending.size}，可能是循环请求`)
    return { ok: false, status: 'already-pending' }
  }

  pending.set(id, { why: String(why ?? '').slice(0, 200), at: Date.now() })
  log(`主动压缩已排队 :: ${shortId(id, 6)} :: ${String(why ?? '').slice(0, 80)}`)
  return { ok: true, status: 'queued' }
}

/** 是否有排队（给测试与状态面板用）。 */
export function hasPending(agent) {
  const id = agent?.id ?? agent?.session?.id
  return !!id && pending.has(id)
}

/**
 * agent 变 idle 时调用：把排队的压缩真正执行掉。
 *
 * ⚠️ 必须吞掉所有异常并转成 notice：
 *   这里是 `agent/status` 的同步监听器，抛出去会污染宿主的状态机。
 *   而压缩失败（busy/changed/summary）是**预期内**的事，要如实告诉模型，
 *   不能静默 —— 静默会让模型以为压过了。
 *
 * @returns {Promise<{ran:boolean, ok?:boolean, text?:string}>}
 */
export async function drainOnIdle(ctx, agent) {
  const id = agent?.id ?? agent?.session?.id
  if (!id) return { ran: false }

  // ⚠️ 这里**故意没有** `if (running.has(id)) return` —— 那不是保守，是死代码。
  //   原因：下面 `pending.delete(id)` 是同步的，而 pending→running 的转移
  //   全在这个函数内同步完成，中间没有 await。所以一旦进入 running 状态，
  //   pending 必然已经空了，会先被下面这一行挡住。
  //   而「压缩中又来新请求」由 requestCompact 的 already-running 分支拦截。
  //   留着假的第二道闸只会让人以为"并发已被保护"，反向验证时才发现根本没路径能测到它
  //   （2026-11-05 实测：去掉那行，599 项测试**全绿** —— 证明它不可达）。
  if (!pending.has(id)) return { ran: false }

  const req = pending.get(id)
  pending.delete(id)
  running.add(id)

  // ── 取压缩服务：三条路，按成功率从高到低 ──
  //
  // ⚠️⚠️ 2026-11-05 真机把前两条都踩了一遍，语义各不相同（cordis/src/reflect.ts）：
  //
  //   ① agentPresets.serviceFor(agent, 'compaction')   ← **最终采用的**
  //      官方说明原文："Read a service supplied inside an Agent's isolated preset group."
  //      （来自 host Service 目录 agentPresets 那一项）
  //      这正是创造模式的情形：compaction 由 preset 的**内层 Loader 树**提供，
  //      主插件在外层，前两条路都够不到。这条是唯一设计用来跨这层边界的入口。
  //
  //   ② ctx.compaction（Proxy get 陷阱，reflect.ts:153-167）
  //      沿 fiber 树**向上**逐级找；查到返回，查到根都没有 → throw。
  //      血证 10:56:25 `主动压缩 drain 异常 :: cannot get property "compaction" without inject`
  //      对「宿主层直接提供 compaction」的组合（如 preset-standard 未内联的场景）仍可能有效。
  //
  //   ③ ctx.get('compaction')（reflect.ts:233-243 _getImpl）
  //      **只查当前 context 自己的 store**，不向上找，找不到返回 undefined。
  //      血证 10:57:48 `主动压缩失败 :: compaction 服务不可用`
  //
  // 三条都拿不到就如实报「当前组合下拿不到」，**绝不假装压过了**。
  //
  // ⚠️ 不为这个功能去 inject 里声明 compaction：Cordis 的 inject 语义是
  //   "Services the plugin requires; it only loads while all are available"（registry.ts:106）。
  //   声明了等于「没有压缩服务时整个记忆插件不加载」—— 拿记忆系统的整体可用性
  //   去赌一个可选功能，代价完全不成比例。
  const wantCompactNow = (s) => s && typeof s.compactNow === 'function'
  let engine
  let engineFrom = 'none'

  // ① preset 内层（创造模式的正解）
  try {
    const presets = typeof ctx?.get === 'function' ? ctx.get('agentPresets') : undefined
    if (presets && typeof presets.serviceFor === 'function') {
      const s = presets.serviceFor(agent, 'compaction')
      if (wantCompactNow(s)) {
        engine = s
        engineFrom = 'preset'
      }
    }
  } catch (e) {
    log(`主动压缩取 preset 内层服务失败（继续试其它路） :: ${e?.message ?? e}`)
  }

  // ② Proxy（祖先 fiber 提供时有效；未 inject 会 throw，必须包住）
  if (!engine) {
    try {
      const s = ctx?.compaction
      if (wantCompactNow(s)) {
        engine = s
        engineFrom = 'proxy'
      }
    } catch {
      /* 未 inject → throw，属预期，继续下一条 */
    }
  }

  // ③ 本层
  if (!engine && typeof ctx?.get === 'function') {
    try {
      const s = ctx.get('compaction')
      if (wantCompactNow(s)) {
        engine = s
        engineFrom = 'local'
      }
    } catch {
      /* 忽略 */
    }
  }

  if (!engine) {
    running.delete(id)
    setNotice(
      id,
      false,
      '请求了主动压缩，但当前组合里拿不到压缩服务（compaction）。' +
        '已试过 preset 内层 / 祖先 / 本层三条路，都没有。没有执行。',
    )
    log(`主动压缩失败 :: ${shortId(id, 6)} :: compaction 三条路都取不到`)
    // ⚠️ 带上 engineFrom：让调用方/测试能区分「三条路都没拿到」与
    //   「拿到了但不是引擎」。这两种失败在 ok=false 上长得一样，
    //   但含义完全不同 —— 前者是组合没有压缩服务，后者是取错了东西（真 bug）。
    return { ran: true, ok: false, engineFrom }
  }
  log(`主动压缩取服务成功 :: ${shortId(id, 6)} :: 来源=${engineFrom}`)

  // ⚠️ 兜底再查一次：三条路都做了 wantCompactNow 校验，但这里是最后防线。
  //   若走到这一步 engine 仍不是引擎，说明上面的校验被改坏了 ——
  //   宁可在这里明确报错，也不要靠 TypeError 顺带兜住
  //   （TypeError 与"服务不存在"在日志里几乎分不清，会把真 bug 伪装成正常降级）。
  if (typeof engine.compactNow !== 'function') {
    running.delete(id)
    setNotice(id, false, `取到的 compaction 不是可用引擎（来源=${engineFrom}），没有执行。`)
    log(`主动压缩失败 :: ${shortId(id, 6)} :: 取到非引擎来源=${engineFrom}`)
    return { ran: true, ok: false, engineFrom: `${engineFrom}:invalid` }
  }

  const controller = new AbortController()
  try {
    const result = await engine.compactNow(agent, controller.signal)
    running.delete(id)
    if (result === null) {
      // 没有可压的区间 —— 这不是失败，但必须说清"什么都没发生"
      setNotice(id, true, '主动压缩已执行：当前没有可安全折叠的历史区间，什么也没动。')
      log(`主动压缩完成 :: ${shortId(id, 6)} :: 无可压区间`)
      return { ran: true, ok: true, engineFrom }
    }
    const n = Array.isArray(result.shadowedSeqs) ? result.shadowedSeqs.length : 0
    const tokens = result.shadowedTokenCount ?? 0
    const summarySeq = result.summarySeq
    setNotice(
      id,
      true,
      `主动压缩已完成（${req.why || '模型请求'}）：折叠 ${n} 条历史，约 ${tokens} tokens，摘要 seq=${summarySeq}。` +
        `精确原文可用 mind_expand 按 seq 取回。`,
    )
    log(`主动压缩完成 :: ${shortId(id, 6)} :: 折叠 ${n} 条 / ${tokens} tokens / 摘要 seq=${summarySeq}`)
    return { ran: true, ok: true }
  } catch (e) {
    running.delete(id)
    // ManualCompactionError 带 code：busy/changed/summary/commit/persistence/cancelled
    const code = e?.code ?? 'unknown'
    const msg = e?.message ?? String(e)
    setNotice(id, false, `主动压缩没有成功（code=${code}）：${msg}。原文与存档不受影响，可以稍后再试。`)
    log(`主动压缩失败 :: ${shortId(id, 6)} :: code=${code} :: ${msg}`)
    return { ran: true, ok: false }
  }
}

function setNotice(sessionId, ok, text) {
  notices.set(sessionId, { ok, text, at: Date.now() })
  // 简单封顶：超了就丢最旧的
  if (notices.size > MAX_NOTICES) {
    const oldest = [...notices.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) notices.delete(oldest[0])
  }
}

/**
 * 取走该会话的压缩结果通知（取走即清）。
 *
 * ⚠️ 取走而不是读：注入每步都可能发生，如果只读不清，
 *   同一句「压缩已完成」会每步重复注入，白白烧预算（这正是 P0 要解决的问题）。
 */
export function takeNotice(sessionId) {
  if (!sessionId) return null
  const n = notices.get(sessionId)
  if (!n) return null
  notices.delete(sessionId)
  return n
}

/** 只读不取（给 mind_status 排查用）。 */
export function peekNotice(sessionId) {
  return sessionId ? (notices.get(sessionId) ?? null) : null
}

/** 测试用：清空全部状态。 */
export function _reset() {
  pending.clear()
  notices.clear()
  running.clear()
}

/** 测试用：看内部状态。 */
export function _inspect() {
  return {
    pending: [...pending.keys()],
    notices: [...notices.keys()],
    running: [...running],
  }
}
