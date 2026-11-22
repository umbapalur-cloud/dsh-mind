/**
 * dsh-mind · 统一预算
 *
 * CCG 六要素:
 *   功能名   注入预算：各段合起来能占多少字符，超了怎么削
 *   生效条件 lib/index.js 在拼装注入文本时调用
 *   子功能   perSegment 上限 / 总上限 / 按段削（从最长段开始）/ 自适应间隔
 *   执行     apply(texts, budget) 纯函数
 *   验证方式 tests/regress.mjs 预算组（含反向：任何一段被削必须在日志里留痕）
 *   不适用条件 需要"按信息密度"削（那需要语义，本模块只按长度）
 *
 * ⚠️ 2026-11-08 拆分：原来管三段（psyche / strand / tacit），
 *   现在 strand 搬走了，但**多了一段 diary**（压缩前日记）。
 *   日记独立成段是因为它本来就该在「压缩发生后」被看见，
 *   与"别的窗口说了什么"无关 —— 以前寄生在 strand 段里只是历史偶然。
 *
 * ⚠️ 2026-11-16 再加 lifeline（月度生命索引）。
 *   它和 diary 的取舍关系必须写清，否则后人会以为多出来的 1300 是白拿的：
 *     · diary    = 只在压缩后出现一次，2000 字符
 *     · lifeline = 每天都在，1300 字符
 *   两者不争同一时刻的预算。lifeline 被削时的正确行为是**先丢最老的月份**
 *   （这一点它在 renderIndex 里自己做了，本模块不做语义，只按长度削）。
 *
 * @param {{psyche?:string, lifeline?:string, diary?:string, tacit?:string}} texts
 * @param {{total:number, psyche:number, lifeline?:number, diary?:number, tacit:number}} budget
 * @returns {{segments:object, chars:number, trimmed:string[]}}
 */
export function applyBudget(texts, budget) {
  const trimmed = []
  const segments = {}

  /**
   * ⚠️ 段的顺序要固定，否则每次拼出来的字符串顺序会变，指纹跟着抖。
   *
   * 顺序 = 注入时的拼接顺序，也决定了读到的先后：
   *   lifeline 在最前 —— 它回答「这是哪一段人生」，是后面所有内容的地图；
   *   然后 psyche（此刻状态）、diary（压缩前写的交接）、
   *   ledger（查过什么，只在压缩后）、tacit（经验）。
   *
   * ⚠️ 新增一段必须同时改这里，**否则那一段会被静默丢弃**：
   *   applyBudget 只遍历 ORDER，不在里面的段根本不会进 segments。
   *   这是这个模块最容易踩的坑（2026-11-16 加 ledger 时差点漏掉）。
   */
  const ORDER = ['lifeline', 'psyche', 'diary', 'ledger', 'tacit']

  // ① 先按段上限削
  for (const key of ORDER) {
    let t = texts[key] ?? ''
    const cap = budget[key]
    if (typeof cap === 'number' && cap > 0 && t.length > cap) {
      t = cutText(t, cap)
      trimmed.push(`${key}:段上限${cap}`)
    }
    segments[key] = t
  }

  // ② 再按总上限削：从最长的段开始
  //
  // ⚠️ lifeline 豁免总上限的"按长度削"（2026-11-16）：
  //   它是常驻时间骨架，长度天然稳定（每月增长一点点）。
  //   若让它参与"谁最长就削谁"，当它成为最长段时会被砍掉最老月份 ——
  //   而砍掉的那部分恰恰是"想知道自己在哪一年"最需要的。
  //   所以：lifeline 只受**它自己的段上限**约束（那边已经保证从最近往前丢），
  //   总上限超了时在其余段里按长度削（本模块不做优先级，那种判断需要语义）。
  const TOTAL_ORDER = ORDER.filter((k) => k !== 'lifeline')
  let total = ORDER.reduce((n, k) => n + segments[k].length, 0)
  const cap = budget.total
  if (typeof cap === 'number' && cap > 0 && total > cap) {
    let guard = 0
    while (total > cap && guard++ < 8) {
      const order = TOTAL_ORDER.sort((a, b) => segments[b].length - segments[a].length)
      const victim = order[0]
      if (!victim || segments[victim].length === 0) break
      const overflow = total - cap
      // 削到「当前长度 - 溢出量」，但不小于 200（留一段可读内容）
      const nextLen = Math.max(200, segments[victim].length - overflow)
      if (nextLen >= segments[victim].length) break
      segments[victim] = cutText(segments[victim], nextLen)
      trimmed.push(`${victim}:总上限削减${overflow}`)
      total = ORDER.reduce((n, k) => n + segments[k].length, 0)
    }
  }

  return { segments, chars: total, trimmed }
}

/**
 * 按字符数裁剪，但**尽量在行边界处切**。
 *
 * ⚠️ 为什么不直接 slice：
 *   硬切会把一行「- 12:13 [别处·助手] ...」切成半句，模型读到半条比读不到更糟
 *   （它会自己补全，补出来的可能是错的）。优先在最后一个换行处切。
 *
 * ⚠️ 截断说明必须**算在 max 之内**（2026-11-03 测试抓到）：
 *   第一版先切到 max 再拼说明，结果削完是 max + 22 字符 —— 每一轮都比目标长 22，
 *   于是"总上限"循环削 8 次仍然超标（实测 6022 > 6000），而且日志刷了 8 行同样的裁剪记录。
 *   现在先留出说明的位置，保证 cutText 的返回值**真的不超过 max**。
 */
export function cutText(text, max) {
  const t = String(text ?? '')
  if (t.length <= max) return t

  const note = `\n（本条因预算被截断，原文 ${t.length} 字符）`
  // 说明本身比预算还长时，只截原文本（极端情况，别为了写说明把预算撑爆）
  if (note.length >= max) return t.slice(0, max)

  const room = max - note.length
  const head = t.slice(0, room)
  const lastNl = head.lastIndexOf('\n')
  // 行边界在合理范围内才用，否则保留更多内容更重要
  const body = lastNl > room * 0.6 ? head.slice(0, lastNl) : head
  return body + note
}

/**
 * 自适应注入间隔：内容越大间隔越长。
 *
 * ⚠️ 不这么做的后果是「记得越多、烧得越快」：
 *   内容 300 字符时每 10 分钟一次几乎不花钱，内容 9000 字符时同样的频率贵 30 倍。
 *
 * 整合后这条由**合并总长度**计算，而不是三段各算一遍。
 *
 * ⚠️ 阈值随预算一起上调过（2026-11-03 主人决定 strand 预算 4000 → 9000）。
 *   若不同步调，9000 字符会永久按 30 分钟档跑，而它本来就该是"中等"那一档。
 *   新分档：
 *     < 2000        → 10 分钟（只有几条事实的典型场景）
 *     < 6000        → 20 分钟
 *     ≥ 6000        → 30 分钟（满负荷：9000 字符 strand + 两小段）
 *
 *   满负荷成本口径：9000 字符 ≈ 5600 tokens，30 分钟一次 → 8 小时 16 次 ≈ 90k tokens。
 */
export const BASE_GAP_MS = 10 * 60 * 1000

export function gapFor(contentChars, envOverride = null) {
  if (envOverride !== null && envOverride !== undefined) return envOverride
  if (contentChars < 2000) return BASE_GAP_MS
  if (contentChars < 6000) return BASE_GAP_MS * 2
  return BASE_GAP_MS * 3
}
