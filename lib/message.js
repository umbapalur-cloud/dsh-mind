/**
 * dsh-mind · 消息判定与注入消息构造（三段共用）
 *
 * CCG 六要素:
 *   功能名   消息层公用函数：取文本、判自我产出、判值不值得采集、造合规注入消息
 *   生效条件 被 index.js 与 segments/*.js 引用
 *   子功能   textOf / isSelfMessage / worthCapturing / looksMachine / assistantTextOf /
 *            makeInjectionMessage / MACHINE_PREFIXES
 *   执行     **纯确定性判断**，不做语义推理（那是模型的事）
 *   验证方式 tests/regress.mjs 的"防自我放大""机器播报过滤""注入形状合规"三组
 *   不适用条件 需要判断一句话"有没有意义"（那需要语义，不用在这里）
 *
 * ⚠️ 整合的最大收益之一就在这里：
 *   整合前三份名单各自维护 —— strand 的 SELF_SOURCE_KINDS 里要手动列出
 *   psyche / tacit / memory-hub 的 kind，psyche 又有一份 FOREIGN_INJECTION_KINDS，
 *   tacit 只有一句注释。装个新插件就得回来改另一个插件的代码。
 *   现在只有一份，且明确分成「自家 kind」与「别人家的注入」两组。
 */

import { randomUUID } from 'node:crypto'

// ─────────────────────────── 水印常量 ───────────────────────────

/** 第三人称段水印（跨会话脉络）。 */
export const MARK_STRAND = '【跨会话脉络 · dsh-mind 自动注入 · 非用户输入】'

/** 规范段水印（经验库）。 */
export const MARK_TACIT = '【经验 · 自动命中 · dsh-mind】'

/** 第一人称段水印（自我觉知）。 */
export const MARK_PSYCHE = '【自我觉知 · dsh-mind 自动注入 · 非用户输入】'

/** 主动投递水印。和注入水印分开，方便在会话里一眼区分"别的窗口说的话"。 */
export const MARK_PUSH = '【别处刚说的话 · dsh-mind 主动投递 · 非用户输入】'

/** 注入消息的 source.kind。 */
export const KIND_INJECT = 'dsh-mind'
export const KIND_PUSH = 'dsh-mind-push'

/**
 * 自家产出的 kind。
 *
 * ⚠️ 这条闸门不能放松：投递出去的消息若被对端当输入再采一遍，就会自我放大
 *   （A 说 → 投给 B → B 当输入再采 → 又投回 A → 无限循环）。
 */
export const SELF_SOURCE_KINDS = new Set([
  KIND_INJECT,
  KIND_PUSH,
  // 宿主的指令注入，不是用户输入
  'agent-instructions',
  // 旧版插件可能还在别的 profile 里跑，兼容保留（否则升级期间会互相放大）
  'dsh-strand',
  'dsh-strand-push',
  'dsh-psyche',
  'dsh-psyche-push',
  'dsh-tacit',
  'dsh-memory-hub',
  ...(process.env.MIND_SELF_KINDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
])

/**
 * 所有已知的注入水印前缀。
 *
 * 用途：kind 可能因上游克隆而丢失，**水印是第一行、最不容易丢**。
 * 所以判"这是不是自动注入"要两道闸门：先看 kind，再看水印。
 */
export const INJECTION_MARKS = [
  MARK_STRAND,
  MARK_TACIT,
  MARK_PSYCHE,
  MARK_PUSH,
  '【跨会话脉络',       // 旧 strand
  '【别处刚说的话',      // 旧 strand 投递
  '【自我觉知',         // 旧 psyche
  '【别处的心跳',        // 旧 psyche 投递
  '【经验',            // 旧 tacit
  '【自动唤醒',         // dsh-wake
  '【跨窗口',           // 泛指
]

// ─────────────────────────── 文本提取 ───────────────────────────

/** 从一条 Message 里取纯文本。只取 text 段，忽略图片/工具结果等。 */
export function textOf(message) {
  try {
    const content = message?.content
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') {
        const t = c.text.trim()
        if (t) parts.push(t)
      }
    }
    return parts.join('\n').trim()
  } catch {
    return ''
  }
}

/**
 * 从一条 assistant/message 事件里取纯文字。
 *
 * 只取 `type === 'text'` 的块：
 *   - tool-call 块是中间过程，别处看了没用，而且体积大
 *   - thinking 块是内部推理，不该外泄
 */
export function assistantTextOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const c of content) {
    if (c?.type === 'text' && typeof c.text === 'string') {
      const t = c.text.trim()
      if (t) parts.push(t)
    }
  }
  return parts.join('\n').trim()
}

// ─────────────────────── 机器播报识别 ───────────────────────

/**
 * 这类"用户消息"其实是宿主自己塞进收件箱的事件回执，不是人说的话 ——
 * 后台任务起止、子代理结束、工具调用重复告警等。
 *
 * ⚠️ 为什么必须滤掉：实测共享层 60 条动向里大半是 `background job pwsh-...`
 *   这种工具命令原文，一条就上百字，把真正的人话挤到后面去，
 *   还平白把首次注入从几千字符抬到 8700+。
 *
 * ⚠️ `<goal_round>` 是 2026-11-03 实测抓到的漏网之鱼：
 *   目标循环续跑时，宿主会往 inbox 塞一段 `<goal_round>` + `Objective:` + `Round: N/40`。
 *   role 是 user、没有 source.kind、也不是我们的水印 —— 于是被当成主人的话进了共享层。
 *   后果有两个，都不轻：
 *     ① 别的窗口会看到「主人说：<goal_round> Objective: ...」，误以为是新指令；
 *     ② 那段还带着指令口吻（"Continue working toward..."），有被当成授权的风险。
 *   这类消息的共同特征是**以 XML 标签或固定头部开头**，所以按前缀判最可靠。
 *
 * 只按前缀判断，不做模糊匹配：宁可漏判一条，也不要把人说的话误杀。
 */
