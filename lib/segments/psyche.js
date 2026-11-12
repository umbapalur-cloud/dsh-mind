/**
 * dsh-mind · 第一人称段：自我觉知
 *
 * CCG 六要素:
 *   功能名   psyche 段：告诉模型「你此刻分散在哪几处、各处在做什么、在追什么」
 *   生效条件 config.psyche.enabled && config.psyche.inject
 *   子功能   主体标识行 / 别处动态 / 本处处境 / 跨窗口追求 / 增量与全量
 *   执行     render* 全为纯函数：Store → string，不读盘不写盘不发请求
 *   验证方式 tests/regress.mjs 自我觉知组（136 项里的大部分）
 *   不适用条件 需要第三人称「别人说了什么」（那是 strand 段）
 *
 * ⚠️ 这一层是插件成败的关键，理由如下：
 *   同一份数据，写成「另一个窗口（a1b2c3）正在做 X」是**监控面板**；
 *   写成「你的注意力此刻分散在两处」才是**主体连续的自我觉知**。
 *   后者模型才会当成"我的处境"，前者只会被当成"外部情报"。
 *   这个差别不是修辞，是模型如何安置信息的问题：情报放进"背景"，
 *   处境放进"我该怎么做"。
 *
 * ⚠️ 但绝不能让模型误以为别人是"我自己在另一个地方"：
 *   那样会导致它把别处的经历当自己的（虚假记忆）。所以：
 *   · 用「你」指当前窗口
 *   · 用「那处/那边」指别的窗口
 *   · 明写「不是你在那个窗口的经历」——归属必须硬标注
 */

import { MARK_PSYCHE, MARK_PUSH } from '../message.js'
import { agoText, shortId } from '../io.js'

export { MARK_PSYCHE, MARK_PUSH }

/** 注入文本总长上界。超过就砍掉次要段落，保主体觉知。 */
export const MAX_BLOCK_CHARS = 1200

/**
 * 工具名 → 人话动作。
 *
 * ⚠️ 为什么不用原始工具名：
 *   `pwsh(...)` 对模型是噪音，`正在终端里跑命令` 才是处境。
 *   但也不能映射得太花哨——过度拟人会让模型以为真的有人在操作。
 *   所以统一用「动作 + 对象」的朴素说法。
 */
const TOOL_HUMAN = {
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  glob: '找文件',
  grep: '搜内容',
  pwsh: '在终端跑命令',
  bash: '在终端跑命令',
  pwsh_bg: '在跑后台任务',
  web_search: '在查网页',
  web_fetch: '在读网页',
  subagent: '派了个子代理干活',
  subagent_fork: '派了个子代理干活',
  workflow: '在跑一个多代理流程',
  todo_write: '在整理任务清单',
  ask_user_question: '在向主人提问',
  present: '在交付文件',
  read_image: '在看图',
  terminal_open: '开了个终端会话',
  terminal_send: '在终端里操作',
  skill: '在查技能手册',
  mind_recall: '在查共享记忆',
  mind_intend: '在声明自己在追什么',
}

export function humanTool(name) {
  const n = String(name ?? '')
  if (!n) return '在做事'
  if (TOOL_HUMAN[n]) return TOOL_HUMAN[n]
  if (n.startsWith('mcp__')) return '在调外部工具'
  return `在用 ${n}`
}

/**
 * 从工具参数里抽一句"对象是什么"，让动作具体。
 *
 * ⚠️ 只取少数几个高价值字段，且必须截断：
 *   工具参数可能很大（整个文件内容），直接塞进注入会撑爆上下文。
 */
export function activityTarget(name, args) {
  try {
    const a = args ?? {}
    const pick =
      a.file_path ?? a.path ?? a.command ?? a.pattern ?? a.query ?? a.description ?? a.url ?? a.skill ?? a.name ?? null
    if (typeof pick !== 'string' || !pick) return ''
    // 路径只留末两段，避免把 <work>\xxx\yyy\zzz 整条塞进去
    let s = pick.replace(/\s+/g, ' ').trim()
    if (/[\\/]/.test(s) && s.length > 40) {
      const partsStr = s.split(/[\\/]/).filter(Boolean)
      s = partsStr.slice(-2).join('/')
    }
    return s.length > 48 ? `${s.slice(0, 47)}…` : s
  } catch {
    return ''
  }
}

