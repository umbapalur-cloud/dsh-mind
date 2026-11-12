/**
 * dsh-mind · 从压缩输入反推被遮蔽的 seq 区间
 *
 * CCG 六要素:
 *   功能名   把 `summarize(input, agent, signal)` 收到的 messages 映射回 surface 的 seq
 *   生效条件 compaction.js 的 summarize() 在存档前调用
 *   子功能   滑窗比对派生消息正文 / 剔掉 system 头 / 找不到返回 null
 *   执行     inferShadowedSeqs(session, input)
 *   验证方式 tests/regress.mjs 第 58 组（纯行为测，不需要宿主包）
 *   不适用条件 不负责落盘（那是 archive.js），不负责摘要（那是 compaction.js）
 *
 * ⚠️ 为什么单独一个文件、且**不 import 任何宿主包**：
 *   这段逻辑原本在 compaction.js 里，而那个文件必须 import
 *   `@deepseek-ai/dsh-compaction-basic` 才能继承引擎 —— 于是回归测试
 *   在普通 node 里一跑就 `ERR_MODULE_NOT_FOUND`，等于**这段关键逻辑测不了**。
 *   抽出来之后它是纯函数：只吃 session 形状，不碰宿主 API，可以直接喂假对象测。
 *
 * ⚠️ 为什么要反推（2026-11-05，读 @deepseek-ai/dsh-compaction-basic 源码确认）：
 *   `summarize(input, agent, signal)` 收到的 `input` **只含 messages 和 tools**，
 *   不带任何 seq 信息 —— `buildSummarizationInput()`（该包 lib/index.js:695-704）
 *   只从 `shadowedSeqs` 里取派生消息，**seq 本身被丢掉**。
 *   而真正被遮蔽的区间恰恰是存档最需要的东西。
 *
 *   所以反过来推：压缩区间的 seq 是 `surface.nodes` 的一段**连续切片**
 *   （`validateSurfaceRegion` 里 `nodes.slice(startIdx, endIdx+1)`）。
 *   我们在表面节点里找一段连续区间，其「派生消息」与 input.messages 的正文一一对应。
 *
 * ⚠️ 判据必须宽松但可验证：
 *   ① 逐条比对派生消息的**文本**（不用 deepEqual —— 那边有 id/时间戳等易变字段）
 *   ② 找不到就返回 null —— **宁可不存档，也不能存错区间**。
 *      存错区间比不存更糟：以后 mind_expand 会取回一段无关的原文，
 *      而模型会把它当成"这就是当时的对话"。
 */

function blocksToPlain(content) {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (typeof content?.text === 'string') return content.text
    return ''
  }
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** 归一化：压掉连续空白，便于跨包装比对。 */
function normalize(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * @param {object} session  需要 surface.nodes 与 deriveEventMessage + eventAt
 * @param {object} input    summarize 收到的 { messages, tools? }
 * @returns {{seqs:number[], startIdx:number}|null}
 */
export function inferShadowedSeqs(session, input) {
  try {
    const nodes = session?.surface?.nodes
    if (!Array.isArray(nodes) || nodes.length === 0) return null
    if (typeof session.deriveEventMessage !== 'function') return null
    if (typeof session.eventAt !== 'function') return null

    const wanted = (input?.messages ?? []).map((m) => ({
      role: m?.role,
      text: blocksToPlain(m?.content),
    }))

    // 头一条可能是 system（buildSummarizationInput 会拼一个 surface 头），
    // 它不对应任何 seq，先剔掉。
    const regionWanted = wanted[0]?.role === 'system' ? wanted.slice(1) : wanted
    if (regionWanted.length === 0) return null

    // ⚠️ 这里是 2026-11-05 修的真 bug 所在，血证见文件头注释。
    //   `surface.nodes` 存的是 **seq 数字**（dsh-session:464 `state.nodes.push(plan.seq)`，
    //   getter 注释写的是「Surface event sequences」），**不是 event 对象**。
    //   第一版直接 `deriveEventMessage(n)`，把数字当事件传进去 →
    //   `event.type` 是 undefined → 走 default 分支返回 null →
    //   derived 全是 null → 永远匹配不上 → 静默返回 null → **存档从未发生**。
    //   基类自己也是 `deriveEventMessage(session.eventAt(seq))`（compaction-basic:699），
    //   女仆漏了 `eventAt` 这一步。
    const derived = []
    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const node = nodes[nodeIdx]
      // 兼容两种形态：宿主给 seq 数字；若将来改成给节点对象则取 .seq
      const seq = typeof node === 'number' ? node : Number(node?.seq)
      if (!Number.isFinite(seq)) continue
      let msg
      try {
        msg = session.deriveEventMessage(session.eventAt(seq))
      } catch {
        msg = null
      }
      // ⚠️ 派生为 null 的节点**不参与比对**，但不能因此丢掉它占的位置。
      //   基类 buildSummarizationInput 用 `.filter(m => m !== null)`，
      //   所以 input.messages 里没有它们；而真正被遮蔽的区间是
      //   `nodes.slice(startIdx, endIdx+1)` 的**连续**切片。
      //   所以：比对时跳过，返回 seq 时按 nodeIdx 跨完整区间。
      if (msg === null || msg === undefined) continue
      derived.push({ nodeIdx, seq, role: msg.role, text: blocksToPlain(msg.content) })
    }
    if (derived.length < regionWanted.length) return null

    // 滑窗：起点 s，长度 = regionWanted.length
    for (let s = 0; s + regionWanted.length <= derived.length; s++) {
      let ok = true
      for (let k = 0; k < regionWanted.length; k++) {
        const d = derived[s + k]
        if (d.role !== regionWanted[k].role) {
          ok = false
          break
        }
        // 文本比对：派生消息可能比原文多了包装（如 system-reminder），用包含判断
        const a = normalize(d.text)
        const b = normalize(regionWanted[k].text)
        if (a !== b && !a.includes(b) && !b.includes(a)) {
          ok = false
          break
        }
      }
      if (ok) {
        const fromIdx = derived[s].nodeIdx
        const toIdx = derived[s + regionWanted.length - 1].nodeIdx
        return {
          seqs: nodes.slice(fromIdx, toIdx + 1).map((n) => (typeof n === 'number' ? n : Number(n?.seq))),
          startIdx: fromIdx,
        }
      }
    }
    return null
  } catch {
    return null
  }
}