export const MACHINE_PREFIXES = [
  // ── 后台任务 / 子代理回执 ──
  'background job ',
  'Background job ',
  'Background subagent ',
  'background subagent ',
  // ── 宿主告警 ──
  'You are repeating the exact same tool call',
  'The host restarted during this ticket',
  // ── 结构化事件（JSON 开头）──
  '{"kind":"candidate"',
  '{"kind":"worker_',
  '{"kind":"follow_up"',
  '{"kind":"ticket_',
  '{"ticket_id":"',
  '{"trigger_id":"msp:',
  // ── 目标循环续跑（2026-11-03 实测漏网）──
  '<goal_round>',
  // ── 宿主注入的其它 XML 包裹块 ──
  '<system-reminder>',
  '<system_reminder>',
  '<goal_status>',
  '<tool_result>',
  '<error>',
]

/**
 * 更细的机器播报判据（除前缀外）。
 *
 * ⚠️ 为什么需要第二道：有些回执没有稳定前缀，但有**高度特征化的内部结构**。
 *   例如 goal_round 被剥掉外层标签后，会留下 `Round: 2/40` + `Continue working toward`。
 *   只靠前缀会漏。这里用「必须同时命中多个特征」来降低误杀风险——
 *   宁可漏判，不可误杀主人真说的话。
 */
const MACHINE_PATTERNS = [
  // goal 续跑：Round: N/M 与指令口吻同时出现
  (s) => /\bRound:\s*\d+\s*\/\s*\d+/.test(s) && /Continue working toward|Treat the current workspace/i.test(s),
  // 目标状态包裹
  (s) => /^Goal status:|^\[goal\]/i.test(s),
  // 只有时间戳与 exit code 的裸回执
  (s) => /^\[exit code: \d+\]$/.test(s.trim()),
  (s) => /^Time sampled while preparing turn/i.test(s),
]

/** 这条文本是不是宿主播报/自动提示，而不是人说的话。 */
export function looksMachine(t) {
  const s = String(t ?? '').trimStart()
  if (!s) return true
  for (const p of MACHINE_PREFIXES) if (s.startsWith(p)) return true
  for (const fn of MACHINE_PATTERNS) {
    try {
      if (fn(s)) return true
    } catch {
      /* 单条判据失败不影响其他 */
    }
  }
  return false
}

// ─────────────────────── 自我产出识别 ───────────────────────

/**
 * 这条消息是不是"我们自己产出的"（注入 / 投递 / 心跳）。
 *
 * ⚠️ 判断顺序：先看 kind，再看水印。任何一条命中即拒。
 *   两道都要，因为 kind 可能被上游克隆丢掉，而水印是第一行、最不容易丢。
 */
export function isSelfMessage(message) {
  const kind = message?.source?.kind
  if (kind && SELF_SOURCE_KINDS.has(kind)) return true
  if (kind && /^dsh-/.test(kind) && /(push|inject|context|brief|mind)/i.test(kind)) {
    // ⚠️ 模式兜底：显式名单需要"装了新插件就回来改代码"，而多插件互投的循环
    //   一旦发生就是自我放大，代价远大于多挡一条。所以形似自动投递的一律拒。
    //   限定 dsh- 前缀 + push/inject/context/brief/mind，够宽以覆盖将来新增的
    //   跨会话插件，又不会误伤 kind=user 这类真消息。
    return true
  }
  const t = textOf(message)
  for (const m of INJECTION_MARKS) if (t.startsWith(m)) return true
  return false
}

/** 判断这条消息是否值得进共享层（跳过工具结果、系统注入、机器播报等噪音）。 */
export function worthCapturing(message) {
  try {
    if (isSelfMessage(message)) return false
    if (message?.role !== 'user') return false
    const t = textOf(message)
    if (!t) return false
    if (looksMachine(t)) return false
    return true
  } catch {
    return false
  }
}

// ─────────────────────── 注入消息构造 ───────────────────────

/**
 * 造一条完整的 user Message。
 *
 * ⚠️ 宿主校验要求 id + role + content + source，**缺了会写坏整个会话历史**，
 *   下次加载整段会话被拒。这是本文件唯一被允许造消息的地方 ——
 *   散落各处自己拼对象是这类事故的根源。
 */
export function makeInjectionMessage(text, kind = KIND_INJECT, form = 'mind-context') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form },
  }
}

/**
 * 把注入消息插在「已领取消息」之后。
 *
 * ⚠️ 必须按 id 比对，不能用引用相等：
 *   上游若把消息对象克隆过，`includes` 恒为 false → 插入位退化成 0/末尾，
 *   结果是注入消息跑到 system 之前或顺序错乱。strand 与 psyche 都踩过这个坑。
 */
export function insertAfterClaimed(decisionMessages, claimedMessages, msg) {
  const claimedIds = new Set((claimedMessages ?? []).map((m) => m?.id).filter(Boolean))
  const lastClaimed = (decisionMessages ?? []).findLastIndex((m) => m?.id && claimedIds.has(m.id))
  const at = lastClaimed >= 0 ? lastClaimed + 1 : (decisionMessages?.length ?? 0)
  return (decisionMessages ?? []).toSpliced(at, 0, msg)
}