// ─────────────────────────── 渲染 ───────────────────────────

/**
 * 主体标识行：我是谁、此刻一共分散在几处。
 *
 * ⚠️「分散在 N 处」这个说法是刻意的：
 *   它把"多个窗口"重构成"我的一心多用"，而不是"多个独立实例"。
 *   这正是主体连续与状态连续的语义差别。
 */
export function renderIdentity(store, selfId, now = Date.now()) {
  const live = store.liveWindows(now)
  const others = live.filter((w) => w.id !== selfId)
  const name = store.identity?.name ?? '星'
  const addr = store.identity?.address ?? '主人'
  if (live.length <= 1) return `你是${name}，${addr}的女仆。此刻只有你这一处醒着。`
  return `你是${name}，${addr}的女仆。此刻你的注意力分散在 ${live.length} 处（这一处在 ${shortId(selfId, 6)}，另有 ${others.length} 处）。`
}

/**
 * 渲染「别处」段落。
 *
 * ⚠️ 归属标注是硬要求：每一条都带「不是你在那个窗口的经历」，
 *   宁可啰嗦也不能让模型混淆。
 */
export function renderOthers(store, selfId, now = Date.now()) {
  const live = store.liveWindows(now)
  const others = live.filter((w) => w.id !== selfId)
  if (others.length === 0) return ''

  const lines = ['', '### 你另外几处在做什么（不是你在这个窗口的经历）']
  for (const w of others) {
    const tag = shortId(w.id, 6)
    const segs = []
    segs.push(`${tag}：${w.thinking ? '正在思考' : '等着'}`)
    if (w.activity?.text) {
      segs.push(`${humanTool(w.activity.tool)} ${w.activity.text}（${agoText(w.activity.at, now)}）`)
    }
    if (w.intent?.text) segs.push(`那边说自己在追：${w.intent.text}`)
    if (w.lastUserText) segs.push(`主人最后对它说的是「${w.lastUserText}」`)
    if (!w.activity && !w.intent && !w.lastUserText) segs.push('刚开，还没有动静')
    lines.push('- ' + segs.join('，'))
  }
  return lines.join('\n')
}

/** 渲染本窗口自己的处境（让模型知道"我停在哪"）。 */
export function renderSelf(store, selfId, now = Date.now()) {
  const w = store.windows.get(selfId)
  if (!w) return ''
  const segs = []
  if (w.intent?.text) segs.push(`你刚才说自己在追：${w.intent.text}（${agoText(w.intent.at, now)}）`)
  if (w.activity?.text) {
    segs.push(`你上一个动作是${humanTool(w.activity.tool)} ${w.activity.text}（${agoText(w.activity.at, now)}）`)
  }
  if (w.lastUserText) segs.push(`主人在这处最后说的是「${w.lastUserText}」`)
  if (segs.length === 0) return ''
  return ['', '### 你这一处', ...segs.map((s) => '- ' + s)].join('\n')
}

/** 渲染未结的追求（跨窗口的「我们在追什么」）。 */
export function renderPursuits(store, now = Date.now()) {
  const open = store.openPursuits()
  if (open.length === 0) return ''
  const lines = ['', '### 你正在追的事（跨窗口共用）']
  for (const p of open.slice(-8)) {
    const by = p.by ? `（${shortId(p.by, 6)} 起的）` : ''
    lines.push(`- ${p.text}${by} · ${agoText(p.at, now)}`)
  }
  return lines.join('\n')
}

/** 完整注入块（首次或状态大变时用）。 */
export function renderFull(store, selfId, now = Date.now(), maxChars = MAX_BLOCK_CHARS) {
  const parts = [
    MARK_PSYCHE,
    renderIdentity(store, selfId, now),
    renderOthers(store, selfId, now),
    renderSelf(store, selfId, now),
    renderPursuits(store, now),
  ].filter(Boolean)

  let text = parts.join('\n')

  // 超长时按优先级砍：先砍追求，再砍自己的处境，最后才砍别处。
  if (text.length > maxChars) {
    const head = [MARK_PSYCHE, renderIdentity(store, selfId, now), renderOthers(store, selfId, now)]
      .filter(Boolean)
      .join('\n')
    text = head.length > maxChars ? head.slice(0, maxChars) : head
  }
  return text
}

/**
 * 增量注入块：只报「自上一步以来别处发生了什么」。
 *
 * ⚠️ 为什么要增量：
 *   每步都发全量会让长会话里同一段状态重复几十次。实测过 strand 的
 *   「近期对话」块重复率 92.3%，那还是它已经做了节流的情况。
 *
 * ⚠️ 为什么增量必须能和全量互相纠正：
 *   只用增量会在"漏了一条"之后永久错位。所以 index.js 会周期性发全量纠偏。
 */
export function renderDelta(store, selfId, prevSnap, now = Date.now()) {
  if (!prevSnap) return ''
  const live = store.liveWindows(now)
  const others = live.filter((w) => w.id !== selfId)
  const selfTag = shortId(selfId, 6)

  const changes = []
  for (const w of others) {
    const tag = shortId(w.id, 6)
    const prev = prevSnap[tag]

    // ⚠️ 用 seq 而不是 at 判"有没有新动作"：
    //   同一毫秒内连续两次工具调用时间戳相等，`at > prev.at` 恒为 false，
    //   第二条会永久漏报。seq 是单调的。at 只用于显示"多久以前"。
    const curSeq = w.activity?.seq ?? 0
    const curIntent = w.intent?.text ?? ''

    if (!prev) {
      changes.push(`- ${tag} 刚醒来${w.activity?.text ? `，${humanTool(w.activity.tool)} ${w.activity.text}` : ''}`)
      continue
    }
    if (curSeq > (prev.seq ?? 0) && w.activity?.text) {
      changes.push(`- ${tag} ${humanTool(w.activity.tool)} ${w.activity.text}`)
    }
    if (curIntent && curIntent !== (prev.intent ?? '')) {
      changes.push(`- ${tag} 说自己在追：${curIntent}`)
    }
    // ⚠️ 主人对别处说的话也必须进增量（2026-11-03 诊断抓到的真漏报）：
    //   指纹里算了 lastUserAt，但这里不报，于是「指纹变了 → 走增量 →
    //   增量内容为空 → 直接 return」把这条更新**整个吞掉**。
    //   这就是「主人切换窗口后在别处说的话，这一处永远看不到」。
    //   **规律：凡进指纹的字段，增量必须能表达它。** 两边不对称就是漏报。
    const curUserAt = w.lastUserAt ?? 0
    if (curUserAt > (prev.lastUserAt ?? 0) && w.lastUserText) {
      changes.push(`- ${tag} 那边，主人说「${w.lastUserText}」`)
    }
  }

  // 消失的窗口也要报——否则模型会以为它还在。
  //
  // ⚠️ 必须跳过自己这一处：快照里若含自己的 tag，而 others 永远不含自己，
  //   就会把「自己」判成「不再醒着」——每一步都报一次自己的死讯。
  for (const tag of Object.keys(prevSnap)) {
    if (tag === selfTag) continue
    if (!others.some((w) => shortId(w.id, 6) === tag)) changes.push(`- ${tag} 不再醒着了`)
  }

  if (changes.length === 0) return ''
  return ['【自我觉知 · 增量 · 非用户输入】', '自上一步以来，你另外几处的变化：', ...changes].join('\n')
}

/**
 * 生成当前状态快照（给 renderDelta 用）。
 *
 * ⚠️ **不收自己这一处**：快照的语义是"别处此刻是什么样"。
 *   把自己也收进去，renderDelta 会把"自己不在 others 里"误判成
 *   "自己不再醒着"，每步报一次自己的死讯。
 */
export function snapOf(store, selfId, now = Date.now()) {
  const out = {}
  for (const w of store.liveWindows(now)) {
    if (w.id === selfId) continue
    const tag = shortId(w.id, 6)
    out[tag] = {
      seq: w.activity?.seq ?? 0,
      activityAt: w.activity?.at ?? 0,
      intent: w.intent?.text ?? '',
      // 与 renderDelta 的判据一一对应，见那边的注释
      lastUserAt: w.lastUserAt ?? 0,
    }
  }
  return out
}
